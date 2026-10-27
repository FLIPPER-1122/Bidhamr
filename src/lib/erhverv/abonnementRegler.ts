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
// fakturaer i en gratis periode. Rabatten slutter ved start + K
// kalendermåneder (discount.end), og en faktura får rabat, hvis den kommer før
// slutningen. Fakturaerne kommer ved naesteFaktura + 0, 1, 2 ... måneder
// (regnet fra naesteFaktura - Stripes billing cycle anchor - ikke fra den
// forrige faktura). For præcis N BETALTE fakturaer med rabat skal
//   naesteFaktura + (N-1) måneder  <  start + K måneder  <  naesteFaktura + N måneder.
// Kuponen sættes på et sted i [nuSek, nuSek + marginSek] (Stripe sætter
// discount.start et øjeblik efter kaldet; i Checkout oprettes abonnementet
// senere end sessionen), og begge uligheder skal holde for HELE vinduet. NB:
// start + K måneder vokser ikke altid med start - 29. jan. 23:47 + 1 måned er
// 28. feb. 23:47, men 30. jan. 00:47 + 1 måned er 28. feb. 00:47 (månedens
// sidste dag). Inden for samme døgn vokser den, så vinduets endepunkter og
// hvert døgnskifte i vinduet tjekkes. K er det mindste tal, der opfylder den
// første ulighed for alle punkterne.
//
// Ved månedsskifte findes der ikke altid et K: kuponen tæller fra en anden
// dag i måneden end fakturaerne, og når fx start er den 31. og fakturaerne
// kommer den 30., springer start + K måneder over en hel fakturamåned (28.
// feb. 01:00 -> 31. mar. 01:00, mens fakturaerne er 28. feb. 23:00 og 30.
// mar. 23:00). Så svares null: kuponen kan ikke give præcis N lige nu, og den
// sættes på lidt senere (betalings-cron'en prøver igen hvert 5. minut - inden
// for et døgn passer det igen). Der gives aldrig N+1 eller N-1.
//
// fra 'straks': rabatten tæller fra nu (en gratis periode bruger af den) - K = N.
// Margin, når kuponen sættes på med et API-kald nu (discount.start ligger
// sekunder efter). Bagefter tjekkes Stripes faktiske discount.end alligevel.
export const INTRO_MARGIN_SEK = 300;
// Margin i Checkout: abonnementet oprettes typisk inden for en time.
export const INTRO_MARGIN_CHECKOUT_SEK = 3600;

// De tidspunkter i [fra, til], hvor start + K måneder er mindst og størst:
// endepunkterne og hvert døgnskifte (UTC) - sidste sekund før og første efter.
function vinduesPunkter(fra: number, til: number): number[] {
  const punkter = [fra, til];
  let midnat = Math.floor(fra / 86_400) * 86_400 + 86_400;
  while (midnat <= til) {
    punkter.push(midnat - 1, midnat);
    midnat += 86_400;
  }
  return punkter;
}

export function introKuponMaaneder(input: {
  nuSek: number;
  naesteFakturaSek: number;
  maaneder: number;
  fra: IntroFra;
  marginSek?: number;
}): number | null {
  const { nuSek, naesteFakturaSek, maaneder, fra } = input;
  const margin = input.marginSek ?? INTRO_MARGIN_SEK;
  if (!Number.isInteger(maaneder) || maaneder < 1) throw new Error("Ugyldigt antal måneder");
  if (!Number.isInteger(margin) || margin < 0 || margin > 86_400) throw new Error("Ugyldig margin");
  if (fra === "straks" || naesteFakturaSek <= nuSek) return maaneder;
  // Kan næste faktura komme, før kuponen er sat på? Så kan den ikke styres.
  if (naesteFakturaSek <= nuSek + margin) return null;
  const sidsteMedRabat = plusMaaneder(naesteFakturaSek, maaneder - 1);
  const foersteUden = plusMaaneder(naesteFakturaSek, maaneder);
  const punkter = vinduesPunkter(nuSek, nuSek + margin);
  const slut = (k: number) => punkter.map((p) => plusMaaneder(p, k));
  let k = 1;
  while (Math.min(...slut(k)) <= sidsteMedRabat) {
    k++;
    if (k > 400) throw new Error("Næste faktura ligger for langt ude");
  }
  if (Math.max(...slut(k)) >= foersteUden) return null;
  return k;
}

// Introkuponen sat på allerede i Stripe Checkout (så Checkout viser den
// rigtige pris efter den gratis periode). Kuponens måneder tæller fra, når
// ABONNEMENTET oprettes (når firmaet gennemfører Checkout) - det er efter
// sessionen (nuSek) og højst ~24 timer senere (sessionens levetid), mens
// trialEnd er låst i sessionen. Først prøves et K, der passer for hele døgnet;
// ellers et, der passer, hvis abonnementet oprettes inden for en time (det
// almindelige). Gennemfører firmaet senere, så rabatten ikke længere rammer
// præcis N betalte fakturaer (fx Checkout 30. aug. kl. 23 og abonnementet
// oprettet 31. aug. kl. 01), opdager spejlingen det (introPasser) og sætter
// kuponen på igen fra abonnementets faktiske tidspunkt. null: intet K passer
// - Checkout laves uden kupon, og webhooken/cron'en sætter den på.
// Uden gratis periode (første faktura ved oprettelsen) eller 'straks': K = N.
export function introKuponMaanederCheckout(input: {
  nuSek: number;
  trialEndSek: number | null;
  maaneder: number;
  fra: IntroFra;
}): number | null {
  const { nuSek, trialEndSek, maaneder, fra } = input;
  if (!Number.isInteger(maaneder) || maaneder < 1) throw new Error("Ugyldigt antal måneder");
  if (fra === "straks" || trialEndSek == null || trialEndSek <= nuSek) return maaneder;
  // Abonnementet oprettes tidligst sekundet EFTER sessionen (trialEnd er
  // nuSek + gratis måneder, så start = nuSek ville ramme en faktura præcis på
  // rabattens slutdato).
  const fra1 = nuSek + 1;
  return (
    introKuponMaaneder({ nuSek: fra1, naesteFakturaSek: trialEndSek, maaneder, fra, marginSek: 86_400 }) ??
    introKuponMaaneder({ nuSek: fra1, naesteFakturaSek: trialEndSek, maaneder, fra, marginSek: INTRO_MARGIN_CHECKOUT_SEK })
  );
}

// Giver en introrabat, der allerede ligger på abonnementet (fx fra Checkout),
// præcis N betalte fakturaer med rabat fra naesteFaktura? (Stripes faktiske
// discount.end, ikke en beregning.)
export function introPasser(input: { naesteFakturaSek: number; rabatSlutSek: number | null; maaneder: number }): boolean {
  return introResterende({ naesteFakturaSek: input.naesteFakturaSek, rabatSlutSek: input.rabatSlutSek }) === input.maaneder;
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
