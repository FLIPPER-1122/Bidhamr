"use client";

import { useState } from "react";
import type { DummyAuction } from "@/components/AuctionCard";
import CategoryGrid from "@/components/CategoryGrid";
import AuctionBrowser from "@/components/AuctionBrowser";
import type { Sortering } from "@/lib/sortering";

export default function AuctionsExplorer({
  initialAuktioner,
  initialQuery,
  initialKategori = "",
  initialSortering,
}: {
  initialAuktioner: DummyAuction[];
  initialQuery: string;
  initialKategori?: string;
  initialSortering?: Sortering;
}) {
  const [kategori, setKategori] = useState(initialKategori);

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
          initialQuery={initialQuery}
          initialSortering={initialSortering}
          kategori={kategori}
          onKategoriChange={setKategori}
        />
      </section>
    </div>
  );
}
