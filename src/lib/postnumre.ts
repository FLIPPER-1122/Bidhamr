import { POSTNUMRE } from "@/data/postnumre";
import { beregnAfstandKm } from "@/lib/distance";

// Synkront opslag i den lokale postnummerliste (src/data/postnumre.ts).
// Virker både på serveren og i browseren – ingen netværkskald.

export interface PostnummerOpslag {
  postnummer: string;
  by: string;
  lat: number;
  lng: number;
}

export const UKENDT_POSTNUMMER = "Postnummeret findes ikke – tjek, at det er rigtigt.";

/** Returnerer by og koordinat for et dansk postnummer, eller null hvis det ikke findes. */
export function slaaPostnummerOp(nr: string | null | undefined): PostnummerOpslag | null {
  if (typeof nr !== "string") return null;
  const postnummer = nr.trim();
  if (!/^\d{4}$/.test(postnummer)) return null;
  if (!Object.prototype.hasOwnProperty.call(POSTNUMRE, postnummer)) return null;
  const [by, lat, lng] = POSTNUMRE[postnummer];
  return { postnummer, by, lat, lng };
}

/** Afstand i km mellem to postnumre (luftlinje), eller null hvis et af dem er ukendt. */
export function afstandMellemPostnumre(a: string, b: string): number | null {
  const fra = slaaPostnummerOp(a);
  const til = slaaPostnummerOp(b);
  if (!fra || !til) return null;
  return beregnAfstandKm(fra.lat, fra.lng, til.lat, til.lng);
}
