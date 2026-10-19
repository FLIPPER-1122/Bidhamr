// Den offentlige Stripe-nøgle (pk_test_/pk_live_) - fælles for browseren
// (stripeKlient) og serveren (vagten i stripe.ts, appens endpoints). Ingen
// hemmeligheder.
//
// NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY bygges ind i koden ved `next build` -
// både i browseren og på serveren - så serveren ser præcis den værdi, som
// betalingsformularen i browseren bruger. Mangler den i buildet (fx sat i
// Vercel efter buildet eller kun for Preview), kan Payment Element ikke
// vises: knappen "Betal" forbliver grå. Derfor afviser serveren nye
// betalinger uden en gyldig nøgle (kraevSammeOffentligeNoegle).
//
// Mellemrum, linjeskift og anførselstegn omkring værdien (en typisk fejl,
// når nøglen sættes i et dashboard) skæres væk.

const FORMAT = /^pk_(test|live)_[A-Za-z0-9]+$/;

export function renOffentligNoegle(vaerdi: string | null | undefined): string | null {
  if (typeof vaerdi !== "string") return null;
  const ren = vaerdi.trim().replace(/^["']+|["']+$/g, "").trim();
  return FORMAT.test(ren) ? ren : null;
}

// Den indbyggede nøgle (null = mangler eller er ugyldig). Skal stå som
// `process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, ellers bygges den ikke ind.
export function indbyggetOffentligNoegle(): string | null {
  return renOffentligNoegle(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}

export const STRIPE_NOEGLE_MANGLER =
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY mangler eller er ugyldig i dette build - betalingsformularen kan ikke vises, og nye betalinger er stoppet. Sæt nøglen (pk_test_...) for Production i Vercel, og byg igen uden build-cache.";
