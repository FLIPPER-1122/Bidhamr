// Regler for oprettelse af auktioner. Deles af opret-formularen og
// genopsætning (server action), så de altid er ens.

export const VARIGHEDER = [
  { label: "30 sekunder", dage: 0 },
  { label: "1 dag", dage: 1 },
  { label: "3 dage", dage: 3 },
  { label: "7 dage", dage: 7 },
] as const;

export type VarighedDage = (typeof VARIGHEDER)[number]["dage"];

export function erGyldigVarighed(dage: unknown): dage is VarighedDage {
  return VARIGHEDER.some((v) => v.dage === dage);
}

// Sluttidspunkt ud fra varighed (0 = 30 sekunder).
export function slutterKlFraVarighed(dage: VarighedDage, fra = new Date()): Date {
  const slut = new Date(fra);
  if (dage === 0) slut.setTime(slut.getTime() + 30 * 1000);
  else slut.setDate(slut.getDate() + dage);
  return slut;
}

// Startpris i hele kroner, 0 eller derover (som formularens felt: min 0, trin 1).
export const MAKS_STARTPRIS = 9_999_999_999;

export function valideStartpris(startpris: unknown): string | null {
  if (typeof startpris !== "number" || !Number.isFinite(startpris)) {
    return "Angiv en startpris.";
  }
  if (!Number.isInteger(startpris)) return "Startprisen skal være i hele kroner.";
  if (startpris < 0) return "Startprisen kan ikke være negativ.";
  if (startpris > MAKS_STARTPRIS) return "Startprisen er for høj.";
  return null;
}
