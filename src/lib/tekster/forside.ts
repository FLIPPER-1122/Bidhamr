// Tekster til forsiden (/). Bygger på ROADMAP-BESLUTNINGER.md afsnit 8
// (hero, tryghed, kategorier, store kort) og afsnit 1-4 (betaling, Stripe,
// BidHamr Beskyttelse). Ordet "forsikring" bruges aldrig.
// Sig aldrig, at BidHamr modtager eller holder pengene - betalingen
// håndteres af vores betalingspartner Stripe.
// MitID gælder private. Firmaer (erhverv) er godkendt med CVR, ikke MitID.
// Pengene udbetales først, når køberen har godkendt varen, eller når
// fristen for at oprette en sag er udløbet.
// Ingen priser for erhverv her.

export const FORSIDE = {
  metaTitel: "BidHamr – auktioner mellem private",
  metaBeskrivelse:
    "Køb og sælg brugte ting på auktion i Danmark. Private er bekræftet med MitID, du ser totalprisen, før du byder, og betalingen håndteres af Stripe.",
  ogTitel: "BidHamr – køb og sælg brugte ting på auktion",
  ogBeskrivelse:
    "Byd på brugte ting fra andre danskere. Du ser den samlede pris, før du byder, og betaler via Stripe.",

  hero: {
    titel: "Køb og sælg brugte ting på auktion",
    undertitel: "Byd mod andre danskere. Du ser altid den samlede pris, før du byder.",
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
      tekst: "Private bekræftes med MitID, før de byder eller sælger. Firmaer er godkendt med CVR.",
      href: "/saadan-virker-det#mitid",
    },
    {
      ikon: "skjold",
      titel: "BidHamr Beskyttelse",
      tekst: "Vælg det, når du byder. Så hjælper vi, hvis varen går i stykker under forsendelsen eller ikke er som beskrevet.",
      href: "/bidhamr-beskyttelse",
    },
    {
      ikon: "kort",
      titel: "Betaling via Stripe",
      tekst: "Sælger får først pengene, når du har godkendt varen, eller når fristen for at oprette en sag er udløbet.",
      href: "/saadan-virker-det",
    },
    {
      ikon: "hjaelp",
      titel: "Hjælp ved svindel",
      tekst: "Tom pakke, en helt anden vare eller aldrig sendt? Så kan du altid oprette en sag.",
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
    tekst: "Der er ingen aktive auktioner i øjeblikket. Det er gratis at sætte en vare til salg – du betaler kun gebyr, hvis den bliver solgt.",
    knap: "Sælg en vare",
    link: "Sådan virker det",
  },

  saadan: {
    titel: "Sådan virker det",
    undertitel: "Fra første bud til varen er hos dig – i tre trin.",
    trin: [
      {
        titel: "Bekræft dig og byd",
        tekst: "Bekræft dig én gang med MitID. Før du byder, ser du den samlede pris med gebyr og fragt.",
      },
      {
        titel: "Vind og betal",
        tekst: "Har du højeste bud, når auktionen slutter, har du 48 timer til at betale med kort, MobilePay, Apple Pay eller Google Pay. Betalingen håndteres af Stripe.",
      },
      {
        titel: "Få varen",
        tekst: "Sælger sender varen, eller du henter den. Sælger får først pengene, når du har godkendt varen, eller når fristen for at oprette en sag er udløbet.",
      },
    ],
    laesMere: "Læs mere om, hvordan det virker",
    saelgKnap: "Sælg en vare",
  },

  erhverv: {
    titel: "Har du et firma?",
    tekst: "Har dit firma et dansk CVR-nummer, kan du sælge på auktion til hele Danmark med BidHamr Erhverv. Udfyld en kort formular, så kontakter vi dig.",
    knap: "Læs om BidHamr Erhverv",
  },
} as const;
