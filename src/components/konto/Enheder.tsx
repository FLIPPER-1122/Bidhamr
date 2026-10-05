"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fjernEnhed, logUdAndreSteder } from "@/app/actions/kontoSikkerhed";
import { FORMULAR_FEJL, SUCCES_BOKS } from "./felter";

export type Enhed = {
  id: string;
  beskrivelse: string;
  foerstSetKl: string;
  sidstSetKl: string;
  denne: boolean;
  loggetInd: boolean;
};

function tid(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    timeZone: "Europe/Copenhagen",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EnhedIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] text-groen-mork" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9H4V6ZM2 18h20" />
    </svg>
  );
}

export default function Enheder({ enheder }: { enheder: Enhed[] }) {
  const router = useRouter();
  const [arbejder, setArbejder] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [besked, setBesked] = useState<string | null>(null);

  async function fjern(id: string) {
    setFejl(null);
    setBesked(null);
    setArbejder(id);
    const svar = await fjernEnhed(id);
    setArbejder(null);
    if ("fejl" in svar) return setFejl(svar.fejl);
    setBesked("Enheden er fjernet og logget ud.");
    router.refresh();
  }

  async function logUdAndre() {
    setFejl(null);
    setBesked(null);
    setArbejder("andre");
    const svar = await logUdAndreSteder();
    setArbejder(null);
    if ("fejl" in svar) return setFejl(svar.fejl);
    setBesked("Du er logget ud alle andre steder. Du er stadig logget ind her.");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {enheder.length === 0 ? (
        <p className="text-sm text-tekst-daempet">
          Her kommer de enheder, du logger ind fra. Næste gang du logger ind, kan du se dem her.
        </p>
      ) : (
        <ul className="divide-y divide-kant rounded-xl border border-kant">
          {enheder.map((e) => (
            <li key={e.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg bg-groen-lys">
                  <EnhedIkon />
                </span>
                <div className="min-w-0">
                  <p className="text-[15px] font-medium text-tekst">
                    {e.beskrivelse}
                    {e.denne && (
                      <span className="ml-2 rounded-full bg-groen-lys px-2 py-0.5 text-[12px] font-semibold text-groen-mork">
                        Denne enhed
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[13px] text-tekst-svag">
                    Sidst set {tid(e.sidstSetKl)} · Først set {tid(e.foerstSetKl)}
                    {!e.denne && !e.loggetInd ? " · Logget ud" : ""}
                  </p>
                </div>
              </div>
              {!e.denne && (
                <button
                  type="button"
                  onClick={() => fjern(e.id)}
                  disabled={arbejder !== null}
                  aria-busy={arbejder === e.id || undefined}
                  className="btn btn-sekundaer btn-lille w-full sm:w-auto"
                >
                  {arbejder === e.id && <span className="btn-spinner" aria-hidden="true" />}
                  Fjern
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {fejl && (
        <p role="alert" className={FORMULAR_FEJL}>
          {fejl}
        </p>
      )}
      {besked && (
        <p role="status" className={SUCCES_BOKS}>
          {besked}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={logUdAndre}
          disabled={arbejder !== null}
          aria-busy={arbejder === "andre" || undefined}
          className="btn btn-sekundaer w-full sm:w-auto"
        >
          {arbejder === "andre" && <span className="btn-spinner" aria-hidden="true" />}
          Log ud alle andre steder
        </button>
        <p className="mt-1.5 text-[13px] text-tekst-daempet">
          Bruges, hvis du har glemt at logge ud på en anden computer, eller du tror, nogen har din adgangskode.
          Gælder også appen.
        </p>
      </div>
    </div>
  );
}
