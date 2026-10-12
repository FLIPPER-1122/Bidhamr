// Standardsvar og -begrundelser i admin (Filip, 12. okt. 2026: "så man ikke
// skriver det samme igen og igen"). Ét klik sætter teksten ind i feltet, og
// den kan rettes, før den sendes.
//
// TODO indhold-agenten: alle tekster her er korte pladsholdere skrevet af
// frontend. De skal gennemskrives (tone, jura, DSA art. 17-krav til
// begrundelser). Hold dem korte og uden beløb og interne oplysninger -
// mange af dem vises for brugeren.
import type { Skabelon } from "@/components/admin/Skabeloner";

// --- Sager: begrundelse til køber og sælger (vises for begge) -------------

export const SAG_BEGRUNDELSE: Record<"koeber" | "saelger" | "lukket", readonly Skabelon[]> = {
  koeber: [
    {
      label: "Ikke som beskrevet",
      tekst:
        "Vi har gennemgået billederne og beskrivelsen i auktionen. Varen svarer ikke til beskrivelsen, så køberen får medhold.",
    },
    {
      label: "Ikke modtaget",
      tekst:
        "Sporingen viser ikke, at pakken er leveret til køberen, og sælgeren har ikke kunnet dokumentere levering. Køberen får derfor medhold.",
    },
    {
      label: "Beskadiget",
      tekst:
        "Billederne viser, at varen er beskadiget, og at skaden ikke fremgik af auktionen. Køberen får medhold.",
    },
  ],
  saelger: [
    {
      label: "Som beskrevet",
      tekst:
        "Vi har gennemgået billederne og beskrivelsen i auktionen. Varen svarer til beskrivelsen, så sælgeren får medhold.",
    },
    {
      label: "Leveret ifølge sporing",
      tekst: "Sporingen viser, at pakken er leveret. Sælgeren får derfor medhold.",
    },
    {
      label: "Mangler dokumentation",
      tekst:
        "Køberen har ikke sendt billeder eller anden dokumentation, der viser problemet. Sælgeren får derfor medhold.",
    },
  ],
  lukket: [
    {
      label: "Køber og sælger er enige",
      tekst: "Køber og sælger har fundet en løsning sammen. Sagen lukkes uden afgørelse.",
    },
    {
      label: "Trukket tilbage",
      tekst: "Køberen har trukket klagen tilbage. Sagen lukkes uden afgørelse.",
    },
  ],
};

// --- Kontaktformular: svar til brugeren -----------------------------------

export const KONTAKT_EMNE_FORSLAG = "Svar på din henvendelse";

export const KONTAKT_SVAR: readonly Skabelon[] = [
  {
    label: "Tak – vi kigger på det",
    tekst: "Tak for din henvendelse. Vi kigger på det og vender tilbage hurtigst muligt.",
  },
  {
    label: "Brug for flere oplysninger",
    tekst:
      "Tak for din henvendelse. For at hjælpe dig skal vi bruge lidt flere oplysninger. Skriv gerne, hvilken handel det drejer sig om, og hvad der er sket.",
  },
  {
    label: "Henvis til sag",
    tekst:
      "Tak for din henvendelse. Er der et problem med en vare, du har købt, så opret en sag fra handlen under Mine køb. Så behandler vi den hurtigst.",
  },
  {
    label: "Løst",
    tekst: "Tak for din henvendelse. Vi har nu løst det. Skriv endelig igen, hvis der er mere.",
  },
];

// --- Anmeldelser og rapporter: note om, hvad der er tjekket (intern) ------

export const RAPPORT_NOTE: readonly Skabelon[] = [
  { label: "Intet brud", tekst: "Opslaget er gennemgået. Det bryder ikke vores regler." },
  { label: "Dublet", tekst: "Samme opslag er allerede behandlet i en anden anmeldelse." },
  { label: "Rettet af sælger", tekst: "Sælgeren har rettet opslaget, så det nu overholder reglerne." },
];

// Begrundelse til brugeren ved indgreb (fakta, vises for brugeren). Regel og
// lov vælges for sig i dialogen.
export const INDGREB_FAKTA: readonly Skabelon[] = [
  {
    label: "Forbudt vare",
    tekst: "Auktionen sælger en vare, der ikke må sælges på BidHamr.",
  },
  {
    label: "Vildledende",
    tekst: "Auktionens beskrivelse eller billeder giver et forkert indtryk af varen.",
  },
  {
    label: "Kopivare",
    tekst: "Vi har grund til at tro, at varen er en kopi af et kendt mærke.",
  },
  {
    label: "Kontakt uden om BidHamr",
    tekst: "Auktionen opfordrer til at handle eller betale uden om BidHamr.",
  },
];

// --- Erhverv: noter og afslag på henvendelser (interne) -------------------

export const ERHVERV_NOTE: readonly Skabelon[] = [
  { label: "Ringet op", tekst: "Ringet op og aftalt opstart." },
  { label: "Ingen svar", tekst: "Forsøgt ringet op – ingen svar. Prøver igen." },
  { label: "Mail sendt", tekst: "Sendt mail med pakker og priser." },
];

// --- Påmindelser via staff-chat (vises for brugeren) ----------------------

export const PAAMINDELSE: Record<"ikke_sendt" | "ikke_modtaget" | "afhentning", { emne: string; tekst: string }> = {
  ikke_sendt: {
    emne: "Husk at sende varen",
    tekst:
      "Hej. Køberen har betalt, men varen er ikke markeret som sendt endnu. Send den gerne hurtigst muligt, og markér den som sendt på handlen.",
  },
  ikke_modtaget: {
    emne: "Er pakken kommet frem?",
    tekst:
      "Hej. Pakken er sendt for et stykke tid siden. Er den kommet frem? Markér den gerne som modtaget på handlen, eller skriv til os, hvis noget er galt.",
  },
  afhentning: {
    emne: "Er varen afhentet?",
    tekst:
      "Hej. Fristen for afhentning er overskredet. Har I mødtes? Skriv gerne, hvordan det går, så vi kan hjælpe.",
  },
};

// --- Kontolukning: afslag (intern begrundelse) ----------------------------

export const KONTOLUKNING_AFVIS: readonly Skabelon[] = [
  { label: "Gamle advarsler", tekst: "Advarslerne er gamle, og brugeren har handlet uden problemer siden." },
  { label: "Fejl i advarsel", tekst: "En af advarslerne var givet ved en fejl." },
];

// --- Ubetalte vindere ------------------------------------------------------

// Begrundelse til køberen ved advarsel (vises for køberen).
export const UBETALT_ADVARSEL: readonly Skabelon[] = [
  {
    label: "Betalte ikke",
    tekst: "Du vandt en auktion, men betalte ikke inden for fristen. Bud på BidHamr er bindende.",
  },
  {
    label: "Gentagen",
    tekst: "Du har igen vundet en auktion uden at betale inden for fristen. Bud på BidHamr er bindende.",
  },
];

// Intern begrundelse, når sagen afvises (køberen får ingen advarsel).
export const UBETALT_AFVIS: readonly Skabelon[] = [
  { label: "Teknisk fejl", tekst: "Betalingen fejlede hos betalingsudbyderen – ikke købers skyld." },
  { label: "Aftalt med sælger", tekst: "Køber og sælger har aftalt at annullere handlen." },
  { label: "Særlige forhold", tekst: "Køberen har en god grund og har skrevet til os." },
];
