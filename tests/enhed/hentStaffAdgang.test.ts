// hentStaffAdgang og lagene ovenpå (assertRole, kraevSideRolle, getStaffRole,
// assertErhverv) - src/lib/adminAuth.ts. Falsk Supabase, intet netværk.
// Forkert host, aal1, gammel amr, ukendt faktor, inaktiv - og uden
// ADMIN_VAERT det gamle tjek.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NU = Math.floor(Date.now() / 1000);
const ID = "44444444-4444-4444-8444-444444444444";

const m = vi.hoisted(() => ({
  bruger: "44444444-4444-4444-8444-444444444444" as string | null,
  rolle: "medarbejder" as string | null,
  host: "admin.localhost:3000",
  claims: null as Record<string, unknown> | null,
  db: { staff: true, aktiv: true, ukendte_faktorer: false } as Record<string, unknown> | null,
  rpcKald: 0,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: m.host }), cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("next/navigation", () => ({
  redirect: (til: string) => {
    throw new Error(`REDIRECT:${til}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/supabase/bruger", () => ({
  hentBruger: async () => (m.bruger ? { id: m.bruger } : null),
  hentMinRolle: async () => m.rolle,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: m.claims ? { claims: m.claims } : null, error: null }) },
    rpc: async () => {
      m.rpcKald++;
      return m.db ? { data: m.db, error: null } : { data: null, error: { code: "x", message: "nede" } };
    },
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://eksempel.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "sb_publishable_test";

const auth = await import("@/lib/adminAuth");

const frisk = () => ({ sub: ID, aal: "aal2", amr: [{ method: "password", timestamp: NU - 60 }, { method: "totp", timestamp: NU - 60 }] });

beforeEach(() => {
  vi.stubEnv("ADMIN_VAERT", "admin.localhost");
  vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "http://admin.localhost:3000");
  m.bruger = ID;
  m.rolle = "medarbejder";
  m.host = "admin.localhost:3000";
  m.claims = frisk();
  m.db = { staff: true, aktiv: true, ukendte_faktorer: false };
  m.rpcKald = 0;
});
afterEach(() => vi.unstubAllEnvs());

async function fejl(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "ingen fejl";
}

describe("hentStaffAdgang med ADMIN_VAERT", () => {
  it("frisk aal2, aktiv, ingen ukendte faktorer: adgang", async () => {
    expect(await auth.hentStaffAdgang()).toMatchObject({ ok: true, userId: ID, rolle: "medarbejder" });
    expect((await auth.assertRole("medarbejder")).userId).toBe(ID);
    expect(await auth.getStaffRole()).toBe("medarbejder");
  });

  it("forkert host (hovedsitet): ingen adgang, siden sender til admin-hosten", async () => {
    m.host = "localhost:3000";
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "forkert_vaert" });
    expect(await fejl(auth.assertRole("medarbejder"))).toBe("Ingen adgang");
    expect(await fejl(auth.kraevSideRolle("medarbejder"))).toBe("REDIRECT:http://admin.localhost:3000/admin");
    expect(await auth.getStaffRole()).toBeNull();
    expect(await fejl(auth.assertErhverv())).toBe("Ingen adgang");
    // Uden for admin-hosten spørges databasen slet ikke.
    expect(m.rpcKald).toBe(0);
  });

  it("aal1: kode-siden", async () => {
    m.claims = { sub: ID, aal: "aal1", amr: [{ method: "password", timestamp: NU }] };
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "kraever_kode" });
    expect(await fejl(auth.assertRole("medarbejder"))).toBe("Kræver to-trins-login");
    expect(await fejl(auth.kraevSideRolle("medarbejder"))).toBe("REDIRECT:/adgang/kode");
  });

  it("gammel amr (over 12 timer): kode-siden", async () => {
    m.claims = { sub: ID, aal: "aal2", amr: [{ method: "totp", timestamp: NU - 12 * 3600 - 5 }] };
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "kraever_kode" });
    // Loft på 12 timer (migration B): 24 lukker ikke en gammel kode ind.
    vi.stubEnv("STAFF_TO_TRIN_MAKS_TIMER", "24");
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "kraever_kode" });
    // En lavere grænse gælder: en kode på 9 timer er for gammel ved 8.
    m.claims = { sub: ID, aal: "aal2", amr: [{ method: "totp", timestamp: NU - 9 * 3600 }] };
    expect((await auth.hentStaffAdgang()).ok).toBe(true);
    vi.stubEnv("STAFF_TO_TRIN_MAKS_TIMER", "8");
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "kraever_kode" });
  });

  it("ukendt faktor: ingen adgang (kode-siden rydder op)", async () => {
    m.db = { staff: true, aktiv: true, ukendte_faktorer: true };
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "ukendt_faktor" });
    expect(await fejl(auth.assertRole("medarbejder"))).toBe("Kræver to-trins-login");
  });

  it("inaktiv (nulstillet eller ikke sat op): opsætningssiden", async () => {
    m.db = { staff: true, aktiv: false, ukendte_faktorer: false };
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "ikke_opsat" });
    expect(await fejl(auth.kraevSideRolle("medarbejder"))).toBe("REDIRECT:/adgang/opsaet");
  });

  it("databasen svarer ikke: fail closed", async () => {
    m.db = null;
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "fejl" });
    expect(await fejl(auth.assertRole("medarbejder"))).toBe("Ingen adgang");
  });

  it("JWT for en anden bruger end getUser: ikke logget ind", async () => {
    m.claims = { ...frisk(), sub: "55555555-5555-4555-8555-555555555555" };
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "ikke_logget_ind" });
    expect(await fejl(auth.kraevSideRolle("medarbejder"))).toBe("REDIRECT:http://admin.localhost:3000/adgang/login");
  });

  it("rollen gælder stadig: medarbejder er ikke chef, saelger kun Erhverv", async () => {
    expect(await fejl(auth.assertRole("chef"))).toBe("Ingen adgang");
    expect(await fejl(auth.kraevSideRolle("admin"))).toBe("NOT_FOUND");
    m.rolle = "saelger";
    expect(await fejl(auth.assertRole("medarbejder"))).toBe("Ingen adgang");
    expect((await auth.assertErhverv()).rolle).toBe("saelger");
    expect(await fejl(auth.assertErhverv(true))).toBe("Ingen adgang");
  });

  it("ikke staff: 404", async () => {
    m.rolle = "bruger";
    expect(await auth.hentStaffAdgang()).toEqual({ ok: false, grund: "ingen_adgang" });
    expect(await fejl(auth.kraevSideRolle("medarbejder"))).toBe("NOT_FOUND");
  });
});

describe("uden ADMIN_VAERT: det gamle tjek (kun rollen)", () => {
  beforeEach(() => vi.stubEnv("ADMIN_VAERT", ""));

  it("aal1 på hovedsitet giver adgang som før", async () => {
    m.host = "localhost:3000";
    m.claims = { sub: ID, aal: "aal1", amr: [] };
    m.db = null;
    expect(await auth.hentStaffAdgang()).toMatchObject({ ok: true, rolle: "medarbejder", andetTrinSek: null });
    expect((await auth.assertRole("medarbejder")).userId).toBe(ID);
    expect(m.rpcKald).toBe(0);
  });

  it("ikke logget ind sender til forsiden som før", async () => {
    m.bruger = null;
    expect(await fejl(auth.kraevSideRolle("medarbejder"))).toBe("REDIRECT:/");
    expect(await fejl(auth.assertRole("medarbejder"))).toBe("Ikke logget ind");
  });
});

describe("staffRolleTilVisning (kun til links og tekster)", () => {
  it("giver rollen også uden for admin-hosten", async () => {
    m.host = "localhost:3000";
    m.rolle = "admin";
    expect(await auth.staffRolleTilVisning()).toBe("admin");
    expect(await auth.getStaffRole()).toBeNull();
  });
});
