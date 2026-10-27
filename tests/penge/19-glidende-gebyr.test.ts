// Scenarie: en privat handel over 7.500 kr. med den glidende overgang
// (prismodel 'ny2', 20261102140000 - Filip, 27. okt. 2026). Køberen betaler
// med testkort 4242 (pm_card_visa); beløbet og BidHamrs application fee hos
// Stripe skal være de glidende gebyrer. Derefter fuld refusion, så
// testsælgerens saldo er, hvor den startede.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  betal,
  betaling,
  forberedSaelger,
  forventet,
  fuldRefusion,
  opretHandel,
  rydOp,
  saldo,
  stripe,
  stripeTal,
  type TestHandel,
} from "./handel";

let h: TestHandel;
let konto: string;
let start = 0;
// Bud 9.000 kr. (under chefens grænse på 10.000 kr.): købergebyr 300 + 3 % af
// 1.500 = 345 kr., sælgergebyr 95 + 2 % af 1.500 = 125 kr., fragt 42 kr. ->
// total 9.387 kr., gebyr 512 kr., udbetaling 8.875 kr.
const BUD = 900_000;
const X = forventet(BUD);

beforeAll(async () => {
  konto = await forberedSaelger();
  const s = await saldo(konto);
  start = s.tilgaengelig + s.afventer;
  h = await opretHandel({ navn: "glidende-gebyr", budOere: BUD });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("glidende gebyr over 7.500 kr.", () => {
  it("betalingen har prismodel 'ny2' og de glidende gebyrer", async () => {
    const b = await betaling(h.betalingId);
    expect(b.prismodel).toBe("ny2");
    expect([X.koeb, X.saelg, X.fragt]).toEqual([34_500, 12_500, 4_200]);
    expect([b.koebergebyr_oere, b.saelgergebyr_oere, b.fragt_oere]).toEqual([X.koeb, X.saelg, X.fragt]);
    expect(b.total_oere).toBe(938_700);
    expect(b.udbetaling_oere).toBe(887_500);
  });

  it("kort 4242: Stripe trækker totalen, og application fee = købergebyr + sælgergebyr + fragt", async () => {
    const pi = await betal(h, { kort: "pm_card_visa" });
    expect(pi.status).toBe("succeeded");
    expect(pi.amount).toBe(X.total);
    expect(pi.application_fee_amount).toBe(51_200);
    expect(pi.application_fee_amount).toBe(X.gebyr);
    expect(pi.transfer_data?.destination).toBe(konto);
    const b = await betaling(h.betalingId);
    expect(b.status).toBe("betalt");
    expect(b.application_fee_oere).toBe(X.gebyr);
    const t = await stripeTal(b);
    expect(t.beloeb).toBe(X.total);
    expect(t.gebyr).toBe(X.gebyr);
    expect(t.transfer).toBe(X.total);
    const ch = await stripe().charges.retrieve(b.stripe_charge_id!);
    expect(ch.payment_method_details?.card?.last4).toBe("4242");
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer - start).toBe(X.udbetaling);
  });

  it("fuld refusion: køber får alt, sælgerens saldo er tilbage, hvor den startede", async () => {
    const r = await fuldRefusion(h);
    expect(r.resultat).toBe("refunderet");
    const b = await betaling(h.betalingId);
    expect(b.status).toBe("refunderet");
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(X.total);
    expect(t.gebyrRefunderet).toBe(X.gebyr);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(start);
  });
});
