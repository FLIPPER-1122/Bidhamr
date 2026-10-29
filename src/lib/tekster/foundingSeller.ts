// Seller founder (Filip, 29. okt. 2026 - ROADMAP-BESLUTNINGER "Seller
// founder"). Mærket på profil, auktionskort og auktionsside, og teksten ved
// gebyret.
export const FOUNDING_SELLER = {
  maerke: "Founding seller",
  maerkeForklaring: "Founding seller hos BidHamr",
  // Under gebyret før buddet, i tilbud til næste byder og i checkout.
  gebyrNote: (rabatPct: number) =>
    rabatPct >= 100
      ? "Sælgeren er Founding seller hos BidHamr: 0 kr. i gebyr."
      : "Sælgeren er Founding seller hos BidHamr: halvt gebyr.",
} as const;
