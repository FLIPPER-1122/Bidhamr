// Køb af boost-point i appen (Apple In-App Purchase og Google Play Billing):
// POST/GET /api/app/boost/iap, POST /api/webhooks/apple og
// POST /api/webhooks/google-play med falske Apple- og Google-svar.
//
// Apple: en falsk certifikatkæde (rod -> "WWDR" -> leaf med Apples OID'er)
// laves i testen med jsrsasign, og den RIGTIGE verificering i Apples
// bibliotek (SignedDataVerifier) bruges mod den falske rod. Get Transaction
// Info er stubbet. En kæde, der ikke ender i roden, og den rigtige Apple
// Root CA - G3 mod den falske kæde afvises.
// Google: fetch til androidpublisher er stubbet; Pub/Sub-OIDC-tokenet
// verificeres af google-auth-library med en testnøgle i stedet for Googles
// offentlige certifikater.
// Databasen er en lille falsk i hukommelsen med samme svar som
// 20261102320000_boost_iap.sql (selve SQL'en testes i
// tests/penge-db/boostIap.test.ts).
import { createSign, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { KJUR } from "jsrsasign";
import { AppStoreServerAPIClient, APIException } from "@apple/app-store-server-library";
import { JWT, OAuth2Client } from "google-auth-library";

const PRIVAT = "11111111-1111-4111-8111-111111111111";
const PRIVAT2 = "22222222-2222-4222-8222-222222222222";
const FIRMA = "33333333-3333-4333-8333-333333333333";
const TOKENS: Record<string, string> = { "a.a.a": PRIVAT, "b.b.b": PRIVAT2, "f.f.f": FIRMA };
const BUNDLE = "dk.bidhamr.app";
const APP_ID = 6700000000;

// ------------------------------------------------------------ falsk database
const db = vi.hoisted(() => {
  type Koeb = { id: string; bruger: string; platform: string; ekstern: string; token: string | null; produkt: string; point: number; refunderet: number; forbrugt: boolean };
  const s = {
    koeb: [] as Koeb[],
    ventende: [] as { platform: string; ekstern: string | null; token: string | null }[],
    claim: true,
    saldo: new Map<string, number>(),
    notifikationer: new Map<string, boolean>(),
    rpc: [] as { navn: string; args: Record<string, unknown> }[],
    drift: [] as { hvor?: string; fejl?: unknown; brugerId?: string }[],
  };
  const PRODUKTER: Record<string, number> = { "dk.bidhamr.app.boost100": 100, "dk.bidhamr.app.boost300": 300, "dk.bidhamr.app.boost700": 700 };
  function rpc(navn: string, a: Record<string, unknown>) {
    s.rpc.push({ navn, args: a });
    const saldo = (b: string) => s.saldo.get(b) ?? 0;
    switch (navn) {
      case "boost_bruger_spaerret":
        return a.p_bruger === "33333333-3333-4333-8333-333333333333" ? "erhverv" : null;
      case "boost_iap_krediter": {
        const k = s.koeb.find((x) => (x.platform === a.p_platform && x.ekstern === a.p_ekstern_id) || (a.p_google_token && x.token === a.p_google_token));
        if (k) return k.bruger !== a.p_bruger ? { kode: "anden_bruger" } : { kode: "allerede", id: k.id, point: k.point, forbrugt: k.forbrugt, saldo: saldo(k.bruger) };
        if (s.ventende.some((v) => v.platform === a.p_platform && ((v.ekstern && v.ekstern === a.p_ekstern_id) || (v.token && v.token === a.p_google_token)))) {
          return { kode: "refunderet" };
        }
        if (a.p_bruger === "33333333-3333-4333-8333-333333333333") return { kode: "erhverv" };
        const point = PRODUKTER[String(a.p_produkt)];
        if (!point) return { kode: "produkt_ukendt" };
        const ny: Koeb = { id: `k${s.koeb.length + 1}`, bruger: String(a.p_bruger), platform: String(a.p_platform), ekstern: String(a.p_ekstern_id), token: (a.p_google_token as string) ?? null, produkt: String(a.p_produkt), point, refunderet: 0, forbrugt: false };
        s.koeb.push(ny);
        s.saldo.set(ny.bruger, saldo(ny.bruger) + point);
        return { kode: "ok", id: ny.id, point, saldo: saldo(ny.bruger) };
      }
      case "boost_iap_forbrug_resultat": {
        const k = s.koeb.find((x) => x.id === a.p_id);
        if (k && a.p_ok) k.forbrugt = true;
        return true;
      }
      case "boost_iap_refusion": {
        const k = s.koeb.find((x) => x.platform === a.p_platform && ((a.p_ekstern_id && x.ekstern === a.p_ekstern_id) || (a.p_google_token && x.token === a.p_google_token)));
        if (!k) {
          const findes = s.ventende.some((v) => v.platform === a.p_platform && ((a.p_ekstern_id && v.ekstern === a.p_ekstern_id) || (a.p_google_token && v.token === a.p_google_token)));
          if (!findes) s.ventende.push({ platform: String(a.p_platform), ekstern: (a.p_ekstern_id as string) ?? null, token: (a.p_google_token as string) ?? null });
          return { kode: "ukendt", ventende: true };
        }
        const maal = Math.min(Math.ceil((k.point * Number(a.p_andel_milli)) / 100000), k.point);
        const delta = maal - k.refunderet;
        if (delta <= 0) return { kode: "allerede", id: k.id, bruger_id: k.bruger, saldo: saldo(k.bruger) };
        k.refunderet = maal;
        s.saldo.set(k.bruger, saldo(k.bruger) - delta);
        return { kode: "tilbagefoert", id: k.id, bruger_id: k.bruger, point: delta, saldo: saldo(k.bruger), i_minus: saldo(k.bruger) < 0 };
      }
      case "boost_iap_opmaerksomhed": {
        const k = s.koeb.find((x) => x.platform === a.p_platform && x.ekstern === a.p_ekstern_id);
        return k?.bruger ?? null;
      }
      case "boost_iap_notifikation_start": {
        const n = `${a.p_platform}|${a.p_id}`;
        if (!s.notifikationer.has(n)) {
          s.notifikationer.set(n, false);
          return "ny";
        }
        return s.notifikationer.get(n) ? "behandlet" : "gentaget";
      }
      case "boost_iap_notifikation_slut":
        s.notifikationer.set(`${a.p_platform}|${a.p_id}`, true);
        return null;
      case "boost_iap_ventende_ophaev": {
        const i = s.ventende.findIndex((v) => v.platform === a.p_platform && v.ekstern === a.p_ekstern_id);
        if (i < 0) return false;
        s.ventende.splice(i, 1);
        return true;
      }
      case "boost_iap_cron_claim":
        return s.claim;
      case "boost_iap_cron_ok":
        return null;
      case "boost_iap_mangler_forbrug":
        return [];
      default:
        throw new Error(`ukendt rpc ${navn}`);
    }
  }
  const klient = {
    rpc: async (navn: string, a: Record<string, unknown>) => ({ data: rpc(navn, a), error: null }),
    from: (tabel: string) => {
      const filter: Record<string, unknown> = {};
      const b = {
        select: () => b,
        eq: (k: string, v: unknown) => {
          filter[k] = v;
          return b;
        },
        order: async () => ({
          data: Object.entries(PRODUKTER).map(([produkt_id, point]) => ({ produkt_id, point })),
          error: null,
        }),
        maybeSingle: async () => {
          if (tabel !== "boost_iap_koeb") throw new Error(`ukendt tabel ${tabel}`);
          const k = s.koeb.find((x) => x.platform === filter.platform && x.token === filter.google_token);
          return { data: k ? { produkt_id: k.produkt } : null, error: null };
        },
      };
      return b;
    },
  };
  return { s, klient };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "127.0.0.9" }) }));
vi.mock("@/lib/rateLimit", () => ({
  FOR_MANGE_FORSOEG: "For mange forsøg.",
  klientIpNoegle: async () => "127.0.0.9",
  tjekGraenser: async () => true,
}));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async (x: { hvor?: string; fejl?: unknown; brugerId?: string }) => {
    db.s.drift.push(x);
    return null;
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.klient }));
vi.mock("@/lib/appApi", async (orig) => ({
  ...(await orig<typeof import("@/lib/appApi")>()),
  appBruger: async (token: string) => (TOKENS[token] ? { bruger: { id: TOKENS[token] }, supabase: {} } : null),
}));

// ------------------------------------------------------------ falsk Apple
const pemNoegle = () => {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { pub: k.publicKey.export({ type: "spki", format: "pem" }) as string, prv: k.privateKey, prvPem: k.privateKey.export({ type: "pkcs8", format: "pem" }) as string };
};
function cert(subj: string, iss: string, pub: string, cakey: string, ca: boolean, oid?: string): string {
  return new KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: Math.floor(Math.random() * 1e9) },
    issuer: { str: iss },
    subject: { str: subj },
    notbefore: "200101000000Z",
    notafter: "400101000000Z",
    sbjpubkey: pub,
    ext: [{ extname: "basicConstraints", cA: ca, critical: true }, ...(oid ? [{ extname: oid, extn: "0500" }] : [])],
    sigalg: "SHA256withECDSA",
    cakey,
  } as unknown as ConstructorParameters<typeof KJUR.asn1.x509.Certificate>[0]).getPEM();
}
const derB64 = (p: string) => p.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");

type Kaede = { leafKey: KeyObject; x5c: string[]; rootDer: Buffer };
function lavKaede(): Kaede {
  const r = pemNoegle();
  const i = pemNoegle();
  const l = pemNoegle();
  const rc = cert("/CN=Falsk rod", "/CN=Falsk rod", r.pub, r.prvPem, true);
  const ic = cert("/CN=Falsk WWDR", "/CN=Falsk rod", i.pub, r.prvPem, true, "1.2.840.113635.100.6.2.1");
  const lc = cert("/CN=Falsk leaf", "/CN=Falsk WWDR", l.pub, i.prvPem, false, "1.2.840.113635.100.6.11.1");
  return { leafKey: l.prv, x5c: [derB64(lc), derB64(ic), derB64(rc)], rootDer: Buffer.from(derB64(rc), "base64") };
}
function jws(k: Kaede, payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", x5c: k.x5c })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = cryptoSign("sha256", Buffer.from(`${h}.${p}`), { key: k.leafKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
}

let kaede: Kaede;
let fremmedKaede: Kaede;
let txNr = 2000000000;
const appleSvar = new Map<string, string>();

function tx(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionId: String(++txNr),
    originalTransactionId: String(txNr),
    bundleId: BUNDLE,
    productId: "dk.bidhamr.app.boost300",
    purchaseDate: Date.now() - 1000,
    signedDate: Date.now(),
    quantity: 1,
    type: "Consumable",
    inAppOwnershipType: "PURCHASED",
    environment: "Production",
    storefront: "DNK",
    currency: "DKK",
    price: 99000,
    appAccountToken: KT(PRIVAT),
    ...o,
  };
}
// Appens JWS + Apples svar på Get Transaction Info (samme eller ændret).
function appleKoeb(o: Record<string, unknown> = {}, hosApple: Record<string, unknown> = {}) {
  const t = tx(o);
  appleSvar.set(String(t.transactionId), jws(kaede, { ...t, signedDate: Date.now(), ...hosApple }));
  return { t, signeret: jws(kaede, t) };
}

// ------------------------------------------------------------ falsk Google
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OIDC_KID = "testkid";
const AUD = "https://test.bidhamr.dk/api/webhooks/google-play";
const SA = "pubsub-push@bidhamr.iam.gserviceaccount.com";
function oidc(o: Record<string, unknown> = {}): string {
  const nu = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: OIDC_KID, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(
    JSON.stringify({ aud: AUD, iss: "https://accounts.google.com", email: SA, email_verified: true, iat: nu - 10, exp: nu + 3000, sub: "1", ...o }),
  ).toString("base64url");
  const s = createSign("RSA-SHA256").update(`${h}.${p}`).sign(rsa.privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}
const google = new Map<string, Record<string, unknown>>();
const googleKald: { metode: string; url: string }[] = [];
// Googles Voided Purchases API (falsk).
const voidedListe: { purchaseToken: string; orderId: string; voidedTimeMillis: string }[] = [];

// ------------------------------------------------------------ opsætning
const ENV = {
  APPLE_IAP_ISSUER_ID: "57246542-96fe-1a63-e053-0824d011072a",
  APPLE_IAP_KEY_ID: "ABCDE12345",
  APPLE_BUNDLE_ID: BUNDLE,
  APPLE_APP_APPLE_ID: String(APP_ID),
  APPLE_IAP_MILJOE: "Production",
  GOOGLE_PLAY_PACKAGE: BUNDLE,
  GOOGLE_PUBSUB_AUDIENCE: AUD,
  GOOGLE_PUBSUB_SA_EMAIL: SA,
};

let ruter: {
  iap: typeof import("@/app/api/app/boost/iap/route");
  apple: typeof import("@/app/api/webhooks/apple/route");
  googlePlay: typeof import("@/app/api/webhooks/google-play/route");
  saetRod: typeof import("@/lib/iap/apple").__saetAppleTestRod;
  konfig: typeof import("@/lib/iap/konfig");
  server: typeof import("@/lib/iap/server");
  regler: typeof import("@/lib/iap/regler");
};

// Kontobindingen (appAccountToken) for en bruger - regnet ud af serveren.
const HEMMELIGHED = "test-hemmelighed-til-iap-kontobinding-0123456789";
const KT = (id: string) => ruter.konfig.kontoToken(id) as string;
const historik = new Map<string, string[]>();
const historikKald: { side: string | null; type: string; fra: number; til: number }[] = [];

beforeAll(async () => {
  kaede = lavKaede();
  fremmedKaede = lavKaede();
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://eksempel.supabase.co"); // ikke testdatabasen
  // Det gamle flag virker ikke længere (sat her for at vise det).
  vi.stubEnv("IAP_TILLAD_TESTKOEB", "1");
  vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", "");
  vi.stubEnv("IAP_TESTKOEB_KONTI", "");
  vi.stubEnv("IAP_KONTO_HEMMELIGHED", HEMMELIGHED);
  vi.stubEnv("APPLE_IAP_PRIVATE_KEY", pemNoegle().prvPem);
  vi.stubEnv(
    "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
    JSON.stringify({
      client_email: "play-api@bidhamr.iam.gserviceaccount.com",
      private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  vi.spyOn(AppStoreServerAPIClient.prototype, "getTransactionInfo").mockImplementation(async (id: string) => {
    const s = appleSvar.get(id);
    if (!s) throw new APIException(404, 4040010, "Transaction id not found.");
    return { signedTransactionInfo: s };
  });
  vi.spyOn(AppStoreServerAPIClient.prototype, "getNotificationHistory").mockImplementation(async (side, req) => {
    historikKald.push({ side, type: String(req.notificationType), fra: Number(req.startDate), til: Number(req.endDate) });
    const alle = historik.get(String(req.notificationType)) ?? [];
    // To sider: første halvdel, så resten.
    const halv = Math.ceil(alle.length / 2);
    const del = side ? alle.slice(halv) : alle.slice(0, halv);
    return { notificationHistory: del.map((signedPayload) => ({ signedPayload })), hasMore: !side && alle.length > 1, paginationToken: side ? undefined : "side2" };
  });
  vi.spyOn(JWT.prototype, "getAccessToken").mockImplementation((async () => ({ token: "falsk-adgang", res: null })) as never);
  vi.spyOn(OAuth2Client.prototype, "getFederatedSignonCertsAsync").mockResolvedValue({
    certs: { [OIDC_KID]: rsa.publicKey.export({ type: "spki", format: "pem" }) as string },
    format: "PEM" as never,
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const metode = init?.method ?? "GET";
    googleKald.push({ metode, url });
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (auth !== "Bearer falsk-adgang") return new Response("{}", { status: 401 });
    if (/\/purchases\/voidedpurchases\?/.test(url)) return Response.json({ voidedPurchases: voidedListe });
    const m = /\/applications\/([^/]+)\/purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:consume)?$/.exec(url);
    if (!m || decodeURIComponent(m[1]) !== BUNDLE) return new Response("{}", { status: 404 });
    const p = google.get(decodeURIComponent(m[3]));
    if (!p || p.productId !== decodeURIComponent(m[2])) return new Response("{}", { status: 404 });
    if (m[4]) {
      p.consumptionState = 1;
      return new Response("", { status: 200 });
    }
    return Response.json({ kind: "androidpublisher#productPurchase", ...p });
  });
  ruter = {
    iap: await import("@/app/api/app/boost/iap/route"),
    apple: await import("@/app/api/webhooks/apple/route"),
    googlePlay: await import("@/app/api/webhooks/google-play/route"),
    saetRod: (await import("@/lib/iap/apple")).__saetAppleTestRod,
    konfig: await import("@/lib/iap/konfig"),
    server: await import("@/lib/iap/server"),
    regler: await import("@/lib/iap/regler"),
  };
  ruter.saetRod([kaede.rootDer]);
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  db.s.rpc = [];
  db.s.drift = [];
  googleKald.length = 0;
});

async function koeb(krop: unknown, token: string | null = "a.a.a") {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await ruter.iap.POST(new NextRequest("http://localhost/api/app/boost/iap", { method: "POST", body: JSON.stringify(krop), headers }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const ios = (signeret: string) => ({ platform: "ios", signedTransaction: signeret });
const rpcNavne = () => db.s.rpc.map((r) => r.navn);

// ============================================================ Apple
describe("POST /api/app/boost/iap - Apple", () => {
  it("gyldigt køb: point fra produktet krediteres, svaret har saldoen", async () => {
    const { t, signeret } = appleKoeb();
    const r = await koeb(ios(signeret));
    expect(r).toEqual({ status: 200, body: { ok: true, kode: "ok", point: 300, saldo: 300 } });
    const k = db.s.rpc.find((x) => x.navn === "boost_iap_krediter")!.args;
    expect(k).toMatchObject({ p_bruger: PRIVAT, p_platform: "ios", p_ekstern_id: t.transactionId, p_produkt: "dk.bidhamr.app.boost300", p_miljoe: "produktion", p_pris_milli: 99000, p_valuta: "DKK", p_land: "DNK", p_google_token: null });
    // Klienten sender ingen point eller pris - og krediteringen får ingen.
    expect(Object.keys(k)).not.toContain("p_point");
    // Samme transaktion igen: ingen nye point.
    expect(await koeb(ios(signeret))).toEqual({ status: 200, body: { ok: true, kode: "allerede", point: 300, saldo: 300 } });
    // ... og ikke til en anden bruger.
    expect((await koeb(ios(signeret), "b.b.b")).body.kode).toBe("anden_konto");
  });

  it("forkert bundle afvises (422)", async () => {
    const { signeret } = appleKoeb({ bundleId: "dk.andenapp.app" });
    const r = await koeb(ios(signeret));
    expect(r.status).toBe(422);
    expect(r.body.kode).toBe("ugyldigt_koeb");
    expect(rpcNavne()).not.toContain("boost_iap_krediter");
  });

  it("Sandbox mod produktion afvises (409 forkert_miljoe)", async () => {
    const { signeret } = appleKoeb({ environment: "Sandbox" });
    const r = await koeb(ios(signeret));
    expect(r).toMatchObject({ status: 409, body: { kode: "forkert_miljoe" } });
    expect(rpcNavne()).not.toContain("boost_iap_krediter");
  });

  it("forfalsket JWS (kæde, der ikke ender i roden) afvises", async () => {
    const r = await koeb(ios(jws(fremmedKaede, tx())));
    expect(r).toMatchObject({ status: 422, body: { kode: "ugyldigt_koeb" } });
  });

  it("ændret payload (signaturen passer ikke) afvises", async () => {
    const { signeret } = appleKoeb();
    const [h, p, s] = signeret.split(".");
    const ny = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), productId: "dk.bidhamr.app.boost700" })).toString("base64url");
    const r = await koeb(ios(`${h}.${ny}.${s}`));
    expect(r).toMatchObject({ status: 422, body: { kode: "ugyldigt_koeb" } });
  });

  it("den rigtige Apple Root CA - G3 godtager ikke den falske kæde", async () => {
    ruter.saetRod(null);
    try {
      const { signeret } = appleKoeb();
      const r = await koeb(ios(signeret));
      expect(r).toMatchObject({ status: 422, body: { kode: "ugyldigt_koeb" } });
    } finally {
      ruter.saetRod([kaede.rootDer]);
    }
  });

  it("refunderet hos Apple (Get Transaction Info) giver ingen point", async () => {
    const { signeret } = appleKoeb({}, { revocationDate: Date.now(), revocationReason: 0 });
    expect(await koeb(ios(signeret))).toMatchObject({ status: 409, body: { kode: "refunderet" } });
  });

  it("ukendt hos Apple (404) afvises", async () => {
    const signeret = jws(kaede, tx());
    expect(await koeb(ios(signeret))).toMatchObject({ status: 422, body: { kode: "ugyldigt_koeb" } });
  });

  it("appAccountToken for en anden konto afvises", async () => {
    const { signeret } = appleKoeb({ appAccountToken: KT(PRIVAT2) });
    expect(await koeb(ios(signeret))).toMatchObject({ status: 409, body: { kode: "anden_konto" } });
  });

  it("ikke et forbrugsprodukt og flere stk. afvises", async () => {
    expect((await koeb(ios(appleKoeb({ type: "Non-Consumable" }).signeret))).body.kode).toBe("ikke_forbrug");
    expect((await koeb(ios(appleKoeb({ quantity: 2 }).signeret))).body.kode).toBe("antal");
  });

  it("firma: verificeret køb afvises (403), og chefen får en drift-note (brugeren har betalt)", async () => {
    const { t, signeret } = appleKoeb({ appAccountToken: KT(FIRMA) });
    const r = await koeb(ios(signeret), "f.f.f");
    expect(r).toMatchObject({ status: 403, body: { kode: "erhverv" } });
    const d = db.s.drift.find((x) => x.hvor === "boost/iap-afvist-betalt");
    expect(d).toMatchObject({ brugerId: FIRMA });
    expect(String(d?.fejl)).toMatch(/firmakonto har betalt Apple/);
    expect(String(d?.fejl)).toContain(String(t.transactionId).slice(0, 12));
    expect(db.s.koeb.some((k) => k.bruger === FIRMA)).toBe(false);
  });

  it("kontobindingen er påkrævet i produktion: uden appAccountToken 409 konto_mangler + drift-note", async () => {
    const { signeret } = appleKoeb({ appAccountToken: undefined });
    expect(await koeb(ios(signeret))).toMatchObject({ status: 409, body: { kode: "konto_mangler" } });
    expect(rpcNavne()).not.toContain("boost_iap_krediter");
    expect(db.s.drift.find((x) => x.hvor === "boost/iap-afvist-betalt")).toMatchObject({ brugerId: PRIVAT });
  });

  it("det rå bruger-id som appAccountToken godtages ikke (anden_konto)", async () => {
    const { signeret } = appleKoeb({ appAccountToken: PRIVAT });
    expect(await koeb(ios(signeret))).toMatchObject({ status: 409, body: { kode: "anden_konto" } });
  });

  it("på testdatabasen må kontobindingen mangle", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://pjiigmzqwlfepxnjdvug.supabase.co");
    try {
      const { signeret } = appleKoeb({ appAccountToken: undefined });
      expect((await koeb(ios(signeret))).status).toBe(200);
    } finally {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://eksempel.supabase.co");
    }
  });

  it("Sandbox-testkøb i produktion: kun med åbent vindue og for kontiene på listen - markeret testkoeb_prod", async () => {
    vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString());
    vi.stubEnv("IAP_TESTKOEB_KONTI", ` ${PRIVAT.toUpperCase()} , ikke-et-id`);
    try {
      const ok = await koeb(ios(appleKoeb({ environment: "Sandbox" }).signeret));
      expect(ok.status).toBe(200);
      expect(db.s.rpc.find((x) => x.navn === "boost_iap_krediter")?.args).toMatchObject({ p_miljoe: "test", p_markering: "testkoeb_prod" });
      // En konto, der ikke er på listen.
      const anden = await koeb(ios(appleKoeb({ environment: "Sandbox", appAccountToken: KT(PRIVAT2) }).signeret), "b.b.b");
      expect(anden).toMatchObject({ status: 409, body: { kode: "forkert_miljoe" } });
      // Almindelige køb er stadig almindelige.
      db.s.rpc = [];
      expect((await koeb(ios(appleKoeb().signeret))).status).toBe(200);
      expect(db.s.rpc.find((x) => x.navn === "boost_iap_krediter")?.args).toMatchObject({ p_miljoe: "produktion", p_markering: null });
    } finally {
      vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", "");
      vi.stubEnv("IAP_TESTKOEB_KONTI", "");
    }
  });

  it("refunderet, før det blev krediteret (ventende refusion): 409 refunderet", async () => {
    const { t, signeret } = appleKoeb();
    db.s.ventende.push({ platform: "ios", ekstern: String(t.transactionId), token: null });
    expect(await koeb(ios(signeret))).toMatchObject({ status: 409, body: { kode: "refunderet" } });
  });

  it("uden login 401; ugyldig krop 400; ekstra felter (point) 400", async () => {
    expect((await koeb(ios(appleKoeb().signeret), null)).status).toBe(401);
    expect((await koeb({ platform: "ios" })).status).toBe(400);
    expect((await koeb({ ...ios(appleKoeb().signeret), point: 700 })).status).toBe(400);
    expect((await koeb({ platform: "web", signedTransaction: "x" })).status).toBe(400);
  });

  it("mangler Apple-opsætningen: 503 iap_ikke_klar", async () => {
    vi.stubEnv("APPLE_IAP_KEY_ID", "");
    try {
      expect(await koeb(ios(appleKoeb().signeret))).toMatchObject({ status: 503, body: { kode: "iap_ikke_klar" } });
    } finally {
      vi.stubEnv("APPLE_IAP_KEY_ID", ENV.APPLE_IAP_KEY_ID);
    }
  });
});

// ============================================================ Google
let tokNr = 0;
function googleKoeb(o: Record<string, unknown> = {}) {
  const token = `tok.${++tokNr}.ABCDEFGHIJ_kl-mn`;
  google.set(token, {
    productId: "dk.bidhamr.app.boost100",
    purchaseState: 0,
    consumptionState: 0,
    orderId: `GPA.3333-1234-5678-${String(10000 + tokNr)}`,
    purchaseTimeMillis: String(Date.now() - 1000),
    acknowledgementState: 0,
    regionCode: "DK",
    obfuscatedExternalAccountId: KT(PRIVAT),
    ...o,
  });
  return { platform: "android", productId: "dk.bidhamr.app.boost100", purchaseToken: token };
}

describe("POST /api/app/boost/iap - Google", () => {
  it("gyldigt køb: krediteres og forbruges (consume); igen = allerede, intet nyt consume", async () => {
    const k = googleKoeb({ obfuscatedExternalAccountId: KT(PRIVAT2) });
    const r = await koeb(k, "b.b.b");
    expect(r).toEqual({ status: 200, body: { ok: true, kode: "ok", point: 100, saldo: 100 } });
    expect(googleKald.map((x) => x.metode)).toEqual(["GET", "POST"]);
    expect(googleKald[1].url).toMatch(/:consume$/);
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_forbrug_resultat")?.args).toMatchObject({ p_ok: true });
    googleKald.length = 0;
    expect((await koeb(k, "b.b.b")).body.kode).toBe("allerede");
    expect(googleKald.map((x) => x.metode)).toEqual(["GET"]);
  });

  it("afventende, annulleret og testkøb på produktion afvises", async () => {
    expect(await koeb(googleKoeb({ purchaseState: 2 }))).toMatchObject({ status: 409, body: { kode: "afventer" } });
    expect(await koeb(googleKoeb({ purchaseState: 1 }))).toMatchObject({ status: 409, body: { kode: "annulleret" } });
    expect(await koeb(googleKoeb({ purchaseType: 0 }))).toMatchObject({ status: 409, body: { kode: "forkert_miljoe" } });
    expect(await koeb(googleKoeb({ purchaseType: 2 }))).toMatchObject({ status: 422, body: { kode: "ugyldigt_koeb" } });
    expect(rpcNavne()).not.toContain("boost_iap_krediter");
  });

  it("testkøb i produktion: IAP_TILLAD_TESTKOEB_TIL højst 14 dage frem + konto på listen", async () => {
    const dag = 24 * 3600 * 1000;
    vi.stubEnv("IAP_TESTKOEB_KONTI", `${PRIVAT},${FIRMA}`);
    try {
      // Det gamle flag (IAP_TILLAD_TESTKOEB=1 er sat) og intet vindue: afvist.
      expect(await koeb(googleKoeb({ purchaseType: 0 }))).toMatchObject({ status: 409, body: { kode: "forkert_miljoe" } });
      for (const til of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 15 * dag).toISOString(), "i morgen", "2026-13-45"]) {
        vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", til);
        expect(await koeb(googleKoeb({ purchaseType: 0 })), til).toMatchObject({ status: 409, body: { kode: "forkert_miljoe" } });
      }
      vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", new Date(Date.now() + 13 * dag).toISOString());
      expect((await koeb(googleKoeb({ purchaseType: 0 }))).status).toBe(200);
      expect(db.s.rpc.find((x) => x.navn === "boost_iap_krediter")?.args).toMatchObject({ p_miljoe: "test", p_markering: "testkoeb_prod" });
      // PRIVAT2 er ikke på listen.
      expect(await koeb(googleKoeb({ purchaseType: 0, obfuscatedExternalAccountId: KT(PRIVAT2) }), "b.b.b")).toMatchObject({
        status: 409,
        body: { kode: "forkert_miljoe" },
      });
    } finally {
      vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", "");
      vi.stubEnv("IAP_TESTKOEB_KONTI", "");
    }
  });

  it("på testdatabasen er testkøb altid tilladt - uden markering", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://pjiigmzqwlfepxnjdvug.supabase.co");
    try {
      expect((await koeb(googleKoeb({ purchaseType: 0 }))).status).toBe(200);
      expect(db.s.rpc.find((x) => x.navn === "boost_iap_krediter")?.args).toMatchObject({ p_miljoe: "test", p_markering: null });
    } finally {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://eksempel.supabase.co");
    }
  });

  it("promokode (purchaseType 1): krediteres med markeringen 'promo' (ikke omsætning)", async () => {
    expect((await koeb(googleKoeb({ purchaseType: 1 }))).status).toBe(200);
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_krediter")?.args).toMatchObject({ p_miljoe: "produktion", p_markering: "promo" });
  });

  it("kontobindingen er påkrævet i produktion: uden obfuscatedExternalAccountId 409 konto_mangler", async () => {
    expect(await koeb(googleKoeb({ obfuscatedExternalAccountId: undefined }))).toMatchObject({ status: 409, body: { kode: "konto_mangler" } });
    expect(rpcNavne()).not.toContain("boost_iap_krediter");
    // Intet consume: Google refunderer selv købet efter 3 dage.
    expect(googleKald.map((x) => x.metode)).toEqual(["GET"]);
    expect(db.s.drift.find((x) => x.hvor === "boost/iap-afvist-betalt")).toMatchObject({ brugerId: PRIVAT });
  });

  it("ukendt token hos Google og en anden kontos køb afvises", async () => {
    const k = { platform: "android", productId: "dk.bidhamr.app.boost100", purchaseToken: "findes.ikke.0123456789" };
    expect(await koeb(k)).toMatchObject({ status: 422, body: { kode: "ugyldigt_koeb" } });
    expect(await koeb(googleKoeb({ obfuscatedExternalAccountId: KT(PRIVAT2) }))).toMatchObject({ status: 409, body: { kode: "anden_konto" } });
  });

  it("firma: 403, intet consume (Google refunderer selv), og chefen får en drift-note", async () => {
    expect(await koeb(googleKoeb({ obfuscatedExternalAccountId: KT(FIRMA) }), "f.f.f")).toMatchObject({ status: 403, body: { kode: "erhverv" } });
    expect(googleKald.map((x) => x.metode)).toEqual(["GET"]);
    const d = db.s.drift.find((x) => x.hvor === "boost/iap-afvist-betalt");
    expect(d).toMatchObject({ brugerId: FIRMA });
    expect(String(d?.fejl)).toMatch(/Google refunderer det automatisk/);
  });
});

describe("GET /api/app/boost/iap", () => {
  it("klar og produkt-id'er; med login også kanKoebe og appAccountToken", async () => {
    const uden = await ruter.iap.GET(new NextRequest("http://localhost/api/app/boost/iap", { headers: { host: "localhost" } }));
    expect(await uden.json()).toEqual({
      ok: true,
      klar: { ios: true, android: true },
      produkter: [
        { id: "dk.bidhamr.app.boost100", point: 100 },
        { id: "dk.bidhamr.app.boost300", point: 300 },
        { id: "dk.bidhamr.app.boost700", point: 700 },
      ],
    });
    const firma = await ruter.iap.GET(new NextRequest("http://localhost/api/app/boost/iap", { headers: { host: "localhost", authorization: "Bearer f.f.f" } }));
    expect(await firma.json()).toMatchObject({ kanKoebe: false, grund: "erhverv", appAccountToken: KT(FIRMA) });
    vi.stubEnv("GOOGLE_PUBSUB_SA_EMAIL", "");
    try {
      const r = await ruter.iap.GET(new NextRequest("http://localhost/api/app/boost/iap", { headers: { host: "localhost" } }));
      expect(((await r.json()) as { klar: unknown }).klar).toEqual({ ios: true, android: false });
    } finally {
      vi.stubEnv("GOOGLE_PUBSUB_SA_EMAIL", SA);
    }
  });
});

// ============================================================ webhooks
async function apple(signedPayload: string) {
  const res = await ruter.apple.POST(
    new NextRequest("http://localhost/api/webhooks/apple", { method: "POST", body: JSON.stringify({ signedPayload }), headers: { "content-type": "application/json" } }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
let uuidNr = 0;
function notifikation(type: string, signeretTx: string | null, k: Kaede = kaede, miljoe = "Production") {
  return jws(k, {
    notificationType: type,
    notificationUUID: `0000aaaa-0000-4000-8000-${String(++uuidNr).padStart(12, "0")}`,
    version: "2.0",
    signedDate: Date.now(),
    data: { bundleId: BUNDLE, appAppleId: APP_ID, environment: miljoe, ...(signeretTx ? { signedTransactionInfo: signeretTx } : {}) },
  });
}

describe("POST /api/webhooks/apple", () => {
  it("REFUND af brugte point: trækkes tilbage til minus + drift-alarm; samme notifikation igen gør intet", async () => {
    // PRIVAT2 køber 700 point og har brugt dem (saldo sat til 0 i den falske db).
    const { t, signeret } = appleKoeb({ productId: "dk.bidhamr.app.boost700", appAccountToken: KT(PRIVAT2) });
    expect((await koeb(ios(signeret), "b.b.b")).status).toBe(200);
    db.s.saldo.set(PRIVAT2, 0);
    const n = notifikation("REFUND", jws(kaede, { ...t, revocationDate: Date.now(), revocationType: "REFUND_FULL", signedDate: Date.now() }));
    expect(await apple(n)).toEqual({ status: 200, body: { resultat: "tilbagefoert" } });
    expect(db.s.saldo.get(PRIVAT2)).toBe(-700);
    expect(db.s.drift.find((d) => d.hvor === "boost/iap-minus")).toMatchObject({ brugerId: PRIVAT2 });
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args).toMatchObject({ p_platform: "ios", p_ekstern_id: t.transactionId, p_andel_milli: 100000 });
    db.s.rpc = [];
    expect(await apple(n)).toEqual({ status: 200, body: { resultat: "allerede" } });
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
    expect(db.s.saldo.get(PRIVAT2)).toBe(-700);
  });

  it("delvis refusion (REFUND_PRORATED) sender andelen", async () => {
    const { t, signeret } = appleKoeb({ productId: "dk.bidhamr.app.boost300" });
    await koeb(ios(signeret));
    const n = notifikation("REFUND", jws(kaede, { ...t, revocationDate: Date.now(), revocationType: "REFUND_PRORATED", revocationPercentage: 50000 }));
    expect((await apple(n)).body.resultat).toBe("tilbagefoert");
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args.p_andel_milli).toBe(50000);
  });

  it("forfalsket signatur: 401 og intet sker", async () => {
    const { t } = appleKoeb();
    expect((await apple(notifikation("REFUND", jws(fremmedKaede, t), fremmedKaede))).status).toBe(401);
    expect(rpcNavne()).toEqual([]);
  });

  it("forkert bundle i notifikationen: 401", async () => {
    const n = jws(kaede, { notificationType: "TEST", notificationUUID: "0000bbbb-0000-4000-8000-000000000001", signedDate: Date.now(), data: { bundleId: "dk.anden.app", appAppleId: APP_ID, environment: "Production" } });
    expect((await apple(n)).status).toBe(401);
  });

  it("TEST: 200; Sandbox-notifikation på produktion: 200 uden handling", async () => {
    expect(await apple(notifikation("TEST", null))).toEqual({ status: 200, body: { resultat: "test" } });
    expect(await apple(notifikation("TEST", null, kaede, "Sandbox"))).toEqual({ status: 200, body: { resultat: "andet_miljoe" } });
  });

  it("CONSUMPTION_REQUEST: kun en note - intet trækkes, intet sendes til Apple", async () => {
    const { t, signeret } = appleKoeb();
    await koeb(ios(signeret));
    db.s.rpc = [];
    expect((await apple(notifikation("CONSUMPTION_REQUEST", jws(kaede, t)))).body.resultat).toBe("noteret");
    expect(rpcNavne()).toContain("boost_iap_opmaerksomhed");
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
  });

  it("ugyldig krop: 400", async () => {
    const res = await ruter.apple.POST(new NextRequest("http://localhost/api/webhooks/apple", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });

  it("REFUND før kreditering: ventende, notifikationen er behandlet, og købet afvises bagefter", async () => {
    const { t, signeret } = appleKoeb();
    const n = notifikation("REFUND", jws(kaede, { ...t, revocationDate: Date.now(), revocationType: "REFUND_FULL" }));
    expect(await apple(n)).toEqual({ status: 200, body: { resultat: "ukendt" } });
    expect(db.s.ventende.some((v) => v.ekstern === t.transactionId)).toBe(true);
    // Apples notificationUUID og signedDate sendes med til databasen.
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args).toMatchObject({
      p_notifikation: expect.stringMatching(/^0000aaaa-/),
      p_signeret_kl: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    // Samme notifikation igen: behandlet - intet kald til databasen.
    db.s.rpc = [];
    expect(await apple(n)).toEqual({ status: 200, body: { resultat: "allerede" } });
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
    // Appen sender købet bagefter (Apple siger endnu ikke refunderet): afvist.
    expect(await koeb(ios(signeret))).toMatchObject({ status: 409, body: { kode: "refunderet" } });
    // REFUND_REVERSED ophæver den ventende refusion, og chefen får en note.
    db.s.drift = [];
    expect((await apple(notifikation("REFUND_REVERSED", jws(kaede, t)))).body.resultat).toBe("ventende_ophaevet");
    expect(String(db.s.drift.find((d) => d.hvor === "boost/iap-refusion-tilbage")?.fejl)).toMatch(
      /^Apple har trukket en refusion tilbage – brugeren kan mangle point, giv dem manuelt, hvis købet ikke sendes igen/,
    );
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_ventende_ophaev")?.args).toMatchObject({ p_kilde: "apple_notifikation" });
    // Den daglige historik kører den samme REFUND igen: intet sker (behandlet).
    historik.set("REFUND", [n]);
    historik.set("REFUND_REVERSED", []);
    db.s.rpc = [];
    db.s.claim = true;
    await ruter.server.koerIapCron();
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
    historik.clear();
    expect((await koeb(ios(signeret))).status).toBe(200);
  });
});

describe("POST /api/webhooks/google-play", () => {
  async function push(auth: string | null, data: unknown, messageId = `m${++uuidNr}`) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth) headers.authorization = `Bearer ${auth}`;
    const body = { message: { data: Buffer.from(JSON.stringify(data)).toString("base64"), messageId }, subscription: "projects/p/subscriptions/s" };
    const res = await ruter.googlePlay.POST(new NextRequest("http://localhost/api/webhooks/google-play", { method: "POST", body: JSON.stringify(body), headers }));
    return res.status;
  }
  const void_ = (token: string, orderId: string) => ({
    version: "1.0",
    packageName: BUNDLE,
    eventTimeMillis: String(Date.now()),
    voidedPurchaseNotification: { purchaseToken: token, orderId, productType: 2, refundType: 1 },
  });

  it("voidedPurchaseNotification med gyldigt OIDC-token: bekræftes hos Google, pointene trækkes tilbage, én gang", async () => {
    const k = googleKoeb();
    await koeb(k);
    const orderId = String(google.get(k.purchaseToken)!.orderId);
    // Google har annulleret købet.
    google.get(k.purchaseToken)!.purchaseState = 1;
    googleKald.length = 0;
    expect(await push(oidc(), void_(k.purchaseToken, orderId), "void-1")).toBe(204);
    // purchases.products.get med produktet fra vores køb.
    expect(googleKald).toHaveLength(1);
    expect(googleKald[0].url).toContain("/products/dk.bidhamr.app.boost100/tokens/");
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args).toMatchObject({ p_platform: "android", p_google_token: k.purchaseToken, p_andel_milli: 100000 });
    db.s.rpc = [];
    expect(await push(oidc(), void_(k.purchaseToken, orderId), "void-1")).toBe(204);
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
  });

  it("void, som Google ikke bekræfter (purchaseState 0): intet trækkes", async () => {
    const k = googleKoeb();
    await koeb(k);
    const orderId = String(google.get(k.purchaseToken)!.orderId);
    expect(await push(oidc(), void_(k.purchaseToken, orderId), "void-2")).toBe(204);
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
    expect(db.s.notifikationer.get("android|void-2")).toBe(true);
    // Voided Purchases API er spurgt.
    expect(googleKald.some((x) => x.url.includes("/purchases/voidedpurchases?"))).toBe(true);
  });

  it("void: purchaseState 0, men købet står i Voided Purchases API: bekræftet", async () => {
    const k = googleKoeb();
    await koeb(k);
    const orderId = String(google.get(k.purchaseToken)!.orderId);
    voidedListe.push({ purchaseToken: k.purchaseToken, orderId, voidedTimeMillis: String(Date.now()) });
    try {
      expect(await push(oidc(), void_(k.purchaseToken, orderId), "void-2b")).toBe(204);
      expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args).toMatchObject({ p_google_token: k.purchaseToken });
    } finally {
      voidedListe.length = 0;
    }
  });

  it("void: en anden tilstand end købt og afventer (fx 3) godtages som annulleret", async () => {
    const k = googleKoeb();
    await koeb(k);
    const orderId = String(google.get(k.purchaseToken)!.orderId);
    google.get(k.purchaseToken)!.purchaseState = 3;
    googleKald.length = 0;
    expect(await push(oidc(), void_(k.purchaseToken, orderId), "void-2c")).toBe(204);
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args).toMatchObject({ p_google_token: k.purchaseToken });
    expect(googleKald.some((x) => x.url.includes("/purchases/voidedpurchases?"))).toBe(false);
  });

  it("void af et køb, vi ikke har: produkterne prøves, og refusionen gemmes som ventende", async () => {
    const k = googleKoeb({ productId: "dk.bidhamr.app.boost700", purchaseState: 1 });
    const orderId = String(google.get(k.purchaseToken)!.orderId);
    expect(await push(oidc(), void_(k.purchaseToken, orderId), "void-3")).toBe(204);
    expect(db.s.rpc.find((x) => x.navn === "boost_iap_refusion")?.args).toMatchObject({ p_google_token: k.purchaseToken });
    expect(db.s.ventende.some((v) => v.token === k.purchaseToken)).toBe(true);
    // Markeret som behandlet - den ventende refusion er gemt.
    expect(db.s.notifikationer.get("android|void-3")).toBe(true);
    // Kommer købet bagefter: afvist.
    expect(await koeb({ ...k, productId: "dk.bidhamr.app.boost700" })).toMatchObject({ status: 409, body: { kode: "annulleret" } });
  });

  it("Google kan ikke nås: 500, så Pub/Sub prøver igen", async () => {
    const k = googleKoeb();
    await koeb(k);
    const orig = globalThis.fetch;
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    try {
      expect(await push(oidc(), void_(k.purchaseToken, "GPA.x"), "void-4")).toBe(500);
      expect(rpcNavne()).not.toContain("boost_iap_refusion");
    } finally {
      vi.stubGlobal("fetch", orig);
    }
  });

  it("OIDC: forkert audience, forkert service account, uverificeret email, udløbet, intet token: 401", async () => {
    const d = void_("tok.x.ABCDEFGHIJ", "GPA.1");
    expect(await push(oidc({ aud: "https://andet.dk" }), d)).toBe(401);
    expect(await push(oidc({ email: "ond@evil.iam.gserviceaccount.com" }), d)).toBe(401);
    expect(await push(oidc({ email_verified: false }), d)).toBe(401);
    expect(await push(oidc({ iat: 1000, exp: 2000 }), d)).toBe(401);
    expect(await push(oidc({ iss: "https://evil.example" }), d)).toBe(401);
    expect(await push(null, d)).toBe(401);
    expect(rpcNavne()).toEqual([]);
  });

  it("testNotification og en anden app: 204 uden handling", async () => {
    expect(await push(oidc(), { version: "1.0", packageName: BUNDLE, testNotification: { version: "1.0" } })).toBe(204);
    expect(await push(oidc(), { ...void_("tok.y.ABCDEFGHIJ", "GPA.2"), packageName: "dk.anden.app" })).toBe(204);
    expect(rpcNavne()).not.toContain("boost_iap_refusion");
  });
});

// ============================================================ cron
describe("den daglige cron", () => {
  it("Apple Get Notification History: REFUND og REFUND_REVERSED for det seneste døgn + overlap, idempotent", async () => {
    // Et køb, hvis REFUND-notifikation aldrig nåede frem.
    const { t, signeret } = appleKoeb({ productId: "dk.bidhamr.app.boost100" });
    expect((await koeb(ios(signeret))).status).toBe(200);
    const tabt = notifikation("REFUND", jws(kaede, { ...t, revocationDate: Date.now(), revocationType: "REFUND_PRORATED", revocationPercentage: 40000 }));
    // Og en, der allerede er behandlet via webhooken.
    const { t: t2, signeret: s2 } = appleKoeb({ productId: "dk.bidhamr.app.boost100" });
    await koeb(ios(s2));
    const kendt = notifikation("REFUND", jws(kaede, { ...t2, revocationDate: Date.now() }));
    expect((await apple(kendt)).body.resultat).toBe("tilbagefoert");
    historik.set("REFUND", [tabt, kendt, jws(fremmedKaede, { notificationType: "REFUND" })]);
    historik.set("REFUND_REVERSED", []);
    historikKald.length = 0;
    db.s.rpc = [];
    db.s.claim = true;
    const r = await ruter.server.koerIapCron();
    expect(r).toMatchObject({ apple: 1 });
    // Begge typer, to sider for REFUND, ca. 36 timer tilbage.
    expect(historikKald.map((h) => `${h.type}:${h.side ?? "-"}`)).toEqual(["REFUND:-", "REFUND:side2", "REFUND_REVERSED:-"]);
    expect(historikKald[0].til - historikKald[0].fra).toBe(36 * 3600 * 1000);
    const refusioner = db.s.rpc.filter((x) => x.navn === "boost_iap_refusion").map((x) => x.args);
    expect(refusioner).toEqual([expect.objectContaining({ p_ekstern_id: t.transactionId, p_andel_milli: 40000, p_kilde: "apple_historik" })]);
    // Den forfalskede notifikation i listen: logget, intet trukket.
    expect(db.s.drift.some((d) => d.hvor === "boost/iap-apple-historik")).toBe(true);
    // Igen: intet nyt.
    db.s.rpc = [];
    historik.set("REFUND", [tabt, kendt]);
    await ruter.server.koerIapCron();
    expect(db.s.rpc.filter((x) => x.navn === "boost_iap_refusion")).toEqual([]);
  });

  it("testkøb slået til i produktion: drift-advarsel hver dag", async () => {
    historik.clear();
    db.s.claim = true;
    vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString());
    vi.stubEnv("IAP_TESTKOEB_KONTI", PRIVAT);
    try {
      await ruter.server.koerIapCron();
      const d = db.s.drift.find((x) => x.hvor === "boost/iap-testkoeb");
      expect(String(d?.fejl)).toMatch(/^Testkøb er slået til i produktion/);
    } finally {
      vi.stubEnv("IAP_TILLAD_TESTKOEB_TIL", "");
      vi.stubEnv("IAP_TESTKOEB_KONTI", "");
    }
    db.s.drift = [];
    await ruter.server.koerIapCron();
    expect(db.s.drift.some((x) => x.hvor === "boost/iap-testkoeb")).toBe(false);
  });
});

// ============================================================ regler
describe("kontobinding og testkøbsvindue", () => {
  it("appAccountToken: deterministisk UUID (v8), forskellig pr. bruger, ikke bruger-id'et; uden hemmelighed: ikke klar", () => {
    const a = KT(PRIVAT);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(KT(PRIVAT)).toBe(a);
    expect(KT(PRIVAT.toUpperCase())).toBe(a);
    expect(KT(PRIVAT2)).not.toBe(a);
    expect(a).not.toBe(PRIVAT);
    vi.stubEnv("IAP_KONTO_HEMMELIGHED", "for-kort");
    try {
      expect(ruter.konfig.kontoToken(PRIVAT)).toBeNull();
      expect(ruter.konfig.iapKlar()).toEqual({ ios: false, android: false });
    } finally {
      vi.stubEnv("IAP_KONTO_HEMMELIGHED", HEMMELIGHED);
    }
  });

  it("IAP_TILLAD_TESTKOEB_TIL: kun ISO-dato i fremtiden og højst 14 dage frem", () => {
    const nu = Date.parse("2026-10-28T12:00:00Z");
    const v = ruter.regler.testkoebVindue;
    expect(v("2026-11-05", nu).aabent).toBe(true);
    expect(v("2026-11-11T12:00:00Z", nu).aabent).toBe(true);
    expect(v("2026-11-11T12:00:01Z", nu).aabent).toBe(false);
    expect(v("2026-10-28T11:59:59Z", nu).aabent).toBe(false);
    expect(v("", nu).aabent).toBe(false);
    expect(v("1", nu).aabent).toBe(false);
    expect(v("5. nov 2026", nu).aabent).toBe(false);
    expect(v("2026-02-30", nu).aabent).toBe(false);
    expect([...ruter.regler.testkoebKonti(` ${PRIVAT.toUpperCase()},x, ${PRIVAT2}`)]).toEqual([PRIVAT, PRIVAT2]);
  });
});
