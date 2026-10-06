"use client";

import { useEffect } from "react";
import type { SamtykkeKategori } from "@/lib/samtykke";
import { markerIndlaest, useSamtykke } from "@/lib/samtykkeKlient";

// Viser kun children (fx et <Script> fra next/script, en pixel eller en
// iframe fra tredjepart), når der er samtykke til kategorien. Uden samtykke
// renderes intet - heller ikke på serveren - så intet indlæses for tidligt.
//
//   <KraeverSamtykke kategori="statistik">
//     <Script src="https://..." nonce={nonce} />
//   </KraeverSamtykke>
//
// Trækkes samtykket tilbage, genindlæses siden (se gemSamtykke), så et script,
// der allerede kører, også forsvinder.
export default function KraeverSamtykke({
  kategori,
  children,
  ellers = null,
}: {
  kategori: SamtykkeKategori;
  children: React.ReactNode;
  // Vises i stedet, fx "Accepter markedsføring for at se videoen".
  ellers?: React.ReactNode;
}) {
  const ok = useSamtykke(kategori);
  useEffect(() => {
    if (ok) markerIndlaest(kategori);
  }, [ok, kategori]);
  return ok ? children : ellers;
}
