// Beskeder til sælgeren om en indsigelse (chargeback) fra køberens bank
// (Niels F04). Kaldes af spejlIndsigelse efter hver dispute-hændelse.
// Én besked pr. dispute og udfald (nøglen), så genleverede events ikke giver
// flere. Kaster aldrig - spejlingen må ikke fejle pga. en besked.
//
// Virker uanset hvor pengene står (platformens saldo eller sælgerens
// Connect-konto): teksterne siger kun, om sælgeren skal vente med varen, og
// om der udbetales.

import { createAdminClient } from "@/lib/supabase/admin";
import { send } from "@/lib/notifikationer/send";

export type IndsigelseUdfald = "aaben" | "afgjort" | "tabt";

type Tilstand = {
  titel: string;
  tradeId: string;
  saelgerId: string;
  sendt: boolean; // varen er sendt / hentet / modtaget
  afhentning: boolean;
  overfoert: boolean; // udbetalingen er sendt til sælgeren
};

export function indsigelseTekst(u: IndsigelseUdfald, t: Tilstand): { titel: string; tekst: string } {
  const vare = `"${t.titel}"`;
  if (u === "aaben") {
    if (!t.sendt) {
      return {
        titel: t.afhentning ? "Udlevér ikke varen endnu" : "Send ikke varen endnu",
        tekst: `Køberen har gjort indsigelse mod betalingen for ${vare} hos sin bank. ${
          t.afhentning ? "Udlevér ikke varen" : "Send ikke varen"
        }, før vi skriver til dig igen. Banken afgør sagen, og indtil da udbetales der ikke for handlen.`,
      };
    }
    return {
      titel: "Køberens bank undersøger betalingen",
      tekst: t.overfoert
        ? `Køberen har gjort indsigelse mod betalingen for ${vare} hos sin bank. BidHamr svarer banken. Din udbetaling bliver ikke trukket tilbage.`
        : `Køberen har gjort indsigelse mod betalingen for ${vare} hos sin bank. BidHamr svarer banken med sporing og kvittering. Udbetalingen venter, til banken har afgjort sagen.`,
    };
  }
  if (u === "afgjort") {
    return {
      titel: "Indsigelsen er afgjort",
      tekst: !t.sendt
        ? `Køberens bank har afgjort indsigelsen mod betalingen for ${vare}, og handlen fortsætter. ${
            t.afhentning ? "Du kan nu aftale afhentning med køberen." : "Du kan nu sende varen."
          }`
        : `Køberens bank har afgjort indsigelsen mod betalingen for ${vare}, og handlen fortsætter som normalt.`,
    };
  }
  return {
    titel: "Køberen har fået pengene tilbage af sin bank",
    tekst: t.overfoert
      ? `Køberens bank har givet køberen pengene tilbage for ${vare}. Din udbetaling bliver ikke trukket tilbage.`
      : `Køberens bank har givet køberen pengene tilbage for ${vare}. Handlen bliver annulleret, og der udbetales ikke for den. ${
          t.afhentning ? "Udlevér ikke varen." : "Send ikke varen."
        } Har du allerede ${t.afhentning ? "udleveret" : "sendt"} den, så skriv til support@bidhamr.dk.`,
  };
}

export async function sendIndsigelseTilSaelger(
  disputeId: string,
  paymentIntentId: string | null,
  chargeId: string | null,
  udfald: IndsigelseUdfald,
): Promise<void> {
  try {
    const admin = createAdminClient();
    let q = admin
      .from("betalinger")
      .select("trade_id, auction_id, seller_id, status, stripe_transfer_id, overfoersel_paabegyndt_kl")
      .limit(1);
    if (paymentIntentId) q = q.eq("stripe_payment_intent_id", paymentIntentId);
    else if (chargeId) q = q.eq("stripe_charge_id", chargeId);
    else return;
    const { data: b } = await q.maybeSingle<{
      trade_id: string;
      auction_id: string;
      seller_id: string;
      status: string;
      stripe_transfer_id: string | null;
      overfoersel_paabegyndt_kl: string | null;
    }>();
    if (!b) return;
    const [{ data: h }, { data: a }] = await Promise.all([
      admin.from("trades").select("status, afhentning").eq("id", b.trade_id).maybeSingle(),
      admin.from("auctions").select("titel").eq("id", b.auction_id).maybeSingle(),
    ]);
    const status = (h?.status as string | undefined) ?? "";
    const t: Tilstand = {
      titel: (a?.titel as string | undefined) ?? "din vare",
      tradeId: b.trade_id,
      saelgerId: b.seller_id,
      sendt: ["pakke_sendt", "modtaget", "leveret", "afsluttet"].includes(status),
      afhentning: !!h?.afhentning,
      overfoert: !!b.stripe_transfer_id || !!b.overfoersel_paabegyndt_kl,
    };
    const { titel, tekst } = indsigelseTekst(udfald, t);
    await send(b.seller_id, "sag", {
      titel,
      tekst,
      link: `/mine-handler/${b.trade_id}`,
      data: { trade_id: b.trade_id },
      noegle: `indsigelse_${udfald}:${disputeId}`,
    });
  } catch (err) {
    console.error("Besked til sælger om indsigelse fejlede:", disputeId, err);
  }
}
