import { NextResponse, type NextRequest } from "next/server";
import { klientIp, tjekGraenser } from "@/lib/rateLimit";

// return_url og refresh_url for appens Stripe-onboarding (udbetalingskonto).
// Stripe kræver https i live-tilstand, så Stripe sender hertil, og vi sender
// videre til appens deep link:
//   bidhamr://udbetalingskonto?status=retur     (onboarding forladt/gennemført)
//   bidhamr://udbetalingskonto?status=udloebet  (linket er udløbet eller brugt)
// Appen åbner linket med WebBrowser.openAuthSessionAsync(url,
// "bidhamr://udbetalingskonto"), som lukker, når den ser deep linket. Ingen
// login og ingen data her - status hentes bagefter af appen med Bearer-token
// (udbetalingskonto-status), og et nyt link laves kun via POST med login.
export const dynamic = "force-dynamic";

const APP_LINK = "bidhamr://udbetalingskonto";

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams.get("status");
  const status = s === "udloebet" ? "udloebet" : "retur";
  // Fail open (som tjekGraenser altid er): siden giver intet væk.
  if (!(await tjekGraenser([["betaling_app_retur_ip", await klientIp()]]))) {
    return new NextResponse("For mange forsøg.", { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  const res = NextResponse.redirect(`${APP_LINK}?status=${status}`, 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
