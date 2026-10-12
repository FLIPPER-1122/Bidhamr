// Scenarie: pakken er ikke hentet i pakkeshoppen og sendt retur til sælgeren
// (ROADMAP-BESLUTNINGER 1, Filip 10. okt. 2026). Køberen får bud - returfragt
// (returfragt = fragten ud); er returfragten >= buddet, får køberen 0 og
// skylder intet. Sælgerens del tilbageføres altid helt (sælgeren står med 0),
// og BidHamr beholder købergebyr, fragt og returfragt.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registrerIkkeAfhentet } from "@/lib/betaling/ikkeAfhentet";
import {
  betal,
  betaling,
  forberedSaelger,
  opretHandel,
  pakkeSendt,
  rydOp,
  saldo,
  stripeTal,
  PAKKESHOP_FRAGT_OERE,
  type TestHandel,
} from "./handel";
import { CHEF_ID } from "./brugere";

let rNul: TestHandel;
let rMindre: TestHandel;
let konto: string;

beforeAll(async () => {
  konto = await forberedSaelger();
  // Bud 30 kr. < returfragt 40 kr. -> R = 0.
  rNul = await opretHandel({ navn: "ikke-afhentet-R0", budOere: 3_000 });
  // Bud 500 kr. -> R = 460 kr. < U = 475 kr.
  rMindre = await opretHandel({ navn: "ikke-afhentet-R<U", budOere: 50_000 });
});

afterAll(async () => {
  for (const h of [rNul, rMindre]) if (h) await rydOp(h);
});

async function ikkeAfhentet(h: TestHandel) {
  return registrerIkkeAfhentet({
    tradeId: h.tradeId,
    kilde: "staff",
    medarbejderId: CHEF_ID,
    begrundelse: "TEST pengetest: pakken kom retur uden at være hentet.",
    refunderNu: true,
  });
}

describe("ikke-afhentet pakke", () => {
  it("R = 0: køberen får intet, sælgerens del tilbageføres, sælger står med 0", async () => {
    await betal(rNul);
    await pakkeSendt(rNul);
    const foer = await saldo(konto);
    const svar = await ikkeAfhentet(rNul);
    expect(svar.kode).toBe("ok_intet");
    expect(svar.refusionOere ?? 0).toBe(0);
    expect(svar.returfragtOere).toBe(PAKKESHOP_FRAGT_OERE);
    const b = await betaling(rNul.betalingId);
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(0);
    // U = 30 - 1,50 = 28,50 kr. tilbageført; intet gebyr refunderet.
    expect(t.tilbagefoert).toBe(2_850);
    expect(t.gebyrRefunderet).toBe(0);
    const efter = await saldo(konto);
    expect(foer.tilgaengelig + foer.afventer - (efter.tilgaengelig + efter.afventer)).toBe(2_850);
    // BidHamr står med hele betalingen (T = 30 + 1,50 + 40 = 71,50 kr.).
    expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(7_150);
  });

  it("R < U: køberen får bud - returfragt, sælger står med 0", async () => {
    await betal(rMindre);
    await pakkeSendt(rMindre);
    const svar = await ikkeAfhentet(rMindre);
    expect(svar.kode).toBe("ok");
    expect(svar.refusionOere).toBe(46_000);
    const b = await betaling(rMindre.betalingId);
    expect(b.status).toBe("refunderet");
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(46_000);
    // Hele sælgerens del (U = 475 kr.) tilbageføres; G = 0.
    expect(t.tilbagefoert).toBe(47_500);
    expect(t.gebyrRefunderet).toBe(0);
    // BidHamr: T - R = 565 - 460 = 105 kr. (gebyr 90 + U - R 15).
    expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(10_500);
  });

  it("gentaget registrering ændrer intet", async () => {
    const svar = await ikkeAfhentet(rMindre);
    expect(svar.kode).toBe("allerede");
    const t = await stripeTal(await betaling(rMindre.betalingId));
    expect(t.refunderet).toBe(46_000);
    expect(t.tilbagefoert).toBe(47_500);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBeGreaterThanOrEqual(0);
  });
});
