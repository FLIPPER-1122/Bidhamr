"use client";

// Klokken i topbaren. Antallet af ulæste hentes ved sideskift, når fanen bliver
// synlig igen, og hvert 60. sekund (ingen realtime). Panelet henter de seneste
// notifikationer, hver gang det åbnes.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  antalUlaeste,
  hentNotifikationer,
  markerAlleLaest,
  type Notifikation,
} from "@/app/actions/notifikationer";
import NotifikationPunkt from "@/components/notifikationer/NotifikationPunkt";
import {
  NOTIFIKATIONER_OPDATERET,
  badgeTekst,
  meldNotifikationerOpdateret,
} from "@/lib/notifikationer/visning";

const ANTAL_I_PANEL = 8;
const INTERVAL_MS = 60_000;

export default function Klokke({ startAntal }: { startAntal: number }) {
  const [antal, setAntal] = useState(startAntal);
  const [aaben, setAaben] = useState(false);
  const [liste, setListe] = useState<Notifikation[] | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [markererAlle, setMarkererAlle] = useState(false);
  const rodRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const overskriftId = useId();
  const pathname = usePathname();
  const foersteRender = useRef(true);

  const opdaterAntal = useCallback(async () => {
    const svar = await antalUlaeste();
    if ("antal" in svar) setAntal(svar.antal);
  }, []);

  const hentListe = useCallback(async () => {
    setFejl(null);
    const svar = await hentNotifikationer({ antal: ANTAL_I_PANEL });
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    setListe(svar.notifikationer);
  }, []);

  // Sideskift: hent tallet igen (første render har allerede tallet fra serveren).
  useEffect(() => {
    if (foersteRender.current) {
      foersteRender.current = false;
      return;
    }
    void opdaterAntal();
  }, [pathname, opdaterAntal]);

  // Hvert 60. sekund, mens fanen er synlig, + når den bliver synlig igen,
  // + når indbakken har markeret noget som læst.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void opdaterAntal();
    }, INTERVAL_MS);
    function vedSynlig() {
      if (document.visibilityState === "visible") void opdaterAntal();
    }
    function vedOpdateret() {
      void opdaterAntal();
    }
    document.addEventListener("visibilitychange", vedSynlig);
    window.addEventListener(NOTIFIKATIONER_OPDATERET, vedOpdateret);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", vedSynlig);
      window.removeEventListener(NOTIFIKATIONER_OPDATERET, vedOpdateret);
    };
  }, [opdaterAntal]);

  // Luk ved klik udenfor og Escape.
  useEffect(() => {
    if (!aaben) return;
    function vedKlik(e: MouseEvent) {
      if (rodRef.current && !rodRef.current.contains(e.target as Node)) setAaben(false);
    }
    function vedTast(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAaben(false);
        knapRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", vedKlik);
    document.addEventListener("keydown", vedTast);
    return () => {
      document.removeEventListener("mousedown", vedKlik);
      document.removeEventListener("keydown", vedTast);
    };
  }, [aaben]);

  function skift() {
    const nyAaben = !aaben;
    setAaben(nyAaben);
    if (nyAaben) {
      void hentListe();
      void opdaterAntal();
    }
  }

  function vedLaest(id: string) {
    setListe((l) => l?.map((n) => (n.id === id ? { ...n, laest_kl: new Date().toISOString() } : n)) ?? l);
    setAntal((a) => Math.max(0, a - 1));
  }

  async function markerAlle() {
    setMarkererAlle(true);
    setFejl(null);
    const svar = await markerAlleLaest();
    setMarkererAlle(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    const nu = new Date().toISOString();
    setListe((l) => l?.map((n) => (n.laest_kl ? n : { ...n, laest_kl: nu })) ?? l);
    setAntal(0);
    meldNotifikationerOpdateret();
  }

  const luk = () => setAaben(false);
  const knapLabel =
    antal === 0
      ? "Notifikationer"
      : `Notifikationer, ${antal} ${antal === 1 ? "ulæst" : "ulæste"}`;

  return (
    // lg:relative: på mobil placeres panelet i forhold til hele headeren (fuld bredde).
    <div ref={rodRef} className="lg:relative">
      <button
        ref={knapRef}
        type="button"
        aria-label={knapLabel}
        aria-expanded={aaben}
        aria-controls={panelId}
        onClick={skift}
        className="relative flex h-11 w-11 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1" />
        </svg>
        {antal > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-fejl-fyldt px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-white"
          >
            {badgeTekst(antal)}
          </span>
        )}
      </button>

      {/* Skærmlæsere får besked, når tallet ændrer sig. */}
      <span className="sr-only" aria-live="polite">
        {antal > 0 ? `${antal} ${antal === 1 ? "ulæst notifikation" : "ulæste notifikationer"}` : ""}
      </span>

      {aaben && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={overskriftId}
          className="absolute inset-x-0 top-full z-50 border-y border-kant bg-white shadow-[0_8px_30px_rgba(0,0,0,.13)] lg:inset-x-auto lg:right-0 lg:mt-2 lg:w-[400px] lg:rounded-xl lg:border"
        >
          <div className="flex items-center justify-between gap-3 border-b border-kant px-4 py-3">
            <h2 id={overskriftId} className="font-sans text-[15px] font-semibold text-tekst">
              Notifikationer
            </h2>
            <button
              type="button"
              onClick={markerAlle}
              disabled={markererAlle || (antal === 0 && !liste?.some((n) => !n.laest_kl))}
              aria-busy={markererAlle}
              className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:cursor-not-allowed disabled:text-tekst-svag disabled:no-underline"
            >
              {markererAlle && <span className="btn-spinner" aria-hidden="true" />}
              Markér alle som læst
            </button>
          </div>

          <div className="max-h-[min(60vh,480px)] overflow-y-auto overscroll-contain p-2">
            {fejl && (
              <p role="alert" className="m-2 rounded-xl border border-fejl-kant bg-fejl-bg p-3 text-sm text-fejl-tekst">
                {fejl}
              </p>
            )}
            {liste === null && !fejl && (
              <ul aria-busy="true" className="flex flex-col gap-1">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="flex gap-3 px-3 py-3">
                    <span className="w-2.5 shrink-0" />
                    <span className="flex-1">
                      <span className="block h-4 w-3/4 animate-pulse rounded bg-skelet" />
                      <span className="mt-2 block h-3 w-full animate-pulse rounded bg-skelet" />
                      <span className="mt-2 block h-3 w-1/4 animate-pulse rounded bg-skelet" />
                    </span>
                  </li>
                ))}
                <li className="sr-only">Indlæser…</li>
              </ul>
            )}
            {liste !== null && liste.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-[15px] font-medium text-tekst">Ingen notifikationer endnu</p>
                <p className="mt-1 text-sm text-tekst-daempet">
                  Her får du besked om bud, handler og betalinger.
                </p>
              </div>
            )}
            {liste !== null && liste.length > 0 && (
              <ul className="flex flex-col gap-1">
                {liste.map((n) => (
                  <li key={n.id}>
                    <NotifikationPunkt n={n} vedLaest={vedLaest} vedNavigation={luk} kompakt />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 border-t border-kant px-4 py-1">
            <Link
              href="/notifikationer"
              onClick={luk}
              className="flex min-h-11 items-center text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              Se alle
            </Link>
            <Link
              href="/konto/notifikationer"
              onClick={luk}
              className="flex min-h-11 items-center text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              Indstillinger
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
