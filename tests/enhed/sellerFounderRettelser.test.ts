// Seller founder - rettelser (20261102460000, Filip 29. okt. 2026 -
// "Founderens gratis handler"): ren logik uden database. Skønnet over Stripe-
// tabet, alarmen ved mistanke om falske handler (én drift-alarm pr. nyt par,
// rigtig alarmtype), staff-koden fra databasen og migrationens vigtigste
// sikkerhedsdele (md5-tjek, sluttid, rettigheder på min_founder_rabat).
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { anslaaetStripeTabOere, STRIPE_GEBYR_SKOEN, STRIPE_GEBYR_SKOEN_TEKST } from "@/lib/betaling/stripeGebyrSkoen";
import { alarmKode, alarmType } from "@/lib/driftAlarmTyper";

const rpcMock = vi.fn();
const logMock = vi.fn();
const assertRoleMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: rpcMock }) }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: (x: unknown) => logMock(x) }));
vi.mock("@/lib/adminAuth", () => ({ assertRole: (r: string) => assertRoleMock(r) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));

const ROD = path.resolve(import.meta.dirname, "../..");
const MIG = readFileSync(path.join(ROD, "supabase/migrations/20261102460000_seller_founder_rettelser.sql"), "utf8");

describe("anslået Stripe-tab (skøn)", () => {
  it("satsen er 1,5 % + 1,80 kr. og står i én konstant", () => {
    expect(STRIPE_GEBYR_SKOEN).toEqual({ basispoint: 150, fastOere: 180 });
    expect(STRIPE_GEBYR_SKOEN_TEKST).toBe("ca. 1,5 % + 1,80 kr.");
  });

  it("i hele øre: procent af summen (halv op) + fast beløb pr. handel", () => {
    expect(anslaaetStripeTabOere(0, 0)).toBe(0);
    expect(anslaaetStripeTabOere(0, 100_000)).toBe(0);
    expect(anslaaetStripeTabOere(1, 100_000)).toBe(1_500 + 180); // 1.000 kr. -> 15 kr. + 1,80 kr.
    expect(anslaaetStripeTabOere(3, 1_000_100)).toBe(15_002 + 540); // 15.001,5 -> 15.002 øre
    expect(anslaaetStripeTabOere(2, 33)).toBe(0 + 360); // 0,495 øre -> 0
    expect(anslaaetStripeTabOere(-1, 5000)).toBe(0);
    expect(anslaaetStripeTabOere(Number.NaN, 5000)).toBe(0);
    expect(Number.isInteger(anslaaetStripeTabOere(7, 123_457))).toBe(true);
  });
});

describe("alarm ved mistanke om falske handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("én drift-alarm pr. nyt par fra databasen; ingen navne eller e-mails i teksten", async () => {
    const { tjekFounderAlarmer, FOUNDER_ALARM_HVOR, founderAlarmTekst } = await import("@/lib/betaling/founderAlarm");
    const F = "11111111-1111-4111-8111-000000000001";
    rpcMock.mockResolvedValue({
      data: [
        { founder_id: F, koeber_id: "22222222-2222-4222-8222-000000000001", handler: 3 },
        { founder_id: F, koeber_id: "22222222-2222-4222-8222-000000000002", handler: 4 },
      ],
      error: null,
    });
    expect(await tjekFounderAlarmer()).toBe(2);
    expect(rpcMock).toHaveBeenCalledWith("seller_founder_alarm_tjek");
    expect(logMock).toHaveBeenCalledTimes(2);
    const kald = logMock.mock.calls[0][0] as { kilde: string; hvor: string; fejl: string; brugerId: string };
    expect(kald).toMatchObject({ kilde: "server", hvor: FOUNDER_ALARM_HVOR, brugerId: F });
    expect(kald.fejl).toMatch(/3 betalte handler/);
    expect(kald.fejl).not.toMatch(/22222222/); // køberens id står ikke i alarmen
    // Koden og typen: gul, med link til listen over founders.
    const kode = alarmKode("server", `${FOUNDER_ALARM_HVOR}: ${founderAlarmTekst({ founder_id: F, koeber_id: "x", handler: 3 })}`);
    expect(kode).toBe("founder/falske-handler");
    const t = alarmType("server", kode);
    expect([t.alvor, t.side.sti]).toEqual(["gul", "/admin/brugere/founders"]);
    expect(t.titel).toMatch(/falske handler/);
  });

  it("ingen nye par: ingen alarm; migrationen ikke kørt: intet; anden fejl: kaster", async () => {
    const { tjekFounderAlarmer } = await import("@/lib/betaling/founderAlarm");
    rpcMock.mockResolvedValue({ data: [], error: null });
    expect(await tjekFounderAlarmer()).toBe(0);
    rpcMock.mockResolvedValue({ data: null, error: { message: "function public.seller_founder_alarm_tjek() does not exist" } });
    expect(await tjekFounderAlarmer()).toBe(0);
    rpcMock.mockResolvedValue({ data: null, error: { message: "timeout" } });
    await expect(tjekFounderAlarmer()).rejects.toThrow(/timeout/);
    expect(logMock).not.toHaveBeenCalled();
  });

  it("kører i betalingsovervågningen", () => {
    const o = readFileSync(path.join(ROD, "src/lib/betaling/overvaagning.ts"), "utf8");
    expect(o).toMatch(/tjek\("founder-handler"/);
    expect(o).toContain("tjekFounderAlarmer()");
  });
});

describe("staff kan ikke være founder", () => {
  beforeEach(() => vi.clearAllMocks());

  it("databasens kode 'staff' bliver en dansk fejl", async () => {
    const { opretSellerFounder } = await import("@/app/actions/adminSellerFounder");
    assertRoleMock.mockResolvedValue({ userId: "chef", admin: { rpc: rpcMock } });
    const fd = new FormData();
    fd.set("brugerId", "11111111-1111-4111-8111-000000000001");
    fd.set("startDato", "2026-10-29");
    rpcMock.mockResolvedValue({ data: { kode: "staff" }, error: null });
    expect(await opretSellerFounder(fd)).toEqual({ fejl: expect.stringMatching(/staff-rolle/) });
  });
});

describe("migrationen", () => {
  it("md5-tjek før og efter triggeren; rabatten efter sluttid kun ved auktionens lukning", () => {
    expect(MIG).toContain("is distinct from '71c3db40bf76679a88c6a4902b896d6b'");
    const nye = MIG.match(/095aa253737258905ae53646ce759616/g) ?? [];
    expect(nye.length).toBe(2);
    expect(MIG).toMatch(/then least\(now\(\), v_slut\)/);
    expect(MIG).toMatch(/v_vinder = new\.buyer_id/);
    expect(MIG).toMatch(/x\.status in \('afventer', 'accepteret'\)/);
  });

  it("min_founder_rabat: ingen bruger-parameter, security definer, kun authenticated", () => {
    expect(MIG).toMatch(/function public\.min_founder_rabat\(p_tid timestamptz default now\(\)\)/);
    const fn = MIG.slice(MIG.indexOf("function public.min_founder_rabat("));
    expect(fn.slice(0, 400)).toMatch(/security definer\s+set search_path = ''/);
    expect(fn).toContain("auth.uid()");
    expect(MIG).toContain("revoke execute on function public.min_founder_rabat(timestamptz) from public, anon;");
    expect(MIG).toContain("grant execute on function public.min_founder_rabat(timestamptz) to authenticated;");
  });

  it("aldrig ordet forsikring", () => {
    expect(MIG.toLowerCase()).not.toContain("forsikring");
  });
});
