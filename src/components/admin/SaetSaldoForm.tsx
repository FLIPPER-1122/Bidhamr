"use client";

import { useState, useTransition } from "react";
import { saetSaldo } from "@/app/actions/adminActions";

export default function SaetSaldoForm({
  userId,
  nuvaerende,
}: {
  userId: string;
  nuvaerende: number;
}) {
  const [vaerdi, setVaerdi] = useState(String(nuvaerende));
  const [fejl, setFejl] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);
  const [venter, startTransition] = useTransition();

  function gem() {
    setFejl(null);
    setGemt(false);

    startTransition(async () => {
      const data = new FormData();
      data.set("userId", userId);
      data.set("saldo", vaerdi);

      try {
        await saetSaldo(data);
        setGemt(true);
      } catch (err) {
        setFejl(err instanceof Error ? err.message : "Kunne ikke sætte saldoen.");
      }
    });
  }

  return (
    <div className="w-full sm:w-auto">
      <div className="flex items-center gap-2">
        <div className="relative">
          <input
            type="number"
            min={0}
            step="0.01"
            value={vaerdi}
            onChange={(e) => {
              setVaerdi(e.target.value);
              setGemt(false);
            }}
            aria-label="Ny saldo i kroner"
            className="w-28 rounded-lg border border-neutral-300 py-2 pl-3 pr-8 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-400">
            kr
          </span>
        </div>
        <button
          type="button"
          onClick={gem}
          disabled={venter}
          className="whitespace-nowrap rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
        >
          {venter ? "Gemmer…" : "Sæt saldo"}
        </button>
      </div>

      {fejl && <p className="mt-1 text-xs text-red-600">{fejl}</p>}
      {gemt && !fejl && (
        <p className="mt-1 text-xs text-green-700">Saldoen er opdateret.</p>
      )}
    </div>
  );
}
