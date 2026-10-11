import "server-only";

// Nødstop (sikkerhedsnet A, 20261019010000_pengesikkerhed.sql): chefen kan
// stoppe alle udbetalinger til sælgernes banker og/eller alle nye betalinger
// (Admin → Penge). Databasen håndhæver det (betaling_udbetaling_blokeret,
// saelger_udbetaling_claim og en trigger, der afviser at gemme en ny
// PaymentIntent); serveren tjekker også selv, så Stripe ikke kaldes forgæves.
// Refusioner kører altid videre - kunden skal kunne få sine penge.

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";

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

export const NYE_BETALINGER_STOPPET_TEKST =
  "Betalingen er midlertidigt sat på pause. Din betalingsfrist bliver forlænget, så du når at betale. Prøv igen senere.";

// Stripe-statusser, hvor en PaymentIntent kan annulleres, uden at køberen er
// trukket (docs.stripe.com/api/payment_intents/cancel). 'processing' og
// 'requires_capture' røres ikke: de kan være på vej igennem banken.
const AABNE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation", "requires_action"];

// Nødstop for nye betalinger: åbne PaymentIntents (en køber kan have
// checkout-siden åben med en client_secret) annulleres hos Stripe, så de ikke
// kan betales under stoppet. En betaling, der allerede er sendt til banken
// ('processing', fx MobilePay), kan stadig gå igennem - webhooken registrerer
// den som normalt. Efter stoppet laver checkout en ny PaymentIntent
// (sikrPaymentIntent: annulleret + 'afventer' -> ny). Højst 500 pr. kald.
// Kaster aldrig. Svar: antal annullerede, antal, der ikke kunne annulleres.
export async function annullerAabneBetalinger(): Promise<{ annulleret: number; fejlet: number; igang: number }> {
  const res = { annulleret: 0, fejlet: 0, igang: 0 };
  let raekker: { id: string; stripe_payment_intent_id: string }[] = [];
  try {
    const { data, error } = await createAdminClient()
      .from("betalinger")
      .select("id, stripe_payment_intent_id")
      .eq("status", "afventer")
      .not("stripe_payment_intent_id", "is", null)
      .limit(500);
    if (error) throw new Error(error.message);
    raekker = (data ?? []) as typeof raekker;
  } catch (err) {
    console.error("annullerAabneBetalinger: kunne ikke hente betalinger:", err);
    res.fejlet++;
    return res;
  }
  const stripe = getStripe();
  for (const r of raekker) {
    const piId = r.stripe_payment_intent_id;
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status === "canceled" || pi.status === "succeeded") continue;
      if (!AABNE.includes(pi.status)) {
        res.igang++;
        continue;
      }
      await stripe.paymentIntents.cancel(
        piId,
        { cancellation_reason: "abandoned" },
        { idempotencyKey: `bidhamr-noedstop-annuller-${piId}` },
      );
      res.annulleret++;
    } catch (err) {
      // Fx er betalingen gået i gang i mellemtiden: tjek igen, ellers tæl den.
      try {
        const igen = await stripe.paymentIntents.retrieve(piId);
        if (igen.status === "canceled") {
          res.annulleret++;
          continue;
        }
        if (igen.status === "succeeded" || igen.status === "processing") {
          res.igang++;
          continue;
        }
      } catch {
        // falder igennem
      }
      console.error("annullerAabneBetalinger: kunne ikke annullere:", piId, err);
      res.fejlet++;
    }
  }
  return res;
}
