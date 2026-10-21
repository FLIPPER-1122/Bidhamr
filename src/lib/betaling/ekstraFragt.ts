import "server-only";

// Ekstra fragt ved for lille pakkestørrelse (Filip, 21. okt. 2026). Migration
// 20261029020000_ekstra_fragt.sql. Sælgeren betaler forskellen, som
// fragtfirmaet har opkrævet - der trækkes ALDRIG automatisk i sælgerens penge.
//
// Pengestrømmen:
//   1. Staff opretter regningen (ekstra_fragt_opret - beløbet i øre inkl.
//      moms låses på rækken, frist 14 dage).
//   2. Sælgeren trykker "Betal": ekstra_fragt_betal_start (under lås) og én
//      PaymentIntent pr. regning og forsøg på BidHamrs PLATFORMSKONTO - ingen
//      on_behalf_of, ingen transfer_data, intet application fee: pengene er
//      BidHamrs fragtindtægt. Kort (inkl. Apple Pay/Google Pay), MobilePay og
//      Revolut Pay (betalingsmetoder.ts - aldrig Link/Klarna), tvungen 3D
//      Secure. Idempotency key pr. regning og forsøg. Metadata: type
//      'ekstra_fragt', ekstra_fragt_id, trade_id, saelger_id, bidhamr_db.
//   3. Webhooken (payment_intent.*) - eller returen fra betalingen, eller
//      cron'en efter 15 min (mistet webhook) - spejler betalingen
//      (ekstra_fragt_registrer, idempotent). Spærringen ophører i samme
//      øjeblik (den beregnes af status og frist).
//   4. Indsigelse/frafald kasserer en åben PaymentIntent (annuller_pi): den
//      annulleres hos Stripe med det samme (og af cron'en, hvis det fejler).
//      Betales en kasseret PaymentIntent alligevel: skyldes regningen stadig,
//      adopteres betalingen; ellers refunderes den helt som dobbeltbetaling.
//   5. Faktura til sælgeren (fragtkonto, med moms) og evt. kreditnota laves af
//      fakturakøen (faktura_planlaeg_ekstra_fragt).
//   6. Bankindsigelse (chargeback) på betalingen: spejles
//      (spejlEkstraFragtBankindsigelse). Tabes den, markeres regningen, og
//      staff får en alarm - regningen genåbnes ALDRIG automatisk (Filip, 21.
//      okt. 2026). Staff kan genåbne den (adminEkstraFragt.ts ->
//      ekstra_fragt_genaabn): kreditnota for den tilbageførte betaling, ny
//      frist og ny betalingsrunde (ny PaymentIntent, ny idempotency key). Den
//      tilbageførte PaymentIntent adopteres aldrig igen (kode 'tilbagefoert').
//
// Stripe er sandheden: databasen spejler kun. Alle beløb i øre (heltal).

import Stripe from "stripe";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, kraevSammeOffentligeNoegle, StripeTilstandFejl } from "@/lib/stripe";
import { logDriftFejl } from "@/lib/drift";
import { egenDatabase } from "@/lib/betaling/fremmedeTestdata";
import { hentNoedstop, NYE_BETALINGER_STOPPET_TEKST } from "@/lib/betaling/noedstop";
import { alarmPrTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { annullerForkerteMetoder, metodeHandling, metodeNoegle } from "@/lib/betaling/betalingsmetoder";
import { hentPlatformMetoder } from "@/lib/betaling/platformMetoder";
import { kundeSessionTilCheckout, sikrStripeKunde, type BetalingsKanal } from "@/lib/betaling/stripeBetaling";
import { EKSTRA_FRAGT_SAELGER_FEJL } from "@/lib/ekstraFragt/tekster";

type Admin = ReturnType<typeof createAdminClient>;

export const EKSTRA_FRAGT_TYPE = "ekstra_fragt";
export const EKSTRA_FRAGT_BUCKET = "ekstra-fragt-dokumentation";
const GENERISK = "Betalingen kunne ikke startes. Prøv igen om lidt.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EkstraFragtRaekke = {
  id: string;
  trade_id: string;
  saelger_id: string;
  beloeb_oere: number;
  status: "afventer_betaling" | "behandles" | "betalt" | "indsigelse" | "frafaldet" | "refunderet";
  stripe_payment_intent_id: string | null;
  pi_forsoeg: number;
  stripe_charge_id: string | null;
  annuller_pi: string | null;
};

const KOLONNER = "id, trade_id, saelger_id, beloeb_oere, status, stripe_payment_intent_id, pi_forsoeg, stripe_charge_id, annuller_pi";

// Tabellen/funktionen findes ikke (migrationen er ikke kørt endnu).
export function manglerEkstraFragt(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST202" ||
    err.code === "42883" ||
    /does not exist|Could not find the (table|function)/i.test(err.message ?? "")
  );
}

async function hentRaekke(admin: Admin, id: string): Promise<EkstraFragtRaekke | null> {
  const { data, error } = await admin.from("ekstra_fragt_regninger").select(KOLONNER).eq("id", id).maybeSingle<EkstraFragtRaekke>();
  if (error) throw new Error(`ekstra_fragt_regninger: ${error.message}`);
  return data;
}

// Regningen for en PaymentIntent (også en kasseret). null = ikke ekstra fragt.
export async function ekstraFragtForPi(piId: string): Promise<EkstraFragtRaekke | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ekstra_fragt_regninger")
    .select(KOLONNER)
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<EkstraFragtRaekke>();
  if (error) {
    if (manglerEkstraFragt(error)) return null;
    throw new Error(`ekstra_fragt_regninger: ${error.message}`);
  }
  if (data) return data;
  const { data: kasseret, error: kFejl } = await admin
    .from("ekstra_fragt_regninger")
    .select(KOLONNER)
    .contains("tidligere_payment_intents", [piId])
    .limit(1)
    .maybeSingle<EkstraFragtRaekke>();
  if (kFejl) throw new Error(`ekstra_fragt_regninger (kasseret): ${kFejl.message}`);
  if (kasseret) return kasseret;
  // Tilbageført efter en tabt bankindsigelse (regningen er genåbnet).
  const { data: tilbage, error: tFejl } = await admin
    .from("ekstra_fragt_regninger")
    .select(KOLONNER)
    .contains("tilbagefoerte_payment_intents", [piId])
    .limit(1)
    .maybeSingle<EkstraFragtRaekke>();
  if (tFejl) throw new Error(`ekstra_fragt_regninger (tilbageført): ${tFejl.message}`);
  return tilbage;
}

// Regningen for en charge (indsigelse, afstemning). null = ikke ekstra fragt.
// Også en charge, der er tilbageført efter en tabt bankindsigelse (regningen
// er genåbnet), så senere events på den stadig genkendes.
export async function ekstraFragtForCharge(chargeId: string): Promise<{ id: string; trade_id: string; saelger_id: string } | null> {
  // Kun et gyldigt Stripe-id indgår i filteret nedenfor.
  if (!/^(ch|py)_[A-Za-z0-9_]{1,250}$/.test(chargeId)) return null;
  const { data, error } = await createAdminClient()
    .from("ekstra_fragt_regninger")
    .select("id, trade_id, saelger_id")
    .or(`stripe_charge_id.eq.${chargeId},tilbagefoerte_charges.cs.{${chargeId}}`)
    .limit(1)
    .maybeSingle<{ id: string; trade_id: string; saelger_id: string }>();
  if (error) return null;
  return data;
}

// Er PaymentIntenten (ud fra metadata) en ekstraregning? Uden opslag.
export function erEkstraFragtMetadata(md: Stripe.Metadata | null | undefined): boolean {
  return md?.type === EKSTRA_FRAGT_TYPE && typeof md.ekstra_fragt_id === "string";
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Kør efter svaret (webhook/server action), eller med det samme uden for en
// request (cron, test). Kaster aldrig.
function efterSvar(navn: string, opgave: () => Promise<unknown>): void {
  const p = () => opgave().catch((err) => logDriftFejl({ kilde: "server", hvor: `Ekstra fragt: ${navn}`, fejl: err }));
  try {
    after(p);
  } catch {
    void p();
  }
}

// Beskederne til sælgeren udledes af tidsstemplerne (notifikationer.ts) -
// her blot med det samme, cron'en tager dem ellers inden for 5 minutter.
function sendBeskederSnart(): void {
  efterSvar("beskeder", async () => {
    const { notificerEkstraFragt } = await import("@/lib/ekstraFragt/notifikationer");
    await notificerEkstraFragt();
  });
}

// ------------------------------------------------------------------ start

class NoedstopFejl extends Error {}

export type EkstraFragtStartFejl = {
  fejl: string;
  kode: "ugyldig" | "ikke_fundet" | "betalt" | "behandles" | "indsigelse" | "frafaldet" | "refunderet" | "pause" | "fejl";
};

export type EkstraFragtStart =
  | {
      ok: true;
      regningId: string;
      clientSecret: string;
      beloebOere: number;
      // Stripe-kunden på PaymentIntenten (PaymentSheet: customerId sammen med
      // customerSessionClientSecret, som ved returfragt og boost).
      customerId: string | null;
      customerSessionClientSecret: string | null;
    }
  | EkstraFragtStartFejl;

function startFejl(kode: string): EkstraFragtStartFejl {
  switch (kode) {
    case "betalt":
    case "behandles":
    case "indsigelse":
    case "frafaldet":
    case "refunderet":
      return { fejl: EKSTRA_FRAGT_SAELGER_FEJL[kode], kode };
    case "ikke_fundet":
    case "ugyldig":
      return { fejl: EKSTRA_FRAGT_SAELGER_FEJL.ikke_fundet, kode: "ikke_fundet" };
    default:
      return { fejl: GENERISK, kode: "fejl" };
  }
}

// Sælgeren starter (eller genoptager) betalingen af en ekstraregning.
// saelgerId SKAL være verificeret med auth af kalderen; databasen tjekker
// igen under lås.
export async function startEkstraFragtBetaling(
  regningId: unknown,
  saelgerId: string,
  kanal: BetalingsKanal = "web",
): Promise<EkstraFragtStart> {
  if (typeof regningId !== "string" || !UUID.test(regningId)) return startFejl("ikke_fundet");
  try {
    try {
      await kraevSammeOffentligeNoegle();
    } catch (err) {
      if (err instanceof StripeTilstandFejl) return { fejl: GENERISK, kode: "fejl" };
      throw err;
    }
    if ((await hentNoedstop()).nyeBetalingerStoppet) return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("ekstra_fragt_betal_start", { p_id: regningId, p_saelger: saelgerId });
    if (error) throw new Error(`ekstra_fragt_betal_start: ${error.message}`);
    const s = data as { kode?: string; id?: string } | null;
    if (s?.kode !== "ok" || !s.id) return startFejl(s?.kode ?? "");
    const r = await hentRaekke(admin, s.id);
    if (!r) return startFejl("ikke_fundet");
    const pi = await sikrPi(r);
    if (pi.status === "succeeded" || pi.status === "processing") {
      // Allerede betalt (fx en anden fane): spejl det.
      await spejlEkstraFragtPi(pi);
      return startFejl(pi.status === "succeeded" ? "betalt" : "behandles");
    }
    if (pi.status === "canceled" || pi.amount !== Number(r.beloeb_oere) || !pi.client_secret) {
      return { fejl: GENERISK, kode: "fejl" };
    }
    return {
      ok: true,
      regningId: r.id,
      clientSecret: pi.client_secret,
      beloebOere: pi.amount,
      customerId: typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null),
      customerSessionClientSecret: await kundeSessionTilCheckout(saelgerId, pi, kanal),
    };
  } catch (err) {
    if (err instanceof NoedstopFejl) return { fejl: NYE_BETALINGER_STOPPET_TEKST, kode: "pause" };
    console.error("startEkstraFragtBetaling fejlede:", err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Ekstra fragt: start betaling", fejl: err, brugerId: saelgerId });
    return { fejl: GENERISK, kode: "fejl" };
  }
}

const OPDATERBARE: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation"];
const AABNE_PI: Stripe.PaymentIntent.Status[] = ["requires_payment_method", "requires_confirmation", "requires_action"];

function metadata(r: EkstraFragtRaekke): Stripe.MetadataParam {
  const db = egenDatabase();
  return {
    type: EKSTRA_FRAGT_TYPE,
    ekstra_fragt_id: r.id,
    trade_id: r.trade_id,
    saelger_id: r.saelger_id,
    ...(db ? { bidhamr_db: db } : {}),
  };
}

// Den ene PaymentIntent for regningen (oprettes én gang pr. forsøg).
async function sikrPi(r: EkstraFragtRaekke, forsoeg = 0): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const admin = createAdminClient();
  const beloeb = Number(r.beloeb_oere);
  if (!Number.isInteger(beloeb) || beloeb < 300 || beloeb > 1_000_000) throw new Error(`Ugyldigt beløb for ekstraregning ${r.id}`);

  if (r.stripe_payment_intent_id) {
    const eks = await stripe.paymentIntents.retrieve(r.stripe_payment_intent_id);
    if (eks.status === "canceled" && r.status === "afventer_betaling") {
      const { data: ok, error } = await admin.rpc("ekstra_fragt_nulstil_pi", { p_id: r.id, p_pi: eks.id });
      if (error) throw new Error(`ekstra_fragt_nulstil_pi: ${error.message}`);
      if (ok !== true || forsoeg >= 2) throw new Error("Ekstraregningens PaymentIntent kunne ikke nulstilles");
      const ny = await hentRaekke(admin, r.id);
      if (!ny) throw new Error("Ekstraregningen findes ikke");
      return sikrPi(ny, forsoeg + 1);
    }
    // En åben PaymentIntent med forkerte betalingsmetoder annulleres, og næste
    // runde nulstiller rækken (ny idempotency key) og laver en ny.
    const metoder = await hentPlatformMetoder();
    const metodeValg = metodeHandling(eks, metoder);
    if (metodeValg === "annuller") {
      if (r.status !== "afventer_betaling" || forsoeg >= 2) throw new Error("Ekstraregningens PaymentIntent har forkerte betalingsmetoder");
      const efter = await annullerForkerteMetoder(stripe, eks.id);
      if (efter.status !== "canceled") return efter; // betalt imens - kalderen spejler
      const ny = await hentRaekke(admin, r.id);
      if (!ny) throw new Error("Ekstraregningen findes ikke");
      return sikrPi(ny, forsoeg + 1);
    }
    // Beløbet er låst i databasen; 3D Secure tvinges også på ældre intents.
    const mangler3ds = eks.payment_method_options?.card?.request_three_d_secure !== "any";
    if (
      (eks.amount !== beloeb || mangler3ds || eks.metadata?.ekstra_fragt_id !== r.id || metodeValg === "opdater") &&
      OPDATERBARE.includes(eks.status)
    ) {
      return stripe.paymentIntents.update(eks.id, {
        amount: beloeb,
        payment_method_types: metoder,
        metadata: metadata(r),
        payment_method_options: { card: { request_three_d_secure: "any" } },
      });
    }
    return eks;
  }

  const kunde = await sikrStripeKunde(r.saelger_id);
  const db = egenDatabase();
  const metoder = await hentPlatformMetoder();
  // Metoderne er med i nøglen (som returfragt og boost).
  const noegle = `bidhamr-ekstrafragt-${r.id}-${r.pi_forsoeg}${db ? `-${db}` : ""}-${metodeNoegle(metoder)}`;
  const pi = await stripe.paymentIntents.create(
    {
      amount: beloeb,
      currency: "dkk",
      customer: kunde,
      // Kun de tilladte metoder - aldrig Klarna eller Link. Betaling til
      // platformen: ingen on_behalf_of, ingen transfer_data, intet application fee.
      payment_method_types: metoder,
      payment_method_options: { card: { request_three_d_secure: "any" } },
      description: `BidHamr ekstra fragt for handel ${r.trade_id}`,
      metadata: metadata(r),
    },
    { idempotencyKey: noegle },
  );

  const { data: gemt, error } = await admin.rpc("ekstra_fragt_gem_pi", { p_id: r.id, p_pi: pi.id, p_forsoeg: r.pi_forsoeg });
  if (error) {
    // Næste kald får samme PaymentIntent tilbage via nøglen (24 t).
    throw new Error(`ekstra_fragt_gem_pi: ${error.message}`);
  }
  if (gemt === true) {
    // Nødstop sat imens: intenten må ikke kunne betales.
    if ((await hentNoedstop()).nyeBetalingerStoppet) {
      await annullerPi(pi.id, "noedstop");
      throw new NoedstopFejl();
    }
    return pi;
  }
  const efter = await hentRaekke(admin, r.id);
  if (efter?.stripe_payment_intent_id && efter.stripe_payment_intent_id !== pi.id) {
    // Et samtidigt kald nåede først: brug dens, og annullér vores, så der
    // aldrig ligger to betalbare intents.
    await annullerPi(pi.id, "overskydende");
    return stripe.paymentIntents.retrieve(efter.stripe_payment_intent_id);
  }
  if (efter?.stripe_payment_intent_id === pi.id) return pi;
  // Regningen er ændret imens (fx indsigelse/frafald): vores intent må ikke kunne betales.
  await annullerPi(pi.id, "foraeldet");
  if (!efter || efter.status !== "afventer_betaling" || forsoeg >= 2) throw new Error("Ekstraregningen kunne ikke startes");
  return sikrPi(efter, forsoeg + 1);
}

// Annullerer en PaymentIntent hos Stripe, hvis den stadig kan betales.
// Idempotent. Svar: PaymentIntentens status efter forsøget. Kaster ved
// netværksfejl (kalderen logger/prøver igen).
async function annullerPi(piId: string, grund: string): Promise<Stripe.PaymentIntent.Status> {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId);
  if (!AABNE_PI.includes(pi.status)) return pi.status;
  try {
    const efter = await stripe.paymentIntents.cancel(
      piId,
      { cancellation_reason: "abandoned" },
      { idempotencyKey: `bidhamr-ekstrafragt-annuller-${piId}` },
    );
    return efter.status;
  } catch (err) {
    // Fx betalt i samme øjeblik: slå den op igen.
    const igen = await stripe.paymentIntents.retrieve(piId);
    if (igen.status === "succeeded" || igen.status === "processing" || igen.status === "canceled") return igen.status;
    console.error(`Ekstra fragt: annullér PaymentIntent (${grund}) fejlede:`, piId, err);
    throw err;
  }
}

// En kasseret PaymentIntent (indsigelse/frafald) annulleres hos Stripe, og
// annuller_pi ryddes. Nåede den at blive betalt, spejles den (adopteres eller
// refunderes). Kaster aldrig - cron'en prøver igen. Svar: true, når
// PaymentIntenten ikke længere kan betales, og annuller_pi er ryddet.
export async function annullerKasseretPi(regningId: string, piId: string | null | undefined): Promise<boolean> {
  if (!piId) return false;
  try {
    const status = await annullerPi(piId, "kasseret");
    if (status === "succeeded" || status === "processing") {
      await spejlEkstraFragtPi(await getStripe().paymentIntents.retrieve(piId));
    }
    // Behandles stadig: cron'en tager den igen, når den er afgjort.
    if (status === "processing") return false;
    const { error } = await createAdminClient().rpc("ekstra_fragt_pi_annulleret", { p_id: regningId, p_pi: piId });
    if (error) throw new Error(`ekstra_fragt_pi_annulleret: ${error.message}`);
    return true;
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "Ekstra fragt: annullér kasseret PaymentIntent", fejl: err });
    return false;
  }
}

// ------------------------------------------------------------------ spejl fra Stripe

// Spejler en PaymentIntent for ekstra fragt (webhook, retur og cron).
// Idempotent. Svar: databasens kode ('betalt', 'allerede', 'ukendt' ...).
export async function spejlEkstraFragtPi(pi: Stripe.PaymentIntent): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ekstra_fragt_registrer", {
    p_pi: pi.id,
    p_status: pi.status,
    p_charge: stripeId(pi.latest_charge as string | { id: string } | null),
    p_beloeb: pi.status === "succeeded" ? pi.amount_received : null,
    p_fejl: pi.last_payment_error?.code ?? pi.last_payment_error?.message ?? null,
  });
  if (error) {
    if (manglerEkstraFragt(error)) return "ukendt";
    throw new Error(`ekstra_fragt_registrer: ${error.message}`);
  }
  const svar = data as { kode?: string; id?: string; annuller_pi?: string | null } | null;
  const kode = svar?.kode ?? "ukendt";
  if ((kode === "betalt" || kode === "beloeb_afviger") && svar?.id) {
    sendBeskederSnart();
    // En nyere åben PaymentIntent er kasseret ved adoptionen: annullér den.
    if (svar.annuller_pi && svar.annuller_pi !== pi.id) {
      const id = svar.id;
      const gammel = svar.annuller_pi;
      efterSvar("annullér nyere PaymentIntent", () => annullerKasseretPi(id, gammel));
    }
  }
  if (kode === "beloeb_afviger" && svar?.id) {
    await alarmPrTilfaelde({
      noegle: `ekstrafragt-beloeb:${svar.id}`,
      hvor: "betaling/ekstra-fragt",
      fejl: `Ekstraregning ${svar.id} (PaymentIntent ${pi.id}) er betalt med et andet beløb end regningen. Den står som betalt; fakturaen kræver handling - kontrollér i Stripe.`,
    });
  }
  if (kode === "kasseret") await refunderKasseret(pi, svar?.id ?? null);
  return kode;
}

// En kasseret PaymentIntent er betalt, men regningen er allerede betalt,
// frafaldet eller refunderet: sælgeren har betalt noget, han ikke skylder -
// det refunderes helt. Idempotent (eksisterende refusioner slås op først,
// fast nøgle pr. PaymentIntent).
async function refunderKasseret(pi: Stripe.PaymentIntent, regningId: string | null): Promise<void> {
  if (pi.status !== "succeeded") return;
  const stripe = getStripe();
  const eksisterende = await stripe.refunds.list({ payment_intent: pi.id, limit: 20 });
  if (!eksisterende.data.some((r) => r.status !== "failed" && r.status !== "canceled")) {
    await stripe.refunds.create(
      {
        payment_intent: pi.id,
        reason: "duplicate",
        metadata: {
          type: EKSTRA_FRAGT_TYPE,
          ekstra_fragt_id: regningId ?? "",
          kasseret: "ja",
          ...(egenDatabase() ? { bidhamr_db: egenDatabase()! } : {}),
        },
      },
      { idempotencyKey: `bidhamr-ekstrafragt-kasseret-${pi.id}` },
    );
  }
  await alarmPrTilfaelde({
    noegle: `ekstrafragt-kasseret:${pi.id}`,
    hvor: "betaling/ekstra-fragt",
    fejl: `En kasseret PaymentIntent for ekstraregning ${regningId ?? "?"} (${pi.id}) er betalt, men regningen er allerede betalt eller frafaldet. Den er refunderet automatisk; kontrollér i Stripe.`,
  });
}

// Returen fra betalingen (hjemmesiden): sælgeren kommer tilbage med
// payment_intent i adressen. Slås op hos Stripe og spejles, men KUN hvis
// PaymentIntenten er sælgerens egen regning. Kaster aldrig. null = noget
// fejlede (vises som "behandles" - webhooken gør det færdigt).
export async function synkEkstraFragtRetur(saelgerId: string, piId: string): Promise<string | null> {
  try {
    if (!/^pi_[A-Za-z0-9_]{1,250}$/.test(piId)) return "ikke_fundet";
    const r = await ekstraFragtForPi(piId);
    if (!r || r.saelger_id !== saelgerId) return "ikke_fundet";
    return await spejlEkstraFragtPi(await getStripe().paymentIntents.retrieve(piId));
  } catch (err) {
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Ekstra fragt: retur fra betaling", fejl: err, brugerId: saelgerId });
    return null;
  }
}

// charge.refunded på en ekstraregning (refunderet i Stripe-dashboardet):
// regningen markeres refunderet (fakturaen krediteres). Svar: kode eller
// null (ikke en ekstraregning).
export async function spejlEkstraFragtChargeRefusion(charge: Stripe.Charge): Promise<string | null> {
  const refusioner = (charge.refunds?.data ?? []).filter((r) => r.status !== "failed" && r.status !== "canceled");
  const nyeste = refusioner.sort((a, b) => b.created - a.created)[0]?.id ?? null;
  const { data, error } = await createAdminClient().rpc("ekstra_fragt_registrer_charge_refusion", {
    p_charge: charge.id,
    p_refund: nyeste,
    p_fuld: charge.refunded === true,
  });
  if (error) {
    if (manglerEkstraFragt(error)) return null;
    throw new Error(`ekstra_fragt_registrer_charge_refusion: ${error.message}`);
  }
  const kode = String(data);
  if (kode === "ukendt") return null;
  if (kode === "markeret" || kode === "refunderet") {
    await alarmPrTilfaelde({
      noegle: `ekstrafragt-refusion:${charge.id}`,
      hvor: "betaling/ekstra-fragt",
      fejl:
        kode === "refunderet"
          ? `Ekstraregningens charge ${charge.id} er refunderet hos Stripe uden om BidHamr. Regningen står nu som refunderet, og fakturaen krediteres.`
          : `Ekstraregningens charge ${charge.id} er delvist refunderet hos Stripe uden om BidHamr. Kontrollér den.`,
    });
  }
  return kode;
}

// refund.failed / refund.updated på en refusion af en dobbeltbetaling:
// sælgeren har betalt to gange og har ikke fået pengene igen - staff skal
// refundere manuelt. Svar: kode eller null (ikke vores).
export async function spejlEkstraFragtRefusionsfejl(refund: Stripe.Refund): Promise<string | null> {
  if (refund.metadata?.type !== EKSTRA_FRAGT_TYPE) return null;
  if (refund.status !== "failed" && refund.status !== "canceled") return refund.status ?? "ukendt";
  await alarmPrTilfaelde({
    noegle: `ekstrafragt-refusion-fejlet:${refund.id}`,
    hvor: "betaling/ekstra-fragt",
    fejl: `Refusionen ${refund.id} af en dobbeltbetaling af ekstra fragt (regning ${refund.metadata?.ekstra_fragt_id || "?"}) ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe${refund.failure_reason ? ` (${refund.failure_reason})` : ""}. Sælgeren har betalt to gange - refundér manuelt i Stripe.`,
  });
  return "alarm";
}

// ------------------------------------------------------------------ bankindsigelse

// Bankindsigelse (chargeback) på en ekstraregnings charge (webhooken,
// charge.dispute.* via spejlIndsigelse). Idempotent. En tabt indsigelse
// markerer regningen (admin-lampen), og databasen laver i samme transaktion
// kreditnotaen for den tilbageførte betaling (aldrig to). Staff får en alarm
// - regningen genåbnes ALDRIG automatisk; staff vælger "Genåbn regning"
// (genaabnEkstraFragt) eller "Afslut uden genåbning"
// (afslutEkstraFragtBankindsigelse). Kaster ved databasefejl (webhooken
// prøver igen).
// Svar: databasens kode, eller null (ikke en ekstraregning / ikke migreret).
export async function spejlEkstraFragtBankindsigelse(
  d: Pick<Stripe.Dispute, "id" | "status" | "amount">,
  chargeId: string,
): Promise<string | null> {
  const { data, error } = await createAdminClient().rpc("ekstra_fragt_registrer_bankindsigelse", {
    p_charge: chargeId,
    p_dispute: d.id,
    p_status: d.status,
    p_beloeb: Number.isInteger(d.amount) ? d.amount : null,
  });
  if (error) {
    if (manglerEkstraFragt(error)) return null;
    throw new Error(`ekstra_fragt_registrer_bankindsigelse: ${error.message}`);
  }
  const svar = (data ?? {}) as { kode?: string; id?: string; status?: string; kreditnota_id?: string | null };
  const kode = String(svar.kode ?? "ukendt");
  if (kode === "ukendt" || kode === "ugyldig") return null;
  if (kode === "tabt" && svar.id) {
    const r = await ekstraFragtForCharge(chargeId);
    await alarmPrTilfaelde({
      noegle: `ekstrafragt-bankindsigelse-tabt:${d.id}`,
      hvor: "betaling/indsigelse-ekstra-fragt",
      fejl:
        svar.status === "betalt"
          ? `Bankindsigelse ${d.id} på sælgerens betaling af ekstraregning ${svar.id} (charge ${chargeId}) er TABT - betalingen er tilbageført. ${svar.kreditnota_id ? "Kreditnotaen for betalingen er lavet automatisk." : "Kreditnotaen kunne IKKE laves automatisk - kontrollér fakturaerne."} Regningen genåbnes ikke automatisk. Vurdér sagen under Admin -> Ekstra fragt, og vælg enten "Genåbn regning" (sælgeren skal betale igen) eller "Afslut uden genåbning" (sælgeren opkræves ikke igen).`
          : `Bankindsigelse ${d.id} på ekstraregning ${svar.id} (charge ${chargeId}, status '${svar.status ?? "?"}') er TABT. Regningen kan ikke genåbnes i den status - kontrollér betalingen i Stripe.`,
      brugerId: r?.saelger_id ?? null,
    });
  }
  return kode;
}

// ------------------------------------------------------------------ dokumentation

// Signeret link (10 minutter) til dokumentationen. Kaldes KUN, når adgangen
// er tjekket (staff: ekstra_fragt_dokumentation_staff; sælger:
// min_ekstra_fragt_dokumentation). null = filen kunne ikke findes.
export async function signeretDokumentationsLink(sti: string, navn?: string | null): Promise<string | null> {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png|webp|heic)$/.test(sti)) return null;
  const filnavn = (navn ?? "").replace(/[^\wæøåÆØÅ .()-]/g, "").slice(0, 100) || `fragtfirmaets-faktura.${sti.split(".").pop()}`;
  const { data, error } = await createAdminClient().storage.from(EKSTRA_FRAGT_BUCKET).createSignedUrl(sti, 600, { download: filnavn });
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

// ------------------------------------------------------------------ indsigelse

// Sælgerens indsigelse (hjemmesiden og appen). klient SKAL køre som sælgeren
// (cookie-session eller Bearer-token): databasen afgør adgangen ud fra
// auth.uid(). En åben betaling kasseres og annulleres hos Stripe efter svaret.
export async function gemEkstraFragtIndsigelse(
  klient: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
  regningId: unknown,
  tekst: unknown,
): Promise<{ ok: true } | { fejl: string; kode: string }> {
  if (typeof regningId !== "string" || !UUID.test(regningId)) {
    return { fejl: EKSTRA_FRAGT_SAELGER_FEJL.ikke_fundet, kode: "ikke_fundet" };
  }
  const { data, error } = await klient.rpc("mit_ekstra_fragt_indsigelse", {
    p_id: regningId,
    p_tekst: typeof tekst === "string" ? tekst : "",
  });
  if (error) throw new Error(`mit_ekstra_fragt_indsigelse: ${error.message}`);
  const svar = (data ?? {}) as { kode?: string; annuller_pi?: string | null };
  const kode = String(svar.kode ?? "fejl");
  if (kode !== "ok") return { fejl: EKSTRA_FRAGT_SAELGER_FEJL[kode] ?? "Noget gik galt. Prøv igen om lidt.", kode };
  if (svar.annuller_pi) {
    const pi = svar.annuller_pi;
    efterSvar("annullér betaling ved indsigelse", () => annullerKasseretPi(regningId, pi));
  }
  sendBeskederSnart();
  return { ok: true };
}

// ------------------------------------------------------------------ cron

export type EkstraFragtCronResultat = { synket: number; annulleret: number; fejl: number };

// Kaldes fra betalings-cron'en: mistede webhooks (ubetalte regninger med
// PaymentIntent i over 15 min) og kasserede PaymentIntents, der ikke blev
// annulleret med det samme. null = migrationen er ikke kørt. Flytter ingen
// penge (en kasseret, betalt PaymentIntent refunderes af spejlingen).
export async function koerEkstraFragtCron(): Promise<EkstraFragtCronResultat | null> {
  const r: EkstraFragtCronResultat = { synket: 0, annulleret: 0, fejl: 0 };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("ekstra_fragt_cron", { p_graense: 20 });
  if (error) {
    if (manglerEkstraFragt(error)) return null;
    throw new Error(`ekstra_fragt_cron: ${error.message}`);
  }
  const opgaver = (data ?? []) as { id: string; handling: string; pi: string | null }[];
  if (opgaver.length === 0) return r;
  const stripe = getStripe();
  for (const o of opgaver) {
    try {
      if (!o.pi) continue;
      if (o.handling === "synk") {
        await spejlEkstraFragtPi(await stripe.paymentIntents.retrieve(o.pi));
        r.synket++;
      } else if (o.handling === "annuller") {
        // Tælles kun, når annulleringen lykkedes (fejlen er logget af annullerKasseretPi).
        if (await annullerKasseretPi(o.id, o.pi)) r.annulleret++;
        else r.fejl++;
      }
    } catch (err) {
      r.fejl++;
      await logDriftFejl({ kilde: "cron", sti: "ekstra-fragt", hvor: `Ekstra fragt: ${o.handling}`, fejl: err });
    }
  }
  return r;
}
