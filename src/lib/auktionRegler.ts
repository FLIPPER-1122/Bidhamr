// Regler for auktioner. Deles af opret-formularen, redigering, budfeltet og
// genopsætning (server action), så de altid er ens. Databasen håndhæver de
// samme regler (supabase/migrations/20261004060000_auktionsregler.sql).

// Varighed: 3, 5, 7 eller 10 dage, 7 forvalgt (Filip, 4. oktober 2026).
export const VARIGHEDER = [
  { label: "3 dage", dage: 3 },
  { label: "5 dage", dage: 5 },
  { label: "7 dage", dage: 7 },
  { label: "10 dage", dage: 10 },
] as const;

export type VarighedDage = (typeof VARIGHEDER)[number]["dage"];

export const STANDARD_VARIGHED: VarighedDage = 7;

export function erGyldigVarighed(dage: unknown): dage is VarighedDage {
  return VARIGHEDER.some((v) => v.dage === dage);
}

// Sluttidspunkt ud fra varighed. Kun vejledende - databasen beregner selv
// sluttidspunktet ud fra varigheden.
export function slutterKlFraVarighed(dage: VarighedDage, fra = new Date()): Date {
  const slut = new Date(fra);
  slut.setTime(slut.getTime() + dage * 24 * 60 * 60 * 1000);
  return slut;
}

// Budstigning som trappe efter det nuværende højeste bud (Filip, 4. oktober
// 2026). Samme regel som public.budstigning i databasen.
export function budstigning(nuvaerende: number): number {
  if (nuvaerende < 100) return 5;
  if (nuvaerende < 1000) return 10;
  if (nuvaerende < 5000) return 50;
  return 100;
}

// Mindste tilladte næste bud. Uden bud: startprisen (mindst 1 kr). Med bud:
// nuværende bud + budstigning. Samme regel som public.naeste_bud_minimum.
export function mindsteNaesteBud(nuvaerendeBud: number | null, startpris: number): number {
  if (nuvaerendeBud === null) return Math.max(Math.ceil(startpris), 1);
  return nuvaerendeBud + budstigning(nuvaerendeBud);
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

// Anbefaling ved oprettelse og redigering.
export const STARTPRIS_ANBEFALING =
  "Sæt startprisen lidt under det, du regner med at få – er den for høj, byder ingen.";

export const BINDENDE_BUD_TEKST = "Dit bud er bindende og kan ikke trækkes tilbage.";

// Samme grænse som public.auktion_billeder_gyldige (1-10 billeder).
export const MAKS_BILLEDER = 10;
export const MAKS_TITEL = 120;
export const MAKS_BESKRIVELSE = 500;

// crypto.randomUUID() findes kun i sikre kontekster (https eller localhost) –
// adgang via en LAN-IP over http (fx fra en telefon på samme netværk) ville
// ellers fejle med en kryptisk TypeError.
function lavBilledeId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Sti til et nyt billede i bucket'en auktion-billeder: <bruger-id>/<id>.<endelse>.
// Databasen godtager kun filnavne af [A-Za-z0-9._-] (public.auktion_billeder_gyldige,
// 20261004061000_auktionsregler_rettelser.sql). Det originale filnavn (mellemrum,
// æøå osv.) bruges derfor ikke – kun en renset endelse.
export function auktionBilledeSti(brugerId: string, fil: { name: string; type?: string }): string {
  const fraNavn = fil.name.includes(".") ? (fil.name.split(".").pop() ?? "") : "";
  const fraType = fil.type?.startsWith("image/") ? fil.type.slice("image/".length) : "";
  const endelse =
    [fraNavn, fraType]
      .map((e) => e.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5))
      .find((e) => e.length > 0) ?? "jpg";
  return `${brugerId}/${lavBilledeId()}.${endelse}`;
}
