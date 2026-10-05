import type { TilvaekstDag } from "./forsideTal";

// Tilvækst de sidste 30 dage: søjler = nye brugere pr. dag, linje = brugere i
// alt ved dagens udgang. Ren SVG (intet chart-bibliotek). Tegnefladen strækkes
// til fuld bredde (preserveAspectRatio="none"); al tekst ligger i HTML uden for
// SVG'en, så den ikke bliver forvrænget eller for lille på mobil.

const MAANEDER = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

function kortDato(iso: string) {
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return `${d}. ${MAANEDER[m - 1]}`;
}

const fmt = (n: number) => n.toLocaleString("da-DK");

export default function TilvaekstGraf({ data }: { data: TilvaekstDag[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-neutral-200 bg-white text-sm text-neutral-500">
        Ingen data
      </div>
    );
  }

  const B = 100; // viewBox-bredde
  const H = 100; // viewBox-højde
  const n = data.length;
  const slot = B / n;
  const soejle = slot * 0.7;

  const maksNye = Math.max(1, ...data.map((d) => d.nye));
  const kumMin = Math.min(...data.map((d) => d.kumulativt));
  const kumMax = Math.max(...data.map((d) => d.kumulativt));
  // Linjen bruger sin egen skala (fra laveste til højeste i perioden), så
  // væksten er synlig, selv når der er mange brugere i forvejen.
  const kumSpaend = Math.max(1, kumMax - kumMin);
  const linjeY = (v: number) => H - 4 - ((v - kumMin) / kumSpaend) * (H - 8);

  const punkter = data
    .map((d, i) => `${(i * slot + slot / 2).toFixed(2)},${linjeY(d.kumulativt).toFixed(2)}`)
    .join(" ");

  const nyeIalt = data.reduce((s, d) => s + d.nye, 0);
  const foerste = data[0];
  const sidste = data[n - 1];
  const midt = data[Math.floor((n - 1) / 2)];

  return (
    <div className="min-w-0 rounded-xl border border-neutral-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-neutral-700">Tilvækst de sidste 30 dage</p>
        <p className="text-sm text-neutral-500">
          <span className="font-semibold text-neutral-900">+{fmt(nyeIalt)}</span> nye brugere
        </p>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm bg-orange" />
          Nye pr. dag (højst {fmt(maksNye)})
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-groen" />
          I alt ({fmt(foerste.kumulativt)} til {fmt(sidste.kumulativt)})
        </li>
      </ul>

      <svg
        viewBox={`0 0 ${B} ${H}`}
        preserveAspectRatio="none"
        className="mt-3 block h-40 w-full sm:h-48"
        role="img"
        aria-label={`Nye brugere pr. dag fra ${kortDato(foerste.dag)} til ${kortDato(sidste.dag)}: ${fmt(nyeIalt)} i alt. Brugere i alt steg fra ${fmt(foerste.kumulativt)} til ${fmt(sidste.kumulativt)}.`}
      >
        <line x1={0} y1={H} x2={B} y2={H} stroke="#EEEEEE" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => {
          const h = d.nye > 0 ? Math.max(1.5, (d.nye / maksNye) * (H - 8)) : 0;
          return (
            <rect
              key={d.dag}
              x={i * slot + (slot - soejle) / 2}
              y={H - h}
              width={soejle}
              height={h}
              fill="var(--color-orange)"
              opacity={0.85}
            >
              <title>{`${kortDato(d.dag)}: ${fmt(d.nye)} nye, ${fmt(d.kumulativt)} i alt`}</title>
            </rect>
          );
        })}
        <polyline
          points={punkter}
          fill="none"
          stroke="var(--color-groen)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="mt-1 flex justify-between text-xs text-neutral-500" aria-hidden>
        <span>{kortDato(foerste.dag)}</span>
        <span>{kortDato(midt.dag)}</span>
        <span>{kortDato(sidste.dag)}</span>
      </div>
    </div>
  );
}
