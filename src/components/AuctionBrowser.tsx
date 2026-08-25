"use client";

import { useEffect, useRef, useState } from "react";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";
import { createClient } from "@/lib/supabase/client";
import { kategorier } from "@/lib/kategorier";
import { mapAuctionTilKort } from "@/lib/mapAuctionCard";
import { beregnAfstandKm } from "@/lib/distance";

type Sortering = "slutter_snart" | "laveste_bud" | "højeste_bud" | "nyeste";

const RADIUS_MIN = 1;
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
  bids?: { count: number }[] | null;
}

interface Koordinat {
  lat: number;
  lng: number;
}

async function slåPostnummerOp(postnummer: string): Promise<{
  by: string | null;
  koordinat: Koordinat | null;
}> {
  try {
    const res = await fetch(
      `https://api.dataforsyningen.dk/postnumre/${postnummer}`,
    );
    if (!res.ok) return { by: null, koordinat: null };

    const data = await res.json();
    const [lng, lat] = data.visueltcenter ?? [];

    return {
      by: data.navn ?? null,
      koordinat:
        typeof lat === "number" && typeof lng === "number"
          ? { lat, lng }
          : null,
    };
  } catch {
    return { by: null, koordinat: null };
  }
}

export default function AuctionBrowser({
  initialAuktioner,
  initialQuery,
  kategori,
  onKategoriChange,
}: {
  initialAuktioner: DummyAuction[];
  initialQuery: string;
  kategori: string;
  onKategoriChange: (kategori: string) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [sortering, setSortering] = useState<Sortering>("slutter_snart");
  const [postnummer, setPostnummer] = useState("");
  const [postBy, setPostBy] = useState<string | null>(null);
  const [postKoordinat, setPostKoordinat] = useState<Koordinat | null>(null);
  const [postStatus, setPostStatus] = useState<
    "idle" | "henter" | "fundet" | "ikke-fundet"
  >("idle");
  const [radiusKm, setRadiusKm] = useState(50);
  const [auktioner, setAuktioner] = useState<DummyAuction[]>(initialAuktioner);
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  const harSøgt = useRef(false);

  // Slå postnummeret op hos DAWA og vis bynavnet som bekræftelse, så snart
  // brugeren har skrevet 4 cifre.
  useEffect(() => {
    if (!/^\d{4}$/.test(postnummer)) {
      setPostBy(null);
      setPostKoordinat(null);
      setPostStatus("idle");
      return;
    }

    let aktiv = true;
    setPostStatus("henter");

    slåPostnummerOp(postnummer).then(({ by, koordinat }) => {
      if (!aktiv) return;
      setPostBy(by);
      setPostKoordinat(koordinat);
      setPostStatus(koordinat ? "fundet" : "ikke-fundet");
    });

    return () => {
      aktiv = false;
    };
  }, [postnummer]);

  // Søg/filtrer, når noget ændrer sig. Hele Danmark (radius i top) eller
  // tomt postnummer betyder ingen radius-filtrering.
  useEffect(() => {
    const erHeleDanmark = radiusKm >= RADIUS_MAX;
    const aktivtCenter = !erHeleDanmark && postKoordinat ? postKoordinat : null;

    // Vent med at søge til postnummer-opslaget er færdigt, så vi ikke søger
    // med et "halvt" filter, mens DAWA stadig svarer.
    if (postnummer && postStatus === "henter") return;

    const timeout = setTimeout(
      () => {
        harSøgt.current = true;
        søg(query, kategori, sortering, aktivtCenter, erHeleDanmark ? null : radiusKm);
      },
      harSøgt.current ? 300 : 0,
    );
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kategori, sortering, postKoordinat, postStatus, radiusKm]);

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
      .select("*, bids(count)")
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
      setFejl(error.message);
      setLoading(false);
      return;
    }

    let rows = (data ?? []) as AuctionRow[];

    if (center && radiusKmAktiv != null) {
      // Auktioner uden gemte koordinater slås op via deres postnummer, så de
      // ikke bare udelukkes fra radius-filtreringen.
      const manglendePostnumre = Array.from(
        new Set(
          rows
            .filter((r) => (r.lat == null || r.lng == null) && r.postnummer)
            .map((r) => r.postnummer as string),
        ),
      );

      const opslag = await Promise.all(
        manglendePostnumre.map(async (pn) => {
          const { koordinat } = await slåPostnummerOp(pn);
          return [pn, koordinat] as const;
        }),
      );
      const postnummerKoordinater = new Map(opslag);

      rows = rows.filter((row) => {
        const koordinat: Koordinat | null =
          row.lat != null && row.lng != null
            ? { lat: row.lat, lng: row.lng }
            : row.postnummer
              ? postnummerKoordinater.get(row.postnummer) ?? null
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

  const erHeleDanmark = radiusKm >= RADIUS_MAX;

  return (
    <div>
      <div className="flex flex-col gap-4 bg-[#F3F4F6] px-4 py-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex flex-1 flex-wrap items-start gap-3">
          <select
            value={kategori}
            onChange={(e) => onKategoriChange(e.target.value)}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          >
            <option value="">Alle kategorier</option>
            {kategorier.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <select
            value={sortering}
            onChange={(e) => setSortering(e.target.value as Sortering)}
            className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          >
            <option value="slutter_snart">Slutter snart</option>
            <option value="laveste_bud">Laveste bud</option>
            <option value="højeste_bud">Højeste bud</option>
            <option value="nyeste">Nyeste</option>
          </select>

          <div>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              placeholder="Postnummer"
              value={postnummer}
              onChange={(e) =>
                setPostnummer(e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              className="w-32 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            {postStatus === "henter" && (
              <p className="mt-1 text-xs text-neutral-500">Henter by…</p>
            )}
            {postStatus === "fundet" && postBy && (
              <p className="mt-1 text-xs text-neutral-700">📍 {postBy}</p>
            )}
            {postStatus === "ikke-fundet" && (
              <p className="mt-1 text-xs text-red-600">
                Postnummeret kunne ikke findes.
              </p>
            )}
          </div>
        </div>

        <div className="flex w-full flex-col gap-1.5 sm:w-56">
          <div className="flex items-center justify-between text-xs text-neutral-500">
            <span>Radius</span>
            <span className="font-medium text-neutral-700">
              {erHeleDanmark ? "Hele Danmark" : `${radiusKm} km`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              step={RADIUS_STEP}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="accent-brand flex-1"
            />
            <button
              type="button"
              onClick={() => setRadiusKm(RADIUS_MAX)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium ${
                erHeleDanmark
                  ? "bg-brand text-white"
                  : "border border-neutral-300 text-neutral-600 hover:border-brand hover:text-brand"
              }`}
            >
              Hele Danmark
            </button>
          </div>
        </div>
      </div>

      <p className="mt-3 text-sm text-neutral-500">
        {loading
          ? "Søger…"
          : `${auktioner.length} auktion${auktioner.length === 1 ? "" : "er"} fundet`}
      </p>

      {fejl && <p className="mt-1 text-sm text-red-600">{fejl}</p>}

      {!loading && auktioner.length === 0 ? (
        <p className="mt-10 text-center text-sm text-neutral-500">
          Ingen auktioner matcher dine filtre.
        </p>
      ) : (
        <div
          className={`mt-6 grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 ${
            loading ? "opacity-50" : ""
          }`}
        >
          {auktioner.map((auktion) => (
            <AuctionCard key={auktion.id} auktion={auktion} />
          ))}
        </div>
      )}
    </div>
  );
}
