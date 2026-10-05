import Link from "next/link";
import Ikon, { KATEGORI_IKON } from "@/components/Ikon";
import { kategorier } from "@/lib/kategorier";

/**
 * Kategorier med ikoner (DESIGN.md 7.2). To måder at bruge komponenten:
 * - Med `onVælg`: knapper der filtrerer en liste på samme side (fx /auktioner).
 * - Uden `onVælg`: links der navigerer til /auktioner?kategori=... (fx forsiden).
 */
export default function CategoryGrid({
  valgt,
  onVælg,
}: {
  valgt?: string;
  onVælg?: (kategori: string) => void;
}) {
  return (
    <ul className="grid grid-cols-4 gap-x-2 gap-y-4 sm:gap-x-3 xl:grid-cols-8">
      {kategorier.map((kategori) => {
        const aktiv = valgt === kategori;
        const fælles =
          "group flex w-full flex-col items-center rounded-[14px] text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";
        const indhold = (
          <>
            <span
              className={`grid h-16 w-full place-items-center rounded-[14px] transition-colors ${
                aktiv
                  ? "bg-groen text-white"
                  : "bg-groen-lys text-groen-mork group-hover:bg-[#DCEAE4]"
              }`}
            >
              <Ikon navn={KATEGORI_IKON[kategori] ?? "andet"} className="h-6 w-6" />
            </span>
            <span className="mt-2 text-[13px] leading-tight font-medium text-[#333]">{kategori}</span>
          </>
        );

        return (
          <li key={kategori} className="min-w-0">
            {onVælg ? (
              <button
                type="button"
                onClick={() => onVælg(aktiv ? "" : kategori)}
                aria-pressed={aktiv}
                className={fælles}
              >
                {indhold}
              </button>
            ) : (
              <Link href={`/auktioner?kategori=${encodeURIComponent(kategori)}`} className={fælles}>
                {indhold}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
