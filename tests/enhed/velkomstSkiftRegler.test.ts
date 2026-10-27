// Rettelser 4 af måned 1-skiftet (27. okt. 2026): de rene regler bag appens
// GET /api/firma/skift-pakke, visning-tjekket, noten og alarm-nøglen.
import { describe, expect, it } from "vitest";
import {
  erVelkomstSkiftTil,
  rabatProcentPaaFaktura,
  retRabatAlarmNoegle,
  tolkVelkomstVisning,
  velkomstBetaltNote,
  velkomstSkiftTilbud,
  velkomstSkiftUdfald,
  velkomstVisning,
  oereMedRabat,
} from "@/lib/erhverv/abonnementRegler";

describe("tolkVelkomstVisning: en sendt, men ugyldig visning bliver aldrig stille til null", () => {
  it("mangler: null (serveren afgør, om den er krævet)", () => {
    expect(tolkVelkomstVisning(undefined)).toEqual({ ok: true, visning: null });
    expect(tolkVelkomstVisning(null)).toEqual({ ok: true, visning: null });
  });
  it("gyldige værdier fra siden og appen", () => {
    for (const v of ["velkomst:50", "intro:30", "saerpris:0", "venter", "ret_rabat"]) {
      expect(tolkVelkomstVisning(v)).toEqual({ ok: true, visning: v });
    }
  });
  it("ugyldige værdier afvises", () => {
    for (const v of ["", " ", "velkomst", "velkomst:abc", "intro:1000", "saerpris:5", "VENTER", 50, true, {}, ["venter"]]) {
      expect(tolkVelkomstVisning(v)).toEqual({ ok: false });
    }
  });
});

describe("erVelkomstSkiftTil: samme regel som siden (PakkeValg.fraVelkomst)", () => {
  const basis = { iVelkomstMaaned: true, stoerre: true, maaned1: "halv", maanedsprisKr: 999 };
  it("skift op til Butik/Pro i velkomstmåneden", () => expect(erVelkomstSkiftTil(basis)).toBe(true));
  it("ikke uden for velkomstmåneden, ikke ned, ikke til en gratis pakke, ikke uden pris", () => {
    expect(erVelkomstSkiftTil({ ...basis, iVelkomstMaaned: false })).toBe(false);
    expect(erVelkomstSkiftTil({ ...basis, stoerre: false })).toBe(false);
    expect(erVelkomstSkiftTil({ ...basis, maaned1: "gratis" })).toBe(false);
    expect(erVelkomstSkiftTil({ ...basis, maanedsprisKr: null })).toBe(false);
  });
  it("maaned1 ukendt (migration ikke kørt): som 'halv'", () => {
    expect(erVelkomstSkiftTil({ ...basis, maaned1: undefined })).toBe(true);
  });
});

const dato = (sek: number) => `dato:${sek}`;
function udfald(over: Partial<Parameters<typeof velkomstSkiftUdfald>[0]> = {}) {
  return velkomstSkiftUdfald({
    saerprisGaelder: false,
    aftale: { status: null, procent: null, maaneder: null, kuponId: null, noegle: null, gaelder: false },
    abonnement: { introer: [], andre: 0, introNoegle: null },
    dato,
    ...over,
  });
}

describe("velkomstSkiftTilbud: det appen viser er det serveren trækker", () => {
  it("velkomst: 50 % af Pro i øre, visning velkomst:50", () => {
    const t = velkomstSkiftTilbud(udfald(), 1999);
    expect(t).toEqual({
      udfald: "skift",
      visning: "velkomst:50",
      rabat: { slags: "velkomst", procent: 50 },
      beloeb: { eksklOere: oereMedRabat(1999, 50).ekskl, inklOere: oereMedRabat(1999, 50).inkl },
      kanSkifte: true,
    });
    expect(t.beloeb).toEqual({ eksklOere: 99_950, inklOere: 124_938 });
  });
  it("introrabat 30 % med slutdato fra Stripe", () => {
    const u = udfald({
      aftale: { status: "aktiv", procent: 30, maaneder: 3, kuponId: "bidhamr_intro_30_3", noegle: "n", gaelder: true },
      abonnement: { introer: [{ kuponId: "bidhamr_intro_30_3", procent: 30, slutSek: 1_800_000_000 }], andre: 0, introNoegle: null },
    });
    const t = velkomstSkiftTilbud(u, 999);
    expect(t.visning).toBe("intro:30");
    expect(t.rabat).toEqual({ slags: "intro", procent: 30, til: "dato:1800000000", maaneder: 3 });
    expect(t.beloeb).toEqual({ eksklOere: 69_930, inklOere: 87_413 });
    // Samme visning, som serveren sammenligner med.
    expect(t.visning).toBe(velkomstVisning(u));
  });
  it("venter: intet beløb, men en knap (rabatten sættes op)", () => {
    const u = udfald({ aftale: { status: "planlagt", procent: 30, maaneder: 3, kuponId: null, noegle: "n", gaelder: true } });
    expect(velkomstSkiftTilbud(u, 999)).toEqual({ udfald: "venter", visning: "venter", rabat: null, beloeb: null, kanSkifte: true });
  });
  it("ret_rabat: intet beløb og ingen knap", () => {
    const u = udfald({ abonnement: { introer: [], andre: 1, introNoegle: null } });
    expect(velkomstSkiftTilbud(u, 999)).toEqual({ udfald: "ret_rabat", visning: "ret_rabat", rabat: null, beloeb: null, kanSkifte: false });
  });
});

describe("noten på pakkeskiftet bruger fakturaens rigtige rabat", () => {
  it("rabatProcentPaaFaktura: rabat mod beløbet før rabat (ekskl. moms)", () => {
    expect(rabatProcentPaaFaktura(99_950, [{ amount: 99_950 }])).toBe(50);
    expect(rabatProcentPaaFaktura(139_930, [{ amount: 59_970 }])).toBe(30);
    expect(rabatProcentPaaFaktura(199_900, [])).toBe(0);
    expect(rabatProcentPaaFaktura(199_900, null)).toBe(0);
    expect(rabatProcentPaaFaktura(null, [{ amount: 1 }])).toBeNull();
    expect(rabatProcentPaaFaktura(0, [])).toBeNull();
  });
  it("velkomstBetaltNote: halv pris kun ved 50 %", () => {
    expect(velkomstBetaltNote(50)).toMatch(/til halv pris$/);
    expect(velkomstBetaltNote(30)).toMatch(/med 30 % rabat$/);
    expect(velkomstBetaltNote(30)).not.toMatch(/halv pris/);
    expect(velkomstBetaltNote(0)).toMatch(/til fuld pris$/);
    expect(velkomstBetaltNote(null)).not.toMatch(/halv|rabat|fuld/);
  });
});

describe("ret_rabat-alarmen: én nøgle pr. firma og aftale", () => {
  const FIRMA = "26849ab7-6678-47b7-a8bd-4d618dfdf9f3";
  const AFTALE = "0f0e0d0c-0b0a-4908-8706-050403020100";
  it("samme firma og aftale giver samme nøgle (databasen dedupper)", () => {
    expect(retRabatAlarmNoegle(FIRMA, AFTALE)).toBe(retRabatAlarmNoegle(FIRMA, AFTALE));
  });
  it("en ny aftale eller et andet firma giver en ny nøgle", () => {
    expect(retRabatAlarmNoegle(FIRMA, AFTALE)).not.toBe(retRabatAlarmNoegle(FIRMA, "1f0e0d0c-0b0a-4908-8706-050403020100"));
    expect(retRabatAlarmNoegle(FIRMA, AFTALE)).not.toBe(retRabatAlarmNoegle("36849ab7-6678-47b7-a8bd-4d618dfdf9f3", AFTALE));
    expect(retRabatAlarmNoegle(FIRMA, null)).not.toBe(retRabatAlarmNoegle(FIRMA, AFTALE));
  });
  it("passer til drift_fejl.digest (højst 100 tegn, kun [A-Za-z0-9_-])", () => {
    for (const n of [retRabatAlarmNoegle(FIRMA, AFTALE), retRabatAlarmNoegle(FIRMA, null)]) {
      expect(n).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    }
  });
});
