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
      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
        <div className="w-full max-w-sm rounded-[14px] border border-kant bg-white p-5 text-center shadow-kort sm:p-8">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-succes-bg">
            <svg viewBox="0 0 24 24" className="h-6 w-6 text-succes-tekst" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-[20px] leading-tight lg:text-[22px]">
            Adgangskode gemt
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-tekst-svag">
            Din adgangskode er opdateret. Du bliver sendt til login…
          </p>
          <Link
            href="/login"
            className="btn btn-primaer btn-stor mt-6 w-full sm:w-auto"
          >
            Gå til login nu
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
            Ny adgangskode
          </h1>
          <p className="mt-1 text-sm text-tekst-svag">
            Vælg en ny adgangskode til din konto.
          </p>

          {!klar && (
            <p className="mt-4 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2.5 text-sm text-advarsel-tekst">
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
                className="block text-sm font-medium text-tekst"
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
                className="mt-1.5 h-11 w-full rounded-xl border border-kant-staerk px-4 text-[15px] text-tekst placeholder:text-pladsholder bg-white hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
              />
            </div>

            <div>
              <label
                htmlFor="password-gentag"
                className="block text-sm font-medium text-tekst"
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
                className="mt-1.5 h-11 w-full rounded-xl border border-kant-staerk px-4 text-[15px] text-tekst placeholder:text-pladsholder bg-white hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
              />
              {passwordGentag && password !== passwordGentag && (
                <p className="mt-1.5 text-xs text-fejl-tekst">
                  Adgangskoderne stemmer ikke overens
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !klar || (!!passwordGentag && password !== passwordGentag)}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading ? "Gemmer…" : "Gem ny adgangskode"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
