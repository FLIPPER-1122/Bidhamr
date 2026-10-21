// Reklamation hos fragtfirma ved transportskade (ROADMAP-BESLUTNINGER
// afsnit 4; migration 20261029010000_reklamation_fragtfirma.sql).
// SÆLGEREN anmelder selv skaden; erstatningen går direkte fra fragtfirmaet
// til sælgeren (Filip, 21. okt. 2026). Fælles typer og tekster - må bruges i
// både server- og klientkode.

export const REKLAMATION_STATUSSER = [
  "afventer_saelger",
  "anmeldt",
  "godkendt",
  "afvist",
  "fravalgt",
  "annulleret",
] as const;
export type ReklamationStatus = (typeof REKLAMATION_STATUSSER)[number];

// De statusser, staff kan rette til (fragt_reklamation_ret_status).
export const REKLAMATION_RET_STATUSSER = ["afventer_saelger", "anmeldt", "godkendt", "afvist", "fravalgt"] as const;
export type ReklamationRetStatus = (typeof REKLAMATION_RET_STATUSSER)[number];

// Åben = sælgeren kan stadig registrere, og pakken kan hentes.
export const REKLAMATION_AABNE: readonly ReklamationStatus[] = ["afventer_saelger", "anmeldt"];

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

// Hvor sælgeren anmelder skaden. DAO: omdeling.info (DAO, 20. okt. 2026).
// GLS: TODO - Filip venter på GLS' svar om deres anmeldelsesvej.
export const REKLAMATION_ANMELD: Record<ReklamationTransportoer, { url: string | null; tekst: string }> = {
  dao: {
    url: "https://omdeling.info",
    tekst: "Anmeld skaden hos DAO på omdeling.info. Kopiér oplysningerne nedenfor over i formularen, og vedhæft billederne. Du kan hente alle billederne på én gang som én fil (ZIP).",
  },
  gls: {
    url: null,
    tekst: "Kontakt GLS' kundeservice, og anmeld skaden. Kopiér oplysningerne nedenfor over, og vedhæft billederne. Du kan hente alle billederne på én gang som én fil (ZIP).",
  },
};

// Status til staff (admin).
export const REKLAMATION_STATUS_STAFF: Record<ReklamationStatus, string> = {
  afventer_saelger: "Venter på sælger",
  anmeldt: "Anmeldt – venter på svar",
  godkendt: "Godkendt – udbetales direkte til sælger",
  afvist: "Afvist af fragtfirmaet",
  fravalgt: "Sælger ønsker ikke at reklamere",
  annulleret: "Annulleret",
};

// Status til sælgeren (handelssiden).
export function reklamationStatusSaelger(status: ReklamationStatus, transportoer: string): string {
  const navn = transportoerNavn(transportoer);
  switch (status) {
    case "afventer_saelger":
      return `Du kan søge erstatning hos ${navn} – anmeld skaden`;
    case "anmeldt":
      return `Anmeldt hos ${navn} – venter på svar`;
    case "godkendt":
      return `${navn} har godkendt erstatningen`;
    case "afvist":
      return `${navn} har afvist din anmeldelse`;
    case "fravalgt":
      return "Du har valgt ikke at reklamere";
    case "annulleret":
      return "Reklamationen er stoppet";
  }
}

// Det sælgeren må se (mine_fragt_reklamationer). Ingen noter eller staff-id'er.
export type SaelgerReklamation = {
  id: string;
  sag_id: string;
  trade_id: string;
  transportoer: ReklamationTransportoer;
  status: ReklamationStatus;
  trackingnummer: string | null;
  varens_vaerdi_oere: number;
  kravbeloeb_oere: number;
  maks_erstatning_oere: number | null;
  godkendt_beloeb_oere: number | null;
  afvisningsgrund: string | null;
  annulleret_grund: string | null;
  transportoerens_sagsnummer: string | null;
  oprettet_kl: string;
  anmeldt_kl: string | null;
  afgjort_kl: string | null;
  fravalgt_kl: string | null;
  annulleret_kl: string | null;
};

// Hele rækken (kun staff).
export type StaffReklamation = SaelgerReklamation & {
  saelger_id: string;
  forsendelse_id: string | null;
  annulleret_auto: boolean;
  sag_aendret_kl: string | null;
  oprettet_af: string;
  aktiv_fra_kl: string;
  fremdrift_kl: string;
  afgjort_af: string | null;
  annulleret_af: string | null;
  gensendt_kl: string | null;
  gensendt_af: string | null;
  gensendt_antal: number;
  intern_note: string | null;
  opdateret_kl: string;
};

// Tællere til admin-lampen (fragt_reklamationer_antal / hentReklamationTal).
export type ReklamationTal = {
  afventerSaelger: number;
  // Åben uden fremdrift i REKLAMATION_STILLE_DAGE dage -> lampe.
  stille: number;
  // Sagen er ændret, efter sælgeren anmeldte.
  sagAendret: number;
};

export const REKLAMATION_PAAMIND_DAGE = 7;
export const REKLAMATION_STILLE_DAGE = 14;

export function kroner(oere: number | null | undefined): string {
  if (oere == null) return "–";
  return `${(oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr.`;
}

// Kroner fra en formular ("1.234,50", "1234.5", "1234") -> øre. null = ugyldigt.
export function kronerTilOere(v: string): number | null {
  const ren = v.trim().replace(/\s|kr\.?/gi, "");
  if (!ren) return null;
  // Dansk: punktum som tusindtalsskilletegn, komma som decimal.
  const norm = ren.includes(",") ? ren.replace(/\./g, "").replace(",", ".") : ren;
  if (!/^\d+(\.\d{1,2})?$/.test(norm)) return null;
  const oere = Math.round(Number(norm) * 100);
  return Number.isSafeInteger(oere) && oere > 0 ? oere : null;
}
