// Rene regler for erhvervsabonnementet (gratis periode og introrabat) - ingen
// Stripe-kald, ingen database. Bruges af src/lib/erhverv/betaling.ts og
// testes i tests/enhed/abonnementRegler.test.ts.
//
// Regler: ROADMAP-BESLUTNINGER.md, "Erhvervskonti" -> "NYE pakker og priser
// (Filip, 26. okt. 2026)": 1 måned gratis for alle nye firmaer; introrabat
// (standard 50 % i 6 måneder efter den gratis måned) sættes manuelt.

export const INTRO_STANDARD = { procent: 50, maaneder: 6 } as const;
export const INTRO_GRAENSER = { procentMin: 1, procentMaks: 100, maanederMin: 1, maanederMaks: 24 } as const;
// Gratis periode pr. klik i admin (Filip: 1-3 måneder).
export const GRATIS_MAANEDER_MAKS = 3;
// Stripe: trial_end højst 730 dage frem.
export const TRIAL_MAKS_DAGE = 730;
export const BEGRUNDELSE = { min: 3, maks: 500 } as const;

export type IntroFra = "efter_gratis" | "straks";

// Kalendermåneder lagt til et tidspunkt (UTC), som Stripe gør det: findes
// dagen ikke i målmåneden (fx 31. januar + 1 måned), bruges månedens sidste
// dag. Klokkeslættet bevares.
export function plusMaaneder(sek: number, maaneder: number): number {
  const d = new Date(sek * 1000);
  const aar = d.getUTCFullYear();
  const maaned = d.getUTCMonth() + maaneder;
  const dag = d.getUTCDate();
  const sidsteDag = new Date(Date.UTC(aar, maaned + 1, 0)).getUTCDate();
  const ny = Date.UTC(aar, maaned, Math.min(dag, sidsteDag), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return Math.floor(ny / 1000);
}

// En kupon med duration 'repeating' gælder alle fakturaer i de
// duration_in_months måneder, der starter, når kuponen sættes på (Stripe:
// docs.stripe.com/billing/subscriptions/coupons#coupon-duration) - også
// fakturaer i en gratis periode. For at give rabat på præcis N BETALTE
// fakturaer fra den næste faktura (naesteFaktura = trial_end eller
// current_period_end) skal kuponens periode [nu, nu + K måneder) indeholde
// naesteFaktura + 0..N-1 måneder, men ikke naesteFaktura + N måneder:
//   K = m + N - 1, hvor m er det mindste antal måneder, så nu + m > naesteFaktura.
// Kuponen sættes aldrig på præcis samme sekund som en faktura (nu ligger
// altid mellem to fakturaer), så ingen faktura ligger på grænsen.
// fra 'straks': rabatten tæller fra nu (en gratis periode bruger af den).
export function introKuponMaaneder(input: {
  nuSek: number;
  naesteFakturaSek: number;
  maaneder: number;
  fra: IntroFra;
}): number {
  const { nuSek, naesteFakturaSek, maaneder, fra } = input;
  if (!Number.isInteger(maaneder) || maaneder < 1) throw new Error("Ugyldigt antal måneder");
  if (fra === "straks" || naesteFakturaSek <= nuSek) return maaneder;
  let m = 1;
  while (plusMaaneder(nuSek, m) <= naesteFakturaSek) {
    m++;
    if (m > 400) throw new Error("Næste faktura ligger for langt ude");
  }
  return m + maaneder - 1;
}

// Hvor mange BETALTE fakturaer har en kørende introrabat tilbage? Fakturaerne
// kommer ved naesteFaktura + 0, 1, 2 ... måneder; kuponen gælder fakturaer før
// dens slut (discount.end).
export function introResterende(input: { naesteFakturaSek: number; rabatSlutSek: number | null }): number {
  const { naesteFakturaSek, rabatSlutSek } = input;
  if (rabatSlutSek == null) return 0;
  let n = 0;
  while (plusMaaneder(naesteFakturaSek, n) < rabatSlutSek) {
    n++;
    if (n > 400) break;
  }
  return n;
}

// Ny trial_end, når staff giver +N gratis måneder. Er firmaet i en gratis
// periode, forlænges den; ellers starter de gratis måneder, når den betalte
// periode slutter (firmaet mister ikke det, det har betalt for).
export function nyGratisSlut(input: {
  status: string;
  trialEndSek: number | null;
  periodeSlutSek: number;
  nuSek: number;
  maaneder: number;
}): number {
  const { status, trialEndSek, periodeSlutSek, nuSek, maaneder } = input;
  const base = status === "trialing" && trialEndSek && trialEndSek > nuSek ? trialEndSek : Math.max(periodeSlutSek, nuSek);
  return plusMaaneder(base, maaneder);
}

export function gyldigBegrundelse(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  return s.length >= BEGRUNDELSE.min && s.length <= BEGRUNDELSE.maks ? s : null;
}
