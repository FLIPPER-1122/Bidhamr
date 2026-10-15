// Shipmondo i serveren: webhook-ruten (signatur, transportør-værn, ukendte
// koder) og annullering (bekræftet / ikke bekræftet / ikke mulig). Databasen
// er en falsk Supabase-klient; Shipmondo er en falsk fetch.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Svar = { data: unknown; error: { message: string; code?: string } | null; status?: number };
const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];
let rpcSvar: Record<string, (args: Record<string, unknown>) => Svar> = {};
// Rækker pr. tabel til maybeSingle/single (filtreres ikke - én række pr. test).
let raekker: Record<string, unknown> = {};

function kaede(tabel: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "not", "or", "limit", "gte", "lt", "update", "neq"]) {
    q[m] = () => q;
  }
  q.maybeSingle = async () => ({ data: raekker[tabel] ?? null, error: null });
  q.single = async () => ({ data: raekker[tabel] ?? null, error: null });
  q.then = (ok: (v: Svar) => unknown, fejl?: (e: unknown) => unknown) =>
    Promise.resolve({ data: raekker[tabel] ? [raekker[tabel]] : [], error: null }).then(ok, fejl);
  return q;
}

const falskAdmin = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcLog.push({ fn, args });
    return rpcSvar[fn]?.(args) ?? { data: null, error: null };
  },
  from: (tabel: string) => kaede(tabel),
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => falskAdmin }));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async () => "ny"),
  renFejltekst: (e: unknown) => String(e instanceof Error ? e.message : e),
}));
vi.mock("@/lib/notifikationer/send", () => ({ send: vi.fn(async () => undefined) }));
vi.mock("@/lib/betaling/stripeBetaling", () => ({ annullerPaymentIntentForLevering: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/fragt/webhook/[firma]/route";
import { annullerUdgaaendeForsendelse } from "@/lib/fragt/server";
import { signerJwtHs256 } from "@/lib/fragt/shipmondo";
import { logDriftFejl } from "@/lib/drift";

const MAPPE = path.resolve(import.meta.dirname, "../../src/lib/fragt/__fixtures__/shipmondo");
const fx = (navn: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(MAPPE, navn), "utf8"));
const WEBHOOK = "webhook-noegle-mindst-16-tegn";

let fetchSvar: Response[] = [];

beforeEach(() => {
  process.env.SHIPMONDO_API_URL = "https://sandbox.shipmondo.com/api/public/v3";
  process.env.SHIPMONDO_API_BRUGER = "bruger";
  process.env.SHIPMONDO_API_NOEGLE = "noegle";
  process.env.SHIPMONDO_WEBHOOK_NOEGLE = WEBHOOK;
  rpcLog.length = 0;
  raekker = {};
  rpcSvar = {
    forsendelse_registrer_haendelse: () => ({ data: { ny: true }, error: null }),
    fragt_ukendt_kode_registrer: () => ({ data: true, error: null }),
    forsendelse_annuller_claim: () => ({ data: "ok", error: null }),
    forsendelse_annuller_afslut: () => ({ data: "annulleret", error: null }),
    forsendelse_annullering_bekraeftet: () => ({ data: true, error: null }),
  };
  vi.mocked(logDriftFejl).mockClear();
  fetchSvar = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const s = fetchSvar.shift();
      if (!s) throw new Error("Testen mangler et svar");
      return s;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fns = () => rpcLog.map((r) => r.fn);

function webhook(payload: unknown, noegle = WEBHOOK) {
  return new NextRequest("https://bidhamr.dk/api/fragt/webhook/shipmondo", {
    method: "POST",
    headers: { "content-type": "application/json", "smd-resource-type": "Shipment Monitor" },
    body: JSON.stringify({ data: signerJwtHs256(payload, noegle) }),
  });
}
const params = { params: Promise.resolve({ firma: "shipmondo" }) };

// En udgående pakke til en pakkeshop i Aarhus (køberen bor i Aarhus).
const UD = {
  id: "F1",
  trade_id: "T1",
  type: "udgaaende",
  levering: "pakkeshop",
  modtager: { navn: "Køber", by: "Aarhus C", postnummer: "8000" },
};

describe("webhook-ruten /api/fragt/webhook/shipmondo", () => {
  it("forkert signatur: 401, intet gemt", async () => {
    const r = await POST(webhook(fx("monitor_gls_leveret.json"), "forkert-noegle-0123456789"), params);
    expect(r.status).toBe(401);
    expect(fns()).toEqual([]);
  });

  it("leveret med samme transportør som forsendelsen: gemmes", async () => {
    raekker.forsendelser = { ...UD, transportoer: "gls" };
    const r = await POST(webhook(fx("monitor_gls_leveret.json")), params);
    expect(r.status).toBe(200);
    const reg = rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse");
    expect(reg).toHaveLength(1);
    expect(reg[0].args).toMatchObject({ p_forsendelse: "F1", p_type: "leveret", p_kilde: "webhook" });
  });

  it("leveret fra en ANDEN transportør end forsendelsens: gemmes ikke (leveret_kl styrer pengene)", async () => {
    raekker.forsendelser = { ...UD, transportoer: "postnord" };
    const r = await POST(webhook(fx("monitor_gls_leveret.json")), params);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ gemt: 0, forkertTransportoer: 1 });
    expect(fns()).not.toContain("forsendelse_registrer_haendelse");
    expect(vi.mocked(logDriftFejl).mock.calls.map((c) => (c[0] as { hvor?: string }).hvor)).toContain("Fragt: forkert transportør");
  });

  it("leveret i en anden by end pakkeshoppen: markering til staff, ALDRIG leveret", async () => {
    raekker.forsendelser = { ...UD, transportoer: "gls" };
    raekker.handel_levering = { pakkeshop_by: "Aarhus C", pakkeshop_postnummer: "8000" };
    const p = fx("monitor_gls_leveret.json") as { data: Record<string, unknown> };
    const r = await POST(webhook({ ...p, data: { ...p.data, city: "Odense SØ" } }), params);
    expect(r.status).toBe(200);
    const reg = rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse");
    expect(reg.map((x) => x.args.p_type)).toEqual(["fejl"]);
  });

  it("returpakke: returteksten bruges ikke - leveret hos sælgeren gemmes som leveret", async () => {
    raekker.forsendelser = {
      ...UD,
      type: "retur",
      levering: "retur",
      modtager: { navn: "Sælger", by: "Odense C", postnummer: "5000" },
      transportoer: "postnord",
    };
    await POST(webhook(fx("monitor_postnord_leveret_retur.json")), params);
    const reg = rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse");
    expect(reg.map((x) => x.args.p_type)).toEqual(["leveret"]);
  });

  it("udgående: leveret med returtekst gemmes som returneret", async () => {
    raekker.forsendelser = { ...UD, transportoer: "postnord" };
    await POST(webhook(fx("monitor_postnord_leveret_retur.json")), params);
    const reg = rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse");
    expect(reg.map((x) => x.args.p_type)).toEqual(["returneret"]);
  });

  it("ukendt status: registreres som ukendt kode og ændrer intet", async () => {
    raekker.forsendelser = { ...UD, transportoer: "dao" };
    const r = await POST(webhook(fx("monitor_ukendt_status.json")), params);
    expect(r.status).toBe(200);
    expect(fns()).toEqual(["fragt_ukendt_kode_registrer"]);
    expect(rpcLog[0].args).toMatchObject({ p_fragtfirma: "shipmondo", p_kode: "LOST_IN_SPACE", p_liste: "dao" });
  });

  it("ukendt forsendelse: 200 uden at gemme", async () => {
    const r = await POST(webhook(fx("monitor_dao_klar.json")), params);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ gemt: 0, ukendte: 1 });
  });
});

describe("annullering via Shipmondo", () => {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  it("GLS/PostNord uden bekræftelse fra transportøren: annulleret, men tæller stadig i labelgrænsen", async () => {
    raekker.forsendelser = { type: "udgaaende", fragtfirma: "shipmondo", forsendelses_id: "69835919" };
    fetchSvar = [json(fx("annuller_ok_ikke_hos_transportoer.json"))];
    expect(await annullerUdgaaendeForsendelse("F1", "S1")).toEqual({ ok: true });
    expect(fns()).toContain("forsendelse_annuller_afslut");
    expect(fns()).not.toContain("forsendelse_annullering_bekraeftet");
    expect(fns()).not.toContain("returfragt_annullering_bekraeftet");
  });

  it("bekræftet hos transportøren: markeres bekræftet (tæller ikke i labelgrænsen)", async () => {
    raekker.forsendelser = { type: "udgaaende", fragtfirma: "shipmondo", forsendelses_id: "69835921" };
    fetchSvar = [json(fx("annuller_ok_bekraeftet.json"))];
    expect(await annullerUdgaaendeForsendelse("F1", "S1")).toEqual({ ok: true });
    expect(fns()).toContain("forsendelse_annullering_bekraeftet");
  });

  it("DAO via Shipmondo (422): annulleret i BidHamr, staff markeres, aldrig bekræftet", async () => {
    raekker.forsendelser = { type: "udgaaende", fragtfirma: "shipmondo", forsendelses_id: "69835917" };
    fetchSvar = [json(fx("annuller_dao_422.json"), 422)];
    expect(await annullerUdgaaendeForsendelse("F1", "S1")).toEqual({ ok: true });
    expect(fns()).toContain("forsendelse_marker_opmaerksomhed");
    expect(fns()).not.toContain("forsendelse_annullering_bekraeftet");
  });
});
