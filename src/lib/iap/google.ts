import "server-only";

import { JWT, OAuth2Client } from "google-auth-library";
import type { GoogleKonfig } from "@/lib/iap/konfig";
import type { GoogleKoeb } from "@/lib/iap/regler";

// Google Play Developer API (androidpublisher v3) med en service account, og
// verificering af Pub/Sub-push (real-time developer notifications) med
// OIDC-tokenet i Authorization-headeren.
//
// REST-kald (fra Googles discovery-dokument for androidpublisher v3):
//   GET  .../applications/{packageName}/purchases/products/{productId}/tokens/{token}           purchases.products.get
//   POST .../applications/{packageName}/purchases/products/{productId}/tokens/{token}:consume   purchases.products.consume (tom krop)
//   GET  .../applications/{packageName}/purchases/voidedpurchases?startTime&endTime&maxResults&token&type
// Scope: https://www.googleapis.com/auth/androidpublisher

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TIMEOUT_MS = 10_000;

export type GoogleFejl = { fejl: "ugyldig" | "midlertidig" | "konfig"; grund: string };

let jwtKlient: { noegle: string; klient: JWT } | null = null;

async function adgangstoken(k: GoogleKonfig): Promise<string> {
  const noegle = `${k.klientEmail}|${k.privatNoegle.length}`;
  if (!jwtKlient || jwtKlient.noegle !== noegle) {
    jwtKlient = { noegle, klient: new JWT({ email: k.klientEmail, key: k.privatNoegle, scopes: [SCOPE] }) };
  }
  const t = await jwtKlient.klient.getAccessToken();
  if (!t.token) throw new Error("intet adgangstoken");
  return t.token;
}

async function kald(k: GoogleKonfig, url: string, metode: "GET" | "POST"): Promise<Response | GoogleFejl> {
  let token: string;
  try {
    token = await adgangstoken(k);
  } catch {
    return { fejl: "konfig", grund: "service account kunne ikke logge ind hos Google" };
  }
  try {
    return await fetch(url, {
      method: metode,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { fejl: "midlertidig", grund: "Google kunne ikke nås" };
  }
}

function statusFejl(r: Response, hvad: string): GoogleFejl {
  // 401/403: service account mangler adgang i Play Console (konfiguration).
  if (r.status === 401 || r.status === 403) return { fejl: "konfig", grund: `${hvad} ${r.status} (service account mangler adgang?)` };
  if (r.status === 400 || r.status === 404 || r.status === 410) return { fejl: "ugyldig", grund: `${hvad} ${r.status}` };
  return { fejl: "midlertidig", grund: `${hvad} ${r.status}` };
}

const sti = (k: GoogleKonfig, produktId: string, token: string) =>
  `${API}/${encodeURIComponent(k.pakke)}/purchases/products/${encodeURIComponent(produktId)}/tokens/${encodeURIComponent(token)}`;

// purchases.products.get - sandheden om købet.
export async function hentGoogleKoeb(k: GoogleKonfig, produktId: string, token: string): Promise<{ koeb: GoogleKoeb } | GoogleFejl> {
  const r = await kald(k, sti(k, produktId, token), "GET");
  if ("fejl" in r) return r;
  if (!r.ok) return statusFejl(r, "purchases.products.get");
  try {
    const j = (await r.json()) as Record<string, unknown>;
    if (j.kind !== undefined && j.kind !== "androidpublisher#productPurchase") return { fejl: "ugyldig", grund: "uventet svar" };
    const tal = (v: unknown) => (typeof v === "number" ? v : undefined);
    const tekst = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      koeb: {
        purchaseState: tal(j.purchaseState),
        consumptionState: tal(j.consumptionState),
        purchaseType: tal(j.purchaseType),
        orderId: tekst(j.orderId),
        quantity: tal(j.quantity),
        purchaseTimeMillis: tekst(j.purchaseTimeMillis),
        obfuscatedExternalAccountId: tekst(j.obfuscatedExternalAccountId),
        regionCode: tekst(j.regionCode),
        productId: tekst(j.productId),
      },
    };
  } catch {
    return { fejl: "midlertidig", grund: "svaret kunne ikke læses" };
  }
}

// purchases.products.consume - så produktet kan købes igen. Idempotent hos
// Google (et allerede forbrugt køb giver en fejl, som vi tjekker med get).
export async function forbrugGoogleKoeb(k: GoogleKonfig, produktId: string, token: string): Promise<{ ok: true } | GoogleFejl> {
  const r = await kald(k, `${sti(k, produktId, token)}:consume`, "POST");
  if ("fejl" in r) return r;
  if (r.ok) return { ok: true };
  // Allerede forbrugt? Så er målet nået.
  const g = await hentGoogleKoeb(k, produktId, token);
  if ("koeb" in g && g.koeb.consumptionState === 1) return { ok: true };
  return statusFejl(r, "purchases.products.consume");
}

export type GoogleVoided = {
  purchaseToken: string;
  orderId: string | null;
  voidedTimeMillis: string | null;
};

// voidedpurchases.list - de seneste annullerede/refunderede/tilbageførte
// engangskøb (type 0 = kun in-app-produkter). Højst 30 dage tilbage (Googles
// grænse). Bladrer med token-sider (højst maksSider).
export async function hentGoogleVoided(
  k: GoogleKonfig,
  fraMs: number,
  maksSider = 20,
): Promise<{ koeb: GoogleVoided[] } | GoogleFejl> {
  const ud: GoogleVoided[] = [];
  let side: string | null = null;
  const fra = Math.max(fraMs, Date.now() - 30 * 24 * 3600 * 1000 + 60_000);
  for (let i = 0; i < maksSider; i++) {
    const q = new URLSearchParams({ type: "0", maxResults: "1000" });
    if (side) q.set("token", side);
    else q.set("startTime", String(Math.floor(fra)));
    const r = await kald(k, `${API}/${encodeURIComponent(k.pakke)}/purchases/voidedpurchases?${q.toString()}`, "GET");
    if ("fejl" in r) return r;
    if (!r.ok) return statusFejl(r, "voidedpurchases.list");
    let j: { voidedPurchases?: unknown[]; tokenPagination?: { nextPageToken?: unknown } };
    try {
      j = (await r.json()) as typeof j;
    } catch {
      return { fejl: "midlertidig", grund: "svaret kunne ikke læses" };
    }
    for (const v of Array.isArray(j.voidedPurchases) ? j.voidedPurchases : []) {
      const o = v as Record<string, unknown>;
      if (typeof o.purchaseToken !== "string") continue;
      ud.push({
        purchaseToken: o.purchaseToken,
        orderId: typeof o.orderId === "string" ? o.orderId : null,
        voidedTimeMillis: typeof o.voidedTimeMillis === "string" ? o.voidedTimeMillis : null,
      });
    }
    const naeste = j.tokenPagination?.nextPageToken;
    if (typeof naeste !== "string" || !naeste) return { koeb: ud };
    side = naeste;
  }
  return { koeb: ud };
}

// Pub/Sub-push: Authorization: Bearer <OIDC-token fra Google>. Signaturen
// (Googles offentlige certifikater), udløb, udsteder (accounts.google.com) og
// audience tjekkes af google-auth-library (verifyIdToken); derefter, som
// Googles vejledning siger, at email er push-abonnementets service account,
// og at email_verified er sand.
const oidcKlient = new OAuth2Client();

export async function verificerPubSubToken(k: GoogleKonfig, authorization: string | null): Promise<boolean> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec((authorization ?? "").trim());
  if (!m) return false;
  try {
    const ticket = await oidcKlient.verifyIdToken({ idToken: m[1], audience: k.pubsubAudience });
    const p = ticket.getPayload();
    if (!p) return false;
    if (p.iss !== "https://accounts.google.com" && p.iss !== "accounts.google.com") return false;
    if (p.email_verified !== true) return false;
    return (p.email ?? "").toLowerCase() === k.pubsubEmail;
  } catch {
    return false;
  }
}
