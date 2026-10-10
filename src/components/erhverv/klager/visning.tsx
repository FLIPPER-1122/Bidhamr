// Fælles visning af klager (køber, firma og admin).
import type { KlageAfgoerelse, KlageStatus } from "@/lib/erhverv/klager";
import { KLAGE_AFGOERELSE_NAVN, KLAGE_STATUS_NAVN } from "@/lib/tekster/erhvervKlager";

export function klageDato(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleDateString("da-DK", {
        timeZone: "Europe/Copenhagen",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "–";
}

export function klageTid(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString("da-DK", {
        timeZone: "Europe/Copenhagen",
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "–";
}

const KLASSE: Record<string, string> = {
  aaben: "bg-orange-lys text-[#8A4210]",
  under_behandling: "bg-info-bg text-info-tekst",
  berettiget: "bg-fejl-bg text-fejl-tekst",
  ikke_berettiget: "bg-succes-bg text-succes-tekst",
  trukket_tilbage: "bg-neutral-100 text-neutral-700",
};

// Afsluttede klager viser afgørelsen i stedet for "Afsluttet".
export function KlageStatusMaerke({
  status,
  afgoerelse,
}: {
  status: KlageStatus;
  afgoerelse: KlageAfgoerelse | null;
}) {
  const noegle = status === "afsluttet" && afgoerelse ? afgoerelse : status;
  const navn = status === "afsluttet" && afgoerelse ? KLAGE_AFGOERELSE_NAVN[afgoerelse] : KLAGE_STATUS_NAVN[status];
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${KLASSE[noegle] ?? "bg-neutral-100"}`}>
      {navn}
    </span>
  );
}
