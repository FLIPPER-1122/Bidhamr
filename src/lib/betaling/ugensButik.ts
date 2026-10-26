import "server-only";

// "Ugens butik" - betalt forsideplads for firmaer (Filip, 26. okt. 2026).
// Migration 20261101020000_ugens_butik.sql (regler, låse og tilstande).
//
// Pengestrømmen (BidHamrs EGEN omsætning - som boost, src/lib/betaling/boost.ts):
//   1. ugens_butik_koeb_start reserverer ugen i 30 minutter (unikt indeks pr.
//      uge + lås, så to firmaer aldrig får samme uge) og låser prisen på
//      bookingen: 500 kr. + 25 % moms = 625 kr. (ugens_butik_indstillinger),
//      minus pakkens rabat (erhverv_pakker.ugens_butik_rabat_procent/_antal,
//      fx Butik 50 % de første 3 uger pr. kalenderår) - ugens_butik_pris_for.
//      Kun aktive firmaer, fra næste uge og højst 12 uger frem.
//   2. En PaymentIntent på BidHamrs PLATFORMSKONTO - ingen on_behalf_of,
//      ingen transfer_data, intet application fee. Kort (inkl. Apple Pay og
//      Google Pay), MobilePay og Revolut Pay, som de er slået til på
//      platformen (betalingsmetoder.ts), tvungen 3D Secure ('any').
//      Idempotency key pr. booking og forsøg. Metadata: type 'ugens_butik',
//      ugens_butik_id, firma_id, uge, bidhamr_db.
//   3. Webhooken (payment_intent.*) - eller returen fra betalingen, eller
//      cron'en efter 15 min - spejler betalingen (ugens_butik_registrer).
//      Først da har firmaet ugen. Betalt med et andet beløb, eller for sent
//      (ugen er taget af et andet firma, eller staff har annulleret): hele
//      beløbet refunderes automatisk. En kasseret PaymentIntent, der alligevel
//      betales, refunderes som dobbeltbetaling.
//   4. Udløber reservationen, annullerer cron'en PaymentIntenten hos Stripe
//      først (er den betalt imens, spejles den i stedet), og så frigives ugen.
//   5. Refusion kun via chefen (Admin -> Erhverv -> Ugens butik ->
//      "Annullér og refundér", med begrundelse og log) eller automatisk (3).
//   6. Faktura (salgskonto, med moms, firmaets CVR) og kreditnota laves af
//      fakturakøen (faktura_planlaeg_ugens_butik -> Dinero).
//
// Stripe er sandheden om penge: databasen spejler kun. Alle beløb i øre.

import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, kraevSammeOffentligeNoegle, StripeTilstandFejl } from "@/lib/stripe";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { egenDatabase } from "@/lib/betaling/fremmedeTestdata";
import { hentNoedstop, NYE_BETALINGER_STOPPET_TEKST } from "@/lib/betaling/noedstop";
import { alarmPrTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { annullerForkerteMetoder, metodeHandling, metodeNoegle } from "@/lib/betaling/betalingsmetoder";
import { hentPlatformMetoder } from "@/lib/betaling/platformMetoder";
import { foerLancering } from "@/lib/lancering";

type Admin = ReturnType<typeof createAdminClient>;

export const UGENS_BUTIK_TYPE = "ugens_butik";
const GENERISK = "Betalingen kunne ikke startes. Prøv igen om lidt.";

export type UgensButikRaekke = {
  id: string;
  firma_id: string;
  bruger_id: string;
  uge_start: string;
  status: "reserveret" | "behandles" | "betalt" | "manuel" | "udloebet" | "annulleret" | "refunderes" | "refunderet";
  kilde: "firma" | "staff";
  betaling: "stripe" | "ingen";
  beloeb_oere: number;
  rabat_procent: number;
  reserveret_til: string | null;
  stripe_payment_intent_id: string | null;
  pi_forsoeg: number;
  stripe_charge_id: string | null;
  modtaget_oere: number | null;
  refusion_aarsag: string | null;
  refusion_forsoeg: number;
  stripe_refund_id: string | null;
};

const KOLONNER =
  "id, firma_id, bruger_id, uge_start, status, kilde, betaling, beloeb_oere, rabat_procent, reserveret_til, stripe_payment_intent_id, " +
  "pi_forsoeg, stripe_charge_id, modtaget_oere, refusion_aarsag, refusion_forsoeg, stripe_refund_id";

// Tabellen/funktionen findes ikke (migrationen er ikke kørt endnu).
export function manglerUgensButik(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST202" ||
    err.code === "42883" ||
    /does not exist|Could not find the (table|function)/i.test(err.message ?? "")
  );
}

async function hentBooking(admin: Admin, id: string): Promise<UgensButikRaekke | null> {
  const { data, error } = await admin.from("ugens_butik_bookinger").select(KOLONNER).eq("id", id).maybeSingle<UgensButikRaekke>();
  if (error) throw new Error(`ugens_butik_bookinger: ${error.message}`);
  return data;
}

// Bookingen for en PaymentIntent (også en kasseret). null = ikke Ugens butik.
export async function ugensButikForPi(piId: string): Promise<UgensButikRaekke | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ugens_butik_bookinger")
    .select(KOLONNER)
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<UgensButikRaekke>();
  if (error) {
    if (manglerUgensButik(error)) return null;
    throw new Error(`ugens_butik_bookinger: ${error.message}`);
  }
  if (data) return data;
  const { data: kasseret, error: kFejl } = await admin
    .from("ugens_butik_bookinger")
    .select(KOLONNER)
    .contains("tidligere_payment_intents", [piId])
    .limit(1)
    .maybeSingle<UgensButikRaekke>();
  if (kFejl) throw new Error(`ugens_butik_bookinger (kasseret): ${kFejl.message}`);
  return kasseret;
}

// Bookingen for en charge (indsigelse, afstemning). null = ikke Ugens butik.
export async function ugensButikForCharge(chargeId: string): Promise<{ id: string; firma_id: string; bruger_id: string } | null> {
  const { data, error } = await createAdminClient()
    .from("ugens_butik_bookinger")
    .select("id, firma_id, bruger_id")
    .eq("stripe_charge_id", chargeId)
    .maybeSingle<{ id: string; firma_id: string; bruger_id: string }>();
  if (error) return null;
  return data;
}

// Er PaymentIntenten (ud fra metadata) Ugens butik? Uden opslag.
export function erUgensButikMetadata(md: Stripe.Metadata | null | undefined): boolean {
  return md?.type === UGENS_BUTIK_TYPE && typeof md.ugens_butik_id === "string";
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

const DATO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPDATERBARE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation"];
const AABNE_PI: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation", "requires_action"];

// ------------------------------------------------------------------ start

class NoedstopFejl extends Error {}

export type UgensButikStartKode =
  | "ugyldig"
  | "ikke_firma"
  | "spaerret"
  | "ikke_aktiv"
  | "uge_ugyldig"
  | "optaget"
  | "aaben_reservation"
  | "behandles"
  | "foer_lancering"
  | "pause"
  | "betalt"
  | "fejl";

export type UgensButikStart =
  | {
      ok: true;
      bookingId: string;
      uge: string;
      clientSecret: string;
      beloebOere: number;
      // Rabat fra firmaets pakke (0 = fuld pris), låst på bookingen.
      rabatProcent: number;
      reserveretTil: string | null;
    }
  | { fejl: string; kode: UgensButikStartKode; uge?: string };

// Teksterne her er kun en sikkerhed - frontenden viser sine egne ud fra koden
// (se listen til frontend i rapporten / docs). Dansk, kort og uden fagudtryk.
const START_FEJL: Record<string, string> = {
  ugyldig: "Ugyldig forespørgsel.",
  ikke_firma: "Kun firmakonti kan købe Ugens butik.",
  spaerret: "Din konto kan ikke købe lige nu. Skriv til erhverv@bidhamr.dk.",
  ikke_aktiv: "Dit abonnement skal være betalt, før du kan købe Ugens butik.",
  uge_ugyldig: "Vælg en uge fra næste uge og op til 12 uger frem.",
  optaget: "Ugen er desværre taget. Vælg en anden uge.",
  aaben_reservation: "Du har allerede en uge, der venter på betaling. Betal den eller annullér den først.",
  behandles: "Din betaling er ved at blive behandlet. Vent et øjeblik, og opdater siden.",
  foer_lancering: "Ugens butik kan købes, når BidHamr er åbnet.",
  betalt: "Ugen er allerede betalt. Opdater siden.",
};

// Firmaet starter (eller genoptager) købet af en uge. brugerId SKAL være
// verificeret med auth af kalderen; databasen tjekker igen under lås.
// uge: mandagen som 'ÅÅÅÅ-MM-DD'.
export async function startUgensButikKoeb(brugerId: string, uge: unknown, skiftForsoeg = 0): Promise<UgensButikStart> {
  if (typeof uge !== "string" || !DATO.test(uge)) return { fejl: START_FEJL.uge_ugyldig, kode: "uge_ugyldig" };
  if (foerLancering()) return { fejl: START_FEJL.foer_lancering, kode: "foer_lancering" };
  try {
    try {
      await kraevSammeOffentligeNoegle();
    } catch (err) {
      if (err instanceof StripeTilstandFejl) return { fejl: GENERISK, kode: "fejl" };
      throw err;
    }
    if ((await hentNoedstop()).nyeBetalingerStoppet) return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("ugens_butik_koeb_start", { p_bruger: brugerId, p_uge: uge });
    if (error) throw new Error(`ugens_butik_koeb_start: ${error.message}`);
    const s = data as { kode?: string; id?: string; pi?: string | null; gammel_pi?: string[] | null; uge_start?: string } | null;
    // Udløbne reservationer, som databasen har frigivet: deres PaymentIntents
    // annulleres også hos Stripe (bliver en alligevel betalt, refunderes den).
    for (const gammel of s?.gammel_pi ?? []) await annullerGammelPi(gammel);
    if (s?.kode === "noedstop") return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    // Firmaets åbne betaling (anden uge eller udløbet) har en PaymentIntent:
    // annullér den hos Stripe FØRST (er den betalt, spejles den - så har
    // firmaet den uge), og prøv igen.
    if (s?.kode === "skift") {
      if (!s.pi || skiftForsoeg >= 2) return { fejl: GENERISK, kode: "fejl" };
      const gl = await afslutPi(s.pi, "skift");
      if (gl === "betalt") return { fejl: START_FEJL.betalt, kode: "betalt", uge: s.uge_start };
      if (gl === "behandles") return { fejl: START_FEJL.behandles, kode: "behandles" };
      return startUgensButikKoeb(brugerId, uge, skiftForsoeg + 1);
    }
    if ((s?.kode !== "ok" && s?.kode !== "findes") || !s.id) {
      const kode = (s?.kode ?? "fejl") as UgensButikStartKode;
      return { fejl: START_FEJL[kode] ?? GENERISK, kode: kode in START_FEJL ? kode : "fejl", uge: s?.uge_start };
    }
    const b = await hentBooking(admin, s.id);
    if (!b) return { fejl: GENERISK, kode: "fejl" };
    const pi = await sikrPi(b);
    if (pi.status === "succeeded" || pi.status === "processing") {
      await spejlUgensButikPi(pi);
      return pi.status === "succeeded"
        ? { fejl: START_FEJL.betalt, kode: "betalt", uge: b.uge_start }
        : { fejl: START_FEJL.behandles, kode: "behandles" };
    }
    if (pi.status === "canceled" || pi.amount !== Number(b.beloeb_oere) || !pi.client_secret) {
      return { fejl: GENERISK, kode: "fejl" };
    }
    return {
      ok: true,
      bookingId: b.id,
      uge: b.uge_start,
      clientSecret: pi.client_secret,
      beloebOere: pi.amount,
      rabatProcent: Number(b.rabat_procent ?? 0),
      reserveretTil: b.reserveret_til,
    };
  } catch (err) {
    if (err instanceof NoedstopFejl) return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    console.error("startUgensButikKoeb fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Ugens butik: start køb", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

// Annullerer en kasseret PaymentIntent hos Stripe, hvis den stadig kan
// betales. Kaster aldrig (en betalt kasseret PaymentIntent spejles af
// webhooken: ugen gives, hvis den er ledig - ellers refunderes den).
async function annullerGammelPi(piId: string): Promise<void> {
  try {
    const pi = await getStripe().paymentIntents.retrieve(piId);
    if (pi.status === "succeeded" || pi.status === "processing") {
      await spejlUgensButikPi(pi);
      return;
    }
    if (!AABNE_PI.includes(pi.status)) return;
    await getStripe().paymentIntents.cancel(
      piId,
      { cancellation_reason: "abandoned" },
      { idempotencyKey: `bidhamr-ugens-butik-annuller-${piId}` },
    );
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Ugens butik: annullér gammel PaymentIntent", fejl: err });
  }
}

// Annullerer en åben PaymentIntent hos Stripe (idempotency key) og spejler
// resultatet. Nåede den at blive betalt (eller behandles den), spejles det i
// stedet. 'annulleret' | 'betalt' | 'behandles'.
async function afslutPi(piId: string, hvorfor: "skift" | "firma" | "staff" | "udloeb"): Promise<"annulleret" | "betalt" | "behandles"> {
  const stripe = getStripe();
  let pi = await stripe.paymentIntents.retrieve(piId);
  if (AABNE_PI.includes(pi.status)) {
    try {
      pi = await stripe.paymentIntents.cancel(
        piId,
        { cancellation_reason: "abandoned" },
        { idempotencyKey: `bidhamr-ugens-butik-${hvorfor}-${piId}` },
      );
    } catch (err) {
      // Fx betalt i samme øjeblik: slå den op igen og spejl den.
      pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status !== "succeeded" && pi.status !== "processing" && pi.status !== "canceled") throw err;
    }
  }
  await spejlUgensButikPi(pi);
  if (pi.status === "succeeded") return "betalt";
  if (pi.status === "processing") return "behandles";
  if (pi.status !== "canceled") throw new Error(`Ugens butik-PaymentIntent ${piId} kunne ikke annulleres (${pi.status})`);
  return "annulleret";
}

function metadata(b: UgensButikRaekke): Stripe.MetadataParam {
  const db = egenDatabase();
  return {
    type: UGENS_BUTIK_TYPE,
    ugens_butik_id: b.id,
    firma_id: b.firma_id,
    bruger_id: b.bruger_id,
    uge: b.uge_start,
    ...(db ? { bidhamr_db: db } : {}),
  };
}

// Firmaets Stripe-kunde fra abonnementet (CVR som momsnummer), hvis den
// findes. Bruges kun til at samle firmaets betalinger hos Stripe - ingen ny
// kunde oprettes her (abonnementet laver den, src/lib/erhverv/betaling.ts).
async function firmaetsKunde(admin: Admin, firmaId: string): Promise<string | undefined> {
  const { data } = await admin.from("firmaer").select("stripe_customer_id").eq("id", firmaId).maybeSingle<{ stripe_customer_id: string | null }>();
  return data?.stripe_customer_id ?? undefined;
}

// Den ene PaymentIntent for bookingen (oprettes én gang pr. forsøg).
async function sikrPi(b: UgensButikRaekke, forsoeg = 0): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const admin = createAdminClient();
  const beloeb = Number(b.beloeb_oere);
  if (b.betaling !== "stripe" || !Number.isInteger(beloeb) || beloeb < 300) throw new Error(`Ugyldigt beløb for Ugens butik ${b.id}`);

  if (b.stripe_payment_intent_id) {
    const eks = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
    if (eks.status === "canceled" && b.status === "reserveret") {
      const { data: ok, error } = await admin.rpc("ugens_butik_nulstil_pi", { p_id: b.id, p_pi: eks.id });
      if (error) throw new Error(`ugens_butik_nulstil_pi: ${error.message}`);
      if (ok !== true || forsoeg >= 2) throw new Error("Ugens butik: PaymentIntent kunne ikke nulstilles");
      const ny = await hentBooking(admin, b.id);
      if (!ny) throw new Error("Bookingen findes ikke");
      return sikrPi(ny, forsoeg + 1);
    }
    const metoder = await hentPlatformMetoder();
    const metodeValg = metodeHandling(eks, metoder);
    if (metodeValg === "annuller") {
      if (b.status !== "reserveret" || forsoeg >= 2) throw new Error("Ugens butik: PaymentIntent har forkerte betalingsmetoder");
      const efter = await annullerForkerteMetoder(stripe, eks.id);
      if (efter.status !== "canceled") return efter; // betalt imens - kalderen spejler
      const ny = await hentBooking(admin, b.id);
      if (!ny) throw new Error("Bookingen findes ikke");
      return sikrPi(ny, forsoeg + 1);
    }
    // Beløbet er låst i databasen; 3D Secure tvinges også på ældre intents.
    const mangler3ds = eks.payment_method_options?.card?.request_three_d_secure !== "any";
    if (
      (eks.amount !== beloeb || mangler3ds || eks.metadata?.ugens_butik_id !== b.id || metodeValg === "opdater") &&
      OPDATERBARE.includes(eks.status)
    ) {
      return stripe.paymentIntents.update(eks.id, {
        amount: beloeb,
        payment_method_types: metoder,
        metadata: metadata(b),
        payment_method_options: { card: { request_three_d_secure: "any" } },
      });
    }
    return eks;
  }

  const db = egenDatabase();
  const metoder = await hentPlatformMetoder();
  const noegle = `bidhamr-ugens-butik-${b.id}-${b.pi_forsoeg}${db ? `-${db}` : ""}-${metodeNoegle(metoder)}`;
  const kunde = await firmaetsKunde(admin, b.firma_id);
  const pi = await stripe.paymentIntents.create(
    {
      amount: beloeb,
      currency: "dkk",
      ...(kunde ? { customer: kunde } : {}),
      // Kun de tilladte metoder (betalingsmetoder.ts) - aldrig Klarna eller
      // Link. Betaling til platformen: ingen on_behalf_of, ingen
      // transfer_data, intet application fee.
      payment_method_types: metoder,
      payment_method_options: { card: { request_three_d_secure: "any" } },
      description: `BidHamr Ugens butik - uge fra ${b.uge_start}`,
      metadata: metadata(b),
    },
    { idempotencyKey: noegle },
  );

  const { data: gemt, error } = await admin.rpc("ugens_butik_gem_pi", { p_id: b.id, p_pi: pi.id, p_forsoeg: b.pi_forsoeg });
  if (error) throw new Error(`ugens_butik_gem_pi: ${error.message}`);
  if (gemt === "ok") return pi;
  if (gemt === "noedstop") {
    await stripe.paymentIntents
      .cancel(pi.id, { cancellation_reason: "abandoned" }, { idempotencyKey: `bidhamr-noedstop-annuller-${pi.id}` })
      .catch((err: unknown) => console.error("Ugens butik-PI under nødstop:", pi.id, err));
    throw new NoedstopFejl();
  }
  const efter = await hentBooking(admin, b.id);
  if (efter?.stripe_payment_intent_id && efter.stripe_payment_intent_id !== pi.id) {
    // Et samtidigt kald nåede først: brug dens, og annullér vores.
    await stripe.paymentIntents
      .cancel(pi.id, { cancellation_reason: "duplicate" }, { idempotencyKey: `bidhamr-ugens-butik-overskud-${pi.id}` })
      .catch((err: unknown) => console.error("Overskydende Ugens butik-PI:", pi.id, err));
    return stripe.paymentIntents.retrieve(efter.stripe_payment_intent_id);
  }
  if (efter?.stripe_payment_intent_id === pi.id) return pi;
  // Reservationen er udløbet eller ændret imens: vores intent må ikke kunne betales.
  await stripe.paymentIntents
    .cancel(pi.id, { cancellation_reason: "abandoned" }, { idempotencyKey: `bidhamr-ugens-butik-foraeldet-${pi.id}` })
    .catch((err: unknown) => console.error("Forældet Ugens butik-PI:", pi.id, err));
  if (!efter || efter.status !== "reserveret" || forsoeg >= 2) throw new Error("Ugens butik: købet kunne ikke startes");
  return sikrPi(efter, forsoeg + 1);
}

// ------------------------------------------------------------------ firmaet annullerer selv

export type UgensButikAnnuller = { ok: true } | { fejl: string; kode: "ikke_fundet" | "behandles" | "betalt" | "fejl" };

// "Annullér" på firmaets åbne betaling i Firma oversigt. PaymentIntenten
// annulleres hos Stripe FØRST; er den betalt imens, har firmaet ugen.
export async function annullerEgenUgensButik(brugerId: string, bookingId: unknown): Promise<UgensButikAnnuller> {
  if (typeof bookingId !== "string" || !UUID.test(bookingId)) return { fejl: "Ugyldig forespørgsel.", kode: "ikke_fundet" };
  try {
    const admin = createAdminClient();
    const b = await hentBooking(admin, bookingId);
    if (!b || b.bruger_id !== brugerId) return { fejl: "Betalingen findes ikke.", kode: "ikke_fundet" };
    if (b.status === "behandles") return { fejl: START_FEJL.behandles, kode: "behandles" };
    if (b.status !== "reserveret") return { fejl: "Betalingen er ikke åben længere. Opdater siden.", kode: "ikke_fundet" };
    if (b.stripe_payment_intent_id) {
      const r = await afslutPi(b.stripe_payment_intent_id, "firma");
      if (r === "betalt") return { fejl: START_FEJL.betalt, kode: "betalt" };
      if (r === "behandles") return { fejl: START_FEJL.behandles, kode: "behandles" };
    }
    const { data, error } = await admin.rpc("ugens_butik_firma_annuller", {
      p_bruger: brugerId,
      p_id: b.id,
      p_pi: b.stripe_payment_intent_id,
    });
    if (error) throw new Error(`ugens_butik_firma_annuller: ${error.message}`);
    // 'nej': webhooken har allerede kasseret PaymentIntenten (canceled) - prøv igen.
    if (data === "nej") {
      const { data: igen, error: igenFejl } = await admin.rpc("ugens_butik_firma_annuller", { p_bruger: brugerId, p_id: b.id, p_pi: null });
      if (igenFejl) throw new Error(`ugens_butik_firma_annuller: ${igenFejl.message}`);
      if (igen === "ok") return { ok: true };
      return { fejl: "Betalingen er ikke åben længere. Opdater siden.", kode: "ikke_fundet" };
    }
    if (data === "ok") return { ok: true };
    if (data === "behandles") return { fejl: START_FEJL.behandles, kode: "behandles" };
    return { fejl: "Betalingen findes ikke.", kode: "ikke_fundet" };
  } catch (err) {
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Ugens butik: firmaet annullerer", fejl: err, brugerId });
    return { fejl: "Noget gik galt. Prøv igen om lidt.", kode: "fejl" };
  }
}

// ------------------------------------------------------------------ spejl fra Stripe

// Spejler en Ugens butik-PaymentIntent (webhook, retur og cron). Idempotent.
// Svar: databasens kode ('betalt', 'allerede', 'for_sent', 'ukendt' ...).
export async function spejlUgensButikPi(pi: Stripe.PaymentIntent): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ugens_butik_registrer", {
    p_pi: pi.id,
    p_status: pi.status,
    p_charge: stripeId(pi.latest_charge as string | { id: string } | null),
    p_beloeb: pi.status === "succeeded" ? pi.amount_received : null,
    p_fejl: pi.last_payment_error?.code ?? pi.last_payment_error?.message ?? null,
  });
  if (error) {
    if (manglerUgensButik(error)) return "ukendt";
    throw new Error(`ugens_butik_registrer: ${error.message}`);
  }
  const svar = data as { kode?: string; id?: string } | null;
  const kode = svar?.kode ?? "ukendt";
  if ((kode === "beloeb_afviger" || kode === "for_sent") && svar?.id) {
    if (kode === "beloeb_afviger") {
      await alarmPrTilfaelde({
        noegle: `ugens-butik-beloeb:${svar.id}`,
        hvor: "betaling/ugens-butik",
        fejl: `Ugens butik ${svar.id} (PaymentIntent ${pi.id}) er betalt med et andet beløb end prisen. Ugen er ikke givet, og beløbet refunderes automatisk - kontrollér i Stripe.`,
      });
    }
    await refunderUgensButik(svar.id);
  }
  if (kode === "kasseret") await refunderKasseret(pi, svar?.id ?? null);
  return kode;
}

// Returen fra betalingen (Firma oversigt): firmaet kommer tilbage med
// payment_intent i adressen. Slås op hos Stripe og spejles, men KUN hvis
// PaymentIntenten er firmaets egen booking. Kaster aldrig.
// "ikke_fundet": ikke firmaets - vis ingen kvittering. null: noget fejlede
// (vis "behandles" - webhooken gør købet færdigt).
export type UgensButikRetur = { kode: string | null; uge: string | null; beloebOere: number | null };

export async function synkUgensButikRetur(brugerId: string, piId: string): Promise<UgensButikRetur> {
  let b: UgensButikRaekke | null = null;
  try {
    if (!/^pi_[A-Za-z0-9_]{1,250}$/.test(piId)) return { kode: "ikke_fundet", uge: null, beloebOere: null };
    b = await ugensButikForPi(piId);
    if (!b || b.bruger_id !== brugerId) return { kode: "ikke_fundet", uge: null, beloebOere: null };
    const kode = await spejlUgensButikPi(await getStripe().paymentIntents.retrieve(piId));
    return { kode, uge: b.uge_start, beloebOere: Number(b.beloeb_oere) };
  } catch (err) {
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Ugens butik: retur fra betaling", fejl: err, brugerId });
    return { kode: null, uge: b?.uge_start ?? null, beloebOere: b ? Number(b.beloeb_oere) : null };
  }
}

// En kasseret PaymentIntent er alligevel betalt: firmaet har betalt to gange -
// den refunderes helt. Idempotent.
async function refunderKasseret(pi: Stripe.PaymentIntent, bookingId: string | null): Promise<void> {
  const stripe = getStripe();
  const eksisterende = await stripe.refunds.list({ payment_intent: pi.id, limit: 20 });
  if (!eksisterende.data.some((r) => r.status !== "failed" && r.status !== "canceled")) {
    await stripe.refunds.create(
      {
        payment_intent: pi.id,
        reason: "duplicate",
        metadata: {
          type: UGENS_BUTIK_TYPE,
          ugens_butik_id: bookingId ?? "",
          kasseret: "ja",
          ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}),
        },
      },
      { idempotencyKey: `bidhamr-ugens-butik-kasseret-${pi.id}` },
    );
  }
  await alarmPrTilfaelde({
    noegle: `ugens-butik-kasseret:${pi.id}`,
    hvor: "betaling/ugens-butik",
    fejl: `En kasseret PaymentIntent for Ugens butik ${bookingId ?? "?"} (${pi.id}) er betalt - mulig dobbeltbetaling. Den er refunderet automatisk; kontrollér i Stripe.`,
  });
}

// ------------------------------------------------------------------ refusion

// Refunderer HELE beløbet for en claimet booking ('refunderes'). Aldrig
// dobbelt: eksisterende refusioner slås op først, og nøglen er fast pr.
// booking og forsøg. Svar: databasens kode. Kaster aldrig.
export async function refunderUgensButik(bookingId: string): Promise<string> {
  const admin = createAdminClient();
  const stripe = getStripe();
  let b: UgensButikRaekke | null = null;
  try {
    b = await hentBooking(admin, bookingId);
    if (!b) return "ikke_fundet";
    if (b.status === "refunderet") return "allerede";
    if (b.status !== "refunderes" || !b.stripe_payment_intent_id) return "forkert_status";
    const piId = b.stripe_payment_intent_id;
    const alle = await stripe.refunds.list({ payment_intent: piId, limit: 100 });
    const aktive = alle.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
    const vores = aktive.find((r) => r.metadata?.ugens_butik_id === b!.id && r.metadata?.type === UGENS_BUTIK_TYPE);
    let refund: Stripe.Refund | null = vores ?? null;
    if (!refund && aktive.length > 0) {
      // Refunderet uden om BidHamr (fx i dashboardet): opret intet nyt.
      const sum = aktive.reduce((s, r) => s + r.amount, 0);
      const betalt = Number(b.modtaget_oere ?? b.beloeb_oere);
      if (sum >= betalt) refund = aktive[0];
      else {
        await alarmPrTilfaelde({
          noegle: `ugens-butik-delvis:${b.id}`,
          hvor: "betaling/ugens-butik",
          fejl: `Ugens butik ${b.id} er delvist refunderet uden om BidHamr - refundér resten manuelt i Stripe.`,
        });
        const { data } = await admin.rpc("ugens_butik_refusion_resultat", {
          p_id: b.id,
          p_ok: false,
          p_refund: null,
          p_fejl: "Delvis refusion uden om BidHamr",
        });
        return String(data);
      }
    }
    if (!refund) {
      refund = await stripe.refunds.create(
        {
          payment_intent: piId,
          metadata: {
            type: UGENS_BUTIK_TYPE,
            ugens_butik_id: b.id,
            firma_id: b.firma_id,
            ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}),
          },
        },
        { idempotencyKey: `bidhamr-ugens-butik-refusion-${b.id}-${b.refusion_forsoeg}` },
      );
    }
    const ok = refund.status !== "failed" && refund.status !== "canceled";
    const { data, error } = await admin.rpc("ugens_butik_refusion_resultat", {
      p_id: b.id,
      p_ok: ok,
      p_refund: refund.id,
      p_fejl: ok ? null : `Refusionen ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe`,
    });
    if (error) throw new Error(`ugens_butik_refusion_resultat: ${error.message}`);
    const kode = String(data);
    if (kode === "opgivet") await alarmOpgivet(b.id);
    return kode;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Ugens butik: refusion", fejl: err });
    if (b?.status === "refunderes") {
      const { data } = await admin.rpc("ugens_butik_refusion_resultat", {
        p_id: b.id,
        p_ok: false,
        p_refund: null,
        p_fejl: renFejltekst(err, 300),
      });
      if (String(data) === "opgivet") await alarmOpgivet(b.id);
    }
    return "fejl";
  }
}

async function alarmOpgivet(id: string): Promise<void> {
  await alarmPrTilfaelde({
    noegle: `ugens-butik-refusion-opgivet:${id}`,
    hvor: "betaling/ugens-butik",
    fejl: `Refusionen af Ugens butik ${id} er fejlet 5 gange - refundér manuelt i Stripe.`,
  });
}

// refund.failed / refund.updated på en refusion af Ugens butik: tilbage til
// 'refunderes', så cron'en prøver igen. Svar: kode eller null (ikke vores).
export async function spejlUgensButikRefusionsfejl(refund: Stripe.Refund): Promise<string | null> {
  if (refund.metadata?.type !== UGENS_BUTIK_TYPE) return null;
  if (refund.status !== "failed" && refund.status !== "canceled") return refund.status ?? "ukendt";
  if (refund.metadata?.kasseret === "ja") {
    await alarmPrTilfaelde({
      noegle: `ugens-butik-kasseret-refusion-fejlet:${refund.id}`,
      hvor: "betaling/ugens-butik",
      fejl: `Refusionen ${refund.id} af en dobbeltbetaling af Ugens butik (booking ${refund.metadata?.ugens_butik_id || "?"}) ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe${refund.failure_reason ? ` (${refund.failure_reason})` : ""}. Firmaet har betalt to gange - refundér manuelt i Stripe.`,
    });
    return "kasseret_alarm";
  }
  const { data, error } = await createAdminClient().rpc("ugens_butik_refusion_fejlet", {
    p_refund: refund.id,
    p_fejl: `Refusionen ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe${refund.failure_reason ? ` (${refund.failure_reason})` : ""}`,
  });
  if (error) {
    if (manglerUgensButik(error)) return null;
    throw new Error(`ugens_butik_refusion_fejlet: ${error.message}`);
  }
  return String(data);
}

// charge.refunded på Ugens butik (fx refunderet i Stripe-dashboardet).
// Svar: kode eller null (ikke Ugens butik).
export async function spejlUgensButikChargeRefusion(charge: Stripe.Charge): Promise<string | null> {
  const refusioner = (charge.refunds?.data ?? []).filter((r) => r.status !== "failed" && r.status !== "canceled");
  const nyeste = refusioner.sort((a, b) => b.created - a.created)[0]?.id ?? null;
  const { data, error } = await createAdminClient().rpc("ugens_butik_registrer_charge_refusion", {
    p_charge: charge.id,
    p_refund: nyeste,
    p_fuld: charge.refunded === true,
  });
  if (error) {
    if (manglerUgensButik(error)) return null;
    throw new Error(`ugens_butik_registrer_charge_refusion: ${error.message}`);
  }
  const kode = String(data);
  if (kode === "ukendt") return null;
  if (kode === "markeret") {
    await alarmPrTilfaelde({
      noegle: `ugens-butik-delvis:${charge.id}`,
      hvor: "betaling/ugens-butik",
      fejl: `Ugens butik-charge ${charge.id} er delvist refunderet hos Stripe uden om BidHamr. Kontrollér det.`,
    });
  }
  return kode;
}

// Indsigelse fra firmaets bank: bookingen markeres til staff (intet flyttes).
// Svar: 'markeret' | 'ukendt' | null (migrationen er ikke kørt).
export async function spejlUgensButikIndsigelse(d: Pick<Stripe.Dispute, "id" | "status">, chargeId: string): Promise<string | null> {
  const { data, error } = await createAdminClient().rpc("ugens_butik_indsigelse", {
    p_charge: chargeId,
    p_dispute: d.id,
    p_status: d.status,
  });
  if (error) {
    if (manglerUgensButik(error)) return null;
    throw new Error(`ugens_butik_indsigelse: ${error.message}`);
  }
  return String(data);
}

// ------------------------------------------------------------------ staff

const STAFF_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen og sælger-rollen kan styre Ugens butik.",
  kun_chef: "Kun chefen kan annullere eller refundere en betalt uge.",
  begrundelse_mangler: "Skriv en begrundelse.",
  ugyldig: "Ugyldig forespørgsel.",
  ikke_fundet: "Firmaet eller bookingen findes ikke.",
  spaerret: "Firmakontoen er lukket eller suspenderet.",
  ikke_aktiv: "Firmaet har ikke et aktivt abonnement.",
  uge_ugyldig: "Vælg en mandag fra denne uge og frem (med betaling: fra næste uge).",
  optaget: "Ugen er allerede booket.",
  aaben_reservation: "Firmaet har allerede en uge, der venter på betaling.",
  forkert_status: "Bookingen kan ikke ændres sådan.",
  behandles: "Betalingen er ved at blive behandlet hos Stripe. Prøv igen om lidt.",
  inhabil: "Du kan ikke ændre din egen booking.",
  noedstop: NYE_BETALINGER_STOPPET_TEKST,
};

export type StaffSvar = { ok: true; id?: string; status?: string; besked?: string } | { fejl: string; kode: string };

// Staff booker en uge manuelt. staffId SKAL være verificeret (assertErhverv).
export async function staffBookUgensButik(
  staffId: string,
  firmaId: string,
  uge: string,
  medBetaling: boolean,
  begrundelse: string,
): Promise<StaffSvar> {
  if (!UUID.test(firmaId) || !DATO.test(uge)) return { fejl: STAFF_FEJL.ugyldig, kode: "ugyldig" };
  const { data, error } = await createAdminClient().rpc("ugens_butik_staff_book", {
    p_staff: staffId,
    p_firma: firmaId,
    p_uge: uge,
    p_med_betaling: medBetaling,
    p_begrundelse: begrundelse.slice(0, 1000),
  });
  if (error) throw new Error(`ugens_butik_staff_book: ${error.message}`);
  const s = data as { kode?: string; id?: string; status?: string; gammel_pi?: string[] | null } | null;
  for (const gammel of s?.gammel_pi ?? []) await annullerGammelPi(gammel);
  if (s?.kode !== "ok") return { fejl: STAFF_FEJL[s?.kode ?? ""] ?? "Noget gik galt. Prøv igen.", kode: s?.kode ?? "fejl" };
  return { ok: true, id: s.id, status: s.status };
}

// Staff annullerer en booking (chefen kan refundere en betalt). Databasen
// tjekker rollen igen og logger. En åben PaymentIntent annulleres hos Stripe;
// en refusion laves med det samme (cron'en prøver igen, hvis Stripe fejler).
export async function staffAnnullerUgensButik(
  staffId: string,
  bookingId: string,
  begrundelse: string,
  refunder: boolean,
): Promise<StaffSvar> {
  if (!UUID.test(bookingId)) return { fejl: STAFF_FEJL.ugyldig, kode: "ugyldig" };
  const admin = createAdminClient();
  // En åben betaling (reserveret med PaymentIntent) annulleres hos Stripe
  // FØRST, så den ikke kan betales, mens den annulleres. Er den betalt imens,
  // spejles det - så er bookingen betalt, og kun chefen kan annullere den.
  const for_ = await hentBooking(admin, bookingId);
  if (for_?.status === "reserveret" && for_.stripe_payment_intent_id) {
    const r = await afslutPi(for_.stripe_payment_intent_id, "staff");
    if (r === "behandles") return { fejl: STAFF_FEJL.behandles, kode: "behandles" };
    if (r === "betalt") return { fejl: "Firmaet har netop betalt ugen. Opdater siden.", kode: "betalt" };
  }
  const { data, error } = await admin.rpc("ugens_butik_staff_annuller", {
    p_staff: staffId,
    p_id: bookingId,
    p_begrundelse: begrundelse.slice(0, 1000),
    p_refunder: refunder,
  });
  if (error) throw new Error(`ugens_butik_staff_annuller: ${error.message}`);
  const s = data as { kode?: string; status?: string; pi?: string | null } | null;
  if (s?.kode !== "ok") return { fejl: STAFF_FEJL[s?.kode ?? ""] ?? "Noget gik galt. Prøv igen.", kode: s?.kode ?? "fejl" };
  if (s.pi) await annullerGammelPi(s.pi);
  if (s.status === "refunderes") {
    const kode = await refunderUgensButik(bookingId);
    if (kode !== "refunderet" && kode !== "allerede") {
      return {
        ok: true,
        status: "refunderes",
        besked: "Refusionen er bestilt, men Stripe svarede ikke. Den prøves igen automatisk – opdatér siden om lidt.",
      };
    }
    return { ok: true, status: "refunderet" };
  }
  return { ok: true, status: s.status };
}

// Chefen retter prisen (kr. ekskl. moms). Databasen tjekker rollen og logger.
export async function staffSaetUgensButikPris(staffId: string, prisEksklMomsOere: number): Promise<StaffSvar> {
  if (!Number.isInteger(prisEksklMomsOere)) return { fejl: STAFF_FEJL.ugyldig, kode: "ugyldig" };
  const { data, error } = await createAdminClient().rpc("ugens_butik_saet_pris", {
    p_staff: staffId,
    p_pris_ekskl_moms_oere: prisEksklMomsOere,
  });
  if (error) throw new Error(`ugens_butik_saet_pris: ${error.message}`);
  const s = data as { kode?: string } | null;
  if (s?.kode === "ugyldig") return { fejl: "Prisen skal være mellem 100 og 10.000 kr. ekskl. moms.", kode: "ugyldig" };
  if (s?.kode !== "ok") return { fejl: "Kun chefen kan rette prisen.", kode: s?.kode ?? "fejl" };
  return { ok: true };
}

// ------------------------------------------------------------------ cron

export type UgensButikCronResultat = { synket: number; udloebet: number; refunderet: number; fejl: number };

// Kaldes fra betalings-cron'en: udløbne reservationer (PaymentIntenten
// annulleres hos Stripe, før ugen frigives), mistede webhooks og refusioner,
// der skal prøves igen. null = migrationen er ikke kørt.
export async function koerUgensButikCron(): Promise<UgensButikCronResultat | null> {
  const r: UgensButikCronResultat = { synket: 0, udloebet: 0, refunderet: 0, fejl: 0 };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ugens_butik_cron", { p_graense: 20 });
  if (error) {
    if (manglerUgensButik(error)) return null;
    throw new Error(`ugens_butik_cron: ${error.message}`);
  }
  const opgaver = (data ?? []) as { id: string; handling: string }[];
  if (opgaver.length === 0) return r;
  const stripe = getStripe();
  for (const o of opgaver) {
    try {
      const b = await hentBooking(admin, o.id);
      if (!b) continue;
      if (o.handling === "synk" && b.stripe_payment_intent_id) {
        await spejlUgensButikPi(await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id));
        r.synket++;
      } else if (o.handling === "refusion") {
        if ((await refunderUgensButik(b.id)) === "refunderet") r.refunderet++;
      } else if (o.handling === "udloeb") {
        if (b.stripe_payment_intent_id) {
          const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id);
          if (pi.status === "succeeded" || pi.status === "processing") {
            await spejlUgensButikPi(pi);
            continue;
          }
          if (pi.status !== "canceled") {
            try {
              await stripe.paymentIntents.cancel(
                pi.id,
                { cancellation_reason: "abandoned" },
                { idempotencyKey: `bidhamr-ugens-butik-udloeb-${pi.id}` },
              );
            } catch (err) {
              // Betalt i samme øjeblik: spejl den, og lad ugen være.
              const igen = await stripe.paymentIntents.retrieve(pi.id);
              if (igen.status === "succeeded" || igen.status === "processing") {
                await spejlUgensButikPi(igen);
                continue;
              }
              if (igen.status !== "canceled") throw err;
            }
          }
        }
        // Kun hvis bookingens PaymentIntent stadig er den, vi annullerede.
        const { data: ok, error: uFejl } = await admin.rpc("ugens_butik_udloeb", {
          p_id: b.id,
          p_pi: b.stripe_payment_intent_id,
        });
        if (uFejl) throw new Error(`ugens_butik_udloeb: ${uFejl.message}`);
        if (ok === true) r.udloebet++;
      }
    } catch (err) {
      r.fejl++;
      await logDriftFejl({ kilde: "cron", sti: "ugens-butik", hvor: `Ugens butik: ${o.handling}`, fejl: err });
    }
  }
  return r;
}
