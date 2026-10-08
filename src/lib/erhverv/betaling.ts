import "server-only";
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
//      invoice.paid (billing_reason subscription_update) ->
//      firma_pakkeskift_betalt -> flere auktioner pr. uge.
//   3. Nedgradering: startNedgradering -> Subscription Schedule, så prisen
//      skifter ved periodens slut (ingen proration, intet refunderes).
//   4. Opsigelse (kun chef i admin): opsigAbonnement -> cancel_at_period_end.
//      customer.subscription.deleted -> 'opsagt'.
//   5. Mislykket betaling: invoice.payment_failed -> firma_abonnement_mislykket.
//      Cron firma_abonnement_frist_koer pauser efter 7 dage; Stripes Smart
//      Retries prøver igen, og en senere betaling genaktiverer.
//
// Databasekrogene (kun service role) er idempotente på fakturaens id, så
// webhook, genlevering og retursiden kan kalde dem i vilkårlig rækkefølge.

// Idempotency-nøgler til ALLE kald, der opretter/ændrer noget hos Stripe.
// Samme handling = samme nøgle; ny handling = ny nøgle. Stripe husker dem i
// mindst 24 timer.
export const idempotensNoegle = {
  kunde: (firmaId: string) => `kunde:${firmaId}`,
  abonnement: (firmaId: string, periode: string) => `abonnement:${firmaId}:${periode}`,
  checkout: (firmaId: string, prisId: string, minut: number) => `checkout:${firmaId}:${prisId}:${minut}`,
  opgradering: (skiftId: string) => `opgradering:${skiftId}`,
  opgraderingRefusion: (skiftId: string) => `opgradering-refusion:${skiftId}`,
  opgraderingTilbage: (skiftId: string) => `opgradering-tilbage:${skiftId}`,
  nedgradering: (skiftId: string) => `nedgradering:${skiftId}`,
  nedgraderingPlan: (skiftId: string) => `nedgradering-plan:${skiftId}`,
  opsigelse: (firmaId: string, periode: string) => `opsigelse:${firmaId}:${periode}`,
  fortrydOpsigelse: (firmaId: string, minut: number) => `fortryd-opsigelse:${firmaId}:${minut}`,
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
  | { status: "fejl"; fejl: string };

const AFVENTER_MANUEL: BetalingsStatus = {
  status: "afventer_betaling",
  besked:
    "Din ændring er registreret. BidHamr kontakter dig om betalingen, og ændringen gælder, når den er betalt.",
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

type SkiftRaekke = {
  id: string;
  firma_id: string;
  til_pakke_id: string;
  type: string;
  status: string;
  stripe_invoice_id: string | null;
};

async function hentSkift(skiftId: string): Promise<SkiftRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("firma_pakkeskift")
    .select("id, firma_id, til_pakke_id, type, status, stripe_invoice_id")
    .eq("id", skiftId)
    .maybeSingle<SkiftRaekke>();
  if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
  return data;
}

// En planlagt nedgradering i Stripe (Subscription Schedule) fjernes, så
// abonnementet igen styres direkte (ved opgradering, "behold pakken" og opsigelse).
async function frigivPlan(sub: Stripe.Subscription): Promise<void> {
  const plan = id(sub.schedule);
  if (!plan) return;
  try {
    await stripe().subscriptionSchedules.release(plan);
  } catch (err) {
    // Allerede frigivet/afsluttet - intet at gøre.
    if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
  }
}

// En opgradering, der stadig venter på betaling i Stripe (pending update med
// en åben faktura), men som ikke længere venter i databasen (firmaet har valgt
// en anden pakke): fakturaen annulleres (void), så den ikke kan betales ved en
// fejl, og Stripe dropper den ventende ændring. Betales den alligevel inden,
// refunderes den (refunderOpgradering). Kaster ikke.
async function annullerGamleOpgraderinger(firmaId: string): Promise<void> {
  try {
    const { data } = await createAdminClient()
      .from("firma_pakkeskift")
      .select("stripe_invoice_id")
      .eq("firma_id", firmaId)
      .in("status", ["annulleret", "erstattet"])
      .not("stripe_invoice_id", "is", null)
      .order("oprettet_kl", { ascending: false })
      .limit(5);
    const s = stripe();
    for (const r of (data ?? []) as { stripe_invoice_id: string }[]) {
      const faktura = await s.invoices.retrieve(r.stripe_invoice_id);
      if (faktura.status !== "open") continue;
      const annulleret = await s.invoices.voidInvoice(faktura.id);
      await synkFaktura(annulleret, null);
    }
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "annullerGamleOpgraderinger", fejl: err });
  }
}

// Firmaet har valgt en større pakke (firma_skift_pakke svarede
// 'opgradering_afventer_betaling'). Pakken skifter først, når fakturaen for
// forskellen er betalt.
export async function startOpgradering(skiftId: string): Promise<BetalingsStatus> {
  try {
    const skift = await hentSkift(skiftId);
    if (!skift || skift.status !== "afventer_betaling" || skift.type !== "opgradering") {
      return { status: "fejl", fejl: "Pakkeskiftet afventer ikke betaling." };
    }
    const f = await hentFirma("id", skift.firma_id);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return AFVENTER_MANUEL;

    const s = stripe();
    let sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    if (sub.status !== "active") return AFVENTER_MANUEL;
    await frigivPlan(sub);
    if (sub.pending_update) await annullerGamleOpgraderinger(f.id);
    if (sub.schedule || sub.pending_update) sub = await s.subscriptions.retrieve(sub.id);

    const prisId = await sikrPris(skift.til_pakke_id);
    const item = sub.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);

    const opdateret = await s.subscriptions.update(
      sub.id,
      {
        items: [{ id: item.id, price: prisId, quantity: 1 }],
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
        expand: ["latest_invoice"],
      },
      { idempotencyKey: idempotensNoegle.opgradering(skift.id) },
    );
    const faktura =
      opdateret.latest_invoice && typeof opdateret.latest_invoice !== "string" ? opdateret.latest_invoice : null;
    if (!faktura) throw new Error(`Ingen faktura efter opgradering af ${sub.id}`);

    const { error } = await createAdminClient()
      .from("firma_pakkeskift")
      .update({ stripe_invoice_id: faktura.id })
      .eq("id", skift.id)
      .is("stripe_invoice_id", null);
    if (error) throw new Error(`firma_pakkeskift.stripe_invoice_id: ${error.message}`);

    await synkFaktura(faktura, null);
    if (faktura.status === "paid") return { status: "betalt" };
    if (faktura.hosted_invoice_url?.startsWith("https://")) {
      return { status: "kraever_handling", url: faktura.hosted_invoice_url };
    }
    return AFVENTER_MANUEL;
  } catch (err) {
    return { status: "fejl", fejl: err instanceof Error ? err.message : String(err) };
  }
}

// Firmaet har valgt en mindre pakke (firma_skift_pakke svarede
// 'nedgradering_planlagt'). Prisen skifter i Stripe ved periodens slut.
export async function startNedgradering(skiftId: string): Promise<BetalingsStatus> {
  try {
    const skift = await hentSkift(skiftId);
    if (!skift || skift.status !== "planlagt") return { status: "fejl", fejl: "Skiftet er ikke planlagt." };
    const f = await hentFirma("id", skift.firma_id);
    // Uden Stripe-abonnement (fx manuel aftale): kun databasen.
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return { status: "betalt" };

    const s = stripe();
    await annullerGamleOpgraderinger(f.id);
    const sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    const item = sub.items.data[0];
    if (!item) throw new Error(`Abonnement ${sub.id} har ingen linjer`);
    const prisId = await sikrPris(skift.til_pakke_id);
    const moms = await sikrMomssats();
    const periodeSlut = item.current_period_end;

    const planId =
      id(sub.schedule) ??
      (
        await s.subscriptionSchedules.create(
          { from_subscription: sub.id },
          { idempotencyKey: idempotensNoegle.nedgraderingPlan(skift.id) },
        )
      ).id;
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

    // Datoen følger Stripes periode.
    await createAdminClient()
      .from("firmaer")
      .update({ naeste_pakke_fra: new Date(periodeSlut * 1000).toISOString() })
      .eq("id", f.id)
      .eq("naeste_pakke_id", skift.til_pakke_id);
    return { status: "betalt" };
  } catch (err) {
    return { status: "fejl", fejl: err instanceof Error ? err.message : String(err) };
  }
}

// Firmaet beholder sin pakke ("uaendret"): en planlagt nedgradering i Stripe
// fjernes. Kaster ikke.
export async function annullerPlanlagtSkift(brugerId: string): Promise<void> {
  try {
    const f = await hentFirma("bruger_id", brugerId);
    if (!f?.stripe_subscription_id || !stripeTilgaengelig()) return;
    await annullerGamleOpgraderinger(f.id);
    await frigivPlan(await stripe().subscriptions.retrieve(f.stripe_subscription_id));
  } catch (err) {
    await logDriftFejl({ kilde: "server", hvor: "annullerPlanlagtSkift", fejl: err });
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

export type OpsigSvar =
  | { status: "opsiges"; fra: string }
  | { status: "ingen_stripe" }
  | { status: "fejl"; fejl: string };

// Opsigelse (kun chef): abonnementet stopper ved periodens slut. Ingen refusion.
export async function opsigAbonnement(firmaId: string): Promise<OpsigSvar> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id) return { status: "ingen_stripe" };
    const s = stripe();
    const sub = await s.subscriptions.retrieve(f.stripe_subscription_id);
    if (sub.status === "canceled") return { status: "ingen_stripe" };
    await frigivPlan(sub);
    const slut = sub.items.data[0]?.current_period_end ?? 0;
    const periode = new Date(slut * 1000).toISOString().slice(0, 7);
    const opdateret = await s.subscriptions.update(
      sub.id,
      { cancel_at_period_end: true },
      { idempotencyKey: idempotensNoegle.opsigelse(firmaId, periode) },
    );
    await synkAbonnement(opdateret);
    const fra = tid(opdateret.cancel_at) ?? tid(slut) ?? new Date().toISOString();
    return { status: "opsiges", fra };
  } catch (err) {
    return { status: "fejl", fejl: err instanceof Error ? err.message : String(err) };
  }
}

export async function fortrydOpsigelse(firmaId: string): Promise<{ status: "ok" } | { status: "fejl"; fejl: string }> {
  try {
    const f = await hentFirma("id", firmaId);
    if (!f?.stripe_subscription_id) return { status: "fejl", fejl: "Firmaet har ikke et abonnement i Stripe." };
    const opdateret = await stripe().subscriptions.update(
      f.stripe_subscription_id,
      { cancel_at_period_end: false },
      { idempotencyKey: idempotensNoegle.fortrydOpsigelse(firmaId, Math.floor(Date.now() / 60_000)) },
    );
    await synkAbonnement(opdateret);
    return { status: "ok" };
  } catch (err) {
    return { status: "fejl", fejl: err instanceof Error ? err.message : String(err) };
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

function fakturaType(f: Stripe.Invoice): "abonnement" | "opgradering" | "andet" {
  switch (f.billing_reason) {
    case "subscription_create":
    case "subscription_cycle":
      return "abonnement";
    case "subscription_update":
      return "opgradering";
    default:
      return "andet";
  }
}

// Perioden, fakturaen dækker. For abonnementsfakturaer er det linjens
// periode (ikke invoice.period_*, som er perioden FØR).
function fakturaPeriode(f: Stripe.Invoice): { start: number | null; slut: number | null } {
  const linjer = f.lines?.data ?? [];
  const starter = linjer.map((l) => l.period?.start).filter((x): x is number => typeof x === "number");
  const slutter = linjer.map((l) => l.period?.end).filter((x): x is number => typeof x === "number");
  return {
    start: starter.length ? Math.min(...starter) : null,
    slut: slutter.length ? Math.max(...slutter) : null,
  };
}

export class ProevIgen extends Error {}

// invoice.finalized/paid/payment_failed (og efter egne kald).
// haendelse 'payment_failed' registrerer en mislykket abonnementsbetaling.
export async function synkFaktura(
  faktura: Stripe.Invoice,
  haendelse: "payment_failed" | null,
): Promise<string> {
  const f = await firmaForKunde(id(faktura.customer), faktura.parent?.subscription_details?.metadata?.firma_id);
  if (!f) return "ikke_erhverv";
  const type = fakturaType(faktura);
  const periode = fakturaPeriode(faktura);
  const ekskl = faktura.total_excluding_tax ?? null;

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
      });
      return `abonnement_betalt:${svar.kode}`;
    }
    if (type === "opgradering") return betaltOpgradering(f, faktura);
    return "andet";
  }

  if (haendelse === "payment_failed" && type === "abonnement") {
    const svar = await rpc("firma_abonnement_mislykket", {
      p_firma: f.id,
      p_stripe_reference: faktura.id,
      p_beloeb_oere: faktura.amount_due,
      p_stripe_invoice_id: faktura.id,
      p_periode_slut: tid(periode.slut),
    });
    return `mislykket:${svar.kode}`;
  }
  // En mislykket opgradering: skiftet venter stadig (gammel pakke beholdes).
  return "spejlet";
}

async function betaltOpgradering(f: FirmaRaekke, faktura: Stripe.Invoice): Promise<string> {
  const admin = createAdminClient();
  const { data: skift, error } = await admin
    .from("firma_pakkeskift")
    .select("id")
    .eq("stripe_invoice_id", faktura.id)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(`firma_pakkeskift: ${error.message}`);
  if (!skift) {
    // startOpgradering har måske ikke nået at gemme faktura-id'et endnu:
    // vent på Stripes næste forsøg, hvis der er et skift, der venter.
    const { count } = await admin
      .from("firma_pakkeskift")
      .select("id", { count: "exact", head: true })
      .eq("firma_id", f.id)
      .eq("status", "afventer_betaling")
      .is("stripe_invoice_id", null);
    if (count) throw new ProevIgen(`Opgraderingsfaktura ${faktura.id} uden kendt pakkeskift endnu`);
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/opgradering-ukendt",
      fejl: `Betalt opgraderingsfaktura ${faktura.id} for firma ${f.id} passer ikke til et pakkeskift - undersøg i Stripe.`,
    });
    return "ukendt_skift";
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
  return `opgradering:${svar.kode}`;
}

// Opgraderingen blev betalt, men pakkeskiftet afventer ikke længere (fx har
// firmaet valgt en anden pakke imens, eller staff har skiftet pakken):
// betalingen refunderes, og prisen i Stripe sættes tilbage til firmaets
// nuværende pakke. Databasen har allerede logget en drift-alarm.
async function refunderOpgradering(f: FirmaRaekke, skiftId: string, faktura: Stripe.Invoice): Promise<void> {
  const s = stripe();
  try {
    if (faktura.amount_paid > 0) {
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
      }
    }
    const sub = f.stripe_subscription_id ? await s.subscriptions.retrieve(f.stripe_subscription_id) : null;
    const item = sub?.items.data[0];
    if (sub && item) {
      const nu = await hentFirma("id", f.id);
      const prisId = await sikrPris(nu?.pakke_id ?? f.pakke_id);
      if (item.price.id !== prisId) {
        await s.subscriptions.update(
          sub.id,
          { items: [{ id: item.id, price: prisId, quantity: 1 }], proration_behavior: "none" },
          { idempotencyKey: idempotensNoegle.opgraderingTilbage(skiftId) },
        );
      }
    }
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/opgradering-refunderet",
      fejl: `Opgradering ${skiftId} (faktura ${faktura.id}) er refunderet automatisk, og prisen er sat tilbage. Tjek i Stripe.`,
    });
  } catch (err) {
    await logDriftFejl({
      kilde: "webhook",
      hvor: "erhverv/opgradering-refusion-fejl",
      fejl: `Refusion af opgradering ${skiftId} (faktura ${faktura.id}) fejlede - refundér manuelt: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
