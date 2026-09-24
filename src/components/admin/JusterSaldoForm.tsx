"use client";

import { useState, useTransition } from "react";
import { justerSaldo } from "@/app/actions/adminActions";

// Justerer saldoen MED et beløb (plus eller minus). Til at sætte en præcis
// saldo bruges SaetSaldoForm på brugeroversigten.
export default function JusterSaldoForm({ userId }: { userId: string }) {
  const [beloeb, setBeloeb] = useState("");
  const [aarsag, setAarsag] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);
  const [venter, startTransition] = useTransition();

  function gem() {
    setFejl(null);
    setGemt(false);

    startTransition(async () => {
      const data = new FormData();
      data.set("userId", userId);
      data.set("beloeb", beloeb);
      data.set("aarsag", aarsag);

      // Actionen returnerer fejlen frem for at kaste den, så beskeden også
      // når frem i produktion.
      const svar = await justerSaldo(data);

      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }

      setGemt(true);
      setBeloeb("");
      setAarsag("");
    });
  }

  return (
    <div className="mt-5 border-t border-neutral-100 pt-4">
      <p className="mb-2 text-xs font-medium uppercase text-neutral-500">
        Justér saldo
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="beloeb" className="block text-xs text-neutral-500">
            Beløb (negativt for træk)
          </label>
          <input
            id="beloeb"
            type="number"
            step="0.01"
            value={beloeb}
            onChange={(e) => {
              setBeloeb(e.target.value);
              setGemt(false);
            }}
            placeholder="1000"
            className="mt-1 w-36 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <label htmlFor="aarsag" className="block text-xs text-neutral-500">
            Begrundelse
          </label>
          <input
            id="aarsag"
            type="text"
            value={aarsag}
            onChange={(e) => {
              setAarsag(e.target.value);
              setGemt(false);
            }}
            placeholder="Testpenge / fejlrettelse"
            className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>
        <button
          type="button"
          onClick={gem}
          disabled={venter}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-orange-mork disabled:opacity-50"
        >
          {venter ? "Bogfører…" : "Bogfør"}
        </button>
      </div>

      {fejl && <p className="mt-2 text-sm text-red-600">{fejl}</p>}
      {gemt && !fejl && (
        <p className="mt-2 text-sm text-green-700">Justeringen er bogført.</p>
      )}

      <p className="mt-2 text-xs text-neutral-500">
        Justeringen bogføres i hovedbogen og logges i moderationsloggen.
      </p>
    </div>
  );
}
