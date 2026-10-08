// Kan firmaet oprette en auktion lige nu - og hvis ikke, hvorfor?
// Fælles for Overblik, Auktioner og "Opret auktion" i firma-dashboardet.
// Databasen håndhæver det samme (BHE02 intet abonnement, BHE03 ugekvote).
import type { FirmaOversigt } from "@/lib/erhverv/regler";
import { naesteLedigeTekst } from "@/lib/erhverv/visning";
import {
  FIRMA_DASHBOARD,
  FIRMA_FOER_LANCERING,
  FIRMA_OVERSIGT,
  FIRMA_OVERSIGT_EKSTRA as X,
} from "@/lib/tekster/erhverv";

export function abonnementAktivt(o: FirmaOversigt): boolean {
  return o.firma.abonnement_status === "aktiv" && !!o.ugekvote?.aktivt_abonnement;
}

export function ikkeAktivTekst(o: FirmaOversigt): string {
  const s = o.firma.abonnement_status;
  return s === "pauset" ? X.pakkePause : s === "opsagt" ? X.pakkeOpsagt : X.kanIkkeOpretteIkkeAktiv;
}

// Status på et salg i firmaets ord (Salg-listen og handelssiden).
export function salgStatus(s: { status: string; afhentning: boolean; retur: boolean }): {
  tekst: string;
  farve: string;
  handling: boolean;
} {
  const S = FIRMA_DASHBOARD.salg.status;
  if (s.retur) return { tekst: S.retur, farve: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst", handling: false };
  if (s.status === "betaling_modtaget") {
    return {
      tekst: s.afhentning ? S.betaling_modtaget_afhentning : S.betaling_modtaget,
      farve: "border-orange bg-orange-lys text-tekst",
      handling: true,
    };
  }
  const farve =
    s.status === "annulleret"
      ? "border-fejl-kant bg-fejl-bg text-fejl-tekst"
      : s.status === "afventer_betaling"
        ? "border-info-kant bg-info-bg text-info-tekst"
        : s.status === "afsluttet" || s.status === "leveret"
          ? "border-succes-kant bg-succes-bg text-succes-tekst"
          : "border-kant bg-groen-lys text-groen-mork";
  return { tekst: S[s.status] ?? s.status, farve, handling: false };
}

export function opretStatus(o: FirmaOversigt, lukket: boolean): { kan: boolean; forklaring: string | null } {
  if (lukket) return { kan: false, forklaring: FIRMA_FOER_LANCERING.kanIkkeOprette };
  if (!abonnementAktivt(o)) return { kan: false, forklaring: ikkeAktivTekst(o) };
  const k = o.ugekvote;
  if (k && k.brugt >= k.max) return { kan: false, forklaring: FIRMA_OVERSIGT.auktioner.alleBrugt(naesteLedigeTekst(k)) };
  return { kan: true, forklaring: null };
}
