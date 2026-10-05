"use client";

// Burger-menu og skuffe på mobil og tablet (under lg).
// Bygget på <dialog> med showModal(): browseren fanger fokus i skuffen, gør
// resten af siden inert, lukker på Escape og giver fokus tilbage til knappen.
// Lukket er skuffen display:none og dermed helt ude af tab-rækkefølgen.
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Ikon, { KATEGORI_IKON } from "@/components/Ikon";
import { badgeTekst } from "@/lib/notifikationer/visning";
import { kategorier } from "@/lib/kategorier";
import { HJAELP, UDFORSK, kategoriHref } from "@/components/topbar/navigation";
import { beskederTekst, useAntalUlaesteBeskeder } from "@/components/topbar/UlaesteBeskeder";
import { useLogUd } from "@/components/topbar/useLogUd";

const punkt =
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] font-medium text-tekst hover:bg-groen-lys hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen";
const overskrift = "px-3 pb-1 font-sans text-xs font-semibold tracking-wide text-tekst-svag uppercase";

export default function MobilMenu({
  loggetInd,
  erAdmin,
}: {
  loggetInd: boolean;
  erAdmin: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lukRef = useRef<HTMLButtonElement>(null);
  const [aaben, setAaben] = useState(false);
  const antalBeskeder = useAntalUlaesteBeskeder();
  const luk = () => dialogRef.current?.close();
  const { logUd, loggerUd } = useLogUd(luk);

  function aabn() {
    dialogRef.current?.showModal();
    lukRef.current?.focus();
    setAaben(true);
  }

  // Siden bag skuffen må ikke rulle, mens den er åben.
  useEffect(() => {
    if (!aaben) return;
    const html = document.documentElement;
    const før = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = før;
    };
  }, [aaben]);

  // Store skærme har ikke burgeren; luk skuffen, hvis vinduet bliver bredt.
  useEffect(() => {
    if (!aaben) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const vedSkift = () => mq.matches && dialogRef.current?.close();
    mq.addEventListener("change", vedSkift);
    return () => mq.removeEventListener("change", vedSkift);
  }, [aaben]);

  // Klik på et link i skuffen lukker den (navigationen sker stadig).
  function vedKlik(e: React.MouseEvent<HTMLDialogElement>) {
    const mål = e.target as HTMLElement;
    // Klik på baggrunden uden for panelet rammer selve <dialog>.
    if (mål === dialogRef.current || mål.closest("a")) luk();
  }

  return (
    <>
      <button
        type="button"
        onClick={aabn}
        aria-haspopup="dialog"
        aria-expanded={aaben}
        aria-label={
          loggetInd && antalBeskeder > 0 ? `Menu, ${beskederTekst(antalBeskeder)}` : "Menu"
        }
        className="relative flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-kant-staerk text-tekst hover:border-groen hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <Ikon navn="menu" />
        {loggetInd && antalBeskeder > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-fejl-fyldt px-1 text-[11px] leading-none font-semibold text-white ring-2 ring-white"
          >
            {badgeTekst(antalBeskeder)}
          </span>
        )}
      </button>

      <dialog
        ref={dialogRef}
        aria-label="Menu"
        onClose={() => setAaben(false)}
        onClick={vedKlik}
        className="m-0 ml-auto h-dvh max-h-none w-[min(22rem,100vw)] max-w-none overflow-hidden bg-transparent p-0 backdrop:bg-black/40"
      >
        <div className="flex h-full flex-col bg-white shadow-stor">
          <div className="flex items-center justify-between gap-3 border-b border-kant px-4 py-3">
            <Link
              href="/"
              aria-label="BidHamr - til forsiden"
              className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              <Image src="/brand/bidhamr-logo.svg" alt="" width={230} height={60} unoptimized className="h-8 w-auto" />
            </Link>
            <button
              type="button"
              ref={lukRef}
              onClick={luk}
              aria-label="Luk menu"
              className="flex h-11 w-11 items-center justify-center rounded-full text-tekst hover:bg-groen-lys hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              <Ikon navn="luk" />
            </button>
          </div>

          <nav aria-label="Hovedmenu" className="flex-1 overflow-y-auto overscroll-contain px-2 py-4">
            <div className="px-2">
              <Link href="/opret-auktion" className="btn btn-primaer btn-stor w-full">
                <Ikon navn="plus" />
                Sælg en vare
              </Link>
            </div>

            {loggetInd && (
              <section className="mt-6" aria-labelledby="mobil-mig">
                <h2 id="mobil-mig" className={`${overskrift}`}>Min side</h2>
                <ul>
                  <li><Link href="/mine-handler" className={punkt}><Ikon navn="handler" />Mine handler</Link></li>
                  <li>
                    <Link
                      href="/beskeder"
                      className={`${punkt} justify-between`}
                      aria-label={antalBeskeder > 0 ? `Beskeder, ${beskederTekst(antalBeskeder)}` : undefined}
                    >
                      <span className="flex items-center gap-3"><Ikon navn="besked" />Beskeder</span>
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
                  <li><Link href="/favoritter" className={punkt}><Ikon navn="hjerte" />Favoritter</Link></li>
                  <li><Link href="/profil/mig" className={punkt}><Ikon navn="bruger" />Min profil</Link></li>
                  <li><Link href="/konto" className={`${punkt} pl-12`}>Min konto</Link></li>
                  <li><Link href="/konto/notifikationer" className={`${punkt} pl-12`}>Notifikationsindstillinger</Link></li>
                  {erAdmin && (
                    <li><Link href="/admin" className={`${punkt} pl-12 text-groen`}>Admin</Link></li>
                  )}
                </ul>
              </section>
            )}

            <section className="mt-6" aria-labelledby="mobil-udforsk">
              <h2 id="mobil-udforsk" className={`${overskrift}`}>Udforsk</h2>
              <ul>
                {UDFORSK.map((l) => (
                  <li key={l.href}><Link href={l.href} className={punkt}>{l.tekst}</Link></li>
                ))}
              </ul>
            </section>

            <section className="mt-6" aria-labelledby="mobil-kategorier">
              <h2 id="mobil-kategorier" className={`${overskrift}`}>Kategorier</h2>
              <ul className="grid grid-cols-2 gap-x-1">
                {kategorier.map((k) => (
                  <li key={k}>
                    <Link href={kategoriHref(k)} className={`${punkt} gap-2.5 px-2`}>
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-groen-lys text-groen-mork">
                        <Ikon navn={KATEGORI_IKON[k] ?? "andet"} className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0 truncate">{k}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-6" aria-labelledby="mobil-hjaelp">
              <h2 id="mobil-hjaelp" className={`${overskrift}`}>Hjælp</h2>
              <ul>
                {HJAELP.map((l) => (
                  <li key={l.href}><Link href={l.href} className={punkt}>{l.tekst}</Link></li>
                ))}
              </ul>
            </section>
          </nav>

          <div className="border-t border-kant p-4">
            {loggetInd ? (
              <button
                type="button"
                onClick={logUd}
                disabled={loggerUd}
                aria-busy={loggerUd}
                className="btn btn-sekundaer w-full"
              >
                {loggerUd && <span className="btn-spinner" aria-hidden="true" />}
                Log ud
              </button>
            ) : (
              <div className="flex gap-2">
                <Link href="/login" className="btn btn-sekundaer flex-1">Log ind</Link>
                <Link href="/signup" className="btn btn-sekundaer flex-1">Opret konto</Link>
              </div>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
