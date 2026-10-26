// Rene regler for gratis periode og introrabat (src/lib/erhverv/abonnementRegler.ts).
// Stripe-delen er "mocket" ved at efterligne Stripes regel for en kupon med
// duration 'repeating': den gælder alle fakturaer i [start, start + K måneder).
// Den rigtige opførsel er også testet mod Stripes testmiljø med test clocks
// (scripts/stripe-test-firmapakker.mjs).
import { describe, expect, it } from "vitest";
import {
  gyldigBegrundelse,
  introKuponMaaneder,
  introResterende,
  nyGratisSlut,
  plusMaaneder,
} from "@/lib/erhverv/abonnementRegler";
import { ERHVERV_FEJL, erhvervFejlTekst, erStoerrePakke, kvoteBrugt } from "@/lib/erhverv/regler";

const sek = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const iso = (s: number) => new Date(s * 1000).toISOString();

// Fakturaer i et månedligt abonnement fra 'forste' (fx trial_end), og hvilke
// af dem en kupon sat på ved 'paaSat' med varighed K måneder giver rabat på.
function rabatFakturaer(paaSat: number, k: number, forste: number, antal = 24): number[] {
  const slut = plusMaaneder(paaSat, k);
  const ud: number[] = [];
  for (let i = 0; i < antal; i++) {
    const f = plusMaaneder(forste, i);
    if (f >= paaSat && f < slut) ud.push(i);
  }
  return ud;
}

describe("plusMaaneder (som Stripe)", () => {
  it("lægger kalendermåneder til og bruger månedens sidste dag", () => {
    expect(iso(plusMaaneder(sek("2026-10-26T21:00:00Z"), 1))).toBe("2026-11-26T21:00:00.000Z");
    expect(iso(plusMaaneder(sek("2027-01-31T10:00:00Z"), 1))).toBe("2027-02-28T10:00:00.000Z");
    expect(iso(plusMaaneder(sek("2028-01-31T10:00:00Z"), 1))).toBe("2028-02-29T10:00:00.000Z");
    expect(iso(plusMaaneder(sek("2026-11-15T00:00:00Z"), 14))).toBe("2028-01-15T00:00:00.000Z");
  });
});

describe("introrabat: præcis N betalte fakturaer efter den gratis måned", () => {
  it("standard: 1 måned gratis + 50 % i 6 måneder (måned 2-7 halv pris)", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    const trialEnd = plusMaaneder(oprettet, 1);
    // Kuponen sættes på lige efter Checkout (nogle sekunder senere).
    const nu = oprettet + 5;
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
    expect(k).toBe(6);
    expect(rabatFakturaer(nu, k, trialEnd)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("3 gratis måneder + 50 % i 6: kuponen dækker de gratis måneder og 6 betalte", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    const trialEnd = plusMaaneder(oprettet, 3);
    const nu = oprettet + 60;
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
    expect(k).toBe(8);
    expect(rabatFakturaer(nu, k, trialEnd)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("sat midt i en betalt periode: de næste N fakturaer", () => {
    const naeste = sek("2026-11-14T08:00:00Z");
    const nu = sek("2026-10-30T12:00:00Z");
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: naeste, maaneder: 4, fra: "efter_gratis" });
    expect(k).toBe(4);
    expect(rabatFakturaer(nu, k, naeste)).toEqual([0, 1, 2, 3]);
  });

  it("'straks' tæller fra nu (gratis måneder bruger af rabatten)", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    // 3 gratis måneder: 'straks' 6 måneder dækker kun 4 betalte fakturaer.
    const trialEnd = plusMaaneder(oprettet, 3);
    const k = introKuponMaaneder({ nuSek: oprettet + 5, naesteFakturaSek: trialEnd, maaneder: 6, fra: "straks" });
    expect(k).toBe(6);
    expect(rabatFakturaer(oprettet + 5, k, trialEnd)).toEqual([0, 1, 2, 3]);
  });

  it("månedens sidste dage giver stadig præcis N", () => {
    for (const start of ["2027-01-31T23:00:00Z", "2027-03-30T10:00:00Z", "2026-12-31T12:00:00Z"]) {
      const oprettet = sek(start);
      const trialEnd = plusMaaneder(oprettet, 1);
      const nu = oprettet + 3;
      const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
      expect(rabatFakturaer(nu, k, trialEnd)).toHaveLength(6);
    }
  });

  it("resterende rabat-fakturaer og flytning ved en ny gratis periode", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    const trialEnd = plusMaaneder(oprettet, 1);
    const nu = oprettet + 5;
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
    const rabatSlut = plusMaaneder(nu, k);
    expect(introResterende({ naesteFakturaSek: trialEnd, rabatSlutSek: rabatSlut })).toBe(6);
    // To betalte fakturaer senere (næste faktura = trialEnd + 2 md.) er der 4 tilbage.
    expect(introResterende({ naesteFakturaSek: plusMaaneder(trialEnd, 2), rabatSlutSek: rabatSlut })).toBe(4);
    // Staff giver +2 gratis måneder midt i: kuponen sættes på igen med de 4.
    const senere = plusMaaneder(trialEnd, 1) + 86400 * 10;
    const nyNaeste = plusMaaneder(plusMaaneder(trialEnd, 2), 2);
    const k2 = introKuponMaaneder({ nuSek: senere, naesteFakturaSek: nyNaeste, maaneder: 4, fra: "efter_gratis" });
    expect(rabatFakturaer(senere, k2, nyNaeste)).toEqual([0, 1, 2, 3]);
    expect(introResterende({ naesteFakturaSek: trialEnd, rabatSlutSek: null })).toBe(0);
  });
});

describe("gratis periode", () => {
  it("forlænger en gratis periode, ellers starter den efter den betalte periode", () => {
    const nu = sek("2026-11-05T10:00:00Z");
    const trialEnd = sek("2026-11-27T09:00:00Z");
    expect(iso(nyGratisSlut({ status: "trialing", trialEndSek: trialEnd, periodeSlutSek: trialEnd, nuSek: nu, maaneder: 2 })))
      .toBe("2027-01-27T09:00:00.000Z");
    const periodeSlut = sek("2026-12-01T00:00:00Z");
    expect(iso(nyGratisSlut({ status: "active", trialEndSek: trialEnd, periodeSlutSek: periodeSlut, nuSek: nu, maaneder: 1 })))
      .toBe("2027-01-01T00:00:00.000Z");
  });

  it("begrundelse skal være 3-500 tegn", () => {
    expect(gyldigBegrundelse("  ok ")).toBeNull();
    expect(gyldigBegrundelse("Aftale  med\nHans")).toBe("Aftale med Hans");
    expect(gyldigBegrundelse("x".repeat(501))).toBeNull();
    expect(gyldigBegrundelse(42)).toBeNull();
  });
});

describe("pakker og kvote", () => {
  const start = { auktioner_pr_maaned: 10, fremhaevninger_pr_maaned: 0, maanedspris: 499 };
  const butik = { auktioner_pr_maaned: 30, fremhaevninger_pr_maaned: 5, maanedspris: 999 };
  const pro = { auktioner_pr_maaned: null, fremhaevninger_pr_maaned: 20, maanedspris: 1999 };
  it("Start < Butik < Pro (ubegrænset er størst)", () => {
    expect(erStoerrePakke(butik, start)).toBe(true);
    expect(erStoerrePakke(pro, butik)).toBe(true);
    expect(erStoerrePakke(start, pro)).toBe(false);
    expect(erStoerrePakke(start, start)).toBe(false);
  });
  it("ubegrænset kvote er aldrig brugt", () => {
    expect(kvoteBrugt({ brugt: 500, max: null })).toBe(false);
    expect(kvoteBrugt({ brugt: 10, max: 10 })).toBe(true);
    expect(kvoteBrugt({ brugt: 9, max: 10 })).toBe(false);
  });
  it("BHE03 vises med databasens nye tekst", () => {
    const db = "erhverv_kvote: Du har oprettet 10 af 10 auktioner i denne måned. Du kan oprette den næste den 1. november.";
    expect(erhvervFejlTekst(db, "BHE03")).toBe(
      "Du har oprettet 10 af 10 auktioner i denne måned. Du kan oprette den næste den 1. november.",
    );
    expect(erhvervFejlTekst("erhverv_kvote: noget andet", "BHE03")).toBe(ERHVERV_FEJL.kvote);
  });
});
