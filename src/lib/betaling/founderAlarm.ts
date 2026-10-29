import "server-only";

// Mistanke om falske handler hos seller founders (Filip, 29. okt. 2026 -
// ROADMAP-BESLUTNINGER "Founderens gratis handler"): samme køber har mindst 3
// betalte handler med founder-rabat hos samme founder inden for 30 dage.
// Databasen finder og gemmer parrene atomisk - højst én gang pr. par pr. 30
// dage (seller_founder_alarm_tjek, 20261102460000) - og her gives én drift-
// alarm pr. nyt par. Alarmen står også på founderens admin-side
// (SellerFounderKort) og på listen /admin/brugere/founders.
//
// Kører i betalingsovervågningen (højst én gang i timen). Kaster ved fejl i
// databasekaldet (overvågningen logger det som et fejlet tjek).

import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";

export const FOUNDER_ALARM_HVOR = "founder/falske-handler";

type NyAlarm = { founder_id: string; koeber_id: string; handler: number };

// Fejlteksten: ingen navne eller e-mails - kun founderens id (til linket) og antal.
export function founderAlarmTekst(a: NyAlarm): string {
  return (
    `Mulige falske handler: samme køber har ${a.handler} betalte handler med founder-rabat hos seller founder ` +
    `${a.founder_id} inden for 30 dage. Se founderens side under Admin -> Brugere -> Seller founders.`
  );
}

export async function tjekFounderAlarmer(): Promise<number> {
  const { data, error } = await createAdminClient().rpc("seller_founder_alarm_tjek");
  if (error) {
    // Migrationen er ikke kørt endnu: intet at tjekke.
    if (/seller_founder_alarm_tjek/.test(error.message) && /does not exist|Could not find/i.test(error.message)) return 0;
    throw new Error(`seller_founder_alarm_tjek: ${error.message}`);
  }
  const nye = (Array.isArray(data) ? data : []) as NyAlarm[];
  for (const a of nye) {
    await logDriftFejl({ kilde: "server", hvor: FOUNDER_ALARM_HVOR, fejl: founderAlarmTekst(a), brugerId: a.founder_id });
  }
  return nye.length;
}
