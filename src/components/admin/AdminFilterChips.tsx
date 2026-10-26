import Link from "next/link";
import AdminTal, { type TalTone } from "@/components/admin/AdminTal";

// Filtre, der afgrænser listen (DESIGN 7.5): grønne chips, aktiv = skovgrøn.
// Orange bruges ikke til filtre - orange er til handlingsknapper.
// Faner (skift mellem undersider) er AdminFaner.
export type FilterChip = { id: string; label: string; href: string; antal?: number; tone?: TalTone };

export default function AdminFilterChips({
  chips,
  aktiv,
  label,
}: {
  chips: readonly FilterChip[];
  aktiv: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="flex flex-wrap gap-2">
      {chips.map((c) => {
        const erAktiv = c.id === aktiv;
        return (
          <Link
            key={c.id}
            href={c.href}
            aria-current={erAktiv ? "true" : undefined}
            className={`inline-flex min-h-10 items-center gap-2 rounded-none px-4 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
              erAktiv ? "bg-groen text-white" : "bg-groen-lys text-groen-mork hover:bg-groen-lys-hover"
            }`}
          >
            {c.label}
            {!!c.antal && <AdminTal antal={c.antal} tone={c.tone ?? "graa"} paaGroen={erAktiv} />}
          </Link>
        );
      })}
    </nav>
  );
}
