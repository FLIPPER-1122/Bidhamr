"use client";

import { useEffect, useId, useRef, useState } from "react";
import AnmeldFormular from "@/components/dsa/AnmeldFormular";
import type { IndholdType } from "@/lib/dsa/regler";

// "Anmeld" på auktioner, profiler, spørgsmål/svar og bedømmelser (DSA art.
// 16). Åbner en dialog med formularen; placeringen udfyldes automatisk ud
// fra type + id. Virker med og uden login.
export default function AnmeldKnap({
  type,
  id,
  hvad,
  loggetInd,
  label = "Anmeld",
  className,
}: {
  type: Exclude<IndholdType, "andet">;
  id: string;
  hvad: string;
  loggetInd: boolean;
  label?: string;
  className?: string;
}) {
  const titelId = useId();
  const [aaben, setAaben] = useState(false);
  // Ny formular hver gang dialogen åbnes.
  const [noegle, setNoegle] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!aaben) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAaben(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aaben]);

  function luk() {
    setAaben(false);
    knapRef.current?.focus();
  }

  return (
    <>
      <button
        ref={knapRef}
        type="button"
        onClick={() => {
          setNoegle((n) => n + 1);
          setAaben(true);
        }}
        aria-haspopup="dialog"
        className={
          className ??
          "inline-flex min-h-11 items-center gap-1.5 rounded-md text-[13px] font-medium text-tekst-svag hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        }
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 21V5.25A2.25 2.25 0 015.25 3h6l.75 1.5h6.75a1.5 1.5 0 011.5 1.5v7.5a1.5 1.5 0 01-1.5 1.5H12l-.75-1.5H3" />
        </svg>
        {label}
      </button>

      {aaben && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={luk}>
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titelId}
            tabIndex={-1}
            className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[18px] bg-white p-5 shadow-stor outline-none sm:rounded-[14px] sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={titelId} className="text-[20px] leading-tight">
              Anmeld ulovligt indhold
            </h2>
            <p className="mb-4 mt-1 text-sm text-tekst-daempet">
              Mener du, at noget er ulovligt eller bryder BidHamrs regler? Fortæl os hvorfor, så ser en medarbejder på det.
            </p>
            <AnmeldFormular key={noegle} type={type} id={id} hvad={hvad} loggetInd={loggetInd} onLuk={luk} />
          </div>
        </div>
      )}
    </>
  );
}
