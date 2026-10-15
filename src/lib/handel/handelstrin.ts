import "server-only";

// Handelstrinene - ÉN kodevej for hjemmesidens server actions
// (src/app/actions/trades.ts og afhentning.ts) og appens endpoint
// (POST /api/handel/app/<handling>, docs/APP-ENDPOINTS.md).
//
// supabase er en klient, der kalder databasen SOM brugeren (cookie-session på
// hjemmesiden, Bearer-token i appen), og brugerId er den samme, verificerede
// bruger (auth.getUser). RPC'erne udleder selv brugeren af auth.uid(), så de
// kan ikke kaldes på en andens vegne. Efter statusskiftet sendes de samme
// beskeder (mail, push, klokke) og startes den samme udbetaling som før.
//
// Fejl RETURNERES som { fejl, kode } - fejl er en dansk tekst, der kan vises.

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pakkeSendtMail } from "@/lib/mails/handel";
import { send } from "@/lib/notifikationer/send";
import { sendKoeberAfsluttet, sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";
import { hentBetalingForHandel, indsigelseBlokerer } from "@/lib/betaling/stripeBetaling";
import { erSendtTilSaelger, pengeTilSaelger } from "@/lib/betaling/udbetaling";
import {
  PAKKE_BILLEDE_KATEGORIER,
  PAKKE_MAKS_BILLEDER,
  PAKKE_SEND_FEJL,
  type PakkeBilledeInput,
  erPakkeBilledeKategori,
} from "@/lib/pakkebilleder";

export type HandelstrinSvar = { ok: true } | { fejl: string; kode: string };

const GENERISK = "Noget gik galt. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type HandelRaekke = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  status: string;
  afhentning: boolean;
};

// Handlen, hvis brugeren er køber eller sælger. Medlemskab filtreres
// eksplicit: RLS ville også slippe staff igennem.
async function hentHandel(supabase: SupabaseClient, brugerId: string, tradeId: unknown): Promise<HandelRaekke | null> {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) return null;
  const { data } = await supabase
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, status, afhentning")
    .eq("id", tradeId)
    .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
    .maybeSingle<HandelRaekke>();
  return data ?? null;
}

const IKKE_FUNDET = { fejl: "Handlen findes ikke.", kode: "ikke_fundet" } as const;

function rensPakkeBilleder(billeder: unknown): PakkeBilledeInput[] | null {
  if (!Array.isArray(billeder) || billeder.length > PAKKE_MAKS_BILLEDER) return null;
  const ud: PakkeBilledeInput[] = [];
  for (const b of billeder) {
    if (!b || typeof b !== "object") return null;
    const { sti, kategori } = b as Record<string, unknown>;
    if (typeof sti !== "string" || sti.length > 200 || !erPakkeBilledeKategori(kategori)) return null;
    ud.push({ sti, kategori });
  }
  return ud;
}

async function auktionTitel(supabase: SupabaseClient, auktionId: string): Promise<string | undefined> {
  const { data } = await supabase.from("auctions").select("titel").eq("id", auktionId).maybeSingle();
  return (data?.titel as string | undefined) ?? undefined;
}

// ------------------------------------------------------------------ send pakke

// Sælger sender pakken: sporingsnummer + pakkebilleder (varen pakket i den
// åbne kasse og den lukkede kasse med label). Billederne er uploadet af
// klienten til bucket 'pakke-billeder' FØR kaldet; her knyttes de til
// handlen i samme transaktion som statusskiftet (trade_marker_sendt).
export async function sendPakkeFor(
  supabase: SupabaseClient,
  brugerId: string,
  tradeId: unknown,
  tracking: unknown,
  billeder: unknown,
): Promise<HandelstrinSvar> {
  if (typeof tracking !== "string") return { fejl: PAKKE_SEND_FEJL.ugyldigt_tracking, kode: "ugyldigt_tracking" };
  const rene = rensPakkeBilleder(billeder);
  if (!rene) return { fejl: PAKKE_SEND_FEJL.ugyldige_billeder, kode: "ugyldige_billeder" };

  const handel = await hentHandel(supabase, brugerId, tradeId);
  if (!handel) return IKKE_FUNDET;

  if (handel.seller_id !== brugerId) {
    return { fejl: "Kun sælgeren kan markere pakken som sendt.", kode: "ikke_saelger" };
  }
  if (handel.afhentning) return { fejl: PAKKE_SEND_FEJL.afhentning, kode: "afhentning" };
  if (handel.status === "annulleret") return { fejl: PAKKE_SEND_FEJL.annulleret, kode: "annulleret" };
  if (handel.status !== "betaling_modtaget") return { fejl: PAKKE_SEND_FEJL.allerede_sendt, kode: "allerede_sendt" };

  const renTracking = tracking.trim();
  if (!renTracking) return { fejl: "Indtast et sporingsnummer.", kode: "ugyldigt_tracking" };
  if (renTracking.length > 100) return { fejl: "Sporingsnummeret er for langt.", kode: "ugyldigt_tracking" };

  const kategorier = new Set(rene.map((b) => b.kategori));
  if (!PAKKE_BILLEDE_KATEGORIER.every((k) => kategorier.has(k))) {
    return { fejl: PAKKE_SEND_FEJL.billeder_kraeves, kode: "billeder_kraeves" };
  }

  // Sælgeren udledes af auth.uid() i funktionen. Handlen låses, billederne
  // valideres (findes i storage, i sælgerens mappe, ikke brugt før), og
  // statusguarden i samme update gør handlingen idempotent ved dobbeltklik.
  const { data: svar, error } = await supabase.rpc("trade_marker_sendt", {
    p_trade: handel.id,
    p_tracking: renTracking,
    p_billeder: rene,
  });
  if (error) {
    console.error("trade_marker_sendt fejlede:", error);
    return { fejl: GENERISK, kode: "fejl" };
  }
  const kode = (svar as { kode?: string } | null)?.kode;
  if (kode !== "ok") {
    return { fejl: PAKKE_SEND_FEJL[kode ?? ""] ?? GENERISK, kode: kode ?? "fejl" };
  }

  // Besked til køberen. send() kaster aldrig, så forsendelsen står fast.
  const titel = (await auktionTitel(supabase, handel.auction_id)) ?? "din vare";
  await send(handel.buyer_id, "pakke_sendt", {
    titel: "Din pakke er på vej",
    tekst: `Sælgeren har sendt "${titel}". Sporingsnummer: ${renTracking}`,
    link: `/mine-handler/${handel.id}`,
    data: { trade_id: handel.id },
    mail: pakkeSendtMail(titel, renTracking, handel.id),
    noegle: `pakke_sendt:${handel.id}`,
  });

  revalidatePath(`/mine-handler/${handel.id}`);
  revalidatePath("/mine-handler");
  return { ok: true };
}

// ------------------------------------------------------------------ modtaget

// TRIN 1: Køberen kvitterer for at pakken er kommet frem. Ingen penge
// flyttes her - det giver køberen tid til at tjekke varen.
export async function markerModtagetFor(
  supabase: SupabaseClient,
  brugerId: string,
  tradeId: unknown,
): Promise<HandelstrinSvar> {
  const handel = await hentHandel(supabase, brugerId, tradeId);
  if (!handel) return IKKE_FUNDET;
  if (handel.buyer_id !== brugerId) return { fejl: "Kun køberen kan kvittere for pakken.", kode: "ikke_koeber" };
  if (handel.status !== "pakke_sendt") {
    return { fejl: "Handlen er ikke klar til at blive kvitteret.", kode: "ikke_klar" };
  }

  // Køberen udledes af auth.uid() inde i funktionen.
  const { data: markeret, error } = await supabase.rpc("trade_marker_modtaget", { p_trade: handel.id });
  if (error) {
    console.error("trade_marker_modtaget fejlede:", error);
    return { fejl: GENERISK, kode: "fejl" };
  }
  if (!markeret) return { fejl: "Pakken er allerede kvitteret.", kode: "allerede" };

  const titel = (await auktionTitel(supabase, handel.auction_id)) ?? "din vare";
  await send(handel.seller_id, "pakke_leveret", {
    titel: "Pakken er kommet frem",
    tekst: `Køberen har modtaget "${titel}" og tjekker nu varen. Du får pengene, når køberen har godkendt varen, eller efter 48 timer, hvis der ikke er oprettet en sag.`,
    link: `/mine-handler/${handel.id}`,
    data: { trade_id: handel.id },
    noegle: `pakke_leveret:${handel.id}`,
  });

  revalidatePath(`/mine-handler/${handel.id}`);
  revalidatePath("/mine-handler");
  return { ok: true };
}

// ------------------------------------------------------------------ godkend

// Links er tilladt i kommentarer (Filips beslutning). Kun længden tjekkes her
// for en pæn besked - databasen er sikkerhedslaget.
export const KOMMENTAR_MAKS = 1000;

const GODKEND_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  ugyldige_stjerner: "Giv sælgeren 1-5 stjerner, før du godkender varen.",
  kommentar_for_lang: `Kommentaren må højst være ${KOMMENTAR_MAKS} tegn.`,
  ikke_mulig: "Pakken er allerede godkendt.",
};

// Starter overførslen til sælgerens Stripe Connect-konto. Fejler det (eller
// har sælgeren ingen aktiv konto endnu), prøver cron og account.updated-
// webhooken igen - frigivelsen står fast uanset. Kaster aldrig.
async function startUdbetaling(tradeId: string) {
  try {
    const betaling = await hentBetalingForHandel(tradeId);
    if (betaling) {
      const r = await pengeTilSaelger(betaling.id);
      if (!erSendtTilSaelger(r)) console.warn("Overførsel ikke gennemført endnu:", tradeId, r);
    }
  } catch (err) {
    console.error("Overførsel til sælger fejlede (prøves igen af cron):", tradeId, err);
  }
}

// TRIN 2: Køberen godkender varen og bedømmer sælgeren (1-5 stjerner +
// valgfri kommentar), og beløbet udbetales til sælgeren. Bedømmelse og
// godkendelse sker i én transaktion i databasen. Uigenkaldeligt.
export async function godkendPakkeFor(
  supabase: SupabaseClient,
  brugerId: string,
  tradeId: unknown,
  stjerner: unknown,
  kommentar: unknown,
): Promise<HandelstrinSvar> {
  if (typeof stjerner !== "number" || !Number.isInteger(stjerner) || stjerner < 1 || stjerner > 5) {
    return { fejl: GODKEND_FEJL.ugyldige_stjerner, kode: "ugyldige_stjerner" };
  }
  const renKommentar = typeof kommentar === "string" ? kommentar.trim() || null : null;
  if (renKommentar && Array.from(renKommentar).length > KOMMENTAR_MAKS) {
    return { fejl: GODKEND_FEJL.kommentar_for_lang, kode: "kommentar_for_lang" };
  }

  const handel = await hentHandel(supabase, brugerId, tradeId);
  if (!handel) return IKKE_FUNDET;
  if (handel.buyer_id !== brugerId) return { fejl: "Kun køberen kan godkende pakken.", kode: "ikke_koeber" };
  if (handel.status !== "modtaget") {
    return { fejl: "Kvittér for pakken, før du godkender den.", kode: "ikke_klar" };
  }

  // En åben indsigelse (chargeback) blokerer frigivelsen - databasen afviser
  // den også, men så får køberen en forståelig besked.
  const forud = await hentBetalingForHandel(handel.id);
  if (forud && indsigelseBlokerer(forud)) {
    return {
      fejl: "Handlen kan ikke godkendes, mens din bank behandler en indsigelse mod betalingen. Kontakt support@bidhamr.dk.",
      kode: "indsigelse",
    };
  }

  // Statusskiftet, frigivelsen og bedømmelsen sker i samme transaktion.
  // Idempotent: et dobbeltklik finder ingen række anden gang.
  const { data: kode, error } = await supabase.rpc("handel_godkend_med_bedoemmelse", {
    p_trade: handel.id,
    p_stjerner: stjerner,
    p_kommentar: renKommentar,
  });
  if (error) {
    console.error("handel_godkend_med_bedoemmelse fejlede:", error);
    return { fejl: GENERISK, kode: "fejl" };
  }
  if (kode !== "ok") {
    return { fejl: GODKEND_FEJL[kode as string] ?? GENERISK, kode: typeof kode === "string" ? kode : "fejl" };
  }

  // Beskeder før overførslen, så sælgerens afregning får den rigtige grund.
  await sendSaelgerAfregning(handel.id, "godkendt");
  await sendKoeberAfsluttet(handel.id, "godkendt");
  await startUdbetaling(handel.id);

  revalidatePath(`/mine-handler/${handel.id}`);
  revalidatePath("/mine-handler");
  revalidatePath(`/profil/${handel.seller_id}`);
  revalidatePath(`/auktion/${handel.auction_id}`);
  return { ok: true };
}

// ------------------------------------------------------------------ afhentning

function klokkeslaet(iso: string) {
  return new Date(iso).toLocaleTimeString("da-DK", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

// Sælgeren indtaster køberens kode. Rigtig kode frigiver pengene.
// Alle regler (kun sælgeren, 5 forkerte = låst 1 time) ligger i
// afhentning_bekraeft, som udleder sælgeren af auth.uid().
export async function bekraeftAfhentningFor(
  supabase: SupabaseClient,
  brugerId: string,
  tradeId: unknown,
  kode: unknown,
): Promise<HandelstrinSvar> {
  if (typeof tradeId !== "string" || !UUID.test(tradeId)) return IKKE_FUNDET;
  const renKode = typeof kode === "string" ? kode.replace(/\s/g, "") : "";
  if (!/^[0-9]{6}$/.test(renKode)) return { fejl: "Koden består af 6 cifre.", kode: "ugyldig_kode" };

  const { data, error } = await supabase.rpc("afhentning_bekraeft", { p_trade: tradeId, p_kode: renKode });
  if (error) {
    console.error("afhentning_bekraeft fejlede:", error);
    return { fejl: GENERISK, kode: "fejl" };
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
        kode: "forkert",
      };
    case "laast_midlertidigt":
      return {
        fejl: svar.laast_til
          ? `For mange forkerte forsøg. Prøv igen efter kl. ${klokkeslaet(svar.laast_til)}.`
          : "For mange forkerte forsøg. Prøv igen om en time.",
        kode: "laast_midlertidigt",
      };
    case "laast":
      return {
        fejl: "Koden er låst efter for mange forkerte forsøg. BidHamr kigger på handlen – kontakt support@bidhamr.dk.",
        kode: "laast",
      };
    case "ikke_vist":
      return {
        fejl: "Køberen har ikke hentet sin kode frem endnu. Bed køberen åbne handlen og trykke \"Vis afhentningskode\".",
        kode: "ikke_vist",
      };
    case "ugyldig_kode":
      return { fejl: "Koden består af 6 cifre.", kode: "ugyldig_kode" };
    case "ikke_logget_ind":
      return { fejl: "Du skal være logget ind.", kode: "ikke_logget_ind" };
    default:
      return { fejl: "Handlen kan ikke afsluttes lige nu. Genindlæs siden.", kode: svar.kode ?? "ikke_mulig" };
  }

  // Afregning til sælgeren og "Tak for handlen" til køberen (idempotente
  // nøgler pr. handel; kaster aldrig), derefter udbetalingen.
  await sendSaelgerAfregning(tradeId, "afhentet");
  await sendKoeberAfsluttet(tradeId, "afhentet");
  await startUdbetaling(tradeId);

  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
  revalidatePath(`/profil/${brugerId}`);
  return { ok: true };
}
