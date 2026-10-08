import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { SAELGER_FROSSET_TEKST } from "@/lib/betaling/frosset";

// Databasefunktionerne (genopsæt, sæt op igen) svarer 'mangler_udbetalingskonto',
// når har_udbetalingskonto er falsk - også for en frosset sælger. Så vises den
// rigtige forklaring. Fejler opslaget, vises standardteksten.
export async function udbetalingskontoFejltekst(userId: string, standard: string): Promise<string> {
  try {
    const { data } = await createAdminClient()
      .from("betalingsprofiler")
      .select("saelger_frosset_kl")
      .eq("user_id", userId)
      .maybeSingle<{ saelger_frosset_kl: string | null }>();
    return data?.saelger_frosset_kl ? SAELGER_FROSSET_TEKST : standard;
  } catch {
    return standard;
  }
}
