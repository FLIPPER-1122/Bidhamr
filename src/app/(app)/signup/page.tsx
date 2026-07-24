"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function EjeIkon({ vis }: { vis: boolean }) {
  return vis ? (
    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0 1 12 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 0 1 1.563-3.029m5.858.908a3 3 0 1 1 4.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88 6.59 6.59m7.532 7.532 3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0 1 12 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 0 1-4.132 5.411m0 0L21 21" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

export default function SignupPage() {
  const router = useRouter();
  const [fornavn, setFornavn] = useState("");
  const [efternavn, setEfternavn] = useState("");
  const [email, setEmail] = useState("");
  const [telefon, setTelefon] = useState("");
  const [password, setPassword] = useState("");
  const [passwordGentag, setPasswordGentag] = useState("");
  const [visPassword, setVisPassword] = useState(false);
  const [visPasswordGentag, setVisPasswordGentag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

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
    const fuldeNavn = [fornavn.trim(), efternavn.trim()].filter(Boolean).join(" ");

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        data: { fornavn: fornavn.trim(), efternavn: efternavn.trim(), navn: fuldeNavn },
      },
    });

    if (signUpError) {
      setLoading(false);
      if (signUpError.message.toLowerCase().includes("already")) {
        setError("Denne email er allerede i brug. Prøv at logge ind.");
      } else {
        setError(signUpError.message);
      }
      return;
    }

    if (data.user) {
      await supabase.from("users").upsert({
        id: data.user.id,
        navn: fuldeNavn,
        fornavn: fornavn.trim(),
        efternavn: efternavn.trim() || null,
        email: email.trim().toLowerCase(),
        telefon: telefon.trim() ? `+45${telefon.trim()}` : null,
        rolle: "bruger",
      });
    }

    setLoading(false);
    setSuccess(true);
  }

  if (success) {
    return (
      <main className="flex min-h-[calc(100vh-78px)] items-center justify-center bg-neutral-50 px-4 py-12">
        <div className="w-full max-w-md rounded-2xl bg-white p-10 text-center shadow-[0_2px_16px_rgba(0,0,0,0.08)]">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
            <svg viewBox="0 0 24 24" className="h-7 w-7 text-green-600" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-neutral-900">Tjek din email</h1>
          <p className="mt-2 text-sm text-neutral-500 leading-relaxed">
            Vi har sendt dig et bekræftelseslink til <span className="font-medium text-neutral-700">{email}</span>.
            Du skal bekræfte din email, før du kan logge ind.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded-xl bg-brand px-8 py-3 text-sm font-semibold text-white hover:bg-[#d62b38] transition-colors"
          >
            Gå til login
          </Link>
        </div>
      </main>
    );
  }

  const inputKlasse =
    "mt-1.5 w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20";

  return (
    <main className="flex min-h-[calc(100vh-78px)] items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 text-center">
          <span className="text-3xl font-extrabold tracking-tight text-brand">BidHamr</span>
          <p className="mt-1.5 text-sm text-neutral-500">Opret din konto gratis og begynd at handle</p>
        </div>

        {/* Kort */}
        <div className="rounded-2xl bg-white p-8 shadow-[0_2px_16px_rgba(0,0,0,0.08)] sm:p-10">
          <h1 className="text-xl font-bold text-neutral-900">Opret konto</h1>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            {/* Fornavn + Efternavn */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="fornavn" className="block text-sm font-medium text-neutral-700">
                  Fornavn <span className="text-brand">*</span>
                </label>
                <input
                  id="fornavn"
                  type="text"
                  required
                  autoComplete="given-name"
                  placeholder="Fornavn"
                  value={fornavn}
                  onChange={(e) => setFornavn(e.target.value)}
                  className={inputKlasse}
                />
              </div>
              <div>
                <label htmlFor="efternavn" className="block text-sm font-medium text-neutral-700">
                  Efternavn
                </label>
                <input
                  id="efternavn"
                  type="text"
                  autoComplete="family-name"
                  placeholder="Efternavn"
                  value={efternavn}
                  onChange={(e) => setEfternavn(e.target.value)}
                  className={inputKlasse}
                />
              </div>
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-neutral-700">
                Email <span className="text-brand">*</span>
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="din@email.dk"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputKlasse}
              />
            </div>

            {/* Telefon */}
            <div>
              <label htmlFor="telefon" className="block text-sm font-medium text-neutral-700">
                Telefonnummer
              </label>
              <div className="relative mt-1.5 flex">
                <span className="flex items-center rounded-l-xl border border-r-0 border-neutral-200 bg-neutral-100 px-3 text-sm text-neutral-500 select-none">
                  +45
                </span>
                <input
                  id="telefon"
                  type="tel"
                  autoComplete="tel"
                  placeholder="12 34 56 78"
                  value={telefon}
                  maxLength={8}
                  onChange={(e) => {
                    const kun = e.target.value.replace(/\D/g, "").slice(0, 8);
                    setTelefon(kun);
                  }}
                  className="w-full rounded-r-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
                />
              </div>
            </div>

            {/* Adgangskode */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-neutral-700">
                Adgangskode <span className="text-brand">*</span>
              </label>
              <div className="relative mt-1.5">
                <input
                  id="password"
                  type={visPassword ? "text" : "password"}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  placeholder="Mindst 6 tegn"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 pr-11 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
                />
                <button
                  type="button"
                  onClick={() => setVisPassword(!visPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                  tabIndex={-1}
                >
                  <EjeIkon vis={visPassword} />
                </button>
              </div>
            </div>

            {/* Gentag adgangskode */}
            <div>
              <label htmlFor="password-gentag" className="block text-sm font-medium text-neutral-700">
                Gentag adgangskode <span className="text-brand">*</span>
              </label>
              <div className="relative mt-1.5">
                <input
                  id="password-gentag"
                  type={visPasswordGentag ? "text" : "password"}
                  required
                  autoComplete="new-password"
                  placeholder="Gentag adgangskode"
                  value={passwordGentag}
                  onChange={(e) => setPasswordGentag(e.target.value)}
                  className={`w-full rounded-xl border bg-neutral-50 px-4 py-3 pr-11 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:bg-white focus:ring-2 ${
                    passwordGentag && password !== passwordGentag
                      ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                      : passwordGentag && password === passwordGentag
                        ? "border-green-300 focus:border-green-400 focus:ring-green-200"
                        : "border-neutral-200 focus:border-brand focus:ring-brand/20"
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setVisPasswordGentag(!visPasswordGentag)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
                  tabIndex={-1}
                >
                  <EjeIkon vis={visPasswordGentag} />
                </button>
              </div>
              {passwordGentag && password !== passwordGentag && (
                <p className="mt-1.5 text-xs text-red-500">Adgangskoderne stemmer ikke overens</p>
              )}
              {passwordGentag && password === passwordGentag && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-green-600">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Adgangskoderne matcher
                </p>
              )}
            </div>

            {/* Fejlbesked */}
            {error && (
              <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="10" />
                  <path strokeLinecap="round" d="M12 8v4m0 4h.01" />
                </svg>
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || (!!passwordGentag && password !== passwordGentag)}
              className="w-full rounded-xl bg-brand py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#d62b38] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
                  </svg>
                  Opretter konto…
                </span>
              ) : (
                "Opret konto"
              )}
            </button>
          </form>
        </div>

        {/* Log ind-link */}
        <p className="mt-6 text-center text-sm text-neutral-500">
          Har du allerede en konto?{" "}
          <Link href="/login" className="font-semibold text-brand hover:underline">
            Log ind
          </Link>
        </p>
      </div>
    </main>
  );
}
