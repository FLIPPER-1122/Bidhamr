import type { ReactNode } from "react";
import Link from "next/link";

// Fælles hoved på alle admin-sider: titel + én kort linje om, hvad siden er
// til. `hoejre` (eller `handlinger`) står ved siden af titlen på computer og
// under forklaringen i fuld bredde på mobil. `tilbage` er et lille link over
// titlen på detaljesider. `hjaelp` er en længere forklaring, der foldes ud
// ("Sådan bruger du siden"). `children` kommer under forklaringen.
export default function AdminSideHoved({
  titel,
  forklaring,
  hoejre,
  handlinger,
  tilbage,
  hjaelp,
  children,
  badges,
}: {
  titel: ReactNode;
  forklaring?: ReactNode;
  hoejre?: ReactNode;
  handlinger?: ReactNode;
  tilbage?: { href: string; label: string };
  hjaelp?: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
}) {
  const hoejreIndhold = handlinger ?? hoejre;
  return (
    <div className="space-y-1">
      {tilbage && (
        <Link
          href={tilbage.href}
          className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-sm font-medium text-tekst-daempet hover:text-tekst focus-visible:outline-2 focus-visible:outline-groen sm:min-h-9"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          {tilbage.label}
        </Link>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {badges && <div className="mb-1.5 flex flex-wrap items-center gap-2">{badges}</div>}
          <h1 className="break-words text-[26px] font-bold leading-tight text-tekst">{titel}</h1>
          {forklaring && <p className="mt-1 max-w-3xl text-sm text-tekst-daempet">{forklaring}</p>}
          {children}
          {hjaelp && (
            <details className="group mt-2 max-w-3xl text-sm text-tekst-daempet">
              <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1 font-medium text-groen hover:underline">
                Sådan bruger du siden
                <svg className="h-4 w-4 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </summary>
              <div className="mt-1 space-y-2">{hjaelp}</div>
            </details>
          )}
        </div>
        {hoejreIndhold && (
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{hoejreIndhold}</div>
        )}
      </div>
    </div>
  );
}
