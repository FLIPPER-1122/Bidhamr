"use client";

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { soegLogBruger, type LogBrugerTraef } from "@/app/actions/adminLog";

// Brugerfilteret i handlingsloggen. Søgefeltet har intet name, så teksten
// (fx en e-mail) aldrig kommer med i GET-formularen og dermed aldrig i
// adresselinjen. Kun det valgte id sendes som ?bruger=<id>. Et valg
// filtrerer med det samme (færrest klik).
export default function LogBrugerVaelger({
  valgt,
  feltKlasse,
}: {
  valgt: { id: string; navn: string } | null;
  feltKlasse: string;
}) {
  const [bruger, setBruger] = useState(valgt);
  const [tekst, setTekst] = useState("");
  const [traef, setTraef] = useState<LogBrugerTraef[]>([]);
  const [aaben, setAaben] = useState(false);
  const [aktiv, setAktiv] = useState(-1);
  const [soeger, setSoeger] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const skjultRef = useRef<HTMLInputElement>(null);
  const nr = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listeId = useId();
  const feltId = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  function skrevet(vaerdi: string) {
    setTekst(vaerdi);
    setAaben(true);
    clearTimeout(timer.current);
    const q = vaerdi.trim();
    const mit = ++nr.current;
    if (q.length < 2) {
      setTraef([]);
      setSoeger(false);
      setFejl(null);
      return;
    }
    setSoeger(true);
    timer.current = setTimeout(async () => {
      const svar = await soegLogBruger(q).catch(() => ({ fejl: "Søgningen virker ikke lige nu. Prøv igen om lidt." }));
      if (mit !== nr.current) return;
      setSoeger(false);
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        setTraef([]);
      } else {
        setFejl(null);
        setTraef(svar.traef);
        setAktiv(svar.traef.length ? 0 : -1);
      }
    }, 250);
  }

  // flushSync: den skjulte værdi skal stå i DOM'en, før formularen sendes.
  function vaelg(t: LogBrugerTraef) {
    flushSync(() => {
      setBruger({ id: t.id, navn: t.navn });
      setTekst("");
      setTraef([]);
      setAaben(false);
    });
    skjultRef.current?.form?.requestSubmit();
  }

  function fjern() {
    flushSync(() => setBruger(null));
    skjultRef.current?.form?.requestSubmit();
  }

  return (
    <div className="text-xs font-medium text-tekst-daempet">
      {bruger ? <span>Bruger</span> : <label htmlFor={feltId}>Bruger</label>}
      {/* Uden valgt bruger er feltet slået fra, så der ikke står "bruger=" i URL'en. */}
      <input ref={skjultRef} type="hidden" name="bruger" value={bruger?.id ?? ""} disabled={!bruger} />
      {bruger ? (
        <p className="mt-1 flex min-h-10 items-center justify-between gap-2 rounded-lg border border-admin-kant bg-neutral-50 px-3 py-2 text-sm font-normal text-tekst">
          <span className="truncate">
            {bruger.navn}
          </span>
          <button type="button" onClick={fjern} className="shrink-0 text-xs font-medium text-groen hover:underline">
            Fjern
          </button>
        </p>
      ) : (
        <div className="relative mt-1">
          <input
            id={feltId}
            type="search"
            role="combobox"
            aria-expanded={aaben && tekst.trim().length >= 2}
            aria-controls={listeId}
            aria-autocomplete="list"
            aria-activedescendant={aktiv >= 0 && traef[aktiv] ? `${listeId}-${aktiv}` : undefined}
            autoComplete="off"
            maxLength={120}
            placeholder="Søg navn, e-mail eller telefon"
            value={tekst}
            onChange={(e) => skrevet(e.target.value)}
            onFocus={() => setAaben(true)}
            onBlur={() => setTimeout(() => setAaben(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && traef.length) {
                e.preventDefault();
                setAaben(true);
                setAktiv((a) => (a + 1) % traef.length);
              } else if (e.key === "ArrowUp" && traef.length) {
                e.preventDefault();
                setAktiv((a) => (a <= 0 ? traef.length - 1 : a - 1));
              } else if (e.key === "Enter") {
                // Enter i søgefeltet må aldrig sende formularen med teksten.
                e.preventDefault();
                if (aktiv >= 0 && traef[aktiv]) vaelg(traef[aktiv]);
              } else if (e.key === "Escape") {
                setAaben(false);
              }
            }}
            className={`${feltKlasse} font-normal`}
          />
          {aaben && tekst.trim().length >= 2 && (
            <ul
              id={listeId}
              role="listbox"
              className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-admin-kant bg-white py-1 shadow-lg"
            >
              {soeger && traef.length === 0 && <li className="px-3 py-2 text-sm font-normal text-tekst-svag">Søger…</li>}
              {!soeger && fejl && (
                <li role="alert" className="px-3 py-2 text-sm font-normal text-fejl-tekst">
                  {fejl}
                </li>
              )}
              {!soeger && !fejl && traef.length === 0 && (
                <li className="px-3 py-2 text-sm font-normal text-tekst-svag">Ingen brugere fundet.</li>
              )}
              {traef.map((t, i) => (
                <li
                  key={t.id}
                  id={`${listeId}-${i}`}
                  role="option"
                  aria-selected={i === aktiv}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    vaelg(t);
                  }}
                  onMouseEnter={() => setAktiv(i)}
                  className={`cursor-pointer px-3 py-2 ${i === aktiv ? "bg-groen-lys" : ""}`}
                >
                  <span className="block truncate text-sm font-medium text-tekst">{t.navn}</span>
                  {t.under && <span className="block truncate text-xs font-normal text-tekst-svag">{t.under}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
