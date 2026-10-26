import { BOOST_TEKST } from "@/lib/boost/tekster";

// Mærket "Boostet" (markedsføringsloven: en betalt placering skal kunne
// kendes). Altid med tekst - ikke kun et ikon. Orange flade med hvid tekst
// (DESIGN.md: orange knap-farven bruges til badges med hvid tekst, 4,83:1).
export default function BoostetMaerke({ lille = false, className = "" }: { lille?: boolean; className?: string }) {
  const stoerrelse = lille ? "px-[9px] py-[5px] text-xs" : "px-3 py-1 text-[13px]";
  return (
    <span
      title={BOOST_TEKST.maerkeForklaring}
      className={`inline-flex items-center gap-1 rounded-none bg-orange-knap font-semibold text-white ${stoerrelse} ${className}`}
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
      </svg>
      {BOOST_TEKST.maerke}
      <span className="sr-only"> – {BOOST_TEKST.maerkeForklaring}</span>
    </span>
  );
}
