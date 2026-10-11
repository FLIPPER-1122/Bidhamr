import "server-only";

// "BidHamr dækker" (sikkerhedsnet A, 20261019010000) - kun chef.
//
// Pengene er udbetalt fra sælgerens Stripe-konto til banken, og en udbetaling
// trækkes aldrig tilbage fra sælgeren (ROADMAP-BESLUTNINGER). Skal køberen
// alligevel have pengene (fx en sag med medhold, der sidder fast med
// penge_fejl), kan chefen lade BidHamr betale af platformens egen saldo:
//
//   1. betaling_bidhamr_daekker_claim låser betalingen (15 min), tjekker rolle,
//      inhabilitet, at udbetalingen er gennemført hos banken ('paid'), ingen
//      indsigelse og ingen tidligere refusionstrin, og låser beløbet første gang:
//        sag med medhold, der venter på refusion -> total - BidHamr Beskyttelse
//        ellers                                  -> refusion_oere, ellers total
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
  | "konflikt" // intet sendt
  | "konflikt_efter" // refusionen er oprettet hos Stripe, men ikke registreret
  | "uafklaret" // ukendt svar fra Stripe - samme kald igen er sikkert
  | "stripe_afviste"
  | "ikke_laast"
  | string; // databasens koder (ingen_adgang, inhabil, ikke_udbetalt ...)

type Claim = {
  kode: string;
  refusion_oere?: number;
  payment_intent?: string;
  charge?: string;
  trade_id?: string;
  buyer_id?: string;
  // Refusionen fra et tidligere forsøg (null = ingen).
  refund_id?: string | null;
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
  // 1. Opslag hos Stripe (intet er sendt endnu - en fejl her kastes).
  let refund: Stripe.Refund | null;
  let liste: Stripe.ApiList<Stripe.Refund>;
  try {
    const charge = await stripe.charges.retrieve(String(c.charge), {}, KALD);
    liste = await stripe.refunds.list({ payment_intent: pi, limit: 100 }, KALD);
    // Et tidligere forsøgs refusion er fejlet/annulleret hos Stripe: id'et
    // nulstilles under låsen, så registreringen ikke giver en falsk konflikt,
    // og kreditnotaen ikke får et forkert id.
    if (c.refund_id) {
      const gammel = liste.data.find((r) => r.id === c.refund_id);
      if (gammel && (gammel.status === "failed" || gammel.status === "canceled")) {
        const { error: gFejl } = await admin.rpc("betaling_bidhamr_daekker_glem_refund", {
          p_betaling: betalingId,
          p_noegle: noegle,
          p_fejlet_refund: gammel.id,
        });
        if (gFejl) throw new Error(`betaling_bidhamr_daekker_glem_refund: ${gFejl.message}`);
      }
    }
    const aktive = liste.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
    refund = aktive.find((r) => r.metadata?.bidhamr_daekker === betalingId) ?? null;
    if (!refund) {
      if (liste.has_more || aktive.length > 0 || Number(charge.amount_refunded) > 0 || Number(charge.amount) < R) {
        await frigiv(betalingId, noegle, "Der findes allerede en anden refusion på betalingen hos Stripe");
        await logDriftFejl({
          kilde: "action",
          hvor: "betaling/bidhamr-daekker",
          fejl: `BidHamr dækker stoppet for betaling ${betalingId}: der findes allerede en anden refusion hos Stripe (eller beløbet passer ikke). Intet er sendt. Kontrollér betalingen i Stripe.`,
        });
        return "konflikt";
      }
    }
  } catch (err) {
    const kode = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt";
    await frigiv(betalingId, noegle, `Fejl hos Stripe (${kode})`);
    throw err;
  }

  // 2. Refusionen oprettes (fast nøgle: et gentaget kald giver samme
  //    refusion tilbage og refunderer aldrig to gange - også et fejlsvar
  //    gentages i op til 24 timer, deraf "prøv igen i morgen").
  if (!refund) {
    try {
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
    } catch (err) {
      // Stripe afviste kaldet (4xx): intet er sendt. Ellers (netværk, 5xx,
      // timeout) ved vi ikke, om refusionen er oprettet - det samme kald med
      // samme nøgle afklarer det uden risiko for to refusioner.
      const afvist =
        err instanceof Stripe.errors.StripeInvalidRequestError ||
        err instanceof Stripe.errors.StripeCardError ||
        err instanceof Stripe.errors.StripePermissionError;
      const kode = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt";
      await frigiv(betalingId, noegle, afvist ? `Stripe afviste refusionen (${kode})` : `Ukendt svar fra Stripe (${kode})`);
      console.error("BidHamr dækker: refunds.create fejlede:", betalingId, err);
      return afvist ? "stripe_afviste" : "uafklaret";
    }
    // Den faste nøgle kan give en tidligere refusion tilbage, som siden er
    // fejlet hos Stripe (svaret er gemt med status fra dengang).
    const tidligere = liste.data.find((r) => r.id === refund!.id);
    if (tidligere && (tidligere.status === "failed" || tidligere.status === "canceled")) {
      await frigiv(betalingId, noegle, `Stripe: refusionen er ${tidligere.status}`);
      return "stripe_afviste";
    }
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    await frigiv(betalingId, noegle, `Stripe: refusionen er ${refund.status}`);
    return "stripe_afviste";
  }

  // 3. Refusionen findes hos Stripe: registreres. Fejler det, må UI'et ikke
  //    sige "intet er sendt" - webhooken (charge.refunded) registrerer den.
  const sendt = refund;
  try {
    const { data: reg, error: rFejl } = await admin.rpc("betaling_bidhamr_daekker_registrer", {
      p_betaling: betalingId,
      p_noegle: noegle,
      p_refund: sendt.id,
      p_status: sendt.status ?? "pending",
    });
    if (rFejl) throw new Error(`betaling_bidhamr_daekker_registrer: ${rFejl.message}`);
    const svar = String(reg);
    if (svar === "ok") {
      if (c.buyer_id && c.trade_id) await beskedTilKoeber(c.buyer_id, c.trade_id, R);
      return "refunderet";
    }
    // Afventer bekræftelse (webhooken afslutter) - låsen frigives.
    await frigiv(betalingId, noegle, null);
    if (svar === "afventer") return "afventer";
    if (svar === "ikke_laast") return "ikke_laast";
    throw new Error(`betaling_bidhamr_daekker_registrer svarede '${svar}'`);
  } catch (err) {
    console.error("BidHamr dækker: refusionen er sendt, men ikke registreret:", betalingId, sendt.id, err);
    await frigiv(betalingId, noegle, "Refusionen er oprettet hos Stripe, men kunne ikke registreres");
    await logDriftFejl({
      kilde: "action",
      hvor: "betaling/bidhamr-daekker",
      fejl: `BidHamr dækker: refusion ${sendt.id} (status '${sendt.status}') er oprettet hos Stripe for betaling ${betalingId}, men kunne ikke registreres i databasen: ${err instanceof Error ? err.message : String(err)}. Kontrollér betalingen i Stripe - webhooken registrerer den, når Stripe bekræfter.`,
    });
    return "konflikt_efter";
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
