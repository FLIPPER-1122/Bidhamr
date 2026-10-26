// Scenarie: handlen er sendt (BidHamr Beskyttelse er inkluderet), køberen
// opretter en sag (varen er gået i stykker), staff giver køberen medhold, og
// ankefristen udløber. Ny prismodel (Filip, 26. okt. 2026 - som Trendsales):
// køberen får KUN buddet tilbage (delvis refusion i tre trin hos Stripe),
// sælgeren står med 0, og BidHamr beholder købergebyr og fragt
// (refusionsplanen: S = U, G = R - S = sælgergebyret).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udfoerSagAfvikling, type SagAfvikling } from "@/lib/sagerServer";
import { betal, betaling, forberedSaelger, forventet, opretHandel, admin, rydOp, saldo, stripeTal, type TestHandel } from "./handel";
import { CHEF_ID } from "./brugere";

let h: TestHandel;
let konto: string;
let sagId: string;
// Bud 500 kr.: total 582 kr. (gebyr 40 + fragt 42), application fee 112 kr.,
// udbetaling 470 kr., sælgergebyr 30 kr.
const BUD = 50_000;
const X = forventet(BUD);

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "sag-medhold", budOere: BUD });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("sag med medhold og refusion", () => {
  it("betaling og sag: pengene er frosset, mens sagen er åben", async () => {
    await betal(h);
    const nu = new Date().toISOString();
    const db = admin();
    const { error: tFejl } = await db
      .from("trades")
      .update({ status: "modtaget", sendt_kl: nu, received_at: nu, tracking_number: "TESTPENGE", sag_aaben: true })
      .eq("id", h.tradeId);
    expect(tFejl).toBeNull();
    const { data: s, error } = await db
      .from("sager")
      .insert({
        trade_id: h.tradeId,
        oprettet_af: h.koeber.id,
        type: "skadet",
        beskrivelse: "TEST pengetest: varen kom frem i stykker.",
        status: "aaben",
        beskyttelse: true,
        handel_status_ved_oprettelse: "modtaget",
      })
      .select("id")
      .single<{ id: string }>();
    expect(error).toBeNull();
    sagId = s!.id;
    const { data: blokeret } = await db.rpc("betaling_udbetaling_blokeret", { p_betaling: h.betalingId });
    expect(blokeret).not.toBeNull();
  });

  it("afgjort til køberen + ankefristen udløbet: køberen får buddet tilbage", async () => {
    const db = admin();
    const nu = new Date().toISOString();
    const { error } = await db
      .from("sager")
      .update({
        status: "afgjort_koeber",
        afgjort_af: CHEF_ID,
        afgjort_kl: nu,
        begrundelse: "TEST pengetest: medhold til køberen.",
        penge_handling: "refunder",
        penge_flyttes_efter_kl: new Date(Date.now() - 60_000).toISOString(),
      })
      .eq("id", sagId);
    expect(error).toBeNull();
    // Samme to trin som betalings-cron'en (afviklForfaldneSager) for én sag.
    const { data: a, error: aFejl } = await db.rpc("sag_afvikl", { p_sag: sagId });
    expect(aFejl).toBeNull();
    expect((a as { kode: string }).kode).toBe("ok");
    const r = await udfoerSagAfvikling(a as SagAfvikling, { notificer: false });
    expect(r).toBe("refunderet");

    const b = await betaling(h.betalingId);
    expect(b.status).toBe("refunderet");
    // Ny model: R = buddet = 500 kr. (gebyr og fragt refunderes ikke).
    expect(b.refusion_oere).toBe(BUD);
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(BUD);
    // Af gebyret (112 kr.) refunderes kun sælgergebyret (G = R - U = 30 kr.).
    expect(t.gebyr).toBe(X.gebyr);
    expect(t.gebyrRefunderet).toBe(X.saelg);
    expect(t.gebyrRefunderet).toBe(BUD - X.udbetaling);
    // Tilbageført fra sælgeren: hans del + det refunderede gebyr = 470 + 30 kr.
    expect(t.tilbagefoert).toBe(X.udbetaling + X.saelg);
    // BidHamr står med købergebyr + fragt (40 + 42 = 82 kr.):
    // gebyr - gebyr-refusion + tilbageført - refunderet.
    expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(X.koeb + X.fragt);
    expect(X.koeb + X.fragt).toBe(8_200);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(0);
    expect(b.saelger_udbetaling_id).toBeNull();
  });

  it("en gentaget afvikling flytter ingen penge igen", async () => {
    const { data: a } = await admin().rpc("sag_afvikl", { p_sag: sagId });
    expect((a as { kode: string }).kode).toBe("intet");
    const b = await betaling(h.betalingId);
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(BUD);
    expect(t.tilbagefoert).toBe(X.udbetaling + X.saelg);
  });
});
