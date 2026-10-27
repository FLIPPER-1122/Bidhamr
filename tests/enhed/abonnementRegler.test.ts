// Rene regler for gratis periode og introrabat (src/lib/erhverv/abonnementRegler.ts).
// Stripe-delen er "mocket" ved at efterligne Stripes regel for en kupon med
// duration 'repeating': den gælder alle fakturaer i [start, start + K måneder).
// Den rigtige opførsel er også testet mod Stripes testmiljø med test clocks
// (scripts/stripe-test-firmapakker.mjs).
import { describe, expect, it } from "vitest";
import {
  gyldigBegrundelse,
  gyldigSaeraftaleBegrundelse,
  introGaelder,
  saerprisGaelder,
  velkomstMaanederVedOprettelse,
  checkoutPlan,
  erKunVelkomstGratis,
  maaned1Regel,
  INTRO_MARGIN_SEK,
  introKuponMaaneder,
  introKuponMaanederCheckout,
  introPasser,
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
  // K skal findes (ikke null) og give præcis N for et hvilket som helst
  // tidspunkt i vinduet [nu, nu + margin], hvor Stripe sætter discount.start.
  function praecis(nu: number, naeste: number, n: number, k: number | null, margin = INTRO_MARGIN_SEK) {
    expect(k).not.toBeNull();
    for (const st of [nu, nu + 1, nu + Math.floor(margin / 2), nu + margin]) {
      expect(rabatFakturaer(st, k!, naeste)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  }

  it("standard: 1 måned gratis + 50 % i 6 måneder (måned 2-7 halv pris)", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    const trialEnd = plusMaaneder(oprettet, 1);
    // Kuponen sættes på lige efter Checkout (nogle sekunder senere).
    const nu = oprettet + 5;
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
    expect(k).toBe(6);
    praecis(nu, trialEnd, 6, k);
  });

  it("3 gratis måneder + 50 % i 6: kuponen dækker de gratis måneder og 6 betalte", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    const trialEnd = plusMaaneder(oprettet, 3);
    const nu = oprettet + 60;
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
    expect(k).toBe(8);
    praecis(nu, trialEnd, 6, k);
  });

  it("sat midt i en betalt periode: de næste N fakturaer", () => {
    const naeste = sek("2026-11-14T08:00:00Z");
    const nu = sek("2026-10-30T12:00:00Z");
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: naeste, maaneder: 4, fra: "efter_gratis" });
    expect(k).toBe(4);
    praecis(nu, naeste, 4, k);
  });

  it("'straks' tæller fra nu (gratis måneder bruger af rabatten)", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    // 3 gratis måneder: 'straks' 6 måneder dækker kun 4 betalte fakturaer.
    const trialEnd = plusMaaneder(oprettet, 3);
    const k = introKuponMaaneder({ nuSek: oprettet + 5, naesteFakturaSek: trialEnd, maaneder: 6, fra: "straks" });
    expect(k).toBe(6);
    expect(rabatFakturaer(oprettet + 5, k!, trialEnd)).toEqual([0, 1, 2, 3]);
  });

  it("sat den 31. med fakturaer den 28. (feb.): aldrig N+1 (fejl i den gamle beregning)", () => {
    // Gammel regel: K = 3 -> rabat 28. feb., 28. mar. OG 28. apr. (3 i stedet for 2).
    const nu = sek("2027-01-31T10:00:00Z");
    const naeste = sek("2027-02-28T12:00:00Z");
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: naeste, maaneder: 2, fra: "efter_gratis" });
    expect(k).toBe(2);
    praecis(nu, naeste, 2, k);
  });

  it("start + K vokser ikke altid med start (29. jan. 23:47 vs. 30. jan. 00:47 + 1 md.)", () => {
    const nu = sek("2026-01-29T23:47:15Z");
    const naeste = sek("2026-01-31T20:25:43Z");
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: naeste, maaneder: 1, fra: "efter_gratis", marginSek: 3600 });
    // Fra 29. jan. 23:47 ville K = 1 give 2 fakturaer (31. jan. og 28. feb.).
    if (k != null) praecis(nu, naeste, 1, k, 3600);
    else expect(k).toBeNull();
  });

  it("ved månedsskifte findes der ikke altid et K: null (aldrig N-1 eller N+1), og det passer igen inden for et døgn", () => {
    // Fakturaer den 30. (28. feb.) kl. 23; kuponen sat den 31. kl. 01.
    const naeste = sek("2026-09-30T23:00:00Z");
    const nu = sek("2026-08-31T01:00:00Z");
    expect(introKuponMaaneder({ nuSek: nu, naesteFakturaSek: naeste, maaneder: 6, fra: "efter_gratis" })).toBeNull();
    let t = nu;
    while (introKuponMaaneder({ nuSek: t, naesteFakturaSek: naeste, maaneder: 6, fra: "efter_gratis" }) == null) t += 300;
    expect(t - nu).toBeLessThan(86_400);
    praecis(t, naeste, 6, introKuponMaaneder({ nuSek: t, naesteFakturaSek: naeste, maaneder: 6, fra: "efter_gratis" }));
  });

  it("kanttilfælde: den 31., den 30., februar, skudår og sommertid giver præcis N eller null", () => {
    const tider = [
      "2027-01-31T23:00:00Z", // 31. jan. -> feb. (ikke skudår)
      "2028-01-31T23:00:00Z", // skudår: 29. feb.
      "2028-01-30T22:30:00Z",
      "2028-02-29T12:00:00Z", // skuddag
      "2026-03-30T10:00:00Z",
      "2026-03-31T23:59:59Z",
      "2026-08-30T23:00:00Z", // Checkout 30. aug. kl. 23
      "2026-08-31T01:00:00Z",
      "2026-12-31T12:00:00Z",
      "2026-03-29T00:30:00Z", // sommertid starter (dansk tid 01:30 -> 03:30)
      "2026-03-29T01:30:00Z",
      "2026-10-25T00:30:00Z", // sommertid slutter
      "2026-10-25T01:30:00Z",
    ];
    for (const start of tider) {
      for (const gratis of [1, 2, 3]) {
        for (const n of [1, 2, 6, 12]) {
          const oprettet = sek(start);
          const trialEnd = plusMaaneder(oprettet, gratis);
          for (const forsinkelse of [3, 3600, 7200, 86_399]) {
            const nu = oprettet + forsinkelse;
            const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: n, fra: "efter_gratis" });
            if (k != null) praecis(nu, trialEnd, n, k);
          }
        }
      }
    }
  });

  it("tilfældige tidspunkter: K giver altid præcis N i hele vinduet (eller null)", () => {
    let x = 12345;
    const tilfaeldig = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const base = sek("2026-01-01T00:00:00Z");
    let nuller = 0;
    for (let i = 0; i < 3000; i++) {
      const nu = base + Math.floor(tilfaeldig() * 3 * 365 * 86_400);
      const naeste = nu + 600 + Math.floor(tilfaeldig() * 90 * 86_400);
      const n = 1 + Math.floor(tilfaeldig() * 12);
      const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: naeste, maaneder: n, fra: "efter_gratis" });
      if (k == null) nuller++;
      else praecis(nu, naeste, n, k);
    }
    expect(nuller).toBeLessThan(30);
  });

  it("resterende rabat-fakturaer og flytning ved en ny gratis periode", () => {
    const oprettet = sek("2026-10-27T09:00:00Z");
    const trialEnd = plusMaaneder(oprettet, 1);
    const nu = oprettet + 5;
    const k = introKuponMaaneder({ nuSek: nu, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" })!;
    const rabatSlut = plusMaaneder(nu, k);
    expect(introResterende({ naesteFakturaSek: trialEnd, rabatSlutSek: rabatSlut })).toBe(6);
    expect(introPasser({ naesteFakturaSek: trialEnd, rabatSlutSek: rabatSlut, maaneder: 6 })).toBe(true);
    // To betalte fakturaer senere (næste faktura = trialEnd + 2 md.) er der 4 tilbage.
    expect(introResterende({ naesteFakturaSek: plusMaaneder(trialEnd, 2), rabatSlutSek: rabatSlut })).toBe(4);
    // Staff giver +2 gratis måneder midt i: kuponen sættes på igen med de 4.
    const senere = plusMaaneder(trialEnd, 1) + 86400 * 10;
    const nyNaeste = plusMaaneder(plusMaaneder(trialEnd, 2), 2);
    const k2 = introKuponMaaneder({ nuSek: senere, naesteFakturaSek: nyNaeste, maaneder: 4, fra: "efter_gratis" });
    praecis(senere, nyNaeste, 4, k2);
    expect(introResterende({ naesteFakturaSek: trialEnd, rabatSlutSek: null })).toBe(0);
  });
});

describe("introkupon allerede i Checkout", () => {
  it("abonnementet oprettes inden for en time: præcis N betalte fakturaer", () => {
    for (const [nu, gratis, n] of [
      ["2026-10-27T10:00:00Z", 1, 6],
      ["2026-01-31T23:30:00Z", 1, 6],
      ["2026-03-15T08:00:00Z", 3, 2],
      ["2026-12-31T12:00:00Z", 2, 1],
      ["2028-01-31T22:00:00Z", 1, 6],
    ] as const) {
      const nuSek = sek(nu);
      const trialEnd = plusMaaneder(nuSek, gratis);
      const k = introKuponMaanederCheckout({ nuSek, trialEndSek: trialEnd, maaneder: n, fra: "efter_gratis" });
      expect(k).not.toBeNull();
      for (const forsinkelse of [1, 600, 3600]) {
        expect(rabatFakturaer(nuSek + forsinkelse, k!, trialEnd)).toEqual(Array.from({ length: n }, (_, i) => i));
      }
    }
  });

  it("Checkout 30. aug. kl. 23, abonnementet oprettet 31. aug. kl. 01: spejlingen opdager det og sætter rabatten på igen", () => {
    const nuSek = sek("2026-08-30T23:00:00Z");
    const trialEnd = plusMaaneder(nuSek, 1); // 30. sep. kl. 23
    const n = 6;
    const k = introKuponMaanederCheckout({ nuSek, trialEndSek: trialEnd, maaneder: n, fra: "efter_gratis" });
    // Abonnementet oprettes to timer senere - efter Checkout-vinduet.
    const oprettet = sek("2026-08-31T01:00:00Z");
    if (k != null) {
      // Kuponen fra Checkout tæller fra oprettelsen. Rammer den ikke præcis N,
      // ser spejlingen det (introPasser) ...
      const passer = introPasser({ naesteFakturaSek: trialEnd, rabatSlutSek: plusMaaneder(oprettet, k), maaneder: n });
      expect(passer).toBe(rabatFakturaer(oprettet, k, trialEnd).length === n);
    }
    // ... og sætter den på igen fra et tidspunkt, hvor det kan gøres præcist
    // (her ikke før 31. aug. sidst på dagen) - aldrig N-1 eller N+1.
    let t = oprettet;
    let k2: number | null = null;
    while ((k2 = introKuponMaaneder({ nuSek: t, naesteFakturaSek: trialEnd, maaneder: n, fra: "efter_gratis" })) == null) t += 300;
    expect(t).toBeLessThan(trialEnd);
    expect(rabatFakturaer(t, k2, trialEnd)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("introPasser: N-1 og N+1 opdages", () => {
    const trialEnd = sek("2026-09-30T23:00:00Z");
    // 31. aug. 01:00 + 6 md. = 28. feb. 01:00: rabatten slutter før 6. faktura (28. feb. 23:00).
    expect(introPasser({ naesteFakturaSek: trialEnd, rabatSlutSek: plusMaaneder(sek("2026-08-31T01:00:00Z"), 6), maaneder: 6 })).toBe(false);
    // + 7 md. = 31. mar. 01:00: også 7. faktura (30. mar. 23:00) får rabat.
    expect(introPasser({ naesteFakturaSek: trialEnd, rabatSlutSek: plusMaaneder(sek("2026-08-31T01:00:00Z"), 7), maaneder: 6 })).toBe(false);
    expect(introPasser({ naesteFakturaSek: trialEnd, rabatSlutSek: plusMaaneder(sek("2026-09-01T01:00:00Z"), 6), maaneder: 6 })).toBe(true);
  });

  it("uden gratis periode og ved 'straks' tæller den fra oprettelsen", () => {
    const nuSek = sek("2026-10-27T10:00:00Z");
    expect(introKuponMaanederCheckout({ nuSek, trialEndSek: null, maaneder: 6, fra: "efter_gratis" })).toBe(6);
    expect(introKuponMaanederCheckout({ nuSek, trialEndSek: plusMaaneder(nuSek, 1), maaneder: 6, fra: "straks" })).toBe(6);
    expect(rabatFakturaer(nuSek + 60, 6, nuSek + 60)).toEqual([0, 1, 2, 3, 4, 5]);
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

describe("særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026)", () => {
  const nu = new Date("2026-10-27T12:00:00Z").getTime();
  it("en introrabat gælder, når den er planlagt eller kører - ikke når den er slut", () => {
    expect(introGaelder({ intro_procent: 50, intro_til: null }, nu)).toBe(true);
    expect(introGaelder({ intro_procent: 50, intro_til: "2027-04-27T12:00:00Z" }, nu)).toBe(true);
    // Udløbet, men endnu ikke meldt færdig af Stripe (intro_status står stadig 'aktiv').
    expect(introGaelder({ intro_procent: 50, intro_til: "2026-10-27T11:59:59Z" }, nu)).toBe(false);
    expect(introGaelder({ intro_procent: null, intro_til: null }, nu)).toBe(false);
  });
  it("en særpris gælder kun på firmaets nuværende pakke (bortfalder ved pakkeskift)", () => {
    expect(saerprisGaelder({ saerpris_oere: 79_900, saerpris_pakke_id: "butik", pakke_id: "butik" })).toBe(true);
    expect(saerprisGaelder({ saerpris_oere: "79900", saerpris_pakke_id: "butik", pakke_id: "butik" })).toBe(true);
    expect(saerprisGaelder({ saerpris_oere: 79_900, saerpris_pakke_id: "butik", pakke_id: "pro" })).toBe(false);
    expect(saerprisGaelder({ saerpris_oere: null, saerpris_pakke_id: null, pakke_id: "butik" })).toBe(false);
  });
});

describe("gratis måned til et CVR, der har haft abonnement før (Filip, 27. okt. 2026)", () => {
  it("nyt CVR: 1 gratis måned; tidligere CVR: ingen - kun som særaftale", () => {
    expect(velkomstMaanederVedOprettelse({ cvrTidligere: false, saeraftale: false })).toBe(1);
    expect(velkomstMaanederVedOprettelse({ cvrTidligere: true, saeraftale: false })).toBe(0);
    expect(velkomstMaanederVedOprettelse({ cvrTidligere: true, saeraftale: true })).toBe(1);
  });
  it("særaftalens begrundelse skal være 5-500 tegn", () => {
    expect(gyldigSaeraftaleBegrundelse("Hej")).toBeNull();
    expect(gyldigSaeraftaleBegrundelse("  abcd ")).toBeNull();
    expect(gyldigSaeraftaleBegrundelse("Aftalt  med\nHans")).toBe("Aftalt med Hans");
    expect(gyldigSaeraftaleBegrundelse("x".repeat(500))).toHaveLength(500);
    expect(gyldigSaeraftaleBegrundelse("x".repeat(501))).toBeNull();
    expect(gyldigSaeraftaleBegrundelse(undefined)).toBeNull();
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

describe("regel for måned 1 (Filip, 27. okt. 2026)", () => {
  it("Start gratis, Butik/Pro halv pris; ingen fordel uden ret eller med introrabat", () => {
    expect(maaned1Regel({ pakke: "gratis", velkomst: true, introGaelder: false })).toBe("gratis");
    expect(maaned1Regel({ pakke: "halv", velkomst: true, introGaelder: false })).toBe("halv");
    expect(maaned1Regel({ pakke: "halv", velkomst: false, introGaelder: false })).toBe("ingen");
    expect(maaned1Regel({ pakke: "gratis", velkomst: true, introGaelder: true })).toBe("ingen");
  });
  it("Checkout-plan: Start trial, Butik/Pro engangskupon - staff-måneder erstatter 50 %", () => {
    expect(checkoutPlan({ maaned1: "gratis", velkomstMaaneder: 1, ekstra: 0 })).toEqual({ velkomstGratis: 1, ekstra: 0, halvPris: false });
    expect(checkoutPlan({ maaned1: "gratis", velkomstMaaneder: 3, ekstra: 2 })).toEqual({ velkomstGratis: 1, ekstra: 2, halvPris: false });
    expect(checkoutPlan({ maaned1: "halv", velkomstMaaneder: 1, ekstra: 0 })).toEqual({ velkomstGratis: 0, ekstra: 0, halvPris: true });
    expect(checkoutPlan({ maaned1: "halv", velkomstMaaneder: 1, ekstra: 1 })).toEqual({ velkomstGratis: 0, ekstra: 1, halvPris: false });
    expect(checkoutPlan({ maaned1: "ingen", velkomstMaaneder: 1, ekstra: 0 })).toEqual({ velkomstGratis: 0, ekstra: 0, halvPris: false });
    // Butik/Pro får aldrig gratis måneder uden en særaftale.
    for (const v of [0, 1, 5]) expect(checkoutPlan({ maaned1: "halv", velkomstMaaneder: v, ekstra: 0 }).velkomstGratis).toBe(0);
  });
  it("kun Starts velkomstmåned (ingen særaftale) gør et skift op betalingspligtigt", () => {
    expect(erKunVelkomstGratis({ maaned1: "gratis" })).toBe(true);
    expect(erKunVelkomstGratis({ maaned1: "gratis", gratis_ekstra: "0" })).toBe(true);
    expect(erKunVelkomstGratis({ maaned1: "gratis", gratis_ekstra: "1" })).toBe(false);
    expect(erKunVelkomstGratis({ maaned1: "gratis", gratis_saeraftale: "ja" })).toBe(false);
    expect(erKunVelkomstGratis({ maaned1: "ingen" })).toBe(false);
    expect(erKunVelkomstGratis({})).toBe(false);
    expect(erKunVelkomstGratis(null)).toBe(false);
  });
});
