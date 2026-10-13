// Drift-alarmernes "ordbog": fra teknisk kode til dansk titel, forklaring,
// handling og alvor. Bruges af alarm-mailen (src/lib/driftAlarmMail.ts) og
// /admin/drift, så mail og side bruger samme ord.
//
// Ingen server-only-import: ren logik, som enhedstestene og forhåndsvisningen
// også bruger.
//
// En hændelse har en kilde (drift_fejl.kilde) og en kode uden id'er. Koden
// udledes af fejlteksten (alarmKode): logDriftFejl skriver "hvor: fejl", så
// koden er normalt "hvor" (fx "betaling/ukendt-betaling"). Databasen udleder
// koden på samme måde i public.drift_alarm_kode() - de to SKAL følges ad
// (migration 20261021030000_drift_alarm_blokke.sql).

export type Alvor = "roed" | "gul";

export type AlarmType = {
  // Overskrift på almindeligt dansk, fx "Betalinger, vi ikke kender".
  titel: string;
  // Én linje om, hvad det betyder.
  betyder: string;
  // Én linje om, hvad man skal gøre.
  goer: string;
  alvor: Alvor;
  side: { sti: string; tekst: string };
  // Emnelinjen, når typen er den vigtigste i mailen.
  emne: (antal: number) => string;
};

const SIDE = {
  penge: { sti: "/admin/penge", tekst: "Åbn Penge" },
  betalinger: { sti: "/admin/betalinger", tekst: "Åbn betalinger" },
  drift: { sti: "/admin/drift", tekst: "Åbn drift-siden" },
  fakturaer: { sti: "/admin/fakturaer", tekst: "Åbn fakturaer" },
  dac7: { sti: "/admin/dac7", tekst: "Åbn DAC7" },
  erhverv: { sti: "/admin/erhverv", tekst: "Åbn erhverv" },
  auktioner: { sti: "/admin/auktioner", tekst: "Åbn auktioner" },
} as const;

const STRIPE_TILSTAND_TEKST = {
  titel: "Stripe-tilstand passer ikke",
  betyder: "Stripe-nøglen og databasen er ikke enige om test eller live, så betalinger behandles ikke.",
  goer: "Tjek Stripe-nøglerne og databasens Stripe-tilstand (se docs/GO-LIVE-STRIPE.md).",
};

const flertal = (n: number, en: string, flere: string) => (n === 1 ? en : flere);

// Emne med antal: "2 betalinger kræver tjek".
const emneAntal = (en: string, flere: string, resten: string) => (n: number) =>
  [String(n), flertal(n, en, flere), resten].filter(Boolean).join(" ");
const emneFast = (tekst: string) => () => tekst;

const STRIPE_TILSTAND: AlarmType = {
  ...STRIPE_TILSTAND_TEKST,
  alvor: "roed",
  side: SIDE.penge,
  emne: () => "Stripe-tilstand passer ikke",
};

// Kendte koder. Nøglen er koden, som den står i drift_fejl (hvor-delen).
export const ALARM_TYPER: Record<string, AlarmType> = {
  // ------------------------------------------------------------ rød: penge
  "betaling/ukendt-betaling": {
    titel: "Betalinger, vi ikke kender",
    betyder: "Stripe har gennemført en betaling, som ikke hører til nogen handel eller noget abonnement hos os.",
    goer: "Find betalingen i Stripe, og refundér den, hvis den ikke hører til en handel.",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneAntal("betaling", "betalinger", "kræver tjek"),
  },
  "betaling/betalingsmodel": {
    titel: "Betalinger kan ikke behandles",
    betyder: "Databasen mangler en opdatering, så betalinger ikke registreres, og pengetrinnene springes over.",
    goer: "Kør migrationerne til betalingsmodellen (se docs/GO-LIVE-STRIPE.md).",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneFast("Betalinger kan ikke behandles"),
  },
  "betaling/fremmed-udbetaling": {
    titel: "Udbetaling, vi ikke har lavet",
    betyder: "Der er sendt penge fra en sælgers Stripe-konto til banken uden om BidHamr. Sælgeren er frosset.",
    goer: "Tjek kontoen og saldoen i Stripe, og ophæv frysningen under Penge, når det er afklaret.",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneAntal("udbetaling", "udbetalinger", "uden om BidHamr"),
  },
  "betaling/udbetaling-konflikt": {
    titel: "Mulig dobbelt udbetaling",
    betyder: "En udbetaling står som fejlet hos os, men findes hos Stripe. Betalingerne er stoppet.",
    goer: "Tjek i Stripe, at sælgeren ikke får pengene to gange.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("udbetaling", "udbetalinger", "kan være sendt to gange"),
  },
  "betaling/indsigelse-efter-refusion": {
    titel: "Indsigelse på en refunderet handel",
    betyder: "Køberen har fået pengene tilbage og har også klaget til sin bank. Køberen kan få pengene to gange.",
    goer: "Svar banken i Stripe med refusionen som bevis, inden fristen udløber.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("indsigelse", "indsigelser", "på refunderede handler"),
  },
  "betaling/indsigelse-frist": {
    titel: "Frist for indsigelse udløber snart",
    betyder: "En køber har klaget til sin bank, og fristen for at svare banken udløber inden for 48 timer.",
    goer: "Indsend beviserne i Stripe, før fristen udløber. Ellers er indsigelsen tabt.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("indsigelse", "indsigelser", "skal besvares snart"),
  },
  "betaling/indsigelse": {
    titel: "Penge fra tabt indsigelse er ikke hentet",
    betyder: "Vi har tabt en indsigelse, men beløbet kunne ikke hentes tilbage fra sælgerens Stripe-konto.",
    goer: "Se handlen under betalinger, og hent beløbet manuelt i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("tabt indsigelse", "tabte indsigelser", "kræver tjek"),
  },
  "betaling/saldo": {
    titel: "For lidt på en sælgers saldo",
    betyder: "En sælgers Stripe-konto har ikke penge nok til det, vi skylder eller skal trække tilbage. Intet er trukket.",
    goer: "Tjek sælgerkontoen i Stripe.",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneAntal("sælgerkonto", "sælgerkonti", "mangler penge"),
  },
  "betaling/negativ-udbetaling": {
    titel: "Stripe har hentet penge fra en sælgers bank",
    betyder: "En sælgers Stripe-konto var i minus, så Stripe har trukket beløbet fra sælgerens bankkonto.",
    goer: "Find ud af i Stripe, hvorfor saldoen var negativ (refusion eller indsigelse).",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneAntal("sælgerkonto", "sælgerkonti", "har været i minus"),
  },
  "betaling/charge-mangler": {
    titel: "Betalt, men kan ikke udbetales",
    betyder: "En betaling er gennemført, men vi kender ikke overførslen til sælgeren, så pengene kan ikke udbetales.",
    goer: "Tjek betalingen i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("betaling", "betalinger", "kan ikke udbetales"),
  },
  "betaling/destination-charge": {
    titel: "Betaling er ikke sat rigtigt op",
    betyder: "En betaling passer ikke til den måde, pengene skal fordeles mellem sælger og BidHamr.",
    goer: "Tjek betalingen i Stripe og under betalinger.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("betaling", "betalinger", "er ikke sat rigtigt op"),
  },
  "betaling/bidhamr-daekker": {
    titel: "\"BidHamr dækker\" er stoppet",
    betyder: "En refusion, som BidHamr betaler, kunne ikke gennemføres eller registreres.",
    goer: "Tjek betalingen i Stripe, så køberen ikke får pengene to gange eller slet ikke.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("refusion", "refusioner", "fra BidHamr kræver tjek"),
  },
  "betaling/refusion-afstemning": {
    titel: "Refusion passer ikke",
    betyder: "En handel er refunderet, men det beløb, der er taget tilbage fra sælgeren, passer ikke.",
    goer: "Tjek tilbageførslen i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("refusion", "refusioner", "passer ikke"),
  },
  "betaling/afstemning": {
    titel: "Pengene passer ikke med Stripe",
    betyder: "Den daglige afstemning har fundet forskel på Stripe og databasen, eller den blev ikke færdig.",
    goer: "Se forskellene under Penge, og markér dem løst, når de er afklaret.",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneFast("Pengene passer ikke med Stripe"),
  },
  "betaling/admin-frigivelse": {
    titel: "Stor frigivelse uden købers godkendelse",
    betyder: "En handel på 10.000 kr. eller mere er frigivet til sælgeren af BidHamr, uden at køberen har godkendt.",
    goer: "Tjek, at frigivelsen er rigtig.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("stor frigivelse", "store frigivelser", "kræver tjek"),
  },
  "erhverv/dobbelt-abonnement": {
    titel: "Firma har to abonnementer",
    betyder: "Et firma betaler for to abonnementer på samme tid.",
    goer: "Opsig det ene i Stripe, og refundér det, der er betalt for meget.",
    alvor: "roed",
    side: SIDE.erhverv,
    emne: emneAntal("firma", "firmaer", "har to abonnementer"),
  },
  "erhverv/opgradering-ukendt": {
    titel: "Betaling for opgradering, vi ikke kender",
    betyder: "Et firma har betalt for en opgradering, som vi ikke kan finde.",
    goer: "Find betalingen i Stripe, og refundér den, hvis den ikke hører til noget.",
    alvor: "roed",
    side: SIDE.erhverv,
    emne: emneAntal("firmabetaling", "firmabetalinger", "kræver tjek"),
  },

  // ------------------------------------------------------------ rød: cron
  "cron/holdt-op": {
    titel: "Betalings-cron er gået i stå",
    betyder: "Den faste kørsel, der flytter penge og afslutter auktioner, har ikke kørt rigtigt i over 20 minutter.",
    goer: "Tjek cron-ruten og Vercel på drift-siden.",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneFast("Betalings-cron er gået i stå"),
  },
  "cron/koersel-fejlede": {
    titel: "Betalings-cron fejlede",
    betyder: "En kørsel af den faste betalings-cron er endt med fejl. Den prøver igen om 5 minutter.",
    goer: "Se fejlen på drift-siden. Kommer den igen, skal den rettes.",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneAntal("cron-kørsel", "cron-kørsler", "fejlede"),
  },
  "cron/koersel-haenger": {
    titel: "Betalings-cron blev ikke færdig",
    betyder: "En kørsel af betalings-cron er startet, men ikke afsluttet efter 10 minutter.",
    goer: "Se kørslen på drift-siden, og tjek Vercels logs.",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneFast("Betalings-cron blev ikke færdig"),
  },

  "Refusion opgivet": {
    titel: "Tilbagebetaling er opgivet",
    betyder: "En tilbagebetaling til en køber er fejlet flere gange og prøves ikke mere automatisk.",
    goer: "Tilbagebetal køberen manuelt i Stripe, og se handlen under betalinger.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("tilbagebetaling", "tilbagebetalinger", "er opgivet"),
  },
  "Lovet refusion": {
    titel: "Lovet tilbagebetaling fejlede",
    betyder: "En tilbagebetaling, som køberen er lovet, kunne ikke sendes. Den prøves igen om 5 minutter.",
    goer: "Se handlen under betalinger. Fortsætter det, så tilbagebetal i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneFast("Lovet tilbagebetaling fejlede"),
  },
  "Lovede refusioner": {
    titel: "Lovede tilbagebetalinger kunne ikke hentes",
    betyder: "Betalings-cron kunne ikke finde de tilbagebetalinger, køberne er lovet. Ingen er sendt i denne kørsel.",
    goer: "Se fejlen på drift-siden. Kommer den igen, skal den rettes.",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneFast("Lovede tilbagebetalinger kunne ikke hentes"),
  },
  "Refusion af afvigelse": {
    titel: "Forkert beløb blev ikke tilbagebetalt",
    betyder: "En køber har betalt et andet beløb end handlen, og det kunne ikke tilbagebetales automatisk.",
    goer: "Tjek betalingen i Stripe, og tilbagebetal forskellen.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneFast("Forkert beløb blev ikke tilbagebetalt"),
  },
  "Tilbageførsel ved tabt indsigelse": {
    titel: "Tabt indsigelse blev ikke hentet hos sælgeren",
    betyder: "Vi har tabt en indsigelse, men beløbet kunne ikke hentes tilbage fra sælgerens Stripe-konto i denne kørsel.",
    goer: "Se handlen under betalinger. Fortsætter det, så hent beløbet i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneFast("Tabt indsigelse blev ikke hentet hos sælgeren"),
  },
  Indsigelsesfrister: {
    titel: "Frister for indsigelser blev ikke tjekket",
    betyder: "Betalings-cron kunne ikke tjekke, om der er indsigelser, som banken venter svar på.",
    goer: "Se indsigelserne i Stripe, så ingen frist bliver overset.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneFast("Frister for indsigelser blev ikke tjekket"),
  },
  "Kunne ikke gemme PaymentIntent": {
    titel: "Betaling er startet, men ikke gemt",
    betyder: "En køber har fået en betaling hos Stripe, som vi ikke fik gemt. Betaler køberen, kender vi ikke betalingen.",
    goer: "Find betalingen i Stripe, og tjek, at den hører til handlen.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneFast("Betaling er startet, men ikke gemt"),
  },
  "Forældet PaymentIntent ikke annulleret": {
    titel: "Gammel betaling er ikke lukket",
    betyder: "En gammel betaling hos Stripe kunne ikke annulleres. Køberen kan risikere at betale to gange.",
    goer: "Annullér den gamle betaling i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneFast("Gammel betaling er ikke lukket"),
  },
  "Stripe-tilstand": STRIPE_TILSTAND,
  "stripe/tilstand": STRIPE_TILSTAND,
  tilstand: STRIPE_TILSTAND,
  Afstemningsruten: {
    titel: "Pengeafstemningen fejlede",
    betyder: "Den daglige afstemning med Stripe gik i stå. Vi ved derfor ikke, om pengene passer.",
    goer: "Se fejlen på drift-siden. Afstemningen prøves igen om 2 timer.",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneFast("Pengeafstemningen fejlede"),
  },
  "erhverv/opgradering-refusion-fejl": {
    titel: "Refusion til firma fejlede",
    betyder: "Et firma skulle have penge tilbage for en opgradering, men refusionen fejlede.",
    goer: "Refundér firmaet manuelt i Stripe.",
    alvor: "roed",
    side: SIDE.erhverv,
    emne: emneFast("Refusion til firma fejlede"),
  },
  "erhverv/admin-pris-tilbage": {
    titel: "Firmaets pris står forkert i Stripe",
    betyder: "En prisændring kunne ikke rulles tilbage i Stripe, så firmaet kan blive opkrævet forkert.",
    goer: "Ret prisen på abonnementet i Stripe.",
    alvor: "roed",
    side: SIDE.erhverv,
    emne: emneFast("Firmaets pris står forkert i Stripe"),
  },
  "erhverv/rul-tilbage": {
    titel: "Pakkeskift blev ikke rullet tilbage",
    betyder: "Et firmas pakkeskift fejlede hos Stripe og kunne ikke rulles tilbage. Stripe og databasen kan være uenige.",
    goer: "Tjek abonnementet i Stripe mod firmaets pakke under erhverv.",
    alvor: "roed",
    side: SIDE.erhverv,
    emne: emneFast("Pakkeskift blev ikke rullet tilbage"),
  },
  kald_betalings_cron: {
    titel: "Betalings-cron kan ikke startes",
    betyder: "Databasen kan ikke kalde betalings-cron, fordi en indstilling i Supabase Vault mangler.",
    goer: "Tjek cron_url og cron_secret i Supabase Vault (se docs/GO-LIVE-STRIPE.md).",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneFast("Betalings-cron kan ikke startes"),
  },

  // ------------------------------------------------------------ gul
  kald_pengeafstemning: {
    titel: "Pengeafstemningen kan ikke startes",
    betyder: "Databasen kan ikke starte den daglige afstemning med Stripe, fordi en indstilling i Supabase Vault mangler.",
    goer: "Tjek cron_url, cron_secret og afstemning_url i Supabase Vault.",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneFast("Pengeafstemningen kan ikke startes"),
  },
  "Automatisk annullering af pauset auktion fejlede": {
    titel: "Auktion på pause blev ikke annulleret",
    betyder: "En auktion har stået på pause i 14 dage, men den automatiske annullering fejlede. Den prøves igen om en time.",
    goer: "Se auktionerne på pause, og annullér den selv, hvis det fortsætter.",
    alvor: "gul",
    side: SIDE.auktioner,
    emne: emneFast("Auktion på pause blev ikke annulleret"),
  },
  "Udbetaling til sælger": {
    titel: "Udbetalinger blev ikke sendt",
    betyder: "Betalings-cron kunne ikke sende udbetalinger til sælgerne i denne kørsel. Den prøver igen om 5 minutter.",
    goer: "Hold øje. Kommer fejlen igen, så se den på drift-siden.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneFast("Udbetalinger blev ikke sendt"),
  },
  "Spejling af charges": {
    titel: "Betalinger kunne ikke hentes fra Stripe",
    betyder: "Betalings-cron kunne ikke hente status for betalinger hos Stripe. Den prøver igen om 5 minutter.",
    goer: "Hold øje. Kommer fejlen igen, så se den på drift-siden.",
    alvor: "gul",
    side: SIDE.drift,
    emne: emneFast("Betalinger kunne ikke hentes fra Stripe"),
  },
  "betaling/webhook-udeblev": {
    titel: "Besked fra Stripe kom ikke frem",
    betyder: "Stripe har ikke sendt os en besked om en betaling eller udbetaling. Vi har selv hentet status, så det er rettet.",
    goer: "Tjek webhooks i Stripe-dashboardet, hvis det sker flere gange.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("besked", "beskeder", "fra Stripe kom ikke frem"),
  },
  "betaling/udbetaling-haenger": {
    titel: "Udbetaling har ventet længe",
    betyder: "En udbetaling til en sælger har stået stille i over 7 dage.",
    goer: "Tjek udbetalingen i Stripe og under betalinger.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("udbetaling", "udbetalinger", "har ventet længe"),
  },
  "betaling/udbetaling-fejlet": {
    titel: "Udbetaling til sælger fejlede",
    betyder: "Banken afviste en udbetaling. Pengene er tilbage på sælgerens Stripe-konto.",
    goer: "Sælgeren skal rette sin bankkonto. Tjek, at sælgeren har fået besked.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("udbetaling", "udbetalinger", "fejlede"),
  },
  "betaling/udbetaling-stoppet": {
    titel: "Udbetaling stoppet til kontrol",
    betyder: "En betaling er markeret, så pengene ikke udbetales, før nogen har set på den.",
    goer: "Se de markerede betalinger, og afgør dem.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("udbetaling", "udbetalinger", "stoppet til kontrol"),
  },
  "betaling/udbetaling": {
    titel: "Udbetaling prøves igen",
    betyder: "En udbetaling til en sælger fejlede. Den prøves igen automatisk.",
    goer: "Hold øje med betalinger. Kommer den igen, så tjek sælgerkontoen i Stripe.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("udbetaling", "udbetalinger", "prøves igen"),
  },
  "betaling/indsigelse-uafklaret": {
    titel: "Tabt indsigelse er ikke afklaret",
    betyder: "En tabt indsigelse er hverken hentet tilbage fra sælgeren eller afgjort efter 7 dage.",
    goer: "Se handlen under betalinger, og afgør den.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("indsigelse", "indsigelser", "er ikke afklaret"),
  },
  "betaling/gamle-midler": {
    titel: "Penge har stået længe",
    betyder: "En handel er betalt for længe siden, men pengene er hverken udbetalt eller refunderet.",
    goer: "Afgør handlen under betalinger.",
    alvor: "gul",
    side: SIDE.betalinger,
    emne: emneAntal("handel", "handler", "venter på at blive afgjort"),
  },
  "betaling/gammel-model": {
    titel: "Betaling fra den gamle model",
    betyder: "En betaling er lavet med den gamle betalingsmodel, som er fjernet. Intet er sendt til Stripe, så pengene skal håndteres i hånden.",
    goer: "Håndtér betalingen manuelt i Stripe.",
    alvor: "roed",
    side: SIDE.betalinger,
    emne: emneAntal("gammel betaling", "gamle betalinger", "skal håndteres"),
  },
  "betaling/kontotjek": {
    titel: "Betaling venter på sælgerkontoen",
    betyder: "En sælgers Stripe-konto står ikke til manuel udbetaling, så betalingen venter.",
    goer: "Tjek sælgerkontoens udbetalingsplan i Stripe.",
    alvor: "gul",
    side: SIDE.penge,
    emne: emneAntal("betaling", "betalinger", "venter på sælgerkontoen"),
  },
  "betaling/frysning": {
    titel: "Sælger frosset",
    betyder: "En sælgers udbetalinger er frosset - enten af chefen eller automatisk.",
    goer: "Tjek under Penge, at frysningen er rigtig, og ophæv den, når det er afklaret.",
    alvor: "gul",
    side: SIDE.penge,
    emne: emneAntal("sælger", "sælgere", "frosset"),
  },
  "betaling/noedstop": {
    titel: "Nødstop slået til eller fra",
    betyder: "Chefen har stoppet eller genoptaget betalinger eller udbetalinger.",
    goer: "Tjek Penge med det samme, hvis det ikke var dig.",
    alvor: "roed",
    side: SIDE.penge,
    emne: emneFast("Nødstop ændret"),
  },
  "connect/udbetalingsplan": {
    titel: "Sælgerkonto havde forkert udbetalingsplan",
    betyder: "En sælgers Stripe-konto stod ikke til manuel udbetaling. Den er sat tilbage, og udbetalingerne er frosset.",
    goer: "Tjek kontoen i Stripe, og ophæv frysningen under Penge.",
    alvor: "gul",
    side: SIDE.penge,
    emne: emneAntal("sælgerkonto", "sælgerkonti", "havde forkert udbetalingsplan"),
  },
  "connect/afvist": {
    titel: "Stripe har afvist en sælgerkonto",
    betyder: "Sælgeren kan ikke modtage betalinger eller udbetalinger.",
    goer: "Tjek kontoen i Stripe, og giv sælgeren besked, hvis der mangler noget.",
    alvor: "gul",
    side: SIDE.penge,
    emne: emneAntal("sælgerkonto", "sælgerkonti", "afvist af Stripe"),
  },
  "connect/ingen-adgang": {
    titel: "Ingen adgang til en sælgerkonto",
    betyder: "Vi kan ikke nå en sælgers Stripe-konto, så sælgeren kan ikke få betalinger.",
    goer: "Tjek kontoen i Stripe.",
    alvor: "gul",
    side: SIDE.penge,
    emne: emneAntal("sælgerkonto", "sælgerkonti", "kan ikke nås"),
  },
  "faktura/dinero": {
    titel: "Fakturaer bliver ikke lavet",
    betyder: "Fakturaer kunne ikke laves i Dinero. De prøves igen automatisk.",
    goer: "Se fakturaerne, og tjek Dinero-opsætningen, hvis det fortsætter.",
    alvor: "gul",
    side: SIDE.fakturaer,
    emne: emneFast("Fakturaer bliver ikke lavet"),
  },
  "cron/pg-cron-job": {
    titel: "Planlagt job i databasen fejlede",
    betyder: "Et af databasens faste job (fx afslutning af auktioner eller oprydning) fejlede.",
    goer: "Se jobbet og fejlen på drift-siden.",
    alvor: "gul",
    side: SIDE.drift,
    emne: emneAntal("planlagt job", "planlagte job", "fejlede"),
  },
  "cron/http-kald": {
    titel: "Databasen kunne ikke kalde siden",
    betyder: "Databasen prøvede at starte en fast kørsel på siden, men fik fejl eller intet svar.",
    goer: "Se kaldene på drift-siden. Sker det igen og igen, så tjek Vercel.",
    alvor: "gul",
    side: SIDE.drift,
    emne: emneAntal("kald", "kald", "til siden fejlede"),
  },
  "mange-fejl": {
    titel: "Mange fejl på kort tid",
    betyder: "Der er registreret over 20 fejl på 15 minutter. Noget kan være gået i stykker.",
    goer: "Se de hyppigste fejl på drift-siden.",
    alvor: "gul",
    side: SIDE.drift,
    emne: emneAntal("fejl", "fejl", "på 15 minutter"),
  },
  klient: {
    titel: "Fejl i brugernes browser",
    betyder: "Siden har vist en fejl for nogle brugere. Selve fejlteksten står kun på drift-siden.",
    goer: "Se fejlene på drift-siden.",
    alvor: "gul",
    side: SIDE.drift,
    emne: emneAntal("fejl", "fejl", "i brugernes browser"),
  },
};

// Grupper af koder, der ikke står enkeltvis ovenfor.
const PRAEFIKS: { praefiks: string; type: AlarmType }[] = [
  {
    praefiks: "Pengeafstemning",
    type: { ...ALARM_TYPER["betaling/afstemning"] },
  },
  {
    praefiks: "Overvågning",
    type: {
      titel: "Pengeovervågningen fejlede",
      betyder: "Den løbende kontrol af betalinger og udbetalinger kunne ikke gennemføres.",
      goer: "Se fejlen på drift-siden. Den prøves igen om en time.",
      alvor: "gul",
      side: SIDE.drift,
      emne: emneFast("Pengeovervågningen fejlede"),
    },
  },
  {
    praefiks: "betaling/",
    type: {
      titel: "Betaling kræver tjek",
      betyder: "Der er sket noget med en betaling eller udbetaling, som en person bør se på.",
      goer: "Se betalingerne, der er markeret.",
      alvor: "roed",
      side: SIDE.betalinger,
      emne: emneAntal("betaling", "betalinger", "kræver opmærksomhed"),
    },
  },
  {
    praefiks: "connect/",
    type: {
      titel: "Problem med en sælgerkonto",
      betyder: "Der er sket noget med en sælgers Stripe-konto.",
      goer: "Tjek kontoen i Stripe.",
      alvor: "gul",
      side: SIDE.penge,
      emne: emneAntal("sælgerkonto", "sælgerkonti", "kræver tjek"),
    },
  },
  {
    praefiks: "erhverv/",
    type: {
      titel: "Firmaabonnement kræver tjek",
      betyder: "Der er sket noget med et firmas abonnement eller betaling.",
      goer: "Se firmaet under erhverv, og tjek abonnementet i Stripe.",
      alvor: "gul",
      side: SIDE.erhverv,
      emne: emneAntal("firmaabonnement", "firmaabonnementer", "kræver tjek"),
    },
  },
  {
    praefiks: "Erhverv",
    type: {
      titel: "Firmaabonnement kræver tjek",
      betyder: "Der er sket noget med et firmas abonnement eller betaling.",
      goer: "Se firmaet under erhverv, og tjek abonnementet i Stripe.",
      alvor: "gul",
      side: SIDE.erhverv,
      emne: emneAntal("firmaabonnement", "firmaabonnementer", "kræver tjek"),
    },
  },
  {
    praefiks: "Fragt",
    type: {
      titel: "Fejl i fragten",
      betyder: "Noget med fragt, labels eller sporing fejlede.",
      goer: "Se fejlen på drift-siden. Tjek fragtfirmaets status, hvis det fortsætter.",
      alvor: "gul",
      side: SIDE.drift,
      emne: emneAntal("fragtfejl", "fragtfejl", ""),
    },
  },
  {
    praefiks: "DAC7",
    type: {
      titel: "Fejl i DAC7-indberetningen",
      betyder: "Noget i indberetningen af sælgere til Skattestyrelsen fejlede.",
      goer: "Se DAC7-siden.",
      alvor: "gul",
      side: SIDE.dac7,
      emne: emneFast("Fejl i DAC7-indberetningen"),
    },
  },
  {
    praefiks: "auktion på pause",
    type: {
      titel: "Fejl ved auktioner på pause",
      betyder: "En besked om en auktion på pause kunne ikke sendes.",
      goer: "Se auktionerne på pause.",
      alvor: "gul",
      side: SIDE.auktioner,
      emne: emneFast("Fejl ved auktioner på pause"),
    },
  },
];

// Når hverken koden eller præfikset er kendt: efter kilde.
const KILDE_TYPE: Record<string, AlarmType> = {
  webhook: {
    titel: "Beskeder udefra fejler",
    betyder: "En besked fra Stripe eller et fragtfirma kunne ikke behandles. Afsenderen prøver igen i op til 3 dage.",
    goer: "Se fejlen på drift-siden. Fortsætter den, skal den rettes.",
    alvor: "roed",
    side: SIDE.drift,
    emne: emneAntal("besked", "beskeder", "udefra fejler"),
  },
  cron: {
    titel: "Fejl i en fast kørsel",
    betyder: "En del af en fast kørsel fejlede. Den prøves igen ved næste kørsel.",
    goer: "Se fejlen på drift-siden. Kommer den igen, skal den rettes.",
    alvor: "gul",
    side: SIDE.drift,
    emne: emneAntal("fejl", "fejl", "i faste kørsler"),
  },
};

export const UKENDT_TYPE: AlarmType = {
  titel: "Teknisk fejl – se drift-siden",
  betyder: "Der er sket en fejl, som vi ikke har en forklaring på endnu.",
  goer: "Se fejlen på drift-siden.",
  alvor: "gul",
  side: SIDE.drift,
  emne: emneAntal("teknisk fejl", "tekniske fejl", ""),
};

// Rækkefølgen SKAL svare til public.drift_alarm_er_roed() i migrationen:
// kendt kode -> kilde 'webhook' (altid rød) -> præfiks -> kilde -> ukendt.
export function alarmType(kilde: string, kode: string): AlarmType {
  const direkte = ALARM_TYPER[kode];
  if (direkte) return direkte;
  if (kilde === "webhook") return KILDE_TYPE.webhook;
  for (const p of PRAEFIKS) if (kode.startsWith(p.praefiks)) return p.type;
  return KILDE_TYPE[kilde] ?? UKENDT_TYPE;
}

// Præfikser, hvis ukendte koder er røde (spejlet i drift_alarm_er_roed).
export const ROEDE_PRAEFIKSER = PRAEFIKS.filter((p) => p.type.alvor === "roed").map((p) => p.praefiks);

// Id-agtige ord (mindst 10 tegn af [A-Za-z0-9_-] med mindst ét ciffer): Stripe-
// id'er, uuid'er m.m. Erstattes med "#", så samme slags fejl får samme kode.
// SAMME mønster som i public.drift_alarm_kode().
const ID_ORD = /(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{10,}/g;
const PRAEFIKS_RE = /^([^:]{1,80}): /;

// Koden for en hændelse uden id'er. Spejler public.drift_alarm_kode().
export function alarmKode(kilde: string, besked: string | null | undefined): string {
  if (kilde === "klient") return "klient";
  const n = (besked ?? "").replace(ID_ORD, "#");
  const m = PRAEFIKS_RE.exec(n);
  const kode = (m ? m[1] : n.slice(0, 60)).replace(/^ +| +$/g, "");
  return kode || "(ingen besked)";
}

// Id'er, der må vises som eksempler (lille grå tekst). Stripe-id'er og uuid'er.
const STRIPE_ID = /\b(?:acct|ch|pi|py|po|re|pyr|dp|du|cus|in|sub|evt|tr|txn|seti|pm|cs|issfr|ii)_[A-Za-z0-9]{6,}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function idIEksempel(tekst: string | null | undefined): string | null {
  if (!tekst) return null;
  const s = tekst.match(STRIPE_ID);
  if (s && s.length > 0) return s[0];
  const u = tekst.match(UUID);
  return u && u.length > 0 ? u[0] : null;
}
