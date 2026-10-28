"use client";

import { FELT, FELT_FEJL, LABEL } from "@/components/konto/felter";
import { ADRESSE_TEKST, byForPostnummer, type AdresseFelt } from "@/lib/adresse/regler";

// Adresse (vej og nr.), postnummer og by - til opret konto, Min adresse og
// formularen før første bud/betaling. Byen udfyldes ud fra postnummeret
// (samme liste som databasen) og kan ikke skrives i.
// idPrefix: feltets id er `${idPrefix}adresse` osv., så flere formularer kan
// stå på samme side. Opret konto bruger "" (id'erne adresse/postnummer).
export default function AdresseFelter({
  adresse,
  postnummer,
  onAdresse,
  onPostnummer,
  fejlFelt,
  idPrefix = "",
  autoFokus = false,
}: {
  adresse: string;
  postnummer: string;
  onAdresse: (v: string) => void;
  onPostnummer: (v: string) => void;
  fejlFelt: AdresseFelt | null;
  idPrefix?: string;
  autoFokus?: boolean;
}) {
  const by = byForPostnummer(postnummer);
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}adresse`} className={LABEL}>
          {ADRESSE_TEKST.adresse}
        </label>
        <input
          id={`${idPrefix}adresse`}
          name="adresse"
          type="text"
          autoComplete="street-address"
          required
          autoFocus={autoFokus}
          maxLength={200}
          value={adresse}
          onChange={(e) => onAdresse(e.target.value)}
          aria-invalid={fejlFelt === "adresse" || undefined}
          aria-describedby={`${idPrefix}adresse-hjaelp`}
          className={`mt-1.5 ${FELT} ${fejlFelt === "adresse" ? FELT_FEJL : ""}`}
        />
        <p id={`${idPrefix}adresse-hjaelp`} className="mt-1.5 text-[13px] text-tekst-daempet">
          {ADRESSE_TEKST.adresseHjaelp}
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-4">
        <div>
          <label htmlFor={`${idPrefix}postnummer`} className={LABEL}>
            {ADRESSE_TEKST.postnummer}
          </label>
          <input
            id={`${idPrefix}postnummer`}
            name="postnummer"
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            pattern="[0-9]{4}"
            required
            maxLength={4}
            value={postnummer}
            onChange={(e) => onPostnummer(e.target.value.replace(/\D/g, "").slice(0, 4))}
            aria-invalid={fejlFelt === "postnummer" || undefined}
            className={`mt-1.5 ${FELT} ${fejlFelt === "postnummer" ? FELT_FEJL : ""}`}
          />
        </div>
        <div>
          <label htmlFor={`${idPrefix}by`} className={LABEL}>
            {ADRESSE_TEKST.by}
          </label>
          <input
            id={`${idPrefix}by`}
            name="by"
            type="text"
            autoComplete="address-level2"
            readOnly
            tabIndex={-1}
            value={by}
            placeholder={ADRESSE_TEKST.byHjaelp}
            aria-describedby={`${idPrefix}by-hjaelp`}
            className={`mt-1.5 ${FELT} cursor-default text-tekst-daempet`}
          />
          <span id={`${idPrefix}by-hjaelp`} className="sr-only">
            {ADRESSE_TEKST.byHjaelp}
          </span>
        </div>
      </div>
    </>
  );
}
