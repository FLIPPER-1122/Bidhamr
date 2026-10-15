// Appens konto-endpoints: POST /api/konto/adgangskode, /api/konto/glemt og
// /api/konto/data. Samme kode som hjemmesiden (src/lib/adgangskodeSkift.ts,
// src/lib/mineDataFil.ts) - her testes kontrakten og adgangen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const BRUGER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "aaa.bbb.ccc";

const m = vi.hoisted(() => ({
  bruger: "22222222-2222-4222-8222-222222222222" as string | null,
  graense: true,
  skiftAdgangskodeFor: vi.fn(),
  sendNulstillingsmail: vi.fn(),
  lavMineDataFil: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => m.graense,
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ auth: { admin: { signOut: m.signOut } } }) }));
vi.mock("@/lib/appApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/appApi")>()),
  appBruger: async (token: string) =>
    token === TOKEN && m.bruger ? { bruger: { id: m.bruger, email: "ida@test.bidhamr.dk" }, supabase: { som: m.bruger } } : null,
}));
vi.mock("@/lib/adgangskodeSkift", () => ({
  skiftAdgangskodeFor: m.skiftAdgangskodeFor,
  sendNulstillingsmail: m.sendNulstillingsmail,
}));
vi.mock("@/lib/mineDataFil", () => ({ lavMineDataFil: m.lavMineDataFil }));

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://eksempel.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "sb_publishable_test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test";

const adgangskode = await import("@/app/api/konto/adgangskode/route");
const glemt = await import("@/app/api/konto/glemt/route");
const data = await import("@/app/api/konto/data/route");

function req(sti: string, krop: unknown, token: string | null = TOKEN, origin?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return new NextRequest(`http://localhost${sti}`, { method: "POST", body: krop === undefined ? undefined : JSON.stringify(krop), headers });
}
async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.bruger = BRUGER;
  m.graense = true;
});

describe("POST /api/konto/adgangskode", () => {
  it("uden login: 401; ugyldig krop: 400; fremmed Origin: 403", async () => {
    expect((await json(await adgangskode.POST(req("/api/konto/adgangskode", { nuvaerende: "a", ny: "b" }, null)))).status).toBe(401);
    m.bruger = null;
    expect((await json(await adgangskode.POST(req("/api/konto/adgangskode", { nuvaerende: "a", ny: "b" })))).body.kode).toBe("ikke_logget_ind");
    m.bruger = BRUGER;
    expect((await json(await adgangskode.POST(req("/api/konto/adgangskode", { ny: "b" })))).status).toBe(400);
    expect((await json(await adgangskode.POST(req("/api/konto/adgangskode", { nuvaerende: "a", ny: "b" }, TOKEN, "https://ond.example")))).status).toBe(403);
    expect(m.skiftAdgangskodeFor).not.toHaveBeenCalled();
  });

  it("skifter med brugerens eget token og logger andre enheder ud (others)", async () => {
    m.skiftAdgangskodeFor.mockImplementation(async (a: { saetAdgangskode: (n: string) => Promise<unknown>; logUdAndre: () => Promise<unknown> }) => {
      await a.saetAdgangskode("NyLangAdgangskode42");
      await a.logUdAndre();
      return { ok: true };
    });
    const hent = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const r = await json(await adgangskode.POST(req("/api/konto/adgangskode", { nuvaerende: "Gammel", ny: "NyLangAdgangskode42" })));
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(m.skiftAdgangskodeFor).toHaveBeenCalledWith(expect.objectContaining({ bruger: expect.objectContaining({ id: BRUGER }), nuvaerende: "Gammel", ny: "NyLangAdgangskode42" }));
    const [url, init] = hent.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/v1\/user$/);
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ password: "NyLangAdgangskode42" });
    expect(m.signOut).toHaveBeenCalledWith(TOKEN, "others");
    hent.mockRestore();
  });

  it("Supabase' fejlkoder oversættes som på hjemmesiden", async () => {
    let fejl: unknown;
    m.skiftAdgangskodeFor.mockImplementation(async (a: { saetAdgangskode: (n: string) => Promise<unknown> }) => {
      fejl = await a.saetAdgangskode("x");
      return { fejl: "Din nuværende adgangskode er forkert.", kode: "forkert_adgangskode" };
    });
    const hent = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 422, error_code: "same_password", msg: "same" }), { status: 422 }),
    );
    const r = await json(await adgangskode.POST(req("/api/konto/adgangskode", { nuvaerende: "a", ny: "b" })));
    expect(fejl).toEqual({ code: "same_password", status: 422, message: "same" });
    expect(r.status).toBe(403);
    expect(r.body.kode).toBe("forkert_adgangskode");
    hent.mockRestore();
    m.skiftAdgangskodeFor.mockResolvedValue({ fejl: "For svag.", kode: "adgangskode" });
    expect((await json(await adgangskode.POST(req("/api/konto/adgangskode", { nuvaerende: "a", ny: "b" })))).status).toBe(400);
  });
});

describe("POST /api/konto/glemt", () => {
  it("samme svar, uanset om e-mailen findes; ingen login nødvendig", async () => {
    m.sendNulstillingsmail.mockResolvedValue({ ok: true });
    const r = await json(await glemt.POST(req("/api/konto/glemt", { email: "ida@test.bidhamr.dk" }, null)));
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(m.sendNulstillingsmail).toHaveBeenCalledWith(expect.anything(), "ida@test.bidhamr.dk", "127.0.0.9");
  });

  it("ugyldig e-mail: 400; for mange: 429; grænserne kan ikke tjekkes: 503", async () => {
    m.sendNulstillingsmail.mockResolvedValue({ fejl: "Indtast en gyldig e-mail.", kode: "email" });
    expect((await json(await glemt.POST(req("/api/konto/glemt", { email: "x" }, null)))).status).toBe(400);
    m.sendNulstillingsmail.mockResolvedValue({ fejl: "For mange forsøg.", kode: "for_mange" });
    expect((await json(await glemt.POST(req("/api/konto/glemt", { email: "ida@test.bidhamr.dk" }, null)))).status).toBe(429);
    m.sendNulstillingsmail.mockResolvedValue({ fejl: "Noget gik galt.", kode: "ikke_tilgaengelig" });
    expect((await json(await glemt.POST(req("/api/konto/glemt", { email: "ida@test.bidhamr.dk" }, null)))).status).toBe(503);
  });

  it("en uventet fejl afslører intet: 200 { ok }", async () => {
    m.sendNulstillingsmail.mockRejectedValue(new Error("boom"));
    expect(await json(await glemt.POST(req("/api/konto/glemt", { email: "ida@test.bidhamr.dk" }, null)))).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("POST /api/konto/data", () => {
  it("PDF med brugerens egen klient; JSON uden format", async () => {
    m.lavMineDataFil.mockResolvedValue({ ok: true, indhold: new Uint8Array([37, 80, 68, 70]), type: "application/pdf", filnavn: "bidhamr-dine-data-2026-10-15.pdf" });
    const res = await data.POST(req("/api/konto/data?format=pdf", undefined));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("bidhamr-dine-data-2026-10-15.pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(m.lavMineDataFil).toHaveBeenCalledWith({ som: BRUGER }, BRUGER, true, "/api/konto/data");
    m.lavMineDataFil.mockResolvedValue({ ok: true, indhold: "{}", type: "application/json; charset=utf-8", filnavn: "x.json" });
    await data.POST(req("/api/konto/data", undefined));
    expect(m.lavMineDataFil).toHaveBeenLastCalledWith({ som: BRUGER }, BRUGER, false, "/api/konto/data");
  });

  it("én gang i timen: 429 vent; uden login: 401", async () => {
    m.lavMineDataFil.mockResolvedValue({ fejl: "vent" });
    const r = await json(await data.POST(req("/api/konto/data?format=pdf", undefined)));
    expect(r.status).toBe(429);
    expect(r.body.kode).toBe("vent");
    expect((await json(await data.POST(req("/api/konto/data?format=pdf", undefined, null)))).status).toBe(401);
  });
});
