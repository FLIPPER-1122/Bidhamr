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
