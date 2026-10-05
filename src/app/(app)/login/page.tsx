"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { sikkerSti } from "@/lib/sikkerSti";
import { gensendBekraeftelse, logInd } from "@/app/actions/auth";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Kun relative stier - ellers kan ?redirect bruges til phishing-omdirigering.
  const redirectTo = sikkerSti(searchParams.get("redirect"), "/auktioner");
  // Auth-callbacket sender fejl hertil, fx når et nulstillingslink er udløbet.
  // Kun faste koder fra /auth/callback vises - aldrig fri tekst fra URL'en.
  const fejlKode = searchParams.get("fejl");
  const callbackFejl =
    fejlKode === "link_udloebet"
      ? "Linket er udløbet. Bed om et nyt og prøv igen."
      : fejlKode
        ? "Linket virker ikke. Bed om et nyt og prøv igen."
        : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailIkkeBekraeftet, setEmailIkkeBekraeftet] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setEmailIkkeBekraeftet(false);
    setResendSuccess(false);

    // Login sker paa serveren, saa det kan rate-limites (src/app/actions/auth.ts).
    const svar = await logInd(email, password);

    setLoading(false);

    if ("fejl" in svar) {
      setError(svar.fejl);
      if (svar.kode === "email_ikke_bekraeftet") setEmailIkkeBekraeftet(true);
      return;
    }

    const supabase = createClient();

    // Suspenderede konti logges ud igen med besked om årsagen.
    const { data: sessionData } = await supabase.auth.getUser();
    if (sessionData.user) {
      // Suspensionsfelterne er ikke laesbare direkte; min_profil() bruger auth.uid().
      const { data: profilRaekker } = await supabase.rpc("min_profil");
      const profil = (profilRaekker as
        | { suspenderet: boolean; suspenderet_aarsag: string | null; suspenderet_til: string | null }[]
        | null)?.[0];

      // Udløbet suspension ignoreres (ryddes af en medarbejder i admin-panelet).
      const aktivSuspension =
        profil?.suspenderet &&
        (!profil.suspenderet_til || new Date(profil.suspenderet_til) > new Date());

      if (aktivSuspension) {
        await supabase.auth.signOut();
        const varighed = profil.suspenderet_til
          ? `indtil d. ${new Date(profil.suspenderet_til).toLocaleDateString("da-DK")}`
          : "permanent";
        setError(
          `Din konto er suspenderet ${varighed}. Årsag: ${profil.suspenderet_aarsag ?? "Ingen begrundelse angivet"}. Kontakt support@bidhamr.dk hvis du mener, det er en fejl.`,
        );
        return;
      }
    }

    router.push(redirectTo);
    router.refresh();
  }

  async function handleResend() {
    if (!email) return;
    setResendLoading(true);
    setResendSuccess(false);

    const svar = await gensendBekraeftelse(email);

    setResendLoading(false);

    if ("fejl" in svar) {
      setError(svar.fejl);
      return;
    }

    setResendSuccess(true);
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-neutral-200 p-6 sm:p-8">
          <h1 className="text-2xl font-semibold text-neutral-900">
            Log ind
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Velkommen tilbage til BidHamr.
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
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-lg border border-kant-staerk px-4 text-[15px] text-tekst outline-none focus:border-groen focus:ring-1 focus:ring-groen"
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-neutral-900"
                >
                  Adgangskode
                </label>
                <Link
                  href="/glemt-adgangskode"
                  className="text-xs font-medium text-groen hover:underline"
                >
                  Glemt adgangskode?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 h-11 w-full rounded-lg border border-kant-staerk px-4 text-[15px] text-tekst outline-none focus:border-groen focus:ring-1 focus:ring-groen"
              />
            </div>

            {(error ?? callbackFejl) && (
              <p className="text-sm text-fejl-tekst">{error ?? callbackFejl}</p>
            )}

            {emailIkkeBekraeftet && (
              <div>
                {resendSuccess ? (
                  <p className="text-sm text-green-600">
                    Bekræftelsesmail sendt igen – tjek din indbakke.
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resendLoading}
                    className="text-sm font-medium text-groen hover:underline disabled:opacity-50"
                  >
                    {resendLoading ? "Sender…" : "Send bekræftelsesmail igen"}
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading ? "Logger ind…" : "Log ind"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-neutral-500">
          BidHamr åbner snart.{" "}
          <Link href="/coming-soon" className="font-medium text-groen">
            Tilmeld ventelisten
          </Link>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
