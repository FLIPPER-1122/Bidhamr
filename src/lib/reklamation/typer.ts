// Reklamation hos fragtfirma ved transportskade (ROADMAP-BESLUTNINGER
// afsnit 4; migration 20261029010000_reklamation_fragtfirma.sql).
// BIDHAMR (staff) anmelder skaden hos fragtfirmaet; fragtfirmaet udbetaler
// erstatningen til BidHamr, og KUN chefen udbetaler den til sælgeren via
// Stripe (Filip, 22. okt. 2026 - DAO's svar). Sælgeren ser kun status.
// Fælles typer og tekster - må bruges i både server- og klientkode.

export const REKLAMATION_STATUSSER = [
  "afventer_bidhamr",
  "anmeldt",
  "godkendt",
  "afvist",
  "udbetalt",
  "annulleret",
] as const;
export type ReklamationStatus = (typeof REKLAMATION_STATUSSER)[number];

// De statusser, staff kan rette til (fragt_reklamation_ret_status). Aldrig
// til eller fra "udbetalt".
export const REKLAMATION_RET_STATUSSER = ["afventer_bidhamr", "anmeldt", "godkendt", "afvist"] as const;
export type ReklamationRetStatus = (typeof REKLAMATION_RET_STATUSSER)[number];

// Åben = venter på BidHamr eller på fragtfirmaets svar.
export const REKLAMATION_AABNE: readonly ReklamationStatus[] = ["afventer_bidhamr", "anmeldt"];

export type ReklamationTransportoer = "dao" | "gls";

export function erReklamationStatus(v: unknown): v is ReklamationStatus {
  return typeof v === "string" && (REKLAMATION_STATUSSER as readonly string[]).includes(v);
}

export function erRetStatus(v: unknown): v is ReklamationRetStatus {
  return typeof v === "string" && (REKLAMATION_RET_STATUSSER as readonly string[]).includes(v);
}

export function transportoerNavn(t: string | null | undefined): string {
  return t === "dao" ? "DAO" : t === "gls" ? "GLS" : "fragtfirmaet";
}

// Hvor STAFF anmelder skaden (kun admin - vises aldrig for sælgeren).
// DAO: omdeling.info (DAO, 20. og 22. okt. 2026 - kun til BidHamrs interne
// brug). GLS: TODO - Filip venter på GLS' svar om deres anmeldelsesvej.
export const REKLAMATION_ANMELD: Record<ReklamationTransportoer, { url: string | null; tekst: string }> = {
  dao: {
    url: "https://omdeling.info",
    tekst:
      "Anmeld skaden på omdeling.info (kun til BidHamrs interne brug – giv aldrig adgangen eller linket til sælgeren). Kopiér felterne over, vedhæft billederne fra ZIP-filen, og skriv DAO's sagsnummer her bagefter.",
  },
  gls: {
    url: null,
    tekst: "Anmeld skaden hos GLS' kundeservice. Kopiér felterne over, vedhæft billederne fra ZIP-filen, og skriv GLS' sagsnummer her bagefter.",
  },
};

// Status til staff (admin).
export const REKLAMATION_STATUS_STAFF: Record<ReklamationStatus, string> = {
  afventer_bidhamr: "Venter på anmeldelse (BidHamr)",
  anmeldt: "Anmeldt – venter på fragtfirmaets svar",
  godkendt: "Godkendt – venter på chefens udbetaling",
  afvist: "Afvist af fragtfirmaet",
  udbetalt: "Udbetalt til sælger",
  annulleret: "Annulleret",
};

// Status til sælgeren (handelssiden). Ingen omtale af omdeling.info.
export function reklamationStatusSaelger(status: ReklamationStatus, transportoer: string): string {
  const navn = transportoerNavn(transportoer);
  switch (status) {
    case "afventer_bidhamr":
      return `Vi reklamerer hos ${navn} for dig`;
    case "anmeldt":
      return `Skaden er anmeldt hos ${navn} – vi venter på svar`;
    case "godkendt":
      return `${navn} har godkendt erstatningen`;
    case "afvist":
      return `${navn} har afvist reklamationen`;
    case "udbetalt":
      return "Erstatningen er udbetalt til dig";
    case "annulleret":
      return "Reklamationen er stoppet";
  }
}

// Sælgerens trin på handelssiden (kun visning).
export const REKLAMATION_TRIN_SAELGER = ["Vi anmelder skaden", "Fragtfirmaet svarer", "Vi udbetaler erstatningen"] as const;

// Hvilket trin (0-2) sælgeren er nået til, og om forløbet er slut.
export function reklamationTrin(status: ReklamationStatus): { trin: number; faerdig: boolean } {
  switch (status) {
    case "afventer_bidhamr":
      return { trin: 0, faerdig: false };
    case "anmeldt":
      return { trin: 1, faerdig: false };
    case "godkendt":
      return { trin: 2, faerdig: false };
    case "udbetalt":
      return { trin: 2, faerdig: true };
    case "afvist":
      return { trin: 1, faerdig: true };
    case "annulleret":
      return { trin: 0, faerdig: true };
  }
}

// Det sælgeren må se (mine_fragt_reklamationer). Ingen noter, staff-id'er,
// sagsnummer, Stripe-id'er eller pakke.
export type SaelgerReklamation = {
  id: string;
  sag_id: string;
  trade_id: string;
  transportoer: ReklamationTransportoer;
  status: ReklamationStatus;
  kravbeloeb_oere: number;
  godkendt_beloeb_oere: number | null;
  afvisningsgrund: string | null;
  annulleret_grund: string | null;
  oprettet_kl: string;
  anmeldt_kl: string | null;
  afgjort_kl: string | null;
  annulleret_kl: string | null;
  udbetalt_kl: string | null;
  // Udbetalingen til sælgerens bank er gennemført (payout paid).
  bank_betalt_kl: string | null;
  // Sagen er ændret efter anmeldelsen, og BidHamr har ikke kvitteret endnu
  // (udbetalingen venter).
  sag_aendret: boolean;
};

export type ReklamationBankStatus = "claimet" | "oprettet" | "paid" | "failed" | "canceled";

// Hele rækken (kun staff).
export type StaffReklamation = Omit<SaelgerReklamation, "sag_aendret" | "bank_betalt_kl"> & {
  saelger_id: string;
  forsendelse_id: string | null;
  trackingnummer: string | null;
  varens_vaerdi_oere: number;
  maks_erstatning_oere: number | null;
  transportoerens_sagsnummer: string | null;
  annulleret_auto: boolean;
  sag_aendret_kl: string | null;
  sag_aendret_kvitteret_kl: string | null;
  sag_aendret_kvitteret_af: string | null;
  oprettet_af: string;
  aktiv_fra_kl: string;
  fremdrift_kl: string;
  afgjort_af: string | null;
  annulleret_af: string | null;
  intern_note: string | null;
  opdateret_kl: string;
  erstatning_modtaget_kl: string | null;
  erstatning_modtaget_af: string | null;
  udbetaling_paabegyndt_kl: string | null;
  udbetaling_paabegyndt_af: string | null;
  udbetaling_forsoeg: number;
  udbetaling_stripe_konto: string | null;
  stripe_transfer_id: string | null;
  udbetalt_af: string | null;
  udbetaling_fejl: string | null;
  transfer_tilbagefoert_kl: string | null;
  bank_status: ReklamationBankStatus | null;
  bank_payout_id: string | null;
  bank_forsoeg: number;
  bank_claimet_kl: string | null;
  bank_sidst_sendt_kl: string | null;
  bank_oprettet_kl: string | null;
  bank_betalt_kl: string | null;
  bank_fejlet_kl: string | null;
  bank_fejlkode: string | null;
  bank_fejl: string | null;
};

// Tællere til admin-lamperne (fragt_reklamationer_antal / hentReklamationTal).
export type ReklamationTal = {
  // Venter på, at staff anmelder (til orientering).
  afventer: number;
  // ... i over REKLAMATION_ANMELD_ROED_DAGE dage -> rød.
  afventerRoed: number;
  // Anmeldt uden svar fra fragtfirmaet i REKLAMATION_STILLE_DAGE dage -> grå.
  stille: number;
  // Sagen er ændret efter anmeldelsen -> rød.
  sagAendret: number;
  // Chefen: godkendt, venter på udbetaling.
  venterUdbetaling: number;
  // Chefen: udbetalingen hænger eller er fejlet -> rød.
  udbetalingFejl: number;
};

export const REKLAMATION_ANMELD_ROED_DAGE = 3;
export const REKLAMATION_STILLE_DAGE = 30;
// Et påbegyndt Stripe-kald uden svar regnes som hængende efter (min.) -
// samme grænse som fragt_reklamationer_antal.
export const REKLAMATION_UDBETALING_HAENGER_MIN = 10;

export function kroner(oere: number | null | undefined): string {
  if (oere == null) return "–";
  return `${(oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr.`;
}

// Kroner fra en formular -> øre, eller en dansk fejltekst.
// Dansk format: komma er decimaltegn (højst 2 decimaler), og punktum eller
// mellemrum er tusindtalsskilletegn - kun i grupper på præcis 3 cifre:
//   "1.250" = 1250 kr., "1.250,50", "1250", "1250,5", "1 250", "12 kr."
// Uden komma tolkes ét punktum efterfulgt af 1-2 cifre som decimaltegn
// ("1250.5" = 1250,50 kr.). Alt andet afvises (fx "1,250", "1.25,00",
// "12.50,00", "1.2.3"), så et beløb aldrig gættes forkert.
export type KronerSvar = { oere: number } | { fejl: string };

const KRONER_FEJL = "Skriv beløbet i kroner, fx 1.250 eller 1.250,50.";

export function fortolkKroner(v: string): KronerSvar {
  // Mellemrum (også hårde) normaliseres; "kr."/"kr" til sidst fjernes.
  let ren = String(v ?? "")
    .replace(/[   ]/g, " ")
    .trim()
    .replace(/\s*kr\.?$/i, "")
    .trim();
  if (!ren) return { fejl: "Skriv beløbet i kroner." };
  if (/^-/.test(ren)) return { fejl: "Beløbet skal være større end 0 kr." };

  let heltal: string;
  let decimaler = "";
  const komma = ren.split(",");
  if (komma.length > 2) return { fejl: KRONER_FEJL };
  if (komma.length === 2) {
    [ren, decimaler] = komma;
    if (!/^\d{1,2}$/.test(decimaler)) {
      return { fejl: "Skriv højst 2 decimaler efter kommaet, fx 1.250,50." };
    }
  } else if (/^\d+\.\d{1,2}$/.test(ren)) {
    // Ingen komma: "1250.5" / "1250.50" (decimalpunktum).
    [ren, decimaler] = ren.split(".");
  }

  if (/^\d+$/.test(ren)) heltal = ren;
  else if (/^\d{1,3}(\.\d{3})+$/.test(ren)) heltal = ren.replace(/\./g, "");
  else if (/^\d{1,3}( \d{3})+$/.test(ren)) heltal = ren.replace(/ /g, "");
  else return { fejl: KRONER_FEJL };

  const oere = Number(heltal) * 100 + (decimaler ? Number(decimaler.padEnd(2, "0")) : 0);
  if (!Number.isSafeInteger(oere)) return { fejl: "Beløbet er for stort." };
  if (oere <= 0) return { fejl: "Beløbet skal være større end 0 kr." };
  return { oere };
}

// Som fortolkKroner, men null ved fejl.
export function kronerTilOere(v: string): number | null {
  const r = fortolkKroner(v);
  return "oere" in r ? r.oere : null;
}

// Hvorfor reklamationen ikke kan være åben/anmeldt/godkendt/udbetales -
// årsagerne fra fragt_reklamation_betingelser (migration 20261029010000).
// Bruges i staffs fejlbeskeder og i dialogen "Kvittér for den ændrede sag".
export const REKLAMATION_BETINGELSE: Record<string, string> = {
  ikke_refunderet: "køberen har ikke fået pengene tilbage (refusionen er ikke bekræftet)",
  saelger_beholder: "sælgeren har fået eller beholder salgsbeløbet (pengene er ikke hentet tilbage fra sælgeren)",
  ikke_koebers_fordel: "sagen er ikke endeligt afgjort til køberens fordel",
  anke_venter: "en anke venter på afgørelse",
  ankefrist: "ankefristen er ikke udløbet endnu",
  indpakning: "indpakningen er ikke vurderet som ordentlig",
  ingen_forsendelse: "der er ingen pakke med DAO eller GLS på handlen",
  afhentning: "varen blev afhentet",
  ikke_skadet: "sagen handler ikke om skade under fragten",
  ingen_handel: "handlen findes ikke",
  ingen_vaerdi: "varens værdi kan ikke findes",
};

// Midlertidige årsager: staff må kvittere (reklamationen fortsætter), og
// systemet markerer sagen ændret igen, hvis anken/fristen ender anderledes.
// Alle andre årsager afviser kvitteringen (databasen:
// betingelser_ikke_opfyldt). Chefens udbetaling kræver HELT opfyldte
// betingelser.
export const REKLAMATION_KVITTER_TILLADT: readonly string[] = ["anke_venter", "ankefrist"];

export function betingelseTekst(aarsag: string | null | undefined): string {
  return (aarsag && REKLAMATION_BETINGELSE[aarsag]) || "betingelserne ikke er opfyldt";
}

// Må staff kvittere for den ændrede sag? null = betingelserne er opfyldt.
export function kanKvittere(aarsag: string | null): boolean {
  return aarsag === null || REKLAMATION_KVITTER_TILLADT.includes(aarsag);
}
