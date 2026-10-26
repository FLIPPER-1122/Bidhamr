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
  forventet,
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
// Ny prismodel (forventet = beregn.ts). Bud 30 kr.: købergebyr 7,10 kr.,
// sælgergebyr 6,50 kr., fragt 42 kr. -> T = 79,10 kr., U = 23,50 kr.
const NUL = { bud: 3_000, ...forventet(3_000) };
// Bud 500 kr.: T = 582 kr., gebyr 112 kr., U = 470 kr., R = bud - returfragt.
const MINDRE = { bud: 50_000, ...forventet(50_000) };
const R_MINDRE = MINDRE.bud - PAKKESHOP_FRAGT_OERE;

beforeAll(async () => {
  konto = await forberedSaelger();
  // Bud 30 kr. < returfragt 42 kr. -> R = 0.
  rNul = await opretHandel({ navn: "ikke-afhentet-R0", budOere: NUL.bud });
  // Bud 500 kr. -> R = 500 - 42 = 458 kr. < U = 470 kr.
  rMindre = await opretHandel({ navn: "ikke-afhentet-R<U", budOere: MINDRE.bud });
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
    // U = 30 - 6,50 = 23,50 kr. tilbageført; intet gebyr refunderet.
    expect(NUL.udbetaling).toBe(2_350);
    expect(t.tilbagefoert).toBe(NUL.udbetaling);
    expect(t.gebyrRefunderet).toBe(0);
    const efter = await saldo(konto);
    expect(foer.tilgaengelig + foer.afventer - (efter.tilgaengelig + efter.afventer)).toBe(NUL.udbetaling);
    // BidHamr står med hele betalingen (T = 30 + 7,10 + 42 = 79,10 kr.).
    expect(NUL.total).toBe(7_910);
    expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(NUL.total);
  });

  it("R < U: køberen får bud - returfragt, sælger står med 0", async () => {
    await betal(rMindre);
    await pakkeSendt(rMindre);
    const svar = await ikkeAfhentet(rMindre);
    expect(svar.kode).toBe("ok");
    expect(R_MINDRE).toBe(45_800);
    expect(svar.refusionOere).toBe(R_MINDRE);
    const b = await betaling(rMindre.betalingId);
    expect(b.status).toBe("refunderet");
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(R_MINDRE);
    // Hele sælgerens del (U = 470 kr.) tilbageføres; G = 0.
    expect(t.tilbagefoert).toBe(MINDRE.udbetaling);
    expect(t.gebyrRefunderet).toBe(0);
    // BidHamr: T - R = 582 - 458 = 124 kr. (gebyr 112 + U - R 12).
    expect(MINDRE.total - R_MINDRE).toBe(12_400);
    expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(MINDRE.total - R_MINDRE);
  });

  it("gentaget registrering ændrer intet", async () => {
    const svar = await ikkeAfhentet(rMindre);
    expect(svar.kode).toBe("allerede");
    const t = await stripeTal(await betaling(rMindre.betalingId));
    expect(t.refunderet).toBe(R_MINDRE);
    expect(t.tilbagefoert).toBe(MINDRE.udbetaling);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBeGreaterThanOrEqual(0);
  });
});
