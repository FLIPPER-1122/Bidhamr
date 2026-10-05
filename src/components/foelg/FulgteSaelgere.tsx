"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useTransition } from "react";
import Ikon from "@/components/Ikon";
import TomTilstand from "@/components/TomTilstand";
import { kanOptimeres } from "@/lib/billedUrl";
import { stopFoelgSaelger } from "@/app/actions/foelg";

export type FulgtSaelger = {
  id: string;
  navn: string;
  avatarUrl: string | null;
  aktiveAuktioner: number;
};

// Listen "Sælgere du følger" under Min konto.
export default function FulgteSaelgere({ start }: { start: FulgtSaelger[] }) {
  const [saelgere, setSaelgere] = useState(start);
  const [fejl, setFejl] = useState<string | null>(null);
  const [igang, setIgang] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function stop(s: FulgtSaelger) {
    setFejl(null);
    setIgang(s.id);
    startTransition(async () => {
      const res = await stopFoelgSaelger(s.id);
      setIgang(null);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      setSaelgere((liste) => liste.filter((x) => x.id !== s.id));
    });
  }

  if (saelgere.length === 0) {
    return (
      <TomTilstand
        className="mt-6"
        ikon="bruger"
        titel="Du følger ingen sælgere endnu"
        tekst="Find en sælger, du kan lide, og tryk Følg på profilen eller auktionen. Så får du besked, når der kommer nyt."
        knap={{ href: "/auktioner", tekst: "Find auktioner" }}
      />
    );
  }

  return (
    <>
      {fejl && (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      <ul className="mt-6 divide-y divide-kant rounded-[14px] border border-kant bg-white">
        {saelgere.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-3.5 sm:gap-4">
            <span className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full border border-kant bg-groen-lys text-groen-mork">
              {s.avatarUrl ? (
                <Image
                  src={s.avatarUrl}
                  alt=""
                  fill
                  sizes="48px"
                  unoptimized={!kanOptimeres(s.avatarUrl)}
                  className="object-cover"
                />
              ) : (
                <Ikon navn="bruger" className="h-5 w-5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <Link
                href={`/profil/${s.id}`}
                className="block truncate rounded-md text-[15px] font-medium text-tekst hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
              >
                {s.navn}
              </Link>
              <span className="mt-0.5 block text-[13px] text-tekst-svag">
                {s.aktiveAuktioner === 0
                  ? "Ingen aktive auktioner lige nu"
                  : s.aktiveAuktioner === 1
                    ? "1 aktiv auktion"
                    : `${s.aktiveAuktioner} aktive auktioner`}
              </span>
            </span>
            <button
              type="button"
              onClick={() => stop(s)}
              disabled={igang === s.id}
              aria-busy={igang === s.id || undefined}
              aria-label={`Stop med at følge ${s.navn}`}
              className="btn btn-sekundaer btn-lille shrink-0"
            >
              {igang === s.id && <span className="btn-spinner" aria-hidden="true" />}
              Stop
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-tekst-daempet">
        Vil du ikke have besked om nye auktioner? Slå det fra under{" "}
        <Link href="/konto/notifikationer" className="font-medium text-groen hover:underline">
          Notifikationsindstillinger
        </Link>
        .
      </p>
    </>
  );
}
