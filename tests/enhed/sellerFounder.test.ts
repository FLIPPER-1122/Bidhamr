// Seller founder (20261102420000, Filip 29. okt. 2026): ren logik uden
// database og Stripe. Beregningen og kontrollen før PaymentIntent
// (forventetTotalOere), refusion med 0 kr. i application fee (intet
// ApplicationFee-objekt hos Stripe) og at kun chefen kan kalde handlingerne.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applicationFeeOere,
  forventetTotalOere,
  founderFriTil,
  founderGebyrOere,
  founderHalvFra,
  founderRabatPct,
  koebergebyrOere,
  koeberTotalOere,
  saelgergebyrOere,
  udbetalingOere,
} from "@/lib/betaling/beregn";

const stripeMock = {
  charges: { retrieve: vi.fn() },
  disputes: { list: vi.fn() },
  balance: { retrieve: vi.fn() },
  applicationFees: { createRefund: vi.fn(), listRefunds: vi.fn() },
  transfers: { createReversal: vi.fn(), listReversals: vi.fn() },
};
const rpcMock = vi.fn();
const assertRoleMock = vi.fn();

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: rpcMock }) }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn() }));
vi.mock("@/lib/adminAuth", () => ({ assertRole: (r: string) => assertRoleMock(r) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));

describe("beregning", () => {
  // 10.000 kr.: ny2 = 375 kr. / 145 kr.
  it.each([
    [0, 37_500, 14_500],
    [50, 18_750, 7_250],
    [100, 0, 0],
  ])("10.000 kr. ved %d %% rabat: køber %d, sælger %d", (rabat, koeb, saelg) => {
    expect(koebergebyrOere(1_000_000, false, rabat)).toBe(koeb);
    expect(saelgergebyrOere(1_000_000, false, rabat)).toBe(saelg);
    expect(udbetalingOere(1_000_000, false, rabat)).toBe(1_000_000 - saelg);
    expect(koeberTotalOere(1_000_000, false, 4_200, rabat)).toBe(1_000_000 + koeb + 4_200);
  });

  it("over 7.500 kr. og loftet: halv op i hele øre", () => {
    // 7.501 kr.: 300,03 / 95,02 kr. -> 150,02 (150,015 halv op) / 47,51.
    expect(koebergebyrOere(750_100, false, 50)).toBe(15_002);
    expect(saelgergebyrOere(750_100, false, 50)).toBe(4_751);
    // 25.000 kr.: 650 / 445 kr. -> 325 / 222,50 kr.
    expect(koebergebyrOere(2_500_000, false, 50)).toBe(32_500);
    expect(saelgergebyrOere(2_500_000, false, 50)).toBe(22_250);
    expect(founderGebyrOere(1, 50)).toBe(1); // 0,5 øre -> 1
  });

  it("erhverv: ingen rabat (firmaer kan ikke være founder)", () => {
    for (const rabat of [0, 50, 100]) {
      expect(koebergebyrOere(1_000_000, true, rabat)).toBe(50_000);
      expect(saelgergebyrOere(1_000_000, true, rabat)).toBe(0);
    }
  });

  it("ugyldig rabat giver null i kontrollen - der betales aldrig et forkert beløb", () => {
    const b = { bud_oere: 1_000_000, koebergebyr_oere: 18_750, saelgergebyr_oere: 7_250, fragt_oere: 4_200, beskyttelse_oere: 0 };
    expect(forventetTotalOere({ ...b, prismodel: "ny2", founder_rabat_pct: 50 })).toBe(1_000_000 + 18_750 + 4_200);
    expect(forventetTotalOere({ ...b, prismodel: "ny2", founder_rabat_pct: 0 })).toBeNull();
    expect(forventetTotalOere({ ...b, prismodel: "ny2", founder_rabat_pct: 30 })).toBeNull();
    expect(forventetTotalOere({ ...b, prismodel: "ny", founder_rabat_pct: 50 })).toBeNull();
    // Application fee = reducerede gebyrer + fragt; sælgeren får buddet minus det reducerede sælgergebyr.
    expect(applicationFeeOere(b)).toBe(18_750 + 7_250 + 4_200);
    const nul = { ...b, koebergebyr_oere: 0, saelgergebyr_oere: 0, fragt_oere: 0 };
    expect(forventetTotalOere({ ...nul, prismodel: "ny2", founder_rabat_pct: 100 })).toBe(1_000_000);
    expect(applicationFeeOere(nul)).toBe(0);
  });

  it("faserne: 6 måneder fra startdatoen i dansk tid", () => {
    const a = { start_dato: "2026-10-29", stoppet_kl: null };
    expect(founderFriTil("2026-10-29")).toBe("2027-04-28");
    expect(founderHalvFra("2026-10-29")).toBe("2027-04-29");
    expect(founderRabatPct(a, new Date("2026-10-28T22:59:00Z"))).toBe(0); // 28. okt. 23:59
    expect(founderRabatPct(a, new Date("2026-10-28T23:00:00Z"))).toBe(100); // 29. okt. 00:00 (vintertid)
    expect(founderRabatPct(a, new Date("2027-04-28T21:59:59Z"))).toBe(100); // 28. apr. 23:59:59 (sommertid)
    expect(founderRabatPct(a, new Date("2027-04-28T22:00:00Z"))).toBe(50); // 29. apr. 00:00
  });
});

describe("refusion med 0 kr. i application fee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("intet gebyr-objekt hos Stripe: kun tilbageførsel, ingen gebyr-refusion", async () => {
    const { forberedDestinationRefusion } = await import("@/lib/betaling/refusion");
    rpcMock.mockImplementation(async (navn: string) => {
      if (navn === "betaling_refusionsplan") {
        return {
          data: {
            kode: "ok",
            refusion_oere: 400_000,
            fra_saelger_oere: 400_000,
            gebyr_oere: 0,
            tilbagefoersel_oere: 400_000,
            application_fee_oere: 0,
            saelger_stripe_konto: "acct_test",
            gebyr_refunderet: false,
            tilbagefoert: false,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    stripeMock.charges.retrieve.mockResolvedValue({
      id: "ch_test",
      currency: "dkk",
      amount: 400_000,
      amount_refunded: 0,
      disputed: false,
      application_fee: null,
      application_fee_amount: 0,
      transfer_data: { destination: "acct_test" },
      transfer: { id: "tr_test", destination: "acct_test", amount: 400_000, amount_reversed: 0 },
    });
    stripeMock.balance.retrieve.mockResolvedValue({ available: [{ currency: "dkk", amount: 400_000 }], pending: [] });
    stripeMock.transfers.createReversal.mockResolvedValue({ id: "trr_test", amount: 400_000 });

    const b = { id: "b1", trade_id: "t1", seller_id: "s1", total_oere: 400_000, stripe_charge_id: "ch_test" };
    const r = await forberedDestinationRefusion(b as never, "laas", 0, 400_000, {});
    expect(r).toEqual({ kode: "klar", refusionOere: 400_000 });
    expect(stripeMock.applicationFees.createRefund).not.toHaveBeenCalled();
    expect(stripeMock.transfers.createReversal).toHaveBeenCalledWith(
      "tr_test",
      expect.objectContaining({ amount: 400_000, refund_application_fee: false }),
      expect.objectContaining({ idempotencyKey: "bidhamr-refusion-tilbagefoersel-b1-0" }),
    );
    // Gebyr-trinnet registreres (uden Stripe-id) og tilbageførslen med id.
    expect(rpcMock).toHaveBeenCalledWith("betaling_refusion_trin", expect.objectContaining({ p_trin: "gebyr", p_stripe_id: null }));
    expect(rpcMock).toHaveBeenCalledWith("betaling_refusion_trin", expect.objectContaining({ p_trin: "tilbagefoersel", p_stripe_id: "trr_test" }));
  });

  it("mangler gebyr-objektet, når planen siger gebyr > 0: konflikt (ingen penge flyttes)", async () => {
    const { forberedDestinationRefusion } = await import("@/lib/betaling/refusion");
    rpcMock.mockResolvedValue({
      data: {
        kode: "ok",
        refusion_oere: 500_000,
        fra_saelger_oere: 480_000,
        gebyr_oere: 20_000,
        tilbagefoersel_oere: 500_000,
        application_fee_oere: 20_000,
        saelger_stripe_konto: "acct_test",
      },
      error: null,
    });
    stripeMock.charges.retrieve.mockResolvedValue({
      id: "ch_x",
      currency: "dkk",
      amount: 500_000,
      amount_refunded: 0,
      disputed: false,
      application_fee: null,
      application_fee_amount: 20_000,
      transfer_data: { destination: "acct_test" },
      transfer: { id: "tr_x", destination: "acct_test", amount: 500_000, amount_reversed: 0 },
    });
    const b = { id: "b2", trade_id: "t2", seller_id: "s1", total_oere: 500_000, stripe_charge_id: "ch_x" };
    const r = await forberedDestinationRefusion(b as never, "laas", 0, 500_000, {});
    expect(r.kode).toBe("konflikt");
    expect(stripeMock.transfers.createReversal).not.toHaveBeenCalled();
    expect(stripeMock.applicationFees.createRefund).not.toHaveBeenCalled();
  });
});

describe("kun chefen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("handlingerne kræver rollen chef; uden adgang sker intet i databasen", async () => {
    const { opretSellerFounder, retSellerFounderStart, stopSellerFounder } = await import("@/app/actions/adminSellerFounder");
    assertRoleMock.mockRejectedValue(new Error("Ingen adgang"));
    const fd = new FormData();
    fd.set("brugerId", "11111111-1111-4111-8111-000000000001");
    fd.set("startDato", "2026-10-29");
    for (const f of [opretSellerFounder, retSellerFounderStart, stopSellerFounder]) {
      expect(await f(fd)).toEqual({ fejl: "Ingen adgang." });
    }
    expect(assertRoleMock).toHaveBeenCalledTimes(3);
    expect(assertRoleMock.mock.calls.every((c) => c[0] === "chef")).toBe(true);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("chefen: startdato og bruger valideres før databasen; databasens kode bliver en dansk fejl", async () => {
    const { opretSellerFounder } = await import("@/app/actions/adminSellerFounder");
    assertRoleMock.mockResolvedValue({ userId: "chef", admin: { rpc: rpcMock } });
    const fd = new FormData();
    fd.set("brugerId", "11111111-1111-4111-8111-000000000001");
    fd.set("startDato", "2026-02-30");
    expect(await opretSellerFounder(fd)).toEqual({ fejl: expect.stringMatching(/startdato/) });
    expect(rpcMock).not.toHaveBeenCalled();
    fd.set("startDato", "2026-10-29");
    rpcMock.mockResolvedValue({ data: { kode: "firma" }, error: null });
    expect(await opretSellerFounder(fd)).toEqual({ fejl: "Firmakonti kan ikke være seller founder." });
    expect(rpcMock).toHaveBeenCalledWith("seller_founder_opret", {
      p_chef: "chef",
      p_bruger: "11111111-1111-4111-8111-000000000001",
      p_start: "2026-10-29",
      p_note: null,
    });
  });

  it("siderne kræver chef (boksen vises kun for chefen, listen kræver chef)", () => {
    const rod = path.resolve(import.meta.dirname, "../..");
    const liste = readFileSync(path.join(rod, "src/app/admin/brugere/founders/page.tsx"), "utf8");
    expect(liste).toContain('kraevSideRolle("chef")');
    const bruger = readFileSync(path.join(rod, "src/app/admin/brugere/[id]/page.tsx"), "utf8");
    expect(bruger).toMatch(/erChef && staffId && \(\s*<SellerFounderKort/);
  });
});
