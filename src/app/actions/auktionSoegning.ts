"use server";

// Næste side / nye filtre på /auktioner. Samme forespørgsel som siden selv
// (src/lib/auktionSoegning.ts); alle input valideres dér. Kun offentlige
// auktionsdata, læst med brugerens egen session (RLS).

import { hentAuktionsside, type AuktionsFiltre, type AuktionsSide } from "@/lib/auktionSoegning";

export async function soegAuktioner(filtre: AuktionsFiltre): Promise<AuktionsSide> {
  if (!filtre || typeof filtre !== "object") {
    return { ok: false, fejl: "Auktionerne kunne ikke hentes. Prøv igen." };
  }
  return hentAuktionsside({
    q: filtre.q,
    kategori: filtre.kategori,
    sortering: filtre.sortering,
    postnummer: filtre.postnummer,
    radiusKm: filtre.radiusKm,
    offset: filtre.offset,
  });
}
