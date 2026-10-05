import Link from "next/link";

// Faner øverst på "Brugere og sikkerhed": søgning og mistænkelig aktivitet.
export default function BrugereFaner({ aktiv }: { aktiv: "soeg" | "mistaenkelig" }) {
  const faner = [
    { id: "soeg", label: "Søg bruger", href: "/admin/brugere" },
    { id: "mistaenkelig", label: "Mistænkelig aktivitet", href: "/admin/brugere/mistaenkelig" },
  ] as const;

  return (
    <nav aria-label="Brugere og sikkerhed" className="flex gap-1 overflow-x-auto border-b border-neutral-200">
      {faner.map((f) => (
        <Link
          key={f.id}
          href={f.href}
          aria-current={aktiv === f.id ? "page" : undefined}
          className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
            aktiv === f.id
              ? "border-brand font-semibold text-brand"
              : "border-transparent text-neutral-500 hover:text-neutral-800"
          }`}
        >
          {f.label}
        </Link>
      ))}
    </nav>
  );
}
