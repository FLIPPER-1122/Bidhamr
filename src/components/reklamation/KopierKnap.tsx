"use client";

import { useEffect, useRef, useState } from "react";

// Kopiér-knap til reklamationspakken: ét klik lægger teksten i
// udklipsholderen, og knappen siger "Kopieret" et øjeblik. Virker også, hvor
// navigator.clipboard mangler (ældre browsere / ikke-https) via et skjult
// tekstfelt.
async function kopier(tekst: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tekst);
      return true;
    }
  } catch {
    // Prøv reserveløsningen nedenfor.
  }
  try {
    const felt = document.createElement("textarea");
    felt.value = tekst;
    felt.setAttribute("readonly", "");
    felt.style.position = "fixed";
    felt.style.opacity = "0";
    document.body.appendChild(felt);
    felt.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(felt);
    return ok;
  } catch {
    return false;
  }
}

export default function KopierKnap({
  tekst,
  label,
  stor = false,
}: {
  tekst: string;
  // Hvad der kopieres - til skærmlæsere, fx "trackingnummer".
  label: string;
  // "Kopiér alt": stor, fyldt knap i fuld bredde på mobil.
  stor?: boolean;
}) {
  const [status, setStatus] = useState<"" | "ok" | "fejl">("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function klik() {
    const ok = await kopier(tekst);
    setStatus(ok ? "ok" : "fejl");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(""), 2500);
  }

  const tekstPaaKnap = status === "ok" ? "Kopieret" : status === "fejl" ? "Kunne ikke kopiere" : stor ? "Kopiér alt" : "Kopiér";

  return (
    <>
      <button
        type="button"
        onClick={klik}
        aria-label={status ? undefined : `Kopiér ${label}`}
        className={
          stor
            ? "btn btn-sekundaer w-full sm:w-auto"
            : `inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:min-h-9 ${
                status === "ok"
                  ? "border-succes-kant bg-succes-bg text-succes-tekst"
                  : status === "fejl"
                    ? "border-fejl-kant bg-fejl-bg text-fejl-tekst"
                    : "border-kant-staerk bg-white text-groen hover:bg-groen-lys"
              }`
        }
      >
        {status === "ok" ? (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
          </svg>
        ) : (
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 8m0 2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2zM16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2" />
          </svg>
        )}
        {tekstPaaKnap}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {status === "ok" ? `${label} er kopieret` : status === "fejl" ? "Kunne ikke kopiere. Markér teksten, og kopiér den selv." : ""}
      </span>
    </>
  );
}
