"use client";

import Image from "next/image";
import { useState } from "react";
import { kanOptimeres } from "@/lib/billedUrl";

const pil =
  "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-tekst shadow-kort transition-colors hover:bg-white hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

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
      <div className="relative aspect-square w-full overflow-hidden rounded-[14px] bg-skelet sm:aspect-[4/3]">
        {aktivBillede && (
          <Image
            src={aktivBillede}
            alt={antal > 1 ? `${titel} – billede ${aktivIndex + 1} af ${antal}` : titel}
            fill
            // Første billede er sidens hovedindhold og hentes med det samme.
            loading="eager"
            fetchPriority="high"
            sizes="(min-width: 1280px) 740px, (min-width: 1024px) 58vw, 100vw"
            unoptimized={!kanOptimeres(aktivBillede)}
            className="object-cover"
          />
        )}

        {antal > 1 && (
          <>
            <button type="button" onClick={forrige} aria-label="Forrige billede" className={`${pil} left-2`}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <button type="button" onClick={næste} aria-label="Næste billede" className={`${pil} right-2`}>
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 18l6-6-6-6" />
              </svg>
            </button>

            <span className="absolute right-3 bottom-3 rounded-full bg-white px-[9px] py-[5px] text-xs font-semibold text-tekst">
              {aktivIndex + 1} af {antal}
            </span>
          </>
        )}
      </div>

      {antal > 1 && (
        <ul className="mt-2 grid grid-cols-5 gap-2" aria-label="Vælg billede">
          {billeder.map((url, index) => (
            <li key={url}>
              <button
                type="button"
                onClick={() => setAktivIndex(index)}
                aria-label={`Vis billede ${index + 1}`}
                aria-current={index === aktivIndex ? "true" : undefined}
                className={`relative block aspect-square w-full overflow-hidden rounded-lg border-2 bg-skelet focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                  index === aktivIndex ? "border-groen" : "border-transparent hover:border-kant-staerk"
                }`}
              >
                <Image
                  src={url}
                  alt=""
                  fill
                  sizes="(min-width: 1024px) 140px, 20vw"
                  unoptimized={!kanOptimeres(url)}
                  className="object-cover"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
