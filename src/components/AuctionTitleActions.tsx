"use client";

import { useState } from "react";
import { useFavoritter } from "@/components/FavoritterProvider";

const knap =
  "flex h-11 w-11 items-center justify-center rounded-full border border-kant-staerk bg-white text-tekst-daempet transition-colors hover:border-groen hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

// Del og gem på auktionssiden. "Gem" bruger de samme favoritter som
// hjertet på auktionskortene (ikke logget ind: sendes til login).
export default function AuctionTitleActions({
  auktionId,
  titel,
}: {
  auktionId: string;
  titel: string;
}) {
  const favoritter = useFavoritter();
  const gemt = favoritter?.erFavorit(auktionId) ?? false;
  const [kopieret, setKopieret] = useState(false);

  async function del() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: titel, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setKopieret(true);
      setTimeout(() => setKopieret(false), 2500);
    } catch {
      // Brugeren lukkede delingsmenuen – intet at gøre.
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <button type="button" onClick={del} aria-label="Del auktion" title="Del auktion" className={knap}>
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14" />
        </svg>
      </button>

      <button
        type="button"
        onClick={() => favoritter?.toggle(auktionId)}
        aria-label={gemt ? "Fjern fra favoritter" : "Gem som favorit"}
        aria-pressed={gemt}
        title={gemt ? "Fjern fra favoritter" : "Gem som favorit"}
        className={knap}
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-5 w-5 ${gemt ? "fill-groen text-groen" : "fill-none"}`}
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572" />
        </svg>
      </button>

      <span role="status" className="sr-only">
        {kopieret ? "Linket er kopieret" : ""}
      </span>
      {kopieret && (
        <span aria-hidden="true" className="text-[13px] font-medium text-groen-mork">
          Kopieret
        </span>
      )}
    </div>
  );
}
