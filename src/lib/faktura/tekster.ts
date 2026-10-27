// Tekster om BidHamrs fakturaer (hjemmesiden, mails og appen bør bruge de
// samme). Ingen hemmeligheder - kan bruges i klient-kode.

export const FAKTURA_TEKST = {
  sideTitel: "Fakturaer",
  sideIntro:
    "Her finder du dine fakturaer fra BidHamr. Som køber får du en faktura på gebyret (med BidHamr Beskyttelse, når varen sendes) og fragten. Som sælger får du en faktura på sælgergebyret. Beløbene er inkl. moms. Selve varen er ikke med, fordi den handles direkte mellem køber og sælger.",
  tomTitel: "Du har ingen fakturaer endnu",
  tomTekst: "Når du køber eller sælger noget, kommer fakturaen på BidHamrs gebyrer her.",
  fejl: "Dine fakturaer kunne ikke hentes lige nu. Prøv igen om lidt.",
  boksTitel: "Fakturaer fra BidHamr",
  boksIntro: "Fakturaen dækker BidHamrs gebyrer og fragt – ikke selve varen. Beløbene er inkl. moms.",
  firmaTitel: "Fakturaer fra BidHamr",
  // Firmaer betaler intet sælgergebyr (Filip, 26. okt. 2026). Regningerne på
  // abonnementet (Stripe) står i kortet over; her er Dinero-fakturaerne -
  // Ugens butik (og sælgergebyret fra ældre handler).
  firmaIntro:
    "Her finder du BidHamrs fakturaer på Ugens butik – med momsen vist for sig og dit CVR-nummer. Regningerne på abonnementet står ovenfor. Du betaler intet gebyr af dit salg, og fakturaen på selve varen sender du selv til køberen.",
  firmaTom: "Når du køber Ugens butik, kommer fakturaen her.",
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
  // Sælgeren betaler ikke gebyret selv (det trækkes i købers betaling).
  kreditForklaringSaelger: "Sælgergebyret er krediteret, fordi handlen blev annulleret.",
  // Mails efter købet/salget.
  mailLinkTekst:
    "Din faktura fra BidHamr på gebyrerne (inkl. moms) kommer under Min konto → Fakturaer få minutter efter betalingen.",
} as const;
