// Grænser (dage) for "handler der hænger" i admin.
//
// Selve udvælgelsen sker i SQL-funktionen admin_haengende_handler()
// (supabase/migrations/20261005031000_admin_forside_rettelser.sql), som både
// admin-forsiden og Hænger-fanen på /admin/handler bruger. Tallene her bruges
// kun til UI-tekster og SKAL holdes ens med intervallerne i SQL-funktionen.
export const HAENGER_GRAENSER_DAGE = {
  // Forsendelse betalt, men ikke sendt – regnet fra betalinger.betalt_kl.
  ikke_sendt: 3,
  // Sendt, men ikke modtaget – regnet fra trades.sendt_kl (ellers betalt_kl).
  ikke_modtaget: 10,
  // Afhentning ikke gennemført – regnet fra betalinger.betalt_kl.
  afhentning: 7,
} as const;

export type HaengerGrund = keyof typeof HAENGER_GRAENSER_DAGE;

export const HAENGER_TEKST: Record<HaengerGrund, string> = {
  ikke_sendt: `Betalt, ikke sendt (> ${HAENGER_GRAENSER_DAGE.ikke_sendt} d)`,
  ikke_modtaget: `Sendt, ikke modtaget (> ${HAENGER_GRAENSER_DAGE.ikke_modtaget} d)`,
  afhentning: `Afhentning ikke gennemført (> ${HAENGER_GRAENSER_DAGE.afhentning} d)`,
};

export function erHaengerGrund(v: unknown): v is HaengerGrund {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(HAENGER_GRAENSER_DAGE, v);
}
