import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { erOnboardingRetur, onboardingLink } from "@/lib/betaling/stripeBetaling";
import { sideUrl } from "@/lib/mails/handel";

// refresh_url for Stripe Connect-onboarding: et udløbet/brugt link sender
// sælgeren hertil, og vi laver et nyt og sender ham videre. Kræver login -
// linket giver adgang til sælgerens personlige oplysninger hos Stripe.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const r = new URL(request.url).searchParams.get("retur");
  const retur = erOnboardingRetur(r) ? r : "konto";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(sideUrl("/login"));

  try {
    return NextResponse.redirect(await onboardingLink(user.id, retur));
  } catch (err) {
    console.error("Connect-onboarding (refresh) fejlede:", err);
    return NextResponse.redirect(sideUrl(`/${retur}?stripe=fejl`));
  }
}
