import "server-only";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

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
//   4. Opsigelse (kun chef i admin): opsigAbonnement -> cancel_at_period_end.
//      customer.subscription.deleted -> 'opsagt'.
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
  nedgradering: (skiftId: string) => `nedgradering:${skiftId}`,
  nedgraderingPlan: (skiftId: string) => `nedgradering-plan:${skiftId}`,
  opsigelse: (firmaId: string, klik: string) => `opsigelse:${firmaId}:${klik}`,
  fortrydOpsigelse: (firmaId: string, klik: string) => `fortryd-opsigelse:${firmaId}:${klik}`,
  adminPakke: (firmaId: string, klik: string) => `admin-pakke:${firmaId}:${klik}`,
  prisRettelse: (subId: string, klik: string) => `pris-rettelse:${subId}:${klik}`,
  dobbeltAbonnement: (subId: string) => `dobbelt-abonnement:${subId}`,
  pris: (lookupKey: string) => `pris:${lookupKey}`,
  produkt: (produktId: string) => `produkt:${produktId}`,
  moms: () => "moms:dk25:v1",
  portal: () => "portal:erhverv:v1",
} as const;

export type BetalingsStatus =
  | { status: "afventer_betaling"; besked: string }
  | { status: "betalt" }
  | { status: "kraever_handling"; url: string }
  // rulletTilbage: databasen er sat tilbage til før skiftet (Stripe fejlede,
  // før abonnementet blev ændret). betalFoerst: abonnementet er ikke aktivt.
  | { status: "fejl"; fejl: string; rulletTilbage?: boolean; betalFoerst?: boolean };

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
};

const FIRMA_FELTER =
  "id, bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon, kontakt_email, pakke_id, abonnement_status, pauset_aarsag, naeste_pakke_id, stripe_customer_id, stripe_subscription_id, stripe_abonnement_status, opsiges_fra";

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

  const s = stripe();
  const lookupKey = `erhverv_pakke_${p.id}_${oere}`;
  let prisId: string | null = null;
  const fundet = await s.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (fundet.data[0]) {
    prisId = fundet.data[0].id;
  } else {
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
        nickname: `${p.navn} – ${oere / 100} kr./md. ekskl. moms`,
        metadata: { pakke_id: p.id },
      },
      { idempotencyKey: idempotensNoegle.pris(lookupKey) },
    );
    prisId = pris.id;
  }
  const { error: gemFejl } = await admin
    .from("erhverv_pakker")
    .update({ stripe_price_id: prisId, stripe_price_oere: oere })
    .eq("id", p.id);
  if (gemFejl) throw new Error(`erhverv_pakker.stripe_price_id: ${gemFejl.message}`);
  return prisId;
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

// "Betal for din pakke": Stripe Checkout for firmaets pakke. base = sidens
// egen adresse (fra den kontrollerede Origin).
export async function startBetaling(brugerId: string, base: string): Promise<LinkSvar> {
  const f = await hentFirma("bruger_id", brugerId);
  if (!f) return { fejl: "Kun firmakonti har et abonnement.", kode: "ikke_firma" };
  if (!kanStarteAbonnement(f)) {
    return { fejl: "Din pakke er allerede betalt. Opdater siden.", kode: "allerede_betalt" };
  }
  let prisId: string;
  try {
    prisId = await sikrPris(f.pakke_id);
  } catch (err) {
    if (err instanceof PrisIkkeSat) {
      return { fejl: "Din pakke har ingen pris endnu. Skriv til erhverv@bidhamr.dk.", kode: "pris_ikke_sat" };
    }
    throw err;
  }
  const s = stripe();
  const kunde = await sikrKunde(f);
  const moms = await sikrMomssats();

  // Genbrug en åben betaling for samme pris (fx når firmaet trykker igen);
  // andre åbne betalinger lukkes, så der ikke kan betales for to abonnementer.
  for await (const sess of s.checkout.sessions.list({ customer: kunde, status: "open", limit: 20 })) {
    if (sess.metadata?.firma_id === f.id && sess.metadata?.pris_id === prisId && sess.url) {
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
      locale: "da",
      subscription_data: {
        default_tax_rates: [moms],
        metadata: { firma_id: f.id, pakke_id: f.pakke_id },
      },
      metadata: { firma_id: f.id, pakke_id: f.pakke_id, pris_id: prisId },
      success_url: `${base}/firma/abonnement?betaling=ok&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/firma/abonnement?betaling=afbrudt`,
    },
    { idempotencyKey: idempotensNoegle.checkout(f.id, prisId, Math.floor(Date.now() / 60_000)) },
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
): Promise<boolean> {
  try {
    const svar = await rpc("firma_pakkeskift_rul_tilbage", {
      p_firma: firmaId,
      p_skift: skiftId,
      p_tilbagerul: tilbagerul,
      p_gendan_planlagt: gendanPlanlagt,
      p_gendan_afventende: gendanAfventende,
      p_note: `Rullet tilbage: ${aarsag}`.slice(0, 1000),
    });
    if (svar.kode !== "ok") {
      await logDriftFejl({
        kilde: "server",
        hvor: "erhverv/rul-tilbage",
        fejl: `Pakkeskift ${skiftId ?? "-"} for firma ${firmaId} kunne ikke rulles tilbage (${String(svar.kode)}) efter Stripe-fejl: ${aarsag}`,
      });
      return false;
    }
    return true;
  } catch (err) {
    await logDriftFejl({
      kilde: "server",
      hvor: "erhverv/rul-tilbage",
      fejl: `Pakkeskift ${skiftId ?? "-"} for firma ${firmaId}: tilbagerulning fejlede (${fejltekst(err)}) efter Stripe-fejl: ${aarsag}`,
    });
    return false;
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
export async function startOpgradering(skiftId: string, tilbagerul: Tilbagerul | null): Promise<BetalingsStatus> {
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
    if (sub.status !== "active") {
      if (tilbagerul) await rulTilbage(f.id, skift.id, tilbagerul, true, true, `abonnementet er ${sub.status}`);
      return { status: "fejl", fejl: `Abonnementet er ${sub.status}`, rulletTilbage: !!tilbagerul, betalFoerst: true };
    }
    const prisId = await sikrPris(skift.til_pakke_id);

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
      const ok = await rulTilbage(firmaId, skiftId, tilbagerul, !planFrigivet, annulleret === 0, `opgradering: ${fejltekst(err)}`);
      await rydSkiftMetadata(subIdForRyd, skiftId);
      return { status: "fejl", fejl: fejltekst(err), rulletTilbage: ok };
    }
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Firmaet har valgt en mindre pakke (firma_skift_pakke_server svarede
// 'nedgradering_planlagt'). Prisen skifter i Stripe ved periodens slut.
// Fejler Stripe, rulles databasen tilbage.
export async function startNedgradering(skiftId: string, tilbagerul: Tilbagerul | null): Promise<BetalingsStatus> {
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
    const prisId = await sikrPris(skift.til_pakke_id);
    const moms = await sikrMomssats();
    annulleret = await annullerGamleOpgraderinger(f.id);
    if (annulleret > 0 || sub.pending_update) sub = await s.subscriptions.retrieve(sub.id);
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

    await s.subscriptionSchedules.update(
      planId,
      {
        end_behavior: "release",
        phases: [
          {
            items: [{ price: item.price.id, quantity: 1 }],
            default_tax_rates: [moms],
            start_date: start,
            end_date: periodeSlut,
            proration_behavior: "none",
          },
          {
            items: [{ price: prisId, quantity: 1 }],
            default_tax_rates: [moms],
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
      const ok = await rulTilbage(firmaId, skiftId, tilbagerul, true, annulleret === 0, `nedgradering: ${fejltekst(err)}`);
      return { status: "fejl", fejl: fejltekst(err), rulletTilbage: ok };
    }
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// Firmaet beholder sin pakke ("uaendret"): en planlagt nedgradering i Stripe
// fjernes, og gamle opgraderingsfakturaer annulleres. Fejler Stripe, rulles
// databasen tilbage (den planlagte nedgradering gælder stadig).
export async function annullerPlanlagtSkift(brugerId: string, tilbagerul: Tilbagerul | null): Promise<BetalingsStatus> {
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
      const ok = await rulTilbage(firmaId, null, tilbagerul, true, annulleret === 0, `behold pakken: ${fejltekst(err)}`);
      return { status: "fejl", fejl: fejltekst(err), rulletTilbage: ok };
    }
    return { status: "fejl", fejl: fejltekst(err) };
  }
}

// --- Admin -------------------------------------------------------------------

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
  const s = stripe();
  let sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
  if (sub.status === "canceled" || sub.status === "incomplete_expired") return { status: "ingen_stripe" };
  const prisId = await sikrPris(pakkeId);

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
    };
  } catch (err) {
    await efterAdminFejl(firmaId, sub.id, planFrigivet, annulleredeFakturaer, `Stripe-fejl: ${fejltekst(err)}`);
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
  | { status: "fejl"; fejl: string };

// Opsigelse (kun chef): abonnementet stopper ved periodens slut. Ingen refusion.
// Ny idempotency-nøgle pr. klik, og abonnementet hentes frisk bagefter, så
// opsig -> fortryd -> opsig igen altid virker i Stripe.
export async function opsigAbonnement(firmaId: string): Promise<OpsigSvar> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id) return { status: "ingen_stripe" };
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
  });

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
      const { data: pakke } = await createAdminClient()
        .from("erhverv_pakker")
        .select("maanedspris")
        .eq("id", nu.pakke_id)
        .maybeSingle<{ maanedspris: number | string | null }>();
      const dbOere = pakke?.maanedspris == null ? null : Math.round(Number(pakke.maanedspris) * 100);
      const item = sub.items.data[0];
      if (sub.schedule || sub.pending_update || count || !item) {
        hvorfor = "abonnementet har en plan/ventende ændring - kun alarm";
      } else if (dbOere == null || pris.unit_amount == null || dbOere > pris.unit_amount) {
        hvorfor = "databasens pakke er dyrere end prisen i Stripe - kun alarm (firmaet skal ikke trækkes for mere automatisk)";
      } else {
        const ny = await sikrPris(nu.pakke_id);
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
          { items: [{ id: item.id, price: await sikrPris(nu.pakke_id), quantity: 1 }], proration_behavior: "none" },
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
