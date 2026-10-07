"use client";

import Image from "next/image";
import Link from "next/link";
import Ikon from "@/components/Ikon";
import { kanOptimeres } from "@/lib/billedUrl";
import { useFavoritter } from "@/components/FavoritterProvider";
import ErhvervssaelgerMaerke from "@/components/erhverv/ErhvervssaelgerMaerke";

export interface DummyAuction {
  id: string;
  titel: string;
  lokation: string;
  nuværendeBud: number;
  antalBud: number;
  tidTilbage: string;
  procentForløbet: number;
  // Under en time tilbage: timeren bliver orange (DESIGN.md 1.5).
  slutterSnart?: boolean;
  farve?: string;
  billede?: string | null;
  // Sælgeren er et firma (auctions.erhverv).
  erhverv?: boolean;
}

// Passer til gitteret 2 / 3 / 4 spalter, som alle kortlister bruger
// (grid-cols-2 lg:grid-cols-3 xl:grid-cols-4).
const STANDARD_SIZES = "(min-width: 1280px) 300px, (min-width: 1024px) 31vw, 46vw";


// Auktionskort efter DESIGN.md 7.1.
export default function AuctionCard({
  auktion,
  sizes = STANDARD_SIZES,
}: {
  auktion: DummyAuction;
  sizes?: string;
}) {
  const favoritter = useFavoritter();
  const gemt = favoritter?.erFavorit(auktion.id) ?? false;
  const meta = auktion.antalBud === 0 ? "Ingen bud endnu" : `${auktion.antalBud} bud`;

  return (
    <div className="group relative h-full">
      <Link
        href={`/auktion/${auktion.id}`}
        className="flex h-full flex-col overflow-hidden rounded-[14px] border border-kant bg-white shadow-kort transition-[box-shadow,border-color] duration-200 ease-out hover:border-kant-staerk hover:shadow-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <div
          className="relative aspect-[4/3] w-full bg-skelet"
          style={auktion.billede || !auktion.farve ? undefined : { backgroundColor: auktion.farve }}
        >
          {auktion.billede && (
            <Image
              src={auktion.billede}
              alt=""
              fill
              sizes={sizes}
              unoptimized={!kanOptimeres(auktion.billede)}
              className="object-cover"
            />
          )}

          <span
            className={`absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-full px-[9px] py-[5px] text-xs font-semibold ${
              auktion.slutterSnart ? "bg-orange-knap text-white" : "bg-white text-tekst"
            }`}
          >
            <Ikon navn="ur" className="h-3.5 w-3.5" strøg={2} />
            {auktion.slutterSnart && <span className="sr-only">Slutter snart: </span>}
            {auktion.tidTilbage}
          </span>
        </div>

        <div className="flex flex-1 flex-col px-[14px] pt-3 pb-4">
          <h3 className="line-clamp-2 font-sans text-sm font-normal text-tekst">{auktion.titel}</h3>
          <p className="mt-1.5 text-lg leading-tight font-bold text-tekst">
            {auktion.nuværendeBud.toLocaleString("da-DK")} kr
          </p>
          <p className="mt-0.5 truncate text-xs text-tekst-svag">
            {meta}
            {auktion.lokation && auktion.lokation !== "Ukendt" && <> · {auktion.lokation}</>}
          </p>
          {auktion.erhverv && (
            <p className="mt-2">
              <ErhvervssaelgerMaerke lille />
            </p>
          )}
        </div>
      </Link>

      {/* Uden for linket: en knap må ikke ligge inde i et <a>. */}
      <button
        type="button"
        onClick={() => favoritter?.toggle(auktion.id)}
        aria-label={gemt ? `Fjern ${auktion.titel} fra favoritter` : `Gem ${auktion.titel} som favorit`}
        aria-pressed={gemt}
        title={gemt ? "Fjern fra favoritter" : "Gem som favorit"}
        className="absolute top-1 right-1 flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-groen"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/95 shadow-kort">
          <svg
            viewBox="0 0 24 24"
            className={`h-[18px] w-[18px] transition-colors ${gemt ? "fill-groen text-groen" : "fill-none text-tekst"}`}
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572" />
          </svg>
        </span>
      </button>
    </div>
  );
}

// Skeleton med samme geometri som kortet (ingen layoutspring).
export function AuctionCardSkelet() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-[14px] border border-kant bg-white">
      <div className="aspect-[4/3] w-full animate-pulse bg-skelet" />
      <div className="px-[14px] pt-3 pb-4">
        <div className="h-4 w-4/5 animate-pulse rounded bg-skelet" />
        <div className="mt-2.5 h-5 w-1/3 animate-pulse rounded bg-skelet" />
        <div className="mt-2 h-3 w-1/4 animate-pulse rounded bg-skelet" />
      </div>
    </div>
  );
}
