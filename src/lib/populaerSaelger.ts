import type { SupabaseClient } from "@supabase/supabase-js";

// "Populær sælger" (mindst 50 gennemførte salg). Status er offentlig og
// regnes i databasen: populaer_saelger(p_bruger) og populaere_saelgere(p_brugere)
// (20261023020000_badge_konkurrence.sql). Fejler opslaget (fx før migrationen
// er kørt), vises mærket bare ikke.

export async function erPopulaerSaelger(supabase: SupabaseClient, brugerId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("populaer_saelger", { p_bruger: brugerId });
  if (error) {
    console.error("populaer_saelger fejlede:", error.message);
    return false;
  }
  return data === true;
}

// Til auktionskort: sætter populaerSaelger på de kort, hvis sælger har mærket.
export async function markerPopulaereSaelgere<T extends { saelgerId?: string; populaerSaelger?: boolean }>(
  supabase: SupabaseClient,
  kort: T[],
): Promise<T[]> {
  const ider = [...new Set(kort.map((k) => k.saelgerId).filter((x): x is string => !!x))].slice(0, 200);
  if (ider.length === 0) return kort;
  const { data, error } = await supabase.rpc("populaere_saelgere", { p_brugere: ider });
  if (error) {
    console.error("populaere_saelgere fejlede:", error.message);
    return kort;
  }
  const populaere = new Set((data ?? []) as string[]);
  return kort.map((k) => (k.saelgerId && populaere.has(k.saelgerId) ? { ...k, populaerSaelger: true } : k));
}
