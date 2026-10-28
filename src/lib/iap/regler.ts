// Rene regler for køb af boost-point i appen (Apple og Google). Ingen
// netværk, ingen database og ingen hemmeligheder - enhedstestene bruger dem
// direkte. Alt her vurderer data, som SERVEREN har hentet og verificeret hos
// Apple/Google - aldrig klientens egne påstande.

// Fejlkoderne til appen (docs/APP-ENDPOINTS.md).
export type IapFejlKode =
  | "ugyldig" // kroppen er forkert
  | "ugyldigt_koeb" // købet kan ikke verificeres (forfalsket, forkert app, ukendt hos Apple/Google)
  | "forkert_miljoe" // Sandbox/testkøb på produktion (eller omvendt)
  | "produkt_ukendt" // ikke et af vores produkter
  | "ikke_forbrug" // ikke et forbrugsprodukt
  | "antal" // mere end ét stk. i samme køb
  | "afventer" // Google: købet er ikke betalt endnu (pending)
  | "annulleret" // Google: købet er annulleret
  | "refunderet" // købet er refunderet/tilbagekaldt
  | "anden_konto"; // købet er lavet på en anden BidHamr-konto

export type IapVurdering<T> = { ok: true; data: T } | { ok: false; kode: IapFejlKode; grund: string };

const fejl = (kode: IapFejlKode, grund: string): { ok: false; kode: IapFejlKode; grund: string } => ({
  ok: false,
  kode,
  grund,
});

export const PRODUKT_ID_RE = /^dk\.bidhamr\.app\.[a-z0-9_]{1,40}$/;
// Googles purchaseToken: bogstaver, cifre og . _ - (og : i ældre tokens).
export const GOOGLE_TOKEN_RE = /^[A-Za-z0-9._:-]{10,2000}$/;
// En JWS: tre base64url-dele (Apple: header med x5c-kæden, payload, signatur).
export const JWS_RE = /^[A-Za-z0-9_-]{10,20000}\.[A-Za-z0-9_-]{10,40000}\.[A-Za-z0-9_-]{10,2000}$/;

export type IapKrop =
  | { platform: "ios"; signedTransaction: string }
  | { platform: "android"; productId: string; purchaseToken: string };

// POST /api/app/boost/iap - kroppen. Kun de kendte felter; alt andet afvises.
export function laesIapKrop(krop: Record<string, unknown>): IapKrop | null {
  const n = Object.keys(krop);
  if (krop.platform === "ios") {
    if (n.some((k) => k !== "platform" && k !== "signedTransaction")) return null;
    const s = krop.signedTransaction;
    if (typeof s !== "string" || !JWS_RE.test(s)) return null;
    return { platform: "ios", signedTransaction: s };
  }
  if (krop.platform === "android") {
    if (n.some((k) => k !== "platform" && k !== "productId" && k !== "purchaseToken")) return null;
    const p = krop.productId;
    const t = krop.purchaseToken;
    if (typeof p !== "string" || !PRODUKT_ID_RE.test(p)) return null;
    if (typeof t !== "string" || !GOOGLE_TOKEN_RE.test(t)) return null;
    return { platform: "android", productId: p, purchaseToken: t };
  }
  return null;
}

// Det, krediteringen skal bruge (boost_iap_krediter).
export type IapKoeb = {
  platform: "ios" | "android";
  eksternId: string;
  originalId: string | null;
  googleToken: string | null;
  produktId: string;
  miljoe: "produktion" | "test";
  koebtKl: string;
  prisMilli: number | null;
  valuta: string | null;
  land: string | null;
};

// Apples dekodede transaktion (JWSTransactionDecodedPayload) - kun felterne,
// vi bruger. Signatur, bundle og miljø er allerede tjekket af
// SignedDataVerifier (certifikatkæden til Apple Root CA - G3).
export type AppleTransaktion = {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  quantity?: number;
  type?: string;
  appAccountToken?: string;
  inAppOwnershipType?: string;
  revocationDate?: number;
  revocationReason?: number;
  revocationType?: string;
  revocationPercentage?: number;
  environment?: string;
  storefront?: string;
  currency?: string;
  price?: number;
};

const TAL_ID = /^\d{1,30}$/;

// Vurderer Apples transaktion (som hentet med Get Transaction Info).
// brugerId: den indloggede BidHamr-bruger. appAccountToken sættes af appen
// til brugerens id ved købet; står der et andet id, er købet lavet på en
// anden konto.
export function vurderAppleTransaktion(
  tx: AppleTransaktion,
  forventet: { bundleId: string; brugerId: string; tilladte: readonly string[] },
): IapVurdering<IapKoeb> {
  if (!tx.transactionId || !TAL_ID.test(tx.transactionId)) return fejl("ugyldigt_koeb", "transactionId mangler");
  if (tx.bundleId !== forventet.bundleId) return fejl("ugyldigt_koeb", "forkert bundle");
  if (!tx.environment || !forventet.tilladte.includes(tx.environment)) return fejl("forkert_miljoe", `miljø ${tx.environment ?? "?"}`);
  if (!tx.productId || !PRODUKT_ID_RE.test(tx.productId)) return fejl("produkt_ukendt", "ukendt produkt");
  if (tx.type !== "Consumable") return fejl("ikke_forbrug", `type ${tx.type ?? "?"}`);
  if ((tx.quantity ?? 1) !== 1) return fejl("antal", `antal ${tx.quantity}`);
  if (tx.inAppOwnershipType !== undefined && tx.inAppOwnershipType !== "PURCHASED") {
    return fejl("ugyldigt_koeb", `ejerskab ${tx.inAppOwnershipType}`);
  }
  if (tx.revocationDate !== undefined && tx.revocationDate !== null) return fejl("refunderet", "tilbagekaldt");
  if (typeof tx.purchaseDate !== "number" || !Number.isFinite(tx.purchaseDate)) return fejl("ugyldigt_koeb", "købsdato mangler");
  if (tx.appAccountToken && tx.appAccountToken.toLowerCase() !== forventet.brugerId.toLowerCase()) {
    return fejl("anden_konto", "appAccountToken passer ikke");
  }
  const pris =
    typeof tx.price === "number" && Number.isSafeInteger(tx.price) && tx.price >= 0 && /^[A-Z]{3}$/.test(tx.currency ?? "")
      ? { prisMilli: tx.price, valuta: tx.currency as string }
      : { prisMilli: null, valuta: null };
  return {
    ok: true,
    data: {
      platform: "ios",
      eksternId: tx.transactionId,
      originalId: tx.originalTransactionId && TAL_ID.test(tx.originalTransactionId) ? tx.originalTransactionId : null,
      googleToken: null,
      produktId: tx.productId,
      miljoe: tx.environment === "Production" ? "produktion" : "test",
      koebtKl: new Date(tx.purchaseDate).toISOString(),
      ...pris,
      land: /^[A-Z]{3}$/.test(tx.storefront ?? "") ? (tx.storefront as string) : null,
    },
  };
}

// Den del af købet, der er refunderet, i milliunits (100000 = alt) - som
// boost_iap_refusion skal bruge. Apple: REFUND_PRORATED med
// revocationPercentage (milliunits); alt andet (REFUND_FULL, ingen type) =
// hele købet.
export function appleRefunderetAndel(tx: Pick<AppleTransaktion, "revocationType" | "revocationPercentage">): number {
  if (tx.revocationType === "REFUND_PRORATED") {
    const p = tx.revocationPercentage;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) return Math.min(100000, Math.ceil(p));
  }
  return 100000;
}

// Googles ProductPurchase (purchases.products.get) - kun felterne, vi bruger.
export type GoogleKoeb = {
  purchaseState?: number;
  consumptionState?: number;
  purchaseType?: number;
  orderId?: string;
  quantity?: number;
  purchaseTimeMillis?: string;
  obfuscatedExternalAccountId?: string;
  regionCode?: string;
  productId?: string;
};

// Idempotens-nøglen for et Google-køb: orderId. Mangler den (kan ske for
// testkøb), bruges en hash af tokenet, som serveren regner ud.
export function vurderGoogleKoeb(
  p: GoogleKoeb,
  forventet: { produktId: string; brugerId: string; tilladTestkoeb: boolean; token: string; tokenHash: string },
): IapVurdering<IapKoeb & { forbrugt: boolean }> {
  if (p.productId !== undefined && p.productId !== forventet.produktId) return fejl("ugyldigt_koeb", "forkert produkt");
  if (p.purchaseState === 2) return fejl("afventer", "købet er ikke betalt endnu");
  if (p.purchaseState === 1) return fejl("annulleret", "købet er annulleret");
  if (p.purchaseState !== 0) return fejl("ugyldigt_koeb", `purchaseState ${p.purchaseState}`);
  let miljoe: "produktion" | "test" = "produktion";
  if (p.purchaseType === 0) {
    if (!forventet.tilladTestkoeb) return fejl("forkert_miljoe", "testkøb på produktion");
    miljoe = "test";
  } else if (p.purchaseType !== undefined && p.purchaseType !== null && p.purchaseType !== 1) {
    // 2 = belønnet (reklame) - ikke betalt.
    return fejl("ugyldigt_koeb", `purchaseType ${p.purchaseType}`);
  }
  if ((p.quantity ?? 1) !== 1) return fejl("antal", `antal ${p.quantity}`);
  if (p.obfuscatedExternalAccountId && p.obfuscatedExternalAccountId.toLowerCase() !== forventet.brugerId.toLowerCase()) {
    return fejl("anden_konto", "obfuscatedExternalAccountId passer ikke");
  }
  const tid = Number(p.purchaseTimeMillis);
  if (!Number.isFinite(tid) || tid <= 0) return fejl("ugyldigt_koeb", "købstid mangler");
  const ordre = typeof p.orderId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(p.orderId) ? p.orderId : `token:${forventet.tokenHash}`;
  return {
    ok: true,
    data: {
      platform: "android",
      eksternId: ordre,
      originalId: null,
      googleToken: forventet.token,
      produktId: forventet.produktId,
      miljoe,
      koebtKl: new Date(tid).toISOString(),
      prisMilli: null,
      valuta: null,
      land: /^[A-Z]{2}$/.test(p.regionCode ?? "") ? (p.regionCode as string) : null,
      forbrugt: p.consumptionState === 1,
    },
  };
}

// Googles RTDN (DeveloperNotification efter base64-afkodning af
// message.data). Kun det, vi bruger.
export type GoogleRtdn =
  | { slags: "test" }
  | { slags: "void"; purchaseToken: string; orderId: string | null; engangskoeb: boolean }
  | { slags: "andet" };

export function laesGoogleRtdn(n: unknown, pakke: string): GoogleRtdn | null {
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  if (o.packageName !== pakke) return null;
  if (o.testNotification && typeof o.testNotification === "object") return { slags: "test" };
  const v = o.voidedPurchaseNotification as Record<string, unknown> | undefined;
  if (v && typeof v === "object") {
    if (typeof v.purchaseToken !== "string" || !GOOGLE_TOKEN_RE.test(v.purchaseToken)) return null;
    const orderId = typeof v.orderId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(v.orderId) ? v.orderId : null;
    // productType 2 = engangskøb (1 = abonnement - vi har ingen).
    return { slags: "void", purchaseToken: v.purchaseToken, orderId, engangskoeb: Number(v.productType) === 2 };
  }
  return { slags: "andet" };
}
