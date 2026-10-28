import { NextResponse, type NextRequest } from "next/server";
import { logDriftFejl } from "@/lib/drift";
import { JWS_RE } from "@/lib/iap/regler";
import { haandterAppleNotifikation } from "@/lib/iap/server";

// App Store Server Notifications V2 (køb af boost-point i appen - docs/IAP.md).
// Apple sender POST { signedPayload } (en JWS). Signaturen og
// certifikatkæden til Apple Root CA - G3 verificeres af Apples officielle
// bibliotek, og bundle-id, app-id og miljø skal passe
// (src/lib/iap/apple.ts). Behandles: REFUND (pointene trækkes tilbage - også
// i minus), REFUND_REVERSED og CONSUMPTION_REQUEST (note til chefen) og TEST.
// Alt andet kvitteres med 200.
//
// Idempotent: én række pr. notificationUUID (boost_iap_notifikationer), og
// refusionen er idempotent i sig selv. Svar: 200 modtaget, 401 ikke
// verificeret, 500/503 prøv igen (Apple prøver igen efter 1, 12, 24, 48 og
// 72 timer i produktion).
//
// Åben rute i proxyen (/api/webhooks) - adgangen er signaturen.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAKS = 128 * 1024;

export async function POST(req: NextRequest) {
  const laengde = Number(req.headers.get("content-length") ?? "0");
  if (laengde > MAKS) return NextResponse.json({ fejl: "For stor" }, { status: 413 });
  let signedPayload: unknown;
  try {
    const tekst = await req.text();
    if (tekst.length > MAKS) return NextResponse.json({ fejl: "For stor" }, { status: 413 });
    signedPayload = (JSON.parse(tekst) as { signedPayload?: unknown }).signedPayload;
  } catch {
    return NextResponse.json({ fejl: "Ugyldig" }, { status: 400 });
  }
  if (typeof signedPayload !== "string" || !JWS_RE.test(signedPayload)) {
    return NextResponse.json({ fejl: "Ugyldig" }, { status: 400 });
  }
  try {
    const r = await haandterAppleNotifikation(signedPayload);
    return NextResponse.json({ resultat: r.resultat }, { status: r.status });
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", sti: "/api/webhooks/apple", hvor: "boost/iap-apple-webhook", fejl: err });
    return NextResponse.json({ fejl: "Prøv igen" }, { status: 500 });
  }
}
