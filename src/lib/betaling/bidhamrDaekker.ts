import "server-only";

// "BidHamr dækker" (sikkerhedsnet A, 20261019010000) - kun chef.
//
// Pengene er udbetalt fra sælgerens Stripe-konto til banken, og en udbetaling
// trækkes aldrig tilbage fra sælgeren (ROADMAP-BESLUTNINGER). Skal køberen
// alligevel have pengene (fx en sag med medhold, der sidder fast med
// penge_fejl), kan chefen lade BidHamr betale af platformens egen saldo:
//
//   1. betaling_bidhamr_daekker_claim låser betalingen (15 min), tjekker rolle,
//      inhabilitet, at udbetalingen er gennemført/på vej, ingen indsigelse og
//      ingen tidligere refusionstrin, og låser beløbet første gang:
//        sag med medhold, der venter på refusion -> total - BidHamr Beskyttelse
//        ellers                                  -> total
//   2. Stripe: refusionerne på PaymentIntenten slås op (en refusion med
//      metadata.bidhamr_daekker = betalingen genbruges; findes en anden, eller
//      er chargen allerede delvist refunderet, stoppes der). Ellers
//      refunds.create med det låste beløb, UDEN reverse_transfer og UDEN
//      refund_application_fee (intet tages fra sælgeren), idempotency key
//      bidhamr-daekker-<betaling> - samme nøgle altid, så et gentaget kald
//      aldrig refunderer to gange.
//   3. betaling_bidhamr_daekker_registrer gemmer refusionen; er den
//      gennemført, registreres betalingen som refunderet (sager lukkes,
//      handlen annulleres), og markeringen lukkes. Kommer bekræftelsen senere,
//      afslutter webhooken den (registrerRefunderet ->
//      betaling_bidhamr_daekker_afslut).
//   4. Kreditnota: faktura_planlaeg krediterer købers faktura (købergebyr,
//      fragt og evt. Beskyttelse) - sælgerens faktura står, han fik sin
//      udbetaling. DAC7 tæller stadig salget.

import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { kronerFraOere } from "@/lib/mails/handel";

export type DaekkerUdfald =
  | "refunderet"
  | "afventer"
  | "konflikt"
  | "stripe_afviste"
  | string; // databasens koder (ingen_adgang, inhabil, ikke_udbetalt ...)

type Claim = {
  kode: string;
  refusion_oere?: number;
  payment_intent?: string;
  charge?: string;
  trade_id?: string;
  buyer_id?: string;
};

const KALD: Stripe.RequestOptions = { timeout: 20_000, maxNetworkRetries: 1 };

async function frigiv(betalingId: string, noegle: string, fejl: string | null): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_bidhamr_daekker_frigiv", {
    p_betaling: betalingId,
    p_noegle: noegle,
    p_fejl: fejl,
  });
  if (error) console.error("betaling_bidhamr_daekker_frigiv:", betalingId, error.message);
}

export async function bidhamrDaekker(
  betalingId: string,
  medarbejderId: string,
  begrundelse: string,
): Promise<DaekkerUdfald> {
  const admin = createAdminClient();
  const noegle = crypto.randomUUID();
  const { data, error } = await admin.rpc("betaling_bidhamr_daekker_claim", {
    p_medarbejder: medarbejderId,
    p_betaling: betalingId,
    p_begrundelse: begrundelse,
    p_noegle: noegle,
  });
  if (error) throw new Error(`betaling_bidhamr_daekker_claim: ${error.message}`);
  const c = (data ?? {}) as Claim;
  if (c.kode !== "ok") return c.kode;
  const R = Number(c.refusion_oere);
  const pi = String(c.payment_intent);
  if (!Number.isInteger(R) || R <= 0) {
    await frigiv(betalingId, noegle, "Ugyldigt beløb");
    return "konflikt";
  }

  const stripe = getStripe();
  try {
    const charge = await stripe.charges.retrieve(String(c.charge), {}, KALD);
    const liste = await stripe.refunds.list({ payment_intent: pi, limit: 100 }, KALD);
    const aktive = liste.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
    let refund: Stripe.Refund | null = aktive.find((r) => r.metadata?.bidhamr_daekker === betalingId) ?? null;
    if (!refund) {
      if (liste.has_more || aktive.length > 0 || Number(charge.amount_refunded) > 0 || Number(charge.amount) < R) {
        await frigiv(betalingId, noegle, "Der findes allerede en anden refusion på betalingen hos Stripe");
        await logDriftFejl({
          kilde: "action",
          hvor: "betaling/bidhamr-daekker",
          fejl: `BidHamr dækker stoppet for betaling ${betalingId}: der findes allerede en anden refusion hos Stripe (eller beløbet passer ikke). Kontrollér betalingen i Stripe.`,
        });
        return "konflikt";
      }
      refund = await stripe.refunds.create(
        {
          payment_intent: pi,
          amount: R,
          reason: "requested_by_customer",
          // Intet tages fra sælgerens Stripe-konto: BidHamr betaler.
          reverse_transfer: false,
          refund_application_fee: false,
          metadata: {
            betaling_id: betalingId,
            handel_id: String(c.trade_id ?? ""),
            aarsag: "bidhamr_daekker",
            bidhamr_daekker: betalingId,
          },
        },
        { ...KALD, idempotencyKey: `bidhamr-daekker-${betalingId}` },
      );
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      await frigiv(betalingId, noegle, `Stripe: refusionen er ${refund.status}`);
      return "stripe_afviste";
    }
    const { data: reg, error: rFejl } = await admin.rpc("betaling_bidhamr_daekker_registrer", {
      p_betaling: betalingId,
      p_noegle: noegle,
      p_refund: refund.id,
      p_status: refund.status ?? "pending",
    });
    if (rFejl) throw new Error(`betaling_bidhamr_daekker_registrer: ${rFejl.message}`);
    if (String(reg) === "ok") {
      if (c.buyer_id && c.trade_id) await beskedTilKoeber(c.buyer_id, c.trade_id, R);
      return "refunderet";
    }
    // Afventer bekræftelse (webhooken afslutter) - låsen frigives.
    await frigiv(betalingId, noegle, null);
    return String(reg) === "afventer" ? "afventer" : String(reg);
  } catch (err) {
    const kode = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt";
    await frigiv(betalingId, noegle, `Fejl hos Stripe (${kode})`);
    throw err;
  }
}

async function beskedTilKoeber(koeberId: string, tradeId: string, oere: number): Promise<void> {
  try {
    await send(koeberId, "sag", {
      titel: "Du får pengene tilbage",
      tekst: `Vi har sørget for, at du får ${kronerFraOere(oere)} kr tilbage på den betalingsmetode, du betalte med. Der kan gå nogle dage, før pengene står på din konto. Betalingen håndteres af vores betalingspartner Stripe.`,
      link: `/mine-handler/${tradeId}`,
      data: { trade_id: tradeId },
      noegle: `bidhamr_daekker_koeber:${tradeId}`,
    });
  } catch (err) {
    console.error("Besked om BidHamr dækker fejlede:", tradeId, err);
  }
}
