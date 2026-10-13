// DAO-adapteren (src/lib/fragt/dao.ts) med en falsk fetch: fejlhåndtering,
// genforsøg kun på læsekald, ét forsøg på ordrer, og at kundeid/kode aldrig
// står i en fejl eller i loggen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const driftLog: string[] = [];
vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async (i: { hvor?: string; fejl: unknown }) => {
    driftLog.push(`${i.hvor ?? ""}: ${String(i.fejl instanceof Error ? i.fejl.message : i.fejl)}`);
    return "ny";
  }),
  renFejltekst: (e: unknown) => String(e instanceof Error ? e.message : e),
}));

import { daoFirma, DaoFejl, daoMobil, _test } from "@/lib/fragt/dao";
import { FragtFejl, FragtUkendtUdfald, FRAGT_IKKE_SAT_OP, type ForsendelseInput } from "@/lib/fragt/types";
import { fixture, fixtureTekst, jsonSvar, pdfSvar } from "./fixtures";

const KUNDEID = "98765";
const KODE = "Sup3r+Hemmelig";

type Kald = { url: URL };
let kald: Kald[] = [];
let svar: ((url: URL) => Response | Promise<Response>)[] = [];

function saetSvar(...s: (Response | ((url: URL) => Response | Promise<Response>) | Error)[]) {
  svar = s.map((x) =>
    x instanceof Response ? () => x.clone() : x instanceof Error ? () => Promise.reject(x) : x,
  );
}

const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

function ingenHemmeligheder(t: string) {
  expect(t).not.toContain(KODE);
  expect(t).not.toContain(encodeURIComponent(KODE));
  expect(t).not.toContain(KUNDEID);
  expect(t).not.toMatch(/kode=(?!\[skjult\])/);
  expect(t).not.toMatch(/kundeid=(?!\[skjult\])/);
}

function input(over: Partial<ForsendelseInput> = {}): ForsendelseInput {
  return {
    reference: "0f5e4c2a-1111-4222-8333-944445555666",
    handel: { id: "t1", titel: "Lampe" },
    afsender: { navn: "Sælger Eksempel", adresse: "Eksempelvej 1", postnummer: "8000", by: "Aarhus C", telefon: "+4512345678", email: "s@example.dk" },
    modtager: { navn: "Køber Eksempel", adresse: "Prøvegade 2", postnummer: "8200", by: "Aarhus N", telefon: "+4587654321", email: "k@example.dk" },
    pakkestoerrelse: "mellem",
    levering: "pakkeshop",
    pakkeshopId: "9101",
    vaegtGram: 1200,
    ...over,
  };
}

beforeEach(() => {
  process.env.DAO_KUNDEID = KUNDEID;
  process.env.DAO_KODE = KODE;
  delete process.env.DAO_API_URL;
  delete process.env.DAO_TESTMODE;
  delete process.env.DAO_LABEL_PAPIR;
  kald = [];
  svar = [];
  driftLog.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(u);
      kald.push({ url });
      const f = svar.shift();
      if (!f) throw new Error("Testen mangler et svar");
      return f(url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("konfiguration", () => {
  it("uden nøgler: 'Fragt er ikke sat op endnu.' og intet kald", async () => {
    delete process.env.DAO_KODE;
    expect(daoFirma.erSatOp!()).toBe(false);
    await expect(daoFirma.soegPakkeshops({ postnummer: "8200" })).rejects.toMatchObject({ brugerbesked: FRAGT_IKKE_SAT_OP });
    expect(kald).toHaveLength(0);
  });

  it("kun https og kun dao.as (nøglerne står i URL'en)", () => {
    process.env.DAO_API_URL = "https://evil.example.com";
    expect(_test.laesKonfig()).toBeNull();
    process.env.DAO_API_URL = "http://api.dao.as";
    expect(_test.laesKonfig()).toBeNull();
    process.env.DAO_API_URL = "https://api.dao.as.evil.com";
    expect(_test.laesKonfig()).toBeNull();
    process.env.DAO_API_URL = "https://apiv2.dao.as/";
    expect(_test.laesKonfig()?.base).toBe("https://apiv2.dao.as");
  });
});

describe("opret Shop2Shop", () => {
  it("OK: labelfri kode, PDF, stregkode som id og produkt DAO_STS", async () => {
    saetSvar(jsonSvar(fixture("c2c_ok.json")), pdfSvar());
    const o = await daoFirma.opretForsendelse(input());
    expect(o.forsendelsesId).toBe("00057099990000412345");
    expect(o.sporingsnummer).toBe("00057099990000412345");
    expect(o.qrKode).toBe("482 913 556");
    expect(o.produkt).toBe("DAO_STS");
    expect(o.label?.type).toBe("pdf");
    expect(o.prisOere).toBeNull();

    const ordre = kald[0].url;
    expect(ordre.pathname).toBe("/DAOPakkeshop/c2cindleveringsordre.php");
    expect(ordre.searchParams.get("shopid")).toBe("9101");
    expect(ordre.searchParams.get("mobil")).toBe("87654321");
    expect(ordre.searchParams.get("vaegt")).toBe("1200");
    expect(ordre.searchParams.get("reference")).toBe(input().reference);
    expect(ordre.searchParams.get("format")).toBe("JSON");
    expect(ordre.searchParams.get("test")).toBeNull();
    expect(kald[1].url.pathname).toBe("/HentLabel.php");
    expect(kald[1].url.searchParams.get("stregkode")).toBe("00057099990000412345");
    expect(kald[1].url.searchParams.get("papir")).toBe("A4Foldable");
  });

  it("DAO_TESTMODE=true sender test=1", async () => {
    process.env.DAO_TESTMODE = "true";
    saetSvar(jsonSvar(fixture("c2c_ok.json")), pdfSvar());
    await daoFirma.opretForsendelse(input());
    expect(kald[0].url.searchParams.get("test")).toBe("1");
  });

  it("retur: Shop2Shop med shopid 0 (DAO vælger shoppen nærmest sælgeren)", async () => {
    saetSvar(jsonSvar(fixture("c2c_ok.json")), pdfSvar());
    await daoFirma.opretReturforsendelse(input({ pakkeshopId: null }));
    expect(kald[0].url.pathname).toBe("/DAOPakkeshop/c2cindleveringsordre.php");
    expect(kald[0].url.searchParams.get("shopid")).toBe("0");
  });

  it("levering til døren: Shop2Home uden shopid", async () => {
    saetSvar(jsonSvar(fixture("shop2home_ok.json")), pdfSvar());
    const o = await daoFirma.opretForsendelse(input({ levering: "doer", pakkeshopId: null }));
    expect(kald[0].url.pathname).toBe("/DAODirekte/ShoptildirekteLeveringsordre.php");
    expect(kald[0].url.searchParams.get("shopid")).toBeNull();
    expect(o.produkt).toBe("DAO_STH");
  });

  it("validering før ethvert kald", async () => {
    await expect(daoFirma.opretForsendelse(input({ vaegtGram: 16000 }))).rejects.toBeInstanceOf(FragtFejl);
    await expect(daoFirma.opretForsendelse(input({ levering: "doer", vaegtGram: 6000 }))).rejects.toThrow(/5 kg/);
    await expect(daoFirma.opretForsendelse(input({ pakkeshopId: null }))).rejects.toThrow(/pakkeshop/);
    await expect(
      daoFirma.opretForsendelse(input({ modtager: { navn: "K", adresse: "Vej 1", postnummer: "8200", telefon: null, email: null } })),
    ).rejects.toThrow(/e-mail eller mobilnummer/);
    await expect(
      daoFirma.opretForsendelse(input({ afsender: { navn: "S", adresse: "x".repeat(46), postnummer: "8000" } })),
    ).rejects.toThrow(/45 tegn/);
    expect(kald).toHaveLength(0);
  });

  it("FEJL (HTTP 200): FragtFejl med dansk tekst - intet oprettet", async () => {
    saetSvar(jsonSvar(fixture("ordre_fejl.json")));
    const err = await daoFirma.opretForsendelse(input()).catch((e) => e);
    expect(err).toBeInstanceOf(DaoFejl);
    expect(err).toBeInstanceOf(FragtFejl);
    expect(err).not.toBeInstanceOf(FragtUkendtUdfald);
    expect(err.brugerbesked).toBe("Fragtfirmaet kunne ikke finde adressen. Tjek vejnavn og husnummer.");
    expect(err.fejlkode).toBe("1");
    ingenHemmeligheder(err.message);
    expect(kald).toHaveLength(1);
  });

  it("timeout på ordren: ukendt udfald, ÉT kald (aldrig blindt genforsøg), ingen hemmeligheder", async () => {
    saetSvar(timeout());
    const err = await daoFirma.opretForsendelse(input()).catch((e) => e);
    expect(err).toBeInstanceOf(FragtUkendtUdfald);
    expect(err.foraeldreloesId).toBeNull();
    expect(err.message).toContain("/DAOPakkeshop/c2cindleveringsordre.php");
    ingenHemmeligheder(err.message);
    ingenHemmeligheder(String(err.stack ?? ""));
    expect(kald).toHaveLength(1);
  });

  it("5xx og ugyldigt svar på ordren: ukendt udfald, ét kald", async () => {
    saetSvar(jsonSvar({ fejl: "x" }, 502));
    await expect(daoFirma.opretForsendelse(input())).rejects.toBeInstanceOf(FragtUkendtUdfald);
    saetSvar(new Response("<html>ups</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(daoFirma.opretForsendelse(input())).rejects.toBeInstanceOf(FragtUkendtUdfald);
    saetSvar(jsonSvar(fixture("ordre_ok_uden_stregkode.json")));
    await expect(daoFirma.opretForsendelse(input())).rejects.toBeInstanceOf(FragtUkendtUdfald);
    expect(kald).toHaveLength(3);
  });

  it("PDF kan ikke hentes, men labelfri kode findes: gemmes uden PDF (drift-advarsel)", async () => {
    saetSvar(jsonSvar(fixture("c2c_ok.json")), jsonSvar({}, 503), jsonSvar({}, 503), jsonSvar({}, 503));
    const o = await daoFirma.opretForsendelse(input());
    expect(o.label).toBeNull();
    expect(o.qrKode).toBe("482 913 556");
    expect(kald.map((k) => k.url.pathname)).toEqual(["/DAOPakkeshop/c2cindleveringsordre.php", "/HentLabel.php", "/HentLabel.php", "/HentLabel.php"]);
    expect(driftLog.some((l) => l.startsWith("DAO: label-PDF"))).toBe(true);
    driftLog.forEach(ingenHemmeligheder);
  });

  it("hverken PDF eller labelfri kode: pakken annulleres igen, FragtFejl", async () => {
    const udenKode = { status: "OK", resultat: { stregkode: "00057099990000412345" } };
    saetSvar(
      jsonSvar(udenKode),
      jsonSvar({ status: "FEJL", fejlkode: 9, fejltekst: "Ingen label" }),
      jsonSvar(fixture("annuller_ok.json")),
    );
    const err = await daoFirma.opretForsendelse(input()).catch((e) => e);
    expect(err).toBeInstanceOf(FragtFejl);
    expect(err).not.toBeInstanceOf(FragtUkendtUdfald);
    expect(kald[2].url.pathname).toBe("/AnnullerePakke.php");
  });

  it("...og fejler annulleringen: ukendt udfald med den forældreløse stregkode", async () => {
    const udenKode = { status: "OK", resultat: { stregkode: "00057099990000412345" } };
    saetSvar(jsonSvar(udenKode), jsonSvar({ status: "FEJL", fejlkode: 9 }), timeout());
    const err = await daoFirma.opretForsendelse(input()).catch((e) => e);
    expect(err).toBeInstanceOf(FragtUkendtUdfald);
    expect(err.foraeldreloesId).toBe("00057099990000412345");
    ingenHemmeligheder(err.message);
  });
});

describe("pakkeshops (læsekald)", () => {
  it("genforsøg ved 5xx og timeout - op til 3 forsøg", async () => {
    saetSvar(jsonSvar({}, 500), timeout(), jsonSvar(fixture("findpakkeshop_ok.json")));
    const shops = await daoFirma.soegPakkeshops({ postnummer: "8200", adresse: "Prøvegade 2", antal: 2 });
    expect(shops.map((p) => p.id)).toEqual(["9101", "9102"]);
    expect(kald).toHaveLength(3);
    expect(kald[0].url.pathname).toBe("/DAOPakkeshop/FindPakkeshop.php");
    expect(kald[0].url.searchParams.get("postnr")).toBe("8200");
  });

  it("giver op efter 3 forsøg uden at afsløre nøglerne", async () => {
    saetSvar(timeout(), timeout(), timeout());
    const err = await daoFirma.soegPakkeshops({ postnummer: "8200" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FragtFejl);
    ingenHemmeligheder(err.message);
    expect(kald).toHaveLength(3);
  });

  it("ERROR med adresse: prøver én gang kun med postnummeret", async () => {
    saetSvar(jsonSvar(fixture("findpakkeshop_error.json")), jsonSvar(fixture("findpakkeshop_ok.json")));
    const shops = await daoFirma.soegPakkeshops({ postnummer: "8200", adresse: "Ukendt vej 99" });
    expect(shops.length).toBe(3);
    expect(kald[1].url.searchParams.get("adresse")).toBeNull();
  });

  it("ERROR uden adresse: FragtFejl med dansk tekst (ingen genforsøg)", async () => {
    saetSvar(jsonSvar(fixture("findpakkeshop_error.json")));
    const err = await daoFirma.soegPakkeshops({ postnummer: "8200" }).catch((e) => e);
    expect(err).toBeInstanceOf(FragtFejl);
    expect(err.brugerbesked).toMatch(/Pakkeshops kunne ikke hentes/);
    expect(kald).toHaveLength(1);
  });

  it("hentPakkeshop finder id'et i søgningen nær køberen", async () => {
    saetSvar(jsonSvar(fixture("findpakkeshop_ok.json")));
    const p = await daoFirma.hentPakkeshop("9102", { postnummer: "8200" });
    expect(p?.navn).toBe("Testkiosken Nord");
    expect(await daoFirma.hentPakkeshop("../x", { postnummer: "8200" })).toBeNull();
  });
});

describe("annullering", () => {
  it("OK", async () => {
    saetSvar(jsonSvar(fixture("annuller_ok.json")));
    await daoFirma.annullerForsendelse("00057099990000412345");
    expect(kald[0].url.pathname).toBe("/AnnullerePakke.php");
    expect(kald[0].url.searchParams.get("stregkode")).toBe("00057099990000412345");
  });

  it("FEJL (fx indleveret): FragtFejl - labelen bliver aktiv, aldrig 'annulleret' i BidHamr", async () => {
    saetSvar(jsonSvar(fixture("annuller_fejl.json")));
    const err = await daoFirma.annullerForsendelse("00057099990000412345").catch((e) => e);
    expect(err).toBeInstanceOf(FragtFejl);
    expect(err.name).not.toBe("FragtAnnulleringIkkeMulig");
    expect(err.brugerbesked).toMatch(/kan ikke annullere/);
  });

  it("timeout: almindelig fejl (ikke FragtFejl) - serveren ruller tilbage og markerer staff", async () => {
    saetSvar(timeout());
    const err = await daoFirma.annullerForsendelse("00057099990000412345").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FragtFejl);
    expect(err).not.toBeInstanceOf(FragtUkendtUdfald);
    ingenHemmeligheder(err.message);
    expect(kald).toHaveLength(1);
  });
});

describe("sporing", () => {
  it("opslag på stregkode", async () => {
    saetSvar(jsonSvar(fixture("tracktrace_stregkode.json")));
    const hs = await daoFirma.hentSporing("00057099990000412345");
    expect(hs.map((h) => h.type)).toEqual(["i_transit", "i_transit"]);
    expect(kald[0].url.pathname).toBe("/TrackNTrace_v2.php");
  });

  it("feed med token: token sendes, nyt token og ukendte koder kommer tilbage", async () => {
    saetSvar(jsonSvar(fixture("tracktrace_token_1.json")));
    const f = await daoFirma.hentSporingFeed!("0");
    expect(kald[0].url.searchParams.get("token")).toBe("0");
    expect(kald[0].url.searchParams.get("stregkode")).toBeNull();
    expect(f.nyToken).toBe("1000234");
    expect(f.haendelser).toHaveLength(2);
    expect(f.ukendte.map((u) => u.kode)).toEqual(["77"]);
  });

  it("feed uden token kaster (tokenet må ikke gemmes)", async () => {
    saetSvar(jsonSvar(fixture("tracktrace_uden_token.json")));
    await expect(daoFirma.hentSporingFeed!("1000234")).rejects.toThrow(/token/);
    await expect(daoFirma.hentSporingFeed!("abc")).rejects.toThrow(/token/);
  });

  it("ingen webhook", async () => {
    const r = await daoFirma.fortolkWebhook(new Request("https://bidhamr.dk/api/fragt/webhook/dao", { method: "POST" }));
    expect(r).toEqual({ ok: false, status: 404, fejl: "DAO har ingen webhook" });
  });
});

describe("efterlysning", () => {
  it("createclaim: bortkommet, stregkode, reference og pris i hele kroner - ét kald", async () => {
    saetSvar(jsonSvar(fixture("createclaim_ok.json")));
    await daoFirma.opretEfterlysning!("00057099990000412345", { reference: "abc", vaerdiOere: 45050 });
    const u = kald[0].url;
    expect(u.pathname).toBe("/createclaim.php");
    expect(u.searchParams.get("type")).toBe("bortkommet");
    expect(u.searchParams.get("pris")).toBe("451");
    expect(u.searchParams.get("referencenr")).toBe("abc");
  });

  it("timeout: ukendt udfald (staff tjekker - aldrig to efterlysninger)", async () => {
    saetSvar(timeout());
    await expect(daoFirma.opretEfterlysning!("00057099990000412345", { reference: "abc", vaerdiOere: 100 })).rejects.toBeInstanceOf(
      FragtUkendtUdfald,
    );
    expect(kald).toHaveLength(1);
  });
});

describe("hjælpere", () => {
  it("daoMobil: danske numre som 8 cifre", () => {
    expect(daoMobil("+4512345678")).toBe("12345678");
    expect(daoMobil("12 34 56 78")).toBe("12345678");
    expect(daoMobil("004512345678")).toBe("12345678");
    expect(daoMobil("+46701234567")).toBeNull();
    expect(daoMobil(null)).toBeNull();
  });

  it("ren() fjerner nøglerne fra enhver tekst", () => {
    const k = _test.laesKonfig()!;
    const url = _test.byggUrl(k, "/X.php", { a: 1 });
    expect(url).toContain(encodeURIComponent(KODE));
    ingenHemmeligheder(_test.ren(`kald til ${url} fejlede (${KODE})`));
  });

  it("fixtures med pæne anførselstegn kan bruges som ordresvar", async () => {
    saetSvar(jsonSvar(fixtureTekst("paene_anfoerselstegn.txt")), pdfSvar());
    const o = await daoFirma.opretForsendelse(input());
    expect(o.forsendelsesId).toBe("00057099990000455555");
    expect(o.qrKode).toBe("123 456 789");
  });
});
