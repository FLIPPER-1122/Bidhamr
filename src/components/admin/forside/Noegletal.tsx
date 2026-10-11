import Link from "next/link";
import type { ForsideTal, PeriodeTal } from "./forsideTal";

// Nøgletal nederst på forsiden: nye brugere, nye auktioner og solgte varer
// for den valgte periode + nye brugere pr. dag i 30 dage. Kun antal.
// Vi har ikke tallet for perioden før, så der vises ingen "+12 %" - kun det,
// vi ved.

export type Periode = "dag" | "uge" | "maaned";

const NAVN: Record<Periode, string> = { dag: "i dag", uge: "7 dage", maaned: "30 dage" };
const NOEGLE: Record<Periode, keyof PeriodeTal> = { dag: "i_dag", uge: "uge", maaned: "maaned" };

export function somPeriode(v: string | undefined): Periode {
  return v === "dag" || v === "maaned" ? v : "uge";
}

const fmt = (n: number) => n.toLocaleString("da-DK");

function Kort({ titel, tal, under }: { titel: string; tal: number; under?: string }) {
  return (
    <div className="rounded-xl border border-admin-kant bg-white px-4 py-3.5">
      <small className="block text-[12.5px] text-tekst-svag">{titel}</small>
      <b className="mt-0.5 block text-[22px] font-bold tabular-nums tracking-tight text-tekst">{fmt(tal)}</b>
      {under && <em className="text-[12.5px] not-italic text-tekst-daempet">{under}</em>}
    </div>
  );
}

export default function Noegletal({ tal, periode }: { tal: ForsideTal; periode: Periode }) {
  const k = NOEGLE[periode];
  const dage = tal.tilvaekst;
  const maks = Math.max(1, ...dage.map((d) => d.nye));
  return (
    <section aria-labelledby="forside-noegletal" className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="forside-noegletal" className="text-[13px] font-semibold uppercase tracking-[0.06em] text-tekst-svag">
          Nøgletal · {NAVN[periode]}
        </h2>
        <nav aria-label="Periode" className="flex gap-1 text-[13.5px]">
          {(Object.keys(NAVN) as Periode[]).map((p, i) => (
            <span key={p} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden="true" className="text-tekst-svag">·</span>}
              <Link
                href={p === "uge" ? "/admin" : `/admin?periode=${p}`}
                aria-current={p === periode ? "true" : undefined}
                className={`inline-flex min-h-9 items-center rounded px-1 font-semibold ${p === periode ? "text-tekst" : "text-groen hover:underline"}`}
              >
                {NAVN[p]}
              </Link>
            </span>
          ))}
        </nav>
      </div>
      <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:grid-cols-3">
        <Kort titel="Nye brugere" tal={tal.brugere[k]} under={`${fmt(tal.brugere.i_alt)} brugere i alt`} />
        <Kort titel="Nye auktioner" tal={tal.aktivitet.auktioner[k]} />
        <Kort titel="Solgte varer (betalte handler)" tal={tal.aktivitet.solgte[k]} />
      </div>
      {dage.length > 0 && (
        <div className="rounded-xl border border-admin-kant bg-white px-4 py-3.5">
          <small className="block text-[12.5px] text-tekst-svag">Nye brugere pr. dag, 30 dage</small>
          <div className="flex h-[90px] items-end gap-[3px] px-1 pt-2.5 sm:gap-[5px]" aria-hidden="true">
            {dage.map((d) => (
              <span
                key={d.dag}
                className="min-w-0 flex-1 rounded-t bg-groen opacity-85"
                style={{ height: `${Math.max(2, (d.nye / maks) * 100)}%` }}
                title={`${d.dag}: ${d.nye}`}
              />
            ))}
          </div>
          <p className="sr-only">
            {fmt(dage.reduce((s, d) => s + d.nye, 0))} nye brugere de sidste {dage.length} dage.
          </p>
        </div>
      )}
    </section>
  );
}
