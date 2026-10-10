// Tekster til forsiden (/). Bygger på ROADMAP-BESLUTNINGER.md afsnit 8
// (hero, tryghed, kategorier, store kort) og afsnit 1-4 (betaling, Stripe,
// BidHamr Beskyttelse). Ordet "forsikring" bruges aldrig.
// Sig aldrig, at BidHamr modtager eller holder pengene - betalingen
// håndteres af vores betalingspartner Stripe.
//
// TODO indhold-agent: alle tekster her er korte pladsholdere fra frontend.
// Gennemlæs og skriv dem endeligt (især hero, de tre trin og erhverv).

export const FORSIDE = {
  metaTitel: "BidHamr – auktioner mellem private",
  metaBeskrivelse:
    "Køb og sælg brugte ting på auktion mellem private i Danmark. MitID-verificerede brugere, BidHamr Beskyttelse og sikker betaling via Stripe.",
  ogTitel: "BidHamr – køb og sælg brugte ting på auktion",
  ogBeskrivelse:
    "Byd, vind og handl trygt med andre danskere. Alle, der byder og sælger, er bekræftet med MitID.",

  hero: {
    titel: "Gode ting fortjener et nyt hjem",
    undertitel: "Byd, vind og handl trygt med andre danskere.",
    soegLabel: "Hvad leder du efter?",
    soegKnap: "Søg",
    populaere: "Populære søgninger",
    saelgKnap: "Sælg en vare",
    saadanLink: "Sådan virker det",
  },

  populaereSoegninger: ["PlayStation 5", "Omega", "Wegner", "Lego", "Royal Copenhagen"],

  tryghedLabel: "Derfor er det trygt at handle på BidHamr",
  tryghed: [
    {
      ikon: "personTjek",
      titel: "MitID-verificerede brugere",
      tekst: "Alle, der byder og sælger, er bekræftet med MitID.",
      href: "/saadan-virker-det#mitid",
    },
    {
      ikon: "skjold",
      titel: "BidHamr Beskyttelse",
      tekst: "Ekstra hjælp, hvis varen ikke er som beskrevet.",
      href: "/bidhamr-beskyttelse",
    },
    {
      ikon: "kort",
      titel: "Sikker betaling via Stripe",
      tekst: "Sælger får først pengene, når du har fået varen.",
      href: "/saadan-virker-det",
    },
    {
      ikon: "hjaelp",
      titel: "Hjælp ved svindel",
      tekst: "Tom pakke eller en helt anden vare? Vi åbner altid en sag.",
      href: "/faq",
    },
  ],

  kategorierTitel: "Udforsk kategorier",

  slutterSnartTitel: "Slutter snart",
  nyeTitel: "Nye auktioner",
  seAlle: "Se alle",

  // Når der slet ingen aktive auktioner er.
  tom: {
    titel: "Ingen auktioner lige nu",
    tekst: "Der er ingen aktive auktioner i øjeblikket. Sæt noget til salg, og vær den første.",
    knap: "Sælg en vare",
    link: "Sådan virker det",
  },

  saadan: {
    titel: "Sådan virker det",
    undertitel: "Fra første bud til varen er hos dig – i tre trin.",
    trin: [
      {
        titel: "Bekræft dig og byd",
        tekst: "Bekræft dig én gang med MitID. Før du byder, ser du altid totalprisen med gebyr og fragt.",
      },
      {
        titel: "Vind og betal trygt",
        tekst: "Har du højeste bud, når tiden løber ud, betaler du inden 48 timer med kort, MobilePay, Apple Pay eller Google Pay.",
      },
      {
        titel: "Få varen",
        tekst: "Sælger sender eller du henter. Sælger får først pengene, når du har fået varen.",
      },
    ],
    laesMere: "Læs mere om, hvordan det virker",
    saelgKnap: "Sælg en vare",
  },

  erhverv: {
    titel: "Har du et firma?",
    tekst: "Sælg dine varer på auktion til hele Danmark med BidHamr Erhverv. Vi hjælper dig personligt i gang.",
    knap: "Læs om BidHamr Erhverv",
  },
} as const;
