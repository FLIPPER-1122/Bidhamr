"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { nulstilAdgangskode } from "@/app/actions/auth";

export default function GlemtAdgangskodePage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Sendes fra serveren, saa det kan rate-limites (src/app/actions/auth.ts).
    const svar = await nulstilAdgangskode(email);

    setLoading(false);

    if ("fejl" in svar) {
      setError(svar.fejl);
      return;
    }

    setSendt(true);
  }

  if (sendt) {
    return (
      <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
        <div className="w-full max-w-sm rounded-xl border border-neutral-200 p-6 text-center sm:p-8">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-neutral-900">Tjek din email</h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Hvis <span className="font-medium text-neutral-700">{email}</span> er
            registreret hos os, har vi sendt et link til at nulstille din
            adgangskode.
          </p>
          <Link
            href="/login"
            className="btn btn-primaer btn-stor mt-6 w-full sm:w-auto"
          >
            Tilbage til login
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-neutral-200 p-6 sm:p-8">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Glemt adgangskode
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Indtast din email, så sender vi dig et link til at nulstille din
            adgangskode.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-neutral-900"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="din@email.dk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-lg border border-kant-staerk px-4 text-[15px] text-tekst outline-none placeholder:text-pladsholder focus:border-groen focus:ring-1 focus:ring-groen"
              />
            </div>

            {error && <p className="text-sm text-fejl-tekst">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading ? "Sender…" : "Send nulstillingslink"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-neutral-500">
          Kom du i tanke om den?{" "}
          <Link href="/login" className="font-medium text-groen">
            Log ind
          </Link>
        </p>
      </div>
    </main>
  );
}
