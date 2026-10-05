"use client";

import { useState } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { spaerByder } from "@/app/actions/tryghed";

export type ByderValg = {
  // Et af byderens bud. Byderens identitet sendes aldrig til browseren.
  budId: string;
  byder: string;
};

// Sælgeren kan spærre en byder ("Byder 3") fra at byde på sine auktioner.
// Vises kun for sælgeren på en igangværende auktion med bud.
export default function SpaerByder({ bydere }: { bydere: ByderValg[] }) {
  const [valgt, setValgt] = useState("");
  const [spaerret, setSpaerret] = useState<Set<string>>(new Set());

  const muligeBydere = bydere.filter((b) => !spaerret.has(b.budId));
  if (bydere.length === 0) return null;
  const valgtByder = bydere.find((b) => b.budId === valgt);

  return (
    <details className="rounded-xl border border-kant bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium text-tekst">Spær en byder</summary>
      <p className="mt-2 text-tekst-daempet">
        En spærret byder kan ikke byde på dine auktioner igen. Byderens nuværende bud er bindende og
        bliver stående. Du kan fjerne spærringen under Min konto.
      </p>
      {spaerret.size > 0 && (
        <p role="status" className="mt-2 text-succes-tekst">
          Byderen er spærret.
        </p>
      )}
      {muligeBydere.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <label htmlFor="spaer-byder" className="sr-only">
            Vælg byder
          </label>
          <select
            id="spaer-byder"
            value={valgt}
            onChange={(e) => setValgt(e.target.value)}
            className="h-11 rounded-lg border border-kant-staerk bg-white px-3 text-base text-tekst sm:h-9 sm:text-sm"
          >
            <option value="">Vælg byder</option>
            {muligeBydere.map((b) => (
              <option key={b.budId} value={b.budId}>
                {b.byder}
              </option>
            ))}
          </select>
          {valgtByder && (
            <BekraeftDialog
              triggerLabel="Spær byder"
              triggerClassName="btn btn-fare btn-lille"
              title={`Spær ${valgtByder.byder}?`}
              description="Byderen kan ikke byde på dine auktioner igen, skrive til dig eller stille dig spørgsmål. Byderens nuværende bud er bindende og bliver stående."
              confirmLabel="Ja, spær byderen"
              onConfirm={async () => {
                const res = await spaerByder(valgtByder.budId);
                return "fejl" in res ? { fejl: res.fejl } : undefined;
              }}
              onSuccess={() => {
                setSpaerret((s) => new Set(s).add(valgtByder.budId));
                setValgt("");
              }}
            />
          )}
        </div>
      )}
    </details>
  );
}
