"use client";

import { useFavoritter } from "@/components/FavoritterProvider";
import DelAuktion from "@/components/del/DelAuktion";

const knap =
  "flex h-11 w-11 items-center justify-center rounded-full border border-kant-staerk bg-white text-tekst-daempet transition-colors hover:border-groen hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

// Del og gem på auktionssiden. "Del" er DelAuktion (systemets delingsmenu på
// mobil, ellers Messenger/SMS/Facebook/e-mail/kopiér link). "Gem" bruger de
// samme favoritter som hjertet på auktionskortene (ikke logget ind: sendes
// til login).
export default function AuctionTitleActions({
  auktionId,
  titel,
  henvisningskode = null,
}: {
  auktionId: string;
  titel: string;
  henvisningskode?: string | null;
}) {
  const favoritter = useFavoritter();
  const gemt = favoritter?.erFavorit(auktionId) ?? false;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <DelAuktion auktionId={auktionId} titel={titel} henvisningskode={henvisningskode} />

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
    </div>
  );
}
