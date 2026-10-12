import Link from "next/link";

// Forrige/Næste + "Side 2" under en liste (docs/ADMIN-REDESIGN.md 4.4).
// `side` starter ved 1. `lavHref` bygger adressen til en side (beholder
// faner, filtre og søgning).
export default function AdminSideskift({
  side,
  harNaeste,
  lavHref,
  antalSider,
}: {
  side: number;
  harNaeste: boolean;
  lavHref: (side: number) => string;
  antalSider?: number;
}) {
  if (side <= 1 && !harNaeste) return null;
  return (
    <nav aria-label="Sider" className="flex items-center justify-between gap-3">
      {side > 1 ? (
        <Link href={lavHref(side - 1)} className="btn btn-sekundaer btn-lille" rel="prev">
          Forrige
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-tekst-daempet">
        Side {side}
        {antalSider ? ` af ${antalSider}` : ""}
      </span>
      {harNaeste ? (
        <Link href={lavHref(side + 1)} className="btn btn-sekundaer btn-lille" rel="next">
          Næste
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

// Læser ?side= sikkert (1-1000).
export function laesSide(v: string | undefined): number {
  const n = Number.parseInt(v ?? "1", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : 1;
}

// Bygger en adresse med de givne parametre (tomme udelades).
export function adminHref(sti: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "side" && Number(v) <= 1) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${sti}?${s}` : sti;
}
