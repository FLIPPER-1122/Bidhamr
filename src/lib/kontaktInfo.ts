// Links, e-mails, telefonnumre, MobilePay-numre og beskedtjenester i
// spørgsmål og svar ("Spørg sælger") blokeres, så handlen ikke flyttes uden
// om BidHamr (og køberen mister sin beskyttelse).
//
// Databasen er autoriteten: public.indeholder_kontaktinfo i
// supabase/migrations/20261006040000_auktionsfunktioner.sql, som bygger på
// chattens spamfilter public.besked_spam_grund (20261006030000). Denne kopi
// efterligner de samme regler, så brugeren får en advarsel, mens hun skriver.
// Ændres reglerne i SQL, så ret dem også her.

function normaliser(tekst: string): string {
  return tekst
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[­​-‏⁠-⁤﻿]/g, "");
}

export function indeholderKontaktinfo(tekst: string | null | undefined): boolean {
  const v = normaliser(tekst ?? "");
  if (!v) return false;

  // E-mail, også "navn (at) mail punktum dk" og "snabel-a".
  if (/[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\bsnabel-?a\b)\s*[a-z0-9-]+(\.|\s+(punktum|dot)\s+)[a-z]{2,}/.test(v)) {
    return true;
  }

  // Links (bidhamr.dk er tilladt).
  const w = v.replace(/(https?:\/\/)?(www\.)?bidhamr\.dk(\/\S*)?/g, " ");
  if (
    /(https?:\/\/|www\.)/.test(w) ||
    /\b[a-z0-9-]{2,}\.(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app)\b/.test(w) ||
    /\b[a-z0-9-]{2,}\s+(punktum|dot)\s+(dk|com|net|org)\b/.test(w)
  ) {
    return true;
  }

  // Tal: mellemrum mellem cifre fjernes ("12 34 56 78" -> "12345678").
  const d = v.replace(/([0-9])\s+(?=[0-9+])/g, "$1").replace(/(\+)\s+(?=[0-9])/g, "$1");
  if (/(mobile\s*pay|\bmp\b)[^0-9]{0,25}[0-9]{4,}/.test(d)) return true;
  if (
    /(^|[^0-9])(\+45|0045)?[2-9][0-9]{7}($|[^0-9])/.test(d) ||
    /(^|[^0-9])[2-9][0-9][-.][0-9]{2}[-.][0-9]{2}[-.][0-9]{2}($|[^0-9])/.test(v)
  ) {
    return true;
  }

  // Andre beskedtjenester.
  return /(whats ?app|telegram|snapchat|messenger|wechat|viber)/.test(v);
}

export const KONTAKTINFO_FEJL =
  "Du må ikke skrive links, e-mails, telefonnumre eller andre måder at kontakte hinanden på. Al kontakt og betaling skal foregå på BidHamr, så I begge er beskyttet.";
