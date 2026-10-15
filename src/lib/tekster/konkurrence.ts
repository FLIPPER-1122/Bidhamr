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

// Besked til vinderen, så snart der er trukket lod (Filip, 15. okt. 2026).
// Følger konkurrencebetingelserne (jura/konkurrencebetingelser-udkast.md):
// 7.1 besked på mail og på BidHamr, og vi beder aldrig om adgangskode, kort
// eller betaling; 7.2 svar inden for 14 dage og bekræft præmien; 7.3 ellers
// bortfalder præmien, og der trækkes en ny vinder; 8.1-8.2 vi spørger om
// samtykke til fornavn og by, og præmien gives uanset svaret.
// Præmien (butik og beløb) er ikke fastlagt endnu, så den nævnes kun som
// "et gavekort". frist er en færdig dansk tidsangivelse, fx
// "29. november 2026 kl. 14.03".
export const KONKURRENCE_VINDER = {
  emne: (maaned: string) => `Du har vundet lodtrækningen i ${maanedNavn(maaned)}`,
  titel: "Du har vundet månedens gavekort",
  notifikation: (maaned: string, frist: string) =>
    `Tillykke! Du er trukket som vinder af lodtrækningen om et gavekort for ${maanedNavn(maaned)}. Svar os senest ${frist} i beskeden fra BidHamr, så sender vi præmien.`,
  notifikationKontakt: (maaned: string, frist: string) =>
    `Tillykke! Du er trukket som vinder af lodtrækningen om et gavekort for ${maanedNavn(maaned)}. Skriv til os senest ${frist} på support@bidhamr.dk, så sender vi præmien.`,
  chat: (maaned: string, frist: string) =>
    [
      `Tillykke! Du er trukket som vinder af BidHamrs lodtrækning om et gavekort for ${maanedNavn(maaned)}.`,
      `Svar her i beskeden senest ${frist} (14 dage efter lodtrækningen), og bekræft, at du vil have præmien. Svarer du ikke inden fristen, bortfalder præmien, og vi trækker en ny vinder.`,
      "Skriv også, om vi må nævne dit fornavn og din by, når vi fortæller, hvem der har vundet. Du får præmien, uanset hvad du svarer.",
      "Vi spørger aldrig om din adgangskode eller dine kortoplysninger, og du skal ikke betale noget for at få præmien.",
    ].join("\n\n"),
  mail: {
    emne: "Du har vundet månedens gavekort på BidHamr",
    preheader: (frist: string) => `Svar os senest ${frist}, så sender vi præmien.`,
    overskrift: "Tillykke – du har vundet!",
    intro: (maaned: string) =>
      `Du er trukket som vinder af BidHamrs lodtrækning om et gavekort for ${maanedNavn(maaned)}. Du var med, fordi du har gennemført salg på BidHamr i måneden.`,
    svarBeskeder: (frist: string) =>
      `Svar os senest ${frist}, og bekræft, at du vil have præmien. Du svarer i beskeden fra BidHamr – tryk på knappen herunder.`,
    svarKontakt: (frist: string) =>
      `Svar os senest ${frist}, og bekræft, at du vil have præmien. Skriv til support@bidhamr.dk.`,
    frist: "Svarer du ikke inden for 14 dage efter lodtrækningen, bortfalder præmien, og vi trækker en ny vinder.",
    samtykke:
      "Skriv også, om vi må nævne dit fornavn og din by, når vi fortæller, hvem der har vundet. Du får præmien, uanset hvad du svarer.",
    sikkerhed:
      "Vi spørger aldrig om din adgangskode eller dine kortoplysninger, og du skal ikke betale noget for at få præmien. Får du en besked, der gør det, er den ikke fra os.",
    infoMaaned: "Lodtrækning",
    infoFrist: "Svar senest",
    knapBeskeder: "Svar på beskeden",
    knapKontakt: "Kontakt BidHamr",
    aarsag: "Du får denne mail, fordi du er trukket som vinder i BidHamrs månedlige lodtrækning blandt private sælgere.",
  },
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
  // Den automatiske besked til vinderen (src/lib/konkurrence/vinderBesked.ts).
  vinderSamtaleFindes: "Vinderen har en samtale med BidHamr, hvor vinderen svarer.",
  // Mailens faktiske status (notifikation_afsendelser).
  vinderMail: {
    sendt: "Mail til vinderen: sendt.",
    fejl: "Mail til vinderen: kunne ikke sendes. Skriv selv til vinderen.",
    i_gang: "Mail til vinderen: er ved at blive sendt. Opdatér siden om lidt.",
    ikke_sendt: "Mail til vinderen: ikke sendt endnu.",
    ukendt: "Mail til vinderen: status kunne ikke hentes.",
  } as Record<string, string>,
  vinderBeskedMangler:
    "Vinderen har ikke fået en samtale med BidHamr. Send beskeden igen, eller skriv selv til vinderen.",
  vinderSamtale: "Se samtalen med vinderen",
  vinderBeskedKnap: "Send besked til vinderen",
  vinderBeskedForklaring:
    "Vinderen får en samtale med BidHamr, en notifikation og en mail med svarfristen. Har vinderen allerede fået mailen, sendes den ikke igen.",
  vinderBeskedKvittering: "Beskeden er sendt til vinderen.",
  kvitteringTrukket: "Vinderen er trukket og har fået besked.",
  vinderBesked: {
    allerede: "Vinderen har allerede fået mailen og notifikationen.",
    ingen_vinder: "Der er ingen gældende vinder at give besked.",
    fejl: "Beskeden kunne ikke sendes. Prøv igen om lidt.",
  } as Record<string, string>,
  generisk: "Noget gik galt. Prøv igen, eller kontakt en udvikler.",
};
