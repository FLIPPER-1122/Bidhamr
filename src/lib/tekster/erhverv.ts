// Tekster til erhvervskonti: siden /erhverv, formularen, velkomstmailen,
// Firma oversigt, admin og menuerne. Regler: ROADMAP-BESLUTNINGER.md,
// afsnittet "Erhvervskonti", og ROADMAP.md "Fase 7".
//
// Målgruppen er primært ældre mennesker med små firmaer. Derfor: korte
// sætninger, almindelige ord, ingen engelske ord, én ting ad gangen.
//
// Husk:
// - Ingen priser på den offentlige side. Priser vises kun i Firma oversigt.
// - BidHamr Beskyttelse gælder IKKE ved køb fra erhverv – nævnes ikke her.
// - BidHamr holder aldrig penge – betalingen håndteres af Stripe.
// - Et firma kan aldrig oprette sin egen firmakonto. BidHamr gør det.

// ---------------------------------------------------------------------------
// 1. Menuer
// ---------------------------------------------------------------------------

export const ERHVERV_MENU = {
  // Knappen i menuen øverst. Vises også for folk, der ikke er logget ind.
  topmenu: "Erhverv",
  // Profilmenuen for en firmakonto viser kun disse to punkter.
  profilmenuFirmaOversigt: "Firma oversigt",
  profilmenuLogUd: "Log ud",
} as const;

// ---------------------------------------------------------------------------
// 2. Siden /erhverv
// ---------------------------------------------------------------------------

export const ERHVERV_SIDE = {
  titel: "Sælg på BidHamr med dit firma",
  metabeskrivelse:
    "Har du et firma med dansk CVR-nummer? Sælg dine varer på auktion til hele Danmark. Vi hjælper dig i gang personligt.",
  intro: [
    "Har du en genbrugsbutik, et lager eller et værksted? Så kan du sælge dine varer på auktion hos BidHamr.",
    "Vi hjælper dig i gang. Du skal bare udfylde en kort formular, så kontakter vi dig.",
  ],

  fordeleOverskrift: "Det kan du som erhverv på BidHamr",
  fordele: [
    {
      titel: "Sælg til hele Danmark",
      tekst: "Dine varer kommer på auktion, hvor købere fra hele landet kan byde.",
    },
    {
      titel: "Nye og brugte varer",
      tekst: "Du må sælge både brugte og nye varer. Fx ting fra et dødsbo, et overskudslager eller udgåede modeller.",
    },
    {
      titel: "Din egen oversigt",
      tekst: "Du kan se, hvad du har solgt, og hvor mange der har set dine auktioner.",
    },
    {
      titel: "Regninger samlet ét sted",
      tekst: "Alle regninger fra BidHamr ligger samlet i din oversigt. Så er de nemme at finde.",
    },
    {
      titel: "Vi hjælper dig personligt",
      tekst: "Du får en fast aftale med os. Vi hjælper dig i gang, og du kan altid kontakte os.",
    },
    {
      titel: "Sikker betaling",
      tekst: "Betalingen håndteres af vores betalingspartner Stripe.",
    },
    {
      titel: "Købere kan se, at du er et rigtigt firma",
      tekst: "Dine auktioner får mærket \"Erhvervssælger\". Købere kan se dit firmanavn og dit CVR-nummer.",
    },
  ],

  trinOverskrift: "Sådan kommer du i gang",
  trin: [
    {
      titel: "Udfyld formularen",
      tekst: "Skriv lidt om dit firma, og hvad du sælger. Det tager kun et par minutter.",
    },
    {
      titel: "Vi kontakter dig",
      tekst: "Vi ringer eller skriver til dig. Sammen finder vi den aftale, der passer til dit firma.",
    },
    {
      titel: "Vi opretter din konto",
      tekst: "Vi opretter firmakontoen for dig. Du får en mail, hvor du vælger din adgangskode. Så er du klar.",
    },
  ],

  // Knappen, der åbner formularen, og den lille tekst ved den.
  knapFormular: "Formular",
  knapTekst: "Udfyld formularen, så kontakter vi dig. Det er gratis og uforpligtende.",

  faqOverskrift: "Spørgsmål og svar",
  faq: [
    {
      spoergsmaal: "Hvem kan sælge som erhverv?",
      svar: "Firmaer med et aktivt dansk CVR-nummer. Det kan fx være et ApS, et A/S eller en enkeltmandsvirksomhed. Foreninger og udenlandske firmaer kan ikke være med lige nu.",
    },
    {
      spoergsmaal: "Kan jeg selv oprette en firmakonto?",
      svar: "Nej. Vi opretter den for dig, når vi har talt sammen og lavet en aftale. Så er vi sikre på, at alt passer.",
    },
    {
      spoergsmaal: "Hvad koster det?",
      svar: "Det aftaler vi med dig, når vi har talt sammen. Udfyld formularen, så kontakter vi dig.",
    },
    {
      spoergsmaal: "Hvor mange auktioner kan jeg have?",
      svar: "Det afhænger af din aftale. Du kan altid få flere auktioner om ugen senere.",
    },
    {
      spoergsmaal: "Skal jeg også have en privat konto?",
      svar: "Nej. Men en firmakonto kan kun sælge. Vil du selv købe noget på BidHamr, skal du bruge en privat konto.",
    },
    {
      spoergsmaal: "Jeg sælger fra mit firma. Må jeg bruge min private konto?",
      svar: "Nej. Sælger du varer fra dit firma, skal du have en firmakonto.",
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// 3. Formularen
// ---------------------------------------------------------------------------

export const ERHVERV_FORMULAR = {
  titel: "Fortæl os om dit firma",
  intro: "Udfyld felterne herunder. Så kontakter vi dig hurtigst muligt. Felter med \"(valgfri)\" kan du springe over.",
  valgfri: "(valgfri)",

  felter: {
    firmanavn: {
      label: "Firmanavn",
      hjaelp: "Navnet på dit firma, som det står i CVR-registret.",
      pladsholder: "Fx Hansens Genbrug ApS",
    },
    cvr: {
      label: "CVR-nummer",
      hjaelp: "8 cifre. Du finder det på dine regninger eller på virk.dk.",
      pladsholder: "12345678",
    },
    kontaktperson: {
      label: "Dit navn",
      hjaelp: "Den person, vi skal tale med.",
      pladsholder: "Fx Karen Hansen",
    },
    telefon: {
      label: "Telefonnummer",
      hjaelp: "Vi ringer måske til dig for at lave en aftale.",
      pladsholder: "12 34 56 78",
    },
    email: {
      label: "E-mail",
      hjaelp: "Vi sender svar til denne e-mail.",
      pladsholder: "navn@firma.dk",
    },
    adresse: {
      label: "Adresse",
      hjaelp: "Firmaets adresse.",
      pladsholder: "Fx Storegade 12",
    },
    postnummer: {
      label: "Postnummer",
      hjaelp: "",
      pladsholder: "1234",
    },
    by: {
      label: "By",
      hjaelp: "",
      pladsholder: "Fx Odense",
    },
    hvadSaelger: {
      label: "Hvad sælger I?",
      hjaelp: "Skriv med dine egne ord. Fx møbler, værktøj eller ting fra dødsboer.",
      pladsholder: "Fx brugte møbler og lamper",
    },
    antalVarer: {
      label: "Cirka hvor mange varer vil I sælge om måneden?",
      hjaelp: "Et skøn er fint.",
      pladsholder: "Fx 10",
    },
    besked: {
      label: "Besked",
      hjaelp: "Er der andet, vi skal vide? Fx hvornår vi bedst kan ringe.",
      pladsholder: "Skriv din besked her",
    },
  },

  knapSend: "Send formularen",
  knapSender: "Sender …",

  fejl: {
    // Vises under et tomt felt, der skal udfyldes.
    mangler: "Dette felt skal udfyldes.",
    manglerFlere: "Nogle felter mangler. De er markeret med rødt.",
    cvrUgyldigt: "CVR-nummeret skal være 8 cifre. Tjek, at du har skrevet det rigtigt.",
    cvrIkkeFundet:
      "Vi kan ikke finde et aktivt dansk firma med det CVR-nummer. Tjek, at du har skrevet det rigtigt.",
    emailUgyldig: "Den e-mail ser forkert ud. Tjek, at den er skrevet rigtigt, fx navn@firma.dk.",
    telefonUgyldigt: "Telefonnummeret ser forkert ud. Skriv 8 cifre, fx 12 34 56 78.",
    postnummerUgyldigt: "Postnummeret skal være 4 cifre.",
    forLang: "Teksten er for lang. Gør den lidt kortere.",
    forMangeForsoeg: "Du har sendt formularen mange gange på kort tid. Vent lidt, og prøv igen senere.",
    generisk:
      "Formularen blev ikke sendt. Prøv igen om lidt. Virker det stadig ikke, så skriv til support@bidhamr.dk.",
  },

  kvittering: {
    titel: "Tak for din henvendelse",
    tekst: "Vi har fået din formular. Vi kontakter dig hurtigst muligt.",
    tekst2: "Du behøver ikke gøre mere lige nu.",
    knapForside: "Til forsiden",
  },
} as const;

// ---------------------------------------------------------------------------
// 4. Velkomstmail (Supabase "Invite user")
// HTML-versionen ligger i supabase/templates/invite.html. Hold teksterne ens.
// ---------------------------------------------------------------------------

export const ERHVERV_VELKOMSTMAIL = {
  emne: "Velkommen til BidHamr – vælg din adgangskode",
  forhaandsvisning: "Din firmakonto er klar. Vælg din adgangskode for at komme i gang.",
  overskrift: "Velkommen til BidHamr",
  tekst: [
    "Din firmakonto er nu klar.",
    "Tryk på knappen herunder, og vælg din adgangskode. Så kan du logge ind og se din Firma oversigt.",
  ],
  knap: "Vælg din adgangskode",
  // Linket følger "Email OTP expiration" i Supabase (i dag 3600 sekunder).
  // Ret teksten, hvis indstillingen ændres.
  udloeber: "Linket virker i 1 time. Er det udløbet, så skriv til os, så sender vi et nyt.",
  separatKonto: "Firmakontoen er en ny konto. Har du også en privat konto, er den ikke ændret.",
  hjaelp: "Har du spørgsmål? Skriv til os på support@bidhamr.dk.",
  fodnote: (email: string) =>
    `Du får denne mail, fordi BidHamr har oprettet en firmakonto til ${email}. Har du ikke talt med os, kan du se bort fra mailen.`,
} as const;

// ---------------------------------------------------------------------------
// 5. Firma oversigt
// ---------------------------------------------------------------------------

export const FIRMA_OVERSIGT = {
  titel: "Firma oversigt",
  intro: "Her har du det hele samlet ét sted.",

  // Vises øverst, hvis abonnementet ikke er sat i gang endnu.
  ikkeAktiv: {
    titel: "Din konto er ikke klar til salg endnu",
    tekst: "Du kan oprette auktioner, når din pakke er sat i gang. Vi kontakter dig om betalingen.",
  },

  overblik: {
    titel: "Overblik",
    forklaring: "Det, dine solgte varer har indbragt.",
    denneMaaned: "Indtjent denne måned",
    iAlt: "Indtjent i alt",
    udbetalt: "Udbetalt til dig",
    paaVej: "På vej til dig",
    paaVejHjaelp:
      "Pengene udbetales, når køberens frist for at fortryde er gået. Betalingen håndteres af vores betalingspartner Stripe.",
    tom: "Du har ikke solgt noget endnu. Når du sælger, kan du se det her.",
  },

  auktioner: {
    titel: "Dine auktioner",
    forklaring: "De auktioner, der kører lige nu.",
    aktive: (antal: number) => (antal === 1 ? "1 auktion kører" : `${antal} auktioner kører`),
    ugensAuktioner: (brugt: number, ialt: number, naesteLedige: string) =>
      `Du har brugt ${brugt} af ${ialt} auktioner denne uge. Næste ledige: ${naesteLedige}.`,
    ledigeNu: (brugt: number, ialt: number) =>
      `Du har brugt ${brugt} af ${ialt} auktioner denne uge.`,
    alleBrugt: (naesteLedige: string) =>
      `Du har brugt alle dine auktioner denne uge. Du kan oprette en ny ${naesteLedige}. Vil du have flere om ugen, så se Abonnement.`,
    knapOpret: "Opret en auktion",
    knapSeAlle: "Se alle dine auktioner",
    tom: "Du har ingen auktioner lige nu. Tryk på \"Opret en auktion\" for at komme i gang.",
  },

  visninger: {
    titel: "Visninger",
    forklaring: "Hvor mange gange dine auktioner er blevet set.",
    seneste7: "Seneste 7 dage",
    seneste30: "Seneste 30 dage",
    iAlt: "I alt",
    bud: "Bud på dine auktioner",
    tom: "Ingen har set dine auktioner endnu. Tallene kommer, når du har en auktion.",
  },

  salg: {
    titel: "Salg",
    forklaring: "De varer, du har solgt.",
    kolonneVare: "Vare",
    kolonneDato: "Solgt",
    kolonnePris: "Pris",
    kolonneStatus: "Status",
    tom: "Du har ikke solgt noget endnu.",
  },

  venter: {
    titel: "Venter på dig",
    forklaring: "Ting, du skal gøre nu.",
    sendPakke: (vare: string) => `Send pakken med ${vare} til køberen.`,
    svarSpoergsmaal: (vare: string) => `En køber har stillet et spørgsmål om ${vare}.`,
    returPaaVej: (vare: string) => `Køberen har fortrudt købet af ${vare}. Varen er på vej retur til dig.`,
    bekraeftRetur: (vare: string) => `Har du fået ${vare} retur? Bekræft det, så køberen kan få pengene tilbage.`,
    knapSendPakke: "Send pakke",
    knapSvar: "Svar køberen",
    knapBekraeftRetur: "Jeg har fået varen",
    tom: "Der er ikke noget, der venter på dig. Godt klaret.",
  },

  abonnement: {
    titel: "Abonnement",
    forklaring: "Din pakke bestemmer, hvor mange auktioner du kan oprette om ugen.",
    dinPakke: "Din pakke",
    andrePakker: "Andre pakker",
    auktionerPrUge: (antal: number) => (antal === 1 ? "1 auktion om ugen" : `${antal} auktioner om ugen`),
    prisPrMaaned: (pris: string) => `${pris} om måneden`,
    knapOpgrader: "Opgradér",
    knapNedgrader: "Skift til denne pakke fra næste måned",
    knapAnnuller: "Fortryd",

    bekraeftOpgraderTitel: (pakke: string) => `Skift til ${pakke} nu?`,
    bekraeftOpgraderTekst:
      "Du får de ekstra auktioner med det samme. Du betaler forskellen i pris for resten af måneden og får en regning på det.",
    bekraeftOpgraderJa: "Ja, skift nu",
    opgraderetSvar: (pakke: string) => `Du har nu ${pakke}. Dine ekstra auktioner kan bruges med det samme.`,

    bekraeftNedgraderTitel: (pakke: string) => `Skift til ${pakke} fra næste måned?`,
    bekraeftNedgraderTekst: (dato: string) =>
      `Du beholder din nuværende pakke til og med ${dato}. Derefter får du den nye pakke. Du får ikke penge tilbage for denne måned.`,
    bekraeftNedgraderJa: "Ja, skift fra næste måned",
    nedgraderetSvar: (pakke: string, dato: string) => `Fra ${dato} har du ${pakke}.`,
    planlagtSkift: (pakke: string, dato: string) => `Fra ${dato} skifter du til ${pakke}.`,

    betalingIkkeSatOp: "Vi kontakter dig om betalingen.",
    betalingIkkeSatOpSkift:
      "Du kan ikke skifte pakke her endnu. Vi kontakter dig om betalingen. Vil du skifte nu, så skriv til os.",
    fejlSkift: "Pakken blev ikke skiftet. Prøv igen om lidt, eller skriv til os.",
  },

  regninger: {
    titel: "Regninger",
    forklaring: "Alle regninger fra BidHamr.",
    kolonneDato: "Dato",
    kolonneBeloeb: "Beløb",
    kolonneStatus: "Status",
    statusBetalt: "Betalt",
    statusIkkeBetalt: "Ikke betalt",
    knapHent: "Hent regning",
    tom: "Du har ingen regninger endnu. Når du får en regning fra BidHamr, ligger den her.",
  },

  firmaoplysninger: {
    titel: "Firmaoplysninger",
    forklaring: "Det har vi skrevet ned om dit firma.",
    firmanavn: "Firmanavn",
    cvr: "CVR-nummer",
    adresse: "Adresse",
    kontaktperson: "Kontaktperson",
    telefon: "Telefon",
    email: "E-mail",
    rettes: "Skal noget rettes? Kontakt os, så retter vi det for dig.",
  },

  kontakt: {
    titel: "Kontakt BidHamr",
    tekst: "Har du spørgsmål, eller har du brug for hjælp? Skriv til os, så svarer vi hurtigst muligt.",
    email: "support@bidhamr.dk",
    knap: "Skriv til os",
  },

  // Hvis en firmakonto forsøger at byde.
  kanIkkeByde: "En firmakonto kan kun sælge. Vil du købe noget, skal du bruge en privat konto.",
  fejlHent: "Vi kunne ikke hente dine oplysninger. Prøv at genindlæse siden.",
} as const;

// ---------------------------------------------------------------------------
// 6. Admin – Erhverv (kun chef og sælger)
// ---------------------------------------------------------------------------

export const ADMIN_ERHVERV = {
  menupunkt: "Erhverv",
  ingenAdgang: "Kun chef og sælger har adgang til Erhverv.",

  faner: {
    henvendelser: "Henvendelser",
    firmaer: "Firmaer",
    pakker: "Pakker",
  },

  henvendelser: {
    titel: "Henvendelser",
    forklaring: "Formularer fra /erhverv. Nyeste øverst.",
    status: {
      ny: "Ny",
      igang: "I gang",
      godkendt: "Godkendt",
      afvist: "Afvist",
    },
    filterAlle: "Alle",
    kolonneModtaget: "Modtaget",
    kolonneFirma: "Firma",
    kolonneCvr: "CVR",
    kolonneKontakt: "Kontakt",
    kolonneStatus: "Status",
    noterTitel: "Noter",
    noterPladsholder: "Fx: Ringet 8/10, aftalt møde fredag kl. 10.",
    knapGemNote: "Gem note",
    knapIgang: "Sæt i gang",
    knapGodkend: "Godkend",
    knapAfvis: "Afvis",
    bekraeftGodkend: "Godkend henvendelsen? Bagefter kan du oprette firmakontoen.",
    bekraeftAfvis: "Afvis henvendelsen? Husk at give firmaet besked.",
    afvisGrund: "Grund (vises kun internt)",
    knapOpretKonto: "Opret firmakonto",
    tom: "Ingen henvendelser endnu.",
    tomFilter: "Ingen henvendelser med denne status.",
  },

  opret: {
    titel: "Opret firmakonto",
    forklaring:
      "Opretter en ny, separat konto med firmaets e-mail og sender velkomstmailen (link til at vælge adgangskode). En evt. privat konto berøres ikke.",
    feltEmail: "Firmaets e-mail (login)",
    feltPakke: "Pakke",
    feltPakkeHjaelp: "Den pakke, der er aftalt med firmaet.",
    cvrTjekket: "CVR tjekket: aktivt dansk firma.",
    knapOpret: "Opret og send velkomstmail",
    oprettet: (email: string) => `Firmakontoen er oprettet. Velkomstmailen er sendt til ${email}.`,
    knapSendIgen: "Send velkomstmail igen",
    sendtIgen: "Velkomstmailen er sendt igen.",
    fejl: {
      ikkeGodkendt: "Henvendelsen skal være godkendt, før kontoen kan oprettes.",
      emailFindes: "Der findes allerede en konto med den e-mail. Firmakontoen skal have sin egen e-mail.",
      cvrFindes: "Der findes allerede en firmakonto med det CVR-nummer.",
      cvrIkkeAktivt: "CVR-nummeret er ikke aktivt i CVR-registret. Kontoen kan ikke oprettes.",
      cvrOpslagFejl: "CVR-registret svarer ikke lige nu. Prøv igen om lidt.",
      ingenPakke: "Vælg en pakke.",
      mailFejl: "Kontoen er oprettet, men velkomstmailen blev ikke sendt. Tryk \"Send velkomstmail igen\".",
      generisk: "Kontoen blev ikke oprettet. Prøv igen. Fejlen er logget i drift.",
    },
  },

  firmaer: {
    titel: "Firmaer",
    kolonneFirma: "Firma",
    kolonneCvr: "CVR",
    kolonnePakke: "Pakke",
    kolonneAbonnement: "Abonnement",
    abonnementAktivt: "Aktivt",
    abonnementIkkeAktivt: "Ikke aktivt",
    abonnementAfventerBetaling: "Afventer betaling",
    tom: "Ingen firmakonti endnu.",
  },

  pakker: {
    titel: "Pakker",
    forklaring: "Pakkerne vises med priser i firmaernes Firma oversigt – aldrig på den offentlige side.",
    kunChef: "Kun chef kan oprette og ændre pakker og priser.",
    feltNavn: "Navn",
    feltNavnPladsholder: "Fx Lille",
    feltPris: "Pris pr. måned (kr.)",
    feltAuktioner: "Auktioner pr. uge",
    feltAktiv: "Kan vælges",
    feltAktivHjaelp: "Slå fra for at skjule pakken, så den ikke kan vælges.",
    knapNy: "Ny pakke",
    knapGem: "Gem pakke",
    gemt: "Pakken er gemt.",
    tom: "Ingen pakker endnu. Opret den første.",
    fejl: {
      navnMangler: "Skriv et navn.",
      prisUgyldig: "Prisen skal være et tal på 0 eller derover.",
      auktionerUgyldigt: "Antal auktioner pr. uge skal være mindst 1.",
      navnFindes: "Der findes allerede en pakke med det navn.",
      generisk: "Pakken blev ikke gemt. Prøv igen.",
    },
  },
} as const;
