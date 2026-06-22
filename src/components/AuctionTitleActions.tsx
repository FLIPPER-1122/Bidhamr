"use client";

import { useState } from "react";

export default function AuctionTitleActions() {
  const [gemt, setGemt] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <button
        aria-label="Del auktion"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 text-neutral-600 hover:text-brand"
      >
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={2}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14"
          />
        </svg>
      </button>

      <button
        onClick={() => setGemt(!gemt)}
        aria-label="Gem auktion"
        className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 text-neutral-600 hover:text-brand"
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-4.5 w-4.5 ${gemt ? "fill-brand text-brand" : "fill-none"}`}
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 21s-7.5-4.5-9.5-9C1 8.5 2.5 5 6 5c2 0 3.5 1 4 2 0.5-1 2-2 4-2 3.5 0 5 3.5 3.5 7-2 4.5-9.5 9-9.5 9z"
          />
        </svg>
      </button>
    </div>
  );
}
