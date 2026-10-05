// Links, e-mails, telefonnumre og "skriv til mig på ..." i spørgsmål og svar
// blokeres, så handlen ikke flyttes uden om BidHamr (og køberen mister sin
// beskyttelse).
//
// HOLD SYNKRON med public.indeholder_kontaktinfo() i
// supabase/migrations/20261006020000_auktionsfunktioner.sql. Databasen er
// autoriteten (stil_spoergsmaal / besvar_spoergsmaal giver kode
// 'kontaktinfo'); denne kopi giver kun en advarsel, mens man skriver.
//
// Samme fælles regex-delmængde som forbudteVarer.ts. Teksten matches med små
// bogstaver.
export const KONTAKT_MOENSTRE: readonly string[] = [
  // Links
  String.raw`https?:`,
  String.raw`www\.`,
  String.raw`[a-z0-9-]+\.(dk|com|net|org|se|no|de|eu|io|info|me|app|shop|nu|biz|co|ly)([^a-z0-9]|$)`,
  String.raw`(punktum|dot) (dk|com|net|org)`,
  // E-mail
  String.raw`[a-z0-9._%+-]+@[a-z0-9-]+`,
  String.raw`snabel[ -]?a`,
  // Telefonnumre: mindst 8 cifre, evt. adskilt af mellemrum, punktum eller bindestreg
  String.raw`[0-9]([ .()-]*[0-9]){7,}`,
  String.raw`\+ ?45`,
  // Andre beskedtjenester
  String.raw`(whatsapp|telegram|snapchat|messenger|wechat|viber)`,
];

const KOMPILEREDE = KONTAKT_MOENSTRE.map((m) => new RegExp(m, "u"));

export function indeholderKontaktinfo(tekst: string | null | undefined): boolean {
  const t = (tekst ?? "").normalize("NFC").toLowerCase();
  return KOMPILEREDE.some((re) => re.test(t));
}

export const KONTAKTINFO_FEJL =
  "Du må ikke skrive links, e-mails, telefonnumre eller andre måder at kontakte hinanden på. Al kontakt og betaling skal foregå på BidHamr, så I begge er beskyttet.";
