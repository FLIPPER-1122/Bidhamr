import type { PeriodeTal } from "./forsideTal";

const fmt = (n: number) => n.toLocaleString("da-DK");

// Et kort med i dag / denne uge / denne måned (Europe/Copenhagen).
export default function PeriodeKort({
  titel,
  tal,
  hovedtal,
}: {
  titel: string;
  tal: PeriodeTal;
  // Valgfrit stort tal øverst (fx brugere i alt).
  hovedtal?: { label: string; vaerdi: number };
}) {
  const felter: [string, number][] = [
    ["I dag", tal.i_dag],
    ["Denne uge", tal.uge],
    ["Denne måned", tal.maaned],
  ];
  return (
    <div className="min-w-0 rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{titel}</p>
      {hovedtal && (
        <p className="mt-1">
          <span className="text-3xl font-bold tabular-nums text-neutral-900">{fmt(hovedtal.vaerdi)}</span>{" "}
          <span className="text-sm text-neutral-500">{hovedtal.label}</span>
        </p>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {felter.map(([label, v]) => (
          <div key={label} className="min-w-0 rounded-lg bg-neutral-50 px-2 py-2 text-center">
            <dt className="truncate text-xs text-neutral-500">{label}</dt>
            <dd className="text-lg font-bold tabular-nums text-neutral-900">{fmt(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
