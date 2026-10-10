"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { accepterVilkaar } from "@/app/actions/vilkaar";
import { useLogUd } from "@/components/topbar/useLogUd";
import {
  erCookieBannerAabent,
  laesGyldigSamtykkeRaa,
  lytTilCookieBanner,
  lytTilSamtykke,
} from "@/lib/samtykkeKlient";
import { VILKAAR_TEKST as T } from "@/lib/tekster/vilkaar";
import {
  BETINGELSER_STI,
  PRIVATLIV_STI,
  VILKAAR_DATO,
  VILKAAR_ER_UDKAST,
  VILKAAR_VERSION,
} from "@/lib/vilkaar";

// Sider, hvor vinduet aldrig vises: de to jura-sider (man skal kunne læse
// dem), login/konto-forløb og venteliste. /admin og /coming-soon ligger uden
// for (app)-layoutet, men står her for en sikkerheds skyld.
const UNDTAGNE_STIER = [
  BETINGELSER_STI,
  PRIVATLIV_STI,
  "/login",
  "/signup",
  "/bekraeft",
  "/reset-password",
  "/glemt-adgangskode",
  "/nulstil-adgangskode",
  "/tjek-indbakke",
  "/konto-slettet",
  "/coming-soon",
  "/admin",
];

function erUndtaget(sti: string | null) {
  if (!sti) return false;
  return UNDTAGNE_STIER.some((u) => sti === u || sti.startsWith(`${u}/`));
}

const LINK =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md font-semibold text-groen underline underline-offset-2 hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

function NyFaneIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

// Blokerende vindue (native <dialog> med showModal: resten af siden er inert,
// og vinduet ligger øverst). Vises først, når cookie-banneret er besvaret og
// væk. Escape lukker ikke. Kun "Jeg accepterer" og "Log ud" fører videre;
// betingelser og privatlivspolitik åbnes i en ny fane.
export default function VilkaarDialog({ nyVersion }: { nyVersion: boolean }) {
  const router = useRouter();
  const sti = usePathname();
  const id = useId();
  const harCookievalg = useSyncExternalStore(
    lytTilSamtykke,
    () => laesGyldigSamtykkeRaa() !== "",
    () => false,
  );
  const bannerAabent = useSyncExternalStore(lytTilCookieBanner, erCookieBannerAabent, () => true);
  const [accepteret, setAccepteret] = useState(false);
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [besked, setBesked] = useState("");
  const { logUd, loggerUd, fejl: logUdFejl } = useLogUd();

  const vis = !accepteret && harCookievalg && !bannerAabent && !erUndtaget(sti);

  async function accepter() {
    setSender(true);
    setFejl(null);
    let svar: Awaited<ReturnType<typeof accepterVilkaar>>;
    try {
      svar = await accepterVilkaar(VILKAAR_VERSION);
    } catch (err) {
      console.error("accepterVilkaar fejlede:", err);
      setFejl(T.netvaerksfejl);
      setSender(false);
      return;
    }
    setSender(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    setAccepteret(true);
    setBesked(T.gemt);
    // Fokus til sidens indhold, så den ikke ender på <body>.
    const maal =
      document.getElementById("indhold") ?? document.querySelector<HTMLElement>("main[tabindex]");
    maal?.focus({ preventScroll: true });
    router.refresh();
  }

  return (
    <>
      <p role="status" className="sr-only">
        {besked}
      </p>
      {vis && (
        <Vindue
          id={id}
          nyVersion={nyVersion}
          fejl={fejl ?? logUdFejl}
          sender={sender}
          loggerUd={loggerUd}
          onAccepter={accepter}
          onLogUd={logUd}
        />
      )}
    </>
  );
}

function Vindue({
  id,
  nyVersion,
  fejl,
  sender,
  loggerUd,
  onAccepter,
  onLogUd,
}: {
  id: string;
  nyVersion: boolean;
  fejl: string | null;
  sender: boolean;
  loggerUd: boolean;
  onAccepter: () => void;
  onLogUd: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const overskriftRef = useRef<HTMLHeadingElement>(null);
  const lukkerSelv = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    lukkerSelv.current = false;
    if (!dialog.open) dialog.showModal();
    overskriftRef.current?.focus();
    // Baggrunden må ikke kunne scrolles bag vinduet.
    const rod = document.documentElement;
    const forrige = rod.style.overflow;
    rod.style.overflow = "hidden";
    return () => {
      lukkerSelv.current = true;
      rod.style.overflow = forrige;
      if (dialog.open) dialog.close();
    };
  }, []);

  // Fokus bliver inde i vinduet (Tab og Shift+Tab går rundt).
  function onKeyDown(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== "Tab") return;
    const fokuserbare = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    );
    if (fokuserbare.length === 0) return;
    const foerste = fokuserbare[0];
    const sidste = fokuserbare[fokuserbare.length - 1];
    const aktiv = document.activeElement;
    if (e.shiftKey && (aktiv === foerste || aktiv === overskriftRef.current)) {
      e.preventDefault();
      sidste.focus();
    } else if (!e.shiftKey && aktiv === sidste) {
      e.preventDefault();
      foerste.focus();
    }
  }

  const travl = sender || loggerUd;

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={`${id}-titel`}
      aria-describedby={`${id}-tekst`}
      // Escape lukker ikke vinduet.
      onCancel={(e) => e.preventDefault()}
      // Lukker browseren det alligevel (fx Escape to gange i Chrome), åbnes
      // det igen med det samme.
      onClose={(e) => {
        const dialog = e.currentTarget;
        if (!lukkerSelv.current && dialog.isConnected && !dialog.open) {
          dialog.showModal();
          overskriftRef.current?.focus();
        }
      }}
      onKeyDown={onKeyDown}
      className="m-auto max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[520px] overflow-y-auto rounded-[18px] border-0 bg-white p-5 text-tekst shadow-stor backdrop:bg-black/55 sm:p-7"
    >
      {VILKAAR_ER_UDKAST && (
        <p className="mb-3 inline-flex items-center rounded-full border border-advarsel-kant bg-advarsel-bg px-2.5 py-0.5 text-xs font-semibold tracking-wide text-advarsel-tekst uppercase">
          {T.udkast}
          <span className="sr-only">: {T.udkastForklaring}</span>
        </p>
      )}
      <h2
        id={`${id}-titel`}
        ref={overskriftRef}
        tabIndex={-1}
        className="text-[22px] leading-tight text-groen-mork outline-none sm:text-[26px]"
      >
        {nyVersion ? T.overskriftNy : T.overskriftFoerste}
      </h2>
      <p id={`${id}-tekst`} className="mt-3 text-[15px] leading-relaxed text-tekst-daempet">
        {nyVersion ? T.tekstNy : T.tekstFoerste}
      </p>
      <p className="mt-2 text-sm text-tekst-svag">{T.version(VILKAAR_VERSION, VILKAAR_DATO)}</p>

      <ul className="mt-3 flex flex-col">
        <li>
          <a href={BETINGELSER_STI} target="_blank" rel="noopener" className={LINK}>
            {T.laesBetingelser}
            <NyFaneIkon />
            <span className="sr-only">{T.nytVindue}</span>
          </a>
        </li>
        <li>
          <a href={PRIVATLIV_STI} target="_blank" rel="noopener" className={LINK}>
            {T.laesPrivatliv}
            <NyFaneIkon />
            <span className="sr-only">{T.nytVindue}</span>
          </a>
        </li>
      </ul>

      {fejl && (
        <p role="alert" className="mt-4 rounded-xl border border-fejl-kant bg-fejl-bg p-3 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onAccepter}
          disabled={travl}
          aria-busy={sender || undefined}
          className="btn btn-primaer btn-stor w-full sm:w-auto"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          {sender ? T.gemmer : T.accepter}
        </button>
        <button
          type="button"
          onClick={onLogUd}
          disabled={travl}
          aria-busy={loggerUd || undefined}
          className="btn w-full text-groen underline-offset-2 hover:underline disabled:text-tekst-svag sm:w-auto sm:px-2"
        >
          {loggerUd ? T.loggerUd : T.logUd}
        </button>
      </div>
    </dialog>
  );
}
