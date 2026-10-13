// Gruppering af drift-fejl på /admin/drift (hentFejlGrupper i driftData.ts).
//
// Mange fejl er ens bortset fra et id ("Refusion re_... på ch_123 er ikke
// registreret ..."). Uden normalisering fik hver besked sin egen gruppe (fx
// "139 registreringer i 139 grupper"). Her erstattes Stripe-id'er og uuid'er
// med en pladsholder, så ens fejl samles i én gruppe med antal og nogle
// eksempel-id'er.
//
// Kun visningen grupperer sådan. drift_fejl gemmer stadig den fulde besked
// (med id'erne), og alarmPrTilfaelde bruger stadig én nøgle pr. tilfælde
// (én alarm pr. betaling/refusion er meningen).
//
// Ren funktion - ingen database (testes i tests/penge-db).

// Stripe-præfikser (charge, PaymentIntent, refusion, payout, transfer,
// application fee, indsigelse (dp_/du_), Connect-konto, kunde, faktura, event,
// betaling på Connect-konto, betalingsmetode, SetupIntent, balance-
// transaktion, gebyr-refusion, transfer reversal, payment refund, abonnement).
const STRIPE_PRAEFIKSER = [
  "ch", "pi", "re", "po", "tr", "fee", "dp", "du", "acct", "cus", "in", "evt",
  "py", "pm", "seti", "txn", "fr", "trr", "pyr", "sub",
];

// Et Stripe-id: præfiks + "_" + mindst 8 tegn [A-Za-z0-9], hvoraf mindst ét er
// et ciffer (så almindelige ord som "in_progress" ikke rammes).
const STRIPE_ID = new RegExp(
  `\\b(${STRIPE_PRAEFIKSER.join("|")})_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{8,}\\b`,
  "g",
);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export const MAKS_EKSEMPLER = 5;

// Beskeden med id'er erstattet af pladsholdere ("ch_…", "<uuid>") og de id'er,
// der blev erstattet (i rækkefølge, uden dubletter).
export function normaliserFejlbesked(besked: string): { tekst: string; ids: string[] } {
  const ids: string[] = [];
  const husk = (x: string) => {
    if (!ids.includes(x)) ids.push(x);
  };
  const tekst = besked
    .replace(STRIPE_ID, (hel: string, praefiks: string) => {
      husk(hel);
      return `${praefiks}_…`;
    })
    .replace(UUID, (hel: string) => {
      husk(hel.toLowerCase());
      return "<uuid>";
    });
  return { tekst, ids };
}

// Grupperingsnøglen for en drift-fejl: kilde + normaliseret besked.
export function fejlGruppeNoegle(kilde: string, besked: string): string {
  return `${kilde}\u0000${normaliserFejlbesked(besked).tekst}`;
}

// Tilføjer id'er til en eksempelliste (højst MAKS_EKSEMPLER).
export function tilfoejEksempler(eksempler: string[], ids: string[]): void {
  for (const x of ids) {
    if (eksempler.length >= MAKS_EKSEMPLER) return;
    if (!eksempler.includes(x)) eksempler.push(x);
  }
}
