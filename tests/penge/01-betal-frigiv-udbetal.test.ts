// Scenarie: køberen betaler -> køberen godkender varen (frigivelse) ->
// BidHamr udbetaler fra sælgerens Connect-konto til banken -> payout.paid.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  betal,
  betaling,
  forberedSaelger,
  forventet,
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
// Bud 500 kr. (ny prismodel): købergebyr 7 % + 5 = 40 kr., sælgergebyr 5 % + 5
// = 30 kr., fragt 42 kr. -> total 582 kr., gebyr 112 kr., udbetaling 470 kr.
const BUD = 50_000;
const X = forventet(BUD);

beforeAll(async () => {
  konto = await forberedSaelger();
  const s = await saldo(konto);
  start = s.tilgaengelig + s.afventer;
  h = await opretHandel({ navn: "betal-frigiv-udbetal", budOere: BUD });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("betal -> frigiv -> payout", () => {
  it("betaling: destination charge med BidHamrs gebyrer som application fee", async () => {
    const pi = await betal(h);
    expect(pi.status).toBe("succeeded");
    const b = await betaling(h.betalingId);
    // bud 500 + gebyr 40 (BidHamr Beskyttelse inkluderet) + fragt 42 = 582 kr.
    expect(X.total).toBe(58_200);
    expect(b.total_oere).toBe(X.total);
    expect(pi.amount).toBe(X.total);
    expect(pi.on_behalf_of).toBe(konto);
    expect(pi.transfer_data?.destination).toBe(konto);
    // Betalingsmetoder (Filip, 20. okt. 2026): præcis kort, MobilePay og
    // Revolut Pay - ingen automatic_payment_methods, Klarna eller Link.
    // Testkontoen har alle tre capabilities aktive (global.ts).
    expect(pi.payment_method_types).toEqual(["card", "mobilepay", "revolut_pay"]);
    expect(pi.automatic_payment_methods?.enabled ?? false).toBe(false);
    // Gebyr = købergebyr + sælgergebyr + fragt = 40 + 30 + 42 = 112 kr.
    expect(X.gebyr).toBe(11_200);
    expect(pi.application_fee_amount).toBe(X.gebyr);
    expect(b.application_fee_oere).toBe(X.gebyr);
    expect(b.status).toBe("betalt");
    // Sælgeren står med total - gebyr = bud - sælgergebyr.
    expect(pi.amount - (pi.application_fee_amount ?? 0)).toBe(b.udbetaling_oere);
    expect(X.udbetaling).toBe(47_000);
    expect(b.udbetaling_oere).toBe(X.udbetaling);
    expect(b.stripe_destination_transfer_id).toBeTruthy();
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer - start).toBe(X.udbetaling);
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
    expect(u.beloeb_oere).toBe(X.udbetaling);
    expect(u.betaling_ids).toContain(h.betalingId);
    const p = await stripe().payouts.retrieve(u.stripe_payout_id!, undefined, { stripeAccount: konto });
    expect(p.amount).toBe(X.udbetaling);
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
