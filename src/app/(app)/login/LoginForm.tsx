"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { LOGIN_EMAIL_NOEGLE } from "@/lib/loginEmail";
import { sikkerSti } from "@/lib/sikkerSti";
import { logInd } from "@/app/actions/auth";
import { FELT, FORMULAR_FEJL, LABEL, LINK } from "@/components/konto/felter";
import { ERHVERV_LOGIN } from "@/lib/tekster/erhverv";
import { useHydreret } from "@/lib/useHydreret";
import Turnstile from "@/components/Turnstile";
import { CAPTCHA_MANGLER, turnstileAktiv } from "@/lib/turnstile";

// betaAaben: tilmeldingen er lukket, men beta-testen er åben - så vises et
// link til "Opret konto" for inviterede.
export default function LoginForm({
  tilmeldingAaben,
  betaAaben = false,
}: {
  tilmeldingAaben: boolean;
  betaAaben?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Kun relative stier - ellers kan ?redirect bruges til phishing-omdirigering.
  // Uden ?redirect lander en firmakonto på /firma, alle andre på /auktioner.
  const redirectParam = searchParams.get("redirect");
  const redirectTo = sikkerSti(redirectParam, "/auktioner");
  // Auth-callbacket sender fejl hertil, fx når et nulstillingslink er udløbet.
  // Kun faste koder fra /auth/callback vises - aldrig fri tekst fra URL'en.
  const fejlKode = searchParams.get("fejl");
  const callbackFejl =
    fejlKode === "velkommen_udloebet"
      ? ERHVERV_LOGIN.velkommenUdloebet
      : fejlKode === "link_udloebet"
      ? "Linket er udløbet. Bed om et nyt og prøv igen."
      : fejlKode === "konto_suspenderet"
        ? "Din konto er suspenderet. Kontakt support@bidhamr.dk, hvis du mener, det er en fejl."
      : fejlKode
        ? "Linket virker ikke. Bed om et nyt og prøv igen."
        : null;
  const adgangskodeGemt = searchParams.get("adgangskode") === "gemt";
  // Ny firmakonto, der lige har valgt sin adgangskode (velkomstmailen).
  const velkommenFirma = adgangskodeGemt && searchParams.get("velkommen") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Lige efter "Vælg din adgangskode"/"Ny adgangskode": e-mailen er kendt og
  // udfyldes (gemt i sessionStorage af NulstilForm, læses én gang). Efter
  // mount, så server- og klient-render er ens.
  useEffect(() => {
    if (!adgangskodeGemt) return;
    const t = setTimeout(() => {
      try {
        const gemt = sessionStorage.getItem(LOGIN_EMAIL_NOEGLE);
        sessionStorage.removeItem(LOGIN_EMAIL_NOEGLE);
        if (gemt) setEmail((nu) => nu || gemt);
      } catch {
        // sessionStorage er ikke tilgængelig - brugeren skriver selv e-mailen.
      }
    }, 0);
    return () => clearTimeout(t);
  }, [adgangskodeGemt]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forkertLogin, setForkertLogin] = useState(false);
  // Knappen er slået fra, til siden er hydreret: ellers kan et tidligt
  // submit sendes af browseren selv (src/lib/useHydreret.ts).
  const hydreret = useHydreret();

  // Turnstile (CAPTCHA) - kun når NEXT_PUBLIC_TURNSTILE_SITE_KEY er sat.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNulstil, setCaptchaNulstil] = useState(0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setForkertLogin(false);
    if (turnstileAktiv() && !captchaToken) {
      setError(CAPTCHA_MANGLER);
      return;
    }
    setLoading(true);

    // Login sker på serveren, så det kan rate-limites og tjekkes for
    // suspension og ny enhed (src/app/actions/auth.ts).
    const svar = await logInd(email, password, captchaToken ?? undefined);

    if ("fejl" in svar) {
      // Tokenet er brugt - et nyt til næste forsøg.
      setCaptchaNulstil((n) => n + 1);
      // Ubekræftet e-mail: serveren har gemt e-mailen i en httpOnly cookie,
      // og koden fra mailen indtastes på /tjek-indbakke (hvor man også kan
      // få en ny kode).
      if (svar.kode === "email_ikke_bekraeftet") {
        router.push("/tjek-indbakke?fra=login");
        return;
      }
      setLoading(false);
      setError(svar.fejl);
      setForkertLogin(svar.kode === "forkert_login");
      return;
    }

    const maal = svar.firma && !redirectParam ? "/firma" : redirectTo;
    // Route handlers (fx /api/mitid/start) skal have en fuld sideindlæsning:
    // router.push henter dem som RSC (to gange) og derefter som side, så
    // handleren køres tre gange - fx tre MitID-forløb. maal er allerede
    // valideret af sikkerSti ovenfor.
    if (maal.startsWith("/api/") || maal.startsWith("/auth/")) {
      window.location.assign(maal);
      return;
    }
    router.push(maal);
    router.refresh();
  }

  const fejlTekst = error ?? callbackFejl;

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-sm">
        <div className="rounded-none border border-kant bg-white p-5 shadow-kort sm:p-8">
          <h1 className="text-[26px] leading-tight sm:text-[32px]">Log ind</h1>
          <p className="mt-1 text-sm text-tekst-svag">
            {velkommenFirma ? ERHVERV_LOGIN.undertitelVelkommen : "Velkommen tilbage til BidHamr."}
          </p>

          {adgangskodeGemt && !fejlTekst && (
            <p
              role="status"
              className={`mt-4 rounded-xl border border-succes-kant bg-succes-bg p-4 text-succes-tekst ${velkommenFirma ? "text-[17px] font-semibold" : "text-sm"}`}
            >
              {velkommenFirma ? ERHVERV_LOGIN.adgangskodeGemt : "Din nye adgangskode er gemt. Log ind med den her."}
            </p>
          )}

          <form onSubmit={handleSubmit} method="post" className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className={LABEL}>
                E-mail
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`mt-1.5 ${FELT}`}
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="password" className={LABEL}>
                  Adgangskode
                </label>
                <Link
                  href="/glemt-adgangskode"
                  className="inline-flex min-h-11 items-center rounded-md text-[13px] font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
                >
                  Glemt adgangskode?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`mt-1.5 ${FELT}`}
              />
            </div>

            <Turnstile handling="login" onToken={setCaptchaToken} nulstil={captchaNulstil} />

            {fejlTekst && (
              <p role="alert" className={FORMULAR_FEJL}>
                {fejlTekst}
                {/* Beta: en ny konto har ingen kendt adgangskode, før koden
                    er indtastet (src/lib/ventendeAdgangskode.ts). Vises ved
                    alle forkerte logins - afslører ikke, om kontoen findes. */}
                {betaAaben && forkertLogin && (
                  <>
                    {" "}
                    Har du lige oprettet dig?{" "}
                    <Link href="/tjek-indbakke" className="font-semibold underline">
                      Indtast koden fra mailen.
                    </Link>
                  </>
                )}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !hydreret}
              aria-busy={loading || undefined}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              Log ind
            </button>
          </form>
        </div>

        {adgangskodeGemt ? null : tilmeldingAaben ? (
          <p className="mt-6 text-center text-sm text-tekst-svag">
            Har du ikke en konto?{" "}
            <Link href="/signup" className={LINK}>
              Opret konto
            </Link>
          </p>
        ) : betaAaben ? (
          <p className="mt-6 text-center text-sm text-tekst-svag">
            Inviteret til beta-testen?{" "}
            <Link href="/signup" className={LINK}>
              Opret konto
            </Link>
          </p>
        ) : (
          <p className="mt-6 text-center text-sm text-tekst-svag">
            BidHamr åbner snart.{" "}
            <Link href="/coming-soon" className={LINK}>
              Tilmeld ventelisten
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
