"use server";

// Afhentning hos sælger (ROADMAP-BESLUTNINGER afsnit 1/2 og 6):
//   1. Køberen giver sælgeren 1-5 stjerner og får sin afhentningskode vist.
//   2. Sælgeren indtaster koden, når varen er hentet -> pengene frigives med
//      det samme. Ingen klagefrist bagefter.
// Al logik og alle tjek ligger i databasen (afhentning_vis_kode,
// afhentning_bekraeft - begge udleder kalderen af auth.uid()). Her oversættes
// koderne til danske beskeder, og overførslen til sælgeren sættes i gang.

import { after } from "next/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hentBetalingForHandel } from "@/lib/betaling/stripeBetaling";
import { erSendtTilSaelger, pengeTilSaelger } from "@/lib/betaling/udbetaling";
import { sendKoeberAfsluttet, sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";
import { notificerAfhentningsfristForlaengelser } from "@/lib/betaling/afhentningsfrist";
import { AFHENTNING_MAKS_FORLAENGELSER } from "@/lib/afhentningsfrist";
import { fristDato } from "@/lib/betalingsfrist";

const KOMMENTAR_MAKS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AfhentningInfo = {
  vist: boolean;
  bekraeftet: boolean;
  laast: boolean;
  laastTil: string | null;
  // Kun til køberen, og kun når han allerede har bedømt sælgeren.
  kode: string | null;
  // Afhentningsfristen (ISO). null, hvis betalingen ikke kunne læses.
  frist: string | null;
  fristUdloebet: boolean;
  // Seneste frist, sælgeren kan forlænge til (14 dage efter betalingen).
  maksFrist: string | null;
  // Kan fristen forlænges en gang til (højst 3 gange)?
  kanForlaenges: boolean;
};

// Status til handelssiden. null = ikke en afhentningshandel (eller ikke din).
export async function hentAfhentningInfo(tradeId: string): Promise<AfhentningInfo | null> {
  if (!UUID.test(tradeId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("afhentning_info", { p_trade: tradeId });
  if (error) {
    console.error("afhentning_info fejlede:", error);
    return null;
  }
  if (!data) return null;
  const d = data as {
    vist?: boolean;
    bekraeftet?: boolean;
    laast?: boolean;
    laast_til?: string | null;
    kode?: string | null;
    frist?: string | null;
    maks_frist?: string | null;
    forlaengelser?: number | null;
  };
  const frist = d.frist ?? null;
  const maksFrist = d.maks_frist ?? null;
  const nu = Date.now();
  const fristUdloebet = frist !== null && new Date(frist).getTime() <= nu;
  return {
    vist: Boolean(d.vist),
    bekraeftet: Boolean(d.bekraeftet),
    laast: Boolean(d.laast),
    laastTil: d.laast_til ?? null,
    kode: d.kode ?? null,
    frist,
    fristUdloebet,
    maksFrist,
    kanForlaenges:
      frist !== null &&
      maksFrist !== null &&
      !fristUdloebet &&
      !d.laast &&
      !d.bekraeftet &&
      new Date(maksFrist).getTime() > new Date(frist).getTime() &&
      Number(d.forlaengelser ?? 0) < AFHENTNING_MAKS_FORLAENGELSER,
  };
}

// Sælgeren forlænger afhentningsfristen (ROADMAP-BESLUTNINGER afsnit 2,
// "Afhentningsfrist"). Alle regler håndhæves i databasen
// (afhentning_forlaeng_frist): kun sælgeren, kun mens afhentningen er åben og
// fristen ikke er udløbet, mindst 24 timer senere end den nuværende frist
// (eller lig med den sidste mulige), højst 14 dage efter betalingen og højst
// 3 gange. Appen kalder samme RPC direkte. Ingen penge flyttes.
export async function forlaengAfhentningsfrist(
  tradeId: string,
  nyFrist: string,
): Promise<{ ok: true; frist: string } | { fejl: string }> {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) {
    return { fejl: "Handlen findes ikke." };
  }
  const ms = typeof nyFrist === "string" ? Date.parse(nyFrist) : NaN;
  if (!Number.isFinite(ms)) return { fejl: "Vælg en ny frist." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };

  const { data, error } = await supabase.rpc("afhentning_forlaeng_frist", {
    p_trade: tradeId,
    p_ny_frist: new Date(ms).toISOString(),
  });
  if (error) {
    console.error("afhentning_forlaeng_frist fejlede:", error);
    return { fejl: "Fristen kunne ikke forlænges. Prøv igen om lidt." };
  }

  const svar = (data ?? { kode: "fejl" }) as { kode: string; frist?: string; maks_frist?: string };
  switch (svar.kode) {
    case "ok":
      // Køberen får besked med det samme. Cron'en tager den, hvis det fejler.
      after(() => notificerAfhentningsfristForlaengelser());
      revalidatePath(`/mine-handler/${tradeId}`);
      return { ok: true, frist: svar.frist ?? new Date(ms).toISOString() };
    case "ikke_logget_ind":
      return { fejl: "Du skal være logget ind." };
    case "ikke_fundet":
      return { fejl: "Handlen findes ikke." };
    case "ikke_mulig":
      return { fejl: "Fristen kan ikke forlænges, fordi afhentningen ikke længere er åben." };
    case "laast":
      return {
        fejl: "Koden er låst efter for mange forkerte forsøg. BidHamr kigger på handlen – kontakt support@bidhamr.dk.",
      };
    case "frist_udloebet":
      return { fejl: "Fristen er allerede udløbet og kan ikke forlænges. BidHamr kigger på handlen." };
    case "for_mange":
      return {
        fejl: `Fristen er allerede forlænget ${AFHENTNING_MAKS_FORLAENGELSER} gange og kan ikke forlænges igen.`,
      };
    case "ugyldig_frist":
      return {
        fejl: "Den nye frist skal være mindst 24 timer senere end den nuværende (eller den sidste mulige frist).",
      };
    case "for_sent":
      return {
        fejl: svar.maks_frist
          ? `Fristen kan højst forlænges til ${fristDato(svar.maks_frist)}.`
          : "Fristen kan højst forlænges til 14 dage efter betalingen.",
      };
    default:
      return { fejl: "Fristen kunne ikke forlænges. Prøv igen om lidt." };
  }
}

const VIS_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  ugyldige_stjerner: "Giv sælgeren 1-5 stjerner, før du får koden vist.",
  kommentar_for_lang: `Kommentaren må højst være ${KOMMENTAR_MAKS} tegn.`,
  ikke_mulig: "Koden kan ikke vises lige nu. Genindlæs siden.",
};

// Køberen bedømmer sælgeren og får koden. Bedømmelsen gemmes kun første gang
// (første valg gælder) og offentliggøres først, når sælgeren har indtastet
// koden. Senere kald giver blot koden igen.
export async function visAfhentningskode(
  tradeId: string,
  stjerner?: number,
  kommentar?: string | null,
): Promise<{ kode: string } | { fejl: string }> {
  if (!UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
  if (
    stjerner !== undefined &&
    (typeof stjerner !== "number" || !Number.isInteger(stjerner) || stjerner < 1 || stjerner > 5)
  ) {
    return { fejl: VIS_FEJL.ugyldige_stjerner };
  }
  const renKommentar = typeof kommentar === "string" ? kommentar.trim() || null : null;
  if (renKommentar && Array.from(renKommentar).length > KOMMENTAR_MAKS) {
    return { fejl: VIS_FEJL.kommentar_for_lang };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: VIS_FEJL.ikke_logget_ind };

  const { data, error } = await supabase.rpc("afhentning_vis_kode", {
    p_trade: tradeId,
    p_stjerner: stjerner ?? null,
    p_kommentar: renKommentar,
  });
  if (error) {
    console.error("afhentning_vis_kode fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  const svar = data as { kode?: string; afhentningskode?: string } | null;
  if (svar?.kode !== "ok" || !svar.afhentningskode) {
    return { fejl: VIS_FEJL[svar?.kode ?? ""] ?? "Noget gik galt. Prøv igen om lidt." };
  }

  revalidatePath(`/mine-handler/${tradeId}`);
  return { kode: svar.afhentningskode };
}

function klokkeslaet(iso: string) {
  return new Date(iso).toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

// Sælgeren indtaster køberens kode. Rigtig kode frigiver pengene.
export async function bekraeftAfhentning(
  tradeId: string,
  kode: string,
): Promise<{ ok: true } | { fejl: string }> {
  if (!UUID.test(tradeId)) return { fejl: "Handlen findes ikke." };
  const renKode = typeof kode === "string" ? kode.replace(/\s/g, "") : "";
  if (!/^[0-9]{6}$/.test(renKode)) {
    return { fejl: "Koden består af 6 cifre." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };

  const { data, error } = await supabase.rpc("afhentning_bekraeft", {
    p_trade: tradeId,
    p_kode: renKode,
  });
  if (error) {
    console.error("afhentning_bekraeft fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  const svar = (data ?? {}) as { kode?: string; tilbage?: number; laast_til?: string };

  switch (svar.kode) {
    case "ok":
      break;
    case "forkert":
      return {
        fejl:
          svar.tilbage === 1
            ? "Koden er forkert. Du har 1 forsøg tilbage i denne time."
            : `Koden er forkert. Du har ${svar.tilbage ?? 0} forsøg tilbage i denne time.`,
      };
    case "laast_midlertidigt":
      return {
        fejl: svar.laast_til
          ? `For mange forkerte forsøg. Prøv igen efter kl. ${klokkeslaet(svar.laast_til)}.`
          : "For mange forkerte forsøg. Prøv igen om en time.",
      };
    case "laast":
      return {
        fejl: "Koden er låst efter for mange forkerte forsøg. BidHamr kigger på handlen – kontakt support@bidhamr.dk.",
      };
    case "ikke_vist":
      return {
        fejl: "Køberen har ikke hentet sin kode frem endnu. Bed køberen åbne handlen og trykke \"Vis afhentningskode\".",
      };
    case "ugyldig_kode":
      return { fejl: "Koden består af 6 cifre." };
    case "ikke_logget_ind":
      return { fejl: "Du skal være logget ind." };
    default:
      return { fejl: "Handlen kan ikke afsluttes lige nu. Genindlæs siden." };
  }

  // Afregning til sælgeren og "Tak for handlen" til køberen (idempotente
  // nøgler pr. handel; kaster aldrig).
  await sendSaelgerAfregning(tradeId, "afhentet");
  await sendKoeberAfsluttet(tradeId, "afhentet");

  // Pengene overføres til sælgerens Stripe Connect-konto. Fejler det (eller
  // har sælgeren ingen aktiv konto endnu), prøver cron og account.updated-
  // webhooken igen - frigivelsen står fast uanset. overfoerTilSaelger sender
  // selv udbetalingsbeskeden til sælgeren.
  try {
    const betaling = await hentBetalingForHandel(tradeId);
    if (betaling) {
      // Begge modeller: transfer (separat) eller payout til banken
      // (destination - venter evt. 3 dage, udbetal_tidligst).
      const r = await pengeTilSaelger(betaling.id);
      if (!erSendtTilSaelger(r)) {
        console.warn("Overførsel ikke gennemført endnu:", tradeId, r);
      }
    }
  } catch (err) {
    console.error("Overførsel til sælger fejlede (prøves igen af cron):", tradeId, err);
  }

  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
  revalidatePath(`/profil/${user.id}`);
  return { ok: true };
}
