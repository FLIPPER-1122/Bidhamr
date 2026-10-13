"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Kvittering efter en handling i admin (fx "Sagen er afgjort"). Står ÉN gang
// i admin/layout.tsx, så den virker på alle sider. Handlingerne kalder
// visKvittering(); beskeden læses op via aria-live. Kortet, handlingen
// gjaldt, forsvinder ofte fra listen, når siden opdateres - så flyttes fokus
// hertil, i stedet for at det forsvinder ud i ingenting.
//
// Hed tidligere "Statuslinje". Det navn bruges nu om den grøn/gul/røde
// linje øverst på forsiden.

const HAENDELSE = "bidhamr:admin-kvittering";

type Besked = { tekst: string; link?: { href: string; label: string }; fejl?: boolean };

export function visKvittering(tekst: string, opts: { link?: { href: string; label: string }; fejl?: boolean } = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Besked>(HAENDELSE, { detail: { tekst, ...opts } }));
}

export default function Kvittering() {
  const [besked, setBesked] = useState<(Besked & { n: number }) | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function modtag(e: Event) {
      const d = (e as CustomEvent<Besked | string>).detail;
      const b: Besked | null = typeof d === "string" ? { tekst: d } : d && typeof d.tekst === "string" ? d : null;
      if (b && b.tekst) setBesked((gl) => ({ ...b, n: (gl?.n ?? 0) + 1 }));
    }
    window.addEventListener(HAENDELSE, modtag);
    return () => window.removeEventListener(HAENDELSE, modtag);
  }, []);

  useEffect(() => {
    if (!besked) return;
    // Siden opdateres efter handlingen; er knappen, der havde fokus, væk,
    // flyttes fokus til kvitteringen. Opdateringen kan tage lidt tid, så der
    // holdes øje i op til 4 sekunder.
    let gange = 0;
    const t1 = window.setInterval(() => {
      const aktiv = document.activeElement;
      if (!aktiv || aktiv === document.body || !aktiv.isConnected) {
        ref.current?.focus();
        window.clearInterval(t1);
      } else if (++gange >= 20) {
        window.clearInterval(t1);
      }
    }, 200);
    const t2 = window.setTimeout(() => setBesked(null), besked.link ? 12000 : 8000);
    return () => {
      window.clearInterval(t1);
      window.clearTimeout(t2);
    };
  }, [besked]);

  const fejl = besked?.fejl === true;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed inset-x-4 z-40 flex justify-center outline-none sm:inset-x-auto sm:right-6"
      style={{ bottom: "calc(var(--samtykke-hoejde, 0px) + 1rem)" }}
    >
      {besked && (
        <p
          key={besked.n}
          className={`pointer-events-auto flex max-w-md flex-wrap items-start gap-x-3 gap-y-1 rounded-xl border-2 px-4 py-3 text-sm font-medium shadow-flyder ${
            fejl ? "border-fejl-kant bg-fejl-bg text-fejl-tekst" : "border-succes-kant bg-succes-bg text-succes-tekst"
          }`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.25}>
            {fejl ? (
              <path d="M12 8v5m0 3h.01M12 3a9 9 0 100 18 9 9 0 000-18z" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
          <span className="min-w-0 flex-1">{besked.tekst}</span>
          {besked.link && (
            <Link href={besked.link.href} onClick={() => setBesked(null)} className="font-semibold underline">
              {besked.link.label}
            </Link>
          )}
          <button
            type="button"
            onClick={() => setBesked(null)}
            className="-my-1 -mr-2 ml-1 rounded-md px-2 py-1 text-xs font-semibold hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-groen"
          >
            Luk
          </button>
        </p>
      )}
    </div>
  );
}
