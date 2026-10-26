// Tal-badge farvet efter alvor (docs/ADMIN-REDESIGN.md 2.1): roed = frist
// overskredet/kritisk, gul = venter, graa = til orientering. Rød er tilladt
// her som undtagelse for tal-badges (DESIGN.md 1.4).
export type TalTone = "roed" | "gul" | "graa";

export default function AdminTal({
  antal,
  tone = "gul",
  paaGroen = false,
  label,
}: {
  antal: number;
  tone?: TalTone;
  // Står på en mørk/grøn flade (menu, aktiv chip).
  paaGroen?: boolean;
  label?: string;
}) {
  if (!antal) return null;
  const cls =
    tone === "roed"
      ? "bg-tal-roed text-white"
      : tone === "gul"
        ? paaGroen
          ? "bg-tal-gul text-tekst"
          : "border border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
        : paaGroen
          ? "bg-white/20 text-white"
          : "bg-admin-graa text-tekst-daempet";
  return (
    <span
      className={`relative inline-flex min-w-[22px] items-center justify-center rounded-none px-1.5 py-px text-[11.5px] font-bold tabular-nums ${cls}`}
    >
      {antal}
      <span className="sr-only"> {label ?? (tone === "roed" ? "kritiske" : "venter")}</span>
    </span>
  );
}
