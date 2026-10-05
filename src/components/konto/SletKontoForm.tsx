"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { sletMinKonto, type Blokering } from "@/app/actions/kontoSletning";
import AdgangskodeFelt from "./AdgangskodeFelt";
import Blokeringer from "./Blokeringer";
import { FELT, FORMULAR_FEJL, LABEL } from "./felter";

export default function SletKontoForm() {
  const router = useRouter();
  const [adgangskode, setAdgangskode] = useState("");
  const [bekraeftelse, setBekraeftelse] = useState("");
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [blokeringer, setBlokeringer] = useState<Blokering[] | null>(null);

  const klar = bekraeftelse.trim() === "SLET" && adgangskode.length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!klar) return;
    setFejl(null);
    setLoading(true);
    const svar = await sletMinKonto({ adgangskode, bekraeftelse });
    if ("fejl" in svar) {
      setLoading(false);
      setFejl(svar.fejl);
      setBlokeringer(svar.blokeringer ?? null);
      return;
    }
    // Sessionen er væk; refresh rydder topbaren og alt andet fra kontoen.
    router.replace("/konto-slettet");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4">
      <AdgangskodeFelt id="slet-adgangskode" label="Din adgangskode" vaerdi={adgangskode} onChange={setAdgangskode} />

      <div>
        <label htmlFor="slet-bekraeft" className={LABEL}>
          Skriv SLET for at bekræfte
        </label>
        <input
          id="slet-bekraeft"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={bekraeftelse}
          onChange={(e) => setBekraeftelse(e.target.value)}
          className={`mt-1.5 ${FELT}`}
        />
        <p className="mt-1.5 text-[13px] text-tekst-daempet">Sletningen kan ikke fortrydes.</p>
      </div>

      {fejl && (
        <p role="alert" className={FORMULAR_FEJL}>
          {fejl}
        </p>
      )}
      {blokeringer && blokeringer.length > 0 && <Blokeringer blokeringer={blokeringer} />}

      <button
        type="submit"
        disabled={!klar || loading}
        aria-busy={loading || undefined}
        className="btn btn-fare-fyldt btn-stor w-full sm:w-auto"
      >
        {loading && <span className="btn-spinner" aria-hidden="true" />}
        Slet min konto for altid
      </button>
    </form>
  );
}
