import { FOUNDING_SELLER } from "@/lib/tekster/foundingSeller";

// Mærket "Founding seller" (aktiv seller founder - public.founding_seller()
// i 20261102420000_seller_founder.sql). Lille og diskret: lys orange flade
// med almindelig tekstfarve (kontrast) og et lille orange flag. Altid med
// tekst. Forklaringen ligger i title og for skærmlæsere.
export default function FoundingSellerMaerke({ lille = false }: { lille?: boolean }) {
  const stoerrelse = lille ? "px-2 py-0.5 text-[12px] gap-1" : "px-2.5 py-1 text-[13px] gap-1.5";
  return (
    <span
      className={`inline-flex items-center rounded-none bg-orange-lys font-semibold whitespace-nowrap text-tekst ${stoerrelse}`}
      title={FOUNDING_SELLER.maerkeForklaring}
    >
      <svg
        viewBox="0 0 24 24"
        className={`${lille ? "h-3.5 w-3.5" : "h-4 w-4"} shrink-0 text-orange-knap`}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 21v-16" />
        <path d="M5 4h11l-2 4l2 4h-11" />
      </svg>
      {FOUNDING_SELLER.maerke}
      <span className="sr-only"> ({FOUNDING_SELLER.maerkeForklaring})</span>
    </span>
  );
}
