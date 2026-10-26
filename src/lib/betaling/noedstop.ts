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
// den som normalt.
//
// En annulleret PaymentIntent fjernes fra betalingen med det samme
// (betaling_nulstil_annulleret_pi: gemmes i tidligere_payment_intents,
// pi_forsoeg + 1), så den ikke slås op igen ved næste kørsel, og checkout
// laver en ny efter stoppet. Sorteret efter id, 100 ad gangen, højst 500 pr.
// kald og højst ca. 45 sekunder (Vercels tidsgrænse). 'tilbage' > 0 betyder:
// kør igen. Kaster aldrig.
export type Annullering = { annulleret: number; fejlet: number; igang: number; tilbage: number };

const SIDE = 100;
const MAKS = 500;
const TIDSGRAENSE_MS = 45_000;

export async function annullerAabneBetalinger(): Promise<Annullering> {
  const res: Annullering = { annulleret: 0, fejlet: 0, igang: 0, tilbage: 0 };
  const admin = createAdminClient();
  const stripe = getStripe();
  const start = Date.now();
  let efterId: string | null = null;
  let set = 0;
  let stoppetTidligt = false;

  ydre: while (true) {
    let q = admin
      .from("betalinger")
      .select("id, stripe_payment_intent_id")
      .eq("status", "afventer")
      .not("stripe_payment_intent_id", "is", null)
      .order("id", { ascending: true })
      .limit(SIDE);
    if (efterId) q = q.gt("id", efterId);
    const { data, error } = await q;
    if (error) {
      console.error("annullerAabneBetalinger: kunne ikke hente betalinger:", error.message);
      res.fejlet++;
      break;
    }
    const side = (data ?? []) as { id: string; stripe_payment_intent_id: string }[];
    if (side.length === 0) break;
    for (const r of side) {
      if (set >= MAKS || Date.now() - start > TIDSGRAENSE_MS) {
        stoppetTidligt = true;
        break ydre;
      }
      set++;
      efterId = r.id;
      const piId = r.stripe_payment_intent_id;
      try {
        let pi = await stripe.paymentIntents.retrieve(piId);
        if (pi.status === "succeeded" || pi.status === "processing" || pi.status === "requires_capture") {
          res.igang++;
          continue;
        }
        if (pi.status !== "canceled") {
          if (!AABNE.includes(pi.status)) {
            res.igang++;
            continue;
          }
          try {
            pi = await stripe.paymentIntents.cancel(
              piId,
              { cancellation_reason: "abandoned" },
              { idempotencyKey: `bidhamr-noedstop-annuller-${piId}` },
            );
          } catch (err) {
            // Fx er betalingen gået i gang i mellemtiden.
            pi = await stripe.paymentIntents.retrieve(piId);
            if (pi.status !== "canceled") {
              if (pi.status === "succeeded" || pi.status === "processing") res.igang++;
              else {
                console.error("annullerAabneBetalinger: kunne ikke annullere:", piId, err);
                res.fejlet++;
              }
              continue;
            }
          }
        }
        // Annulleret hos Stripe: fjernes fra betalingen (kun hvis den stadig
        // er den gemte og betalingen afventer).
        const { error: nFejl } = await admin.rpc("betaling_nulstil_annulleret_pi", {
          p_betaling: r.id,
          p_pi: piId,
        });
        if (nFejl) throw new Error(`betaling_nulstil_annulleret_pi: ${nFejl.message}`);
        res.annulleret++;
      } catch (err) {
        console.error("annullerAabneBetalinger:", piId, err);
        res.fejlet++;
      }
    }
    if (side.length < SIDE) break;
  }

  // Returfragt i sager (returfragt.ts): åbne returfragt-PaymentIntents
  // annulleres på samme måde (annullerAabneReturfragter).
  if (!stoppetTidligt) {
    const rf = await annullerAabneReturfragter(Math.max(0, MAKS - set), start);
    res.annulleret += rf.annulleret;
    res.fejlet += rf.fejlet;
    res.igang += rf.igang;
    res.tilbage = Math.max(res.tilbage, rf.tilbage);
    // Køb af boost-point (boost.ts): åbne boost-PaymentIntents annulleres
    // på samme måde.
    const bk = await annullerAabneBoostKoeb(Math.max(0, MAKS - set - rf.annulleret - rf.igang - rf.fejlet), start);
    res.annulleret += bk.annulleret;
    res.fejlet += bk.fejlet;
    res.igang += bk.igang;
    res.tilbage = Math.max(res.tilbage, bk.tilbage);
    // Ugens butik (ugensButik.ts): åbne PaymentIntents på reservationer
    // annulleres på samme måde (reservationen udløber af sig selv).
    const ub = await annullerAabneUgensButik(
      Math.max(0, MAKS - set - rf.annulleret - rf.igang - rf.fejlet - bk.annulleret - bk.igang - bk.fejlet),
      start,
    );
    res.annulleret += ub.annulleret;
    res.fejlet += ub.fejlet;
    res.igang += ub.igang;
    res.tilbage = Math.max(res.tilbage, ub.tilbage);
  }

  if (stoppetTidligt) {
    const { count } = await admin
      .from("betalinger")
      .select("id", { count: "exact", head: true })
      .eq("status", "afventer")
      .not("stripe_payment_intent_id", "is", null)
      .gt("id", efterId ?? "00000000-0000-0000-0000-000000000000");
    res.tilbage = Math.max(1, count ?? 1);
  }
  return res;
}

// Åbne boost-PaymentIntents (køb af point, status 'afventer') annulleres hos
// Stripe (idempotency key) og kasseres i databasen (boost_koeb_nulstil_pi,
// pi_forsoeg + 1) - næste køb efter stoppet laver en ny. 'behandles' røres
// ikke (kan være på vej igennem banken). Mangler tabellen (migrationen er
// ikke kørt), springes det over. Kaster aldrig.
export async function annullerAabneBoostKoeb(maks = MAKS, start = Date.now()): Promise<Annullering> {
  const res: Annullering = { annulleret: 0, fejlet: 0, igang: 0, tilbage: 0 };
  maks = Math.max(0, maks);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("boost_koeb")
    .select("id, stripe_payment_intent_id")
    .eq("status", "afventer")
    .not("stripe_payment_intent_id", "is", null)
    .order("id", { ascending: true })
    .limit(maks + 1);
  if (error) {
    if (!/does not exist|Could not find the table|42P01|PGRST205/i.test(`${error.code ?? ""} ${error.message}`)) {
      console.error("annullerAabneBoostKoeb: kunne ikke hente boost-køb:", error.message);
      res.fejlet++;
    }
    return res;
  }
  const raekker = (data ?? []) as { id: string; stripe_payment_intent_id: string }[];
  if (raekker.length === 0) return res;
  const stripe = getStripe();
  let n = 0;
  for (const r of raekker) {
    // Budgettet (maks) er brugt, eller tiden er gået: kør igen.
    if (n >= maks || Date.now() - start > TIDSGRAENSE_MS) {
      res.tilbage = Math.max(1, raekker.length - n);
      break;
    }
    n++;
    const piId = r.stripe_payment_intent_id;
    try {
      let pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status !== "canceled") {
        if (!AABNE.includes(pi.status)) {
          res.igang++;
          continue;
        }
        try {
          pi = await stripe.paymentIntents.cancel(
            piId,
            { cancellation_reason: "abandoned" },
            { idempotencyKey: `bidhamr-noedstop-annuller-${piId}` },
          );
        } catch (err) {
          pi = await stripe.paymentIntents.retrieve(piId);
          if (pi.status !== "canceled") {
            if (pi.status === "succeeded" || pi.status === "processing") res.igang++;
            else {
              console.error("annullerAabneBoostKoeb: kunne ikke annullere:", piId, err);
              res.fejlet++;
            }
            continue;
          }
        }
      }
      const { error: nFejl } = await admin.rpc("boost_koeb_nulstil_pi", { p_id: r.id, p_pi: piId });
      if (nFejl) throw new Error(`boost_koeb_nulstil_pi: ${nFejl.message}`);
      res.annulleret++;
    } catch (err) {
      console.error("annullerAabneBoostKoeb:", piId, err);
      res.fejlet++;
    }
  }
  return res;
}

// Åbne PaymentIntents på Ugens butik-reservationer (status 'reserveret')
// annulleres hos Stripe (idempotency key) og kasseres i databasen
// (ugens_butik_nulstil_pi, pi_forsoeg + 1). 'behandles' røres ikke. Mangler
// tabellen (migrationen er ikke kørt), springes det over. Kaster aldrig.
export async function annullerAabneUgensButik(maks = MAKS, start = Date.now()): Promise<Annullering> {
  const res: Annullering = { annulleret: 0, fejlet: 0, igang: 0, tilbage: 0 };
  maks = Math.max(0, maks);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ugens_butik_bookinger")
    .select("id, stripe_payment_intent_id")
    .eq("status", "reserveret")
    .not("stripe_payment_intent_id", "is", null)
    .order("id", { ascending: true })
    .limit(maks + 1);
  if (error) {
    if (!/does not exist|Could not find the table|42P01|PGRST205/i.test(`${error.code ?? ""} ${error.message}`)) {
      console.error("annullerAabneUgensButik: kunne ikke hente bookinger:", error.message);
      res.fejlet++;
    }
    return res;
  }
  const raekker = (data ?? []) as { id: string; stripe_payment_intent_id: string }[];
  if (raekker.length === 0) return res;
  const stripe = getStripe();
  let n = 0;
  for (const r of raekker) {
    if (n >= maks || Date.now() - start > TIDSGRAENSE_MS) {
      res.tilbage = Math.max(1, raekker.length - n);
      break;
    }
    n++;
    const piId = r.stripe_payment_intent_id;
    try {
      let pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status !== "canceled") {
        if (!AABNE.includes(pi.status)) {
          res.igang++;
          continue;
        }
        try {
          pi = await stripe.paymentIntents.cancel(
            piId,
            { cancellation_reason: "abandoned" },
            { idempotencyKey: `bidhamr-noedstop-annuller-${piId}` },
          );
        } catch (err) {
          pi = await stripe.paymentIntents.retrieve(piId);
          if (pi.status !== "canceled") {
            if (pi.status === "succeeded" || pi.status === "processing") res.igang++;
            else {
              console.error("annullerAabneUgensButik: kunne ikke annullere:", piId, err);
              res.fejlet++;
            }
            continue;
          }
        }
      }
      const { error: nFejl } = await admin.rpc("ugens_butik_nulstil_pi", { p_id: r.id, p_pi: piId });
      if (nFejl) throw new Error(`ugens_butik_nulstil_pi: ${nFejl.message}`);
      res.annulleret++;
    } catch (err) {
      console.error("annullerAabneUgensButik:", piId, err);
      res.fejlet++;
    }
  }
  return res;
}

// Åbne returfragt-PaymentIntents (status 'afventer') annulleres hos Stripe
// (idempotency key) og kasseres i databasen (returfragt_nulstil_pi, pi_forsoeg
// + 1) - næste start efter stoppet laver en ny. Mangler tabellen
// (migrationen er ikke kørt), springes det over. Kaster aldrig.
export async function annullerAabneReturfragter(maks = MAKS, start = Date.now()): Promise<Annullering> {
  const res: Annullering = { annulleret: 0, fejlet: 0, igang: 0, tilbage: 0 };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("returfragt_betalinger")
    .select("id, stripe_payment_intent_id")
    .eq("status", "afventer")
    .not("stripe_payment_intent_id", "is", null)
    .order("id", { ascending: true })
    .limit(Math.max(1, maks));
  if (error) {
    if (!/does not exist|Could not find the table|42P01|PGRST205/i.test(`${error.code ?? ""} ${error.message}`)) {
      console.error("annullerAabneReturfragter: kunne ikke hente returfragter:", error.message);
      res.fejlet++;
    }
    return res;
  }
  const raekker = (data ?? []) as { id: string; stripe_payment_intent_id: string }[];
  if (raekker.length === 0) return res;
  const stripe = getStripe();
  let n = 0;
  for (const r of raekker) {
    if (n >= maks || Date.now() - start > TIDSGRAENSE_MS) {
      res.tilbage = Math.max(1, raekker.length - n);
      break;
    }
    n++;
    const piId = r.stripe_payment_intent_id;
    try {
      let pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status !== "canceled") {
        if (!AABNE.includes(pi.status)) {
          res.igang++;
          continue;
        }
        try {
          pi = await stripe.paymentIntents.cancel(
            piId,
            { cancellation_reason: "abandoned" },
            { idempotencyKey: `bidhamr-noedstop-annuller-${piId}` },
          );
        } catch (err) {
          pi = await stripe.paymentIntents.retrieve(piId);
          if (pi.status !== "canceled") {
            if (pi.status === "succeeded" || pi.status === "processing") res.igang++;
            else {
              console.error("annullerAabneReturfragter: kunne ikke annullere:", piId, err);
              res.fejlet++;
            }
            continue;
          }
        }
      }
      const { error: nFejl } = await admin.rpc("returfragt_nulstil_pi", { p_id: r.id, p_pi: piId });
      if (nFejl) throw new Error(`returfragt_nulstil_pi: ${nFejl.message}`);
      res.annulleret++;
    } catch (err) {
      console.error("annullerAabneReturfragter:", piId, err);
      res.fejlet++;
    }
  }
  return res;
}
