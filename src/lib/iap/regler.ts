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
  | "anden_konto" // købet er lavet på en anden BidHamr-konto
  | "konto_mangler"; // produktion: købet er ikke bundet til en konto (appAccountToken / obfuscatedAccountId mangler)

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

// Testkøb i produktion (IAP_TILLAD_TESTKOEB_TIL): kun et tidsvindue, der
// slutter i fremtiden og højst 14 dage frem. Alt andet (tomt, ugyldig dato,
// fortid, for langt frem) = slået fra (fail closed).
export const TESTKOEB_MAKS_DAGE = 14;
const ISO_DATO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function testkoebVindue(tekst: string, nuMs: number): { aabent: boolean; til: Date | null } {
  const t = tekst.trim();
  if (!ISO_DATO.test(t)) return { aabent: false, til: null };
  // Date.parse godtager fx 30. februar (ruller over) - tjek dagen selv.
  const [aar, maaned, dag] = t.slice(0, 10).split("-").map(Number);
  if (maaned < 1 || maaned > 12 || dag < 1 || dag > new Date(Date.UTC(aar, maaned, 0)).getUTCDate()) return { aabent: false, til: null };
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) return { aabent: false, til: null };
  if (ms <= nuMs || ms > nuMs + TESTKOEB_MAKS_DAGE * 24 * 3600 * 1000) return { aabent: false, til: null };
  return { aabent: true, til: new Date(ms) };
}

// IAP_TESTKOEB_KONTI: kommaseparerede bruger-id'er (uuid). Ugyldige id'er
// ignoreres.
export function testkoebKonti(tekst: string): Set<string> {
  const ud = new Set<string>();
  for (const del of tekst.split(",")) {
    const id = del.trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) ud.add(id);
  }
  return ud;
}

// Særlige køb, der ikke er almindelig omsætning (tælles for sig i "Boost-salg"):
//   testkoeb_prod  testkøb (Apple Sandbox / Googles licenstestere) i
//                  produktion - kan findes og trækkes tilbage samlet
//                  (boost_iap_tilbagekald_testkoeb)
//   promo          Google-køb med en promokode (purchaseType 1) - ikke betalt
export type IapMarkering = "testkoeb_prod" | "promo" | null;

// Det, købet tjekkes imod (fra serveren - aldrig fra klienten):
//   kontoToken  den indloggede brugers appAccountToken (HMAC af bruger-id'et)
//   kraevKonto  produktion: et køb uden kontobinding afvises (konto_mangler)
//   testkoeb    testkøb er tilladt for DENNE bruger
//   produktion  produktionsdatabasen (testkøb markeres testkoeb_prod)
export type IapForventet = {
  kontoToken: string;
  kraevKonto: boolean;
  testkoeb: boolean;
  produktion: boolean;
};

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
  markering: IapMarkering;
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
// appAccountToken sættes af appen ved købet til den værdi, GET
// /api/app/boost/iap gav (forventet.kontoToken - en HMAC af bruger-id'et).
// Står der en anden værdi, er købet lavet på en anden konto. Mangler den, er
// købet ikke bundet til en konto og afvises i produktion.
export function vurderAppleTransaktion(
  tx: AppleTransaktion,
  forventet: IapForventet & { bundleId: string; tilladte: readonly string[] },
): IapVurdering<IapKoeb> {
  if (!tx.transactionId || !TAL_ID.test(tx.transactionId)) return fejl("ugyldigt_koeb", "transactionId mangler");
  if (tx.bundleId !== forventet.bundleId) return fejl("ugyldigt_koeb", "forkert bundle");
  if (!tx.environment || !forventet.tilladte.includes(tx.environment)) return fejl("forkert_miljoe", `miljø ${tx.environment ?? "?"}`);
  // Sandbox er et testkøb: kun for konti, der må lave testkøb.
  const test = tx.environment !== "Production";
  if (test && !forventet.testkoeb) return fejl("forkert_miljoe", "testkøb er ikke tilladt for kontoen");
  if (!tx.productId || !PRODUKT_ID_RE.test(tx.productId)) return fejl("produkt_ukendt", "ukendt produkt");
  if (tx.type !== "Consumable") return fejl("ikke_forbrug", `type ${tx.type ?? "?"}`);
  if ((tx.quantity ?? 1) !== 1) return fejl("antal", `antal ${tx.quantity}`);
  if (tx.inAppOwnershipType !== undefined && tx.inAppOwnershipType !== "PURCHASED") {
    return fejl("ugyldigt_koeb", `ejerskab ${tx.inAppOwnershipType}`);
  }
  if (tx.revocationDate !== undefined && tx.revocationDate !== null) return fejl("refunderet", "tilbagekaldt");
  if (typeof tx.purchaseDate !== "number" || !Number.isFinite(tx.purchaseDate)) return fejl("ugyldigt_koeb", "købsdato mangler");
  if (!tx.appAccountToken) {
    if (forventet.kraevKonto) return fejl("konto_mangler", "appAccountToken mangler");
  } else if (tx.appAccountToken.toLowerCase() !== forventet.kontoToken.toLowerCase()) {
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
      miljoe: test ? "test" : "produktion",
      koebtKl: new Date(tx.purchaseDate).toISOString(),
      ...pris,
      land: /^[A-Z]{3}$/.test(tx.storefront ?? "") ? (tx.storefront as string) : null,
      markering: test && forventet.produktion ? "testkoeb_prod" : null,
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
  forventet: IapForventet & { produktId: string; token: string; tokenHash: string },
): IapVurdering<IapKoeb & { forbrugt: boolean }> {
  if (p.productId !== undefined && p.productId !== forventet.produktId) return fejl("ugyldigt_koeb", "forkert produkt");
  if (p.purchaseState === 2) return fejl("afventer", "købet er ikke betalt endnu");
  if (p.purchaseState === 1) return fejl("annulleret", "købet er annulleret");
  if (p.purchaseState !== 0) return fejl("ugyldigt_koeb", `purchaseState ${p.purchaseState}`);
  // purchaseType er kun sat, når købet IKKE er gået gennem det almindelige
  // betalingsflow: 0 = testkøb (licenstester), 1 = promokode (ikke betalt -
  // gemmes med markeringen 'promo' og tælles ikke som omsætning i
  // "Boost-salg"), 2 = belønnet (reklame - ikke betalt, afvises). Ukendte
  // værdier afvises.
  let miljoe: "produktion" | "test" = "produktion";
  let markering: IapMarkering = null;
  if (p.purchaseType === 0) {
    if (!forventet.testkoeb) return fejl("forkert_miljoe", "testkøb er ikke tilladt for kontoen");
    miljoe = "test";
    markering = forventet.produktion ? "testkoeb_prod" : null;
  } else if (p.purchaseType === 1) {
    markering = "promo";
  } else if (p.purchaseType !== undefined && p.purchaseType !== null) {
    return fejl("ugyldigt_koeb", `purchaseType ${p.purchaseType}`);
  }
  if ((p.quantity ?? 1) !== 1) return fejl("antal", `antal ${p.quantity}`);
  if (!p.obfuscatedExternalAccountId) {
    if (forventet.kraevKonto) return fejl("konto_mangler", "obfuscatedExternalAccountId mangler");
  } else if (p.obfuscatedExternalAccountId.toLowerCase() !== forventet.kontoToken.toLowerCase()) {
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
      markering,
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
