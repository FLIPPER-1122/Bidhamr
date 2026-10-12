// Scenarie: køberen har BidHamr Beskyttelse, opretter en sag (varen er gået i
// stykker), staff giver køberen medhold, og ankefristen udløber. Køberen får
// alt undtagen BidHamr Beskyttelse tilbage (delvis refusion i tre trin hos
// Stripe), sælgeren står med 0, og BidHamr beholder kun Beskyttelsen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udfoerSagAfvikling, type SagAfvikling } from "@/lib/sagerServer";
import { betal, betaling, forberedSaelger, opretHandel, admin, rydOp, saldo, stripeTal, type TestHandel } from "./handel";
import { CHEF_ID } from "./brugere";

let h: TestHandel;
let konto: string;
let sagId: string;

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "sag-medhold", budOere: 50_000, beskyttelse: true });
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

  it("afgjort til køberen + ankefristen udløbet: refusion af alt undtagen Beskyttelsen", async () => {
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
    // T = 590 kr., Beskyttelse 25 kr. -> køberen får 565 kr.
    expect(b.refusion_oere).toBe(56_500);
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(56_500);
    // Gebyret (115 kr.) refunderes undtagen Beskyttelsen: 90 kr.
    expect(t.gebyr).toBe(11_500);
    expect(t.gebyrRefunderet).toBe(9_000);
    // Tilbageført fra sælgeren: hans del + det refunderede gebyr.
    expect(t.tilbagefoert).toBe(56_500);
    // BidHamr står med Beskyttelsen: gebyr - gebyr-refusion + tilbageført - refunderet.
    expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(2_500);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(0);
    expect(b.saelger_udbetaling_id).toBeNull();
  });

  it("en gentaget afvikling flytter ingen penge igen", async () => {
    const { data: a } = await admin().rpc("sag_afvikl", { p_sag: sagId });
    expect((a as { kode: string }).kode).toBe("intet");
    const b = await betaling(h.betalingId);
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(56_500);
    expect(t.tilbagefoert).toBe(56_500);
  });
});
