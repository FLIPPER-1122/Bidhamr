"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { bekraeftEmailSkift, sendEmailSkiftKode } from "@/app/actions/emailSkift";
import { useHydreret } from "@/lib/useHydreret";
import AdgangskodeFelt from "./AdgangskodeFelt";
import { FELT, FELT_FEJL, FORMULAR_FEJL, LABEL, SUCCES_BOKS } from "./felter";

// Skift af e-mail under Indstillinger (src/lib/emailSkift.ts):
//   1. "Ny e-mail" + "Nuværende adgangskode" -> "Send kode"
//   2. Koden fra mailen til den nye adresse -> "Bekræft"
//   3. Kvitteringen "Din e-mail er ændret".
// Svaret i trin 1 er det samme, uanset om adressen er i brug.
// Firmakonti skifter ikke selv e-mail - de ser kun teksten om at kontakte
// BidHamr (serveren afviser det også, kode "firma").
type Trin = "lukket" | "formular" | "kode";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const FIRMA_EMAIL_TEKST = "Kontakt BidHamr for at skifte e-mail på en firmakonto.";

export default function SkiftEmail({ email, erFirma = false }: { email: string; erFirma?: boolean }) {
  const router = useRouter();
  const hydreret = useHydreret();
  const [trin, setTrin] = useState<Trin>("lukket");
  const [nyEmail, setNyEmail] = useState("");
  const [adgangskode, setAdgangskode] = useState("");
  const [kode, setKode] = useState("");
  const [besked, setBesked] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sender, setSender] = useState(false);
  const [aendret, setAendret] = useState<string | null>(null);

  function nulstil() {
    setNyEmail("");
    setAdgangskode("");
    setKode("");
    setBesked(null);
    setFejl(null);
  }

  async function sendKode(e: FormEvent) {
    e.preventDefault();
    if (sender) return;
    setFejl(null);
    const ny = nyEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(ny)) return setFejl("Skriv en gyldig e-mail.");
    if (ny === email.toLowerCase()) return setFejl("Det er allerede din e-mail.");
    if (!adgangskode) return setFejl("Skriv din nuværende adgangskode.");
    setSender(true);
    const svar = await sendEmailSkiftKode(ny, adgangskode);
    setSender(false);
    if ("fejl" in svar) return setFejl(svar.fejl);
    setAdgangskode("");
    setKode("");
    setBesked(svar.besked);
    setTrin("kode");
  }

  async function bekraeft(e: FormEvent) {
    e.preventDefault();
    if (sender) return;
    setFejl(null);
    const k = kode.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(k)) return setFejl("Skriv de 6 cifre fra mailen.");
    setSender(true);
    const svar = await bekraeftEmailSkift(k);
    setSender(false);
    if ("fejl" in svar) return setFejl(svar.fejl);
    nulstil();
    setTrin("lukket");
    setAendret(svar.email);
    router.refresh();
  }

  if (erFirma) {
    return (
      <div>
        <p className={LABEL}>E-mail</p>
        <p className="mt-1.5 break-all text-[15px] text-tekst" data-testid="nuvaerende-email">
          {email}
        </p>
        <p className="mt-1.5 text-[13px] text-tekst-daempet">{FIRMA_EMAIL_TEKST}</p>
      </div>
    );
  }

  if (trin === "lukket") {
    return (
      <div>
        <p className={LABEL}>E-mail</p>
        <p className="mt-1.5 break-all text-[15px] text-tekst" data-testid="nuvaerende-email">
          {aendret ?? email}
        </p>
        {aendret && (
          <p role="status" className={`mt-3 ${SUCCES_BOKS}`}>
            Din e-mail er ændret. Du logger ind med den nye adresse fremover. Du er logget ud på dine andre enheder, og
            vi har sendt en besked til din tidligere adresse.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setAendret(null);
            nulstil();
            setTrin("formular");
          }}
          className="btn btn-sekundaer mt-3 w-full sm:w-auto"
        >
          Skift e-mail
        </button>
      </div>
    );
  }

  if (trin === "formular") {
    return (
      <form onSubmit={sendKode} method="post" noValidate className="space-y-4 rounded-xl border border-kant p-4">
        <div>
          <p className={LABEL}>Nuværende e-mail</p>
          <p className="mt-1 break-all text-[15px] text-tekst-daempet">{email}</p>
        </div>
        <div>
          <label htmlFor="ny-email" className={LABEL}>
            Ny e-mail
          </label>
          <input
            id="ny-email"
            name="ny-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={320}
            value={nyEmail}
            onChange={(e) => setNyEmail(e.target.value)}
            className={`mt-1.5 ${FELT}`}
          />
        </div>
        <AdgangskodeFelt
          id="email-skift-adgangskode"
          label="Nuværende adgangskode"
          vaerdi={adgangskode}
          onChange={setAdgangskode}
        />
        <p className="text-[13px] text-tekst-daempet">
          Vi sender en kode til den nye adresse. Din e-mail skifter først, når du har skrevet koden.
        </p>
        {fejl && (
          <p role="alert" className={FORMULAR_FEJL}>
            {fejl}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          <button type="submit" disabled={sender || !hydreret} aria-busy={sender || undefined} className="btn btn-primaer w-full sm:w-auto">
            {sender && <span className="btn-spinner" aria-hidden="true" />}
            Send kode
          </button>
          <button
            type="button"
            onClick={() => {
              nulstil();
              setTrin("lukket");
            }}
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            Annullér
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={bekraeft} method="post" noValidate className="space-y-4 rounded-xl border border-kant p-4">
      {besked && (
        <p role="status" className={SUCCES_BOKS}>
          {besked}
        </p>
      )}
      <div>
        <label htmlFor="email-skift-kode" className={LABEL}>
          Kode fra mailen
        </label>
        <input
          id="email-skift-kode"
          name="kode"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={12}
          autoFocus
          value={kode}
          onChange={(e) => setKode(e.target.value.replace(/[^\d\s]/g, ""))}
          aria-invalid={fejl ? true : undefined}
          aria-describedby="email-skift-kode-hjaelp"
          className={`mt-1.5 ${FELT} h-14 text-center text-[24px] font-semibold tracking-[0.4em] ${fejl ? FELT_FEJL : ""}`}
        />
        <p id="email-skift-kode-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
          Koden er sendt til {nyEmail.trim().toLowerCase()}. Kan du ikke finde mailen, så tjek uønsket post.
        </p>
      </div>
      {fejl && (
        <p role="alert" className={FORMULAR_FEJL}>
          {fejl}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" disabled={sender || !hydreret} aria-busy={sender || undefined} className="btn btn-primaer w-full sm:w-auto">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Bekræft ny e-mail
        </button>
        <button
          type="button"
          onClick={() => {
            setFejl(null);
            setKode("");
            setTrin("formular");
          }}
          className="btn btn-sekundaer w-full sm:w-auto"
        >
          Send en ny kode
        </button>
        <button
          type="button"
          onClick={() => {
            nulstil();
            setTrin("lukket");
          }}
          className="btn btn-sekundaer w-full sm:w-auto"
        >
          Annullér
        </button>
      </div>
    </form>
  );
}
