// Scenarie: Stripe sender et tidligt svindelvarsel (testkort 5423). Ingen
// automatisk refusion (Filip, 8. okt. 2026) - men udbetalingen stoppes, til
// staff har set på det. Også, når webhooken ikke er kommet: tjekket hos
// Stripe lige før udbetalingen (F03) finder varslet selv.
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udbetalVentende } from "@/lib/betaling/udbetaling";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  fuldRefusion,
  koeberGodkender,
  koeberGodkenderUdenUdbetaling,
  opretHandel,
  rydOp,
  saldo,
  sendWebhook,
  stripe,
  ventPaa,
  type TestHandel,
} from "./handel";

let medWebhook: TestHandel;
let udenWebhook: TestHandel;
let konto: string;
let varsel: Stripe.Radar.EarlyFraudWarning;

beforeAll(async () => {
  konto = await forberedSaelger();
  medWebhook = await opretHandel({ navn: "svindelvarsel-webhook", budOere: 8_000 });
  udenWebhook = await opretHandel({ navn: "svindelvarsel-uden-webhook", budOere: 9_000 });
  // Begge betales med det samme - Stripe laver varslet lidt efter betalingen.
  await betal(medWebhook, { kort: "pm_card_createIssuerFraudRecord" });
  await betal(udenWebhook, { kort: "pm_card_createIssuerFraudRecord" });
});

afterAll(async () => {
  for (const h of [medWebhook, udenWebhook]) {
    if (!h) continue;
    // Sluttilstand: køberen refunderes (testdata - pengene må ikke blive
    // stående på sælgerens konto).
    const b = await betaling(h.betalingId).catch(() => null);
    if (b && b.status === "betalt" && !b.saelger_udbetaling_id) await fuldRefusion(h).catch(() => null);
    await rydOp(h);
  }
});

async function hentVarsel(chargeId: string) {
  return ventPaa(
    () => stripe().radar.earlyFraudWarnings.list({ charge: chargeId, limit: 1 }),
    (l) => l.data.length > 0,
    180_000,
    5000,
  );
}

describe("tidligt svindelvarsel stopper udbetalingen", () => {
  it("varslet spejles fra webhooken, og frigivelsen udbetaler ikke", async () => {
    const b = await betaling(medWebhook.betalingId);
    const l = await hentVarsel(b.stripe_charge_id!);
    expect(l.data.length).toBe(1);
    varsel = l.data[0];
    expect((await sendWebhook("radar.early_fraud_warning.created", varsel as unknown as { id: string })).status).toBe(200);
    const efter = await betaling(medWebhook.betalingId);
    expect(efter.svindelvarsel_kl).toBeTruthy();
    const foer = await saldo(konto);
    await koeberGodkender(medWebhook);
    const frigivet = await betaling(medWebhook.betalingId);
    expect(frigivet.frigivet_kl).toBeTruthy();
    expect(frigivet.saelger_udbetaling_id).toBeNull();
    const { data: grund } = await admin().rpc("betaling_udbetaling_blokeret", { p_betaling: medWebhook.betalingId });
    expect(String(grund)).toMatch(/svindel/);
    await udbetalVentende(medWebhook.saelger.id);
    expect((await betaling(medWebhook.betalingId)).saelger_udbetaling_id).toBeNull();
    const nu = await saldo(konto);
    expect(nu.tilgaengelig + nu.afventer).toBe(foer.tilgaengelig + foer.afventer);
  });

  it("uden webhook: tjekket hos Stripe før udbetaling finder varslet", async () => {
    const b = await betaling(udenWebhook.betalingId);
    const l = await hentVarsel(b.stripe_charge_id!);
    expect(l.data.length).toBe(1);
    expect((await betaling(udenWebhook.betalingId)).svindelvarsel_kl).toBeNull();
    await koeberGodkenderUdenUdbetaling(udenWebhook);
    // Testkort 5423 lægger pengene som "afventende" i 7 dage, så den
    // almindelige udbetaling venter alligevel (midler ikke tilgængelige) og
    // når ikke til Stripe-tjekket. Tjekket (F03), der kører lige før hver
    // payout, kaldes derfor direkte med betalingen.
    await udbetalVentende(udenWebhook.saelger.id);
    expect((await betaling(udenWebhook.betalingId)).saelger_udbetaling_id).toBeNull();
    const { tjekFoerUdbetaling } = await import("@/lib/betaling/udbetaling");
    const raekke = await betaling(udenWebhook.betalingId);
    expect(await tjekFoerUdbetaling(raekke as never)).toBe("svindelvarsel");
    const efter = await betaling(udenWebhook.betalingId);
    expect(efter.saelger_udbetaling_id).toBeNull();
    expect(efter.svindelvarsel_kl).toBeTruthy();
    const { data: grund } = await admin().rpc("betaling_udbetaling_blokeret", { p_betaling: udenWebhook.betalingId });
    expect(grund).not.toBeNull();
  });
});
