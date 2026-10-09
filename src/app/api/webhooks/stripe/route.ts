import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { databasensStripeTilstand, getStripe, noeglensTilstand } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import {
  overfoerVentende,
  registrerGemtKort,
  spejlConnectKonto,
  spejlDestinationCharge,
  spejlFrakobling,
  spejlIndsigelse,
  spejlPaymentIntent,
  spejlRefusion,
  spejlRefusionsfejl,
  spejlSvindelvarsel,
  spejlUdbetaling,
} from "@/lib/betaling/stripeBetaling";
import { aabnVentende } from "@/lib/betaling/betalingInd";
import { bankKontoRettet, spejlReview, udbetalForKonto, udbetalVentende } from "@/lib/betaling/udbetaling";
import { synkAbonnement, synkFaktura, udloebetOpgradering } from "@/lib/erhverv/betaling";

// Stripe-webhook for den nye betalingsmodel. Spejler Stripes status i
// databasen - Stripe er sandheden om penge.
//
// Signaturen verificeres altid. Platform-events signeres med
// STRIPE_WEBHOOK_SECRET; events fra Connect-konti (account.updated,
// account.application.deauthorized, capability.updated, payout.paid,
// payout.failed, payout.canceled, balance.available,
// account.external_account.created/updated) kommer fra en
// separat Connect-destination i Stripe ("Events from: Connected accounts")
// og signeres med STRIPE_CONNECT_WEBHOOK_SECRET (samme rute bruges til begge).
// Connect-events har event.account = sælgerens Connect-konto.
//
// Erhvervsabonnementer (Stripe Billing, src/lib/erhverv/betaling.ts):
// customer.subscription.created/updated/deleted/pending_update_expired og
// invoice.finalized/paid/payment_failed/voided/marked_uncollectible. Kun for
// kunder, der er et firma (firmaer.stripe_customer_id); alle andre ignoreres.
//
// Betalingsmodel destination (trin 2, platform-events): charge.succeeded og
// charge.updated spejler transfer/application fee/available_on;
// radar.early_fraud_warning.created/updated markerer betalingen til staff
// (ingen automatisk refusion).
//
// Trin 3 (udbetaling): payout.paid/failed/canceled spejler BidHamrs
// udbetalinger fra sælgerens konto til banken; balance.available og
// account.external_account.* (Connect) prøver ventende udbetalinger igen;
// review.opened/closed (platform) stopper udbetalingen under et Radar-review.
//
// Idempotent: alle handlere tåler samme event flere gange (statusvagter i
// databasen). Behandlede event-id'er logges i stripe_haendelser og springes
// over ved genlevering.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function verificer(rawBody: string, signatur: string): Stripe.Event | null {
  const hemmeligheder = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  ].filter((h): h is string => !!h);

  for (const h of hemmeligheder) {
    try {
      return getStripe().webhooks.constructEvent(rawBody, signatur, h);
    } catch {
      // prøv næste hemmelighed
    }
  }
  return null;
}

// Events fra Connect-konti, som BidHamr bruger. Alle andre events med
// event.account (fx betalinger direkte på en Connect-konto) ignoreres - de
// hører ikke til BidHamrs pengestrøm og må ikke spejles som platform-events.
const CONNECT_EVENTS = new Set<string>([
  "account.updated",
  "account.application.deauthorized",
  "capability.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
  "balance.available",
  "account.external_account.created",
  "account.external_account.updated",
]);

// Hent sælgerens konto frisk (events kan komme i forkert rækkefølge) og spejl
// den. Er kontoen nu klar til overførsler, overføres frigivne beløb, der
// ventede (betalingsmodel separat).
async function spejlKonto(kontoId: string, eventType: string): Promise<void> {
  let konto: Stripe.Account;
  try {
    konto = await getStripe().accounts.retrieve(kontoId);
  } catch (err) {
    // Ingen adgang længere (kontoen er frakoblet/lukket): intet at spejle.
    // account.application.deauthorized håndterer frakoblingen.
    if (err instanceof Stripe.errors.StripePermissionError) {
      console.warn(`${eventType} for konto uden adgang:`, kontoId);
      return;
    }
    throw err;
  }
  const brugerId = await spejlConnectKonto(konto);
  if (brugerId && konto.capabilities?.transfers === "active") {
    await overfoerVentende(brugerId);
  }
  // Betalinger, der ventede på sælgerens konto (destination), åbnes nu,
  // hvis kontoen kan tage imod betaling.
  if (brugerId) await aabnVentende(brugerId);
  // Destination (trin 3): har sælgeren rettet bankkontoen efter en fejlet
  // udbetaling, sendes pengene igen; ellers forsøges ventende udbetalinger.
  if (brugerId && !(await bankKontoRettet(konto, brugerId)) && konto.payouts_enabled) {
    await udbetalVentende(brugerId);
  }
}

async function haandter(event: Stripe.Event): Promise<void> {
  if (event.account && !CONNECT_EVENTS.has(event.type)) return;

  switch (event.type) {
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.processing":
    case "payment_intent.canceled": {
      // Hent den aktuelle PaymentIntent i stedet for at stole på event-
      // payloaden: events kan komme i forkert rækkefølge.
      const fraEvent = event.data.object as Stripe.PaymentIntent;
      if (!fraEvent.metadata?.betaling_id) return; // ikke en BidHamr-handel
      const pi = await getStripe().paymentIntents.retrieve(fraEvent.id);
      const resultat = await spejlPaymentIntent(pi);
      console.log(`Stripe ${event.type}: ${pi.id} -> ${resultat}`);
      return;
    }

    case "charge.succeeded":
    case "charge.updated": {
      // Kun destination-charges (transfer_data) - alt andet ignoreres.
      const fraEvent = event.data.object as Stripe.Charge;
      if (!fraEvent.payment_intent || !fraEvent.transfer_data?.destination) return;
      const resultat = await spejlDestinationCharge(fraEvent.id);
      console.log(`Stripe ${event.type}: ${fraEvent.id} -> ${resultat}`);
      return;
    }

    case "radar.early_fraud_warning.created":
    case "radar.early_fraud_warning.updated": {
      const varsel = event.data.object as Stripe.Radar.EarlyFraudWarning;
      const resultat = await spejlSvindelvarsel(varsel.id);
      console.log(`Stripe ${event.type}: ${varsel.id} -> ${resultat}`);
      return;
    }

    case "charge.refunded": {
      // Hent den aktuelle charge (events kan komme i forkert rækkefølge).
      const fraEvent = event.data.object as Stripe.Charge;
      if (!fraEvent.payment_intent) return;
      const charge = await getStripe().charges.retrieve(fraEvent.id);
      const resultat = await spejlRefusion(charge);
      console.log(`Stripe ${event.type}: ${charge.id} -> ${resultat}`);
      return;
    }

    case "refund.updated":
    case "refund.failed":
    case "charge.refund.updated": {
      // En refusion, der fejler hos Stripe (fx kortet er lukket), markeres til
      // admin. Refusionen hentes frisk i spejlRefusionsfejl.
      const refund = event.data.object as Stripe.Refund;
      const resultat = await spejlRefusionsfejl(refund.id);
      console.log(`Stripe ${event.type}: ${refund.id} -> ${resultat}`);
      return;
    }

    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated": {
      // Indsigelse (chargeback). Disputen hentes frisk fra Stripe i
      // spejlIndsigelse, så rækkefølgen af events er ligegyldig.
      const dispute = event.data.object as Stripe.Dispute;
      const resultat = await spejlIndsigelse(dispute.id);
      console.log(`Stripe ${event.type}: ${dispute.id} -> ${resultat}`);
      return;
    }

    case "setup_intent.succeeded": {
      const si = event.data.object as Stripe.SetupIntent;
      await registrerGemtKort(si);
      return;
    }

    case "account.updated": {
      await spejlKonto((event.data.object as Stripe.Account).id, event.type);
      return;
    }

    case "capability.updated": {
      // En capability (card_payments, transfers, mobilepay_payments ...) på
      // sælgerens konto har skiftet status. Kontoen spejles som ved
      // account.updated.
      const cap = event.data.object as Stripe.Capability;
      const kontoId = typeof cap.account === "string" ? cap.account : cap.account?.id;
      if (!kontoId) return;
      await spejlKonto(kontoId, event.type);
      return;
    }

    case "account.application.deauthorized": {
      // data.object er applikationen (BidHamr); kontoen står i event.account.
      if (!event.account) return;
      const resultat = await spejlFrakobling(event.account);
      console.log(`Stripe ${event.type}: ${event.account} -> ${resultat}`);
      return;
    }

    case "account.external_account.created":
    case "account.external_account.updated": {
      // Sælgeren har tilføjet/rettet en bankkonto hos Stripe.
      if (!event.account) return;
      await spejlKonto(event.account, event.type);
      return;
    }

    case "balance.available": {
      // Midler på sælgerens konto er blevet tilgængelige (destination):
      // udbetal handler, der er helt færdige.
      if (!event.account) return;
      const antal = await udbetalForKonto(event.account);
      console.log(`Stripe ${event.type}: ${event.account} -> ${antal} udbetaling(er)`);
      return;
    }

    case "review.opened":
    case "review.closed": {
      // Stripe Radar-review (platform): stopper udbetalingen, mens det er åbent.
      const review = event.data.object as Stripe.Review;
      const resultat = await spejlReview(review.id);
      console.log(`Stripe ${event.type}: ${review.id} -> ${resultat}`);
      return;
    }

    case "payout.paid":
    case "payout.failed":
    case "payout.canceled": {
      // Udbetaling fra sælgerens Connect-konto til banken: BidHamrs egen
      // (destination, saelger_udbetalinger) eller Stripes automatiske
      // (separat).
      if (!event.account) return; // platformens egne udbetalinger
      const payout = event.data.object as Stripe.Payout;
      const resultat = await spejlUdbetaling(event.account, payout.id);
      console.log(`Stripe ${event.type}: ${payout.id} -> ${resultat}`);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // Hent abonnementet frisk (events kan komme i forkert rækkefølge).
      const fraEvent = event.data.object as Stripe.Subscription;
      const sub = await getStripe().subscriptions.retrieve(fraEvent.id);
      const resultat = await synkAbonnement(sub, event.type === "customer.subscription.deleted");
      console.log(`Stripe ${event.type}: ${sub.id} -> ${resultat}`);
      return;
    }

    case "customer.subscription.pending_update_expired": {
      // Firmaet nåede ikke at betale forskellen for en opgradering.
      const fraEvent = event.data.object as Stripe.Subscription;
      const sub = await getStripe().subscriptions.retrieve(fraEvent.id);
      const resultat = await udloebetOpgradering(sub);
      console.log(`Stripe ${event.type}: ${sub.id} -> ${resultat}`);
      return;
    }

    case "invoice.finalized":
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided":
    case "invoice.marked_uncollectible": {
      const fraEvent = event.data.object as Stripe.Invoice;
      if (!fraEvent.id) return;
      const faktura = await getStripe().invoices.retrieve(fraEvent.id);
      const resultat = await synkFaktura(faktura, event.type === "invoice.payment_failed" ? "payment_failed" : null);
      console.log(`Stripe ${event.type}: ${faktura.id} -> ${resultat}`);
      return;
    }

    default:
      return;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signatur = req.headers.get("stripe-signature");
  if (!signatur) {
    return NextResponse.json({ error: "Mangler signatur." }, { status: 400 });
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET && !process.env.STRIPE_CONNECT_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET mangler - webhook afvist.");
    return NextResponse.json({ error: "Ikke konfigureret." }, { status: 500 });
  }

  const event = verificer(rawBody, signatur);
  if (!event) {
    console.error("Ugyldig Stripe-webhook-signatur.");
    return NextResponse.json({ error: "Ugyldig signatur." }, { status: 400 });
  }

  // Eventets tilstand (test/live) skal passe til nøglen OG databasen
  // (stripe_tilstand, Niels F07). Ellers kvitteres der IKKE: drift-alarm og
  // 503, så Stripe prøver igen (op til 3 dage), når databasen er klar - og
  // fejlen ses i Stripe-dashboardet. Kun testmiljø indtil fase 6.
  {
    const eventTilstand = event.livemode ? "live" : "test";
    const noegle = noeglensTilstand();
    const db = await databasensStripeTilstand();
    if (eventTilstand !== noegle || (db !== null && db !== eventTilstand) || (db === null && eventTilstand === "live")) {
      console.error(`Stripe-event ${event.id} er ${eventTilstand}, men nøglen er ${noegle ?? "?"} og databasen ${db ?? "?"}.`);
      await logDriftFejl({
        kilde: "webhook",
        sti: "stripe-webhook",
        hvor: "tilstand",
        fejl: `${eventTilstand.toUpperCase()}-event (${event.type}) modtaget, men nøglen er ${noegle ?? "ukendt"} og databasens Stripe-tilstand er ${db ?? "ukendt"} - ikke behandlet. Se docs/GO-LIVE-STRIPE.md.`,
      });
      return NextResponse.json({ error: "Stripe-tilstanden passer ikke." }, { status: 503 });
    }
  }

  const admin = createAdminClient();
  const { data: set } = await admin
    .from("stripe_haendelser")
    .select("id")
    .eq("id", event.id)
    .maybeSingle();
  if (set) return NextResponse.json({ received: true, gentaget: true });

  try {
    await haandter(event);
  } catch (err) {
    // 500 får Stripe til at prøve igen. Handlerne er idempotente.
    console.error(`Webhook ${event.type} (${event.id}) fejlede:`, err);
    await logDriftFejl({ kilde: "webhook", sti: "stripe-webhook", hvor: event.type, fejl: err });
    return NextResponse.json({ error: "Intern fejl." }, { status: 500 });
  }

  // Registreres først EFTER vellykket behandling, så en fejl giver et nyt forsøg.
  await admin
    .from("stripe_haendelser")
    .upsert({ id: event.id, type: event.type }, { onConflict: "id", ignoreDuplicates: true });

  return NextResponse.json({ received: true });
}
