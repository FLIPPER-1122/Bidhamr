"use client";

import { useEffect, useRef, useState } from "react";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";
import Ikon from "@/components/Ikon";
import { createClient } from "@/lib/supabase/client";
import { kategorier } from "@/lib/kategorier";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import { beregnAfstandKm } from "@/lib/distance";
import { UKENDT_POSTNUMMER, slaaPostnummerOp } from "@/lib/postnumre";

import { SORTERINGER, type Sortering } from "@/lib/sortering";

// Felter i filterbjælken (DESIGN.md 8.2).
const felt =
  "h-11 w-full rounded-xl border border-kant-staerk bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";
const etiket = "mb-1.5 block text-sm font-medium text-tekst";

const RADIUS_MIN = 5;
const RADIUS_MAX = 150;
const RADIUS_STEP = 5;

interface AuctionRow {
  id: string;
  titel: string;
  postnummer: string | null;
  lokation: string | null;
  nuværende_bud: number | string | null;
  startpris: number | string;
  oprettet: string;
  slutter_kl: string;
  billeder: string[] | null;
  kategori: string | null;
  lat: number | null;
  lng: number | null;
  antal_bud?: number | null;
}

interface Koordinat {
  lat: number;
  lng: number;
}

function koordinatForPostnummer(postnummer: string): Koordinat | null {
  const opslag = slaaPostnummerOp(postnummer);
  return opslag ? { lat: opslag.lat, lng: opslag.lng } : null;
}

export default function AuctionBrowser({
  initialAuktioner,
  initialQuery,
  initialSortering = "slutter_snart",
  kategori,
  onKategoriChange,
}: {
  initialAuktioner: DummyAuction[];
  initialQuery: string;
  initialSortering?: Sortering;
  kategori: string;
  onKategoriChange: (kategori: string) => void;
}) {
  const query = initialQuery;
  const [sortering, setSortering] = useState<Sortering>(initialSortering);
  const [postnummer, setPostnummer] = useState("");
  // Postnummeret slås op i den lokale liste (synkront), så by og koordinat
  // udledes direkte ved render.
  const gyldigtPostnummer = /^\d{4}$/.test(postnummer);
  const postOpslag = gyldigtPostnummer ? slaaPostnummerOp(postnummer) : null;
  const postBy = postOpslag?.by ?? null;
  const postLat = postOpslag?.lat ?? null;
  const postLng = postOpslag?.lng ?? null;
  const postStatus: "idle" | "fundet" | "ikke-fundet" = !gyldigtPostnummer
    ? "idle"
    : postOpslag
      ? "fundet"
      : "ikke-fundet";
  const [radiusKm, setRadiusKm] = useState(50);
  const [auktioner, setAuktioner] = useState<DummyAuction[]>(initialAuktioner);
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  const harSøgt = useRef(false);

  async function søg(
    søgetekst: string,
    valgtKategori: string,
    valgtSortering: Sortering,
    center: Koordinat | null,
    radiusKmAktiv: number | null,
  ) {
    setLoading(true);
    setFejl(null);

    const supabase = createClient();
    let queryBuilder = supabase
      .from("auctions")
      .select("*")
      .eq("status", "aktiv")
      .eq("skjult", false)
      .gt("slutter_kl", new Date().toISOString());

    if (søgetekst.trim()) {
      queryBuilder = queryBuilder.ilike("titel", `%${søgetekst.trim()}%`);
    }
    if (valgtKategori) {
      queryBuilder = queryBuilder.eq("kategori", valgtKategori);
    }

    switch (valgtSortering) {
      case "slutter_snart":
        queryBuilder = queryBuilder.order("slutter_kl", { ascending: true });
        break;
      case "laveste_bud":
        queryBuilder = queryBuilder.order("nuværende_bud", {
          ascending: true,
          nullsFirst: false,
        });
        break;
      case "højeste_bud":
        queryBuilder = queryBuilder.order("nuværende_bud", {
          ascending: false,
          nullsFirst: false,
        });
        break;
      case "nyeste":
        queryBuilder = queryBuilder.order("oprettet", { ascending: false });
        break;
    }

    const { data, error } = await queryBuilder;

    if (error) {
      console.error("Søgning fejlede:", error.message);
      setFejl("Auktionerne kunne ikke hentes. Prøv igen.");
      setLoading(false);
      return;
    }

    let rows = (data ?? []) as AuctionRow[];

    if (center && radiusKmAktiv != null) {
      // Auktioner uden gemte koordinater slås op via deres postnummer, så de
      // ikke bare udelukkes fra radius-filtreringen.
      rows = rows.filter((row) => {
        const koordinat: Koordinat | null =
          row.lat != null && row.lng != null
            ? { lat: row.lat, lng: row.lng }
            : row.postnummer
              ? koordinatForPostnummer(row.postnummer)
              : null;

        if (!koordinat) return false;

        return (
          beregnAfstandKm(center.lat, center.lng, koordinat.lat, koordinat.lng) <=
          radiusKmAktiv
        );
      });
    }

    setAuktioner(rows.map(mapAuctionTilKort));
    setLoading(false);
  }

  // Søg/filtrer, når noget ændrer sig. Hele Danmark (radius i top) eller
  // tomt postnummer betyder ingen radius-filtrering.
  useEffect(() => {
    const erHeleDanmark = radiusKm >= RADIUS_MAX;
    const aktivtCenter =
      !erHeleDanmark && postLat != null && postLng != null
        ? { lat: postLat, lng: postLng }
        : null;

    const timeout = setTimeout(
      () => {
        harSøgt.current = true;
        søg(query, kategori, sortering, aktivtCenter, erHeleDanmark ? null : radiusKm);
      },
      harSøgt.current ? 300 : 0,
    );
    return () => clearTimeout(timeout);
  }, [query, kategori, sortering, postLat, postLng, radiusKm]);

  const erHeleDanmark = radiusKm >= RADIUS_MAX;

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 rounded-[14px] bg-groen-lys p-4 md:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.4fr)] lg:gap-x-5">
        <div className="min-w-0">
          <label htmlFor="filter-kategori" className={etiket}>Kategori</label>
          <select
            id="filter-kategori"
            value={kategori}
            onChange={(e) => onKategoriChange(e.target.value)}
            className={felt}
          >
            <option value="">Alle kategorier</option>
            {kategorier.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label htmlFor="filter-sortering" className={etiket}>Sortér efter</label>
          <select
            id="filter-sortering"
            value={sortering}
            onChange={(e) => setSortering(e.target.value as Sortering)}
            className={felt}
          >
            {SORTERINGER.map((s) => (
              <option key={s.værdi} value={s.værdi}>
                {s.tekst}
              </option>
            ))}
          </select>
        </div>

        <div className="col-span-2 min-w-0 md:col-span-1">
          <label htmlFor="filter-postnummer" className={etiket}>Postnummer</label>
          <input
            id="filter-postnummer"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={4}
            placeholder="Fx 8000"
            value={postnummer}
            onChange={(e) =>
              setPostnummer(e.target.value.replace(/\D/g, "").slice(0, 4))
            }
            aria-describedby="filter-postnummer-status"
            aria-invalid={postStatus === "ikke-fundet" || undefined}
            className={felt}
          />
          <p id="filter-postnummer-status" aria-live="polite" className="text-[13px]">
            {postStatus === "fundet" && postBy && (
              <span className="mt-1.5 block text-tekst-daempet">{postBy}</span>
            )}
            {postStatus === "ikke-fundet" && (
              <span className="mt-1.5 block font-medium text-fejl-tekst">
                {UKENDT_POSTNUMMER}
              </span>
            )}
          </p>
        </div>

        <div className="col-span-2 min-w-0 md:col-span-1">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <label htmlFor="filter-radius" className="text-sm font-medium text-tekst">Afstand</label>
            <span className="text-[13px] font-semibold text-groen-mork">
              {erHeleDanmark ? "Hele Danmark" : `${radiusKm} km`}
            </span>
          </div>
          <div className="flex h-11 min-w-0 items-center gap-3">
            <input
              id="filter-radius"
              type="range"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              step={RADIUS_STEP}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              aria-valuetext={erHeleDanmark ? "Hele Danmark" : `${radiusKm} km`}
              className="h-11 w-0 min-w-0 flex-1 accent-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            />
            <button
              type="button"
              onClick={() => setRadiusKm(RADIUS_MAX)}
              aria-pressed={erHeleDanmark}
              className={`inline-flex h-11 shrink-0 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                erHeleDanmark
                  ? "bg-groen text-white"
                  : "border border-kant-staerk bg-white text-tekst-daempet hover:border-groen hover:text-groen"
              }`}
            >
              Hele Danmark
            </button>
          </div>
        </div>
      </div>

      <p className="mt-4 text-sm text-tekst-svag" aria-live="polite">
        {loading
          ? "Søger…"
          : `${auktioner.length} auktion${auktioner.length === 1 ? "" : "er"} fundet`}
      </p>

      {fejl && (
        <p role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      {!loading && !fejl && auktioner.length === 0 ? (
        <div className="mt-4 flex flex-col items-center rounded-[14px] border border-kant px-6 py-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork">
            <Ikon navn="soeg" className="h-6 w-6" />
          </span>
          <h3 className="mt-4 text-[17px] lg:text-lg">Ingen auktioner fundet</h3>
          <p className="mt-1 max-w-[45ch] text-[15px] text-tekst-daempet">
            Prøv en anden kategori, et større område eller færre ord i søgningen.
          </p>
        </div>
      ) : (
        <ul
          aria-busy={loading}
          className={`mt-4 grid grid-cols-2 gap-3 transition-opacity sm:gap-5 lg:grid-cols-3 xl:grid-cols-4 ${
            loading ? "opacity-50" : ""
          }`}
        >
          {auktioner.map((auktion) => (
            <li key={auktion.id} className="min-w-0">
              <AuctionCard auktion={auktion} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
