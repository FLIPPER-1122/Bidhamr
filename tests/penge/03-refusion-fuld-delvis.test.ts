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
    // bud 200 + købergebyr 10 + fragt 40 = 250 kr.
    expect(t.beloeb).toBe(25_000);
    expect(t.refunderet).toBe(25_000);
    expect(t.gebyrRefunderet).toBe(t.gebyr);
    expect(t.tilbagefoert).toBe(25_000);
    const efter = await saldo(konto);
    expect(foer.tilgaengelig + foer.afventer - (efter.tilgaengelig + efter.afventer)).toBe(19_000);
  });

  it("refusionen kan ikke gentages (idempotent)", async () => {
    const r = await fuldRefusion(fuld);
    expect(r.claimet).toBeNull();
    const t = await stripeTal(await betaling(fuld.betalingId));
    expect(t.refunderet).toBe(25_000);
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
