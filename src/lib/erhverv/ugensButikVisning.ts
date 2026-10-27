import "server-only";
import { createClient } from "@/lib/supabase/server";

// Hvem vises lige nu i Ugens butik på forsiden? Samme RPC som forsiden
// (forside_ugens_butik): feltet vises kun, når ugen er betalt eller aftalt,
// firmaet er aktivt og ikke spærret, og firmaet har mindst én aktiv auktion,
// der kan ses og bydes på. Svar: firmaets bruger-id, eller null.
// Kaldes med den indloggede brugers klient (RPC'en er åben for authenticated).
export async function ugensButikVisesNu(): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("forside_ugens_butik");
  if (error) {
    console.error("forside_ugens_butik:", error.message);
    return null;
  }
  const d = data as { firma?: { bruger_id?: string }; auktioner?: unknown[] } | null;
  if (!d?.firma?.bruger_id || !Array.isArray(d.auktioner) || d.auktioner.length === 0) return null;
  return d.firma.bruger_id;
}

// Hvor mange af firmaets auktioner kan vises i Ugens butik lige nu? Samme
// filter som forside_ugens_butik: aktiv, ikke skjult, ikke arkiveret, ikke på
// pause og ikke slut. RLS: sælgeren ser sine egne.
export async function antalVisbareAuktioner(brugerId: string): Promise<number | null> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("auctions")
    .select("id", { count: "exact", head: true })
    .eq("bruger_id", brugerId)
    .eq("status", "aktiv")
    .not("skjult", "is", true)
    .is("arkiveret_kl", null)
    .is("pauset_kl", null)
    .gt("slutter_kl", new Date().toISOString());
  // kunst_kontrol kan ikke læses af brugeren (kolonne-rettighed) - en auktion
  // under kunst-kontrol tælles derfor med her. Selve visningen ("Vises nu")
  // afgøres af ugensButikVisesNu (RPC'en).
  if (error) {
    console.error("antalVisbareAuktioner:", error.message);
    return null;
  }
  return count ?? 0;
}
