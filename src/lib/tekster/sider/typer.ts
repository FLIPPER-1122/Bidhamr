// Fælles struktur for rene tekstsider (Sådan virker det, FAQ, Pakkeguide, Om,
// Cookies, Tilgængelighed). Vises af src/components/Tekstside.tsx.
// Al tekst skrives af indhold-agenten og bygger på ROADMAP-BESLUTNINGER.md.

export type Trin = {
  titel: string;
  tekst: string;
};

export type Link = {
  tekst: string;
  href: string;
};

// Tabel, fx over cookies. Første kolonne er rækkens navn. På mobil vises
// hver række som et kort, så tabellen ikke giver vandret scroll.
export type Tabel = {
  // Læses op af skærmlæsere som tabellens titel.
  titel: string;
  kolonner: string[];
  raekker: string[][];
};

export type Afsnit = {
  // Bruges som anker (#id) og som React-key. Kun a-z, 0-9 og bindestreg.
  id: string;
  overskrift: string;
  // Ét afsnit pr. element.
  tekst?: string[];
  // Nummereret liste (trin for trin).
  trin?: Trin[];
  // Punktliste.
  punkter?: string[];
  // Lille note under afsnittet, fx "Gælder indtil videre".
  note?: string;
  links?: Link[];
  tabel?: Tabel;
};

export type FaqPunkt = {
  spoergsmaal: string;
  svar: string;
};

export type FaqGruppe = {
  id: string;
  overskrift: string;
  punkter: FaqPunkt[];
};

export type Tekstside = {
  titel: string;
  metabeskrivelse: string;
  intro: string;
  // Vises som "Senest opdateret <dato>" under titlen, hvis sat.
  senestOpdateret?: string;
  afsnit: Afsnit[];
  faq?: FaqGruppe[];
};
