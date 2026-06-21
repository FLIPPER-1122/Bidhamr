"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const [navn, setNavn] = useState("");
  const [email, setEmail] = useState("");
  const [telefon, setTelefon] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { navn, telefon },
      },
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setSuccess(true);
  }

  if (success) {
    return (
      <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
        <div className="w-full max-w-sm rounded-xl border border-neutral-200 p-8 text-center">
          <h1 className="text-xl font-semibold text-neutral-900">
            Tjek din email
          </h1>
          <p className="mt-2 text-sm text-neutral-500">
            Vi har sendt dig en bekræftelseslink. Klik på linket for at
            aktivere din konto, og log derefter ind.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block text-sm font-medium text-brand"
          >
            Gå til login
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
            Opret konto
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Opret en bruger for at byde og sælge på Hamr.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="navn"
                className="block text-sm font-medium text-neutral-900"
              >
                Navn
              </label>
              <input
                id="navn"
                type="text"
                required
                value={navn}
                onChange={(e) => setNavn(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            <div>
              <label
                htmlFor="telefon"
                className="block text-sm font-medium text-neutral-900"
              >
                Telefon
              </label>
              <input
                id="telefon"
                type="tel"
                value={telefon}
                onChange={(e) => setTelefon(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-neutral-900"
              >
                Adgangskode
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:opacity-50"
            >
              {loading ? "Opretter…" : "Opret konto"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-neutral-500">
          Har du allerede en konto?{" "}
          <Link href="/login" className="font-medium text-brand">
            Log ind
          </Link>
        </p>
      </div>
    </main>
  );
}
