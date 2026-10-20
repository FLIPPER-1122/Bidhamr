// To-trins-login for staff: de rene regler (src/lib/staffToTrinRegler.ts) og
// gendannelseskoderne (src/lib/staffToTrin.ts).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => null) }));
vi.mock("@/lib/mails/send", () => ({ sendHandelMailDetaljer: vi.fn(async () => ({ ok: true })) }));

import {
  GENDANNELSESKODER_ANTAL,
  andetTrinFrisk,
  nyesteAndetTrinSek,
  renGendannelseskode,
  renTotpKode,
  sikkerAdminSti,
  somStaffRolle,
  toTrinMaksTimer,
  toTrinMaksTimerFejl,
  vurderStaffAdgang,
  type StaffInput,
} from "@/lib/staffToTrinRegler";
import { hashGendannelseskode, nyeGendannelseskoder } from "@/lib/staffToTrin";

const NU = 1_800_000_000;
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

describe("amr og frisk kode", () => {
  it("finder det seneste TOTP og ignorerer andre metoder og skrald", () => {
    const amr = [
      { method: "password", timestamp: NU - 10 },
      { method: "totp", timestamp: NU - 500 },
      { method: "totp", timestamp: NU - 100 },
      { method: "otp", timestamp: NU },
      { method: "totp", timestamp: "nu" },
      null,
    ];
    expect(nyesteAndetTrinSek(amr)).toBe(NU - 100);
    expect(nyesteAndetTrinSek([{ method: "password", timestamp: NU }])).toBeNull();
    expect(nyesteAndetTrinSek("totp")).toBeNull();
    expect(nyesteAndetTrinSek(undefined)).toBeNull();
  });

  it("12 timer: frisk lige før grænsen, gammel lige efter", () => {
    const maks = 12 * 3600;
    expect(andetTrinFrisk([{ method: "totp", timestamp: NU - maks }], maks, NU)).toBe(true);
    expect(andetTrinFrisk([{ method: "totp", timestamp: NU - maks - 1 }], maks, NU)).toBe(false);
    // Et tidspunkt langt ude i fremtiden godtages ikke.
    expect(andetTrinFrisk([{ method: "totp", timestamp: NU + 3600 }], maks, NU)).toBe(false);
    expect(andetTrinFrisk([{ method: "totp", timestamp: NU + 60 }], maks, NU)).toBe(true);
  });

  it("STAFF_TO_TRIN_MAKS_TIMER: standard 12, 1-12, loft 12 (migration B)", () => {
    expect(toTrinMaksTimer(undefined)).toBe(12);
    expect(toTrinMaksTimer("")).toBe(12);
    expect(toTrinMaksTimer("8")).toBe(8);
    expect(toTrinMaksTimer("12")).toBe(12);
    expect(toTrinMaksTimer("13")).toBe(12);
    expect(toTrinMaksTimer("24")).toBe(12);
    expect(toTrinMaksTimer("0")).toBe(12);
    expect(toTrinMaksTimer("169")).toBe(12);
    expect(toTrinMaksTimer("2.5")).toBe(12);
    expect(toTrinMaksTimer("abc")).toBe(12);
  });
});

describe("vurderStaffAdgang", () => {
  const frisk = [{ method: "password", timestamp: NU - 60 }, { method: "totp", timestamp: NU - 60 }];
  const basis: StaffInput = {
    flagAktiv: true,
    paaAdminVaert: true,
    brugerId: ID,
    claimsSub: ID,
    rolle: "medarbejder",
    aal: "aal2",
    amr: frisk,
    db: { aktiv: true, ukendte_faktorer: false },
    nuSek: NU,
    maksTimer: 12,
  };
  const v = (over: Partial<StaffInput>) => vurderStaffAdgang({ ...basis, ...over });

  it("alt i orden: adgang med tidspunktet for koden", () => {
    expect(v({})).toEqual({ ok: true, rolle: "medarbejder", andetTrinSek: NU - 60 });
  });

  it.each([
    ["ikke logget ind", { brugerId: null }, "ikke_logget_ind"],
    ["forkert host (hovedsitet)", { paaAdminVaert: false }, "forkert_vaert"],
    ["ikke staff", { rolle: "bruger" }, "ingen_adgang"],
    ["ingen rolle", { rolle: null }, "ingen_adgang"],
    ["JWT for en anden bruger", { claimsSub: ID2 }, "ikke_logget_ind"],
    ["ingen JWT", { claimsSub: null }, "ikke_logget_ind"],
    ["aal1", { aal: "aal1" }, "kraever_kode"],
    ["aal2 uden TOTP i amr", { amr: [{ method: "password", timestamp: NU }] }, "kraever_kode"],
    ["gammel amr (13 timer)", { amr: [{ method: "totp", timestamp: NU - 13 * 3600 }] }, "kraever_kode"],
    ["ukendt faktor", { db: { aktiv: true, ukendte_faktorer: true } }, "ukendt_faktor"],
    ["inaktiv (nulstillet / ikke sat op)", { db: { aktiv: false, ukendte_faktorer: false } }, "ikke_opsat"],
    ["databasen svarer ikke (fail closed)", { db: null }, "fejl"],
  ] as [string, Partial<StaffInput>, string][])("%s -> %s", (_navn, over, grund) => {
    expect(v(over)).toEqual({ ok: false, grund });
  });

  it("ukendt faktor vinder over aal1 (og inaktiv over aal1)", () => {
    expect(v({ aal: "aal1", db: { aktiv: true, ukendte_faktorer: true } })).toEqual({ ok: false, grund: "ukendt_faktor" });
    expect(v({ aal: "aal1", db: { aktiv: false, ukendte_faktorer: false } })).toEqual({ ok: false, grund: "ikke_opsat" });
  });

  it("start-tjekket melder en værdi over 12 eller en ugyldig værdi", () => {
    expect(toTrinMaksTimerFejl(undefined)).toBeNull();
    expect(toTrinMaksTimerFejl("")).toBeNull();
    expect(toTrinMaksTimerFejl("8")).toBeNull();
    expect(toTrinMaksTimerFejl("12")).toBeNull();
    expect(toTrinMaksTimerFejl("13")).toMatch(/højst 12/);
    expect(toTrinMaksTimerFejl("abc")).toMatch(/ugyldig/);
    expect(toTrinMaksTimerFejl("0")).toMatch(/ugyldig/);
  });

  it("STAFF_TO_TRIN_MAKS_TIMER styrer grænsen", () => {
    expect(v({ amr: [{ method: "totp", timestamp: NU - 3 * 3600 }], maksTimer: 2 })).toEqual({ ok: false, grund: "kraever_kode" });
    expect(v({ amr: [{ method: "totp", timestamp: NU - 3 * 3600 }], maksTimer: 4 }).ok).toBe(true);
  });

  it("alle staff-roller, også saelger", () => {
    for (const r of ["medarbejder", "admin", "chef", "saelger"]) expect(v({ rolle: r }).ok).toBe(true);
    expect(somStaffRolle("bruger")).toBeNull();
  });

  it("uden ADMIN_VAERT: kun rollen, som før (intet to-trins-krav, ingen host)", () => {
    const gl = { flagAktiv: false, paaAdminVaert: false, claimsSub: null, aal: "aal1", amr: [], db: null };
    expect(v(gl)).toEqual({ ok: true, rolle: "medarbejder", andetTrinSek: null });
    expect(v({ ...gl, rolle: "bruger" })).toEqual({ ok: false, grund: "ingen_adgang" });
    expect(v({ ...gl, brugerId: null })).toEqual({ ok: false, grund: "ikke_logget_ind" });
  });
});

describe("koden fra app'en", () => {
  it.each([
    ["123456", "123456"],
    [" 123 456 ", "123456"],
    ["123-456", "123456"],
    ["12345", null],
    ["1234567", null],
    ["12a456", null],
    [123456, null],
  ])("%s -> %s", (ind, ud) => expect(renTotpKode(ind)).toBe(ud));
});

describe("gendannelseskoder", () => {
  it("10 forskellige i formatet XXXX-XXXX-XXXX-XXXX uden tegn, der ligner hinanden", () => {
    const koder = nyeGendannelseskoder();
    expect(koder).toHaveLength(GENDANNELSESKODER_ANTAL);
    expect(new Set(koder).size).toBe(10);
    for (const k of koder) {
      expect(k).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(k).not.toMatch(/[01ILOUV]/);
    }
  });

  it("normaliseres: små bogstaver, mellemrum og bindestreger er ligegyldige", () => {
    const k = nyeGendannelseskoder()[0];
    const ren = k.replace(/-/g, "");
    expect(renGendannelseskode(k)).toBe(ren);
    expect(renGendannelseskode(k.toLowerCase())).toBe(ren);
    expect(renGendannelseskode(` ${ren.slice(0, 8)} ${ren.slice(8)} `)).toBe(ren);
    expect(renGendannelseskode("ABCD-EFGH")).toBeNull();
    expect(renGendannelseskode("0000-0000-0000-0000")).toBeNull();
    expect(renGendannelseskode(null)).toBeNull();
  });

  it("hashen er sha256 (64 hex), samme for samme kode og bruger, forskellig for en anden bruger", () => {
    const k = nyeGendannelseskoder()[0];
    const h = hashGendannelseskode(ID, k);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGendannelseskode(ID, k.toLowerCase().replace(/-/g, " "))).toBe(h);
    expect(hashGendannelseskode(ID.toUpperCase(), k)).toBe(h);
    expect(hashGendannelseskode(ID2, k)).not.toBe(h);
    expect(hashGendannelseskode(ID, "forkert")).toBeNull();
    expect(hashGendannelseskode("ikke-et-id", k)).toBeNull();
    // Selve koden står ikke i hashen.
    expect(h).not.toContain(k.replace(/-/g, "").toLowerCase());
  });
});

describe("sikkerAdminSti (efter login)", () => {
  it.each([
    ["/admin/sager?q=1", "/admin/sager?q=1"],
    ["/admin", "/admin"],
    ["/administrator", "/admin"],
    ["/auktioner", "/admin"],
    ["//evil.dk/admin", "/admin"],
    ["https://evil.dk/admin", "/admin"],
    ["/admin\\..\\evil", "/admin"],
    ["/admin/\nx", "/admin"],
    [undefined, "/admin"],
  ])("%s -> %s", (ind, ud) => expect(sikkerAdminSti(ind)).toBe(ud));
});
