// Status på en DSA-sag som en tidslinje (Modtaget → Behandles → Afgjort →
// Klage → Klage afgjort). En almindelig ordnet liste, hvor det trin, sagen er
// nået til, har aria-current="step", så skærmlæsere kan følge med.

export type Trin = {
  titel: string;
  tekst?: string;
  tid?: string | null;
  tilstand: "faerdig" | "aktiv" | "kommende";
};

const dato = (iso: string) =>
  new Date(iso).toLocaleDateString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const TILSTAND_SR: Record<Trin["tilstand"], string> = {
  faerdig: "Færdig",
  aktiv: "Nu",
  kommende: "Kommer senere",
};

export default function Tidslinje({ trin, label = "Sagens forløb" }: { trin: Trin[]; label?: string }) {
  // Er intet trin aktivt (sagen er slut), er det sidste færdige trin "nu".
  const aktivIndex = trin.findIndex((t) => t.tilstand === "aktiv");
  const nuIndex = aktivIndex >= 0 ? aktivIndex : trin.map((t) => t.tilstand).lastIndexOf("faerdig");

  return (
    <ol aria-label={label} className="relative">
      {trin.map((t, i) => {
        const sidste = i === trin.length - 1;
        const erNu = i === nuIndex;
        return (
          <li key={`${t.titel}-${i}`} aria-current={erNu ? "step" : undefined} className="relative flex gap-3 pb-5 last:pb-0">
            {!sidste && (
              <span
                aria-hidden="true"
                className={`absolute left-[11px] top-7 bottom-1 w-0.5 rounded ${t.tilstand === "faerdig" ? "bg-groen" : "bg-kant-staerk"}`}
              />
            )}
            <span
              aria-hidden="true"
              className={`relative z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 ${
                t.tilstand === "faerdig"
                  ? "border-groen bg-groen text-white"
                  : t.tilstand === "aktiv"
                    ? "border-orange-knap bg-white"
                    : "border-kant-staerk bg-white"
              }`}
            >
              {t.tilstand === "faerdig" ? (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={3}>
                  <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : t.tilstand === "aktiv" ? (
                <span className="h-2 w-2 rounded-full bg-orange-knap" />
              ) : null}
            </span>
            <div className="min-w-0">
              <p
                className={`text-[15px] leading-6 ${
                  t.tilstand === "kommende" ? "text-tekst-svag" : "font-semibold text-tekst"
                }`}
              >
                <span className="sr-only">{TILSTAND_SR[t.tilstand]}: </span>
                {t.titel}
              </p>
              {t.tid && <p className="text-sm text-tekst-svag">{dato(t.tid)}</p>}
              {t.tekst && <p className="mt-0.5 text-sm text-tekst-daempet">{t.tekst}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
