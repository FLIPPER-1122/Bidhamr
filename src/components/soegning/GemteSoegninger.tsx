"use client";

import Link from "next/link";
import { type FormEvent, useId, useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import TomTilstand from "@/components/TomTilstand";
import { omdoebSoegning, saetBesked, sletSoegning } from "@/app/actions/gemteSoegninger";
import { MAKS_NAVN, kriterieTekst, soegningHref, type GemtSoegning } from "@/lib/gemteSoegninger";

// Listen "Gemte søgninger" under Min konto: omdøb, besked til/fra og slet.
export default function GemteSoegninger({ start }: { start: GemtSoegning[] }) {
  const [soegninger, setSoegninger] = useState(start);

  if (soegninger.length === 0) {
    return (
      <TomTilstand
        className="mt-6"
        ikon="soeg"
        titel="Du har ingen gemte søgninger endnu"
        tekst={'Søg efter noget, du leder efter, og tryk "Gem søgning". Så giver vi besked, når der kommer nyt.'}
        knap={{ href: "/auktioner", tekst: "Gå til auktioner" }}
      />
    );
  }

  return (
    <ul className="mt-6 space-y-3">
      {soegninger.map((s) => (
        <Soegning
          key={s.id}
          soegning={s}
          vedAendring={(ny) => setSoegninger((liste) => liste.map((x) => (x.id === ny.id ? ny : x)))}
          vedSlet={() => setSoegninger((liste) => liste.filter((x) => x.id !== s.id))}
        />
      ))}
    </ul>
  );
}

function Soegning({
  soegning: s,
  vedAendring,
  vedSlet,
}: {
  soegning: GemtSoegning;
  vedAendring: (s: GemtSoegning) => void;
  vedSlet: () => void;
}) {
  const feltId = useId();
  const [redigerer, setRedigerer] = useState(false);
  const [navn, setNavn] = useState(s.navn);
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemmer, startGem] = useTransition();
  const [skifter, startSkift] = useTransition();

  function gemNavn(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    startGem(async () => {
      const res = await omdoebSoegning(s.id, navn);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      vedAendring({ ...s, navn: navn.replace(/\s+/g, " ").trim() });
      setRedigerer(false);
    });
  }

  function skiftBesked() {
    setFejl(null);
    const ny = !s.besked;
    vedAendring({ ...s, besked: ny });
    startSkift(async () => {
      const res = await saetBesked(s.id, ny);
      if ("fejl" in res) {
        vedAendring({ ...s, besked: !ny });
        setFejl(res.fejl);
      }
    });
  }

  return (
    <li className="rounded-[14px] border border-kant bg-white p-4 sm:p-5">
      {redigerer ? (
        <form onSubmit={gemNavn} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
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
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={gemmer} aria-busy={gemmer || undefined} className="btn btn-primaer">
              {gemmer && <span className="btn-spinner" aria-hidden="true" />}
              Gem
            </button>
            <button
              type="button"
              onClick={() => {
                setNavn(s.navn);
                setRedigerer(false);
                setFejl(null);
              }}
              className="btn btn-tekst"
            >
              Annullér
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-snug break-words lg:text-lg">{s.navn}</h2>
            <p className="mt-0.5 text-sm break-words text-tekst-daempet">{kriterieTekst(s)}</p>
          </div>
          <Link href={soegningHref(s, true)} className="btn btn-sekundaer btn-lille shrink-0">
            Vis auktioner
          </Link>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-kant pt-3">
        <button
          type="button"
          role="switch"
          aria-checked={s.besked}
          onClick={skiftBesked}
          disabled={skifter}
          className="flex min-h-11 items-center gap-3 rounded-lg text-left text-sm font-medium text-tekst focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          <span
            aria-hidden="true"
            className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${s.besked ? "bg-groen" : "bg-kant-staerk"}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${s.besked ? "translate-x-[18px]" : "translate-x-0.5"}`}
            />
          </span>
          Besked om nye auktioner
        </button>

        <div className="flex items-center gap-4">
          {!redigerer && (
            <button type="button" onClick={() => setRedigerer(true)} className="btn btn-tekst min-h-11 text-sm">
              Omdøb
            </button>
          )}
          <BekraeftDialog
            triggerLabel="Slet"
            triggerClassName="btn btn-tekst min-h-11 text-sm text-fejl-tekst"
            title="Slet gemt søgning?"
            description={`"${s.navn}" slettes, og du får ikke længere besked om nye auktioner fra den.`}
            confirmLabel="Ja, slet"
            onConfirm={async () => {
              const res = await sletSoegning(s.id);
              return "fejl" in res ? { fejl: res.fejl } : undefined;
            }}
            onSuccess={vedSlet}
          />
        </div>
      </div>

      {fejl && (
        <p role="alert" className="mt-2 text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </li>
  );
}
