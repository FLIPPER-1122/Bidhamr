import Link from "next/link";
import Ikon, { type IkonNavn } from "@/components/Ikon";

// Tom tilstand (DESIGN.md 9): ikon i lys grøn cirkel, overskrift, én linje
// forklaring og evt. en primær knap. Virker i server- og klientkomponenter.
export default function TomTilstand({
  ikon,
  titel,
  tekst,
  knap,
  className = "",
}: {
  ikon: IkonNavn;
  titel: string;
  tekst?: string;
  knap?: { href: string; tekst: string };
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center rounded-[14px] border border-kant bg-white px-6 py-10 text-center ${className}`}>
      <span className="grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork">
        <Ikon navn={ikon} className="h-6 w-6" />
      </span>
      <h2 className="mt-4 text-[17px] leading-snug lg:text-lg">{titel}</h2>
      {tekst && <p className="mt-1 max-w-[45ch] text-[15px] text-tekst-daempet">{tekst}</p>}
      {knap && (
        <Link href={knap.href} className="btn btn-primaer mt-5">
          {knap.tekst}
        </Link>
      )}
    </div>
  );
}
