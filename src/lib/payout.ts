// Udbetaling til sælger. I dag databaseført ledger: beløbet registreres som
// "skyldig til sælger" på transaktionen (udbetaling_beløb/udbetalt_kl), og
// pengene bliver stående på platformens Stripe-saldo.
//
// Når Stripe Connect tages i brug: tilføj stripe_account_id på users, og kald
// getStripe().transfers.create({ amount, currency: "dkk", destination })
// herfra — kaldere afhænger kun af denne funktions interface.

export type PayoutInput = {
  id: string;
  beløb: number;
  sælger_gebyr: number;
};

export type PayoutResult = {
  udbetalingBeløb: number;
};

export async function releaseFundsToSeller(
  transaktion: PayoutInput,
): Promise<PayoutResult> {
  const udbetalingBeløb =
    Math.round((transaktion.beløb - transaktion.sælger_gebyr) * 100) / 100;
  return { udbetalingBeløb };
}
