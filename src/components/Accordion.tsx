"use client";

import { useId, useState, type ReactNode } from "react";

export default function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div className="overflow-hidden rounded-xl border border-kant bg-white">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="flex min-h-11 w-full items-center justify-between gap-4 rounded-xl px-4 py-3 text-left text-sm font-semibold text-tekst hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen"
      >
        {title}
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 shrink-0 text-tekst-svag transition-transform ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div id={id} className="border-t border-kant px-4 py-3 text-sm leading-relaxed text-tekst-daempet">
          {children}
        </div>
      )}
    </div>
  );
}
