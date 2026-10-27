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
    indholdTitel: "Den åbne, tomme pakke",
    indholdHjaelp: "Åbn pakken og vis, at den er tom.",
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
  // Påkrævet (ved "pakken er smidt ud" er pakkebilledet ikke påkrævet).
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
export function sagBilledKrav(valg: SagValg, billederKraeves: boolean, pakkeSmidtUd = false): SagBilledKrav[] {
  if (!billederKraeves || valg.type === "bortkommet") return [];
  return [
    { kategori: "pakke_label", titel: SAG_PAKKE_BILLEDE.titel, hjaelp: SAG_PAKKE_BILLEDE.hjaelp, paakraevet: !pakkeSmidtUd },
    { kategori: "indhold", titel: valg.indholdTitel, hjaelp: valg.indholdHjaelp, paakraevet: true },
  ];
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
} as const;
