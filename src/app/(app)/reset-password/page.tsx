"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";

export default function NulstilAdgangskodePage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [passwordGentag, setPasswordGentag] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gemt, setGemt] = useState(false);
  const [klar, setKlar] = useState(false);

  // Linket i mailen logger brugeren ind med en recovery-session.
  // Vent på at sessionen er etableret før formularen kan indsendes.
  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setKlar(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setKlar(true);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== passwordGentag) {
      setError("Adgangskoderne stemmer ikke overens.");
      return;
    }
    if (password.length < 6) {
      setError("Adgangskoden skal være mindst 6 tegn.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setGemt(true);
    // Log ud af recovery-sessionen og send brugeren til login med den nye kode.
    await supabase.auth.signOut();
    setTimeout(() => {
      router.push("/login");
      router.refresh();
    }, 2500);
  }

  if (gemt) {
    return (
      <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
        <div className="w-full max-w-sm rounded-xl border border-neutral-200 p-6 text-center sm:p-8">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-neutral-900">
            Adgangskode gemt
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            Din adgangskode er opdateret. Du bliver sendt til login…
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38]"
          >
            Gå til login nu
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
            Ny adgangskode
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Vælg en ny adgangskode til din konto.
          </p>

          {!klar && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              Venter på bekræftelse af dit nulstillingslink… Hvis du ikke er
              kommet hertil via linket i din email, skal du{" "}
              <Link href="/glemt-adgangskode" className="font-medium underline">
                bestille et nyt link
              </Link>
              .
            </p>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-neutral-900"
              >
                Ny adgangskode
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={6}
                autoComplete="new-password"
                placeholder="Mindst 6 tegn"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-brand focus:ring-1 focus:ring-brand"
              />
            </div>

            <div>
              <label
                htmlFor="password-gentag"
                className="block text-sm font-medium text-neutral-900"
              >
                Gentag ny adgangskode
              </label>
              <input
                id="password-gentag"
                type="password"
                required
                autoComplete="new-password"
                placeholder="Gentag adgangskode"
                value={passwordGentag}
                onChange={(e) => setPasswordGentag(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-brand focus:ring-1 focus:ring-brand"
              />
              {passwordGentag && password !== passwordGentag && (
                <p className="mt-1.5 text-xs text-red-500">
                  Adgangskoderne stemmer ikke overens
                </p>
              )}
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading || !klar || (!!passwordGentag && password !== passwordGentag)}
              className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#d62b38] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Gemmer…" : "Gem ny adgangskode"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
