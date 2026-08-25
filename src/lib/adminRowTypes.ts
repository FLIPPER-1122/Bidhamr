// supabase-js' compile-time query-parser kan ikke tokenisere kolonnenavne med
// æ/ø (fx "nuværende_bud", "beløb"), så resultattypen kollapser til ParserError.
// Disse rækketyper bruges med .overrideTypes<..., { merge: false }>() til at
// erklære resultatet eksplicit. Skal holdes i sync med supabase/migrations.

export type AdminAuktionRow = {
  id: string;
  titel: string;
  billeder: string[] | null;
  startpris: number | null;
  nuværende_bud: number | null;
  status: string;
  slutter_kl: string | null;
  oprettet: string;
  bruger_id: string;
  skjult: boolean;
};

export type BrugerAuktionRow = {
  id: string;
  titel: string;
  status: string;
  oprettet: string;
  nuværende_bud: number | null;
};

export type TransaktionRow = {
  id: string;
  auktion_id: string;
  køber_id: string;
  sælger_id: string;
  beløb: number | null;
  gebyr: number | null;
  status: string;
  oprettet: string;
};

export type TransaktionBeløbRow = {
  beløb: number | null;
  gebyr: number | null;
};
