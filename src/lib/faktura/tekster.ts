// Tekster om BidHamrs fakturaer (hjemmesiden, mails og appen bør bruge de
// samme). Ingen hemmeligheder - kan bruges i klient-kode.

export const FAKTURA_TEKST = {
  sideTitel: "Fakturaer",
  sideIntro:
    "Her finder du dine fakturaer fra BidHamr. Som køber får du en faktura på købergebyr, fragt og eventuel BidHamr Beskyttelse. Som sælger får du en faktura på sælgergebyret. Beløbene er inkl. moms. Selve varen er ikke med, fordi den handles direkte mellem køber og sælger.",
  tomTitel: "Du har ingen fakturaer endnu",
  tomTekst: "Når du køber eller sælger noget, kommer fakturaen på BidHamrs gebyrer her.",
  fejl: "Dine fakturaer kunne ikke hentes lige nu. Prøv igen om lidt.",
  boksTitel: "Fakturaer fra BidHamr",
  boksIntro: "Fakturaen dækker BidHamrs gebyrer, fragt og eventuel BidHamr Beskyttelse – ikke selve varen. Beløbene er inkl. moms.",
  firmaTitel: "Fakturaer på gebyrer",
  firmaIntro:
    "Når I sælger, får I en faktura fra BidHamr på sælgergebyret (5 %) med momsen vist for sig og jeres CVR-nummer. Fakturaen på selve varen sender I selv til køberen.",
  firmaTom: "Når I sælger noget, kommer fakturaen på sælgergebyret her.",
  paaVej: "Fakturaen er på vej. Den er normalt klar om få minutter.",
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
