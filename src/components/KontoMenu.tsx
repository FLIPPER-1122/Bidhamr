"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { badgeTekst } from "@/lib/notifikationer/visning";
import { useUlaesteBeskeder } from "@/components/staffchat/useUlaesteBeskeder";

type Props = {
  logget_ind: boolean;
  erAdmin: boolean;
  // Ulæste beskeder fra BidHamr (fra serveren ved første visning).
  ulaesteBeskeder?: number;
};

const punkt =
  "flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[15px] font-medium text-tekst hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen";

export default function KontoMenu({ logget_ind, erAdmin, ulaesteBeskeder = 0 }: Props) {
  const antalBeskeder = useUlaesteBeskeder(ulaesteBeskeder, logget_ind);
  const beskederTekst =
    antalBeskeder === 1 ? "1 ulæst besked fra BidHamr" : `${antalBeskeder} ulæste beskeder fra BidHamr`;
  const [aaben, setAaben] = useState(false);
  const [loggerUd, setLoggerUd] = useState(false);
  const rodRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const router = useRouter();

  useEffect(() => {
    if (!aaben) return;
    function vedKlik(e: MouseEvent) {
      if (rodRef.current && !rodRef.current.contains(e.target as Node)) {
        setAaben(false);
      }
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

  const luk = () => setAaben(false);

  async function logUd() {
    setLoggerUd(true);
    await createClient().auth.signOut();
    setAaben(false);
    router.push("/login");
    router.refresh();
  }

  return (
    <div ref={rodRef} className="relative">
      <button
        ref={knapRef}
        type="button"
        aria-expanded={aaben}
        aria-controls={menuId}
        aria-label={
          logget_ind ? (antalBeskeder > 0 ? `Konto-menu, ${beskederTekst}` : "Konto-menu") : "Menu"
        }
        onClick={() => setAaben((v) => !v)}
        className="relative flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border-[1.5px] border-kant-staerk px-2.5 text-sm font-medium text-tekst hover:border-groen hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen lg:px-3.5"
      >
        {/* Burger på mobil */}
        <svg viewBox="0 0 24 24" className="h-5 w-5 lg:hidden" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        {/* Person-ikon + tekst på desktop */}
        <svg viewBox="0 0 24 24" className="hidden h-5 w-5 lg:block" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
        </svg>
        <span className="hidden lg:inline">{logget_ind ? "Min konto" : "Menu"}</span>
        <svg viewBox="0 0 24 24" className="hidden h-4 w-4 lg:block" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
        {logget_ind && antalBeskeder > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-fejl-fyldt px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-white"
          >
            {badgeTekst(antalBeskeder)}
          </span>
        )}
      </button>

      {aaben && (
        <div
          id={menuId}
          className="absolute right-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-kant bg-white p-2 shadow-[0_8px_30px_rgba(0,0,0,.13)]"
        >
          <nav aria-label="Konto">
            <ul className="flex flex-col">
              {/* Kun på mobil: det, topbaren viser på desktop */}
              <li className="lg:hidden">
                <Link href="/opret-auktion" onClick={luk} className={`${punkt} font-semibold`}>
                  Opret auktion
                </Link>
              </li>
              <li className="lg:hidden">
                <Link href="/auktioner" onClick={luk} className={punkt}>
                  Alle auktioner
                </Link>
              </li>

              {logget_ind ? (
                <>
                  <li><Link href="/konto" onClick={luk} className={punkt}>Min konto</Link></li>
                  <li><Link href="/konto/notifikationer" onClick={luk} className={punkt}>Notifikationsindstillinger</Link></li>
                  <li><Link href="/mine-handler" onClick={luk} className={punkt}>Mine handler</Link></li>
                  <li>
                    <Link
                      href="/beskeder"
                      onClick={luk}
                      className={`${punkt} justify-between gap-2`}
                      aria-label={antalBeskeder > 0 ? `Beskeder, ${beskederTekst}` : undefined}
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
                  <li><Link href="/profil/mig" onClick={luk} className={punkt}>Min profil</Link></li>
                  <li><Link href="/favoritter" onClick={luk} className={punkt}>Favoritter</Link></li>
                  {erAdmin && (
                    <li><Link href="/admin" onClick={luk} className={`${punkt} text-groen`}>Admin</Link></li>
                  )}
                  <li className="mt-1 border-t border-kant pt-1">
                    <button type="button" onClick={logUd} disabled={loggerUd} className={`${punkt} disabled:opacity-50`}>
                      {loggerUd ? "Logger ud…" : "Log ud"}
                    </button>
                  </li>
                </>
              ) : (
                <>
                  <li><Link href="/favoritter" onClick={luk} className={punkt}>Favoritter</Link></li>
                  <li><Link href="/login" onClick={luk} className={punkt}>Log ind</Link></li>
                </>
              )}
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}
