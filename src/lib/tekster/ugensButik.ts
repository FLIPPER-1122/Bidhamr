// Tekster til "Ugens butik" - betalt forsideplads for firmaer (Filip, 26.
// okt. 2026, ROADMAP-BESLUTNINGER.md "Ugens butik" og "Regler for Ugens
// butik"). Korte pladsholdere - indhold-agenten finpudser dem.
//
// Husk:
// - Pladsen er en annonce og skal altid markeres som "Annonce"
//   (markedsføringsloven).
// - Prisen er ekskl. moms (500 kr. + 25 % moms = 625 kr.). Vis altid begge.
// - BidHamr holder aldrig penge - betalingen håndteres af Stripe.

// ---------------------------------------------------------------------------
// Forsiden (heroens højre side)
// ---------------------------------------------------------------------------

export const UGENS_FORSIDE = {
  maerke: "Annonce · Ugens butik",
  // Skjult for skærmlæsere: hvad feltet er.
  omraadeLabel: (firma: string) => `Annonce: Ugens butik – ${firma}`,
  seButikken: "Se butikken",
  seButikkenLabel: (firma: string) => `Se butikken ${firma}`,
  visAuktion: (nr: number, i_alt: number) => `Vis auktion ${nr} af ${i_alt}`,
  aabnAuktion: (titel: string) => `Se auktionen ${titel}`,
  slutterOm: (tid: string) => `Slutter om ${tid}`,
  bud: (n: number) => (n === 1 ? "1 bud" : `${n} bud`),
  startpris: "Startpris",
  inklMoms: "inkl. moms",
} as const;

// ---------------------------------------------------------------------------
// Firma oversigt -> Ugens butik (/firma/ugens-butik)
// ---------------------------------------------------------------------------

export const UGENS_FIRMA = {
  menupunkt: "Ugens butik",
  titel: "Ugens butik",
  intro: "Din butik øverst på forsiden i en hel uge – ét firma ad gangen.",

  // TODO indhold-agenten: endelig forklaring.
  forklaringTitel: "Sådan virker det",
  forklaring: [
    "Dit firmanavn står som stor overskrift øverst på BidHamrs forside, og dine aktive auktioner vises ét billede ad gangen.",
    "En uge går fra mandag kl. 00 til søndag kl. 24. Du kan også købe den uge, vi er i gang med. Prisen er den samme, uanset hvilken dag du køber.",
    "Feltet er markeret som annonce. Har du ingen aktive auktioner, vises feltet ikke.",
    "Du kan højst have pladsen 4 uger i træk. Derefter skal der gå 2 uger, før du kan få den igen.",
  ],

  prisTitel: "Pris",
  prisEkskl: (kr: string) => `${kr} pr. uge ekskl. moms`,
  prisInkl: (kr: string) => `${kr} inkl. moms`,
  rabatLinje: (pct: number, antal: number) =>
    `Du har ${pct} % rabat de første ${antal === 1 ? "uge" : `${antal} uger`} hvert år.`,
  rabatTilbage: (tilbage: number, aar: number) =>
    tilbage === 0
      ? `Du har brugt alle rabatterne i ${aar}.`
      : `Du har ${tilbage === 1 ? "1 rabat" : `${tilbage} rabatter`} tilbage i ${aar}.`,
  ingenRabat: "Du har ingen rabat på Ugens butik.",
  reservationPris: (kr: string) => `${kr} inkl. moms – prisen er låst på reservationen.`,
  rabatIUgen: (pct: number) => `${pct} % rabat`,

  kalenderTitel: "Vælg en uge",
  kalenderForklaring: "Tryk på en ledig uge. Du kan købe op til 12 uger frem.",
  uge: (nr: number) => `Uge ${nr}`,
  fraTil: (fra: string, til: string) => `${fra} – ${til}`,
  denneUge: "Denne uge",
  status: {
    ledig: "Ledig",
    optaget: "Optaget",
    din: "Din uge",
    din_reservation: "Venter på betaling",
    loft: "Pause",
  } as Record<string, string>,
  // Vises under kalenderen, når en uge har status "loft".
  loftForklaring: "Pause: Du har haft pladsen 4 uger i træk. Du kan booke igen om 2 uger.",
  forklaringFarver: "Ledig = kan købes · Optaget = et andet firma · Din uge = betalt",

  valgtUge: (nr: number, fra: string, til: string) => `Uge ${nr} (${fra} – ${til})`,
  bookKnap: (nr: number, kr: string) => `Book uge ${nr} – ${kr} inkl. moms`,
  vaelgFoerst: "Vælg en ledig uge i kalenderen.",
  starter: "Gør betalingen klar …",

  betalTitel: (nr: number) => `Betal for uge ${nr}`,
  betalTekst: (kl: string) => `Ugen er holdt til dig til kl. ${kl}. Betal inden da, ellers bliver den ledig igen.`,
  betalKnap: (kr: string) => `Betal ${kr}`,
  betalStripe: "Betalingen håndteres af Stripe. Du får en faktura fra BidHamr, når du har betalt.",
  betalFejl: "Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.",
  fortryd: "Annullér",
  annulleret: "Reservationen er annulleret. Ugen er ledig igen.",

  aabenTitel: "Du har en uge, der venter på betaling",
  aabenTekst: (nr: number, kr: string, kl: string | null) =>
    kl ? `Uge ${nr} – ${kr} inkl. moms. Betal senest ${kl}.` : `Uge ${nr} – ${kr} inkl. moms.`,
  aabenFraBidhamr: "BidHamr har reserveret ugen til dig efter aftale.",
  aabenBetal: "Betal nu",
  aabenAnnuller: "Annullér reservationen",
  aabenBehandles: "Din betaling er ved at blive behandlet hos banken. Opdater siden om lidt.",

  // Retur fra betalingen.
  retur: {
    betaltTitel: "Tak – ugen er din",
    betaltTekst: (nr: number) => `Du er Ugens butik i uge ${nr}. Fakturaen kommer under "Fakturaer" herunder.`,
    behandlesTitel: "Betalingen behandles",
    behandlesTekst: "Vi venter på svar fra banken. Det tager som regel kun et øjeblik. Opdater siden om lidt.",
    mislykketTitel: "Betalingen gik ikke igennem",
    mislykketTekst: "Du er ikke blevet trukket. Prøv igen, eller vælg en anden betalingsmetode.",
    refunderesTitel: "Ugen kunne ikke gives",
    refunderesTekst: "Betalingen kom for sent, eller ugen var taget. Hele beløbet sendes automatisk tilbage til dig.",
  },

  // Fejlkoder fra /api/offentlig/firma-ugens-butik-koeb og -annuller.
  fejl: {
    uge_ugyldig: "Vælg en uge fra denne uge og op til 12 uger frem.",
    optaget: "Ugen er desværre lige blevet taget. Vælg en anden uge.",
    loft: "Du har haft pladsen 4 uger i træk. Du kan booke igen om 2 uger.",
    aaben_reservation: "Du har allerede en uge, der venter på betaling. Betal den, eller annullér den først.",
    behandles: "Din betaling er ved at blive behandlet. Vent et øjeblik, og opdater siden.",
    ikke_aktiv: "Dit abonnement skal være betalt, før du kan købe Ugens butik.",
    spaerret: "Din konto kan ikke købe Ugens butik lige nu. Skriv til erhverv@bidhamr.dk.",
    pause: "Betalinger er sat på pause lige nu. Prøv igen senere.",
    betalt: "Ugen er allerede betalt. Opdater siden.",
    foer_lancering: "Ugens butik kan købes, når BidHamr åbner.",
    ikke_firma: "Kun firmakonti kan købe Ugens butik.",
    ikke_fundet: "Reservationen findes ikke længere. Opdater siden.",
    ugyldig: "Noget gik galt. Opdater siden, og prøv igen.",
    fejl: "Noget gik galt. Prøv igen om lidt.",
  } as Record<string, string>,

  // Grunde til, at firmaet slet ikke kan købe (firma_ugens_butik.grund).
  kanIkke: {
    ikke_aktiv: "Du kan købe Ugens butik, når dit abonnement er betalt.",
    spaerret: "Din konto kan ikke købe Ugens butik lige nu. Skriv til erhverv@bidhamr.dk.",
    ikke_firma: "Kun firmakonti kan købe Ugens butik.",
  } as Record<string, string>,
  seAbonnement: "Gå til Abonnement",

  bookingerTitel: "Dine uger",
  bookingerTom: "Du har ikke haft Ugens butik endnu.",
  bookingStatus: {
    betalt: "Betalt",
    manuel: "Aftalt med BidHamr",
    refunderes: "Pengene sendes tilbage",
    refunderet: "Refunderet",
    annulleret: "Annulleret",
  } as Record<string, string>,
  aktivNu: "Vises nu",
  betaltDen: (d: string) => `Betalt ${d}`,
  refunderetDen: (d: string) => `Refunderet ${d}`,
  udenBetaling: "Uden betaling",

  fakturaTitel: "Fakturaer",
  fakturaIntro: "Fakturaer og kreditnotaer fra BidHamr for Ugens butik.",
  fakturaTom: "Du har ingen fakturaer for Ugens butik endnu.",
  fakturaFejl: "Fakturaerne kunne ikke hentes lige nu. Prøv igen om lidt.",
  alleRegninger: "Se alle regninger",

  hentFejl: "Ugens butik kunne ikke hentes lige nu. Prøv at opdatere siden.",
} as const;

// ---------------------------------------------------------------------------
// Admin -> Erhverv -> Ugens butik (/admin/erhverv/ugens-butik)
// ---------------------------------------------------------------------------

export const UGENS_ADMIN = {
  menupunkt: "Ugens butik",
  titel: "Ugens butik",
  forklaring: "Alle uger og bookinger. Book, annullér og refundér fra firmasiden.",
  prisTitel: "Pris pr. uge",
  pris: (ekskl: string, inkl: string) => `${ekskl} ekskl. moms (${inkl} inkl. moms)`,
  prisOpdateret: (d: string) => `Sidst ændret ${d}`,
  prisLabel: "Ny pris i hele kroner ekskl. moms",
  prisRet: "Ret pris",
  prisGem: "Gem pris",
  prisGemt: "Prisen er gemt. Den gælder nye bookinger.",
  prisKunChef: "Kun chefen kan ændre prisen.",
  prisForklaring: "Prisen gælder alle firmaer og nye bookinger. Åbne reservationer beholder deres pris.",
  ugerTitel: "De næste uger",
  ledig: "Ledig",
  denneUge: "denne uge",
  bookingerTitel: "Bookinger",
  bookingerTom: "Ingen bookinger endnu.",
  visesMaks: (n: number) => `Viser de seneste ${n}.`,
  kolonne: { uge: "Uge", firma: "Firma", status: "Status", beloeb: "Beløb", oprettet: "Oprettet" },
  udenBetaling: "Uden betaling",
  afStaff: (navn: string | null) => `Booket af ${navn ?? "staff"}`,
  afFirma: "Købt af firmaet",
  loftOmgaaet: "Loftet er omgået",
  rabat: (pct: number) => `${pct} % rabat`,
  seFirma: "Åbn firma",
  visFlere: "Vis flere",
  filter: { alle: "Alle", aabne: "Aktive og åbne", opmaerksomhed: "Kræver opmærksomhed" },
  ingenAdgang: "Ingen adgang.",
  fejl: "Ugens butik kunne ikke hentes. Prøv at genindlæse siden.",
  mangler: "Ugens butik er ikke sat op i databasen endnu.",
} as const;
