// Parsning af DAO's svar (src/lib/fragt/daoParse.ts) mod egne eksempelsvar.
import { describe, expect, it } from "vitest";
import {
  aabningstider,
  daoTidTilIso,
  feedFraSvar,
  gyldigStregkode,
  pakkeshopsFraResultat,
  parseDaoJson,
  renLabelfriKode,
  saniter,
  sporingFraResultat,
  tolkHaendelse,
  tolkSvar,
} from "@/lib/fragt/daoParse";
import { fixture, fixtureTekst } from "./fixtures";

describe("tolkSvar", () => {
  it("OK med resultat", () => {
    const s = tolkSvar(fixture("c2c_ok.json"));
    expect(s.status).toBe("ok");
    if (s.status === "ok") expect((s.resultat as { stregkode: string }).stregkode).toBe("00057099990000412345");
  });

  it("HTTP 200 med FEJL er en fejl (status skal læses)", () => {
    expect(tolkSvar(fixture("ordre_fejl.json"))).toEqual({ status: "fejl", fejlkode: "1", fejltekst: "Vej ikke fundet" });
  });

  it("FindPakkeshop svarer ERROR i stedet for FEJL", () => {
    expect(tolkSvar(fixture("findpakkeshop_error.json"))).toEqual({
      status: "fejl",
      fejlkode: "12",
      fejltekst: "Adresse kunne ikke findes",
    });
  });

  it("engelske feltnavne (pickup-endpoints) og små bogstaver", () => {
    expect(tolkSvar({ Status: "ok", Result: { barcode: "X" } }).status).toBe("ok");
    expect(tolkSvar({ status: "ERROR", errorcode: 7, errortext: "Bad" })).toEqual({
      status: "fejl",
      fejlkode: "7",
      fejltekst: "Bad",
    });
  });

  it("uden status er svaret ugyldigt - aldrig OK", () => {
    expect(tolkSvar({ resultat: { stregkode: "123" } }).status).toBe("ugyldig");
    expect(tolkSvar(null).status).toBe("ugyldig");
    expect(tolkSvar("OK").status).toBe("ugyldig");
    expect(tolkSvar([]).status).toBe("ugyldig");
  });
});

describe("parseDaoJson", () => {
  it("retter pæne anførselstegn som i dokumentationens eksempler", () => {
    const s = tolkSvar(parseDaoJson(fixtureTekst("paene_anfoerselstegn.txt")));
    expect(s.status).toBe("ok");
  });
  it("BOM og tomt svar", () => {
    expect(parseDaoJson('﻿{"status":"OK"}')).toEqual({ status: "OK" });
    expect(parseDaoJson("")).toBeNull();
    expect(parseDaoJson("<html>fejl</html>")).toBeNull();
  });
  it("et ” inde i en rigtig værdi bevares", () => {
    expect(parseDaoJson('{"navn":"Kiosk ”Hjørnet”"}')).toEqual({ navn: "Kiosk ”Hjørnet”" });
  });
});

describe("pakkeshops", () => {
  const s = tolkSvar(fixture("findpakkeshop_ok.json"));
  const shops = s.status === "ok" ? pakkeshopsFraResultat(s.resultat) : [];

  it("nærmeste først, uden dubletter", () => {
    expect(shops.map((p) => p.id)).toEqual(["9101", "9102", "9103"]);
  });

  it("tal som tekst, afstand i meter (også med komma)", () => {
    const nord = shops.find((p) => p.id === "9102")!;
    expect(nord.afstandM).toBe(1400);
    expect(nord.lat).toBeCloseTo(56.1801);
    expect(nord.lng).toBeCloseTo(10.1902);
    expect(nord.postnummer).toBe("8200");
    expect(nord.by).toBe("Aarhus N");
    const tank = shops.find((p) => p.id === "9103")!;
    expect(tank.lat).toBeNull();
    expect(tank.lng).toBeNull();
    expect(tank.aabningstider).toEqual([]);
  });

  it("åbningstider man-søn -> danske dagnavne i rækkefølge", () => {
    const nord = shops.find((p) => p.id === "9102")!;
    expect(nord.aabningstider.map((d) => d.dag)).toEqual([
      "Mandag",
      "Tirsdag",
      "Onsdag",
      "Torsdag",
      "Fredag",
      "Lørdag",
      "Søndag",
    ]);
    expect(nord.aabningstider[5].tider).toBe("09:00 - 18:00");
    expect(aabningstider({ lør: "10-14" })).toEqual([{ dag: "Lørdag", tider: "10-14" }]);
  });
});

describe("tid", () => {
  it("dansk tid uden tidszone -> UTC (sommer og vinter)", () => {
    expect(daoTidTilIso("2026-07-01 12:00:00")).toBe("2026-07-01T10:00:00.000Z");
    expect(daoTidTilIso("2026-12-01 12:00:00")).toBe("2026-12-01T11:00:00.000Z");
    expect(daoTidTilIso("2026-10-25 01:30")).toBe("2026-10-24T23:30:00.000Z");
  });
  it("med tidszone bruges den", () => {
    expect(daoTidTilIso("2026-07-01T12:00:00Z")).toBe("2026-07-01T12:00:00.000Z");
  });
  it("ugyldige tidspunkter", () => {
    for (const v of ["ikke en dato", "2026-13-01 10:00:00", "", null, 5]) expect(daoTidTilIso(v)).toBeNull();
  });
});

describe("koder", () => {
  it("stregkode og labelfri kode", () => {
    expect(gyldigStregkode("00057099990000412345")).toBe(true);
    expect(gyldigStregkode("x")).toBe(false);
    expect(gyldigStregkode("123 456")).toBe(false);
    expect(renLabelfriKode(" 482  913 556 ")).toBe("482 913 556");
    expect(renLabelfriKode("<script>")).toBeNull();
  });
});

describe("sporing", () => {
  it("opslag på stregkode: kendte koder bliver hændelser, ukendte rapporteres, ugyldige droppes", () => {
    const s = tolkSvar(fixture("tracktrace_stregkode.json"));
    if (s.status !== "ok") throw new Error("forventede OK");
    const r = sporingFraResultat("00057099990000412345", s.resultat);
    expect(r.haendelser.map((h) => h.type)).toEqual(["i_transit", "i_transit"]);
    expect(r.haendelser[0].tidspunkt).toBe("2026-10-14T06:05:00.000Z");
    expect(r.ukendte).toEqual([
      { kode: "87", liste: "pakkeshop", beskrivelse: "Ukendt hændelse i eksemplet", sporingsnummer: "00057099990000412345" },
    ]);
  });

  it("samme nøgle i feedet og ved opslag på stregkoden (idempotent)", () => {
    const a = tolkHaendelse("00057099990000412345", { tidspunkt: "2026-10-14 08:05:00", haendelse: 10 });
    const b = tolkHaendelse("00057099990000412345", { tidspunkt: "2026-10-14 08:05:00", haendelse: "10", beskrivelse: "x" });
    expect(a.slags).toBe("kendt");
    if (a.slags === "kendt" && b.slags === "kendt") {
      expect(a.haendelse.noegle).toBe(b.haendelse.noegle);
      expect(a.haendelse.noegle).toBe("dao:00057099990000412345:10:2026-10-14 08:05:00");
    }
  });

  it("HOME: teksten i 'sted' bruges, når beskrivelsen mangler", () => {
    const r = tolkHaendelse("00057099990000498765", { tidspunkt: "2026-10-14 08:05:00", haendelse: 10, sted: "Ved hoveddøren" });
    expect(r.slags === "kendt" && r.haendelse.beskrivelse).toBe("Ved hoveddøren");
  });
});

describe("feed (token)", () => {
  it("første svar: nyt token, hændelser for gyldige stregkoder og ukendte koder", () => {
    const rod = fixture("tracktrace_token_1.json") as Record<string, unknown>;
    const s = tolkSvar(rod);
    if (s.status !== "ok") throw new Error("forventede OK");
    const f = feedFraSvar(s.rod, s.resultat);
    expect(f.nyToken).toBe("1000234");
    expect(f.pakker).toBe(2);
    expect(f.haendelser).toHaveLength(2);
    expect(f.haendelser.every((h) => h.sporingsnummer === "00057099990000412345")).toBe(true);
    expect(f.ukendte.map((u) => u.kode)).toEqual(["77"]);
  });

  it("token som tal og ingen hændelser", () => {
    const s = tolkSvar(fixture("tracktrace_token_2.json"));
    if (s.status !== "ok") throw new Error("forventede OK");
    const f = feedFraSvar(s.rod, s.resultat);
    expect(f.nyToken).toBe("1000240");
    expect(f.haendelser).toEqual([]);
  });

  it("uden gyldigt token kastes der - så gemmes intet", () => {
    const s = tolkSvar(fixture("tracktrace_uden_token.json"));
    if (s.status !== "ok") throw new Error("forventede OK");
    expect(() => feedFraSvar(s.rod, s.resultat)).toThrow(/token/);
    expect(() => feedFraSvar({ token: "abc" }, [])).toThrow(/token/);
    expect(() => feedFraSvar({ token: "-1" }, [])).toThrow(/token/);
  });
});

describe("saniter (kundeid og kode må aldrig logges)", () => {
  const url = "https://api.dao.as/DAOPakkeshop/FindPakkeshop.php?kundeid=12345&kode=Hemmelig%2BKode1&postnr=8200";

  it("URL'er afkortes til sti, og hemmelighederne fjernes", () => {
    const t = saniter(`Fejl ved ${url}: timeout`, ["Hemmelig+Kode1", "12345"]);
    expect(t.startsWith("Fejl ved https://api.dao.as/DAOPakkeshop/FindPakkeshop.php")).toBe(true);
    expect(t).not.toContain("?");
    expect(t).not.toMatch(/Hemmelig|12345|kode=|kundeid=/);
  });

  it("query-parametre uden for en URL", () => {
    const t = saniter("GET /HentLabel.php?kundeid=777&kode=abc123&stregkode=1", []);
    expect(t).toContain("kundeid=[skjult]");
    expect(t).toContain("kode=[skjult]");
    expect(t).not.toMatch(/777|abc123/);
    // labellesskode= er ikke en hemmelighed
    expect(saniter("labellesskode=123", [])).toBe("labellesskode=123");
  });

  it("selve værdierne, også URL-kodet, hvor de end står", () => {
    const t = saniter("koden er Hemmelig+Kode1 eller Hemmelig%2BKode1", ["Hemmelig+Kode1"]);
    expect(t).not.toMatch(/Hemmelig/);
  });
});
