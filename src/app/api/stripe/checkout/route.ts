import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

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

  // Gebyrer beregnes i øre for at undgå float-afrunding; DB-kolonnerne er i kr.
  const budØre = Math.round(beløb * 100);
  const køberGebyrØre = Math.round(budØre * 0.05);
  const sælgerGebyrØre = Math.round(budØre * 0.1);

  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card", "mobilepay"],
    line_items: [
      {
        price_data: {
          currency: "dkk",
          product_data: {
            name: `Vindende bud: ${auktion.titel}`,
            images: auktion.billeder?.[0] ? [auktion.billeder[0]] : undefined,
          },
          unit_amount: budØre,
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: "dkk",
          product_data: {
            name: "BidHamr købergebyr (5%)",
          },
          unit_amount: køberGebyrØre,
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

  // Forladte checkout-forsøg efterlader 'afventer'-rækker; markér dem
  // annulleret, så webhookens statusguard kun rammer den aktuelle række.
  await supabase
    .from("transactions")
    .update({ status: "annulleret" })
    .eq("auktion_id", auktionId)
    .eq("køber_id", authData.user.id)
    .eq("status", "afventer");

  const { error: insertError } = await supabase.from("transactions").insert({
    auktion_id: auktionId,
    køber_id: authData.user.id,
    sælger_id: auktion.bruger_id,
    beløb,
    køber_gebyr: køberGebyrØre / 100,
    sælger_gebyr: sælgerGebyrØre / 100,
    gebyr: 0,
    status: "afventer",
    stripe_checkout_session_id: session.id,
  });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ url: session.url });
}
