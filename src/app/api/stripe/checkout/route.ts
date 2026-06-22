import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const { auktionId } = await req.json();

  if (!auktionId) {
    return NextResponse.json({ error: "Mangler auktionId." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return NextResponse.json(
      { error: "Du skal være logget ind." },
      { status: 401 },
    );
  }

  const { data: auktion } = await supabase
    .from("auctions")
    .select("*")
    .eq("id", auktionId)
    .single();

  if (!auktion) {
    return NextResponse.json({ error: "Auktionen findes ikke." }, { status: 404 });
  }

  if (new Date(auktion.slutter_kl) > new Date()) {
    return NextResponse.json(
      { error: "Auktionen er ikke slut endnu." },
      { status: 400 },
    );
  }

  const { data: højesteBud } = await supabase
    .from("bids")
    .select("*")
    .eq("auktion_id", auktionId)
    .order("beløb", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!højesteBud || højesteBud.bruger_id !== authData.user.id) {
    return NextResponse.json(
      { error: "Du har ikke vundet denne auktion." },
      { status: 403 },
    );
  }

  const { data: eksisterendeBetalt } = await supabase
    .from("transactions")
    .select("id")
    .eq("auktion_id", auktionId)
    .eq("status", "betalt")
    .maybeSingle();

  if (eksisterendeBetalt) {
    return NextResponse.json(
      { error: "Denne auktion er allerede betalt." },
      { status: 400 },
    );
  }

  const origin = req.nextUrl.origin;
  const beløb = Number(højesteBud.beløb);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "dkk",
          product_data: {
            name: auktion.titel,
            images: auktion.billeder?.[0] ? [auktion.billeder[0]] : undefined,
          },
          unit_amount: Math.round(beløb * 100),
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      metadata: {
        auktion_id: auktionId,
        køber_id: authData.user.id,
      },
    },
    success_url: `${origin}/auktion/${auktionId}/betal/success`,
    cancel_url: `${origin}/auktion/${auktionId}/betal`,
  });

  const { error: insertError } = await supabase.from("transactions").insert({
    auktion_id: auktionId,
    køber_id: authData.user.id,
    sælger_id: auktion.bruger_id,
    beløb,
    gebyr: 0,
    status: "afventer",
    stripe_checkout_session_id: session.id,
  });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ url: session.url });
}
