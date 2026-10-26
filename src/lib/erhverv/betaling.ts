import "server-only";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import {
  introKuponMaaneder,
  introKuponMaanederCheckout,
  introResterende,
  nyGratisSlut,
  plusMaaneder,
  TRIAL_MAKS_DAGE,
  type IntroFra,
} from "@/lib/erhverv/abonnementRegler";

// Betaling af erhvervsabonnementer med Stripe Billing (bygget 8. okt. 2026 i
// Stripes TESTMILJØ efter Filips ønske; Niels gennemgår - se
// STRIPE-ERHVERV-NOTE.md). Regler: ROADMAP-BESLUTNINGER.md "Erhvervskonti".
//
// Stripe-objekter (oprettes idempotent fra koden første gang, de bruges):
//   Tax Rate   "Moms" 25 %, DK, eksklusiv (metadata.bidhamr = moms_dk_25).
//              Fast sats i stedet for Stripe Tax: alle kunder er danske
//              firmaer med CVR, så satsen er altid 25 %.
//   Product    bidhamr_erhverv_<pakke-id uden bindestreger>, én pr. pakke.
//   Price      lookup_key erhverv_pakke_<pakke-id>_<øre>: månedlig, DKK,
//              ekskl. moms (tax_behavior 'exclusive'). Ændrer chefen prisen,
//              laves en ny Price (priser kan ikke ændres i Stripe), og
//              erhverv_pakker.stripe_price_id peger på den nye. Eksisterende
//              abonnementer beholder den gamle pris, til firmaet skifter pakke.
//   Customer   én pr. firma: firmanavn, adresse, kontakt-e-mail og CVR som
//              momsnummer (tax id eu_vat "DK" + CVR) - står på fakturaen.
//   Portal     Customer Portal-konfiguration (metadata.bidhamr = erhverv_v1):
//              KUN skift af betalingskort og fakturahistorik. Opsigelse og
//              pakkeskift sker kun via BidHamr.
//
// Forløb:
//   1. Første betaling: firmaet trykker "Betal for din pakke" ->
//      startBetaling -> Stripe Checkout (mode subscription, kort) ->
//      /firma/abonnement?betaling=ok -> bekraeftCheckout + webhook
//      invoice.paid -> firma_abonnement_betalt ('afventer_betaling' -> 'aktiv').
//   2. Opgradering: startOpgradering (proration_behavior 'always_invoice',
//      payment_behavior 'pending_if_incomplete') -> fakturaen for forskellen
//      betales med det samme med det gemte kort. Kræver kortet godkendelse
//      (3DS) eller fejler det, sendes firmaet til fakturaens hosted_invoice_url.
//      invoice.paid (fakturaen har kun proration-linjer) -> tjek at
//      abonnementets pris ER skiftet -> firma_pakkeskift_betalt -> flere
//      auktioner pr. uge. Udløber Stripes ventende ændring
//      (customer.subscription.pending_update_expired) eller annulleres
//      fakturaen (invoice.voided), annulleres skiftet.
//   3. Nedgradering: startNedgradering -> Subscription Schedule, så prisen
//      skifter ved periodens slut (ingen proration, intet refunderes).
//      Fornyelsen (abonnementslinje) -> firma_abonnement_betalt, som også
//      gennemfører nedgraderingen i databasen.
//   4. Opsigelse (chef og sælger i admin): opsigAbonnement ->
//      cancel_at_period_end. customer.subscription.deleted -> 'opsagt'.
//      Lukkes firmakontoen PERMANENT, opsiges abonnementet med det samme
//      (opsigVedLukning lige efter lukningen + koerLukOpsigelser i
//      betalings-cron'en, som prøver igen, hvis Stripe fejler). Ingen refusion.
//   5. Mislykket betaling: invoice.payment_failed -> firma_abonnement_mislykket.
//      Cron firma_abonnement_frist_koer pauser efter 7 dage; Stripes Smart
//      Retries prøver igen, og en senere betaling genaktiverer. Kun
//      mislykkede regninger fra det nuværende abonnement tæller.
//   6. Chefen skifter pakke i admin: skiftPrisAdmin (proration 'none') FØR
//      databasen; fejler databasen, sættes prisen tilbage.
//   Alle pakkeskift fra firmaet går via src/lib/erhverv/pakkeskift.ts; fejler
//   Stripe, rulles databasen tilbage (firma_pakkeskift_rul_tilbage).
//   Efter hver betalt fornyelse tjekkes, at prisen i Stripe hører til
//   firmaets pakke i databasen (tjekAbonnementsPris) - ellers drift-alarm.
//
// Databasekrogene (kun service role) er idempotente på fakturaens id, så
// webhook, genlevering og retursiden kan kalde dem i vilkårlig rækkefølge.

// Idempotency-nøgler til ALLE kald, der opretter/ændrer noget hos Stripe.
// Samme handling = samme nøgle; ny handling = ny nøgle. Stripe husker dem i
// mindst 24 timer. Handlinger, der kan gentages med modsat virkning (opsig ->
// fortryd -> opsig igen, chefens pakkeskift, prisrettelser), får en ny UUID
// pr. klik (`klik`), så Stripe aldrig svarer med et gammelt resultat.
export const idempotensNoegle = {
  kunde: (firmaId: string) => `kunde:${firmaId}`,
  checkout: (firmaId: string, prisId: string, minut: number) => `checkout:${firmaId}:${prisId}:${minut}`,
  opgradering: (skiftId: string) => `opgradering:${skiftId}`,
  opgraderingMetadata: (skiftId: string) => `opgradering-metadata:${skiftId}`,
  opgraderingMetadataRyd: (skiftId: string) => `opgradering-metadata-ryd:${skiftId}`,
  opgraderingRefusion: (skiftId: string) => `opgradering-refusion:${skiftId}`,
  opgraderingTilbage: (skiftId: string) => `opgradering-tilbage:${skiftId}`,
  gratisSkift: (skiftId: string) => `gratis-skift:${skiftId}`,
  // Staff-handlinger på et firma (20261102010000): ny nøgle pr. klik. Sender
  // admin-formularen et klik-id (20261102020000), er det nøglen - så et
  // dobbeltklik aldrig giver dobbelt effekt i Stripe.
  gratisPeriode: (firmaId: string, klik: string) => `gratis-periode:${firmaId}:${klik}`,
  intro: (firmaId: string, subId: string, noegle: string, k: number) => `intro:${firmaId}:${subId}:${noegle}:${k}`,
  introFlyt: (firmaId: string, subId: string, klik: string) => `intro-flyt:${firmaId}:${subId}:${klik}`,
  introFjern: (firmaId: string, klik: string) => `intro-fjern:${firmaId}:${klik}`,
  kupon: (kuponId: string) => `kupon:${kuponId}`,
  saerpris: (firmaId: string, klik: string) => `saerpris:${firmaId}:${klik}`,
  prisSynk: (firmaId: string, prisId: string) => `pris-synk:${firmaId}:${prisId}`,
  prisSynkVoid: (fakturaId: string) => `pris-synk-void:${fakturaId}`,
  // Firmaoplysninger til Stripe-kunden (20261102020000): én nøgle pr. version
  // af oplysningerne (firmaer.stripe_kunde_version).
  kundeSynk: (firmaId: string, version: number) => `kunde-synk:${firmaId}:${version}`,
  kundeMoms: (firmaId: string, version: number, cvr: string) => `kunde-moms:${firmaId}:${version}:${cvr}`,
  regningRefusion: (regningId: string) => `regning-refusion:${regningId}`,
  nedgradering: (skiftId: string) => `nedgradering:${skiftId}`,
  nedgraderingPlan: (skiftId: string) => `nedgradering-plan:${skiftId}`,
  opsigelse: (firmaId: string, klik: string) => `opsigelse:${firmaId}:${klik}`,
  fortrydOpsigelse: (firmaId: string, klik: string) => `fortryd-opsigelse:${firmaId}:${klik}`,
  adminPakke: (firmaId: string, klik: string) => `admin-pakke:${firmaId}:${klik}`,
  prisRettelse: (subId: string, klik: string) => `pris-rettelse:${subId}:${klik}`,
  dobbeltAbonnement: (subId: string) => `dobbelt-abonnement:${subId}`,
  // Opsigelse ved permanent lukning af kontoen. NB: Stripe ignorerer
  // idempotency-nøgler på DELETE (subscriptions.cancel er idempotent i sig
  // selv - et opsagt abonnement kan ikke opsiges igen); nøglen sendes alligevel,
  // så kaldet kan genkendes i Stripes log. De ledsagende POST-kald (luk åbne
  // Checkout-betalinger, annullér opgraderingsfakturaer) får nøgler med
  // forsøgsnummeret, så et gemt fejlsvar ikke blokerer næste forsøg i 24 timer.
  lukOpsigelse: (brugerId: string, subId: string) => `luk:${brugerId}:${subId}`,
  lukCheckout: (brugerId: string, subId: string, forsoeg: number, sessionId: string) =>
    `luk:${brugerId}:${subId}:${forsoeg}:checkout:${sessionId}`,
  lukFaktura: (brugerId: string, subId: string, forsoeg: number, fakturaId: string) =>
    `luk:${brugerId}:${subId}:${forsoeg}:void:${fakturaId}`,
  pris: (lookupKey: string) => `pris:${lookupKey}`,
  produkt: (produktId: string) => `produkt:${produktId}`,
  moms: () => "moms:dk25:v1",
  portal: () => "portal:erhverv:v1",
} as const;

export type BetalingsStatus =
  | { status: "afventer_betaling"; besked: string }
  // straks: skiftet er gennemført med det samme (i den gratis periode).
  | { status: "betalt"; straks?: true }
  | { status: "kraever_handling"; url: string }
  // rulletTilbage: databasen er sat tilbage til før skiftet (Stripe fejlede,
  // før abonnementet blev ændret). betalFoerst: abonnementet er ikke aktivt.
  // laasOvertaget: databasen er IKKE rullet tilbage, fordi et nyere pakkeskift
  // (eller chefen) har taget låsen imens - det nye skift gælder.
  | { status: "fejl"; fejl: string; rulletTilbage?: boolean; laasOvertaget?: boolean; betalFoerst?: boolean };

// Udfald af rulTilbage.
type Tilbagerulning = "ok" | "fejl" | "laas_overtaget";

function tilbagerulFelter(r: Tilbagerulning): { rulletTilbage: boolean; laasOvertaget?: true } {
  return r === "laas_overtaget" ? { rulletTilbage: false, laasOvertaget: true } : { rulletTilbage: r === "ok" };
}

// Tilstanden før et pakkeskift (firma_skift_pakke_server -> 'tilbagerul').
export type Tilbagerul = {
  naeste_pakke_id: string | null;
  naeste_pakke_fra: string | null;
  planlagt: string | null;
  afventer: string | null;
};

const AFVENTER_MANUEL: BetalingsStatus = {
  status: "afventer_betaling",
  besked:
    "Din ændring er registreret. BidHamr kontakter dig om betalingen, og ændringen gælder, når den er betalt.",
};

// Betalingen er gået igennem, men pakken er ikke aktiveret endnu (webhooken
// gør det om et øjeblik).
const BETALT_BEHANDLES: BetalingsStatus = {
  status: "afventer_betaling",
  besked: "Betalingen er gået igennem. Din nye pakke bliver aktiveret om et øjeblik – opdater siden.",
};

const MOMS_PROCENT = 25;
const MOMS_METADATA = "moms_dk_25";
const PORTAL_METADATA = "erhverv_v1";

// Kun Stripes testmiljø, indtil Niels har gennemgået opsætningen (fase 6).
function stripe(): Stripe {
  const noegle = process.env.STRIPE_SECRET_KEY ?? "";
  if (!noegle.startsWith("sk_test_") && !noegle.startsWith("rk_test_")) {
    throw new Error("Erhvervsabonnementet kører kun i Stripes testmiljø (test-nøgle påkrævet).");
  }
  return getStripe();
}

export function stripeTilgaengelig(): boolean {
  const noegle = process.env.STRIPE_SECRET_KEY ?? "";
  return noegle.startsWith("sk_test_") || noegle.startsWith("rk_test_");
}

function id(x: string | { id: string } | null | undefined): string | null {
  if (!x) return null;
  return typeof x === "string" ? x : x.id;
}

function tid(sek: number | null | undefined): string | null {
  return typeof sek === "number" ? new Date(sek * 1000).toISOString() : null;
}

type FirmaRaekke = {
  id: string;
  bruger_id: string;
  firmanavn: string;
  cvr: string;
  adresse: string;
  postnummer: string;
  bynavn: string;
  telefon: string;
  kontakt_email: string;
  pakke_id: string;
  abonnement_status: "afventer_betaling" | "aktiv" | "pauset" | "opsagt";
  pauset_aarsag: "betaling" | "bidhamr" | null;
  naeste_pakke_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_abonnement_status: string | null;
  opsiges_fra: string | null;
  // 20261102010000: gratis periode, introrabat og særpris.
  proeve_maaneder: number;
  proeve_givet_kl: string | null;
  intro_procent: number | null;
  intro_maaneder: number | null;
  intro_fra: IntroFra | null;
  intro_status: "planlagt" | "aktiv" | null;
  intro_noegle: string | null;
  intro_coupon_id: string | null;
  saerpris_oere: number | string | null;
  saerpris_pakke_id: string | null;
};

const FIRMA_FELTER =
  "id, bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon, kontakt_email, pakke_id, abonnement_status, pauset_aarsag, naeste_pakke_id, stripe_customer_id, stripe_subscription_id, stripe_abonnement_status, opsiges_fra, " +
  "proeve_maaneder, proeve_givet_kl, intro_procent, intro_maaneder, intro_fra, intro_status, intro_noegle, intro_coupon_id, saerpris_oere, saerpris_pakke_id";

async function hentFirma(kolonne: "id" | "bruger_id" | "stripe_customer_id", vaerdi: string): Promise<FirmaRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("firmaer")
    .select(FIRMA_FELTER)
    .eq(kolonne, vaerdi)
    .maybeSingle<FirmaRaekke>();
  if (error) throw new Error(`firmaer: ${error.message}`);
  return data;
}

// --- Stripe-objekter -------------------------------------------------------

let momsCache: string | null = null;

// Tax Rate "Moms" 25 % (eksklusiv). Findes den, genbruges den.
export async function sikrMomssats(): Promise<string> {
  if (momsCache) return momsCache;
  const s = stripe();
  for await (const t of s.taxRates.list({ active: true, limit: 100 })) {
    if (t.metadata?.bidhamr === MOMS_METADATA && t.percentage === MOMS_PROCENT && !t.inclusive) {
      momsCache = t.id;
      return t.id;
    }
  }
  const ny = await s.taxRates.create(
    {
      display_name: "Moms",
      description: "Dansk moms 25 %",
      percentage: MOMS_PROCENT,
      inclusive: false,
      country: "DK",
      jurisdiction: "DK",
      tax_type: "vat",
      metadata: { bidhamr: MOMS_METADATA },
    },
    { idempotencyKey: idempotensNoegle.moms() },
  );
  momsCache = ny.id;
  return ny.id;
}

type PakkeRaekke = {
  id: string;
  navn: string;
  maanedspris: number | string | null;
  stripe_price_id: string | null;
  stripe_price_oere: number | string | null;
};

export class PrisIkkeSat extends Error {}

// Pakkens Stripe-pris for den nuværende månedspris (ekskl. moms). Laver
// produkt og pris, hvis de ikke findes, og gemmer pris-id'et på pakken.
export async function sikrPris(pakkeId: string): Promise<string> {
  const admin = createAdminClient();
  const { data: p, error } = await admin
    .from("erhverv_pakker")
    .select("id, navn, maanedspris, stripe_price_id, stripe_price_oere")
    .eq("id", pakkeId)
    .maybeSingle<PakkeRaekke>();
  if (error) throw new Error(`erhverv_pakker: ${error.message}`);
  if (!p || p.maanedspris == null) throw new PrisIkkeSat("Pakken har ingen pris.");
  const oere = Math.round(Number(p.maanedspris) * 100);
  if (!Number.isInteger(oere) || oere <= 0) throw new PrisIkkeSat("Pakken har ingen gyldig pris.");
  if (p.stripe_price_id && Number(p.stripe_price_oere) === oere) return p.stripe_price_id;

  const prisId = await findEllerOpretPris(p, oere, `erhverv_pakke_${p.id}_${oere}`, `${p.navn} – ${oere / 100} kr./md. ekskl. moms`, {
    pakke_id: p.id,
  });
  const { error: gemFejl } = await admin
    .from("erhverv_pakker")
    .update({ stripe_price_id: prisId, stripe_price_oere: oere })
    .eq("id", p.id);
  if (gemFejl) throw new Error(`erhverv_pakker.stripe_price_id: ${gemFejl.message}`);
  return prisId;
}

// En månedlig Stripe-pris (DKK, ekskl. moms) på pakkens produkt, fundet på
// lookup_key eller oprettet (idempotent). Produktet laves første gang.
async function findEllerOpretPris(
  p: { id: string; navn: string },
  oere: number,
  lookupKey: string,
  nickname: string,
  metadata: Record<string, string>,
): Promise<string> {
  const s = stripe();
  const fundet = await s.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (fundet.data[0]) return fundet.data[0].id;
  const produktId = `bidhamr_erhverv_${p.id.replace(/-/g, "")}`;
  try {
    await s.products.retrieve(produktId);
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError) || err.code !== "resource_missing") throw err;
    await s.products.create(
      {
        id: produktId,
        name: `BidHamr erhvervsabonnement – ${p.navn}`,
        metadata: { pakke_id: p.id },
      },
      { idempotencyKey: idempotensNoegle.produkt(produktId) },
    );
  }
  const pris = await s.prices.create(
    {
      product: produktId,
      currency: "dkk",
      unit_amount: oere,
      recurring: { interval: "month" },
      tax_behavior: "exclusive",
      lookup_key: lookupKey,
      nickname,
      metadata,
    },
    { idempotencyKey: idempotensNoegle.pris(lookupKey) },
  );
  return pris.id;
}

// Særpris: firmaets egen Stripe-pris på pakkens produkt (lookup_key
// erhverv_firma_<firma>_<pakke>_<øre>, metadata pakke_id + firma_id), så alt,
// der kender pakken på prisen (metadata.pakke_id), virker uændret. En egen
// pris er mere robust end en rabat: den kan ikke udløbe eller stables forkert
// med introrabatten (som er en kupon), og fakturaen viser den rigtige pris.
export async function sikrFirmaPris(firmaId: string, pakkeId: string, oere: number): Promise<string> {
  if (!Number.isInteger(oere) || oere < 100 || oere % 100 !== 0) throw new PrisIkkeSat("Særprisen er ugyldig.");
  const { data: p, error } = await createAdminClient()
    .from("erhverv_pakker")
    .select("id, navn")
    .eq("id", pakkeId)
    .maybeSingle<{ id: string; navn: string }>();
  if (error) throw new Error(`erhverv_pakker: ${error.message}`);
  if (!p) throw new PrisIkkeSat("Pakken findes ikke.");
  return findEllerOpretPris(
    p,
    oere,
    `erhverv_firma_${firmaId}_${pakkeId}_${oere}`,
    `${p.navn} – særpris ${oere / 100} kr./md. ekskl. moms (firma ${firmaId})`,
    { pakke_id: pakkeId, firma_id: firmaId, saerpris: "ja" },
  );
}

// Den pris, firmaet skal betale for en pakke: særprisen, hvis den gælder netop
// den pakke, ellers pakkens pris.
export function firmaetsSaerpris(f: Pick<FirmaRaekke, "saerpris_oere" | "saerpris_pakke_id">, pakkeId: string): number | null {
  if (f.saerpris_oere == null || f.saerpris_pakke_id !== pakkeId) return null;
  const oere = Number(f.saerpris_oere);
  return Number.isInteger(oere) && oere > 0 ? oere : null;
}

export async function firmaPris(f: Pick<FirmaRaekke, "id" | "saerpris_oere" | "saerpris_pakke_id">, pakkeId: string): Promise<string> {
  const saer = firmaetsSaerpris(f, pakkeId);
  return saer ? sikrFirmaPris(f.id, pakkeId, saer) : sikrPris(pakkeId);
}

// Forventet månedspris i øre for firmaet på pakken (til pristjekket).
async function forventetOere(f: Pick<FirmaRaekke, "saerpris_oere" | "saerpris_pakke_id">, pakkeId: string): Promise<number | null> {
  const saer = firmaetsSaerpris(f, pakkeId);
  if (saer) return saer;
  const { data: pakke } = await createAdminClient()
    .from("erhverv_pakker")
    .select("maanedspris")
    .eq("id", pakkeId)
    .maybeSingle<{ maanedspris: number | string | null }>();
  return pakke?.maanedspris == null ? null : Math.round(Number(pakke.maanedspris) * 100);
}

// Firmaets Stripe-kunde (oprettes første gang, med CVR som momsnummer).
async function sikrKunde(f: FirmaRaekke): Promise<string> {
  if (f.stripe_customer_id) return f.stripe_customer_id;
  const kunde = await stripe().customers.create(
    {
      name: f.firmanavn,
      email: f.kontakt_email,
      phone: f.telefon,
      address: { line1: f.adresse, postal_code: f.postnummer, city: f.bynavn, country: "DK" },
      preferred_locales: ["da"],
      tax_id_data: [{ type: "eu_vat", value: `DK${f.cvr}` }],
      metadata: { firma_id: f.id, cvr: f.cvr },
    },
    { idempotencyKey: idempotensNoegle.kunde(f.id) },
  );
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("firmaer")
    .update({ stripe_customer_id: kunde.id })
    .eq("id", f.id)
    .is("stripe_customer_id", null)
    .select("id");
  if (error) throw new Error(`firmaer.stripe_customer_id: ${error.message}`);
  if (!data?.length) {
    // En anden forespørgsel nåede først - brug den gemte kunde.
    const igen = await hentFirma("id", f.id);
    if (igen?.stripe_customer_id) return igen.stripe_customer_id;
  }
  return kunde.id;
}

let portalCache: string | null = null;

async function sikrPortalKonfiguration(): Promise<string> {
  if (portalCache) return portalCache;
  const s = stripe();
  for await (const k of s.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (k.metadata?.bidhamr === PORTAL_METADATA) {
      portalCache = k.id;
      return k.id;
    }
  }
  const ny = await s.billingPortal.configurations.create(
    {
      business_profile: { headline: "BidHamr – betalingskort og fakturaer" },
      features: {
        payment_method_update: { enabled: true },
        invoice_history: { enabled: true },
        customer_update: { enabled: false },
        subscription_cancel: { enabled: false },
        subscription_update: { enabled: false },
      },
      metadata: { bidhamr: PORTAL_METADATA },
    },
    { idempotencyKey: idempotensNoegle.portal() },
  );
  portalCache = ny.id;
  return ny.id;
}

// --- Firmaets egne handlinger (via /api/offentlig) --------------------------

export type LinkSvar = { ok: true; url: string } | { fejl: string; kode: string };

// Må firmaet starte et (nyt) abonnement med Checkout? Før første betaling,
// eller når Stripe har afsluttet abonnementet pga. manglende betaling.
export function kanStarteAbonnement(f: Pick<FirmaRaekke, "abonnement_status" | "pauset_aarsag" | "stripe_subscription_id">): boolean {
  if (f.stripe_subscription_id) return false;
  return f.abonnement_status === "afventer_betaling" || (f.abonnement_status === "pauset" && f.pauset_aarsag === "betaling");
}

// Får firmaet velkomstperioden, når abonnementet starter? Kun et nyt firma:
// det har aldrig haft en gratis periode og aldrig betalt for abonnementet.
// Reglen ligger ét sted i databasen (erhverv_faar_velkomst_gratis,
// 20261102020000) - staff-handlingen "gratis periode" bruger den samme.
async function faarGratisPeriode(f: Pick<FirmaRaekke, "id" | "proeve_givet_kl" | "proeve_maaneder">): Promise<boolean> {
  const { data, error: rpcFejl } = await createAdminClient().rpc("erhverv_faar_velkomst_gratis", { p_firma: f.id });
  if (!rpcFejl) return data === true;
  // PGRST202: migrationen 20261102020000 er ikke kørt endnu - samme regel her.
  if (rpcFejl.code !== "PGRST202") throw new Error(`erhverv_faar_velkomst_gratis: ${rpcFejl.message}`);
  if (f.proeve_givet_kl || !(f.proeve_maaneder > 0)) return false;
  const { count, error } = await createAdminClient()
    .from("firma_regninger")
    .select("id", { count: "exact", head: true })
    .eq("firma_id", f.id)
    .eq("type", "abonnement")
    .eq("status", "betalt")
    .gt("beloeb_oere", 0);
  if (error) throw new Error(`firma_regninger: ${error.message}`);
  return !count;
}

// Gratis måneder, staff har givet et firma, der IKKE får velkomstperioden
// (firmaer.proeve_ekstra_ventende, 20261102020000). 0, hvis kolonnen ikke
// findes endnu (42703: migrationen er ikke kørt).
async function ventendeGratisMaaneder(firmaId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("firmaer")
    .select("proeve_ekstra_ventende")
    .eq("id", firmaId)
    .maybeSingle<{ proeve_ekstra_ventende: number | null }>();
  if (error) {
    if (error.code === "42703") return 0;
    throw new Error(`firmaer.proeve_ekstra_ventende: ${error.message}`);
  }
  const n = Number(data?.proeve_ekstra_ventende ?? 0);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 24) : 0;
}

// "Betal for din pakke": Stripe Checkout for firmaets pakke. base = sidens
// egen adresse (fra den kontrollerede Origin).
export async function startBetaling(brugerId: string, base: string): Promise<LinkSvar> {
  const f = await hentFirma("bruger_id", brugerId);
  if (!f) return { fejl: "Kun firmakonti har et abonnement.", kode: "ikke_firma" };
  // En lukket konto kan ikke starte et nyt abonnement (opsigVedLukning
  // opsiger det gamle og lukker åbne betalinger).
  if (await kontoLukket(brugerId)) {
    return { fejl: "Din konto er lukket. Skriv til erhverv@bidhamr.dk, hvis du har spørgsmål.", kode: "konto_lukket" };
  }
  if (!kanStarteAbonnement(f)) {
    return { fejl: "Din pakke er allerede betalt. Opdater siden.", kode: "allerede_betalt" };
  }
  let prisId: string;
  try {
    prisId = await firmaPris(f, f.pakke_id);
  } catch (err) {
    if (err instanceof PrisIkkeSat) {
      return { fejl: "Din pakke har ingen pris endnu. Skriv til erhverv@bidhamr.dk.", kode: "pris_ikke_sat" };
    }
    throw err;
  }
  const s = stripe();
  const kunde = await sikrKunde(f);
  const moms = await sikrMomssats();

  // 1 måned gratis for alle nye firmaer (+ evt. ekstra gratis måneder fra
  // staff): kortet gemmes i Checkout, men der trækkes 0 kr. nu, og første
  // betaling er ved trial_end. Velkomstperioden kun første gang - et firma,
  // der starter igen efter en mislykket betaling, får ikke en ny. Men gratis
  // måneder, staff har givet det imens (proeve_ekstra_ventende), lægges på
  // (metadata gratis_ekstra; trækkes fra i databasen, når Stripe har startet
  // abonnementet - synkAbonnement -> firma_gratis_ekstra_brugt).
  const velkomstDel = (await faarGratisPeriode(f)) ? Math.max(0, Math.min(f.proeve_maaneder, 24)) : 0;
  const ekstra = Math.max(0, Math.min(await ventendeGratisMaaneder(f.id), 24 - velkomstDel));
  const gratisMaaneder = velkomstDel + ekstra;
  const nuSek = Math.floor(Date.now() / 1000);
  const trialEnd = gratisMaaneder > 0 ? Math.min(plusMaaneder(nuSek, gratisMaaneder), nuSek + (TRIAL_MAKS_DAGE - 1) * 86400) : null;

  // En aftalt introrabat sættes på allerede i Checkout, så Stripe viser den
  // rigtige pris efter den gratis periode (ikke den fulde). Kuponens varighed
  // regnes fra abonnementets oprettelse (introKuponMaanederCheckout).
  // Aftalens nøgle står i abonnementets metadata, så synkAbonnement kun
  // spejler rabatten og ikke sætter den på igen (anvendIntro).
  let introKupon: string | null = null;
  if (f.intro_status === "planlagt" && f.intro_procent && f.intro_maaneder && f.intro_noegle) {
    const k = introKuponMaanederCheckout({
      nuSek,
      trialEndSek: trialEnd,
      maaneder: f.intro_maaneder,
      fra: f.intro_fra ?? "efter_gratis",
    });
    introKupon = await sikrIntroKupon(f.intro_procent, k);
  }
  const introMeta: Record<string, string> =
    introKupon && f.intro_noegle ? { intro_noegle: f.intro_noegle, intro_kupon: introKupon } : {};

  // Genbrug en åben betaling for samme pris og gratis periode (fx når firmaet
  // trykker igen); andre åbne betalinger lukkes, så der ikke kan betales for
  // to abonnementer.
  for await (const sess of s.checkout.sessions.list({ customer: kunde, status: "open", limit: 20 })) {
    if (
      sess.metadata?.firma_id === f.id &&
      sess.metadata?.pris_id === prisId &&
      sess.metadata?.gratis_maaneder === String(gratisMaaneder) &&
      (sess.metadata?.gratis_ekstra ?? "0") === String(ekstra) &&
      (sess.metadata?.intro_kupon ?? "") === (introKupon ?? "") &&
      (sess.metadata?.intro_noegle ?? "") === (introMeta.intro_noegle ?? "") &&
      sess.url
    ) {
      return { ok: true, url: sess.url };
    }
    await s.checkout.sessions.expire(sess.id).catch(() => {});
  }

  const session = await s.checkout.sessions.create(
    {
      mode: "subscription",
      customer: kunde,
      line_items: [{ price: prisId, quantity: 1 }],
      payment_method_types: ["card"],
      // Kortet gemmes altid - også når der trækkes 0 kr. i den gratis periode.
      payment_method_collection: "always",
      locale: "da",
      subscription_data: {
        default_tax_rates: [moms],
        metadata: {
          firma_id: f.id,
          pakke_id: f.pakke_id,
          ...(ekstra > 0 ? { gratis_ekstra: String(ekstra) } : {}),
          ...introMeta,
        },
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
      ...(introKupon ? { discounts: [{ coupon: introKupon }] } : {}),
      metadata: {
        firma_id: f.id,
        pakke_id: f.pakke_id,
        pris_id: prisId,
        gratis_maaneder: String(gratisMaaneder),
        gratis_ekstra: String(ekstra),
        ...introMeta,
      },
      success_url: `${base}/firma/abonnement?betaling=ok&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/firma/abonnement?betaling=afbrudt`,
    },
    {
      idempotencyKey: idempotensNoegle.checkout(
        f.id,
        `${prisId}:${gratisMaaneder}:${ekstra}:${introKupon ?? "-"}:${introMeta.intro_noegle ?? "-"}`,
        Math.floor(Date.now() / 60_000),
      ),
    },
  );
  if (!session.url) throw new Error("Checkout uden url");
  return { ok: true, url: session.url };
}

// "Skift betalingskort": Stripes kundeportal (kun kort og fakturaer).
export async function portalLink(brugerId: string, base: string): Promise<LinkSvar> {
  const f = await hentFirma("bruger_id", brugerId);
  if (!f) return { fejl: "Kun firmakonti har et abonnement.", kode: "ikke_firma" };
  if (!f.stripe_customer_id) {
    return { fejl: "Du har ikke betalt for din pakke endnu.", kode: "ingen_kunde" };
  }
  const session = await stripe().billingPortal.sessions.create({
    customer: f.stripe_customer_id,
    configuration: await sikrPortalKonfiguration(),
    return_url: `${base}/firma/abonnement`,
    locale: "da",
  });
  return { ok: true, url: session.url };
}

// Retur fra Checkout: hent sessionen og spejl abonnement og faktura med det
// samme (webhooken gør det samme - begge er idempotente).
export async function bekraeftCheckout(
  brugerId: string,
  sessionId: string,
): Promise<"betalt" | "behandles" | "ukendt"> {
  if (!/^cs_test_[A-Za-z0-9]{10,200}$/.test(sessionId)) return "ukendt";
  const f = await hentFirma("bruger_id", brugerId);
  if (!f?.stripe_customer_id) return "ukendt";
  const session = await stripe().checkout.sessions.retrieve(sessionId, {
    expand: ["subscription", "subscription.latest_invoice"],
  });
  if (id(session.customer) !== f.stripe_customer_id || session.metadata?.firma_id !== f.id) return "ukendt";
  if (session.status !== "complete") return "behandles";
  const sub = session.subscription && typeof session.subscription !== "string" ? session.subscription : null;
  if (!sub) return "behandles";
  await synkAbonnement(sub);
  const faktura = sub.latest_invoice && typeof sub.latest_invoice !== "string" ? sub.latest_invoice : null;
  if (faktura) await synkFaktura(faktura, null);
  return faktura?.status === "paid" ? "betalt" : "behandles";
}

// --- Pakkeskift --------------------------------------------------------------
//
// Alle pakkeskift går gennem serveren (src/lib/erhverv/pakkeskift.ts):
// firma_skift_pakke_server ændrer databasen og svarer med 'tilbagerul'
// (tilstanden før). Derefter ændres abonnementet i Stripe her. Fejler Stripe,
// FØR abonnementet er ændret, rulles databasen tilbage
// (firma_pakkeskift_rul_tilbage), så firmaet beholder præcis det, det havde.

type SkiftRaekke = {
  id: string;
  firma_id: string;
  til_pakke_id: string;
  type: string;
  status: string;
  stripe_invoice_id: string | null;
};

const SKIFT_FELTER = "id, firma_id, til_pakke_id, type, status, stripe_invoice_id";

async function hentSkift(skiftId: string): Promise<SkiftRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("firma_pakkeskift")
    .select(SKIFT_FELTER)
    .eq("id", skiftId)
    .maybeSingle<SkiftRaekke>();
  if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
  return data;
}

function fejltekst(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Databasen sættes tilbage til før skiftet. Kaster ikke (logger i stedet).
async function rulTilbage(
  firmaId: string,
  skiftId: string | null,
  tilbagerul: Tilbagerul,
  gendanPlanlagt: boolean,
  gendanAfventende: boolean,
  aarsag: string,
  laas: string | null,
): Promise<Tilbagerulning> {
  try {
    const svar = await rpc("firma_pakkeskift_rul_tilbage", {
      p_firma: firmaId,
      p_skift: skiftId,
      p_tilbagerul: tilbagerul,
      p_gendan_planlagt: gendanPlanlagt,
      p_gendan_afventende: gendanAfventende,
      p_note: `Rullet tilbage: ${aarsag}`.slice(0, 1000),
      // Kun vores egen lås ryddes (20261010071000): har et nyere skift eller
      // chefen taget den, røres intet ('laas_overtaget').
      p_laas: laas,
    });
    // Et nyere pakkeskift (eller chefen) har taget låsen: intet er rullet
    // tilbage herfra, og det nye skift gælder. Det er ikke "alt er rullet
    // tilbage" - drift skal tjekke, at Stripe og databasen stemmer.
    if (svar.kode === "laas_overtaget") {
      await logDriftFejl({
        kilde: "server",
        hvor: "erhverv/rul-tilbage",
        fejl: `Pakkeskift ${skiftId ?? "-"} for firma ${firmaId} blev ikke rullet tilbage: et nyere pakkeskift har taget låsen. Tjek abonnementet i Stripe mod databasen. Stripe-fejl: ${aarsag}`,
      });
      return "laas_overtaget";
    }
    if (svar.kode !== "ok") {
      await logDriftFejl({
        kilde: "server",
        hvor: "erhverv/rul-tilbage",
        fejl: `Pakkeskift ${skiftId ?? "-"} for firma ${firmaId} kunne ikke rulles tilbage (${String(svar.kode)}) efter Stripe-fejl: ${aarsag}`,
      });
      return "fejl";
    }
    return "ok";
  } catch (err) {
    await logDriftFejl({
      kilde: "server",
      hvor: "erhverv/rul-tilbage",
      fejl: `Pakkeskift ${skiftId ?? "-"} for firma ${firmaId}: tilbagerulning fejlede (${fejltekst(err)}) efter Stripe-fejl: ${aarsag}`,
    });
    return "fejl";
  }
}

// En planlagt nedgradering i Stripe (Subscription Schedule) fjernes, så
// abonnementet igen styres direkte. Svarer true, hvis en plan blev frigivet.
async function frigivPlan(sub: Stripe.Subscription): Promise<boolean> {
  const plan = id(sub.schedule);
  if (!plan) return false;
  try {
    await stripe().subscriptionSchedules.release(plan);
    return true;
  } catch (err) {
    // Allerede frigivet/afsluttet - intet at gøre.
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    return false;
  }
}

// Opgraderinger, der stadig venter på betaling i Stripe (pending update med
// en åben faktura), men som ikke længere venter i databasen (firmaet har valgt
// en anden pakke): fakturaen annulleres (void), så den ikke kan betales ved en
// fejl, og Stripe dropper den ventende ændring. Betales den alligevel inden,
// refunderes den (refunderOpgradering). ALLE åbne ses (ikke kun de seneste):
// kun fakturaer, hvis regning ikke allerede er afsluttet, slås op i Stripe.
// Svarer med antallet af annullerede fakturaer. Kaster ikke.
async function annullerGamleOpgraderinger(firmaId: string): Promise<number> {
  let antal = 0;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("firma_pakkeskift")
      .select("stripe_invoice_id")
      .eq("firma_id", firmaId)
      .in("status", ["annulleret", "erstattet"])
      .not("stripe_invoice_id", "is", null);
    if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
    const ider = ((data ?? []) as { stripe_invoice_id: string }[]).map((r) => r.stripe_invoice_id);
    if (!ider.length) return 0;
    const { data: afsluttede, error: rFejl } = await admin
      .from("firma_regninger")
      .select("stripe_invoice_id")
      .eq("firma_id", firmaId)
      .in("stripe_invoice_id", ider)
      .in("status", ["betalt", "annulleret", "krediteret"]);
    if (rFejl) throw new Error(`firma_regninger: ${rFejl.message}`);
    const faerdige = new Set(((afsluttede ?? []) as { stripe_invoice_id: string }[]).map((r) => r.stripe_invoice_id));
    const s = stripe();
    for (const fakturaId of ider) {
      if (faerdige.has(fakturaId)) continue;
      try {
        const faktura = await s.invoices.retrieve(fakturaId);
        if (faktura.status !== "open") continue;
        const annulleret = await s.invoices.voidInvoice(faktura.id);
        antal++;
        await synkFaktura(annulleret, null);
      } catch (err) {
        await logDriftFejl({ kilde: "server", hvor: "annullerGamleOpgraderinger", fejl: `${fakturaId}: ${fejltekst(err)}` });
      }
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "annullerGamleOpgraderinger", fejl: err });
  }
  return antal;
}

// Skiftet er færdigt (betalt, annulleret eller refunderet): skift_id fjernes
// fra abonnementets metadata, så senere fakturaer ikke kobles til det. Kun hvis
// det stadig er DETTE skift, der står der. Kaster ikke.
async function rydSkiftMetadata(subId: string | null, skiftId: string): Promise<void> {
  if (!subId) return;
  try {
    const s = stripe();
    const sub = await s.subscriptions.retrieve(subId);
    if (sub.metadata?.skift_id !== skiftId) return;
    await s.subscriptions.update(
      subId,
      { metadata: { skift_id: "" } },
      { idempotencyKey: idempotensNoegle.opgraderingMetadataRyd(skiftId) },
    );
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "erhverv/ryd-skift-metadata", fejl: `${subId}/${skiftId}: ${fejltekst(err)}` });
  }
}

// Pakken, en Stripe-pris hører til (metadata.pakke_id fra sikrPris).
function prisensPakke(pris: Stripe.Price | string | null | undefined): string | null {
  if (!pris || typeof pris === "string") return null;
  return typeof pris.metadata?.pakke_id === "string" ? pris.metadata.pakke_id : null;
}

// Firmaet har valgt en større pakke (firma_skift_pakke_server svarede
// 'opgradering_afventer_betaling'). Pakken skifter først, når fakturaen for
// forskellen er betalt. Fejler Stripe, før abonnementet er ændret, rulles
// databasen tilbage.
export async function startOpgradering(
  skiftId: string,
  tilbagerul: Tilbagerul | null,
  laas: string | null = null,
): Promise<BetalingsStatus> {
  let firmaId: string | null = null;
  let planFrigivet = false;
  let annulleret = 0;
  let aendret = false;
  let subIdForRyd: string | null = null;
  try {
    const skift = await hentSkift(skiftId);
    if (!skift || skift.status !== "afventer_betaling" || skift.type !== "opgradering") {
      return { status: "fejl", fejl: "Pakkeskiftet afventer ikke betaling." };
    }
    const f = await hentFirma("id", skift.firma_id);
    // Uden Stripe-abonnement (fx manuel aftale): BidHamr afgør betalingen.
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return AFVENTER_MANUEL;
    firmaId = f.id;

    const s = stripe();
    let sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    // I den gratis periode er der intet at betale: skiftet sker med det samme.
    if (sub.status === "trialing") return await skiftIGratisPeriode(f, skift, sub, tilbagerul, laas);
    if (sub.status !== "active") {
      const r = tilbagerul
        ? await rulTilbage(f.id, skift.id, tilbagerul, true, true, `abonnementet er ${sub.status}`, laas)
        : "fejl";
      return { status: "fejl", fejl: `Abonnementet er ${sub.status}`, ...tilbagerulFelter(r), betalFoerst: true };
    }
    const prisId = await firmaPris(f, skift.til_pakke_id);

    planFrigivet = await frigivPlan(sub);
    if (sub.pending_update) annulleret = await annullerGamleOpgraderinger(f.id);
    if (planFrigivet || sub.pending_update) sub = await s.subscriptions.retrieve(sub.id);
    if (sub.pending_update) throw new Error(`Abonnement ${sub.id} har stadig en ventende ændring`);
    const item = sub.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);

    // Skiftets id på abonnementet: fakturaen for forskellen får det med
    // (invoice.parent.subscription_details.metadata), så webhooken altid kan
    // finde skiftet - også før faktura-id'et er gemt herunder.
    // (pending_if_incomplete tillader ikke metadata i samme kald.)
    subIdForRyd = sub.id;
    await s.subscriptions.update(
      sub.id,
      { metadata: { firma_id: f.id, skift_id: skift.id } },
      { idempotencyKey: idempotensNoegle.opgraderingMetadata(skift.id) },
    );

    let opdateret: Stripe.Subscription;
    try {
      opdateret = await s.subscriptions.update(
        sub.id,
        {
          items: [{ id: item.id, price: prisId, quantity: 1 }],
          proration_behavior: "always_invoice",
          payment_behavior: "pending_if_incomplete",
          expand: ["latest_invoice"],
        },
        { idempotencyKey: idempotensNoegle.opgradering(skift.id) },
      );
    } catch (err) {
      // Er ændringen alligevel gået igennem (fx timeout efter svaret)?
      const tjek = await s.subscriptions.retrieve(sub.id).catch(() => null);
      if (tjek && (tjek.pending_update || tjek.items.data[0]?.price.id === prisId)) aendret = true;
      throw err;
    }
    aendret = true;
    const faktura =
      opdateret.latest_invoice && typeof opdateret.latest_invoice !== "string" ? opdateret.latest_invoice : null;
    if (!faktura) throw new Error(`Ingen faktura efter opgradering af ${sub.id}`);

    const { error } = await createAdminClient()
      .from("firma_pakkeskift")
      .update({ stripe_invoice_id: faktura.id })
      .eq("id", skift.id)
      .is("stripe_invoice_id", null);
    if (error) throw new Error(`firma_pakkeskift.stripe_invoice_id: ${error.message}`);

    // Abonnementet ER ændret nu: herfra rulles intet tilbage. Fejler
    // spejlingen (fx ProevIgen, fordi Stripe ikke har anvendt ændringen
    // endnu), klarer webhooken det - firmaet må ikke få "betalingen fejlede".
    let resultat: string | null = null;
    try {
      resultat = await synkFaktura(faktura, null);
    } catch (err) {
      if (!(err instanceof ProevIgen)) {
        await logDriftFejl({ kilde: "server", hvor: "startOpgradering/synk", fejl: `Opgradering ${skift.id}: ${fejltekst(err)}` });
      }
    }
    if (faktura.status === "paid") {
      // Betalt, men prisen blev ikke skiftet: refunderet og annulleret.
      if (resultat?.startsWith("opgradering:pris_ikke_skiftet")) {
        return { status: "fejl", fejl: "Prisen blev ikke skiftet - betalingen er refunderet", rulletTilbage: true };
      }
      return resultat === "opgradering:ok" || resultat === "opgradering:allerede_registreret"
        ? { status: "betalt" }
        : BETALT_BEHANDLES;
    }
    if (faktura.hosted_invoice_url?.startsWith("https://")) {
      return { status: "kraever_handling", url: faktura.hosted_invoice_url };
    }
    return AFVENTER_MANUEL;
  } catch (err) {
    if (firmaId && tilbagerul && !aendret) {
      // Er planen frigivet i Stripe, kan den planlagte nedgradering ikke
      // gendannes; er en gammel faktura annulleret, kan den gamle
      // opgradering heller ikke.
      const r = await rulTilbage(firmaId, skiftId, tilbagerul, !planFrigivet, annulleret === 0, `opgradering: ${fejltekst(err)}`, laas);
      await rydSkiftMetadata(subIdForRyd, skiftId);
      return { status: "fejl", fejl: fejltekst(err), ...tilbagerulFelter(r) };
    }
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Pakkeskift i den gratis periode (begge retninger): prisen skiftes i Stripe
// uden proration (perioden er gratis, så der er intet at afregne), og skiftet
// gennemføres i databasen med det samme (firma_pakkeskift_uden_betaling) -
// flere auktioner med det samme ved en opgradering. Første betaling (ved
// trial_end) er den nye pakkes pris. Fejler Stripe, før prisen er skiftet,
// rulles databasen tilbage.
async function skiftIGratisPeriode(
  f: FirmaRaekke,
  skift: SkiftRaekke,
  sub: Stripe.Subscription,
  tilbagerul: Tilbagerul | null,
  laas: string | null,
): Promise<BetalingsStatus> {
  const s = stripe();
  let aendret = false;
  let planFrigivet = false;
  try {
    const prisId = await firmaPris(f, skift.til_pakke_id);
    planFrigivet = await frigivPlan(sub);
    const frisk = planFrigivet ? await s.subscriptions.retrieve(sub.id) : sub;
    const item = frisk.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
    if (item.price.id !== prisId) {
      try {
        await s.subscriptions.update(
          sub.id,
          { items: [{ id: item.id, price: prisId, quantity: 1 }], proration_behavior: "none" },
          { idempotencyKey: idempotensNoegle.gratisSkift(skift.id) },
        );
      } catch (err) {
        const tjek = await s.subscriptions.retrieve(sub.id).catch(() => null);
        if (tjek?.items.data[0]?.price.id === prisId) aendret = true;
        throw err;
      }
    }
    aendret = true;
    const svar = await rpc("firma_pakkeskift_uden_betaling", {
      p_skift: skift.id,
      p_note: "Skiftet i den gratis periode (ingen betaling)",
    });
    if (svar.kode !== "ok" && svar.kode !== "allerede_registreret") {
      throw new Error(`firma_pakkeskift_uden_betaling svarede ${String(svar.kode)}`);
    }
    return { status: "betalt", straks: true };
  } catch (err) {
    if (!aendret && tilbagerul) {
      const r = await rulTilbage(f.id, skift.id, tilbagerul, !planFrigivet, true, `skift i gratis periode: ${fejltekst(err)}`, laas);
      return { status: "fejl", fejl: fejltekst(err), ...tilbagerulFelter(r) };
    }
    // Prisen ER skiftet i Stripe, men databasen fulgte ikke med: alarm (staff
    // gennemfører skiftet i admin - prisen i Stripe er allerede den nye).
    await logDriftFejl({
      kilde: "server",
      hvor: "erhverv/gratis-skift",
      fejl: `Pakkeskift ${skift.id} for firma ${f.id}: prisen er skiftet i Stripe (${sub.id}), men databasen kunne ikke opdateres - skift pakken i admin: ${fejltekst(err)}`,
    });
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

function stopHvisOpsagt(sub: Stripe.Subscription): void {
  if (sub.cancel_at_period_end || sub.cancel_at) {
    throw new Error(`Abonnement ${sub.id} er opsagt - nedgraderingen er stoppet`);
  }
}

// Firmaet har valgt en mindre pakke (firma_skift_pakke_server svarede
// 'nedgradering_planlagt'). Prisen skifter i Stripe ved periodens slut.
// Fejler Stripe, rulles databasen tilbage.
export async function startNedgradering(
  skiftId: string,
  tilbagerul: Tilbagerul | null,
  laas: string | null = null,
): Promise<BetalingsStatus> {
  let firmaId: string | null = null;
  let annulleret = 0;
  let nyPlan: string | null = null;
  try {
    const skift = await hentSkift(skiftId);
    if (!skift || skift.status !== "planlagt") return { status: "fejl", fejl: "Skiftet er ikke planlagt." };
    const f = await hentFirma("id", skift.firma_id);
    // Uden Stripe-abonnement (fx manuel aftale): kun databasen.
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "betalt" };
    firmaId = f.id;

    const s = stripe();
    let sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      throw new Error(`Abonnementet er ${sub.status}`);
    }
    // I den gratis periode skiftes med det samme (ingen plan).
    if (sub.status === "trialing") return await skiftIGratisPeriode(f, skift, sub, tilbagerul, laas);
    const prisId = await firmaPris(f, skift.til_pakke_id);
    const moms = await sikrMomssats();
    annulleret = await annullerGamleOpgraderinger(f.id);
    // Frisk lige før planen laves: er abonnementet opsagt i mellemtiden
    // (cancel_at_period_end/cancel_at), stoppes nedgraderingen og rulles
    // tilbage - en Stripe-plan ville ellers genstarte et opsagt abonnement.
    sub = await s.subscriptions.retrieve(sub.id);
    stopHvisOpsagt(sub);
    if (sub.pending_update) throw new Error(`Abonnement ${sub.id} har stadig en ventende ændring`);
    const item = sub.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
    const periodeSlut = item.current_period_end;

    let planId = id(sub.schedule);
    if (!planId) {
      planId = (
        await s.subscriptionSchedules.create(
          { from_subscription: sub.id },
          { idempotencyKey: idempotensNoegle.nedgraderingPlan(skift.id) },
        )
      ).id;
      nyPlan = planId;
    }
    const plan = await s.subscriptionSchedules.retrieve(planId);
    const start = plan.current_phase?.start_date ?? plan.phases[0]?.start_date ?? item.current_period_start;
    // Og igen lige før planen ændres (en ny plan frigives i catch).
    const lige = await s.subscriptions.retrieve(sub.id);
    stopHvisOpsagt(lige);
    // Abonnementets rabatter (fx introrabatten) følger med i BEGGE faser:
    // uden 'discounts' arver en fase kun KUNDENS rabatter (Stripe:
    // subscription_schedules phases.discounts), og introrabatten ville
    // forsvinde ved nedgraderingen. 'discount' genbruger den eksisterende
    // rabat (samme slutdato, discount.end), så den gælder til intro_til - ikke
    // en ny periode fra nu.
    const rabatter = (lige.discounts ?? [])
      .map((d) => id(d))
      .filter((x): x is string => !!x)
      .map((discount) => ({ discount }));

    await s.subscriptionSchedules.update(
      planId,
      {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: item.price.id, quantity: 1 }],
            default_tax_rates: [moms],
            ...(rabatter.length ? { discounts: rabatter } : {}),
            start_date: start,
            end_date: periodeSlut,
            proration_behavior: "none",
          },
          {
            items: [{ price: prisId, quantity: 1 }],
            default_tax_rates: [moms],
            ...(rabatter.length ? { discounts: rabatter } : {}),
            proration_behavior: "none",
            duration: { interval: "month", interval_count: 1 },
          },
        ],
        metadata: { firma_id: f.id, skift_id: skift.id },
      },
      { idempotencyKey: idempotensNoegle.nedgradering(skift.id) },
    );
    nyPlan = null;

    // Datoen følger Stripes periode.
    const iso = new Date(periodeSlut * 1000).toISOString();
    const admin = createAdminClient();
    await admin.from("firmaer").update({ naeste_pakke_fra: iso }).eq("id", f.id).eq("naeste_pakke_id", skift.til_pakke_id);
    await admin.from("firma_pakkeskift").update({ gaelder_fra: iso }).eq("id", skift.id).eq("status", "planlagt");
    return { status: "betalt" };
  } catch (err) {
    if (nyPlan) {
      // Planen, vi selv lavede, fjernes igen (abonnementet er uændret).
      await stripe()
        .subscriptionSchedules.release(nyPlan)
        .catch((e) => logDriftFejl({ kilde: "server", hvor: "startNedgradering/frigiv", fejl: e }));
    }
    if (firmaId && tilbagerul) {
      const r = await rulTilbage(firmaId, skiftId, tilbagerul, true, annulleret === 0, `nedgradering: ${fejltekst(err)}`, laas);
      return { status: "fejl", fejl: fejltekst(err), ...tilbagerulFelter(r) };
    }
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Firmaet beholder sin pakke ("uaendret"): en planlagt nedgradering i Stripe
// fjernes, og gamle opgraderingsfakturaer annulleres. Fejler Stripe, rulles
// databasen tilbage (den planlagte nedgradering gælder stadig).
export async function annullerPlanlagtSkift(
  brugerId: string,
  tilbagerul: Tilbagerul | null,
  laas: string | null = null,
): Promise<BetalingsStatus> {
  let firmaId: string | null = null;
  let annulleret = 0;
  try {
    const f = await hentFirma("bruger_id", brugerId);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "betalt" };
    firmaId = f.id;
    annulleret = await annullerGamleOpgraderinger(f.id);
    await frigivPlan(await stripe().subscriptions.retrieve(f.stripe_subscription_id));
    return { status: "betalt" };
  } catch (err) {
    if (firmaId && tilbagerul) {
      const r = await rulTilbage(firmaId, null, tilbagerul, true, annulleret === 0, `behold pakken: ${fejltekst(err)}`, laas);
      return { status: "fejl", fejl: fejltekst(err), ...tilbagerulFelter(r) };
    }
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// --- Admin -------------------------------------------------------------------

// Chefens opsigelse og pakkeskift tager samme lås som firmaets pakkeskift
// (firmaer.pakkeskift_laas, 20261010071000), så de aldrig kører samtidig med
// et pakkeskift - og firmaet kan ikke starte et skift, mens chefen arbejder.
export const PAKKESKIFT_I_GANG =
  "Firmaet er ved at skifte pakke lige nu. Vent et par minutter, og prøv igen.";
export class PakkeskiftIGang extends Error {}

async function tagPakkeskiftLaas(firmaId: string): Promise<string | null> {
  const { data, error } = await createAdminClient().rpc("firma_pakkeskift_laas_tag", { p_firma: firmaId });
  if (error) throw new Error(`firma_pakkeskift_laas_tag: ${error.message}`);
  return typeof data === "string" ? data : null;
}

// Kaster ikke (låsen udløber selv efter 5 minutter).
export async function frigivPakkeskiftLaas(firmaId: string, laas: string): Promise<void> {
  const { error } = await createAdminClient().rpc("firma_pakkeskift_laas_frigiv", { p_firma: firmaId, p_laas: laas });
  if (error) await logDriftFejl({ kilde: "action", hvor: "erhverv/frigiv-laas", fejl: error });
}

// Firmakontoen er oprettet: Stripe-kunden laves med det samme (så CVR og
// adresse står rigtigt), men abonnementet starter først, når firmaet betaler
// ("Betal for din pakke"). Kaster ikke.
export async function startAbonnement(firmaId: string): Promise<BetalingsStatus> {
  try {
    if (!stripeTilgaengelig()) return AFVENTER_MANUEL;
    const f = await hentFirma("id", firmaId);
    if (f) await sikrKunde(f);
    return { status: "afventer_betaling", besked: "Firmaet betaler selv for pakken i Firma oversigt → Abonnement." };
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "startAbonnement", fejl: err });
    return { status: "afventer_betaling", besked: "Firmaet betaler selv for pakken i Firma oversigt → Abonnement." };
  }
}

export type AdminPrisSvar =
  | { status: "ingen_stripe" }
  | {
      status: "ok";
      firmaId: string;
      subId: string;
      itemId: string;
      gammelPris: string;
      nyPris: string;
      // Hvad der blev fjernet i Stripe og IKKE kan genskabes (en annulleret
      // faktura kan ikke genåbnes; en frigivet plan er væk).
      planFrigivet: boolean;
      annulleredeFakturaer: number;
      // Pakkeskift-låsen: frigives af kalderen (frigivPakkeskiftLaas), når
      // databasen også er opdateret.
      laas: string;
    };

// Chefen skifter firmaets pakke i admin (med det samme). I Stripe:
// ventende opgraderingsfakturaer annulleres, en planlagt nedgradering
// frigives, og abonnementets pris sættes til den nye pakke med
// proration_behavior 'none' - den nye pris gælder fra firmaets næste betaling,
// og der laves ingen faktura eller kreditnota for resten af perioden (chefen
// har en aftale med firmaet; en evt. forskel ordnes særskilt). Kaster ved
// fejl - så ændres databasen ikke. Kaldes FØR databasen (erhverv_firma_opdater);
// fejler den, sættes prisen tilbage med saetAdminPrisTilbage.
//
// En frigivet plan og annullerede fakturaer kan ikke genskabes i Stripe. Går
// noget galt bagefter, gøres databasen derfor konsistent med Stripe: den
// planlagte nedgradering annulleres også dér (invoice.voided-webhooken
// annullerer den ventende opgradering), og der gives drift-alarm, så chefen
// ved, at firmaet skal vælge igen.
export async function skiftPrisAdmin(firmaId: string, pakkeId: string): Promise<AdminPrisSvar> {
  const f = await hentFirma("id", firmaId);
  if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "ingen_stripe" };
  // Afvises, mens firmaet er midt i et pakkeskift (PakkeskiftIGang).
  const laas = await tagPakkeskiftLaas(firmaId);
  if (!laas) throw new PakkeskiftIGang(PAKKESKIFT_I_GANG);
  const s = stripe();
  let sub: Stripe.Subscription;
  let prisId: string;
  try {
    sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      await frigivPakkeskiftLaas(firmaId, laas);
      return { status: "ingen_stripe" };
    }
    prisId = await firmaPris(f, pakkeId);
  } catch (err) {
    await frigivPakkeskiftLaas(firmaId, laas);
    throw err;
  }

  let planFrigivet = false;
  let annulleredeFakturaer = 0;
  try {
    // Åbne opgraderingsfakturaer på abonnementet annulleres (chefen afgør pakken).
    for await (const faktura of s.invoices.list({ subscription: sub.id, status: "open", limit: 20 })) {
      if (fakturaType(faktura) !== "opgradering") continue;
      const annulleret = await s.invoices.voidInvoice(faktura.id);
      annulleredeFakturaer++;
      await synkFaktura(annulleret, null);
    }
    planFrigivet = await frigivPlan(sub);
    sub = await s.subscriptions.retrieve(sub.id);
    if (sub.pending_update) throw new Error(`Abonnement ${sub.id} har stadig en ventende ændring`);
    const item = sub.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
    if (item.price.id !== prisId) {
      await s.subscriptions.update(
        sub.id,
        { items: [{ id: item.id, price: prisId, quantity: 1 }], proration_behavior: "none" },
        { idempotencyKey: idempotensNoegle.adminPakke(firmaId, randomUUID()) },
      );
    }
    return {
      status: "ok",
      firmaId,
      subId: sub.id,
      itemId: item.id,
      gammelPris: item.price.id,
      nyPris: prisId,
      planFrigivet,
      annulleredeFakturaer,
      laas,
    };
  } catch (err) {
    await efterAdminFejl(firmaId, sub.id, planFrigivet, annulleredeFakturaer, `Stripe-fejl: ${fejltekst(err)}`);
    await frigivPakkeskiftLaas(firmaId, laas);
    throw err;
  }
}

// Chefens pakkeskift blev ikke gennemført, men Stripe-planen/fakturaerne er
// allerede fjernet: databasen rettes til (planlagt nedgradering annulleres),
// og chefen får drift-alarm. Kaster ikke.
async function efterAdminFejl(
  firmaId: string,
  subId: string,
  planFrigivet: boolean,
  annulleredeFakturaer: number,
  aarsag: string,
): Promise<void> {
  if (!planFrigivet && annulleredeFakturaer === 0) return;
  const dele: string[] = [];
  if (planFrigivet) {
    try {
      await rpc("firma_pakkeskift_annuller_planlagt", {
        p_firma: firmaId,
        p_note: "Chefens pakkeskift fejlede, efter at planen i Stripe var frigivet",
      });
      dele.push("den planlagte nedgradering er frigivet i Stripe og annulleret i databasen");
    } catch (err) {
      dele.push(`den planlagte nedgradering er frigivet i Stripe, men kunne IKKE annulleres i databasen (${fejltekst(err)}) - annullér den manuelt`);
    }
  }
  if (annulleredeFakturaer > 0) {
    dele.push(`${annulleredeFakturaer} ventende opgraderingsfaktura(er) er annulleret (kan ikke genåbnes)`);
  }
  await logDriftFejl({
    kilde: "action",
    hvor: "erhverv/admin-pakke-delvist",
    fejl: `Chefens pakkeskift for firma ${firmaId} (abonnement ${subId}) blev ikke gennemført (${aarsag}), men ${dele.join(", og ")}. Firmaet beholder sin pakke og skal vælge pakkeskiftet igen.`,
  });
}

// Databasen kunne ikke gemme chefens pakkeskift: prisen sættes tilbage, og
// det, der ikke kan genskabes i Stripe (plan/fakturaer), rettes i databasen
// med drift-alarm (efterAdminFejl).
export async function saetAdminPrisTilbage(svar: Extract<AdminPrisSvar, { status: "ok" }>): Promise<void> {
  if (svar.gammelPris !== svar.nyPris) {
    try {
      await stripe().subscriptions.update(
        svar.subId,
        { items: [{ id: svar.itemId, price: svar.gammelPris, quantity: 1 }], proration_behavior: "none" },
        { idempotencyKey: idempotensNoegle.prisRettelse(svar.subId, randomUUID()) },
      );
    } catch (err) {
      await logDriftFejl({
        kilde: "action",
        hvor: "erhverv/admin-pris-tilbage",
        fejl: `Abonnement ${svar.subId}: prisen kunne ikke sættes tilbage til ${svar.gammelPris} efter fejl i databasen - ret i Stripe: ${fejltekst(err)}`,
      });
    }
  }
  await efterAdminFejl(svar.firmaId, svar.subId, svar.planFrigivet, svar.annulleredeFakturaer, "databasen kunne ikke gemme skiftet");
}

export type OpsigSvar =
  | { status: "opsiges"; fra: string }
  | { status: "ingen_stripe" }
  // Firmaet er midt i et pakkeskift (dansk besked i fejl).
  | { status: "i_gang"; fejl: string }
  | { status: "fejl"; fejl: string };

// Opsigelse (chef og sælger i admin): abonnementet stopper ved periodens slut.
// Ingen refusion.
// Ny idempotency-nøgle pr. klik, og abonnementet hentes frisk bagefter, så
// opsig -> fortryd -> opsig igen altid virker i Stripe.
export async function opsigAbonnement(firmaId: string): Promise<OpsigSvar> {
  let laas: string | null = null;
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id) return { status: "ingen_stripe" };
    // Ikke midt i et pakkeskift: en nedgradering laver en Stripe-plan, som
    // ellers kunne genstarte det opsagte abonnement.
    laas = await tagPakkeskiftLaas(f.id);
    if (!laas) return { status: "i_gang", fejl: PAKKESKIFT_I_GANG };
    const s = stripe();
    const sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    if (sub.status === "canceled") return { status: "ingen_stripe" };
    await frigivPlan(sub);
    await s.subscriptions.update(
      sub.id,
      { cancel_at_period_end: true },
      { idempotencyKey: idempotensNoegle.opsigelse(firmaId, randomUUID()) },
    );
    const frisk = await s.subscriptions.retrieve(sub.id);
    await synkAbonnement(frisk);
    if (!frisk.cancel_at_period_end && !frisk.cancel_at) {
      return { status: "fejl", fejl: `Stripe viser ikke abonnementet ${sub.id} som opsagt.` };
    }
    // Planen (en planlagt nedgradering) er frigivet i Stripe ovenfor - så
    // skal den også væk i databasen, ellers gennemføres den alligevel. Den
    // genopstår ikke ved "Fortryd opsigelsen" (rul_tilbage gendanner aldrig
    // en nedgradering med denne note).
    await rpc("firma_pakkeskift_annuller_planlagt", { p_firma: firmaId, p_note: "Abonnementet er opsagt" }).catch((err) =>
      logDriftFejl({
        kilde: "action",
        hvor: "erhverv/opsig-planlagt",
        fejl: `Firma ${firmaId} er opsagt i Stripe, men den planlagte nedgradering kunne ikke annulleres i databasen - annullér den manuelt: ${fejltekst(err)}`,
      }),
    );
    const slut = frisk.items.data[0]?.current_period_end ?? null;
    const fra = tid(frisk.cancel_at) ?? tid(slut) ?? new Date().toISOString();
    return { status: "opsiges", fra };
  } catch (err) {
    return { status: "fejl", fejl: fejltekst(err) };
  } finally {
    if (laas) await frigivPakkeskiftLaas(firmaId, laas);
  }
}

export async function fortrydOpsigelse(firmaId: string): Promise<{ status: "ok" } | { status: "fejl"; fejl: string }> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id) return { status: "fejl", fejl: "Firmaet har ikke et abonnement i Stripe." };
    const s = stripe();
    await s.subscriptions.update(
      f.stripe_subscription_id,
      { cancel_at_period_end: false },
      { idempotencyKey: idempotensNoegle.fortrydOpsigelse(firmaId, randomUUID()) },
    );
    const frisk = await s.subscriptions.retrieve(f.stripe_subscription_id);
    await synkAbonnement(frisk);
    if (frisk.cancel_at_period_end || frisk.cancel_at) {
      return { status: "fejl", fejl: `Stripe viser stadig abonnementet ${frisk.id} som opsagt.` };
    }
    return { status: "ok" };
  } catch (err) {
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// --- Permanent lukning af en firmakonto ----------------------------------------
//
// Lukkes en firmakonto permanent (bruger_luk_konto_permanent - via
// "3 advarsler"-forslaget eller DSA-indgrebet "luk konto"), kan firmaet ikke
// sælge mere, så abonnementet opsiges i Stripe MED DET SAMME
// (subscriptions.cancel, prorate: false, invoice_now: false): ingen refusion
// eller kreditering for resten af perioden, og ingen ny faktura. Stripe stopper
// selv automatisk opkrævning af åbne fakturaer, når abonnementet opsiges.
//
// Lukningen rulles ALDRIG tilbage, hvis Stripe fejler. I stedet:
//   - opsigVedLukning kaldes lige efter lukningen (after() i server-handlingen),
//   - koerLukOpsigelser kører i betalings-cron'en (hvert 5. minut) og finder
//     ALLE lukkede firmakonti, hvis abonnement ikke er afsluttet i Stripe
//     (firma_luk_opsigelse_kandidater - ud fra tilstanden, så alle veje til
//     lukning er dækket). Fejl tælles op med stigende ventetid (5 min -> 6 t)
//     og giver drift-alarm.
// Stripe er sandheden: abonnementet hentes altid frisk, og databasen spejles
// bagefter (synkAbonnement -> 'opsagt'). Webhooken customer.subscription.deleted
// gør det samme, så rækkefølgen er ligegyldig.

type LukKandidat = {
  firma_id: string;
  bruger_id: string;
  subscription_id: string;
  forsoeg: number;
  konto_lukket_kl: string;
};

export type LukOpsigelseUdfald = "opsagt" | "allerede_afsluttet" | "ikke_lukket" | "ingen" | "fejl";

async function kontoLukket(brugerId: string): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("users")
    .select("konto_lukket_kl")
    .eq("id", brugerId)
    .maybeSingle<{ konto_lukket_kl: string | null }>();
  if (error) throw new Error(`users: ${error.message}`);
  return !!data?.konto_lukket_kl;
}

async function lukKandidater(brugerId: string | null, graense = 20): Promise<LukKandidat[]> {
  const { data, error } = await createAdminClient().rpc("firma_luk_opsigelse_kandidater", {
    p_bruger: brugerId,
    p_graense: graense,
  });
  if (error) {
    // PGRST202: funktionen findes ikke - migrationen er ikke kørt endnu.
    const mangler = error.code === "PGRST202" ? " (migration 20261016040000_erhverv_luk_opsigelse.sql mangler)" : "";
    throw new Error(`firma_luk_opsigelse_kandidater: ${error.message}${mangler}`);
  }
  return (data ?? []) as LukKandidat[];
}

function erAfsluttet(sub: Stripe.Subscription): boolean {
  return sub.status === "canceled" || sub.status === "incomplete_expired";
}

// Åbne Checkout-betalinger lukkes, så firmaet ikke kan starte et nyt
// abonnement efter lukningen. Kaster ikke (logger).
async function lukAabneBetalinger(k: LukKandidat, kunde: string): Promise<void> {
  try {
    const s = stripe();
    for await (const sess of s.checkout.sessions.list({ customer: kunde, status: "open", limit: 20 })) {
      await s.checkout.sessions.expire(sess.id, {}, {
        idempotencyKey: idempotensNoegle.lukCheckout(k.bruger_id, k.subscription_id, k.forsoeg, sess.id),
      });
    }
  } catch (err) {
    await logDriftFejl({
      kilde: "server",
      hvor: "erhverv/luk-checkout",
      fejl: `Firma ${k.firma_id} er lukket, men åbne Checkout-betalinger kunne ikke lukkes i Stripe - luk dem manuelt: ${fejltekst(err)}`,
    });
  }
}

// Ventende opgraderingsfakturaer på abonnementet annulleres (void): pakken kan
// aldrig gives, når kontoen er lukket, og fakturaen kan ellers betales via
// Stripes fakturaside. Almindelige fornyelsesfakturaer, der ikke er betalt
// (perioden er brugt), annulleres IKKE - Stripe stopper opkrævningen, og
// staff afgør dem. Kaster ikke (logger).
async function annullerOpgraderingerVedLukning(k: LukKandidat): Promise<void> {
  const s = stripe();
  try {
    for await (const faktura of s.invoices.list({ subscription: k.subscription_id, status: "open", limit: 20 })) {
      if (!faktura.id || fakturaType(faktura) !== "opgradering") continue;
      try {
        const annulleret = await s.invoices.voidInvoice(faktura.id, {}, {
          idempotencyKey: idempotensNoegle.lukFaktura(k.bruger_id, k.subscription_id, k.forsoeg, faktura.id),
        });
        await synkFaktura(annulleret, null);
      } catch (err) {
        await logDriftFejl({
          kilde: "server",
          hvor: "erhverv/luk-opgradering",
          fejl: `Firma ${k.firma_id} er lukket: opgraderingsfaktura ${faktura.id} kunne ikke annulleres - annullér den manuelt i Stripe: ${fejltekst(err)}`,
        });
      }
    }
  } catch (err) {
    await logDriftFejl({
      kilde: "server",
      hvor: "erhverv/luk-opgradering",
      fejl: `Firma ${k.firma_id} er lukket: åbne fakturaer på ${k.subscription_id} kunne ikke hentes - tjek dem i Stripe: ${fejltekst(err)}`,
    });
  }
}

// Et afsluttet abonnement spejles i databasen og kvitteres. Svarer databasen
// ikke som forventet, KASTES der - så sætter firma_luk_opsigelse_fejl en
// ventetid, og der gives drift-alarm (i stedet for at firmaet tages op igen
// hvert 5. minut uden alarm).
//   'opsagt'         - normalt (cancellation_requested eller opsiges_fra sat)
//   'pause_betaling' - Stripe havde selv afsluttet det pga. manglende betaling;
//                      abonnements-id'et er fjernet, så intet at kvittere
async function spejlAfsluttet(k: LukKandidat, sub: Stripe.Subscription): Promise<void> {
  const spejl = await synkAbonnement(sub, true);
  if (spejl === "pause_betaling") return;
  if (spejl !== "opsagt") {
    throw new Error(`Databasen spejlede ikke abonnementet ${sub.id} som opsagt (svar: ${spejl})`);
  }
  const kvit = await rpc("firma_luk_opsigelse_udfoert", { p_firma: k.firma_id, p_subscription_id: sub.id });
  if (kvit.kode !== "ok" && kvit.kode !== "allerede") {
    throw new Error(`firma_luk_opsigelse_udfoert svarede ${String(kvit.kode)} for ${sub.id}`);
  }
}

async function opsigKandidat(k: LukKandidat, kilde: "action" | "cron"): Promise<LukOpsigelseUdfald> {
  let opsagtIStripe = false;
  try {
    const s = stripe();
    let sub = await s.subscriptions.retrieve(k.subscription_id);
    if (erAfsluttet(sub)) {
      // Allerede afsluttet i Stripe (fx webhooken er ikke nået frem endnu).
      opsagtIStripe = true;
      await spejlAfsluttet(k, sub);
      return "allerede_afsluttet";
    }
    // Lige før opsigelsen: er kontoen stadig lukket? (En omgjort afgørelse
    // kan have genåbnet den imens.)
    if (!(await kontoLukket(k.bruger_id))) return "ikke_lukket";

    const kunde = id(sub.customer);
    if (kunde) await lukAabneBetalinger(k, kunde);

    try {
      sub = await s.subscriptions.cancel(
        sub.id,
        {
          invoice_now: false,
          prorate: false,
          cancellation_details: { comment: "Kontoen er lukket permanent af BidHamr" },
        },
        { idempotencyKey: idempotensNoegle.lukOpsigelse(k.bruger_id, sub.id) },
      );
    } catch (err) {
      // Fejl fra Stripe (fx 404 på et abonnement, der allerede er opsagt, eller
      // en timeout, hvor opsigelsen alligevel gik igennem): abonnementet hentes
      // ALTID frisk - kun et afsluttet abonnement tæller som opsagt.
      const frisk = await s.subscriptions.retrieve(k.subscription_id).catch(() => null);
      if (!frisk || !erAfsluttet(frisk)) throw err;
      sub = frisk;
    }
    if (!erAfsluttet(sub)) sub = await s.subscriptions.retrieve(k.subscription_id);
    if (!erAfsluttet(sub)) throw new Error(`Stripe viser abonnementet ${sub.id} som ${sub.status} efter opsigelsen`);
    opsagtIStripe = true;

    await spejlAfsluttet(k, sub);
    await annullerOpgraderingerVedLukning(k);

    // Abonnementet er startet EFTER lukningen (fx en åben Checkout, der blev
    // betalt bagefter): firmaet har betalt for en periode, det ikke kan bruge.
    if (sub.created * 1000 > new Date(k.konto_lukket_kl).getTime()) {
      await logDriftFejl({
        kilde,
        hvor: "erhverv/luk-nyt-abonnement",
        fejl: `Firma ${k.firma_id} startede abonnementet ${sub.id} efter, at kontoen blev lukket. Det er opsagt - refundér betalingen manuelt i Stripe.`,
      });
    }
    return "opsagt";
  } catch (err) {
    const tekst = fejltekst(err).slice(0, 500);
    let forsoeg: number | null = null;
    try {
      const svar = await rpc("firma_luk_opsigelse_fejl", {
        p_firma: k.firma_id,
        p_subscription_id: k.subscription_id,
        p_fejl: tekst,
      });
      forsoeg = typeof svar.forsoeg === "number" ? svar.forsoeg : null;
    } catch (dbFejl) {
      await logDriftFejl({ kilde, hvor: "erhverv/luk-opsigelse-db", fejl: dbFejl });
    }
    await logDriftFejl({
      kilde,
      hvor: "erhverv/luk-opsigelse",
      fejl: opsagtIStripe
        ? `Firma ${k.firma_id}: abonnementet ${k.subscription_id} ER opsagt i Stripe, men databasen kunne ikke opdateres (forsøg ${forsoeg ?? "?"}) - betalings-cron'en spejler det igen: ${tekst}`
        : `Firma ${k.firma_id} er lukket permanent, men abonnementet ${k.subscription_id} kunne ikke opsiges i Stripe (forsøg ${forsoeg ?? "?"}) - prøves igen af betalings-cron'en: ${tekst}`,
    });
    return "fejl";
  }
}

// Lige efter en permanent lukning (server-handlingen, i after()). Kaster ikke.
// Er brugeren ikke en firmakonto med et aktivt abonnement, sker intet.
export async function opsigVedLukning(brugerId: string): Promise<LukOpsigelseUdfald> {
  // Uden Stripe-testnøgle findes der ingen erhvervsabonnementer i Stripe.
  if (!stripeTilgaengelig()) return "ingen";
  try {
    const [k] = await lukKandidater(brugerId, 1);
    if (!k) return "ingen";
    return await opsigKandidat(k, "action");
  } catch (err) {
    // Fx databasen svarer ikke: cron'en finder kontoen næste gang.
    await logDriftFejl({ kilde: "action", hvor: "erhverv/luk-opsigelse", fejl: err, brugerId });
    return "fejl";
  }
}

// Betalings-cron'en: alle lukkede firmakonti med et abonnement, der ikke er
// afsluttet i Stripe (og hvis ventetid er udløbet). Kaster ikke ved fejl på
// det enkelte firma; kaster, hvis kandidaterne ikke kan hentes.
export async function koerLukOpsigelser(): Promise<{ opsagt: number; fejl: number; ingen_handling: number }> {
  const ud = { opsagt: 0, fejl: 0, ingen_handling: 0 };
  if (!stripeTilgaengelig()) return ud;
  for (const k of await lukKandidater(null, 20)) {
    const r = await opsigKandidat(k, "cron");
    if (r === "opsagt" || r === "allerede_afsluttet") ud.opsagt++;
    else if (r === "fejl") ud.fejl++;
    else ud.ingen_handling++;
  }
  return ud;
}

// Webhooken/serveren har spejlet et afsluttet abonnement ('opsagt'): er
// kontoen lukket, registreres det (nulstiller forsøg og logger én neutral
// linje: "Abonnementet er afsluttet i Stripe (kontoen er lukket permanent)" -
// det kan også være en almindelig opsigelse, der udløb). Kaster ikke -
// spejlingen er det vigtige.
async function kvitterLukOpsigelse(f: FirmaRaekke, subId: string): Promise<void> {
  try {
    if (!(await kontoLukket(f.bruger_id))) return;
    await rpc("firma_luk_opsigelse_udfoert", { p_firma: f.id, p_subscription_id: subId });
  } catch (err) {
    await logDriftFejl({
      kilde: "server",
      hvor: "erhverv/luk-kvitter",
      fejl: `Abonnementet er afsluttet (kontoen er lukket), men det kunne ikke registreres for firma ${f.id} (${subId}): ${fejltekst(err)}`,
    });
  }
}

// --- Spejling (webhook og retursider) ----------------------------------------

async function firmaForKunde(kunde: string | null, metadataFirma?: string | null): Promise<FirmaRaekke | null> {
  if (kunde) {
    const f = await hentFirma("stripe_customer_id", kunde);
    if (f) return f;
  }
  if (metadataFirma && /^[0-9a-f-]{36}$/i.test(metadataFirma)) {
    const f = await hentFirma("id", metadataFirma);
    // Kun hvis kunden passer (metadata kan ikke stå alene).
    if (f && f.stripe_customer_id && f.stripe_customer_id === kunde) return f;
  }
  return null;
}

async function rpc(navn: string, args: Record<string, unknown>): Promise<{ kode?: string } & Record<string, unknown>> {
  const { data, error } = await createAdminClient().rpc(navn, args);
  if (error) throw new Error(`${navn}: ${error.message}`);
  return (data ?? {}) as { kode?: string } & Record<string, unknown>;
}

// customer.subscription.created/updated/deleted (og efter egne kald).
export async function synkAbonnement(sub: Stripe.Subscription, slettet = false): Promise<string> {
  const f = await firmaForKunde(id(sub.customer), sub.metadata?.firma_id);
  if (!f) return "ikke_erhverv";
  const item = sub.items.data[0];
  const svar = await rpc("firma_stripe_abonnement_spejl", {
    p_firma: f.id,
    p_subscription_id: sub.id,
    p_stripe_status: sub.status,
    p_opsiges_fra: sub.cancel_at_period_end || sub.cancel_at ? tid(sub.cancel_at ?? item?.current_period_end) : null,
    p_periode_slut: tid(item?.current_period_end),
    p_slettet: slettet || sub.status === "canceled" || sub.status === "incomplete_expired",
    p_aarsag: sub.cancellation_details?.reason ?? null,
    p_proeve_slut: tid(sub.trial_end),
  });

  if (svar.kode === "ok") {
    // Abonnementet er startet med staff-givne ventende gratis måneder
    // (Checkout-metadata gratis_ekstra, startBetaling): de trækkes fra i
    // databasen. Idempotent pr. abonnement - prøves igen ved næste
    // customer.subscription.updated, hvis det fejler.
    const ekstra = Number(sub.metadata?.gratis_ekstra ?? 0);
    if (Number.isInteger(ekstra) && ekstra > 0 && sub.trial_end) {
      await rpc("firma_gratis_ekstra_brugt", { p_firma: f.id, p_subscription_id: sub.id, p_antal: ekstra }).catch((err) =>
        logDriftFejl({ kilde: "webhook", hvor: "erhverv/gratis-ekstra", fejl: `Firma ${f.id} (${sub.id}): ${fejltekst(err)}` }),
      );
    }
    // En aftalt introrabat sættes på, så snart abonnementet findes (fx lige
    // efter Checkout). Kortet spejles (mærke, sidste 4, udløb). Fejl her må
    // ikke stoppe spejlingen - cron'en prøver introrabatten igen.
    if (f.intro_status === "planlagt" && f.intro_noegle && (sub.status === "trialing" || sub.status === "active")) {
      await anvendIntro(f, sub).catch((err) =>
        logDriftFejl({ kilde: "webhook", hvor: "erhverv/intro", fejl: `Firma ${f.id}: ${fejltekst(err)}` }),
      );
    }
    await synkKort(f.id, sub).catch((err) =>
      logDriftFejl({ kilde: "webhook", hvor: "erhverv/kort", fejl: `Firma ${f.id}: ${fejltekst(err)}` }),
    );
  }

  if (svar.kode === "andet_abonnement" && sub.status !== "canceled" && sub.status !== "incomplete_expired") {
    // Firmaet har allerede et abonnement (fx to betalinger på samme tid):
    // det nye stoppes, og staff refunderer det betalte manuelt.
    await stripe().subscriptions.cancel(sub.id, {}, { idempotencyKey: idempotensNoegle.dobbeltAbonnement(sub.id) });
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/dobbelt-abonnement",
      fejl: `Firma ${f.id} fik et ekstra abonnement ${sub.id} (har ${String(svar.nuvaerende)}). Det ekstra er stoppet i Stripe - refundér dets betaling manuelt.`,
    });
  }
  if (svar.kode === "opsagt") await kvitterLukOpsigelse(f, sub.id);
  return svar.kode ?? "?";
}

// customer.subscription.pending_update_expired: firmaet nåede ikke at betale
// forskellen (fx 3DS ikke godkendt). Stripe har droppet ændringen: fakturaen
// annulleres (void), og skiftet annulleres - firmaet beholder sin pakke.
export async function udloebetOpgradering(sub: Stripe.Subscription): Promise<string> {
  const f = await firmaForKunde(id(sub.customer), sub.metadata?.firma_id);
  if (!f) return "ikke_erhverv";
  const { data, error } = await createAdminClient()
    .from("firma_pakkeskift")
    .select(SKIFT_FELTER)
    .eq("firma_id", f.id)
    .eq("status", "afventer_betaling")
    .eq("type", "opgradering")
    .maybeSingle<SkiftRaekke>();
  if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
  if (!data) return "intet_skift";
  if (data.stripe_invoice_id) {
    const s = stripe();
    const faktura = await s.invoices.retrieve(data.stripe_invoice_id);
    if (faktura.status === "paid") return "betalt"; // invoice.paid behandler den
    if (faktura.status === "open") await synkFaktura(await s.invoices.voidInvoice(faktura.id), null);
  }
  const svar = await rpc("firma_pakkeskift_annuller", {
    p_skift: data.id,
    p_note: "Betalingen for den større pakke blev ikke gennemført i tide (Stripe pending update udløbet)",
    p_krediter_faktura: null,
  });
  await rydSkiftMetadata(sub.id, data.id);
  return `udloebet:${svar.kode}`;
}

function erProration(l: Stripe.InvoiceLineItem): boolean {
  return !!(l.parent?.subscription_item_details?.proration || l.parent?.invoice_item_details?.proration);
}

function erAbonnementslinje(l: Stripe.InvoiceLineItem): boolean {
  return l.parent?.type === "subscription_item_details" && !erProration(l);
}

function fakturaensAbonnement(f: Stripe.Invoice): string | null {
  return id(f.parent?.subscription_details?.subscription);
}

// Fakturatypen ud fra fakturaLINJERNE (ikke billing_reason, som fx er
// 'subscription_update' ved en fase-overgang i en Subscription Schedule):
//   - en almindelig abonnementslinje (ikke proration) = fornyelse/første betaling
//   - kun proration-linjer = opgradering (forskellen for resten af perioden)
//   - ellers (ingen abonnement) = andet
function fakturaType(f: Stripe.Invoice): "abonnement" | "opgradering" | "andet" {
  if (!fakturaensAbonnement(f)) return "andet";
  const linjer = f.lines?.data ?? [];
  if (linjer.some(erAbonnementslinje)) return "abonnement";
  if (linjer.length > 0 && linjer.every(erProration)) return "opgradering";
  if (f.billing_reason === "subscription_create" || f.billing_reason === "subscription_cycle") return "abonnement";
  return "andet";
}

// Perioden, fakturaen dækker. For abonnementsfakturaer er det abonnements-
// linjens periode (ikke invoice.period_*, som er perioden FØR).
function fakturaPeriode(f: Stripe.Invoice): { start: number | null; slut: number | null } {
  const alle = f.lines?.data ?? [];
  const abon = alle.filter(erAbonnementslinje);
  const linjer = abon.length ? abon : alle;
  const starter = linjer.map((l) => l.period?.start).filter((x): x is number => typeof x === "number");
  const slutter = linjer.map((l) => l.period?.end).filter((x): x is number => typeof x === "number");
  return {
    start: starter.length ? Math.min(...starter) : null,
    slut: slutter.length ? Math.max(...slutter) : null,
  };
}

export class ProevIgen extends Error {}

// invoice.finalized/paid/payment_failed/voided/marked_uncollectible (og efter
// egne kald). haendelse 'payment_failed' registrerer en mislykket
// abonnementsbetaling.
export async function synkFaktura(
  faktura: Stripe.Invoice,
  haendelse: "payment_failed" | null,
): Promise<string> {
  const f = await firmaForKunde(id(faktura.customer), faktura.parent?.subscription_details?.metadata?.firma_id);
  if (!f) return "ikke_erhverv";
  const type = fakturaType(faktura);
  const periode = fakturaPeriode(faktura);
  const ekskl = faktura.total_excluding_tax ?? null;
  const subId = fakturaensAbonnement(faktura);

  await rpc("firma_faktura_spejl", {
    p_firma: f.id,
    p_stripe_invoice_id: faktura.id,
    p_nummer: faktura.number ?? null,
    p_type: type,
    p_periode_fra: tid(periode.start),
    p_periode_til: tid(periode.slut),
    p_beloeb_oere: faktura.total,
    p_ekskl_moms_oere: ekskl,
    p_moms_oere: ekskl == null ? null : faktura.total - ekskl,
    p_stripe_status: faktura.status ?? "draft",
    p_pdf_url: faktura.invoice_pdf ?? null,
    p_hosted_url: faktura.hosted_invoice_url ?? null,
    p_subscription_id: subId,
  });

  if (faktura.status === "paid") {
    if (type === "abonnement") {
      const svar = await rpc("firma_abonnement_betalt", {
        p_firma: f.id,
        p_periode_start: tid(periode.start ?? faktura.period_start),
        p_periode_slut: tid(periode.slut ?? faktura.period_end),
        p_beloeb_oere: faktura.amount_paid,
        p_stripe_reference: faktura.id,
        p_stripe_invoice_id: faktura.id,
        p_subscription_id: subId,
      });
      if ((faktura.lines?.data ?? []).some(erProration)) {
        await logDriftFejl({
          kilde: "webhook",
          hvor: "erhverv/fornyelse-med-proration",
          fejl: `Abonnementsfaktura ${faktura.id} for firma ${f.id} har proration-linjer - tjek beløbet i Stripe.`,
        });
      }
      const pris = await tjekAbonnementsPris(f.id, faktura);
      return `abonnement_betalt:${svar.kode}:${pris}`;
    }
    if (type === "opgradering") return betaltOpgradering(f, faktura);
    return "andet";
  }

  if (faktura.status === "void" && type === "opgradering") {
    // Annulleret (af os, af staff i Stripe eller fordi ændringen udløb):
    // et skift, der stadig venter på netop denne faktura, annulleres.
    const { data: skift } = await createAdminClient()
      .from("firma_pakkeskift")
      .select("id")
      .eq("stripe_invoice_id", faktura.id)
      .eq("status", "afventer_betaling")
      .maybeSingle<{ id: string }>();
    if (skift) {
      const svar = await rpc("firma_pakkeskift_annuller", {
        p_skift: skift.id,
        p_note: "Fakturaen for forskellen er annulleret i Stripe",
        p_krediter_faktura: null,
      });
      await rydSkiftMetadata(subId, skift.id);
      return `void:${svar.kode}`;
    }
    return "void";
  }

  if (haendelse === "payment_failed" && type === "abonnement") {
    const svar = await rpc("firma_abonnement_mislykket", {
      p_firma: f.id,
      p_stripe_reference: faktura.id,
      p_beloeb_oere: faktura.amount_due,
      p_stripe_invoice_id: faktura.id,
      p_periode_slut: tid(periode.slut),
      p_subscription_id: subId,
    });
    return `mislykket:${svar.kode}`;
  }
  // En mislykket opgradering: skiftet venter stadig (gammel pakke beholdes).
  return "spejlet";
}

// Værn i dybden: efter en betalt abonnementsfaktura (og firma_anvend_planlagt)
// skal fakturaens Stripe-pris høre til firmaets pakke i databasen. Afviger den,
// logges en drift-alarm. Prisen rettes kun automatisk, når det er sikkert:
// abonnementet styres direkte (ingen plan, ingen ventende ændring, intet skift
// venter), og databasens pakke er IKKE dyrere end det, firmaet betaler i
// Stripe - så firmaet aldrig trækkes for mere uden selv at have valgt det.
// Rettelsen gælder fra næste betaling (proration 'none'). Kaster ikke.
async function tjekAbonnementsPris(firmaId: string, faktura: Stripe.Invoice): Promise<string> {
  try {
    const linje = (faktura.lines?.data ?? []).find(erAbonnementslinje);
    const prisRef = linje?.pricing?.price_details?.price;
    const prisId = id(prisRef);
    if (!prisId) return "ingen_pris";
    const nu = await hentFirma("id", firmaId);
    if (!nu) return "ingen_firma";
    const s = stripe();
    const pris = typeof prisRef === "string" || !prisRef ? await s.prices.retrieve(prisId) : prisRef;
    if (prisensPakke(pris) === nu.pakke_id) return "pris_ok";

    const subId = fakturaensAbonnement(faktura);
    let rettet = false;
    let hvorfor = "";
    if (subId && subId === nu.stripe_subscription_id) {
      const sub = await s.subscriptions.retrieve(subId);
      const { count } = await createAdminClient()
        .from("firma_pakkeskift")
        .select("id", { count: "exact", head: true })
        .eq("firma_id", nu.id)
        .in("status", ["afventer_betaling", "planlagt"]);
      const dbOere = await forventetOere(nu, nu.pakke_id);
      const item = sub.items.data[0];
      if (sub.schedule || sub.pending_update || count || !item) {
        hvorfor = "abonnementet har en plan/ventende ændring - kun alarm";
      } else if (dbOere == null || pris.unit_amount == null || dbOere > pris.unit_amount) {
        hvorfor = "databasens pakke er dyrere end prisen i Stripe - kun alarm (firmaet skal ikke trækkes for mere automatisk)";
      } else {
        const ny = await firmaPris(nu, nu.pakke_id);
        await s.subscriptions.update(
          sub.id,
          { items: [{ id: item.id, price: ny, quantity: 1 }], proration_behavior: "none" },
          { idempotencyKey: idempotensNoegle.prisRettelse(sub.id, randomUUID()) },
        );
        rettet = true;
        hvorfor = `prisen er rettet til ${ny} fra næste betaling`;
      }
    } else {
      hvorfor = "fakturaen hører ikke til firmaets nuværende abonnement - kun alarm";
    }
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/pris-afviger",
      fejl: `Faktura ${faktura.id} for firma ${nu.id} er betalt med pris ${prisId} (pakke ${prisensPakke(pris) ?? "?"}), men firmaets pakke er ${nu.pakke_id}: ${hvorfor}.`,
    });
    return rettet ? "pris_rettet" : "pris_afviger";
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", hvor: "erhverv/pris-tjek", fejl: err });
    return "pris_tjek_fejl";
  }
}

// Det pakkeskift, en betalt opgraderingsfaktura hører til: via faktura-id'et,
// ellers via skift_id i fakturaens abonnements-metadata (sat af
// startOpgradering, før abonnementet ændres).
async function findOpgradering(f: FirmaRaekke, faktura: Stripe.Invoice): Promise<SkiftRaekke | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("firma_pakkeskift")
    .select(SKIFT_FELTER)
    .eq("stripe_invoice_id", faktura.id)
    .maybeSingle<SkiftRaekke>();
  if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
  if (data) return data.firma_id === f.id ? data : null;

  const skiftId = faktura.parent?.subscription_details?.metadata?.skift_id;
  if (!skiftId || !/^[0-9a-f-]{36}$/i.test(skiftId)) return null;
  const skift = await hentSkift(skiftId);
  if (!skift || skift.firma_id !== f.id || skift.type !== "opgradering" || skift.stripe_invoice_id) return null;
  const { error: gemFejl } = await admin
    .from("firma_pakkeskift")
    .update({ stripe_invoice_id: faktura.id })
    .eq("id", skift.id)
    .is("stripe_invoice_id", null);
  if (gemFejl) throw new Error(`firma_pakkeskift.stripe_invoice_id: ${gemFejl.message}`);
  return { ...skift, stripe_invoice_id: faktura.id };
}

async function betaltOpgradering(f: FirmaRaekke, faktura: Stripe.Invoice): Promise<string> {
  const skift = await findOpgradering(f, faktura);
  if (!skift) {
    // Kendes ikke: alarm og acknowledge (ingen uendelige genforsøg).
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/opgradering-ukendt",
      fejl: `Betalt opgraderingsfaktura ${faktura.id} for firma ${f.id} passer ikke til et pakkeskift - undersøg i Stripe (evt. refundér).`,
    });
    return "ukendt_skift";
  }

  if (skift.status === "afventer_betaling") {
    // Er prisen i Stripe faktisk skiftet til den nye pakke? Ellers får
    // firmaet ikke pakken: betalingen refunderes, og skiftet annulleres.
    const subId = fakturaensAbonnement(faktura) ?? f.stripe_subscription_id;
    if (!subId) throw new Error(`Opgraderingsfaktura ${faktura.id} uden abonnement`);
    const sub = await stripe().subscriptions.retrieve(subId);
    const item = sub.items.data[0];
    const pakke = prisensPakke(item?.price);
    if (pakke !== skift.til_pakke_id) {
      if (sub.pending_update) {
        // Stripe har ikke nået at anvende ændringen endnu - prøv igen.
        throw new ProevIgen(`Opgradering ${skift.id}: abonnementet ${sub.id} har stadig en ventende ændring`);
      }
      await refunderOpgradering(f, skift.id, faktura);
      const svar = await rpc("firma_pakkeskift_annuller", {
        p_skift: skift.id,
        p_note: "Betalt, men prisen i Stripe blev ikke skiftet - betalingen er refunderet",
        p_krediter_faktura: null,
      });
      await logDriftFejl({
        kilde: "webhook",
        hvor: "erhverv/opgradering-pris-ikke-skiftet",
        fejl: `Opgradering ${skift.id} (faktura ${faktura.id}) er betalt, men abonnementet ${sub.id} har pris ${item?.price.id ?? "-"} (pakke ${pakke ?? "?"}), ikke pakke ${skift.til_pakke_id}. Refunderet og annulleret.`,
      });
      await rydSkiftMetadata(sub.id, skift.id);
      return `opgradering:pris_ikke_skiftet:${svar.kode}`;
    }
  }

  const svar = await rpc("firma_pakkeskift_betalt", {
    p_skift: skift.id,
    p_stripe_reference: faktura.id,
    p_beloeb_oere: faktura.amount_paid,
    p_stripe_invoice_id: faktura.id,
  });
  if (svar.kode === "betalt_men_ikke_afventende") {
    await refunderOpgradering(f, skift.id, faktura);
  }
  await rydSkiftMetadata(fakturaensAbonnement(faktura) ?? f.stripe_subscription_id, skift.id);
  return `opgradering:${svar.kode}`;
}

// Opgraderingen blev betalt, men den kan ikke gennemføres (skiftet afventer
// ikke længere, eller prisen er ikke skiftet): betalingen refunderes, og
// regningen markeres som krediteret. Prisen i Stripe sættes tilbage til
// firmaets nuværende pakke - MEN kun hvis intet andet skift venter (en ny
// opgradering/nedgradering styrer selv prisen; ellers ville vi overskrive
// den), og abonnementet ikke har en plan eller ventende ændring. Står prisen
// stadig forkert, fanges det ved næste fornyelse (tjekAbonnementsPris).
async function refunderOpgradering(f: FirmaRaekke, skiftId: string, faktura: Stripe.Invoice): Promise<void> {
  const s = stripe();
  let refusionTekst = "intet at refundere (fakturaen er betalt med 0 kr.)";
  try {
    if (faktura.amount_paid > 0) {
      refusionTekst = "INGEN betaling fundet på fakturaen - intet refunderet, tjek i Stripe";
      const betalinger = await s.invoicePayments.list({ invoice: faktura.id, limit: 10 });
      const pi = betalinger.data
        .filter((b) => b.status === "paid")
        .map((b) => id(b.payment.payment_intent))
        .find((x): x is string => !!x);
      if (pi) {
        await s.refunds.create(
          { payment_intent: pi, metadata: { firma_id: f.id, skift_id: skiftId } },
          { idempotencyKey: idempotensNoegle.opgraderingRefusion(skiftId) },
        );
        await rpc("firma_regning_krediteret", { p_firma: f.id, p_stripe_invoice_id: faktura.id });
        refusionTekst = `${faktura.amount_paid / 100} kr. er refunderet automatisk`;
      }
    }

    let prisTekst = "prisen er uændret";
    const nu = await hentFirma("id", f.id);
    const sub = nu?.stripe_subscription_id ? await s.subscriptions.retrieve(nu.stripe_subscription_id) : null;
    const item = sub?.items.data[0];
    if (nu && sub && item && prisensPakke(item.price) !== nu.pakke_id) {
      const { count } = await createAdminClient()
        .from("firma_pakkeskift")
        .select("id", { count: "exact", head: true })
        .eq("firma_id", nu.id)
        .neq("id", skiftId)
        .in("status", ["afventer_betaling", "planlagt"]);
      if (count || sub.pending_update || sub.schedule) {
        prisTekst = "prisen er IKKE sat tilbage, fordi et andet pakkeskift venter - tjek prisen, når det er afgjort";
      } else {
        await s.subscriptions.update(
          sub.id,
          { items: [{ id: item.id, price: await firmaPris(nu, nu.pakke_id), quantity: 1 }], proration_behavior: "none" },
          { idempotencyKey: idempotensNoegle.opgraderingTilbage(skiftId) },
        );
        prisTekst = "prisen er sat tilbage";
      }
    }
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/opgradering-refunderet",
      fejl: `Opgradering ${skiftId} (faktura ${faktura.id}): ${refusionTekst}; ${prisTekst}. Tjek i Stripe.`,
    });
  } catch (err) {
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/opgradering-refusion-fejl",
      fejl: `Refusion af opgradering ${skiftId} (faktura ${faktura.id}) fejlede - refundér manuelt: ${fejltekst(err)}`,
    });
  }
}

// =============================================================================
// Staff-handlinger på abonnementet (20261102010000): introrabat, gratis periode,
// særpris, kort og refusion af en regning. Chef og sælger-rollen (server
// actions i src/app/actions/adminErhvervAbonnement.ts). Stripe er sandheden:
// Stripe ændres FØRST, databasen spejler bagefter. Hver handling tager
// pakkeskift-låsen, så den aldrig kører samtidig med et pakkeskift.
// =============================================================================

const INTRO_METADATA = "intro";

export type AbonnementHandlingSvar =
  | { status: "ok"; proeveSlut?: string | null; introTil?: string | null }
  // Firmaet har intet abonnement i Stripe endnu: kun databasen (gælder, når
  // abonnementet starter).
  | { status: "ingen_stripe" }
  | { status: "afvist"; kode: "i_gang" | "opsagt" | "ikke_aktiv" | "skift_venter" | "for_lang" | "allerede"; fejl: string }
  | { status: "fejl"; fejl: string };

// Klik-id fra admin-formularen (UUID) eller en ny nøgle pr. kald (som før).
function klikNoegle(klik: string | null | undefined): string {
  return klik && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(klik) ? klik : randomUUID();
}

// Samme klik-id er brugt til et ANDET kald hos Stripe (fx dobbeltklik, efter
// at den første ændring er gennemført): Stripe afviser det - intet ændres.
const ALLEREDE_SENDT: Extract<AbonnementHandlingSvar, { status: "afvist" }> = {
  status: "afvist",
  kode: "allerede",
  fejl: "Ændringen er allerede sendt til Stripe. Opdater siden.",
};

function erIntroRabat(d: string | Stripe.Discount): d is Stripe.Discount {
  if (typeof d === "string") return false;
  const k = d.source?.coupon;
  return !!k && typeof k !== "string" && k.metadata?.bidhamr === INTRO_METADATA;
}

async function hentAbonnement(subId: string): Promise<Stripe.Subscription> {
  return stripe().subscriptions.retrieve(subId, { expand: ["discounts", "discounts.source.coupon"] });
}

// Kupon "Introrabat X %" med duration 'repeating' i K måneder (genbruges af
// alle firmaer med samme procent og varighed - en kupon er en skabelon).
async function sikrIntroKupon(procent: number, maaneder: number): Promise<string> {
  const kuponId = `bidhamr_intro_${procent}_${maaneder}`;
  const s = stripe();
  try {
    const k = await s.coupons.retrieve(kuponId);
    if (!k.valid) throw new Error(`Kuponen ${kuponId} er ikke længere gyldig i Stripe`);
    return k.id;
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError) || err.code !== "resource_missing") throw err;
  }
  await s.coupons.create(
    {
      id: kuponId,
      name: `Introrabat ${procent} %`,
      percent_off: procent,
      duration: "repeating",
      duration_in_months: maaneder,
      metadata: { bidhamr: INTRO_METADATA, procent: String(procent), maaneder: String(maaneder) },
    },
    { idempotencyKey: idempotensNoegle.kupon(kuponId) },
  );
  return kuponId;
}

function naesteFaktura(sub: Stripe.Subscription): number {
  if (sub.status === "trialing" && sub.trial_end) return sub.trial_end;
  return sub.items.data[0]?.current_period_end ?? Math.floor(Date.now() / 1000);
}

// Sæt firmaets aftalte introrabat (status 'planlagt') på abonnementet.
// Idempotent: nøglen er aftalens intro_noegle + varigheden, og databasen
// spejler kun, hvis aftalen ikke er ændret imens (firma_intro_spejl).
async function anvendIntro(f: FirmaRaekke, sub: Stripe.Subscription): Promise<string | null> {
  if (!f.intro_procent || !f.intro_maaneder || !f.intro_noegle) return null;
  // Sat på allerede i Checkout for netop denne aftale (startBetaling): kun
  // spejling - en ny kupon ville flytte rabattens slutdato.
  if (sub.metadata?.intro_noegle === f.intro_noegle) {
    const fuld = await hentAbonnement(sub.id);
    const fraCheckout = fuld.discounts.find(erIntroRabat);
    const kuponId = fraCheckout && typeof fraCheckout.source.coupon !== "string" ? fraCheckout.source.coupon?.id : null;
    if (fraCheckout && kuponId) {
      const til = tid(fraCheckout.end ?? null);
      await rpc("firma_intro_spejl", { p_firma: f.id, p_noegle: f.intro_noegle, p_status: "aktiv", p_coupon: kuponId, p_til: til });
      return til;
    }
  }
  const nuSek = Math.floor(Date.now() / 1000);
  const k = introKuponMaaneder({
    nuSek,
    naesteFakturaSek: naesteFaktura(sub),
    maaneder: f.intro_maaneder,
    fra: f.intro_fra ?? "efter_gratis",
  });
  const kupon = await sikrIntroKupon(f.intro_procent, k);
  const opdateret = await stripe().subscriptions.update(
    sub.id,
    { discounts: [{ coupon: kupon }], expand: ["discounts", "discounts.source.coupon"] },
    { idempotencyKey: idempotensNoegle.intro(f.id, sub.id, f.intro_noegle, k) },
  );
  const rabat = opdateret.discounts.find(erIntroRabat);
  const til = tid(rabat?.end ?? null);
  await rpc("firma_intro_spejl", { p_firma: f.id, p_noegle: f.intro_noegle, p_status: "aktiv", p_coupon: kupon, p_til: til });
  return til;
}

// Fjern introrabatten fra abonnementet (kun vores egen kupon fjernes).
async function fjernIntroFraAbonnement(firmaId: string, sub: Stripe.Subscription, klik: string): Promise<void> {
  const andre = sub.discounts.filter((d) => !erIntroRabat(d));
  if (andre.length === sub.discounts.length) return;
  await stripe().subscriptions.update(
    sub.id,
    { discounts: andre.length ? andre.map((d) => ({ discount: typeof d === "string" ? d : d.id })) : "" },
    { idempotencyKey: idempotensNoegle.introFjern(firmaId, klik) },
  );
}

async function medLaas(
  firmaId: string,
  fn: () => Promise<AbonnementHandlingSvar>,
): Promise<AbonnementHandlingSvar> {
  const laas = await tagPakkeskiftLaas(firmaId);
  if (!laas) return { status: "afvist", kode: "i_gang", fejl: PAKKESKIFT_I_GANG };
  try {
    return await fn();
  } finally {
    await frigivPakkeskiftLaas(firmaId, laas);
  }
}

// Kan abonnementet ændres af staff lige nu? (Ikke opsagt, ingen planlagt
// nedgradering eller ventende opgradering - de skal afgøres først.)
function tjekAendring(sub: Stripe.Subscription): Extract<AbonnementHandlingSvar, { status: "afvist" }> | null {
  if (sub.status !== "trialing" && sub.status !== "active") {
    return { status: "afvist", kode: "ikke_aktiv", fejl: `Abonnementet er ${sub.status} i Stripe. Løs betalingen først.` };
  }
  if (sub.cancel_at_period_end || sub.cancel_at) {
    return { status: "afvist", kode: "opsagt", fejl: "Abonnementet er opsagt. Fortryd opsigelsen først." };
  }
  if (sub.schedule || sub.pending_update) {
    return {
      status: "afvist",
      kode: "skift_venter",
      fejl: "Firmaet har et pakkeskift, der venter. Skift pakken med det samme i admin (eller vent), og prøv igen.",
    };
  }
  return null;
}

// Introrabat sat/ændret i databasen (erhverv_firma_intro_gem -> 'planlagt'):
// sæt den på abonnementet nu, hvis det findes.
export async function introTilStripe(firmaId: string): Promise<AbonnementHandlingSvar> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "ingen_stripe" };
    const subId = f.stripe_subscription_id;
    return await medLaas(firmaId, async () => {
      const sub = await hentAbonnement(subId);
      if (erAfsluttet(sub)) return { status: "ingen_stripe" };
      const afvist = tjekAendring(sub);
      if (afvist) return afvist;
      return { status: "ok", introTil: await anvendIntro(f, sub) };
    });
  } catch (err) {
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Fjern introrabatten: Stripe først, så databasen. klik: admin-formularens
// klik-id (idempotency key).
export async function fjernIntroStripe(firmaId: string, klik?: string | null): Promise<AbonnementHandlingSvar> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "ingen_stripe" };
    const subId = f.stripe_subscription_id;
    return await medLaas(firmaId, async () => {
      const sub = await hentAbonnement(subId);
      if (erAfsluttet(sub)) return { status: "ingen_stripe" };
      await fjernIntroFraAbonnement(firmaId, sub, klikNoegle(klik));
      return { status: "ok" };
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeIdempotencyError) return ALLEREDE_SENDT;
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Gratis periode +N måneder: trial_end forlænges (i den gratis periode) eller
// sættes til slutningen af den betalte periode + N måneder (proration 'none' -
// firmaet beholder det betalte og får N måneder gratis oven i). En kørende
// introrabat flyttes, så firmaet stadig får de resterende rabatmåneder på
// betalte fakturaer. klik: admin-formularens klik-id - idempotency key, så et
// dobbeltklik aldrig giver to gratis perioder (det andet kald har en ny
// trial_end med samme nøgle, og Stripe afviser det: 'allerede').
export async function givGratisPeriodeStripe(
  firmaId: string,
  maaneder: number,
  klikId?: string | null,
): Promise<AbonnementHandlingSvar> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "ingen_stripe" };
    const subId = f.stripe_subscription_id;
    return await medLaas(firmaId, async () => {
      const s = stripe();
      const sub = await hentAbonnement(subId);
      if (erAfsluttet(sub)) return { status: "ingen_stripe" };
      const afvist = tjekAendring(sub);
      if (afvist) return afvist;
      const nuSek = Math.floor(Date.now() / 1000);
      const item = sub.items.data[0];
      if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
      const nyTrial = nyGratisSlut({
        status: sub.status,
        trialEndSek: sub.trial_end,
        periodeSlutSek: item.current_period_end,
        nuSek,
        maaneder,
      });
      if (nyTrial - nuSek > (TRIAL_MAKS_DAGE - 1) * 86400) {
        return { status: "afvist", kode: "for_lang", fejl: "Den gratis periode kan højst vare 2 år i alt (Stripes grænse)." };
      }
      // Resterende introrabat (på betalte fakturaer) FØR ændringen.
      const intro = sub.discounts.find(erIntroRabat);
      const rest = intro ? introResterende({ naesteFakturaSek: naesteFaktura(sub), rabatSlutSek: intro.end }) : 0;
      const kuponObj = intro && typeof intro.source.coupon !== "string" ? intro.source.coupon : null;
      const procent = kuponObj?.percent_off ?? null;

      const klik = klikNoegle(klikId);
      const opdateret = await s.subscriptions.update(
        sub.id,
        { trial_end: nyTrial, proration_behavior: "none" },
        { idempotencyKey: idempotensNoegle.gratisPeriode(firmaId, klik) },
      );
      let introTil: string | null = null;
      if (intro && rest > 0 && procent) {
        const k = introKuponMaaneder({ nuSek, naesteFakturaSek: naesteFaktura(opdateret), maaneder: rest, fra: "efter_gratis" });
        const kupon = await sikrIntroKupon(Math.round(procent), k);
        const flyttet = await s.subscriptions.update(
          sub.id,
          { discounts: [{ coupon: kupon }], expand: ["discounts", "discounts.source.coupon"] },
          { idempotencyKey: idempotensNoegle.introFlyt(firmaId, sub.id, klik) },
        );
        introTil = tid(flyttet.discounts.find(erIntroRabat)?.end ?? null);
        const frisk = await hentFirma("id", firmaId);
        if (frisk?.intro_noegle) {
          await rpc("firma_intro_spejl", { p_firma: f.id, p_noegle: frisk.intro_noegle, p_status: "aktiv", p_coupon: kupon, p_til: introTil });
        }
      }
      await synkAbonnement(await s.subscriptions.retrieve(sub.id));
      return { status: "ok", proeveSlut: tid(opdateret.trial_end), introTil };
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeIdempotencyError) return ALLEREDE_SENDT;
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Særpris (oere) eller pakkens pris igen (null) på abonnementet. fra
// 'naeste_betaling': proration 'none' (gælder fra næste betaling); 'straks':
// proration 'create_prorations' (forskellen for resten af perioden afregnes på
// næste regning - ingen ekstra betaling nu). I den gratis periode er der intet
// at afregne. Svarer med den gamle pris, så kalderen kan sætte den tilbage.
export type SaerprisSvar =
  | { status: "ok"; subId: string; itemId: string; gammelPris: string; nyPris: string; laas: string }
  | Exclude<AbonnementHandlingSvar, { status: "ok" }>;

// Låsen holdes, til databasen er opdateret (kalderen frigiver den med
// frigivPakkeskiftLaas - også når prisen sættes tilbage). klik:
// admin-formularens klik-id (idempotency key). Bagefter hentes abonnementet
// igen: Stripe svarer på en genbrugt nøgle med det GEMTE svar uden at gøre
// noget (fx hvis prisen er sat tilbage efter en databasefejl, og samme
// formular sendes igen) - så tjekkes det, at prisen faktisk ER skiftet.
export async function saetSaerprisStripe(
  firmaId: string,
  pakkeId: string,
  oere: number | null,
  fra: "naeste_betaling" | "straks",
  klik?: string | null,
): Promise<SaerprisSvar> {
  let laas: string | null = null;
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "ingen_stripe" };
    laas = await tagPakkeskiftLaas(firmaId);
    if (!laas) return { status: "afvist", kode: "i_gang", fejl: PAKKESKIFT_I_GANG };
    const s = stripe();
    const sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    if (erAfsluttet(sub)) {
      await frigivPakkeskiftLaas(firmaId, laas);
      return { status: "ingen_stripe" };
    }
    const afvist = tjekAendring(sub);
    if (afvist) {
      await frigivPakkeskiftLaas(firmaId, laas);
      return afvist;
    }
    const item = sub.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
    const nyPris = oere ? await sikrFirmaPris(firmaId, pakkeId, oere) : await sikrPris(pakkeId);
    if (item.price.id !== nyPris) {
      await s.subscriptions.update(
        sub.id,
        {
          items: [{ id: item.id, price: nyPris, quantity: 1 }],
          proration_behavior: fra === "straks" && sub.status === "active" ? "create_prorations" : "none",
        },
        { idempotencyKey: idempotensNoegle.saerpris(firmaId, klikNoegle(klik)) },
      );
      const tjek = await s.subscriptions.retrieve(sub.id);
      if (tjek.items.data[0]?.price.id !== nyPris) {
        throw new Error(`Prisen på ${sub.id} er ikke skiftet i Stripe (genbrugt klik-id?) - åbn formularen igen`);
      }
    }
    return { status: "ok", subId: sub.id, itemId: item.id, gammelPris: item.price.id, nyPris, laas };
  } catch (err) {
    if (laas) await frigivPakkeskiftLaas(firmaId, laas);
    if (err instanceof Stripe.errors.StripeIdempotencyError) return ALLEREDE_SENDT;
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Databasen kunne ikke gemme særprisen: prisen i Stripe sættes tilbage.
// Kaster ikke.
export async function saetSaerprisTilbage(svar: Extract<SaerprisSvar, { status: "ok" }>, firmaId: string): Promise<void> {
  if (svar.gammelPris === svar.nyPris) return;
  try {
    await stripe().subscriptions.update(
      svar.subId,
      { items: [{ id: svar.itemId, price: svar.gammelPris, quantity: 1 }], proration_behavior: "none" },
      { idempotencyKey: idempotensNoegle.prisRettelse(svar.subId, randomUUID()) },
    );
  } catch (err) {
    await logDriftFejl({
      kilde: "action",
      hvor: "erhverv/saerpris-tilbage",
      fejl: `Firma ${firmaId}: særprisen blev ikke gemt i databasen, og prisen på ${svar.subId} kunne ikke sættes tilbage til ${svar.gammelPris} - ret i Stripe: ${fejltekst(err)}`,
    });
  }
}

// Kortet på abonnementet (eller kundens standardkort) spejles: mærke, sidste
// 4 cifre og udløb - aldrig mere. Kaster ved fejl (kalderen logger).
async function synkKort(firmaId: string, sub: Stripe.Subscription): Promise<void> {
  const s = stripe();
  let pmId = id(sub.default_payment_method);
  if (!pmId) {
    const kundeId = id(sub.customer);
    if (!kundeId) return;
    const kunde = await s.customers.retrieve(kundeId);
    if (!("deleted" in kunde && kunde.deleted)) {
      pmId = id((kunde as Stripe.Customer).invoice_settings?.default_payment_method ?? null);
    }
  }
  if (!pmId) return;
  const pm = await s.paymentMethods.retrieve(pmId);
  if (!pm.card) return;
  await rpc("firma_kort_spejl", {
    p_firma: firmaId,
    p_maerke: pm.card.brand,
    p_sidste4: pm.card.last4,
    p_udloeb_maaned: pm.card.exp_month,
    p_udloeb_aar: pm.card.exp_year,
  });
}

// customer.updated / payment_method.attached / payment_method.automatically_updated:
// kortet er måske skiftet (fx i kundeportalen). Kaster ikke.
export async function synkKortForKunde(kunde: string | null): Promise<string> {
  try {
    if (!kunde) return "ingen_kunde";
    const f = await firmaForKunde(kunde);
    if (!f) return "ikke_erhverv";
    if (!f.stripe_subscription_id) return "intet_abonnement";
    await synkKort(f.id, await stripe().subscriptions.retrieve(f.stripe_subscription_id));
    return "kort_spejlet";
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", hvor: "erhverv/kort", fejl: err });
    return "fejl";
  }
}

// Hel refusion af en betalt regning (abonnement eller opgradering) med en
// kreditnota i Stripe (alle linjer, refund_amount = det betalte). Idempotent
// pr. regning. Regningen markeres 'krediteret' (bogføringen følger med via
// firma_regninger_krediteret_kl). Abonnementet fortsætter uændret.
export type RefusionSvar =
  | { status: "ok"; beloebOere: number; firmaId: string }
  | { status: "afvist"; fejl: string }
  | { status: "fejl"; fejl: string };

export async function refunderRegningStripe(regningId: string): Promise<RefusionSvar> {
  try {
    const { data: r, error } = await createAdminClient()
      .from("firma_regninger")
      .select("id, firma_id, status, type, stripe_invoice_id, beloeb_oere")
      .eq("id", regningId)
      .maybeSingle<{ id: string; firma_id: string; status: string; type: string; stripe_invoice_id: string | null; beloeb_oere: number }>();
    if (error) throw new Error(`firma_regninger: ${error.message}`);
    if (!r) return { status: "afvist", fejl: "Regningen findes ikke." };
    if (r.status === "krediteret") return { status: "afvist", fejl: "Regningen er allerede refunderet." };
    if (r.status !== "betalt") return { status: "afvist", fejl: "Kun en betalt regning kan refunderes." };
    if (!r.stripe_invoice_id) return { status: "afvist", fejl: "Regningen er ikke betalt i Stripe og kan ikke refunderes her." };
    if (!stripeTilgaengelig()) return { status: "afvist", fejl: "Stripe er ikke sat op." };
    const s = stripe();
    const faktura = await s.invoices.retrieve(r.stripe_invoice_id);
    if (faktura.status !== "paid") return { status: "afvist", fejl: "Fakturaen er ikke betalt i Stripe." };
    if (faktura.amount_paid <= 0) return { status: "afvist", fejl: "Der er intet at refundere (0 kr.)." };
    // Er kreditnotaen allerede lavet af os for netop denne regning (fx
    // databasen fejlede lige efter Stripe-kaldet), spejles den bare - ellers
    // ville regningen sidde fast som 'betalt' med en kreditnota i Stripe.
    for await (const cn of s.creditNotes.list({ invoice: faktura.id!, limit: 100 })) {
      if (cn.status !== "void" && cn.metadata?.regning_id === r.id) {
        await rpc("firma_regning_krediteret", { p_firma: r.firma_id, p_stripe_invoice_id: faktura.id });
        return { status: "ok", beloebOere: cn.total, firmaId: r.firma_id };
      }
    }
    if ((faktura.post_payment_credit_notes_amount ?? 0) > 0) {
      return { status: "afvist", fejl: "Der er allerede lavet en kreditnota på fakturaen i Stripe - tjek den i Stripe." };
    }
    const linjer: Stripe.InvoiceLineItem[] = [];
    for await (const l of s.invoices.listLineItems(faktura.id!, { limit: 100 })) linjer.push(l);
    const kreditLinjer = linjer.map((l) => ({
      type: "invoice_line_item" as const,
      invoice_line_item: l.id,
      quantity: l.quantity ?? 1,
    }));
    // Kreditnotaens beløb (alle linjer, efter rabat og med moms) regnes af
    // Stripe først: refund_amount skal være præcis kreditnotaens beløb efter
    // betaling (post_payment_amount). Passer det ikke med det betalte (fx en
    // del er betalt med kundesaldo), refunderes intet automatisk.
    const preview = await s.creditNotes.preview({ invoice: faktura.id!, lines: kreditLinjer });
    const refusion = preview.post_payment_amount;
    if (refusion !== faktura.amount_paid) {
      await logDriftFejl({
        kilde: "action",
        hvor: "erhverv/regning-refusion",
        fejl: `Regning ${r.id} (faktura ${faktura.id}): kreditnotaen ville være ${refusion} øre, men der er betalt ${faktura.amount_paid} øre - refundér manuelt i Stripe.`,
      });
      return { status: "afvist", fejl: "Beløbet passer ikke med det betalte. Refundér regningen direkte i Stripe." };
    }
    await s.creditNotes.create(
      {
        invoice: faktura.id!,
        lines: kreditLinjer,
        refund_amount: refusion,
        reason: "order_change",
        memo: "Refunderet af BidHamr",
        metadata: { firma_id: r.firma_id, regning_id: r.id },
      },
      { idempotencyKey: idempotensNoegle.regningRefusion(r.id) },
    );
    await rpc("firma_regning_krediteret", { p_firma: r.firma_id, p_stripe_invoice_id: faktura.id });
    return { status: "ok", beloebOere: refusion, firmaId: r.firma_id };
  } catch (err) {
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Cron'en forsøger nu (firmaer.stripe_synk_forsoegt_kl, 20261102020000): kun
// til rækkefølgen, så de samme firmaer ikke blokerer resten. Kaster ikke.
async function markerSynkForsoeg(firmaId: string): Promise<void> {
  const { error } = await createAdminClient().rpc("firma_synk_forsoegt", { p_firma: firmaId });
  if (error && error.code !== "PGRST202") {
    await logDriftFejl({ kilde: "cron", hvor: "erhverv/synk-forsoeg", fejl: `Firma ${firmaId}: ${error.message}` });
  }
}

// Prisen for et firma, der er flyttet til de nye pakker (stripe_pris_synk),
// skiftes i Stripe fra næste betaling. Migrationen 20261102010000 annullerede
// firmaets ventende pakkeskift i DATABASEN; her ryddes de samme i STRIPE:
// en planlagt nedgradering (Subscription Schedule) frigives, og åbne
// opgraderingsfakturaer annulleres (void - Stripe dropper så den ventende
// ændring). Kun når databasen ikke har et NYT ventende skift (firmaet kan have
// valgt en ny pakke efter flytningen - det skift styrer selv prisen, så der
// ventes, til det er afgjort). Svarer true, når prissynket er færdigt.
async function synkPrisEfterFlytning(f: FirmaRaekke): Promise<boolean> {
  const s = stripe();
  let sub = await s.subscriptions.retrieve(f.stripe_subscription_id!);
  if (erAfsluttet(sub)) return true;
  const { count, error } = await createAdminClient()
    .from("firma_pakkeskift")
    .select("id", { count: "exact", head: true })
    .eq("firma_id", f.id)
    .in("status", ["afventer_betaling", "planlagt"]);
  if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
  if (count) return false;

  const ryddet: string[] = [];
  if (await frigivPlan(sub)) ryddet.push("planlagt nedgradering frigivet");
  for await (const faktura of s.invoices.list({ subscription: sub.id, status: "open", limit: 20 })) {
    if (!faktura.id || fakturaType(faktura) !== "opgradering") continue;
    const annulleret = await s.invoices.voidInvoice(faktura.id, {}, { idempotencyKey: idempotensNoegle.prisSynkVoid(faktura.id) });
    await synkFaktura(annulleret, null);
    ryddet.push(`opgraderingsfaktura ${faktura.id} annulleret`);
  }
  if (ryddet.length || sub.pending_update || sub.schedule) sub = await s.subscriptions.retrieve(sub.id);
  if (sub.pending_update || sub.schedule) {
    throw new Error(`Abonnement ${sub.id} har stadig en ventende ændring eller plan efter oprydningen`);
  }
  const item = sub.items.data[0];
  if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
  const pris = await firmaPris(f, f.pakke_id);
  if (item.price.id !== pris) {
    await s.subscriptions.update(
      sub.id,
      { items: [{ id: item.id, price: pris, quantity: 1 }], proration_behavior: "none" },
      { idempotencyKey: idempotensNoegle.prisSynk(f.id, pris) },
    );
  }
  if (ryddet.length) {
    await logDriftFejl({
      kilde: "cron",
      hvor: "erhverv/pris-synk-oprydning",
      fejl: `Firma ${f.id} (${sub.id}) er flyttet til de nye pakker: ${ryddet.join(", ")} i Stripe (skiftet var annulleret i databasen). Prisen er nu ${pris} fra næste betaling.`,
    });
  }
  return true;
}

// Firmaets navn, CVR, adresse, telefon og e-mail til Stripe-kunden (fakturaen
// viser dem). Triggeren firmaer_stripe_kunde_aendret tæller
// stripe_kunde_version op ved hver ændring (20261102020000); her opdateres
// kunden, momsnummeret (tax id eu_vat "DK" + CVR) byttes ud, hvis CVR er
// ændret, og versionen kvitteres. En fejl ændrer intet i databasen - næste
// kørsel prøver igen. Svarer med udfaldet.
export async function synkKundeStripe(firmaId: string, version: number): Promise<"ok" | "ingen_kunde" | "fejl"> {
  try {
    if (!stripeTilgaengelig()) return "ingen_kunde";
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_customer_id) return "ingen_kunde";
    const s = stripe();
    const kunde = f.stripe_customer_id;
    await s.customers.update(
      kunde,
      {
        name: f.firmanavn,
        email: f.kontakt_email,
        phone: f.telefon,
        address: { line1: f.adresse, postal_code: f.postnummer, city: f.bynavn, country: "DK" },
        metadata: { firma_id: f.id, cvr: f.cvr },
      },
      { idempotencyKey: idempotensNoegle.kundeSynk(f.id, version) },
    );
    const oensket = `DK${f.cvr}`;
    let findes = false;
    for await (const t of s.customers.listTaxIds(kunde, { limit: 100 })) {
      if (t.type !== "eu_vat") continue;
      if (t.value === oensket) {
        findes = true;
        continue;
      }
      // Gammelt CVR: slettes (DELETE er idempotent hos Stripe - en allerede
      // slettet giver resource_missing, som ignoreres).
      try {
        await s.customers.deleteTaxId(kunde, t.id);
      } catch (err) {
        if (!(err instanceof Stripe.errors.StripeInvalidRequestError) || err.code !== "resource_missing") throw err;
      }
    }
    if (!findes) {
      await s.customers.createTaxId(
        kunde,
        { type: "eu_vat", value: oensket },
        { idempotencyKey: idempotensNoegle.kundeMoms(f.id, version, f.cvr) },
      );
    }
    await rpc("firma_kunde_synk_udfoert", { p_firma: f.id, p_version: version });
    return "ok";
  } catch (err) {
    await logDriftFejl({
      kilde: "cron",
      hvor: "erhverv/kunde-synk",
      fejl: `Firma ${firmaId}: firmaoplysningerne kunne ikke opdateres i Stripe (prøves igen): ${fejltekst(err)}`,
    });
    return "fejl";
  }
}

// Betalings-cron'en: (1) priserne for firmaer, der er flyttet til de nye
// pakker (stripe_pris_synk), skiftes i Stripe fra næste betaling - efter at
// gamle planer og opgraderingsfakturaer er ryddet i Stripe; (2) en aftalt
// introrabat, der ikke er kommet på abonnementet (fx Stripe fejlede), sættes
// på; (3) ændrede firmaoplysninger sendes til Stripe-kunden. Hver liste tages
// i rækkefølge efter seneste forsøg (aldrig forsøgt først), så de samme 20
// aldrig blokerer resten. Kaster ikke pr. firma.
export async function koerAbonnementSynk(): Promise<{ priser: number; intro: number; kunder: number; fejl: number }> {
  const ud = { priser: 0, intro: 0, kunder: 0, fejl: 0 };
  if (!stripeTilgaengelig()) return ud;
  const admin = createAdminClient();
  const { data: synk, error } = await admin.rpc("firma_pris_synk_kandidater", { p_graense: 20 });
  if (error) {
    // PGRST202: migrationen 20261102010000 er ikke kørt endnu.
    if (error.code !== "PGRST202") throw new Error(`firma_pris_synk_kandidater: ${error.message}`);
  }
  for (const k of (synk ?? []) as { firma_id: string; subscription_id: string }[]) {
    try {
      await markerSynkForsoeg(k.firma_id);
      const f = await hentFirma("id", k.firma_id);
      if (!f?.stripe_subscription_id) continue;
      const laas = await tagPakkeskiftLaas(f.id);
      if (!laas) continue;
      try {
        if (await synkPrisEfterFlytning(f)) {
          await rpc("firma_pris_synk_udfoert", { p_firma: f.id });
          ud.priser++;
        }
      } finally {
        await frigivPakkeskiftLaas(f.id, laas);
      }
    } catch (err) {
      ud.fejl++;
      await logDriftFejl({ kilde: "cron", hvor: "erhverv/pris-synk", fejl: `Firma ${k.firma_id}: ${fejltekst(err)}` });
    }
  }

  // Introrabatter, der venter (ældste forsøg først; uden migrationen
  // 20261102020000 - 42703 - efter opdateret_kl).
  const introListe = (medForsoeg: boolean) => {
    let q = admin.from("firmaer").select("id").eq("intro_status", "planlagt").not("stripe_subscription_id", "is", null);
    if (medForsoeg) q = q.order("stripe_synk_forsoegt_kl", { ascending: true, nullsFirst: true });
    return q.order("opdateret_kl", { ascending: true }).limit(20);
  };
  let { data: intro, error: iFejl } = await introListe(true);
  if (iFejl?.code === "42703") ({ data: intro, error: iFejl } = await introListe(false));
  if (iFejl) throw new Error(`firmaer (intro): ${iFejl.message}`);
  for (const r of (intro ?? []) as { id: string }[]) {
    await markerSynkForsoeg(r.id);
    const svar = await introTilStripe(r.id);
    if (svar.status === "ok") ud.intro++;
    else if (svar.status === "fejl") {
      ud.fejl++;
      await logDriftFejl({ kilde: "cron", hvor: "erhverv/intro", fejl: `Firma ${r.id}: ${svar.fejl}` });
    }
  }

  // Firmaoplysninger til Stripe-kunden.
  const { data: kunder, error: kFejl } = await admin.rpc("firma_kunde_synk_kandidater", { p_graense: 20 });
  if (kFejl) {
    // PGRST202: migrationen 20261102020000 er ikke kørt endnu.
    if (kFejl.code !== "PGRST202") throw new Error(`firma_kunde_synk_kandidater: ${kFejl.message}`);
  }
  for (const k of (kunder ?? []) as { firma_id: string; version: number }[]) {
    await markerSynkForsoeg(k.firma_id);
    const r = await synkKundeStripe(k.firma_id, k.version);
    if (r === "ok") ud.kunder++;
    else if (r === "fejl") ud.fejl++;
  }
  return ud;
}
