"use client";

// Del-knappen på auktionssiden (Filip, 27. okt. 2026 - punkt 4 i "Nye
// funktioner før lancering").
// - Mobil/tablet (berøringsskærm med navigator.share): systemets
//   delingsmenu åbnes direkte.
// - Ellers: en lille menu med Messenger, SMS, Facebook, e-mail og "Kopiér
//   link" (+ "Flere muligheder", hvis browseren har en delingsmenu).
// Linket er altid /auktion/<id> på det aktuelle domæne - aldrig
// window.location.href, som kan have parametre fra fx en betaling. Kun
// henvisningskoden fra "Henvis en ven" kan komme med (src/lib/del/delLink.ts).
import { useEffect, useId, useRef, useState } from "react";
import { auktionDelUrl, delMaal, delTekst } from "@/lib/del/delLink";
import { DEL_TEKST } from "@/lib/tekster/del";

const FACEBOOK_APP_ID = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID ?? null;

const punkt =
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] font-medium text-tekst hover:bg-groen-lys hover:text-groen-mork focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen";

async function kopier(tekst: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tekst);
      return true;
    }
  } catch {
    // Prøv reserveløsningen nedenfor.
  }
  try {
    const felt = document.createElement("textarea");
    felt.value = tekst;
    felt.setAttribute("readonly", "");
    felt.style.position = "fixed";
    felt.style.opacity = "0";
    document.body.appendChild(felt);
    felt.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(felt);
    return ok;
  } catch {
    return false;
  }
}

function erBeroering(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

function kanDele(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

function SvgIkon({ d, className = "h-5 w-5" }: { d: string[]; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

const IKON = {
  del: ["M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7", "M16 6l-4-4-4 4", "M12 2v14"],
  messenger: ["M3 20l1.3 -3.9a9 8 0 1 1 3.4 2.9l-4.7 1", "M8 13l3 -2l2 2l3 -2"],
  sms: ["M8 9h8", "M8 13h6", "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z"],
  facebook: ["M7 10v4h3v7h4v-7h3l1 -4h-4v-2a1 1 0 0 1 1 -1h3v-4h-3a5 5 0 0 0 -5 5v2h-3"],
  email: ["M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10z", "M3 7l9 6l9 -6"],
  link: ["M9 15l6 -6", "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464", "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463"],
  flere: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
};

export default function DelAuktion({
  auktionId,
  titel,
  henvisningskode = null,
}: {
  auktionId: string;
  titel: string;
  // Fra "Henvis en ven" (kun indlogget privat bruger) - se src/lib/del/henvisning.ts.
  henvisningskode?: string | null;
}) {
  const [aaben, setAaben] = useState(false);
  const [besked, setBesked] = useState<string | null>(null);
  const rodRef = useRef<HTMLDivElement>(null);
  const knapRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const beskedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (beskedTimer.current) clearTimeout(beskedTimer.current);
    };
  }, []);

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

  function link(): string | null {
    return auktionDelUrl(window.location.origin, auktionId, henvisningskode);
  }

  function visBesked(tekst: string) {
    setBesked(tekst);
    if (beskedTimer.current) clearTimeout(beskedTimer.current);
    beskedTimer.current = setTimeout(() => setBesked(null), 4000);
  }

  // true = systemets delingsmenu blev åbnet (eller lukket af brugeren).
  async function systemDeling(): Promise<boolean> {
    const url = link();
    if (!url || !kanDele()) return false;
    try {
      await navigator.share({ title: delTekst(titel), url });
      return true;
    } catch (err) {
      // AbortError: brugeren lukkede menuen - intet at gøre. Andre fejl
      // (fx NotAllowedError): vis vores egen menu i stedet.
      return err instanceof DOMException && err.name === "AbortError";
    }
  }

  async function klikDel() {
    if (aaben) {
      setAaben(false);
      return;
    }
    if (erBeroering() && (await systemDeling())) return;
    setAaben(true);
  }

  function aabnVindue(url: string) {
    window.open(url, "_blank", "noopener,noreferrer,width=640,height=560");
  }

  async function klikKopier() {
    const url = link();
    if (!url) return;
    const ok = await kopier(url);
    visBesked(ok ? DEL_TEKST.kopieret : DEL_TEKST.kopierFejl);
    setAaben(false);
    knapRef.current?.focus();
  }

  async function klikMessenger() {
    const url = link();
    if (!url) return;
    const maal = delMaal(url, titel, FACEBOOK_APP_ID);
    setAaben(false);
    if (erBeroering()) {
      window.location.href = maal.messengerApp;
      return;
    }
    if (maal.messengerWeb) {
      aabnVindue(maal.messengerWeb);
      return;
    }
    // Uden Facebook app-id findes der ingen delingsadresse til Messenger på
    // computeren: kopiér linket og åbn Messenger.
    const ok = await kopier(url);
    visBesked(ok ? DEL_TEKST.messengerKopieret : DEL_TEKST.kopierFejl);
    window.open("https://www.messenger.com/", "_blank", "noopener,noreferrer");
  }

  // Menuen vises kun efter et klik (altid i browseren), så window og
  // navigator kan bruges her uden at give forskel ved hydrering.
  const url = aaben ? link() : null;
  const maal = url ? delMaal(url, titel, FACEBOOK_APP_ID) : null;
  const harDelingsmenu = aaben && kanDele();

  return (
    <div ref={rodRef} className="relative">
      <button
        ref={knapRef}
        type="button"
        onClick={klikDel}
        aria-expanded={aaben}
        aria-controls={aaben ? menuId : undefined}
        aria-label={DEL_TEKST.knapLabel}
        className="flex h-11 items-center gap-2 rounded-full border border-kant-staerk bg-white pr-4 pl-3 text-[15px] font-semibold text-tekst transition-colors hover:border-groen hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        <SvgIkon d={IKON.del} />
        {DEL_TEKST.knap}
      </button>

      {aaben && maal && (
        <div
          id={menuId}
          className="absolute top-full right-0 z-50 mt-2 w-60 rounded-xl border border-kant bg-white p-2 shadow-flyder"
        >
          <ul aria-label={DEL_TEKST.menuLabel} className="flex flex-col">
            <li>
              <button type="button" onClick={klikMessenger} className={punkt}>
                <SvgIkon d={IKON.messenger} /> {DEL_TEKST.messenger}
              </button>
            </li>
            <li>
              <a href={maal.sms} onClick={() => setAaben(false)} className={punkt}>
                <SvgIkon d={IKON.sms} /> {DEL_TEKST.sms}
              </a>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  setAaben(false);
                  aabnVindue(maal.facebook);
                }}
                className={punkt}
              >
                <SvgIkon d={IKON.facebook} /> {DEL_TEKST.facebook}
              </button>
            </li>
            <li>
              <a href={maal.email} onClick={() => setAaben(false)} className={punkt}>
                <SvgIkon d={IKON.email} /> {DEL_TEKST.email}
              </a>
            </li>
            <li>
              <button type="button" onClick={klikKopier} className={punkt}>
                <SvgIkon d={IKON.link} /> {DEL_TEKST.kopier}
              </button>
            </li>
            {harDelingsmenu && (
              <li className="mt-1 border-t border-kant pt-1">
                <button
                  type="button"
                  onClick={async () => {
                    setAaben(false);
                    await systemDeling();
                  }}
                  className={punkt}
                >
                  <SvgIkon d={IKON.flere} /> {DEL_TEKST.flere}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}

      <span role="status" className="sr-only">
        {besked ?? ""}
      </span>
      {besked && (
        <span
          aria-hidden="true"
          className="absolute top-full right-0 z-40 mt-2 w-max max-w-64 rounded-lg bg-groen-mork px-3 py-2 text-[13px] font-medium text-white shadow-flyder"
        >
          {besked}
        </span>
      )}
    </div>
  );
}
