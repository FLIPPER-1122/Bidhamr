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

type HandelRaekke = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  status: string;
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
    .select("id, auction_id, seller_id, buyer_id, status")
    .eq("id", tradeId)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<HandelRaekke>();

  if (!handel) return { fejl: "Handlen findes ikke." as const };
  return { supabase, user, handel };
}

// Sælger sender pakken og indtaster sporingsnummer.
export async function sendPakke(tradeId: string, tracking: string) {
  const resultat = await hentHandel(tradeId);
  if ("fejl" in resultat) return resultat;
  const { supabase, user, handel } = resultat;

  if (handel.seller_id !== user.id) {
    return { fejl: "Kun sælgeren kan markere pakken som sendt." };
  }
  if (handel.status !== "betaling_modtaget") {
    return { fejl: "Pakken er allerede markeret som sendt." };
  }

  const renTracking = tracking.trim();
  if (!renTracking) return { fejl: "Indtast et sporingsnummer." };

  if (renTracking.length > 100) return { fejl: "Sporingsnummeret er for langt." };

  // Sælgeren udledes af auth.uid() i funktionen. Statusguard i samme update
  // gør handlingen idempotent ved dobbeltklik.
  const { data: sendt, error } = await supabase.rpc("trade_marker_sendt", {
    p_trade: tradeId,
    p_tracking: renTracking,
  });

  if (error) {
    console.error("trade_marker_sendt fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  if (!sendt) return { fejl: "Pakken er allerede markeret som sendt." };

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

// TRIN 2: Køberen godkender varen, og beløbet udbetales til sælgeren.
// Uigenkaldeligt - derfor bekræftelsesdialogen i brugerfladen.
export async function godkendPakke(tradeId: string) {
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

  // Statusskiftet og frigivelsen (frigivet_kl) sker i samme transaktion i
  // databasen. Idempotent: et dobbeltklik finder ingen række anden gang.
  const { data: godkendt, error } = await supabase.rpc("handel_godkend", {
    p_trade: tradeId,
  });

  if (error) {
    console.error("handel_godkend fejlede:", error);
    return { fejl: "Noget gik galt. Prøv igen om lidt." };
  }
  if (!godkendt) {
    return { fejl: "Pakken er allerede godkendt." };
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
  return { ok: true };
}
