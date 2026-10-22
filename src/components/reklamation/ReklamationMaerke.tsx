import type { SaelgerReklamation } from "@/lib/reklamation/typer";

// Lille mærke til handelssidens overblik og listen (kun mens reklamationen er
// i gang - BidHamr reklamerer for sælgeren).
const MAERKE: Partial<Record<SaelgerReklamation["status"], { tekst: string; cls: string }>> = {
  afventer_bidhamr: { tekst: "Vi reklamerer for dig", cls: "border-info-kant bg-info-bg text-info-tekst" },
  anmeldt: { tekst: "Reklamation anmeldt", cls: "border-info-kant bg-info-bg text-info-tekst" },
  godkendt: { tekst: "Erstatning godkendt", cls: "border-succes-kant bg-succes-bg text-succes-tekst" },
};

export default function ReklamationMaerke({ status }: { status: SaelgerReklamation["status"] }) {
  const m = MAERKE[status];
  if (!m) return null;
  return <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${m.cls}`}>{m.tekst}</span>;
}
