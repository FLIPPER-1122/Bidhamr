import "server-only";
import type { DummyAuction } from "@/components/AuctionCard";
import { createClient } from "@/lib/supabase/server";
import { kategorier } from "@/lib/kategorier";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import { beregnAfstandKm } from "@/lib/distance";
import { slaaPostnummerOp } from "@/lib/postnumre";
import { logDriftFejl } from "@/lib/drift";
import { læsSortering, type Sortering } from "@/lib/sortering";
import { escapeLike, escapeRegex } from "@/lib/postgrest";
import type { TotalType } from "@/lib/soegeTotal";

// Søgning på /auktioner med sidetal. Bruges både af siden (første side,
// server-renderet) og af server-handlingen "Vis flere"/nye filtre, så
// filtrene kun er skrevet ét sted. Hentes med brugerens egen klient (RLS).

export const AUKTIONER_PR_SIDE = 24; // går op i 2, 3 og 4 spalter
export const RADIUS_MAX_KM = 150; // "Hele Danmark"
const MAKS_SOEGETEKST = 100;
const MAKS_OFFSET = 5000;
// Øvre grænse for kandidater ved afstandsfilter (kun id og koordinat
// hentes, så det er få kB). Rammes loftet, logges det til drift.
const MAKS_KANDIDATER = 1000;
// Antal: "estimated" tæller præcist op til PostgREST's max-rows (1000 hos
// Supabase) og bruger planlæggerens skøn derover, så en bred søgning ikke
// skal tælle alle rækker. Over grænsen vises tallet som "ca." og afrundet.
const PRAECIST_ANTAL_OP_TIL = 1000;

// Kun de kolonner, kortet bruger. Typet som string: Supabase-typernes
// select-parser kan ikke læse "ø" i nuværende_bud.
const KORT_KOLONNER: string =
  "id, titel, postnummer, lokation, nuværende_bud, startpris, oprettet, slutter_kl, billeder, antal_bud";
const AFSTAND_KOLONNER: string = "id, lat, lng";

type KortRaekke = Parameters<typeof mapAuctionTilKort>[0];
type AfstandRaekke = { id: string; lat: number | null; lng: number | null };

export interface AuktionsFiltre {
  q?: string;
  kategori?: string;
  sortering?: string;
  postnummer?: string;
  radiusKm?: number;
  offset?: number;
}

export type { TotalType };

export type AuktionsSide =
  | { ok: true; auktioner: DummyAuction[]; total: number; totalType: TotalType }
  | { ok: false; fejl: string };

const FEJL = "Auktionerne kunne ikke hentes. Prøv igen.";

export async function hentAuktionsside(filtre: AuktionsFiltre): Promise<AuktionsSide> {
  const søgetekst = typeof filtre.q === "string" ? filtre.q.trim().slice(0, MAKS_SOEGETEKST) : "";
  const kategori = typeof filtre.kategori === "string" ? filtre.kategori.trim() : "";
  // Ukendt kategori giver ingen resultater (som et eq-filter på en ukendt værdi).
  if (kategori && !kategorier.includes(kategori)) {
    return { ok: true, auktioner: [], total: 0, totalType: "praecis" };
  }
  const sortering: Sortering = læsSortering(filtre.sortering);
  const offset = Number.isInteger(filtre.offset) ? Math.min(Math.max(filtre.offset!, 0), MAKS_OFFSET) : 0;

  // Afstand: kun med et kendt postnummer og en radius under "Hele Danmark".
  // Radius rundes til nærmeste 5 km (som skyderen).
  const center = slaaPostnummerOp(filtre.postnummer);
  const radius = Math.round(Number(filtre.radiusKm) / 5) * 5;
  const radiusKm =
    center && Number.isFinite(radius) && radius >= 5 && radius < RADIUS_MAX_KM ? radius : null;

  const supabase = await createClient();

  const grund = (kolonner: string, medAntal: boolean) => {
    let q = supabase
      .from("auctions")
      .select(kolonner, medAntal ? { count: "estimated" } : undefined)
      .eq("status", "aktiv")
      .eq("skjult", false)
      .gt("slutter_kl", new Date().toISOString());
    if (søgetekst) {
      // PostgREST gør altid "*" i et like-mønster til "%", og det kan ikke
      // escapes. Indeholder søgningen "*", bruges derfor et escapet regex
      // (imatch = ~*), som trigram-indekset også kan bruge.
      q = søgetekst.includes("*")
        ? q.filter("titel", "imatch", escapeRegex(søgetekst))
        : q.ilike("titel", `%${escapeLike(søgetekst)}%`);
    }
    if (kategori) q = q.eq("kategori", kategori);
    switch (sortering) {
      case "slutter_snart":
        q = q.order("slutter_kl", { ascending: true });
        break;
      // Efter den viste pris (nuværende bud, ellers startpris). visningspris
      // er en genereret kolonne (migration 20261008040000).
      case "laveste_bud":
        q = q.order("visningspris", { ascending: true, nullsFirst: false });
        break;
      case "højeste_bud":
        q = q.order("visningspris", { ascending: false, nullsFirst: false });
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
    // Mindst så mange, som er hentet (et skøn kan være for lavt).
    const total = Math.max(count ?? 0, offset + rækker.length);
    const erSkoen = total > PRAECIST_ANTAL_OP_TIL;
    return {
      ok: true,
      auktioner: rækker.map(mapAuctionTilKort),
      // Et skøn afrundes til hele hundreder.
      total: erSkoen ? Math.round(total / 100) * 100 : total,
      totalType: erSkoen ? "ca" : "praecis",
    };
  }

  // Afstandsfilter: hent kandidater inden for en firkant om centret,
  // filtrér præcist her, og hent derefter kun kortene til den viste side.
  // Alle auktioner har en koordinat: databasen sætter den ud fra
  // postnummeret, hvis web/app ikke selv sender en (migration
  // 20261008050000). Auktioner uden koordinat kommer derfor ikke med.
  const dLat = (radiusKm / 111) * 1.01;
  const dLng = (radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180))) * 1.01;
  const { data: kandidater, error: kandidatFejl } = await grund(AFSTAND_KOLONNER, false)
    .gte("lat", Number((center.lat - dLat).toFixed(5)))
    .lte("lat", Number((center.lat + dLat).toFixed(5)))
    .gte("lng", Number((center.lng - dLng).toFixed(5)))
    .lte("lng", Number((center.lng + dLng).toFixed(5)))
    .limit(MAKS_KANDIDATER);
  if (kandidatFejl) {
    console.error("Auktioner (afstand) kunne ikke hentes:", kandidatFejl.message);
    return { ok: false, fejl: FEJL };
  }

  const alleKandidater = (kandidater ?? []) as unknown as AfstandRaekke[];
  // Loftet ramt: der kan være flere auktioner inden for radius, end der er
  // set. Vis ikke et forkert total, og log det, så loftet kan hæves (eller
  // filteret flyttes til databasen), før det bliver et problem. drift_fejl
  // samler gentagelser af samme besked.
  const loftRamt = alleKandidater.length >= MAKS_KANDIDATER;
  if (loftRamt) {
    await logDriftFejl({
      kilde: "server",
      hvor: "hentAuktionsside",
      sti: "/auktioner",
      fejl: `Afstandsfilteret ramte loftet på ${MAKS_KANDIDATER} kandidater (${radiusKm} km). Totalen vises som "mange".`,
    });
  }
  const totalType: TotalType = loftRamt ? "mange" : "praecis";

  const indenfor = alleKandidater.filter(
    (r) =>
      r.lat != null &&
      r.lng != null &&
      beregnAfstandKm(center.lat, center.lng, r.lat, r.lng) <= radiusKm,
  );
  const sideIder = indenfor.slice(offset, offset + AUKTIONER_PR_SIDE).map((r) => r.id);
  if (sideIder.length === 0) return { ok: true, auktioner: [], total: indenfor.length, totalType };

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
  return { ok: true, auktioner, total: indenfor.length, totalType };
}
