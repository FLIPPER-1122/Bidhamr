// Tekster om BidHamrs fakturaer (hjemmesiden, mails og appen bør bruge de
// samme). Ingen hemmeligheder - kan bruges i klient-kode.

export const FAKTURA_TEKST = {
  sideTitel: "Fakturaer",
  sideIntro:
    "Fakturaer fra BidHamr på gebyrer, fragt og BidHamr Beskyttelse. Beløbene er inkl. 25 % moms. Selve varen er ikke med – den køber du af sælgeren.",
  tomTitel: "Du har ingen fakturaer endnu",
  tomTekst: "Når du køber eller sælger noget, får du en faktura fra BidHamr på gebyrerne her.",
  fejl: "Dine fakturaer kunne ikke hentes lige nu. Prøv igen om lidt.",
  boksTitel: "Fakturaer fra BidHamr",
  boksIntro: "BidHamrs gebyrer, fragt og BidHamr Beskyttelse inkl. moms.",
  firmaTitel: "Fakturaer på gebyrer",
  firmaIntro:
    "Når I sælger, får I en faktura fra BidHamr på sælgergebyret (5 %) med moms udskilt og jeres CVR-nummer, så I kan trække momsen fra.",
  firmaTom: "Når I sælger noget, kommer fakturaen på sælgergebyret her.",
  paaVej: "Fakturaen er på vej – den er klar om få minutter.",
  hentPdf: "Hent faktura (PDF)",
  hentKreditnotaPdf: "Hent kreditnota (PDF)",
  seHandlen: "Se handlen",
  hermoms: (moms: string) => `heraf moms ${moms}`,
  faktura: (nr: number | null) => (nr ? `Faktura nr. ${nr}` : "Faktura"),
  kreditnota: (nr: number | null, fakturaNr: number | null) =>
    `${nr ? `Kreditnota nr. ${nr}` : "Kreditnota"}${fakturaNr ? ` (for faktura nr. ${fakturaNr})` : ""}`,
  koeb: (titel: string | null) => (titel ? `Dit køb af "${titel}"` : "Dit køb"),
  salg: (titel: string | null) => (titel ? `Dit salg af "${titel}"` : "Dit salg"),
  kreditForklaring: "Pengene er sendt tilbage via vores betalingspartner Stripe.",
  // Mails efter købet/salget.
  mailLinkTekst:
    "Din faktura fra BidHamr på gebyrerne (inkl. moms) kommer under Min konto → Fakturaer få minutter efter betalingen.",
} as const;
