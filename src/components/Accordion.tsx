"use client";

import { useState, type ReactNode } from "react";

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

  return (
    <div className="border border-neutral-200 bg-[#F3F4F6]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-[#111]"
      >
        {title}
        <svg
          viewBox="0 0 24 24"
          className={`h-4 w-4 text-neutral-500 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-neutral-200 px-4 py-3 text-sm text-neutral-700">
          {children}
        </div>
      )}
    </div>
  );
}
