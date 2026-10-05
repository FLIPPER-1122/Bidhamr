"use client";

// "Alle kategorier" i kategorilinjen (kun store skærme). Lukker ved Escape,
// klik udenfor og når man vælger et link.
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import Ikon, { KATEGORI_IKON } from "@/components/Ikon";
import { kategorier } from "@/lib/kategorier";
import { kategoriHref } from "@/components/topbar/navigation";

export default function KategoriMenu() {
  const [aaben, setAaben] = useState(false);
  const rodRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

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
    function vedFokus(e: FocusEvent) {
      if (rodRef.current && !rodRef.current.contains(e.target as Node)) setAaben(false);
    }
    document.addEventListener("mousedown", vedKlik);
    document.addEventListener("keydown", vedTast);
    document.addEventListener("focusin", vedFokus);
    return () => {
      document.removeEventListener("mousedown", vedKlik);
      document.removeEventListener("keydown", vedTast);
      document.removeEventListener("focusin", vedFokus);
    };
  }, [aaben]);

  const luk = () => setAaben(false);

  return (
    <div ref={rodRef} className="relative">
      <button
        ref={knapRef}
        type="button"
        aria-expanded={aaben}
        aria-controls={panelId}
        onClick={() => setAaben((v) => !v)}
        className="flex min-h-11 items-center gap-1.5 rounded-lg font-medium text-tekst hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <Ikon navn="kategorier" className="h-[18px] w-[18px]" />
        Alle kategorier
        <Ikon navn="ned" className={`h-4 w-4 transition-transform ${aaben ? "rotate-180" : ""}`} />
      </button>

      {aaben && (
        <div
          id={panelId}
          className="absolute top-full left-0 z-50 mt-1 w-[440px] rounded-[14px] border border-kant bg-white p-3 shadow-flyder"
        >
          <ul className="grid grid-cols-2 gap-1">
            {kategorier.map((k) => (
              <li key={k}>
                <Link
                  href={kategoriHref(k)}
                  onClick={luk}
                  className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-[15px] font-medium text-tekst hover:bg-groen-lys hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-groen-lys text-groen-mork">
                    <Ikon navn={KATEGORI_IKON[k] ?? "andet"} className="h-[18px] w-[18px]" />
                  </span>
                  {k}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-kant pt-2">
            <Link
              href="/auktioner"
              onClick={luk}
              className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen"
            >
              Se alle auktioner
              <Ikon navn="hoejre" className="h-4 w-4" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
