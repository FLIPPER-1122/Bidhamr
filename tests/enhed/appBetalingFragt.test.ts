// Ændringerne i de eksisterende app-endpoints:
//   - /api/betaling/app/betal: levering.transportoer sendes videre, og
//     sælgerens visningsnavn ("Sælger: X") er med i svaret.
//   - /api/fragt/app/returfragt: customerId (og publishableKey) som betal.
// Og at proxyen lukker de nye app-stier igennem (de svarer selv med JSON).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { falskKlient } from "./hjaelpere/falskSupabase";

const KOEBER = "22222222-2222-4222-8222-222222222222";
const SAELGER = "11111111-1111-4111-8111-111111111111";
const HANDEL = "44444444-4444-4444-8444-444444444444";
const TOKEN = "aaa.bbb.ccc";

const m = vi.hoisted(() => ({
  gemLevering: vi.fn(),
  startBetalingFor: vi.fn(),
  startReturfragt: vi.fn(),
  bookPakke: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => true,
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: KOEBER } }, error: null } : { data: { user: null }, error: { message: "x" } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    falskKlient((q) => {
      if (q.tabel === "trades") return { data: { seller_id: SAELGER }, error: null };
      if (q.tabel === "users") return { data: { navn: "Ida H." }, error: null };
      return undefined;
    }).klient,
}));
vi.mock("@/lib/betaling/kort", () => ({ fjernGemtKortForBruger: vi.fn() }));
vi.mock("@/lib/betaling/boost", () => ({ brugBoost: vi.fn(), startBoostKoeb: vi.fn() }));
vi.mock("@/lib/betaling/betalingHandlinger", () => ({
  GENERISK: "Noget gik galt. Prøv igen om lidt.",
  startBetalingFor: m.startBetalingFor,
  bekraeftGemtKortFor: vi.fn(),
  hentBetalingsindstillingerFor: vi.fn(),
  opdaterSaelgerStatusFor: vi.fn(),
  startGemKortFor: vi.fn(),
  startOnboardingFor: vi.fn(),
  stripeOversigtFor: vi.fn(),
}));
vi.mock("@/lib/fragt/handlinger", () => ({
  gemLevering: m.gemLevering,
  startReturfragt: m.startReturfragt,
  annullerPakke: vi.fn(),
  bookPakke: m.bookPakke,
  hentCheckout: vi.fn(),
  hentForsendelser: vi.fn(),
  hentLabelLink: vi.fn(),
  lavReturlabel: vi.fn(),
  soegPakkeshops: vi.fn(),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://eksempel.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "sb_publishable_test";
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_abc123";

const betaling = await import("@/app/api/betaling/app/[handling]/route");
const fragt = await import("@/app/api/fragt/app/[handling]/route");

function req(sti: string, krop: unknown) {
  return new NextRequest(`http://localhost${sti}`, {
    method: "POST",
    body: JSON.stringify(krop),
    headers: { "content-type": "application/json", host: "localhost", authorization: `Bearer ${TOKEN}` },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("/api/betaling/app/betal", () => {
  it("levering.transportoer sendes videre til gemLevering; saelgerNavn i svaret", async () => {
    m.gemLevering.mockResolvedValue({ ok: true, maade: "pakkeshop" });
    m.startBetalingFor.mockResolvedValue({ clientSecret: "pi_1_secret_2", totalOere: 35_500, customerId: "cus_1", customerSessionClientSecret: null });
    const res = await betaling.POST(
      req("/api/betaling/app/betal", { trade_id: HANDEL, levering: { maade: "pakkeshop", pakkeshop_id: "123", transportoer: "gls", modtager: { navn: "Ida", telefon: "12345678" } } }),
      { params: Promise.resolve({ handling: "betal" }) },
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(m.gemLevering).toHaveBeenCalledWith(HANDEL, KOEBER, expect.objectContaining({ transportoer: "gls", maade: "pakkeshop" }));
    expect(body.saelgerNavn).toBe("Ida H.");
    expect(body.publishableKey).toBe("pk_test_abc123");
  });

  it("uden transportoer: feltet sendes ikke (DAO som standard)", async () => {
    m.gemLevering.mockResolvedValue({ ok: true });
    m.startBetalingFor.mockResolvedValue({ clientSecret: "pi_1_secret_2", totalOere: 1, customerId: null, customerSessionClientSecret: null });
    await betaling.POST(req("/api/betaling/app/betal", { trade_id: HANDEL, levering: { maade: "doer" } }), { params: Promise.resolve({ handling: "betal" }) });
    expect(m.gemLevering.mock.calls[0][2]).not.toHaveProperty("transportoer");
  });
});

// DAO (Filip, 20. okt. 2026): sælgeren accepterer DAO's handelsbetingelser
// før første DAO-label. Appen får kode "dao_betingelser" og sender accepten med.
describe("/api/fragt/app/book og DAO's handelsbetingelser", () => {
  it("uden accept: 409 kode dao_betingelser med link, version og tekst", async () => {
    m.bookPakke.mockResolvedValue({ fejl: "Sæt flueben ved DAO's handelsbetingelser, før du laver fragtlabelen.", kode: "dao_betingelser" });
    const r = await fragt.POST(req("/api/fragt/app/book", { trade_id: HANDEL }), { params: Promise.resolve({ handling: "book" }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      fejl: "Sæt flueben ved DAO's handelsbetingelser, før du laver fragtlabelen.",
      kode: "dao_betingelser",
      betingelser: {
        url: "https://dao.as/handelsbetingelser/",
        version: "2025-10-01",
        tekst: "Jeg accepterer DAO's handelsbetingelser for forsendelsen",
      },
    });
    expect(m.bookPakke).toHaveBeenCalledWith(HANDEL, KOEBER, null, false);
  });

  it("accepter_dao_betingelser: true sendes videre (kun præcis true)", async () => {
    m.bookPakke.mockResolvedValue({ ok: true, forsendelseId: "F1" });
    const r = await fragt.POST(req("/api/fragt/app/book", { trade_id: HANDEL, accepter_dao_betingelser: true }), {
      params: Promise.resolve({ handling: "book" }),
    });
    expect(r.status).toBe(200);
    expect(m.bookPakke).toHaveBeenCalledWith(HANDEL, KOEBER, null, true);
    await fragt.POST(req("/api/fragt/app/book", { trade_id: HANDEL, accepter_dao_betingelser: "true" }), {
      params: Promise.resolve({ handling: "book" }),
    });
    expect(m.bookPakke).toHaveBeenLastCalledWith(HANDEL, KOEBER, null, false);
  });

  it("andre fejl er stadig 409 afvist", async () => {
    m.bookPakke.mockResolvedValue({ fejl: "Handlen findes ikke." });
    const r = await fragt.POST(req("/api/fragt/app/book", { trade_id: HANDEL }), { params: Promise.resolve({ handling: "book" }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ fejl: "Handlen findes ikke.", kode: "afvist" });
  });
});

describe("/api/fragt/app/returfragt", () => {
  it("customerId, customerSessionClientSecret og publishableKey som betal", async () => {
    m.startReturfragt.mockResolvedValue({ ok: true, clientSecret: "pi_r_secret_x", beloebOere: 4_000, customerId: "cus_9", customerSessionClientSecret: "cuss_1" });
    const res = await fragt.POST(
      req("/api/fragt/app/returfragt", { trade_id: HANDEL, afsender: { navn: "Ida", adresse: "Vej 1", postnummer: "8000", by: "Aarhus", telefon: "12345678" } }),
      { params: Promise.resolve({ handling: "returfragt" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      clientSecret: "pi_r_secret_x",
      beloebOere: 4_000,
      customerId: "cus_9",
      customerSessionClientSecret: "cuss_1",
      publishableKey: "pk_test_abc123",
    });
  });
});

describe("proxyen", () => {
  it("de nye app-stier slippes igennem uden cookie-login (ruterne svarer selv med JSON)", async () => {
    vi.resetModules();
    vi.doMock("@supabase/ssr", () => ({
      createServerClient: () => ({ auth: { getClaims: async () => ({ data: null, error: null }) }, rpc: vi.fn(), from: vi.fn() }),
    }));
    const { updateSession } = await import("@/lib/supabase/middleware");
    for (const sti of [
      "/api/handel/app/status",
      "/api/bud/app",
      "/api/auktion/app/fjern-billeder",
      "/api/konto/adgangskode",
      "/api/konto/glemt",
      "/api/konto/data",
    ]) {
      const res = await updateSession(new NextRequest(`http://localhost${sti}`, { method: "POST", body: "{}" }));
      expect(res.status, sti).toBe(200);
      expect(res.headers.get("x-middleware-next"), sti).toBe("1");
    }
    // En lukket sti uden login giver stadig proxyens svar.
    const lukket = await updateSession(new NextRequest("http://localhost/api/noget-andet", { method: "POST", body: "{}" }));
    expect(lukket.headers.get("x-middleware-next")).toBeNull();
  });
});
