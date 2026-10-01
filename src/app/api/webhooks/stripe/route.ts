import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  overfoerVentende,
  registrerGemtKort,
  spejlConnectKonto,
  spejlPaymentIntent,
} from "@/lib/betaling/stripeBetaling";

// Stripe-webhook for den nye betalingsmodel. Spejler Stripes status i
// databasen - Stripe er sandheden om penge.
//
// Signaturen verificeres altid. Platform-events signeres med
// STRIPE_WEBHOOK_SECRET; events fra Connect-konti (account.updated) kommer
// fra et separat Connect-endpoint i Stripe og signeres med
// STRIPE_CONNECT_WEBHOOK_SECRET (valgfri - samme rute kan bruges til begge).
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

async function haandter(event: Stripe.Event): Promise<void> {
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

    case "setup_intent.succeeded": {
      const si = event.data.object as Stripe.SetupIntent;
      await registrerGemtKort(si);
      return;
    }

    case "account.updated": {
      const konto = event.data.object as Stripe.Account;
      const brugerId = await spejlConnectKonto(konto);
      // Er sælgerens konto nu klar, overføres frigivne beløb, der ventede.
      if (brugerId && konto.capabilities?.transfers === "active") {
        await overfoerVentende(brugerId);
      }
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
    return NextResponse.json({ error: "Intern fejl." }, { status: 500 });
  }

  // Registreres først EFTER vellykket behandling, så en fejl giver et nyt forsøg.
  await admin
    .from("stripe_haendelser")
    .upsert({ id: event.id, type: event.type }, { onConflict: "id", ignoreDuplicates: true });

  return NextResponse.json({ received: true });
}
