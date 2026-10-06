// Filtrene på /auktioner, som de står i URL'en. Læses ens af server-siden
// (første side) og af klienten (når man navigerer, trykker Tilbage eller
// ændrer et filter), så et delt link altid viser det samme.
// ?kategori=&q=&sortering=&postnummer=&afstand=
import { læsSortering, type Sortering } from "@/lib/sortering";

export const AFSTAND_STANDARD_KM = 50; // som filterbjælken, når kun postnummeret er givet
export const AFSTAND_MIN_KM = 5;
export const AFSTAND_MAX_KM = 150; // "Hele Danmark"
export const AFSTAND_TRIN_KM = 5;

export { læsSortering };
export type { Sortering };

// Kun fire cifre; alt andet ignoreres.
export function læsPostnummer(værdi: string | null | undefined): string {
  return /^\d{4}$/.test(værdi ?? "") ? værdi! : "";
}

// Afstand tæller kun sammen med et postnummer. Rundes til skyderens trin.
export function læsAfstand(postnummer: string, værdi: string | null | undefined): number | undefined {
  if (!postnummer) return undefined;
  const km = Number(værdi);
  return Number.isInteger(km) && km >= AFSTAND_MIN_KM && km <= AFSTAND_MAX_KM
    ? Math.round(km / AFSTAND_TRIN_KM) * AFSTAND_TRIN_KM
    : undefined;
}
