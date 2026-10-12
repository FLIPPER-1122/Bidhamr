// Scenarie: køberens bank laver en indsigelse EFTER, at pengene er udbetalt
// til sælgerens bank, og BidHamr taber den. Reglen (Filip, 2. og 8. okt.
// 2026): intet trækkes fra sælgeren - BidHamr bærer tabet.
//
// Stripes testmiljø kan kun lave en indsigelse i samme øjeblik som betalingen
// (testkort 0259), og så stopper BidHamrs tjek før udbetaling (F03) netop
// udbetalingen. Derfor: rigtig betaling, rigtig frigivelse og rigtig payout
// (paid) hos Stripe - og derefter et SIMULERET dispute-objekt (status lost)
// for den rigtige charge, som Stripes API giver det. Alt andet (webhook-ruten,
// spejlingen, tilbageførselsvejen, Stripe-tjekket af transferen) er rigtigt.
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  betal,
  betaling,
  forberedSaelger,
  koeberGodkender,
  opretHandel,
  rydOp,
  saelgerUdbetaling,
  saldo,
  sendWebhook,
  stripe,
  stripeTal,
  ventPaaPayout,
  type TestHandel,
} from "./handel";

let h: TestHandel;
let konto: string;
let falsk: Stripe.Dispute;

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "indsigelse-efter-udbetaling", budOere: 12_000 });
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (h) await rydOp(h);
});

describe("indsigelse tabt efter udbetaling", () => {
  it("betaling, frigivelse og payout til banken (paid)", async () => {
    await betal(h);
    expect(await koeberGodkender(h)).toEqual({ ok: true });
    const b = await betaling(h.betalingId);
    const u = await saelgerUdbetaling(b.saelger_udbetaling_id!);
    const p = await ventPaaPayout(konto, u.stripe_payout_id!);
    expect(p.status).toBe("paid");
    expect((await sendWebhook("payout.paid", p as unknown as { id: string }, { konto })).status).toBe(200);
    expect((await saelgerUdbetaling(u.id)).status).toBe("paid");
  });

  it("indsigelsen tabes: intet trækkes fra sælgeren, BidHamr bærer tabet", async () => {
    const b = await betaling(h.betalingId);
    const foer = await saldo(konto);
    falsk = {
      id: `dp_test_pengetest_${h.betalingId.slice(0, 8)}`,
      object: "dispute",
      amount: b.total_oere,
      currency: "dkk",
      charge: b.stripe_charge_id!,
      payment_intent: b.stripe_payment_intent_id!,
      status: "lost",
      reason: "fraudulent",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      is_charge_refundable: false,
      balance_transactions: [],
      metadata: {},
      evidence: {} as Stripe.Dispute.Evidence,
      evidence_details: {
        due_by: Math.floor(Date.now() / 1000) + 7 * 86_400,
        has_evidence: false,
        past_due: false,
        submission_count: 0,
      } as Stripe.Dispute.EvidenceDetails,
    } as unknown as Stripe.Dispute;
    const disputes = stripe().disputes;
    vi.spyOn(disputes, "retrieve").mockImplementation((async () => falsk) as never);
    vi.spyOn(disputes, "list").mockImplementation((async () => ({ object: "list", data: [falsk], has_more: false, url: "" })) as never);

    expect((await sendWebhook("charge.dispute.created", falsk as unknown as { id: string })).status).toBe(200);
    expect((await sendWebhook("charge.dispute.closed", falsk as unknown as { id: string })).status).toBe(200);

    const efter = await betaling(h.betalingId);
    expect(efter.indsigelse_status).toBe("lost");
    expect(efter.indsigelse_tabt_afklaret).toBe("udbetalt");
    expect(efter.kraever_opmaerksomhed).toBe(true);
    // Rigtigt opslag hos Stripe: ingen tilbageførsel fra sælgeren.
    const t = await stripeTal(efter);
    expect(t.tilbagefoert).toBe(0);
    const nu = await saldo(konto);
    expect(nu.tilgaengelig + nu.afventer).toBe(foer.tilgaengelig + foer.afventer);
  });

  it("cron'en prøver ikke at hente beløbet tilbage bagefter", async () => {
    const { tilbagefoerTabteIndsigelserVentende } = await import("@/lib/betaling/indsigelse");
    await tilbagefoerTabteIndsigelserVentende();
    const t = await stripeTal(await betaling(h.betalingId));
    expect(t.tilbagefoert).toBe(0);
    vi.restoreAllMocks();
  });
});
