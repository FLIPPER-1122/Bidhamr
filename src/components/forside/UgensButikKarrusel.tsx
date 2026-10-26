"use client";

// "Ugens butik" i forsidens hero (højre side) - Filips godkendte showcase
// (showcase/forside-ugens-butik-showcase.html): "Annonce · Ugens butik",
// firmanavnet som stor overskrift, "Se butikken" og ét stort billede ad
// gangen fra firmaets aktive auktioner. Billederne glider over i hinanden
// hvert 5. sekund (opacity 1,4 s, langsom zoom, pris og titel toner ind), med
// fremdriftsstreger nederst. Pause, mens musen er over billedet (eller
// fokus er i feltet). prefers-reduced-motion: intet skifter af sig selv, og
// overgangene er slået fra (også globalt i globals.css).
// Data kommer fra forside_ugens_butik (server, src/app/(app)/(forside)/page.tsx).
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { kanOptimeres } from "@/lib/billedUrl";
import { UGENS_FORSIDE as T } from "@/lib/tekster/ugensButik";

export type UgensSlide = {
  id: string;
  titel: string;
  billede: string | null;
  pris: string;
  meta: string;
  tid: string;
};

const SKIFT_MS = 5000;

export default function UgensButikKarrusel({
  firmanavn,
  profilUrl,
  slides,
  className = "",
}: {
  firmanavn: string;
  profilUrl: string;
  slides: UgensSlide[];
  className?: string;
}) {
  const [nr, setNr] = useState(0);
  // Øges ved hvert (gen)start, så fremdriftsstregen begynder forfra.
  const [runde, setRunde] = useState(0);
  const [pause, setPause] = useState(false);
  const [rolig, setRolig] = useState(false);
  const antal = slides.length;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const opdater = () => setRolig(mq.matches);
    opdater();
    mq.addEventListener("change", opdater);
    return () => mq.removeEventListener("change", opdater);
  }, []);

  useEffect(() => {
    if (pause || rolig || antal < 2) return;
    const t = window.setTimeout(() => {
      setNr((n) => (n + 1) % antal);
      setRunde((r) => r + 1);
    }, SKIFT_MS);
    return () => window.clearTimeout(t);
  }, [nr, runde, pause, rolig, antal]);

  function gaaTil(i: number) {
    setNr(((i % antal) + antal) % antal);
    setRunde((r) => r + 1);
  }

  function stop() {
    setPause(true);
  }
  function fortsaet() {
    setPause(false);
    // Billedet får sine fulde 5 sekunder igen.
    setRunde((r) => r + 1);
  }

  return (
    <section
      aria-label={T.omraadeLabel(firmanavn)}
      className={`flex h-[440px] min-w-0 flex-col bg-groen-mork text-white sm:h-[480px] md:h-auto md:flex-1 ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3.5 sm:px-6 sm:pt-6">
        <div className="min-w-0">
          <span className="inline-block bg-white/15 px-2 py-1 text-[11px] font-bold tracking-[0.08em] uppercase">{T.maerke}</span>
          <h2 className="mt-2.5 text-[28px] leading-[1.05] font-extrabold break-words sm:text-[34px]">{firmanavn}</h2>
        </div>
        <Link
          href={profilUrl}
          aria-label={T.seButikkenLabel(firmanavn)}
          className="btn btn-paa-groen shrink-0 px-3.5 text-sm font-bold whitespace-nowrap text-tekst"
        >
          {T.seButikken}
        </Link>
      </div>

      <div
        className="relative mx-[3px] min-h-0 flex-1 overflow-hidden bg-[#222]"
        onMouseEnter={stop}
        onMouseLeave={fortsaet}
        onFocus={stop}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) fortsaet();
        }}
      >
        {slides.map((s, i) => {
          const vis = i === nr;
          return (
            <Link
              key={s.id}
              href={`/auktion/${s.id}`}
              aria-label={T.aabnAuktion(s.titel)}
              aria-hidden={!vis || undefined}
              tabIndex={vis ? 0 : -1}
              className={`group absolute inset-0 block overflow-hidden text-white transition-opacity duration-[1400ms] ease-[cubic-bezier(.4,0,.2,1)] focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white ${
                vis ? "pointer-events-auto z-[1] opacity-100" : "pointer-events-none opacity-0"
              }`}
            >
              {s.billede ? (
                <Image
                  src={s.billede}
                  alt=""
                  fill
                  sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 100vw"
                  unoptimized={!kanOptimeres(s.billede)}
                  loading={i === 0 ? "eager" : "lazy"}
                  fetchPriority={i === 0 ? "high" : undefined}
                  className={`object-cover transition-transform duration-[6000ms] ease-out ${vis ? "scale-[1.09]" : "scale-[1.02]"}`}
                />
              ) : (
                <span className="absolute inset-0 bg-groen" />
              )}
              <span className="absolute top-3 right-3 bg-black/60 px-2 py-1 text-[12.5px] font-semibold">{T.slutterOm(s.tid)}</span>
              <span
                className={`absolute inset-x-0 bottom-0 flex flex-col gap-[3px] bg-gradient-to-b from-transparent to-black/75 px-[18px] pt-11 pb-4 transition-[transform,opacity] delay-[450ms] duration-[900ms] ${
                  vis ? "translate-y-0 opacity-100" : "translate-y-[10px] opacity-0"
                }`}
              >
                <b className="text-[24px] leading-tight sm:text-[26px]">{s.pris}</b>
                <span className="line-clamp-2 text-sm text-[#EEE]">{s.titel}</span>
                <span className="text-[13px] text-white/75">{s.meta}</span>
              </span>
            </Link>
          );
        })}
      </div>

      {antal > 1 ? (
        <div className="flex justify-center gap-2 py-3">
          {slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => gaaTil(i)}
              aria-label={T.visAuktion(i + 1, antal)}
              aria-current={i === nr || undefined}
              // Klikfladen er 44 px høj; selve stregen er 4 px.
              className="group relative flex h-11 w-[26px] items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <span className="relative block h-1 w-full overflow-hidden bg-white/30">
                <span
                  key={i === nr ? `aktiv-${runde}` : "fast"}
                  className="absolute inset-0 origin-left bg-white"
                  style={
                    i === nr
                      ? rolig || antal < 2
                        ? { transform: "scaleX(1)" }
                        : {
                            animation: `ugens-fyld ${SKIFT_MS}ms linear forwards`,
                            animationPlayState: pause ? "paused" : "running",
                          }
                      : { transform: i < nr ? "scaleX(1)" : "scaleX(0)" }
                  }
                />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="h-3" />
      )}
    </section>
  );
}
