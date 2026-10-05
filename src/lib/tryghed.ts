// Blokering, rapporter af beskeder/brugere, spamfilter og kontaktformular.
// Database: supabase/migrations/20261006030000_tryghed_chat_kontakt.sql.
// Ingen server-only-import: både sider og klientkomponenter bruger teksterne.

// Kategorier, en bruger kan vælge, når en besked eller bruger rapporteres
// (bruger_rapporter.category). 'auto_*' sættes kun af spamfilteret.
export const RAPPORT_KATEGORIER = [
  { vaerdi: "spam", label: "Spam eller reklame" },
  { vaerdi: "chikane", label: "Chikane eller trusler" },
  { vaerdi: "svindel", label: "Mistanke om svindel" },
  { vaerdi: "betaling_udenom", label: "Vil handle eller betale uden om BidHamr" },
  { vaerdi: "stoedende", label: "Stødende indhold" },
  { vaerdi: "andet", label: "Andet" },
] as const;

export type RapportKategori = (typeof RAPPORT_KATEGORIER)[number]["vaerdi"];

const KATEGORI_NAVN: Record<string, string> = {
  ...Object.fromEntries(RAPPORT_KATEGORIER.map((k) => [k.vaerdi, k.label])),
  auto_mistaenkelig: "Spamfilter: mulig handel uden om BidHamr",
  auto_blokeret: "Spamfilter: gentagne stoppede beskeder",
};

export function rapportKategoriNavn(kategori: string): string {
  return KATEGORI_NAVN[kategori] ?? kategori;
}

export function erRapportKategori(v: unknown): v is RapportKategori {
  return typeof v === "string" && RAPPORT_KATEGORIER.some((k) => k.vaerdi === v);
}

// messages.blokeret_grund -> venlig forklaring til afsenderen.
export type SpamGrund = "link" | "email" | "telefon" | "mobilepay" | "socialt_medie" | "gentaget";

const SPAM_FORKLARING: Record<SpamGrund, string> = {
  link: "Beskeden blev ikke sendt, fordi den indeholder et link. Af hensyn til jeres tryghed må der ikke deles links i chatten.",
  email:
    "Beskeden blev ikke sendt, fordi den indeholder en e-mailadresse. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  telefon:
    "Beskeden blev ikke sendt, fordi den ser ud til at indeholde et telefonnummer. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  mobilepay:
    "Beskeden blev ikke sendt, fordi den indeholder et MobilePay-nummer. Al betaling sker gennem BidHamr, så du er beskyttet.",
  socialt_medie:
    "Beskeden blev ikke sendt, fordi den ser ud til at flytte jeres snak til et socialt medie eller en anden app. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  gentaget: "Beskeden blev ikke sendt, fordi du har sendt den samme besked flere gange lige efter hinanden.",
};

// --- Spamfilter (spejl af databasen) -----------------------------------------
// SPEJL af public.besked_normaliser + public.besked_spam_grund i
// supabase/migrations/20261007050000_fase4_testrettelser.sql (testdatabasen:
// rettet igen i 20261007051000_fase4_testrettelser_2.sql). Databasen
// afgør altid (triggeren messages_tryghed); denne kopi kan bruges til at
// advare, før beskeden sendes. Ændres en regel, SKAL begge steder rettes.
// Forskel: Postgres' \m/\M regner æøå som bogstaver; her bruges \p{L}.

const B = "(?<![\\p{L}\\p{N}_])"; // ordstart (\m)
const E = "(?![\\p{L}\\p{N}_])"; // ordslut (\M)

// (a) +45 / 0045 / (+45) + 8 cifre, evt. adskilt af mellemrum, - eller .
const P_LANDEKODE = "(\\(\\s*\\+\\s*45\\s*\\)|\\+\\s*45|(?<![0-9])0045)[\\s.-]{0,2}[0-9]([\\s.-]{0,2}[0-9]){7}(?![0-9])";
// (b) 8 cifre i træk, første 2-9, ikke del af en længere cifferrække.
const P_OTTE = "(?<![0-9])[2-9][0-9]{7}(?![0-9])";
// (c) 2-2-2-2 eller 4-4 – kræver et kontaktord højst 25 tegn før.
const P_GRUPPERET =
  "(?<![0-9])([2-9][0-9][\\s.-][0-9]{2}[\\s.-][0-9]{2}[\\s.-][0-9]{2}|[2-9][0-9]{3}[\\s.-][0-9]{4})(?![0-9])";
// (c') Som (c), men heller ikke ved siden af en anden cifferblok
// ("0730 2533 0012" i et sporingsnummer). Bruges på arbejdskopien.
const P_GRP =
  "(?<![0-9][\\s.,-])(?<![0-9])([2-9][0-9][\\s.-][0-9]{2}[\\s.-][0-9]{2}[\\s.-][0-9]{2}|[2-9][0-9]{3}[\\s.-][0-9]{4})(?![\\s.,-]?[0-9])";
// Kontaktord højst 25 tegn FØR nummeret.
const P_FOER =
  B +
  "(ring|ringe|ringer|tlf|tlfnr|telefon|telefonnummer|telefonnummeret|telefonnr" +
  "|mobil|mobilnummer|mobilnummeret|mobilnr|sms|skriv til|kontakt mig" +
  "|whats\\s*app|signal|nummer|nummeret|nr|hilsen|mvh)" +
  E;
// Kontaktord højst 15 tegn EFTER nummeret.
const P_EFTER = B + "(ring|ringe|ringer|sms|hvis|tlf|telefon|mobil|nr|nummer|nummeret|whats\\s*app|signal)" + E;
const P_MOBILEPAY = `(mobile\\s*pay|${B}mp${E})`;
const P_SOME =
  `(instagram|insta|${B}ig|facebook|${B}fb|messenger|snap\\s*chat|${B}snap|tik\\s*tok|telegram` +
  `|whats\\s*app|${B}signal|wechat|viber|discord)${E}`;
// Som P_SOME, men uden signal: "mit signal er dårligt" er ikke en kontaktvej
// (bruges kun efter min/mit/mine; "på signal" og "signal:" stoppes stadig).
const P_SOME_MIN =
  `(instagram|insta|${B}ig|facebook|${B}fb|messenger|snap\\s*chat|${B}snap|tik\\s*tok|telegram` +
  `|whats\\s*app|wechat|viber|discord)${E}`;
// @brugernavn kræver mindst ét bogstav eller _ ("Pris @1500" er ikke et brugernavn).
const P_AT = "@(?=[a-z0-9_.]*[a-z_])";

// Tal, der ikke er telefonnumre, erstattes med '#' i arbejdskopien.
// Et 8-cifret nummer i 2-2-2-2- eller 4-4-format (ikke del af en længere cifferrække).
const GRP_2222 = String.raw`[2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}(?![\s.,-]?[0-9])`;
const GRP_44 = String.raw`[2-9][0-9]{3}[\s.-][0-9]{4}(?![\s.,-]?[0-9])`;
const NR = String.raw`[\s.:#]*((nr|nummer|nummeret)${E})?[\s.:#]*`;
// Cifre lige efter model, ordre(nr), postnr, sporing, mål m.fl.
const NEUTRAL_ORD = new RegExp(
  B +
    "(model[a-zæøå]*" +
    "|ordre[a-zæøå]*|post\\s*nr|postnummer[a-zæøå]*|sporing[a-zæøå]*|track[a-z]*" +
    "|stregkode|ean|imei|serie\\s*nr|serienummer[a-zæøå]*|vare\\s*nr|varenummer[a-zæøå]*" +
    "|faktura[a-zæøå]*|kunde\\s*nr|kundenummer[a-zæøå]*" +
    "|reg|pakke[a-zæøå]*|mål[a-zæøå]*)" +
    E +
    NR +
    String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
// ref/konto/art: aldrig et nummer i telefonformat (2-2-2-2 eller 4-4).
const NEUTRAL_REF = new RegExp(
  `${B}(ref|reference|konto[a-zæøå]*|art)${E}${NR}(?!${GRP_2222}|${GRP_44})` + String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
// str/størrelse: ikke 2-2-2-2 (størrelseslister fanges af STOERRELSER).
const NEUTRAL_STR = new RegExp(
  `${B}(str|størrelse[a-zæøå]*|skostørrelse[a-zæøå]*|size|sizes)${E}${NR}(?!${GRP_2222})` +
    String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
// kl/klokken: kun et klokkeslæt (18, 18.30, 18:30, 18 30) med intet ciffer efter.
const NEUTRAL_KL = new RegExp(
  `${B}(kl|klokken)${E}` + String.raw`[\s.:]*([01]?[0-9]|2[0-3])([.:\s][0-5][0-9])?(?![\s.:,-]?[0-9])`,
  "gu",
);
// Par/intervaller af klokkeslæt (20.00-22.00, 20.10 21.10) og datoer (24.12-27.12.).
const PAR_SEP = String.raw`(\s*[-–]\s*|\s+(og|til)\s+|\s+)`;
const TID = "([01][0-9]|2[0-3])[.:][0-5][0-9]";
const DATO = String.raw`(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[0-2])\.?`;
const NEUTRAL_TID_DATO = new RegExp(
  `(?<![0-9][.:])(?<![0-9])(${TID}${PAR_SEP}${TID}|${DATO}${PAR_SEP}${DATO})(?![.:]?[0-9])`,
  "gu",
);
const NEUTRAL_AAR = /(?<![0-9])(19|20)[0-9]{2}(\s*[-/]\s*|\s+(og|til)\s+|\s+)(19|20)[0-9]{2}(?![0-9])/gu;
// Beløbspar i hele hundreder: "2500 3000", "1500-2000".
const NEUTRAL_HUNDREDER =
  /(?<![0-9])[1-9][0-9]{1,3}00(\s*[-–/]\s*|\s+(og|til|eller)\s+|\s+)[1-9][0-9]{1,3}00(?![0-9])/gu;
const NEUTRAL_BELOEB = new RegExp(`(?<![0-9])[0-9][0-9 .]*[0-9]\\s*(kr${E}|dkk${E}|kroner${E}|,-|\\.-)`, "gu");
const STOERRELSER = /(?<![0-9])([0-9]{2})[\s.,/-]+([0-9]{2})[\s.,/-]+([0-9]{2})[\s.,/-]+([0-9]{2})(?![0-9])/gu;

// Arbejdskopi: klokkeslæt/datoer, modelnumre, årstal, beløb og
// størrelseslister (fast trin 1 eller 2) -> '#', så de ikke ligner
// telefonnumre. Samme rækkefølge som i SQL.
function neutraliserTal(v: string): string {
  let g = v
    .replace(NEUTRAL_TID_DATO, " # ")
    .replace(NEUTRAL_ORD, " # ")
    .replace(NEUTRAL_REF, " # ")
    .replace(NEUTRAL_STR, " # ")
    .replace(NEUTRAL_KL, " # ")
    .replace(NEUTRAL_AAR, " # ")
    .replace(NEUTRAL_HUNDREDER, " # ")
    .replace(NEUTRAL_BELOEB, " # ");
  for (const m of [...g.matchAll(STOERRELSER)]) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
    const trin = b - a;
    if ((trin === 1 || trin === 2) && c - b === trin && d - c === trin) g = g.split(m[0]).join(" # ");
  }
  return g;
}

const RE = (s: string) => new RegExp(s, "u");

const SPAM_REGLER = {
  email: RE(`[a-z0-9._%+-]+\\s*(@|\\(at\\)|\\[at\\]|${B}snabel-?a${E})\\s*[a-z0-9-]+(\\.|\\s+(punktum|dot)\\s+)[a-z]{2,}`),
  bidhamr: new RegExp(
    "(?<![a-z0-9.@-])(https?://)?(www\\.)?bidhamr\\.dk(/[a-z0-9/_-]*)?(?![a-z0-9@-]|\\.[a-z0-9])",
    "gu",
  ),
  fragt: new RegExp(
    "(?<![a-z0-9.@-])(https?://)?([a-z0-9-]+\\.)*" +
      "(gls\\.dk|gls-group\\.eu|gls-group\\.com|postnord\\.dk|dao\\.as|bring\\.dk" +
      "|ups\\.com|dhl\\.dk|dhl\\.com|shipmondo\\.com)" +
      "(/[a-z0-9/_?=&%#+-]*)?(?![a-z0-9@-]|\\.[a-z0-9])",
    "gu",
  ),
  links: [
    RE("(https?://|www\\.)"),
    RE(`${B}[a-z0-9-]{2,}\\.(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)${E}`),
    RE(`${B}t\\.me${E}`),
    RE(`${B}[a-z0-9-]{2,}\\s+(punktum|dot)\\s+(dk|com|net|org|io|me|eu|se|de|no|nu|co)${E}`),
  ],
  mobilepay: [
    RE(
      P_MOBILEPAY +
        "(\\s*(boks|box))?[\\s:#.]*((nr|nummer|nummeret|på|til)[\\s:#.]*)?" +
        "(?<![0-9])[0-9]{4,5}(?![0-9])(?!\\s*(kr|dkk|,-|\\.-|,[0-9]|\\.[0-9]))",
    ),
    RE(`${P_MOBILEPAY}[^]{0,25}(${P_LANDEKODE}|${P_OTTE}|${P_GRUPPERET})`),
  ],
  telefon: [RE(P_LANDEKODE), RE(P_OTTE)],
  // Køres på arbejdskopien (neutraliserTal).
  telefonGrupperet: [
    RE(`${P_FOER}[^]{0,25}${P_GRP}`),
    RE(`${P_GRP}[^]{0,15}${P_EFTER}`),
    RE(`${P_GRP}[^a-z0-9æøå]*$`),
  ],
  socialt: [
    RE(`${P_SOME}\\s*(:|=)\\s*@?[a-z0-9_.]{3,}`),
    RE(`${P_SOME}[^]{0,15}(?<![a-z0-9._%+-])${P_AT}[a-z0-9_.]{3,}`),
    RE(`${P_SOME}\\s+(er|hedder)\\s+@?(?=[a-z0-9_.]*[_.0-9])[a-z0-9_.]{3,}`),
    RE(`${B}(på|via|over|gennem|i)\\s+((min|mit|mine)\\s+)?${P_SOME}`),
    RE(`${B}(min|mit|mine)\\s+${P_SOME_MIN}`),
    RE(`(^|[^a-z0-9._%+-])${P_AT}[a-z0-9_][a-z0-9_.]{2,}`),
  ],
};

// public.besked_normaliser: NFKC, små bogstaver, usynlige tegn fjernet.
function normaliserBesked(tekst: string): string {
  return tekst
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[­​-‏⁠-⁤﻿]/g, "");
}

// Samme svar som public.besked_spam_grund: 'email' | 'link' | 'mobilepay' |
// 'telefon' | 'socialt_medie' | null. ('gentaget' afgøres kun i databasen.)
export function spamGrund(tekst: string): Exclude<SpamGrund, "gentaget"> | null {
  const v = normaliserBesked(tekst ?? "");
  if (SPAM_REGLER.email.test(v)) return "email";
  const w = v.replace(SPAM_REGLER.bidhamr, " ").replace(SPAM_REGLER.fragt, " ");
  if (SPAM_REGLER.links.some((r) => r.test(w))) return "link";
  if (SPAM_REGLER.mobilepay.some((r) => r.test(v))) return "mobilepay";
  if (SPAM_REGLER.telefon.some((r) => r.test(v))) return "telefon";
  const g = neutraliserTal(v);
  if (SPAM_REGLER.telefonGrupperet.some((r) => r.test(g))) return "telefon";
  if (SPAM_REGLER.socialt.some((r) => r.test(v))) return "socialt_medie";
  return null;
}

export function spamForklaring(grund: string | null | undefined): string {
  return (grund && SPAM_FORKLARING[grund as SpamGrund]) || "Beskeden blev ikke sendt.";
}

const SPAM_NAVN_STAFF: Record<SpamGrund, string> = {
  link: "link",
  email: "e-mail",
  telefon: "telefonnummer",
  mobilepay: "MobilePay-nummer",
  socialt_medie: "socialt medie",
  gentaget: "gentaget besked",
};

export function spamNavnStaff(grund: string): string {
  return SPAM_NAVN_STAFF[grund as SpamGrund] ?? grund;
}

// Kontaktformularen (kontakt_henvendelser.emne). "?emne=fejl" forvælger Teknisk fejl.
export const KONTAKT_EMNER = [
  { vaerdi: "generelt", label: "Generelt" },
  { vaerdi: "handel", label: "Handel" },
  { vaerdi: "betaling", label: "Betaling" },
  { vaerdi: "fejl", label: "Teknisk fejl" },
] as const;

export type KontaktEmne = (typeof KONTAKT_EMNER)[number]["vaerdi"];

export function erKontaktEmne(v: unknown): v is KontaktEmne {
  return typeof v === "string" && KONTAKT_EMNER.some((k) => k.vaerdi === v);
}

export function kontaktEmneNavn(v: string): string {
  return KONTAKT_EMNER.find((k) => k.vaerdi === v)?.label ?? v;
}

export const KONTAKT_BESKED_MIN = 10;
export const KONTAKT_BESKED_MAKS = 4000;
export const RAPPORT_BESKRIVELSE_MAKS = 1000;
