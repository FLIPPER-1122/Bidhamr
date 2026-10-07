import "server-only";

// Signerede links til DSA-sager (HMAC), så en anmelder uden login - eller en
// bruger med lukket/suspenderet konto - kan se sin sag og klage via mailen.
import { createHmac, timingSafeEqual } from "node:crypto";
import { logDriftFejl } from "@/lib/drift";
import { afledningsNoegle } from "@/lib/supabase/noeglerServer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function erUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// Nøglen: DSA_LINK_HEMMELIGHED (egen lang, tilfældig værdi, uafhængig af
// Supabases API-nøgler), ellers som før service-role-nøglen (afledningsNoegle
// i src/lib/supabase/noegler.ts). Linket giver kun adgang til at se én sag og
// klage. Mangler DSA_LINK_HEMMELIGHED i produktion, logges en advarsel i drift
// (én gang pr. serverproces) - fallback'en virker, men skiftes eller slås
// service-role-nøglen fra, holder alle gamle links op med at virke.
let advaret = false;
function noegle(): string {
  const egen = process.env.DSA_LINK_HEMMELIGHED;
  if (!egen && !advaret && process.env.NODE_ENV === "production") {
    advaret = true;
    console.warn("DSA_LINK_HEMMELIGHED mangler - DSA-links signeres med Supabase-nøglen.");
    void logDriftFejl({
      kilde: "server",
      sti: "/dsa",
      hvor: "DSA-links",
      fejl: "DSA_LINK_HEMMELIGHED mangler i produktion - links signeres med Supabase-nøglen (fallback).",
    });
  }
  const k = egen || afledningsNoegle();
  if (!k) throw new Error("Ingen nøgle til DSA-links");
  return k;
}

export type LinkType = "anmeldelse" | "afgoerelse";

export function dsaToken(type: LinkType, id: string): string {
  return tokenMed(noegle(), type, id);
}

// Overgang: links sendt før DSA_LINK_HEMMELIGHED blev sat, er signeret med
// afledningsnøglen. De godtages stadig, så gamle links i folks mails virker.
function tokenMed(k: string, type: LinkType, id: string): string {
  return createHmac("sha256", k)
    .update(`bidhamr-dsa:${type}:${id.toLowerCase()}`)
    .digest("base64url")
    .slice(0, 32);
}

export function tjekDsaToken(type: LinkType, id: string, token: unknown): boolean {
  if (typeof token !== "string" || token.length !== 32 || !erUuid(id)) return false;
  const b = Buffer.from(token);
  const noegler = [noegle(), afledningsNoegle()].filter(
    (k, i, alle): k is string => typeof k === "string" && k.length > 0 && alle.indexOf(k) === i,
  );
  let ok = false;
  for (const k of noegler) {
    const a = Buffer.from(tokenMed(k, type, id));
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

export function anmeldelseSti(id: string, medToken = true): string {
  return `/dsa/anmeldelse/${id}${medToken ? `?t=${dsaToken("anmeldelse", id)}` : ""}`;
}

export function afgoerelseSti(id: string, medToken = true): string {
  return `/dsa/afgoerelse/${id}${medToken ? `?t=${dsaToken("afgoerelse", id)}` : ""}`;
}

