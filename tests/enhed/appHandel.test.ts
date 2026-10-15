// POST /api/handel/app/<handling> - appens handelstrin. Ruten testes med
// falske afhængigheder: login (appBruger), opslaget af handlen (service
// role) og de fælles funktioner, som hjemmesidens server actions også bruger.
// Tjekker adgang (401, 403 "ikke part", 404), kroppen (400) og at
// kontrakterne fra appen holdes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { falskKlient, type Forespoergsel } from "./hjaelpere/falskSupabase";

const SAELGER = "11111111-1111-4111-8111-111111111111";
const KOEBER = "22222222-2222-4222-8222-222222222222";
const FREMMED = "33333333-3333-4333-8333-333333333333";
const HANDEL = "44444444-4444-4444-8444-444444444444";
const AUKTION = "55555555-5555-4555-8555-555555555555";
const TILBUD = "66666666-6666-4666-8666-666666666666";
const TOKEN = "aaa.bbb.ccc";

const m = vi.hoisted(() => ({
  bruger: null as null | string,
  graense: true,
  handel: null as null | Record<string, unknown>,
  sendPakkeFor: vi.fn(),
  markerModtagetFor: vi.fn(),
  godkendPakkeFor: vi.fn(),
  bekraeftAfhentningFor: vi.fn(),
  hentHandelAppStatus: vi.fn(),
  hentAndenchanceStatusFor: vi.fn(),
  sendAndenchanceTilbudFor: vi.fn(),
  svarAndenchanceFor: vi.fn(),
  genopsaetAuktionFor: vi.fn(),
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
      if (q.tabel === "trades") return { data: m.handel, error: null };
      return undefined;
    }).klient,
}));
vi.mock("@/lib/appApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/appApi")>()),
  appBruger: async (token: string) =>
    token === TOKEN && m.bruger ? { bruger: { id: m.bruger, email: "x@test.bidhamr.dk" }, supabase: { som: m.bruger } } : null,
}));
vi.mock("@/lib/handel/handelstrin", () => ({
  sendPakkeFor: m.sendPakkeFor,
  markerModtagetFor: m.markerModtagetFor,
  godkendPakkeFor: m.godkendPakkeFor,
  bekraeftAfhentningFor: m.bekraeftAfhentningFor,
}));
vi.mock("@/lib/handel/handelStatus", () => ({ hentHandelAppStatus: m.hentHandelAppStatus }));
vi.mock("@/lib/andenchance", () => ({
  hentAndenchanceStatusFor: m.hentAndenchanceStatusFor,
  sendAndenchanceTilbudFor: m.sendAndenchanceTilbudFor,
  svarAndenchanceFor: m.svarAndenchanceFor,
  genopsaetAuktionFor: m.genopsaetAuktionFor,
}));

const { POST } = await import("@/app/api/handel/app/[handling]/route");

async function kald(handling: string, krop: unknown, o: { token?: string | null; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  const token = o.token === undefined ? TOKEN : o.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (o.origin) headers.origin = o.origin;
  const req = new NextRequest(`http://localhost/api/handel/app/${handling}`, {
    method: "POST",
    body: typeof krop === "string" ? krop : JSON.stringify(krop),
    headers,
  });
  const res = await POST(req, { params: Promise.resolve({ handling }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.bruger = KOEBER;
  m.graense = true;
  m.log = [];
  m.handel = { id: HANDEL, auction_id: AUKTION, seller_id: SAELGER, buyer_id: KOEBER, status: "pakke_sendt", afhentning: false };
});

const HANDELSHANDLINGER = [
  "status",
  "send-pakke",
  "modtaget",
  "godkend",
  "afhentning-bekraeft",
  "andenchance-status",
  "andenchance-tilbud",
  "genopsaet",
];

describe("adgang", () => {
  it("ukendt handling: 404", async () => {
    const r = await kald("slet-alt", { trade_id: HANDEL });
    expect(r.status).toBe(404);
    expect(r.body.kode).toBe("ugyldig");
  });

  it("uden token eller med et ugyldigt token: 401 JSON (ikke proxyens tekst)", async () => {
    for (const h of [...HANDELSHANDLINGER, "andenchance-svar"]) {
      const a = await kald(h, { trade_id: HANDEL }, { token: null });
      expect(a.status).toBe(401);
      expect(a.body).toEqual({ fejl: "Du er ikke logget ind længere. Log ind igen.", kode: "ikke_logget_ind" });
    }
    m.bruger = null;
    const b = await kald("status", { trade_id: HANDEL });
    expect(b.status).toBe(401);
    expect(b.body.kode).toBe("ikke_logget_ind");
  });

  it("ikke part i handlen: 403 for alle handlinger - og intet kaldes", async () => {
    m.bruger = FREMMED;
    for (const h of HANDELSHANDLINGER) {
      const r = await kald(h, { trade_id: HANDEL, tracking: "x", billeder: [], stjerner: 5, kode: "123456", startpris: 100, varighed_dage: 7 });
      expect(r.status, h).toBe(403);
      expect(r.body.kode, h).toBe("ikke_part");
    }
    for (const f of [m.sendPakkeFor, m.markerModtagetFor, m.godkendPakkeFor, m.bekraeftAfhentningFor, m.hentHandelAppStatus,
      m.hentAndenchanceStatusFor, m.sendAndenchanceTilbudFor, m.genopsaetAuktionFor]) {
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("handlen findes ikke: 404; ugyldigt trade_id: 400", async () => {
    m.handel = null;
    const r = await kald("status", { trade_id: HANDEL });
    expect(r.status).toBe(404);
    expect(r.body.kode).toBe("ikke_fundet");
    const u = await kald("status", { trade_id: "ikke-en-uuid" });
    expect(u.status).toBe(400);
  });

  it("fremmed Origin: 403; rate limit: 429; ikke JSON: 400", async () => {
    expect((await kald("status", { trade_id: HANDEL }, { origin: "https://ond.example" })).status).toBe(403);
    m.graense = false;
    const g = await kald("modtaget", { trade_id: HANDEL });
    expect(g.status).toBe(429);
    expect(g.body.kode).toBe("for_mange");
    m.graense = true;
    expect((await kald("status", "ikke json")).status).toBe(400);
  });

  it("kroppen er for stor: 413", async () => {
    const r = await kald("status", { trade_id: HANDEL, fyld: "x".repeat(5000) });
    expect(r.status).toBe(413);
  });
});

describe("status", () => {
  it("svarer med kontrakten og kalder den fælles funktion som brugeren", async () => {
    m.hentHandelAppStatus.mockResolvedValue({
      annullering: { aarsag: "afsendelsesfrist", refunderet: true },
      betaling: null,
      fragt: { labelsAktiv: true, returlabelAktiv: false },
    });
    const r = await kald("status", { trade_id: HANDEL });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      annullering: { aarsag: "afsendelsesfrist", refunderet: true },
      betaling: null,
      fragt: { labelsAktiv: true, returlabelAktiv: false },
    });
    expect(m.hentHandelAppStatus).toHaveBeenCalledWith({ som: KOEBER }, KOEBER, expect.objectContaining({ id: HANDEL }));
  });

  it("sælgeren må også", async () => {
    m.bruger = SAELGER;
    m.hentHandelAppStatus.mockResolvedValue({ annullering: null, betaling: null, fragt: { labelsAktiv: false, returlabelAktiv: false } });
    expect((await kald("status", { trade_id: HANDEL })).status).toBe(200);
  });
});

describe("send-pakke", () => {
  const billeder = [
    { sti: `${SAELGER}/${HANDEL}/a.jpg`, kategori: "aaben_kasse" },
    { sti: `${SAELGER}/${HANDEL}/b.jpg`, kategori: "lukket_kasse" },
  ];

  it("{} giver 400", async () => {
    m.bruger = SAELGER;
    expect((await kald("send-pakke", {})).status).toBe(400);
    expect((await kald("send-pakke", { trade_id: HANDEL })).status).toBe(400);
  });

  it("kalder sendPakkeFor (samme som hjemmesiden) og svarer { ok }", async () => {
    m.bruger = SAELGER;
    m.sendPakkeFor.mockResolvedValue({ ok: true });
    const r = await kald("send-pakke", { trade_id: HANDEL, tracking: "123-456-789", billeder });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(m.sendPakkeFor).toHaveBeenCalledWith({ som: SAELGER }, SAELGER, HANDEL, "123-456-789", billeder);
  });

  it("fejlkoden fra trade_marker_sendt sendes videre", async () => {
    m.bruger = SAELGER;
    m.sendPakkeFor.mockResolvedValue({ fejl: "Et billede blev ikke uploadet korrekt. Prøv igen.", kode: "billede_mangler" });
    const r = await kald("send-pakke", { trade_id: HANDEL, tracking: "1", billeder });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ fejl: "Et billede blev ikke uploadet korrekt. Prøv igen.", kode: "billede_mangler" });
    m.sendPakkeFor.mockResolvedValue({ fejl: "Kun sælgeren kan markere pakken som sendt.", kode: "ikke_saelger" });
    expect((await kald("send-pakke", { trade_id: HANDEL, tracking: "1", billeder })).status).toBe(403);
  });
});

describe("modtaget og godkend", () => {
  it("modtaget: { ok }", async () => {
    m.markerModtagetFor.mockResolvedValue({ ok: true });
    expect(await kald("modtaget", { trade_id: HANDEL })).toEqual({ status: 200, body: { ok: true } });
    expect(m.markerModtagetFor).toHaveBeenCalledWith({ som: KOEBER }, KOEBER, HANDEL);
  });

  it("godkend: stjerner og kommentar sendes videre; ugyldig kommentar giver 400", async () => {
    m.godkendPakkeFor.mockResolvedValue({ ok: true });
    expect((await kald("godkend", { trade_id: HANDEL, stjerner: 4, kommentar: "Fin" })).status).toBe(200);
    expect(m.godkendPakkeFor).toHaveBeenCalledWith({ som: KOEBER }, KOEBER, HANDEL, 4, "Fin");
    await kald("godkend", { trade_id: HANDEL, stjerner: 5 });
    expect(m.godkendPakkeFor).toHaveBeenLastCalledWith({ som: KOEBER }, KOEBER, HANDEL, 5, null);
    expect((await kald("godkend", { trade_id: HANDEL, stjerner: 5, kommentar: 7 })).status).toBe(400);
  });

  it("godkend: indsigelse og forkerte stjerner", async () => {
    m.godkendPakkeFor.mockResolvedValue({ fejl: "Giv sælgeren 1-5 stjerner, før du godkender varen.", kode: "ugyldige_stjerner" });
    expect((await kald("godkend", { trade_id: HANDEL, stjerner: 9 })).status).toBe(400);
    m.godkendPakkeFor.mockResolvedValue({ fejl: "Handlen kan ikke godkendes ...", kode: "indsigelse" });
    const r = await kald("godkend", { trade_id: HANDEL, stjerner: 5 });
    expect(r.status).toBe(409);
    expect(r.body.kode).toBe("indsigelse");
  });
});

describe("afhentning-bekraeft", () => {
  it("kun sælgeren; samme fejltekster som hjemmesiden", async () => {
    const k = await kald("afhentning-bekraeft", { trade_id: HANDEL, kode: "123456" });
    expect(k.status).toBe(403);
    expect(k.body.kode).toBe("ikke_saelger");
    m.bruger = SAELGER;
    m.bekraeftAfhentningFor.mockResolvedValue({ fejl: "Koden er forkert. Du har 1 forsøg tilbage i denne time.", kode: "forkert" });
    const f = await kald("afhentning-bekraeft", { trade_id: HANDEL, kode: "123456" });
    expect(f.status).toBe(409);
    expect(f.body.fejl).toBe("Koden er forkert. Du har 1 forsøg tilbage i denne time.");
    m.bekraeftAfhentningFor.mockResolvedValue({ ok: true });
    expect((await kald("afhentning-bekraeft", { trade_id: HANDEL, kode: "123 456" })).body).toEqual({ ok: true });
    expect(m.bekraeftAfhentningFor).toHaveBeenLastCalledWith({ som: SAELGER }, SAELGER, HANDEL, "123 456");
    expect((await kald("afhentning-bekraeft", { trade_id: HANDEL })).status).toBe(400);
  });
});

describe("andenchance", () => {
  it("status: samme objekt som hentAndenchanceStatus, uden ok fra funktionen", async () => {
    m.bruger = SAELGER;
    const status = {
      ok: true,
      ubetalt: true,
      aarsag: "ubetalt",
      nyHandelId: null,
      genopsatAuktionId: null,
      aktivtTilbud: null,
      tilbud: [],
      harFlereBydere: true,
      naesteBudOere: 12_000,
      kanTilbyde: true,
      kanGenopsaette: true,
    };
    m.hentAndenchanceStatusFor.mockResolvedValue(status);
    const r = await kald("andenchance-status", { trade_id: HANDEL });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(status);
    // Køberen: 403.
    m.bruger = KOEBER;
    expect((await kald("andenchance-status", { trade_id: HANDEL })).status).toBe(403);
  });

  it("tilbud: { tilbudId, budOere, udloeber }; vilkårsfejl giver kode 'vilkaar'", async () => {
    m.bruger = SAELGER;
    m.sendAndenchanceTilbudFor.mockResolvedValue({ ok: true, tilbudId: TILBUD, budOere: 9_000, udloeber: "2026-10-17T10:00:00Z" });
    const r = await kald("andenchance-tilbud", { trade_id: HANDEL });
    expect(r.body).toEqual({ ok: true, tilbudId: TILBUD, budOere: 9_000, udloeber: "2026-10-17T10:00:00Z" });
    m.sendAndenchanceTilbudFor.mockResolvedValue({ fejl: "Du skal acceptere brugerbetingelserne.", kode: "vilkaar" });
    const v = await kald("andenchance-tilbud", { trade_id: HANDEL });
    expect(v.body.kode).toBe("vilkaar");
    expect(v.status).toBe(403);
  });

  it("svar: { trade_id }; {} giver 400; ingen handel slås op", async () => {
    expect((await kald("andenchance-svar", {})).status).toBe(400);
    expect((await kald("andenchance-svar", { tilbud_id: TILBUD, ja: "ja" })).status).toBe(400);
    m.svarAndenchanceFor.mockResolvedValue({ ok: true, tradeId: HANDEL });
    expect((await kald("andenchance-svar", { tilbud_id: TILBUD, ja: true })).body).toEqual({ ok: true, trade_id: HANDEL });
    expect(m.svarAndenchanceFor).toHaveBeenCalledWith(KOEBER, TILBUD, true);
    m.svarAndenchanceFor.mockResolvedValue({ ok: true, tradeId: null });
    expect((await kald("andenchance-svar", { tilbud_id: TILBUD, ja: false })).body).toEqual({ ok: true, trade_id: null });
    m.svarAndenchanceFor.mockResolvedValue({ fejl: "Tilbuddet findes ikke.", kode: "ikke_byder" });
    expect((await kald("andenchance-svar", { tilbud_id: TILBUD, ja: true })).status).toBe(404);
    expect(m.log.filter((q) => q.tabel === "trades")).toHaveLength(0);
  });

  it("genopsaet: serveren finder auktionen ud fra handlen; kun sælgeren", async () => {
    expect((await kald("genopsaet", { trade_id: HANDEL, startpris: 100, varighed_dage: 7 })).status).toBe(403);
    m.bruger = SAELGER;
    m.genopsaetAuktionFor.mockResolvedValue({ ok: true, auktionId: "77777777-7777-4777-8777-777777777777" });
    const r = await kald("genopsaet", { trade_id: HANDEL, startpris: 100, varighed_dage: 7, auktion_id: "fremmed" });
    expect(r.body).toEqual({ ok: true, auktion_id: "77777777-7777-4777-8777-777777777777" });
    expect(m.genopsaetAuktionFor).toHaveBeenCalledWith(SAELGER, AUKTION, 100, 7);
    expect((await kald("genopsaet", { trade_id: HANDEL })).status).toBe(400);
  });
});

describe("uventede fejl", () => {
  it("500 med en generisk dansk tekst", async () => {
    m.markerModtagetFor.mockRejectedValue(new Error("boom"));
    const r = await kald("modtaget", { trade_id: HANDEL });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" });
  });
});
