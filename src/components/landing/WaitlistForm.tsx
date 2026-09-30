"use client";

import { useState, type FormEvent } from "react";

const GENERISK_FEJL = "Vi kunne ikke skrive dig op lige nu. Prøv igen om lidt.";

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

      if (!res.ok) {
        // Kun serverens egne, faste valideringsbeskeder (400) vises. Alt andet
        // giver en fast besked, så rå fejltekst aldrig når brugeren.
        let besked = GENERISK_FEJL;
        if (res.status === 400) {
          const data = await res.json().catch(() => null);
          if (data && typeof data.error === "string") besked = data.error;
        }
        setError(besked);
        return;
      }

      setSuccess(true);
      setEmail("");
    } catch (err) {
      console.error("Venteliste-tilmelding fejlede:", err);
      setError(GENERISK_FEJL);
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
        Ingen spam. Vi skriver kun, når vi åbner.
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
