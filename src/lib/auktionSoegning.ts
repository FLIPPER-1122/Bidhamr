import "server-only";
import type { DummyAuction } from "@/components/AuctionCard";
import { createClient } from "@/lib/supabase/server";
import { kategorier } from "@/lib/kategorier";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import { beregnAfstandKm } from "@/lib/distance";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { læsSortering, type Sortering } from "@/lib/sortering";

// Søgning på /auktioner med sidetal. Bruges både af siden (første side,
// server-renderet) og af server-handlingen "Vis flere"/nye filtre, så
// filtrene kun er skrevet ét sted. Hentes med brugerens egen klient (RLS).

export const AUKTIONER_PR_SIDE = 24; // går op i 2, 3 og 4 spalter
export const RADIUS_MAX_KM = 150; // "Hele Danmark"
const MAKS_SOEGETEKST = 100;
const MAKS_OFFSET = 5000;
// Øvre grænse for kandidater ved afstandsfilter (kun id, koordinat og
// sorteringskolonne hentes, så det er få kB).
const MAKS_KANDIDATER = 1000;

// Kun de kolonner, kortet bruger. Typet som string: Supabase-typernes
// select-parser kan ikke læse "ø" i nuværende_bud.
const KORT_KOLONNER: string =
  "id, titel, postnummer, lokation, nuværende_bud, startpris, oprettet, slutter_kl, billeder, antal_bud";
const AFSTAND_KOLONNER: string = "id, lat, lng, postnummer";

type KortRaekke = Parameters<typeof mapAuctionTilKort>[0];
type AfstandRaekke = { id: string; lat: number | null; lng: number | null; postnummer: string | null };

export interface AuktionsFiltre {
  q?: string;
  kategori?: string;
  sortering?: string;
  postnummer?: string;
  radiusKm?: number;
  offset?: number;
}

export type AuktionsSide =
  | { ok: true; auktioner: DummyAuction[]; total: number }
  | { ok: false; fejl: string };

const FEJL = "Auktionerne kunne ikke hentes. Prøv igen.";

export async function hentAuktionsside(filtre: AuktionsFiltre): Promise<AuktionsSide> {
  const søgetekst = typeof filtre.q === "string" ? filtre.q.trim().slice(0, MAKS_SOEGETEKST) : "";
  const kategori = typeof filtre.kategori === "string" ? filtre.kategori.trim() : "";
  // Ukendt kategori giver ingen resultater (som et eq-filter på en ukendt værdi).
  if (kategori && !kategorier.includes(kategori)) return { ok: true, auktioner: [], total: 0 };
  const sortering: Sortering = læsSortering(filtre.sortering);
  const offset = Number.isInteger(filtre.offset) ? Math.min(Math.max(filtre.offset!, 0), MAKS_OFFSET) : 0;

  // Afstand: kun med et kendt postnummer og en radius under "Hele Danmark".
  const center = slaaPostnummerOp(filtre.postnummer);
  const radius = Number(filtre.radiusKm);
  const radiusKm =
    center && Number.isFinite(radius) && radius >= 5 && radius < RADIUS_MAX_KM ? radius : null;

  const supabase = await createClient();

  const grund = (kolonner: string, medAntal: boolean) => {
    let q = supabase
      .from("auctions")
      .select(kolonner, medAntal ? { count: "exact" } : undefined)
      .eq("status", "aktiv")
      .eq("skjult", false)
      .gt("slutter_kl", new Date().toISOString());
    if (søgetekst) q = q.ilike("titel", `%${søgetekst}%`);
    if (kategori) q = q.eq("kategori", kategori);
    switch (sortering) {
      case "slutter_snart":
        q = q.order("slutter_kl", { ascending: true });
        break;
      case "laveste_bud":
        q = q.order("nuværende_bud", { ascending: true, nullsFirst: false });
        break;
      case "højeste_bud":
        q = q.order("nuværende_bud", { ascending: false, nullsFirst: false });
        break;
      case "nyeste":
        q = q.order("oprettet", { ascending: false });
        break;
    }
    // Fast rækkefølge ved lige værdier, så "Vis flere" ikke giver dubletter.
    return q.order("id", { ascending: true });
  };

  if (!center || radiusKm == null) {
    const { data, count, error } = await grund(KORT_KOLONNER, true).range(
      offset,
      offset + AUKTIONER_PR_SIDE - 1,
    );
    if (error) {
      console.error("Auktioner kunne ikke hentes:", error.message);
      return { ok: false, fejl: FEJL };
    }
    const rækker = (data ?? []) as unknown as KortRaekke[];
    return { ok: true, auktioner: rækker.map(mapAuctionTilKort), total: count ?? rækker.length };
  }

  // Afstandsfilter: hent kandidater inden for en firkant om centret (plus
  // auktioner uden koordinat, som slås op via postnummeret), filtrér præcist
  // her, og hent derefter kun kortene til den viste side.
  const dLat = (radiusKm / 111) * 1.01;
  const dLng = (radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * 1.01;
  const boks = [
    `lat.gte.${(center.lat - dLat).toFixed(5)}`,
    `lat.lte.${(center.lat + dLat).toFixed(5)}`,
    `lng.gte.${(center.lng - dLng).toFixed(5)}`,
    `lng.lte.${(center.lng + dLng).toFixed(5)}`,
  ].join(",");
  const { data: kandidater, error: kandidatFejl } = await grund(AFSTAND_KOLONNER, false)
    .or(`and(${boks}),lat.is.null,lng.is.null`)
    .limit(MAKS_KANDIDATER);
  if (kandidatFejl) {
    console.error("Auktioner (afstand) kunne ikke hentes:", kandidatFejl.message);
    return { ok: false, fejl: FEJL };
  }

  const indenfor = ((kandidater ?? []) as unknown as AfstandRaekke[]).filter((r) => {
    const punkt =
      r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : slaaPostnummerOp(r.postnummer);
    return !!punkt && beregnAfstandKm(center.lat, center.lng, punkt.lat, punkt.lng) <= radiusKm;
  });
  const sideIder = indenfor.slice(offset, offset + AUKTIONER_PR_SIDE).map((r) => r.id);
  if (sideIder.length === 0) return { ok: true, auktioner: [], total: indenfor.length };

  const { data: kort, error: kortFejl } = await supabase
    .from("auctions")
    .select(KORT_KOLONNER)
    .in("id", sideIder);
  if (kortFejl) {
    console.error("Auktionskort kunne ikke hentes:", kortFejl.message);
    return { ok: false, fejl: FEJL };
  }
  const efterId = new Map(((kort ?? []) as unknown as KortRaekke[]).map((r) => [r.id, r]));
  const auktioner = sideIder
    .map((id) => efterId.get(id))
    .filter((r): r is KortRaekke => !!r)
    .map(mapAuctionTilKort);
  return { ok: true, auktioner, total: indenfor.length };
}
