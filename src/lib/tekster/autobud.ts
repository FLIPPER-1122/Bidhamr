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
    "Har to bydere et maksimum, fører den højeste til det laveste beløb, der slår det andet. Er de lige store, fører den, der satte sit først. Det andet maksimum vises aldrig – derfor kan budhistorikken springe.",
    "Har en anden allerede et maksimum på præcis det beløb, du byder, fører den anden. Så skal du byde mere.",
    "Du kan hæve dit maksimum når som helst. Fører du, kan du sænke det, men ikke under dit nuværende bud.",
  ],
  statusFoererMedMaks: (maks: string) => `Dit maksimum: ${maks}. Kun du kan se det.`,
  statusFoerer: "Du fører",
  statusOverbudt: "Du er overbudt",
  statusMaksNaaet: (maks: string) => `Dit maksimum på ${maks} er nået. Hæv det, hvis du stadig vil have varen.`,
  svarFoerer: (bud: string, maks: string) => `Du fører med ${bud}. Dit maksimum: ${maks}.`,
  svarOverbudt: (bud: string) =>
    `En anden byder har et lige så højt eller højere maksimum. Det højeste bud er nu ${bud}.`,
  // Efter "Byd én gang", hvis et maksimum straks bød over.
  svarOverbudtEfterEnkelt: (bud: string) =>
    `En anden byder havde et automatisk bud og fører nu med ${bud}.`,
  // Fører man, og vælger "Byd én gang".
  advarselFoererEnkelt: "Du fører allerede – vil du hæve dit maksimum i stedet?",
  knapSkiftTilMaks: "Hæv mit maksimum",
  // Fører man: knap ved "Du fører" og i budbjælken på mobil.
  knapRetMaks: "Ret maksimum",
  // BidHamr Beskyttelse kan ikke ændres via maksimum, mens man fører.
  beskyttelseLaast: "Følger dit førende bud og kan ikke ændres, mens du fører.",
  // Meget højt maksimum (> 10 × nuværende bud eller > 10.000 kr).
  bekraeftHoejtTitel: "Er du sikker? Dit maksimum er bindende.",
  bekraeftHoejtTekst: (maks: string) =>
    `Du er ved at sætte dit maksimum til ${maks}. Vinder du, kan du komme til at betale op til det beløb.`,
  bekraeftHoejtJa: "Ja, byd automatisk",
  bekraeftHoejtNej: "Ret beløbet",
  forlaenget: "Auktionen er forlænget med 2 minutter!",
  svarGemt: (maks: string) => `Dit maksimum er nu ${maks}.`,
  historikMarkering: "automatisk",
} as const;
