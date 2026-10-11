import "server-only";

// Den adgangskode, brugeren vælger ved oprettelse, sættes FØRST på kontoen,
// når e-mailen er bekræftet med koden (verificerSignupKode i
// src/app/actions/auth.ts). Indtil da ligger den krypteret i en kort cookie
// i brugerens egen browser.
//
// Hvorfor (review 11. okt. 2026): ellers kan en angriber, der kender en
// (inviteret) e-mail, oprette kontoen først med sin egen adgangskode - eller
// bagefter overskrive offerets - og logge ind, når offeret bekræfter. Nu
// bestemmes adgangskoden kun af den, der har koden fra mailen: beta-kontoen
// oprettes med en tilfældig adgangskode, og den valgte sættes med
// updateUser i sessionen fra verifyOtp.
//
// Sikkerhed:
// - AES-256-GCM. Nøglen er SIGNUP_ADGANGSKODE_HEMMELIGHED (lang, tilfældig,
//   kun på serveren - Filip sætter den i Vercel). Mangler den, afledes
//   nøglen af service-role-nøglen (afledningsNoegle, som rolle-cookien), med
//   eget formål i afledningen. Mangler alt, gemmes intet (brugeren vælger så
//   adgangskode efter bekræftelsen).
// - Bundet til e-mailen (i klarteksten OG som "additional data"), gælder
//   højst 30 minutter, httpOnly, SameSite=Lax og Secure i produktion.
// - Cookien slettes efter bekræftelsen, uanset udfaldet.
import { cookies } from "next/headers";
import { afledningsNoegle } from "@/lib/supabase/noeglerServer";

export const VENTENDE_ADGANGSKODE_COOKIE = "bh_ny_adgangskode";
const LEVETID_SEKUNDER = 30 * 60;

let noegleLoefte: Promise<CryptoKey | null> | null = null;

function hentNoegle(): Promise<CryptoKey | null> {
  if (!noegleLoefte) {
    noegleLoefte = (async () => {
      const egen = process.env.SIGNUP_ADGANGSKODE_HEMMELIGHED;
      let tekst: string;
      if (egen) {
        tekst = `bidhamr-signup-adgangskode-v1|egen|${egen}`;
      } else {
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

// Krypterer og gemmer adgangskoden til e-mailen. false = kunne ikke (ingen nøgle).
export async function gemVentendeAdgangskode(email: string, adgangskode: string): Promise<boolean> {
  const noegle = await hentNoegle();
  if (!noegle) return false;
  const e = email.toLowerCase();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const klar = new TextEncoder().encode(
    JSON.stringify({ e, p: adgangskode, x: Math.floor(Date.now() / 1000) + LEVETID_SEKUNDER }),
  );
  const krypteret = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(e) }, noegle, klar),
  );
  const samlet = new Uint8Array(iv.length + krypteret.length);
  samlet.set(iv);
  samlet.set(krypteret, iv.length);
  (await cookies()).set(VENTENDE_ADGANGSKODE_COOKIE, tilBase64Url(samlet), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: LEVETID_SEKUNDER,
  });
  return true;
}

// Adgangskoden, hvis cookien er gyldig, ikke udløbet og hører til netop
// denne e-mail. Ellers null.
export async function hentVentendeAdgangskode(email: string): Promise<string | null> {
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
    const data = JSON.parse(new TextDecoder().decode(klar)) as { e?: unknown; p?: unknown; x?: unknown };
    if (data.e !== e || typeof data.p !== "string" || typeof data.x !== "number") return null;
    if (data.x <= Math.floor(Date.now() / 1000)) return null;
    return data.p;
  } catch {
    return null;
  }
}

export async function sletVentendeAdgangskode(): Promise<void> {
  (await cookies()).delete(VENTENDE_ADGANGSKODE_COOKIE);
}
