import Link from "next/link";

// Fejl- og indlæsningstilstand for checkout (/mine-handler/[id]/betal).
// Ingen "use client": kan vises direkte fra server-siden.

export default function CheckoutFejl({ handelSti, tekst }: { handelSti: string; tekst: string }) {
  return (
    <main className="flex-1 px-4 pt-6 pb-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl rounded-[14px] border border-fejl-kant bg-fejl-bg p-6 text-fejl-tekst">
        <h1 className="font-serif text-[22px] leading-tight font-semibold">Betalingen kunne ikke vises</h1>
        <p className="mt-2 text-sm">{tekst}</p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Link href={`${handelSti}?vis=handel`} className="btn btn-sekundaer">
            Til handlen
          </Link>
          <Link
            href="/mine-handler"
            className="text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            Mine handler
          </Link>
        </div>
      </div>
    </main>
  );
}

const blok = "animate-pulse rounded bg-skelet";
const flade = "animate-pulse rounded-[14px] bg-groen-lys";

// Samme geometri som checkout: vare, levering og betaling til venstre,
// prisoversigt til højre (under på mobil).
export function CheckoutSkelet() {
  return (
    <main className="flex-1 px-4 pt-4 pb-10 sm:px-6 lg:px-8 lg:pt-6" aria-busy="true">
      <span className="sr-only">Indlæser betalingen…</span>
      <div className="mx-auto max-w-[1120px]">
        <div className={`h-4 w-40 ${blok}`} />
        <div className={`mt-4 h-8 w-64 max-w-full ${blok}`} />
        <div className={`mt-4 h-12 ${flade}`} />
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
          <div className="space-y-6">
            <div className="flex items-center gap-4 rounded-[14px] border border-kant p-5">
              <div className="h-20 w-20 shrink-0 animate-pulse rounded-lg bg-skelet" />
              <div className="flex-1 space-y-2">
                <div className={`h-5 w-3/5 ${blok}`} />
                <div className={`h-4 w-28 ${blok}`} />
              </div>
            </div>
            <div className={`h-64 ${flade}`} />
            <div className={`h-48 ${flade}`} />
          </div>
          <div className={`h-80 ${flade}`} />
        </div>
      </div>
    </main>
  );
}
