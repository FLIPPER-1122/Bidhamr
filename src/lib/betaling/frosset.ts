// Sælgerens konto er frosset (betalingsmodel destination, 20261011020000):
// Stripe godkendte ikke udbetalingskontoen inden for 7 dage efter en
// auktions slutning, og auktionen blev annulleret. Indtil Stripe har godkendt
// kontoen, kan sælgeren ikke sætte varer til salg (BHU02), og der kan ikke
// bydes på sælgerens auktioner (BHU03). Ingen server-only: teksterne bruges
// også i klienten (OpretAuktionForm).

export const SAELGER_FROSSET_TEKST =
  "Din udbetalingskonto er ikke godkendt af vores betalingspartner Stripe. Du kan sætte varer til salg igen, når Stripe har godkendt den – gør opsætningen færdig under Min konto.";

// Vises kun for en FROSSET sælger - ikke for alle sælgere, Stripe er ved at
// godkende. Normalt kan man godt byde, mens Stripe godkender sælgerens konto
// (har_udbetalingskonto); frysningen sker først, når en auktion er annulleret,
// fordi kontoen ikke blev godkendt i tide.
export const BUD_SAELGER_FROSSET_TITEL = "Der kan ikke bydes lige nu.";
export const BUD_SAELGER_FROSSET_FORKLARING =
  "Sælgeren skal have godkendt sin udbetalingskonto hos Stripe, før der kan bydes på sælgerens auktioner igen.";
export const BUD_SAELGER_FROSSET_NOTE =
  "Det gælder kun denne sælger. Normalt kan du godt byde, mens Stripe godkender en sælgers konto.";

export const BUD_SAELGER_FROSSET_TEKST = `${BUD_SAELGER_FROSSET_TITEL} ${BUD_SAELGER_FROSSET_FORKLARING}`;

// Fejl fra databasen ved oprettelse af auktion (BHU02).
export function erSaelgerFrossetFejl(kode?: string | null, besked?: string | null): boolean {
  return kode === "BHU02" || (besked ?? "").includes("saelger_frosset: Din");
}

// Fejl fra databasen ved bud (BHU03).
export function erBudSaelgerFrossetFejl(kode?: string | null, besked?: string | null): boolean {
  return kode === "BHU03" || (besked ?? "").includes("saelger_frosset: Sælger");
}
