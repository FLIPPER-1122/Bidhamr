import "server-only";

import { createHmac } from "node:crypto";
import { erTestdatabase } from "@/lib/miljoe";
import { testkoebKonti, testkoebVindue } from "@/lib/iap/regler";

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
//     køb) tillades altid på testdatabasen. På produktionsdatabasen KUN når
//     IAP_TILLAD_TESTKOEB_TIL er en ISO-dato i fremtiden og højst 14 dage
//     frem, og kun for kontiene i IAP_TESTKOEB_KONTI (fx kontoen til Apples
//     App Review). Alt andet = slået fra (fail closed). Testkøb gemmes med
//     miljoe 'test', i produktion også med markeringen 'testkoeb_prod', og
//     tælles for sig i rapporten. Så længe vinduet er åbent, logger den
//     daglige cron en drift-advarsel.
//   - På produktionsdatabasen er APPLE_IAP_MILJOE=Sandbox kun klar, mens
//     testkøbsvinduet er åbent (ellers ville gratis Sandbox-køb give point).
//
// Kontobindingen (appAccountToken hos Apple, obfuscatedAccountId hos Google)
// er en HMAC af bruger-id'et med IAP_KONTO_HEMMELIGHED - deterministisk, så
// serveren kan regne den ud igen, men uden at bruger-id'et sendes til
// Apple/Google. Mangler hemmeligheden, er køb i appen ikke klar.

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
};

const UUID_LIGNENDE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAKKE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const env = (navn: string) => (process.env[navn] ?? "").trim();

// "\n" i en env-værdi (Vercel gemmer ofte nøglen på én linje).
const pem = (v: string) => v.replace(/\\n/g, "\n");

export type TestkoebStatus = {
  // Testkøb kan forekomme (testdatabasen, eller et åbent vindue med mindst
  // én konto i produktion).
  aabent: boolean;
  // Produktionsdatabasen med åbent vindue (drift-advarsel hver dag).
  iProduktion: boolean;
  til: Date | null;
  // null = alle (testdatabasen); ellers kun disse konti.
  konti: Set<string> | null;
};

export function testkoebStatus(nuMs: number = Date.now()): TestkoebStatus {
  if (erTestdatabase()) return { aabent: true, iProduktion: false, til: null, konti: null };
  const v = testkoebVindue(env("IAP_TILLAD_TESTKOEB_TIL"), nuMs);
  const konti = testkoebKonti(env("IAP_TESTKOEB_KONTI"));
  const aabent = v.aabent && konti.size > 0;
  return { aabent, iProduktion: aabent, til: aabent ? v.til : null, konti: aabent ? konti : new Set() };
}

// Må DENNE bruger lave testkøb?
export function testkoebTilladtFor(brugerId: string, s: TestkoebStatus = testkoebStatus()): boolean {
  if (!s.aabent) return false;
  return s.konti === null || s.konti.has(brugerId.toLowerCase());
}

function kontoHemmelighed(): string | null {
  const h = env("IAP_KONTO_HEMMELIGHED");
  return h.length >= 32 ? h : null;
}

// appAccountToken / obfuscatedAccountId for en bruger: HMAC-SHA256 af
// bruger-id'et, formateret som et UUID (version 8, RFC 9562), fordi Apple
// kræver et UUID. null = hemmeligheden mangler (køb i appen er ikke klar).
export function kontoToken(brugerId: string): string | null {
  const h = kontoHemmelighed();
  if (!h) return null;
  const b = createHmac("sha256", h).update(`bidhamr-iap-konto:v1:${brugerId.toLowerCase()}`, "utf8").digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
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
  if (!kontoHemmelighed()) return null;
  const test = testkoebStatus().aabent;
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
  if (!kontoHemmelighed()) return null;
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
  };
}

export type IapPlatform = "ios" | "android";

export function iapKlar(): Record<IapPlatform, boolean> {
  return { ios: appleKonfig() !== null, android: googleKonfig() !== null };
}
