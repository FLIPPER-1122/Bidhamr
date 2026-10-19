// Routing-matricen for proxyen med admin på egen host (docs/ADMIN-VAERT.md):
// host x sti x metode x session (ingen/aal1/aal2/gammel kode) x rolle
// (bruger/medarbejder/saelger). Den rigtige proxy (src/proxy.ts) køres med en
// falsk Supabase - ingen netværk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NU = Math.floor(Date.now() / 1000);
const BRUGER = "33333333-3333-4333-8333-333333333333";

const m = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  rolle: "bruger" as string | null,
  foerLancering: false,
  cookieNavne: [] as (string | undefined)[],
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _noegle: string, opts: { cookieOptions?: { name?: string } }) => {
    m.cookieNavne.push(opts.cookieOptions?.name);
    return {
      auth: { getClaims: async () => ({ data: m.claims ? { claims: m.claims } : null, error: null }) },
      rpc: async (fn: string) => ({ data: fn === "min_rolle" ? m.rolle : false, error: null }),
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { konto_type: "privat" } }) }) }) }),
    };
  },
}));
vi.mock("@/lib/rolleCookie", () => ({
  ROLLE_COOKIE: "bh_rolle",
  laesRolleCookie: async () => null,
  lavRolleCookie: async () => null,
}));
vi.mock("@/lib/lancering", () => ({ foerLancering: () => m.foerLancering }));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://eksempel.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "sb_publishable_test";

const { proxy } = await import("@/proxy");
const { adminGateBeslutning, adminRute, hovedAdminBeslutning } = await import("@/lib/adminGateRegler");

type Session = "ingen" | "aal1" | "aal2" | "gammel";
function saetSession(s: Session) {
  const pw = { method: "password", timestamp: NU - 60 };
  m.claims =
    s === "ingen"
      ? null
      : s === "aal1"
        ? { sub: BRUGER, session_id: "s1", aal: "aal1", amr: [pw] }
        : s === "aal2"
          ? { sub: BRUGER, session_id: "s1", aal: "aal2", amr: [pw, { method: "totp", timestamp: NU - 60 }] }
          : { sub: BRUGER, session_id: "s1", aal: "aal2", amr: [pw, { method: "totp", timestamp: NU - 13 * 3600 }] };
}

async function kald(host: string, sti: string, metode = "GET", ekstra: Record<string, string> = {}) {
  const headers: Record<string, string> = { host, ...ekstra };
  if (metode !== "GET" && metode !== "HEAD") headers["content-type"] = "text/plain;charset=UTF-8";
  const req = new NextRequest(`http://${host}${sti}`, { method: metode, headers, body: metode === "GET" || metode === "HEAD" ? undefined : "[]" });
  const res = await proxy(req);
  const loc = res.headers.get("location");
  return { status: res.status, til: loc ? new URL(loc).toString() : null, res };
}

const ADMIN = "admin.localhost:3000";
const HOVED = "localhost:3000";

beforeEach(() => {
  vi.stubEnv("ADMIN_VAERT", "admin.localhost");
  vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "http://admin.localhost:3000");
  vi.stubEnv("ADMIN_LUK_HOVEDDOMAENE", "");
  m.foerLancering = false;
  m.rolle = "bruger";
  m.cookieNavne = [];
  saetSession("ingen");
});
afterEach(() => vi.unstubAllEnvs());

describe("tilladelseslisten på admin-hosten", () => {
  it.each([
    ["/", "rod"],
    ["/robots.txt", "robots"],
    ["/admin", "admin"],
    ["/admin/penge/csv", "admin"],
    ["/adgang/login", "adgang"],
    ["/_next/data/x.json", "next"],
    ["/favicon.ico", "ikon"],
    ["/auktioner", "ukendt"],
    ["/api/cron/afslut-auktioner", "ukendt"],
    ["/login", "ukendt"],
    ["/administrator", "ukendt"],
    ["/adgangskode", "ukendt"],
  ])("%s -> %s", (sti, rute) => expect(adminRute(sti)).toBe(rute));
});

// [sti, metode, session, rolle, forventet status, forventet mål (sti)]
type Raekke = [string, string, Session, string, number, string | null];
const ADMIN_MATRIX: Raekke[] = [
  // Uden for listen: altid 404, uanset session.
  ["/auktioner", "GET", "aal2", "medarbejder", 404, null],
  ["/api/cron/x", "GET", "ingen", "bruger", 404, null],
  ["/login", "POST", "aal2", "chef", 404, null],
  ["/_next/x", "POST", "aal2", "chef", 404, null],
  // Roden sender til /admin.
  ["/", "GET", "ingen", "bruger", 307, "/admin"],
  ["/", "POST", "ingen", "bruger", 404, null],
  // /admin uden session: login (GET), 401 (andet).
  ["/admin", "GET", "ingen", "bruger", 307, "/adgang/login?naeste=%2Fadmin"],
  ["/admin/sager?q=1", "GET", "ingen", "bruger", 307, "/adgang/login?naeste=%2Fadmin%2Fsager%3Fq%3D1"],
  ["/admin", "POST", "ingen", "bruger", 401, null],
  // Ikke staff: 404 - også med aal2.
  ["/admin", "GET", "aal1", "bruger", 404, null],
  ["/admin", "GET", "aal2", "bruger", 404, null],
  ["/admin", "POST", "aal2", "bruger", 404, null],
  // Staff med aal1 eller en gammel kode: kode-siden.
  ["/admin", "GET", "aal1", "medarbejder", 307, "/adgang/kode?naeste=%2Fadmin"],
  ["/admin/sager", "GET", "gammel", "chef", 307, "/adgang/kode?naeste=%2Fadmin%2Fsager"],
  ["/admin", "POST", "aal1", "medarbejder", 401, null],
  ["/admin", "POST", "gammel", "admin", 401, null],
  // Staff med frisk aal2: ind.
  ["/admin", "GET", "aal2", "medarbejder", 200, null],
  ["/admin/penge/csv", "GET", "aal2", "chef", 200, null],
  ["/admin/sager", "POST", "aal2", "admin", 200, null],
  // Sælger: kun Erhverv.
  ["/admin", "GET", "aal2", "saelger", 307, "/admin/erhverv"],
  ["/admin/erhverv", "GET", "aal2", "saelger", 200, null],
  ["/admin/sager", "POST", "aal2", "saelger", 403, null],
  ["/admin/erhverv", "GET", "aal1", "saelger", 307, "/adgang/kode?naeste=%2Fadmin%2Ferhverv"],
  // /adgang: GET for alle. POST kun til route handlerne /adgang/api/* - og
  // kun uden session eller for staff, der mangler to-trins-login/en ny kode.
  ["/adgang/login", "GET", "ingen", "bruger", 200, null],
  ["/adgang/login", "GET", "aal1", "bruger", 200, null],
  // Et action-id postet til en login-side: aldrig (heller ikke uden session).
  ["/adgang/login", "POST", "ingen", "bruger", 404, null],
  ["/adgang/kode", "POST", "aal1", "medarbejder", 404, null],
  ["/adgang/kode", "POST", "aal1", "saelger", 404, null],
  ["/adgang", "POST", "aal1", "saelger", 404, null],
  ["/adgang/api/login", "POST", "ingen", "bruger", 200, null],
  ["/adgang/api/gendan", "POST", "ingen", "bruger", 200, null],
  ["/adgang/api/kode", "POST", "aal1", "medarbejder", 200, null],
  ["/adgang/api/kode", "POST", "gammel", "chef", 200, null],
  ["/adgang/api/opsaet-start", "POST", "aal1", "saelger", 200, null],
  // Fuldt inde (frisk aal2): intet at gøre på /adgang.
  ["/adgang/api/kode", "POST", "aal2", "chef", 403, null],
  ["/adgang/api/login", "POST", "aal1", "bruger", 403, null],
  ["/adgang/api/login", "POST", "aal2", "bruger", 403, null],
  // Log ud må altid.
  ["/adgang/api/logud", "POST", "aal2", "chef", 200, null],
  ["/adgang/api/logud", "POST", "aal1", "bruger", 200, null],
];

describe("admin-hosten (ADMIN_VAERT=admin.localhost)", () => {
  it.each(ADMIN_MATRIX)("%s %s session=%s rolle=%s -> %i %s", async (sti, metode, session, rolle, status, til) => {
    saetSession(session);
    m.rolle = rolle;
    const r = await kald(ADMIN, sti, metode);
    expect(r.status).toBe(status);
    expect(r.til).toBe(til ? `http://admin.localhost:3000${til}` : null);
  });

  it("gaten før lancering køres ikke (en sælger kommer stadig kun til Erhverv)", async () => {
    m.foerLancering = true;
    saetSession("aal2");
    m.rolle = "medarbejder";
    expect((await kald(ADMIN, "/admin")).status).toBe(200);
  });

  it("robots.txt: Disallow alt", async () => {
    const r = await kald(ADMIN, "/robots.txt");
    expect(r.status).toBe(200);
    expect(await r.res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("headere: noindex, no-referrer, no-store og admin-CSP uden Stripe/Google/MapTiler", async () => {
    saetSession("aal2");
    m.rolle = "chef";
    for (const sti of ["/admin", "/auktioner", "/adgang/login"]) {
      const { res } = await kald(ADMIN, sti);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).not.toMatch(/stripe|google|apple|maptiler|openstreetmap/);
      expect(csp).toContain("frame-src 'none'");
    }
  });

  it("admin-hosten bruger sin egen cookie; hovedsitet Supabases standard", async () => {
    saetSession("aal2");
    m.rolle = "chef";
    await kald(ADMIN, "/admin");
    expect(m.cookieNavne.at(-1)).toBe("bh-admin-auth");
    await kald(HOVED, "/auktioner");
    expect(m.cookieNavne.at(-1)).toBeUndefined();
  });

  it("en admin-cookie uden gyldige claims: ryddes, og alt andet end GET/HEAD får 401", async () => {
    saetSession("ingen");
    m.rolle = "chef";
    for (const [sti, metode, status] of [
      ["/admin", "POST", 401],
      ["/adgang/api/login", "POST", 401],
      ["/adgang/api/logud", "POST", 401],
      ["/admin/sager", "GET", 307],
      ["/adgang/login", "GET", 200],
    ] as const) {
      const r = await kald(ADMIN, sti, metode, { cookie: "bh-admin-auth.0=forfalsket; bh-admin-auth.1=mere" });
      expect(r.status, `${metode} ${sti}`).toBe(status);
      const saet = r.res.headers.getSetCookie().join("\n");
      expect(saet).toMatch(/bh-admin-auth\.0=;/);
      expect(saet).toMatch(/bh-admin-auth\.1=;/);
    }
    // Uden admin-cookie: intet ryddes, og login virker som før.
    const r = await kald(ADMIN, "/adgang/api/login", "POST");
    expect(r.status).toBe(200);
    expect(r.res.headers.getSetCookie().join("\n")).not.toMatch(/bh-admin-auth/);
  });

  it("x-forwarded-host kan ikke gøre hovedsitet til admin-hosten", async () => {
    saetSession("aal2");
    m.rolle = "chef";
    const r = await kald(HOVED, "/adgang/login", "GET", { "x-forwarded-host": "admin.localhost:3000" });
    expect(r.status).toBe(404);
  });
});

describe("hovedhosten (localhost) med ADMIN_VAERT sat", () => {
  it("/adgang findes ikke her", async () => {
    expect((await kald(HOVED, "/adgang/login")).status).toBe(404);
    expect((await kald(HOVED, "/adgang/login", "POST")).status).toBe(404);
  });

  it("ADMIN_LUK_HOVEDDOMAENE ikke sat: /admin går til gaten som i dag (siden sender selv videre)", async () => {
    saetSession("aal1");
    m.rolle = "chef";
    const r = await kald(HOVED, "/admin");
    expect(r.status).toBe(200);
  });

  it("=omdiriger: GET 307 til admin-hosten med sti og søgning, alt andet 404", async () => {
    vi.stubEnv("ADMIN_LUK_HOVEDDOMAENE", "omdiriger");
    saetSession("aal1");
    m.rolle = "chef";
    const r = await kald(HOVED, "/admin/sager?q=1");
    expect(r.status).toBe(307);
    expect(r.til).toBe("http://admin.localhost:3000/admin/sager?q=1");
    expect((await kald(HOVED, "/admin/sager", "POST")).status).toBe(404);
    expect((await kald(HOVED, "/admin", "PUT")).status).toBe(404);
  });

  it("=1: alt 404", async () => {
    vi.stubEnv("ADMIN_LUK_HOVEDDOMAENE", "1");
    saetSession("aal2");
    m.rolle = "chef";
    expect((await kald(HOVED, "/admin")).status).toBe(404);
    expect((await kald(HOVED, "/admin/penge/csv")).status).toBe(404);
    expect((await kald(HOVED, "/admin", "POST")).status).toBe(404);
  });

  it("sælgeren sendes til Erhverv på admin-hosten", async () => {
    saetSession("aal1");
    m.rolle = "saelger";
    const r = await kald(HOVED, "/admin/sager");
    expect(r.status).toBe(307);
    expect(r.til).toBe("http://admin.localhost:3000/admin/erhverv");
  });

  it("resten af hovedsitet er uændret", async () => {
    expect((await kald(HOVED, "/auktioner")).status).toBe(200);
    saetSession("aal1");
    expect((await kald(HOVED, "/konto")).status).toBe(200);
  });
});

describe("uden ADMIN_VAERT (flaget slået fra)", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_VAERT", "");
    vi.stubEnv("ADMIN_LUK_HOVEDDOMAENE", "1");
  });

  it("admin.localhost er bare en host som alle andre - ingen admin-gate", async () => {
    saetSession("aal1");
    m.rolle = "chef";
    const r = await kald(ADMIN, "/admin");
    expect(r.status).toBe(200);
    expect(m.cookieNavne.at(-1)).toBeUndefined();
  });

  it("/admin på hovedsitet virker som i dag (lukningen kræver ADMIN_VAERT)", async () => {
    saetSession("aal1");
    m.rolle = "medarbejder";
    expect((await kald(HOVED, "/admin")).status).toBe(200);
    expect(hovedAdminBeslutning("/admin", "GET", "nej")).toBeNull();
  });

  it("en sælger sendes til /admin/erhverv på samme host som før", async () => {
    saetSession("aal1");
    m.rolle = "saelger";
    const r = await kald(HOVED, "/admin/sager");
    expect(r.til).toBe("http://localhost:3000/admin/erhverv");
  });
});

describe("adminGateBeslutning (ren funktion)", () => {
  it("HEAD behandles som GET", () => {
    expect(adminGateBeslutning({ pathname: "/admin", soeg: "", metode: "HEAD", session: "ingen", rolle: null }).type).toBe("omdiriger");
  });
});
