"use client";

import { useSearchParams } from "next/navigation";
import type { DummyAuction } from "@/components/AuctionCard";
import CategoryGrid from "@/components/CategoryGrid";
import AuctionBrowser from "@/components/AuctionBrowser";
import type { Sortering } from "@/lib/sortering";

export default function AuctionsExplorer({
  initialAuktioner,
  initialTotal,
  initialQuery,
  initialKategori = "",
  initialSortering,
  initialPostnummer,
  initialRadiusKm,
  initialAfstandAktiv,
  erLoggetInd,
}: {
  initialAuktioner: DummyAuction[];
  initialTotal: number;
  initialQuery: string;
  initialKategori?: string;
  initialSortering?: Sortering;
  initialPostnummer?: string;
  initialRadiusKm?: number;
  initialAfstandAktiv?: boolean;
  erLoggetInd?: boolean;
}) {
  // Kategorien ligger i URL'en (?kategori=…), så filteret kan deles, og
  // Tilbage-knappen husker det. replaceState opdaterer useSearchParams uden
  // at hente siden igen fra serveren.
  const searchParams = useSearchParams();
  const kategori = searchParams.get("kategori")?.trim() ?? initialKategori;

  function setKategori(ny: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (ny) params.set("kategori", ny);
    else params.delete("kategori");
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }

  return (
    <div>
      {!initialQuery && (
        <section aria-labelledby="kategorier-titel" className="mt-6">
          <h2 id="kategorier-titel" className="sr-only">
            Kategorier
          </h2>
          <CategoryGrid valgt={kategori} onVælg={setKategori} />
        </section>
      )}

      <section id="alle-auktioner" aria-label="Auktioner" className="mt-6">
        <AuctionBrowser
          initialAuktioner={initialAuktioner}
          initialTotal={initialTotal}
          initialKategori={initialKategori}
          initialQuery={initialQuery}
          initialSortering={initialSortering}
          initialPostnummer={initialPostnummer}
          initialRadiusKm={initialRadiusKm}
          initialAfstandAktiv={initialAfstandAktiv}
          erLoggetInd={erLoggetInd}
          kategori={kategori}
          onKategoriChange={setKategori}
        />
      </section>
    </div>
  );
}
