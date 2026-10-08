// Server-only: hvilken betalingsmodel er aktiv (docs/BETALINGSMODEL-PLAN.md).
//
//   separat     - i dag: køberen betaler på BidHamrs platformskonto, og
//                 pengene overføres (transfer) til sælgeren ved frigivelse.
//   destination - ny model: betaling på sælgerens vegne (on_behalf_of +
//                 transfer_data); pengene står på sælgerens Connect-konto med
//                 manuel udbetalingsplan, og BidHamr udbetaler, når handlen
//                 er afsluttet.
//
// Destination er KUN aktiv, når BÅDE serverflaget STRIPE_BETALINGSMODEL er
// 'destination' OG databasens indstilling (stripe_tilstand.betalingsmodel,
// 20261011010000) er 'destination'. Databasen bruger sin indstilling i
// har_udbetalingskonto (strammere krav til sælgerkontoen). Er de uenige,
// gives drift-alarm, og koden kører 'separat' (sikreste valg: ingen nye
// pengestrømme). Standard (flaget ikke sat) = 'separat' uden databaseopslag.
//
// Trin 1 (fundament): kun onboarding/kontoopsætning og spejling af
// sælgerkontoen læser modellen. Pengestrømmen er uændret.

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

export type Betalingsmodel = "separat" | "destination";

const CACHE_MS = 60_000;
const CACHE_FEJL_MS = 5_000;
const ALARM_MS = 10 * 60_000;
let cache: { model: Betalingsmodel | null; kl: number } | null = null;
let sidsteAlarm = 0;

async function alarm(tekst: string) {
  if (Date.now() - sidsteAlarm < ALARM_MS) return;
  sidsteAlarm = Date.now();
  await logDriftFejl({ kilde: "server", hvor: "betaling/betalingsmodel", fejl: tekst });
}

// Serverflaget. Tomt/ikke sat = 'separat'. En ukendt værdi = 'separat' + alarm.
export function serverensBetalingsmodel(): { model: Betalingsmodel; ugyldig: boolean } {
  const v = (process.env.STRIPE_BETALINGSMODEL ?? "").trim().toLowerCase();
  if (v === "destination") return { model: "destination", ugyldig: false };
  if (v === "" || v === "separat") return { model: "separat", ugyldig: false };
  return { model: "separat", ugyldig: true };
}

// Databasens indstilling (null = kunne ikke læses, fx før migrationen).
export async function databasensBetalingsmodel(): Promise<Betalingsmodel | null> {
  if (cache && Date.now() - cache.kl < (cache.model ? CACHE_MS : CACHE_FEJL_MS)) return cache.model;
  let model: Betalingsmodel | null = null;
  try {
    const { data, error } = await createAdminClient()
      .from("stripe_tilstand")
      .select("betalingsmodel")
      .eq("id", true)
      .maybeSingle<{ betalingsmodel: string }>();
    if (!error && (data?.betalingsmodel === "separat" || data?.betalingsmodel === "destination")) {
      model = data.betalingsmodel;
    }
  } catch {
    model = null;
  }
  cache = { model, kl: Date.now() };
  return model;
}

export async function aktivBetalingsmodel(): Promise<Betalingsmodel> {
  const server = serverensBetalingsmodel();
  if (server.ugyldig) {
    await alarm("STRIPE_BETALINGSMODEL har en ukendt værdi - kører 'separat'. Brug 'separat' eller 'destination'.");
  }
  if (server.model === "separat") return "separat";
  const db = await databasensBetalingsmodel();
  if (db === "destination") return "destination";
  await alarm(
    db === null
      ? "STRIPE_BETALINGSMODEL=destination, men databasens betalingsmodel (stripe_tilstand.betalingsmodel) kan ikke læses - kører 'separat'."
      : "STRIPE_BETALINGSMODEL=destination, men databasens betalingsmodel er 'separat' - kører 'separat'. Sæt begge, når destination skal bruges.",
  );
  return "separat";
}

// Kun til test: nulstil cachen.
export function glemBetalingsmodel() {
  cache = null;
}
