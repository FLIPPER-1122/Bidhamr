// Fælles visning til reklamationer i admin (liste, detalje og sagens side).
// Ingen "use client" - bruges i serverkomponenter.
import AdminBadge, { type BadgeTone } from "@/components/admin/AdminBadge";
import { REKLAMATION_STATUS_STAFF, REKLAMATION_STILLE_DAGE, type ReklamationStatus } from "@/lib/reklamation/typer";

const TONE: Record<ReklamationStatus, BadgeTone> = {
  afventer_saelger: "gul",
  anmeldt: "blaa",
  godkendt: "groen",
  afvist: "graa",
  fravalgt: "graa",
  annulleret: "graa",
};

// Kort navn til badges (det lange står i REKLAMATION_STATUS_STAFF).
export const REKLAMATION_STATUS_KORT: Record<ReklamationStatus, string> = {
  afventer_saelger: "Venter på sælger",
  anmeldt: "Anmeldt",
  godkendt: "Godkendt",
  afvist: "Afvist",
  fravalgt: "Fravalgt",
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

// Åben uden fremdrift i 14 dage (samme regel som fragt_reklamationer_antal).
export function erStille(status: ReklamationStatus, fremdriftKl: string, nu: number): boolean {
  const d = dageSiden(fremdriftKl, nu);
  return (status === "afventer_saelger" || status === "anmeldt") && d !== null && d >= REKLAMATION_STILLE_DAGE;
}

// Sagen er ændret, efter sælgeren anmeldte, og staff har ikke kvitteret
// (samme regel som tælleren).
export function erSagAendret(
  status: ReklamationStatus,
  sagAendretKl: string | null,
  kvitteretKl: string | null = null,
): boolean {
  return !!sagAendretKl && !kvitteretKl && (status === "anmeldt" || status === "godkendt");
}

// Navne på reklamationens hændelser i moderation_log (tidslinjen).
export const REKLAMATION_LOG_NAVN: Record<string, string> = {
  indpakning_ordentlig: "Indpakningen vurderet ordentlig",
  indpakning_ordentlig_fortrudt: "Vurderingen \"ordentlig indpakning\" er fortrudt",
  reklamation_oprettet: "Reklamationen er oprettet – sælgeren har fået besked",
  reklamation_genaabnet: "Reklamationen er åbnet igen",
  reklamation_annulleret: "Reklamationen er annulleret",
  reklamation_sag_aendret: "Sagen er ændret efter anmeldelsen",
  reklamation_sag_aendret_kvitteret: "Kvitteret for den ændrede sag",
  reklamation_note: "Intern note gemt",
  reklamation_gensendt: "Oplysningerne er sendt til sælgeren igen",
  reklamation_status_rettet: "Status rettet af BidHamr",
  reklamation_saelger_anmeldt: "Sælgeren har anmeldt skaden",
  reklamation_saelger_godkendt: "Sælgeren: erstatningen er godkendt",
  reklamation_saelger_afvist: "Sælgeren: erstatningen er afvist",
  reklamation_saelger_fravalgt: "Sælgeren vil ikke reklamere",
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
