// Skift af e-mail (src/lib/emailSkift.ts) og appens endpoints
// (POST /api/konto/email og /api/konto/email/bekraeft). Databasen, Supabase
// Auth, Resend og Stripe er mocket - her testes rækkefølgen af tjek, at
// svaret ikke afslører, om adressen findes, og at intet ændres før koden.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const BRUGER = "33333333-3333-4333-8333-333333333333";
const TOKEN = "aaa.bbb.ccc";

const m = vi.hoisted(() => ({
  graense: "ok" as "ok" | "for_mange" | "fejl",
  rpc: vi.fn(),
  updateUserById: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  bekraeftAdgangskode: vi.fn(),
  send: vi.fn(),
  drift: vi.fn(async () => null),
  profil: { stripe_customer_id: "cus_1", stripe_account_id: "acct_1", connect_frakoblet_kl: null } as Record<string, unknown> | null,
  kundeUpdate: vi.fn(async () => ({})),
  kontoUpdate: vi.fn(async () => ({})),
  appBruger: true,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => true,
  tjekGraenserLukket: async () => m.graense,
  graenseFejl: (s: string) => (s === "for_mange" ? "For mange forsøg." : s === "fejl" ? "Prøv igen om lidt." : null),
  nulstilGraense: vi.fn(async () => {}),
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: m.drift }));
vi.mock("@/lib/bekraeftAdgangskode", () => ({ bekraeftAdgangskode: m.bekraeftAdgangskode }));
vi.mock("@/lib/mails/send", () => ({ sendHandelMailDetaljer: m.send }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ customers: { update: m.kundeUpdate }, accounts: { update: m.kontoUpdate } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: m.rpc,
    auth: { admin: { updateUserById: m.updateUserById, signOut: m.signOut } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.profil, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/appApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/appApi")>()),
  appBruger: async (token: string) =>
    token === TOKEN && m.appBruger ? { bruger: { id: BRUGER, email: "ida@test.bidhamr.dk" }, supabase: {} } : null,
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://eksempel.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test";
process.env.STRIPE_SECRET_KEY ??= "sk_test_x";

const lib = await import("@/lib/emailSkift");
const anmodRute = await import("@/app/api/konto/email/route");
const bekraeftRute = await import("@/app/api/konto/email/bekraeft/route");

const bruger = { id: BRUGER, email: "ida@test.bidhamr.dk" };

// rpc-svar pr. funktionsnavn.
function rpcSvar(svar: Record<string, unknown>) {
  m.rpc.mockImplementation(async (navn: string) => ({ data: svar[navn] ?? null, error: null }));
}

function req(sti: string, krop: unknown, token: string | null = TOKEN, origin?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return new NextRequest(`http://localhost${sti}`, { method: "POST", body: JSON.stringify(krop), headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.graense = "ok";
  m.appBruger = true;
  m.profil = { stripe_customer_id: "cus_1", stripe_account_id: "acct_1", connect_frakoblet_kl: null };
  m.bekraeftAdgangskode.mockResolvedValue("ok");
  m.send.mockResolvedValue({ ok: true });
  m.updateUserById.mockResolvedValue({ error: null });
});

describe("kode og hash", () => {
  it("6 cifre, hash bundet til brugeren, mellemrum fjernes", () => {
    const k = lib.nyEmailKode();
    expect(k).toMatch(/^\d{6}$/);
    expect(lib.hashEmailKode(BRUGER, "123456")).toMatch(/^[0-9a-f]{64}$/);
    expect(lib.hashEmailKode(BRUGER, "123456")).not.toBe(lib.hashEmailKode("44444444-4444-4444-8444-444444444444", "123456"));
    expect(lib.renEmailKode(" 123 456 ")).toBe("123456");
    expect(lib.renEmailKode("12345")).toBeNull();
    expect(lib.renEmailKode("abcdef")).toBeNull();
  });
});

describe("anmodEmailSkiftFor", () => {
  it("ugyldig eller samme adresse afvises, før adgangskoden tjekkes", async () => {
    expect(await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ikke-en-mail", adgangskode: "x" })).toMatchObject({ kode: "email" });
    expect(await lib.anmodEmailSkiftFor({ bruger, nyEmail: "x@slettet.invalid", adgangskode: "x" })).toMatchObject({ kode: "email" });
    expect(await lib.anmodEmailSkiftFor({ bruger, nyEmail: " IDA@test.bidhamr.dk ", adgangskode: "x" })).toMatchObject({ kode: "samme_email" });
    expect(m.bekraeftAdgangskode).not.toHaveBeenCalled();
  });

  it("staff, suspenderede, lukkede og slettede konti stoppes før adgangskoden", async () => {
    for (const k of ["staff", "suspenderet", "lukket", "slettet"]) {
      rpcSvar({ email_skift_konto_spaerret: k });
      const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "x" });
      expect(r).toMatchObject({ kode: k });
    }
    expect(m.bekraeftAdgangskode).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("forkert adgangskode: ingen anmodning og ingen mail", async () => {
    rpcSvar({ email_skift_konto_spaerret: null });
    m.bekraeftAdgangskode.mockResolvedValue("forkert");
    const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "forkert" });
    expect(r).toMatchObject({ kode: "forkert_adgangskode" });
    expect(m.rpc).not.toHaveBeenCalledWith("email_skift_anmod", expect.anything());
    expect(m.send).not.toHaveBeenCalled();
  });

  it("grænser fail closed", async () => {
    m.graense = "fejl";
    expect(await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "x" })).toMatchObject({ kode: "ikke_tilgaengelig" });
    m.graense = "for_mange";
    expect(await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "x" })).toMatchObject({ kode: "for_mange" });
    expect(m.bekraeftAdgangskode).not.toHaveBeenCalled();
  });

  it("ledig adresse: koden sendes til den NYE adresse, kun hashen går til databasen", async () => {
    rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "ok", optaget: false } });
    const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "Ny@Test.bidhamr.dk", adgangskode: "rigtig" });
    expect(r).toEqual({ ok: true, besked: lib.EMAIL_SKIFT.kodeSendt });
    const kald = m.rpc.mock.calls.find((c) => c[0] === "email_skift_anmod")!;
    expect(kald[1]).toMatchObject({ p_bruger: BRUGER, p_ny: "ny@test.bidhamr.dk" });
    expect(kald[1].p_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toBe("ny@test.bidhamr.dk");
    const kode = /(\d{6}) er din kode/.exec(m.send.mock.calls[0][1].subject)![1];
    expect(lib.hashEmailKode(BRUGER, kode)).toBe(kald[1].p_hash);
    expect(m.updateUserById).not.toHaveBeenCalled();
  });

  it("adressen er i brug: samme svar, men ingen mail", async () => {
    rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "ok", optaget: true } });
    const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "optaget@test.bidhamr.dk", adgangskode: "rigtig" });
    expect(r).toEqual({ ok: true, besked: lib.EMAIL_SKIFT.kodeSendt });
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("bekraeftEmailSkiftFor", () => {
  const logUdAndre = vi.fn(async () => null);

  it("forkert format og forkert kode ændrer intet", async () => {
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "12", logUdAndre })).toMatchObject({ kode: "kode_forkert" });
    rpcSvar({ email_skift_tjek: { kode: "forkert" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", logUdAndre })).toMatchObject({ kode: "kode_forkert" });
    rpcSvar({ email_skift_tjek: { kode: "for_mange" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", logUdAndre })).toMatchObject({ kode: "kode_udloebet" });
    rpcSvar({ email_skift_tjek: { kode: "optaget" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", logUdAndre })).toMatchObject({ kode: "optaget" });
    rpcSvar({ email_skift_tjek: { kode: "staff" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", logUdAndre })).toMatchObject({ kode: "staff" });
    expect(m.updateUserById).not.toHaveBeenCalled();
    expect(logUdAndre).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("rigtig kode: auth skiftes, andre logges ud, gammel adresse får mail, Stripe opdateres", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123 456", logUdAndre });
    expect(r).toEqual({ ok: true, email: "ny@test.bidhamr.dk" });
    expect(m.rpc).toHaveBeenCalledWith("email_skift_tjek", { p_bruger: BRUGER, p_hash: lib.hashEmailKode(BRUGER, "123456") });
    expect(m.updateUserById).toHaveBeenCalledWith(BRUGER, { email: "ny@test.bidhamr.dk", email_confirm: true });
    expect(logUdAndre).toHaveBeenCalledTimes(1);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toBe("ida@test.bidhamr.dk");
    expect(m.send.mock.calls[0][1].subject).toBe("Din e-mail er ændret");
    expect(m.send.mock.calls[0][1].html).toContain("ny@test.bidhamr.dk");
    expect(m.send.mock.calls[0][1].html).toContain("support@bidhamr.dk");
    expect(m.kundeUpdate).toHaveBeenCalledWith("cus_1", { email: "ny@test.bidhamr.dk" });
    expect(m.kontoUpdate).toHaveBeenCalledWith("acct_1", { email: "ny@test.bidhamr.dk" });
  });

  it("adressen blev taget i mellemtiden: optaget, intet andet sker", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    m.updateUserById.mockResolvedValue({ error: { code: "email_exists", status: 422, message: "exists" } });
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", logUdAndre });
    expect(r).toMatchObject({ kode: "optaget" });
    expect(m.rpc).toHaveBeenCalledWith("email_skift_afslut", { p_id: "s1", p_status: "optaget" });
    expect(logUdAndre).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("en Stripe-fejl stopper ikke skiftet (logges)", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    m.kontoUpdate.mockRejectedValueOnce(new Error("stripe nej"));
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", logUdAndre });
    expect(r).toMatchObject({ ok: true });
    expect(m.drift).toHaveBeenCalledWith(expect.objectContaining({ hvor: "emailSkift/stripe-connect" }));
  });
});

describe("appens endpoints", () => {
  it("POST /api/konto/email: 401 uden token, 400 ugyldig krop, 403 fremmed Origin", async () => {
    expect((await anmodRute.POST(req("/api/konto/email", { ny_email: "a@b.dk", adgangskode: "x" }, null))).status).toBe(401);
    expect((await anmodRute.POST(req("/api/konto/email", { ny_email: "a@b.dk" }))).status).toBe(400);
    expect((await anmodRute.POST(req("/api/konto/email", { ny_email: "a@b.dk", adgangskode: "x" }, TOKEN, "https://ond.example"))).status).toBe(403);
    m.appBruger = false;
    expect((await anmodRute.POST(req("/api/konto/email", { ny_email: "a@b.dk", adgangskode: "x" }))).status).toBe(401);
  });

  it("POST /api/konto/email: forkert adgangskode 403, ok 200 med besked", async () => {
    rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "ok", optaget: true } });
    m.bekraeftAdgangskode.mockResolvedValueOnce("forkert");
    const r1 = await anmodRute.POST(req("/api/konto/email", { ny_email: "ny@test.bidhamr.dk", adgangskode: "x" }));
    expect(r1.status).toBe(403);
    expect((await r1.json()).kode).toBe("forkert_adgangskode");
    const r2 = await anmodRute.POST(req("/api/konto/email", { ny_email: "ny@test.bidhamr.dk", adgangskode: "rigtig" }));
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, besked: lib.EMAIL_SKIFT.kodeSendt });
  });

  it("POST /api/konto/email/bekraeft: logger andre enheder ud med appens eget token", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    const r = await bekraeftRute.POST(req("/api/konto/email/bekraeft", { kode: "123456" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, email: "ny@test.bidhamr.dk" });
    expect(m.signOut).toHaveBeenCalledWith(TOKEN, "others");
    rpcSvar({ email_skift_tjek: { kode: "forkert" } });
    const r2 = await bekraeftRute.POST(req("/api/konto/email/bekraeft", { kode: "000000" }));
    expect(r2.status).toBe(400);
    expect((await r2.json()).kode).toBe("kode_forkert");
  });
});
