"use client";

import { useState, type FormEvent } from "react";
import { skiftAdgangskode } from "@/app/actions/kontoSikkerhed";
import { vurderAdgangskode, type Personinfo } from "@/lib/adgangskode";
import AdgangskodeFelt from "./AdgangskodeFelt";
import { FORMULAR_FEJL, SUCCES_BOKS } from "./felter";

export default function SkiftAdgangskode({ person }: { person: Personinfo }) {
  const [aaben, setAaben] = useState(false);
  const [nuvaerende, setNuvaerende] = useState("");
  const [ny, setNy] = useState("");
  const [gentag, setGentag] = useState("");
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);

  function nulstil() {
    setNuvaerende("");
    setNy("");
    setGentag("");
    setFejl(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    const v = vurderAdgangskode(ny, person);
    if (!v.ok) return setFejl(v.fejl);
    if (ny !== gentag) return setFejl("Adgangskoderne stemmer ikke overens.");

    setLoading(true);
    const svar = await skiftAdgangskode(nuvaerende, ny);
    setLoading(false);
    if ("fejl" in svar) return setFejl(svar.fejl);
    nulstil();
    setAaben(false);
    setGemt(true);
  }

  if (!aaben) {
    return (
      <div>
        {gemt && (
          <p role="status" className={`mb-3 ${SUCCES_BOKS}`}>
            Din adgangskode er ændret. Du er logget ud på dine andre enheder, og vi har sendt dig en mail.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setGemt(false);
            setAaben(true);
          }}
          className="btn btn-sekundaer w-full sm:w-auto"
        >
          Skift adgangskode
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4">
      <AdgangskodeFelt
        id="nuvaerende-adgangskode"
        label="Nuværende adgangskode"
        vaerdi={nuvaerende}
        onChange={setNuvaerende}
      />
      <AdgangskodeFelt id="ny-adgangskode" label="Ny adgangskode" vaerdi={ny} onChange={setNy} ny person={person} />
      <div>
        <AdgangskodeFelt
          id="gentag-adgangskode"
          label="Gentag ny adgangskode"
          vaerdi={gentag}
          onChange={setGentag}
          autoComplete="new-password"
        />
        {gentag && ny !== gentag && (
          <p className="mt-1.5 text-[13px] font-medium text-fejl-tekst">Adgangskoderne stemmer ikke overens</p>
        )}
      </div>

      {fejl && (
        <p role="alert" className={FORMULAR_FEJL}>
          {fejl}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" disabled={loading} aria-busy={loading || undefined} className="btn btn-primaer w-full sm:w-auto">
          {loading && <span className="btn-spinner" aria-hidden="true" />}
          Gem ny adgangskode
        </button>
        <button
          type="button"
          onClick={() => {
            nulstil();
            setAaben(false);
          }}
          className="btn btn-sekundaer w-full sm:w-auto"
        >
          Annullér
        </button>
      </div>
    </form>
  );
}
