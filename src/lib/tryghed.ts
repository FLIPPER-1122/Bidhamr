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
export type SpamGrund = "link" | "email" | "telefon" | "mobilepay" | "gentaget";

const SPAM_FORKLARING: Record<SpamGrund, string> = {
  link: "Beskeden blev ikke sendt, fordi den indeholder et link. Af hensyn til jeres tryghed må der ikke deles links i chatten.",
  email:
    "Beskeden blev ikke sendt, fordi den indeholder en e-mailadresse. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  telefon:
    "Beskeden blev ikke sendt, fordi den ser ud til at indeholde et telefonnummer. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  mobilepay:
    "Beskeden blev ikke sendt, fordi den indeholder et MobilePay-nummer. Al betaling sker gennem BidHamr, så du er beskyttet.",
  gentaget: "Beskeden blev ikke sendt, fordi du har sendt den samme besked flere gange lige efter hinanden.",
};

// --- Spamfilter (spejl af databasen) -----------------------------------------
// SPEJL af public.besked_normaliser + public.besked_spam_grund i
// supabase/migrations/20261006031000_spamfilter_rettelser.sql. Databasen
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
const P_KONTAKTORD =
  B +
  "(ring|ringe|ringer|tlf|tlfnr|telefon|telefonnummer|telefonnummeret|telefonnr" +
  "|mobil|mobilnummer|mobilnummeret|mobilnr|sms|skriv til|kontakt mig" +
  "|whats\\s*app|signal|nummer|nummeret)" +
  E;
const P_MOBILEPAY = `(mobile\\s*pay|${B}mp${E})`;

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
  telefon: [RE(P_LANDEKODE), RE(P_OTTE), RE(`${P_KONTAKTORD}[^]{0,25}${P_GRUPPERET}`)],
};

// public.besked_normaliser: NFKC, små bogstaver, usynlige tegn fjernet.
function normaliserBesked(tekst: string): string {
  return tekst
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[­​-‏⁠-⁤﻿]/g, "");
}

// Samme svar som public.besked_spam_grund: 'email' | 'link' | 'mobilepay' |
// 'telefon' | null. ('gentaget' afgøres kun i databasen.)
export function spamGrund(tekst: string): Exclude<SpamGrund, "gentaget"> | null {
  const v = normaliserBesked(tekst ?? "");
  if (SPAM_REGLER.email.test(v)) return "email";
  const w = v.replace(SPAM_REGLER.bidhamr, " ").replace(SPAM_REGLER.fragt, " ");
  if (SPAM_REGLER.links.some((r) => r.test(w))) return "link";
  if (SPAM_REGLER.mobilepay.some((r) => r.test(v))) return "mobilepay";
  if (SPAM_REGLER.telefon.some((r) => r.test(v))) return "telefon";
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
