import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

// Stripe bruges udelukkende til at fylde penge PÅ en e-money-konto. Selve
// auktionsbetalingen sker internt mellem konti, når auktionen lukker - der
// findes ikke længere en betaling pr. auktion.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Mangler signatur." }, { status: 400 });
  }

  const hemmelighed = process.env.STRIPE_WEBHOOK_SECRET;
  if (!hemmelighed) {
    console.error("STRIPE_WEBHOOK_SECRET mangler - webhook afvist.");
    return NextResponse.json({ error: "Ikke konfigureret." }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, hemmelighed);
  } catch (err) {
    console.error("Ugyldig Stripe-webhook-signatur:", err);
    return NextResponse.json({ error: "Ugyldig signatur." }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    // Kun indbetalinger til wallet håndteres her.
    if (session.metadata?.formaal !== "wallet_indbetaling") {
      return NextResponse.json({ received: true });
    }

    const brugerId = session.metadata?.bruger_id;
    const øre = session.amount_total;

    if (!brugerId || !øre) {
      console.error("Wallet-indbetaling uden bruger_id eller beløb:", session.id);
      return NextResponse.json({ received: true });
    }

    // Betalte Stripe først? Ellers venter vi på async_payment_succeeded.
    if (session.payment_status !== "paid") {
      return NextResponse.json({ received: true });
    }

    const supabase = createAdminClient();

    // Funktionen er idempotent på session-id, så en genleveret webhook
    // krediterer ikke igen. Det er derfor sikkert altid at kalde den.
    const { error } = await supabase.rpc("wallet_indbetal", {
      p_user: brugerId,
      p_amount: øre / 100,
      p_stripe_session: session.id,
    });

    if (error) {
      // 500 får Stripe til at prøve igen - det er det, vi vil have, hvis
      // krediteringen fejlede af forbigående årsager.
      console.error("Kunne ikke kreditere wallet:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(
      `Wallet krediteret: ${øre / 100} kr til bruger ${brugerId} (${session.id}).`,
    );
  }

  return NextResponse.json({ received: true });
}
