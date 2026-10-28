"use client";

import HenvisningLink from "@/components/henvisning/HenvisningLink";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { opretKonto } from "@/app/actions/auth";
import { vurderAdgangskode } from "@/lib/adgangskode";
import AdgangskodeFelt from "@/components/konto/AdgangskodeFelt";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL, LINK } from "@/components/konto/felter";
import { BETINGELSER_STI, PRIVATLIV_STI, VILKAAR_VERSION } from "@/lib/vilkaar";
import { useHydreret } from "@/lib/useHydreret";
import { medHenvisning, renHenvisningskode } from "@/lib/henvisning/kode";
import { HENVISNING_TEKST } from "@/lib/tekster/henvisning";
import Turnstile from "@/components/Turnstile";
import { CAPTCHA_MANGLER, turnstileAktiv } from "@/lib/turnstile";
import AdresseFelter from "@/components/konto/AdresseFelter";
import { validerAdresse } from "@/lib/adresse/regler";

type Felt = "fornavn" | "efternavn" | "adresse" | "postnummer" | "email" | "password" | "vilkaar" | "henvisningskode";

// Samme regel som på serveren (renNavn i actions/auth.ts): mellemrum samles og
// trimmes, før vi tjekker, om feltet er tomt.
function renset(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

// kunInviterede: tilmeldingen er lukket, og kun inviterede beta-testere kan
// oprette sig (serveren og databasen tjekker invitationen).
// henvisningskode: koden fra ?ven=KODE (Henvis en ven). Vises i et synligt,
// valgfrit felt, som vennen kan rette eller slette - intet gemmes i
// browseren. Koden sendes videre i adressen til "Indtast koden" og knyttes
// først, når e-mailen er bekræftet (verificerSignupKode).
export default function SignupForm({
  kunInviterede = false,
  henvisningskode = "",
}: {
  kunInviterede?: boolean;
  henvisningskode?: string;
}) {
  const router = useRouter();
  const [fornavn, setFornavn] = useState("");
  const [efternavn, setEfternavn] = useState("");
  // Adressen til fakturaer (påkrævet). Byen udfyldes ud fra postnummeret.
  const [adresse, setAdresse] = useState("");
  const [postnummer, setPostnummer] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepterer, setAccepterer] = useState(false);
  const [henvKode, setHenvKode] = useState(henvisningskode);
  const [loading, setLoading] = useState(false);
  // Knappen er slået fra, til siden er hydreret (src/lib/useHydreret.ts).
  const hydreret = useHydreret();
  const [fejl, setFejl] = useState<string | null>(null);
  const [fejlFelt, setFejlFelt] = useState<Felt | null>(null);

  // Turnstile (CAPTCHA) - kun når NEXT_PUBLIC_TURNSTILE_SITE_KEY er sat.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNulstil, setCaptchaNulstil] = useState(0);

  const person = { email, navn: [fornavn, efternavn] };

  // Viser fejlen og flytter fokus til feltet, så skærmlæsere og mobil
  // lander det rigtige sted.
  function visFejl(besked: string, felt: Felt | null) {
    setFejl(besked);
    setFejlFelt(felt);
    if (felt) requestAnimationFrame(() => document.getElementById(felt)?.focus());
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    setFejlFelt(null);

    if (!renset(fornavn)) {
      visFejl("Skriv dit fornavn.", "fornavn");
      return;
    }
    if (!renset(efternavn)) {
      visFejl("Skriv dit efternavn.", "efternavn");
      return;
    }
    const adr = validerAdresse({ adresse, postnummer });
    if ("fejl" in adr) {
      visFejl(adr.fejl, adr.felt);
      return;
    }

    const v = vurderAdgangskode(password, person);
    if (!v.ok) {
      visFejl(v.fejl ?? "Vælg en anden adgangskode.", "password");
      return;
    }

    if (!accepterer) {
      visFejl("Du skal acceptere brugerbetingelserne for at oprette en konto.", "vilkaar");
      return;
    }

    const renKode = henvKode.trim() ? renHenvisningskode(henvKode) : null;
    if (henvKode.trim() && !renKode) {
      visFejl(HENVISNING_TEKST.signupKodeUgyldig, "henvisningskode");
      return;
    }

    if (turnstileAktiv() && !captchaToken) {
      visFejl(CAPTCHA_MANGLER, null);
      return;
    }

    setLoading(true);
    const svar = await opretKonto({
      fornavn,
      efternavn,
      adresse,
      postnummer,
      email,
      password,
      vilkaarVersion: VILKAAR_VERSION,
      captchaToken: captchaToken ?? undefined,
      henvisningskode: renKode ?? undefined,
    });
    if ("fejl" in svar) {
      // Tokenet er brugt - et nyt til næste forsøg.
      setCaptchaNulstil((n) => n + 1);
      setLoading(false);
      visFejl(svar.fejl, svar.felt ?? null);
      return;
    }

    if (svar.bekraeftMail) {
      // Beta: samme svar, uanset om e-mailen er inviteret (ingen afsløring).
      // Henvisningskoden følger med i adressen (ingen cookie).
      router.push(medHenvisning(svar.beta ? "/tjek-indbakke?fra=beta" : "/tjek-indbakke", renKode));
    } else {
      router.push("/velkommen");
      router.refresh();
    }
  }

  return (
    <main className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center sm:py-12">
      <div className="w-full max-w-md">
        <div className="rounded-none border border-kant bg-white p-5 shadow-kort sm:p-8">
          <h1 className="text-[26px] leading-tight sm:text-[32px]">Opret konto</h1>
          <p className="mt-1 text-sm text-tekst-daempet">
            Det er gratis. Du betaler kun et gebyr, når du køber eller sælger noget.
          </p>

          {kunInviterede && (
            <p role="note" className="mt-4 rounded-xl border border-info-kant bg-info-bg p-4 text-sm text-info-tekst">
              BidHamr er i lukket beta-test. Du kan kun oprette en konto med den e-mail, du har fået en invitation på.
            </p>
          )}

          <form onSubmit={handleSubmit} method="post" className="mt-6 space-y-4" noValidate>
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
                  Efternavn
                </label>
                <input
                  id="efternavn"
                  type="text"
                  autoComplete="family-name"
                  required
                  maxLength={100}
                  value={efternavn}
                  onChange={(e) => setEfternavn(e.target.value)}
                  aria-invalid={fejlFelt === "efternavn" || undefined}
                  className={`mt-1.5 ${FELT} ${fejlFelt === "efternavn" ? FELT_FEJL : ""}`}
                />
              </div>
            </div>

            <AdresseFelter
              adresse={adresse}
              postnummer={postnummer}
              onAdresse={setAdresse}
              onPostnummer={setPostnummer}
              fejlFelt={fejlFelt === "adresse" || fejlFelt === "postnummer" ? fejlFelt : null}
            />

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
                Vi sender en kode, som du skal indtaste for at bekræfte din e-mail.
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
              <label htmlFor="henvisningskode" className={LABEL}>
                {HENVISNING_TEKST.signupFelt} <span className="font-normal text-tekst-daempet">(valgfri)</span>
              </label>
              <input
                id="henvisningskode"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={20}
                value={henvKode}
                onChange={(e) => {
                  setHenvKode(e.target.value);
                  if (fejlFelt === "henvisningskode") {
                    setFejl(null);
                    setFejlFelt(null);
                  }
                }}
                aria-invalid={fejlFelt === "henvisningskode" || undefined}
                aria-describedby="henvisningskode-hjaelp"
                className={`mt-1.5 ${FELT} uppercase ${fejlFelt === "henvisningskode" ? FELT_FEJL : ""}`}
              />
              <p id="henvisningskode-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
                {HENVISNING_TEKST.signupHjaelp}
              </p>
            </div>

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

            <Turnstile handling="opret" onToken={setCaptchaToken} nulstil={captchaNulstil} />

            {fejl && fejlFelt !== "password" && (
              <p role="alert" className={FORMULAR_FEJL}>
                {fejl}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !hydreret}
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
          <HenvisningLink href="/login" className={LINK}>
            Log ind
          </HenvisningLink>
        </p>
      </div>
    </main>
  );
}
