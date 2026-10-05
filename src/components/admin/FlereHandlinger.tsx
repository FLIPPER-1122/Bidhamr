"use client";

import { useId, useState, type ReactNode } from "react";

// "Flere handlinger" – samler sjældne eller farlige knapper bag én knap, så
// hver række i en tabel kun har én tydelig hovedknap. Lavet som en
// disclosure (knap + indhold, der foldes ud under), så den virker med
// tastatur og ikke klippes af tabellens vandrette scroll.
//
// Indholdet skjules med `hidden`, når den er lukket. Bekræftelsesdialogerne
// ligger inde i indholdet, så menuen lukker bevidst IKKE af sig selv, når man
// trykker på en knap – ellers ville dialogen forsvinde med den.
export default function FlereHandlinger({
  children,
  label = "Flere handlinger",
}: {
  children: ReactNode;
  label?: string;
}) {
  const id = useId();
  const [aaben, setAaben] = useState(false);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setAaben((v) => !v)}
        aria-expanded={aaben}
        aria-controls={id}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
      >
        {label}
        <svg
          className={`h-3.5 w-3.5 transition-transform ${aaben ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      <div
        id={id}
        hidden={!aaben}
        className="mt-2 flex flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2"
      >
        {children}
      </div>
    </div>
  );
}
