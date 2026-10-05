// Kun billeder fra vores egen Supabase-lagring maa optimeres af next/image
// (next.config.ts). Et billede fra andre steder vises uoptimeret i stedet for
// at vaelte siden med en 400-fejl.
const OPTIMERBAR =
  /^https:\/\/(lkifkrexeldimmghnsie|pjiigmzqwlfepxnjdvug)\.supabase\.co\/storage\/v1\/object\/public\/[^?]*$/;

export function kanOptimeres(url: string): boolean {
  return OPTIMERBAR.test(url);
}
