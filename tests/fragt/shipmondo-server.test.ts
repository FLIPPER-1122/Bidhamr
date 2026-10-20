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
// Fejl pr. tabel på liste-forespørgsler (fx kolonnen findes ikke).
let tabelFejl: Record<string, { message: string; code?: string }> = {};

function kaede(tabel: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "not", "or", "limit", "gte", "lt", "update", "neq"]) {
    q[m] = () => q;
  }
  q.maybeSingle = async () => ({ data: raekker[tabel] ?? null, error: null });
  q.single = async () => ({ data: raekker[tabel] ?? null, error: null });
  q.then = (ok: (v: Svar) => unknown, fejl?: (e: unknown) => unknown) =>
    Promise.resolve(
      tabelFejl[tabel]
        ? { data: null, error: tabelFejl[tabel] }
        : { data: raekker[tabel] ? [raekker[tabel]] : [], error: null },
    ).then(ok, fejl);
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
import {
  _nulstilMigreretCache,
  annullerUdgaaendeForsendelse,
  gemLeveringsvalg,
  opretUdgaaendeForsendelse,
  soegPakkeshops,
} from "@/lib/fragt/server";
import { hentFragtfirma } from "@/lib/fragt";
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
  tabelFejl = {};
  _nulstilMigreretCache();
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

describe("Shipmondo før migrationen 20261024010000", () => {
  beforeEach(() => {
    process.env.FRAGTFIRMA = "shipmondo";
    tabelFejl.forsendelser = { message: 'column forsendelser.leveret_frigiver does not exist', code: "42703" };
  });
  afterEach(() => {
    delete process.env.FRAGTFIRMA;
  });

  it("fragt er 'ikke sat op': ingen pakkeshops og ingen label (ellers kunne leveret frigive penge)", async () => {
    expect(await soegPakkeshops({ postnummer: "8000" })).toEqual({ fejl: "Fragt er ikke sat op endnu." });
    raekker.handel_levering = { maade: "pakkeshop", fragtfirma: "shipmondo", pakkeshop_id: "1", modtager_navn: "K", modtager_telefon: "+4512345678" };
    const r = await opretUdgaaendeForsendelse("T1", "S1", { navn: "Sælger", adresse: "Vej 1", postnummer: "5000", by: "Odense C" });
    expect(r).toEqual({ fejl: "Fragt er ikke sat op endnu." });
    expect(fns()).not.toContain("forsendelse_claim");
  });

  it("efter migrationen: pakkeshop-søgningen kører", async () => {
    delete tabelFejl.forsendelser;
    fetchSvar = [new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })];
    expect(await soegPakkeshops({ postnummer: "8000" })).toMatchObject({ ok: true, fragtfirma: "shipmondo" });
  });
});

// Fragtfirmaer (Filip, 20. okt. 2026): DAO og GLS (GLS med printet label),
// ingen PostNord - kun med SHIPMONDO_POSTNORD_AKTIV=true (fail closed).
// Eksisterende PostNord-forsendelser (label, retur) virker videre.
describe("DAO og GLS, ingen PostNord (SHIPMONDO_TRANSPORTOERER / SHIPMONDO_POSTNORD_AKTIV)", () => {
  const POSTNORD_LUKKET = "PostNord kan ikke vælges lige nu. Vælg DAO eller GLS.";
  const ENV = ["SHIPMONDO_GLS_AKTIV", "SHIPMONDO_POSTNORD_AKTIV", "SHIPMONDO_TRANSPORTOERER"] as const;
  const doer = (transportoer?: string) => ({
    maade: "doer",
    transportoer,
    modtager: { navn: "Køber Købersen", adresse: "Vejen 1", postnummer: "8000", by: "Aarhus C", telefon: "12345678" },
  });
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const tomListe = () => json([]);

  beforeEach(() => {
    process.env.FRAGTFIRMA = "shipmondo";
    for (const k of ENV) delete process.env[k];
    rpcSvar.handel_gem_levering = () => ({
      data: { kode: "ok", fragt_oere: 6000, total_oere: 16000, beskyttelse_oere: 0, afhentning: false, pris_aendret: false },
      error: null,
    });
  });
  afterEach(() => {
    delete process.env.FRAGTFIRMA;
    for (const k of ENV) delete process.env[k];
  });

  it("standard: kun DAO og GLS kan vælges", () => {
    expect(hentFragtfirma().transportoerer).toEqual(["dao", "gls"]);
    for (const v of ["", "1", "TRUE", "ja", " true", "false"]) {
      process.env.SHIPMONDO_POSTNORD_AKTIV = v;
      expect(hentFragtfirma().transportoerer).toEqual(["dao", "gls"]);
    }
  });

  it("SHIPMONDO_GLS_AKTIV (gammelt flag) ændrer ikke standarden og slår ikke GLS fra", () => {
    for (const v of ["true", "false", ""]) {
      process.env.SHIPMONDO_GLS_AKTIV = v;
      expect(hentFragtfirma().transportoerer).toEqual(["dao", "gls"]);
    }
  });

  it("PostNord i checkout afvises med dansk fejl, og databasen kaldes ikke", async () => {
    expect(await gemLeveringsvalg("T1", "K1", doer("postnord"))).toEqual({ fejl: POSTNORD_LUKKET });
    expect(fns()).not.toContain("handel_gem_levering");
  });

  it("pakkeshop-søgning hos PostNord afvises", async () => {
    expect(await soegPakkeshops({ postnummer: "8000", transportoer: "postnord" })).toEqual({ fejl: POSTNORD_LUKKET });
  });

  it("indleveringssteder til retur af en PostNord-pakke kan stadig søges", async () => {
    fetchSvar = [tomListe()];
    expect(await soegPakkeshops({ postnummer: "8000", transportoer: "postnord", indlevering: true })).toMatchObject({
      ok: true,
      transportoer: "postnord",
    });
  });

  it("GLS kan vælges, og databasen får listen ['dao','gls'] (og gls_aktiv til den gamle funktion)", async () => {
    expect(await gemLeveringsvalg("T1", "K1", doer("gls"))).toMatchObject({ ok: true });
    const kald = rpcLog.find((r) => r.fn === "handel_gem_levering");
    expect(kald?.args.p_valg).toMatchObject({ transportoer: "gls", tilladte: ["dao", "gls"], gls_aktiv: true });
  });

  it("uden transportør (ældre app): DAO", async () => {
    expect(await gemLeveringsvalg("T1", "K1", doer())).toMatchObject({ ok: true });
    const kald = rpcLog.find((r) => r.fn === "handel_gem_levering");
    expect(kald?.args.p_valg).toMatchObject({ transportoer: "dao", tilladte: ["dao", "gls"] });
  });

  it("databasens afvisning (transportoer_lukket) vises som dansk fejl", async () => {
    rpcSvar.handel_gem_levering = () => ({ data: { kode: "transportoer_lukket" }, error: null });
    expect(await gemLeveringsvalg("T1", "K1", doer("gls"))).toEqual({
      fejl: "GLS kan ikke vælges lige nu. Vælg DAO.",
    });
  });

  it("SHIPMONDO_POSTNORD_AKTIV=true slår PostNord til igen", async () => {
    process.env.SHIPMONDO_POSTNORD_AKTIV = "true";
    expect(hentFragtfirma().transportoerer).toEqual(["dao", "gls", "postnord"]);
    expect(await gemLeveringsvalg("T1", "K1", doer("postnord"))).toMatchObject({ ok: true });
    const kald = rpcLog.find((r) => r.fn === "handel_gem_levering");
    expect(kald?.args.p_valg).toMatchObject({ transportoer: "postnord", tilladte: ["dao", "gls", "postnord"] });
  });

  it("SHIPMONDO_TRANSPORTOERER styrer listen (ukendte værdier ignoreres)", async () => {
    process.env.SHIPMONDO_TRANSPORTOERER = "dao";
    expect(hentFragtfirma().transportoerer).toEqual(["dao"]);
    expect(await gemLeveringsvalg("T1", "K1", doer("gls"))).toEqual({ fejl: "GLS kan ikke vælges lige nu. Vælg DAO." });
    process.env.SHIPMONDO_TRANSPORTOERER = "postnord, DAO ,bring";
    expect(hentFragtfirma().transportoerer).toEqual(["dao", "postnord"]);
    process.env.SHIPMONDO_TRANSPORTOERER = "bring";
    expect(hentFragtfirma().transportoerer).toEqual(["dao", "gls"]);
  });

  // En label til en levering, køberen valgte og betalte, før PostNord blev
  // slået fra: labelen laves stadig med PostNord (QR + PDF).
  const FID = "00000000-0000-4000-8000-0000000000f1";
  function forbered(transportoer: "postnord" | "gls") {
    raekker.handel_levering = {
      maade: "pakkeshop",
      fragtfirma: "shipmondo",
      transportoer,
      pakkeshop_id: "1234",
      pakkeshop_navn: "Shop",
      pakkeshop_adresse: "Gade 2",
      pakkeshop_postnummer: "8000",
      pakkeshop_by: "Aarhus C",
      modtager_navn: "Køber",
      modtager_adresse: null,
      modtager_postnummer: null,
      modtager_by: null,
      modtager_telefon: "+4512345678",
      modtager_email: "koeber@test.bidhamr.dk",
    };
    raekker.forsendelser = { id: FID, transportoer };
    raekker.trades = { id: "T1", auction_id: "A1", buyer_id: "K1", seller_id: "S1" };
    raekker.auctions = { titel: "Lampe", vaegt_gram: 800 };
    raekker.users = { email: "saelger@test.bidhamr.dk" };
    rpcSvar.forsendelse_claim = () => ({ data: { kode: "ok", id: FID, pakkestoerrelse: "lille" }, error: null });
    rpcSvar.forsendelse_gem_detaljer = () => ({ data: null, error: null });
    rpcSvar.forsendelse_gem_oprettet = () => ({ data: true, error: null });
    (falskAdmin as Record<string, unknown>).storage = {
      from: () => ({ upload: async () => ({ error: null }) }),
    };
  }
  const postBody = () => {
    const kald = vi.mocked(fetch).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST");
    return JSON.parse(String((kald?.[1] as RequestInit).body)) as Record<string, unknown>;
  };
  const AFSENDER = { navn: "Sælger", adresse: "Vej 1", postnummer: "5000", by: "Odense C" };

  it("en betalt PostNord-levering får stadig label og QR-kode (PostNord slået fra)", async () => {
    forbered("postnord");
    fetchSvar = [tomListe(), json(fx("opret_postnord_pakkeshop.json")), json(fx("qr_postnord.json"))];
    const r = await opretUdgaaendeForsendelse("T1", "S1", AFSENDER);
    expect(r).toEqual({ ok: true, forsendelseId: FID });
    expect(postBody()).toMatchObject({ product_code: "PDK_MC" });
    expect(fns()).toContain("forsendelse_gem_qr");
  });

  it("GLS: labelen er en PDF (ingen labelfri kode, ingen QR)", async () => {
    forbered("gls");
    fetchSvar = [tomListe(), json(fx("opret_gls_pakkeshop.json"))];
    const r = await opretUdgaaendeForsendelse("T1", "S1", AFSENDER);
    expect(r).toEqual({ ok: true, forsendelseId: FID });
    const body = postBody();
    expect(body.product_code).toBe("GLSDK_SD");
    expect(body.service_codes).not.toContain("QR_CODE");
    const gemt = rpcLog.find((x) => x.fn === "forsendelse_gem_oprettet");
    expect(gemt?.args).toMatchObject({ p_qr_kode: null });
    expect(String(gemt?.args.p_label_sti)).toMatch(/\.pdf$/);
    expect(fns()).not.toContain("forsendelse_gem_qr");
  });
});
