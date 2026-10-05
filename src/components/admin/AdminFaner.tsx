import Link from "next/link";

export type AdminFane = { id: string; label: string; href: string };

// Fælles faner øverst på en admin-side (fx Brugere og Rapporter). Hver fane
// er sin egen URL, så gamle links og bogmærker stadig virker.
export default function AdminFaner({
  faner,
  aktiv,
  label,
}: {
  faner: readonly AdminFane[];
  aktiv: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-neutral-200">
      {faner.map((f) => (
        <Link
          key={f.id}
          href={f.href}
          aria-current={aktiv === f.id ? "page" : undefined}
          className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
            aktiv === f.id
              ? "border-groen font-semibold text-groen-mork"
              : "border-transparent text-neutral-500 hover:text-neutral-800"
          }`}
        >
          {f.label}
        </Link>
      ))}
    </nav>
  );
}
