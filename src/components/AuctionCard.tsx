"use client";

import Link from "next/link";
import { useState } from "react";

export interface DummyAuction {
  id: string;
  titel: string;
  lokation: string;
  nuværendeBud: number;
  antalBud: number;
  tidTilbage: string;
  procentForløbet: number;
  farve?: string;
  billede?: string | null;
}

export default function AuctionCard({ auktion }: { auktion: DummyAuction }) {
  const [gemt, setGemt] = useState(false);

  return (
    <Link
      href={`/auktion/${auktion.id}`}
      className="group block overflow-hidden border border-neutral-200"
    >
      <div
        className="relative aspect-[4/3] w-full bg-neutral-100"
        style={auktion.billede ? undefined : { backgroundColor: auktion.farve }}
      >
        {auktion.billede && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={auktion.billede}
            alt={auktion.titel}
            className="h-full w-full object-cover"
          />
        )}

        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setGemt(!gemt);
          }}
          aria-label="Gem auktion"
          className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-white/90"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-4 w-4 ${gemt ? "fill-brand text-brand" : "fill-none text-neutral-700"}`}
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

        <span className="absolute bottom-1.5 left-1.5 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-brand">
          {auktion.tidTilbage}
        </span>
      </div>

      <div className="h-1 w-full bg-neutral-200">
        <div
          className="h-full bg-brand"
          style={{ width: `${auktion.procentForløbet}%` }}
        />
      </div>

      <div className="p-2">
        <h3 className="truncate text-[13px] font-medium text-neutral-900">
          {auktion.titel}
        </h3>

        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-neutral-500">
          <svg
            viewBox="0 0 24 24"
            className="h-3 w-3"
            fill="currentColor"
          >
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
          </svg>
          {auktion.lokation}
        </p>

        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-sm font-bold text-neutral-900">
            {auktion.nuværendeBud.toLocaleString("da-DK")} kr
          </span>
          <span className="bg-brand px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {auktion.antalBud}
          </span>
        </div>
      </div>
    </Link>
  );
}
