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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "email-fejl" : "email-hjaelp"}
          className={`h-13 min-w-0 flex-1 rounded-xl border bg-white px-4 text-[15px] text-tekst outline-none transition-colors placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 ${
            error ? "border-fejl-kant" : "border-kant-staerk hover:border-[#BFBFBF]"
          }`}
        />
        <button
          type="submit"
          disabled={loading}
          aria-busy={loading}
          className="btn btn-primaer btn-stor shrink-0"
        >
          {loading && <span className="btn-spinner" aria-hidden />}
          Tilmeld venteliste
        </button>
      </div>

      <p id="email-hjaelp" className="mt-3 text-[13px] text-tekst-daempet">
        Ingen spam. Vi skriver kun, når vi er klar til launch.
      </p>

      {success && (
        <p
          className="mt-3 rounded-xl border border-succes-kant bg-succes-bg px-4 py-3 text-sm font-medium text-succes-tekst"
          role="status"
        >
          Tak — du er på ventelisten!
        </p>
      )}
      {error && (
        <p
          id="email-fejl"
          className="mt-3 text-[13px] font-medium text-fejl-tekst"
          role="alert"
        >
          {error}
        </p>
      )}
    </form>
  );
}
