import "server-only";

import { erTestdatabase } from "@/lib/miljoe";

// Konfiguration af køb af boost-point i appen (Apple In-App Purchase og
// Google Play Billing). Alt kommer fra miljøvariabler (se .env.example og
// docs/IAP.md). Mangler noget, er platformen IKKE klar: endpointet svarer
// 503 iap_ikke_klar, og GET /api/app/boost/iap fortæller appen, at køb skal
// skjules. Fail closed - en halv opsætning giver aldrig point.
//
// Miljø (Apple Sandbox / Googles licenstestere = gratis testkøb):
//   - Apple: kun det miljø, APPLE_IAP_MILJOE siger ("Production" eller
//     "Sandbox"). En Sandbox-transaktion afvises på en Production-server.
//   - Testkøb (Apple Sandbox på en Production-server og Googles licenstest-
//     køb) tillades kun på testdatabasen eller med IAP_TILLAD_TESTKOEB=1
//     (fx mens Apple gennemgår appen - App Review køber i Sandbox). De
//     gemmes med miljoe 'test' og tælles for sig i rapporten.
//   - På produktionsdatabasen er APPLE_IAP_MILJOE=Sandbox ikke klar, medmindre
//     IAP_TILLAD_TESTKOEB=1 (ellers ville gratis Sandbox-køb give point).

export type AppleMiljoe = "Production" | "Sandbox";

export type AppleKonfig = {
  issuerId: string;
  keyId: string;
  privatNoegle: string;
  bundleId: string;
  appAppleId: number;
  miljoe: AppleMiljoe;
  // De miljøer, en transaktion må komme fra (miljoe + evt. Sandbox).
  tilladte: AppleMiljoe[];
};

export type GoogleKonfig = {
  klientEmail: string;
  privatNoegle: string;
  pakke: string;
  pubsubAudience: string;
  pubsubEmail: string;
  tilladTestkoeb: boolean;
};

const UUID_LIGNENDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAKKE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const env = (navn: string) => (process.env[navn] ?? "").trim();

// "\n" i en env-værdi (Vercel gemmer ofte nøglen på én linje).
const pem = (v: string) => v.replace(/\\n/g, "\n");

export function testkoebTilladt(): boolean {
  return erTestdatabase() || env("IAP_TILLAD_TESTKOEB") === "1";
}

export function appleKonfig(): AppleKonfig | null {
  const issuerId = env("APPLE_IAP_ISSUER_ID");
  const keyId = env("APPLE_IAP_KEY_ID");
  const privatNoegle = pem(env("APPLE_IAP_PRIVATE_KEY"));
  const bundleId = env("APPLE_BUNDLE_ID");
  const appAppleIdTekst = env("APPLE_APP_APPLE_ID");
  const miljoeTekst = env("APPLE_IAP_MILJOE");
  if (!UUID_LIGNENDE.test(issuerId)) return null;
  if (!/^[A-Z0-9]{10}$/.test(keyId)) return null;
  if (!privatNoegle.includes("-----BEGIN PRIVATE KEY-----")) return null;
  if (!PAKKE.test(bundleId)) return null;
  if (!/^\d{1,15}$/.test(appAppleIdTekst)) return null;
  if (miljoeTekst !== "Production" && miljoeTekst !== "Sandbox") return null;
  const test = testkoebTilladt();
  if (miljoeTekst === "Sandbox" && !test) return null;
  const tilladte: AppleMiljoe[] = miljoeTekst === "Production" && test ? ["Production", "Sandbox"] : [miljoeTekst];
  return {
    issuerId,
    keyId,
    privatNoegle,
    bundleId,
    appAppleId: Number(appAppleIdTekst),
    miljoe: miljoeTekst,
    tilladte,
  };
}

export function googleKonfig(): GoogleKonfig | null {
  const pakke = env("GOOGLE_PLAY_PACKAGE");
  const pubsubAudience = env("GOOGLE_PUBSUB_AUDIENCE");
  const pubsubEmail = env("GOOGLE_PUBSUB_SA_EMAIL");
  if (!PAKKE.test(pakke) || !pubsubAudience || pubsubAudience.length > 500 || !EMAIL.test(pubsubEmail)) return null;
  let sa: { client_email?: unknown; private_key?: unknown };
  try {
    sa = JSON.parse(env("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")) as typeof sa;
  } catch {
    return null;
  }
  if (!sa || typeof sa.client_email !== "string" || !EMAIL.test(sa.client_email)) return null;
  if (typeof sa.private_key !== "string" || !sa.private_key.includes("PRIVATE KEY-----")) return null;
  return {
    klientEmail: sa.client_email,
    privatNoegle: pem(sa.private_key),
    pakke,
    pubsubAudience,
    pubsubEmail: pubsubEmail.toLowerCase(),
    tilladTestkoeb: testkoebTilladt(),
  };
}

export type IapPlatform = "ios" | "android";

export function iapKlar(): Record<IapPlatform, boolean> {
  return { ios: appleKonfig() !== null, android: googleKonfig() !== null };
}
