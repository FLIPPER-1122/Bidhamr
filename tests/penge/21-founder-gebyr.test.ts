// Scenarie: seller founder (20261102420000, Filip 29. okt. 2026). Sælgeren
// er founder (oprettet med chefens RPC). To handler mod Stripes testmiljø:
//   A) måned 1 (100 % rabat), afhentning: 0 kr. i købergebyr og sælgergebyr
//      og ingen fragt -> BidHamrs application fee er 0 kr. Stripe laver intet
//      ApplicationFee-objekt; sælgeren får hele buddet. Fuld refusion uden
//      gebyr-refusion (kun tilbageførsel + refusion).
//   B) måned 7 (50 % rabat), forsendelse: halve gebyrer + fragt i
//      application fee. Fuld refusion.
// Køberen betaler med testkort 4242 (pm_card_visa). Bagefter stoppes
// aftalen, og sælgerens saldo er, hvor den startede.
// Sælgeren er SAELGER_BANK_FEJLER (bruges kun af 10-payout-fejlet), så en
// samtidig kørsel af de andre scenarier ikke får founder-gebyrer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { koebergebyrOere, saelgergebyrOere } from "@/lib/betaling/beregn";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  fuldRefusion,
  opretHandel,
  PAKKESHOP_FRAGT_OERE,
  rydOp,
  saldo,
  stripe,
  stripeTal,
  type TestHandel,
} from "./handel";
import { CHEF_ID, KOEBER, SAELGER_BANK_FEJLER } from "./brugere";

const SAELGER = SAELGER_BANK_FEJLER;
let konto: string;
let start = 0;
let hA: TestHandel | undefined;
let hB: TestHandel | undefined;

function iDag(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());
}

function minusMaaneder(dato: string, n: number): string {
  const [a, m, d] = dato.split("-").map(Number);
  const x = new Date(Date.UTC(a, m - 1 - n, Math.min(d, 28)));
  return x.toISOString().slice(0, 10);
}

async function rpc(navn: string, args: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin().rpc(navn, args);
  if (error) throw new Error(`${navn}: ${error.message}`);
  return (data as { kode: string }).kode;
}

async function stopAftale(): Promise<void> {
  const k = await rpc("seller_founder_stop", { p_chef: CHEF_ID, p_bruger: SAELGER.id, p_begrundelse: "TEST pengetest: oprydning" });
  if (k !== "ok" && k !== "ikke_founder") throw new Error(`seller_founder_stop: ${k}`);
}

beforeAll(async () => {
  konto = await forberedSaelger(SAELGER);
  const s = await saldo(konto);
  start = s.tilgaengelig + s.afventer;
  // Køberen skal have en adresse, før der kan betales (20261102340000).
  const { data: adr, error: adrFejl } = await admin().rpc("bruger_adresse_gem", {
    p_bruger: KOEBER.id,
    p_adresse: "Testvej 2",
    p_postnummer: "2100",
  });
  if (adrFejl) throw new Error(`bruger_adresse_gem: ${adrFejl.message}`);
  expect((adr as { kode: string }).kode).toBe("ok");
  await stopAftale(); // fra en afbrudt kørsel
  expect(await rpc("seller_founder_opret", { p_chef: CHEF_ID, p_bruger: SAELGER.id, p_start: iDag(), p_note: "TEST pengetest" }))
    .toBe("ok");
});

afterAll(async () => {
  if (hA) await rydOp(hA);
  if (hB) await rydOp(hB);
  await stopAftale();
});

describe("seller founder: 100 % rabat og afhentning (application fee 0 kr.)", () => {
  const BUD = 400_000; // 4.000 kr.

  it("betalingen er låst med 100 % rabat: 0 kr. i gebyrer, total = buddet", async () => {
    hA = await opretHandel({ navn: "founder-100", budOere: BUD, saelger: SAELGER, afhentning: true });
    const b = await betaling(hA.betalingId);
    expect([b.prismodel, b.founder_rabat_pct]).toEqual(["ny2", 100]);
    expect([b.koebergebyr_oere, b.saelgergebyr_oere, b.fragt_oere]).toEqual([0, 0, 0]);
    expect([b.total_oere, b.udbetaling_oere]).toEqual([BUD, BUD]);
  });

  it("kort 4242: Stripe trækker buddet, application fee 0, intet gebyr-objekt, sælgeren får hele buddet", async () => {
    const pi = await betal(hA!, { kort: "pm_card_visa" });
    expect(pi.status).toBe("succeeded");
    expect(pi.amount).toBe(BUD);
    expect(pi.application_fee_amount).toBe(0);
    expect(pi.transfer_data?.destination).toBe(konto);
    const b = await betaling(hA!.betalingId);
    expect(b.status).toBe("betalt");
    expect(b.application_fee_oere).toBe(0);
    const ch = await stripe().charges.retrieve(b.stripe_charge_id!);
    expect(ch.application_fee).toBeNull();
    expect(ch.application_fee_amount).toBe(0);
    expect(ch.payment_method_details?.card?.last4).toBe("4242");
    const t = await stripeTal(b);
    expect([t.beloeb, t.gebyr, t.transfer]).toEqual([BUD, 0, BUD]);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer - start).toBe(BUD);
    // Ingen markering til staff (spejlingen accepterer 0 kr. i gebyr).
    expect(b.kraever_opmaerksomhed).toBe(false);
  });

  it("udbetaling: tjekket lige før udbetaling godkender 0 kr. i gebyr (udbetaling = hele buddet)", async () => {
    const { tjekFoerUdbetaling } = await import("@/lib/betaling/udbetaling");
    const b = await betaling(hA!.betalingId);
    expect(b.udbetaling_oere).toBe(BUD);
    expect(await tjekFoerUdbetaling(b as never)).toBeNull();
    expect((await betaling(hA!.betalingId)).kraever_opmaerksomhed).toBe(false);
  });

  it("aftalen ændres bagefter: betalingen beholder sin rabat", async () => {
    expect(await rpc("seller_founder_ret_start", { p_chef: CHEF_ID, p_bruger: SAELGER.id, p_start: minusMaaneder(iDag(), 7) }))
      .toBe("ok");
    const b = await betaling(hA!.betalingId);
    expect([b.founder_rabat_pct, b.koebergebyr_oere, b.saelgergebyr_oere]).toEqual([100, 0, 0]);
  });

  it("fuld refusion uden gebyr-refusion: køber får alt, sælgerens saldo er tilbage", async () => {
    const r = await fuldRefusion(hA!);
    expect(r.resultat).toBe("refunderet");
    const b = await betaling(hA!.betalingId);
    expect(b.status).toBe("refunderet");
    expect(b.refusion_gebyr_oere).toBe(0);
    // Afstemningen efter refusionen (kontrollerDestinationRefusion) godtager 0 kr. i gebyr.
    const { kontrollerDestinationRefusion } = await import("@/lib/betaling/refusion");
    await kontrollerDestinationRefusion(b.stripe_payment_intent_id!);
    expect((await betaling(hA!.betalingId)).kraever_opmaerksomhed).toBe(false);
    const t = await stripeTal(b);
    expect([t.refunderet, t.gebyrRefunderet, t.tilbagefoert]).toEqual([BUD, 0, BUD]);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(start);
  });
});

describe("seller founder: 50 % rabat (måned 7) med forsendelse", () => {
  const BUD = 900_000; // 9.000 kr.: ny2 345 kr. / 125 kr. -> 172,50 / 62,50 kr.

  it("betalingen har 50 % rabat; application fee = halve gebyrer + fragt", async () => {
    hB = await opretHandel({ navn: "founder-50", budOere: BUD, saelger: SAELGER });
    const b = await betaling(hB.betalingId);
    expect([b.prismodel, b.founder_rabat_pct]).toEqual(["ny2", 50]);
    expect([b.koebergebyr_oere, b.saelgergebyr_oere]).toEqual([17_250, 6_250]);
    expect(b.koebergebyr_oere).toBe(koebergebyrOere(BUD, false, 50));
    expect(b.saelgergebyr_oere).toBe(saelgergebyrOere(BUD, false, 50));
    expect(b.fragt_oere).toBe(PAKKESHOP_FRAGT_OERE);
    expect(b.beskyttelse).toBe(true);
    const pi = await betal(hB, { kort: "pm_card_visa" });
    expect(pi.status).toBe("succeeded");
    expect(pi.amount).toBe(BUD + 17_250 + PAKKESHOP_FRAGT_OERE);
    expect(pi.application_fee_amount).toBe(17_250 + 6_250 + PAKKESHOP_FRAGT_OERE);
    const efter = await betaling(hB.betalingId);
    const t = await stripeTal(efter);
    expect(t.gebyr).toBe(17_250 + 6_250 + PAKKESHOP_FRAGT_OERE);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer - start).toBe(BUD - 6_250);
  });

  it("fuld refusion: køber får alt, gebyret refunderes, saldoen er tilbage", async () => {
    const r = await fuldRefusion(hB!);
    expect(r.resultat).toBe("refunderet");
    const b = await betaling(hB!.betalingId);
    const t = await stripeTal(b);
    expect(t.refunderet).toBe(b.total_oere);
    expect(t.gebyrRefunderet).toBe(17_250 + 6_250 + PAKKESHOP_FRAGT_OERE);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(start);
  });
});
