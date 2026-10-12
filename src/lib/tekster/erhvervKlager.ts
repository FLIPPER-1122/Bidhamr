// Tekster til klager over firmaer (reklamation): køber, firma og admin.
// Samlet her, så indhold-agenten kan rette dem ét sted.
import type { KlageAfgoerelse, KlageGrund, KlageKanal, KlageKategori, KlageStatus } from "@/lib/erhverv/klager";

export const KLAGE_KATEGORI_NAVN: Record<KlageKategori, string> = {
  ikke_som_beskrevet: "Varen er ikke som beskrevet",
  ikke_leveret: "Varen er ikke leveret",
  reklamation_afvist: "Firmaet har afvist min reklamation",
  fortrydelsesret: "Firmaet respekterer ikke min fortrydelsesret",
  andet: "Andet",
};

export const KLAGE_KATEGORI_HJAELP: Record<KlageKategori, string> = {
  ikke_som_beskrevet: "Varen er tydeligt anderledes end beskrevet i auktionen.",
  ikke_leveret: "Du har betalt, men har ikke fået varen.",
  reklamation_afvist: "Varen er gået i stykker eller har en fejl, og firmaet vil ikke reparere, bytte eller give pengene tilbage.",
  fortrydelsesret: "Du har fortrudt købet inden for 14 dage, men firmaet vil ikke tage varen retur.",
  andet: "Noget andet, firmaet ikke har løst.",
};

export const KLAGE_STATUS_NAVN: Record<KlageStatus, string> = {
  aaben: "Modtaget",
  under_behandling: "Under behandling",
  afsluttet: "Afsluttet",
};

export const KLAGE_AFGOERELSE_NAVN: Record<KlageAfgoerelse, string> = {
  berettiget: "Klagen er berettiget",
  ikke_berettiget: "Klagen er ikke berettiget",
  trukket_tilbage: "Trukket tilbage",
};

export const KLAGE_KANAL_NAVN: Record<KlageKanal, string> = {
  telefon: "Telefon",
  email: "E-mail",
  andet: "Andet",
};

// Køberen på handelssiden.
export const KLAGE_KOEBER = {
  titel: "Klag over firmaet",
  intro:
    "Har du først kontaktet firmaet, uden at det er blevet løst? Så kan du klage til BidHamr. Vi ser på klagen og kontakter firmaet. Firmaer, der får gentagne berettigede klager, kan få en advarsel og til sidst få lukket deres konto.",
  bemaerk:
    "BidHamr kan ikke give dig pengene tilbage. Din ret til at reklamere (2 år) og til at fortryde købet (14 dage) har du over for firmaet. BidHamr Beskyttelse gælder ikke ved køb fra firmaer.",
  knapAaben: "Klag over firmaet",
  kategoriLegend: "Hvad handler klagen om?",
  beskrivelseLabel: "Beskriv, hvad der er sket",
  beskrivelsePladsholder: "Hvad er problemet, hvornår kontaktede du firmaet, og hvad svarede de?",
  beskrivelseHjaelp: (min: number) => `Mindst ${min} tegn. Firmaet kan ikke se din beskrivelse eller dine billeder.`,
  billederTitel: "Billeder (valgfrit)",
  billederHjaelp: "Fx billeder af varen, fejlen eller et skærmbillede af din mail til firmaet.",
  billederFelt: "Billeder",
  knapSend: "Send klagen",
  knapAnnuller: "Annullér",
  uploader: (f: number, i: number) => `Uploader billeder: ${f} af ${i}`,
  sender: "Sender klagen …",
  sendt: "Tak. Vi har modtaget din klage og ser på den hurtigst muligt.",
  vaelgKategori: "Vælg, hvad klagen handler om.",
  forKortBeskrivelse: (min: number, maks: number) => `Beskrivelsen skal være mellem ${min} og ${maks} tegn.`,
  dineKlager: "Dine klager over firmaet",
  klageNr: (n: number) => `Klage nr. ${n}`,
  oprettet: "Sendt",
  afgjort: "Afgjort",
  begrundelse: "BidHamrs begrundelse",
  knapTraekTilbage: "Træk klagen tilbage",
  traekTitel: "Træk klagen tilbage?",
  traekTekst: "Gør det, hvis firmaet har løst problemet. Du kan ikke fortryde det bagefter.",
  traekKnap: "Ja, træk den tilbage",
  grund: {
    aaben_findes: "Du har en klage over denne handel, som BidHamr er ved at se på.",
    for_mange: "Du har sendt mange klager på kort tid. Prøv igen senere.",
    for_mange_handel: "Du har klaget over denne handel det største antal gange. Skriv til BidHamr, hvis der er mere.",
    ikke_betalt: "Du kan klage over firmaet, når handlen er betalt.",
    for_sent: "Fristen for at klage over denne handel er udløbet.",
  } satisfies Record<KlageGrund, string>,
  // erhverv_klage_annulleret (BHE11, 20261020020000): annulleret handel, hvor
  // firmaet hverken undlod at sende varen eller tabte en sag.
  annulleret:
    "Du kan kun klage over firmaet på en annulleret handel, hvis firmaet ikke sendte varen, eller hvis du har fået medhold i en sag.",
  fejlGenerisk: "Noget gik galt. Prøv igen om lidt.",
} as const;

// Firma oversigt → Klager.
export const KLAGE_FIRMA = {
  menupunkt: "Klager",
  titel: "Klager",
  intro:
    "Her ser du klager fra købere over jeres salg. BidHamr ser på hver klage og kontakter jer, hvis vi har brug for jeres forklaring. Køberens beskrivelse og billeder vises ikke her.",
  tom: "Der er ingen klager over jer. Godt gået!",
  berettigede: (n: number) =>
    n === 1
      ? "1 berettiget klage de seneste 12 måneder."
      : `${n} berettigede klager de seneste 12 måneder.`,
  regel:
    "Gentagne berettigede klager kan give en advarsel. 3 advarsler betyder, at kontoen kan blive lukket.",
  klageNr: (n: number) => `Klage nr. ${n}`,
  salg: "Salg",
  seSalg: "Se salget",
  modtaget: "Modtaget",
  afgjort: "Afgjort",
  begrundelse: "BidHamrs begrundelse",
} as const;

// Admin → Erhverv → Klager.
export const KLAGE_ADMIN = {
  fane: "Købers klager",
  titel: "Klager over firmaer",
  forklaring:
    "Købernes klager over firmaer. Læs klagen, skriv noter, log kontakt med firmaet, og afgør klagen med en begrundelse (køber og firma ser den). Alt logges.",
  filter: { aaben: "Åbne", under_behandling: "Under behandling", afsluttet: "Afsluttede" },
  tom: "Ingen klager her.",
  forslagTitel: "Forslag om advarsel",
  forslagForklaring: (antal: number, maaneder: number) =>
    `Et firma får et forslag, når det har ${antal} berettigede klager inden for ${maaneder} måneder - eller ved hver ny berettiget klage, hvis det allerede har en advarsel. Advarslen gives aldrig automatisk.`,
  forslagGrundlag: {
    tre_klager: (n: number) => `${n} berettigede klager`,
    tidligere_advarsel: (n: number) => `${n} ny${n === 1 ? "" : "e"} berettiget${n === 1 ? "" : "e"} klage${n === 1 ? "" : "r"} efter en advarsel`,
  },
  advarslerAntal: (n: number) => `${n} advarsel${n === 1 ? "" : "er"} i forvejen`,
  kolonne: { firma: "Firma", koeber: "Køber", kategori: "Kategori", oprettet: "Modtaget" },
  tilbage: "Alle klager",
  klageNr: (n: number) => `Klage nr. ${n}`,
  handel: "Handlen",
  firma: "Firmaet",
  koeber: "Køberen",
  koeberEmailKunChef: "E-mail vises kun for chefen.",
  beskrivelse: "Køberens beskrivelse",
  billeder: "Køberens billeder",
  ingenBilleder: "Ingen billeder.",
  statistik: "Firmaet i tal",
  klagerIAlt: "Klager i alt",
  berettigede12: "Berettigede de seneste 12 måneder",
  advarsler: "Advarsler",
  lukningForeslaaet: "Der er et forslag om at lukke firmakontoen. Kun chefen og sælger-rollen kan godkende det.",
  lukningLink: "Godkend eller afvis under firmaet",
  inhabil: "Du har selv handlet med firmaet (eller er køberen) og kan ikke behandle klagen. Bed en kollega om at tage den.",
  inhabilSkjult: "Du er inhabil i denne sag.",
  knapTag: "Tag klagen",
  noter: "Noter og kontakt med firmaet",
  ingenNoter: "Ingen noter endnu.",
  noteType: { note: "Intern note", kontakt_firma: "Kontakt med firmaet" },
  noteLabel: "Ny note (kun staff ser den)",
  kontaktLabel: "Hvad aftalte I med firmaet?",
  kanalLabel: "Hvordan kontaktede du firmaet?",
  knapGemNote: "Gem note",
  knapLogKontakt: "Log kontakt",
  afgoerTitel: "Afgør klagen",
  afgoerForklaring: "Begrundelsen sendes til både køberen og firmaet. Skriv den, så begge forstår den.",
  begrundelseLabel: "Begrundelse til køber og firma",
  knapBerettiget: "Klagen er berettiget",
  knapIkkeBerettiget: "Klagen er ikke berettiget",
  bekraeftBerettiget: "Klagen afgøres som berettiget. Det tæller med, når BidHamr vurderer, om firmaet skal have en advarsel.",
  bekraeftIkkeBerettiget: "Klagen afgøres som ikke berettiget.",
  afgjortAf: "Afgjort af",
  giverForslag: "Afgørelsen gav et forslag om advarsel til firmaet.",
  advarselTitel: "Giv firmaet en advarsel",
  advarselBegrundelse: "Begrundelse til firmaet (vises i besked og på kontoen)",
  advarselNote: "Intern note (valgfri, kun staff)",
  knapGivAdvarsel: "Giv advarsel",
  bekraeftAdvarsel: "Firmaet får en advarsel. Ved 3 advarsler oprettes et forslag om at lukke kontoen, som kun chefen og sælger-rollen kan godkende.",
  afvisLabel: "Hvorfor skal firmaet ikke have en advarsel? (intern)",
  knapAfvis: "Afvis forslaget",
  bekraeftAfvis: "Forslaget afvises, og firmaet får ingen advarsel. Klagerne tæller ikke med i et nyt forslag.",
  advarselGivet: "Advarslen er givet.",
  advarselGivetLukning: "Advarslen er givet. Firmaet har nu 3 advarsler, og der er oprettet et forslag om lukning til chefen.",
  afvist: "Forslaget er afvist.",
  noteGemt: "Gemt.",
  seFirma: "Se firmaet",
} as const;

export const KLAGE_ADMIN_FEJL: Record<string, string> = {
  ingen_adgang: "Du har ikke adgang til klager under Erhverv.",
  ikke_fundet: "Findes ikke længere. Opdater siden.",
  inhabil: "Du kan ikke behandle denne klage, fordi du selv har handlet med firmaet (eller er køberen). Bed en kollega om at tage den.",
  ugyldig_type: "Ugyldig type.",
  ugyldig_kanal: "Vælg, hvordan du kontaktede firmaet.",
  tekst_mangler: "Skriv en tekst.",
  for_lang_tekst: "Teksten er for lang.",
  ugyldig_afgoerelse: "Vælg en afgørelse.",
  begrundelse_mangler: "Skriv en begrundelse.",
  afsluttet: "Klagen er allerede afgjort. Opdater siden.",
  begrundelse_bruger_mangler: "Skriv en begrundelse til firmaet.",
  begrundelse_bruger_for_lang: "Begrundelsen til firmaet må højst være 1000 tegn.",
  behandlet: "Forslaget er allerede behandlet. Opdater siden.",
  konto_lukket: "Firmakontoen er allerede lukket.",
};

// Notifikationer (type 'afgoerelse' - "Afgørelser og klager").
export const KLAGE_NOTIFIKATION = {
  koeberTitel: "Din klage over firmaet er afgjort",
  koeberTekst: (nr: number, afg: string, begrundelse: string) =>
    `Klage nr. ${nr}: ${afg}. Begrundelse: ${begrundelse}`,
  firmaTitel: "En klage over jer er afgjort",
  firmaTekst: (nr: number, afg: string, begrundelse: string) =>
    `Klage nr. ${nr}: ${afg}. Begrundelse: ${begrundelse}`,
} as const;

// Admin → Erhverv → Firmaer → [firma]: firmakontoen (chef og sælger-rollen).
export const FIRMA_KONTO = {
  titel: "Firmakontoen",
  forklaring:
    "Luk, suspendér eller åbn firmakontoen igen. Firmaet får en begrundelse på mail og kan klage (som ved alle andre indgreb). Alt logges.",
  status: "Status",
  aktiv: "Aktiv",
  lukket: (d: string) => `Lukket permanent ${d}. Kontoen kan kun åbnes igen, hvis firmaet får medhold i en klage.`,
  suspenderetPermanent: "Suspenderet permanent",
  suspenderetTil: (d: string) => `Suspenderet til ${d}`,
  aarsag: "Årsag",
  knapLuk: "Luk firmakonto permanent",
  lukTitel: "Luk firmakontoen permanent?",
  lukTekst:
    "Firmaet kan ikke logge ind, og kontoen kan kun åbnes igen, hvis firmaet får medhold i en klage. Firmaets abonnement opsiges automatisk. Firmaet får begrundelsen på mail og kan klage.",
  lukBekraeft: "Ja, luk firmakontoen",
  lukPladsholder: "Fx: Firmaet har fået gentagne berettigede klager over varer, der ikke blev leveret.",
  knapSuspender: "Suspendér firmakonto",
  suspenderTitel: "Suspendér firmakontoen?",
  suspenderTekst:
    "Firmaet kan ikke logge ind, så længe suspensionen gælder. Vælg 1 dag, 7 dage eller permanent. Abonnementet kører videre, mens kontoen er suspenderet. Firmaet får begrundelsen på mail og kan klage.",
  suspenderBekraeft: "Ja, suspendér",
  suspenderPladsholder: "Fx: Firmaet har ikke svaret på vores henvendelser om flere klager.",
  knapOphaev: "Ophæv suspension",
  ophaevTitel: "Ophæv suspensionen?",
  ophaevTekst: "Firmaet kan logge ind og sælge igen med det samme.",
  ophaevBekraeft: "Ja, ophæv suspensionen",
  forslagTitel: (n: number) => `Forslag om lukning: firmaet har ${n} advarsler`,
  forslagTekst: "Efter 3 advarsler skal chefen eller sælger-rollen tage stilling til, om firmakontoen lukkes.",
  knapGodkend: "Godkend lukning",
  godkendTitel: "Luk firmakontoen efter 3 advarsler?",
  godkendTekst:
    "Kontoen lukkes permanent og kan kun åbnes igen, hvis firmaet får medhold i en klage. Firmaets abonnement opsiges automatisk. Firmaet får begrundelsen på mail og kan klage.",
  godkendNote: "Intern note (kun staff)",
  knapAfvis: "Afvis forslag",
  afvisTitel: "Afvis forslaget om lukning?",
  afvisTekst: "Firmakontoen forbliver åben, og firmaet får ingen besked. En ny advarsel giver et nyt forslag.",
  afvisBegrundelse: "Hvorfor skal kontoen ikke lukkes? (kun staff)",
  // Besked til firmaet, når suspensionen ophæves (påkrævet type 'afgoerelse').
  ophaevetBeskedTitel: "Din konto er åbnet igen",
  ophaevetBeskedTekst: "BidHamr har ophævet suspensionen af jeres firmakonto. I kan logge ind og sælge igen.",
} as const;

export const FIRMA_KONTO_FEJL = {
  ingen_adgang: "Kun chefen og sælger-rollen kan gøre dette.",
  kun_erhverv: "Kun chefen og sælger-rollen kan gøre dette ved en firmakonto.",
  ikke_fundet: "Findes ikke længere. Opdater siden.",
  ikke_firma: "Det er ikke en firmakonto.",
  regel_mangler: "Vælg hvilken regel eller lov, firmaet bryder.",
  fakta_mangler: "Skriv en begrundelse til firmaet: hvad har firmaet gjort?",
  for_lang_tekst: "En af teksterne er for lang (højst 2000 tegn).",
  ugyldig_varighed: "Vælg, hvor længe kontoen skal suspenderes.",
  begrundelse_mangler: "Skriv en begrundelse.",
  bortfaldet: "Kontoen var allerede lukket. Forslaget er markeret som bortfaldet.",
  behandlet: "Forslaget er allerede behandlet. Opdater siden.",
  lukket: "Kontoen er lukket permanent. Den kan kun åbnes igen, hvis firmaet får medhold i en klage.",
  allerede_lukket: "Kontoen er allerede lukket permanent.",
  inhabil: "Du kan ikke behandle dette firma, fordi du selv har handlet med det. Bed en kollega om at gøre det.",
  sig_selv: "Du kan ikke gøre dette mod dig selv.",
  ugyldig_bruger: "Kontoen findes ikke.",
} as const;
