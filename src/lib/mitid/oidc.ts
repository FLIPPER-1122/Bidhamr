import "server-only";

import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";

// MitID via Idura Verify (tidligere Criipto) - OpenID Connect, authorization
// code flow med client secret (kun på serveren) + state + nonce + PKCE (S256).
// Se docs/MITID.md.
//
// Miljøvariabler (aldrig i klientkode, aldrig udskrevet):
//   CRIIPTO_DOMAIN        fx bidhamr-test.test.idura.broker (test) - uden https://
//   CRIIPTO_CLIENT_ID
//   CRIIPTO_CLIENT_SECRET
//   MITID_HASH_NOEGLE     hemmelig nøgle til HMAC af MitIDs Person-ID (mindst
//                         32 tegn). SKAL være den samme for altid i et miljø -
//                         skiftes den, kan samme MitID bruges på en ny konto.
//
// Ingen afhængigheder: id_token (RS256) verificeres med Node's crypto mod
// Iduras JWKS.

// Niveau "betydelig" (substantial): MitID med app/kodeviser + PIN - det
// niveau, Idura anbefaler, og som svarer til NSIS "betydelig" (bruges af
// banker/netbutikker til identitet). "Lav" er kun brugernavn+adgangskode-agtig
// sikkerhed og for svagt til at forhindre dobbeltkonti; "høj" kræver chip og
// er unødigt besværligt for en markedsplads.
export const MITID_ACR = "urn:grn:authn:dk:mitid:substantial";

// Tilladt afvigelse mellem urene (sekunder).
const UR_SKAEV = 60;

export type MitIdKonfig = {
  domaene: string;
  clientId: string;
  clientSecret: string;
  hashNoegle: string;
};

export function mitIdKonfig(): MitIdKonfig | null {
  const domaene = (process.env.CRIIPTO_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const clientId = (process.env.CRIIPTO_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.CRIIPTO_CLIENT_SECRET ?? "").trim();
  const hashNoegle = (process.env.MITID_HASH_NOEGLE ?? "").trim();
  if (!domaene || !/^[a-z0-9.-]+$/i.test(domaene) || !clientId || !clientSecret || hashNoegle.length < 32) {
    return null;
  }
  return { domaene, clientId, clientSecret, hashNoegle };
}

// Til fejlloggen: hvad der mangler i konfigurationen (aldrig selve værdierne).
export function mitIdKonfigMangler(): string[] {
  const domaene = (process.env.CRIIPTO_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const mangler: string[] = [];
  if (!domaene) mangler.push("CRIIPTO_DOMAIN mangler");
  else if (!/^[a-z0-9.-]+$/i.test(domaene)) mangler.push("CRIIPTO_DOMAIN har ugyldige tegn (kun domænet, fx bidhamr-test.test.idura.broker)");
  if (!(process.env.CRIIPTO_CLIENT_ID ?? "").trim()) mangler.push("CRIIPTO_CLIENT_ID mangler");
  if (!(process.env.CRIIPTO_CLIENT_SECRET ?? "").trim()) mangler.push("CRIIPTO_CLIENT_SECRET mangler");
  const n = (process.env.MITID_HASH_NOEGLE ?? "").trim().length;
  if (n < 32) mangler.push(`MITID_HASH_NOEGLE er ${n} tegn (skal være mindst 32)`);
  return mangler;
}

// Callback-adressen skal være præcis den, der er registreret hos Idura.
// Kun disse to (Filip, 9. okt. 2026). MITID_CALLBACK_URL kan overstyre (fx
// en anden port), men skal stadig være registreret hos Idura.
const TILLADTE_ORIGINS = ["http://localhost:3000", "https://bidhamr.dk"];

export function callbackUrl(requestOrigin: string): string | null {
  const fast = process.env.MITID_CALLBACK_URL?.trim();
  if (fast) return fast;
  const origin = requestOrigin.replace(/\/+$/, "");
  if (origin === "https://www.bidhamr.dk") return "https://bidhamr.dk/api/mitid/callback";
  return TILLADTE_ORIGINS.includes(origin) ? `${origin}/api/mitid/callback` : null;
}

// Den side, brugeren sendes tilbage til (samme origin som callback).
export function sideOrigin(callback: string): string {
  return new URL(callback).origin;
}

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

let discoveryCache: { domaene: string; data: Discovery; hentet: number } | null = null;
let jwksCache: { uri: string; noegler: JsonWebKey[]; hentet: number } | null = null;

async function hentJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`MitID: ${new URL(url).pathname} svarede ${res.status}`);
  return res.json();
}

export async function discovery(k: MitIdKonfig): Promise<Discovery> {
  if (discoveryCache && discoveryCache.domaene === k.domaene && Date.now() - discoveryCache.hentet < 60 * 60 * 1000) {
    return discoveryCache.data;
  }
  const d = (await hentJson(`https://${k.domaene}/.well-known/openid-configuration`)) as Partial<Discovery>;
  const forventetIssuer = `https://${k.domaene}`;
  // Alle endpoints skal ligge på vores eget Idura-domæne (fail closed).
  const paaDomaenet = (u?: string) => {
    try {
      return !!u && new URL(u).origin === forventetIssuer;
    } catch {
      return false;
    }
  };
  if (
    d.issuer !== forventetIssuer ||
    !paaDomaenet(d.authorization_endpoint) ||
    !paaDomaenet(d.token_endpoint) ||
    !paaDomaenet(d.jwks_uri)
  ) {
    throw new Error("MitID: discovery-dokumentet er ugyldigt");
  }
  const data = d as Discovery;
  discoveryCache = { domaene: k.domaene, data, hentet: Date.now() };
  return data;
}

async function jwks(uri: string, tving: boolean): Promise<JsonWebKey[]> {
  if (!tving && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.hentet < 60 * 60 * 1000) {
    return jwksCache.noegler;
  }
  // Højst én tvungen genhentning pr. 30 sek. (ukendt kid).
  if (tving && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.hentet < 30 * 1000) {
    return jwksCache.noegler;
  }
  const d = (await hentJson(uri)) as { keys?: JsonWebKey[] };
  const noegler = Array.isArray(d.keys) ? d.keys : [];
  jwksCache = { uri, noegler, hentet: Date.now() };
  return noegler;
}

export function base64url(b: Buffer): string {
  return b.toString("base64url");
}

export function tilfaeldig(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function ensStrenge(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

// HMAC af MitIDs Person-ID. Prefikset binder hashen til netop MitID-uuid'en.
export function mitIdHash(k: MitIdKonfig, personId: string): string {
  return createHmac("sha256", k.hashNoegle).update(`dkmitid:uuid:${personId.toLowerCase()}`, "utf8").digest("hex");
}

export async function authorizeUrl(
  k: MitIdKonfig,
  p: { redirectUri: string; state: string; nonce: string; codeVerifier: string },
): Promise<string> {
  const d = await discovery(k);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", k.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("scope", "openid");
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("acr_values", MITID_ACR);
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", pkceChallenge(p.codeVerifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("ui_locales", "da");
  // Altid et nyt MitID-login (ingen genbrug af en tidligere Idura-session).
  u.searchParams.set("prompt", "login");
  return u.toString();
}

export type MitIdIdentitet = {
  personId: string;
  navn: string | null;
  foedselsdato: string; // YYYY-MM-DD
};

function afkodDel(del: string): Record<string, unknown> {
  const json = Buffer.from(del, "base64url").toString("utf8");
  const v = JSON.parse(json) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("MitID: ugyldigt token");
  return v as Record<string, unknown>;
}

async function verificerIdToken(
  k: MitIdKonfig,
  d: Discovery,
  idToken: string,
  nonce: string,
): Promise<Record<string, unknown>> {
  const dele = idToken.split(".");
  if (dele.length !== 3) throw new Error("MitID: id_token har forkert format");
  const header = afkodDel(dele[0]);
  if (header.alg !== "RS256") throw new Error("MitID: uventet signaturalgoritme");
  const kid = typeof header.kid === "string" ? header.kid : null;

  const find = (ks: JsonWebKey[]) =>
    ks.find((n) => n.kty === "RSA" && (!kid || n.kid === kid) && (!n.use || n.use === "sig"));
  let jwk = find(await jwks(d.jwks_uri, false));
  if (!jwk) jwk = find(await jwks(d.jwks_uri, true));
  if (!jwk) throw new Error("MitID: ukendt signaturnøgle");

  const noegle = createPublicKey({ key: jwk, format: "jwk" });
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${dele[0]}.${dele[1]}`, "ascii"),
    noegle,
    Buffer.from(dele[2], "base64url"),
  );
  if (!ok) throw new Error("MitID: ugyldig signatur");

  const c = afkodDel(dele[1]);
  const nu = Math.floor(Date.now() / 1000);
  if (c.iss !== d.issuer) throw new Error("MitID: forkert issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(k.clientId)) throw new Error("MitID: forkert audience");
  if (aud.length > 1 && c.azp !== k.clientId) throw new Error("MitID: forkert azp");
  if (typeof c.exp !== "number" || c.exp + UR_SKAEV < nu) throw new Error("MitID: token er udløbet");
  if (typeof c.iat !== "number" || c.iat - UR_SKAEV > nu || c.iat < nu - 10 * 60) {
    throw new Error("MitID: token har ugyldigt udstedelsestidspunkt");
  }
  if (typeof c.nbf === "number" && c.nbf - UR_SKAEV > nu) throw new Error("MitID: token er ikke gyldigt endnu");
  if (typeof c.nonce !== "string" || !ensStrenge(c.nonce, nonce)) throw new Error("MitID: forkert nonce");
  return c;
}

// Bytter koden til tokens og returnerer den verificerede identitet.
export async function hentIdentitet(
  k: MitIdKonfig,
  p: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
): Promise<MitIdIdentitet> {
  const d = await discovery(k);
  const krop = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  });
  // client_secret_basic (RFC 6749 2.3.1: id og hemmelighed URL-kodes først).
  const basic = Buffer.from(
    `${encodeURIComponent(k.clientId)}:${encodeURIComponent(k.clientSecret)}`,
    "utf8",
  ).toString("base64");
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
    },
    body: krop.toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    // Fejlteksten fra Idura logges ikke (kan indeholde koden).
    throw new Error(`MitID: token-endpointet svarede ${res.status}`);
  }
  const tokens = (await res.json()) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") throw new Error("MitID: intet id_token");

  const c = await verificerIdToken(k, d, tokens.id_token, p.nonce);

  // Kun dansk MitID på niveau betydelig eller højere.
  if (c.identityscheme !== "dkmitid") throw new Error("MitID: forkert eID");
  // Idura sender niveauet i authenticationtype (URN) og/eller
  // gov:saml:attribute:LoA ("SUBSTANTIAL" eller NSIS-URI) - ikke altid i acr. Mindst én skal sige
  // betydelig/høj, og ingen må sige lavere.
  const niveauer = [c.acr, c.authenticationtype, c["gov:saml:attribute:LoA"]]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
  const godkendt = (v: string) =>
    v === MITID_ACR ||
    v === "urn:grn:authn:dk:mitid:high" ||
    /^https:\/\/data\.gov\.dk\/concept\/core\/nsis\/loa\/(substantial|high)$/i.test(v) ||
    // gov:saml:attribute:LoA kommer fra Idura som "SUBSTANTIAL"/"HIGH".
    /^(substantial|high)$/i.test(v);
  if (niveauer.length === 0 || !niveauer.every(godkendt)) {
    // Niveau-værdierne er ikke personoplysninger.
    throw new Error(
      `MitID: for lavt sikringsniveau (${niveauer.map((v) => v.slice(0, 80)).join(" | ") || "intet niveau"}; claims=${Object.keys(c).sort().join(",").slice(0, 400)})`,
    );
  }
  // Person-ID står i uuid eller gov:saml:attribute:UUID. Er begge sat, skal de
  // være ens - ellers kunne samme person få to forskellige hashes.
  const normId = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^urn:uuid:/i, "").toLowerCase() : "");
  const ids = [normId(c.uuid), normId(c["gov:saml:attribute:UUID"])].filter(Boolean);
  if (ids.length === 2 && ids[0] !== ids[1]) throw new Error("MitID: modstridende Person-ID");
  const personId = ids[0] ?? "";
  if (!/^[0-9a-f-]{16,64}$/i.test(personId)) throw new Error("MitID: mangler Person-ID");
  const foedselsdato = typeof c.birthdate === "string" ? c.birthdate.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(foedselsdato)) throw new Error("MitID: mangler fødselsdato");
  const navn = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 300) : null;
  return { personId, navn, foedselsdato };
}
