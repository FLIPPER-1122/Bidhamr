"use client";

import { useSearchParams } from "next/navigation";
import type { DummyAuction } from "@/components/AuctionCard";
import CategoryGrid from "@/components/CategoryGrid";
import AuctionBrowser from "@/components/AuctionBrowser";
import { læsAfstand, læsPostnummer, læsSortering, type Sortering } from "@/lib/auktionFiltre";
import type { TotalType } from "@/lib/soegeTotal";

export default function AuctionsExplorer({
  initialAuktioner,
  initialTotal,
  initialTotalType,
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
  initialTotalType: TotalType;
  initialQuery: string;
  initialKategori?: string;
  initialSortering?: Sortering;
  initialPostnummer?: string;
  initialRadiusKm?: number;
  initialAfstandAktiv?: boolean;
  erLoggetInd?: boolean;
}) {
  // Filtrene ligger i URL'en (?kategori=&sortering=&postnummer=&afstand=),
  // så de kan deles, Tilbage-knappen husker dem, og menulinks som "Slutter
  // snart" virker, også når man allerede står på /auktioner. replaceState
  // opdaterer useSearchParams uden at hente siden igen fra serveren.
  const searchParams = useSearchParams();
  const kategori = searchParams.get("kategori")?.trim() ?? initialKategori;
  const sortering = læsSortering(searchParams.get("sortering") ?? undefined);
  const urlPostnummer = læsPostnummer(searchParams.get("postnummer"));
  const urlRadiusKm = læsAfstand(urlPostnummer, searchParams.get("afstand"));

  function opdaterUrl(ændringer: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [navn, værdi] of Object.entries(ændringer)) {
      if (værdi) params.set(navn, værdi);
      else params.delete(navn);
    }
    const qs = params.toString();
    if (qs === searchParams.toString()) return;
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }

  function setKategori(ny: string) {
    opdaterUrl({ kategori: ny || null });
  }

  function setSortering(ny: Sortering) {
    // Standarden står ikke i URL'en, så /auktioner forbliver den kanoniske adresse.
    opdaterUrl({ sortering: ny === læsSortering(undefined) ? null : ny });
  }

  // Postnummer og afstand skrives kun, når postnummeret er fire cifre.
  function setAfstand(postnummer: string, radiusKm: number) {
    const gyldigt = læsPostnummer(postnummer);
    opdaterUrl({ postnummer: gyldigt || null, afstand: gyldigt ? String(radiusKm) : null });
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
          initialTotalType={initialTotalType}
          initialKategori={initialKategori}
          initialQuery={initialQuery}
          initialSortering={initialSortering}
          initialPostnummer={initialPostnummer}
          initialRadiusKm={initialRadiusKm}
          initialAfstandAktiv={initialAfstandAktiv}
          erLoggetInd={erLoggetInd}
          kategori={kategori}
          onKategoriChange={setKategori}
          sortering={sortering}
          onSorteringChange={setSortering}
          urlPostnummer={urlPostnummer}
          urlRadiusKm={urlRadiusKm}
          onAfstandChange={setAfstand}
        />
      </section>
    </div>
  );
}
