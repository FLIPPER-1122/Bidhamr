// Tekster til siden /bidhamr-beskyttelse og til budfeltet (BidPanel).
// Bygger på ROADMAP-BESLUTNINGER.md, afsnit 1, 2 og 4 (inkl. "Pakke kommer ikke frem" og "Visning", 1. okt. 2026).
// Brug altid navnet "BidHamr Beskyttelse". Procenter må kun stå på siden, ikke ved budfeltet.

export type Sektion = {
  overskrift: string;
  tekst?: string;
  punkter: string[];
};

export type FaqPunkt = {
  spoergsmaal: string;
  svar: string;
};

export const SIDETITEL = "BidHamr Beskyttelse";

export const METABESKRIVELSE =
  "Se, hvad BidHamr altid hjælper med, og hvad du får ekstra med BidHamr Beskyttelse, hvis varen går i stykker under forsendelsen eller ikke er som beskrevet.";

export const INTRO =
  "På BidHamr handler du med andre privatpersoner. Vi hjælper altid, hvis noget går helt galt. Med BidHamr Beskyttelse får du også hjælp, hvis varen går i stykker under forsendelsen eller ikke er som beskrevet. Her kan du se forskellen.";

export const SEKTION_ALTID: Sektion = {
  overskrift: "Det hjælper BidHamr altid med",
  tekst: "Det gælder alle køb – også uden BidHamr Beskyttelse.",
  punkter: [
    "Betalingen håndteres af vores betalingspartner Stripe, som holder pengene, indtil du har godkendt varen. Sælgeren får dem først, når du har bekræftet, at varen er i orden, eller når fristen for at oprette en sag er gået.",
    "Pakken kommer ikke frem. Forsvinder pakken under forsendelsen, hjælper vi dig.",
    "Åbenlys svindel. Er pakken tom, er det en helt anden vare, er det en falsk kopi solgt som ægte, eller er varen aldrig sendt, kan du altid oprette en sag. Pengene holdes tilbage hos Stripe, mens vi ser på sagen.",
  ],
};

export const SEKTION_MED: Sektion = {
  overskrift: "Det hjælper BidHamr Beskyttelse med",
  tekst: "Har du valgt BidHamr Beskyttelse, får du også hjælp her:",
  punkter: [
    "Varen er gået i stykker under forsendelsen. Du kan oprette en sag og sende varen retur.",
    "Varen er ikke som beskrevet. Her håndterer BidHamr sagen for dig, så du ikke selv skal løse det med sælgeren.",
  ],
};

export const SEKTION_UDEN: Sektion = {
  overskrift: "Uden BidHamr Beskyttelse",
  punkter: [
    "Går varen i stykker under forsendelsen, eller er den ikke som beskrevet, må du og sælgeren selv blive enige om en løsning. BidHamr blander sig ikke, og varen kan ikke sendes retur gennem BidHamr.",
    "Pakke, der ikke kommer frem, og åbenlys svindel hjælper vi stadig med.",
  ],
};

export const SEKTION_SAG: Sektion = {
  overskrift: "Sådan opretter du en sag",
  punkter: [
    "Du har 48 timer til at oprette en sag. Fristen starter, når sporingen viser, at du har hentet pakken.",
    "Tag billeder af pakken, labelen og indholdet, og upload dem, når du opretter sagen. Uden billeder kan vi ikke oprette sagen.",
    "Når sagen er oprettet, holdes pengene tilbage, og du kan følge sagen på siden Sager.",
    "Opretter du ingen sag inden for 48 timer, går pengene automatisk til sælgeren.",
  ],
};

export const SEKTION_PRIS: Sektion = {
  overskrift: "Hvad koster det?",
  punkter: [
    "BidHamr Beskyttelse koster 5 % af dit bud – mindst 25 kr og højst 250 kr.",
    "Du vælger det selv, når du byder. Det er ikke slået til på forhånd.",
    "Dit valg følger buddet og kan ikke ændres bagefter.",
    "Vinder du auktionen, indgår prisen i din betaling – også hvis du har slået automatisk betaling til.",
    "Alle beløb er inkl. moms.",
  ],
};

export const SEKTIONER: Sektion[] = [
  SEKTION_ALTID,
  SEKTION_MED,
  SEKTION_UDEN,
  SEKTION_SAG,
  SEKTION_PRIS,
];

export const FAQ_OVERSKRIFT = "Spørgsmål og svar";

export const FAQ: FaqPunkt[] = [
  {
    spoergsmaal: "Kan jeg tilføje BidHamr Beskyttelse, efter jeg har budt?",
    svar: "Nej. Du vælger BidHamr Beskyttelse, når du byder, og valget kan ikke ændres bagefter. Vil du have den, skal du sætte flueben, før du afgiver dit bud.",
  },
  {
    spoergsmaal: "Hvad sker der, hvis min pakke ikke kommer frem?",
    svar: "Så hjælper vi dig – også selvom du ikke har valgt BidHamr Beskyttelse.",
  },
  {
    spoergsmaal: "Varen er gået i stykker, men jeg har ikke BidHamr Beskyttelse. Hvad gør jeg?",
    svar: "Så må du og sælgeren selv finde en løsning, og varen kan ikke sendes retur gennem BidHamr. Er der tale om åbenlys svindel, fx en tom pakke eller en helt anden vare, kan du dog altid oprette en sag.",
  },
  {
    spoergsmaal: "Kan jeg fortryde mit køb?",
    svar: "Nej. Du handler med en privatperson, så der er ingen fortrydelsesret. BidHamr Beskyttelse handler om varer, der går i stykker under forsendelsen eller ikke er som beskrevet – ikke om at fortryde.",
  },
  {
    spoergsmaal: "Gælder det, hvis jeg henter varen hos sælgeren?",
    svar: "Når du henter varen hos sælgeren, viser du en kode, og pengene går til sælgeren med det samme. Der er ingen frist til at oprette en sag bagefter, så se varen godt efter, før du viser koden.",
  },
];

// Tekster til budfeltet. Ingen procenter her – kun beløb i kroner (vises af koden).
export const BIDPANEL = {
  beskyttelseLabel: "Tilføj BidHamr Beskyttelse",
  laesMere: "Læs mere",
  laesMereHref: "/bidhamr-beskyttelse",
  prisLinje:
    "Vinder du, betaler du dit bud + købergebyr + fragt + evt. BidHamr Beskyttelse. Du ser den samlede pris i kroner, før du betaler, og har 24 timer til at betale. Alle beløb er inkl. moms.",
} as const;
