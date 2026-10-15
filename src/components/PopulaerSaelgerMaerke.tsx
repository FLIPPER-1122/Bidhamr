import Ikon from "@/components/Ikon";
import { POPULAER_SAELGER } from "@/lib/tekster/konkurrence";

// Mærket "Populær sælger" (mindst 50 gennemførte salg - populaer_saelger()
// i 20261023020000_badge_konkurrence.sql). Samme mønster som "MitID-
// verificeret" (src/components/mitid/MitIDMaerke.tsx): altid med tekst,
// lys grøn flade.
export default function PopulaerSaelgerMaerke({ lille = false }: { lille?: boolean }) {
  const stoerrelse = lille ? "px-2 py-0.5 text-[12px] gap-1" : "px-2.5 py-1 text-[13px] gap-1.5";
  return (
    <span
      className={`inline-flex items-center rounded-full bg-groen-lys font-semibold whitespace-nowrap text-groen-mork ${stoerrelse}`}
      title={POPULAER_SAELGER.maerkeForklaring}
    >
      <Ikon navn="stjerne" className={lille ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0"} strøg={2} />
      {POPULAER_SAELGER.maerke}
    </span>
  );
}
