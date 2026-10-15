// Tekster om boost (hjemmesiden og appen bør bruge de samme). Ingen
// hemmeligheder - kan bruges i klient-kode. Tallene (point, pris, timer)
// kommer fra databasen (boost_indstillinger via mine_point /
// min_auktion_boost), så de kun står ét sted.

const kr = (oere: number) =>
  (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: oere % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });

export const BOOST_TEKST = {
  // Mærket på kort og auktionsside (markedsføringsloven: betalt placering).
  maerke: "Boostet",
  maerkeForklaring: "Sælgeren har betalt for at få auktionen vist øverst.",
  sektionTitel: "Boostede auktioner",
  sektionIntro: "Sælgerne har betalt for at få disse auktioner vist øverst.",

  sideTitel: "Boost-point",
  sideIntro:
    "Med boost-point kan du lægge din auktion øverst på forsiden, i kategorien og i søgningen, så flere ser den. Boostede auktioner vises med mærket \"Boostet\".",
  saldo: (point: number) => `${point.toLocaleString("da-DK")} point`,
  saldoLabel: "Din saldo",
  koebKnap: (point: number, prisOere: number) => `Køb ${point} point – ${kr(prisOere)} kr.`,
  betalKnap: (prisOere: number) => `Betal ${kr(prisOere)} kr.`,
  boostKnap: (timer: number, point: number) => `Boost i ${timer} timer (${point} point)`,
  saadan: (
    pakkePoint: number,
    prisOere: number,
    boostPoint: number,
    timer: number,
    prSalg: number,
    minBudOere: number,
    maksPrKoeber: number,
  ) => [
    `Køb ${pakkePoint} point for ${kr(prisOere)} kr. (inkl. moms). Du får en faktura fra BidHamr.`,
    `Et boost koster ${boostPoint} point og lægger din auktion øverst i ${timer} timer.`,
    `Du får ${prSalg} point for hvert salg på mindst ${kr(minBudOere)} kr., når pengene er udbetalt til dig – højst ${maksPrKoeber} point pr. køber pr. måned. Bliver handlen refunderet, trækkes pointene tilbage.`,
  ],
  betalingIntro: "Betalingen håndteres af vores betalingspartner Stripe.",
  betalingBehandles: "Din betaling behandles. Dine point kommer, så snart betalingen er gennemført.",
  koebGennemfoert: (point: number) => `Tak for dit køb. Du har fået ${point} point.`,
  allerede_betalt: "Købet er allerede betalt. Opdatér siden for at se dine point.",
  historikTitel: "Historik",
  historikTom: "Du har ingen point-bevægelser endnu.",
  kunPrivate: "Boost er kun for private sælgere. Firmakonti kan ikke købe eller bruge boost.",
  spaerret: "Din konto kan ikke bruge boost lige nu. Kontakt BidHamr, hvis du har spørgsmål.",
  samtykkeMangler: "Du skal acceptere vilkårene for købet.",
  samtykkeTekst:
    "Jeg ønsker, at pointene leveres med det samme, og accepterer, at min fortrydelsesret bortfalder, når jeg bruger dem.",

  // Historik-linjer.
  type: {
    koeb: "Købt",
    optjening: "Optjent ved salg",
    forbrug: "Boost",
    tilbagefoersel: "Trukket tilbage",
    staff: "Justeret af BidHamr",
  } as Record<string, string>,

  // Auktionssiden (ejeren).
  auktionTitel: "Boost din auktion",
  auktionIntro: (timer: number) =>
    `Læg auktionen øverst på forsiden, i kategorien og i søgningen i ${timer} timer. Den vises med mærket "Boostet".`,
  boostetTil: (kl: string) => `Din auktion er boostet til ${kl}.`,
  duHar: (point: number) => `Du har ${point.toLocaleString("da-DK")} point.`,
  forFaaPoint: (saldo: number, pris: number) =>
    `Du har ${saldo.toLocaleString("da-DK")} point. Et boost koster ${pris} point.`,
  slutterSnart: "Auktionen slutter snart, så den kan ikke boostes.",
  bekraeftTitel: "Boost auktionen?",
  bekraeftTekst: (point: number, timer: number) =>
    `Der trækkes ${point} point fra din saldo, og auktionen ligger øverst i ${timer} timer. Det kan ikke fortrydes.`,
  boostGennemfoert: (kl: string) => `Auktionen er boostet til ${kl}.`,

  fejl: {
    ugyldig: "Ugyldig forespørgsel.",
    boostet: "Auktionen er allerede boostet.",
    for_faa_point: "Du har ikke point nok til et boost.",
    ikke_ejer: "Du kan kun booste dine egne auktioner.",
    ikke_aktiv: "Auktionen kan ikke boostes, fordi den ikke er aktiv.",
    slutter_snart: "Auktionen slutter snart, så den kan ikke boostes.",
    erhverv: "Boost er kun for private sælgere. Firmakonti kan ikke købe eller bruge boost.",
    spaerret: "Din konto kan ikke bruge boost lige nu. Kontakt BidHamr, hvis du har spørgsmål.",
    ikke_fundet: "Auktionen findes ikke.",
    laast: "Dine boost-point er midlertidigt låst, mens en betaling bliver undersøgt.",
    fejl: "Noget gik galt. Prøv igen om lidt.",
  },
} as const;

export function boostKr(oere: number): string {
  return kr(oere);
}
