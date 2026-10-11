import "server-only";

// Nødstop (sikkerhedsnet A, 20261019010000_pengesikkerhed.sql): chefen kan
// stoppe alle udbetalinger til sælgernes banker og/eller alle nye betalinger
// (Admin → Penge). Databasen håndhæver det (betaling_udbetaling_blokeret,
// saelger_udbetaling_claim og en trigger, der afviser at gemme en ny
// PaymentIntent); serveren tjekker også selv, så Stripe ikke kaldes forgæves.
// Refusioner kører altid videre - kunden skal kunne få sine penge.

import { createAdminClient } from "@/lib/supabase/admin";

export type Noedstop = {
  udbetalingerStoppet: boolean;
  udbetalingerAarsag: string | null;
  udbetalingerKl: string | null;
  nyeBetalingerStoppet: boolean;
  nyeBetalingerAarsag: string | null;
  nyeBetalingerKl: string | null;
};

const CACHE_MS = 5_000;
let cache: { v: Noedstop; kl: number } | null = null;

// Kolonnerne findes ikke (migrationen er ikke kørt): intet nødstop.
const INGEN: Noedstop = {
  udbetalingerStoppet: false,
  udbetalingerAarsag: null,
  udbetalingerKl: null,
  nyeBetalingerStoppet: false,
  nyeBetalingerAarsag: null,
  nyeBetalingerKl: null,
};

// Kan tilstanden ikke læses (andre fejl), regnes begge som stoppet (fail closed).
const UKENDT: Noedstop = { ...INGEN, udbetalingerStoppet: true, nyeBetalingerStoppet: true };

export async function hentNoedstop(friskt = false): Promise<Noedstop> {
  if (!friskt && cache && Date.now() - cache.kl < CACHE_MS) return cache.v;
  let v: Noedstop;
  try {
    const { data, error } = await createAdminClient()
      .from("stripe_tilstand")
      .select(
        "udbetalinger_stoppet, udbetalinger_stoppet_aarsag, udbetalinger_stoppet_kl, nye_betalinger_stoppet, nye_betalinger_stoppet_aarsag, nye_betalinger_stoppet_kl",
      )
      .eq("id", true)
      .maybeSingle<{
        udbetalinger_stoppet: boolean;
        udbetalinger_stoppet_aarsag: string | null;
        udbetalinger_stoppet_kl: string | null;
        nye_betalinger_stoppet: boolean;
        nye_betalinger_stoppet_aarsag: string | null;
        nye_betalinger_stoppet_kl: string | null;
      }>();
    if (error) {
      v = ["42703", "PGRST204"].includes(error.code ?? "") ? INGEN : UKENDT;
    } else if (!data) {
      v = UKENDT;
    } else {
      v = {
        udbetalingerStoppet: !!data.udbetalinger_stoppet,
        udbetalingerAarsag: data.udbetalinger_stoppet_aarsag,
        udbetalingerKl: data.udbetalinger_stoppet_kl,
        nyeBetalingerStoppet: !!data.nye_betalinger_stoppet,
        nyeBetalingerAarsag: data.nye_betalinger_stoppet_aarsag,
        nyeBetalingerKl: data.nye_betalinger_stoppet_kl,
      };
    }
  } catch {
    v = UKENDT;
  }
  cache = { v, kl: Date.now() };
  return v;
}

export function glemNoedstop() {
  cache = null;
}

export const NYE_BETALINGER_STOPPET_TEKST = "Betalingen er midlertidigt sat på pause. Prøv igen senere.";
