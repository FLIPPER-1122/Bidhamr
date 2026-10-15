// Tekster om "Populær sælger" og den månedlige lodtrækning om et gavekort
// (ROADMAP-BESLUTNINGER, "Nye funktioner (Filip, 13. okt. 2026)").
// Konkurrencebetingelserne er kun et udkast (jura/konkurrencebetingelser-
// udkast.md) - der linkes ikke til dem, før advokaten har godkendt dem.

export const POPULAER_SAELGER = {
  maerke: "Populær sælger",
  maerkeForklaring: "Sælgeren har gennemført mindst 50 salg til mindst 20 forskellige købere på BidHamr.",
};

const MAANEDER = [
  "januar",
  "februar",
  "marts",
  "april",
  "maj",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "december",
];

// "2026-10" -> "oktober 2026"
export function maanedNavn(maaned: string): string {
  const [aar, md] = maaned.split("-").map(Number);
  return `${MAANEDER[md - 1] ?? maaned} ${aar}`;
}

export const KONKURRENCE_KONTO = {
  titel: "Månedens lodtrækning",
  antal: (antal: number, maaned: string) =>
    antal === 1
      ? `Du har 1 lod i lodtrækningen om et gavekort i ${maanedNavn(maaned)}.`
      : `Du har ${antal} lod i lodtrækningen om et gavekort i ${maanedNavn(maaned)}.`,
  regel:
    "Du får én lod for hvert gennemført salg i måneden, dog højst én lod pr. køber. Et salg tæller i den måned, hvor pengene bliver frigivet til dig, og buddet skal være mindst 50 kr. Handler, der er annulleret eller refunderet, eller som har en åben sag, giver ikke lod.",
  ingen: "Sælg noget i denne måned, så er du med. Du skal ikke tilmelde dig.",
  erhverv: "Firmakonti deltager ikke i lodtrækningen.",
  staff: "Medarbejdere hos BidHamr deltager ikke i lodtrækningen.",
  konto: "Din konto deltager ikke i lodtrækningen lige nu.",
};

export const KONKURRENCE_ADMIN = {
  titel: "Konkurrence",
  forklaring:
    "Den månedlige lodtrækning om et gavekort. Alle private sælgere er med: én lod pr. gennemført salg (bud mindst 50 kr.) i den måned, hvor pengene blev frigivet, dog højst én lod pr. køber pr. sælger pr. måned. Firmakonti, medarbejdere, konti på pause eller frosset og handler med åben sag eller anke er ikke med. Vinderen kan trækkes, når måneden er slut.",
  grund: {
    erhverv: "Firmakonto",
    staff: "Medarbejder",
    lukket: "Lukket eller slettet konto",
    pause: "Konto på pause",
    frosset: "Konto frosset",
  } as Record<string, string>,
  koder: {
    ingen_adgang: "Kun chefen kan trække en vinder.",
    ugyldig_maaned: "Vælg en gyldig måned.",
    foer_start: "Konkurrencen var ikke startet i den måned, så der kan ikke trækkes en vinder.",
    maaned_ikke_slut: "Måneden er ikke slut endnu. Vinderen kan først trækkes, når måneden er slut.",
    ingen_deltagere: "Der er ingen deltagere i måneden, så der trækkes ingen vinder.",
    findes: "Der er allerede trukket en vinder for måneden.",
    grund_mangler: "Vælg, hvorfor der skal trækkes en ny vinder.",
    begrundelse_for_lang: "Uddybningen må højst være 2.000 tegn.",
    loft_naaet: "Der er allerede trukket en ny vinder for måneden. Der kan kun trækkes én ny vinder pr. måned.",
    svarfrist_ikke_udloebet: "Vinderens svarfrist er ikke udløbet endnu. Vælg \"Vinderen opfylder ikke betingelserne\", hvis det er grunden.",
    findes_ikke: "Lodtrækningen findes ikke.",
    allerede_erstattet: "Der er allerede trukket en ny vinder.",
    ingen_flere: "Der er ingen andre deltagere at trække blandt.",
  } as Record<string, string>,
  grundNyVinder: {
    svarer_ikke: "Vinderen har ikke svaret inden fristen",
    opfylder_ikke: "Vinderen opfylder ikke betingelserne",
  } as Record<string, string>,
  generisk: "Noget gik galt. Prøv igen, eller kontakt en udvikler.",
};
