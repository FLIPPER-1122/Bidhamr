"use client";

import { useEffect, useRef, useState } from "react";

// Kvittering efter en handling i admin (fx "Anmeldelsen er afsluttet").
// ConfirmDialog kalder visKvittering(); denne komponent står én gang på siden
// og læser beskeden op via aria-live. Kortet, handlingen gjaldt, forsvinder
// ofte fra listen, når siden opdateres - så flyttes fokus hertil, i stedet for
// at det forsvinder ud i ingenting.

const HAENDELSE = "bidhamr:admin-kvittering";

export function visKvittering(tekst: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(HAENDELSE, { detail: tekst }));
}

export default function Statuslinje() {
  const [besked, setBesked] = useState<{ tekst: string; n: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function modtag(e: Event) {
      const tekst = (e as CustomEvent<string>).detail;
      if (typeof tekst === "string" && tekst) setBesked((b) => ({ tekst, n: (b?.n ?? 0) + 1 }));
    }
    window.addEventListener(HAENDELSE, modtag);
    return () => window.removeEventListener(HAENDELSE, modtag);
  }, []);

  useEffect(() => {
    if (!besked) return;
    // Siden opdateres efter handlingen; er knappen, der havde fokus, væk,
    // flyttes fokus til kvitteringen.
    // Opdateringen kan tage lidt tid, så der holdes øje i op til 4 sekunder.
    let gange = 0;
    const t1 = window.setInterval(() => {
      const aktiv = document.activeElement;
      if (!aktiv || aktiv === document.body || !aktiv.isConnected) {
        ref.current?.focus();
        window.clearInterval(t1);
      } else if (++gange >= 20) {
        window.clearInterval(t1);
      }
    }, 200);
    const t2 = window.setTimeout(() => setBesked(null), 8000);
    return () => {
      window.clearInterval(t1);
      window.clearTimeout(t2);
    };
  }, [besked]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex justify-center outline-none sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      {besked && (
        <p
          key={besked.n}
          className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border border-succes-kant bg-succes-bg px-4 py-3 text-sm font-medium text-succes-tekst shadow-[0_8px_30px_rgba(0,0,0,.13)]"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.25}>
            <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{besked.tekst}</span>
          <button
            type="button"
            onClick={() => setBesked(null)}
            className="-my-1 -mr-2 ml-1 rounded-md px-2 py-1 text-xs font-semibold text-succes-tekst hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-groen"
          >
            Luk
          </button>
        </p>
      )}
    </div>
  );
}
