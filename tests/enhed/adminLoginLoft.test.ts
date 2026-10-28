// Admin-login: staff kan ikke spærres ude via loftet pr. e-mail
// (PLAN-MOD-LANCERING, "Admin: staff kan ikke spærres ude via login-loftet").
// src/lib/adgang.ts med alt omkring mocket: databasen, Supabase Auth,
// rate limits og den kendte enhed (cookien bh_enhed).
//
// Testes:
//   - fra en ukendt browser gælder loftet pr. e-mail som før - for staff og
//     for e-mails, der ikke er staff, med SAMME svar (afslører intet)
//   - fra en kendt enhed for netop den medarbejder gælder det ikke: en
//     angriber, der har ramt loftet, kan ikke spærre medarbejderen ude
//   - lofterne pr. IP og pr. e-mail+IP gælder stadig for alle
//   - det samme for gendannelse med gendannelseskode
import { beforeEach, describe, expect, it, vi } from "vitest";

const STAFF_ID = "55555555-5555-4555-8555-555555555555";

const m = vi.hoisted(() => ({
  // Svar fra rate limit pr. grænsenavn ("ok" som standard).
  loft: {} as Record<string, "ok" | "for_mange" | "fejl">,
  graenseKald: [] as string[],
  brugere: {} as Record<string, Record<string, unknown>[]>,
  kendt: false,
  kendtKald: [] as string[],
  login: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signOut: vi.fn(async () => ({ error: null })) } }),
  paaAdminVaert: async () => true,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: (_k: string, email: string) => ({ limit: async () => ({ data: m.brugere[email] ?? [], error: null }) }),
      }),
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  }),
}));
vi.mock("@/lib/supabase/adgangskodeLogin", () => ({ logIndUdenCaptcha: m.login }));
vi.mock("@/lib/rateLimit", () => ({
  PROEV_IGEN_OM_LIDT: "Prøv igen om lidt.",
  klientIp: async () => "10.0.0.1",
  tjekGraenserLukket: async (t: [string, string][]) => {
    const svar = t.map(([n]) => {
      m.graenseKald.push(n);
      return m.loft[n] ?? "ok";
    });
    if (svar.includes("for_mange")) return "for_mange";
    if (svar.includes("fejl")) return "fejl";
    return "ok";
  },
  graenseFejl: (s: string) => (s === "for_mange" ? "For mange forsøg." : s === "fejl" ? "Prøv igen om lidt." : null),
  nulstilGraense: vi.fn(async () => {}),
}));
vi.mock("@/lib/kontoOprettelse", () => ({
  renEmail: (v: unknown) => (typeof v === "string" && v.includes("@") ? v.trim().toLowerCase() : null),
}));
vi.mock("@/lib/kontoStatus", () => ({ hentKontoStatus: async () => ({ kode: "ok" }) }));
vi.mock("@/lib/enheder", () => ({
  erKendtEnhed: async (id: string) => {
    m.kendtKald.push(id);
    return m.kendt;
  },
  registrerLogin: vi.fn(async () => {}),
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => null) }));
vi.mock("@/lib/staffToTrin", () => ({
  aktivTotpFaktor: vi.fn(),
  bekraeftTotp: vi.fn(),
  godkendteFaktorer: vi.fn(),
  hashGendannelseskode: () => "h".repeat(64),
  hashMailKode: vi.fn(),
  minStaffStatus: async () => ({ staff: true, aktiv: true }),
  nyMailKode: vi.fn(),
  nyeGendannelseskoder: vi.fn(),
  rydUkendteFaktorer: vi.fn(),
  sendSikkerhedsmail: vi.fn(),
  sletAlleFaktorer: vi.fn(),
}));
vi.mock("@/lib/mails/staffToTrin", () => ({
  toTrinGendannetMail: vi.fn(),
  toTrinMailKodeMail: vi.fn(),
  toTrinOpsatMail: vi.fn(),
}));
vi.mock("@/lib/mails/send", () => ({ sendHandelMailDetaljer: vi.fn() }));

const adgang = await import("@/lib/adgang");

const FORKERT = "Forkert e-mail eller adgangskode.";

beforeEach(() => {
  vi.clearAllMocks();
  adgang.ADMIN_SVARTID.minMs = 0;
  m.loft = {};
  m.graenseKald = [];
  m.kendt = false;
  m.kendtKald = [];
  m.brugere = {
    "chef@test.bidhamr.dk": [
      { id: STAFF_ID, rolle: "chef", suspenderet: false, suspenderet_til: null, konto_slettet_kl: null, konto_lukket_kl: null },
    ],
    "bruger@test.bidhamr.dk": [
      { id: "66666666-6666-4666-8666-666666666666", rolle: "bruger", suspenderet: false, suspenderet_til: null, konto_slettet_kl: null, konto_lukket_kl: null },
    ],
  };
  m.login.mockResolvedValue({ data: { user: null, session: null }, error: { code: "invalid_credentials", status: 400 } });
});

describe("loftet pr. e-mail på admin-login", () => {
  it("ukendt browser: loftet pr. e-mail gælder for staff - adgangskoden prøves ikke", async () => {
    m.loft.admin_login_email = "for_mange";
    expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "gæt")).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
    expect(m.graenseKald).toEqual(["admin_login_ip", "admin_login_email_ip", "admin_login_email"]);
  });

  it("kendt enhed for netop medarbejderen: loftet pr. e-mail kan ikke spærre medarbejderen ude", async () => {
    m.loft.admin_login_email = "for_mange"; // en angriber har ramt loftet
    m.kendt = true;
    m.login.mockResolvedValue({ data: { user: null, session: null }, error: { code: "invalid_credentials", status: 400 } });
    await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig");
    expect(m.login).toHaveBeenCalledTimes(1);
    expect(m.kendtKald).toEqual([STAFF_ID]);
    expect(m.graenseKald).not.toContain("admin_login_email");
  });

  it("lofterne pr. IP og pr. e-mail+IP gælder stadig - også fra en kendt enhed", async () => {
    m.kendt = true;
    m.loft.admin_login_email_ip = "for_mange";
    expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig")).toEqual({ fejl: "For mange forsøg." });
    m.loft = { admin_login_ip: "for_mange" };
    expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig")).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
  });

  it("afslører ikke, om e-mailen er staff: samme svar og samme lofter for staff, almindelige og ukendte e-mails", async () => {
    for (const email of ["chef@test.bidhamr.dk", "bruger@test.bidhamr.dk", "ukendt@test.bidhamr.dk"]) {
      m.graenseKald = [];
      m.loft = {};
      expect(await adgang.logIndAdmin(email, "forkert")).toEqual({ fejl: FORKERT });
      expect(m.graenseKald).toEqual(["admin_login_ip", "admin_login_email_ip", "admin_login_email"]);
      m.loft.admin_login_email = "for_mange";
      expect(await adgang.logIndAdmin(email, "forkert")).toEqual({ fejl: "For mange forsøg." });
    }
    // Den kendte enhed slås kun op for staff (en almindelig bruger kan ikke
    // slippe uden om loftet).
    expect(m.kendtKald).toEqual([STAFF_ID, STAFF_ID]);
  });

  it("en kendt enhed hjælper ikke en anden e-mail end den, den er kendt for", async () => {
    m.kendt = true;
    m.loft.admin_login_email = "for_mange";
    expect(await adgang.logIndAdmin("bruger@test.bidhamr.dk", "x")).toEqual({ fejl: "For mange forsøg." });
    expect(m.kendtKald).toEqual([]);
  });

  it("fast minimumssvartid gælder stadig", async () => {
    adgang.ADMIN_SVARTID.minMs = 150;
    const t0 = Date.now();
    await adgang.logIndAdmin("ukendt@test.bidhamr.dk", "x");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

describe("loftet pr. e-mail på gendannelse", () => {
  const KODE = "ABCD-EFGH-JKMN-PQRS";

  it("ukendt browser: loftet gælder; kendt enhed: det gælder ikke", async () => {
    m.loft.admin_gendan_email = "for_mange";
    expect(await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE)).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
    m.kendt = true;
    await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE);
    expect(m.login).toHaveBeenCalledTimes(1);
  });

  it("IP-loftet gælder også fra en kendt enhed", async () => {
    m.kendt = true;
    m.loft.admin_gendan_ip = "for_mange";
    expect(await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE)).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
  });
});
