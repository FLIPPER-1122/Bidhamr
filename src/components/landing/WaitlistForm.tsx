"use client";

import { useState, type FormEvent } from "react";

export default function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!email.trim()) {
      setError("Indtast venligst din e-mail.");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Indtast en gyldig e-mailadresse.");
      }

      setSuccess(true);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Noget gik galt.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 max-w-md">
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <label htmlFor="email" className="sr-only">
          E-mail
        </label>
        <input
          id="email"
          name="email"
          type="email"
          placeholder="din@email.dk"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setError(null);
            setSuccess(false);
          }}
          className={`min-w-0 flex-1 rounded-full border px-4 py-3.5 text-sm text-neutral-900 outline-none transition-colors focus:ring-2 focus:ring-brand ${
            error ? "border-brand" : "border-neutral-200 focus:border-brand"
          }`}
        />
        <button
          type="submit"
          disabled={loading}
          className="shrink-0 rounded-full bg-brand px-6 py-3.5 text-sm font-semibold text-white hover:bg-[#c62832] disabled:opacity-50"
        >
          {loading ? "Tilmelder…" : "Tilmeld venteliste"}
        </button>
      </div>

      <p className="mt-3 text-[13px] text-neutral-400">
        Ingen spam. Vi skriver kun, når vi er klar til launch.
      </p>

      {success && (
        <p className="mt-3 text-sm font-semibold text-emerald-600" role="status">
          Tak — du er på ventelisten!
        </p>
      )}
      {error && (
        <p className="mt-3 text-[13px] text-brand" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
