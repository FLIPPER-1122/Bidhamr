import "server-only";

// Betalingsmodel trin 4: refusion af en destination-betaling
// (docs/BETALINGSMODEL-PLAN.md 1.5 og 6.4, migration 20261011040000).
//
// Købers penge står på sælgerens Stripe Connect-konto (transfer T = hele
// beløbet), og BidHamrs application fee F er trukket derfra; sælgeren står
// med U = T - F (udbetaling_oere). En refusion R til køberen laves i tre
// eksakte trin efter en plan, der låses i databasen (betaling_refusionsplan):
//   S = fra sælgerens konto  = U (sælgeren får intet, når køberen får pengene)
//   G = gebyr-refusion       = R - S
//   (a) applicationFees.createRefund(G)   -> sælgerens konto: U + G
//   (b) transfers.createReversal(R)       -> sælgerens konto: U + G - R = 0
//   (c) refunds.create(R) fra platformen  -> køberen får R
// Fuld refusion (annullering): R = T, G = F. Sag med medhold: R = T -
// Beskyttelse, G = F - Beskyttelse (BidHamr beholder kun Beskyttelsen).
// Ingen proportionel afrunding hos Stripe (begge beløb angives eksakt), og
// sælgerens saldo bliver aldrig negativ undervejs (gebyret først, så
// tilbageførslen; saldoen tjekkes før begge).
//
// Hvert trin afgøres ud fra Stripes FAKTISKE tilstand (fee.amount_refunded,
// transfer.amount_reversed), så et afbrudt forsøg eller en refusion, der
// fejler bagefter (fx testkort 4000 0000 0000 5126), aldrig tilbagefører to
// gange: et nyt forsøg laver kun det, der mangler (typisk kun (c)).
//
// Kaldes kun af refunderUnderLaas (stripeBetaling.ts) under refusionslåsen.

import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import type { BetalingRaekke } from "@/lib/betaling/stripeBetaling";

export type DestinationForberedt =
  | { kode: "klar"; refusionOere: number }
  | { kode: "konflikt"; besked: string }
  | { kode: "indsigelse" };

type Plan = {
  kode: string;
  refusion_oere?: number;
  fra_saelger_oere?: number;
  gebyr_oere?: number;
  application_fee_oere?: number;
  saelger_stripe_konto?: string;
  gebyr_refunderet?: boolean;
  tilbagefoert?: boolean;
};

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Tilgængelig + afventende saldo (DKK) på sælgerens konto.
async function saldoIAlt(konto: string, opts: Stripe.RequestOptions): Promise<number> {
  const saldo = await getStripe().balance.retrieve({}, { ...opts, stripeAccount: konto });
  let sum = 0;
  for (const x of [...(saldo.available ?? []), ...(saldo.pending ?? [])]) {
    if (x.currency === "dkk") sum += Number(x.amount);
  }
  return sum;
}

async function registrerTrin(
  betalingId: string,
  laas: string,
  trin: "gebyr" | "tilbagefoersel",
  stripeObjektId: string | null,
): Promise<void> {
  const { data, error } = await createAdminClient().rpc("betaling_refusion_trin", {
    p_betaling: betalingId,
    p_noegle: laas,
    p_trin: trin,
    p_stripe_id: stripeObjektId,
  });
  if (error) throw new Error(`betaling_refusion_trin: ${error.message}`);
  // Låsen er tabt (udløbet): stop - næste forsøg ser Stripes tilstand.
  if (data !== true) throw new Error(`Refusionstrinnet '${trin}' kunne ikke registreres (låsen er udløbet).`);
}

async function saldoAlarm(b: BetalingRaekke, konto: string): Promise<void> {
  await logDriftFejl({
    kilde: "server",
    hvor: "betaling/saldo",
    fejl: `Refusion stoppet: sælgerkonto ${konto} har ikke nok på saldoen til at tilbageføre handlen (${b.trade_id}) uden at gå i minus. Kontrollér kontoen i Stripe.`,
    brugerId: b.seller_id,
  });
}

// Trin (a) og (b). Returnerer "klar", når køberen nu kan refunderes R fra
// platformen (uden reverse_transfer/refund_application_fee).
export async function forberedDestinationRefusion(
  b: BetalingRaekke,
  laas: string,
  forsoeg: number,
  maal: number,
  opts: Stripe.RequestOptions,
): Promise<DestinationForberedt> {
  const admin = createAdminClient();
  const stripe = getStripe();

  const { data: planData, error: planFejl } = await admin.rpc("betaling_refusionsplan", {
    p_betaling: b.id,
    p_noegle: laas,
  });
  if (planFejl) throw new Error(`betaling_refusionsplan: ${planFejl.message}`);
  const plan = planData as Plan;
  if (plan.kode === "indsigelse") return { kode: "indsigelse" };
  if (plan.kode === "ikke_laast") throw new Error("Refusionslåsen er udløbet - prøves igen.");
  if (plan.kode !== "ok") {
    return {
      kode: "konflikt",
      besked: `Refusionsplanen kan ikke laves (${plan.kode}) - håndtér refusionen manuelt`,
    };
  }
  const R = Number(plan.refusion_oere);
  const S = Number(plan.fra_saelger_oere);
  const G = Number(plan.gebyr_oere);
  const konto = String(plan.saelger_stripe_konto);
  if (![R, S, G].every(Number.isInteger) || R !== S + G || R !== maal) {
    return { kode: "konflikt", besked: "Refusionsplanen passer ikke med refusionsbeløbet - refusion stoppet" };
  }

  if (!b.stripe_charge_id) throw new Error(`Ingen charge at refundere for betaling ${b.id}`);
  const charge = await stripe.charges.retrieve(
    b.stripe_charge_id,
    { expand: ["transfer", "application_fee"] },
    opts,
  );
  if (charge.disputed) return { kode: "indsigelse" };
  const transfer = charge.transfer && typeof charge.transfer !== "string" ? charge.transfer : null;
  const fee =
    charge.application_fee && typeof charge.application_fee !== "string" ? charge.application_fee : null;
  if (
    charge.currency !== "dkk" ||
    Number(charge.amount) !== Number(b.total_oere) ||
    stripeId(charge.transfer_data?.destination ?? null) !== konto ||
    !transfer ||
    stripeId(transfer.destination) !== konto ||
    Number(transfer.amount) !== Number(charge.amount) ||
    !fee ||
    Number(fee.amount) !== Number(plan.application_fee_oere)
  ) {
    return {
      kode: "konflikt",
      besked: "Betalingen hos Stripe passer ikke med handlen (beløb, gebyr eller sælgerkonto) - refusion stoppet",
    };
  }
  if (Number(charge.amount_refunded) > 0) {
    return { kode: "konflikt", besked: "Betalingen er allerede delvist refunderet hos Stripe - kontrollér, før der refunderes" };
  }

  const gebyrRefunderet = Number(fee.amount_refunded);
  const tilbagefoert = Number(transfer.amount_reversed);

  // (a) Gebyret tilbage til sælgerens konto.
  if (gebyrRefunderet !== G) {
    if (gebyrRefunderet !== 0 || plan.gebyr_refunderet) {
      return { kode: "konflikt", besked: "BidHamrs gebyr er refunderet med et andet beløb hos Stripe - refusion stoppet" };
    }
    if (tilbagefoert !== 0) {
      return { kode: "konflikt", besked: "Overførslen til sælgeren er tilbageført uden gebyr-refusion - refusion stoppet" };
    }
    if ((await saldoIAlt(konto, opts)) < S) {
      await saldoAlarm(b, konto);
      return { kode: "konflikt", besked: "Sælgerens Stripe-konto har for lidt på saldoen til refusionen - refusion stoppet" };
    }
    const fr = await stripe.applicationFees.createRefund(
      fee.id,
      { amount: G, metadata: { betaling_id: b.id, handel_id: b.trade_id, trin: "gebyr" } },
      { ...opts, idempotencyKey: `bidhamr-gebyr-refusion-${b.id}-${forsoeg}` },
    );
    if (Number(fr.amount) !== G) {
      return { kode: "konflikt", besked: "Gebyr-refusionen hos Stripe har et andet beløb end planen - refusion stoppet" };
    }
    await registrerTrin(b.id, laas, "gebyr", fr.id);
  } else if (!plan.gebyr_refunderet) {
    // Gennemført hos Stripe, men ikke registreret (afbrudt forsøg).
    let id: string | null = null;
    if (G > 0) {
      const liste = await stripe.applicationFees.listRefunds(fee.id, { limit: 10 }, opts);
      id = liste.data.find((r) => r.metadata?.betaling_id === b.id)?.id ?? liste.data[0]?.id ?? null;
    }
    await registrerTrin(b.id, laas, "gebyr", id);
  }

  // (b) R tilbage fra sælgerens konto til platformen.
  if (tilbagefoert !== R) {
    if (tilbagefoert !== 0 || plan.tilbagefoert) {
      return { kode: "konflikt", besked: "Overførslen til sælgeren er tilbageført med et andet beløb hos Stripe - refusion stoppet" };
    }
    if ((await saldoIAlt(konto, opts)) < R) {
      await saldoAlarm(b, konto);
      return { kode: "konflikt", besked: "Sælgerens Stripe-konto har for lidt på saldoen til refusionen - refusion stoppet" };
    }
    const rev = await stripe.transfers.createReversal(
      transfer.id,
      {
        amount: R,
        refund_application_fee: false,
        metadata: { betaling_id: b.id, handel_id: b.trade_id, trin: "refusion" },
      },
      { ...opts, idempotencyKey: `bidhamr-refusion-tilbagefoersel-${b.id}-${forsoeg}` },
    );
    if (Number(rev.amount) !== R) {
      return { kode: "konflikt", besked: "Tilbageførslen hos Stripe har et andet beløb end planen - refusion stoppet" };
    }
    await registrerTrin(b.id, laas, "tilbagefoersel", rev.id);
  } else if (!plan.tilbagefoert) {
    const liste = await stripe.transfers.listReversals(transfer.id, { limit: 10 }, opts);
    const rev = liste.data.find((r) => r.metadata?.betaling_id === b.id) ?? liste.data[0] ?? null;
    await registrerTrin(b.id, laas, "tilbagefoersel", rev?.id ?? null);
  }

  return { kode: "klar", refusionOere: R };
}

// Afstemning efter en gennemført refusion af en destination-betaling (også
// en refusion lavet direkte i Stripe-dashboardet): sælgeren skal stå med 0
// på handlen (transfer - tilbageført - (gebyr - gebyr refunderet) = 0).
// Ellers markering til staff og drift-alarm. Kaster aldrig.
export async function kontrollerDestinationRefusion(paymentIntentId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: b } = await admin
      .from("betalinger")
      .select("id, trade_id, seller_id, pengemodel, stripe_charge_id, status")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .maybeSingle<{ id: string; trade_id: string; seller_id: string; pengemodel: string; stripe_charge_id: string | null; status: string }>();
    if (!b || b.pengemodel !== "destination" || b.status !== "refunderet" || !b.stripe_charge_id) return;
    const charge = await getStripe().charges.retrieve(b.stripe_charge_id, {
      expand: ["transfer", "application_fee"],
    });
    const transfer = charge.transfer && typeof charge.transfer !== "string" ? charge.transfer : null;
    const fee =
      charge.application_fee && typeof charge.application_fee !== "string" ? charge.application_fee : null;
    if (!transfer || !fee) return;
    const tilbage =
      Number(transfer.amount) - Number(transfer.amount_reversed) - (Number(fee.amount) - Number(fee.amount_refunded));
    if (tilbage === 0) return;
    const tekst =
      tilbage > 0
        ? "Refunderet hos Stripe, men pengene er ikke (helt) taget tilbage fra sælgerens Stripe-konto - kontrollér tilbageførslen"
        : "Refunderet hos Stripe, men der er taget mere fra sælgerens Stripe-konto end handlen - kontrollér tilbageførslen";
    await admin.rpc("betaling_marker_opmaerksomhed", { p_payment_intent: paymentIntentId, p_besked: tekst });
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/refusion-afstemning",
      fejl: `${tekst} (handel ${b.trade_id}).`,
      brugerId: b.seller_id,
    });
  } catch (err) {
    console.error("kontrollerDestinationRefusion fejlede:", paymentIntentId, err);
  }
}
