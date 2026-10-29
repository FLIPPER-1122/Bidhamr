// Anslået Stripe-gebyr (Filip, 29. okt. 2026 - ROADMAP-BESLUTNINGER
// "Founderens gratis handler"): i måned 1-6 betaler BidHamr selv Stripes
// gebyr på founderens handler, fordi der ikke kommer gebyr ind. Admin viser
// et SKØN ud fra satsen her - det rigtige gebyr afhænger af kortet (fx
// udenlandske kort koster mere) og står kun hos Stripe.
//
// Ren logik uden server-only (enhedstestene bruger den). Beløb i hele øre.

export const STRIPE_GEBYR_SKOEN = {
  // 1,5 % = 150 basispoint af det, køberen betaler.
  basispoint: 150,
  // 1,80 kr. pr. betaling.
  fastOere: 180,
} as const;

// "ca. 1,5 % + 1,80 kr." til visningen.
export const STRIPE_GEBYR_SKOEN_TEKST = `ca. ${(STRIPE_GEBYR_SKOEN.basispoint / 100).toLocaleString("da-DK")} % + ${(
  STRIPE_GEBYR_SKOEN.fastOere / 100
).toLocaleString("da-DK", { minimumFractionDigits: 2 })} kr.`;

// Skønnet tab for `antal` betalte handler, hvor køberne i alt har betalt
// `totalOere`. Procentdelen afrundes én gang på summen (halv op) - det er et
// skøn, ikke Stripes afregning.
export function anslaaetStripeTabOere(antal: number, totalOere: number): number {
  const n = Number.isFinite(antal) && antal > 0 ? Math.floor(antal) : 0;
  const t = Number.isFinite(totalOere) && totalOere > 0 ? Math.floor(totalOere) : 0;
  if (n === 0) return 0;
  return Math.round((t * STRIPE_GEBYR_SKOEN.basispoint) / 10_000) + n * STRIPE_GEBYR_SKOEN.fastOere;
}
