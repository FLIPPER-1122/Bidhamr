import Ikon from "@/components/Ikon";
import { MITID } from "@/lib/tekster/mitid";

// Mærket "MitID-verificeret" (users.mitid_verificeret_kl). Altid med tekst -
// aldrig kun et ikon. Lys grøn flade som tryghedsmærkerne (DESIGN.md 1.5).
export default function MitIDMaerke({ lille = false }: { lille?: boolean }) {
  const stoerrelse = lille ? "px-2 py-0.5 text-[12px] gap-1" : "px-2.5 py-1 text-[13px] gap-1.5";
  return (
    <span
      className={`inline-flex items-center rounded-full bg-groen-lys font-semibold text-groen-mork ${stoerrelse}`}
      title={MITID.maerkeForklaring}
    >
      <Ikon navn="personTjek" className={lille ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0"} strøg={2} />
      {MITID.maerke}
    </span>
  );
}
