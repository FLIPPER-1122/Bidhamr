"use client";

// Den lille flydende "Meld fejl"-knap (kun beta-testere og staff før
// lancering - se src/components/betafejl/BetaFejlKnap.tsx).
//
// Holdt så let som muligt: formularen (BetaFejlFormular) og Supabase-klienten
// hentes først, når man trykker på knappen. Intet databasekald før det.
//
// Knappen ligger nederst til venstre (BidHamr-botten har højre hjørne, som i
// appen).
//
// Mobil: knappen er 44 px høj og ligger over de faste bjælker nederst (fx
// "Byd"-bjælken på en auktion), og den kan minimeres til en lille fane i
// højre kant midt på skærmen. Valget huskes i localStorage.
import dynamic from "next/dynamic";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";

const BetaFejlFormular = dynamic(() => import("./BetaFejlFormular"), { ssr: false });

const MINI_NOEGLE = "bidhamr-beta-fejl-mini";
const lyttere = new Set<() => void>();

function laesMini(): boolean {
  try {
    return window.localStorage.getItem(MINI_NOEGLE) === "1";
  } catch {
    return false;
  }
}

function gemMini(mini: boolean) {
  try {
    window.localStorage.setItem(MINI_NOEGLE, mini ? "1" : "0");
  } catch {
    // Valget huskes så bare ikke.
  }
  lyttere.forEach((l) => l());
}

function lyt(l: () => void) {
  lyttere.add(l);
  window.addEventListener("storage", l);
  return () => {
    lyttere.delete(l);
    window.removeEventListener("storage", l);
  };
}

function FejlIkon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 9v-1a3 3 0 0 1 6 0v1" />
      <path d="M8 9h8a6 6 0 0 1 1 3v3a5 5 0 0 1 -10 0v-3a6 6 0 0 1 1 -3" />
      <path d="M3 13l4 0" />
      <path d="M17 13l4 0" />
      <path d="M12 20l0 -6" />
      <path d="M4 19l3.35 -2" />
      <path d="M20 19l-3.35 -2" />
      <path d="M4 7l3.75 2.4" />
      <path d="M20 7l-3.75 2.4" />
    </svg>
  );
}

export default function BetaFejlStarter({ brugerId }: { brugerId: string }) {
  const mini = useSyncExternalStore(lyt, laesMini, () => false);
  const [aaben, setAaben] = useState(false);
  const knapRef = useRef<HTMLButtonElement>(null);
  const miniRef = useRef<HTMLButtonElement>(null);

  const luk = useCallback(() => {
    setAaben(false);
    // Fokus tilbage til knappen, der åbnede formularen.
    requestAnimationFrame(() => knapRef.current?.focus());
  }, []);

  return (
    <>
      {mini ? (
        <button
          ref={miniRef}
          type="button"
          onClick={() => {
            gemMini(false);
            requestAnimationFrame(() => knapRef.current?.focus());
          }}
          aria-label="Vis knappen Meld fejl"
          title="Meld fejl"
          className="fixed right-0 top-1/2 z-30 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-l-xl bg-groen text-white shadow-[var(--shadow-flyder)] transition-colors hover:bg-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen print:hidden"
        >
          <FejlIkon className="h-5 w-5" />
        </button>
      ) : (
        !aaben && (
          <div
            className="fixed left-3 z-30 flex items-center overflow-hidden rounded-none bg-groen text-white shadow-[var(--shadow-flyder)] bottom-[calc(var(--samtykke-hoejde,0px)+env(safe-area-inset-bottom,0px)+88px)] lg:left-6 lg:bottom-[calc(var(--samtykke-hoejde,0px)+24px)] print:hidden"
          >
            <button
              ref={knapRef}
              type="button"
              onClick={() => setAaben(true)}
              aria-haspopup="dialog"
              className="inline-flex h-11 items-center gap-2 pl-4 pr-3 text-sm font-semibold transition-colors hover:bg-groen-mork focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
            >
              <FejlIkon className="h-5 w-5" />
              Meld fejl
            </button>
            <span aria-hidden="true" className="h-6 w-px bg-white/30" />
            <button
              type="button"
              onClick={() => {
                gemMini(true);
                requestAnimationFrame(() => miniRef.current?.focus());
              }}
              aria-label="Minimér knappen Meld fejl"
              title="Minimér"
              className="inline-flex h-11 w-11 items-center justify-center transition-colors hover:bg-groen-mork focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
                <path d="M9 6l6 6l-6 6" />
              </svg>
            </button>
          </div>
        )
      )}
      {aaben && <BetaFejlFormular brugerId={brugerId} onLuk={luk} />}
    </>
  );
}
