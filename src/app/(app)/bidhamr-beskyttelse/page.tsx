import type { Metadata } from "next";
import {
  FAQ,
  FAQ_OVERSKRIFT,
  INTRO,
  METABESKRIVELSE,
  SEKTION_ALTID,
  SEKTION_MED,
  SEKTIONER,
  SIDETITEL,
  type Sektion,
} from "@/lib/tekster/beskyttelse";

export const metadata: Metadata = {
  title: SIDETITEL,
  description: METABESKRIVELSE,
};

// "Altid" og "Med" vises side om side; resten som almindelige sektioner.
const OEVRIGE = SEKTIONER.filter((s) => s !== SEKTION_ALTID && s !== SEKTION_MED);

function Punkter({ punkter, accent }: { punkter: string[]; accent: string }) {
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {punkter.map((p) => (
        <li key={p} className="flex gap-3 text-sm leading-relaxed text-tekst">
          <span aria-hidden className={`mt-2 h-2 w-2 shrink-0 rounded-full ${accent}`} />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

function Kolonne({
  sektion,
  maerke,
  fremhaevet,
}: {
  sektion: Sektion;
  maerke: string;
  fremhaevet?: boolean;
}) {
  return (
    <section
      className={`rounded-2xl p-6 sm:p-8 ${
        fremhaevet ? "border-2 border-groen bg-white" : "bg-groen-lys"
      }`}
    >
      <span
        className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${
          fremhaevet ? "bg-groen text-white" : "bg-white text-groen-mork"
        }`}
      >
        {maerke}
      </span>
      <h2 className="mt-3 text-xl text-groen-mork">{sektion.overskrift}</h2>
      {sektion.tekst && <p className="mt-2 text-sm text-tekst-daempet">{sektion.tekst}</p>}
      <Punkter punkter={sektion.punkter} accent={fremhaevet ? "bg-orange" : "bg-groen"} />
    </section>
  );
}

export default function BeskyttelsePage() {
  return (
    <main className="mx-auto w-full max-w-[1080px] flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-[65ch]">
        <h1 className="text-3xl text-groen-mork sm:text-4xl">{SIDETITEL}</h1>
        <p className="mt-4 text-base leading-relaxed text-tekst-daempet">{INTRO}</p>
      </header>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        <Kolonne sektion={SEKTION_ALTID} maerke="Altid" />
        <Kolonne sektion={SEKTION_MED} maerke="Med BidHamr Beskyttelse" fremhaevet />
      </div>

      <div className="mt-10 flex flex-col gap-8">
        {OEVRIGE.map((s) => (
          <section key={s.overskrift} className="rounded-2xl border border-kant bg-white p-6 sm:p-8">
            <h2 className="text-xl text-groen-mork">{s.overskrift}</h2>
            {s.tekst && <p className="mt-2 text-sm text-tekst-daempet">{s.tekst}</p>}
            <Punkter punkter={s.punkter} accent="bg-groen" />
          </section>
        ))}
      </div>

      <section className="mt-12">
        <h2 className="text-2xl text-groen-mork">{FAQ_OVERSKRIFT}</h2>
        {/* Accordion med <details>: virker uden JavaScript. */}
        <div className="mt-5 flex flex-col gap-3">
          {FAQ.map((f) => (
            <details key={f.spoergsmaal} className="group rounded-xl border border-kant bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-tekst [&::-webkit-details-marker]:hidden">
                {f.spoergsmaal}
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4 shrink-0 text-tekst-svag transition-transform group-open:rotate-180"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                </svg>
              </summary>
              <p className="border-t border-kant px-5 py-4 text-sm leading-relaxed text-tekst-daempet">
                {f.svar}
              </p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
