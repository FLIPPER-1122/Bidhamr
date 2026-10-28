import "server-only";

import { createHash } from "node:crypto";
import {
  APIException,
  AppStoreServerAPIClient,
  Environment,
  NotificationTypeV2,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";
import type { AppleKonfig, AppleMiljoe } from "@/lib/iap/konfig";
import type { AppleTransaktion } from "@/lib/iap/regler";

// Apple: verificering af signerede JWS-data (StoreKit 2-transaktioner og App
// Store Server Notifications V2) og opslag i App Store Server API (Get
// Transaction Info) med Apples officielle bibliotek
// (@apple/app-store-server-library).
//
// SignedDataVerifier tjekker certifikatkæden i JWS-headeren (x5c: leaf ->
// Apple WWDR -> rod) mod Apple Root CA - G3 (indlejret herunder og tjekket
// med SHA-256-fingeraftrykket fra apple.com/certificateauthority), Apples
// OID'er i leaf og mellemcertifikat, signaturen, og at bundle-id og miljø
// (og app-id i produktion) passer. Med online-tjek (altid på serveren)
// tjekkes også, om certifikaterne er tilbagekaldt (OCSP), og datoerne mod nu.

// Apple Root CA - G3 (DER, base64) fra https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
const APPLE_ROOT_CA_G3_B64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";
// SHA-256-fingeraftryk, som Apple oplyser for Apple Root CA - G3.
const APPLE_ROOT_CA_G3_SHA256 = "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

function appleRod(): Buffer {
  const der = Buffer.from(APPLE_ROOT_CA_G3_B64, "base64");
  if (createHash("sha256").update(der).digest("hex") !== APPLE_ROOT_CA_G3_SHA256) {
    throw new Error("Apple Root CA - G3 har forkert fingeraftryk");
  }
  return der;
}

// Kun til enhedstest (vitest): en falsk rod og ingen online-tjek, så testene
// kan signere egne kæder. Virker ikke uden for vitest.
let testRod: { roots: Buffer[]; online: boolean } | null = null;
export function __saetAppleTestRod(roots: Buffer[] | null): void {
  if (!process.env.VITEST) throw new Error("Kun i test");
  testRod = roots ? { roots, online: false } : null;
  verifiers.clear();
}

const MILJOE: Record<AppleMiljoe, Environment> = {
  Production: Environment.PRODUCTION,
  Sandbox: Environment.SANDBOX,
};

const verifiers = new Map<string, SignedDataVerifier>();

function verifier(k: AppleKonfig, miljoe: AppleMiljoe): SignedDataVerifier {
  const noegle = `${miljoe}|${k.bundleId}|${k.appAppleId}`;
  let v = verifiers.get(noegle);
  if (!v) {
    const roots = testRod?.roots ?? [appleRod()];
    const online = testRod ? testRod.online : true;
    v = new SignedDataVerifier(roots, online, MILJOE[miljoe], k.bundleId, miljoe === "Production" ? k.appAppleId : undefined);
    verifiers.set(noegle, v);
  }
  return v;
}

export type AppleFejl = { fejl: "ugyldig" | "miljoe" | "midlertidig"; grund: string };

function somFejl(err: unknown): AppleFejl {
  if (err instanceof VerificationException) {
    if (err.status === VerificationStatus.INVALID_ENVIRONMENT) return { fejl: "miljoe", grund: "forkert miljø" };
    if (err.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) return { fejl: "midlertidig", grund: "OCSP kunne ikke nås" };
    return { fejl: "ugyldig", grund: `verificering fejlede (${VerificationStatus[err.status] ?? err.status})` };
  }
  return { fejl: "ugyldig", grund: "verificering fejlede" };
}

// Miljøet, som JWS'en SIGER, den kommer fra (uverificeret - bruges kun til at
// vælge verifier; verifieren tjekker det bagefter).
function paastaaetMiljoe(jws: string, felt: "transaktion" | "notifikation"): AppleMiljoe | null {
  try {
    const del = jws.split(".")[1];
    const j = JSON.parse(Buffer.from(del, "base64url").toString("utf8")) as Record<string, unknown>;
    const e = felt === "transaktion" ? j.environment : ((j.data ?? j.summary) as Record<string, unknown> | undefined)?.environment;
    return e === "Production" || e === "Sandbox" ? e : null;
  } catch {
    return null;
  }
}

// Verificerer en signeret transaktion (fra appen eller fra Apple). Kun de
// tilladte miljøer. Svar: transaktionen og dens miljø, eller en fejl.
export async function verificerAppleTransaktion(
  k: AppleKonfig,
  jws: string,
): Promise<{ tx: AppleTransaktion; miljoe: AppleMiljoe } | AppleFejl> {
  const paastaaet = paastaaetMiljoe(jws, "transaktion");
  if (!paastaaet) return { fejl: "ugyldig", grund: "miljø mangler" };
  if (!k.tilladte.includes(paastaaet)) {
    // Verificér alligevel med det påståede miljøs verifier - en forfalsket
    // JWS skal være "ugyldig", ikke "forkert miljø". Production kræver app-id.
    try {
      await verifier(k, paastaaet).verifyAndDecodeTransaction(jws);
      return { fejl: "miljoe", grund: `${paastaaet} er ikke tilladt` };
    } catch (err) {
      return somFejl(err);
    }
  }
  try {
    const tx = (await verifier(k, paastaaet).verifyAndDecodeTransaction(jws)) as AppleTransaktion;
    return { tx, miljoe: paastaaet };
  } catch (err) {
    return somFejl(err);
  }
}

// Get Transaction Info hos Apple (sandheden om købet - også om det er
// refunderet). Svaret er en signeret transaktion, som verificeres igen.
export async function hentAppleTransaktion(
  k: AppleKonfig,
  transaktionId: string,
  miljoe: AppleMiljoe,
): Promise<{ tx: AppleTransaktion } | AppleFejl> {
  let signeret: string | undefined;
  try {
    const klient = new AppStoreServerAPIClient(k.privatNoegle, k.keyId, k.issuerId, k.bundleId, MILJOE[miljoe]);
    signeret = (await klient.getTransactionInfo(transaktionId)).signedTransactionInfo;
  } catch (err) {
    if (err instanceof APIException && err.httpStatusCode >= 400 && err.httpStatusCode < 500 && err.httpStatusCode !== 401 && err.httpStatusCode !== 429) {
      // 400/404: ukendt transaktion for denne app og dette miljø.
      return { fejl: "ugyldig", grund: `Get Transaction Info ${err.httpStatusCode} ${err.apiError ?? ""}`.trim() };
    }
    const status = err instanceof APIException ? `${err.httpStatusCode} ${err.apiError ?? ""}`.trim() : "netværk";
    return { fejl: "midlertidig", grund: `Get Transaction Info fejlede (${status})` };
  }
  if (!signeret) return { fejl: "ugyldig", grund: "Get Transaction Info uden transaktion" };
  const v = await verificerAppleTransaktion(k, signeret);
  if ("fejl" in v) return v;
  if (v.miljoe !== miljoe) return { fejl: "ugyldig", grund: "miljøet skiftede" };
  return { tx: v.tx };
}

// Get Notification History (App Store Server API) - sikkerhedsnet, hvis en
// notifikation er gået tabt. Én notifikationstype pr. kald (Apple: enten
// notificationType eller transactionId, ikke begge). Bladrer med
// paginationToken (op til 20 pr. side) til hasMore er falsk eller maksSider.
// Svaret er de signerede notifikationer (signedPayload), som verificeres som
// en webhook (verificerAppleNotifikation).
export async function hentAppleNotifikationshistorik(
  k: AppleKonfig,
  miljoe: AppleMiljoe,
  type: NotificationTypeV2,
  fraMs: number,
  tilMs: number,
  maksSider = 50,
): Promise<{ signerede: string[]; flere: boolean } | AppleFejl> {
  const klient = new AppStoreServerAPIClient(k.privatNoegle, k.keyId, k.issuerId, k.bundleId, MILJOE[miljoe]);
  const signerede: string[] = [];
  let side: string | null = null;
  for (let i = 0; i < maksSider; i++) {
    let svar: Awaited<ReturnType<AppStoreServerAPIClient["getNotificationHistory"]>>;
    try {
      svar = await klient.getNotificationHistory(side, { startDate: Math.floor(fraMs), endDate: Math.floor(tilMs), notificationType: type });
    } catch (err) {
      const status = err instanceof APIException ? `${err.httpStatusCode} ${err.apiError ?? ""}`.trim() : "netværk";
      return { fejl: "midlertidig", grund: `Get Notification History fejlede (${status})` };
    }
    for (const n of svar.notificationHistory ?? []) {
      if (typeof n.signedPayload === "string" && n.signedPayload.length > 0) signerede.push(n.signedPayload);
    }
    if (!svar.hasMore || !svar.paginationToken) return { signerede, flere: false };
    side = svar.paginationToken;
  }
  return { signerede, flere: true };
}

export { NotificationTypeV2 };

export type AppleNotifikation = {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  // UNIX-tid i millisekunder, hvor App Store signerede notifikationen.
  signedDate?: number;
  data?: { signedTransactionInfo?: string; environment?: string; bundleId?: string; consumptionRequestReason?: string };
};

// Verificerer en App Store Server Notification V2 (signedPayload).
//   { notifikation, miljoe }                    verificeret, tilladt miljø
//   { fejl: "miljoe" }                          ægte, men fra et miljø, vi ikke bruger
//   { fejl: "ugyldig" | "midlertidig" }
export async function verificerAppleNotifikation(
  k: AppleKonfig,
  signedPayload: string,
): Promise<{ notifikation: AppleNotifikation; miljoe: AppleMiljoe } | AppleFejl> {
  const paastaaet = paastaaetMiljoe(signedPayload, "notifikation");
  if (!paastaaet) return { fejl: "ugyldig", grund: "miljø mangler" };
  try {
    const n = (await verifier(k, paastaaet).verifyAndDecodeNotification(signedPayload)) as AppleNotifikation;
    if (!k.tilladte.includes(paastaaet)) return { fejl: "miljoe", grund: `${paastaaet} er ikke tilladt` };
    return { notifikation: n, miljoe: paastaaet };
  } catch (err) {
    return somFejl(err);
  }
}
