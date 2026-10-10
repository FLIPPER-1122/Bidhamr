// Tekster om MitID-verificering (ROADMAP-BESLUTNINGER, "MitID (Filip, 9. okt. 2026)").
// Leverandøren hedder Idura (tidligere Criipto). Ordet "forsikring" bruges aldrig.

export const MITID = {
  knap: "Bekræft med MitID",
  maerke: "MitID-verificeret",
  maerkeForklaring: "Brugeren har bekræftet sin identitet med MitID.",

  // Boksen før første bud / første auktion.
  kraevesTitelBud: "Bekræft dig med MitID for at byde",
  kraevesTitelSaelg: "Bekræft dig med MitID for at sælge",
  kraevesTekst:
    "Før dit første bud eller din første auktion skal du bekræfte, hvem du er, med MitID. Det tager et minut og sker kun én gang. Så ved alle på BidHamr, at de handler med en rigtig person.",
  kraevesPrivat:
    "Andre ser kun dit brugernavn og mærket \"MitID-verificeret\" – aldrig dit navn fra MitID. Vi får ikke dit CPR-nummer fra MitID.",

  // Maksimum (automatisk bud) fra en bruger uden MitID byder ikke videre.
  maksimumStoppet: "Bekræft med MitID for at fortsætte dit maksimumbud.",
  maksimumStoppetTekst:
    "Dit maksimumbud byder ikke automatisk for dig, før du har bekræftet dig med MitID. De bud, du allerede har afgivet, gælder stadig.",

  // Fejl fra databasen (BHV01).
  fejlMangler: "Bekræft dig med MitID, før du byder eller sætter varer til salg. Det gør du kun én gang.",

  // Resultat efter MitID (?mitid=...).
  resultat: {
    ok: "Tak. Du er nu MitID-verificeret og kan byde og sælge.",
    allerede: "Du er allerede MitID-verificeret.",
    afbrudt: "Du afbrød MitID. Du kan prøve igen, når du er klar.",
    dobbeltkonto:
      "Dit MitID er allerede brugt til en anden BidHamr-konto. Du kan kun have én konto. Log ind på den konto, du har i forvejen – eller skriv til support@bidhamr.dk, hvis du mener, det er en fejl.",
    under18: "Du skal være fyldt 18 år for at byde og sælge på BidHamr.",
    lukket:
      "Dit MitID hører til en konto, som BidHamr har lukket permanent. Derfor kan det ikke bruges til en ny konto. Skriv til support@bidhamr.dk, hvis du har spørgsmål.",
    tidligereSpaerret:
      "Dit MitID hører til en konto, der blev slettet, mens den var suspenderet eller havde for mange advarsler. Derfor kan det ikke bruges til en ny konto. Skriv til support@bidhamr.dk, hvis du har spørgsmål.",
    andenMitid:
      "Din konto er allerede bekræftet med et andet MitID. Skriv til support@bidhamr.dk, hvis du mener, det er en fejl.",
    erhverv: "Firmakonti skal ikke bekræftes med MitID.",
    udloebet: "Det tog for lang tid. Start forfra med \"Bekræft med MitID\".",
    fejl: "Noget gik galt med MitID. Prøv igen om lidt.",
    ikkeTilgaengelig: "MitID er ikke tilgængelig lige nu. Prøv igen senere.",
    forMange: "Du har prøvet for mange gange. Vent lidt, og prøv så igen.",
  },

  // Min konto.
  kontoTitel: "MitID",
  kontoVerificeret: (dato: string) => `Du er MitID-verificeret (siden ${dato}).`,
  kontoIkkeVerificeret:
    "Du er ikke bekræftet med MitID endnu. Det kræves, før du kan byde eller sætte varer til salg.",
  kontoNavn: "Navn fra MitID (vises aldrig for andre):",

  // Mere synlig MitID (Filip, 10. okt. 2026: "den er gemt lidt væk").
  // Velkomstsiden efter oprettelse.
  velkommenTitel: "Bekræft dig med MitID",
  velkommenTekst:
    "Så er du klar til at byde og sælge. Det tager et minut, og du gør det kun én gang.",
  springOver: "Spring over – jeg gør det senere",
  // Kortet øverst på Min konto.
  kontoKortTitel: "Du er ikke bekræftet med MitID endnu",
  kontoKortTekst:
    "Du skal bekræfte dig med MitID, før du kan byde eller sætte varer til salg. Det tager et minut, og du gør det kun én gang.",
  // Profilmenuen i topbaren.
  menuPunkt: "Bekræft med MitID",
  menuMangler: "MitID mangler",
  // Egen profil (kun ejeren ser det).
  profilEjer: "Ikke MitID-verificeret endnu – bekræft dig nu",
  // Hvorfor MitID - kort liste (velkomst, Min konto, boksen før bud/salg).
  hvorforTitel: "Hvorfor MitID?",
  hvorfor: [
    "Tryghed: alle, der byder og sælger, er rigtige personer.",
    "Mindre svindel: hver person kan kun have én konto. Bliver en konto lukket for svindel, kan personen ikke oprette en ny.",
    "Du skal være fyldt 18 år.",
    "Dit navn fra MitID bruger vi kun internt. Andre ser kun dit brugernavn.",
  ],
} as const;

export type MitIdResultat = keyof typeof MITID.resultat;

export const MITID_RESULTATER = Object.keys(MITID.resultat) as MitIdResultat[];

// Succes-tone eller fejl-tone.
export function erMitIdSucces(r: MitIdResultat): boolean {
  return r === "ok" || r === "allerede";
}
