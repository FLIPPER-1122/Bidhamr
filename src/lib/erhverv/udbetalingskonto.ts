import "server-only";
import { createClient } from "@/lib/supabase/server";

// Har firmaet en færdig udbetalingskonto (Stripe Connect)? Samme regel som
// OpretAuktionIndhold og har_udbetalingskonto i databasen: kontoen er oprettet,
// oplysningerne er sendt ind, og kortbetaling er anmodet.
//   "klar"     - kan sælge
//   "mangler"  - ingen konto endnu ("Tilføj bankkonto")
//   "ufaerdig" - konto oprettet, men opsætningen hos Stripe er ikke færdig
//   "spaerret" - lukket, afvist eller frosset (forklares på Opret auktion)
export type Udbetalingskontostatus = "klar" | "mangler" | "ufaerdig" | "spaerret";

export async function hentUdbetalingskontostatus(brugerId: string): Promise<Udbetalingskontostatus> {
  const supabase = await createClient();
  // RLS: brugeren kan kun læse sin egen betalingsprofil.
  const { data: p } = await supabase
    .from("betalingsprofiler")
    .select(
      "stripe_account_id, connect_detaljer_indsendt, connect_betalingsmetoder, connect_frakoblet_kl, connect_spaerret_aarsag, saelger_frosset_kl",
    )
    .eq("user_id", brugerId)
    .maybeSingle<{
      stripe_account_id: string | null;
      connect_detaljer_indsendt: boolean | null;
      connect_betalingsmetoder: Record<string, string> | null;
      connect_frakoblet_kl: string | null;
      connect_spaerret_aarsag: string | null;
      saelger_frosset_kl: string | null;
    }>();
  if (!p?.stripe_account_id) return "mangler";
  if (p.connect_frakoblet_kl || p.connect_spaerret_aarsag?.startsWith("rejected.")) return "spaerret";
  // Frosset: kontoen blev ikke godkendt i tide - opsætningen skal gøres færdig.
  if (p.saelger_frosset_kl) return "ufaerdig";
  const kortAnmodet = !!p.connect_betalingsmetoder && "card_payments" in p.connect_betalingsmetoder;
  return p.connect_detaljer_indsendt && kortAnmodet ? "klar" : "ufaerdig";
}
