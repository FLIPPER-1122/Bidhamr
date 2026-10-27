import "server-only";

// Hvem må se og bruge BidHamr-bot?
// - Uden ANTHROPIC_API_KEY: ingen (skjult overalt, ingen fejl).
// - Før lancering ("kun coming soon", Filip 26. okt. 2026): kun dem, der har
//   adgang til den lukkede app (staff, firmakonti og beta-testere) - samme
//   regel som resten af siden (src/lib/lukketUdgave.ts). Besøgende uden login
//   ser kun coming soon og erhverv, og dér er botten ikke.
// - Efter lancering: alle, også uden login.
// Endpoints tjekker det samme igen - chatboblen er kun visning.

import type { SupabaseClient } from "@supabase/supabase-js";
import { botAktiv } from "@/lib/bot/konfig";
import { foerLancering } from "@/lib/lancering";
import { visLukketUdgave } from "@/lib/lukketUdgave";
import { harAdgangTilLukketApp } from "@/lib/lukketUdgaveRegler";

// Hjemmesiden (cookie-session): layoutet og POST /api/bot.
export async function botSynligPaaHjemmesiden(): Promise<boolean> {
  if (!botAktiv()) return false;
  return !(await visLukketUdgave());
}

// Appen (Bearer-token). supabase/brugerId fra appBruger - null uden login.
export async function botSynligIAppen(supabase: SupabaseClient | null, brugerId: string | null): Promise<boolean> {
  if (!botAktiv()) return false;
  if (!foerLancering()) return true;
  if (!supabase || !brugerId) return false;
  try {
    const [{ data: rolle }, { data: konto }, { data: beta }] = await Promise.all([
      supabase.rpc("min_rolle"),
      supabase.from("users").select("konto_type").eq("id", brugerId).maybeSingle<{ konto_type: string | null }>(),
      supabase.rpc("min_beta_adgang"),
    ]);
    return harAdgangTilLukketApp({
      rolle: typeof rolle === "string" ? rolle : null,
      kontoType: konto?.konto_type ?? null,
      beta: beta === true,
    });
  } catch {
    return false;
  }
}
