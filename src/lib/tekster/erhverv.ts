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
    {
      spoergsmaal: "Hvem sender fakturaen på varen?",
      svar: "Det gør dit firma selv, fra dit eget regnskabsprogram. Dit firma står også for momsen af varen (eller brugtmoms). Under Salg i Firma oversigt finder du alt, du skal bruge til fakturaen: købers navn, adresse og e-mail, varen, prisen og datoen. BidHamr sender kun faktura på vores egne gebyrer og på dit abonnement.",
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
      label: "Hvad sælger du?",
      hjaelp: "Skriv med dine egne ord. Fx møbler, værktøj eller ting fra dødsboer.",
      pladsholder: "Fx brugte møbler og lamper",
    },
    antalVarer: {
      label: "Cirka hvor mange varer vil du sælge om måneden?",
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
    antalUgyldigt: "Skriv et tal, fx 20 – eller lad feltet stå tomt.",
    forMangeForsoeg: "Du har sendt formularen mange gange på kort tid. Vent lidt, og prøv igen senere.",
    generisk:
      "Formularen blev ikke sendt. Prøv igen om lidt. Virker det stadig ikke, så skriv til erhverv@bidhamr.dk.",
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
  hjaelp: "Har du spørgsmål? Skriv til os på erhverv@bidhamr.dk.",
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
    prisPrMaaned: (pris: string) => `${pris} om måneden + moms`,
    knapOpgrader: "Opgradér",
    knapNedgrader: "Skift til denne pakke fra næste måned",
    knapAnnuller: "Fortryd",

    bekraeftOpgraderTitel: (pakke: string) => `Vælg ${pakke}?`,
    bekraeftOpgraderTekst:
      "Du får de ekstra auktioner med det samme. Du betaler forskellen i pris for resten af måneden og får en regning på det.",
    bekraeftOpgraderJa: (pakke: string) => `Ja, vælg ${pakke}`,
    opgraderetSvar: (pakke: string) => `Du har nu ${pakke}. Dine ekstra auktioner kan bruges med det samme.`,

    bekraeftNedgraderTitel: (pakke: string) => `Skift til ${pakke} fra næste måned?`,
    bekraeftNedgraderTekst: (dato: string) =>
      `Din nye pakke gælder fra ${dato}. Indtil da beholder du din nuværende pakke. Du får ikke penge tilbage for denne måned.`,
    bekraeftNedgraderJa: "Ja, skift fra næste måned",
    nedgraderetSvar: (pakke: string, dato: string) => `Fra ${dato} har du ${pakke}.`,
    planlagtSkift: (pakke: string, dato: string) => `Fra ${dato} skifter du til ${pakke}.`,

    betalingIkkeSatOp: "Vi kontakter dig om betalingen.",
    betalingIkkeSatOpSkift:
      "Du kan skifte pakke, når dit abonnement er i gang. Vil du have en anden pakke nu, så skriv til os.",
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
    email: "erhverv@bidhamr.dk",
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
      prisHeleKroner: "Skriv prisen i hele kroner, fx 199.",
      auktionerUgyldigt: "Antal auktioner pr. uge skal være mindst 1.",
      navnFindes: "Der findes allerede en pakke med det navn.",
      generisk: "Pakken blev ikke gemt. Prøv igen.",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// 7. Ekstra tekster til siderne (frontend). Korte pladsholdere i samme stil -
//    indhold-agenten må gerne finpudse dem.
// ---------------------------------------------------------------------------

export const ERHVERV_SIDE_EKSTRA = {
  formularTilbage: "Tilbage til Erhverv",
  formularMetaTitel: "Formular for erhverv",
  kontaktLinje: "Du kan også skrive direkte til os på",
} as const;

// Mærket "Erhvervssælger" og den offentlige firmaprofil.
export const ERHVERVSSAELGER = {
  maerke: "Erhvervssælger",
  seFirma: "Se firmaets oplysninger",
  profilIntro: "Denne sælger er et firma med dansk CVR-nummer.",
  firmanavn: "Firmanavn",
  cvr: "CVR-nummer",
  adresse: "Adresse",
  telefon: "Telefon",
  email: "E-mail",
  siden: "Sælger på BidHamr siden",
  ikkeAktiv: "Firmaet sælger ikke på BidHamr lige nu. Oplysningerne vises, så du stadig kan kontakte firmaet.",
  fortrydelsesretTitel: "Fortrydelsesret i 14 dage",
  fortrydelsesret: [
    "Når du køber af et firma, har du 14 dages fortrydelsesret efter loven. Fristen regnes fra den dag, du har fået varen.",
    "Har varen en fejl, kan du klage til firmaet (reklamationsret i 2 år).",
  ],
  // BidHamr Beskyttelse gælder ikke ved køb fra erhverv.
  ingenBeskyttelse:
    "BidHamr Beskyttelse kan ikke vælges, når du køber af et firma. Du har i stedet fortrydelsesret og reklamationsret efter loven.",
  seAuktioner: "Se firmaets profil og auktioner",
  // Når firmaet selv ser sin firmaprofil (linker til /firma/auktioner).
  seEgneAuktioner: "Se dine auktioner",
  tilbage: "Tilbage",
} as const;

// Budpanelet på en erhvervsauktion.
export const ERHVERV_BIDPANEL = {
  prisLinje:
    "Vinder du, betaler du dit bud + købergebyr + fragt. Du ser den samlede pris i kroner, før du betaler, og har 48 timer til at betale. Alle beløb er inkl. moms.",
  firmakontoTitel: "En firmakonto kan kun sælge",
  firmakontoTekst: "Vil du købe noget, skal du bruge en privat konto.",
} as const;

// Opret/redigér auktion: oplysninger, EU kræver ved nye varer (GPSR).
export const ERHVERV_GPSR = {
  titel: "Oplysninger om den nye vare",
  intro: "Når et firma sælger en ny vare, skal disse oplysninger stå på auktionen.",
  producentLabel: "Producent",
  producentHjaelp:
    "Navn og adresse på den, der har lavet varen. Fx: Hansen Møbler A/S, Fabriksvej 1, 5000 Odense.",
  producentMangler: "Skriv producentens navn og adresse.",
  sikkerhedLabel: "Sikkerhedsoplysninger",
  sikkerhedHjaelp:
    "Advarsler og råd om sikker brug. Fx: Ikke egnet til børn under 3 år. Står der ingen advarsler på varen, så skriv det.",
  sikkerhedMangler: "Skriv sikkerhedsoplysninger. Er der ingen advarsler, så skriv det.",
} as const;

// /reset-password, når man kommer fra velkomstmailen.
export const ERHVERV_VAELG_ADGANGSKODE = {
  titel: "Vælg din adgangskode",
  tekst: "Velkommen til BidHamr. Vælg den adgangskode, du vil bruge til din firmakonto.",
  felt: "Adgangskode",
  feltGentag: "Skriv adgangskoden igen",
  knap: "Gem adgangskode",
  venter: "Vi tjekker dit link … Er linket udløbet, så skriv til erhverv@bidhamr.dk, så sender vi et nyt.",
} as const;

// Velkomstmailen sendt igen fra admin.
export const ERHVERV_VELKOMSTMAIL_GENSENDT = {
  fodnote: (email: string) =>
    `Du får denne mail igen, fordi BidHamr har sendt et nyt link til firmakontoen ${email}. Har du ikke talt med os, kan du se bort fra mailen.`,
} as const;

// Firma oversigt - ekstra.
export const FIRMA_OVERSIGT_EKSTRA = {
  genvejeTitel: "Det bruger du mest",
  genveje: {
    handler: "Dine handler",
    handlerTekst: "Solgte varer, pakker der skal sendes, og betalinger.",
    beskeder: "Beskeder",
    beskederTekst: "Beskeder fra købere og fra BidHamr.",
    auktioner: "Dine auktioner",
    auktionerTekst: "Alle de auktioner, du har oprettet.",
  },
  kanIkkeOpretteIkkeAktiv: "Du kan ikke oprette auktioner, før din pakke er sat i gang.",
  kanIkkeOpretteBetal: "Betal for din pakke under Abonnement. Så kan du oprette auktioner.",
  pakkePause: "Dit abonnement er sat på pause. Du kan ikke oprette nye auktioner. Skriv til os, så hjælper vi dig.",
  pakkeOpsagt: "Dit abonnement er opsagt. Skriv til os, hvis du vil sælge igen.",
  ingenPakke: "Du har ingen pakke endnu. Vi kontakter dig.",
  afventerTitel: "Venter på betaling",
  afventerTekst: (pakke: string) =>
    `Du har valgt ${pakke}. Du får de ekstra auktioner, så snart betalingen er gået igennem.`,
  prisIkkeSat: "Prisen aftales med BidHamr",
  // Opgraderingen gælder, så snart forskellen er betalt (src/lib/erhverv/betaling.ts).
  bekraeftOpgraderTekstAfventer:
    "Du betaler forskellen i pris for resten af måneden med dit kort. Så snart betalingen er gået igennem, får du de ekstra auktioner. Du får en regning på det.",
  betalForskellenSvar: "Din bank vil have dig til at godkende betalingen. Vi sender dig videre nu …",
  opgraderingBetalingFejl:
    "Vi kunne ikke sætte betalingen i gang. Din pakke er ikke skiftet. Prøv igen om lidt, eller skriv til erhverv@bidhamr.dk.",
  nedgraderetSvar: (pakke: string, dato: string) =>
    `Du skifter til ${pakke} den ${dato}. Indtil da beholder du din nuværende pakke.`,
  uaendretSvar: "Du beholder din nuværende pakke.",
  // Stripe kunne ikke ændre abonnementet: skiftet er rullet tilbage.
  pakkeskiftFejl:
    "Vi kunne ikke skifte din pakke lige nu. Din pakke er ikke ændret. Prøv igen om lidt, eller skriv til erhverv@bidhamr.dk.",
  // Stripe fejlede, og et andet pakkeskift gik i gang imens (det gælder nu).
  pakkeskiftLaasOvertaget:
    "Vi kunne ikke gennemføre dit pakkeskift, og et andet pakkeskift blev sat i gang imens. Se din pakke under Abonnement, før du prøver igen. Er du i tvivl, så skriv til erhverv@bidhamr.dk.",
  // Abonnementet i Stripe er ikke aktivt (fx en ubetalt regning).
  pakkeskiftBetalFoerst: "Du kan ikke skifte pakke, før din seneste regning er betalt. Din pakke er ikke ændret.",
  afhentning: (vare: string) => `Køberen skal hente ${vare}. Aftal tid og sted med køberen.`,
  knapSeHandel: "Se handlen",
  ugensTal: (brugt: number, ialt: number) => `${brugt} af ${ialt}`,
  ugensTalLabel: "Brugt denne uge",
  visningerAktive: "På dine aktive auktioner",
  firmanavnLabel: "Firma",
  slutter: "Slutter",
  bud: (antal: number) => (antal === 1 ? "1 bud" : `${antal} bud`),
  solgtDenneMaaned: "Solgt denne måned",
  solgtIAlt: "Solgt i alt",
  seSalg: "Se alle dine salg",
  regningType: { abonnement: "Abonnement", opgradering: "Opgradering", andet: "Andet" },
  regningStatus: {
    afventer: "Ikke betalt",
    betalt: "Betalt",
    mislykket: "Betaling fejlede",
    krediteret: "Krediteret",
    annulleret: "Annulleret",
  },
  luk: "Luk",
} as const;

// Admin - ekstra.
export const ADMIN_ERHVERV_EKSTRA = {
  forklaring: "Formularer fra firmaer, firmakonti og pakker.",
  arkiverede: "Arkiverede",
  knapArkiver: "Arkivér",
  knapHentTilbage: "Hent tilbage",
  bekraeftArkiver: "Arkivér henvendelsen? Den kan hentes tilbage under Arkiverede.",
  tilbageTilListe: "Tilbage til henvendelser",
  felter: {
    firmanavn: "Firmanavn",
    cvr: "CVR",
    kontaktperson: "Kontaktperson",
    telefon: "Telefon",
    email: "E-mail",
    kontaktEmail: "Kontakt-e-mail (vises for købere)",
    adresse: "Adresse",
    postnummer: "Postnummer",
    by: "By",
    hvadSaelger: "Hvad sælger de",
    antalVarer: "Varer pr. måned (ca.)",
    besked: "Besked",
    modtaget: "Modtaget",
    behandletAf: "Sidst behandlet af",
    loginEmail: "Login-e-mail",
    loggetInd: "Har logget ind",
  },
  ja: "Ja",
  nej: "Nej, ikke endnu",
  ikkeLoggetInd: "Ikke logget ind endnu",
  knapSlaaCvrOp: "Slå CVR op",
  cvrFundet: "Oplysningerne er hentet fra CVR-registret. Tjek dem, før du opretter kontoen.",
  firmaOprettet: "Der er oprettet en firmakonto ud fra denne henvendelse.",
  kontoOprettet: "Konto oprettet",
  seFirma: "Se firmaet",
  bekraeftOpretTitel: "Opret firmakontoen?",
  bekraeftOpret: (email: string) =>
    `Kontoen oprettes, og velkomstmailen sendes til ${email}. Kontoen kan ikke slettes bagefter.`,
  tilbageTilFirmaer: "Tilbage til firmaer",
  knapGemFirma: "Gem ændringer",
  firmaGemt: "Firmaet er gemt.",
  aendrPakkeHjaelp: "Skifter pakken med det samme (fx efter en aftale eller betaling uden for Stripe).",
  bekraeftGemFirma: "Gem ændringerne på firmaet?",
  feltStatus: "Abonnement",
  feltNote: "Note (vises kun internt)",
  afventerOpgradering: (pakke: string) => `Firmaet har bedt om ${pakke} og venter på betaling.`,
  planlagtSkift: (pakke: string, dato: string) => `Skifter til ${pakke} fra ${dato}.`,
  aktiveAuktioner: "Aktive auktioner",
  oprettetAf: "Oprettet af",
  feltBeskrivelse: "Beskrivelse (valgfri)",
  feltSortering: "Rækkefølge",
  feltSorteringHjaelp: "Lavt tal vises først.",
  prisTomHjaelp: "Lad feltet være tomt, hvis prisen ikke er sat endnu.",
  antalFirmaer: (n: number) => (n === 1 ? "1 firma" : `${n} firmaer`),
  prisIkkeSat: "Ikke sat",
  knapRet: "Ret",
  knapAnnuller: "Annullér",
  skjult: "Skjult",
  rolleSaelger: "Sælger",
  goerTilSaelger: "Gør til sælger",
  pakkeBrugesTitel: "Pakken bruges af firmaer",
  pakkeBruges: (n: number) =>
    `${n === 1 ? "1 firma bruger" : `${n} firmaer bruger`} denne pakke – ændringen gælder for dem med det samme.`,
  knapGemAlligevel: "Ja, gem ændringen",
} as const;

// Login-siden for firmakonti.
export const ERHVERV_LOGIN = {
  // /auth/callback med et brugt eller udløbet velkomstlink (type=invite).
  velkommenUdloebet: "Linket virker ikke længere. Skriv til erhverv@bidhamr.dk, så sender vi dig et nyt.",
  // Efter "Vælg din adgangskode" (/reset-password?velkommen=1).
  adgangskodeGemt: "Din adgangskode er gemt. Log ind for at komme til din Firma oversigt.",
  undertitelVelkommen: "Log ind med din e-mail og den adgangskode, du lige har valgt.",
} as const;

// Opret auktion for en firmakonto uden udbetalingskonto (bankkonto).
export const FIRMA_UDBETALINGSKONTO = {
  titel: "Hvor skal pengene sendes hen?",
  tekst:
    "Før du kan sælge, skal vi vide, hvilken bankkonto pengene skal sendes til. Det er gratis og tager ca. 5 minutter. Betalingen håndteres af vores betalingspartner Stripe.",
  knapOpret: "Tilføj bankkonto",
  knapFaerdig: "Gør det færdigt",
  knapSender: "Sender dig videre …",
  hjaelp: "Har du brug for hjælp? Skriv til",
  tilbage: "Tilbage til Firma oversigt",
} as const;

// Diskret link på /coming-soon (siden /erhverv er offentlig før lancering).
export const ERHVERV_COMING_SOON = {
  link: "Er du virksomhed? Læs om BidHamr Erhverv",
} as const;

// Firma oversigt før lancering: firmaet kan logge ind og se sin pakke og sine
// oplysninger, men resten af siden er lukket, og der kan ikke sælges endnu
// (Filip, 8. okt. 2026).
export const FIRMA_FOER_LANCERING = {
  titel: "BidHamr åbner snart",
  tekst:
    "Når vi åbner, kan du sætte dine auktioner til salg her. Indtil da kan du se din pakke og dine oplysninger.",
  // Under den slåede-fra "Opret auktion"-knap.
  kanIkkeOprette: "Du kan oprette auktioner, når BidHamr åbner.",
  // I stedet for genvejene til handler, beskeder og auktioner.
  genvejeLukket: "Dine handler og auktioner kommer her, når BidHamr åbner.",
} as const;

// Firma-dashboardet (/firma/*), sat op som admin: menu i siden, egen top og
// én side pr. emne (Filip, 8. okt. 2026). Målgruppen er primært ældre:
// korte sætninger, ingen fagudtryk.
export const FIRMA_DASHBOARD = {
  top: {
    logoLabel: "BidHamr - til Overblik",
    seButik: "Se din butik",
    seButikLukket: "Din butik kan ses af købere, når BidHamr åbner.",
    logUd: "Log ud",
    loggerUd: "Logger ud …",
  },
  menu: {
    navLabel: "Firma",
    aabn: "Menu",
    luk: "Luk menu",
    overblik: "Overblik",
    auktioner: "Auktioner",
    salg: "Salg",
    statistik: "Statistik",
    udbetalinger: "Udbetalinger",
    abonnement: "Abonnement",
    regninger: "Regninger",
    oplysninger: "Firmaoplysninger",
    hjaelp: "Hjælp og kontakt",
  },
  tilbage: (side: string) => `Tilbage til ${side}`,

  overblik: {
    titel: "Overblik",
    intro: "Det vigtigste lige nu.",
    tal: "Dine tal",
    aktive: "Aktive auktioner",
    ugensKvote: "Ugens auktioner",
    seAuktioner: "Se dine auktioner",
    seSalg: "Se dine salg",
    seUdbetalinger: "Se udbetalinger",
  },

  auktioner: {
    titel: "Auktioner",
    intro: "Alle dine auktioner. Vælg, hvilke du vil se.",
    faner: {
      aktive: "Aktive",
      solgte: "Solgte",
      usolgte: "Usolgte",
      annullerede: "Annullerede",
    },
    fanerLabel: "Vis auktioner",
    tom: {
      aktive: "Du har ingen auktioner, der kører lige nu.",
      solgte: "Du har ikke solgt noget endnu.",
      usolgte: "Ingen af dine auktioner er sluttet uden at blive solgt.",
      annullerede: "Du har ingen annullerede auktioner.",
    },
    nuvaerendeBud: "Højeste bud",
    startpris: "Startpris",
    ingenBud: "Ingen bud endnu",
    solgtFor: "Solgt for",
    slutter: "Slutter",
    sluttede: "Sluttede",
    visninger: (n: number) => (n === 1 ? "1 visning" : `${n.toLocaleString("da-DK")} visninger`),
    bud: (n: number) => (n === 1 ? "1 bud" : `${n.toLocaleString("da-DK")} bud`),
    skjult: "Skjult af BidHamr",
    knapRediger: "Redigér",
    knapSeAuktion: "Se auktionen",
    knapSeHandel: "Se handlen",
    ugeKvote: (brugt: number, max: number) =>
      `Du har brugt ${brugt} af ${max} ${max === 1 ? "auktion" : "auktioner"} denne uge.`,
    oprettet: "Din auktion er oprettet og kører nu.",
    gemt: "Dine ændringer er gemt.",
  },

  opret: {
    titel: "Opret auktion",
    lukket: "Du kan oprette auktioner, når BidHamr åbner.",
  },

  rediger: {
    titel: "Redigér auktion",
    lukket: "Du kan redigere auktioner, når BidHamr åbner.",
    ikkeAktiv: "Auktionen er ikke aktiv længere og kan ikke ændres.",
  },

  salg: {
    titel: "Salg",
    intro: "Alle dine solgte varer. Tryk på en vare for at se handlen.",
    tom: "Du har ikke solgt noget endnu. Når du sælger, kan du se det her.",
    solgt: "Solgt",
    knapSendPakke: "Send pakke",
    knapSeHandel: "Se handlen",
    status: {
      afventer_betaling: "Venter på betaling",
      betaling_modtaget: "Skal sendes",
      betaling_modtaget_afhentning: "Skal hentes",
      pakke_sendt: "Sendt",
      modtaget: "Leveret",
      leveret: "Leveret",
      afsluttet: "Afsluttet",
      annulleret: "Annulleret",
      retur: "Retur",
    } as Record<string, string>,
    sendPakkeLukket: "Du kan sende pakker, når BidHamr åbner.",
    ingenChat:
      "Køberen kan ikke skrive til dig her. Køberen ser dit firmas e-mail og telefon og kontakter dig dér, hvis der er spørgsmål.",
  },

  statistik: {
    titel: "Statistik",
    intro: "Hvor mange der har set dine auktioner, budt og købt.",
    prMaaned: "Pr. måned",
    prMaanedForklaring: "De seneste 12 måneder.",
    prAuktion: "Pr. auktion",
    prAuktionForklaring: "Dine seneste auktioner.",
    kolonneMaaned: "Måned",
    kolonneVisninger: "Visninger",
    kolonneBud: "Bud",
    kolonneSolgte: "Solgte",
    kolonneOmsaetning: "Indtjent",
    kolonneAuktion: "Auktion",
    kolonneSolgtFor: "Solgt for",
    ikkeSolgt: "Ikke solgt",
    koerer: "Kører",
    tom: "Der er ingen tal endnu. Tallene kommer, når du har en auktion.",
  },

  udbetalinger: {
    titel: "Udbetalinger",
    intro: "Penge fra dine salg. Betalingen håndteres af vores betalingspartner Stripe.",
    paaVej: "På vej til dig",
    udbetalt: "Udbetalt i alt",
    udbetaltMaaned: "Udbetalt denne måned",
    prHandel: "Pr. handel",
    tom: "Der er ingen udbetalinger endnu.",
    hjaelp: "Pengene udbetales til din bankkonto, når køberens frist for at fortryde er gået.",
    status: {
      udbetalt: "Udbetalt",
      paaVej: "På vej til dig",
      venterBetaling: "Køberen har ikke betalt endnu",
      refunderet: "Pengene er sendt tilbage til køberen",
      annulleret: "Annulleret",
    },
  },

  oplysninger: {
    titel: "Firmaoplysninger",
  },

  // "Download dine data" (GDPR) på Firmaoplysninger. Formularen poster til
  // /konto/data (samme som for private).
  dineData: {
    titel: "Dine data",
    tekst:
      "Få en fil med alt det, BidHamr har gemt om dig og dit firma: konto, auktioner, handler og indstillinger. Filen er i JSON-format og kan åbnes i en teksteditor.",
    knap: "Download dine data",
    hjaelp: "Du kan hente filen én gang i timen.",
    vent: "Du har lige hentet dine data. Du kan hente dem igen om højst en time.",
    fejl: "Dine data kunne ikke hentes lige nu. Prøv igen om lidt.",
  },

  // Firmakonto uden firma-oplysninger (ingen række i firmaer endnu).
  ikkeSatOp: {
    titel: "Firma oversigt",
    // Efterfølges af e-mailen som link og et punktum.
    tekst: "Din firmakonto er ikke sat op endnu. Skriv til",
    fuld: "Din firmakonto er ikke sat op endnu. Skriv til erhverv@bidhamr.dk.",
  },

  // Afhentning hos firmaet (ingen chat med erhverv).
  afhentning:
    "Køberen kommer og henter varen. Køberen kan se din adresse og dit telefonnummer og kontakter dig, hvis der er brug for det.",

  hjaelp: {
    titel: "Hjælp og kontakt",
  },

  // Handelssiden for køberen, når sælgeren er et firma (ingen chat).
  koeberKontakt: {
    titel: "Kontakt sælgeren",
    tekst: "Sælgeren er et firma. Har du spørgsmål til handlen, så kontakt firmaet direkte.",
    telefon: "Telefon",
    email: "E-mail",
    seProfil: "Se firmaets profil",
  },
  bidhamrBeskeder: "Beskeder fra BidHamr",
  // I stedet for "Spørg sælger" på en erhvervsauktion.
  spoergFirma: {
    titel: "Spørgsmål til sælgeren",
    tekst: "Sælgeren er et firma. Har du spørgsmål til varen, så kontakt firmaet på mail eller telefon.",
    seProfil: "Se firmaets kontaktoplysninger",
  },
  ingenBeskederFejl:
    "Du kan ikke skrive til en erhvervssælger. Kontakt firmaet på mail eller telefon - se firmaets profil.",
} as const;

// Betaling af abonnementet med Stripe (Firma oversigt -> Abonnement og
// Regninger). Meget enkelt sprog - primært ældre brugere.
export const FIRMA_BETALING = {
  betalTitel: "Betal for at komme i gang",
  betalTekst: (pakke: string, pris: string) =>
    `Du har pakken ${pakke}. Du betaler ${pris} om måneden + moms. Når du har betalt, kan du oprette auktioner.`,
  betalTekstUdenPris: "Når du har betalt for din pakke, kan du oprette auktioner.",
  knapBetal: "Betal for din pakke",
  knapSender: "Sender dig videre …",
  stripeForklaring: "Betalingen håndteres af vores betalingspartner Stripe. Du betaler med kort.",
  maanedligTekst: "Beløbet trækkes automatisk hver måned. Du får en regning hver gang.",
  prisMedMoms: (ekskl: string, inkl: string) => `${ekskl} + moms (${inkl} i alt) om måneden`,
  eksklMoms: "ekskl. moms",
  // Retur fra Stripe.
  kvitteringTitel: "Tak for din betaling",
  kvitteringTekst: "Din pakke er sat i gang. Du kan nu oprette auktioner. Regningen ligger under Regninger.",
  behandlesTitel: "Vi venter på betalingen",
  behandlesTekst: "Betalingen er ved at blive behandlet. Opdater siden om et øjeblik.",
  afbrudtTekst: "Du afbrød betalingen. Der er ikke trukket penge. Du kan prøve igen, når du er klar.",
  opgraderetTitel: "Tak - din pakke er skiftet",
  // Mislykket betaling.
  mislykketTitel: "Din betaling gik ikke igennem",
  mislykketTekst: (dato: string) =>
    `Vi kunne ikke trække betalingen for dit abonnement. Skift dit betalingskort, eller betal regningen, inden ${dato}. Ellers sættes dit abonnement på pause, og du kan ikke oprette nye auktioner.`,
  pauseTitel: "Dit abonnement er sat på pause",
  pauseTekst: "Vi har ikke modtaget betalingen. Betal regningen, så kører dit abonnement igen med det samme.",
  pauseNyBetalingTekst: "Vi har ikke modtaget betalingen. Betal for din pakke igen, så kører dit abonnement igen med det samme.",
  knapBetalRegning: "Betal regningen",
  knapBetalForskellen: "Betal forskellen",
  knapSkiftKort: "Skift betalingskort",
  skiftKortTekst: "Vil du betale med et andet kort? Du kan også se dine regninger dér.",
  opsigesTekst: (dato: string) => `Dit abonnement stopper den ${dato}. Skriv til os, hvis du vil fortsætte.`,
  naesteBetaling: (dato: string) => `Næste betaling: ${dato}.`,
  fejl: "Vi kunne ikke sende dig til betalingen. Prøv igen om lidt, eller skriv til erhverv@bidhamr.dk.",
  // Regninger.
  regningBeloeb: (ekskl: string, moms: string, inkl: string) => `${ekskl} + moms ${moms} = ${inkl}`,
  knapHentPdf: "Hent faktura (PDF)",
  knapSeRegning: "Se og betal regningen",
  regningNummer: (nr: string) => `Faktura ${nr}`,
} as const;

// Admin -> Erhverv -> Firma: abonnementet i Stripe (kun chef).
export const ADMIN_ERHVERV_BETALING = {
  titel: "Betaling (Stripe)",
  ingenAbonnement: "Firmaet har ikke betalt for sin pakke endnu (intet abonnement i Stripe).",
  stripeStatus: "Status i Stripe",
  betaltTil: "Betalt til",
  opsigesFra: (dato: string) => `Abonnementet er opsagt og stopper ${dato}.`,
  knapOpsig: "Opsig abonnement",
  bekraeftOpsigTitel: "Opsig abonnementet?",
  bekraeftOpsig: "Abonnementet stopper ved slutningen af den betalte periode. Der refunderes ikke noget. Firmaet kan sælge, indtil perioden slutter.",
  opsagt: (dato: string) => `Abonnementet er opsagt og stopper ${dato}.`,
  opsagtStraks: "Firmaet havde intet abonnement i Stripe, så det er opsagt med det samme.",
  knapFortryd: "Fortryd opsigelsen",
  fortrudt: "Opsigelsen er fortrudt. Abonnementet fortsætter.",
  kunChef: "Kun chefen kan opsige abonnementet.",
  brugOpsigKnap: "Firmaet har et abonnement i Stripe. Brug knappen \"Opsig abonnement\", så stopper betalingen også.",
  prisNyStripe: (n: number) =>
    n === 0
      ? "Prisen er gemt, og der er lavet en ny pris i Stripe."
      : `Prisen er gemt, og der er lavet en ny pris i Stripe. ${n === 1 ? "1 firma" : `${n} firmaer`} betaler stadig den gamle pris, indtil de skifter pakke.`,
  prisStripeFejl: "Prisen er gemt, men den nye pris kunne ikke oprettes i Stripe endnu. Den oprettes automatisk, næste gang et firma betaler.",
  // Chefen skifter pakke i admin: prisen i Stripe skifter fra næste betaling
  // (ingen proration - en evt. forskel i indeværende periode aftales særskilt).
  pakkeStripeFejl: "Pakken er IKKE ændret: abonnementet i Stripe kunne ikke opdateres. Prøv igen om lidt.",
  pakkeSkiftetStripe: "Pakken er ændret. Den nye pris gælder i Stripe fra firmaets næste betaling.",
} as const;

// Moms ved prisen på erhvervsauktioner (Filip, 8. okt. 2026 - se
// ROADMAP-BESLUTNINGER.md "Moms og fakturaer"): på en erhvervsauktion er
// prisen på varen inkl. moms, og det skal stå ved beløbet. Private
// auktioner viser intet om moms.
export const ERHVERV_MOMS = {
  // Lille tekst ved beløbet (kort, auktionsside, Firma oversigt).
  inklMoms: "inkl. moms",
  // Hjælpetekst ved startpris-feltet, når et firma opretter/retter.
  startprisHjaelp: "Prisen er inkl. moms",
} as const;
