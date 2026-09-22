"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getResend } from "@/lib/resend";
import { HANDEL_AFSENDER, pakkeSendtMail } from "@/lib/mails/handel";

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

  // Statusguard gør handlingen idempotent ved dobbeltklik.
  const { error } = await supabase
    .from("trades")
    .update({ status: "pakke_sendt", tracking_number: renTracking })
    .eq("id", tradeId)
    .eq("status", "betaling_modtaget");

  if (error) return { fejl: error.message };

  // Mail til køberen. Fejler den, må det ikke vælte forsendelsen.
  try {
    const resend = getResend();
    if (resend) {
      const [{ data: auktion }, { data: koeber }] = await Promise.all([
        supabase.from("auctions").select("titel").eq("id", handel.auction_id).single(),
        supabase.from("users").select("email").eq("id", handel.buyer_id).single(),
      ]);
      if (koeber?.email) {
        const mail = pakkeSendtMail(
          auktion?.titel ?? "din vare",
          renTracking,
          tradeId,
        );
        const { error: mailFejl } = await resend.emails.send({
          from: HANDEL_AFSENDER,
          to: koeber.email,
          subject: mail.subject,
          html: mail.html,
        });
        if (mailFejl) console.error("Kunne ikke sende pakke-mail:", mailFejl);
      }
    } else {
      console.warn("RESEND_API_KEY mangler - pakke-mail blev ikke sendt.");
    }
  } catch (err) {
    console.error("Pakke-mail kastede:", err);
  }

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

  if (error) return { fejl: error.message };
  if (!markeret) {
    return { fejl: "Pakken er allerede kvitteret." };
  }

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

  // Statusskiftet OG udbetalingen sker i samme transaktion i databasen.
  // Funktionen er idempotent, så et dobbeltklik ikke kan udbetale to gange.
  const { data: udbetalt, error } = await supabase.rpc(
    "wallet_udbetal_saelger",
    { p_trade: tradeId },
  );

  if (error) return { fejl: error.message };
  if (!udbetalt) {
    return { fejl: "Pakken er allerede godkendt." };
  }

  revalidatePath(`/mine-handler/${tradeId}`);
  revalidatePath("/mine-handler");
  return { ok: true };
}
