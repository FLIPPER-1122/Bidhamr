// Shipmondo-adapteren (src/lib/fragt/shipmondo.ts) mod rigtige sandbox-svar
// (src/lib/fragt/__fixtures__/shipmondo/) med en falsk fetch: opret pr.
// transportør (DAO, GLS, PostNord), labelfri kode/QR, retur, annullering,
// pakkeshops og webhook (signatur og statuskoder).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async () => "ny"),
  renFejltekst: (e: unknown) => String(e instanceof Error ? e.message : e),
}));

import {
  monitorHaendelser,
  monitorTilType,
  servicekoder,
  shipmondoFirma,
  signerJwtHs256,
  stedPasser,
  vaelgProdukt,
  vurderMonitorHaendelse,
} from "@/lib/fragt/shipmondo";
import {
  FragtAnnulleringIkkeMulig,
  FragtFejl,
  FragtUkendtUdfald,
  type ForsendelseInput,
  type ForsendelseKontekst,
  type Transportoer,
} from "@/lib/fragt/types";

const MAPPE = path.resolve(import.meta.dirname, "../../src/lib/fragt/__fixtures__/shipmondo");
const fx = (navn: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(MAPPE, navn), "utf8"));

const BRUGER = "testbruger-123";
const NOEGLE = "test-noegle-hemmelig-456";
const WEBHOOK = "webhook-noegle-mindst-16-tegn";
const BASE = "https://sandbox.shipmondo.com/api/public/v3";

type Kald = { metode: string; url: URL; body: Record<string, unknown> | null; auth: string | null };
let kald: Kald[] = [];
let svar: ((k: Kald) => Response)[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function saetSvar(...s: (Response | Error)[]) {
  svar = s.map((x) => (x instanceof Error ? () => Promise.reject(x) as never : () => x.clone()));
}

function input(over: Partial<ForsendelseInput> = {}): ForsendelseInput {
  return {
    reference: "0f5e4c2a-1111-4222-8333-944445555666",
    handel: { id: "t1", titel: "Lampe" },
    afsender: { navn: "Sælger Test", adresse: "Vestergade 10", postnummer: "5000", by: "Odense C", telefon: "+4512345678", email: "s@test.bidhamr.dk" },
    modtager: { navn: "Køber Test", adresse: "Nørregade 1", postnummer: "8000", by: "Aarhus C", telefon: "+4587654321", email: "k@test.bidhamr.dk" },
    pakkestoerrelse: "lille",
    levering: "pakkeshop",
    pakkeshopId: "59184",
    vaegtGram: 900,
    transportoer: "dao",
    ...over,
  };
}

const REF = input().reference.replace(/-/g, "");
function opretSvar(navn: string) {
  return { ...fx(navn), reference: REF };
}

beforeEach(() => {
  process.env.SHIPMONDO_API_URL = BASE;
  process.env.SHIPMONDO_API_BRUGER = BRUGER;
  process.env.SHIPMONDO_API_NOEGLE = NOEGLE;
  process.env.SHIPMONDO_WEBHOOK_NOEGLE = WEBHOOK;
  delete process.env.SHIPMONDO_EGEN_AFTALE;
  delete process.env.SHIPMONDO_RETUR_ER_IKKE_AFHENTET;
  kald = [];
  svar = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) => {
      const k: Kald = {
        metode: init?.method ?? "GET",
        url: new URL(u),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      };
      kald.push(k);
      const f = svar.shift();
      if (!f) throw new Error("Testen mangler et svar");
      return f(k);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------ produkter

describe("produktvalg pr. transportør", () => {
  it.each([
    ["dao", "pakkeshop", false, "DAO_STS", "valgt"],
    ["dao", "doer", false, "DAO_STH", null],
    ["gls", "pakkeshop", false, "GLSDK_SD", "valgt"],
    ["gls", "doer", false, "GLSDK_HD", null],
    ["postnord", "pakkeshop", false, "PDK_MC", "valgt"],
    ["postnord", "doer", false, "PDK_MH", null],
    ["dao", "pakkeshop", true, "DAO_STS", "automatisk"],
    ["gls", "pakkeshop", true, "GLSDK_SR", null],
    ["postnord", "pakkeshop", true, "PDK_MC", "automatisk"],
  ] as const)("%s %s retur=%s -> %s", (t, lev, retur, produkt, shop) => {
    expect(vaelgProdukt(t as Transportoer, lev, retur)).toEqual({ produkt, pakkeshop: shop });
  });

  it("GLS-retur har GLSDK_SD til en pakkeshop nær sælgeren som reserve", () => {
    expect(vaelgProdukt("gls", "pakkeshop", true, true)).toEqual({ produkt: "GLSDK_SD", pakkeshop: "automatisk" });
  });

  it("QR_CODE kun på PostNord og GLS ShopReturn; GLS kræver e-mail", () => {
    const m = { navn: "K", email: "k@x.dk", telefon: "+4512345678" };
    expect(servicekoder(m, "PDK_MC", false)).toBe("EMAIL_NT,SMS_NT,QR_CODE");
    expect(servicekoder(m, "PDK_MH", false)).toBe("EMAIL_NT,SMS_NT,QR_CODE");
    expect(servicekoder(m, "GLSDK_SR", true)).toBe("EMAIL_NT,SMS_NT,QR_CODE");
    expect(servicekoder(m, "GLSDK_SD", true)).toBe("EMAIL_NT,SMS_NT");
    expect(servicekoder(m, "DAO_STS", false)).toBe("EMAIL_NT,SMS_NT");
    expect(() => servicekoder({ navn: "K", telefon: "+4512345678" }, "GLSDK_SD", true)).toThrow(FragtFejl);
    expect(servicekoder({ navn: "K", telefon: "+4512345678" }, "DAO_STS", false)).toBe("SMS_NT");
  });
});

// ------------------------------------------------------------ opret

describe("opret pr. transportør", () => {
  it("DAO pakkeshop: labelfri kode, PDF og valgt pakkeshop", async () => {
    saetSvar(json([]), json(opretSvar("opret_dao_pakkeshop.json")));
    const o = await shipmondoFirma.opretForsendelse(input());
    expect(kald.map((k) => `${k.metode} ${k.url.pathname}`)).toEqual([
      "GET /api/public/v3/shipments",
      "POST /api/public/v3/shipments",
    ]);
    const body = kald[1].body!;
    expect(body.product_code).toBe("DAO_STS");
    expect(body.service_point_id).toBe("59184");
    expect(body.service_codes).toBe("EMAIL_NT,SMS_NT");
    // Uden bindestreger: PostNord tillader højst 35 tegn.
    expect(body.reference).toBe(REF);
    expect(String(body.reference).length).toBeLessThanOrEqual(35);
    expect(kald[0].url.searchParams.get("reference")).toBe(REF);
    expect(kald[1].auth).toBe("Basic " + Buffer.from(`${BRUGER}:${NOEGLE}`).toString("base64"));
    expect(o.qrKode).toBe("123-456-789");
    expect(o.qrPng ?? null).toBeNull();
    expect(o.produkt).toBe("DAO_STS");
    expect(o.label?.type).toBe("pdf");
    expect(o.prisOere).toBe(4350);
  });

  it("DAO døren: DAO_STH uden pakkeshop", async () => {
    saetSvar(json([]), json(opretSvar("opret_dao_doer.json")));
    const o = await shipmondoFirma.opretForsendelse(input({ levering: "doer", pakkeshopId: null }));
    expect(kald[1].body!.product_code).toBe("DAO_STH");
    expect(kald[1].body!.service_point_id).toBeUndefined();
    expect(o.qrKode).toBe("123-456-789");
  });

  it("GLS pakkeshop og døren: ingen labelfri - kun PDF (og ingen QR-kald)", async () => {
    saetSvar(json([]), json(opretSvar("opret_gls_pakkeshop.json")));
    const a = await shipmondoFirma.opretForsendelse(input({ transportoer: "gls", pakkeshopId: "97842" }));
    expect(kald[1].body!.product_code).toBe("GLSDK_SD");
    expect(kald).toHaveLength(2);
    expect(a.qrKode).toBeNull();
    expect(a.qrPng).toBeNull();
    expect(a.label?.type).toBe("pdf");

    kald = [];
    saetSvar(json([]), json(opretSvar("opret_gls_doer.json")));
    const b = await shipmondoFirma.opretForsendelse(input({ transportoer: "gls", levering: "doer", pakkeshopId: null }));
    expect(kald[1].body!.product_code).toBe("GLSDK_HD");
    expect(b.qrKode).toBeNull();
  });

  it("PostNord pakkeshop og døren: QR-kode (PNG) hentes efter oprettelsen", async () => {
    saetSvar(json([]), json(opretSvar("opret_postnord_pakkeshop.json")), json(fx("qr_postnord.json")));
    const a = await shipmondoFirma.opretForsendelse(input({ transportoer: "postnord", pakkeshopId: "5021" }));
    expect(kald[1].body!.product_code).toBe("PDK_MC");
    expect(kald[1].body!.service_codes).toBe("EMAIL_NT,SMS_NT,QR_CODE");
    expect(kald[2].url.pathname).toBe("/api/public/v3/shipments/69835921/qr_code");
    expect(kald[2].url.searchParams.get("file_format")).toBe("png");
    expect(a.qrPng).toMatch(/^iVBORw0KGgo/);
    expect(a.qrKode).toBeNull();

    kald = [];
    saetSvar(json([]), json(opretSvar("opret_postnord_doer.json")), json(fx("qr_postnord.json")));
    const b = await shipmondoFirma.opretForsendelse(input({ transportoer: "postnord", levering: "doer", pakkeshopId: null }));
    expect(kald[1].body!.product_code).toBe("PDK_MH");
    expect(b.qrPng).toMatch(/^iVBORw0KGgo/);
  });

  it("PostNord uden QR (fejl ved hentning): forsendelsen er stadig oprettet med PDF", async () => {
    saetSvar(json([]), json(opretSvar("opret_postnord_pakkeshop.json")), json(fx("qr_ingen.json"), 404));
    const o = await shipmondoFirma.opretForsendelse(input({ transportoer: "postnord", pakkeshopId: "5021" }));
    expect(o.qrPng).toBeNull();
    expect(o.label?.type).toBe("pdf");
  });

  it("findes referencen allerede, genbruges forsendelsen (ingen ny POST)", async () => {
    saetSvar(
      json([opretSvar("opret_postnord_pakkeshop.json")]),
      json([{ base64: Buffer.from("%PDF").toString("base64"), file_format: "pdf" }]),
      json(fx("qr_postnord.json")),
    );
    const o = await shipmondoFirma.opretForsendelse(input({ transportoer: "postnord", pakkeshopId: "5021" }));
    expect(kald.some((k) => k.metode === "POST")).toBe(false);
    expect(o.forsendelsesId).toBe("69835921");
    expect(o.qrPng).toMatch(/^iVBORw0KGgo/);
  });

  it("422 på oprettelsen er en FragtFejl (intet oprettet); netværksfejl er ukendt udfald", async () => {
    saetSvar(json([]), json(fx("qr_code_ugyldig_service.json"), 422));
    await expect(shipmondoFirma.opretForsendelse(input({ transportoer: "gls", pakkeshopId: "97842" }))).rejects.toBeInstanceOf(FragtFejl);
    saetSvar(json([]), new Error("ECONNRESET"));
    await expect(shipmondoFirma.opretForsendelse(input())).rejects.toBeInstanceOf(FragtUkendtUdfald);
  });

  it("validering før ethvert kald: ingen pakkeshop, døren over 5 kg, ukendt transportør", async () => {
    await expect(shipmondoFirma.opretForsendelse(input({ pakkeshopId: null }))).rejects.toBeInstanceOf(FragtFejl);
    await expect(
      shipmondoFirma.opretForsendelse(input({ levering: "doer", pakkeshopId: null, vaegtGram: 6000, pakkestoerrelse: "stor" })),
    ).rejects.toBeInstanceOf(FragtFejl);
    await expect(
      shipmondoFirma.opretForsendelse(input({ transportoer: "bring" as unknown as Transportoer })),
    ).rejects.toBeInstanceOf(FragtFejl);
    expect(kald).toHaveLength(0);
  });

  it("sætter ikke op uden sandbox/app-URL (og kalder intet)", async () => {
    process.env.SHIPMONDO_API_URL = "https://evil.example.com/api/public/v3";
    expect(shipmondoFirma.erSatOp?.()).toBe(false);
    await expect(shipmondoFirma.opretForsendelse(input())).rejects.toBeInstanceOf(FragtFejl);
    expect(kald).toHaveLength(0);
  });
});

// ------------------------------------------------------------ retur

describe("returlabel (køber -> sælger)", () => {
  const retur = (t: Transportoer) =>
    input({
      transportoer: t,
      levering: "pakkeshop",
      pakkeshopId: null,
      afsender: input().modtager,
      modtager: input().afsender,
    });

  it("DAO: DAO_STS med automatisk daoSHOP nær sælgeren og labelfri kode", async () => {
    saetSvar(json([]), json(opretSvar("opret_dao_pakkeshop.json")));
    const o = await shipmondoFirma.opretReturforsendelse(retur("dao"));
    expect(kald[1].body!.product_code).toBe("DAO_STS");
    expect(kald[1].body!.automatic_select_service_point).toBe(true);
    expect(kald[1].body!.service_point_id).toBeUndefined();
    expect(o.qrKode).toBe("123-456-789");
  });

  it("PostNord: PDK_MC + QR med automatisk pakkeshop nær sælgeren", async () => {
    saetSvar(json([]), json(opretSvar("opret_postnord_retur.json")), json(fx("qr_postnord.json")));
    const o = await shipmondoFirma.opretReturforsendelse(retur("postnord"));
    expect(kald[1].body!.product_code).toBe("PDK_MC");
    expect(kald[1].body!.automatic_select_service_point).toBe(true);
    expect(kald[1].body!.service_codes).toBe("EMAIL_NT,SMS_NT,QR_CODE");
    expect(o.qrPng).toMatch(/^iVBORw0KGgo/);
  });

  it("GLS: ShopReturn + QR til sælgerens adresse", async () => {
    saetSvar(json([]), json(opretSvar("opret_gls_retur.json")), json(fx("qr_gls_retur.json")));
    const o = await shipmondoFirma.opretReturforsendelse(retur("gls"));
    expect(kald[1].body!.product_code).toBe("GLSDK_SR");
    expect(kald[1].body!.automatic_select_service_point).toBeUndefined();
    expect((kald[1].body!.parties as { type: string; name: string }[]).find((p) => p.type === "receiver")?.name).toBe("Sælger Test");
    expect(o.qrPng).toMatch(/^iVBORw0KGgo/);
  });

  it("GLS: afvises ShopReturn (422), bruges GLSDK_SD til en pakkeshop nær sælgeren", async () => {
    saetSvar(json([]), json({ error: "Receiver must be a business" }, 422), json(opretSvar("opret_gls_retur_reserve.json")));
    const o = await shipmondoFirma.opretReturforsendelse(retur("gls"));
    expect(kald.map((k) => k.body?.product_code ?? null)).toEqual([null, "GLSDK_SR", "GLSDK_SD"]);
    expect(kald[2].body!.automatic_select_service_point).toBe(true);
    expect(kald[2].body!.reference).toBe(REF);
    expect(o.qrPng).toBeNull();
    expect(o.label?.type).toBe("pdf");
  });

  it.each([400, 401, 403, 429])("GLS: %i på ShopReturn giver INGEN reserve-bestilling", async (status) => {
    saetSvar(json([]), json({ error: "nej" }, status));
    await expect(shipmondoFirma.opretReturforsendelse(retur("gls"))).rejects.toBeInstanceOf(FragtFejl);
    expect(kald.filter((k) => k.metode === "POST")).toHaveLength(1);
  });
});

// ------------------------------------------------------------ annullering

describe("annullering", () => {
  it("DAO: 422 -> FragtAnnulleringIkkeMulig", async () => {
    saetSvar(json(fx("annuller_dao_422.json"), 422));
    await expect(shipmondoFirma.annullerForsendelse("69835917")).rejects.toBeInstanceOf(FragtAnnulleringIkkeMulig);
    expect(kald[0].metode).toBe("PUT");
    expect(kald[0].url.pathname).toBe("/api/public/v3/shipments/69835917/cancel");
  });

  it("GLS/PostNord: annulleret hos Shipmondo, men ikke bekræftet af transportøren", async () => {
    saetSvar(json(fx("annuller_ok_ikke_hos_transportoer.json")));
    await expect(shipmondoFirma.annullerForsendelse("69835919")).resolves.toEqual({ bekraeftet: false });
  });

  it("bekræftet hos transportøren", async () => {
    saetSvar(json(fx("annuller_ok_bekraeftet.json")));
    await expect(shipmondoFirma.annullerForsendelse("69835921")).resolves.toEqual({ bekraeftet: true });
  });

  it("cancelled: false er ikke en annullering", async () => {
    saetSvar(json({ cancelled: false }));
    await expect(shipmondoFirma.annullerForsendelse("1")).rejects.toBeInstanceOf(FragtAnnulleringIkkeMulig);
  });

  it("ugyldigt id kaldes aldrig", async () => {
    await expect(shipmondoFirma.annullerForsendelse("../1")).rejects.toBeInstanceOf(FragtFejl);
    expect(kald).toHaveLength(0);
  });
});

// ------------------------------------------------------------ pakkeshops

describe("pakkeshops pr. transportør", () => {
  it.each([
    ["dao", "DAO_STS", "service_points_dao.json", "Naturkost Odense", "Lørdag"],
    ["gls", "GLSDK_SD", "service_points_gls.json", "City Shoppen", "Mandag"],
    ["postnord", "PDK_MC", "service_points_postnord.json", "Pakkeshop Trævarefabrikernes Udsalg", "Mandag"],
  ] as const)("%s søger med %s", async (t, produkt, fil, foerste, dag) => {
    saetSvar(json(fx(fil)));
    const liste = await shipmondoFirma.soegPakkeshops({ postnummer: "5000", adresse: "Vestergade 10", transportoer: t, antal: 3 });
    expect(kald[0].url.pathname).toBe("/api/public/v3/service_point/service_points");
    expect(kald[0].url.searchParams.get("product_code")).toBe(produkt);
    expect(kald[0].url.searchParams.get("zipcode")).toBe("5000");
    expect(liste).toHaveLength(3);
    expect(liste[0].navn).toBe(foerste);
    expect(liste[0].afstandM).toBeLessThan(liste[2].afstandM!);
    expect(liste[0].aabningstider.map((a) => a.dag)).toContain(dag);
    expect(liste[0].by).toBe("Odense C");
  });

  it("filtrerer shops fra et andet fragtfirma og shops uden afhentning/indlevering fra", async () => {
    const shops = fx("service_points_gls.json") as unknown as Record<string, unknown>[];
    const blandet = [
      { ...shops[0], carrier_code: "dao" },
      { ...shops[1], pickup_allowed: false },
      { ...shops[2], drop_off_allowed: false },
    ];
    saetSvar(json(blandet));
    const afhent = await shipmondoFirma.soegPakkeshops({ postnummer: "5000", transportoer: "gls" });
    expect(afhent.map((s) => s.id)).toEqual([String(shops[2].id)]);
    saetSvar(json(blandet));
    const aflever = await shipmondoFirma.soegPakkeshops({ postnummer: "5000", transportoer: "gls", indlevering: true });
    expect(aflever.map((s) => s.id)).toEqual([String(shops[1].id)]);
  });

  it("hentPakkeshop finder kun shoppen hos den valgte transportør", async () => {
    saetSvar(json(fx("service_points_postnord.json")));
    expect((await shipmondoFirma.hentPakkeshop("5021", { postnummer: "5000", transportoer: "postnord" }))?.navn).toBe(
      "Pakkeshop Superbrugsen Vestergade",
    );
    saetSvar(json(fx("service_points_dao.json")));
    expect(await shipmondoFirma.hentPakkeshop("5021", { postnummer: "5000", transportoer: "dao" })).toBeNull();
  });
});

// ------------------------------------------------------------ webhook

function webhookRequest(payload: unknown, opts: { noegle?: string; header?: string; jwt?: string } = {}): Request {
  const jwt = opts.jwt ?? signerJwtHs256(payload, opts.noegle ?? WEBHOOK);
  return new Request("https://bidhamr.dk/api/fragt/webhook/shipmondo", {
    method: "POST",
    headers: { "content-type": "application/json", "smd-resource-type": opts.header ?? "Shipment Monitor" },
    body: JSON.stringify({ data: jwt }),
  });
}

describe("webhook: signatur", () => {
  it("afviser forkert nøgle, alg none og manglende nøgle (fail closed)", async () => {
    const p = fx("monitor_gls_leveret.json");
    expect(await shipmondoFirma.fortolkWebhook(webhookRequest(p, { noegle: "en-helt-anden-noegle-123" }))).toMatchObject({ ok: false, status: 401 });

    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${enc({ alg: "none" })}.${enc(p)}.`;
    expect(await shipmondoFirma.fortolkWebhook(webhookRequest(p, { jwt: none }))).toMatchObject({ ok: false });
    const hs512 = `${enc({ alg: "HS512" })}.${enc(p)}.${"a".repeat(86)}`;
    expect(await shipmondoFirma.fortolkWebhook(webhookRequest(p, { jwt: hs512 }))).toMatchObject({ ok: false, status: 401 });

    delete process.env.SHIPMONDO_WEBHOOK_NOEGLE;
    expect(await shipmondoFirma.fortolkWebhook(webhookRequest(p))).toMatchObject({ ok: false, status: 503 });
  });

  it("Shipmondo pakker payloaden som en JSON-streng - begge former virker", async () => {
    const p = fx("monitor_gls_leveret.json");
    const a = await shipmondoFirma.fortolkWebhook(webhookRequest(p));
    const b = await shipmondoFirma.fortolkWebhook(webhookRequest(JSON.stringify(p)));
    expect(a).toEqual(b);
    // Foreløbig: endelig type først efter vurdering med forsendelsen.
    expect(a.ok && a.haendelser[0].raa?.vurderes).toBe(true);
  });
});

describe("webhook: statuskoder (fælles for DAO, GLS og PostNord)", () => {
  // Køberen i Aarhus (pakkeshop i 8000), sælgeren i Odense.
  const UD: ForsendelseKontekst = { type: "udgaaende", steder: [{ by: "Aarhus C", postnummer: "8000" }] };
  const RETUR: ForsendelseKontekst = { type: "retur", steder: [{ by: "Odense C", postnummer: "5000" }] };

  const fortolk = async (payload: unknown) => {
    const r = await shipmondoFirma.fortolkWebhook(webhookRequest(payload));
    if (!r.ok) throw new Error(r.fejl);
    return r;
  };
  // Som webhook-ruten: hændelserne vurderes med forsendelsen.
  const typer = async (fil: string, k: ForsendelseKontekst = UD, over: Record<string, unknown> = {}) => {
    const p = fx(fil) as { data: Record<string, unknown> };
    const r = await fortolk({ ...p, data: { ...p.data, ...over } });
    return { ...r, haendelser: r.haendelser.flatMap((h) => vurderMonitorHaendelse(h, k)) };
  };

  it("foreløbige hændelser er markeret til vurdering (gemmes aldrig uden)", async () => {
    const r = await fortolk(fx("monitor_gls_leveret.json"));
    expect(r.haendelser[0].raa?.vurderes).toBe(true);
    const v = vurderMonitorHaendelse(r.haendelser[0], UD);
    expect(v[0].raa?.vurderes).toBeUndefined();
  });

  it("DAO EN_ROUTE -> i_transit, AVAILABLE_FOR_DELIVERY -> klar_til_afhentning", async () => {
    const a = await typer("monitor_dao_undervejs.json");
    expect(a.haendelser.map((h) => h.type)).toEqual(["i_transit"]);
    expect(a.haendelser[0]).toMatchObject({ forsendelsesId: "69835917", sporingsnummer: "00057126960000000015", transportoer: "dao" });
    expect((await typer("monitor_dao_klar.json")).haendelser.map((h) => h.type)).toEqual(["klar_til_afhentning"]);
  });

  it("GLS DELIVERED på det rigtige sted -> leveret (med målt vægt i gram)", async () => {
    const r = await typer("monitor_gls_leveret.json");
    expect(r.haendelser).toHaveLength(1);
    expect(r.haendelser[0]).toMatchObject({ type: "leveret", transportoer: "gls", forsendelsesId: "69835919" });
    expect(r.haendelser[0].raa?.maalt_vaegt_gram).toBe(900);
    expect(r.ukendte ?? []).toEqual([]);
  });

  it("PostNord EN_ROUTE -> i_transit", async () => {
    const r = await typer("monitor_postnord_undervejs.json");
    expect(r.haendelser[0]).toMatchObject({ type: "i_transit", transportoer: "postnord" });
  });

  describe("leveret_kl: by/postnummer skal passe", () => {
    it("leveret i en anden by end pakkeshoppen/modtageren -> markering (fejl), aldrig leveret", async () => {
      const r = await typer("monitor_gls_leveret.json", UD, { city: "Odense SØ" });
      expect(r.haendelser.map((h) => h.type)).toEqual(["fejl"]);
      expect(r.haendelser[0].noegle).toMatch(/:sted$/);
      expect(r.haendelser[0].beskrivelse).toContain("Odense SØ");
    });

    it("uden by fra Shipmondo -> markering, ikke leveret", async () => {
      const r = await typer("monitor_gls_leveret.json", UD, { city: "" });
      expect(r.haendelser.map((h) => h.type)).toEqual(["fejl"]);
    });

    it("postnummeret passer (selv om byen staves anderledes) -> leveret", async () => {
      const r = await typer("monitor_gls_leveret.json", UD, { city: "Århus", zipcode: "8000" });
      expect(r.haendelser.map((h) => h.type)).toEqual(["leveret"]);
    });

    it("bydel og versaler gør ikke noget (første ord)", () => {
      expect(stedPasser({ by: "AARHUS N", postnummer: null }, UD.steder)).toBe(true);
      expect(stedPasser({ by: "København Ø", postnummer: null }, [{ by: null, postnummer: "2100" }])).toBe(true);
      expect(stedPasser({ by: "Vejle", postnummer: "7100" }, UD.steder)).toBe(false);
    });

    it("leveret_kl sættes kun ved DELIVERED - aldrig ved andre statusser", async () => {
      for (const status of ["EN_ROUTE", "AVAILABLE_FOR_DELIVERY", "INFORMED", "GENERAL", "PICKUP_REQUESTED"]) {
        const r = await typer("monitor_gls_leveret.json", UD, { current_status: status });
        expect(r.haendelser.map((h) => h.type)).not.toContain("leveret");
      }
    });
  });

  describe("returtekst efter forsendelsens type", () => {
    it("udgående: DELIVERED med returtekst -> returneret (leveret tilbage til afsenderen), aldrig leveret", async () => {
      const r = await typer("monitor_postnord_leveret_retur.json", UD);
      expect(r.haendelser.map((h) => h.type)).toEqual(["returneret"]);
    });

    it("udgående: returtekst ved EN_ROUTE ændrer intet (kun ved DELIVERED)", async () => {
      const r = await typer("monitor_postnord_undervejs.json", UD, { current_status_text: "Returned to sender" });
      expect(r.haendelser.map((h) => h.type)).toEqual(["i_transit"]);
    });

    it("retur: returteksten bruges aldrig - DELIVERED hos sælgeren er leveret", async () => {
      const r = await typer("monitor_postnord_leveret_retur.json", RETUR);
      expect(r.haendelser.map((h) => h.type)).toEqual(["leveret"]);
    });

    it("retur: DELIVERED et andet sted end hos sælgeren -> markering", async () => {
      const r = await typer("monitor_postnord_leveret_retur.json", RETUR, { city: "Aarhus C" });
      expect(r.haendelser.map((h) => h.type)).toEqual(["fejl"]);
    });

    it("retur: returtekst ved EN_ROUTE -> i_transit (aldrig returneret)", async () => {
      const r = await typer("monitor_postnord_undervejs.json", RETUR, { current_status_text: "Retur til afsender" });
      expect(r.haendelser.map((h) => h.type)).toEqual(["i_transit"]);
    });

    it("monitorTilType med type", () => {
      const m = { carrier_code: "gls", current_status: "DELIVERED", current_status_text: "Returned to sender" };
      expect(monitorTilType(m, "udgaaende")).toEqual({ type: "returneret" });
      expect(monitorTilType(m, "retur")).toEqual({ type: "leveret" });
    });
  });

  it("DANGER giver en ekstra fejl-hændelse (markering), status uændret", async () => {
    const r = await typer("monitor_dao_danger.json");
    expect(r.haendelser.map((h) => h.type)).toEqual(["klar_til_afhentning", "fejl"]);
    expect(new Set(r.haendelser.map((h) => h.noegle)).size).toBe(2);
  });

  it("INFORMED er kendt, men giver ingen hændelse", async () => {
    const r = await typer("monitor_informed.json");
    expect(r.haendelser).toEqual([]);
    expect(r.ukendte ?? []).toEqual([]);
  });

  it("ukendt status og ukendt transportør ændrer aldrig status - de registreres som ukendte", async () => {
    const a = await typer("monitor_ukendt_status.json");
    expect(a.haendelser).toEqual([]);
    expect(a.ukendte).toEqual([expect.objectContaining({ kode: "LOST_IN_SPACE", liste: "dao" })]);
    const b = await typer("monitor_ukendt_transportoer.json");
    expect(b.haendelser).toEqual([]);
    expect(b.ukendte).toEqual([expect.objectContaining({ kode: "carrier:ups", liste: "" })]);
  });

  it("andre ressourcer (fx Shipments) giver ingen hændelser", async () => {
    const r = await shipmondoFirma.fortolkWebhook(
      webhookRequest({ webhook: "Shipment", data: { id: 1, carrier_code: "gls" } }, { header: "Shipments" }),
    );
    expect(r).toEqual({ ok: true, haendelser: [] });
  });

  it("samme hændelse to gange giver samme nøgle (idempotent) - også uden tidspunkt", () => {
    const m = (fx("monitor_gls_leveret.json") as { data: Record<string, unknown> }).data;
    expect(monitorHaendelser(m).haendelser[0].noegle).toBe(monitorHaendelser({ ...m }).haendelser[0].noegle);
    const utenTid = { ...m, current_status_registered_at: null };
    const a = monitorHaendelser(utenTid).haendelser[0].noegle;
    expect(a).toBe("shipmondo:69835919:DELIVERED:uden-tid");
    expect(monitorHaendelser({ ...utenTid }).haendelser[0].noegle).toBe(a);
  });

  it("samme forsendelse, kode og tidspunkt med en anden current_state er samme hændelse (20261102060000)", () => {
    const m = (fx("monitor_gls_leveret.json") as { data: Record<string, unknown> }).data;
    const a = monitorHaendelser(m).haendelser[0].noegle;
    expect(monitorHaendelser({ ...m, current_state: "PROGRESSING" }).haendelser[0].noegle).toBe(a);
    expect(a).not.toContain("SUCCESS");
    // Et andet tidspunkt er en ny hændelse.
    expect(monitorHaendelser({ ...m, current_status_registered_at: "2026-01-01T00:00:00Z" }).haendelser[0].noegle).not.toBe(a);
  });

  it("monitorTilType: kendte statusser pr. transportør", () => {
    for (const carrier of ["dao", "gls", "pdk"]) {
      expect(monitorTilType({ carrier_code: carrier, current_status: "DELIVERED" }, "udgaaende")).toEqual({ type: "leveret" });
      expect(monitorTilType({ carrier_code: carrier, current_status: "EN_ROUTE" }, "udgaaende")).toEqual({ type: "i_transit" });
      expect(monitorTilType({ carrier_code: carrier, current_status: "AVAILABLE_FOR_DELIVERY" }, "udgaaende")).toEqual({
        type: "klar_til_afhentning",
      });
      expect(monitorTilType({ carrier_code: carrier, current_status: "GENERAL" }, "udgaaende")).toEqual({ type: null });
      expect(monitorTilType({ carrier_code: carrier, current_status: "PICKUP_REQUESTED" }, "udgaaende")).toEqual({ type: null });
      expect(monitorTilType({ carrier_code: carrier, current_status: "constructor" }, "udgaaende")).toEqual({ ukendt: "CONSTRUCTOR" });
    }
  });
});

describe("adapterens egenskaber", () => {
  it("DAO og GLS (PostNord kun med SHIPMONDO_POSTNORD_AKTIV=true), manuel efterlysning, ingen sporing at hente", async () => {
    delete process.env.SHIPMONDO_POSTNORD_AKTIV;
    delete process.env.SHIPMONDO_TRANSPORTOERER;
    expect(shipmondoFirma.transportoerer).toEqual(["dao", "gls"]);
    process.env.SHIPMONDO_POSTNORD_AKTIV = "true";
    expect(shipmondoFirma.transportoerer).toEqual(["dao", "gls", "postnord"]);
    delete process.env.SHIPMONDO_POSTNORD_AKTIV;
    expect(shipmondoFirma.efterlysningUdenApi).toBe(true);
    expect(await shipmondoFirma.hentSporing("x")).toEqual([]);
  });

  it("automatisk 'ikke afhentet' kun med SHIPMONDO_RETUR_ER_IKKE_AFHENTET=true", () => {
    expect(shipmondoFirma.returErIkkeAfhentet).toBe(false);
    process.env.SHIPMONDO_RETUR_ER_IKKE_AFHENTET = "true";
    expect(shipmondoFirma.returErIkkeAfhentet).toBe(true);
  });
});
