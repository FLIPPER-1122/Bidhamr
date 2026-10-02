"use client";

// Vælg billeder pr. kategori (pakke, label, indhold, andet) med
// forhåndsvisning og "Fjern". Selve uploadet sker først ved afsendelse
// (sagUpload.ts), så fjernede billeder aldrig rammer serveren.
import { useEffect, useId, useRef, useState } from "react";
import { SAG_KATEGORI_NAVN, SAG_MAKS_BILLEDSTOERRELSE, type SagBilledeKategori } from "@/lib/sager";
import { ACCEPT, UPLOAD_FEJL, filType, type ValgtBillede } from "./sagUpload";

export type KategoriFelt = {
  kategori: SagBilledeKategori;
  overskrift: string;
  hjaelp: string;
  paakraevet: boolean;
};

// Hjælpetekster. TODO(indhold): gennemse og evt. udvid eksemplerne.
export const KATEGORI_FELTER: Record<SagBilledeKategori, Omit<KategoriFelt, "paakraevet">> = {
  pakke: {
    kategori: "pakke",
    overskrift: "Pakken udefra",
    hjaelp: "Hele pakken, så skader på kassen kan ses. Tag gerne billeder fra flere sider.",
  },
  label: {
    kategori: "label",
    overskrift: "Labelen",
    hjaelp: "Fragtlabelen på pakken, så sporingsnummeret kan læses.",
  },
  indhold: {
    kategori: "indhold",
    overskrift: "Indholdet",
    hjaelp: "Varen og indpakningen, som du fandt dem, da du åbnede pakken. Vis skaden tæt på.",
  },
  andet: {
    kategori: "andet",
    overskrift: "Andre billeder",
    hjaelp: "Fx et skærmbillede af sporingen eller af annoncen.",
  },
};

// Frigiv object-URL'er, når komponenten forsvinder.
export function useFrigivPreviews(billeder: ValgtBillede[]) {
  const ref = useRef(billeder);
  useEffect(() => {
    ref.current = billeder;
  }, [billeder]);
  useEffect(() => () => ref.current.forEach((b) => URL.revokeObjectURL(b.preview)), []);
}

export default function BilledVaelger({
  felter,
  billeder,
  onChange,
  maks,
  laast,
}: {
  felter: KategoriFelt[];
  billeder: ValgtBillede[];
  onChange: (billeder: ValgtBillede[]) => void;
  maks: number;
  laast: boolean;
}) {
  const id = useId();
  const [fejl, setFejl] = useState<string | null>(null);
  // Billeder, browseren ikke kan vise (fx HEIC i Chrome): vis filnavnet.
  const [ulaeselige, setUlaeselige] = useState<ReadonlySet<string>>(new Set());
  const plads = maks - billeder.length;

  function tilfoej(kategori: SagBilledeKategori, filer: FileList | null) {
    setFejl(null);
    if (!filer || filer.length === 0) return;
    const nye: ValgtBillede[] = [];
    for (const fil of Array.from(filer)) {
      if (billeder.length + nye.length >= maks) {
        setFejl(`Du kan højst tilføje ${maks} billeder.`);
        break;
      }
      if (!filType(fil)) {
        setFejl(UPLOAD_FEJL.ugyldig_type);
        continue;
      }
      // Billeder over 10 MB komprimeres ved afsendelse; afvis kun de helt store.
      if (fil.size > SAG_MAKS_BILLEDSTOERRELSE * 3) {
        setFejl(UPLOAD_FEJL.for_stor);
        continue;
      }
      nye.push({ id: crypto.randomUUID(), fil, kategori, preview: URL.createObjectURL(fil) });
    }
    if (nye.length) onChange([...billeder, ...nye]);
  }

  function fjern(bid: string) {
    const b = billeder.find((x) => x.id === bid);
    if (b) URL.revokeObjectURL(b.preview);
    onChange(billeder.filter((x) => x.id !== bid));
  }

  return (
    <div className="space-y-5">
      {felter.map((f) => {
        const egne = billeder.filter((b) => b.kategori === f.kategori);
        const inputId = `${id}-${f.kategori}`;
        return (
          <fieldset key={f.kategori} className="rounded-xl border border-kant p-4">
            <legend className="px-1 text-sm font-semibold text-tekst">
              {f.overskrift}
              {f.paakraevet ? (
                <span className="font-normal text-tekst-daempet"> (mindst ét billede)</span>
              ) : (
                <span className="font-normal text-tekst-daempet"> (valgfrit)</span>
              )}
            </legend>
            <p id={`${inputId}-hjaelp`} className="text-sm text-tekst-daempet">
              {f.hjaelp}
            </p>

            {egne.length > 0 && (
              <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                {egne.map((b) => (
                  <li key={b.id} className="relative overflow-hidden rounded-lg border border-kant bg-skelet">
                    {ulaeselige.has(b.id) ? (
                      <span className="flex aspect-square w-full items-center justify-center break-all p-2 text-center text-xs text-tekst-daempet">
                        {b.fil.name}
                      </span>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={b.preview}
                        alt={`Valgt billede: ${SAG_KATEGORI_NAVN[b.kategori].toLowerCase()}`}
                        className="aspect-square w-full object-cover"
                        onError={() => setUlaeselige((s) => new Set(s).add(b.id))}
                      />
                    )}
                    {b.sti && (
                      <span className="absolute left-1 top-1 rounded-full bg-succes-bg px-1.5 py-0.5 text-[11px] font-semibold text-succes-tekst">
                        Uploadet
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => fjern(b.id)}
                      disabled={laast}
                      aria-label={`Fjern billedet ${b.fil.name}`}
                      className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-white/95 text-tekst shadow disabled:opacity-50"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <label
              htmlFor={inputId}
              className={`btn btn-sekundaer btn-lille mt-3 cursor-pointer ${
                laast || plads <= 0 ? "pointer-events-none opacity-50" : ""
              }`}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Tilføj billede
            </label>
            <input
              id={inputId}
              type="file"
              accept={ACCEPT}
              multiple
              disabled={laast || plads <= 0}
              aria-describedby={`${inputId}-hjaelp`}
              className="sr-only"
              onChange={(e) => {
                tilfoej(f.kategori, e.target.files);
                e.target.value = "";
              }}
            />
          </fieldset>
        );
      })}
      <p className="text-xs text-tekst-svag">
        {billeder.length} af højst {maks} billeder. JPG, PNG, HEIC eller WEBP. Billederne gøres mindre, før de sendes.
      </p>
      {fejl && (
        <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
