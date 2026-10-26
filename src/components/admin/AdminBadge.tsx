import type { ReactNode } from "react";

// Én statusbadge med fem toner fra DESIGN.md 1.4 (+ orange til "ny").
// groen = løst/ok/aktiv, gul = venter/advarsel, roed = fejlet/over frist,
// blaa = i gang/testmiljø, graa = afsluttet/afvist, orange = ny.
export type BadgeTone = "groen" | "gul" | "roed" | "blaa" | "graa" | "orange";

const TONE: Record<BadgeTone, string> = {
  groen: "border-succes-kant bg-succes-bg text-succes-tekst",
  gul: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst",
  roed: "border-fejl-kant bg-fejl-bg text-fejl-tekst",
  blaa: "border-info-kant bg-info-bg text-info-tekst",
  graa: "border-kant bg-admin-graa text-tekst-daempet",
  orange: "border-advarsel-kant bg-orange-lys text-advarsel-tekst",
};

const PRIK: Record<BadgeTone, string> = {
  groen: "bg-lampe-groen",
  gul: "bg-lampe-gul",
  roed: "bg-lampe-roed",
  blaa: "bg-lampe-blaa",
  graa: "bg-lampe-graa",
  orange: "bg-orange",
};

export default function AdminBadge({
  tone,
  children,
  prik = false,
  className = "",
}: {
  tone: BadgeTone;
  children: ReactNode;
  prik?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-none border px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]} ${className}`}
    >
      {prik && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${PRIK[tone]}`} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

// Lille farvet prik (lamper og "Kræver handling"). Farven er aldrig eneste
// signal - der står altid en tekst ved siden af.
export function AdminPrik({ tone, className = "" }: { tone: BadgeTone; className?: string }) {
  return <span aria-hidden="true" className={`inline-block h-[11px] w-[11px] shrink-0 rounded-full ${PRIK[tone]} ${className}`} />;
}
