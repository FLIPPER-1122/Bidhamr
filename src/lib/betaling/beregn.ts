// Gebyrer, fragt og BidHamr Beskyttelse i øre (heltal). Samme formler som i
// databasen (afslut_udloebne_auktioner / beregn_beskyttelse_oere) - databasen
// er den, der gemmer beløbene; denne fil bruges til at vise og kontrollere.
//
// ROADMAP-BESLUTNINGER afsnit 3 og 4:
//   købergebyr 5%, sælgergebyr 5%, altid.
//   BidHamr Beskyttelse 5% af buddet, min 25 kr / maks 250 kr. Vælges, når
//   man byder, og kan ikke ændres bagefter.
//   Fragt (Filip 9. okt. 2026): pris efter pakkestørrelse og leveringsmåde i
//   tabellen fragt_pakkestoerrelser (ét sted). Prisen låses på auktionen
//   (auctions.fragt_pakkeshop_oere / fragt_doer_oere), og betalingens
//   fragt_oere sættes af databasen ud fra købers leveringsvalg i checkout.
//   Kun afhentning = 0 kr.
//   Udbetaling til sælger = bud - sælgergebyr. Fragten bliver på BidHamrs
//   platformskonto og går videre til fragtfirmaet.

export const KOEBERGEBYR_PROCENT = 5;
export const SAELGERGEBYR_PROCENT = 5;
export const BESKYTTELSE_PROCENT = 5;
export const BESKYTTELSE_MIN_OERE = 2500;
export const BESKYTTELSE_MAKS_OERE = 25000;
// Den gamle faste fragt. Bruges kun til visning på auktioner uden låst pris
// (oprettet før 20261012010000 - databasen gav dem samme 35 kr.).
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

// Fragten køberen ser før buddet: auktionens låste pakkeshop-pris (billigste
// leveringsmåde). Visning - beløbet i betalingen sætter databasen.
export function fragtOere(forsendelseMulig: boolean, pakkeshopOere?: number | null): number {
  if (!forsendelseMulig) return 0;
  return typeof pakkeshopOere === "number" && pakkeshopOere > 0 ? pakkeshopOere : FRAGT_OERE;
}

export function udbetalingOere(budOere: number): number {
  return budOere - procentAf(budOere, SAELGERGEBYR_PROCENT);
}

export type BetalingsBeloeb = {
  bud_oere: number;
  koebergebyr_oere: number;
  fragt_oere: number;
};

// Betalingsmodel destination: BidHamrs application fee på PaymentIntenten =
// købergebyr + sælgergebyr + fragt + BidHamr Beskyttelse (alle inkl. moms).
// Sælgeren står tilbage med total - fee = bud - sælgergebyr = udbetaling_oere
// (CHECK betalinger_destination_gebyr_stemmer i databasen).
export function applicationFeeOere(b: {
  koebergebyr_oere: number;
  saelgergebyr_oere: number;
  fragt_oere: number;
  beskyttelse_oere: number;
}): number {
  return (
    Number(b.koebergebyr_oere) +
    Number(b.saelgergebyr_oere) +
    Number(b.fragt_oere) +
    Number(b.beskyttelse_oere)
  );
}

export function totalOere(b: BetalingsBeloeb, beskyttelse: boolean): number {
  return (
    Number(b.bud_oere) +
    Number(b.koebergebyr_oere) +
    Number(b.fragt_oere) +
    (beskyttelse ? beskyttelseOere(Number(b.bud_oere)) : 0)
  );
}
