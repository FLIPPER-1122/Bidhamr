"use client";

import { useState } from "react";

export default function BetalKnap({ auktionId }: { auktionId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auktionId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Kunne ikke starte betalingen.");
      }

      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noget gik galt.");
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        className="w-full rounded-lg bg-brand px-6 py-3 text-base font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
      >
        {loading ? "Sender dig til Stripe…" : "Betal nu"}
      </button>

      {error && (
        <div className="mt-3 border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
