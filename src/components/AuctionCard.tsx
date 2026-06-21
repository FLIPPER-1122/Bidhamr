"use client";

import { useState } from "react";

export interface DummyAuction {
  id: string;
  titel: string;
  lokation: string;
  nuværendeBud: number;
  antalBud: number;
  tidTilbage: string;
  farve: string;
}

export default function AuctionCard({ auktion }: { auktion: DummyAuction }) {
  const [gemt, setGemt] = useState(false);

  return (
    <div className="group overflow-hidden rounded-lg border border-neutral-200">
      <div
        className="relative aspect-square w-full"
        style={{ backgroundColor: auktion.farve }}
      >
        <button
          onClick={() => setGemt(!gemt)}
          aria-label="Gem auktion"
          className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white/90"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-4.5 w-4.5 ${gemt ? "fill-brand text-brand" : "fill-none text-neutral-700"}`}
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

        <span className="absolute bottom-2 left-2 rounded-md bg-black/70 px-2 py-1 text-xs font-medium text-white">
          {auktion.tidTilbage}
        </span>
      </div>

      <div className="p-3">
        <h3 className="truncate text-sm font-medium text-neutral-900">
          {auktion.titel}
        </h3>

        <p className="mt-1 flex items-center gap-1 text-xs text-neutral-500">
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="currentColor"
          >
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
          </svg>
          {auktion.lokation}
        </p>

        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-base font-bold text-neutral-900">
            {auktion.nuværendeBud.toLocaleString("da-DK")} kr
          </span>
          <span className="text-xs text-neutral-500">
            {auktion.antalBud} bud
          </span>
        </div>
      </div>
    </div>
  );
}
