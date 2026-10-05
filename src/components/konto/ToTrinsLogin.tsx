"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  annullerNyToTrin,
  bekraeftNyToTrin,
  slaaToTrinFra,
  startToTrin,
} from "@/app/actions/kontoSikkerhed";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL, SUCCES_BOKS } from "./felter";

type Tilstand =
  | { trin: "hvile" }
  | { trin: "opsaet"; faktorId: string; qrKode: string; hemmelighed: string }
  | { trin: "slaa_fra" };

function KodeFelt({
  id,
  vaerdi,
  onChange,
  fejl,
}: {
  id: string;
  vaerdi: string;
  onChange: (v: string) => void;
  fejl: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        6-cifret kode fra appen
      </label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        value={vaerdi}
        onChange={(e) => onChange(e.target.value.replace(/[^\d ]/g, ""))}
        aria-invalid={fejl || undefined}
        className={`mt-1.5 ${FELT} max-w-[220px] text-center text-[18px] tracking-[0.3em] ${fejl ? FELT_FEJL : ""}`}
      />
    </div>
  );
}

// Hemmeligheden vises i grupper af 4, så den er nem at taste af.
function grupper(s: string) {
  return s.replace(/(.{4})/g, "$1 ").trim();
}

export default function ToTrinsLogin({ slaaetTil }: { slaaetTil: boolean }) {
  const router = useRouter();
  const [tilstand, setTilstand] = useState<Tilstand>({ trin: "hvile" });
  const [kode, setKode] = useState("");
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [besked, setBesked] = useState<string | null>(null);

  async function start() {
    setFejl(null);
    setBesked(null);
    setLoading(true);
    const svar = await startToTrin();
    setLoading(false);
    if ("fejl" in svar) return setFejl(svar.fejl);
    setKode("");
    setTilstand({ trin: "opsaet", faktorId: svar.faktorId, qrKode: svar.qrKode, hemmelighed: svar.hemmelighed });
  }

  async function bekraeft(e: FormEvent) {
    e.preventDefault();
    if (tilstand.trin !== "opsaet") return;
    setFejl(null);
    setLoading(true);
    const svar = await bekraeftNyToTrin(tilstand.faktorId, kode);
    setLoading(false);
    if ("fejl" in svar) {
      setKode("");
      return setFejl(svar.fejl);
    }
    setTilstand({ trin: "hvile" });
    setBesked("To-trins-login er slået til. Næste gang du logger ind, skal du også bruge koden fra appen.");
    router.refresh();
  }

  async function annuller() {
    if (tilstand.trin === "opsaet") await annullerNyToTrin(tilstand.faktorId);
    setTilstand({ trin: "hvile" });
    setKode("");
    setFejl(null);
  }

  async function slaaFra(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    setLoading(true);
    const svar = await slaaToTrinFra(kode);
    setLoading(false);
    if ("fejl" in svar) {
      setKode("");
      return setFejl(svar.fejl);
    }
    setTilstand({ trin: "hvile" });
    setKode("");
    setBesked("To-trins-login er slået fra.");
    router.refresh();
  }

  const fejlBoks = fejl && (
    <p role="alert" className={FORMULAR_FEJL}>
      {fejl}
    </p>
  );

  if (tilstand.trin === "opsaet") {
    return (
      <form onSubmit={bekraeft} className="space-y-5">
        <ol className="space-y-5">
          <li>
            <p className="text-[15px] font-semibold text-tekst">1. Hent en godkendelses-app</p>
            <p className="mt-1 text-sm text-tekst-daempet">
              Fx Google Authenticator, Microsoft Authenticator eller 1Password. Den findes gratis i App Store og
              Google Play.
            </p>
          </li>
          <li>
            <p className="text-[15px] font-semibold text-tekst">2. Scan QR-koden med appen</p>
            <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start">
              {/* QR-koden er et data:-SVG fra Supabase; next/image kan ikke optimere den. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={tilstand.qrKode}
                alt="QR-kode til din godkendelses-app"
                width={176}
                height={176}
                className="h-44 w-44 shrink-0 rounded-xl border border-kant bg-white p-2"
              />
              <div className="min-w-0 text-sm text-tekst-daempet">
                <p>Kan du ikke scanne? Vælg &quot;Indtast nøgle&quot; i appen, og skriv:</p>
                <p className="mt-2 break-all rounded-lg bg-groen-lys px-3 py-2 font-mono text-[14px] text-groen-mork select-all">
                  {grupper(tilstand.hemmelighed)}
                </p>
                <p className="mt-2">Kontonavn: BidHamr</p>
              </div>
            </div>
          </li>
          <li>
            <p className="text-[15px] font-semibold text-tekst">3. Indtast koden, appen viser</p>
            <div className="mt-2">
              <KodeFelt id="ny-totp-kode" vaerdi={kode} onChange={setKode} fejl={!!fejl} />
            </div>
          </li>
        </ol>

        <div className="rounded-xl border border-advarsel-kant bg-advarsel-bg p-4 text-sm text-advarsel-tekst">
          <p className="font-semibold">Hvis du mister telefonen</p>
          <p className="mt-1">
            Gem nøglen ovenfor et sikkert sted (fx i en adgangskode-manager), eller tilføj den i to apps. Så kan du altid
            få koden igen. Har du mistet både telefon og nøgle, så skriv til support@bidhamr.dk – vi bekræfter, at det er
            dig, og hjælper dig ind igen.
          </p>
        </div>

        {fejlBoks}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            disabled={loading || kode.replace(/\s/g, "").length !== 6}
            aria-busy={loading || undefined}
            className="btn btn-primaer w-full sm:w-auto"
          >
            {loading && <span className="btn-spinner" aria-hidden="true" />}
            Slå to-trins-login til
          </button>
          <button type="button" onClick={annuller} className="btn btn-sekundaer w-full sm:w-auto">
            Annullér
          </button>
        </div>
      </form>
    );
  }

  if (tilstand.trin === "slaa_fra") {
    return (
      <form onSubmit={slaaFra} className="space-y-4">
        <p className="text-sm text-tekst-daempet">
          Indtast koden fra din app for at slå to-trins-login fra. Din konto er bedre beskyttet, hvis det er slået til.
        </p>
        <KodeFelt id="fra-totp-kode" vaerdi={kode} onChange={setKode} fejl={!!fejl} />
        {fejlBoks}
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            disabled={loading || kode.replace(/\s/g, "").length !== 6}
            aria-busy={loading || undefined}
            className="btn btn-fare w-full sm:w-auto"
          >
            {loading && <span className="btn-spinner" aria-hidden="true" />}
            Slå to-trins-login fra
          </button>
          <button
            type="button"
            onClick={() => {
              setTilstand({ trin: "hvile" });
              setKode("");
              setFejl(null);
            }}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            Annullér
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {besked && (
        <p role="status" className={SUCCES_BOKS}>
          {besked}
        </p>
      )}
      {slaaetTil ? (
        <>
          <p className="flex items-center gap-2 text-sm font-medium text-succes-tekst">
            <span aria-hidden="true">✓</span> Slået til – du bruger en kode fra din app, når du logger ind.
          </p>
          {fejlBoks}
          <button
            type="button"
            onClick={() => {
              setBesked(null);
              setFejl(null);
              setTilstand({ trin: "slaa_fra" });
            }}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            Slå fra
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-tekst-daempet">
            Med to-trins-login skal du både bruge din adgangskode og en kode fra en app på din telefon. Så kan ingen logge
            ind, selvom de kender din adgangskode.
          </p>
          {fejlBoks}
          <button
            type="button"
            onClick={start}
            disabled={loading}
            aria-busy={loading || undefined}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            {loading && <span className="btn-spinner" aria-hidden="true" />}
            Slå to-trins-login til
          </button>
        </>
      )}
    </div>
  );
}
