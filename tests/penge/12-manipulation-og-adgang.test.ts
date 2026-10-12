// Scenarier:
//   - Beløbsmanipulation afvises: køberen kan ikke ændre beløbet i databasen
//     (RLS), en PaymentIntent med ændret beløb rettes før betaling, og en
//     betaling med forkert beløb registreres ikke som betalt - den
//     refunderes automatisk, og handlen fortsætter med en ny PaymentIntent.
//   - Betaling for en andens handel afvises: en fremmed kan hverken starte
//     betalingen, se den, godkende varen eller læse betalingsrækken; sælgeren
//     kan ikke betale sin egen handel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hentBetalingsstatus, startBetaling } from "@/app/actions/betaling";
import { godkendPakke } from "@/app/actions/trades";
import {
  admin,
  betaling,
  forberedSaelger,
  fuldRefusion,
  leverBetalingsWebhooks,
  opretHandel,
  piId,
  rydOp,
  stripe,
  udenTvungen3ds,
  type TestHandel,
} from "./handel";
import { FREMMED, KOEBER, SAELGER } from "./brugere";
import { logIndSom } from "./session";

let manip: TestHandel;
let anden: TestHandel;

beforeAll(async () => {
  await forberedSaelger();
  manip = await opretHandel({ navn: "beloebsmanipulation", budOere: 10_000 });
  anden = await opretHandel({ navn: "andens-handel", budOere: 10_000 });
});

afterAll(async () => {
  for (const h of [manip, anden]) {
    if (!h) continue;
    const b = await betaling(h.betalingId).catch(() => null);
    if (b?.status === "betalt" && !b.saelger_udbetaling_id) await fuldRefusion(h).catch(() => null);
    await rydOp(h);
  }
});

describe("beløbsmanipulation afvises", () => {
  it("køberen kan ikke ændre beløb eller status i databasen", async () => {
    const klient = await logIndSom(KOEBER.id, KOEBER.email);
    const { data, error } = await klient
      .from("betalinger")
      .update({ total_oere: 100, application_fee_oere: 0, status: "betalt" })
      .eq("id", manip.betalingId)
      .select("id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
    const ny = await klient.from("betalinger").insert({
      trade_id: manip.tradeId,
      auction_id: manip.auktionId,
      buyer_id: KOEBER.id,
      seller_id: SAELGER.id,
      bud_oere: 100,
      total_oere: 100,
    });
    expect(ny.error).not.toBeNull();
    const b = await betaling(manip.betalingId);
    expect(b.total_oere).toBe(10_000 + 500 + 4_000);
    expect(b.status).toBe("afventer");
  });

  it("en PaymentIntent med ændret beløb rettes, før køberen kan betale", async () => {
    await logIndSom(KOEBER.id, KOEBER.email);
    const s1 = await startBetaling(manip.tradeId);
    if (!("ok" in s1)) throw new Error(s1.fejl);
    const id = piId(s1.clientSecret);
    // Nogen ændrer beløbet hos Stripe (fx en fejl eller et angreb på nøglen).
    await stripe().paymentIntents.update(id, { amount: 1_000, application_fee_amount: 100 });
    const s2 = await startBetaling(manip.tradeId);
    if (!("ok" in s2)) throw new Error(s2.fejl);
    expect(s2.totalOere).toBe(14_500);
    const pi = await stripe().paymentIntents.retrieve(id);
    expect(pi.amount).toBe(14_500);
    expect(pi.application_fee_amount).toBe(500 + 500 + 4_000);
    // Og den tvungne 3D Secure (sikkerhedsnet A) står på.
    expect(pi.payment_method_options?.card?.request_three_d_secure).toBe("any");
  });

  it("betales et forkert beløb alligevel, registreres det ikke som betalt og refunderes", async () => {
    const b = await betaling(manip.betalingId);
    const id = b.stripe_payment_intent_id!;
    await stripe().paymentIntents.update(id, { amount: 1_000, application_fee_amount: 100 });
    // 3DS-siden kan ikke klikkes igennem uden browser (se udenTvungen3ds).
    await udenTvungen3ds(id);
    const pi = await stripe().paymentIntents.confirm(id, {
      payment_method: "pm_card_bypassPending",
      return_url: "https://bidhamr.dk/test-betaling",
    });
    expect(pi.status).toBe("succeeded");
    await leverBetalingsWebhooks(await stripe().paymentIntents.retrieve(id));
    const efter = await betaling(manip.betalingId);
    expect(efter.status).toBe("afventer");
    expect(efter.stripe_payment_intent_id).not.toBe(id);
    const { data: afv } = await admin()
      .from("betaling_afvigelser")
      .select("modtaget_oere, forventet_oere, refunderet_kl")
      .eq("stripe_payment_intent_id", id)
      .single<{ modtaget_oere: number; forventet_oere: number; refunderet_kl: string | null }>();
    expect(afv?.modtaget_oere).toBe(1_000);
    expect(afv?.forventet_oere).toBe(14_500);
    expect(afv?.refunderet_kl).toBeTruthy();
    const ch = await stripe().charges.retrieve(pi.latest_charge as string);
    expect(ch.refunded).toBe(true);
    // Handlen fortsætter: køberen kan betale det rigtige beløb.
    const s = await startBetaling(manip.tradeId);
    if (!("ok" in s)) throw new Error(s.fejl);
    expect(s.totalOere).toBe(14_500);
    expect(piId(s.clientSecret)).not.toBe(id);
  });
});

describe("betaling for en andens handel afvises", () => {
  it("en fremmed kan ikke starte, se eller godkende betalingen", async () => {
    const klient = await logIndSom(FREMMED.id, FREMMED.email);
    expect(await startBetaling(anden.tradeId)).toEqual({ fejl: "Betalingen findes ikke." });
    expect(await hentBetalingsstatus(anden.tradeId)).toEqual({ fejl: "Betalingen findes ikke." });
    expect(await godkendPakke(anden.tradeId, 5, null)).toEqual({ fejl: "Handlen findes ikke." });
    const { data } = await klient.from("betalinger").select("id").eq("id", anden.betalingId);
    expect(data ?? []).toEqual([]);
    const rpc = await klient.rpc("handel_godkend_med_bedoemmelse", { p_trade: anden.tradeId, p_stjerner: 5, p_kommentar: null });
    expect(rpc.data === "ok").toBe(false);
    expect((await betaling(anden.betalingId)).stripe_payment_intent_id).toBeNull();
  });

  it("sælgeren kan ikke betale sin egen handel", async () => {
    await logIndSom(SAELGER.id, SAELGER.email);
    expect(await startBetaling(anden.tradeId)).toEqual({ fejl: "Betalingen findes ikke." });
    expect((await betaling(anden.betalingId)).stripe_payment_intent_id).toBeNull();
  });

  it("uden login: ingen adgang", async () => {
    const { logUd } = await import("./session");
    logUd();
    expect(await startBetaling(anden.tradeId)).toEqual({ fejl: "Du skal være logget ind." });
  });
});
