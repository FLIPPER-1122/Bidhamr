import { NextResponse, type NextRequest } from "next/server";
import { logDriftFejl } from "@/lib/drift";
import { haandterGoogleRtdn } from "@/lib/iap/server";

// Google Play real-time developer notifications via Pub/Sub push (køb af
// boost-point i appen - docs/IAP.md). Pub/Sub sender POST
// { message: { data (base64 DeveloperNotification), messageId, ... },
// subscription } med "Authorization: Bearer <OIDC-token>". Tokenet
// verificeres (Googles signatur, udløb, udsteder, audience =
// GOOGLE_PUBSUB_AUDIENCE og email = GOOGLE_PUBSUB_SA_EMAIL med
// email_verified) - src/lib/iap/google.ts. Behandles:
// voidedPurchaseNotification for engangskøb (pointene trækkes tilbage - også
// i minus) og testNotification. Alt andet kvitteres.
//
// Idempotent: én række pr. messageId (boost_iap_notifikationer), og
// refusionen er idempotent i sig selv. Svar: 204 modtaget, 401 ikke
// verificeret, 500/503 prøv igen (Pub/Sub prøver igen).
//
// Åben rute i proxyen (/api/webhooks) - adgangen er OIDC-tokenet.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAKS = 64 * 1024;

export async function POST(req: NextRequest) {
  const laengde = Number(req.headers.get("content-length") ?? "0");
  if (laengde > MAKS) return NextResponse.json({ fejl: "For stor" }, { status: 413 });
  let krop: Record<string, unknown>;
  try {
    const tekst = await req.text();
    if (tekst.length > MAKS) return NextResponse.json({ fejl: "For stor" }, { status: 413 });
    const j = JSON.parse(tekst) as unknown;
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("ikke et objekt");
    krop = j as Record<string, unknown>;
  } catch {
    return NextResponse.json({ fejl: "Ugyldig" }, { status: 400 });
  }
  try {
    const r = await haandterGoogleRtdn(req.headers.get("authorization"), krop);
    if (r.status === 204) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ resultat: r.resultat }, { status: r.status });
  } catch (err) {
    await logDriftFejl({ kilde: "webhook", sti: "/api/webhooks/google-play", hvor: "boost/iap-google-webhook", fejl: err });
    return NextResponse.json({ fejl: "Prøv igen" }, { status: 500 });
  }
}
