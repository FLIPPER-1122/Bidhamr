"use client";

import { useEffect, useRef, useState } from "react";
import AuctionCard, { type DummyAuction } from "@/components/AuctionCard";
import Ikon from "@/components/Ikon";
import { kategorier } from "@/lib/kategorier";
import { UKENDT_POSTNUMMER } from "@/lib/postnummerTekst";
import { soegAuktioner } from "@/app/actions/auktionSoegning";

import { SORTERINGER, type Sortering } from "@/lib/sortering";
import { antalFundet, antalTekst, type TotalType } from "@/lib/soegeTotal";
import GemSoegningKnap from "@/components/soegning/GemSoegningKnap";

// Felter i filterbjælken (DESIGN.md 8.2).
const felt =
  "h-11 w-full rounded-xl border border-kant-staerk bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";
const etiket = "mb-1.5 block text-sm font-medium text-tekst";

const RADIUS_MIN = 5;
const RADIUS_MAX = 150;
const RADIUS_STEP = 5;
const FEJL = "Auktionerne kunne ikke hentes. Prøv igen.";

type Opslag = typeof import("@/lib/postnumre").slaaPostnummerOp;
type Afstand = { postnummer: string; radiusKm: number } | null;

// De filtre, der faktisk sendes til serveren. Postnummer og radius tæller
// kun, når postnummeret findes, og radius er under "Hele Danmark".
function filterNoegle(query: string, kategori: string, sortering: Sortering, afstand: Afstand) {
  return JSON.stringify({ q: query.trim(), kategori, sortering, afstand });
}

export default function AuctionBrowser({
  initialAuktioner,
  initialTotal,
  initialTotalType,
  initialQuery,
  initialKategori = "",
  initialSortering = "slutter_snart",
  initialPostnummer = "",
  initialRadiusKm = 50,
  initialAfstandAktiv = false,
  kategori,
  onKategoriChange,
  erLoggetInd = false,
}: {
  // Første side er hentet på serveren med de samme filtre (src/lib/auktionSoegning.ts).
  initialAuktioner: DummyAuction[];
  initialTotal: number;
  initialTotalType: TotalType;
  initialQuery: string;
  initialKategori?: string;
  initialSortering?: Sortering;
  // Fra ?postnummer=&afstand= (fx linket i en notifikation om en gemt søgning).
  initialPostnummer?: string;
  initialRadiusKm?: number;
  // Serveren har filtreret på afstand (postnummeret findes, og radius er
  // under "Hele Danmark").
  initialAfstandAktiv?: boolean;
  kategori: string;
  onKategoriChange: (kategori: string) => void;
  erLoggetInd?: boolean;
}) {
  const query = initialQuery;
  const [sortering, setSortering] = useState<Sortering>(initialSortering);
  const [postnummer, setPostnummer] = useState(initialPostnummer);
  // Postnummeret slås op i den lokale postnummerliste. Listen (ca. 50 kB)
  // indlæses først, når der står et helt postnummer i feltet, så den ikke er
  // med i sidens JavaScript fra start.
  const gyldigtPostnummer = /^\d{4}$/.test(postnummer);
  const [slaaOp, setSlaaOp] = useState<Opslag | null>(null);
  useEffect(() => {
    if (!gyldigtPostnummer || slaaOp) return;
    let aktiv = true;
    import("@/lib/postnumre").then((m) => {
      if (aktiv) setSlaaOp(() => m.slaaPostnummerOp);
    });
    return () => {
      aktiv = false;
    };
  }, [gyldigtPostnummer, slaaOp]);
  const venterPaaOpslag = gyldigtPostnummer && !slaaOp;
  const postOpslag = gyldigtPostnummer && slaaOp ? slaaOp(postnummer) : null;
  const postBy = postOpslag?.by ?? null;
  const postStatus: "idle" | "fundet" | "ikke-fundet" = !gyldigtPostnummer || venterPaaOpslag
    ? "idle"
    : postOpslag
      ? "fundet"
      : "ikke-fundet";
  const [radiusKm, setRadiusKm] = useState(initialRadiusKm);
  const [auktioner, setAuktioner] = useState<DummyAuction[]>(initialAuktioner);
  const [total, setTotal] = useState(initialTotal);
  const [totalType, setTotalType] = useState<TotalType>(initialTotalType);
  const [loading, setLoading] = useState(false);
  const [henterFlere, setHenterFlere] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  const afstand: Afstand = radiusKm < RADIUS_MAX && postOpslag ? { postnummer, radiusKm } : null;
  const noegle = filterNoegle(query, kategori, sortering, afstand);
  // Filtrene, den viste liste er hentet med. Starter som serverens.
  const hentetNoegle = useRef(
    filterNoegle(
      initialQuery,
      initialKategori,
      initialSortering,
      initialAfstandAktiv ? { postnummer: initialPostnummer, radiusKm: initialRadiusKm } : null,
    ),
  );
  // Kun svaret på den seneste forespørgsel må vises.
  const forespoergselNr = useRef(0);

  function filtre(offset: number) {
    return {
      q: query.trim(),
      kategori,
      sortering,
      postnummer: afstand?.postnummer,
      radiusKm: afstand?.radiusKm,
      offset,
    };
  }

  // Nye filtre: hent første side igen (lidt forsinket, mens man trækker i
  // afstandsskyderen eller taster postnummer).
  useEffect(() => {
    // Vent på postnummerlisten, før afstanden kan afgøres.
    if (venterPaaOpslag || noegle === hentetNoegle.current) return;
    const timeout = setTimeout(async () => {
      const nr = ++forespoergselNr.current;
      setLoading(true);
      setFejl(null);
      try {
        const svar = await soegAuktioner(filtre(0));
        if (nr !== forespoergselNr.current) return;
        if (!svar.ok) {
          setFejl(svar.fejl);
        } else {
          hentetNoegle.current = noegle;
          setAuktioner(svar.auktioner);
          setTotal(svar.total);
          setTotalType(svar.totalType);
        }
      } catch {
        if (nr === forespoergselNr.current) setFejl(FEJL);
      } finally {
        if (nr === forespoergselNr.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
    // filtre() læser kun værdier, der indgår i noegle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noegle, venterPaaOpslag]);

  async function visFlere() {
    const nr = ++forespoergselNr.current;
    setHenterFlere(true);
    setFejl(null);
    try {
      const svar = await soegAuktioner(filtre(auktioner.length));
      if (nr !== forespoergselNr.current) return;
      if (!svar.ok) {
        setFejl(svar.fejl);
      } else {
        // Undgå dubletter, hvis listen har flyttet sig imens.
        const kendte = new Set(auktioner.map((a) => a.id));
        setAuktioner([...auktioner, ...svar.auktioner.filter((a) => !kendte.has(a.id))]);
        setTotal(svar.total);
        setTotalType(svar.totalType);
      }
    } catch {
      if (nr === forespoergselNr.current) setFejl(FEJL);
    } finally {
      setHenterFlere(false);
    }
  }

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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-tekst-svag" aria-live="polite">
          {loading
            ? "Søger…"
            : antalFundet(total, totalType)}
        </p>
        <GemSoegningKnap
          erLoggetInd={erLoggetInd}
          kriterier={{
            soegeord: query.trim(),
            kategori: kategori || null,
            postnummer: !erHeleDanmark && postStatus === "fundet" ? postnummer : null,
            radiusKm: !erHeleDanmark && postStatus === "fundet" ? radiusKm : null,
          }}
        />
      </div>

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

      {!loading && auktioner.length > 0 && auktioner.length < total && (
        <div className="mt-6 flex flex-col items-center gap-2">
          <p className="text-sm text-tekst-svag">
            Viser {auktioner.length} af {antalTekst(total, totalType)}
          </p>
          <button
            type="button"
            onClick={visFlere}
            disabled={henterFlere}
            aria-busy={henterFlere}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            {henterFlere ? "Henter…" : "Vis flere auktioner"}
          </button>
        </div>
      )}
    </div>
  );
}
