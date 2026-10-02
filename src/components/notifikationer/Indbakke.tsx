"use client";

import Link from "next/link";
import { useState } from "react";
import {
  hentNotifikationer,
  markerAlleLaest,
  type Notifikation,
} from "@/app/actions/notifikationer";
import NotifikationPunkt from "@/components/notifikationer/NotifikationPunkt";
import { SIDE_STOERRELSE, meldNotifikationerOpdateret } from "@/lib/notifikationer/visning";

export default function Indbakke({
  start,
  flereStart,
}: {
  start: Notifikation[];
  flereStart: boolean;
}) {
  const [liste, setListe] = useState(start);
  const [flere, setFlere] = useState(flereStart);
  const [henter, setHenter] = useState(false);
  const [markerer, setMarkerer] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  const harUlaeste = liste.some((n) => !n.laest_kl);

  function vedLaest(id: string) {
    setListe((l) => l.map((n) => (n.id === id ? { ...n, laest_kl: new Date().toISOString() } : n)));
  }

  async function visFlere() {
    const sidste = liste[liste.length - 1];
    if (!sidste) return;
    setHenter(true);
    setFejl(null);
    // Én ekstra, så vi ved, om der er flere at hente.
    const svar = await hentNotifikationer({ antal: SIDE_STOERRELSE + 1, foer: sidste.oprettet_kl });
    setHenter(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    setListe((l) => {
      const kendte = new Set(l.map((n) => n.id));
      const nye = svar.notifikationer.slice(0, SIDE_STOERRELSE);
      return [...l, ...nye.filter((n) => !kendte.has(n.id))];
    });
    setFlere(svar.notifikationer.length > SIDE_STOERRELSE);
  }

  async function markerAlle() {
    setMarkerer(true);
    setFejl(null);
    const svar = await markerAlleLaest();
    setMarkerer(false);
    if ("fejl" in svar) {
      setFejl(svar.fejl);
      return;
    }
    const nu = new Date().toISOString();
    setListe((l) => l.map((n) => (n.laest_kl ? n : { ...n, laest_kl: nu })));
    meldNotifikationerOpdateret();
  }

  if (liste.length === 0) {
    return (
      <div className="mt-6 flex flex-col items-center rounded-[14px] border border-kant bg-white px-4 py-12 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-groen-lys text-groen-mork" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 5a2 2 0 1 1 4 0 7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2-3v-3a7 7 0 0 1 4-6M9 17v1a3 3 0 0 0 6 0v-1" />
          </svg>
        </span>
        <h2 className="mt-4 text-[17px] font-semibold text-tekst">Ingen notifikationer endnu</h2>
        <p className="mt-1 max-w-[40ch] text-[15px] text-tekst-daempet">
          Her får du besked om bud, handler og betalinger.
        </p>
        <Link href="/auktioner" className="btn btn-primaer mt-6">
          Se auktioner
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={markerAlle}
          disabled={markerer || !harUlaeste}
          aria-busy={markerer}
          className="btn btn-sekundaer"
        >
          {markerer && <span className="btn-spinner" aria-hidden="true" />}
          Markér alle som læst
        </button>
      </div>

      {fejl && (
        <p role="alert" className="mt-4 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      <ul className="mt-4 flex flex-col gap-1 rounded-[14px] border border-kant bg-white p-2">
        {liste.map((n) => (
          <li key={n.id}>
            <NotifikationPunkt n={n} vedLaest={vedLaest} />
          </li>
        ))}
      </ul>

      {flere && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={visFlere}
            disabled={henter}
            aria-busy={henter}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            {henter && <span className="btn-spinner" aria-hidden="true" />}
            Vis flere
          </button>
        </div>
      )}
    </>
  );
}
