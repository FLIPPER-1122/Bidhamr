// Gebyrer, fragt og BidHamr Beskyttelse i øre (heltal). Samme formler som i
// databasen (afslut_udloebne_auktioner / beregn_beskyttelse_oere) - databasen
// er den, der gemmer beløbene; denne fil bruges til at vise og kontrollere.
//
// ROADMAP-BESLUTNINGER afsnit 3 og 4:
//   købergebyr 5%, sælgergebyr 5%, altid.
//   BidHamr Beskyttelse 5% af buddet, min 25 kr / maks 250 kr. Vælges, når
//   man byder, og kan ikke ændres bagefter.
//   Fragt: fast 35 kr pr. handel, betalt af køber, når auktionen tilbyder
//   forsendelse. Kun afhentning = 0 kr.
//   Udbetaling til sælger = bud - sælgergebyr. Fragten bliver på BidHamrs
//   platformskonto og går videre til fragtfirmaet.

export const KOEBERGEBYR_PROCENT = 5;
export const SAELGERGEBYR_PROCENT = 5;
export const BESKYTTELSE_PROCENT = 5;
export const BESKYTTELSE_MIN_OERE = 2500;
export const BESKYTTELSE_MAKS_OERE = 25000;
export const FRAGT_OERE = 3500;

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

export function fragtOere(forsendelseMulig: boolean): number {
  return forsendelseMulig ? FRAGT_OERE : 0;
}

export function udbetalingOere(budOere: number): number {
  return budOere - procentAf(budOere, SAELGERGEBYR_PROCENT);
}

export type BetalingsBeloeb = {
  bud_oere: number;
  koebergebyr_oere: number;
  fragt_oere: number;
};

export function totalOere(b: BetalingsBeloeb, beskyttelse: boolean): number {
  return (
    Number(b.bud_oere) +
    Number(b.koebergebyr_oere) +
    Number(b.fragt_oere) +
    (beskyttelse ? beskyttelseOere(Number(b.bud_oere)) : 0)
  );
}
