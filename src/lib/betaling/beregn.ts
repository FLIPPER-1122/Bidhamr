// Gebyrer og BidHamr Beskyttelse i øre (heltal). Samme formler som i
// databasen (afslut_udloebne_auktioner / beregn_beskyttelse_oere) - databasen
// er den, der gemmer beløbene; denne fil bruges til at vise og kontrollere.
//
// ROADMAP-BESLUTNINGER afsnit 3 og 4:
//   købergebyr 5%, sælgergebyr 5%, altid.
//   BidHamr Beskyttelse 3% af buddet, min 20 kr / maks 250 kr.

export const KOEBERGEBYR_PROCENT = 5;
export const SAELGERGEBYR_PROCENT = 5;
export const BESKYTTELSE_PROCENT = 3;
export const BESKYTTELSE_MIN_OERE = 2000;
export const BESKYTTELSE_MAKS_OERE = 25000;

// Halv op til nærmeste øre, som Postgres' round() på positive tal.
function procentAf(oere: number, procent: number): number {
  return Math.round((oere * procent) / 100);
}

export function beskyttelseOere(budOere: number): number {
  return Math.min(
    Math.max(procentAf(budOere, BESKYTTELSE_PROCENT), BESKYTTELSE_MIN_OERE),
    BESKYTTELSE_MAKS_OERE,
  );
}

export type BetalingsBeloeb = {
  bud_oere: number;
  koebergebyr_oere: number;
  fragt_oere: number;
};

export function totalOere(b: BetalingsBeloeb, beskyttelse: boolean): number {
  return (
    b.bud_oere +
    b.koebergebyr_oere +
    b.fragt_oere +
    (beskyttelse ? beskyttelseOere(b.bud_oere) : 0)
  );
}
