import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getStripe } from "@/lib/stripe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIN_KR = 50;
const MAX_KR = 50000;

export async function POST(req: NextRequest) {
  // ASCII-noegle i API-kontrakten: 'ø' er lovligt JSON, men overlever ikke
  // altid encoding paa vej gennem proxyer og vaerktoejer.
  let beloeb: unknown;
  try {
    ({ beloeb } = await req.json());
  } catch {
    return NextResponse.json({ error: "Ugyldig forespørgsel." }, { status: 400 });
  }

  const kroner = Number(beloeb);
  if (!Number.isFinite(kroner) || kroner < MIN_KR || kroner > MAX_KR) {
    return NextResponse.json(
      { error: `Beløbet skal være mellem ${MIN_KR} og ${MAX_KR} kr.` },
      { status: 400 },
    );
  }

  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return NextResponse.json(
      { error: "Du skal være logget ind." },
      { status: 401 },
    );
  }

  const øre = Math.round(kroner * 100);
  const origin = req.nextUrl.origin;

  // Beløbet tages fra serveren, aldrig fra klienten efter dette punkt.
  // Krediteringen sker først i webhooken, når Stripe bekræfter betalingen -
  // en bruger kan altså ikke få saldo ved blot at kalde success-URL'en.
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card", "mobilepay"],
    line_items: [
      {
        price_data: {
          currency: "dkk",
          product_data: { name: "Indbetaling til BidHamr-konto" },
          unit_amount: øre,
        },
        quantity: 1,
      },
    ],
    metadata: {
      formaal: "wallet_indbetaling",
      bruger_id: authData.user.id,
    },
    success_url: `${origin}/konto?indbetaling=ok`,
    cancel_url: `${origin}/konto?indbetaling=afbrudt`,
  });

  return NextResponse.json({ url: session.url });
}
