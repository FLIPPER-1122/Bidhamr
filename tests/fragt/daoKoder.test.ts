// Mapping af DAO's hændelseskoder (src/lib/fragt/daoKoder.ts).
import { describe, expect, it } from "vitest";
import {
  DAO_KODER,
  DAO_RETUR_ER_IKKE_AFHENTET,
  daoKodeTilType,
  listeFraPakketype,
  normaliserKode,
} from "@/lib/fragt/daoKoder";
import { SPORINGS_TYPER } from "@/lib/fragt/types";

describe("normaliserKode", () => {
  it("læser tal og tekst ens", () => {
    expect(normaliserKode(10)).toBe("10");
    expect(normaliserKode("10")).toBe("10");
    expect(normaliserKode(" 010 ")).toBe("10");
  });
  it("afviser alt andet", () => {
    for (const v of [null, undefined, "", "abc", "1.5", "-1", "1234567", {}, []]) {
      expect(normaliserKode(v)).toBeNull();
    }
  });
});

describe("daoKodeTilType", () => {
  it("kender dokumentationens eksempler (10, 11) som 'undervejs'", () => {
    expect(daoKodeTilType(10, null)).toBe("i_transit");
    expect(daoKodeTilType("11", "pakkeshop")).toBe("i_transit");
    expect(daoKodeTilType(11, "direkte")).toBe("i_transit");
  });

  it("sikker standard: en ukendt kode giver ingen type (ingen statusændring)", () => {
    expect(daoKodeTilType(87, "pakkeshop")).toBeNull();
    expect(daoKodeTilType(999999, null)).toBeNull();
    expect(daoKodeTilType("ikke-tal", null)).toBeNull();
  });

  it("alle regler peger på en gyldig sporingstype og har en kilde", () => {
    for (const [kode, regler] of Object.entries(DAO_KODER)) {
      expect(normaliserKode(kode)).toBe(kode);
      for (const r of regler) {
        expect(SPORINGS_TYPER).toContain(r.type);
        expect(r.kilde.length).toBeGreaterThan(5);
      }
    }
  });

  it("gætter ikke 'leveret' eller 'returneret', før koderne er bekræftet", () => {
    // Når de rigtige koder kendes (TrackNTraceKoder.php + rigtige pakker),
    // ændres denne test sammen med tabellen.
    const typer = Object.values(DAO_KODER).flatMap((r) => r.map((x) => x.type));
    expect(typer).not.toContain("leveret");
    expect(typer).not.toContain("returneret");
  });
});

describe("listeFraPakketype", () => {
  it("Home/Direkte og Shop", () => {
    expect(listeFraPakketype("Home")).toBe("direkte");
    expect(listeFraPakketype("direkte")).toBe("direkte");
    expect(listeFraPakketype("Shop")).toBe("pakkeshop");
    expect(listeFraPakketype("")).toBeNull();
    expect(listeFraPakketype("Global")).toBeNull();
    expect(listeFraPakketype(undefined)).toBeNull();
  });
});

describe("ikke afhentet", () => {
  it("er slået fra, indtil returkoden er set på en rigtig pakke", () => {
    expect(DAO_RETUR_ER_IKKE_AFHENTET).toBe(false);
  });
});
