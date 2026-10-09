import "server-only";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { hentProfil } from "@/lib/betaling/stripeBetaling";

// "Fjern kort" - ÉN vej for hjemmesiden (server action i
// src/app/actions/betaling.ts) og appen (POST /api/betaling/kort).
// betalingsprofiler kan kun ændres af serveren (authenticated har kun
// select). brugerId kommer altid fra et verificeret login. Kaster ved
// databasefejl.
//
// Automatisk betaling findes ikke længere (Filip, 9. okt. 2026): et gemt kort
// bruges kun til at forudfylde checkout (kundeSessionTilCheckout i
// stripeBetaling.ts) og trækkes kun, når køberen selv trykker Betal.

export async function fjernGemtKortForBruger(brugerId: string): Promise<{ ok: true }> {
  const p = await hentProfil(brugerId);
  if (!p?.gemt_betalingsmetode_id) return { ok: true };
  const { error } = await createAdminClient()
    .from("betalingsprofiler")
    .update({
      // Altid false efter 20261012020000_ingen_autobetaling.sql. Sættes stadig
      // her, så "Fjern kort" ikke rammer autobetaling_kraever_kort på en
      // database, hvor migrationen endnu ikke er kørt.
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
