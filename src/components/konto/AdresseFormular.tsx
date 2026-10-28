"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import AdresseFelter from "@/components/konto/AdresseFelter";
import { FORMULAR_FEJL, SUCCES_BOKS } from "@/components/konto/felter";
import { gemMinAdresseAction } from "@/app/actions/adresse";
import { ADRESSE_TEKST, validerAdresse, type Adresse, type AdresseFelt } from "@/lib/adresse/regler";
import { useHydreret } from "@/lib/useHydreret";

// Formularen til brugerens adresse: Min konto -> Min adresse, og den korte
// formular før første bud (budpanelet) og første betaling (checkout).
// onGemt: kaldes med den gemte adresse (fx så budpanelet viser budformularen
// igen). Uden onGemt opdateres siden og "Din adresse er gemt." vises.
export default function AdresseFormular({
  start = null,
  onGemt,
  knapTekst = ADRESSE_TEKST.gem,
  idPrefix = "adr-",
  autoFokus = false,
}: {
  start?: Adresse | null;
  onGemt?: (adresse: Adresse) => void;
  knapTekst?: string;
  idPrefix?: string;
  autoFokus?: boolean;
}) {
  const router = useRouter();
  const hydreret = useHydreret();
  const [adresse, setAdresse] = useState(start?.adresse ?? "");
  const [postnummer, setPostnummer] = useState(start?.postnummer ?? "");
  const [fejl, setFejl] = useState<string | null>(null);
  const [fejlFelt, setFejlFelt] = useState<AdresseFelt | null>(null);
  const [gemt, setGemt] = useState(false);
  const [loading, setLoading] = useState(false);

  function visFejl(besked: string, felt: AdresseFelt | null) {
    setFejl(besked);
    setFejlFelt(felt);
    if (felt) requestAnimationFrame(() => document.getElementById(`${idPrefix}${felt}`)?.focus());
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setFejl(null);
    setFejlFelt(null);
    setGemt(false);
    const v = validerAdresse({ adresse, postnummer });
    if ("fejl" in v) {
      visFejl(v.fejl, v.felt);
      return;
    }
    setLoading(true);
    const svar = await gemMinAdresseAction({ adresse, postnummer });
    setLoading(false);
    if ("fejl" in svar) {
      visFejl(svar.fejl, svar.felt ?? null);
      return;
    }
    setAdresse(svar.adresse.adresse);
    setPostnummer(svar.adresse.postnummer);
    if (onGemt) {
      onGemt(svar.adresse);
    } else {
      setGemt(true);
      router.refresh();
    }
  }

  return (
    <form onSubmit={handleSubmit} method="post" noValidate className="space-y-4">
      <AdresseFelter
        adresse={adresse}
        postnummer={postnummer}
        onAdresse={(v) => {
          setAdresse(v);
          setGemt(false);
        }}
        onPostnummer={(v) => {
          setPostnummer(v);
          setGemt(false);
        }}
        fejlFelt={fejlFelt}
        idPrefix={idPrefix}
        autoFokus={autoFokus}
      />
      {fejl && (
        <p role="alert" className={FORMULAR_FEJL}>
          {fejl}
        </p>
      )}
      {gemt && (
        <p role="status" className={SUCCES_BOKS}>
          {ADRESSE_TEKST.gemt}
        </p>
      )}
      <button
        type="submit"
        disabled={loading || !hydreret}
        aria-busy={loading || undefined}
        className="btn btn-primaer w-full sm:w-auto"
      >
        {loading && <span className="btn-spinner" aria-hidden="true" />}
        {knapTekst}
      </button>
    </form>
  );
}
