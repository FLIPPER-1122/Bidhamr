import type { EkstraFragtStatus } from "@/lib/ekstraFragt/tekster";
import { kroner } from "@/lib/kroner";

// Lille mærke til Mine handler og handelssidens overblik, når sælgeren har
// en åben regning for ekstra fragt. Rødt, når fristen er overskredet.
export default function EkstraFragtMaerke({
  status,
  beloebOere,
  spaerrer = false,
}: {
  status: EkstraFragtStatus;
  beloebOere: number;
  spaerrer?: boolean;
}) {
  if (status !== "afventer_betaling" && status !== "behandles" && status !== "indsigelse") return null;
  const stil =
    status === "afventer_betaling"
      ? spaerrer
        ? "border-fejl-kant bg-fejl-bg text-fejl-tekst"
        : "border-orange bg-orange-lys text-advarsel-tekst"
      : "border-info-kant bg-info-bg text-info-tekst";
  const tekst =
    status === "afventer_betaling"
      ? `Ekstra fragt: ${kroner(beloebOere)}.`
      : status === "behandles"
        ? "Ekstra fragt: betaling behandles"
        : "Ekstra fragt: indsigelse";
  return <span className={`inline-block rounded-none border px-2.5 py-0.5 text-xs font-semibold ${stil}`}>{tekst}</span>;
}
