import type { SaelgerReklamation } from "@/lib/reklamation/typer";

// Lille mærke til handelssidens overblik og listen.
export default function ReklamationMaerke({ status }: { status: SaelgerReklamation["status"] }) {
  if (status !== "afventer_saelger" && status !== "anmeldt") return null;
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
        status === "afventer_saelger"
          ? "border-orange bg-orange-lys text-advarsel-tekst"
          : "border-info-kant bg-info-bg text-info-tekst"
      }`}
    >
      {status === "afventer_saelger" ? "Få erstatning" : "Reklamation anmeldt"}
    </span>
  );
}
