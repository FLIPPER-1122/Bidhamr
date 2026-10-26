// Scenarie: køberens bank laver en indsigelse (chargeback, testkort 0259),
// før der er udbetalt. Pengene fryses (ingen frigivelse/udbetaling), og da
// indsigelsen tabes, hentes sælgerens del tilbage fra hans Stripe-konto.
// BidHamr står lige (gebyret dækker), bortset fra Stripes indsigelsesgebyr.
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  forventet,
  koeberGodkender,
  opretHandel,
  rydOp,
  saldo,
  sendWebhook,
  stripe,
  stripeTal,
  ventPaa,
  type TestHandel,
} from "./handel";

let h: TestHandel;
let konto: string;
let start = 0;
let dispute: Stripe.Dispute;
// Bud 200 kr.: sælgergebyr 5 % + 5 = 15 kr. -> U = 185 kr.
const X = forventet(20_000);

beforeAll(async () => {
  konto = await forberedSaelger();
  const s = await saldo(konto);
  start = s.tilgaengelig + s.afventer;
  h = await opretHandel({ navn: "indsigelse-foer-udbetaling", budOere: 20_000 });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("indsigelse tabt før udbetaling", () => {
  it("indsigelsen kommer: pengene fryses, frigivelse afvises", async () => {
    const pi = await betal(h, { kort: "pm_card_createDispute" });
    expect(pi.status).toBe("succeeded");
    const liste = await ventPaa(
      () => stripe().disputes.list({ payment_intent: pi.id, limit: 1 }),
      (l) => l.data.length > 0,
      120_000,
    );
    expect(liste.data.length).toBe(1);
    dispute = liste.data[0];
    expect((await sendWebhook("charge.dispute.created", dispute as unknown as { id: string })).status).toBe(200);
    const b = await betaling(h.betalingId);
    expect(b.stripe_dispute_id).toBe(dispute.id);
    const { data: grund } = await admin().rpc("betaling_udbetaling_blokeret", { p_betaling: h.betalingId });
    expect(grund).not.toBeNull();
    const r = (await koeberGodkender(h)) as { fejl?: string };
    expect(r.fejl).toMatch(/indsigelse/);
    expect((await betaling(h.betalingId)).saelger_udbetaling_id).toBeNull();
  });

  it("indsigelsen tabes: sælgerens del tilbageføres, sælgeren står med 0", async () => {
    // Testmiljøet: "losing_evidence" gør, at indsigelsen tabes.
    await stripe().disputes.update(dispute.id, {
      evidence: { uncategorized_text: "losing_evidence" },
      submit: true,
    });
    const tabt = await ventPaa(
      () => stripe().disputes.retrieve(dispute.id),
      (d) => d.status === "lost",
      120_000,
    );
    expect(tabt.status).toBe("lost");
    expect((await sendWebhook("charge.dispute.closed", tabt as unknown as { id: string })).status).toBe(200);
    const b = await betaling(h.betalingId);
    expect(b.indsigelse_status).toBe("lost");
    expect(b.indsigelse_tabt_afklaret).toBe("tilbagefoert");
    const t = await stripeTal(b);
    // U = 200 - 15 = 185 kr. hentet tilbage.
    expect(X.udbetaling).toBe(18_500);
    expect(t.tilbagefoert).toBe(X.udbetaling);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(start);
    expect(b.saelger_udbetaling_id).toBeNull();
  });

  it("samme event igen og cron'en henter ikke beløbet to gange", async () => {
    const d = await stripe().disputes.retrieve(dispute.id);
    expect((await sendWebhook("charge.dispute.closed", d as unknown as { id: string })).status).toBe(200);
    const { tilbagefoerTabteIndsigelserVentende } = await import("@/lib/betaling/indsigelse");
    await tilbagefoerTabteIndsigelserVentende();
    const t = await stripeTal(await betaling(h.betalingId));
    expect(t.tilbagefoert).toBe(X.udbetaling);
  });
});
