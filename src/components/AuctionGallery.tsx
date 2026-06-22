"use client";

import { useState } from "react";

export default function AuctionGallery({
  billeder,
  titel,
}: {
  billeder: string[];
  titel: string;
}) {
  const [aktivIndex, setAktivIndex] = useState(0);

  const antal = billeder.length;
  const aktivBillede = antal > 0 ? billeder[aktivIndex] : null;

  function forrige() {
    setAktivIndex((i) => (i - 1 + antal) % antal);
  }

  function næste() {
    setAktivIndex((i) => (i + 1) % antal);
  }

  return (
    <div>
      <div className="relative aspect-square w-full bg-neutral-100 sm:aspect-[4/3]">
        {aktivBillede && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={aktivBillede}
            alt={titel}
            className="h-full w-full object-cover"
          />
        )}

        {antal > 1 && (
          <>
            <button
              onClick={forrige}
              aria-label="Forrige billede"
              className="absolute top-1/2 left-2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-neutral-700"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <button
              onClick={næste}
              aria-label="Næste billede"
              className="absolute top-1/2 right-2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-neutral-700"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" />
              </svg>
            </button>

            <span className="absolute right-2 bottom-2 bg-black/70 px-2 py-1 text-xs font-medium text-white">
              {aktivIndex + 1} af {antal}
            </span>
          </>
        )}
      </div>

      {antal > 1 && (
        <div className="mt-2 grid grid-cols-5 gap-2">
          {billeder.map((url, index) => (
            <button
              key={url}
              onClick={() => setAktivIndex(index)}
              className={`aspect-square overflow-hidden border-2 ${
                index === aktivIndex ? "border-brand" : "border-transparent"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`${titel} – billede ${index + 1}`}
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
