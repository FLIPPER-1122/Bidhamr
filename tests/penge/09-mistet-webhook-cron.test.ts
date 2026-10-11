// Scenarie: Stripe-webhooken når aldrig frem (hverken payment_intent.succeeded
// eller charge.updated). Overvågningen i betalings-cron'en opdager betalingen
// hos Stripe og spejler den (opsamlUdebleveneBetalinger, sikkerhedsnet B), og
// udbetalingen henter selv transferen frisk (spejlManglendeCharges), så
// handlen kan gennemføres uden en eneste webhook.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opsamlUdebleveneBetalinger } from "@/lib/betaling/overvaagning";
import { udbetalVentende } from "@/lib/betaling/udbetaling";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  koeberGodkenderUdenUdbetaling,
  opretHandel,
  rydOp,
  saelgerUdbetaling,
  afslutPayout,
  ventPaaTransfer,
  type TestHandel,
} from "./handel";

let h: TestHandel;
let konto: string;

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "mistet-webhook", budOere: 6_000 });
});

afterAll(async () => {
  if (h) await rydOp(h);
});

describe("mistet webhook samles op af cron", () => {
  it("betalt hos Stripe, men databasen ved det ikke", async () => {
    const pi = await betal(h, { medWebhook: false });
    expect(pi.status).toBe("succeeded");
    expect((await betaling(h.betalingId)).status).toBe("afventer");
  });

  it("overvågningen spejler betalingen og giver én alarm", async () => {
    const alarmer: string[] = [];
    const n = await opsamlUdebleveneBetalinger(async (o) => {
      alarmer.push(o.noegle);
    }, 0);
    expect(n).toBeGreaterThanOrEqual(1);
    const b = await betaling(h.betalingId);
    expect(b.status).toBe("betalt");
    expect(alarmer.some((x) => x.includes(h.betalingId))).toBe(true);
    // Anden kørsel: intet at spejle for denne betaling.
    const igen: string[] = [];
    await opsamlUdebleveneBetalinger(async (o) => {
      igen.push(o.noegle);
    }, 0);
    expect(igen.some((x) => x.includes(h.betalingId))).toBe(false);
  });

  it("udbetalingen virker uden charge.updated (transferen hentes frisk)", async () => {
    // Uden charge-webhooken kender databasen evt. ikke transferen endnu.
    await koeberGodkenderUdenUdbetaling(h);
    // Stripe sætter transferen lidt efter betalingen. Til da venter
    // udbetalingen (korrekt) - testen venter på Stripe, ikke på webhooken.
    const b0 = await betaling(h.betalingId);
    expect((await ventPaaTransfer(b0.stripe_charge_id!)).transfer).toBeTruthy();
    await udbetalVentende(h.saelger.id);
    const b = await betaling(h.betalingId);
    expect(b.stripe_destination_transfer_id).toBeTruthy();
    expect(b.saelger_udbetaling_id).toBeTruthy();
    const u = await saelgerUdbetaling(b.saelger_udbetaling_id!);
    expect(["oprettet", "paid"]).toContain(u.status);
    expect(await afslutPayout(konto, u.id)).toBe("paid");
    const { count } = await admin()
      .from("saelger_udbetalinger")
      .select("id", { count: "exact", head: true })
      .contains("betaling_ids", [h.betalingId]);
    expect(count).toBe(1);
  });
});
