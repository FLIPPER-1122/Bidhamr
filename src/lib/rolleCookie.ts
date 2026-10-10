import "server-only";

// Kortlivet, signeret cookie med brugerens staff-rolle og konto_type til
// gaten før lancering (src/lib/supabase/middleware.ts). konto_type er med,
// fordi en firmakonto (konto_type 'erhverv') må nå Firma oversigt før
// lancering - så skal gaten heller ikke spørge databasen ved hvert klik for
// firmaet. Uden den spurgte proxyen
// databasen (min_rolle) ved HVERT klik, før siden overhovedet begyndte at
// blive bygget.
//
// Sikkerhed:
// - Kun gaten bruger cookien. Admin-sider og alle staff-handlinger tjekker
//   stadig rollen i databasen hver gang (kraevSideRolle/assertRole i
//   src/lib/adminAuth.ts), og RLS er uændret.
// - Værdien er signeret med HMAC-SHA256 med en nøgle, der kun findes på
//   serveren: ROLLE_COOKIE_HEMMELIGHED (egen lang, tilfældig værdi, uafhængig
//   af Supabases API-nøgler, så et nøgleskifte ikke rører den). Mangler den,
//   afledes nøglen som før af service-role-nøglen (afledningsNoegle i
//   src/lib/supabase/noegler.ts), og der logges én advarsel i drift i
//   produktion. Kan ikke laves eller ændres i browseren. Mangler alle nøgler,
//   bruges cookien ikke (fail closed: så spørges databasen hver gang som før).
// - Bundet til brugerens id OG sessionens id (session_id i JWT'en): et nyt
//   login, logud eller en anden bruger i samme browser gør den ugyldig.
// - Gælder højst 5 minutter. Fratages en medarbejder rollen, kan gaten
//   derfor lukke op for ham i op til 5 minutter mere: han kan se siden og
//   bruge almindelige brugerhandlinger (fx byde), som kun kræver login.
//   Admin og staff-handlinger tjekker rollen i databasen og afvises med
//   det samme. Det samme gælder konto_type: en firmakonto, der laves om til
//   privat, kan nå Firma oversigt i op til 5 minutter mere (siden tjekker
//   selv konto_type i databasen).
// - Alle indloggede får en cookie (også private brugere med rollen 'bruger'),
//   så gaten heller ikke spørger databasen ved hvert klik for dem efter
//   lancering. Cookien giver kun det, rollen i den giver: en privat bruger
//   sendes stadig til venteliste-siden før lancering.
// - httpOnly, SameSite=Lax og Secure (undtagen lokalt på http).

import { logDriftFejl } from "@/lib/drift";
import { afledningsNoegle } from "@/lib/supabase/noeglerServer";

export const ROLLE_COOKIE = "bh_rolle";
const LEVETID_SEKUNDER = 5 * 60;
// NOEGLE_VERSION indgår i nøgleafledningen og er uændret, så nøglen er den
// samme som før. VERSION er cookiens format: v2 har konto_type med (v1 havde
// kun rollen). En gammel v1-cookie afvises bare, og rollen slås op igen.
const NOEGLE_VERSION = "v1";
const VERSION = "v2";

let noegleLoefte: Promise<CryptoKey | null> | null = null;
let advaret = false;

// Én advarsel pr. serverproces i produktion, når fallback'en bruges.
function advarOmFallback() {
  if (advaret || process.env.NODE_ENV !== "production") return;
  advaret = true;
  console.warn("ROLLE_COOKIE_HEMMELIGHED mangler - rolle-cookien signeres med Supabase-nøglen.");
  void logDriftFejl({
    kilde: "server",
    sti: "/",
    hvor: "Rolle-cookie",
    fejl: "ROLLE_COOKIE_HEMMELIGHED mangler i produktion - rolle-cookien signeres med Supabase-nøglen (fallback).",
  });
}

function hentNoegle(): Promise<CryptoKey | null> {
  if (!noegleLoefte) {
    noegleLoefte = (async () => {
      const egen = process.env.ROLLE_COOKIE_HEMMELIGHED;
      let tekst: string;
      if (egen) {
        tekst = `bidhamr-rolle-cookie-${NOEGLE_VERSION}|egen|${egen}`;
      } else {
        // Den gamle afledning (uændret), så eksisterende cookies virker videre.
        const afledt = afledningsNoegle();
        if (!afledt) return null;
        advarOmFallback();
        tekst = `bidhamr-rolle-cookie-${NOEGLE_VERSION}|${afledt}`;
      }
      const materiale = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst));
      return crypto.subtle.importKey("raw", materiale, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]);
    })().catch(() => null);
  }
  return noegleLoefte;
}

function tilBase64Url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fraBase64Url(tekst: string): Uint8Array<ArrayBuffer> | null {
  try {
    const b64 = tekst.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const ud = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) ud[i] = bin.charCodeAt(i);
    return ud;
  } catch {
    return null;
  }
}

const SIKKER_DEL = /^[A-Za-z0-9-]{1,64}$/;

// Konto_type til cookien: kun sikre tegn; mangler den, gemmes "ingen".
const INGEN_KONTOTYPE = "ingen";

export type GateIdentitet = { rolle: string; kontoType: string | null };

// Den signerede værdi til cookien, eller null hvis den ikke kan laves.
export async function lavRolleCookie(
  brugerId: string,
  sessionId: string,
  rolle: string,
  kontoType: string | null,
): Promise<{ vaerdi: string; maxAge: number } | null> {
  const konto = kontoType ?? INGEN_KONTOTYPE;
  if (![brugerId, sessionId, rolle, konto].every((d) => SIKKER_DEL.test(d))) return null;
  const noegle = await hentNoegle();
  if (!noegle) return null;
  const udloeber = Math.floor(Date.now() / 1000) + LEVETID_SEKUNDER;
  const data = `${VERSION}.${brugerId}.${sessionId}.${rolle}.${konto}.${udloeber}`;
  const signatur = await crypto.subtle.sign("HMAC", noegle, new TextEncoder().encode(data));
  return { vaerdi: `${data}.${tilBase64Url(signatur)}`, maxAge: LEVETID_SEKUNDER };
}

// Rolle og konto_type fra cookien, hvis signaturen er gyldig, den ikke er
// udløbet, og den hører til præcis denne bruger og session. Ellers null.
export async function laesRolleCookie(
  vaerdi: string | undefined,
  brugerId: string,
  sessionId: string,
): Promise<GateIdentitet | null> {
  if (!vaerdi) return null;
  const dele = vaerdi.split(".");
  if (dele.length !== 7) return null;
  const [version, id, session, rolle, konto, udloeberTekst, signaturTekst] = dele;
  if (version !== VERSION || id !== brugerId || session !== sessionId) return null;
  const udloeber = Number(udloeberTekst);
  if (!Number.isInteger(udloeber) || udloeber <= Math.floor(Date.now() / 1000)) return null;
  if (udloeber > Math.floor(Date.now() / 1000) + LEVETID_SEKUNDER) return null;
  const signatur = fraBase64Url(signaturTekst);
  if (!signatur) return null;
  const noegle = await hentNoegle();
  if (!noegle) return null;
  const data = `${version}.${id}.${session}.${rolle}.${konto}.${udloeberTekst}`;
  // crypto.subtle.verify sammenligner i konstant tid.
  const gyldig = await crypto.subtle.verify("HMAC", noegle, signatur, new TextEncoder().encode(data));
  if (!gyldig) return null;
  return { rolle, kontoType: konto === INGEN_KONTOTYPE ? null : konto };
}
