// POST /api/bud/app - appens bud. Samme kode som hjemmesidens afgivBud og
// saetMaksimum (src/lib/bud/afgivBud.ts); her testes kontrakten, øre ->
// kroner, BH-koderne og idempotens-nøglen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { falskKlient, filter, type Forespoergsel } from "./hjaelpere/falskSupabase";

const BYDER = "22222222-2222-4222-8222-222222222222";
const AUKTION = "55555555-5555-4555-8555-555555555555";
const NOEGLE = "88888888-8888-4888-8888-888888888888";
const TOKEN = "aaa.bbb.ccc";

const m = vi.hoisted(() => ({
  bruger: "22222222-2222-4222-8222-222222222222" as string | null,
  graense: true,
  afgivBudFor: vi.fn(),
  saetMaksimumFor: vi.fn(),
  noegler: new Map<string, { auktion_id: string; type?: string; beloeb_oere?: number; svar: unknown }>(),
  slutterKl: "2026-10-20T10:00:00.000Z",
  log: [] as Forespoergsel[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIp: async () => "127.0.0.9",
  tjekGraenser: async () => m.graense,
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    falskKlient((q) => {
      m.log.push(q);
      if (q.tabel === "auctions") return { data: { slutter_kl: m.slutterKl }, error: null };
      if (q.tabel !== "app_bud_noegler") return undefined;
      const noegle = String(filter(q, "eq", "noegle") ?? (q.vaerdi as { noegle?: string } | undefined)?.noegle);
      if (q.handling === "insert") {
        const v = q.vaerdi as { noegle: string; auktion_id: string; type: string; beloeb_oere: number };
        if (m.noegler.has(v.noegle)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        m.noegler.set(v.noegle, { auktion_id: v.auktion_id, type: v.type, beloeb_oere: v.beloeb_oere, svar: null });
        return { data: null, error: null };
      }
      if (q.handling === "update") {
        const r = m.noegler.get(noegle);
        if (r) r.svar = (q.vaerdi as { svar: unknown }).svar;
        return { data: null, error: null };
      }
      if (q.handling === "delete") {
        if (filter(q, "is", "svar") === null && noegle !== "undefined") m.noegler.delete(noegle);
        return { data: null, error: null };
      }
      return { data: m.noegler.get(noegle) ?? null, error: null };
    }).klient,
}));
vi.mock("@/lib/appApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/appApi")>()),
  appBruger: async (token: string) =>
    token === TOKEN && m.bruger ? { bruger: { id: m.bruger }, supabase: { som: m.bruger } } : null,
}));
vi.mock("@/lib/bud/afgivBud", () => ({ afgivBudFor: m.afgivBudFor, saetMaksimumFor: m.saetMaksimumFor }));

const { POST } = await import("@/app/api/bud/app/route");

async function kald(krop: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await POST(new NextRequest("http://localhost/api/bud/app", { method: "POST", body: JSON.stringify(krop), headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.bruger = BYDER;
  m.graense = true;
  m.noegler.clear();
  m.log = [];
});

const bud = (o: Record<string, unknown> = {}) => ({ auktion_id: AUKTION, beloeb_oere: 15_000, idempotens_noegle: NOEGLE, ...o });

describe("POST /api/bud/app", () => {
  it("uden login: 401", async () => {
    expect((await kald(bud(), null)).status).toBe(401);
    m.bruger = null;
    expect((await kald(bud())).body.kode).toBe("ikke_logget_ind");
  });

  it("kroppen: præcis ét beløb, hele kroner, uuid'er", async () => {
    expect((await kald({ auktion_id: AUKTION, idempotens_noegle: NOEGLE })).status).toBe(400);
    expect((await kald(bud({ maksimum_oere: 20_000 }))).status).toBe(400);
    expect((await kald(bud({ beloeb_oere: 15_050 }))).body).toEqual({ fejl: "Buddet skal være i hele kroner.", kode: "ugyldig" });
    expect((await kald(bud({ beloeb_oere: -100 }))).status).toBe(400);
    expect((await kald(bud({ idempotens_noegle: "abc" }))).status).toBe(400);
    expect((await kald(bud({ auktion_id: "abc" }))).status).toBe(400);
    expect((await kald(bud({ beskyttelse: "ja" }))).status).toBe(400);
    expect(m.afgivBudFor).not.toHaveBeenCalled();
  });

  it("bud: øre -> kroner til den fælles funktion; svar { foerer, hoejeste_oere, forlaenget }", async () => {
    m.afgivBudFor.mockResolvedValue({ ok: true, foerer: true, nuvaerendeBud: 150, slutterKl: "2026-10-20T10:02:00.000Z" });
    const r = await kald(bud({ beskyttelse: true }));
    expect(r).toEqual({ status: 200, body: { ok: true, foerer: true, hoejeste_oere: 15_000, forlaenget: true } });
    expect(m.afgivBudFor).toHaveBeenCalledWith({ som: BYDER }, BYDER, "127.0.0.9", AUKTION, 150, true, undefined);
  });

  it("maksimum: saetMaksimumFor; ikke forlænget", async () => {
    m.saetMaksimumFor.mockResolvedValue({ ok: true, foerer: false, nuvaerendeBud: 300, maks: 250, slutterKl: m.slutterKl, budAfgivet: true });
    const r = await kald({ auktion_id: AUKTION, maksimum_oere: 25_000, idempotens_noegle: NOEGLE, auktion_redigeret_kl: "2026-10-15T08:00:00Z" });
    expect(r.body).toEqual({ ok: true, foerer: false, hoejeste_oere: 30_000, forlaenget: false });
    expect(m.saetMaksimumFor).toHaveBeenCalledWith({ som: BYDER }, BYDER, "127.0.0.9", AUKTION, 250, undefined, "2026-10-15T08:00:00Z");
  });

  it("databasens BH-kode gives videre (frosset sælger BHU03); nøglen frigives", async () => {
    m.afgivBudFor.mockResolvedValue({ fejl: "Der kan ikke bydes lige nu. ...", kode: "BHU03" });
    const r = await kald(bud());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ fejl: "Der kan ikke bydes lige nu. ...", kode: "BHU03" });
    expect(m.noegler.has(NOEGLE)).toBe(false);
    m.afgivBudFor.mockResolvedValue({ fejl: "For mange forsøg.", kode: "for_mange" });
    expect((await kald(bud())).status).toBe(429);
  });

  it("idempotens: samme nøgle giver samme svar - buddet afgives kun én gang", async () => {
    m.afgivBudFor.mockResolvedValue({ ok: true, foerer: true, nuvaerendeBud: 150, slutterKl: m.slutterKl });
    const a = await kald(bud());
    const b = await kald(bud());
    expect(b).toEqual(a);
    expect(m.afgivBudFor).toHaveBeenCalledTimes(1);
    // Samme nøgle til en anden auktion: afvist.
    const c = await kald(bud({ auktion_id: "99999999-9999-4999-8999-999999999999" }));
    expect(c.status).toBe(409);
    expect(c.body.kode).toBe("noegle_brugt");
    // Samme nøgle med et andet beløb eller som maksimum: afvist.
    const d = await kald(bud({ beloeb_oere: 16_000 }));
    expect(d.body.kode).toBe("noegle_brugt");
    const e = await kald({ auktion_id: AUKTION, maksimum_oere: 15_000, idempotens_noegle: NOEGLE });
    expect(e.body.kode).toBe("noegle_brugt");
    expect(m.afgivBudFor).toHaveBeenCalledTimes(1);
    expect(m.saetMaksimumFor).not.toHaveBeenCalled();
    expect(m.noegler.get(NOEGLE)).toMatchObject({ auktion_id: AUKTION, type: "bud", beloeb_oere: 15_000 });
  });

  it("mens det første kald stadig kører: 409 behandles", async () => {
    m.noegler.set(NOEGLE, { auktion_id: AUKTION, type: "bud", beloeb_oere: 15_000, svar: null });
    const r = await kald(bud());
    expect(r.status).toBe(409);
    expect(r.body.kode).toBe("behandles");
    expect(m.afgivBudFor).not.toHaveBeenCalled();
  });
});
