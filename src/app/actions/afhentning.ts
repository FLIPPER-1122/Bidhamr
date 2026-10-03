"use server";

// Afhentning hos sælger (ROADMAP-BESLUTNINGER afsnit 1/2 og 6):
//   1. Køberen giver sælgeren 1-5 stjerner og får sin afhentningskode vist.
//   2. Sælgeren indtaster koden, når varen er hentet -> pengene frigives med
//      det samme. Ingen klagefrist bagefter.
// Al logik og alle tjek ligger i databasen (afhentning_vis_kode,
// afhentning_bekraeft - begge udleder kalderen af auth.uid()). Her oversættes
// koderne til danske beskeder, og overførslen til sælgeren sættes i gang.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import {
  hentBetalingForHandel,
  overfoerTilSaelger,
} from "@/lib/betaling/stripeBetaling";
import { sendKoeberAfsluttet, sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";

const KOMMENTAR_MAKS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AfhentningInfo = {
  vist: boolean;
  bekraeftet: boolean;
  laast: boolean;
  laastTil: string | null;
  // Kun til køberen, og kun når han allerede har bedømt sælgeren.
  kode: string | null;
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
  };
  return {
    vist: Boolean(d.vist),
    bekraeftet: Boolean(d.bekraeftet),
    laast: Boolean(d.laast),
    laastTil: d.laast_til ?? null,
    kode: d.kode ?? null,
  };
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
  } = await supabase.auth.getUser();
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
  } = await supabase.auth.getUser();
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
      const r = await overfoerTilSaelger(betaling.id);
      if (r !== "overfoert" && r !== "allerede_overfoert") {
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
