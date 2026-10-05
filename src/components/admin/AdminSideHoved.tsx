import type { ReactNode } from "react";

// Fælles hoved på alle admin-sider: titel + én kort linje om, hvad siden er
// til, og hvornår man bruger den. `hoejre` er valgfrit indhold ved siden af
// titlen (fx et antal eller en knap). `children` kommer under forklaringen
// (fx en ekstra note eller et link).
export default function AdminSideHoved({
  titel,
  forklaring,
  hoejre,
  children,
}: {
  titel: string;
  forklaring: ReactNode;
  hoejre?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="break-words text-2xl font-bold text-neutral-900">{titel}</h1>
        <p className="mt-1 max-w-3xl text-sm text-neutral-600">{forklaring}</p>
        {children}
      </div>
      {hoejre && <div className="flex shrink-0 flex-wrap items-center gap-2">{hoejre}</div>}
    </div>
  );
}
