// Sælgerens konto er frosset (betalingsmodel destination, 20261011020000):
// Stripe godkendte ikke udbetalingskontoen inden for 7 dage efter en
// auktions slutning, og auktionen blev annulleret. Indtil Stripe har godkendt
// kontoen, kan sælgeren ikke sætte varer til salg (BHU02), og der kan ikke
// bydes på sælgerens auktioner (BHU03). Ingen server-only: teksterne bruges
// også i klienten (OpretAuktionForm).

export const SAELGER_FROSSET_TEKST =
  "Din udbetalingskonto er ikke godkendt af vores betalingspartner Stripe. Du kan sætte varer til salg igen, når Stripe har godkendt den – gør opsætningen færdig under Min konto.";

export const BUD_SAELGER_FROSSET_TEKST =
  "Du kan ikke byde på denne auktion lige nu, fordi sælgerens konto venter på godkendelse hos vores betalingspartner Stripe.";

// Fejl fra databasen ved oprettelse af auktion (BHU02).
export function erSaelgerFrossetFejl(kode?: string | null, besked?: string | null): boolean {
  return kode === "BHU02" || (besked ?? "").includes("saelger_frosset: Din");
}

// Fejl fra databasen ved bud (BHU03).
export function erBudSaelgerFrossetFejl(kode?: string | null, besked?: string | null): boolean {
  return kode === "BHU03" || (besked ?? "").includes("saelger_frosset: Sælgerens");
}
