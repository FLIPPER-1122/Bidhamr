import "server-only";

// Den adgangskode, brugeren vælger ved oprettelse, sættes FØRST på kontoen,
// når e-mailen er bekræftet med koden (verificerSignupKode i
// src/app/actions/auth.ts -> bekraeftKode i src/lib/kontoOprettelse.ts).
// Indtil da ligger den krypteret i en kort cookie i brugerens egen browser.
// Gælder både åben og lukket tilmelding. Appen har ingen cookie og sender
// adgangskoden igen til POST /api/konto/bekraeft (docs/APP-SIGNUP.md).
//
// Hvorfor (review 11. okt. 2026): ellers kan en angriber, der kender en
// (inviteret) e-mail, oprette kontoen først med sin egen adgangskode - eller
// bagefter overskrive offerets - og logge ind, når offeret bekræfter. Nu
// bestemmes adgangskoden kun af den, der har koden fra mailen: kontoen
// oprettes med en tilfældig adgangskode, og den valgte sættes med
// updateUser i sessionen fra verifyOtp.
//
// Sikkerhed:
// - AES-256-GCM. Nøglen er SIGNUP_ADGANGSKODE_HEMMELIGHED (mindst 32 tegn,
//   tilfældig, kun på serveren - Filip sætter den i Vercel). Mangler den,
//   eller er den for kort (logges i drift), afledes
//   nøglen af service-role-nøglen (afledningsNoegle, som rolle-cookien), med
//   eget formål i afledningen. Mangler alt, gemmes intet (brugeren vælger så
//   adgangskode efter bekræftelsen).
// - Bundet til e-mailen (i klarteksten OG som "additional data"), gælder
//   højst 30 minutter, httpOnly, SameSite=Lax og Secure i produktion.
// - Cookien slettes efter bekræftelsen, uanset udfaldet.
import { cookies } from "next/headers";
import { logDriftFejl } from "@/lib/drift";
import { afledningsNoegle } from "@/lib/supabase/noeglerServer";

// I produktion (https) bruges __Host--præfikset: browseren godtager kun
// cookien med Secure, path "/" og uden domain, så den ikke kan sættes fra et
// underdomæne. Lokalt på http beholdes det gamle navn (uden Secure).
const PRODUKTION = process.env.NODE_ENV === "production";
export const VENTENDE_ADGANGSKODE_COOKIE = PRODUKTION ? "__Host-bh_ny_adgangskode" : "bh_ny_adgangskode";
const LEVETID_SEKUNDER = 30 * 60;
// Den egne nøgle skal være lang nok til at være tilfældig nok.
const MIN_HEMMELIGHED = 32;

let noegleLoefte: Promise<CryptoKey | null> | null = null;
let advaret = false;

// Én advarsel pr. serverproces i drift, når fallback'en bruges i produktion.
function advarOmFallback(grund: string) {
  if (advaret || !PRODUKTION) return;
  advaret = true;
  void logDriftFejl({
    kilde: "server",
    sti: "/",
    hvor: "Ventende adgangskode",
    fejl: `${grund} - den valgte adgangskode krypteres med en nøgle afledt af Supabase-nøglen (fallback).`,
  });
}

function hentNoegle(): Promise<CryptoKey | null> {
  if (!noegleLoefte) {
    noegleLoefte = (async () => {
      const egen = process.env.SIGNUP_ADGANGSKODE_HEMMELIGHED?.trim();
      let tekst: string;
      if (egen && egen.length >= MIN_HEMMELIGHED) {
        tekst = `bidhamr-signup-adgangskode-v1|egen|${egen}`;
      } else {
        advarOmFallback(
          egen
            ? `SIGNUP_ADGANGSKODE_HEMMELIGHED er for kort (under ${MIN_HEMMELIGHED} tegn)`
            : "SIGNUP_ADGANGSKODE_HEMMELIGHED mangler",
        );
        const afledt = afledningsNoegle();
        if (!afledt) return null;
        tekst = `bidhamr-signup-adgangskode-v1|${afledt}`;
      }
      const materiale = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst));
      return crypto.subtle.importKey("raw", materiale, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })().catch(() => null);
  }
  return noegleLoefte;
}

function tilBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
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

const aad = (email: string) => new TextEncoder().encode(`bh-signup|${email.toLowerCase()}`);

// Det, der venter på bekræftelsen: den valgte adgangskode og navn og
// vilkårsaccept (review 11. okt. 2026, V2) - så de kommer fra den, der har
// koden, og ikke fra den, der først oprettede kontoen.
export type VentendeSignup = {
  adgangskode: string;
  profil: { fornavn: string; efternavn: string; vilkaarVersion: string };
};

// Krypterer og gemmer det ventende til e-mailen. false = kunne ikke (ingen nøgle).
export async function gemVentendeAdgangskode(email: string, ventende: VentendeSignup): Promise<boolean> {
  const noegle = await hentNoegle();
  if (!noegle) return false;
  const e = email.toLowerCase();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const { fornavn: f, efternavn: l, vilkaarVersion: v } = ventende.profil;
  const klar = new TextEncoder().encode(
    JSON.stringify({ e, p: ventende.adgangskode, f, l, v, x: Math.floor(Date.now() / 1000) + LEVETID_SEKUNDER }),
  );
  const krypteret = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(e) }, noegle, klar),
  );
  const samlet = new Uint8Array(iv.length + krypteret.length);
  samlet.set(iv);
  samlet.set(krypteret, iv.length);
  (await cookies()).set(VENTENDE_ADGANGSKODE_COOKIE, tilBase64Url(samlet), {
    httpOnly: true,
    secure: PRODUKTION,
    sameSite: "lax",
    path: "/",
    maxAge: LEVETID_SEKUNDER,
  });
  return true;
}

// Det ventende, hvis cookien er gyldig, ikke udløbet og hører til netop
// denne e-mail. Ellers null.
export async function hentVentendeAdgangskode(email: string): Promise<VentendeSignup | null> {
  const vaerdi = (await cookies()).get(VENTENDE_ADGANGSKODE_COOKIE)?.value;
  if (!vaerdi) return null;
  const bytes = fraBase64Url(vaerdi);
  if (!bytes || bytes.length < 12 + 16) return null;
  const noegle = await hentNoegle();
  if (!noegle) return null;
  const e = email.toLowerCase();
  try {
    const klar = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(e) },
      noegle,
      bytes.slice(12),
    );
    const data = JSON.parse(new TextDecoder().decode(klar)) as Record<string, unknown>;
    if (data.e !== e || typeof data.p !== "string" || typeof data.x !== "number") return null;
    if (data.x <= Math.floor(Date.now() / 1000)) return null;
    if (typeof data.f !== "string" || typeof data.l !== "string" || typeof data.v !== "string") return null;
    return { adgangskode: data.p, profil: { fornavn: data.f, efternavn: data.l, vilkaarVersion: data.v } };
  } catch {
    return null;
  }
}

// Er der allerede en gyldig ventende adgangskode til netop denne e-mail i
// browseren? (Så kan den opdateres uden en ny kode - se opretKonto.)
export async function harVentendeAdgangskode(email: string): Promise<boolean> {
  return (await hentVentendeAdgangskode(email)) !== null;
}

export async function sletVentendeAdgangskode(): Promise<void> {
  (await cookies()).delete(VENTENDE_ADGANGSKODE_COOKIE);
}
