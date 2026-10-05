"use client";

import Link from "next/link";
import { type FormEvent, useId, useState, useTransition } from "react";
import Ikon from "@/components/Ikon";
import { gemSoegning } from "@/app/actions/gemteSoegninger";
import { MAKS_NAVN, soegningHref, standardNavn, type SoegeKriterier } from "@/lib/gemteSoegninger";

// "Gem søgning" på /auktioner: gemmer søgeord og filtre, så brugeren får
// besked om nye auktioner, der matcher.
export default function GemSoegningKnap({
  kriterier,
  erLoggetInd,
}: {
  kriterier: SoegeKriterier;
  erLoggetInd: boolean;
}) {
  const feltId = useId();
  const [aaben, setAaben] = useState(false);
  const [navn, setNavn] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  // Hvilke filtre der sidst blev gemt - ændres filtrene, kan den nye søgning gemmes.
  const [gemtFor, setGemtFor] = useState<string | null>(null);
  const [gemmer, startGem] = useTransition();
  const kanGemmes = Boolean(kriterier.soegeord || kriterier.kategori);
  const noegle = JSON.stringify(kriterier);
  const gemt = gemtFor === noegle;

  if (!erLoggetInd) {
    return (
      <Link
        href={`/login?redirect=${encodeURIComponent(soegningHref(kriterier))}`}
        className="btn btn-sekundaer btn-lille"
      >
        <Ikon navn="klokke" className="h-4 w-4" />
        Gem søgning
      </Link>
    );
  }

  if (gemt) {
    return (
      <p role="status" className="text-sm text-succes-tekst">
        Søgningen er gemt. Vi giver besked, når der kommer nyt.{" "}
        <Link href="/konto/soegninger" className="font-medium text-groen underline">
          Se gemte søgninger
        </Link>
      </p>
    );
  }

  function gem(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    startGem(async () => {
      const res = await gemSoegning(navn, kriterier);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      setGemtFor(noegle);
      setAaben(false);
    });
  }

  if (!aaben) {
    return (
      <div className="flex flex-col items-start gap-1.5 sm:items-end">
        <button
          type="button"
          onClick={() => {
            if (!kanGemmes) {
              setFejl("Skriv et søgeord eller vælg en kategori, før du gemmer søgningen.");
              return;
            }
            setNavn(standardNavn(kriterier));
            setAaben(true);
          }}
          className="btn btn-sekundaer btn-lille"
        >
          <Ikon navn="klokke" className="h-4 w-4" />
          Gem søgning
        </button>
        {fejl && (
          <p role="alert" className="text-[13px] font-medium text-fejl-tekst">
            {fejl}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={gem}
      className="w-full rounded-xl border border-kant bg-white p-4 shadow-flyder sm:max-w-md"
    >
      <label htmlFor={feltId} className="mb-1.5 block text-sm font-medium text-tekst">
        Navn på søgningen
      </label>
      <input
        id={feltId}
        value={navn}
        maxLength={MAKS_NAVN}
        onChange={(e) => setNavn(e.target.value)}
        autoFocus
        className="h-11 w-full rounded-xl border border-kant-staerk bg-white px-4 text-[15px] text-tekst hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
      />
      <p className="mt-1.5 text-[13px] text-tekst-daempet">
        Du får højst én besked hver 6. time, når der kommer nye auktioner, der matcher.
      </p>
      {fejl && (
        <p role="alert" className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={gemmer} aria-busy={gemmer || undefined} className="btn btn-primaer">
          {gemmer && <span className="btn-spinner" aria-hidden="true" />}
          Gem søgning
        </button>
        <button type="button" onClick={() => setAaben(false)} className="btn btn-tekst">
          Annullér
        </button>
      </div>
    </form>
  );
}
