"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { opretKonto } from "@/app/actions/auth";
import { vurderAdgangskode } from "@/lib/adgangskode";
import AdgangskodeFelt from "@/components/konto/AdgangskodeFelt";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL, LINK } from "@/components/konto/felter";
import { BETINGELSER_STI, PRIVATLIV_STI, VILKAAR_VERSION } from "@/lib/vilkaar";

type Felt = "fornavn" | "email" | "password" | "vilkaar";

export default function SignupForm() {
  const router = useRouter();
  const [fornavn, setFornavn] = useState("");
  const [efternavn, setEfternavn] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepterer, setAccepterer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [fejlFelt, setFejlFelt] = useState<Felt | null>(null);

  const person = { email, navn: [fornavn, efternavn] };

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    setFejlFelt(null);

    const v = vurderAdgangskode(password, person);
    if (!v.ok) {
      setFejl(v.fejl);
      setFejlFelt("password");
      return;
    }

    if (!accepterer) {
      setFejl("Du skal acceptere brugerbetingelserne for at oprette en konto.");
      setFejlFelt("vilkaar");
      return;
    }

    setLoading(true);
    const svar = await opretKonto({
      fornavn,
      efternavn,
      email,
      password,
      vilkaarVersion: VILKAAR_VERSION,
    });
    if ("fejl" in svar) {
      setLoading(false);
      setFejl(svar.fejl);
      setFejlFelt(svar.felt ?? null);
      return;
    }

    if (svar.bekraeftMail) {
      router.push("/tjek-indbakke");
    } else {
      router.push("/velkommen");
      router.refresh();
    }
  }

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md">
        <div className="rounded-[14px] border border-kant bg-white p-5 shadow-kort sm:p-8">
          <h1 className="text-[26px] leading-tight sm:text-[32px]">Opret konto</h1>
          <p className="mt-1 text-sm text-tekst-daempet">
            Det er gratis. Du betaler kun et gebyr, når du køber eller sælger noget.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
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
                  onChange={(e) => setFornavn(e.target.value)}
                  aria-invalid={fejlFelt === "fornavn" || undefined}
                  className={`mt-1.5 ${FELT} ${fejlFelt === "fornavn" ? FELT_FEJL : ""}`}
                />
              </div>
              <div>
                <label htmlFor="efternavn" className={LABEL}>
                  Efternavn <span className="font-normal text-tekst-svag">(valgfrit)</span>
                </label>
                <input
                  id="efternavn"
                  type="text"
                  autoComplete="family-name"
                  maxLength={100}
                  value={efternavn}
                  onChange={(e) => setEfternavn(e.target.value)}
                  className={`mt-1.5 ${FELT}`}
                />
              </div>
            </div>

            <div>
              <label htmlFor="email" className={LABEL}>
                E-mail
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                maxLength={320}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={fejlFelt === "email" || undefined}
                className={`mt-1.5 ${FELT} ${fejlFelt === "email" ? FELT_FEJL : ""}`}
              />
              <p className="mt-1.5 text-[13px] text-tekst-daempet">
                Vi sender et link, som du skal klikke på for at bekræfte din e-mail.
              </p>
            </div>

            <AdgangskodeFelt
              id="password"
              label="Adgangskode"
              vaerdi={password}
              onChange={setPassword}
              ny
              person={person}
              fejl={fejlFelt === "password" ? fejl : null}
            />

            <div>
              <div className="flex items-start gap-3">
                <input
                  id="vilkaar"
                  type="checkbox"
                  required
                  checked={accepterer}
                  onChange={(e) => {
                    setAccepterer(e.target.checked);
                    if (e.target.checked && fejlFelt === "vilkaar") {
                      setFejl(null);
                      setFejlFelt(null);
                    }
                  }}
                  aria-invalid={fejlFelt === "vilkaar" || undefined}
                  aria-describedby="vilkaar-privatliv"
                  className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-groen"
                />
                <label htmlFor="vilkaar" className="cursor-pointer text-sm leading-snug text-tekst">
                  Jeg accepterer BidHamrs{" "}
                  <a href={BETINGELSER_STI} target="_blank" rel="noopener" className={LINK}>
                    brugerbetingelser
                    <span className="sr-only"> (åbner i et nyt vindue)</span>
                  </a>
                </label>
              </div>
              <p id="vilkaar-privatliv" className="mt-1.5 pl-8 text-[13px] text-tekst-daempet">
                Læs hvordan vi behandler dine oplysninger i{" "}
                <a href={PRIVATLIV_STI} target="_blank" rel="noopener" className={LINK}>
                  privatlivspolitikken
                  <span className="sr-only"> (åbner i et nyt vindue)</span>
                </a>
                .
              </p>
            </div>

            {fejl && fejlFelt !== "password" && (
              <p role="alert" className={FORMULAR_FEJL}>
                {fejl}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              aria-busy={loading || undefined}
              className="btn btn-primaer btn-stor w-full"
            >
              {loading && <span className="btn-spinner" aria-hidden="true" />}
              Opret konto
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-tekst-svag">
          Har du allerede en konto?{" "}
          <Link href="/login" className={LINK}>
            Log ind
          </Link>
        </p>
      </div>
    </main>
  );
}
