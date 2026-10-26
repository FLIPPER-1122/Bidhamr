// Scenarie: fuld refusion ("Refundér køber" / annullering) - køberen får hele
// beløbet inkl. fragt, gebyret refunderes helt, sælgerens del tilbageføres.
// Delvis refusion er dækket af sagen (02) og ikke-afhentet (04). Her også:
// refusion efter udbetaling afvises, og en refusion lavet i Stripe-
// dashboardet uden tilbageførsel fanges af afstemningen efter refusion.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  betal,
  betaling,
  forberedSaelger,
  forventet,
  fuldRefusion,
  koeberGodkender,
  opretHandel,
  rydOp,
  sendWebhook,
  saldo,
  stripe,
  stripeTal,
  type TestHandel,
} from "./handel";

let fuld: TestHandel;
let udbetalt: TestHandel;
let dashboard: TestHandel;
let konto: string;
// Bud 200 kr.: købergebyr 7 % + 5 = 19 kr., fragt 42 kr. -> total 261 kr.;
// sælgergebyr 15 kr. -> udbetaling 185 kr.
const FULD = forventet(20_000);

beforeAll(async () => {
  konto = await forberedSaelger();
  fuld = await opretHandel({ navn: "fuld-refusion", budOere: 20_000 });
  udbetalt = await opretHandel({ navn: "refusion-efter-udbetaling", budOere: 10_000 });
  dashboard = await opretHandel({ navn: "refusion-i-dashboardet", budOere: 15_000 });
});

afterAll(async () => {
  for (const h of [fuld, udbetalt, dashboard]) if (h) await rydOp(h);
});

describe("fuld og delvis refusion", () => {
  it("fuld refusion: køber 100 %, sælger 0, BidHamrs gebyr tilbage", async () => {
    await betal(fuld);
    const foer = await saldo(konto);
    const r = await fuldRefusion(fuld);
    expect(r.claimet).not.toBeNull();
    expect(r.resultat).toBe("refunderet");
    const b = await betaling(fuld.betalingId);
    expect(b.status).toBe("refunderet");
    const t = await stripeTal(b);
    // bud 200 + gebyr 19 + fragt 42 = 261 kr.
    expect(FULD.total).toBe(26_100);
    expect(t.beloeb).toBe(FULD.total);
    expect(t.refunderet).toBe(FULD.total);
    expect(t.gebyr).toBe(FULD.gebyr);
    expect(t.gebyrRefunderet).toBe(t.gebyr);
    expect(t.tilbagefoert).toBe(FULD.total);
    const efter = await saldo(konto);
    expect(foer.tilgaengelig + foer.afventer - (efter.tilgaengelig + efter.afventer)).toBe(FULD.udbetaling);
    expect(FULD.udbetaling).toBe(18_500);
  });

  it("refusionen kan ikke gentages (idempotent)", async () => {
    const r = await fuldRefusion(fuld);
    expect(r.claimet).toBeNull();
    const t = await stripeTal(await betaling(fuld.betalingId));
    expect(t.refunderet).toBe(FULD.total);
    const refusioner = await stripe().refunds.list({ charge: (await betaling(fuld.betalingId)).stripe_charge_id! });
    expect(refusioner.data.length).toBe(1);
  });

  it("refusion efter udbetaling afvises", async () => {
    await betal(udbetalt);
    expect(await koeberGodkender(udbetalt)).toEqual({ ok: true });
    const b = await betaling(udbetalt.betalingId);
    expect(b.saelger_udbetaling_id).toBeTruthy();
    const r = await fuldRefusion(udbetalt);
    expect(r.claimet).toBeNull();
    const t = await stripeTal(await betaling(udbetalt.betalingId));
    expect(t.refunderet).toBe(0);
    expect(t.tilbagefoert).toBe(0);
  });

  it("afstemningen efter BidHamrs egen refusion godkender den (sælgeren står med 0)", async () => {
    const b = await betaling(fuld.betalingId);
    const { kontrollerDestinationRefusion } = await import("@/lib/betaling/refusion");
    await kontrollerDestinationRefusion(b.stripe_payment_intent_id!);
    expect((await betaling(fuld.betalingId)).kraever_opmaerksomhed).toBe(false);
  });

  it("refusion lavet i Stripe-dashboardet uden tilbageførsel: markeres til staff, intet udbetales", async () => {
    await betal(dashboard);
    const b = await betaling(dashboard.betalingId);
    // "Dashboardet": fuld refusion fra platformen uden reverse_transfer.
    const refund = await stripe().refunds.create({ charge: b.stripe_charge_id!, metadata: { test: "TEST pengetest dashboard" } });
    expect(refund.status).toBe("succeeded");
    const ch = await stripe().charges.retrieve(b.stripe_charge_id!);
    expect((await sendWebhook("charge.refunded", ch as unknown as { id: string })).status).toBe(200);
    const efter = await betaling(dashboard.betalingId);
    expect(efter.status).toBe("refunderet");
    // Sælgeren har stadig sin del - staff skal tage den tilbage.
    expect(efter.kraever_opmaerksomhed).toBe(true);
    expect(efter.sidste_fejl).toMatch(/ikke \(helt\) taget tilbage/);
    // Og den kan ikke udbetales.
    expect(await koeberGodkender(dashboard)).not.toEqual({ ok: true });
    expect((await betaling(dashboard.betalingId)).saelger_udbetaling_id).toBeNull();
    // Oprydning som staff ville gøre: sælgerens del tages tilbage. Transferen
    // er hele beløbet; gebyret er trukket fra bagefter på sælgerens konto.
    const t = await stripeTal(efter);
    expect(t.transfer - t.tilbagefoert - (t.gebyr - t.gebyrRefunderet)).toBe(efter.udbetaling_oere);
    await stripe().transfers.createReversal(efter.stripe_destination_transfer_id!, {
      amount: efter.udbetaling_oere,
      metadata: { test: "TEST pengetest oprydning" },
    });
  });
});
