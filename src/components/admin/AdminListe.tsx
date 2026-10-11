import type { ReactNode } from "react";

// Liste, der er en rigtig tabel fra lg og kort under lg
// (docs/ADMIN-REDESIGN.md 4.4). Hver celle tegnes ÉN gang - kun CSS skifter
// mellem kort og tabel - så knapper og dialoger i en række ikke findes to
// gange. Ingen vandret scroll ved 360 px.
//
// mobil: hvor cellen står på kortet.
//   "status"   - øverst (badges)
//   "titel"    - titlen (fed)
//   "meta"     - en linje under titlen (med kolonnens navn foran, hvis mobilLabel)
//   "handling" - nederst, adskilt af en streg
//   "skjul"    - vises kun i tabellen
export type Kolonne<T> = {
  id: string;
  label: string;
  celle: (r: T) => ReactNode;
  mobil?: "status" | "titel" | "meta" | "handling" | "skjul";
  mobilLabel?: boolean;
  hoejre?: boolean;
  // Klasse på cellen i tabellen, fx en bredde.
  className?: string;
};

const ORDEN: Record<NonNullable<Kolonne<unknown>["mobil"]>, string> = {
  status: "order-1",
  titel: "order-2",
  meta: "order-3",
  handling: "order-4 mt-2 border-t border-kant pt-3 lg:mt-0 lg:border-t-0 lg:pt-3",
  skjul: "hidden",
};

export default function AdminListe<T>({
  raekker,
  kolonner,
  noegle,
  fremhaev,
  label,
  tom,
}: {
  raekker: readonly T[];
  kolonner: readonly Kolonne<T>[];
  noegle: (r: T) => string;
  // Rækker, der kræver handling, får advarselsbaggrund.
  fremhaev?: (r: T) => boolean;
  label: string;
  tom?: ReactNode;
}) {
  if (raekker.length === 0 && tom) return <>{tom}</>;
  return (
    <div className="lg:overflow-hidden lg:rounded-[14px] lg:border lg:border-kant lg:bg-white">
      <table aria-label={label} className="block w-full text-sm lg:table">
        <thead className="hidden lg:table-header-group">
          <tr className="border-b border-kant bg-admin-bg text-left text-xs font-semibold uppercase tracking-wide text-tekst-svag">
            {kolonner.map((k) => (
              <th key={k.id} scope="col" className={`px-4 py-3 ${k.hoejre ? "text-right" : ""}`}>
                {k.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="block space-y-3 lg:table-row-group lg:space-y-0">
          {raekker.map((r) => {
            const vigtig = fremhaev?.(r) ?? false;
            return (
              <tr
                key={noegle(r)}
                className={`flex min-w-0 flex-col gap-1.5 rounded-[14px] border p-4 align-top lg:table-row lg:rounded-none lg:border-0 lg:border-t lg:border-kant lg:p-0 lg:first:border-t-0 ${
                  vigtig ? "border-advarsel-kant bg-advarsel-bg/50" : "border-kant bg-white lg:hover:bg-admin-bg/60"
                }`}
              >
                {kolonner.map((k) => {
                  const plads = k.mobil ?? "meta";
                  return (
                    <td
                      key={k.id}
                      className={`${ORDEN[plads]} min-w-0 break-words lg:table-cell lg:px-4 lg:py-3 lg:align-top ${
                        plads === "skjul" ? "lg:table-cell" : ""
                      } ${plads === "titel" ? "font-semibold text-tekst lg:font-normal" : "text-tekst-daempet lg:text-tekst"} ${
                        k.hoejre ? "lg:text-right" : ""
                      } ${k.className ?? ""}`}
                    >
                      {plads === "meta" && k.mobilLabel && (
                        <span className="mr-1 text-xs text-tekst-svag lg:hidden">{k.label}:</span>
                      )}
                      {k.celle(r)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
