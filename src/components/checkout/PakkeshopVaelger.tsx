"use client";

// "Vælg pakkeshop": vindue med søgefelt, liste til venstre og kort til højre
// (fuld skærm på mobil, kortet øverst). Listen er en radiogruppe, så den kan
// bruges med tastatur (piletaster) og skærmlæser. Esc lukker, Tab holdes inde
// i vinduet, og fokus går tilbage til knappen, der åbnede det.
// TODO(indhold): gennemse teksterne.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { soegPakkeshopsAction } from "@/app/actions/fragt";
import type { Pakkeshop } from "@/lib/fragt/types";
import Ikon from "@/components/Ikon";

const PakkeshopKort = dynamic(() => import("@/components/checkout/PakkeshopKort"), {
  ssr: false,
  loading: () => <div className="h-full min-h-[200px] w-full animate-pulse bg-groen-lys" aria-hidden="true" />,
});

export type ValgtPakkeshop = {
  id: string;
  navn: string;
  adresse: string;
  postnummer: string;
  by: string;
  // Søgningen, shoppen blev fundet med (serveren slår den op igen med den).
  soegPostnummer: string;
  soegAdresse: string | null;
};

export function afstandTekst(m: number | null) {
  if (m === null) return null;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toLocaleString("da-DK", { maximumFractionDigits: 1 })} km`;
}

// "Vesterbrogade 10, 1620 København V" -> postnummer 1620, adresse "Vesterbrogade 10".
function fortolkSoegning(tekst: string): { postnummer: string; adresse: string | null } | null {
  const m = /(?:^|\D)(\d{4})(?!\d)/.exec(tekst);
  if (!m) return null;
  const foer = tekst.slice(0, m.index + m[0].indexOf(m[1])).replace(/[,\s]+$/, "").trim();
  return { postnummer: m[1], adresse: foer.length >= 3 ? foer : null };
}

export default function PakkeshopVaelger({
  onLuk,
  onBekraeft,
  startSoegning,
  valgt,
}: {
  onLuk: () => void;
  onBekraeft: (shop: ValgtPakkeshop) => void;
  startSoegning: string;
  valgt: ValgtPakkeshop | null;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const soegRef = useRef<HTMLInputElement>(null);
  const listeRef = useRef<HTMLDivElement>(null);
  const bekraeftRef = useRef<HTMLButtonElement>(null);
  const [soegning, setSoegning] = useState(startSoegning);
  const [shops, setShops] = useState<Pakkeshop[]>([]);
  const [soegt, setSoegt] = useState<{ postnummer: string; adresse: string | null } | null>(null);
  const [markeret, setMarkeret] = useState<string | null>(valgt?.id ?? null);
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  // Mobil: liste eller kort (begge vises fra lg).
  const [visning, setVisning] = useState<"liste" | "kort">("liste");
  const foersteSoegning = useRef(true);

  const soeg = useCallback(async (tekst: string) => {
    const q = fortolkSoegning(tekst);
    if (!q) {
      setFejl("Skriv et postnummer (4 cifre) – gerne med vejnavn, så finder vi de nærmeste.");
      return;
    }
    setHenter(true);
    setFejl(null);
    try {
      const r = await soegPakkeshopsAction({ postnummer: q.postnummer, adresse: q.adresse, antal: 20 });
      if ("fejl" in r) {
        setFejl(r.fejl);
        setShops([]);
      } else {
        setShops(r.pakkeshops);
        // Behold markeringen, hvis shoppen stadig er med.
        setMarkeret((m) => (m && r.pakkeshops.some((s) => s.id === m) ? m : null));
      }
    } catch {
      setFejl("Pakkeshops kunne ikke hentes. Prøv igen om lidt.");
    } finally {
      setHenter(false);
      setSoegt({ postnummer: q.postnummer, adresse: q.adresse });
    }
  }, []);

  // Ved åbning (vinduet monteres først, når det åbnes): fokus i søgefeltet,
  // siden bagved ruller ikke, og der søges med det, vi kender (postnummer).
  // Ved lukning går fokus tilbage til knappen, der åbnede det.
  const startRef = useRef(startSoegning);
  useEffect(() => {
    const forrige = document.activeElement as HTMLElement | null;
    soegRef.current?.focus();
    if (foersteSoegning.current && startRef.current) {
      foersteSoegning.current = false;
      void soeg(startRef.current);
    }
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = scroll;
      forrige?.focus?.();
    };
  }, [soeg]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onLuk();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const fokuserbare = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (fokuserbare.length === 0) return;
    const foerste = fokuserbare[0];
    const sidste = fokuserbare[fokuserbare.length - 1];
    if (e.shiftKey && document.activeElement === foerste) {
      e.preventDefault();
      sidste.focus();
    } else if (!e.shiftKey && document.activeElement === sidste) {
      e.preventDefault();
      foerste.focus();
    }
  }

  function vaelgFraKort(shopId: string) {
    setMarkeret(shopId);
    // Vis den valgte i listen (mobil: skift til listen, så "Bekræft" ses).
    const el = listeRef.current?.querySelector<HTMLElement>(`[data-shop="${CSS.escape(shopId)}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function bekraeft() {
    const s = shops.find((x) => x.id === markeret);
    if (!s) return;
    onBekraeft({
      id: s.id,
      navn: s.navn,
      adresse: s.adresse,
      postnummer: s.postnummer,
      by: s.by,
      soegPostnummer: soegt?.postnummer ?? s.postnummer,
      soegAdresse: soegt?.adresse ?? null,
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void soeg(soegning);
  }

  const valgtShop = shops.find((s) => s.id === markeret) ?? null;
  const harKoordinater = shops.some((s) => s.lat !== null && s.lng !== null);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 lg:items-center lg:p-6" onClick={onLuk}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-titel`}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden bg-white shadow-[0_10px_40px_rgba(0,0,0,.13)] lg:h-[min(760px,90vh)] lg:max-w-[1120px] lg:rounded-[18px]"
      >
        {/* Hoved: titel, luk og søgning */}
        <div className="border-b border-kant px-4 pt-4 pb-3 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <h2 id={`${id}-titel`} className="font-serif text-[20px] leading-tight lg:text-[22px]">
              Vælg pakkeshop
            </h2>
            <button
              type="button"
              onClick={onLuk}
              className="-mr-2 grid h-11 w-11 place-items-center rounded-full text-tekst-daempet hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              <Ikon navn="luk" className="h-5 w-5" />
              <span className="sr-only">Luk</span>
            </button>
          </div>
          <form onSubmit={onSubmit} role="search" className="mt-3 flex gap-2">
            <label htmlFor={`${id}-soeg`} className="sr-only">
              Adresse eller postnummer
            </label>
            <input
              ref={soegRef}
              id={`${id}-soeg`}
              type="search"
              value={soegning}
              onChange={(e) => setSoegning(e.target.value)}
              placeholder="Adresse eller postnummer, fx 2100"
              autoComplete="street-address"
              enterKeyHint="search"
              aria-describedby={fejl ? `${id}-fejl` : undefined}
              className="h-11 min-w-0 flex-1 rounded-xl border border-kant-staerk bg-white px-4 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
            />
            <button type="submit" disabled={henter} aria-busy={henter || undefined} className="btn btn-primaer shrink-0 px-4">
              {henter && <span className="btn-spinner" aria-hidden="true" />}
              <Ikon navn="soeg" className="h-[18px] w-[18px]" />
              <span className="max-sm:sr-only">Søg</span>
            </button>
          </form>
          {fejl && (
            <p id={`${id}-fejl`} role="alert" className="mt-2 text-[13px] font-medium text-fejl-tekst">
              {fejl}
            </p>
          )}
          {/* Mobil: skift mellem liste og kort */}
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-groen-lys p-1 lg:hidden" role="group" aria-label="Visning">
            {(["liste", "kort"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={visning === v}
                onClick={() => setVisning(v)}
                className={`min-h-10 rounded-lg text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                  visning === v ? "bg-white text-groen-mork shadow-sm" : "text-tekst-daempet"
                }`}
              >
                {v === "liste" ? "Liste" : "Kort"}
              </button>
            ))}
          </div>
        </div>

        {/* Liste og kort */}
        <div className="flex min-h-0 flex-1">
          <div
            ref={listeRef}
            className={`min-h-0 w-full overflow-y-auto lg:block lg:w-[400px] lg:shrink-0 lg:border-r lg:border-kant ${
              visning === "liste" ? "block" : "hidden"
            }`}
            aria-busy={henter || undefined}
          >
            {henter && shops.length === 0 ? (
              <ul className="space-y-2 p-4" aria-hidden="true">
                {Array.from({ length: 5 }, (_, i) => (
                  <li key={i} className="h-[76px] animate-pulse rounded-xl bg-groen-lys" />
                ))}
              </ul>
            ) : shops.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork">
                  <Ikon navn="soeg" className="h-6 w-6" />
                </span>
                <p className="mt-3 text-[15px] font-semibold text-tekst">
                  {soegt && !fejl ? "Ingen pakkeshops fundet" : "Find en pakkeshop nær dig"}
                </p>
                <p className="mt-1 text-sm text-tekst-daempet">
                  {soegt && !fejl ? "Prøv et andet postnummer eller en adresse." : "Skriv din adresse eller dit postnummer ovenfor."}
                </p>
              </div>
            ) : (
              <fieldset className="p-3 sm:p-4">
                <legend className="sr-only">Pakkeshops nær {soegning}</legend>
                <p className="px-1 pb-2 text-[13px] text-tekst-svag" aria-live="polite">
                  {shops.length} pakkeshops – nærmeste først
                </p>
                <div className="space-y-2">
                  {shops.map((s, i) => {
                    const er = s.id === markeret;
                    const afstand = afstandTekst(s.afstandM);
                    return (
                      <label
                        key={s.id}
                        data-shop={s.id}
                        className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-groen ${
                          er ? "border-groen bg-groen-lys" : "border-kant hover:border-kant-staerk"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`${id}-shop`}
                          value={s.id}
                          checked={er}
                          onChange={() => setMarkeret(s.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              setMarkeret(s.id);
                              bekraeftRef.current?.focus();
                            }
                          }}
                          className="sr-only"
                        />
                        <span
                          aria-hidden="true"
                          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white ${
                            er ? "bg-orange-knap" : "bg-groen"
                          }`}
                        >
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[15px] font-semibold text-tekst">{s.navn}</span>
                            {afstand && <span className="shrink-0 text-[13px] text-tekst-svag">{afstand}</span>}
                          </span>
                          <span className="block text-sm text-tekst-daempet">
                            {s.adresse}, {s.postnummer} {s.by}
                          </span>
                          {er && s.aabningstider.length > 0 && (
                            <span className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-[13px] text-tekst-daempet">
                              {s.aabningstider.map((a) => (
                                <span key={a.dag} className="contents">
                                  <span>{a.dag}</span>
                                  <span className="tabular-nums">{a.tider}</span>
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                        {er && <Ikon navn="flueben" className="mt-1 h-5 w-5 shrink-0 text-groen" />}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </div>
          <div className={`min-h-0 flex-1 lg:block ${visning === "kort" ? "block" : "hidden"}`}>
            {shops.length > 0 && harKoordinater ? (
              <PakkeshopKort shops={shops} valgtId={markeret} onVaelg={vaelgFraKort} />
            ) : (
              <div className="grid h-full place-items-center bg-groen-lys px-6 text-center text-sm text-tekst-daempet">
                {henter ? "Henter kortet…" : "Kortet vises, når du har søgt."}
              </div>
            )}
          </div>
        </div>

        {/* Fod: valgt shop + Bekræft */}
        <div className="border-t border-kant bg-white px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-sm text-tekst-daempet" aria-live="polite">
              {valgtShop ? (
                <>
                  Valgt: <span className="font-semibold text-tekst">{valgtShop.navn}</span>
                </>
              ) : (
                "Vælg en pakkeshop på listen eller kortet."
              )}
            </p>
            <button
              ref={bekraeftRef}
              type="button"
              onClick={bekraeft}
              disabled={!valgtShop}
              className="btn btn-primaer btn-stor w-full sm:w-auto sm:min-w-[200px]"
            >
              Bekræft pakkeshop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
