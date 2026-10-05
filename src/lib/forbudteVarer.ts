// Forbudte varer på BidHamr. Bruges af siden /forbudte-varer, opret- og
// redigeringsformularen (advarsel i browseren) og som reference for appen.
//
// HOLD SYNKRON med databasen (supabase/migrations/20261006040000_auktionsfunktioner.sql):
//   FORBUDTE_KATEGORIER  <-> public.forbudte_varer()
//   FORBUDTE_ORD         <-> public.forbudte_ord()
//   normaliserTekst      <-> public.forbudt_normaliser()
//   tjekForbudtTekst     <-> public.forbudt_tekst_tjek()
// Databasen er autoriteten: den afviser "blokeret" ved oprettelse/redigering
// (fejlkode BHF01 / kode 'forbudt_vare') og opretter en automatisk rapport
// til staff (reports.category = 'forbudt_vare') ved "tvivl".
//
// Mønstrene er bevidst skrevet i en lille fælles regex-delmængde, som både
// JavaScript og Postgres forstår ens: bogstaver, mellemrum, [..], ?, (a|b).
// Ingen \b, \w, lookahead eller (?:..). De matches mod den normaliserede
// tekst (små bogstaver, - _ . / bliver til mellemrum) og kun som hele ord.

export type ForbudtKategori =
  | "vaaben"
  | "narkotika"
  | "medicin"
  | "levende_dyr"
  | "forfalskninger"
  | "tobak_alkohol"
  | "stjaalne"
  | "voksenindhold"
  | "kemikalier"
  | "persondata"
  | "billetter";

export const FORBUDTE_KATEGORIER: readonly {
  kode: ForbudtKategori;
  navn: string;
  beskrivelse: string;
}[] = [
  {
    kode: "vaaben",
    navn: "Våben og ammunition",
    beskrivelse:
      "Skydevåben, dele til skydevåben, ammunition og krudt, springknive, butterflyknive, knojern, peberspray, strømpistoler og andre våben, der kræver tilladelse eller er forbudte i Danmark.",
  },
  {
    kode: "narkotika",
    navn: "Narkotika",
    beskrivelse:
      "Euforiserende stoffer af enhver art – også udstyr, frø og planter, der er beregnet til at fremstille eller bruge dem.",
  },
  {
    kode: "medicin",
    navn: "Medicin og doping",
    beskrivelse:
      "Receptpligtig medicin, håndkøbsmedicin, doping og anabolske steroider. Medicin må kun sælges af apoteker og godkendte forhandlere.",
  },
  {
    kode: "levende_dyr",
    navn: "Levende dyr",
    beskrivelse: "Alle levende dyr, fx hvalpe, killinger, kaniner, fugle, fisk og krybdyr.",
  },
  {
    kode: "forfalskninger",
    navn: "Forfalskninger og kopivarer",
    beskrivelse:
      "Kopier af mærkevarer, falske dokumenter, pas, ID-kort, kørekort, pengesedler og andet, der udgiver sig for at være ægte.",
  },
  {
    kode: "tobak_alkohol",
    navn: "Tobak og alkohol",
    beskrivelse:
      "Snus (forbudt at sælge i Danmark). Tobak, e-cigaretter og alkohol må aldrig sælges til personer under 18 år.",
  },
  {
    kode: "stjaalne",
    navn: "Stjålne varer",
    beskrivelse: "Stjålne varer og hælervarer – også varer, du har mistanke om er stjålet.",
  },
  {
    kode: "voksenindhold",
    navn: "Voksenindhold",
    beskrivelse: "Pornografi og andet seksuelt indhold, herunder brugt undertøj solgt som voksenindhold.",
  },
  {
    kode: "kemikalier",
    navn: "Farlige kemikalier og sprængstoffer",
    beskrivelse:
      "Sprængstoffer, fyrværkeri, giftige og ætsende kemikalier, kviksølv og asbest.",
  },
  {
    kode: "persondata",
    navn: "Personlige data og konti",
    beskrivelse:
      "CPR-numre, kortoplysninger, kundelister, MitID/NemID og login til brugerkonti – dine egne eller andres.",
  },
  {
    kode: "billetter",
    navn: "Billetter med videresalgsforbud",
    beskrivelse:
      "Billetter, som arrangøren ikke tillader videresalg af, og billetter solgt til mere end den oprindelige pris (billetloven).",
  },
] as const;

export type ForbudtNiveau = "blokeret" | "tvivl";

// blokeret: åbenlyst forbudt - auktionen kan ikke oprettes med ordet.
// tvivl:    kan være lovligt (fx "pistol" om en vandpistol). Auktionen
//           oprettes, og staff får en automatisk rapport.
export const FORBUDTE_ORD: readonly {
  kategori: ForbudtKategori;
  niveau: ForbudtNiveau;
  moenster: string;
}[] = [
  // Våben
  { kategori: "vaaben", niveau: "blokeret", moenster: "skydev[aå]ben" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "skarpe patroner" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "springkniv(e|en|ene)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "faldkniv(e|en|ene)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "butterflykniv(e|en|ene)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "knojern" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "peberspray" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "str[oø]mpistol(er|en)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "elpistol(er|en)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "taser(e|en)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "h[aå]ndgranat(er)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "haglgev[aæ]r(et)?" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "jagtriffel" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "pistol(er|en)?" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "revolver(e|en)?" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "(riffel|rifler)" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "gev[aæ]r(et)?" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "ammunition" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "krudt" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "armbr[oø]st" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "kastekniv(e)?" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "machete" },

  // Narkotika
  { kategori: "narkotika", niveau: "blokeret", moenster: "kokain" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "heroin" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "(met)?amfetamin" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "crystal meth" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "mdma" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "lsd" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "fentanyl" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "ghb" },
  { kategori: "narkotika", niveau: "blokeret", moenster: "psilocybin" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "hash" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "skunk" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "cannabis" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "thc" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "ecstasy" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "ketamin" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "joints?" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "growbox" },
  { kategori: "narkotika", niveau: "tvivl", moenster: "bongs?" },

  // Medicin og doping
  { kategori: "medicin", niveau: "blokeret", moenster: "receptpligtig(e)?" },
  { kategori: "medicin", niveau: "blokeret", moenster: "viagra" },
  { kategori: "medicin", niveau: "blokeret", moenster: "cialis" },
  { kategori: "medicin", niveau: "blokeret", moenster: "oxycodon" },
  { kategori: "medicin", niveau: "blokeret", moenster: "oxycontin" },
  { kategori: "medicin", niveau: "blokeret", moenster: "tramadol" },
  { kategori: "medicin", niveau: "blokeret", moenster: "morfin" },
  { kategori: "medicin", niveau: "blokeret", moenster: "stesolid" },
  { kategori: "medicin", niveau: "blokeret", moenster: "rivotril" },
  { kategori: "medicin", niveau: "blokeret", moenster: "xanax" },
  { kategori: "medicin", niveau: "blokeret", moenster: "ozempic" },
  { kategori: "medicin", niveau: "blokeret", moenster: "wegovy" },
  { kategori: "medicin", niveau: "blokeret", moenster: "(anabolske )?steroider" },
  { kategori: "medicin", niveau: "blokeret", moenster: "testosteron" },
  { kategori: "medicin", niveau: "tvivl", moenster: "medicin" },
  { kategori: "medicin", niveau: "tvivl", moenster: "piller" },
  { kategori: "medicin", niveau: "tvivl", moenster: "sovepiller" },
  { kategori: "medicin", niveau: "tvivl", moenster: "kosttilskud" },

  // Levende dyr
  { kategori: "levende_dyr", niveau: "blokeret", moenster: "levende dyr" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "hvalp(e|en|ene)?" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "(katte)?killing(er|en|erne)?" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "kanin(er|en|erne)?" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "marsvin" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "undulat(er)?" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "hamster(e|en)?" },

  // Forfalskninger
  { kategori: "forfalskninger", niveau: "blokeret", moenster: "kopivare(r)?" },
  { kategori: "forfalskninger", niveau: "blokeret", moenster: "falske? (pas|id|k[oø]rekort|sedler|penge|dokumenter)" },
  { kategori: "forfalskninger", niveau: "tvivl", moenster: "replika" },
  { kategori: "forfalskninger", niveau: "tvivl", moenster: "replica" },
  { kategori: "forfalskninger", niveau: "tvivl", moenster: "fake" },
  { kategori: "forfalskninger", niveau: "tvivl", moenster: "kopi af" },

  // Tobak og alkohol
  { kategori: "tobak_alkohol", niveau: "blokeret", moenster: "snus" },
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "(e )?cigaret(ter)?" },
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "vapes?" },
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "tobak" },
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "spiritus" },
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "vodka" },
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "alkohol" },

  // Stjålne varer
  { kategori: "stjaalne", niveau: "blokeret", moenster: "h[aæ]lervare(r)?" },
  { kategori: "stjaalne", niveau: "blokeret", moenster: "tyvekoster" },
  { kategori: "stjaalne", niveau: "tvivl", moenster: "stj[aå]l(et|ne)" },

  // Voksenindhold
  { kategori: "voksenindhold", niveau: "blokeret", moenster: "porno(film|grafi)?" },
  { kategori: "voksenindhold", niveau: "blokeret", moenster: "b[oø]rneporno" },
  { kategori: "voksenindhold", niveau: "blokeret", moenster: "onlyfans" },
  { kategori: "voksenindhold", niveau: "tvivl", moenster: "dildo(er)?" },
  { kategori: "voksenindhold", niveau: "tvivl", moenster: "sexleget[oø]j" },
  { kategori: "voksenindhold", niveau: "tvivl", moenster: "brugte trusser" },

  // Farlige kemikalier og sprængstoffer
  { kategori: "kemikalier", niveau: "blokeret", moenster: "spr[aæ]ngstof(fer)?" },
  { kategori: "kemikalier", niveau: "blokeret", moenster: "dynamit" },
  { kategori: "kemikalier", niveau: "blokeret", moenster: "nitroglycerin" },
  { kategori: "kemikalier", niveau: "blokeret", moenster: "cyanid" },
  { kategori: "kemikalier", niveau: "blokeret", moenster: "flussyre" },
  { kategori: "kemikalier", niveau: "blokeret", moenster: "asbest" },
  { kategori: "kemikalier", niveau: "tvivl", moenster: "fyrv[aæ]rkeri" },
  { kategori: "kemikalier", niveau: "tvivl", moenster: "kanonslag" },
  { kategori: "kemikalier", niveau: "tvivl", moenster: "kviks[oø]lv" },
  { kategori: "kemikalier", niveau: "tvivl", moenster: "pesticid(er)?" },

  // Personlige data og konti
  { kategori: "persondata", niveau: "blokeret", moenster: "cpr ?(num(mer|re)|nr)" },
  { kategori: "persondata", niveau: "blokeret", moenster: "personnum(mer|re)" },
  { kategori: "persondata", niveau: "blokeret", moenster: "(kreditkort|kort)oplysninger" },
  { kategori: "persondata", niveau: "blokeret", moenster: "kortdata" },
  { kategori: "persondata", niveau: "blokeret", moenster: "(nemid|mitid)" },
  { kategori: "persondata", niveau: "blokeret", moenster: "kunde(database|kartotek)" },
  { kategori: "persondata", niveau: "blokeret", moenster: "e ?mail ?liste" },
  { kategori: "persondata", niveau: "tvivl", moenster: "konto til salg" },
  { kategori: "persondata", niveau: "tvivl", moenster: "(netflix|spotify|steam|bruger) ?konto" },
  { kategori: "persondata", niveau: "tvivl", moenster: "login" },

  // Billetter
  { kategori: "billetter", niveau: "tvivl", moenster: "billet(ter|ten|terne)?" },
  { kategori: "billetter", niveau: "tvivl", moenster: "(koncert|festival|fodbold)billet(ter)?" },
] as const;

// Små bogstaver, NFC, og - _ . / samt gentagne mellemrum bliver til ét
// mellemrum. Samme regel som public.forbudt_normaliser.
export function normaliserTekst(tekst: string | null | undefined): string {
  return (tekst ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[-_./]+/g, " ")
    .replace(/\s+/g, " ");
}

// Hele ord: ingen bogstaver/tal lige før eller efter.
const GRAENSE = "[^a-z0-9æøåäöüé]";

const KOMPILEREDE = FORBUDTE_ORD.map((o) => ({
  ...o,
  re: new RegExp(`(^|${GRAENSE})(${o.moenster})($|${GRAENSE})`, "u"),
}));

export type ForbudtResultat =
  | { resultat: "ok" }
  | { resultat: "blokeret" | "tvivl"; kategori: ForbudtKategori; ord: string };

// Blokerede ord vinder over tvivl. Samme logik som public.forbudt_tekst_tjek.
export function tjekForbudtTekst(...tekster: (string | null | undefined)[]): ForbudtResultat {
  const norm = normaliserTekst(tekster.filter(Boolean).join(" \n "));
  let tvivl: ForbudtResultat | null = null;
  for (const o of KOMPILEREDE) {
    const m = norm.match(o.re);
    if (!m) continue;
    if (o.niveau === "blokeret") return { resultat: "blokeret", kategori: o.kategori, ord: m[2] };
    tvivl ??= { resultat: "tvivl", kategori: o.kategori, ord: m[2] };
  }
  return tvivl ?? { resultat: "ok" };
}

export function forbudtKategoriNavn(kode: string): string {
  return FORBUDTE_KATEGORIER.find((k) => k.kode === kode)?.navn ?? "forbudte varer";
}

// Brugerbesked, når et ord blokerer oprettelsen.
export function forbudtBesked(ord: string, kategori: string): string {
  return `Ordet "${ord}" hører under ${forbudtKategoriNavn(kategori).toLowerCase()}, som ikke må sælges på BidHamr. Ret titlen eller beskrivelsen – se listen over forbudte varer.`;
}
