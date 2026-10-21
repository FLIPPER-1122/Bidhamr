// Fælles visning til ekstra fragt i admin (liste, detalje og handlens side).
// Ingen "use client" - bruges i serverkomponenter.
import AdminBadge, { type BadgeTone } from "@/components/admin/AdminBadge";
import type { EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";

const TONE: Record<EkstraFragtStatus, BadgeTone> = {
  afventer_betaling: "gul",
  behandles: "blaa",
  betalt: "groen",
  indsigelse: "roed",
  frafaldet: "graa",
  refunderet: "graa",
};

export const EKSTRA_FRAGT_STATUS_KORT: Record<EkstraFragtStatus, string> = {
  afventer_betaling: "Afventer betaling",
  behandles: "Betaling behandles",
  betalt: "Betalt",
  indsigelse: "Indsigelse",
  frafaldet: "Frafaldet",
  refunderet: "Refunderet",
};

export function EkstraFragtStatusBadge({ status, spaerrer = false }: { status: EkstraFragtStatus; spaerrer?: boolean }) {
  if (status === "afventer_betaling" && spaerrer) {
    return (
      <AdminBadge tone="roed" prik>
        Spærret – fristen er overskredet
      </AdminBadge>
    );
  }
  return (
    <AdminBadge tone={TONE[status] ?? "graa"} prik>
      {EKSTRA_FRAGT_STATUS_KORT[status] ?? status}
    </AdminBadge>
  );
}

export function oereKr(oere: number | string | null | undefined): string {
  if (oere == null) return "–";
  return (Number(oere) / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr.";
}

// Handlingerne i moderation_log, der hører til ekstra fragt (tidslinjen).
export const EKSTRA_FRAGT_LOG_HANDLINGER = [
  "ekstra_fragt_oprettet",
  "ekstra_fragt_frafaldet",
  "ekstra_fragt_fastholdt",
  "ekstra_fragt_indsigelse",
  "ekstra_fragt_betalt",
  "ekstra_fragt_note",
] as const;
