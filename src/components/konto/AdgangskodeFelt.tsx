"use client";

import { useId, useState } from "react";
import {
  MIN_LAENGDE,
  STYRKE_TEKST,
  vurderAdgangskode,
  type Personinfo,
} from "@/lib/adgangskode";
import { FELT, FELT_FEJL, LABEL } from "./felter";

function Oeje({ vis }: { vis: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
      {vis ? (
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c4.5 0 8.3 2.9 9.5 7a10 10 0 0 1-2.9 4.4M6.6 6.6A10 10 0 0 0 2.5 12c1.3 4.1 5 7 9.5 7 1.6 0 3.1-.4 4.4-1" />
      ) : (
        <>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12C3.8 7.9 7.5 5 12 5s8.2 2.9 9.5 7c-1.3 4.1-5 7-9.5 7s-8.2-2.9-9.5-7Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </>
      )}
    </svg>
  );
}

function KravLinje({ ok, tekst }: { ok: boolean; tekst: string }) {
  return (
    <li className={`flex items-start gap-2 text-[13px] ${ok ? "text-succes-tekst" : "text-tekst-daempet"}`}>
      <span aria-hidden="true" className="mt-px w-4 shrink-0 text-center font-semibold">
        {ok ? "✓" : "•"}
      </span>
      <span>
        {tekst}
        <span className="sr-only">{ok ? " – opfyldt" : " – ikke opfyldt endnu"}</span>
      </span>
    </li>
  );
}

const STYRKE_FARVE = ["bg-fejl-fyldt", "bg-fejl-fyldt", "bg-orange", "bg-groen", "bg-groen-mork"];

// Adgangskodefelt med vis/skjul. Med `ny` vises styrkemåler og kravene,
// mens man skriver. Kravene tjekkes igen på serveren.
export default function AdgangskodeFelt({
  id,
  label,
  vaerdi,
  onChange,
  ny = false,
  person,
  autoComplete,
  fejl,
}: {
  id?: string;
  label: string;
  vaerdi: string;
  onChange: (v: string) => void;
  ny?: boolean;
  person?: Personinfo;
  autoComplete?: string;
  fejl?: string | null;
}) {
  const egetId = useId();
  const feltId = id ?? egetId;
  const [vis, setVis] = useState(false);
  const vurdering = vurderAdgangskode(vaerdi, person);
  const hjaelpId = `${feltId}-hjaelp`;
  const fejlId = `${feltId}-fejl`;

  return (
    <div>
      <label htmlFor={feltId} className={LABEL}>
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={feltId}
          type={vis ? "text" : "password"}
          autoComplete={autoComplete ?? (ny ? "new-password" : "current-password")}
          required
          maxLength={200}
          value={vaerdi}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={fejl ? true : undefined}
          aria-describedby={[ny ? hjaelpId : null, fejl ? fejlId : null].filter(Boolean).join(" ") || undefined}
          className={`${FELT} pr-12 ${fejl ? FELT_FEJL : ""}`}
        />
        <button
          type="button"
          onClick={() => setVis((v) => !v)}
          aria-label={vis ? "Skjul adgangskode" : "Vis adgangskode"}
          aria-pressed={vis}
          className="absolute right-0 top-0 grid h-11 w-11 place-items-center rounded-xl text-tekst-svag hover:text-tekst focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen"
        >
          <Oeje vis={vis} />
        </button>
      </div>

      {fejl && (
        <p id={fejlId} className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}

      {ny && (
        <div id={hjaelpId} className="mt-2">
          <div className="flex items-center gap-3">
            <div className="flex flex-1 gap-1" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    vaerdi && vurdering.styrke > i ? STYRKE_FARVE[vurdering.styrke] : "bg-kant"
                  }`}
                />
              ))}
            </div>
            <span className="w-20 text-right text-[13px] font-medium text-tekst-daempet" aria-live="polite">
              {vaerdi ? STYRKE_TEKST[vurdering.styrke] : ""}
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            <KravLinje ok={vurdering.krav.laengde} tekst={`Mindst ${MIN_LAENGDE} tegn`} />
            <KravLinje ok={vurdering.krav.ikkeAlmindelig} tekst="Ikke en almindelig adgangskode" />
            <KravLinje ok={vurdering.krav.ikkePersonlig} tekst="Ikke din e-mail eller dit navn" />
          </ul>
          <p className="mt-2 text-[13px] text-tekst-daempet">
            Tip: Brug tre-fire tilfældige ord, fx &quot;kaffe cykel blå tromme&quot;.
          </p>
        </div>
      )}
    </div>
  );
}
