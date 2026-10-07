// Kortlivet, signeret cookie med brugerens staff-rolle til gaten før
// lancering (src/lib/supabase/middleware.ts). Uden den spurgte proxyen
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
//   det samme.
// - httpOnly, SameSite=Lax og Secure (undtagen lokalt på http).

import { logDriftFejl } from "@/lib/drift";
import { afledningsNoegle } from "@/lib/supabase/noegler";

export const ROLLE_COOKIE = "bh_rolle";
const LEVETID_SEKUNDER = 5 * 60;
const VERSION = "v1";

let noegleLoefte: Promise<CryptoKey | null> | null = null;
let advaret = false;

// Én advarsel pr. serverproces i produktion, når fallback'en bruges.
function advarOmFallback() {
  if (advaret || process.env.NODE_ENV !== "production") return;
  advaret = true;
  console.warn("ROLLE_COOKIE_HEMMELIGHED mangler - rolle-cookien signeres med service-role-nøglen.");
  void logDriftFejl({
    kilde: "server",
    sti: "/",
    hvor: "Rolle-cookie",
    fejl: "ROLLE_COOKIE_HEMMELIGHED mangler i produktion - rolle-cookien signeres med service-role-nøglen (fallback).",
  });
}

function hentNoegle(): Promise<CryptoKey | null> {
  if (!noegleLoefte) {
    noegleLoefte = (async () => {
      const egen = process.env.ROLLE_COOKIE_HEMMELIGHED;
      let tekst: string;
      if (egen) {
        tekst = `bidhamr-rolle-cookie-${VERSION}|egen|${egen}`;
      } else {
        // Den gamle afledning (uændret), så eksisterende cookies virker videre.
        const afledt = afledningsNoegle();
        if (!afledt) return null;
        advarOmFallback();
        tekst = `bidhamr-rolle-cookie-${VERSION}|${afledt}`;
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

// Den signerede værdi til cookien, eller null hvis den ikke kan laves.
export async function lavRolleCookie(
  brugerId: string,
  sessionId: string,
  rolle: string,
): Promise<{ vaerdi: string; maxAge: number } | null> {
  if (![brugerId, sessionId, rolle].every((d) => SIKKER_DEL.test(d))) return null;
  const noegle = await hentNoegle();
  if (!noegle) return null;
  const udloeber = Math.floor(Date.now() / 1000) + LEVETID_SEKUNDER;
  const data = `${VERSION}.${brugerId}.${sessionId}.${rolle}.${udloeber}`;
  const signatur = await crypto.subtle.sign("HMAC", noegle, new TextEncoder().encode(data));
  return { vaerdi: `${data}.${tilBase64Url(signatur)}`, maxAge: LEVETID_SEKUNDER };
}

// Rollen fra cookien, hvis signaturen er gyldig, den ikke er udløbet, og den
// hører til præcis denne bruger og session. Ellers null.
export async function laesRolleCookie(
  vaerdi: string | undefined,
  brugerId: string,
  sessionId: string,
): Promise<string | null> {
  if (!vaerdi) return null;
  const dele = vaerdi.split(".");
  if (dele.length !== 6) return null;
  const [version, id, session, rolle, udloeberTekst, signaturTekst] = dele;
  if (version !== VERSION || id !== brugerId || session !== sessionId) return null;
  const udloeber = Number(udloeberTekst);
  if (!Number.isInteger(udloeber) || udloeber <= Math.floor(Date.now() / 1000)) return null;
  if (udloeber > Math.floor(Date.now() / 1000) + LEVETID_SEKUNDER) return null;
  const signatur = fraBase64Url(signaturTekst);
  if (!signatur) return null;
  const noegle = await hentNoegle();
  if (!noegle) return null;
  const data = `${version}.${id}.${session}.${rolle}.${udloeberTekst}`;
  // crypto.subtle.verify sammenligner i konstant tid.
  const gyldig = await crypto.subtle.verify("HMAC", noegle, signatur, new TextEncoder().encode(data));
  return gyldig ? rolle : null;
}
