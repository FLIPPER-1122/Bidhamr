// Admin -> Fakturaer -> "Test Dinero-forbindelse"
// (src/lib/faktura/forbindelsesTest.ts). Falsk Dinero (fetch) - intet
// netværk, ingen database. Svaret må aldrig indeholde nøgler, secret eller
// token - heller ikke dele af dem.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT_ID = "cid-Q7wX9zK2mP4r";
const SECRET = "sec-H3nB8vL1tY6uJ0aZ";
const API_KEY = "key-R5dF2gS9kE7cW4xN";
const TOKEN = "tok-M8pV3qT6yU1iO9lK";

type Org = { Id: number; Name: string; VatNumber: string | null };
let organisationer: Org[] = [];
let loginSvar: { status: number; krop: unknown } = { status: 200, krop: { access_token: TOKEN, expires_in: 3600 } };
const kald: string[] = [];

beforeEach(() => {
  vi.resetModules();
  kald.length = 0;
  organisationer = [{ Id: 659420, Name: "BidHamr Test", VatNumber: null }];
  loginSvar = { status: 200, krop: { access_token: TOKEN, expires_in: 3600 } };
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://pjiigmzqwlfepxnjdvug.supabase.co");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_abcdef");
  vi.stubEnv("DINERO_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("DINERO_CLIENT_SECRET", SECRET);
  vi.stubEnv("DINERO_API_KEY", API_KEY);
  vi.stubEnv("DINERO_ORG_ID", "659420");
  vi.stubEnv("DINERO_MILJOE", "");
  vi.stubEnv("DINERO_LIVE_ORG_ID", "");
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    kald.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("oauth/token")) return new Response(JSON.stringify(loginSvar.krop), { status: loginSvar.status });
    if (url.endsWith("/v1.1/organizations")) return new Response(JSON.stringify(organisationer), { status: 200 });
    return new Response("{}", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function koer() {
  const { koerDineroForbindelsesTest } = await import("@/lib/faktura/forbindelsesTest");
  return koerDineroForbindelsesTest();
}

// Ingen hemmelighed - og intet stykke på 5 tegn eller mere af en - i svaret.
function udenHemmeligheder(r: unknown) {
  const ud = JSON.stringify(r);
  for (const h of [CLIENT_ID, SECRET, API_KEY, TOKEN, "sk_test_abcdef"]) {
    for (let i = 0; i + 5 <= h.length; i++) expect(ud).not.toContain(h.slice(i, i + 5));
  }
  expect(ud).not.toContain(Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64").slice(0, 12));
}

describe("Test Dinero-forbindelse", () => {
  it("login 401: afvist med dansk forklaring, regnskaberne hentes ikke", async () => {
    loginSvar = { status: 401, krop: { error: "invalid_client", error_description: `bad ${SECRET}` } };
    const r = await koer();
    expect(r.ok).toBe(false);
    expect(r.login).toEqual({ ok: false, status: 401, tekst: expect.stringContaining("afvist (401)") });
    expect(r.login && !r.login.ok && r.login.tekst).toContain("Client ID eller Client Secret passer ikke");
    expect(r.regnskaber).toBeNull();
    expect(kald.some((k) => k.includes("organizations"))).toBe(false);
    udenHemmeligheder(r);
  });
  it("login 400 uden kode: generel forklaring", async () => {
    loginSvar = { status: 400, krop: { error: "Noget <script>" } };
    const r = await koer();
    expect(r.login).toMatchObject({ ok: false, status: 400 });
    expect(r.login && !r.login.ok && r.login.tekst).toBe("afvist (400) - Client ID/Secret eller API-nøgle passer ikke.");
    udenHemmeligheder(r);
  });
  it("DINERO_ORG_ID mangler blandt nøglens regnskaber", async () => {
    organisationer = [
      { Id: 111, Name: "Bidhamr ApS", VatNumber: "46836219" },
      { Id: 222, Name: "Andet", VatNumber: null },
    ];
    const r = await koer();
    expect(r.login).toEqual({ ok: true });
    expect(r.regnskaber).toEqual([
      { id: "111", navn: "Bidhamr ApS" },
      { id: "222", navn: "Andet" },
    ]);
    expect(r.orgFundet).toBe(false);
    expect(r.vaern?.ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.overskrift).toContain("er ikke blandt nøglens regnskaber");
    udenHemmeligheder(r);
  });
  it("regnskabet findes og består værnet", async () => {
    organisationer = [
      { Id: 1, Name: "Bidhamr ApS", VatNumber: "46836219" },
      { Id: 659420, Name: "BidHamr Test", VatNumber: null },
    ];
    const r = await koer();
    expect(r.ok).toBe(true);
    expect(r.orgFundet).toBe(true);
    expect(r.vaern).toEqual({ ok: true, tekst: null });
    expect(r.miljoe).toBe("test");
    expect(r.stripe).toBe("test");
    expect(r.database).toBe("test");
    expect(r.overskrift).toContain("Forbindelsen virker");
    // Kun læsning hos Dinero: login + ét GET.
    expect(kald).toEqual(["POST https://authz.dinero.dk/dineroapi/oauth/token", "GET https://api.dinero.dk/v1.1/organizations"]);
    udenHemmeligheder(r);
  });
  it("værnet afviser: regnskabet hedder ikke BidHamr Test", async () => {
    organisationer = [{ Id: 659420, Name: "Bidhamr ApS", VatNumber: null }];
    const r = await koer();
    expect(r.orgFundet).toBe(true);
    expect(r.vaern?.ok).toBe(false);
    expect(r.vaern?.tekst).toContain('hedder ikke "BidHamr Test"');
    expect(r.ok).toBe(false);
    udenHemmeligheder(r);
  });
  it("værnet afviser: testregnskabet har BidHamrs CVR", async () => {
    organisationer = [{ Id: 659420, Name: "BidHamr Test", VatNumber: "46836219" }];
    const r = await koer();
    expect(r.vaern?.ok).toBe(false);
    expect(r.vaern?.tekst).toContain("har BidHamrs CVR");
  });
  it("variabler mangler: intet kald til Dinero, kun udfyldt ja/nej", async () => {
    vi.stubEnv("DINERO_CLIENT_SECRET", "");
    const r = await koer();
    expect(kald).toEqual([]);
    expect(r.login).toBeNull();
    expect(r.konfigOk).toBe(false);
    expect(r.variabler.find((v) => v.navn === "DINERO_CLIENT_SECRET")).toEqual({
      navn: "DINERO_CLIENT_SECRET",
      udfyldt: false,
      laengde: 0,
      advarsel: null,
    });
    expect(r.variabler.find((v) => v.navn === "DINERO_API_KEY")).toMatchObject({ udfyldt: true, laengde: API_KEY.length });
    udenHemmeligheder(r);
  });
  it("anførselstegn i en værdi giver en advarsel uden at vise værdien", async () => {
    vi.stubEnv("DINERO_API_KEY", `"${API_KEY}"`);
    const r = await koer();
    expect(r.variabler.find((v) => v.navn === "DINERO_API_KEY")?.advarsel).toContain("anførselstegn");
    udenHemmeligheder(r);
  });
  it("API'et afviser opslaget (401 to gange): login virker, regnskaberne ikke", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("oauth/token")) return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ message: `nope ${API_KEY}` }), { status: 401 });
    });
    const r = await koer();
    expect(r.login).toEqual({ ok: true });
    expect(r.regnskaber).toBeNull();
    expect(r.regnskaberFejl).toContain("(401)");
    udenHemmeligheder(r);
  });
});
