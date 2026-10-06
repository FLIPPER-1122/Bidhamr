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
      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
        <div className="w-full max-w-sm rounded-[14px] border border-kant bg-white p-5 text-center shadow-kort sm:p-8">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-succes-bg">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-succes-tekst" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-[20px] leading-tight lg:text-[22px]">Tjek din e-mail</h1>
          <p className="mt-2 text-sm leading-relaxed text-tekst-svag">
            Hvis <span className="font-medium text-tekst-daempet">{email}</span> er
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
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-sm">
        <div className="rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8">
          <h1 className="text-[26px] leading-tight sm:text-[32px]">
            Glemt adgangskode
          </h1>
          <p className="mt-1 text-sm text-tekst-svag">
            Indtast din e-mail, så sender vi dig et link til at nulstille din
            adgangskode.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-tekst"
              >
                E-mail
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="din@email.dk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-xl border border-kant-staerk px-4 text-[15px] text-tekst placeholder:text-pladsholder bg-white hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
              />
            </div>

            {error && (
              <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading || undefined}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              Send nulstillingslink
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-tekst-svag">
          Kom du i tanke om den?{" "}
          <Link href="/login" className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen">
            Log ind
          </Link>
        </p>
      </div>
    </main>
  );
}
