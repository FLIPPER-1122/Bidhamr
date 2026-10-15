import "server-only";

// Boost (Filip, 13. okt. 2026). Migration 20261023030000_boost.sql.
//
// Pengestrømmen for KØB af point (100 point for 39 kr.):
//   1. boost_koeb_start låser pris og point på en række i boost_koeb (højst
//      ét åbent køb pr. bruger). Kun private konti (firmaer: 'erhverv').
//   2. En PaymentIntent på BidHamrs PLATFORMSKONTO - ingen on_behalf_of,
//      ingen transfer_data, intet application fee: købet er BidHamrs egen
//      omsætning (med moms). Kort, MobilePay, Apple Pay og Google Pay
//      (automatic_payment_methods), tvungen 3D Secure ('any'). Idempotency
//      key pr. køb og forsøg. Metadata: type 'boost', boost_koeb_id,
//      bruger_id, point, bidhamr_db.
//   3. Webhooken (payment_intent.succeeded) - eller returen fra betalingen,
//      eller cron'en efter 15 min (mistet webhook) - spejler betalingen
//      (boost_koeb_registrer). Først da krediteres pointene, og kun én gang
//      (unikt indeks på ledgeren). Betalt med et andet beløb: ingen point,
//      hele beløbet refunderes automatisk. En kasseret PaymentIntent, der
//      alligevel betales, refunderes som dobbeltbetaling.
//   4. Refusion kun via chefen (Admin -> brugeren -> Boost-point, "Refundér
//      køb") eller Stripe-dashboardet: pointene trækkes tilbage, så langt
//      saldoen rækker (saldoen bliver aldrig negativ).
//   5. Faktura (salgskonto, med moms) og evt. kreditnota laves af fakturakøen
//      (faktura_planlaeg_boost).
//
// Brug af point (boost i 24 timer for 50 point) flytter ingen penge:
// boost_brug i databasen (lås pr. bruger og auktion, idempotens-nøgle).
// Optjening (10 point pr. gennemført salg) og tilbageførsel: boost_point_synk
// i betalings-cron'en.
//
// Stripe er sandheden om penge: databasen spejler kun. Alle beløb i øre.

import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, kraevSammeOffentligeNoegle, StripeTilstandFejl } from "@/lib/stripe";
import { logDriftFejl, renFejltekst } from "@/lib/drift";
import { egenDatabase } from "@/lib/betaling/fremmedeTestdata";
import { hentNoedstop, NYE_BETALINGER_STOPPET_TEKST } from "@/lib/betaling/noedstop";
import { alarmPrTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { kundeSessionTilCheckout, sikrStripeKunde, type BetalingsKanal } from "@/lib/betaling/stripeBetaling";
import { BOOST_TEKST } from "@/lib/boost/tekster";

type Admin = ReturnType<typeof createAdminClient>;

export const BOOST_TYPE = "boost";
const GENERISK = "Betalingen kunne ikke startes. Prøv igen om lidt.";

export type BoostKoebRaekke = {
  id: string;
  bruger_id: string;
  point: number;
  beloeb_oere: number;
  status: "afventer" | "behandles" | "betalt" | "refunderes" | "refunderet" | "annulleret";
  stripe_payment_intent_id: string | null;
  pi_forsoeg: number;
  stripe_charge_id: string | null;
  modtaget_oere: number | null;
  refusion_aarsag: string | null;
  refusion_forsoeg: number;
  stripe_refund_id: string | null;
};

const KOLONNER =
  "id, bruger_id, point, beloeb_oere, status, stripe_payment_intent_id, pi_forsoeg, stripe_charge_id, modtaget_oere, " +
  "refusion_aarsag, refusion_forsoeg, stripe_refund_id";

// Tabellen/funktionen findes ikke (migrationen er ikke kørt endnu).
export function manglerBoost(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST202" ||
    err.code === "42883" ||
    /does not exist|Could not find the (table|function)/i.test(err.message ?? "")
  );
}

async function hentKoeb(admin: Admin, id: string): Promise<BoostKoebRaekke | null> {
  const { data, error } = await admin.from("boost_koeb").select(KOLONNER).eq("id", id).maybeSingle<BoostKoebRaekke>();
  if (error) throw new Error(`boost_koeb: ${error.message}`);
  return data;
}

// Købet for en PaymentIntent (også en kasseret). null = ikke et boost-køb.
export async function boostKoebForPi(piId: string): Promise<BoostKoebRaekke | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("boost_koeb")
    .select(KOLONNER)
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<BoostKoebRaekke>();
  if (error) {
    if (manglerBoost(error)) return null;
    throw new Error(`boost_koeb: ${error.message}`);
  }
  if (data) return data;
  const { data: kasseret, error: kFejl } = await admin
    .from("boost_koeb")
    .select(KOLONNER)
    .contains("tidligere_payment_intents", [piId])
    .limit(1)
    .maybeSingle<BoostKoebRaekke>();
  if (kFejl) throw new Error(`boost_koeb (kasseret): ${kFejl.message}`);
  return kasseret;
}

// Købet for en charge (indsigelse, afstemning). null = ikke et boost-køb.
export async function boostKoebForCharge(chargeId: string): Promise<{ id: string; bruger_id: string } | null> {
  const { data, error } = await createAdminClient()
    .from("boost_koeb")
    .select("id, bruger_id")
    .eq("stripe_charge_id", chargeId)
    .maybeSingle<{ id: string; bruger_id: string }>();
  if (error) return null;
  return data;
}

// Er PaymentIntenten (ud fra metadata) et boost-køb? Uden opslag.
export function erBoostMetadata(md: Stripe.Metadata | null | undefined): boolean {
  return md?.type === BOOST_TYPE && typeof md.boost_koeb_id === "string";
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// ------------------------------------------------------------------ start

// Nødstop for nye betalinger er sat, mens PaymentIntenten blev lavet.
class NoedstopFejl extends Error {}

const START_FEJL: Record<string, { fejl: string; kode: BoostStartFejl["kode"] }> = {
  ugyldig: { fejl: "Ugyldig forespørgsel.", kode: "ugyldig" },
  ikke_fundet: { fejl: "Din konto blev ikke fundet. Log ind igen.", kode: "ikke_fundet" },
  erhverv: { fejl: BOOST_TEKST.kunPrivate, kode: "erhverv" },
  spaerret: { fejl: BOOST_TEKST.spaerret, kode: "spaerret" },
  samtykke: { fejl: BOOST_TEKST.samtykkeMangler, kode: "samtykke" },
};

export type BoostStartFejl = {
  fejl: string;
  kode: "ugyldig" | "ikke_fundet" | "erhverv" | "spaerret" | "samtykke" | "pause" | "betalt" | "fejl";
};

export type BoostStart =
  | {
      ok: true;
      koebId: string;
      clientSecret: string;
      beloebOere: number;
      point: number;
      customerId: string | null;
      customerSessionClientSecret: string | null;
    }
  | BoostStartFejl;

// Brugeren starter (eller genoptager) et køb af point. brugerId SKAL være
// verificeret med auth af kalderen; databasen tjekker igen under lås.
export async function startBoostKoeb(
  brugerId: string,
  kanal: BetalingsKanal = "web",
  samtykke = false,
): Promise<BoostStart> {
  try {
    try {
      await kraevSammeOffentligeNoegle();
    } catch (err) {
      if (err instanceof StripeTilstandFejl) return { fejl: GENERISK, kode: "fejl" };
      throw err;
    }
    if ((await hentNoedstop()).nyeBetalingerStoppet) return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("boost_koeb_start", { p_bruger: brugerId, p_samtykke: samtykke === true });
    if (error) throw new Error(`boost_koeb_start: ${error.message}`);
    const s = data as { kode?: string; id?: string } | null;
    if ((s?.kode !== "ok" && s?.kode !== "findes") || !s.id) {
      return START_FEJL[s?.kode ?? ""] ?? { fejl: GENERISK, kode: "fejl" };
    }
    const k = await hentKoeb(admin, s.id);
    if (!k) return { fejl: GENERISK, kode: "fejl" };
    const pi = await sikrBoostPi(k);
    if (pi.status === "succeeded" || pi.status === "processing") {
      // Allerede betalt (fx en anden fane): spejl det - næste køb er et nyt.
      await spejlBoostPi(pi);
      return { fejl: BOOST_TEKST.allerede_betalt, kode: "betalt" };
    }
    if (pi.status === "canceled" || pi.amount !== Number(k.beloeb_oere) || !pi.client_secret) {
      return { fejl: GENERISK, kode: "fejl" };
    }
    return {
      ok: true,
      koebId: k.id,
      clientSecret: pi.client_secret,
      beloebOere: pi.amount,
      point: Number(k.point),
      customerId: typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null),
      customerSessionClientSecret: await kundeSessionTilCheckout(brugerId, pi, kanal),
    };
  } catch (err) {
    if (err instanceof NoedstopFejl) return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    console.error("startBoostKoeb fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Boost: start køb", fejl: err, brugerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

const OPDATERBARE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation"];

function metadata(k: BoostKoebRaekke): Stripe.MetadataParam {
  const db = egenDatabase();
  return {
    type: BOOST_TYPE,
    boost_koeb_id: k.id,
    bruger_id: k.bruger_id,
    point: String(k.point),
    ...(db ? { bidhamr_db: db } : {}),
  };
}

// Den ene PaymentIntent for købet (oprettes én gang pr. forsøg).
async function sikrBoostPi(k: BoostKoebRaekke, forsoeg = 0): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const admin = createAdminClient();
  const beloeb = Number(k.beloeb_oere);
  if (!Number.isInteger(beloeb) || beloeb < 300) throw new Error(`Ugyldigt boost-beløb for ${k.id}`);

  if (k.stripe_payment_intent_id) {
    const eks = await stripe.paymentIntents.retrieve(k.stripe_payment_intent_id);
    if (eks.status === "canceled" && k.status === "afventer") {
      const { data: ok, error } = await admin.rpc("boost_koeb_nulstil_pi", { p_id: k.id, p_pi: eks.id });
      if (error) throw new Error(`boost_koeb_nulstil_pi: ${error.message}`);
      if (ok !== true || forsoeg >= 2) throw new Error("Boost-købets PaymentIntent kunne ikke nulstilles");
      const ny = await hentKoeb(admin, k.id);
      if (!ny) throw new Error("Boost-købet findes ikke");
      return sikrBoostPi(ny, forsoeg + 1);
    }
    // Beløbet er låst i databasen; 3D Secure tvinges også på ældre intents.
    const mangler3ds = eks.payment_method_options?.card?.request_three_d_secure !== "any";
    if ((eks.amount !== beloeb || mangler3ds || eks.metadata?.boost_koeb_id !== k.id) && OPDATERBARE.includes(eks.status)) {
      return stripe.paymentIntents.update(eks.id, {
        amount: beloeb,
        metadata: metadata(k),
        payment_method_options: { card: { request_three_d_secure: "any" } },
      });
    }
    return eks;
  }

  const kunde = await sikrStripeKunde(k.bruger_id);
  const db = egenDatabase();
  const noegle = `bidhamr-boost-${k.id}-${k.pi_forsoeg}${db ? `-${db}` : ""}`;
  const pi = await stripe.paymentIntents.create(
    {
      amount: beloeb,
      currency: "dkk",
      customer: kunde,
      // Kort, MobilePay, Apple Pay, Google Pay - som den øvrige checkout
      // (styres fra Stripe Dashboard). Betaling til platformen: ingen
      // on_behalf_of, ingen transfer_data, intet application fee.
      automatic_payment_methods: { enabled: true },
      payment_method_options: { card: { request_three_d_secure: "any" } },
      description: `BidHamr boost-point (${k.point} point)`,
      metadata: metadata(k),
    },
    { idempotencyKey: noegle },
  );

  const { data: gemt, error } = await admin.rpc("boost_koeb_gem_pi", {
    p_id: k.id,
    p_pi: pi.id,
    p_forsoeg: k.pi_forsoeg,
  });
  if (error) {
    // Næste kald får samme PaymentIntent tilbage via nøglen (24 t).
    throw new Error(`boost_koeb_gem_pi: ${error.message}`);
  }
  if (gemt === "ok") return pi;
  if (gemt === "noedstop") {
    // Nødstop sat imens: intenten må ikke kunne betales.
    await stripe.paymentIntents
      .cancel(pi.id, { cancellation_reason: "abandoned" }, { idempotencyKey: `bidhamr-noedstop-annuller-${pi.id}` })
      .catch((err: unknown) => console.error("Boost-PI under nødstop:", pi.id, err));
    throw new NoedstopFejl();
  }
  const efter = await hentKoeb(admin, k.id);
  if (efter?.stripe_payment_intent_id && efter.stripe_payment_intent_id !== pi.id) {
    // Et samtidigt kald nåede først: brug dens, og annullér vores, så der
    // aldrig ligger to betalbare intents.
    await stripe.paymentIntents.cancel(pi.id).catch((err: unknown) => console.error("Overskydende boost-PI:", pi.id, err));
    return stripe.paymentIntents.retrieve(efter.stripe_payment_intent_id);
  }
  if (efter?.stripe_payment_intent_id === pi.id) return pi;
  // Købet er ændret imens: vores intent må ikke kunne betales.
  await stripe.paymentIntents.cancel(pi.id).catch((err: unknown) => console.error("Forældet boost-PI:", pi.id, err));
  if (!efter || efter.status !== "afventer" || forsoeg >= 2) throw new Error("Boost-købet kunne ikke startes");
  return sikrBoostPi(efter, forsoeg + 1);
}

// ------------------------------------------------------------------ spejl fra Stripe

// Spejler en boost-PaymentIntent (webhook, retur og cron). Idempotent.
// Svar: databasens kode ('betalt', 'allerede', 'ukendt' ...).
export async function spejlBoostPi(pi: Stripe.PaymentIntent): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("boost_koeb_registrer", {
    p_pi: pi.id,
    p_status: pi.status,
    p_charge: stripeId(pi.latest_charge as string | { id: string } | null),
    p_beloeb: pi.status === "succeeded" ? pi.amount_received : null,
    p_fejl: pi.last_payment_error?.code ?? pi.last_payment_error?.message ?? null,
  });
  if (error) {
    if (manglerBoost(error)) return "ukendt";
    throw new Error(`boost_koeb_registrer: ${error.message}`);
  }
  const svar = data as { kode?: string; id?: string } | null;
  const kode = svar?.kode ?? "ukendt";
  if (kode === "beloeb_afviger" && svar?.id) {
    await alarmPrTilfaelde({
      noegle: `boost-beloeb:${svar.id}`,
      hvor: "betaling/boost",
      fejl: `Boost-køb ${svar.id} (PaymentIntent ${pi.id}) er betalt med et andet beløb end prisen. Der er ikke givet point, og beløbet refunderes automatisk - kontrollér i Stripe.`,
    });
    await refunderBoostKoeb(svar.id);
  }
  if (kode === "kasseret") await refunderKasseret(pi, svar?.id ?? null);
  return kode;
}

// Returen fra betalingen (hjemmesiden): brugeren kommer tilbage med
// payment_intent i adressen. Slås op hos Stripe og spejles, men KUN hvis
// PaymentIntenten er brugerens eget boost-køb. Kaster aldrig.
export async function synkBoostRetur(brugerId: string, piId: string): Promise<string | null> {
  try {
    if (!/^pi_[A-Za-z0-9_]{1,250}$/.test(piId)) return null;
    const k = await boostKoebForPi(piId);
    if (!k || k.bruger_id !== brugerId) return null;
    return await spejlBoostPi(await getStripe().paymentIntents.retrieve(piId));
  } catch (err) {
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Boost: retur fra betaling", fejl: err, brugerId });
    return null;
  }
}

// En kasseret PaymentIntent er alligevel betalt: brugeren har betalt to
// gange - den refunderes helt. Idempotent.
async function refunderKasseret(pi: Stripe.PaymentIntent, koebId: string | null): Promise<void> {
  const stripe = getStripe();
  const eksisterende = await stripe.refunds.list({ payment_intent: pi.id, limit: 20 });
  if (!eksisterende.data.some((r) => r.status !== "failed" && r.status !== "canceled")) {
    await stripe.refunds.create(
      {
        payment_intent: pi.id,
        reason: "duplicate",
        metadata: {
          type: BOOST_TYPE,
          boost_koeb_id: koebId ?? "",
          kasseret: "ja",
          ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}),
        },
      },
      { idempotencyKey: `bidhamr-boost-kasseret-${pi.id}` },
    );
  }
  await alarmPrTilfaelde({
    noegle: `boost-kasseret:${pi.id}`,
    hvor: "betaling/boost",
    fejl: `En kasseret PaymentIntent for boost-køb ${koebId ?? "?"} (${pi.id}) er betalt - mulig dobbeltbetaling. Den er refunderet automatisk; kontrollér i Stripe.`,
  });
}

// ------------------------------------------------------------------ refusion

// Refunderer HELE købet for en claimet række ('refunderes'). Aldrig dobbelt:
// eksisterende refusioner på PaymentIntenten slås op først, og nøglen er fast
// pr. køb og forsøg. Svar: databasens kode. Kaster aldrig.
export async function refunderBoostKoeb(koebId: string): Promise<string> {
  const admin = createAdminClient();
  const stripe = getStripe();
  let k: BoostKoebRaekke | null = null;
  try {
    k = await hentKoeb(admin, koebId);
    if (!k) return "ikke_fundet";
    if (k.status === "refunderet") return "allerede";
    if (k.status !== "refunderes" || !k.stripe_payment_intent_id) return "forkert_status";
    const piId = k.stripe_payment_intent_id;
    const alle = await stripe.refunds.list({ payment_intent: piId, limit: 100 });
    const aktive = alle.data.filter((r) => r.status !== "failed" && r.status !== "canceled");
    const vores = aktive.find((r) => r.metadata?.boost_koeb_id === k!.id && r.metadata?.type === BOOST_TYPE);
    let refund: Stripe.Refund | null = vores ?? null;
    if (!refund && aktive.length > 0) {
      // Refunderet uden om BidHamr (fx i dashboardet): opret intet nyt.
      const sum = aktive.reduce((s, r) => s + r.amount, 0);
      const betalt = Number(k.modtaget_oere ?? k.beloeb_oere);
      if (sum >= betalt) refund = aktive[0];
      else {
        await alarmPrTilfaelde({
          noegle: `boost-delvis:${k.id}`,
          hvor: "betaling/boost",
          fejl: `Boost-køb ${k.id} er delvist refunderet uden om BidHamr - refundér resten manuelt i Stripe.`,
        });
        const { data } = await admin.rpc("boost_koeb_refusion_resultat", {
          p_id: k.id,
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
            type: BOOST_TYPE,
            boost_koeb_id: k.id,
            bruger_id: k.bruger_id,
            ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}),
          },
        },
        { idempotencyKey: `bidhamr-boost-refusion-${k.id}-${k.refusion_forsoeg}` },
      );
    }
    const ok = refund.status !== "failed" && refund.status !== "canceled";
    const { data, error } = await admin.rpc("boost_koeb_refusion_resultat", {
      p_id: k.id,
      p_ok: ok,
      p_refund: refund.id,
      p_fejl: ok ? null : `Refusionen ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe`,
    });
    if (error) throw new Error(`boost_koeb_refusion_resultat: ${error.message}`);
    const kode = String(data);
    if (kode === "opgivet") {
      await alarmPrTilfaelde({
        noegle: `boost-refusion-opgivet:${k.id}`,
        hvor: "betaling/boost",
        fejl: `Refusionen af boost-køb ${k.id} er fejlet 5 gange - refundér manuelt i Stripe.`,
      });
    }
    return kode;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Boost: refusion", fejl: err });
    if (k?.status === "refunderes") {
      const { data } = await admin.rpc("boost_koeb_refusion_resultat", {
        p_id: k.id,
        p_ok: false,
        p_refund: null,
        p_fejl: renFejltekst(err, 300),
      });
      if (String(data) === "opgivet") {
        await alarmPrTilfaelde({
          noegle: `boost-refusion-opgivet:${k.id}`,
          hvor: "betaling/boost",
          fejl: `Refusionen af boost-køb ${k.id} er fejlet 5 gange - refundér manuelt i Stripe.`,
        });
      }
    }
    return "fejl";
  }
}

const STAFF_REFUSION_FEJL: Record<string, string> = {
  ingen_adgang: "Kun chefen kan refundere et køb af boost-point.",
  inhabil: "Du kan ikke refundere dit eget køb.",
  begrundelse_mangler: "Skriv en begrundelse.",
  ikke_fundet: "Købet findes ikke.",
  forkert_status: "Købet er ikke betalt (eller er allerede refunderet).",
};

// Chefen: "Refundér køb". staffId SKAL være verificeret (assertRole);
// databasen tjekker rolle igen, trækker pointene tilbage og logger.
export async function staffRefunderBoostKoeb(
  staffId: string,
  koebId: string,
  begrundelse: string,
): Promise<{ ok: true; kode: string; trukket: number; oensket: number } | { fejl: string }> {
  const { data, error } = await createAdminClient().rpc("boost_staff_refusion", {
    p_staff: staffId,
    p_id: koebId,
    p_begrundelse: begrundelse,
  });
  if (error) throw new Error(`boost_staff_refusion: ${error.message}`);
  const s = data as { kode?: string; trukket?: number; oensket?: number } | null;
  if (s?.kode !== "ok") return { fejl: STAFF_REFUSION_FEJL[s?.kode ?? ""] ?? "Noget gik galt. Prøv igen om lidt." };
  // Fejler Stripe-kaldet, prøver cron'en igen (status 'refunderes').
  return { ok: true, kode: await refunderBoostKoeb(koebId), trukket: Number(s.trukket ?? 0), oensket: Number(s.oensket ?? 0) };
}

// refund.failed / refund.updated på en boost-refusion: tilbage til
// 'refunderes', så cron'en prøver igen. Svar: kode eller null (ikke vores).
export async function spejlBoostRefusionsfejl(refund: Stripe.Refund): Promise<string | null> {
  if (refund.metadata?.type !== BOOST_TYPE) return null;
  if (refund.status !== "failed" && refund.status !== "canceled") return refund.status ?? "ukendt";
  const { data, error } = await createAdminClient().rpc("boost_koeb_refusion_fejlet", {
    p_refund: refund.id,
    p_fejl: `Refusionen ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe${refund.failure_reason ? ` (${refund.failure_reason})` : ""}`,
  });
  if (error) {
    if (manglerBoost(error)) return null;
    throw new Error(`boost_koeb_refusion_fejlet: ${error.message}`);
  }
  return String(data);
}

// charge.refunded på et boost-køb (fx refunderet i Stripe-dashboardet):
// købet markeres refunderet, og pointene trækkes tilbage. Svar: kode eller
// null (ikke et boost-køb).
export async function spejlBoostChargeRefusion(charge: Stripe.Charge): Promise<string | null> {
  const refusioner = (charge.refunds?.data ?? []).filter((r) => r.status !== "failed" && r.status !== "canceled");
  const nyeste = refusioner.sort((a, b) => b.created - a.created)[0]?.id ?? null;
  const { data, error } = await createAdminClient().rpc("boost_koeb_registrer_charge_refusion", {
    p_charge: charge.id,
    p_refund: nyeste,
    p_fuld: charge.refunded === true,
  });
  if (error) {
    if (manglerBoost(error)) return null;
    throw new Error(`boost_koeb_registrer_charge_refusion: ${error.message}`);
  }
  const kode = String(data);
  if (kode === "ukendt") return null;
  if (kode === "markeret") {
    await alarmPrTilfaelde({
      noegle: `boost-delvis:${charge.id}`,
      hvor: "betaling/boost",
      fejl: `Boost-købets charge ${charge.id} er delvist refunderet hos Stripe uden om BidHamr. Kontrollér det, og justér brugerens point.`,
    });
  }
  return kode;
}

// ------------------------------------------------------------------ brug boost

export type BoostBrugKode =
  | "ok"
  | "allerede"
  | "boostet"
  | "for_faa_point"
  | "ikke_ejer"
  | "ikke_aktiv"
  | "slutter_snart"
  | "erhverv"
  | "spaerret"
  | "ikke_fundet"
  | "ugyldig"
  | "fejl";

export type BoostBrug =
  | { ok: true; kode: "ok" | "allerede"; boostId: string; slutKl: string; saldo: number }
  | { fejl: string; kode: Exclude<BoostBrugKode, "ok" | "allerede">; saldo?: number; pris?: number; slutKl?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ejeren booster sin egen auktion. brugerId SKAL være verificeret med auth;
// noegle er klientens idempotens-nøgle (uuid - samme nøgle = samme boost).
export async function brugBoost(brugerId: string, auktionId: unknown, noegle: unknown): Promise<BoostBrug> {
  if (typeof auktionId !== "string" || !UUID.test(auktionId) || typeof noegle !== "string" || !UUID.test(noegle)) {
    return { fejl: BOOST_TEKST.fejl.ugyldig, kode: "ugyldig" };
  }
  try {
    const { data, error } = await createAdminClient().rpc("boost_brug", {
      p_bruger: brugerId,
      p_auktion: auktionId,
      p_noegle: noegle,
    });
    if (error) {
      // Saldoen tjekkes igen i databasen under lås (BHB01) - vis det som
      // "for få point", ikke som en fejl.
      if (error.code === "BHB01") return { fejl: BOOST_TEKST.fejl.for_faa_point, kode: "for_faa_point" };
      if (error.code === "BHB03") return { fejl: BOOST_TEKST.fejl.boostet, kode: "boostet" };
      throw new Error(`boost_brug: ${error.message}`);
    }
    const s = data as { kode?: string; boost_id?: string; slut_kl?: string; saldo?: number; pris?: number } | null;
    if ((s?.kode === "ok" || s?.kode === "allerede") && s.boost_id && s.slut_kl) {
      return { ok: true, kode: s.kode, boostId: s.boost_id, slutKl: s.slut_kl, saldo: Number(s.saldo ?? 0) };
    }
    const kode = (s?.kode ?? "fejl") as Exclude<BoostBrugKode, "ok" | "allerede">;
    const tekst = BOOST_TEKST.fejl[kode as keyof typeof BOOST_TEKST.fejl] ?? BOOST_TEKST.fejl.fejl;
    return {
      fejl: tekst,
      kode: kode in BOOST_TEKST.fejl ? kode : "fejl",
      ...(s?.saldo !== undefined ? { saldo: Number(s.saldo) } : {}),
      ...(s?.pris !== undefined ? { pris: Number(s.pris) } : {}),
      ...(s?.slut_kl ? { slutKl: s.slut_kl } : {}),
    };
  } catch (err) {
    await logDriftFejl({ kilde: "action", sti: "boost", hvor: "Boost: brug", fejl: err, brugerId });
    return { fejl: BOOST_TEKST.fejl.fejl, kode: "fejl" };
  }
}

// ------------------------------------------------------------------ cron

export type BoostCronResultat = { synket: number; refunderet: number; optjent: number; tilbagefoert: number; fejl: number };

// Kaldes fra betalings-cron'en: mistede webhooks (åbne køb med PaymentIntent
// i over 15 min), refusioner, der skal prøves igen, og point ved salg
// (optjening og tilbageførsel). null = migrationen er ikke kørt.
export async function koerBoostCron(): Promise<BoostCronResultat | null> {
  const r: BoostCronResultat = { synket: 0, refunderet: 0, optjent: 0, tilbagefoert: 0, fejl: 0 };
  const admin = createAdminClient();

  const { data: synk, error: synkFejl } = await admin.rpc("boost_point_synk", { p_graense: 500 });
  if (synkFejl) {
    if (manglerBoost(synkFejl)) return null;
    throw new Error(`boost_point_synk: ${synkFejl.message}`);
  }
  const p = synk as { optjent?: number; tilbagefoert?: number } | null;
  r.optjent = Number(p?.optjent ?? 0);
  r.tilbagefoert = Number(p?.tilbagefoert ?? 0);

  const { data, error } = await admin.rpc("boost_koeb_cron", { p_graense: 20 });
  if (error) throw new Error(`boost_koeb_cron: ${error.message}`);
  const opgaver = (data ?? []) as { id: string; handling: string }[];
  if (opgaver.length === 0) return r;
  const stripe = getStripe();
  for (const o of opgaver) {
    try {
      const k = await hentKoeb(admin, o.id);
      if (!k) continue;
      if (o.handling === "synk" && k.stripe_payment_intent_id) {
        await spejlBoostPi(await stripe.paymentIntents.retrieve(k.stripe_payment_intent_id));
        r.synket++;
      } else if (o.handling === "refusion") {
        if ((await refunderBoostKoeb(k.id)) === "refunderet") r.refunderet++;
      }
    } catch (err) {
      r.fejl++;
      await logDriftFejl({ kilde: "cron", sti: "boost", hvor: `Boost: ${o.handling}`, fejl: err });
    }
  }
  return r;
}
