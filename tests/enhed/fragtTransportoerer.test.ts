// Fragtfirmaer (Filip, 20. okt. 2026): køberen kan kun vælge DAO og GLS (GLS
// med printet label), PostNord er slået fra, indtil SHIPMONDO_POSTNORD_AKTIV
// =true. Den ene liste (tilladteTransportoerer) bruges af checkout,
// pakkeshop-søgning, gem levering, betaling og databasen.
import { afterEach, describe, expect, it } from "vitest";
import {
  STANDARD_TRANSPORTOERER,
  TRANSPORTOER_INFO,
  tilladteTransportoerer,
  transportoerLukket,
} from "@/lib/fragt/types";
import { fragtfirmaNavne } from "@/lib/fragt";

describe("tilladteTransportoerer", () => {
  it("standard uden env: DAO og GLS", () => {
    expect(STANDARD_TRANSPORTOERER).toEqual(["dao", "gls"]);
    expect(tilladteTransportoerer({})).toEqual(["dao", "gls"]);
  });

  it("PostNord kun med SHIPMONDO_POSTNORD_AKTIV præcis 'true' (fail closed)", () => {
    for (const v of ["", "1", "TRUE", "ja", " true", "false"]) {
      expect(tilladteTransportoerer({ SHIPMONDO_POSTNORD_AKTIV: v })).toEqual(["dao", "gls"]);
    }
    expect(tilladteTransportoerer({ SHIPMONDO_POSTNORD_AKTIV: "true" })).toEqual(["dao", "gls", "postnord"]);
  });

  it("SHIPMONDO_GLS_AKTIV er bagudkompatibelt: 'true' er overflødigt, alt andet slår ikke GLS fra", () => {
    for (const v of ["true", "false", ""]) {
      expect(tilladteTransportoerer({ SHIPMONDO_GLS_AKTIV: v })).toEqual(["dao", "gls"]);
    }
    expect(tilladteTransportoerer({ SHIPMONDO_TRANSPORTOERER: "dao", SHIPMONDO_GLS_AKTIV: "true" })).toEqual(["dao", "gls"]);
  });

  it("SHIPMONDO_TRANSPORTOERER: liste i fast rækkefølge, ukendte ignoreres, intet gyldigt = standard", () => {
    expect(tilladteTransportoerer({ SHIPMONDO_TRANSPORTOERER: "dao" })).toEqual(["dao"]);
    expect(tilladteTransportoerer({ SHIPMONDO_TRANSPORTOERER: " GLS , dao,dao" })).toEqual(["dao", "gls"]);
    expect(tilladteTransportoerer({ SHIPMONDO_TRANSPORTOERER: "postnord,dao" })).toEqual(["dao", "postnord"]);
    expect(tilladteTransportoerer({ SHIPMONDO_TRANSPORTOERER: "bring,," })).toEqual(["dao", "gls"]);
    expect(tilladteTransportoerer({ SHIPMONDO_TRANSPORTOERER: "" })).toEqual(["dao", "gls"]);
  });
});

describe("transportoerLukket (dansk fejltekst)", () => {
  it("PostNord med standardlisten", () => {
    expect(transportoerLukket("postnord", ["dao", "gls"])).toBe("PostNord kan ikke vælges lige nu. Vælg DAO eller GLS.");
  });
  it("én eller flere andre", () => {
    expect(transportoerLukket("gls", ["dao"])).toBe("GLS kan ikke vælges lige nu. Vælg DAO.");
    expect(transportoerLukket("dao", ["gls", "postnord"])).toBe("DAO kan ikke vælges lige nu. Vælg GLS eller PostNord.");
  });
});

describe("GLS kræver printet label", () => {
  it("GLS har ingen labelfri udgående; DAO har kode", () => {
    expect(TRANSPORTOER_INFO.gls.labelfri).toBeNull();
    expect(TRANSPORTOER_INFO.dao.labelfri).toBe("kode");
  });
});

describe("fragtfirmaNavne (teksten på auktionssiden)", () => {
  afterEach(() => {
    delete process.env.FRAGTFIRMA;
    delete process.env.SHIPMONDO_POSTNORD_AKTIV;
  });
  it("Shipmondo: DAO og GLS", () => {
    process.env.FRAGTFIRMA = "shipmondo";
    expect(fragtfirmaNavne()).toEqual(["DAO", "GLS"]);
  });
  it("med SHIPMONDO_POSTNORD_AKTIV=true: også PostNord", () => {
    process.env.FRAGTFIRMA = "shipmondo";
    process.env.SHIPMONDO_POSTNORD_AKTIV = "true";
    expect(fragtfirmaNavne()).toEqual(["DAO", "GLS", "PostNord"]);
  });
});

// DAO's handelsbetingelser (Filip, 20. okt. 2026): kun DAO kræver accept.
describe("kraeverDaoBetingelser", () => {
  it("DAO direkte og Shipmondo med DAO (eller uden transportør)", async () => {
    const { kraeverDaoBetingelser, DAO_BETINGELSER } = await import("@/lib/fragt/betingelser");
    expect(kraeverDaoBetingelser("dao", null)).toBe(true);
    expect(kraeverDaoBetingelser("shipmondo", "dao")).toBe(true);
    expect(kraeverDaoBetingelser("shipmondo", null)).toBe(true);
    expect(kraeverDaoBetingelser("shipmondo", "gls")).toBe(false);
    expect(kraeverDaoBetingelser("shipmondo", "postnord")).toBe(false);
    expect(kraeverDaoBetingelser("test", null)).toBe(false);
    expect(kraeverDaoBetingelser(null, null)).toBe(false);
    expect(DAO_BETINGELSER.url).toBe("https://dao.as/handelsbetingelser/");
  });
});
