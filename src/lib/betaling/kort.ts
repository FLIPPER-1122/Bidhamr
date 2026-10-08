import "server-only";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { AUTOBETALING_SAMTYKKE } from "@/lib/betaling/samtykke";
import { hentProfil } from "@/lib/betaling/stripeBetaling";

// Automatisk betaling og "Fjern kort" - ÉN vej for hjemmesiden (server
// actions i src/app/actions/betaling.ts) og appen (POST /api/betaling/kort).
// betalingsprofiler kan kun ændres af serveren (authenticated har kun
// select). brugerId kommer altid fra et verificeret login. Kaster ved
// databasefejl; svarer { fejl } ved brugerfejl.

export async function saetAutobetalingForBruger(brugerId: string, til: boolean): Promise<{ ok: true } | { fejl: string }> {
  const p = await hentProfil(brugerId);
  if (til && !p?.gemt_betalingsmetode_id) {
    return { fejl: "Gem et kort, før du slår automatisk betaling til." };
  }
  if (!p) return { ok: true };
  const { error } = await createAdminClient()
    .from("betalingsprofiler")
    .update({
      autobetaling: til,
      // Samtykket gemmes (tidspunkt sættes af databasen, Niels M04).
      ...(til ? { autobetaling_samtykke_version: AUTOBETALING_SAMTYKKE.version } : {}),
      opdateret: new Date().toISOString(),
    })
    .eq("user_id", brugerId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function fjernGemtKortForBruger(brugerId: string): Promise<{ ok: true }> {
  const p = await hentProfil(brugerId);
  if (!p?.gemt_betalingsmetode_id) return { ok: true };
  const { error } = await createAdminClient()
    .from("betalingsprofiler")
    .update({
      autobetaling: false,
      gemt_betalingsmetode_id: null,
      gemt_kort_maerke: null,
      gemt_kort_sidste4: null,
      gemt_kort_udloeb: null,
      // Et forsinket Stripe-svar må ikke genskabe kortet (registrerGemtKort).
      kort_fjernet_kl: new Date().toISOString(),
      opdateret: new Date().toISOString(),
    })
    .eq("user_id", brugerId);
  if (error) throw new Error(error.message);
  try {
    await getStripe().paymentMethods.detach(p.gemt_betalingsmetode_id);
  } catch (err) {
    console.warn("Kunne ikke fjerne kort hos Stripe:", err instanceof Error ? err.message : err);
  }
  return { ok: true };
}
