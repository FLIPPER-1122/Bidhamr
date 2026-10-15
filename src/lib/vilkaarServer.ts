import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { VILKAAR_VERSION, erVilkaarVersion } from "@/lib/vilkaar";

// Den version af brugerbetingelserne, en ny konto må acceptere: hjemmesidens
// (VILKAAR_VERSION) eller databasens aktive (vilkaar_aktuel_version, styret af
// vilkaar_indstilling - 20261023010000). Appen sender databasens, så den
// virker både før og efter, at admin har slået en ny version til. null =
// ugyldig.
export async function godkendtSignupVersion(v: unknown): Promise<string | null> {
  if (!erVilkaarVersion(v)) return null;
  if (v === VILKAAR_VERSION) return v;
  const { data, error } = await createAdminClient().rpc("vilkaar_aktuel_version");
  if (!error && data === v) return v;
  return null;
}
