// Kun billeder fra vores egen Supabase-lagring maa optimeres af next/image
// (next.config.ts). Et billede fra andre steder vises uoptimeret i stedet for
// at vaelte siden med en 400-fejl.
const OPTIMERBAR =
  /^https:\/\/(lkifkrexeldimmghnsie|pjiigmzqwlfepxnjdvug)\.supabase\.co\/storage\/v1\/object\/public\/[^?]*$/;

export function kanOptimeres(url: string): boolean {
  return OPTIMERBAR.test(url);
}

// ".." eller et kodet punktum (%2e/%2E, også dobbeltkodet %252e) i stien -
// eller en backslash - kan få fetch eller lagringen til at gå ud af
// /object/public/. Bruges af delebilledet (auktion/[id]/opengraph-image.tsx),
// som selv henter billedet på serveren.
export function farligBilledSti(url: string): boolean {
  return /\.\.|%(?:25)*2e|\\/i.test(url);
}
