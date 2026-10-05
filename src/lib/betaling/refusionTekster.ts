// Beskeder til staff, når refunderBetaling ikke har sendt en ny
// tilbagebetaling afsted (svarene "refusion_konflikt" og "refusion_i_gang").
// Ingen beløb - teksterne vises for medarbejdere.

export const REFUSION_KONFLIKT =
  "Der findes allerede en anden tilbagebetaling hos Stripe for denne betaling. Tjek den i Stripe, før du gør mere.";

export const REFUSION_I_GANG =
  "En tilbagebetaling er allerede i gang. Prøv igen om et par minutter.";
