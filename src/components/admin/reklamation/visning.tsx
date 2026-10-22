// Fælles visning til reklamationer i admin (liste, detalje og sagens side).
// Ingen "use client" - bruges i serverkomponenter.
import AdminBadge, { type BadgeTone } from "@/components/admin/AdminBadge";
import {
  REKLAMATION_ANMELD_ROED_DAGE,
  REKLAMATION_STATUS_STAFF,
  REKLAMATION_STILLE_DAGE,
  REKLAMATION_UDBETALING_HAENGER_MIN,
  type ReklamationStatus,
  type StaffReklamation,
} from "@/lib/reklamation/typer";

const TONE: Record<ReklamationStatus, BadgeTone> = {
  afventer_bidhamr: "gul",
  anmeldt: "blaa",
  godkendt: "gul",
  afvist: "graa",
  udbetalt: "groen",
  annulleret: "graa",
};

// Kort navn til badges (det lange står i REKLAMATION_STATUS_STAFF).
export const REKLAMATION_STATUS_KORT: Record<ReklamationStatus, string> = {
  afventer_bidhamr: "Skal anmeldes",
  anmeldt: "Anmeldt",
  godkendt: "Godkendt",
  afvist: "Afvist",
  udbetalt: "Udbetalt",
  annulleret: "Annulleret",
};

export function ReklamationStatusBadge({ status, lang = false }: { status: ReklamationStatus; lang?: boolean }) {
  return (
    <AdminBadge tone={TONE[status]} prik>
      {lang ? REKLAMATION_STATUS_STAFF[status] : REKLAMATION_STATUS_KORT[status]}
    </AdminBadge>
  );
}

const DAG = 24 * 3600 * 1000;

// Hele dage siden et tidspunkt (0 = i dag).
export function dageSiden(iso: string | null, nu: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((nu - t) / DAG));
}

// Venter på anmeldelse i over 3 dage (rød - samme regel som tælleren).
export function erAnmeldRoed(status: ReklamationStatus, aktivFraKl: string, nu: number): boolean {
  const d = dageSiden(aktivFraKl, nu);
  return status === "afventer_bidhamr" && d !== null && d >= REKLAMATION_ANMELD_ROED_DAGE;
}

// Anmeldt uden svar fra fragtfirmaet i 30 dage (grå - samme regel som tælleren).
export function erStille(status: ReklamationStatus, fremdriftKl: string, nu: number): boolean {
  const d = dageSiden(fremdriftKl, nu);
  return status === "anmeldt" && d !== null && d >= REKLAMATION_STILLE_DAGE;
}

// Sagen er ændret efter anmeldelsen, og staff har ikke kvitteret (samme
// regel som tælleren).
export function erSagAendret(
  status: ReklamationStatus,
  sagAendretKl: string | null,
  kvitteretKl: string | null = null,
): boolean {
  return !!sagAendretKl && !kvitteretKl && (status === "anmeldt" || status === "godkendt");
}

// Chefens udbetaling hænger eller er fejlet (samme regel som tælleren -
// src/lib/reklamation/tal.ts / fragt_reklamationer_antal).
export function erUdbetalingFejl(
  r: Pick<
    StaffReklamation,
    "status" | "udbetaling_paabegyndt_kl" | "bank_status" | "transfer_tilbagefoert_kl" | "udbetalt_kl" | "bank_claimet_kl" | "bank_oprettet_kl"
  >,
  nu: number,
): boolean {
  const foer = (iso: string | null, ms: number) => !!iso && Date.parse(iso) < nu - ms;
  if (r.status === "godkendt") return foer(r.udbetaling_paabegyndt_kl, REKLAMATION_UDBETALING_HAENGER_MIN * 60_000);
  if (r.status !== "udbetalt") return false;
  return (
    r.bank_status === "failed" ||
    r.bank_status === "canceled" ||
    !!r.transfer_tilbagefoert_kl ||
    (r.bank_status === null && foer(r.udbetalt_kl, 3600_000)) ||
    (r.bank_status === "claimet" && foer(r.bank_claimet_kl, 3600_000)) ||
    (r.bank_status === "oprettet" && foer(r.bank_oprettet_kl, 7 * DAG))
  );
}

// Udbetalingen til sælgerens bank (kun staff).
export const REKLAMATION_BANK_TEKST: Record<string, string> = {
  claimet: "Sendes til sælgerens bank",
  oprettet: "På vej til sælgerens bank",
  paid: "Sendt til sælgerens bank",
  failed: "Udbetalingen til banken fejlede – venter på, at sælgeren retter bankkontoen",
  canceled: "Udbetalingen til banken blev annulleret hos Stripe – kontrollér i Stripe, og send igen",
};

// Navne på reklamationens hændelser i moderation_log (tidslinjen). De gamle
// (sælgeren anmeldte selv - første udgave) står med for historikken.
export const REKLAMATION_LOG_NAVN: Record<string, string> = {
  indpakning_ordentlig: "Indpakningen vurderet ordentlig",
  indpakning_ordentlig_fortrudt: "Vurderingen \"ordentlig indpakning\" er fortrudt",
  reklamation_oprettet: "Reklamationen er oprettet – sælgeren har fået besked",
  reklamation_genaabnet: "Reklamationen er åbnet igen",
  reklamation_annulleret: "Reklamationen er annulleret",
  reklamation_sag_aendret: "Sagen er ændret efter anmeldelsen",
  reklamation_sag_aendret_kvitteret: "Kvitteret for den ændrede sag",
  reklamation_note: "Intern note gemt",
  reklamation_status_rettet: "Status rettet af BidHamr",
  reklamation_anmeldt: "Anmeldt hos fragtfirmaet",
  reklamation_godkendt: "Fragtfirmaet har godkendt erstatningen",
  reklamation_afvist: "Fragtfirmaet har afvist reklamationen",
  reklamation_udbetaling_startet: "Chefen: erstatningen er modtaget – udbetaling startet",
  reklamation_udbetaling_fejlet: "Udbetalingen fejlede",
  reklamation_udbetalt: "Udbetalt til sælgerens Stripe-konto",
  reklamation_bank_udbetaling: "Udbetaling til sælgerens bank",
  reklamation_gensendt: "Oplysningerne er sendt til sælgeren igen (første udgave)",
  reklamation_saelger_anmeldt: "Sælgeren har anmeldt skaden (første udgave)",
  reklamation_saelger_godkendt: "Sælgeren: erstatningen er godkendt (første udgave)",
  reklamation_saelger_afvist: "Sælgeren: erstatningen er afvist (første udgave)",
  reklamation_saelger_fravalgt: "Sælgeren vil ikke reklamere (første udgave)",
};

export const REKLAMATION_LOG_HANDLINGER = Object.keys(REKLAMATION_LOG_NAVN);

// Fast tidszone, så server og browser viser det samme.
export function reklamationTid(iso: string | null): string {
  if (!iso) return "–";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "–";
  return new Date(t).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}
