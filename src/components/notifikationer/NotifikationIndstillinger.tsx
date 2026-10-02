"use client";

// Indstillingssiden: én række pr. type med tre kontakter (Klokke, Mail, Push i appen).
// Påkrævede typer skal have mindst én kanal slået til - UI'et forhindrer at slå den
// sidste fra, og serveren tjekker det også (dens fejl vises øverst).
import { useId, useRef, useState } from "react";
import { gemIndstillinger, type Indstilling } from "@/app/actions/notifikationer";
import type { Kanal } from "@/lib/notifikationer/typer";

const KANALER: { kanal: Kanal; navn: string }[] = [
  { kanal: "klokke", navn: "Klokke" },
  { kanal: "mail", navn: "Mail" },
  { kanal: "push", navn: "Push i appen" },
];

function antalTil(i: Indstilling) {
  return (i.klokke ? 1 : 0) + (i.mail ? 1 : 0) + (i.push ? 1 : 0);
}

export default function NotifikationIndstillinger({ start }: { start: Indstilling[] }) {
  const [gemt, setGemt] = useState(start);
  const [valg, setValg] = useState(start);
  const [gemmer, setGemmer] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [besked, setBesked] = useState<string | null>(null);
  const fejlRef = useRef<HTMLParagraphElement>(null);
  const paakraevetHjaelpId = useId();

  const aendret = valg.some((v, idx) => {
    const g = gemt[idx];
    return v.klokke !== g.klokke || v.mail !== g.mail || v.push !== g.push;
  });

  function skift(type: Indstilling["type"], kanal: Kanal) {
    setBesked(null);
    setFejl(null);
    setValg((l) =>
      l.map((i) => {
        if (i.type !== type) return i;
        const ny = { ...i, [kanal]: !i[kanal] };
        // Værn: den sidste kanal på en påkrævet type kan ikke slås fra.
        if (i.paakraevet && antalTil(ny) === 0) return i;
        return ny;
      }),
    );
  }

  async function gem() {
    setGemmer(true);
    setFejl(null);
    setBesked(null);
    const svar = await gemIndstillinger(
      valg.map((i) => ({ type: i.type, klokke: i.klokke, mail: i.mail, push: i.push })),
    );
    setGemmer(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      // Flyt fokus til fejlen, så den bliver læst op.
      requestAnimationFrame(() => fejlRef.current?.focus());
      return;
    }
    setGemt(valg);
    setBesked("Dine indstillinger er gemt.");
  }

  function fortryd() {
    setValg(gemt);
    setFejl(null);
    setBesked(null);
  }

  const grupper = [
    {
      titel: "Handel og betaling",
      tekst: "Vigtige beskeder om dine handler. Du skal have mindst én kanal slået til.",
      raekker: valg.filter((i) => i.paakraevet),
    },
    {
      titel: "Auktioner og aktivitet",
      tekst: "Valgfrie beskeder. Du kan slå dem helt fra.",
      raekker: valg.filter((i) => !i.paakraevet),
    },
  ];

  return (
    <div>
      {fejl && (
        <p
          ref={fejlRef}
          tabIndex={-1}
          role="alert"
          className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst focus:outline-none"
        >
          {fejl}
        </p>
      )}

      <p id={paakraevetHjaelpId} className="sr-only">
        Du skal have mindst én kanal slået til.
      </p>

      {grupper.map((g) => (
        <section key={g.titel} className="mt-6 rounded-[14px] border border-kant bg-white">
          <div className="border-b border-kant p-4 sm:px-6">
            <h2 className="text-[20px] font-semibold leading-tight text-tekst sm:text-[22px]">{g.titel}</h2>
            <p className="mt-1 text-sm text-tekst-daempet">{g.tekst}</p>
          </div>

          {/* Kolonneoverskrifter - kun på bredere skærme, på mobil står navnet ved hver kontakt */}
          <div
            aria-hidden="true"
            className="hidden grid-cols-[1fr_repeat(3,88px)] gap-2 border-b border-kant px-6 py-2 text-xs font-medium text-tekst-svag sm:grid"
          >
            <span />
            {KANALER.map((k) => (
              <span key={k.kanal} className="text-center">
                {k.navn}
              </span>
            ))}
          </div>

          <ul>
            {g.raekker.map((i) => {
              const sidsteTil = i.paakraevet && antalTil(i) === 1;
              return (
                <li
                  key={i.type}
                  className="grid gap-3 border-b border-kant p-4 last:border-b-0 sm:grid-cols-[1fr_repeat(3,88px)] sm:items-center sm:gap-2 sm:px-6"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="font-sans text-[15px] font-semibold text-tekst">{i.navn}</h3>
                      {i.paakraevet && (
                        <span className="rounded-full bg-groen-lys px-2 py-0.5 text-xs font-semibold text-groen-mork">
                          Påkrævet
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-tekst-daempet">{i.beskrivelse}</p>
                    {sidsteTil && (
                      <p className="mt-1 text-xs text-tekst-svag">Du skal have mindst én kanal slået til.</p>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:contents">
                    {KANALER.map((k) => {
                      const til = i[k.kanal];
                      const laast = sidsteTil && til;
                      return (
                        <div key={k.kanal} className="flex flex-col items-center gap-1 sm:justify-center">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={til}
                            aria-label={`${k.navn}: ${i.navn}`}
                            aria-disabled={laast || undefined}
                            aria-describedby={laast ? paakraevetHjaelpId : undefined}
                            title={laast ? "Du skal have mindst én kanal slået til" : undefined}
                            onClick={() => {
                              if (!laast) skift(i.type, k.kanal);
                            }}
                            className={`group flex h-11 w-14 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                              laast ? "cursor-not-allowed" : ""
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className={`relative h-6 w-11 rounded-full transition-colors duration-150 ${
                                til ? (laast ? "bg-groen/50" : "bg-groen") : "bg-kant-staerk"
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none ${
                                  til ? "translate-x-5" : ""
                                }`}
                              />
                            </span>
                          </button>
                          <span aria-hidden="true" className="text-xs text-tekst-svag sm:hidden">
                            {k.navn}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <p className="mt-4 text-sm text-tekst-daempet">
        Push i appen virker, når du er logget ind i BidHamr-appen på din telefon.
      </p>

      {/* Gem-linje: holder sig synlig i bunden, mens man scroller på mobil */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-6 border-t border-kant bg-white px-4 py-4 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0">
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={gem}
            disabled={gemmer || !aendret}
            aria-busy={gemmer}
            className="btn btn-primaer btn-stor w-full sm:w-auto"
          >
            {gemmer && <span className="btn-spinner" aria-hidden="true" />}
            Gem indstillinger
          </button>
          {aendret && !gemmer && (
            <button type="button" onClick={fortryd} className="btn btn-tekst min-h-11 self-center">
              Fortryd ændringer
            </button>
          )}
          <p role="status" className="text-sm font-medium text-succes-tekst sm:ml-2">
            {besked}
          </p>
        </div>
      </div>
    </div>
  );
}
