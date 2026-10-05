// Varens stand – faste valg ved oprettelse. Gør "ikke som beskrevet"-sager
// lettere at afgøre (staff ser standen i sagen).
//
// HOLD SYNKRON med auctions_stand_check og public.stand_normaliser() i
// supabase/migrations/20261006040000_auktionsfunktioner.sql. Databasen gemmer
// koden (fx 'som_ny'). Gamle værdier fra appen ('Ny', 'Som ny', 'Brugt',
// 'Defekt') oversættes automatisk til koder af databasen.
export const STAND_VALG = [
  { kode: "ny_med_maerke", navn: "Ny med mærke", beskrivelse: "Aldrig brugt, med mærker eller i original emballage." },
  { kode: "som_ny", navn: "Som ny", beskrivelse: "Brugt meget lidt, ingen synlige tegn på brug." },
  { kode: "god", navn: "God", beskrivelse: "Brugt, men velholdt. Små tegn på brug kan forekomme." },
  { kode: "brugt", navn: "Brugt", beskrivelse: "Tydelige tegn på brug, fx ridser eller slid. Virker som den skal." },
  { kode: "defekt", navn: "Defekt", beskrivelse: "Virker ikke, eller mangler dele. Beskriv fejlen." },
] as const;

export type Stand = (typeof STAND_VALG)[number]["kode"];

export function erStand(v: unknown): v is Stand {
  return STAND_VALG.some((s) => s.kode === v);
}

// Navn til visning. Ukendte/gamle værdier vises som de er; null = "Ikke angivet".
export function standNavn(v: string | null | undefined): string {
  if (!v) return "Ikke angivet";
  return STAND_VALG.find((s) => s.kode === v)?.navn ?? v;
}
