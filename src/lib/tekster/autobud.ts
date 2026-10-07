// Tekster til automatisk bud (maksimum) i budpanelet. Regler:
// ROADMAP-BESLUTNINGER.md, afsnittet "Autobud".
export const AUTOBUD = {
  valgEnkelt: "Byd én gang",
  valgAutomatisk: "Byd automatisk",
  feltLabel: "Dit maksimum",
  feltHjaelp:
    "Det højeste, du vil give. Vi byder det mindst mulige for dig – op til dit maksimum. Kun du kan se det.",
  bindende: "Dit maksimum er bindende. Vi byder kun så meget, som det kræver for at føre.",
  knapNy: "Byd automatisk",
  knapRet: "Gem nyt maksimum",
  totalLabel: "Du betaler højst i alt, hvis du vinder",
  forklaringTitel: "Sådan virker automatisk bud",
  forklaring: [
    "Du skriver det højeste beløb, du vil give. Sælgeren og de andre bydere kan aldrig se det.",
    "Byder en anden over dig, byder vi automatisk det mindst mulige for dig – indtil dit maksimum er nået.",
    "Har to bydere et maksimum, fører den højeste til det laveste beløb, der slår det andet. Er de lige store, fører den, der satte sit først.",
    "Du kan hæve dit maksimum når som helst. Fører du, kan du sænke det, men ikke under dit nuværende bud.",
  ],
  statusFoererMedMaks: (maks: string) => `Dit maksimum: ${maks}. Kun du kan se det.`,
  statusFoerer: "Du fører",
  statusOverbudt: "Du er overbudt",
  statusMaksNaaet: (maks: string) => `Dit maksimum på ${maks} er nået. Hæv det, hvis du stadig vil have varen.`,
  svarFoerer: (bud: string, maks: string) => `Du fører med ${bud}. Dit maksimum: ${maks}.`,
  svarOverbudt: (bud: string) =>
    `En anden byder har et højere maksimum. Det højeste bud er nu ${bud}.`,
  svarGemt: (maks: string) => `Dit maksimum er nu ${maks}.`,
  historikMarkering: "automatisk",
} as const;
