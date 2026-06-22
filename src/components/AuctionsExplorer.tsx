"use client";

import { useState } from "react";
import type { DummyAuction } from "@/components/AuctionCard";
import CategoryGrid from "@/components/CategoryGrid";
import AuctionBrowser from "@/components/AuctionBrowser";

export default function AuctionsExplorer({
  initialAuktioner,
  initialQuery,
  initialKategori = "",
}: {
  initialAuktioner: DummyAuction[];
  initialQuery: string;
  initialKategori?: string;
}) {
  const [kategori, setKategori] = useState(initialKategori);

  return (
    <div>
      {!initialQuery && (
        <section>
          <h2 className="text-lg font-semibold text-neutral-900">
            Kategorier
          </h2>
          <div className="mt-3">
            <CategoryGrid valgt={kategori} onVælg={setKategori} />
          </div>
        </section>
      )}

      <section id="alle-auktioner" className={initialQuery ? "" : "mt-10"}>
        <h2 className="text-lg font-semibold text-neutral-900">
          Alle auktioner
        </h2>
        <div className="mt-3">
          <AuctionBrowser
            initialAuktioner={initialAuktioner}
            initialQuery={initialQuery}
            kategori={kategori}
            onKategoriChange={setKategori}
          />
        </div>
      </section>
    </div>
  );
}
