"use client";

import Link from "next/link";
import { LOGIN_EMAIL_NOEGLE } from "@/lib/loginEmail";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import type { gemNyAdgangskode } from "@/app/actions/auth";
import { kaldOffentligHandling } from "@/lib/offentligHandling";
import { vurderAdgangskode } from "@/lib/adgangskode";
import AdgangskodeFelt from "@/components/konto/AdgangskodeFelt";
import { FELT, FORMULAR_FEJL, LABEL } from "@/components/konto/felter";
import { ERHVERV_VAELG_ADGANGSKODE as V } from "@/lib/tekster/erhverv";
import { useHydreret } from "@/lib/useHydreret";

// velkommen: kommer fra velkomstmailen til en ny firmakonto
// (src/lib/mails/erhverv.ts) - så hedder det "Vælg din adgangskode".
// signup: e-mailen er lige bekræftet med koden, og brugeren skal vælge sin
// adgangskode og skrive sit navn (src/app/actions/auth.ts, verificerSignupKode):
// navnet fra oprettelsen bruges ikke, når den, der har koden, ikke er den
// samme browser (det kunne være en anden, der oprettede kontoen).
export default function NulstilForm({ velkommen = false, signup = false }: { velkommen?: boolean; signup?: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [passwordGentag, setPasswordGentag] = useState("");
  const [fornavn, setFornavn] = useState("");
  const [efternavn, setEfternavn] = useState("");
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Knappen er slået fra, til siden er hydreret (src/lib/useHydreret.ts).
  const hydreret = useHydreret();
  const [error, setError] = useState<string | null>(null);
  const [klar, setKlar] = useState(false);

  // Linket i mailen logger brugeren ind med en recovery-session.
  // Vent på at sessionen er etableret før formularen kan indsendes.
  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setKlar(true);
        setEmail(data.session.user.email ?? null);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setKlar(true);
        setEmail(session?.user.email ?? null);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // Den gamle fejltekst (fx "mindst 10 tegn") forsvinder, så snart et felt
  // rettes - ellers står den, selvom feltet nu er i orden.
  function medNulstilFejl(saet: (v: string) => void) {
    return (v: string) => {
      saet(v);
      setError(null);
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (signup && !fornavn.replace(/\s+/g, " ").trim()) {
      setError("Skriv dit fornavn.");
      return;
    }
    if (signup && !efternavn.replace(/\s+/g, " ").trim()) {
      setError("Skriv dit efternavn.");
      return;
    }
    const v = vurderAdgangskode(password, { email, navn: signup ? [fornavn, efternavn] : [] });
    if (!v.ok) {
      setError(v.fejl);
      return;
    }
    if (password !== passwordGentag) {
      setError("Adgangskoderne stemmer ikke overens.");
      return;
    }

    setLoading(true);
    // Via /api/offentlig (ikke server action), saa det ogsaa virker for en
    // almindelig bruger, mens siden er lukket (gaten i middleware.ts).
    const fd = new FormData();
    fd.set("password", password);
    if (signup) {
      fd.set("fornavn", fornavn);
      fd.set("efternavn", efternavn);
    }
    const svar = await kaldOffentligHandling<Awaited<ReturnType<typeof gemNyAdgangskode>>>("ny-adgangskode", fd);
    setLoading(false);

    if ("fejl" in svar) {
      setError(svar.fejl);
      return;
    }

    // Serveren har logget ud alle steder; login-siden viser en bekræftelse.
    // En ny firmakonto sendes til Firma oversigt efter login.
    // E-mailen udfyldes på login-siden (kun i denne fane - aldrig i URL'en).
    if (email) {
      try {
        sessionStorage.setItem(LOGIN_EMAIL_NOEGLE, email);
      } catch {
        // Privat tilstand o.l.: så skriver brugeren selv e-mailen.
      }
    }
    router.push(velkommen ? "/login?adgangskode=gemt&velkommen=1&redirect=/firma" : "/login?adgangskode=gemt");
    router.refresh();
  }

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className={`w-full ${velkommen ? "max-w-md" : "max-w-sm"}`}>
        <div className="rounded-none border border-kant bg-white p-5 shadow-kort sm:p-8">
          <h1 className="text-[26px] leading-tight sm:text-[32px]">
            {velkommen ? V.titel : signup ? "Vælg din adgangskode" : "Ny adgangskode"}
          </h1>
          <p className={velkommen ? "mt-2 text-[17px] text-tekst-daempet" : "mt-1 text-sm text-tekst-svag"}>
            {velkommen
              ? V.tekst
              : signup
                ? "Din e-mail er bekræftet. Skriv dit navn, og vælg den adgangskode, du vil logge ind med. Bagefter logger du ind med den."
                : "Vælg en ny adgangskode til din konto."}
          </p>

          {!klar && velkommen && (
            <p className="mt-4 rounded-lg border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-base text-advarsel-tekst">
              {V.venter}
            </p>
          )}
          {!klar && !velkommen && (
            <p className="mt-4 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2.5 text-sm text-advarsel-tekst">
              Venter på bekræftelse af dit nulstillingslink… Hvis du ikke er
              kommet hertil via linket i din e-mail, skal du{" "}
              <Link href="/glemt-adgangskode" className="font-medium underline">
                bestille et nyt link
              </Link>
              .
            </p>
          )}

          <form onSubmit={handleSubmit} method="post" className="mt-6 space-y-4">
            {signup && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="fornavn" className={LABEL}>
                    Fornavn
                  </label>
                  <input
                    id="fornavn"
                    type="text"
                    autoComplete="given-name"
                    required
                    maxLength={100}
                    value={fornavn}
                    onChange={(e) => medNulstilFejl(setFornavn)(e.target.value)}
                    className={`mt-1.5 ${FELT}`}
                  />
                </div>
                <div>
                  <label htmlFor="efternavn" className={LABEL}>
                    Efternavn
                  </label>
                  <input
                    id="efternavn"
                    type="text"
                    autoComplete="family-name"
                    required
                    maxLength={100}
                    value={efternavn}
                    onChange={(e) => medNulstilFejl(setEfternavn)(e.target.value)}
                    className={`mt-1.5 ${FELT}`}
                  />
                </div>
              </div>
            )}
            <AdgangskodeFelt
              id="password"
              label={velkommen ? V.felt : "Ny adgangskode"}
              vaerdi={password}
              onChange={medNulstilFejl(setPassword)}
              ny
              person={{ email }}
            />

            <div>
              <AdgangskodeFelt
                id="password-gentag"
                label={velkommen ? V.feltGentag : "Gentag ny adgangskode"}
                vaerdi={passwordGentag}
                onChange={medNulstilFejl(setPasswordGentag)}
                autoComplete="new-password"
              />
              {passwordGentag && password !== passwordGentag && (
                <p className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
                  Adgangskoderne stemmer ikke overens
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className={FORMULAR_FEJL}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !hydreret || !klar || (!!passwordGentag && password !== passwordGentag)}
              aria-busy={loading || undefined}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              {velkommen ? V.knap : "Gem ny adgangskode"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
