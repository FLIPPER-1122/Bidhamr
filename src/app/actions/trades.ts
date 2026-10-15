"use server";

// Handelstrinene på hjemmesiden. Logikken (tjek, RPC, beskeder og
// udbetaling) ligger i src/lib/handel/handelstrin.ts, som appens endpoint
// (POST /api/handel/app/<handling>) også bruger - her findes kun den
// indloggede bruger (cookie-session). Fejl RETURNERES som { fejl }.

import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { createClient } from "@/lib/supabase/server";
import { godkendPakkeFor, markerModtagetFor, sendPakkeFor, type HandelstrinSvar } from "@/lib/handel/handelstrin";
import type { PakkeBilledeInput } from "@/lib/pakkebilleder";

// Samme form som før (fejl og ok er valgfrie på hinandens grene), så
// komponenterne kan læse resultat.fejl direkte.
type TrinResultat = { ok: true; fejl?: undefined } | { fejl: string; ok?: undefined };

async function medBruger(
  fn: (supabase: Awaited<ReturnType<typeof createClient>>, brugerId: string) => Promise<HandelstrinSvar>,
): Promise<TrinResultat> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind." };
  const r = await fn(supabase, user.id);
  return "fejl" in r ? { fejl: r.fejl } : { ok: true };
}

// Sælger sender pakken: sporingsnummer + pakkebilleder (uploadet af
// klienten til bucket 'pakke-billeder' FØR kaldet).
export async function sendPakke(tradeId: string, tracking: string, billeder: PakkeBilledeInput[]) {
  return medBruger((supabase, brugerId) => sendPakkeFor(supabase, brugerId, tradeId, tracking, billeder));
}

// TRIN 1: Køberen kvitterer for at pakken er kommet frem.
export async function markerModtaget(tradeId: string) {
  return medBruger((supabase, brugerId) => markerModtagetFor(supabase, brugerId, tradeId));
}

// TRIN 2: Køberen godkender varen og bedømmer sælgeren (1-5 stjerner +
// valgfri kommentar), og beløbet udbetales til sælgeren. Uigenkaldeligt -
// derfor bekræftelsesdialogen i brugerfladen. stjerner er valgfri i typen,
// så et kald uden bedømmelse afvises med en forståelig besked.
export async function godkendPakke(tradeId: string, stjerner?: number, kommentar?: string | null) {
  return medBruger((supabase, brugerId) => godkendPakkeFor(supabase, brugerId, tradeId, stjerner, kommentar));
}
