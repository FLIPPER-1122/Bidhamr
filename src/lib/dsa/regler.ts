// Digital Services Act (DSA): lister og tekster, som både sider, klient-
// komponenter og server actions bruger. Ingen server-only-import.
//
// SKAL matche supabase/migrations/20261009010000_dsa.sql (dsa_regler(),
// check-listerne på dsa_anmeldelser / dsa_afgoerelser og dsa_min_rolle()).
// Beslutningerne står i ROADMAP-BESLUTNINGER.md, afsnit "DSA".

// Grænser (også håndhævet i databasen).
export const DSA_BEGRUNDELSE_MIN = 10;
export const DSA_BEGRUNDELSE_MAKS = 2000;
export const DSA_NAVN_MAKS = 100;
export const DSA_EMAIL_MAKS = 254;
export const DSA_FAKTA_MAKS = 2000;
export const DSA_KLAGE_MAANEDER = 6;

// Kontaktpunkt for myndigheder og brugere (art. 11-12).
// TODO Filip: opret postkassen dsa@bidhamr.dk (eller vælg en anden adresse).
export const DSA_KONTAKT_EMAIL = "dsa@bidhamr.dk";

// ------------------------------------------------------------------ Anmeldelser

export type AnmeldKategori =
  | "forbudt_vare"
  | "falske_varer"
  | "svindel"
  | "ophavsret"
  | "personoplysninger"
  | "hadefuld_tale"
  | "misbrug_boern"
  | "vilkaar"
  | "andet";

export const ANMELD_KATEGORIER: readonly { vaerdi: AnmeldKategori; label: string; hjaelp: string }[] = [
  { vaerdi: "forbudt_vare", label: "Forbudt eller ulovlig vare", hjaelp: "Fx våben, narkotika eller levende dyr." },
  { vaerdi: "falske_varer", label: "Falsk vare eller kopi af et mærke", hjaelp: "Varen ser ud til at være en kopi solgt som ægte." },
  { vaerdi: "svindel", label: "Svindel eller vildledning", hjaelp: "Fx en auktion, der prøver at snyde købere." },
  { vaerdi: "ophavsret", label: "Krænkelse af ophavsret", hjaelp: "Fx dine egne billeder eller tekster brugt uden lov." },
  { vaerdi: "personoplysninger", label: "Personoplysninger", hjaelp: "Fx navn, adresse eller billeder af en anden person." },
  { vaerdi: "hadefuld_tale", label: "Hadefuld, truende eller ulovlig tale", hjaelp: "Fx trusler eller hån af en gruppe." },
  { vaerdi: "misbrug_boern", label: "Seksuelt misbrug af børn", hjaelp: "Du behøver ikke oplyse navn og e-mail." },
  { vaerdi: "vilkaar", label: "Bryder BidHamrs regler", hjaelp: "Fx chikane, spam eller handel uden om BidHamr." },
  { vaerdi: "andet", label: "Andet", hjaelp: "Beskriv, hvad der er galt." },
];

export function erAnmeldKategori(v: unknown): v is AnmeldKategori {
  return typeof v === "string" && ANMELD_KATEGORIER.some((k) => k.vaerdi === v);
}

export function anmeldKategoriNavn(v: string): string {
  return ANMELD_KATEGORIER.find((k) => k.vaerdi === v)?.label ?? v;
}

// Art. 16(2)(c): navn og e-mail kan udelades ved misbrug af børn.
export function kraeverKontaktoplysninger(kategori: string): boolean {
  return kategori !== "misbrug_boern";
}

export type IndholdType =
  | "auktion"
  | "profil"
  | "spoergsmaal"
  | "spoergsmaal_svar"
  | "bedoemmelse"
  | "bedoemmelse_svar"
  | "andet";

export const INDHOLD_NAVNE: Record<IndholdType, string> = {
  auktion: "Auktion",
  profil: "Profil",
  spoergsmaal: "Spørgsmål til en auktion",
  spoergsmaal_svar: "Sælgers svar på et spørgsmål",
  bedoemmelse: "Bedømmelse",
  bedoemmelse_svar: "Sælgers svar på en bedømmelse",
  andet: "Andet indhold",
};

export function erIndholdType(v: unknown): v is IndholdType {
  return typeof v === "string" && v in INDHOLD_NAVNE;
}

export function indholdNavn(v: string): string {
  return INDHOLD_NAVNE[v as IndholdType] ?? v;
}

export const UDFALD_NAVNE: Record<string, string> = {
  indgreb: "Indholdet er fjernet eller begrænset",
  ingen_overtraedelse: "Ingen overtrædelse – indholdet bliver",
  ikke_fundet: "Indholdet kunne ikke findes",
};

// Interne frister (vises i admin). Matcher dsa_anmeldelse_opret og dsa_klager.
export const FRIST_TIMER_NORMAL = 7 * 24;
export const FRIST_TIMER_HASTER = 24;
export const KLAGE_FRIST_DAGE = 14;

// ------------------------------------------------------------------ Regler for indgreb

export type DsaRegel = {
  kode: string;
  navn: string;
  grundlag: "lov" | "vilkaar";
  henvisning: string;
};

// Spejl af dsa_regler() i SQL. Henvisningerne er foreløbige (afventer advokat).
export const DSA_REGLER: readonly DsaRegel[] = [
  { kode: "forbudt_vare", navn: "Varen må ikke sælges på BidHamr", grundlag: "vilkaar", henvisning: "BidHamrs regler om forbudte varer, se bidhamr.dk/forbudte-varer" },
  { kode: "ulovlig_vare", navn: "Varen er ulovlig at sælge", grundlag: "lov", henvisning: "Dansk lovgivning, fx våbenloven, lov om euforiserende stoffer og dyrevelfærdsloven" },
  { kode: "falsk_vare", navn: "Kopivare eller krænkelse af et varemærke", grundlag: "lov", henvisning: "Varemærkeloven" },
  { kode: "ophavsret", navn: "Krænkelse af ophavsret (fx kopierede billeder)", grundlag: "lov", henvisning: "Ophavsretsloven" },
  { kode: "svindel", navn: "Svindel eller vildledning", grundlag: "lov", henvisning: "Straffeloven § 279 og BidHamrs regler" },
  { kode: "personoplysninger", navn: "Deling af andres personoplysninger", grundlag: "lov", henvisning: "Databeskyttelsesforordningen (GDPR)" },
  { kode: "hadefuld_tale", navn: "Hadefuld eller truende tale", grundlag: "lov", henvisning: "Straffeloven §§ 266 og 266 b" },
  { kode: "misbrug_boern", navn: "Seksuelt misbrug af børn", grundlag: "lov", henvisning: "Straffeloven § 235" },
  { kode: "chikane", navn: "Grove ord eller chikane", grundlag: "vilkaar", henvisning: "BidHamrs regler for god opførsel" },
  { kode: "kontaktinfo", navn: "Kontaktoplysninger eller handel uden om BidHamr", grundlag: "vilkaar", henvisning: "BidHamrs regler for handel på BidHamr" },
  { kode: "ikke_relateret", navn: "Indholdet handler ikke om handlen", grundlag: "vilkaar", henvisning: "BidHamrs regler for bedømmelser og spørgsmål" },
  { kode: "spam", navn: "Spam eller reklame", grundlag: "vilkaar", henvisning: "BidHamrs regler for god opførsel" },
  { kode: "gentagne_overtraedelser", navn: "Gentagne overtrædelser (3 advarsler)", grundlag: "vilkaar", henvisning: "BidHamrs regler om advarsler" },
  { kode: "andet", navn: "Andet brud på BidHamrs regler", grundlag: "vilkaar", henvisning: "BidHamrs regler" },
];

// Valg i admin-dialogerne (kontolukning efter 3 advarsler sættes automatisk).
export const REGEL_VALG = DSA_REGLER.filter((r) => r.kode !== "gentagne_overtraedelser").map((r) => ({
  value: r.kode,
  label: `${r.navn}${r.grundlag === "lov" ? " (lov)" : ""}`,
}));

export function erRegel(v: unknown): boolean {
  return typeof v === "string" && DSA_REGLER.some((r) => r.kode === v);
}

export function regelNavn(kode: string): string {
  return DSA_REGLER.find((r) => r.kode === kode)?.navn ?? kode;
}

// Anmeldelsens kategori -> det mest oplagte regelvalg i admin.
export const KATEGORI_TIL_REGEL: Record<string, string> = {
  forbudt_vare: "forbudt_vare",
  falske_varer: "falsk_vare",
  svindel: "svindel",
  ophavsret: "ophavsret",
  personoplysninger: "personoplysninger",
  hadefuld_tale: "hadefuld_tale",
  misbrug_boern: "misbrug_boern",
  vilkaar: "andet",
  andet: "andet",
};

export const GRUNDLAG_NAVNE: Record<string, string> = {
  lov: "Ulovligt indhold (lovgivning)",
  vilkaar: "Brud på BidHamrs regler",
};

// ------------------------------------------------------------------ Indgreb

export type DsaHandling =
  | "auktion_skjult"
  | "auktion_fjernet"
  | "auktion_annulleret"
  | "spoergsmaal_skjult"
  | "bedoemmelse_skjult"
  | "bedoemmelse_svar_skjult"
  | "konto_suspenderet"
  | "konto_lukket";

// Hvad der er gjort - set fra brugeren.
export const HANDLING_BRUGER: Record<DsaHandling, string> = {
  auktion_skjult: "Din auktion er skjult",
  auktion_fjernet: "Din auktion er fjernet",
  auktion_annulleret: "Din auktion er stoppet",
  spoergsmaal_skjult: "Dit indlæg under en auktion er skjult",
  bedoemmelse_skjult: "Din bedømmelse er skjult",
  bedoemmelse_svar_skjult: "Dit svar på en bedømmelse er skjult",
  konto_suspenderet: "Din konto er suspenderet",
  konto_lukket: "Din konto er lukket",
};

// Kort forklaring af konsekvensen.
export const HANDLING_KONSEKVENS: Record<DsaHandling, string> = {
  auktion_skjult: "Auktionen kan ikke længere ses af andre. Var den i gang, er den sat på pause, så den ikke slutter, mens den er skjult. Den er ikke slettet.",
  auktion_fjernet: "Auktionen er stoppet og kan ikke længere ses af andre. Den er ikke slettet.",
  auktion_annulleret: "Auktionen er stoppet, og der kan ikke længere bydes.",
  spoergsmaal_skjult: "Teksten kan ikke længere ses af andre. Den er ikke slettet.",
  bedoemmelse_skjult: "Bedømmelsen kan ikke længere ses af andre og tæller ikke med i sælgerens gennemsnit. Den er ikke slettet.",
  bedoemmelse_svar_skjult: "Svaret kan ikke længere ses af andre. Det er ikke slettet.",
  konto_suspenderet: "Du kan ikke logge ind, byde eller sælge, så længe suspensionen varer.",
  konto_lukket: "Du kan ikke længere bruge din konto.",
};

// Navne i admin og i rapporten.
export const HANDLING_NAVNE: Record<DsaHandling, string> = {
  auktion_skjult: "Auktion skjult",
  auktion_fjernet: "Auktion fjernet",
  auktion_annulleret: "Auktion stoppet",
  spoergsmaal_skjult: "Spørgsmål/svar skjult",
  bedoemmelse_skjult: "Bedømmelse skjult",
  bedoemmelse_svar_skjult: "Svar på bedømmelse skjult",
  konto_suspenderet: "Konto suspenderet",
  konto_lukket: "Konto lukket permanent",
};

export function handlingNavn(h: string): string {
  return HANDLING_NAVNE[h as DsaHandling] ?? h;
}

export function erDsaHandling(v: unknown): v is DsaHandling {
  return typeof v === "string" && v in HANDLING_NAVNE;
}

// Matcher dsa_min_rolle() i SQL.
export function handlingKraeverAdmin(h: string): boolean {
  return h === "auktion_skjult" || h === "auktion_fjernet" || h === "auktion_annulleret" || h === "konto_lukket";
}

// De indgreb, der giver mening for en type indhold.
export function handlingerFor(type: string): DsaHandling[] {
  switch (type) {
    case "auktion":
      return ["auktion_fjernet", "auktion_skjult", "auktion_annulleret"];
    case "spoergsmaal":
    case "spoergsmaal_svar":
      return ["spoergsmaal_skjult"];
    case "bedoemmelse":
      return ["bedoemmelse_skjult"];
    case "bedoemmelse_svar":
      return ["bedoemmelse_svar_skjult"];
    case "profil":
      return ["konto_suspenderet", "konto_lukket"];
    default:
      return [];
  }
}

export const KLAGE_UDFALD_NAVNE: Record<string, string> = {
  medhold: "Du har fået medhold",
  fastholdt: "Afgørelsen er fastholdt",
};

// Andre klagemuligheder (art. 17(3)(f), 21). Foreløbig tekst – afventer advokat.
export const ANDRE_KLAGEMULIGHEDER =
  "Er du stadig uenig, efter vi har behandlet din klage, kan du indbringe sagen for et godkendt udenretligt tvistbilæggelsesorgan efter EU's forordning om digitale tjenester (artikel 21) eller for domstolene.";

// Tidspunktet nu (til frister i server components).
export function nuMs(): number {
  return Date.now();
}
