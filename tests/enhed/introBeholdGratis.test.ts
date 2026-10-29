// "Behold Starts gratis måned + introrabat" (Filip, 29. okt. 2026 -
// 20261102450000): udvalgte firmaer på Start får måned 1 gratis, derefter
// introrabatten fra første betaling (50 % i måned 2-7) og fuld pris fra måned 8.
// Rene regler (src/lib/erhverv/abonnementRegler.ts) og teksterne. Stripes
// kupon med duration 'repeating' efterlignes som i abonnementRegler.test.ts:
// den gælder fakturaer i [start, start + K måneder). Det rigtige forløb mod
// Stripes testmiljø: tests/stripe-firma/introBeholdGratis.test.ts.
import { describe, expect, it } from "vitest";
import {
  beholdGratisAfvisning,
  checkoutPlan,
  erKunVelkomstGratis,
  introForloeb,
  introFraSkiftet,
  introKuponMaaneder,
  introKuponMaanederCheckout,
  maaned1Regel,
  oereMedRabat,
  plusMaaneder,
  velkomstSkiftUdfald,
  velkomstVisning,
  erVelkomstVisning,
} from "@/lib/erhverv/abonnementRegler";
import { ADMIN_ERHVERV, FIRMA_ABONNEMENT, FIRMA_ABONNEMENT_MAIL } from "@/lib/tekster/erhverv";
import { ADMIN_FIRMA } from "@/lib/tekster/adminFirma";

const sek = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const START_KR = 499;

// Fakturabeløb ekskl. moms i øre for et Start-abonnement oprettet ved
// 'oprettet' med 'gratis' gratis måneder (trial) og en introkupon (procent,
// K måneder) sat på ved 'oprettet' - som Stripe: 0 kr. i den gratis periode,
// og kuponen gælder fakturaer før start + K måneder.
function fakturaer(input: {
  oprettet: number;
  gratis: number;
  kupon: { procent: number; k: number } | null;
  antal: number;
}): number[] {
  const { oprettet, gratis, kupon, antal } = input;
  const ud: number[] = gratis > 0 ? [0] : [];
  const foersteBetalte = plusMaaneder(oprettet, gratis);
  const slut = kupon ? plusMaaneder(oprettet, kupon.k) : 0;
  for (let i = 0; ud.length < antal; i++) {
    const t = plusMaaneder(foersteBetalte, i);
    const rabat = kupon && t < slut ? kupon.procent : 0;
    ud.push(oereMedRabat(START_KR, rabat).ekskl);
  }
  return ud;
}

const HALV = 24_950;
const FULD = 49_900;
const FORVENTET = [0, HALV, HALV, HALV, HALV, HALV, HALV, FULD, FULD];

describe("regel for måned 1 med 'Behold Starts gratis måned + introrabat'", () => {
  const basis = { velkomst: true, introGaelder: true, saerprisGaelder: false };

  it("Start + introrabat + valget: måned 1 er gratis", () => {
    expect(maaned1Regel({ ...basis, pakke: "gratis", introBeholdGratis: true })).toBe("gratis");
  });

  it("uden valget er det som før: introrabatten erstatter den gratis måned", () => {
    expect(maaned1Regel({ ...basis, pakke: "gratis" })).toBe("ingen");
    expect(maaned1Regel({ ...basis, pakke: "gratis", introBeholdGratis: false })).toBe("ingen");
  });

  it("Butik/Pro får aldrig en gratis måned af valget", () => {
    expect(maaned1Regel({ ...basis, pakke: "halv", introBeholdGratis: true })).toBe("ingen");
  });

  it("ingen gratis måned til gode eller særpris: ingen fordel", () => {
    expect(maaned1Regel({ ...basis, pakke: "gratis", velkomst: false, introBeholdGratis: true })).toBe("ingen");
    expect(maaned1Regel({ ...basis, pakke: "gratis", saerprisGaelder: true, introBeholdGratis: true })).toBe("ingen");
  });

  it("valget uden kørende introrabat ændrer intet", () => {
    expect(maaned1Regel({ ...basis, introGaelder: false, pakke: "gratis", introBeholdGratis: true })).toBe("gratis");
    expect(maaned1Regel({ ...basis, introGaelder: false, pakke: "halv", introBeholdGratis: true })).toBe("halv");
  });

  it("Checkout: 1 gratis måned, ingen 50 %-engangskupon og ingen særaftale (gratis_saeraftale)", () => {
    const maaned1 = maaned1Regel({ ...basis, pakke: "gratis", introBeholdGratis: true });
    const plan = checkoutPlan({ maaned1, velkomstMaaneder: 1, ekstra: 0 });
    expect(plan).toEqual({ velkomstGratis: 1, ekstra: 0, halvPris: false });
    // Abonnementets metadata, som startBetaling sætter dem: maaned1 'gratis'
    // uden gratis_ekstra/gratis_saeraftale - et skift op i den gratis måned
    // følger de almindelige regler (ikke gratis).
    expect(erKunVelkomstGratis({ maaned1, gratis_velkomst: "1" })).toBe(true);
  });
});

describe("forløbet: 0 kr., 6 x 249,50 kr. og derefter 499 kr.", () => {
  it("Checkout med introkuponen (abonnementet oprettet inden for en time)", () => {
    for (const nu of [
      "2026-10-29T10:00:00Z",
      "2026-01-31T23:30:00Z",
      "2026-02-28T12:00:00Z",
      "2026-08-30T22:00:00Z",
      "2027-12-31T23:59:00Z",
      "2028-02-29T08:00:00Z",
    ]) {
      const nuSek = sek(nu);
      const trialEnd = plusMaaneder(nuSek, 1);
      const k = introKuponMaanederCheckout({ nuSek, trialEndSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
      expect(k, nu).not.toBeNull();
      for (const forsinkelse of [1, 600, 3600]) {
        // Abonnementet (og kuponen) oprettes efter sessionen; trial_end er låst.
        const oprettet = nuSek + forsinkelse;
        const slut = plusMaaneder(oprettet, k!);
        const beloeb = [0];
        for (let i = 0; i < 8; i++) {
          const t = plusMaaneder(trialEnd, i);
          beloeb.push(oereMedRabat(START_KR, t < slut ? 50 : 0).ekskl);
        }
        expect(beloeb, `${nu} +${forsinkelse}s`).toEqual(FORVENTET);
      }
    }
  });

  it("hver time i et helt år: Checkout-kuponen rammer præcis 6 betalte måneder - ellers sættes den på bagefter (aldrig 5 eller 7)", () => {
    const fra = sek("2026-01-01T00:30:00Z");
    for (let t = fra; t < fra + 366 * 86_400; t += 3_600) {
      const trialEnd = plusMaaneder(t, 1);
      const k = introKuponMaanederCheckout({ nuSek: t, trialEndSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
      if (k != null) {
        const slut = plusMaaneder(t + 60, k);
        let n = 0;
        while (plusMaaneder(trialEnd, n) < slut) n++;
        expect(n).toBe(6);
      } else {
        // Webhooken/cron'en sætter kuponen på efter oprettelsen (anvendIntro):
        // passer intet K lige nu, prøves igen (inden for et døgn passer det).
        let fundet = false;
        for (let senere = t + 300; senere < t + 86_400 && !fundet; senere += 300) {
          const k2 = introKuponMaaneder({ nuSek: senere, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" });
          if (k2 != null) {
            const slut = plusMaaneder(senere + 60, k2);
            let n = 0;
            while (plusMaaneder(trialEnd, n) < slut) n++;
            expect(n).toBe(6);
            fundet = true;
          }
        }
        expect(fundet).toBe(true);
      }
    }
  });

  it("'Fra nu' (straks) i den gratis måned: en rabatmåned bruges i den gratis måned (kun 5 betalte med rabat)", () => {
    const nuSek = sek("2026-10-29T10:00:00Z");
    const k = introKuponMaanederCheckout({ nuSek, trialEndSek: plusMaaneder(nuSek, 1), maaneder: 6, fra: "straks" });
    expect(k).toBe(6);
    expect(fakturaer({ oprettet: nuSek + 60, gratis: 1, kupon: { procent: 50, k: k! }, antal: 9 })).toEqual([
      0, HALV, HALV, HALV, HALV, HALV, FULD, FULD, FULD,
    ]);
  });

  it("forkert rækkefølge før (introrabat uden valget): ingen gratis måned - 6 x 249,50 kr. fra måned 1", () => {
    const nuSek = sek("2026-10-29T10:00:00Z");
    const maaned1 = maaned1Regel({ pakke: "gratis", velkomst: true, introGaelder: true, saerprisGaelder: false });
    const plan = checkoutPlan({ maaned1, velkomstMaaneder: 1, ekstra: 0 });
    expect(plan.velkomstGratis).toBe(0);
    const k = introKuponMaanederCheckout({ nuSek, trialEndSek: null, maaneder: 6, fra: "efter_gratis" });
    expect(fakturaer({ oprettet: nuSek + 60, gratis: 0, kupon: { procent: 50, k: k! }, antal: 7 })).toEqual([
      HALV, HALV, HALV, HALV, HALV, HALV, FULD,
    ]);
  });
});

describe("afvisninger (samme som databasen)", () => {
  const ok = { fra: "efter_gratis" as const, pakke: "gratis" as const, harAbonnement: false, velkomst: true };
  it("Start, før Checkout, med gratis måned til gode og fra første betaling: tilladt", () => {
    expect(beholdGratisAfvisning(ok)).toBeNull();
  });
  it("'Fra nu' afvises", () => {
    expect(beholdGratisAfvisning({ ...ok, fra: "straks" })).toBe("ugyldig_rabat");
    expect(beholdGratisAfvisning({ ...ok, fra: null })).toBe("ugyldig_rabat");
  });
  it("abonnementet er startet", () => {
    expect(beholdGratisAfvisning({ ...ok, harAbonnement: true })).toBe("behold_startet");
  });
  it("kun Start", () => {
    expect(beholdGratisAfvisning({ ...ok, pakke: "halv" })).toBe("behold_kun_start");
  });
  it("ingen gratis måned til gode (tidligere CVR uden særaftale, eller brugt)", () => {
    expect(beholdGratisAfvisning({ ...ok, velkomst: false })).toBe("behold_ingen_gratis");
  });
});

describe("forløbet i måneder", () => {
  it("med valget: måned 1 gratis, rabat måned 2-7, fuld pris fra måned 8", () => {
    expect(introForloeb({ maaneder: 6, beholdGratis: true })).toEqual({ gratisMaaneder: 1, rabatFra: 2, rabatTil: 7, fuldFra: 8 });
  });
  it("uden: rabat måned 1-6, fuld pris fra måned 7", () => {
    expect(introForloeb({ maaneder: 6, beholdGratis: false })).toEqual({ gratisMaaneder: 0, rabatFra: 1, rabatTil: 6, fuldFra: 7 });
  });
});

describe("tekster", () => {
  it("Opret firmakonto: 1 måned gratis, derefter 50 % i 6 måneder", () => {
    const t = ADMIN_ERHVERV.opret.pakkeOpsummering(
      "Start",
      "499 kr.",
      { procent: 50, maaneder: 6, pris: "249,50 kr.", beholdGratis: true },
      "ny",
      "gratis",
      "249,50 kr.",
    );
    expect(t).toBe("Start – 499 kr./md. + moms. 1 måned gratis, derefter 50 % i 6 måneder (måned 2-7), 249,50 kr./md. + moms. Derefter 499 kr./md. + moms.");
    expect(t).not.toMatch(/forsikring/i);
  });

  it("særaftale for et tidligere CVR: markeret; uden særaftale ingen gratis måned", () => {
    const intro = { procent: 50, maaneder: 6, pris: "249,50 kr.", beholdGratis: true };
    expect(ADMIN_ERHVERV.opret.pakkeOpsummering("Start", "499 kr.", intro, "saeraftale", "gratis")).toContain("1 måned gratis (særaftale), derefter 50 %");
    expect(ADMIN_ERHVERV.opret.pakkeOpsummering("Start", "499 kr.", intro, "ingen", "gratis")).toContain("Ingen gratis måned");
  });

  it("uden valget er teksten uændret", () => {
    expect(
      ADMIN_ERHVERV.opret.pakkeOpsummering("Start", "499 kr.", { procent: 50, maaneder: 6, pris: "249,50 kr." }, "ny", "gratis"),
    ).toBe("Start – 499 kr./md. + moms. Introrabat 50 % i måned 1-6 (249,50 kr./md. + moms). Ingen gratis måned. Derefter 499 kr./md. + moms.");
  });

  it("mailen til firmaet", () => {
    expect(FIRMA_ABONNEMENT_MAIL.intro.tekst("Testfirma", 50, 6, true, true)[1]).toBe(
      "Jeres første måned er gratis. Derefter får I 50 % rabat på jeres pakke i 6 måneder fra jeres første betaling.",
    );
    expect(FIRMA_ABONNEMENT_MAIL.intro.tekst("Testfirma", 50, 6, true)[1]).toBe("I får 50 % rabat på jeres pakke i 6 måneder fra jeres første betaling.");
  });

  it("firmaets abonnementsside", () => {
    expect(FIRMA_ABONNEMENT.introPlanlagt(50, 6, true, true)).toBe(
      "Efter din gratis måned får du 50 % rabat i 6 måneder (måned 2-7). Derefter betaler du pakkens almindelige pris.",
    );
  });

  it("admin: kortet og advarslen ved 'Fra nu'", () => {
    const I = ADMIN_FIRMA.hurtig.intro;
    expect(I.behold).toBe("Behold Starts gratis måned + introrabat");
    expect(I.beholdHjaelp(50, 6)).toContain("måned 2-7");
    expect(I.straksAdvarsel).toContain("bruges en af rabatmånederne i den gratis måned");
    expect(I.nu(50, 6, "efter_gratis", null, true)).toBe("Nu: første måned gratis, derefter 50 % i 6 måneder fra første betaling");
  });
});

// Skift op i den gratis måned (Filip, 29. okt. 2026): sættes rabatten på igen
// fra skiftet (introFraSkiftet - N betalte måneder i alt), viser siden "i N
// måneder" og ikke den gamle slutdato. Ellers: slutdatoen som før.
describe("skift op i den gratis måned: visningen", () => {
  const input = (fraSkiftet: boolean) => ({
    saerprisGaelder: false,
    aftale: { status: "aktiv", procent: 50, maaneder: 6, kuponId: "bidhamr_intro_50_6", noegle: "n", gaelder: true },
    abonnement: {
      introer: [{ kuponId: "bidhamr_intro_50_6", procent: 50, slutSek: sek("2027-04-29T10:00:00Z") }],
      andre: 0,
      introNoegle: "n",
    },
    dato: () => "29. april 2027",
    fraSkiftet,
  });

  it("sættes på igen fra skiftet: til er null, og visningen siger det (intro:50:skift)", () => {
    const u = velkomstSkiftUdfald(input(true));
    expect(u).toEqual({ udfald: "skift", rabat: { slags: "intro", procent: 50, til: null, maaneder: 6 }, velkomstKupon: false, fraSkiftet: true });
    expect(velkomstVisning(u)).toBe("intro:50:skift");
    expect(erVelkomstVisning(velkomstVisning(u))).toBe(true);
    if (u.udfald === "skift") {
      expect(FIRMA_ABONNEMENT.bekraeftOpgraderFraGratisMaaned("Butik", "499,50 kr. + moms (624,38 kr.)", u.rabat)).toContain(
        "(50 % rabat i 6 måneder). Derefter betaler du pakkens almindelige pris.",
      );
    }
  });

  it("bliver liggende: rabattens slutdato fra Stripe, visningen uden :skift (intro:50)", () => {
    const u = velkomstSkiftUdfald(input(false));
    expect(u).toMatchObject({ udfald: "skift", rabat: { slags: "intro", til: "29. april 2027" } });
    expect(u).not.toHaveProperty("fraSkiftet");
    expect(velkomstVisning(u)).toBe("intro:50");
  });

  it("visningen: kun introrabatten kan have :skift", () => {
    expect(erVelkomstVisning("intro:30:skift")).toBe(true);
    for (const v of ["velkomst:50:skift", "saerpris:0:skift", "venter:skift", "intro:30:", "intro:30:skift:skift", "intro::skift"]) {
      expect(erVelkomstVisning(v)).toBe(false);
    }
    // fraSkiftet uden en introrabat (fx velkomstrabatten) ændrer ikke visningen.
    expect(
      velkomstVisning({ udfald: "skift", rabat: { slags: "velkomst", procent: 50 }, velkomstKupon: true, fraSkiftet: true }),
    ).toBe("velkomst:50");
  });

  it("K = N, når første faktura er nu (trial_end 'now')", () => {
    const nu = sek("2026-11-08T12:00:00Z");
    expect(introKuponMaaneder({ nuSek: nu, naesteFakturaSek: nu, maaneder: 6, fra: "efter_gratis" })).toBe(6);
  });

  it("admin: advarsel, når valget forsvinder", () => {
    expect(ADMIN_FIRMA.hurtig.intro.beholdMistesAdvarsel).toContain("forsvinder den gratis måned");
  });
});

// Skift op i den gratis måned gælder ALTID N måneder fra skiftet - også uden
// valget (Filip, 29. okt. 2026). Kuponen efterlignes som Stripe: den gælder
// fakturaer før start + K måneder; fakturaerne fra skiftet kommer ved skiftet
// + 0, 1, 2 ... måneder (trial_end 'now' nulstiller billing_cycle_anchor).
describe("introFraSkiftet: sættes introrabatten på igen ved skiftet?", () => {
  const t0 = sek("2026-11-03T09:00:00Z");
  const trialEnd = plusMaaneder(t0, 1);
  const dag10 = t0 + 10 * 86_400;
  const rabatter = (skift: number, slut: number) => {
    let n = 0;
    while (plusMaaneder(skift, n) < slut) n++;
    return n;
  };
  const basis = { kunVelkomstGratis: true, introKuponer: 1, nuSek: dag10, maaneder: 6 };

  // Kuponerne, BidHamr selv sætter i velkomstmåneden, er regnet fra
  // trial_end og starter før skiftet - de giver højst N fra skiftet (som
  // Stripe-testen viser). Reglen er alligevel generel: en kupon, der løber til
  // trial_end + N måneder (fx sat på direkte eller fra en ældre beregning),
  // giver N+1 fra skiftet og sættes på igen.
  it("kupon, der løber til trial_end + 6 md.: 7 fra dag 10 -> på igen", () => {
    const slut = plusMaaneder(trialEnd, 6);
    expect(rabatter(dag10, slut)).toBe(7);
    expect(introFraSkiftet({ ...basis, rabatSlutSek: slut })).toBe(true);
  });

  it("Checkout-kuponen med valget (regnet fra trial_end): 6 fra dag 10 -> bliver liggende", () => {
    const k = introKuponMaanederCheckout({ nuSek: t0, trialEndSek: trialEnd, maaneder: 6, fra: "efter_gratis" })!;
    const slut = plusMaaneder(t0 + 600, k);
    expect(rabatter(dag10, slut)).toBe(6);
    expect(introFraSkiftet({ ...basis, rabatSlutSek: slut })).toBe(false);
  });

  it("staff gemmer introrabatten igen efter Checkout / sætter den i den gratis måned: 6 fra dag 10 -> bliver liggende", () => {
    for (const sat of [t0 + 3600, t0 + 2 * 86_400, t0 + 9 * 86_400]) {
      const k = introKuponMaaneder({ nuSek: sat, naesteFakturaSek: trialEnd, maaneder: 6, fra: "efter_gratis" })!;
      const slut = plusMaaneder(sat, k);
      expect(rabatter(dag10, slut)).toBe(6);
      expect(introFraSkiftet({ ...basis, rabatSlutSek: slut })).toBe(false);
    }
  });

  it("reglen svarer altid til 'flere end N fra skiftet' (alle skiftedage i den gratis måned, slutdatoer +-40 dage)", () => {
    for (let dag = 0; dag < 30; dag++) {
      const skift = t0 + dag * 86_400 + 4000;
      for (let d = -40; d <= 40; d++) {
        const slut = plusMaaneder(trialEnd, 5) + d * 86_400;
        expect(introFraSkiftet({ ...basis, nuSek: skift, rabatSlutSek: slut })).toBe(rabatter(skift, slut) > 6);
      }
    }
  });

  it("kuponen giver allerede præcis N fra skiftet ('fra nu' sat på dag 2) -> bliver liggende", () => {
    const slut = plusMaaneder(t0 + 2 * 86_400, 6);
    expect(rabatter(dag10, slut)).toBe(6);
    expect(introFraSkiftet({ ...basis, rabatSlutSek: slut })).toBe(false);
  });

  it("grænsen: slut præcis skiftet + N måneder giver N (bliver liggende), ét sekund mere giver N+1", () => {
    expect(introFraSkiftet({ ...basis, rabatSlutSek: plusMaaneder(dag10, 6) })).toBe(false);
    expect(introFraSkiftet({ ...basis, rabatSlutSek: plusMaaneder(dag10, 6) + 1 })).toBe(true);
  });

  it("alle tre skal være opfyldt", () => {
    const syv = plusMaaneder(dag10, 6) + 86_400;
    expect(introFraSkiftet({ ...basis, rabatSlutSek: syv })).toBe(true);
    // Ikke kun Starts velkomstmåned (fx staff-givet gratis periode - særaftale).
    expect(introFraSkiftet({ ...basis, kunVelkomstGratis: false, rabatSlutSek: syv })).toBe(false);
    // Ingen introrabat (velkomstrabatten) eller flere introkuponer (ret_rabat).
    expect(introFraSkiftet({ ...basis, introKuponer: 0, rabatSlutSek: null })).toBe(false);
    expect(introFraSkiftet({ ...basis, introKuponer: 2, rabatSlutSek: syv })).toBe(false);
    // Ingen aftalte måneder.
    expect(introFraSkiftet({ ...basis, maaneder: null, rabatSlutSek: syv })).toBe(false);
    expect(introFraSkiftet({ ...basis, maaneder: 0, rabatSlutSek: syv })).toBe(false);
  });

  it("en introrabat uden slutdato giver uendeligt mange -> på igen", () => {
    expect(introFraSkiftet({ ...basis, rabatSlutSek: null })).toBe(true);
  });

  it("andre antal måneder (3 og 12)", () => {
    expect(introFraSkiftet({ ...basis, maaneder: 3, rabatSlutSek: plusMaaneder(trialEnd, 3) })).toBe(true);
    expect(introFraSkiftet({ ...basis, maaneder: 3, rabatSlutSek: plusMaaneder(dag10, 3) })).toBe(false);
    expect(introFraSkiftet({ ...basis, maaneder: 12, rabatSlutSek: plusMaaneder(trialEnd, 12) })).toBe(true);
  });
});
