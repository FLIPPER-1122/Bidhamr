// Scenarie: Stripe leverer samme event to gange, events i forkert rækkefølge,
// et forældet event efter et nyere, og falske/forældede signaturer. Ingen
// dobbelt effekt, og intet behandles uden gyldig signatur.
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  fuldRefusion,
  koeberGodkender,
  opretHandel,
  rydOp,
  saelgerUdbetaling,
  sendWebhook,
  stripe,
  ventPaaPayout,
  ventPaaTransfer,
  type TestHandel,
} from "./handel";

let h: TestHandel;
let konto: string;
let pi: Stripe.PaymentIntent;
let charge: Stripe.Charge;

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "webhook-dobbelt", budOere: 7_000 });
  // Betal UDEN webhooks - testen leverer dem selv.
  pi = await betal(h, { medWebhook: false });
  charge = await ventPaaTransfer(pi.latest_charge as string);
});

afterAll(async () => {
  if (h) await rydOp(h);
});

async function antalNotifikationer(noegle: string): Promise<number> {
  const { count } = await admin()
    .from("notifikation_afsendelser")
    .select("noegle", { count: "exact", head: true })
    .eq("noegle", noegle);
  return count ?? 0;
}

describe("webhooks: gentagelser, rækkefølge og signatur", () => {
  it("falsk signatur og forældet signatur afvises (400), intet ændres", async () => {
    const frisk = await stripe().paymentIntents.retrieve(pi.id);
    const falsk = await sendWebhook("payment_intent.succeeded", frisk as unknown as { id: string }, {
      signatur: "t=1,v1=" + "0".repeat(64),
    });
    expect(falsk.status).toBe(400);
    const payload = "{}";
    const gammel = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    const forsinket = await sendWebhook("payment_intent.succeeded", frisk as unknown as { id: string }, {
      signatur: gammel,
    });
    expect(forsinket.status).toBe(400);
    expect((await betaling(h.betalingId)).status).toBe("afventer");
  });

  it("charge.updated før payment_intent.succeeded: ingen betaling registreres af charge-eventet alene", async () => {
    const r = await sendWebhook("charge.updated", charge as unknown as { id: string });
    expect(r.status).toBe(200);
    expect((await betaling(h.betalingId)).status).toBe("afventer");
  });

  it("forældet payment_failed-event efter betalingen: Stripes friske status vinder", async () => {
    const gammeltObjekt = { ...pi, status: "requires_payment_method" } as unknown as { id: string };
    const r = await sendWebhook("payment_intent.payment_failed", gammeltObjekt);
    expect(r.status).toBe(200);
    expect((await betaling(h.betalingId)).status).toBe("betalt");
  });

  it("samme event to gange og et nyt event for samme betaling: ingen dobbelt effekt", async () => {
    const foer = await betaling(h.betalingId);
    const frisk = await stripe().paymentIntents.retrieve(pi.id);
    const eventId = `evt_test_pengetest_dobbelt_${h.betalingId.replace(/-/g, "")}`;
    const r1 = await sendWebhook("payment_intent.succeeded", frisk as unknown as { id: string }, { eventId });
    const r2 = await sendWebhook("payment_intent.succeeded", frisk as unknown as { id: string }, { eventId });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.gentaget).toBe(true);
    const r3 = await sendWebhook("payment_intent.succeeded", frisk as unknown as { id: string });
    expect(r3.status).toBe(200);
    const efter = await betaling(h.betalingId);
    expect(efter.status).toBe("betalt");
    expect(efter.betalt_kl).toBe(foer.betalt_kl);
    // "Køberen har betalt" til sælgeren: præcis én gang.
    expect(await antalNotifikationer(`betalt:${h.tradeId}`)).toBe(1);
    const ch = await sendWebhook("charge.updated", (await ventPaaTransfer(charge.id)) as unknown as { id: string });
    expect(ch.status).toBe(200);
    expect((await betaling(h.betalingId)).stripe_destination_transfer_id).toBe(efter.stripe_destination_transfer_id);
  });

  it("payout.paid to gange og balance.available: én udbetaling", async () => {
    expect(await koeberGodkender(h)).toEqual({ ok: true });
    const b = await betaling(h.betalingId);
    const u = await saelgerUdbetaling(b.saelger_udbetaling_id!);
    const p = await ventPaaPayout(konto, u.stripe_payout_id!);
    for (let i = 0; i < 2; i++) {
      expect((await sendWebhook("payout.paid", p as unknown as { id: string }, { konto })).status).toBe(200);
    }
    const bal = await stripe().balance.retrieve({}, { stripeAccount: konto });
    expect((await sendWebhook("balance.available", { id: "balance", ...bal } as unknown as { id: string }, { konto })).status).toBe(200);
    expect((await saelgerUdbetaling(u.id)).status).toBe("paid");
    const payouts = await stripe().payouts.list({ limit: 100 }, { stripeAccount: konto });
    expect(payouts.data.filter((x) => x.metadata?.saelger_udbetaling_id === u.id).length).toBe(1);
    // En refusion efter udbetalingen er stadig afvist.
    expect((await fuldRefusion(h)).claimet).toBeNull();
  });
});
