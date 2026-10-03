"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { pakkeSendtMail } from "@/lib/mails/handel";
import { send } from "@/lib/notifikationer/send";
import {
  hentBetalingForHandel,
  indsigelseBlokerer,
  overfoerTilSaelger,
} from "@/lib/betaling/stripeBetaling";
import {
  PAKKE_BILLEDE_KATEGORIER,
  PAKKE_MAKS_BILLEDER,
  PAKKE_SEND_FEJL,
  type PakkeBilledeInput,
  erPakkeBilledeKategori,
} from "@/lib/pakkebilleder";

type HandelRaekke = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  status: string;
  afhentning: boolean;
};

async function hentHandel(tradeId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { fejl: "Du skal være logget ind." as const };

  // Medlemskab filtreres eksplicit. RLS ville også slippe staff igennem, og
  // selv om kaldere nedenfor tjekker køber/sælger hver for sig, skal rækken
  // slet ikke hentes for uvedkommende.
  const { data: handel } = await supabase
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, status, afhentning")
    .eq("id", tradeId)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<HandelRaekke>();

  if (!handel) return { fejl: "Handlen findes ikke." as const };
  return { supabase, user, handel };
}

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

// Sælger sender pakken: sporingsnummer + pakkebilleder (varen pakket i den
// åbne kasse og den lukkede kasse med label). Billederne er uploadet af
// klienten til bucket 'pakke-billeder' FØR kaldet; her knyttes de til
// handlen i samme transaktion som statusskiftet (trade_marker_sendt).
export async function sendPakke(
  tradeId: string,
  tracking: string,
  billeder: PakkeBilledeInput[],
) {
  if (typeof tracking !== "string") return { fejl: PAKKE_SEND_FEJL.ugyldigt_tracking };
  const rene = rensPakkeBilleder(billeder);
  if (!rene) return { fejl: PAKKE_SEND_FEJL.ugyldige_billeder };

  const resultat = await hentHandel(tradeId);
  if ("fejl" in resultat) return resultat;
  const { supabase, user, handel } = resultat;

  if (handel.seller_id !== user.id) {
    return { fejl: "Kun sælgeren kan markere pakken som sendt." };
  }
  if (handel.afhentning) {
    return { fejl: PAKKE_SEND_FEJL.afhentning };
  }
  if (handel.status !== "betaling_modtaget") {
    return { fejl: PAKKE_SEND_FEJL.allerede_sendt };
  }

  const renTracking = tracking.trim();
  if (!renTracking) return { fejl: "Indtast et sporingsnummer." };

  if (renTracking.length > 100) return { fejl: "Sporingsnummeret er for langt." };

  const kategorier = new Set(rene.map((b) => b.kategori));
  if (!PAKKE_BILLEDE_KATEGORIER.every((k) => kategorier.has(k))) {
    return { fejl: PAKKE_SEND_FEJL.billeder_kraeves };
  }

  // Sælgeren udledes af auth.uid() i funktionen. Handlen låses, billederne
  // valideres (findes i storage, i sælgerens mappe, ikke brugt før), og
  // statusguarden i samme update gør handlingen idempotent ved dobbeltklik.
  const { data: svar, error } = await supabase.rpc("trade_marker_sendt", {
    p_trade: tradeId,
    p_tracking: renTracking,
    p_billeder: rene,
  });

  if (error) {
    console.error("trade_marker_sendt fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  const kode = (svar as { kode?: string } | null)?.kode;
  if (kode !== "ok") {
    return { fejl: PAKKE_SEND_FEJL[kode ?? ""] ?? "Noget gik galt. Prøv igen om lidt." };
  }

  // Besked til køberen. send() kaster aldrig, så forsendelsen står fast.
  // Sælgeren er allerede verificeret af trade_marker_sendt ovenfor.
  const { data: auktion } = await supabase
    .from("auctions")
    .select("titel")
    .eq("id", handel.auction_id)
    .maybeSingle();
  const titel = (auktion?.titel as string | undefined) ?? "din vare";
  await send(handel.buyer_id, "pakke_sendt", {
    titel: "Din pakke er på vej",
    tekst: `Sælgeren har sendt "${titel}". Sporingsnummer: ${renTracking}`,
    link: `/mine-handler/${tradeId}`,
    data: { trade_id: tradeId },
    mail: pakkeSendtMail(titel, renTracking, tradeId),
    noegle: `pakke_sendt:${tradeId}`,
  });

  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
  return { ok: true };
}

// TRIN 1: Køberen kvitterer for at pakken er kommet frem. Ingen penge
// flyttes her - det giver køberen tid til at tjekke varen, før beløbet er
// ude af døren.
export async function markerModtaget(tradeId: string) {
  const resultat = await hentHandel(tradeId);
  if ("fejl" in resultat) return resultat;
  const { supabase, user, handel } = resultat;

  if (handel.buyer_id !== user.id) {
    return { fejl: "Kun køberen kan kvittere for pakken." };
  }
  if (handel.status !== "pakke_sendt") {
    return { fejl: "Handlen er ikke klar til at blive kvitteret." };
  }

  // Køberen udledes af auth.uid() inde i funktionen og sendes IKKE med som
  // parameter - ellers kunne enhver kalde den på en andens vegne.
  const { data: markeret, error } = await supabase.rpc(
    "trade_marker_modtaget",
    { p_trade: tradeId },
  );

  if (error) {
    console.error("trade_marker_modtaget fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  if (!markeret) {
    return { fejl: "Pakken er allerede kvitteret." };
  }

  // Sælgeren får besked om, at pakken er kommet frem.
  const { data: auktion } = await supabase
    .from("auctions")
    .select("titel")
    .eq("id", handel.auction_id)
    .maybeSingle();
  await send(handel.seller_id, "pakke_leveret", {
    titel: "Pakken er kommet frem",
    tekst: `Køberen har modtaget "${(auktion?.titel as string | undefined) ?? "din vare"}" og tjekker nu varen. Du får pengene, når køberen har godkendt varen, eller efter 48 timer, hvis der ikke er oprettet en sag.`,
    link: `/mine-handler/${tradeId}`,
    data: { trade_id: tradeId },
    noegle: `pakke_leveret:${tradeId}`,
  });

  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
  return { ok: true };
}

// Links er tilladt i kommentarer (Filips beslutning). Kun længden tjekkes her
// for en pæn besked - databasen er sikkerhedslaget.
const KOMMENTAR_MAKS = 1000;

const GODKEND_FEJL: Record<string, string> = {
  ikke_logget_ind: "Du skal være logget ind.",
  ugyldige_stjerner: "Giv sælgeren 1-5 stjerner, før du godkender varen.",
  kommentar_for_lang: `Kommentaren må højst være ${KOMMENTAR_MAKS} tegn.`,
  ikke_mulig: "Pakken er allerede godkendt.",
};

// TRIN 2: Køberen godkender varen og bedømmer sælgeren (1-5 stjerner +
// valgfri kommentar), og beløbet udbetales til sælgeren. Bedømmelse og
// godkendelse sker i én transaktion i databasen - den ene kan ikke ske uden
// den anden (ROADMAP-BESLUTNINGER afsnit 6). Uigenkaldeligt - derfor
// bekræftelsesdialogen i brugerfladen.
//
// stjerner er valgfri i typen, så et kald uden bedømmelse afvises med en
// forståelig besked i stedet for at kaste.
export async function godkendPakke(
  tradeId: string,
  stjerner?: number,
  kommentar?: string | null,
) {
  if (
    typeof stjerner !== "number" ||
    !Number.isInteger(stjerner) ||
    stjerner < 1 ||
    stjerner > 5
  ) {
    return { fejl: GODKEND_FEJL.ugyldige_stjerner };
  }
  const renKommentar =
    typeof kommentar === "string" ? kommentar.trim() || null : null;
  if (renKommentar && Array.from(renKommentar).length > KOMMENTAR_MAKS) {
    return { fejl: GODKEND_FEJL.kommentar_for_lang };
  }

  const resultat = await hentHandel(tradeId);
  if ("fejl" in resultat) return resultat;
  const { supabase, user, handel } = resultat;

  if (handel.buyer_id !== user.id) {
    return { fejl: "Kun køberen kan godkende pakken." };
  }
  if (handel.status !== "modtaget") {
    return { fejl: "Kvittér for pakken, før du godkender den." };
  }

  // En åben indsigelse (chargeback) blokerer frigivelsen - databasen afviser
  // den også, men så får køberen en forståelig besked.
  const forud = await hentBetalingForHandel(tradeId);
  if (forud && indsigelseBlokerer(forud)) {
    return {
      fejl: "Handlen kan ikke godkendes, mens din bank behandler en indsigelse mod betalingen. Kontakt support@bidhamr.dk.",
    };
  }

  // Statusskiftet, frigivelsen (frigivet_kl) og bedømmelsen sker i samme
  // transaktion i databasen. Køberen og sælgeren udledes af auth.uid() og
  // handlen - de sendes ikke med. Idempotent: et dobbeltklik finder ingen
  // række anden gang og giver ingen ekstra bedømmelse.
  const { data: kode, error } = await supabase.rpc(
    "handel_godkend_med_bedoemmelse",
    { p_trade: tradeId, p_stjerner: stjerner, p_kommentar: renKommentar },
  );

  if (error) {
    console.error("handel_godkend_med_bedoemmelse fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  if (kode !== "ok") {
    return {
      fejl:
        GODKEND_FEJL[kode as string] ?? "Noget gik galt. Prøv igen om lidt.",
    };
  }

  // Pengene overføres til sælgerens Stripe Connect-konto. Fejler det (eller
  // har sælgeren ingen aktiv konto endnu), prøver cron og account.updated-
  // webhooken igen - godkendelsen står fast uanset.
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
  // Bedømmelsen vises på sælgerens profil og auktionssiden.
  revalidatePath(`/profil/${handel.seller_id}`);
  revalidatePath(`/auktion/${handel.auction_id}`);
  return { ok: true };
}
