// Klient-API til cookie-samtykke. ALLE ikke-nødvendige scripts, pixels,
// iframes og cookies (statistik, markedsføring, video, kort, chat-widgets …)
// SKAL gå gennem dette modul, så de først indlæses efter samtykke:
//
//   if (harSamtykke("statistik")) { ... }               // engangstjek
//   const ok = useSamtykke("statistik");                 // i komponenter
//   useEffect(() => naarSamtykke("statistik", indlaes), []); // indlæs ved ja
//   <KraeverSamtykke kategori="statistik">…</KraeverSamtykke> // JSX
//
// Husk også: tilføj værktøjets cookies til COOKIES_PR_KATEGORI og tabellen på
// /cookies, og tæl SAMTYKKE_VERSION op (src/lib/samtykke.ts).
import { useSyncExternalStore } from "react";
import {
  COOKIES_PR_KATEGORI,
  SAMTYKKE_COOKIE,
  SAMTYKKE_KATEGORIER,
  SAMTYKKE_MAKS_SEKUNDER,
  fortolkSamtykke,
  gyldigSamtykkeVaerdi,
  lavSamtykkeVaerdi,
  type Samtykke,
  type SamtykkeKategori,
  type SamtykkeValg,
} from "@/lib/samtykke";

const AABN_EVENT = "bh:cookieindstillinger";
const lyttere = new Set<() => void>();
// Kategorier, hvor et script faktisk er indlæst i denne side-session. Trækkes
// samtykket tilbage for en af dem, genindlæses siden, så scriptet forsvinder.
const indlaesteKategorier = new Set<SamtykkeKategori>();

function laesCookie(navn: string): string | null {
  if (typeof document === "undefined") return null;
  for (const del of document.cookie.split(";")) {
    const i = del.indexOf("=");
    if (i < 0) continue;
    if (del.slice(0, i).trim() === navn) {
      try {
        return decodeURIComponent(del.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Rå cookieværdi, men kun hvis den er gyldig lige nu - ellers "". Bruges som
// snapshot i useSyncExternalStore (en streng er stabil mellem kald).
export function laesGyldigSamtykkeRaa(): string {
  // Samme normaliserede værdi som serveren sender (root-layoutet).
  return gyldigSamtykkeVaerdi(laesCookie(SAMTYKKE_COOKIE));
}

export function hentSamtykke(): Samtykke | null {
  return fortolkSamtykke(laesGyldigSamtykkeRaa(), Date.now());
}

// Må et værktøj i kategorien bruges? Altid false på serveren og uden valg.
export function harSamtykke(kategori: SamtykkeKategori): boolean {
  return hentSamtykke()?.valg[kategori] === true;
}

export function lytTilSamtykke(l: () => void): () => void {
  lyttere.add(l);
  return () => {
    lyttere.delete(l);
  };
}

function sletCookie(navn: string) {
  const udloeb = "expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = `${navn}=; ${udloeb}`;
  // Værktøjer sætter tit cookies på hoveddomænet (.bidhamr.dk).
  const dele = window.location.hostname.split(".");
  if (dele.length >= 2) {
    document.cookie = `${navn}=; ${udloeb}; domain=.${dele.slice(-2).join(".")}`;
  }
}

export function gemSamtykke(valg: SamtykkeValg) {
  const foer = hentSamtykke();
  const vaerdi = lavSamtykkeVaerdi(valg, Date.now());
  const sikker = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SAMTYKKE_COOKIE}=${encodeURIComponent(vaerdi)}; Max-Age=${SAMTYKKE_MAKS_SEKUNDER}; Path=/; SameSite=Lax${sikker}`;

  // Tilbagetrukket samtykke: fjern kategoriens cookies, og genindlæs siden,
  // hvis et af dens scripts allerede kører.
  let genindlaes = false;
  for (const { id } of SAMTYKKE_KATEGORIER) {
    if (valg[id]) continue;
    COOKIES_PR_KATEGORI[id].forEach(sletCookie);
    if (foer?.valg[id] && indlaesteKategorier.has(id)) genindlaes = true;
  }
  lyttere.forEach((l) => l());
  if (genindlaes) window.location.reload();
}

// Kører fn, så snart (og hvis) der er samtykke til kategorien - med det samme,
// hvis det allerede er givet. Returnerer en oprydningsfunktion til useEffect.
export function naarSamtykke(kategori: SamtykkeKategori, fn: () => void): () => void {
  let koert = false;
  const proev = () => {
    if (koert || !harSamtykke(kategori)) return;
    koert = true;
    indlaesteKategorier.add(kategori);
    fn();
  };
  proev();
  if (koert) return () => {};
  const af = lytTilSamtykke(proev);
  return af;
}

// Markerer, at et script i kategorien er indlæst (bruges af KraeverSamtykke).
export function markerIndlaest(kategori: SamtykkeKategori) {
  indlaesteKategorier.add(kategori);
}

export function useSamtykke(kategori: SamtykkeKategori): boolean {
  return useSyncExternalStore(
    lytTilSamtykke,
    () => harSamtykke(kategori),
    () => false,
  );
}

// Åbner cookieindstillingerne (footer-linket, /cookies-siden, admin-menuen).
export function aabnCookieindstillinger() {
  window.dispatchEvent(new Event(AABN_EVENT));
}

export function lytTilAabn(l: () => void): () => void {
  window.addEventListener(AABN_EVENT, l);
  return () => window.removeEventListener(AABN_EVENT, l);
}
