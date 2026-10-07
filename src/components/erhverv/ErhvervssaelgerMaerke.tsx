import Link from "next/link";
import { ERHVERVSSAELGER } from "@/lib/tekster/erhverv";

// Mærket "Erhvervssælger" (auctions.erhverv). Med saelgerId bliver det et
// link til firmaets offentlige profil (/erhvervssaelger/[id]) - ét klik fra
// auktionen. Uden (fx inde i et auktionskort, som selv er et link) er det
// bare et mærke. Altid med tekst - ikke kun et ikon.
const MAERKE =
  "inline-flex items-center gap-1.5 rounded-full border border-groen bg-white font-semibold text-groen-mork";

function Ikon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M10 21v-4h4v4" />
    </svg>
  );
}

export default function ErhvervssaelgerMaerke({ saelgerId, lille = false }: { saelgerId?: string; lille?: boolean }) {
  const stoerrelse = lille ? "px-2 py-0.5 text-[12px]" : "px-3 py-1.5 text-[14px]";
  if (!saelgerId) {
    return (
      <span className={`${MAERKE} ${stoerrelse}`}>
        <Ikon />
        {ERHVERVSSAELGER.maerke}
      </span>
    );
  }
  return (
    <Link
      href={`/erhvervssaelger/${saelgerId}`}
      className={`${MAERKE} ${stoerrelse} min-h-11 hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen`}
    >
      <Ikon />
      {ERHVERVSSAELGER.maerke}
      <span className="font-normal underline underline-offset-2">· {ERHVERVSSAELGER.seFirma}</span>
    </Link>
  );
}
