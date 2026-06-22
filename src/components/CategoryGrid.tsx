import Link from "next/link";
import { kategorier } from "@/lib/kategorier";

const IKONER: Record<string, React.ReactNode> = {
  Elektronik: (
    <path d="M4 5h16v11H4z M8 20h8 M12 16v4" />
  ),
  Møbler: (
    <path d="M5 11h14v10H5z M8 11V8a4 4 0 0 1 8 0v3" />
  ),
  "Tøj & sko": (
    <path d="M8 4l4 2 4-2 3 4-3 2v10H8V10L5 8z" />
  ),
  Biler: (
    <path d="M3 13l1.5-5A2 2 0 0 1 6.4 6.5h11.2A2 2 0 0 1 19.5 8l1.5 5v5H3z M7 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M17 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
  ),
  Legetøj: (
    <path d="M9 9V6a3 3 0 1 1 3 3h3a3 3 0 1 1-3 3v3a3 3 0 1 1-3-3H6a3 3 0 1 1 3-3z" />
  ),
  Sport: (
    <path d="M6 4v16 M18 4v16 M2 9h4 M2 15h4 M18 9h4 M18 15h4 M6 12h12" />
  ),
  Havemøbler: (
    <path d="M12 3v6 M5 9h14l-1 4H6z M7 13v8 M17 13v8 M5 21h14" />
  ),
  Andet: <path d="M12 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M12 21a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />,
};

function Ikon({ kategori }: { kategori: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {IKONER[kategori]}
    </svg>
  );
}

/**
 * To måder at bruge komponenten:
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
    <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
      {kategorier.map((kategori) => {
        const aktiv = valgt === kategori;
        const fælles = `flex flex-col items-center gap-2 rounded-xl border p-4 text-center transition-colors ${
          aktiv
            ? "border-brand bg-[#FDECEE] text-brand"
            : "border-neutral-200 text-neutral-700 hover:border-brand hover:text-brand"
        }`;

        if (onVælg) {
          return (
            <button
              key={kategori}
              onClick={() => onVælg(aktiv ? "" : kategori)}
              className={fælles}
            >
              <Ikon kategori={kategori} />
              <span className="text-xs font-medium">{kategori}</span>
            </button>
          );
        }

        return (
          <Link
            key={kategori}
            href={`/auktioner?kategori=${encodeURIComponent(kategori)}`}
            className={fælles}
          >
            <Ikon kategori={kategori} />
            <span className="text-xs font-medium">{kategori}</span>
          </Link>
        );
      })}
    </div>
  );
}
