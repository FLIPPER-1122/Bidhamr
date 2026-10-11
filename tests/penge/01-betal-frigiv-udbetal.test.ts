// Scenarie: køberen betaler -> køberen godkender varen (frigivelse) ->
// BidHamr udbetaler fra sælgerens Connect-konto til banken -> payout.paid.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  ventPaaPayout,
  type TestHandel,
} from "./handel";

let h: TestHandel;
let konto: string;
// Sælgerens saldo før testen (andre testfiler bruger samme testkonto).
let start = 0;

beforeAll(async () => {
  konto = await forberedSaelger();
  const s = await saldo(konto);
  start = s.tilgaengelig + s.afventer;
  h = await opretHandel({ navn: "betal-frigiv-udbetal", budOere: 50_000, beskyttelse: true });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("betal -> frigiv -> payout", () => {
  it("betaling: destination charge med BidHamrs gebyrer som application fee", async () => {
    const pi = await betal(h);
    expect(pi.status).toBe("succeeded");
    const b = await betaling(h.betalingId);
    // bud 500 + købergebyr 25 + fragt 40 + Beskyttelse 25 = 590 kr.
    expect(b.total_oere).toBe(59_000);
    expect(pi.amount).toBe(59_000);
    expect(pi.on_behalf_of).toBe(konto);
    expect(pi.transfer_data?.destination).toBe(konto);
    // Gebyr = købergebyr + sælgergebyr + fragt + Beskyttelse = 25 + 25 + 40 + 25.
    expect(pi.application_fee_amount).toBe(11_500);
    expect(b.application_fee_oere).toBe(11_500);
    expect(b.status).toBe("betalt");
    // Sælgeren står med total - gebyr = bud - sælgergebyr.
    expect(pi.amount - (pi.application_fee_amount ?? 0)).toBe(b.udbetaling_oere);
    expect(b.udbetaling_oere).toBe(47_500);
    expect(b.stripe_destination_transfer_id).toBeTruthy();
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer - start).toBe(47_500);
  });

  it("frigivelse: køberen godkender, og udbetalingen sendes til sælgerens bank", async () => {
    const r = await koeberGodkender(h);
    expect(r).toEqual({ ok: true });
    const b = await betaling(h.betalingId);
    expect(b.frigivet_kl).toBeTruthy();
    expect(b.saelger_udbetaling_id).toBeTruthy();
    expect(b.overfoert_kl).toBeTruthy();
    const u = await saelgerUdbetaling(b.saelger_udbetaling_id!);
    expect(u.status).toBe("oprettet");
    expect(u.beloeb_oere).toBe(47_500);
    expect(u.betaling_ids).toContain(h.betalingId);
    const p = await stripe().payouts.retrieve(u.stripe_payout_id!, undefined, { stripeAccount: konto });
    expect(p.amount).toBe(47_500);
    expect(p.metadata?.saelger_udbetaling_id).toBe(u.id);
  });

  it("payout.paid spejles, og sælgerens saldo er tilbage, hvor den startede", async () => {
    const b = await betaling(h.betalingId);
    const u = await saelgerUdbetaling(b.saelger_udbetaling_id!);
    const p = await ventPaaPayout(konto, u.stripe_payout_id!);
    expect(p.status).toBe("paid");
    const svar = await sendWebhook("payout.paid", p as unknown as { id: string }, { konto });
    expect(svar.status).toBe(200);
    expect((await saelgerUdbetaling(u.id)).status).toBe("paid");
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(start);
  });
});
