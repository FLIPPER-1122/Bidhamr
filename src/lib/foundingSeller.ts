import "server-only";

import { createAnonClient } from "@/lib/supabase/anon";
import { erFounderRabatPct, type FounderRabatPct } from "@/lib/betaling/beregn";

// "Founding seller" (seller founder, Filip 29. okt. 2026). Status er offentlig
// og regnes i databasen: founding_seller(p_bruger), founding_sellere(p_brugere)
// og auktion_founder_rabat(p_auktion) (20261102420000_seller_founder.sql).
// Samme mønster som src/lib/populaerSaelger.ts: ingen cache (mærket skal
// forsvinde med det samme, når aftalen stoppes), den offentlige nøgle uden
// cookies, og fejler opslaget (fx før migrationen er kørt), vises mærket bare
// ikke - og gebyret vises uden rabat (det endelige gebyr låses alligevel af
// databasen på betalingen).

export async function erFoundingSeller(brugerId: string): Promise<boolean> {
  try {
    const { data, error } = await createAnonClient().rpc("founding_seller", { p_bruger: brugerId });
    if (error) throw new Error(`founding_seller: ${error.message}`);
    return data === true;
  } catch (err) {
    console.error("Founding seller kunne ikke hentes:", err instanceof Error ? err.message : err);
    return false;
  }
}

// Til auktionskort: sætter foundingSeller på de kort, hvis sælger er aktiv founder.
export async function markerFoundingSellers<T extends { saelgerId?: string; foundingSeller?: boolean }>(
  kort: T[],
): Promise<T[]> {
  const ider = [...new Set(kort.map((k) => k.saelgerId).filter((x): x is string => !!x))].sort().slice(0, 200);
  if (ider.length === 0) return kort;
  let founders: Set<string>;
  try {
    const { data, error } = await createAnonClient().rpc("founding_sellere", { p_brugere: ider });
    if (error) throw new Error(`founding_sellere: ${error.message}`);
    founders = new Set((data ?? []) as string[]);
  } catch (err) {
    console.error("Founding sellers kunne ikke hentes:", err instanceof Error ? err.message : err);
    return kort;
  }
  return kort.map((k) => (k.saelgerId && founders.has(k.saelgerId) ? { ...k, foundingSeller: true } : k));
}

// Rabatten på auktionens gebyrer, hvis den slutter som planlagt (visningen
// "Det betaler du, hvis du vinder"). 0 ved fejl.
export async function auktionFounderRabat(auktionId: string): Promise<FounderRabatPct> {
  try {
    const { data, error } = await createAnonClient().rpc("auktion_founder_rabat", { p_auktion: auktionId });
    if (error) throw new Error(`auktion_founder_rabat: ${error.message}`);
    const n = Number(data ?? 0);
    return erFounderRabatPct(n) ? n : 0;
  } catch (err) {
    console.error("Founder-rabat kunne ikke hentes:", err instanceof Error ? err.message : err);
    return 0;
  }
}
