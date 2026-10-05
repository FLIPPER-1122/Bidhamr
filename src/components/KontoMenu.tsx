"use client";

// Profil-menuen i topbaren på store skærme (kun for indloggede).
// På mobil ligger de samme links i MobilMenu.
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import Ikon from "@/components/Ikon";
import { badgeTekst } from "@/lib/notifikationer/visning";
import { beskederTekst, useAntalUlaesteBeskeder } from "@/components/topbar/UlaesteBeskeder";
import { useLogUd } from "@/components/topbar/useLogUd";

const punkt =
  "flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[15px] font-medium text-tekst hover:bg-groen-lys hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen";

export default function KontoMenu({ erAdmin }: { erAdmin: boolean }) {
  const antalBeskeder = useAntalUlaesteBeskeder();
  const [aaben, setAaben] = useState(false);
  const rodRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const luk = () => setAaben(false);
  const { logUd, loggerUd } = useLogUd(luk);

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

  return (
    <div ref={rodRef} className="relative">
      <button
        ref={knapRef}
        type="button"
        aria-expanded={aaben}
        aria-controls={menuId}
        aria-label={antalBeskeder > 0 ? `Min konto, ${beskederTekst(antalBeskeder)}` : "Min konto"}
        onClick={() => setAaben((v) => !v)}
        className="relative flex h-11 items-center gap-1.5 rounded-full border-[1.5px] border-kant-staerk pr-2.5 pl-1.5 text-sm font-medium text-tekst hover:border-groen hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <span className="grid h-8 w-8 place-items-center rounded-full bg-groen-lys text-groen-mork">
          <Ikon navn="bruger" className="h-[18px] w-[18px]" />
        </span>
        <Ikon navn="ned" className={`h-4 w-4 transition-transform ${aaben ? "rotate-180" : ""}`} />
      </button>

      {aaben && (
        <div
          id={menuId}
          className="absolute top-full right-0 z-50 mt-2 w-64 rounded-xl border border-kant bg-white p-2 shadow-flyder"
        >
          <nav aria-label="Konto">
            <ul className="flex flex-col">
              <li><Link href="/profil/mig" onClick={luk} className={punkt}>Min profil</Link></li>
              <li><Link href="/mine-handler" onClick={luk} className={punkt}>Mine handler</Link></li>
              <li>
                <Link
                  href="/beskeder"
                  onClick={luk}
                  className={`${punkt} justify-between gap-2`}
                  aria-label={antalBeskeder > 0 ? `Beskeder, ${beskederTekst(antalBeskeder)}` : undefined}
                >
                  Beskeder
                  {antalBeskeder > 0 && (
                    <span
                      aria-hidden="true"
                      className="flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-fejl-fyldt px-1.5 text-[12px] leading-none font-semibold text-white"
                    >
                      {badgeTekst(antalBeskeder)}
                    </span>
                  )}
                </Link>
              </li>
              <li><Link href="/favoritter" onClick={luk} className={punkt}>Favoritter</Link></li>
              <li><Link href="/konto" onClick={luk} className={punkt}>Min konto</Link></li>
              <li><Link href="/konto/notifikationer" onClick={luk} className={punkt}>Notifikationsindstillinger</Link></li>
              {erAdmin && (
                <li><Link href="/admin" onClick={luk} className={`${punkt} text-groen`}>Admin</Link></li>
              )}
              <li className="mt-1 border-t border-kant pt-1">
                <button
                  type="button"
                  onClick={logUd}
                  disabled={loggerUd}
                  aria-busy={loggerUd}
                  className={`${punkt} gap-2 disabled:cursor-not-allowed disabled:text-tekst-svag`}
                >
                  {loggerUd && <span className="btn-spinner" aria-hidden="true" />}
                  Log ud
                </button>
              </li>
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}
