// Skift af e-mail (src/lib/emailSkift.ts) og appens endpoints
// (POST /api/konto/email og /api/konto/email/bekraeft). Databasen, Supabase
// Auth, Resend og Stripe er mocket - her testes rækkefølgen af tjek, at
// svaret ikke afslører, om adressen findes, og at intet ændres før koden.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const BRUGER = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
// Et access token med session_id (kun payloaden læses - appBruger er mocket).
const TOKEN = `aaa.${Buffer.from(JSON.stringify({ session_id: SESSION })).toString("base64url")}.ccc`;

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
  kontoRetrieve: vi.fn(async () => ({ type: "custom", controller: { requirement_collection: "application" } }) as Record<string, unknown>),
  appBruger: true,
  // after() fra next/server: callbacks samles og køres af koerEfter().
  efter: [] as (() => unknown)[],
  graenseKald: [] as string[][],
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    m.efter.push(fn);
  },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => true,
  tjekGraenserLukket: async (t: [string, string][]) => {
    m.graenseKald.push(t.map(([n]) => n));
    return m.graense;
  },
  graenseFejl: (s: string) => (s === "for_mange" ? "For mange forsøg." : s === "fejl" ? "Prøv igen om lidt." : null),
  nulstilGraense: vi.fn(async () => {}),
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: m.drift }));
vi.mock("@/lib/bekraeftAdgangskode", () => ({ bekraeftAdgangskode: m.bekraeftAdgangskode }));
vi.mock("@/lib/mails/send", () => ({ sendHandelMailDetaljer: m.send }));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ customers: { update: m.kundeUpdate }, accounts: { update: m.kontoUpdate, retrieve: m.kontoRetrieve } }),
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
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-test";

const lib = await import("@/lib/emailSkift");
const anmodRute = await import("@/app/api/konto/email/route");
const bekraeftRute = await import("@/app/api/konto/email/bekraeft/route");

const bruger = { id: BRUGER, email: "ida@test.bidhamr.dk" };

// rpc-svar pr. funktionsnavn.
function rpcSvar(svar: Record<string, unknown>, fejl: Record<string, { code: string; message: string }> = {}) {
  m.rpc.mockImplementation(async (navn: string) => ({ data: svar[navn] ?? null, error: fejl[navn] ?? null }));
}
// Databasen uden 20261102410000 (koden skal virke, før migrationen er kørt).
const UDEN_OUTBOX = { email_skift_behold_session: { code: "PGRST202", message: "Could not find the function" } };

function req(sti: string, krop: unknown, token: string | null = TOKEN, origin?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return new NextRequest(`http://localhost${sti}`, { method: "POST", body: JSON.stringify(krop), headers });
}

async function koerEfter() {
  const fns = m.efter.splice(0);
  for (const fn of fns) await fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.efter = [];
  m.graenseKald = [];
  lib.EMAIL_SKIFT_SVARTID.minMs = 0;
  m.kontoRetrieve.mockResolvedValue({ type: "custom", controller: { requirement_collection: "application" } });
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
    // HMAC med serverhemmeligheden - ikke en ren sha256, der kan knækkes uden nøglen.
    expect(lib.hashEmailKode(BRUGER, "123456")).not.toBe(
      createHash("sha256").update(`bidhamr-email-skift-v1|${BRUGER}|123456`).digest("hex"),
    );
    expect(lib.hashEmailKode(BRUGER, "123456")).toBe(
      createHmac("sha256", `bidhamr-email-skift-v2|${process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY}`)
        .update(`${BRUGER}|123456`)
        .digest("hex"),
    );
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

  it("staff, firma, suspenderede, lukkede og slettede konti stoppes før adgangskoden", async () => {
    for (const k of ["staff", "firma", "suspenderet", "lukket", "slettet"]) {
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
    // Grænsen pr. ny adresse tælles først efter en rigtig adgangskode.
    expect(m.graenseKald.flat()).not.toContain("email_skift_ny_email");
  });

  it("firmakonto: teksten om at kontakte BidHamr", async () => {
    rpcSvar({ email_skift_konto_spaerret: "firma" });
    const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "x" });
    expect(r).toEqual({ fejl: "Kontakt BidHamr for at skifte e-mail på en firmakonto.", kode: "firma" });
  });

  it("grænsen pr. ny adresse tælles efter adgangskoden", async () => {
    rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "ok", optaget: true } });
    await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "rigtig" });
    expect(m.graenseKald).toEqual([["adgangskode_bruger", "email_skift_bruger"], ["email_skift_ny_email"]]);
  });

  it("et netop bekræftet skift i gang: prøv igen om lidt", async () => {
    rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "igang" } });
    const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "rigtig" });
    expect(r).toEqual({ fejl: lib.EMAIL_SKIFT.igang, kode: "ikke_tilgaengelig" });
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
    // Mailen sendes i baggrunden (after), ikke før svaret.
    expect(m.send).not.toHaveBeenCalled();
    await koerEfter();
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
    await koerEfter();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("Resend fejler: samme svar, fejlen logges", async () => {
    rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "ok", optaget: false } });
    m.send.mockResolvedValue({ ok: false, fejl: "resend nede" });
    const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "rigtig" });
    expect(r).toEqual({ ok: true, besked: lib.EMAIL_SKIFT.kodeSendt });
    await koerEfter();
    expect(m.drift).toHaveBeenCalledWith(expect.objectContaining({ hvor: "emailSkift/kodemail", fejl: "resend nede" }));
    // Også når afsendelsen kaster.
    m.send.mockRejectedValueOnce(new Error("netværk"));
    await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "rigtig" });
    await koerEfter();
    expect(m.drift).toHaveBeenCalledTimes(2);
  });

  it("fast minimumsventetid: ledig og optaget adresse svarer tidligst efter minMs", async () => {
    lib.EMAIL_SKIFT_SVARTID.minMs = 150;
    for (const optaget of [false, true]) {
      rpcSvar({ email_skift_konto_spaerret: null, email_skift_anmod: { kode: "ok", optaget } });
      const t0 = Date.now();
      const r = await lib.anmodEmailSkiftFor({ bruger, nyEmail: "ny@test.bidhamr.dk", adgangskode: "rigtig" });
      expect(r).toEqual({ ok: true, besked: lib.EMAIL_SKIFT.kodeSendt });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    }
  });
});

describe("bekraeftEmailSkiftFor", () => {
  const logUdAndre = vi.fn(async () => null);

  it("forkert format og forkert kode ændrer intet", async () => {
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "12", sessionId: SESSION, logUdAndre })).toMatchObject({ kode: "kode_forkert" });
    rpcSvar({ email_skift_tjek: { kode: "forkert" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre })).toMatchObject({ kode: "kode_forkert" });
    rpcSvar({ email_skift_tjek: { kode: "for_mange" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre })).toMatchObject({ kode: "kode_udloebet" });
    rpcSvar({ email_skift_tjek: { kode: "optaget" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre })).toMatchObject({ kode: "optaget" });
    rpcSvar({ email_skift_tjek: { kode: "staff" } });
    expect(await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre })).toMatchObject({ kode: "staff" });
    expect(m.updateUserById).not.toHaveBeenCalled();
    expect(logUdAndre).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("uden 20261102410000: auth skiftes, andre logges ud, gammel adresse får mail, Stripe opdateres (som før)", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } }, UDEN_OUTBOX);
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123 456", sessionId: SESSION, logUdAndre });
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

  it("updateUserById kaster: anmodningen afsluttes som fejl (sidder ikke fast)", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    m.updateUserById.mockRejectedValueOnce(new Error("timeout"));
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre });
    expect(r).toEqual({ fejl: lib.EMAIL_SKIFT.generisk, kode: "fejl" });
    expect(m.rpc).toHaveBeenCalledWith("email_skift_afslut", { p_id: "s1", p_status: "fejl" });
    expect(m.drift).toHaveBeenCalledWith(expect.objectContaining({ hvor: "emailSkift/updateUserById" }));
    expect(logUdAndre).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("Express-konto: e-mailen sendes ikke til Connect (sælgerens eget Stripe-login)", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } }, UDEN_OUTBOX);
    m.kontoRetrieve.mockResolvedValue({ type: "express", controller: { requirement_collection: "stripe" } });
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre });
    expect(r).toMatchObject({ ok: true });
    expect(m.kundeUpdate).toHaveBeenCalledWith("cus_1", { email: "ny@test.bidhamr.dk" });
    expect(m.kontoUpdate).not.toHaveBeenCalled();
    expect(m.drift).not.toHaveBeenCalled();
  });

  it("adressen blev taget i mellemtiden: optaget, intet andet sker", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    m.updateUserById.mockResolvedValue({ error: { code: "email_exists", status: 422, message: "exists" } });
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre });
    expect(r).toMatchObject({ kode: "optaget" });
    expect(m.rpc).toHaveBeenCalledWith("email_skift_afslut", { p_id: "s1", p_status: "optaget" });
    expect(logUdAndre).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("en Stripe-fejl stopper ikke skiftet (logges)", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } }, UDEN_OUTBOX);
    m.kontoUpdate.mockRejectedValueOnce(new Error("stripe nej"));
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre });
    expect(r).toMatchObject({ ok: true });
    expect(m.drift).toHaveBeenCalledWith(expect.objectContaining({ hvor: "emailSkift/stripe-connect" }));
  });
});

describe("outbox (20261102410000)", () => {
  const logUdAndre = vi.fn(async () => null);
  const raekke = (ekstra: Record<string, unknown> = {}) => ({
    id: "o1",
    bruger_id: BRUGER,
    skiftet_kl: "2026-10-28T10:00:00.000Z",
    gammel_email: "ida@test.bidhamr.dk",
    ny_email: "ny@test.bidhamr.dk",
    log_ud: false,
    mail: false,
    stripe: false,
    forsoeg: 1,
    ...ekstra,
  });
  const kald = (navn: string) => m.rpc.mock.calls.filter((c) => c[0] === navn);

  it("rigtig kode: sessionen gemmes FØR auth, derefter log ud + mail + Stripe via outboxen", async () => {
    rpcSvar({
      email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" },
      email_skift_behold_session: true,
      email_skift_outbox_tag: [raekke()],
      email_skift_outbox_log_ud: { kode: "ok", sessioner: 2, tokens: 1 },
      email_skift_outbox_trin: true,
    });
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre });
    expect(r).toEqual({ ok: true, email: "ny@test.bidhamr.dk" });
    const navne = m.rpc.mock.calls.map((c) => c[0]);
    expect(navne.indexOf("email_skift_behold_session")).toBeLessThan(navne.indexOf("email_skift_outbox_tag"));
    expect(m.updateUserById.mock.invocationCallOrder[0]).toBeGreaterThan(
      m.rpc.mock.invocationCallOrder[navne.indexOf("email_skift_behold_session")],
    );
    expect(kald("email_skift_behold_session")[0][1]).toEqual({ p_id: "s1", p_bruger: BRUGER, p_session: SESSION });
    expect(kald("email_skift_outbox_tag")[0][1]).toEqual({ p_skift: "s1", p_graense: 20 });
    expect(kald("email_skift_outbox_log_ud")[0][1]).toEqual({ p_id: "o1" });
    expect(kald("email_skift_outbox_trin").map((c) => c[1].p_trin)).toEqual(["mail", "stripe"]);
    expect(logUdAndre).not.toHaveBeenCalled();
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toBe("ida@test.bidhamr.dk");
    expect(m.send.mock.calls[0][1].subject).toBe("Din e-mail er ændret");
    expect(m.kundeUpdate).toHaveBeenCalledWith("cus_1", { email: "ny@test.bidhamr.dk" });
  });

  it("ugyldig eller manglende session: null til databasen (alle sessioner fra før skiftet logges ud)", async () => {
    rpcSvar({
      email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" },
      email_skift_behold_session: true,
      email_skift_outbox_tag: [],
    });
    await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: "ikke-en-uuid", logUdAndre });
    expect(kald("email_skift_behold_session")[0][1]).toMatchObject({ p_session: null });
  });

  it("mailen fejler: skiftet lykkes, fejlen gemmes på rækken (cron prøver igen), Stripe venter", async () => {
    rpcSvar({
      email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" },
      email_skift_behold_session: true,
      email_skift_outbox_tag: [raekke()],
      email_skift_outbox_log_ud: { kode: "ok" },
      email_skift_outbox_trin: true,
    });
    m.send.mockResolvedValueOnce({ ok: false, fejl: "Resend nede for ida@test.bidhamr.dk" });
    const r = await lib.bekraeftEmailSkiftFor({ bruger, kode: "123456", sessionId: SESSION, logUdAndre });
    expect(r).toMatchObject({ ok: true });
    expect(kald("email_skift_outbox_trin")).toHaveLength(0);
    const fejl = kald("email_skift_outbox_fejl");
    expect(fejl).toHaveLength(1);
    // Ingen e-mailadresser i fejlteksten.
    expect(fejl[0][1].p_fejl).not.toContain("@");
    expect(m.drift).toHaveBeenCalledWith(expect.objectContaining({ hvor: "emailSkift/outbox" }));
  });

  it("cron: kun de trin, der mangler; slettet konto får ingen mail; opgivet efter 12 forsøg", async () => {
    rpcSvar({
      email_skift_outbox_tag: [
        raekke({ id: "o2", log_ud: true }),
        raekke({ id: "o3", log_ud: true, gammel_email: null, ny_email: null }),
      ],
      email_skift_outbox_trin: true,
    });
    expect(await lib.koerEmailSkiftOutbox()).toEqual({ behandlet: 2, fejl: 0 });
    expect(kald("email_skift_outbox_tag")[0][1]).toEqual({ p_skift: null, p_graense: 20 });
    expect(kald("email_skift_outbox_log_ud")).toHaveLength(0);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(kald("email_skift_outbox_trin")).toHaveLength(4);

    vi.clearAllMocks();
    rpcSvar(
      { email_skift_outbox_tag: [raekke({ id: "o4", forsoeg: 12 })] },
      { email_skift_outbox_log_ud: { code: "XX000", message: "nede" } },
    );
    expect(await lib.koerEmailSkiftOutbox()).toEqual({ behandlet: 0, fejl: 1 });
    expect(m.drift).toHaveBeenCalledWith(expect.objectContaining({ hvor: expect.stringContaining("opgivet efter 12") }));
  });

  it("uden migrationen: cron-trinnet gør intet (null)", async () => {
    rpcSvar({}, { email_skift_outbox_tag: { code: "PGRST202", message: "Could not find the function" } });
    expect(await lib.koerEmailSkiftOutbox()).toBeNull();
    expect(m.drift).not.toHaveBeenCalled();
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

  it("POST /api/konto/email/bekraeft: appens egen session beholdes (outbox), uden migrationen logges andre ud med tokenet", async () => {
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } });
    const r0 = await bekraeftRute.POST(req("/api/konto/email/bekraeft", { kode: "123456" }));
    expect(r0.status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("email_skift_behold_session", { p_id: "s1", p_bruger: BRUGER, p_session: SESSION });
    expect(m.signOut).not.toHaveBeenCalled();
    rpcSvar({ email_skift_tjek: { kode: "ok", id: "s1", ny_email: "ny@test.bidhamr.dk", gammel_email: "ida@test.bidhamr.dk" } }, UDEN_OUTBOX);
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
