import "server-only";

import { createAnonClient } from "@/lib/supabase/anon";

// "Populær sælger" (mindst 50 gennemførte salg). Status er offentlig og
// regnes i databasen: populaer_saelger(p_bruger) og populaere_saelgere(p_brugere)
// (20261023020000_badge_konkurrence.sql). Opslaget caches IKKE: mærket skal
// forsvinde med det samme, når en konto bliver firmakonto, eller en handel
// refunderes/får en indsigelse (ROADMAP-BESLUTNINGER), og de ændringer sker
// mange steder (webhooks, cron, admin, databasen). Det er én RPC pr. side
// (populaere_saelgere tager hele listen), og siderne er alligevel dynamiske.
// Det er det samme for alle, så det hentes med den offentlige nøgle uden
// cookies. Fejler opslaget (fx før migrationen er kørt), vises mærket bare ikke.

async function hentEn(brugerId: string): Promise<boolean> {
  const { data, error } = await createAnonClient().rpc("populaer_saelger", { p_bruger: brugerId });
  if (error) throw new Error(`populaer_saelger: ${error.message}`);
  return data === true;
}

async function hentFlere(ider: string[]): Promise<string[]> {
  const { data, error } = await createAnonClient().rpc("populaere_saelgere", { p_brugere: ider });
  if (error) throw new Error(`populaere_saelgere: ${error.message}`);
  return (data ?? []) as string[];
}

export async function erPopulaerSaelger(brugerId: string): Promise<boolean> {
  try {
    return await hentEn(brugerId);
  } catch (err) {
    console.error("Populær sælger kunne ikke hentes:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Til auktionskort: sætter populaerSaelger på de kort, hvis sælger har mærket.
export async function markerPopulaereSaelgere<T extends { saelgerId?: string; populaerSaelger?: boolean }>(
  kort: T[],
): Promise<T[]> {
  const ider = [...new Set(kort.map((k) => k.saelgerId).filter((x): x is string => !!x))].sort().slice(0, 200);
  if (ider.length === 0) return kort;
  let populaere: Set<string>;
  try {
    populaere = new Set(await hentFlere(ider));
  } catch (err) {
    console.error("Populære sælgere kunne ikke hentes:", err instanceof Error ? err.message : err);
    return kort;
  }
  return kort.map((k) => (k.saelgerId && populaere.has(k.saelgerId) ? { ...k, populaerSaelger: true } : k));
}
