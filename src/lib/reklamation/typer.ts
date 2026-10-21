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
  // Sagen er ændret efter anmeldelsen, og BidHamr har ikke kvitteret endnu:
  // "godkendt" er spærret (mit_fragt_reklamation_godkendt -> sag_aendret).
  afventer_bidhamr: boolean;
};

// Hele rækken (kun staff).
export type StaffReklamation = SaelgerReklamation & {
  saelger_id: string;
  forsendelse_id: string | null;
  annulleret_auto: boolean;
  sag_aendret_kl: string | null;
  sag_aendret_kvitteret_kl: string | null;
  sag_aendret_kvitteret_af: string | null;
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

// Hvorfor reklamationen ikke kan være åben/anmeldt/godkendt - årsagerne fra
// fragt_reklamation_betingelser (migration 20261029010000). Bruges i staffs
// fejlbeskeder og i dialogen "Kvittér for den ændrede sag".
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

// Midlertidige årsager: staff må kvittere (sælgeren fortsætter), og systemet
// markerer sagen ændret igen, hvis anken/fristen ender anderledes. Alle andre
// årsager afviser kvitteringen (databasen: betingelser_ikke_opfyldt).
export const REKLAMATION_KVITTER_TILLADT: readonly string[] = ["anke_venter", "ankefrist"];

export function betingelseTekst(aarsag: string | null | undefined): string {
  return (aarsag && REKLAMATION_BETINGELSE[aarsag]) || "betingelserne ikke er opfyldt";
}

// Må staff kvittere for den ændrede sag? null = betingelserne er opfyldt.
export function kanKvittere(aarsag: string | null): boolean {
  return aarsag === null || REKLAMATION_KVITTER_TILLADT.includes(aarsag);
}
