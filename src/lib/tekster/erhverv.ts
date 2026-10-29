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
      // Ingen priser på den offentlige side - kun at der er et abonnement,
      // intet gebyr af salget og velkomstrabatten i måned 1 (Filip, 27. okt.
      // 2026: Start gratis, Butik og Pro halv pris).
      titel: "Intet gebyr af dit salg",
      tekst: "Du betaler et fast abonnement hver måned og får hele buddet for dine varer. Start: første måned gratis. Butik og Pro: første måned til halv pris.",
    },
    {
      titel: "Bliv set på forsiden",
      tekst: "Du kan købe Ugens butik. Så står dit firma øverst på forsiden i en hel uge sammen med dine auktioner.",
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
      svar: "Dit firma betaler et fast abonnement hver måned. Der er intet gebyr af dine salg – du får hele buddet. Start: første måned gratis. Butik og Pro: første måned til halv pris. Prisen afhænger af, hvor mange auktioner du vil have, og den får du, når vi har talt sammen. Udfyld formularen, så kontakter vi dig.",
    },
    {
      spoergsmaal: "Hvor mange auktioner kan jeg have?",
      svar: "Det afhænger af din pakke. Antallet gælder pr. måned. Har du brugt dem alle, kan du skifte til en større pakke med det samme. En auktion kan godt være flere ting samlet, fx 8 jakker.",
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
      svar: "Det gør dit firma selv, fra dit eget regnskabsprogram. Dit firma står også for momsen af varen (eller brugtmoms). Under Salg i Firma oversigt finder du alt, du skal bruge til fakturaen: købers navn, adresse og e-mail, varen, prisen og datoen. BidHamr sender kun regninger på dit abonnement og på det, du køber ekstra hos os, fx Ugens butik.",
    },
    {
      spoergsmaal: "Hvilke regler gælder for mine købere?",
      svar: "Dine købere er forbrugere. De har 14 dages fortrydelsesret og 2 års reklamationsret efter loven. Fortryder en køber, får køberen en returlabel gennem BidHamr, og du skal tage imod varen. Vi gennemgår reglerne med dig, når vi laver aftalen.",
    },
    {
      spoergsmaal: "Kan købere skrive til mig på BidHamr?",
      svar: "Nej. Der er ingen chat med firmaer. Købere ser dit firmas e-mail og telefon og kontakter dig dér.",
    },
    {
      spoergsmaal: "Hvornår får jeg pengene for et salg?",
      svar: "Når handlen er færdig, og køberens frist for at fortryde er gået. Du får hele buddet. Vores betalingspartner Stripe sender pengene til din bankkonto hver 14. dag, samlet for alle dine salg i perioden.",
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// 3. Formularen
// ---------------------------------------------------------------------------

export const ERHVERV_FORMULAR = {
  titel: "Fortæl os om dit firma",
  intro: "Udfyld felterne herunder. Så kontakter vi dig hurtigst muligt.",
  // "(valgfri)" står samlet (whitespace-nowrap), så " ikke står alene på en linje.
  introValgfriFoer: "Felter med",
  introValgfriEfter: "kan du springe over.",
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
    manglerFlere: "Nogle felter skal rettes. De er markeret med rødt.",
    cvrUgyldigt: "CVR-nummeret skal være 8 cifre. Tjek, at du har skrevet det rigtigt.",
    cvrIkkeFundet:
      "Vi kan ikke finde et aktivt dansk firma med det CVR-nummer. Tjek, at du har skrevet det rigtigt.",
    emailUgyldig: "Den e-mail ser forkert ud. Tjek, at den er skrevet rigtigt, fx navn@firma.dk.",
    telefonUgyldigt: "Telefonnummeret ser forkert ud. Skriv 8 cifre, fx 12 34 56 78.",
    postnummerUgyldigt: "Postnummeret skal være 4 cifre fra 1000 til 9999.",
    // Tidsfælden: formularen blev sendt få sekunder efter, den blev vist.
    forHurtigt: "Formularen blev sendt meget hurtigt. Tryk på \"Send formularen\" igen.",
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
  // Linket er BidHamrs egen billet, der gælder i 24 timer
  // (src/lib/erhverv/velkomstBillet.ts, VELKOMST_TIMER).
  udloeber: "Linket virker i 24 timer. Er det udløbet, så skriv til os, så sender vi et nyt.",
  // Reserve, hvis billetten ikke kunne laves: så er det Supabases eget link,
  // som følger "Email OTP expiration" (i dag 3600 sekunder).
  udloeber1Time: "Linket virker i 1 time. Er det udløbet, så skriv til os, så sender vi et nyt.",
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
    // Kvoten er pr. kalendermåned (20261102010000). ialt null = ubegrænset.
    ugensAuktioner: (brugt: number, ialt: number | null, naesteLedige: string) =>
      ialt == null
        ? `Du har oprettet ${brugt} auktioner i denne måned. Din pakke har ubegrænset antal.`
        : `Du har brugt ${brugt} af ${ialt} auktioner i denne måned. Næste ledige: ${naesteLedige}.`,
    ledigeNu: (brugt: number, ialt: number | null) =>
      ialt == null
        ? `Du har oprettet ${brugt} auktioner i denne måned. Din pakke har ubegrænset antal.`
        : `Du har brugt ${brugt} af ${ialt} auktioner i denne måned.`,
    alleBrugt: (naesteLedige: string) =>
      `Du har brugt alle dine auktioner denne måned. Du kan oprette en ny ${naesteLedige}. Vil du have flere nu, kan du skifte til en større pakke under Abonnement. Det gælder med det samme.`,
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
    forklaring:
      "Din pakke bestemmer, hvor mange auktioner du kan oprette om måneden. Du betaler intet gebyr af dine salg. En større pakke gælder med det samme, en mindre fra næste måned.",
    dinPakke: "Din pakke",
    andrePakker: "Andre pakker",
    // Gammelt navn - pakkerne har nu auktioner pr. måned (null = ubegrænset).
    auktionerPrUge: (antal: number | null) => FIRMA_PAKKER.auktionerPrMaaned(antal),
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
    forklaring: "Firmaer, der har udfyldt formularen på erhvervssiden. Nyeste øverst.",
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
    feltPakkeHjaelp: "Den pakke, der er aftalt med firmaet. Start: første måned gratis. Butik og Pro: første måned til halv pris.",
    pakkeValg: (navn: string, auktioner: string, pris: string | null) =>
      `${navn} – ${auktioner}${pris ? ` – ${pris} pr. md. ekskl. moms` : ""}`,
    introTitel: "Introrabat",
    introSlaa: "Giv introrabat (i stedet for velkomstrabatten)",
    introHjaelp:
      "Kun til firmaer, BidHamr selv har kontaktet. Slå den til, så er 50 % i 6 måneder udfyldt (måned 1-6 til halv pris). Der er ingen gratis måned oveni.",
    introProcent: "Rabat i procent (1-100)",
    introMaaneder: "Antal måneder (1-24)",
    introUgyldig: "Skriv hele tal: 1-100 % og 1-24 måneder.",
    introOpsummering: (procent: number, maaneder: number) =>
      `${procent} % rabat i ${maaneder === 1 ? "måned 1" : `måned 1-${maaneder}`}. Ingen gratis måned. Så betaler firmaet pakkens almindelige pris.`,
    udenIntro: "Start: første måned gratis. Butik og Pro: første måned til halv pris. Derefter betaler firmaet pakkens almindelige pris.",
    // "Behold Starts gratis måned + introrabat" (20261102450000): særaftale,
    // aldrig standard - kun Start.
    beholdSlaa: "Behold Starts gratis måned + introrabat",
    beholdHjaelp:
      "Særaftale: firmaet får første måned gratis og derefter introrabatten fra første betaling (fx måned 2-7). Kun på Start. Kræver en begrundelse, som gemmes i loggen.",
    beholdBegrundelse: "Begrundelse for særaftalen (5-500 tegn)",
    beholdPladsholder: "Fx Filip har aftalt det med firmaet i telefonen",
    beholdUgyldig: "Skriv en begrundelse på 5-500 tegn.",
    beholdTidligereCvr:
      "CVR'et har haft et abonnement før, så der er ingen gratis måned at beholde. Giv velkomstrabatten som særaftale nedenfor, eller luk og slå valget fra.",
    // Bekræftelsen: pakke og pris efter reglen for måned 1 (Filip, 27. okt.
    // 2026), fx "Butik – 999 kr./md. + moms. Første måned til halv pris
    // (499,50 kr. + moms). Derefter 999 kr./md. + moms."
    // gratis: "ny" = nyt CVR (velkomstrabat), "ingen" = CVR'et har haft et
    // abonnement før (ingen velkomstrabat), "saeraftale" = velkomstrabat som
    // særaftale. maaned1: pakkens regel ('gratis' = Start, 'halv' = Butik/Pro).
    // En introrabat gælder fra måned 1 i stedet for velkomstrabatten.
    // intro.beholdGratis: "Behold Starts gratis måned + introrabat" - kun på
    // Start (maaned1 'gratis') og ikke for et tidligere CVR uden særaftale:
    // "1 måned gratis, derefter 50 % i 6 måneder (måned 2-7)".
    pakkeOpsummering: (
      pakke: string,
      pris: string | null,
      intro: { procent: number; maaneder: number; pris: string | null; beholdGratis?: boolean } | null,
      gratis: "ny" | "ingen" | "saeraftale" = "ny",
      maaned1: "gratis" | "halv" = "halv",
      halvPris: string | null = null,
    ) => {
      const prisMd = pris ? `${pris}/md. + moms` : "pris ikke sat";
      if (intro?.beholdGratis && maaned1 === "gratis" && gratis !== "ingen") {
        const n = intro.maaneder;
        const mdr = n === 1 ? "1 måned (måned 2)" : `${n} måneder (måned 2-${n + 1})`;
        const introPris = intro.pris ? `, ${intro.pris}/md. + moms` : "";
        const saer = gratis === "saeraftale" ? " (særaftale)" : "";
        return `${pakke} – ${prisMd}. 1 måned gratis${saer}, derefter ${intro.procent} % i ${mdr}${introPris}. Derefter ${prisMd}.`;
      }
      if (intro) {
        const mdr = intro.maaneder === 1 ? "måned 1" : `måned 1-${intro.maaneder}`;
        const introPris = intro.pris ? ` (${intro.pris}/md. + moms)` : "";
        return `${pakke} – ${prisMd}. Introrabat ${intro.procent} % i ${mdr}${introPris}. Ingen gratis måned. Derefter ${prisMd}.`;
      }
      if (gratis === "ingen") {
        return `${pakke} – ${prisMd}. Ingen velkomstrabat i måned 1. Første betaling: ${prisMd}, når firmaet starter abonnementet.`;
      }
      const saer = gratis === "saeraftale" ? " (særaftale)" : "";
      if (maaned1 === "gratis") return `${pakke} – ${prisMd}. Første måned er gratis${saer}. Derefter ${prisMd}.`;
      const halv = halvPris ? ` (${halvPris} + moms)` : "";
      return `${pakke} – ${prisMd}. Første måned til halv pris${halv}${saer}. Derefter ${prisMd}.`;
    },
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
    feltNavnPladsholder: "Fx Butik",
    feltPris: "Pris pr. måned ekskl. moms (kr.)",
    feltAuktioner: "Auktioner pr. måned",
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
      auktionerUgyldigt: "Antal auktioner pr. måned skal være mindst 1.",
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
    "BidHamr Beskyttelse gælder ikke, når du køber af et firma. Du har i stedet fortrydelsesret og reklamationsret efter loven.",
  seAuktioner: "Se firmaets profil og auktioner",
  // Når firmaet selv ser sin firmaprofil (linker til /firma/auktioner).
  seEgneAuktioner: "Se dine auktioner",
  tilbage: "Tilbage",
} as const;

// Budpanelet på en erhvervsauktion.
export const ERHVERV_BIDPANEL = {
  prisLinje:
    "Vinder du, betaler du dit bud + gebyr + fragt. Du ser den samlede pris i kroner, før du byder, og har 48 timer til at betale. Alle beløb er inkl. moms.",
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
    // Købere kan ikke skrive til firmaer (BHE05) - kun BidHamr.
    beskederTekst: "Beskeder fra BidHamr.",
    auktioner: "Dine auktioner",
    auktionerTekst: "Alle de auktioner, du har oprettet.",
  },
  kanIkkeOpretteIkkeAktiv: "Du kan ikke oprette auktioner, før din pakke er sat i gang.",
  kanIkkeOpretteBetal: "Betal for din pakke under Abonnement. Så kan du oprette auktioner.",
  kanIkkeOpretteGratis: "Start din gratis måned under Abonnement. Så kan du oprette auktioner.",
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
  // Som ovenfor, men skiftet blev afvist, før noget blev trukket (skift op
  // fra den gratis måned).
  pakkeskiftLaasOvertagetIntetTrukket:
    "Vi kunne ikke gennemføre dit pakkeskift, og et andet pakkeskift blev sat i gang imens. Der er ikke trukket nogen penge for dette skift. Se din pakke under Abonnement, før du prøver igen. Er du i tvivl, så skriv til erhverv@bidhamr.dk.",
  // Skiftet blev afvist, før noget blev trukket, men vi kunne ikke sætte
  // pakkeskiftet tilbage (staff har fået en alarm).
  pakkeskiftIkkeRulletIntetTrukket:
    "Vi kunne ikke gennemføre dit pakkeskift. Der er ikke trukket nogen penge. Se din pakke under Abonnement, før du prøver igen. Er du i tvivl, så skriv til erhverv@bidhamr.dk.",
  // Abonnementet i Stripe er ikke aktivt (fx en ubetalt regning).
  pakkeskiftBetalFoerst: "Du kan ikke skifte pakke, før din seneste regning er betalt. Din pakke er ikke ændret.",
  afhentning: (vare: string) => `Køberen skal hente ${vare}. Aftal tid og sted med køberen.`,
  knapSeHandel: "Se handlen",
  ugensTal: (brugt: number, ialt: number | null) => (ialt == null ? `${brugt} (ubegrænset)` : `${brugt} af ${ialt}`),
  ugensTalLabel: "Brugt i denne måned",
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
  // Advarsel, når CVR'et har haft et abonnement før (erhverv_cvr_tidligere).
  cvrTidligere: {
    titel: "CVR'et har haft et abonnement før",
    tekst:
      "Firmaet har haft en firmakonto hos BidHamr før. Tjek oplysningerne herunder, før du opretter kontoen. Der er ikke oprettet noget endnu.",
    // Filip, 27. okt. 2026: et tidligere CVR får ingen velkomstrabat i måned 1
    // (hverken gratis eller halv pris) - kun som særaftale.
    ingenGratis:
      "Firmaet får ingen velkomstrabat i måned 1, fordi CVR'et har haft abonnement før. Første betaling er fuld pris og trækkes, når firmaet starter abonnementet.",
    saeraftaleSlaa: "Giv alligevel velkomstrabatten for måned 1 (særaftale)",
    saeraftaleHjaelp:
      "Kun efter aftale. Start: første måned gratis. Butik og Pro: første måned til halv pris. Begrundelsen gemmes i loggen med dit navn.",
    saeraftaleBegrundelse: "Begrundelse for særaftalen (5-500 tegn)",
    saeraftalePladsholder: "Fx aftalt med Filip 27/10: firmaet har været lukket i 2 år",
    saeraftaleUgyldig: "Skriv en begrundelse på 5-500 tegn.",
    resultatIngen: "Ingen velkomstrabat i måned 1",
    resultatSaeraftale: "Velkomstrabat for måned 1 (særaftale)",
    status: "Status",
    start: "Startet",
    opsagt: "Opsagt",
    gratis: "Har haft gratis periode",
    regninger: "Betalte regninger",
    ja: "Ja",
    nej: "Nej",
    ingenDato: "–",
    knap: "Opret kontoen alligevel",
  },
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
  // Opgave under "Venter på dig" på Overblik (/firma), når firmaet ikke har
  // en færdig udbetalingskonto.
  opgave: "Tilføj din bankkonto, så du kan oprette auktioner og få penge udbetalt.",
  opgaveFaerdig: "Gør din bankkonto færdig, så du kan oprette auktioner og få penge udbetalt.",
  opgaveTid: "Det er gratis og tager ca. 5 minutter.",
  // Under den slåede-fra "Opret en auktion"-knap.
  kanIkkeOprette: "Tilføj din bankkonto først. Se \"Venter på dig\" øverst på siden.",
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
    ugensKvote: "Auktioner denne måned",
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
    ugeKvote: (brugt: number, max: number | null) =>
      max == null
        ? `Du har oprettet ${brugt} ${brugt === 1 ? "auktion" : "auktioner"} i denne måned (ubegrænset).`
        : `Du har brugt ${brugt} af ${max} ${max === 1 ? "auktion" : "auktioner"} i denne måned.`,
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
      "Få en fil med alt det, BidHamr har gemt om dig og dit firma: konto, auktioner, handler og indstillinger. Vælg PDF for at læse den, eller JSON, hvis du vil flytte dine data til en anden tjeneste.",
    knapPdf: "Download som PDF",
    knapJson: "Download som JSON",
    hjaelp: "Du kan hente én fil i timen – enten PDF eller JSON.",
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
  // Regel for måned 1 (Filip, 27. okt. 2026): Start første måned gratis,
  // Butik og Pro første måned til halv pris; introrabat (50 % i måned 1-6,
  // sat manuelt i admin) i stedet for velkomstrabatten.
  // Nye nøgler: skal kobles på i Firma oversigt -> Abonnement.
  gratisMaaned: (dato: string) => `Din første måned er gratis. Du betaler første gang den ${dato}.`,
  // til: rabattens slutdato (Stripes discount.end, dansk dato). Konvention for
  // alle rabatdatoer: "til <dato>" - rabatten gælder til det tidspunkt på
  // dagen, så "til og med" ville love en dag for meget.
  introrabat: (procent: number, til: string) =>
    `Du har ${procent} % rabat på dit abonnement til ${til}. Derefter betaler du den almindelige pris.`,
  ingenGebyr: "Du betaler intet gebyr af dine salg. Du får hele buddet.",
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

// Admin -> Erhverv -> Firma: abonnementet i Stripe (chef og sælger).
export const ADMIN_ERHVERV_BETALING = {
  titel: "Betaling (Stripe)",
  ingenAbonnement: "Firmaet har ikke betalt for sin pakke endnu (intet abonnement i Stripe).",
  stripeStatus: "Status i Stripe",
  // Stripes abonnementsstatus på dansk (ukendte vises som de er).
  stripeStatusNavn: {
    trialing: "Gratis periode",
    active: "Aktiv",
    past_due: "Betaling mangler",
    canceled: "Opsagt",
    incomplete: "Ikke gennemført",
    incomplete_expired: "Ikke gennemført (udløbet)",
    unpaid: "Ubetalt",
    paused: "På pause",
  } as Record<string, string>,
  betaltTil: "Betalt til",
  opsigesFra: (dato: string) => `Abonnementet er opsagt og stopper ${dato}.`,
  knapOpsig: "Opsig abonnement",
  bekraeftOpsigTitel: "Opsig abonnementet?",
  bekraeftOpsig: "Abonnementet stopper ved slutningen af den betalte periode. Der refunderes ikke noget. Firmaet kan sælge, indtil perioden slutter.",
  opsagt: (dato: string) => `Abonnementet er opsagt og stopper ${dato}.`,
  opsagtStraks: "Firmaet havde intet abonnement i Stripe, så det er opsagt med det samme.",
  knapFortryd: "Fortryd opsigelsen",
  fortrudt: "Opsigelsen er fortrudt. Abonnementet fortsætter.",
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

// --- Pakker (Filip, 26. okt. 2026): Start, Butik og Pro -----------------------
// Fælles for Firma oversigt, admin og mails. Alle priser er ekskl. moms.
export const FIRMA_PAKKER = {
  auktionerPrMaaned: (antal: number | null) =>
    antal == null ? "Ubegrænset antal auktioner" : antal === 1 ? "1 auktion om måneden" : `${antal} auktioner om måneden`,
  fremhaevningerPrMaaned: (antal: number) =>
    antal === 0
      ? "Ingen fremhævede auktioner"
      : antal === 1
        ? "1 fremhævet auktion om måneden"
        : `${antal} fremhævede auktioner om måneden`,
  statistik: { ingen: "Ingen statistik", statistik: "Statistik", fuld: "Fuld statistik" } as Record<string, string>,
  fastKontaktperson: "Fast kontaktperson hos BidHamr",
  ugensButikRabat: (procent: number, antal: number) =>
    `${procent} % rabat på Ugens butik ${antal === 1 ? "den første gang" : `de første ${antal} gange`} hvert år`,
  prisPrMaaned: (kr: string) => `${kr} om måneden + moms`,
  // Velkomstrabatten i måned 1 efter pakken (erhverv_pakker.maaned1).
  maaned1: { gratis: "Første måned gratis", halv: "Første måned til halv pris" } as Record<string, string>,
  gratisTil: (dato: string) => `Gratis til og med ${dato}`,
  introrabat: (procent: number, maaneder: number) =>
    `${procent} % rabat i ${maaneder === 1 ? "1 måned" : `${maaneder} måneder`}`,
  skiftetIGratisPeriode: (navn: string) =>
    `Din pakke er nu ${navn}. Du er i din gratis periode, så der skal ikke betales noget nu.`,
  kvoteMaaned: (brugt: number, max: number | null) =>
    max == null ? `${brugt} auktioner i denne måned (ubegrænset)` : `${brugt} af ${max} auktioner i denne måned`,
  statistikLaast: "Statistik er med i pakkerne Butik og Pro. Se Abonnement, hvis du vil have den.",
  // BHE03 (databasen): "Du har oprettet X af Y auktioner i denne måned. Du kan
  // oprette den næste den 1. <måned>."
  kvoteFejl: (brugt: string, max: string, maaned: string) =>
    `Du har oprettet ${brugt} af ${max} auktioner i denne måned. Du kan oprette den næste den 1. ${maaned}.`,
  kvoteFejlKort: "Du har brugt månedens auktioner. Du kan oprette den næste den 1. i næste måned.",
} as const;

// --- Fremhævede auktioner ("Annonce") ------------------------------------------
export const FIRMA_FREMHAEVNING = {
  maerke: "Annonce",
  maerkeForklaring: "Betalt placering: firmaet har fremhævet auktionen",
  titel: "Fremhæv en auktion",
  forklaring:
    "En fremhævet auktion kommer i 7 dage med blandt de fremhævede auktioner øverst i sin kategori og i søgningen. Den er markeret \"Annonce\". Ubrugte fremhævninger forsvinder ved månedens udgang.",
  knap: "Fremhæv i 7 dage",
  tilbage: (n: number, maks: number) => `Du har ${n} af ${maks} fremhævninger tilbage i denne måned.`,
  ingenIPakken: "Din pakke har ingen fremhævede auktioner. Butik har 5 og Pro har 20 om måneden.",
  fremhaevet: (dato: string) => `Auktionen er fremhævet til ${dato}.`,
  aktiv: "Fremhævet",
  fejl: {
    ikke_firma: "Kun firmakonti kan fremhæve auktioner.",
    spaerret: "Din konto er spærret, så du kan ikke fremhæve auktioner.",
    ikke_aktiv: "Dit abonnement er ikke aktivt, så du kan ikke fremhæve auktioner.",
    ikke_fundet: "Auktionen findes ikke.",
    ikke_din: "Du kan kun fremhæve dine egne auktioner.",
    ikke_aktiv_auktion: "Du kan kun fremhæve en aktiv auktion, som købere kan se.",
    for_kort_tid: "Auktionen slutter om under 1 time og kan ikke fremhæves.",
    allerede: "Auktionen er allerede fremhævet.",
    kvote_brugt: "Du har brugt dine fremhævninger i denne måned. Du får nye den 1. i næste måned.",
    generisk: "Auktionen kunne ikke fremhæves. Prøv igen.",
  } as Record<string, string>,
} as const;

// --- Mails til firmaet, når BidHamr ændrer abonnementet ------------------------
// (pakke, pris, rabat og gratis periode - 20261102010000). Til firmaets
// kontakt-e-mail (samme som på regningerne fra Stripe).
export const FIRMA_ABONNEMENT_MAIL = {
  fodnote: "Du får denne mail, fordi BidHamr har ændret jeres abonnement.",
  hjaelp: "Har I spørgsmål, så skriv til erhverv@bidhamr.dk.",
  knap: "Se jeres abonnement",
  pakke: {
    emne: "Jeres pakke hos BidHamr er ændret",
    overskrift: "Jeres pakke er ændret",
    tekst: (firmanavn: string, fra: string, til: string, pris: string) => [
      `Hej ${firmanavn}.`,
      `Vi har ændret jeres pakke fra ${fra} til ${til}. ${til} koster ${pris} om måneden + moms.`,
      "Den nye pakke gælder med det samme. Den nye pris gælder fra jeres næste betaling.",
    ],
  },
  saerpris: {
    emne: "Jeres pris hos BidHamr er ændret",
    overskrift: "Jeres pris er ændret",
    tekst: (firmanavn: string, pakke: string, pris: string, straks: boolean) => [
      `Hej ${firmanavn}.`,
      `Som aftalt betaler I nu ${pris} om måneden + moms for pakken ${pakke}.`,
      straks
        ? "Prisen gælder fra i dag. Forskellen for resten af denne måned kommer med på jeres næste regning."
        : "Prisen gælder fra jeres næste betaling.",
    ],
    fjernetTekst: (firmanavn: string, pakke: string, pris: string) => [
      `Hej ${firmanavn}.`,
      `Jeres særpris er stoppet. Fra jeres næste betaling betaler I pakkens almindelige pris: ${pris} om måneden + moms for ${pakke}.`,
    ],
  },
  intro: {
    emne: "I har fået introrabat hos BidHamr",
    overskrift: "I har fået introrabat",
    // beholdGratis: "Behold Starts gratis måned + introrabat" (20261102450000) -
    // første måned gratis, derefter rabatten fra første betaling.
    tekst: (firmanavn: string, procent: number, maaneder: number, efterGratis: boolean, beholdGratis = false) => [
      `Hej ${firmanavn}.`,
      beholdGratis
        ? `Jeres første måned er gratis. Derefter får I ${procent} % rabat på jeres pakke i ${maaneder === 1 ? "1 måned" : `${maaneder} måneder`} fra jeres første betaling.`
        : `I får ${procent} % rabat på jeres pakke i ${maaneder === 1 ? "1 måned" : `${maaneder} måneder`}${efterGratis ? " fra jeres første betaling" : ""}.`,
      "Rabatten trækkes automatisk fra på jeres regninger. Derefter betaler I pakkens almindelige pris.",
    ],
    fjernetEmne: "Jeres introrabat hos BidHamr er stoppet",
    fjernetOverskrift: "Jeres introrabat er stoppet",
    fjernetTekst: (firmanavn: string) => [
      `Hej ${firmanavn}.`,
      "Jeres introrabat er stoppet. Fra jeres næste regning betaler I pakkens almindelige pris.",
    ],
  },
  gratis: {
    emne: "I har fået gratis måneder hos BidHamr",
    overskrift: "I har fået gratis måneder",
    tekst: (firmanavn: string, maaneder: number, til: string | null) => [
      `Hej ${firmanavn}.`,
      `I har fået ${maaneder === 1 ? "1 gratis måned" : `${maaneder} gratis måneder`}.`,
      til
        ? `Jeres pakke er gratis til ${til}. Derefter betaler I som normalt med jeres gemte kort.`
        : "De gratis måneder starter, når I har sat jeres betaling op under Abonnement i Firma oversigt.",
    ],
  },
  kort: {
    emne: "Jeres betalingskort skal skiftes",
    overskrift: "Skift jeres betalingskort",
    tekst: (firmanavn: string, kort: string | null) => [
      `Hej ${firmanavn}.`,
      kort
        ? `Kortet, I betaler jeres abonnement med (${kort}), udløber snart eller virker ikke længere.`
        : "Vi kan ikke trække betalingen for jeres abonnement på det kort, I har givet os.",
      "Skift kortet under Abonnement i Firma oversigt med knappen \"Skift betalingskort\". Det tager et minut.",
    ],
    knap: "Skift betalingskort",
  },
} as const;

// --- Admin: hurtighandlinger på et firma (chef og sælger-rollen) ----------------
export const ADMIN_FIRMA_ABONNEMENT = {
  begrundelse: "Skriv en begrundelse (3-500 tegn). Den gemmes i loggen.",
  firmaFindesIkke: "Firmaet findes ikke længere. Opdater siden.",
  gratis: {
    ugyldig: "Vælg 1, 2 eller 3 måneder.",
    givet: (maaneder: number, til: string | null) =>
      til
        ? `Firmaet har fået ${maaneder === 1 ? "1 gratis måned" : `${maaneder} gratis måneder`}. Gratis til ${til}.`
        : `Firmaet har fået ${maaneder === 1 ? "1 gratis måned" : `${maaneder} gratis måneder`}. De gælder, når firmaet starter abonnementet.`,
    forLang: "Den gratis periode kan højst vare 2 år i alt.",
    kanIkkeStarte:
      "Firmaet har intet aktivt abonnement og kan ikke starte et nyt lige nu (fx fordi abonnementet er opsagt eller lige er stoppet i Stripe). De gratis måneder er ikke givet, og firmaet har ikke fået en mail.",
  },
  // Samme formular er sendt to gange (dobbeltklik).
  alleredeUdfoert: "Det er allerede gjort. Opdater siden for at se ændringen.",
  intro: {
    ugyldig: "Rabatten skal være 1-100 % i 1-24 måneder.",
    sat: (procent: number, maaneder: number, stripe: boolean) =>
      stripe
        ? `Introrabatten (${procent} % i ${maaneder} måneder) er sat på firmaets abonnement.`
        : `Introrabatten (${procent} % i ${maaneder} måneder) er gemt. Den kommer på, når firmaet starter abonnementet.`,
    venter:
      "Introrabatten er gemt, men kunne ikke sættes på abonnementet i Stripe lige nu. Det prøves igen automatisk inden for 5 minutter.",
    fjernet: "Introrabatten er fjernet.",
    ingen: "Firmaet har ingen introrabat.",
    // Særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026).
    saerprisAktiv: "Firmaet har en særpris. Fjern særprisen først, hvis firmaet skal have introrabat i stedet.",
    // "Behold Starts gratis måned + introrabat" (20261102450000).
    satBehold: (procent: number, maaneder: number) =>
      `Introrabatten er gemt: første måned gratis, derefter ${procent} % i ${maaneder === 1 ? "1 måned" : `${maaneder} måneder`}. Den kommer på, når firmaet starter abonnementet.`,
    beholdKunStart: "Den gratis måned kan kun beholdes på Start. Butik og Pro har ingen gratis måned.",
    beholdStartet:
      "Firmaet har allerede startet abonnementet. Vælg \"Fra første betaling\" – så gælder rabatten efter en kørende gratis periode.",
    beholdIngenGratis:
      "Firmaet har ikke Starts gratis måned til gode (fx fordi CVR'et har haft et abonnement før, eller fordi den gratis måned er brugt).",
    beholdStraks: "Den gratis måned kan kun beholdes, når rabatten gælder fra første betaling.",
    beholdMangler: "Valget kan ikke gemmes lige nu, så intet er ændret. Prøv igen senere, eller kontakt en udvikler.",
  },
  saerpris: {
    ugyldig: "Skriv prisen i hele kroner ekskl. moms (mindst 1 kr.).",
    sat: (kr: string, stripe: boolean) =>
      stripe ? `Særprisen ${kr} om måneden + moms er sat på abonnementet.` : `Særprisen ${kr} om måneden + moms er gemt. Den bruges, når firmaet starter abonnementet.`,
    fjernet: "Særprisen er fjernet. Pakkens almindelige pris gælder fra næste betaling.",
    pakkeSkiftet: "Firmaets pakke er skiftet imens. Opdater siden, og prøv igen.",
    stripeFejl: "Prisen er IKKE ændret: abonnementet i Stripe kunne ikke opdateres. Prøv igen om lidt.",
    // Særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026).
    introAktiv: "Firmaet har en introrabat. Fjern introrabatten først, hvis firmaet skal have en særpris i stedet.",
  },
  ekstra: {
    ugyldig: "Skriv et antal (fx 5). Et minus trækker fra.",
    underNul: "Firmaet har ikke så mange ekstra i denne måned.",
    auktioner: (i_alt: number) => `Firmaet har nu ${i_alt} ekstra ${i_alt === 1 ? "auktion" : "auktioner"} i denne måned.`,
    fremhaevninger: (i_alt: number) => `Firmaet har nu ${i_alt} ekstra ${i_alt === 1 ? "fremhævning" : "fremhævninger"} i denne måned.`,
  },
  pakke: {
    skiftet: (navn: string) => `Pakken er skiftet til ${navn}. Den nye pris gælder fra firmaets næste betaling.`,
    uaendret: "Firmaet har allerede den pakke.",
  },
  kortMail: {
    sendt: "Mailen om at skifte betalingskort er sendt.",
    fejl: "Mailen kunne ikke sendes. Prøv igen om lidt.",
  },
  refusion: {
    refunderet: (kr: string) => `${kr} er refunderet til firmaets kort, og der er lavet en kreditnota.`,
  },
  fremhaevning: {
    stoppet: "Fremhævningen er stoppet.",
    tilbage: "Fremhævningen er stoppet og givet tilbage til månedens kvote.",
  },
  ikkeAktiv: "Abonnementet i Stripe er ikke aktivt. Løs betalingen først.",
  mailIkkeSendt: "Bemærk: mailen til firmaet kunne ikke sendes.",
} as const;

// --- Admin: pakke-editoren (kun chef) - pakkerne fra 26. okt. 2026 ----------------
export const ADMIN_PAKKE_EDITOR = {
  ubegraenset: "Ubegrænset antal auktioner",
  ubegraensetHjaelp: "Som i Pro: firmaet kan oprette så mange auktioner, det vil.",
  antalHjaelp: "Pr. kalendermåned (dansk tid). Nulstilles den 1. Annullerede auktioner tæller med.",
  fremh: "Fremhævede auktioner pr. måned",
  fremhHjaelp: "0 = ingen. Ubrugte fremhævninger forsvinder ved månedens udgang.",
  statistik: "Statistik i Firma oversigt",
  statistikValg: {
    ingen: "Ingen statistik",
    statistik: "Statistik (tal pr. måned)",
    fuld: "Fuld statistik (også pr. auktion)",
  } as Record<string, string>,
  fastKontakt: "Fast kontaktperson hos BidHamr",
  fastKontaktHjaelp: "Står som en fordel ved pakken i Firma oversigt.",
  ugensTitel: "Rabat på Ugens butik",
  ugensHjaelp: "Fx 50 % de første 3 gange hvert kalenderår (nulstilles 1. januar). Skriv 0 og 0 for ingen rabat.",
  ugensProcent: "Rabat i procent (0-90)",
  ugensAntal: "Gange pr. år (0-52)",
  fejl: {
    fremh: "Fremhævninger skal være et helt tal fra 0 til 1000.",
    ugens: "Rabatten på Ugens butik: procent 0-90 og gange 0-52 (hele tal).",
  },
  arkiveret: "Arkiveret",
  arkiveretHjaelp: "Gammel pakke. Den kan ikke vælges eller ændres, men gemmes af hensyn til regnskabet.",
  linjePris: (pris: string | null) => (pris ? `${pris} pr. md. ekskl. moms` : "Pris ikke sat"),
  linjeUgens: (pct: number, antal: number) => `${pct} % på Ugens butik ${antal} ${antal === 1 ? "gang" : "gange"}/år`,
} as const;

// --- Firma oversigt -> Abonnement: gratis måned, introrabat, særpris og kort ------
// (Filip, 26. okt. 2026). Store, enkle sætninger - målgruppen er ældre.
export const FIRMA_ABONNEMENT = {
  gratisStartTitel: "Start din gratis måned",
  gratisStartTekst: (maaneder: number) =>
    maaneder === 1
      ? "Din første måned er gratis. Du skal bare oplyse dit betalingskort. Vi trækker 0 kr. i dag."
      : `Dine første ${maaneder} måneder er gratis. Du skal bare oplyse dit betalingskort. Vi trækker 0 kr. i dag.`,
  gratisFoersteBetaling: (dato: string, beloeb: string) =>
    `Du betaler første gang den ${dato}. Prisen er ${beloeb}.`,
  knapStartGratis: "Start gratis",
  // Ingen gratis måned (fx et CVR, der har haft abonnement før): knappen på
  // /firma og /firma/abonnement (Filip, 27. okt. 2026).
  knapStartAbonnement: "Start abonnement",
  iDag: "I dag betaler du 0 kr.",
  gratisNu: (dato: string) => `Du er i din gratis periode til og med ${dato}. Indtil da betaler du ikke noget.`,
  dinPris: "Din pris",
  saerpris: (pris: string, normal: string) =>
    `Du har en aftalt pris: ${pris} om måneden + moms. Pakkens almindelige pris er ${normal} om måneden + moms.`,
  // beholdGratis: "Behold Starts gratis måned + introrabat" (20261102450000).
  introPlanlagt: (procent: number, maaneder: number, efterGratis: boolean, beholdGratis = false) =>
    beholdGratis
      ? `Efter din gratis måned får du ${procent} % rabat i ${maaneder === 1 ? "1 måned (måned 2)" : `${maaneder} måneder (måned 2-${maaneder + 1})`}. Derefter betaler du pakkens almindelige pris.`
      : `Du får ${procent} % rabat i ${maaneder === 1 ? "1 måned" : `${maaneder} måneder`}${efterGratis ? " fra din første betaling" : ""}. Derefter betaler du pakkens almindelige pris.`,
  // Butik/Pro: første måned til halv pris (Filip, 27. okt. 2026).
  halvPrisIDag: (ekskl: string, inkl: string) => `I dag betaler du ${ekskl} + moms (${inkl} i alt) for din første måned`,
  halvPrisTekst: (fuld: string) => `Din første måned koster halv pris. Fra næste måned betaler du ${fuld}.`,
  introPris: (pris: string) => `Med rabatten betaler du ${pris} om måneden + moms.`,
  kortTitel: "Dit betalingskort",
  kort: (kort: string, udloeb: string) => `${kort}, udløber ${udloeb}`,
  kortUdloeberSnart: "Dit kort udløber snart. Skift det i god tid, så din betaling ikke stopper.",
  kvitteringGratisTitel: "Din gratis periode er startet",
  kvitteringGratisTekst: (dato: string) =>
    `Du kan oprette auktioner nu. Vi har ikke trukket nogen penge. Du betaler første gang den ${dato}.`,
  bekraeftOpgraderGratis:
    "Du er i din gratis periode. Den nye pakke gælder med det samme, og du betaler ikke noget nu. Når den gratis periode slutter, betaler du den nye pakkes pris.",
  bekraeftNedgraderGratis:
    "Du er i din gratis periode. Den nye pakke gælder med det samme, og du betaler ikke noget nu. Når den gratis periode slutter, betaler du den nye pakkes pris.",
  bekraeftNedgraderGratisJa: "Ja, skift pakke nu",
  // Fra Starts gratis måned til Butik/Pro: ikke gratis (Filip, 27. okt. 2026).
  // Fx "999,50 kr. + moms (1.249,38 kr.)".
  beloebMedMoms: (ekskl: string, inkl: string) => `${ekskl} + moms (${inkl})`,
  // beloeb fx "999,50 kr. + moms (1.249,38 kr.)". rabat: velkomstSkiftRabat -
  // slags afgør teksten (ikke procenten: en introrabat kan også være 50 %).
  // intro.til er rabattens slutdato fra Stripe (dansk dato, "31. marts 2027" -
  // samme konvention som introrabat: "til <dato>") eller null uden slutdato.
  bekraeftOpgraderFraGratisMaaned: (
    navn: string,
    beloeb: string,
    rabat:
      | { slags: "velkomst"; procent: number }
      | { slags: "intro"; procent: number; til: string | null; maaneder: number }
      | { slags: "saerpris"; procent: number },
  ) => {
    const start = `Din gratis måned slutter, når du skifter. I dag betaler du ${beloeb} for din første måned med ${navn}`;
    if (rabat.slags === "velkomst") return `${start} (halv pris). Fra næste måned betaler du fuld pris.`;
    if (rabat.slags === "intro") {
      const periode = rabat.til
        ? `til ${rabat.til}`
        : `i ${rabat.maaneder === 1 ? "1 måned" : `${rabat.maaneder} måneder`}`;
      return `${start} (${rabat.procent} % rabat ${periode}). Derefter betaler du pakkens almindelige pris.`;
    }
    return `${start}. Det er pakkens almindelige pris, og den betaler du også fra næste måned.`;
  },
  // Skift op fra den gratis måned (opgraderFraVelkomst) afvist, før noget er
  // trukket:
  //  - introrabatten kunne ikke sættes på endnu (fx månedsskifte - op til et døgn)
  skiftVenterRabat:
    "Din rabat er ved at blive sat op. Det kan tage op til et døgn. Prøv at skifte pakke igen senere. Der er ikke trukket nogen penge.",
  //  - introrabatten er lige sat på: prisen er en anden end den viste
  skiftRabatSatOp:
    "Din rabat er nu sat op, så prisen er ændret. Se den nye pris, og vælg pakken igen. Der er ikke trukket nogen penge.",
  //  - rabatten i Stripe og hos os er uenige (staff har fået en alarm)
  skiftRetRabat: "Vi skal lige rette din rabat. Kontakt os, eller prøv igen senere. Der er ikke trukket nogen penge.",
  //  - rabatten er ændret, siden siden blev vist
  skiftPrisAendret:
    "Prisen er ændret, siden du åbnede siden. Se den nye pris, og vælg pakken igen. Der er ikke trukket nogen penge.",
  //  - siden eller appen sendte ikke, hvilken pris den viste
  skiftVisningMangler:
    "Vi kunne ikke se, hvilken pris du fik vist. Opdater siden, se prisen, og vælg pakken igen. Der er ikke trukket nogen penge.",
  // I bekræftelsen, når der ikke kan vises et beløb (velkomstSkiftUdfald):
  //  - venter: introrabatten er aftalt, men ikke sat på endnu
  bekraeftOpgraderVenterRabat:
    "Din aftalte rabat er ikke sat på dit abonnement endnu. Når du trykker, sætter vi den op først. Der bliver ikke trukket nogen penge nu. Bagefter kan du se prisen og skifte pakke.",
  //  - ret_rabat: skiftet kan ikke gennemføres lige nu
  knapSaetRabatOp: "Sæt min rabat op",
  bekraeftOpgraderRetRabat:"Vi skal lige rette din rabat, før du kan skifte pakke. Kontakt os, eller prøv igen senere.",
  //  - pakken har ingen pris endnu: skiftet kan ikke gennemføres lige nu
  bekraeftOpgraderPrisIkkeSat:
    "Prisen på pakken aftales med BidHamr, så du kan ikke vælge den her endnu. Skriv til erhverv@bidhamr.dk.",
  knapSkiftNu: "Skift til denne pakke",
} as const;

// --- Firma oversigt -> Statistik efter pakkens niveau ----------------------------
export const FIRMA_STATISTIK_NIVEAU = {
  laastTitel: "Statistik er med i Butik og Pro",
  laastTekst:
    "Med Butik ser du, hvor mange der har set dine auktioner, budt og købt – måned for måned. Med Pro ser du også tallene for hver enkelt auktion. Skifter du til en større pakke, gælder den med det samme.",
  knapSePakker: "Se pakkerne",
  prAuktionLaast: "Tallene for hver enkelt auktion er med i Pro.",
} as const;

// --- Firma oversigt -> Auktioner: fremhæv en auktion -----------------------------
export const FIRMA_FREMHAEV_KNAP = {
  bekraeftTitel: "Fremhæv auktionen i 7 dage?",
  bekraeftTekst: (tilbage: number) =>
    `I 7 dage kommer auktionen med blandt de fremhævede auktioner øverst i sin kategori og i søgningen. Den markeres "Annonce". Det bruger 1 af de ${tilbage} fremhævninger, du har tilbage i denne måned.`,
  ja: "Ja, fremhæv",
  annuller: "Annullér",
  ingenTilbage: "Du har brugt alle månedens fremhævninger. Du får nye den 1. i næste måned.",
  talLabel: "Fremhævninger tilbage",
  tal: (tilbage: number, maks: number) => `${tilbage} af ${maks}`,
  fremhaevetTil: (dato: string) => `Fremhævet til ${dato}`,
} as const;
