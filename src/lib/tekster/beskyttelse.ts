// Tekster til siden /bidhamr-beskyttelse og til budfeltet (BidPanel).
// Bygger på ROADMAP-BESLUTNINGER.md, afsnit 1, 2, 3 og 4 (ny prismodel, Filip 26. okt. 2026):
// BidHamr Beskyttelse er altid inkluderet i købers gebyr, når varen sendes. Den kan
// ikke til- eller fravælges. Ved afhentning: samme gebyr, men ingen Beskyttelse.
// Erhvervsauktioner: ingen Beskyttelse (fortrydelsesret i stedet).
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
  "BidHamr Beskyttelse er altid med i gebyret, når varen sendes. Se, hvad den dækker, hvis varen går i stykker under forsendelsen eller ikke er som beskrevet.";

export const INTRO =
  "På BidHamr handler du med andre privatpersoner. Når du køber en vare, der bliver sendt, er BidHamr Beskyttelse altid med. Den er en del af gebyret, så du skal ikke vælge den, og den koster ikke ekstra. Her kan du se, hvad vi hjælper med.";

// Mærkerne over de to kolonner øverst på siden.
export const MAERKE_ALTID = "Altid";
export const MAERKE_MED = "Med, når varen sendes";

export const SEKTION_ALTID: Sektion = {
  overskrift: "Det hjælper BidHamr altid med",
  tekst: "Det gælder alle køb fra privatpersoner.",
  punkter: [
    "Betalingen håndteres af vores betalingspartner Stripe, som holder pengene, indtil du har godkendt varen. Sælgeren får dem først, når du har bekræftet, at varen er i orden, eller når fristen for at oprette en sag er gået.",
    "Pakken kommer ikke frem. Forsvinder pakken under forsendelsen, hjælper vi dig.",
    "Åbenlys svindel. Er pakken tom, er det en helt anden vare, er det en falsk kopi solgt som ægte, eller er varen aldrig sendt, kan du altid oprette en sag. Pengene holdes tilbage hos Stripe, mens vi ser på sagen.",
  ],
};

export const SEKTION_MED: Sektion = {
  overskrift: "Det dækker BidHamr Beskyttelse",
  tekst: "Når varen bliver sendt, får du også hjælp her:",
  punkter: [
    "Varen er gået i stykker under forsendelsen. Du kan oprette en sag og sende varen retur.",
    "Varen er ikke som beskrevet. Her håndterer BidHamr sagen for dig, så du ikke selv skal løse det med sælgeren.",
  ],
};

export const SEKTION_AFHENTNING: Sektion = {
  overskrift: "Når du henter varen hos sælgeren",
  punkter: [
    "BidHamr Beskyttelse gælder kun pakker, der bliver sendt. Henter du varen selv, kan du se den, før du tager imod den.",
    "Du viser en kode, når du har fået varen, og så går pengene til sælgeren med det samme. Der er ingen frist til at oprette en sag bagefter, så se varen godt efter, før du viser koden.",
    "Du betaler det samme gebyr som ved forsendelse, men ingen fragt.",
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
    "BidHamr Beskyttelse koster ikke ekstra. Den er en del af det gebyr, du betaler som køber.",
    "Gebyret er 7 % af buddet + 5 kr., dog højst 300 kr., når varen sælges for op til 7.500 kr.",
    "Sælges varen for mere end 7.500 kr., er gebyret 3 % af buddet + 15 kr., dog højst 650 kr.",
    "Du skal ikke vælge noget, og du kan ikke fravælge den. Den er med, når varen bliver sendt.",
    "Ved auktionen ser du gebyret i kroner og den samlede pris, før du byder.",
    "Alle beløb er inkl. moms.",
  ],
};

export const SEKTIONER: Sektion[] = [
  SEKTION_ALTID,
  SEKTION_MED,
  SEKTION_AFHENTNING,
  SEKTION_SAG,
  SEKTION_PRIS,
];

export const FAQ_OVERSKRIFT = "Spørgsmål og svar";

export const FAQ: FaqPunkt[] = [
  {
    spoergsmaal: "Skal jeg vælge BidHamr Beskyttelse, når jeg byder?",
    svar: "Nej. BidHamr Beskyttelse er altid med i gebyret, når varen sendes. Du skal ikke sætte flueben, og den koster ikke ekstra.",
  },
  {
    spoergsmaal: "Kan jeg fravælge BidHamr Beskyttelse for at betale mindre?",
    svar: "Nej. Gebyret er det samme for alle køb fra privatpersoner, og BidHamr Beskyttelse er en del af det.",
  },
  {
    spoergsmaal: "Hvad sker der, hvis min pakke ikke kommer frem?",
    svar: "Så hjælper vi dig. Du kan melde pakken bortkommet på handelssiden 7 dage efter, at sælgeren har sendt den.",
  },
  {
    spoergsmaal: "Varen er gået i stykker under forsendelsen. Hvad gør jeg?",
    svar: "Tag billeder af pakken, labelen og skaden, og opret en sag på handelssiden inden for 48 timer. En medarbejder ser på sagen. Får du medhold, får du prisen for varen tilbage (gebyr og fragt refunderes ikke), og varen sendes retur til sælgeren.",
  },
  {
    spoergsmaal: "Kan jeg fortryde mit køb?",
    svar: "Nej. Du handler med en privatperson, så der er ingen fortrydelsesret. BidHamr Beskyttelse handler om varer, der går i stykker under forsendelsen eller ikke er som beskrevet – ikke om at fortryde.",
  },
  {
    spoergsmaal: "Gælder det, hvis jeg henter varen hos sælgeren?",
    svar: "Nej. BidHamr Beskyttelse gælder kun pakker, der bliver sendt. Når du henter varen, viser du en kode, og pengene går til sælgeren med det samme. Der er ingen frist til at oprette en sag bagefter, så se varen godt efter, før du viser koden. Du betaler det samme gebyr, men ingen fragt.",
  },
  {
    spoergsmaal: "Gælder det, når jeg køber af et firma?",
    svar: "Nej. Når du køber af et firma, har du i stedet fortrydelsesret og reklamationsret efter loven.",
  },
];

// Tekster til budfeltet. Ingen procenter her – kun beløb i kroner (vises af koden).
// beskyttelseInkluderet vises ved forsendelse (privat) i stedet for det gamle flueben.
export const BIDPANEL = {
  beskyttelseInkluderet: "BidHamr Beskyttelse er med i gebyret, når varen sendes.",
  gebyrLabel: "Gebyr",
  laesMere: "Læs mere",
  laesMereHref: "/bidhamr-beskyttelse",
  prisLinje:
    "Vinder du, betaler du dit bud + gebyr + fragt. Du ser den samlede pris i kroner, før du byder, og har 48 timer til at betale. Alle beløb er inkl. moms.",
  // Næste mindstebud er over beløbsloftet (MAKS_BELOEB_KR) - ingen kan byde mere.
  loftNaaet: (maks: string) => `Auktionen har nået det højeste tilladte bud på ${maks}.`,
  loftNaaetKort: "Højeste tilladte bud er nået",
  // Sluttiden er passeret, men auktionen er ikke lukket endnu (cron, under et minut).
  tidSlut: "Auktionen er slut – resultatet kommer om lidt",
} as const;

// Sager i den nye prismodel (betalinger.prismodel = 'ny', Filip 26. okt. 2026):
// ved medhold får køberen kun buddet tilbage. Vises i "Opret sag" og ved en
// åben sag - ikke for gamle handler eller erhverv.
export const SAG_REFUSION_NY =
  "Får du medhold, får du prisen for varen (dit bud) tilbage. Gebyr og fragt refunderes ikke.";
