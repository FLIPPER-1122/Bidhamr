"use client";

import { useState, type FormEvent } from "react";

const HURTIGVALG = [100, 500, 1000, 2500];

export default function IndbetalForm() {
  const [beløb, setBeløb] = useState("500");
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFejl(null);

    try {
      const res = await fetch("/api/stripe/wallet-indbetaling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beloeb: Number(beløb) }),
      });

      const data = await res.json();

      if (!res.ok) {
        setFejl(data.error ?? "Noget gik galt.");
        setLoading(false);
        return;
      }

      // Videre til Stripe. Saldoen krediteres først, når Stripe bekræfter
      // betalingen via webhooken - ikke når vi lander på success-siden.
      window.location.href = data.url;
    } catch {
      setFejl("Kunne ikke oprette betalingen. Prøv igen.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {HURTIGVALG.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setBeløb(String(v))}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
              beløb === String(v)
                ? "border-brand bg-brand text-white"
                : "border-neutral-300 text-neutral-700 hover:border-brand"
            }`}
          >
            {v.toLocaleString("da-DK")} kr
          </button>
        ))}
      </div>

      <div>
        <label
          htmlFor="beloeb"
          className="block text-sm font-medium text-neutral-900"
        >
          Beløb i kroner
        </label>
        <input
          id="beloeb"
          type="number"
          min={50}
          max={50000}
          step={1}
          required
          value={beløb}
          onChange={(e) => setBeløb(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
        <p className="mt-1 text-xs text-neutral-500">
          Mindst 50 kr, højst 50.000 kr.
        </p>
      </div>

      {fejl && <p className="text-sm text-red-600">{fejl}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
      >
        {loading ? "Åbner betaling…" : "Indbetal med kort eller MobilePay"}
      </button>
    </form>
  );
}
