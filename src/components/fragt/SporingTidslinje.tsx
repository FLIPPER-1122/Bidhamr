// Sporingstidslinje for en forsendelse (køber og sælger). Ingen hooks og
// ingen "use client": kan bruges i både server- og klientkomponenter.
// Tiderne vises i dansk tid, så server og browser viser det samme.
// TODO(indhold): gennemse teksterne.
import type { ForsendelseVisning } from "@/lib/fragt/handlinger";

const tidFormat = new Intl.DateTimeFormat("da-DK", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Copenhagen",
});

type Trin = { noegle: string; navn: string; tid: string | null };

function foersteHaendelse(f: ForsendelseVisning, type: string) {
  return f.haendelser.find((h) => h.type === type)?.tidspunkt ?? null;
}

export default function SporingTidslinje({ f }: { f: ForsendelseVisning }) {
  const doer = f.levering === "doer";
  const trin: Trin[] = [
    { noegle: "oprettet", navn: "Label lavet", tid: f.oprettetKl },
    { noegle: "afleveret", navn: "Pakken er indleveret", tid: f.afleveretKl ?? foersteHaendelse(f, "afleveret") },
    { noegle: "i_transit", navn: "Pakken er undervejs", tid: foersteHaendelse(f, "i_transit") },
    ...(doer
      ? []
      : [
          {
            noegle: "klar_til_afhentning",
            navn: "Klar til afhentning i pakkeshoppen",
            tid: f.klarTilAfhentningKl ?? foersteHaendelse(f, "klar_til_afhentning"),
          },
        ]),
    { noegle: "leveret", navn: doer ? "Pakken er leveret" : "Pakken er hentet", tid: f.leveretKl ?? foersteHaendelse(f, "leveret") },
  ];
  // Et senere trin betyder, at de tidligere også er nået (fragtfirmaet melder
  // ikke altid alle trin).
  const sidsteNaaede = trin.reduce((s, t, i) => (t.tid ? i : s), -1);
  const problemer = f.haendelser.filter((h) => h.type === "returneret" || h.type === "fejl");

  return (
    <div>
      <ol className="space-y-0" aria-label="Pakkens vej">
        {trin.map((t, i) => {
          const naaet = i <= sidsteNaaede;
          const sidste = i === trin.length - 1;
          return (
            <li key={t.noegle} className="relative flex gap-3 pb-4 last:pb-0" aria-current={i === sidsteNaaede ? "step" : undefined}>
              {!sidste && (
                <span
                  aria-hidden="true"
                  className={`absolute top-5 left-[9px] h-[calc(100%-12px)] w-0.5 ${i < sidsteNaaede ? "bg-groen" : "bg-kant"}`}
                />
              )}
              <span
                aria-hidden="true"
                className={`relative mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
                  naaet ? "border-groen bg-groen" : "border-kant-staerk bg-white"
                }`}
              >
                {naaet && (
                  <svg viewBox="0 0 24 24" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth={3}>
                    <path d="M5 12l5 5l10 -10" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm ${naaet ? "font-semibold text-tekst" : "text-tekst-svag"}`}>
                  {t.navn}
                  <span className="sr-only">{naaet ? " (sket)" : " (ikke endnu)"}</span>
                </span>
                {t.tid && <span className="block text-[12px] text-tekst-svag">{tidFormat.format(new Date(t.tid))}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {problemer.length > 0 && (
        <ul className="mt-3 space-y-2">
          {problemer.map((p) => (
            <li
              key={`${p.type}-${p.tidspunkt}`}
              className="rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-[13px] text-advarsel-tekst"
            >
              <span className="font-semibold">{p.navn}</span> · {tidFormat.format(new Date(p.tidspunkt))}
              {p.beskrivelse && <span className="block">{p.beskrivelse}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
