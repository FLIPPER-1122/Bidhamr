"use client";

import { useId, useState } from "react";

// Stjernevælger 1-5 (oprindeligt fra RatingForm). Bygget som en radiogruppe,
// så den virker med tastatur (piletaster) og skærmlæser, og hver stjerne har
// en trykflade på mindst 44x44 px på mobil.

const BETEGNELSER = ["", "Meget dårlig", "Dårlig", "OK", "God", "Fremragende"];

export default function StjerneVaelger({
  legend,
  vaerdi,
  onChange,
  disabled = false,
}: {
  legend: string;
  vaerdi: number;
  onChange: (stjerner: number) => void;
  disabled?: boolean;
}) {
  const navn = useId();
  const [hover, setHover] = useState(0);
  const vist = hover || vaerdi;

  return (
    <fieldset disabled={disabled}>
      <legend className="text-sm font-medium text-neutral-900">{legend}</legend>
      <div
        className="mt-2 flex gap-1"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((i) => (
          <label
            key={i}
            className="cursor-pointer"
            onMouseEnter={() => setHover(i)}
          >
            <input
              type="radio"
              name={navn}
              value={i}
              checked={vaerdi === i}
              onChange={() => onChange(i)}
              className="peer sr-only"
              aria-label={`${i} ${i === 1 ? "stjerne" : "stjerner"} – ${BETEGNELSER[i]}`}
            />
            <span className="flex h-11 w-11 items-center justify-center rounded-lg transition-transform peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-groen hover:scale-110 sm:h-10 sm:w-10">
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className={`h-9 w-9 transition-colors sm:h-8 sm:w-8 ${
                  i <= vist
                    ? "fill-orange-mork text-orange-mork"
                    : "fill-neutral-200 text-neutral-200"
                }`}
              >
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-1 min-h-5 text-sm text-neutral-600" aria-live="polite">
        {vaerdi > 0 ? BETEGNELSER[vaerdi] : ""}
      </p>
    </fieldset>
  );
}
