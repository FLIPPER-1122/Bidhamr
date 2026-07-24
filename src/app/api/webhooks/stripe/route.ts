import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Mangler signatur." }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    console.error("Ugyldig Stripe-webhook-signatur:", err);
    return NextResponse.json({ error: "Ugyldig signatur." }, { status: 400 });
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const auktionId = paymentIntent.metadata?.auktion_id;

    if (!auktionId) {
      console.error("payment_intent.succeeded uden auktion_id i metadata");
      return NextResponse.json({ received: true });
    }

    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("transactions")
      .update({
        status: "betalt",
        stripe_payment_intent_id: paymentIntent.id,
      })
      .eq("auktion_id", auktionId)
      .eq("status", "afventer")
      .select("id");

    if (error) {
      console.error("Kunne ikke opdatere transaction efter betaling:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log(
      `Betaling gennemført for auktion ${auktionId}, opdaterede ${data?.length ?? 0} transaktion(er) til 'betalt'.`,
    );
  }

  return NextResponse.json({ received: true });
}
