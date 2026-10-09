// Server-only: vagt for betalingsmodellen (docs/BETALINGSMODEL-PLAN.md).
//
// BidHamr kører KUN med destination (Filip, 8. okt. 2026 - trin 5): betaling
// på sælgerens vegne (on_behalf_of + transfer_data); pengene står på
// sælgerens Connect-konto med manuel udbetalingsplan, og BidHamr udbetaler,
// når handlen er afsluttet. Den gamle model (separate charges and transfers)
// er fjernet, og der er intet serverflag (STRIPE_BETALINGSMODEL bruges ikke).
//
// Vagt: databasens stripe_tilstand.betalingsmodel er 'destination', når
// migrationerne for trin 1-5 er kørt (20261011050000 sætter den og låser den).
// Står den til noget andet, eller kan den ikke læses (databasen er ikke
// migreret), nægter serveren at oprette betalinger (PaymentIntents) og giver
// drift-alarm (betaling/betalingsmodel) - der faldes ALDRIG tilbage til den
// gamle model.

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

const CACHE_MS = 60_000;
const CACHE_FEJL_MS = 5_000;
const ALARM_MS = 10 * 60_000;
let cache: { status: BetalingsmodelStatus; kl: number } | null = null;
let sidsteAlarm = 0;

// Teksten må vises for brugeren.
export class BetalingsmodelFejl extends Error {
  constructor() {
    super("Betalingen kan ikke startes lige nu. Prøv igen senere – vi kigger på det.");
  }
}

async function alarm(tekst: string) {
  if (Date.now() - sidsteAlarm < ALARM_MS) return;
  sidsteAlarm = Date.now();
  await logDriftFejl({ kilde: "server", hvor: "betaling/betalingsmodel", fejl: tekst });
}

// Databasens betalingsmodel:
//   destination      - migreret (stripe_tilstand.betalingsmodel = destination)
//   ikke_destination - LÆST: står til noget andet, eller tabellen/kolonnen/
//                      rækken findes ikke (migrationen er ikke kørt)
//   ukendt           - kunne ikke læses (fx netværks- eller databasefejl)
export type BetalingsmodelStatus = "destination" | "ikke_destination" | "ukendt";

export async function databasensBetalingsmodelStatus(): Promise<BetalingsmodelStatus> {
  if (cache && Date.now() - cache.kl < (cache.status === "destination" ? CACHE_MS : CACHE_FEJL_MS)) {
    return cache.status;
  }
  let status: BetalingsmodelStatus = "ukendt";
  try {
    const { data, error } = await createAdminClient()
      .from("stripe_tilstand")
      .select("betalingsmodel")
      .eq("id", true)
      .maybeSingle<{ betalingsmodel: string }>();
    if (!error) status = data?.betalingsmodel === "destination" ? "destination" : "ikke_destination";
    else if (["42P01", "42703", "PGRST204", "PGRST205"].includes(error.code ?? "")) status = "ikke_destination";
  } catch {
    status = "ukendt";
  }
  cache = { status, kl: Date.now() };
  return status;
}

// true = databasen er migreret til destination. Ukendt tæller som nej (ingen
// nye betalinger, når det ikke kan afgøres).
export async function databasenErDestination(): Promise<boolean> {
  return (await databasensBetalingsmodelStatus()) === "destination";
}

// Kaster BetalingsmodelFejl (og giver drift-alarm), hvis databasen ikke er
// migreret til destination. Kaldes før en betaling (PaymentIntent) oprettes.
export async function kraevDestination(): Promise<void> {
  if (await databasenErDestination()) return;
  await alarm(
    "Betaling stoppet: databasens betalingsmodel (stripe_tilstand.betalingsmodel) er ikke 'destination' eller kan ikke læses. Kør migrationerne for betalingsmodellen (trin 1-5, se docs/GO-LIVE-STRIPE.md). Der oprettes ingen betalinger, før det er gjort.",
  );
  throw new BetalingsmodelFejl();
}

// Kun til test: nulstil cachen.
export function glemBetalingsmodel() {
  cache = null;
}
