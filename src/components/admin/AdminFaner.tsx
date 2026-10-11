import type { ReactNode } from "react";
import Link from "next/link";
import RulAktivFane from "@/components/admin/RulAktivFane";
import AdminTal, { type TalTone } from "@/components/admin/AdminTal";

// antal/tone: fanens eget tal, farvet efter alvor (roed = over frist,
// gul = venter, graa = til orientering).
export type AdminFane = { id: string; label: ReactNode; href: string; antal?: number; tone?: TalTone };

// Fælles faner øverst på en admin-side (fx Anmeldelser og Brugere). Hver
// fane er sin egen URL, så gamle links og bogmærker stadig virker. En fane,
// man ikke har adgang til, skal ikke gives med (siden tjekker selv adgangen).
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
    <nav aria-label={label} className="-mx-4 flex gap-1 overflow-x-auto border-b border-admin-kant px-4 sm:mx-0 sm:px-0">
      {faner.map((f) => (
        <Link
          key={f.id}
          href={f.href}
          aria-current={aktiv === f.id ? "page" : undefined}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:px-4 ${
            aktiv === f.id
              ? "border-groen font-semibold text-groen-mork"
              : "border-transparent text-tekst-daempet hover:text-tekst"
          }`}
        >
          {f.label}
          {!!f.antal && <AdminTal antal={f.antal} tone={f.tone ?? "gul"} />}
        </Link>
      ))}
      <RulAktivFane aktiv={aktiv} />
    </nav>
  );
}
