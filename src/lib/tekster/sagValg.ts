// Fælles tabel for "Meld et problem" (Filip, 27. okt. 2026 - flowet i
// showcase/opret-sag-showcase.html er godkendt, ROADMAP-BESLUTNINGER afsnit 4).
// Bruges af hjemmesiden OG appen (appen får tabellen fra
// POST /api/sag/app/muligheder, så teksterne er ens - docs/APP-ENDPOINTS.md).
//
// Køberen vælger et hverdagsvalg; systemet vælger sagstypen bag kulisserne.
// Køberen ser aldrig ordet "svindel". Staff kan rette typen bagefter
// (sag_ret_type).
//
// Regler for teksterne: BidHamr holder aldrig pengene - skriv "Sælgeren får
// ikke pengene, mens sagen kører" og "Betalingen håndteres af vores
// betalingspartner Stripe". Lov ingen frister, der ikke findes (sælgerens
// svarfrist er til sælgeren, ikke et løfte om en afgørelse).
// Ingen server-only-import: frontend må gerne bruge filen.
import { sagRefusionOere, type Prismodel } from "@/lib/betaling/beregn";
import { kroner } from "@/lib/kroner";
import {
  SAG_BESKRIVELSE_MAKS,
  SAG_BESKRIVELSE_MIN,
  SAG_MAKS_BILLEDER,
  SAG_SMIDT_UD_BEGRUNDELSE_MAKS,
  SAG_SMIDT_UD_BEGRUNDELSE_MIN,
  SAG_SVAR_FRIST_TIMER,
  SAG_SVAR_MAKS,
  SAG_SVAR_MAKS_BILLEDER,
  SAG_SVAR_MIN,
  type SagBilledeKategori,
  type SagType,
} from "@/lib/sager";

export const SAG_VALG_IDER = ["stykker", "annonce", "anden_vare", "tom", "ikke_kommet", "andet"] as const;
export type SagValgId = (typeof SAG_VALG_IDER)[number];

export type SagValg = {
  id: SagValgId;
  // Store knapper i trin 1.
  navn: string;
  undertekst: string;
  // Undertekst, når fragtfirmaet har meldt pakken leveret (kun ikke_kommet).
  undertekstLeveret?: string;
  // Sagstypen, valget bliver til (sag_opret p_type).
  type: SagType;
  // Skal varen sendes retur, hvis køberen får ret?
  retur: boolean;
  // Billede 2 ("indholdet") - overskrift og hjælp følger valget.
  indholdTitel: string;
  indholdHjaelp: string;
  // Forslag i trin 3 (tryk for at bruge).
  tekstforslag: string[];
  // "Det skal du gøre nu" på kvitteringen.
  goerNu: string;
};

export const SAG_VALG: Record<SagValgId, SagValg> = {
  stykker: {
    id: "stykker",
    navn: "Varen er i stykker",
    undertekst: "Den er gået i stykker på vejen",
    type: "skadet",
    retur: true,
    indholdTitel: "Skaden tæt på",
    indholdHjaelp: "Vis det, der er gået i stykker.",
    tekstforslag: [
      "Det ene ben er knækket.",
      "Pakken var mast udefra.",
      "Varen var ikke pakket ind i noget.",
      "Jeg opdagede det, da jeg åbnede pakken.",
    ],
    goerNu: "Gem varen og pakken, til sagen er afgjort. Du skal måske sende varen retur.",
  },
  annonce: {
    id: "annonce",
    navn: "Varen passer ikke med annoncen",
    undertekst: "Fx fejl eller mangler, som ikke stod i annoncen",
    type: "ikke_som_beskrevet",
    retur: true,
    indholdTitel: "Det, der er galt",
    indholdHjaelp: "Vis fejlen eller manglen tæt på.",
    tekstforslag: [
      "Der er en revne, som ikke stod i annoncen.",
      "Varen er slidt meget mere end på billederne.",
      "Der mangler en del.",
      "Materialet er ikke det, der stod i annoncen.",
    ],
    goerNu: "Gem varen og pakken, til sagen er afgjort. Du skal måske sende varen retur.",
  },
  anden_vare: {
    id: "anden_vare",
    navn: "Det er ikke den vare, jeg købte",
    undertekst: "En helt anden ting – eller en kopi",
    type: "svindel",
    retur: false,
    indholdTitel: "Det, der lå i pakken",
    indholdHjaelp: "Vis den vare, du har fået.",
    tekstforslag: [
      "Der lå en helt anden ting i pakken.",
      "Det er en kopi, ikke den ægte vare.",
      "Mærket mangler på varen.",
    ],
    goerNu: "Gem pakken og det, der lå i den, til sagen er afgjort.",
  },
  tom: {
    id: "tom",
    navn: "Pakken var tom",
    undertekst: "Der lå ingenting i pakken",
    type: "svindel",
    retur: false,
    indholdTitel: "Den åbne, tomme pakke (valgfrit)",
    indholdHjaelp: "Har du et billede af den åbne pakke, så tilføj det gerne.",
    tekstforslag: [
      "Pakken var tom, da jeg åbnede den.",
      "Pakken var meget let, da jeg hentede den.",
      "Tapen var skåret op.",
    ],
    goerNu: "Gem pakken og det, der lå i den, til sagen er afgjort.",
  },
  ikke_kommet: {
    id: "ikke_kommet",
    navn: "Jeg har ikke fået pakken",
    undertekst: "Pakken er ikke kommet frem",
    undertekstLeveret: "Der står, at den er leveret, men jeg har den ikke",
    type: "bortkommet",
    retur: false,
    indholdTitel: "",
    indholdHjaelp: "",
    tekstforslag: [
      "Pakkeshoppen kan ikke finde pakken.",
      "Jeg har ikke fået nogen kode til at hente den.",
      "Der står leveret, men den var ikke i pakkeshoppen.",
    ],
    goerNu: "Du skal ikke gøre noget nu. Vi tjekker sporingen hos fragtfirmaet og skriver til dig, hvis vi har brug for mere.",
  },
  andet: {
    id: "andet",
    navn: "Noget andet",
    undertekst: "Forklar det med dine egne ord",
    type: "andet",
    retur: true,
    indholdTitel: "Det, der er galt",
    indholdHjaelp: "Vis problemet så tydeligt som muligt.",
    tekstforslag: ["Jeg er ikke sikker på, hvad jeg skal vælge.", "Varen virker ikke."],
    goerNu: "Gem varen og pakken, til sagen er afgjort.",
  },
};

// Billederne i trin 2. Rækkefølgen er den, de tages i.
export type SagBilledKrav = {
  kategori: SagBilledeKategori;
  titel: string;
  hjaelp: string;
  // Påkrævet (ved "pakken er smidt ud" er pakkebilledet ikke påkrævet; ved
  // en tom pakke er indholdsbilledet valgfrit).
  paakraevet: boolean;
};

export const SAG_PAKKE_BILLEDE = {
  titel: "Pakken med labelen",
  hjaelp: "Hele pakken, så man kan se, om den er mast, og så labelen kan læses.",
} as const;

export const SAG_BILLEDER_INTRO = "Så kan vi se, hvad der er sket. Det tager under et minut.";
export const SAG_BILLEDER_HJAELP =
  'Tag billederne i godt lys. Har du allerede taget billeder, kan du vælge dem under "Fra billeder" i kameraet. Du kan tilføje flere billeder senere.';

// "Pakken er smidt ud" (regel 2): sagen kan oprettes uden pakkebillede, med en
// forklaring på mindst 20 tegn. BidHamr vurderer forklaringen.
export const SAG_SMIDT_UD = {
  knap: "Jeg har ikke pakken længere",
  titel: "Hvorfor har du ikke pakken?",
  hjaelp: "Skriv kort, hvad der er sket med pakken. BidHamr vurderer din forklaring sammen med de andre billeder.",
  forslag: ["Jeg smed papkassen ud, før jeg opdagede problemet.", "Pakken blev smidt ud ved en fejl."],
} as const;

// billederKraeves: pakken er modtaget (hentSagMuligheder.billederKraeves) og
// valget er ikke "ikke kommet frem" efter leveringsmelding.
// Tom pakke (Filip, 27. okt. 2026): kun billedet af pakken med labelen er
// påkrævet - billedet af den åbne, tomme pakke er valgfrit, og "pakken er
// smidt ud" er ikke mulig (pakken er selve beviset). sag_opret håndhæver det,
// når klienten sender valget (p_valg).
export function sagBilledKrav(valg: SagValg, billederKraeves: boolean, pakkeSmidtUd = false): SagBilledKrav[] {
  if (!billederKraeves || valg.type === "bortkommet") return [];
  if (valg.id === "tom") {
    return [
      { kategori: "pakke_label", titel: SAG_PAKKE_BILLEDE.titel, hjaelp: SAG_PAKKE_BILLEDE.hjaelp, paakraevet: true },
      { kategori: "indhold", titel: valg.indholdTitel, hjaelp: valg.indholdHjaelp, paakraevet: false },
    ];
  }
  return [
    { kategori: "pakke_label", titel: SAG_PAKKE_BILLEDE.titel, hjaelp: SAG_PAKKE_BILLEDE.hjaelp, paakraevet: !pakkeSmidtUd },
    { kategori: "indhold", titel: valg.indholdTitel, hjaelp: valg.indholdHjaelp, paakraevet: true },
  ];
}

// Kan "Jeg har ikke pakken længere" vælges? Kun hvor pakkebilledet ellers
// kræves, og ikke ved en tom pakke.
export function sagSmidtUdMulig(valg: SagValg, billeder: readonly SagBilledKrav[]): boolean {
  return valg.id !== "tom" && billeder.some((x) => x.kategori === "pakke_label");
}

// Trin 3.
export const SAG_TEKST = {
  titel: "Fortæl kort, hvad der er sket",
  hjaelp: "Et par sætninger er nok. Sælgeren kan også læse det.",
  forslagIntro: "Tryk på et forslag for at bruge det:",
  for_kort: "Skriv mindst 10 tegn – eller tryk på et forslag",
  godt: "Godt – du kan altid skrive mere i sagen bagefter",
} as const;

// Trin 4: "Det sker, når du sender".
export const SAG_DET_SKER = [
  "Sælgeren får ikke pengene, mens sagen kører.",
  "Sælgeren får besked og kan se det, du har skrevet, og dine billeder.",
  "BidHamr ser på sagen. Vi skriver til dig her, hvis vi har brug for mere.",
  "Du får besked, hver gang der sker noget i sagen.",
] as const;

export const SAG_KVITTERING = {
  titel: "Tak – vi har fået din sag",
  tekst: "Sælgeren får ikke pengene, mens vi ser på sagen. Du får besked, når der sker noget.",
} as const;

export const SAG_STRIPE = "Betalingen håndteres af vores betalingspartner Stripe.";

// Handlens beløb (fra køberens egen betaling) til "Hvis du får ret".
export type SagBeloeb = {
  prismodel?: Prismodel | null;
  bud_oere: number;
  total_oere: number;
  beskyttelse_oere: number | null;
  // Returfragten, køberen betaler ved "ikke som beskrevet" (= fragten ud).
  returfragt_oere?: number | null;
};

// "Hvis du får ret"-teksten (trin 3 og 4). Beløbet regnes med samme regel som
// databasen (sag_refusion_oere med sagstypen).
export function sagHvisDuFaarRet(valg: SagValg, b: SagBeloeb | null): string {
  if (valg.type === "andet") {
    return "BidHamr ser på, hvad der er sket, og finder den rigtige type sag. Hvad du får tilbage, og om varen skal sendes retur, står i afgørelsen.";
  }
  const ankeNote = "Pengene sendes, når de 4 dage til at anke er gået.";
  if (!b) {
    if (valg.type === "bortkommet" || valg.type === "skadet") {
      return valg.retur
        ? "Får du ret, sender du varen retur til sælgeren. Du betaler ikke returfragten. Når pakken er afleveret, får du hele beløbet tilbage – bud, gebyr og fragt."
        : `Får du ret, får du hele beløbet tilbage – bud, gebyr og fragt. ${ankeNote}`;
    }
    return valg.retur
      ? "Får du ret, sender du varen retur til sælgeren og betaler selv returfragten. Når pakken er afleveret, får du dit bud tilbage."
      : `Får du ret, får du dit bud tilbage. Du skal ikke sende noget retur. ${ankeNote}`;
  }
  const r = sagRefusionOere(b, valg.type);
  const hele = r === Number(b.total_oere);
  const kun_bud = r === Number(b.bud_oere) && !hele;
  const hvad = hele
    ? `hele beløbet på ${kroner(r)} tilbage – bud, gebyr og fragt`
    : kun_bud
      ? `dit bud på ${kroner(r)} tilbage`
      : `${kroner(r)} tilbage`;
  const ikkeGebyr = kun_bud ? " Gebyr og fragt får du ikke tilbage." : "";
  if (valg.type === "skadet") {
    return `Får du ret, sender du varen retur til sælgeren. Du betaler ikke returfragten. Når pakken er afleveret, får du ${hvad}.`;
  }
  if (valg.retur) {
    const rf = b.returfragt_oere ? `Returfragten koster ${kroner(Number(b.returfragt_oere))}, og den betaler du. ` : "Returfragten betaler du selv. ";
    return `Får du ret, sender du varen retur til sælgeren. ${rf}Når pakken er afleveret, får du ${hvad}.${ikkeGebyr}`;
  }
  return `Får du ret, får du ${hvad}. Du skal ikke sende noget retur.${ikkeGebyr} ${ankeNote}`;
}

// Hvilke valg kan køberen vælge, ud fra de sagstyper, databasen tillader nu
// (hentSagMuligheder.typer)? Rækkefølgen er showcasens.
export function sagValgFor(typer: readonly SagType[]): SagValg[] {
  return SAG_VALG_IDER.map((id) => SAG_VALG[id]).filter((v) => typer.includes(v.type));
}

export function erSagValgId(v: unknown): v is SagValgId {
  return typeof v === "string" && (SAG_VALG_IDER as readonly string[]).includes(v);
}

// Problemet i hverdagsord til køber og sælger (sagssiden, kvitteringen og
// notifikationerne). SAG_TYPE_NAVN (fx "Svindel ...") er kun til staff.
// Gamle sager har ingen koeber_valg - så bruges en neutral tekst pr. type.
export const SAG_TYPE_NEUTRAL: Record<SagType, string> = {
  bortkommet: "Pakken er ikke kommet frem",
  skadet: "Varen er gået i stykker",
  ikke_som_beskrevet: "Varen passer ikke med annoncen",
  svindel: "Pakken eller varen var ikke, som den skulle være",
  andet: "Noget andet",
};

export function sagProblemTekst(type: SagType, koeberValg: string | null | undefined): string {
  return erSagValgId(koeberValg) ? SAG_VALG[koeberValg].navn : SAG_TYPE_NEUTRAL[type];
}

// Til sælgeren (regel 3).
export const SAG_SAELGER_SVAR = {
  titel: "Giv din forklaring",
  hjaelp: "BidHamr læser den, før sagen afgøres. Køberen kan også se den.",
  forslag: [
    "Varen var hel, da jeg sendte den.",
    "Jeg pakkede den i bobleplast og en solid kasse.",
    "Fejlen stod i annoncen.",
    "Jeg er enig – køberen skal have pengene tilbage.",
  ],
  billederTitel: "Billeder (valgfrit)",
  billederHjaelp: "Fx billeder af varen, før du sendte den.",
  efterFrist: "Fristen for at give din forklaring er udløbet. BidHamr skriver til dig, hvis vi har brug for mere.",
} as const;

// ------------------------------------------------------------------ Skærmene
// Faste tekster til "Meld et problem" (4 trin, kvittering, handelssiden og
// sagssiden) - fælles for hjemmesiden og appen. Pladsholdere i {krøllede}
// udfyldes med sagUdfyld() (appen får teksterne som JSON, så der er ingen
// funktioner her).
export const SAG_FLOW = {
  titel: "Meld et problem",
  tilbage: "Tilbage",
  luk: "Luk",
  annuller: "Annullér",
  naeste: "Næste",
  trin: "Trin {n} af {ialt}",
  // Handelssiden: "Hvordan er varen?" øverst, når en sag kan oprettes.
  handel: {
    leveretTitel: "Pakken er leveret – tjek varen",
    leveretTekst: "Sælgeren får først pengene, når du har godkendt varen.",
    hvordan: "Hvordan er varen?",
    altIOrden: "Alt er i orden",
    altIOrdenUnder: "Godkend varen",
    problem: "Der er et problem med varen",
    problemUnder: "Meld det her",
    gemPakken: "Gem pakken og labelen, til du har godkendt. Du skal tage billeder af dem, hvis der er et problem.",
    fristTitel: "Du har {tid} til at melde et problem",
    fristUnder: "Senest {dato}",
    udloebetTitel: "Fristen for at melde et problem er udløbet",
    udloebetTekst: "Fristen udløb {dato}. Du kan ikke længere melde et problem med varen.",
    ikkeKommetTitel: "Er pakken ikke kommet?",
    ikkeKommet: "Jeg har ikke fået pakken",
    ikkeKommetVenter: "Pakker kan være nogle dage undervejs. Er den ikke kommet {dato}, kan du melde det her. Knappen kommer frem af sig selv.",
    ikkeKommetNu: "Pakken burde være kommet frem nu. Har du ikke fået den, kan du melde det senest {dato}.",
    kraeverBeskyttelseErhverv:
      "Køb fra et firma er ikke dækket af BidHamr Beskyttelse. Er varen gået i stykker eller ikke som beskrevet, så kontakt firmaet – du har reklamationsret efter loven.",
    // Fast tekst (ingen sagstyper - køber og sælger ser aldrig staff-navnene).
    kraeverBeskyttelse:
      "Uden BidHamr Beskyttelse kan du ikke oprette en sag, hvis varen er gået i stykker, ikke passer med annoncen eller har et andet problem. Skriv i stedet til sælgeren i chatten.",
    laesMere: "Læs mere",
  },
  // Trin 1-4.
  trin1: {
    titel: "Hvad er der galt?",
    hjaelp: "Vælg det, der passer bedst. Du kan forklare mere bagefter.",
    note: "Sælgeren får ikke pengene, mens vi ser på det.",
  },
  trin2: {
    titelEn: "Tag 1 billede",
    titelFlere: "Tag {antal} billeder",
    eksempel: "Sådan",
    ditBillede: "Dit billede",
    mangler: "Mangler",
    valgfrit: "Valgfrit",
    taget: "Taget",
    tagBillede: "Tag billede",
    tagFlere: "Tag et billede mere",
    vaelgFil: "Vælg fra dine billeder",
    fjern: "Fjern billedet",
    status: "{taget} af {ialt} billeder",
    alleTaget: "Alle billeder er taget",
    manglerFejl: "Tag de billeder, der mangler, før du går videre.",
    smidtUdFortryd: "Jeg har pakken alligevel",
    smidtUdValgt: "Du har ikke pakken længere. Forklar hvorfor i næste trin.",
  },
  trin3: {
    label: "Hvad er der sket?",
    pladsholder: "Fx: Det ene ben var knækket, da jeg åbnede pakken i går aftes.",
    smidtUdPladsholder: "Fx: Jeg smed papkassen ud, før jeg opdagede skaden.",
    smidtUdForKort: "Skriv mindst {min} tegn om, hvorfor du ikke har pakken",
  },
  hvisDuFaarRet: "Hvis du får ret",
  trin4: {
    titel: "Tjek og send",
    varen: "Varen",
    problem: "Problem",
    billeder: "Billeder",
    tekst: "Det har du skrevet",
    smidtUd: "Hvorfor du ikke har pakken",
    ingenBilleder: "Ingen billeder",
    ret: "Ret",
    detSker: "Det sker, når du sender",
    send: "Send til BidHamr",
    uploader: "Sender billeder: {n} af {ialt}",
    opretter: "Sender sagen …",
  },
  // Kvitteringen efter oprettelsen.
  kvittering: {
    goerNu: "Det skal du gøre nu",
    videre: "Sådan går det videre",
    trin: [
      "Sælgeren får besked nu og kan give sin forklaring inden for {timer} timer – senest {dato}.",
      "BidHamr ser på sagen og giver jer begge besked om afgørelsen.",
      "Efter afgørelsen har I {dage} dage til at anke, hvis en af jer er uenig.",
    ],
    seSag: "Se din sag",
  },
  // Desktop: boksen til højre.
  side: {
    bud: "Bud: {beloeb}",
    fristTid: "{tid} tilbage",
    fristUnder: "til at melde et problem (senest {dato})",
  },
  // /mine-handler/[id]/sag, når der ikke kan oprettes en sag.
  ikkeMulig: {
    titel: "Du kan ikke melde et problem lige nu",
    udloebet: "Fristen for at melde et problem udløb {dato}.",
    forTidligt: "Er pakken ikke kommet frem, kan du melde det fra {dato}.",
    generelt: "Der kan ikke oprettes en sag på handlen lige nu.",
    tilbage: "Tilbage til handlen",
  },
  // Sagssiden (handelssiden #sag) for køber og sælger.
  sag: {
    titelKoeber: "Din sag",
    titelSaelger: "Sag fra køberen",
    meldt: "Sendt {dato}",
    meldtSaelger: "Køberen har meldt et problem: {problem}",
    goerNu: "Det skal du gøre nu",
    endte: "Sådan endte sagen",
    videre: "Sådan går det videre",
    tidslinje: {
      oprettetKoeber: "Du har meldt problemet",
      oprettetSaelger: "Køberen har meldt et problem",
      behandler: "BidHamr ser på sagen",
      behandlerNoteKoeber: "Vi ser på dine billeder og på sælgerens billeder af indpakningen.",
      behandlerNoteSaelger: "Vi ser på køberens billeder og på dine billeder af indpakningen.",
      afgjort: "Afgørelse",
      afgjortNote: "I får besked med det samme.",
      anke: "Anke",
      ankefrist: "4 dage til at anke",
      retur: "Send varen retur",
      slutPenge: "Pengene er på vej",
      slutSendt: "Pengene er sendt",
      slutLukket: "Sagen er lukket",
    },
    duHarSendt: "Det har du sendt",
    koeberSkriver: "Det skriver køberen",
    koeberBilleder: "Køberens billeder",
    dineBilleder: "Dine billeder",
    pakkebillederSaelger: "Dine billeder af indpakningen – lagt ved sagen automatisk",
    pakkebillederKoeber: "Sælgerens billeder af indpakningen",
    pakkebillederHjaelp: "Taget, da pakken blev sendt. BidHamr bruger dem til at vurdere, om varen var pakket ordentligt.",
    smidtUd: "Køberen har ikke pakken længere",
    svarKoeber: "Sælgerens forklaring",
    svarSaelger: "Din forklaring",
    svarVenter: "Sælgeren kan give sin forklaring indtil {dato}.",
    svarIngen: "Sælgeren har ikke givet en forklaring.",
    afgoerelse: "BidHamrs afgørelse",
    returfragt: "Returfragt",
    returfragtDaekket: "Dækket – du betaler ikke returfragten",
    returfragtDaekketSaelger: "Du betaler returfragten, fordi varen ikke var pakket forsvarligt",
    returfragtBidhamr: "BidHamr betaler returfragten",
    returfragtKoeber: "Køberen betaler returfragten",
    returfragtSelv: "Du betaler selv returfragten",
    detaljer: "Se detaljer om sagen",
  },
} as const;

// Sælgerens svar på sagssiden (ud over SAG_SAELGER_SVAR).
export const SAG_SAELGER_SVAR_FORM = {
  knap: "Giv din forklaring",
  label: "Din forklaring",
  pladsholder: "Fx: Varen var hel, da jeg sendte den. Jeg pakkede den i bobleplast og en solid kasse.",
  frist: "Du kan give din forklaring én gang, indtil {dato}.",
  send: "Send til BidHamr",
  sender: "Sender …",
  tak: "Tak – din forklaring er sendt. BidHamr læser den, før sagen afgøres.",
} as const;

// Udfyld {pladsholdere} i en tekst fra SAG_FLOW.
export function sagUdfyld(tekst: string, vaerdier: Record<string, string | number>): string {
  return tekst.replace(/\{(\w+)\}/g, (hel, navn: string) => (navn in vaerdier ? String(vaerdier[navn]) : hel));
}

// Tid tilbage til en frist i hverdagsord: "1 dag og 4 timer", "5 timer og
// 12 minutter", "12 minutter". Under ét minut: "under 1 minut". Udløbet: null.
export function sagTidTilbage(fristIso: string | null | undefined, nuMs: number): string | null {
  const frist = fristIso ? Date.parse(fristIso) : NaN;
  if (Number.isNaN(frist)) return null;
  const ms = frist - nuMs;
  if (ms <= 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "under 1 minut";
  const dage = Math.floor(min / 1440);
  const timer = Math.floor((min % 1440) / 60);
  const minutter = min % 60;
  const ord = (n: number, en: string, flere: string) => `${n} ${n === 1 ? en : flere}`;
  if (dage > 0) return timer > 0 ? `${ord(dage, "dag", "dage")} og ${ord(timer, "time", "timer")}` : ord(dage, "dag", "dage");
  if (timer > 0) return minutter > 0 ? `${ord(timer, "time", "timer")} og ${ord(minutter, "minut", "minutter")}` : ord(timer, "time", "timer");
  return ord(minutter, "minut", "minutter");
}

// Alle faste tekster og grænser samlet - appen får dem fra
// POST /api/sag/app/muligheder ("tekster"), så de er ens med hjemmesiden.
export const SAG_FAELLES_TEKSTER = {
  billederIntro: SAG_BILLEDER_INTRO,
  billederHjaelp: SAG_BILLEDER_HJAELP,
  pakkeBillede: SAG_PAKKE_BILLEDE,
  smidtUd: { ...SAG_SMIDT_UD, minTegn: SAG_SMIDT_UD_BEGRUNDELSE_MIN, maksTegn: SAG_SMIDT_UD_BEGRUNDELSE_MAKS },
  tekst: { ...SAG_TEKST, minTegn: SAG_BESKRIVELSE_MIN, maksTegn: SAG_BESKRIVELSE_MAKS },
  detSker: SAG_DET_SKER,
  kvittering: SAG_KVITTERING,
  stripe: SAG_STRIPE,
  saelgerSvar: {
    ...SAG_SAELGER_SVAR,
    minTegn: SAG_SVAR_MIN,
    maksTegn: SAG_SVAR_MAKS,
    maksBilleder: SAG_SVAR_MAKS_BILLEDER,
    fristTimer: SAG_SVAR_FRIST_TIMER,
  },
  maksBilleder: SAG_MAKS_BILLEDER,
  // Skærmenes faste tekster (pladsholdere udfyldes som sagUdfyld()).
  flow: SAG_FLOW,
  saelgerSvarForm: SAG_SAELGER_SVAR_FORM,
} as const;
