// Erhvervskonti - fælles konstanter, typer og validering (bruges både af
// server actions og af sider/komponenter, derfor ikke "server-only").
//
// Regler: ROADMAP-BESLUTNINGER.md, "Erhvervskonti (Filip, 7. oktober 2026)".
// Database: supabase/migrations/20261010030000_erhverv.sql.

export const ERHVERV_EMAIL = "erhverv@bidhamr.dk";

export const HENVENDELSE_STATUSSER = ["ny", "i_gang", "godkendt", "afvist"] as const;
export type HenvendelseStatus = (typeof HENVENDELSE_STATUSSER)[number];

export const HENVENDELSE_STATUS_NAVN: Record<HenvendelseStatus, string> = {
  ny: "Ny",
  i_gang: "I gang",
  godkendt: "Godkendt",
  afvist: "Afvist",
};

export function erHenvendelseStatus(s: unknown): s is HenvendelseStatus {
  return typeof s === "string" && (HENVENDELSE_STATUSSER as readonly string[]).includes(s);
}

// Statusser, staff kan vælge i admin. 'afventer_betaling' (ny firmakonto,
// der ikke har betalt endnu) sættes kun af databasen og ophæves af første
// betaling (Stripe) - eller af staff ved at vælge 'aktiv' efter en aftale.
export const ABONNEMENT_STATUSSER = ["aktiv", "pauset", "opsagt"] as const;
export type AbonnementStatus = (typeof ABONNEMENT_STATUSSER)[number] | "afventer_betaling";

export const ABONNEMENT_STATUS_NAVN: Record<AbonnementStatus, string> = {
  afventer_betaling: "Venter på første betaling",
  aktiv: "Aktiv",
  pauset: "Sat på pause",
  opsagt: "Opsagt",
};

export function erAbonnementStatus(s: unknown): s is AbonnementStatus {
  return typeof s === "string" && (ABONNEMENT_STATUSSER as readonly string[]).includes(s);
}

// Feltgrænser - samme som CHECK-constraints i databasen.
export const ERHVERV_GRAENSER = {
  firmanavn: 200,
  kontaktperson: 200,
  telefonMin: 6,
  telefonMaks: 30,
  email: 254,
  adresse: 200,
  by: 100,
  hvadSaelgerI: 2000,
  besked: 4000,
  noter: 10000,
  antalVarerMaks: 10_000_000,
  pakkeNavn: 60,
  pakkeBeskrivelse: 1000,
  pakkePrisMaks: 1_000_000,
  auktionerPrUgeMaks: 1000,
  auktionerPrMaanedMaks: 100000,
  producent: 500,
  sikkerhedsoplysninger: 2000,
} as const;

export const CVR = /^[0-9]{8}$/;
// Danske postnumre er 1000-9999 (0123 er ikke et postnummer).
export const POSTNUMMER = /^[1-9][0-9]{3}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// "12 34 56 78" / "DK12345678" -> "12345678". null, hvis det ikke er 8 cifre.
export function renCvr(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.replace(/\s+/g, "").replace(/^DK/i, "");
  return CVR.test(s) ? s : null;
}

// Telefon: cifre, mellemrum, + og bindestreg.
export function renTelefon(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().replace(/\s+/g, " ");
  if (!/^\+?[0-9][0-9 \-]*$/.test(s)) return null;
  const cifre = s.replace(/[^0-9]/g, "").length;
  if (cifre < 8 || s.length > ERHVERV_GRAENSER.telefonMaks) return null;
  return s;
}

export type ErhvervPakke = {
  id: string;
  navn: string;
  beskrivelse: string | null;
  // Hele kroner pr. måned. null = Filip har ikke sat prisen endnu.
  maanedspris: number | null;
  // Gammel ugekvote (null for pakkerne fra 26. okt. 2026).
  auktioner_pr_uge: number | null;
  // Pakkerne fra 26. okt. 2026 (20261102010000). null = ubegrænset.
  auktioner_pr_maaned: number | null;
  ubegraenset: boolean;
  fremhaevninger_pr_maaned: number;
  statistik: "ingen" | "statistik" | "fuld";
  fast_kontaktperson: boolean;
  ugens_butik_rabat_procent: number;
  ugens_butik_rabat_antal: number;
  // Velkomstfordelen i måned 1 (20261102070000): Start 'gratis', Butik/Pro 'halv'.
  maaned1?: "gratis" | "halv";
  aktiv: boolean;
  arkiveret: boolean;
};

// Rækkefølge mellem pakker (som erhverv_pakke_rang i databasen): flere
// auktioner (ubegrænset størst), så flere fremhævninger, så højere pris.
type RangFelter = Pick<ErhvervPakke, "auktioner_pr_maaned" | "fremhaevninger_pr_maaned" | "maanedspris">;
export function pakkeRang(p: RangFelter): number[] {
  return [p.auktioner_pr_maaned ?? 1_000_000_000, p.fremhaevninger_pr_maaned ?? 0, p.maanedspris ?? 0];
}
export function erStoerrePakke(a: RangFelter, b: RangFelter): boolean {
  const x = pakkeRang(a);
  const y = pakkeRang(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Er et skift fra `nu` til `til` en opgradering? SAMME regel som databasen
// (firma_skift_pakke_server): en arkiveret nuværende pakke regnes som mindst,
// ellers afgør rangen. Siden (PakkeValg) bruger den, så den viser det samme
// som serveren gør.
export function erOpgraderingTil(
  til: RangFelter,
  nu: RangFelter & { arkiveret?: boolean | null },
): boolean {
  return !!nu.arkiveret || erStoerrePakke(til, nu);
}

// Sammenligner to værdier fra databasens erhverv_pakke_rang (numeric[]) som
// Postgres' `>` på arrays: element for element, NULL er større end ethvert
// tal, og ved lige elementer er det længste array størst. Appens GET bruger
// databasens egen rang, så den aldrig er uenig med POST'en.
export function dbRangStoerre(a: readonly unknown[] | null, b: readonly unknown[] | null): boolean {
  if (!a || !b) throw new Error("erhverv_pakke_rang: pakken findes ikke");
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] == null ? null : Number(a[i]);
    const y = b[i] == null ? null : Number(b[i]);
    if ((x != null && Number.isNaN(x)) || (y != null && Number.isNaN(y))) {
      throw new Error("erhverv_pakke_rang: ugyldig værdi");
    }
    if (x === y) continue;
    if (x == null) return true;
    if (y == null) return false;
    return x > y;
  }
  return a.length > b.length;
}

// Fremhævninger i måneden (pakke + ekstra fra BidHamr).
export type FremhaevningKvote = { pakke: number; ekstra: number; maks: number; brugt: number; tilbage: number };

// firma_kvote() (og det gamle navn firma_ugekvote()): kvoten er pr.
// KALENDERMÅNED (dansk tid) fra 20261102010000. uge_start/naeste_uge er de
// gamle navne og er nu månedens start og næste måned.
export type Ugekvote = {
  brugt: number;
  // null = ubegrænset (Pro).
  max: number | null;
  ekstra: number;
  ubegraenset: boolean;
  kan_oprette: boolean;
  naeste_ledige: string | null;
  maaned_start: string;
  naeste_maaned: string;
  uge_start: string;
  naeste_uge: string;
  aktivt_abonnement: boolean;
  fremhaevninger: FremhaevningKvote;
};
export type Maanedskvote = Ugekvote;

// Er månedens auktioner brugt? (Ubegrænset = aldrig.)
export function kvoteBrugt(k: Pick<Ugekvote, "brugt" | "max">): boolean {
  return k.max != null && k.brugt >= k.max;
}

// Firmaets abonnement (erhverv_firma_abonnement_json - i firma_oversigt.abonnement
// og i admin-listen erhverv_firmaer_liste).
export type FirmaAbonnement = {
  // Hele kroner ekskl. moms, som firmaet betaler (særpris eller pakkens pris).
  pris: number | null;
  saerpris: number | null;
  gratis_til: string | null;
  gratis_maaneder_ved_start: number;
  // Velkomstfordelen, når firmaet starter (20261102070000): 'gratis' (Start:
  // første måned gratis), 'halv' (Butik/Pro: første måned til halv pris) eller
  // 'ingen'. null/udeladt, når abonnementet er startet.
  maaned1?: "gratis" | "halv" | "ingen" | null;
  gratis_brugt: boolean;
  introrabat: {
    procent: number;
    maaneder: number;
    fra: "efter_gratis" | "straks";
    status: "planlagt" | "aktiv";
    til: string | null;
  } | null;
  kort: { maerke: string | null; sidste4: string; udloeb: string; udloeber_snart: boolean } | null;
  kvote: {
    brugt: number;
    max: number | null;
    pakke_max: number | null;
    ekstra: number;
    ubegraenset: boolean;
    periode_start: string;
    periode_slut: string;
  };
  fremhaevninger: FremhaevningKvote;
};

// Svar fra firma_oversigt() (se migrationen for alle felter).
export type FirmaOversigt = {
  firma: {
    id: string;
    firmanavn: string;
    cvr: string;
    adresse: string;
    postnummer: string;
    by: string;
    telefon: string;
    kontakt_email: string;
    kontaktperson: string;
    abonnement_status: AbonnementStatus;
    abonnement_start: string;
    betalt_til: string | null;
    betaling_mislykket_kl: string | null;
    pauset_aarsag: "betaling" | "bidhamr" | null;
    naeste_periode: string;
    periode_slut: string | null;
    opsiges_fra: string | null;
    har_stripe_abonnement: boolean;
    stripe_abonnement_status: string | null;
  };
  pakke: ErhvervPakke | null;
  naeste_pakke: (ErhvervPakke & { fra: string }) | null;
  afventende_opgradering: (ErhvervPakke & { skift_id: string; anmodet_kl: string; faktura_url: string | null }) | null;
  pakker: ErhvervPakke[];
  kvote: Ugekvote | null;
  // Gammelt navn (samme indhold som kvote).
  ugekvote: Ugekvote | null;
  // Uden saerpris_aftale (den interne aftaletekst vises kun i admin).
  abonnement: Omit<FirmaAbonnement, "saerpris_aftale"> | null;
  auktioner: { aktive: number; i_alt: number; visninger: number; visninger_aktive: number; bud: number };
  salg: {
    solgte_i_alt: number;
    solgte_denne_maaned: number;
    omsaetning_i_alt: number;
    omsaetning_denne_maaned: number;
    afsluttede_i_alt: number;
    omsaetning_afsluttede_i_alt: number;
  };
  udbetalinger: { udbetalt_i_alt_oere: number; udbetalt_denne_maaned_oere: number; paa_vej_oere: number };
  venter_paa_dig: {
    trade_id: string;
    auktion_id: string;
    titel: string | null;
    beloeb: number;
    afhentning: boolean;
    status: string;
    oprettet: string;
  }[];
  ubesvarede_spoergsmaal: { id: string; auktion_id: string; titel: string; spoergsmaal: string; stillet_kl: string }[];
  regninger: {
    id: string;
    nummer: string | null;
    type: "abonnement" | "opgradering" | "andet";
    periode_fra: string | null;
    periode_til: string | null;
    // Inkl. moms.
    beloeb_oere: number;
    beloeb_ekskl_moms_oere: number | null;
    moms_oere: number | null;
    status: "afventer" | "betalt" | "mislykket" | "krediteret" | "annulleret";
    pdf_url: string | null;
    // Stripes fakturaside (se og betal).
    hosted_url: string | null;
    betalt_kl: string | null;
    oprettet: string;
  }[];
  kontakt_bidhamr: string;
};

// Firma-dashboardet (20261010040000_firma_dashboard.sql).
export const AUKTION_GRUPPER = ["aktive", "solgte", "usolgte", "annullerede"] as const;
export type AuktionGruppe = (typeof AUKTION_GRUPPER)[number];

export function erAuktionGruppe(s: unknown): s is AuktionGruppe {
  return typeof s === "string" && (AUKTION_GRUPPER as readonly string[]).includes(s);
}

// firma_auktioner(p_gruppe)
export type FirmaAuktioner = {
  antal: Record<AuktionGruppe, number>;
  gruppe: AuktionGruppe;
  auktioner: {
    id: string;
    titel: string;
    billede: string | null;
    status: "aktiv" | "afsluttet" | "annulleret";
    slutter_kl: string;
    oprettet: string;
    startpris: number;
    nuvaerende_bud: number | null;
    antal_bud: number;
    skjult: boolean;
    trade_id: string | null;
    solgt_for: number | null;
    visninger: number;
  }[];
};

// firma_fremhaevninger()
export type FirmaFremhaevninger = {
  kvote: FremhaevningKvote;
  naeste_maaned: string;
  fremhaevninger: {
    id: string;
    auktion_id: string;
    titel: string;
    start_kl: string;
    slut_kl: string;
    stoppet_kl: string | null;
    aktiv: boolean;
  }[];
};

// firma_statistik(). niveau efter pakken: 'ingen' (tomme lister),
// 'statistik' (kun maaneder) eller 'fuld' (også auktioner).
export type FirmaStatistik = {
  niveau?: "ingen" | "statistik" | "fuld";
  // maaned: "2026-10"
  maaneder: { maaned: string; visninger: number; bud: number; solgte: number; omsaetning: number }[];
  auktioner: {
    id: string;
    titel: string;
    status: "aktiv" | "afsluttet" | "annulleret";
    oprettet: string;
    slutter_kl: string;
    bud: number;
    visninger: number;
    solgt_for: number | null;
  }[];
};

// firma_salg()
export type FirmaSalg = {
  trade_id: string;
  auktion_id: string;
  titel: string | null;
  billede: string | null;
  beloeb: number;
  status: string;
  afhentning: boolean;
  oprettet: string;
  sendt_kl: string | null;
  modtaget_kl: string | null;
  retur: boolean;
  udbetaling_oere: number | null;
  betaling_status: string | null;
  betalt_kl: string | null;
  overfoert_kl: string | null;
  refunderet_kl: string | null;
}[];

// Offentlige firmaoplysninger (firma_offentlig) til mærket "Erhvervssælger"
// og firmaprofilen.
export type FirmaOffentlig = {
  bruger_id: string;
  firmanavn: string;
  cvr: string;
  adresse: string;
  postnummer: string;
  by: string;
  telefon: string;
  kontakt_email: string;
  aktiv: boolean;
  siden: string;
};

// Databasens fejl med stabilt præfiks (også fra appen). Teksten bygges her,
// så databasens fejltekst aldrig sendes ordret til brugeren.
export const ERHVERV_FEJL = {
  kanIkkeByde: "Firmakonti kan ikke byde. Vil du købe, så brug en privat konto.",
  skalBetale: "Betal for din pakke under Abonnement i Firma oversigt. Så kan du oprette auktioner.",
  intetAbonnement: `Firmaet har ikke et aktivt abonnement. Kontakt BidHamr på ${ERHVERV_EMAIL}.`,
  gpsr: "Når varen er ny, skal du udfylde producent (navn og adresse) og sikkerhedsoplysninger.",
  kvote: "Du har brugt månedens auktioner. Du kan oprette den næste den 1. i næste måned.",
  kontoSpaerret: `Din konto er spærret, så du kan ikke skifte pakke. Skriv til ${ERHVERV_EMAIL}.`,
  skiftIGang: "Vi er ved at skifte din pakke. Vent et øjeblik, og opdater siden.",
  opsagtNedgradering: `Dit abonnement er opsagt, så du kan ikke skifte til en mindre pakke. Skriv til ${ERHVERV_EMAIL}, hvis du vil fortsætte.`,
  ingenBeskeder:
    "Du kan ikke skrive til en erhvervssælger. Kontakt firmaet på mail eller telefon - se firmaets profil.",
} as const;

export function erhvervFejlTekst(besked: string | null | undefined, kode?: string | null): string | null {
  const b = besked ?? "";
  if (kode === "BHE01" || b.includes("erhverv_kan_ikke_byde")) return ERHVERV_FEJL.kanIkkeByde;
  if ((kode === "BHE02" || b.includes("erhverv_intet_abonnement")) && b.includes("Betal for din pakke")) {
    return ERHVERV_FEJL.skalBetale;
  }
  if (kode === "BHE02" || b.includes("erhverv_intet_abonnement")) return ERHVERV_FEJL.intetAbonnement;
  // Pakkeskift (20261010051000): spærret konto, skift allerede i gang,
  // nedgradering mens abonnementet er opsagt. Databasens tekst er dansk.
  if (kode === "BHE06" || b.includes("erhverv_konto_spaerret")) return ERHVERV_FEJL.kontoSpaerret;
  if (kode === "BHE07" || b.includes("erhverv_skift_i_gang")) return ERHVERV_FEJL.skiftIGang;
  if (kode === "BHE08" || b.includes("erhverv_opsagt")) {
    const m = b.match(/erhverv_opsagt:\s*(.+)$/);
    return m ? m[1].trim() : ERHVERV_FEJL.opsagtNedgradering;
  }
  if (kode === "BHE04" || b.includes("erhverv_gpsr")) return ERHVERV_FEJL.gpsr;
  if (kode === "BHE05" || b.includes("erhverv_ingen_beskeder")) return ERHVERV_FEJL.ingenBeskeder;
  if (kode === "BHE03" || b.includes("erhverv_kvote")) {
    // 20261102010000: "Du har oprettet X af Y auktioner i denne måned. Du kan
    // oprette den næste den 1. <måned>."
    const m = b.match(/oprettet (\d+) af (\d+) auktioner i denne måned\. Du kan oprette den næste den 1\. ([a-zæøå]+)\./);
    return m
      ? `Du har oprettet ${m[1]} af ${m[2]} auktioner i denne måned. Du kan oprette den næste den 1. ${m[3]}.`
      : ERHVERV_FEJL.kvote;
  }
  return null;
}
