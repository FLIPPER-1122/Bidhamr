// Admin-login: staff kan ikke spærres ude via loftet pr. e-mail
// (PLAN-MOD-LANCERING, "Admin: staff kan ikke spærres ude via login-loftet",
// og review af 20261102410000 -> 20261102430000).
// src/lib/adgang.ts med alt omkring mocket: databasen, Supabase Auth,
// rate limits og undtagelsen fra loftet (loftUndtagelse i src/lib/enheder.ts).
//
// Testes:
//   - fra en ukendt browser gælder loftet pr. e-mail som før - for staff og
//     for e-mails, der ikke er staff, med SAMME svar (afslører intet)
//   - fra en kendt enhed (to-trins-login gennemført på admin-hosten) gælder
//     det ikke - i stedet et loft pr. enhed
//   - efter chefens "Nulstil login-loft" gælder det ikke for kontoen
//   - lofterne pr. IP og pr. e-mail+IP gælder stadig for alle
//   - enheden markeres først efter koden fra app'en, ikke efter adgangskoden
//   - det samme for gendannelse med gendannelseskode
import { beforeEach, describe, expect, it, vi } from "vitest";

const STAFF_ID = "55555555-5555-4555-8555-555555555555";
const HASH = "e".repeat(64);

type Undtagelse = { kode: "enhed"; hash: string } | { kode: "fritaget" } | null;

const m = vi.hoisted(() => ({
  // Svar fra rate limit pr. grænsenavn ("ok" som standard).
  loft: {} as Record<string, "ok" | "for_mange" | "fejl">,
  graenseKald: [] as [string, string][],
  brugere: {} as Record<string, Record<string, unknown>[]>,
  undtagelse: null as Undtagelse,
  undtagelseKald: [] as string[],
  login: vi.fn(),
  marker: vi.fn(async () => {}),
  bekraeftTotp: vi.fn(),
  aktivTotpFaktor: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signOut: vi.fn(async () => ({ error: null })),
      getUser: async () => ({ data: { user: { id: STAFF_ID, email: "chef@test.bidhamr.dk" } } }),
    },
  }),
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
    const svar = t.map(([n, id]) => {
      m.graenseKald.push([n, id]);
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
  loftUndtagelse: async (id: string) => {
    m.undtagelseKald.push(id);
    return m.undtagelse;
  },
  markerAdminMfa: m.marker,
  registrerLogin: vi.fn(async () => {}),
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => null) }));
vi.mock("@/lib/staffToTrin", () => ({
  aktivTotpFaktor: m.aktivTotpFaktor,
  bekraeftTotp: m.bekraeftTotp,
  godkendteFaktorer: vi.fn(async () => null),
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
const navne = () => m.graenseKald.map(([n]) => n);

beforeEach(() => {
  vi.clearAllMocks();
  adgang.ADMIN_SVARTID.minMs = 0;
  m.loft = {};
  m.graenseKald = [];
  m.undtagelse = null;
  m.undtagelseKald = [];
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
    expect(navne()).toEqual(["admin_login_ip", "admin_login_email_ip", "admin_login_email"]);
  });

  it("kendt enhed (to-trins-login gennemført her): loftet pr. e-mail spærrer ikke - loftet pr. enhed tælles i stedet", async () => {
    m.loft.admin_login_email = "for_mange"; // en angriber har ramt loftet
    m.undtagelse = { kode: "enhed", hash: HASH };
    await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig");
    expect(m.login).toHaveBeenCalledTimes(1);
    expect(m.undtagelseKald).toEqual([STAFF_ID]);
    expect(navne()).not.toContain("admin_login_email");
    expect(m.graenseKald).toContainEqual(["admin_login_enhed", HASH]);
  });

  it("loftet pr. enhed: en stjålet cookie giver ikke ubegrænsede forsøg", async () => {
    m.undtagelse = { kode: "enhed", hash: HASH };
    m.loft.admin_login_enhed = "for_mange";
    expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "gæt")).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
  });

  it("chefens nulstilling (fritaget): hverken loftet pr. e-mail eller pr. enhed tælles", async () => {
    m.loft.admin_login_email = "for_mange";
    m.undtagelse = { kode: "fritaget" };
    await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig");
    expect(m.login).toHaveBeenCalledTimes(1);
    expect(navne()).toEqual(["admin_login_ip", "admin_login_email_ip"]);
  });

  it("lofterne pr. IP og pr. e-mail+IP gælder stadig - også fra en kendt enhed og efter nulstilling", async () => {
    for (const u of [{ kode: "enhed", hash: HASH }, { kode: "fritaget" }] as const) {
      m.undtagelse = u;
      m.loft = { admin_login_email_ip: "for_mange" };
      expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig")).toEqual({ fejl: "For mange forsøg." });
      m.loft = { admin_login_ip: "for_mange" };
      expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig")).toEqual({ fejl: "For mange forsøg." });
    }
    expect(m.login).not.toHaveBeenCalled();
  });

  it("afslører ikke, om e-mailen er staff: samme svar og samme lofter for staff, almindelige og ukendte e-mails", async () => {
    for (const email of ["chef@test.bidhamr.dk", "bruger@test.bidhamr.dk", "ukendt@test.bidhamr.dk"]) {
      m.graenseKald = [];
      m.loft = {};
      expect(await adgang.logIndAdmin(email, "forkert")).toEqual({ fejl: FORKERT });
      expect(navne()).toEqual(["admin_login_ip", "admin_login_email_ip", "admin_login_email"]);
      m.loft.admin_login_email = "for_mange";
      expect(await adgang.logIndAdmin(email, "forkert")).toEqual({ fejl: "For mange forsøg." });
    }
    // Undtagelsen slås kun op for staff (en almindelig bruger kan ikke
    // slippe uden om loftet).
    expect(m.undtagelseKald).toEqual([STAFF_ID, STAFF_ID]);
  });

  it("en undtagelse hjælper ikke en anden e-mail end den, den gælder for", async () => {
    m.undtagelse = { kode: "enhed", hash: HASH };
    m.loft.admin_login_email = "for_mange";
    expect(await adgang.logIndAdmin("bruger@test.bidhamr.dk", "x")).toEqual({ fejl: "For mange forsøg." });
    expect(m.undtagelseKald).toEqual([]);
  });

  it("adgangskoden alene gør ikke enheden kendt", async () => {
    m.login.mockResolvedValue({
      data: { user: { id: STAFF_ID, email: "chef@test.bidhamr.dk" }, session: { access_token: "x" } },
      error: null,
    });
    expect(await adgang.logIndAdmin("chef@test.bidhamr.dk", "rigtig")).toEqual({ ok: true, naeste: "kode" });
    expect(m.marker).not.toHaveBeenCalled();
  });

  it("fast minimumssvartid gælder stadig", async () => {
    adgang.ADMIN_SVARTID.minMs = 150;
    const t0 = Date.now();
    await adgang.logIndAdmin("ukendt@test.bidhamr.dk", "x");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

describe("enheden bliver kendt efter koden fra app'en", () => {
  it("markeres efter en rigtig kode - ikke efter en forkert", async () => {
    m.aktivTotpFaktor.mockResolvedValue("faktor-1");
    m.bekraeftTotp.mockResolvedValue("forkert");
    expect(await adgang.bekraeftAdminKode("123456")).toHaveProperty("fejl");
    expect(m.marker).not.toHaveBeenCalled();
    m.bekraeftTotp.mockResolvedValue("ok");
    expect(await adgang.bekraeftAdminKode("123456")).toEqual({ ok: true });
    expect(m.marker).toHaveBeenCalledWith(STAFF_ID);
  });
});

describe("loftet pr. e-mail på gendannelse", () => {
  const KODE = "ABCD-EFGH-JKMN-PQRS";

  it("ukendt browser: loftet gælder; kendt enhed: loftet pr. enhed i stedet", async () => {
    m.loft.admin_gendan_email = "for_mange";
    expect(await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE)).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
    m.undtagelse = { kode: "enhed", hash: HASH };
    await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE);
    expect(m.login).toHaveBeenCalledTimes(1);
    expect(m.graenseKald).toContainEqual(["admin_gendan_enhed", HASH]);
    m.loft.admin_gendan_enhed = "for_mange";
    expect(await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE)).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).toHaveBeenCalledTimes(1);
  });

  it("chefens nulstilling gælder også for gendannelse", async () => {
    m.loft.admin_gendan_email = "for_mange";
    m.undtagelse = { kode: "fritaget" };
    await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE);
    expect(m.login).toHaveBeenCalledTimes(1);
  });

  it("IP-loftet gælder også fra en kendt enhed", async () => {
    m.undtagelse = { kode: "enhed", hash: HASH };
    m.loft.admin_gendan_ip = "for_mange";
    expect(await adgang.gendanAdmin("chef@test.bidhamr.dk", "x", KODE)).toEqual({ fejl: "For mange forsøg." });
    expect(m.login).not.toHaveBeenCalled();
  });
});
