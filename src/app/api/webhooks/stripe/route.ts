import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import {
  overfoerVentende,
  registrerGemtKort,
  spejlConnectKonto,
  spejlFrakobling,
  spejlIndsigelse,
  spejlPaymentIntent,
  spejlRefusion,
  spejlRefusionsfejl,
  spejlUdbetaling,
} from "@/lib/betaling/stripeBetaling";

// Stripe-webhook for den nye betalingsmodel. Spejler Stripes status i
// databasen - Stripe er sandheden om penge.
//
// Signaturen verificeres altid. Platform-events signeres med
// STRIPE_WEBHOOK_SECRET; events fra Connect-konti (account.updated,
// account.application.deauthorized, payout.paid, payout.failed) kommer fra en
// separat Connect-destination i Stripe ("Events from: Connected accounts")
// og signeres med STRIPE_CONNECT_WEBHOOK_SECRET (samme rute bruges til begge).
// Connect-events har event.account = sælgerens Connect-konto.
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
  "payout.paid",
  "payout.failed",
]);

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
    case "charge.dispute.closed": {
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
      // Hent kontoen frisk (events kan komme i forkert rækkefølge).
      const fraEvent = event.data.object as Stripe.Account;
      let konto: Stripe.Account;
      try {
        konto = await getStripe().accounts.retrieve(fraEvent.id);
      } catch (err) {
        // Ingen adgang længere (kontoen er frakoblet/lukket): intet at spejle.
        // account.application.deauthorized håndterer frakoblingen.
        if (err instanceof Stripe.errors.StripePermissionError) {
          console.warn("account.updated for konto uden adgang:", fraEvent.id);
          return;
        }
        throw err;
      }
      const brugerId = await spejlConnectKonto(konto);
      // Er sælgerens konto nu klar, overføres frigivne beløb, der ventede.
      if (brugerId && konto.capabilities?.transfers === "active") {
        await overfoerVentende(brugerId);
      }
      return;
    }

    case "account.application.deauthorized": {
      // data.object er applikationen (BidHamr); kontoen står i event.account.
      if (!event.account) return;
      const resultat = await spejlFrakobling(event.account);
      console.log(`Stripe ${event.type}: ${event.account} -> ${resultat}`);
      return;
    }

    case "payout.paid":
    case "payout.failed": {
      // Stripes automatiske udbetaling fra sælgerens Connect-konto til banken.
      if (!event.account) return; // platformens egne udbetalinger
      const payout = event.data.object as Stripe.Payout;
      const resultat = await spejlUdbetaling(event.account, payout.id);
      console.log(`Stripe ${event.type}: ${payout.id} -> ${resultat}`);
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

  // Kun testmiljø indtil fase 6.
  if (event.livemode) {
    console.error("Live-event modtaget, men kun test mode er tilladt:", event.id);
    return NextResponse.json({ received: true });
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
