import "server-only";

// Boost i listerne (forsiden, kategori og søgning) og mærket "Boostet".
// Databasen bestemmer, hvilke boostede auktioner der står øverst (boost_top:
// højst 4 pr. liste, roteret hvert 10. minut, sorteret efter boost-start) og
// hvilke der er boostet lige nu (aktive_boosts). Begge kan kaldes uden login.
// Fejler et opslag, vises listen bare uden boost (siden må aldrig gå ned).

import type { SupabaseClient } from "@supabase/supabase-js";

type Klient = SupabaseClient;

// De boostede auktioner, der skal stå øverst i en liste (id'er i rækkefølge).
export async function hentBoostTop(
  supabase: Klient,
  filtre: { kategori?: string | null; soeg?: string | null } = {},
): Promise<string[]> {
  const { data, error } = await supabase.rpc("boost_top", {
    p_kategori: filtre.kategori || null,
    p_soeg: filtre.soeg || null,
  });
  if (error) {
    if (!/Could not find the function|does not exist|PGRST202/i.test(`${error.code ?? ""} ${error.message}`)) {
      console.error("boost_top:", error.message);
    }
    return [];
  }
  return ((data ?? []) as { auktion_id: string }[]).map((r) => r.auktion_id);
}

// Hvilke af auktionerne er boostet lige nu?
export async function hentAktiveBoosts(supabase: Klient, ider: string[]): Promise<Set<string>> {
  const unikke = [...new Set(ider)].slice(0, 500);
  if (unikke.length === 0) return new Set();
  const { data, error } = await supabase.rpc("aktive_boosts", { p_auktioner: unikke });
  if (error) {
    if (!/Could not find the function|does not exist|PGRST202/i.test(`${error.code ?? ""} ${error.message}`)) {
      console.error("aktive_boosts:", error.message);
    }
    return new Set();
  }
  return new Set(((data ?? []) as { auktion_id: string }[]).map((r) => r.auktion_id));
}

// Sætter boostet = true på de kort, hvis auktion er boostet lige nu.
export async function markerBoostede<T extends { id: string; boostet?: boolean }>(
  supabase: Klient,
  kort: T[],
): Promise<T[]> {
  const aktive = await hentAktiveBoosts(
    supabase,
    kort.map((k) => k.id),
  );
  return kort.map((k) => (aktive.has(k.id) ? { ...k, boostet: true } : k));
}
