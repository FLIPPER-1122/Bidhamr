"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ALT_VALGT,
  INTET_VALG,
  SAMTYKKE_KATEGORIER,
  fortolkSamtykke,
  type SamtykkeValg,
} from "@/lib/samtykke";
import {
  gemSamtykke,
  hentSamtykke,
  laesGyldigSamtykkeRaa,
  lytTilAabn,
  lytTilSamtykke,
} from "@/lib/samtykkeKlient";
import { KATEGORI_TEKST, SAMTYKKE_TEKST as T } from "@/lib/tekster/samtykke";

// Cookie-banner nederst på siden. Ikke en modal: siden kan bruges, mens det
// står der. Serveren sender den gyldige cookieværdi med (startRaa), så banneret
// er med i den første HTML, hvis der mangler et valg - det blinker ikke frem
// efter hydrering. Det ligger fast (fixed) over indholdet og flytter derfor
// intet (ingen CLS); dets højde lægges som luft nederst på siden
// (--samtykke-hoejde), så intet indhold gemmer sig bag det.
//
// Datatilsynet: "Kun nødvendige" er lige så synlig og let som "Accepter alle"
// (samme størrelse, farve og vægt), og ingen kategori er slået til på forhånd.

// Begge valgknapper har nøjagtig samme udseende med vilje.
const VALGKNAP =
  "btn w-full bg-groen text-white hover:bg-groen-mork active:bg-groen-mork sm:w-auto sm:min-w-[164px]";

function Kontakt({
  til,
  onSkift,
  navnId,
  beskrivelseId,
}: {
  til: boolean;
  onSkift: () => void;
  navnId: string;
  beskrivelseId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={til}
      aria-labelledby={navnId}
      aria-describedby={beskrivelseId}
      onClick={onSkift}
      className="-mr-1 inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
    >
      <span
        aria-hidden
        className={`relative inline-flex h-7 w-12 items-center rounded-full border-2 transition-colors motion-reduce:transition-none ${
          til ? "border-groen bg-groen" : "border-tekst-svag bg-white"
        }`}
      >
        <span
          className={`h-5 w-5 rounded-full transition-transform motion-reduce:transition-none ${
            til ? "translate-x-[22px] bg-white" : "translate-x-[2px] bg-tekst-svag"
          }`}
        />
      </span>
    </button>
  );
}

export default function CookieBanner({ startRaa }: { startRaa: string }) {
  const raa = useSyncExternalStore(lytTilSamtykke, laesGyldigSamtykkeRaa, () => startRaa);
  const samtykke = useMemo(() => fortolkSamtykke(raa), [raa]);
  // null = indstillingerne er lukket; ellers de valg, man er ved at lave.
  const [udkast, setUdkast] = useState<SamtykkeValg | null>(null);
  const [besked, setBesked] = useState("");
  const boksRef = useRef<HTMLElement>(null);
  const overskriftRef = useRef<HTMLHeadingElement>(null);
  const tilbageRef = useRef<HTMLElement | null>(null);
  const id = useId();

  const vis = !samtykke || udkast !== null;
  const iIndstillinger = udkast !== null;

  // "Cookieindstillinger" i footeren m.fl. åbner indstillingerne.
  useEffect(
    () =>
      lytTilAabn(() => {
        const aktiv = document.activeElement;
        tilbageRef.current = aktiv instanceof HTMLElement ? aktiv : null;
        setBesked("");
        setUdkast(hentSamtykke()?.valg ?? { ...INTET_VALG });
      }),
    [],
  );

  // Fokus til overskriften, når indstillingerne åbnes.
  useEffect(() => {
    if (iIndstillinger) overskriftRef.current?.focus();
  }, [iIndstillinger]);

  // Bannerets højde bliver til luft nederst på siden.
  useEffect(() => {
    const el = boksRef.current;
    const rod = document.documentElement;
    if (!vis || !el) return;
    const saet = () => rod.style.setProperty("--samtykke-hoejde", `${Math.ceil(el.offsetHeight)}px`);
    saet();
    const ro = new ResizeObserver(saet);
    ro.observe(el);
    return () => {
      ro.disconnect();
      rod.style.removeProperty("--samtykke-hoejde");
    };
  }, [vis, iIndstillinger]);

  function vaelg(valg: SamtykkeValg) {
    gemSamtykke(valg);
    setUdkast(null);
    setBesked(T.gemt);
    const tilbage = tilbageRef.current;
    tilbageRef.current = null;
    if (tilbage?.isConnected) tilbage.focus();
  }

  function aabnFraBanner() {
    tilbageRef.current = null;
    setUdkast(samtykke?.valg ?? { ...INTET_VALG });
  }

  function lukIndstillinger() {
    setUdkast(null);
    const tilbage = tilbageRef.current;
    tilbageRef.current = null;
    if (tilbage?.isConnected) tilbage.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Esc lukker kun indstillingerne. Uden et valg står banneret, til man vælger.
    if (e.key === "Escape" && iIndstillinger) {
      e.stopPropagation();
      lukIndstillinger();
    }
  }

  const dato = samtykke
    ? new Date(samtykke.tidspunkt * 1000).toLocaleDateString("da-DK", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <>
      <p role="status" className="sr-only">
        {besked}
      </p>
      {vis && (
        <section
          ref={boksRef}
          aria-labelledby={`${id}-overskrift`}
          onKeyDown={onKeyDown}
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[35] px-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6"
        >
          <div className="pointer-events-auto mx-auto max-h-[85dvh] w-full max-w-[960px] overflow-y-auto rounded-[14px] border border-kant bg-white p-4 shadow-stor sm:rounded-[18px] sm:p-6">
            {!iIndstillinger ? (
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-8">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <h2
                      id={`${id}-overskrift`}
                      ref={overskriftRef}
                      tabIndex={-1}
                      className="text-[17px] leading-snug text-groen-mork outline-none sm:text-[18px]"
                    >
                      {T.bannerOverskrift}
                    </h2>
                    {/* Mobil/tablet: ved overskriften. Computer: ved knapperne. */}
                    <button
                      type="button"
                      onClick={aabnFraBanner}
                      className="-my-2 inline-flex min-h-11 shrink-0 items-center rounded-md px-1 text-sm font-semibold text-groen underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:hidden"
                    >
                      {T.indstillinger}
                    </button>
                  </div>
                  <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-tekst-daempet">
                    {T.bannerTekst}{" "}
                    <Link
                      href="/cookies"
                      className="font-medium text-groen underline underline-offset-2 hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                    >
                      {T.laesMere}
                    </Link>
                  </p>
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:gap-3">
                  <button
                    type="button"
                    onClick={aabnFraBanner}
                    className="btn hidden px-3 text-groen underline-offset-2 hover:underline lg:inline-flex"
                  >
                    {T.indstillinger}
                  </button>
                  <button type="button" onClick={() => vaelg({ ...ALT_VALGT })} className={VALGKNAP}>
                    {T.accepterAlle}
                  </button>
                  <button type="button" onClick={() => vaelg({ ...INTET_VALG })} className={VALGKNAP}>
                    {T.kunNoedvendige}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h2
                    id={`${id}-overskrift`}
                    ref={overskriftRef}
                    tabIndex={-1}
                    className="text-[17px] leading-snug text-groen-mork outline-none sm:text-[18px]"
                  >
                    {T.indstillingerOverskrift}
                  </h2>
                  {samtykke && (
                    <button
                      type="button"
                      onClick={lukIndstillinger}
                      aria-label={T.luk}
                      className="-m-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-tekst-daempet hover:bg-groen-lys hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
                <p className="mt-1 max-w-[70ch] text-sm leading-relaxed text-tekst-daempet">
                  {T.indstillingerTekst}
                  {dato && <> {T.nuvaerendeValg(dato)}</>}{" "}
                  <Link
                    href="/cookies"
                    className="font-medium text-groen underline underline-offset-2 hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                  >
                    {T.laesMere}
                  </Link>
                </p>

                <ul className="mt-4 flex flex-col gap-2">
                  <li className="flex items-center justify-between gap-4 rounded-xl border border-kant p-3 sm:p-4">
                    <div className="min-w-0">
                      <h3 className="font-sans text-[15px] font-semibold text-tekst">{T.noedvendigeNavn}</h3>
                      <p className="mt-0.5 text-sm leading-relaxed text-tekst-daempet">{T.noedvendigeBeskrivelse}</p>
                    </div>
                    <span className="shrink-0 text-[13px] font-semibold text-groen-mork">{T.altidTil}</span>
                  </li>
                  {SAMTYKKE_KATEGORIER.map((k) => {
                    const navnId = `${id}-${k.id}-navn`;
                    const beskrivelseId = `${id}-${k.id}-beskrivelse`;
                    return (
                      <li key={k.id} className="flex items-center justify-between gap-4 rounded-xl border border-kant p-3 sm:p-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h3 id={navnId} className="font-sans text-[15px] font-semibold text-tekst">
                              {KATEGORI_TEKST[k.id].navn}
                            </h3>
                            {!k.iBrug && (
                              <span className="rounded-full bg-groen-lys px-2 py-0.5 text-xs font-medium text-groen-mork">
                                {T.ikkeIBrug}
                              </span>
                            )}
                          </div>
                          <p id={beskrivelseId} className="mt-0.5 text-sm leading-relaxed text-tekst-daempet">
                            {KATEGORI_TEKST[k.id].beskrivelse}
                            {!k.iBrug && <span className="sr-only"> {T.ikkeIBrug}.</span>}
                          </p>
                        </div>
                        <Kontakt
                          til={udkast[k.id]}
                          onSkift={() => setUdkast((u) => (u ? { ...u, [k.id]: !u[k.id] } : u))}
                          navnId={navnId}
                          beskrivelseId={beskrivelseId}
                        />
                      </li>
                    );
                  })}
                </ul>

                <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:justify-end sm:gap-3">
                  <button type="button" onClick={() => vaelg({ ...ALT_VALGT })} className={VALGKNAP}>
                    {T.accepterAlle}
                  </button>
                  <button type="button" onClick={() => vaelg({ ...INTET_VALG })} className={VALGKNAP}>
                    {T.kunNoedvendige}
                  </button>
                  <button
                    type="button"
                    onClick={() => vaelg(udkast)}
                    className={`${VALGKNAP} col-span-2 sm:col-span-1`}
                  >
                    {T.gemValg}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
