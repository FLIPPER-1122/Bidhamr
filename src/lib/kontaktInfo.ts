// Links, e-mails, telefonnumre, MobilePay-numre og beskedtjenester i
// spørgsmål og svar ("Spørg sælger") blokeres, så handlen ikke flyttes uden
// om BidHamr (og køberen mister sin beskyttelse).
//
// Databasen er autoriteten: public.indeholder_kontaktinfo i
// supabase/migrations/20261006040000_auktionsfunktioner.sql, som bygger på
// chattens spamfilter public.besked_spam_grund (seneste: 20261007050000_fase4_testrettelser.sql,
// før: 20261006031000). Denne kopi bruger TS-spejlet
// spamGrund() i src/lib/tryghed.ts, så brugeren får en advarsel, mens hun
// skriver. Ændres reglerne i SQL, så ret dem også i tryghed.ts.

import { spamGrund } from "@/lib/tryghed";

export function indeholderKontaktinfo(tekst: string | null | undefined): boolean {
  const t = tekst ?? "";
  if (!t) return false;
  if (spamGrund(t) !== null) return true;

  // Andre beskedtjenester (som public.indeholder_kontaktinfo).
  const v = t.normalize("NFKC").toLowerCase().replace(/[­​-‏⁠-⁤﻿]/g, "");
  return /(whats ?app|telegram|snapchat|messenger|wechat|viber)/.test(v);
}

export const KONTAKTINFO_FEJL =
  "Du må ikke skrive links, e-mails, telefonnumre eller andre måder at kontakte hinanden på. Al kontakt og betaling skal foregå på BidHamr, så I begge er beskyttet.";
