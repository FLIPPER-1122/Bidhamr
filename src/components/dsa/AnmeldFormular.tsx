"use client";

import Link from "next/link";
import { useId, useState, useTransition, type FormEvent } from "react";
import { anmeldIndhold } from "@/app/actions/dsa";
import {
  ANMELD_KATEGORIER,
  DSA_BEGRUNDELSE_MAKS,
  DSA_BEGRUNDELSE_MIN,
  DSA_EMAIL_MAKS,
  DSA_NAVN_MAKS,
  kraeverKontaktoplysninger,
  type IndholdType,
} from "@/lib/dsa/regler";

// Formularen til "Anmeld ulovligt indhold" (DSA art. 16). Bruges i dialogen
// på auktioner, profiler, spørgsmål og bedømmelser (placeringen udfyldes
// automatisk) og på /dsa/anmeld (brugeren indsætter et link).
// Virker også uden login. Spambeskyttelse: honeypot + tidsfælde + rate limit.

const felt =
  "w-full rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";

export type AnmeldFormularProps = {
  type?: IndholdType;
  id?: string;
  // Kort beskrivelse af det anmeldte, fx "Auktion: Rød cykel".
  hvad?: string;
  loggetInd: boolean;
  onLuk?: () => void;
};

export default function AnmeldFormular({ type, id, hvad, loggetInd, onLuk }: AnmeldFormularProps) {
  const uid = useId();
  const [kategori, setKategori] = useState("");
  const [begrundelse, setBegrundelse] = useState("");
  // Tidspunktet, formularen blev vist (tidsfælden mod robotter).
  const [startet] = useState(() => String(Date.now()));
  const [fejl, setFejl] = useState<string | null>(null);
  const [kvittering, setKvittering] = useState<{ sagsnummer: string; statusSti: string; findes: boolean } | null>(null);
  const [sender, startSend] = useTransition();


  const medLink = !type || type === "andet";
  const kontaktKraeves = !loggetInd && (!kategori || kraeverKontaktoplysninger(kategori));

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFejl(null);
    const form = e.currentTarget;
    if (!kategori) {
      setFejl("Vælg, hvad anmeldelsen handler om.");
      return;
    }
    if (begrundelse.trim().length < DSA_BEGRUNDELSE_MIN) {
      setFejl("Forklar lidt mere, hvorfor indholdet er ulovligt eller bryder reglerne.");
      return;
    }
    const fd = new FormData(form);
    startSend(async () => {
      const r = await anmeldIndhold(fd);
      if ("fejl" in r) {
        setFejl(r.fejl);
        return;
      }
      setKvittering({ sagsnummer: r.sagsnummer, statusSti: r.statusSti, findes: !!r.findes });
    });
  }

  if (kvittering) {
    return (
      <div className="text-center" role="status">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-succes-bg">
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-succes-tekst" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-[20px] leading-tight">
          {kvittering.findes ? "Du har allerede anmeldt dette" : "Tak for din anmeldelse"}
        </h2>
        <p className="mt-1.5 text-sm text-tekst-daempet">
          {kvittering.findes
            ? "Vi er ved at se på din tidligere anmeldelse."
            : "En medarbejder kigger på det. Du får svar, når vi har taget stilling."}
        </p>
        {kvittering.sagsnummer && (
          <p className="mt-3 text-sm text-tekst">
            Sagsnummer: <strong className="font-semibold">{kvittering.sagsnummer}</strong>
          </p>
        )}
        <div className="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          {kvittering.sagsnummer && (
            <Link href={kvittering.statusSti} className="btn btn-sekundaer">
              Følg din anmeldelse
            </Link>
          )}
          {onLuk && (
            <button type="button" onClick={onLuk} className="btn btn-primaer">
              Luk
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={indsend} className="space-y-4" noValidate>
      {/* Spambeskyttelse: usynligt for mennesker. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor={`${uid}-hp`}>Lad dette felt være tomt</label>
        <input id={`${uid}-hp`} name="hjemmeside" tabIndex={-1} autoComplete="off" />
      </div>
      <input type="hidden" name="t" value={startet} />
      {type && type !== "andet" && <input type="hidden" name="type" value={type} />}
      {id && <input type="hidden" name="id" value={id} />}

      {hvad && (
        <p className="rounded-xl bg-groen-lys px-4 py-3 text-sm text-tekst">
          <span className="font-medium">Du anmelder:</span> {hvad}
        </p>
      )}

      {medLink && (
        <div>
          <label htmlFor={`${uid}-link`} className="block text-sm font-medium text-tekst">
            Link til indholdet
          </label>
          <input
            id={`${uid}-link`}
            name="link"
            type="text"
            inputMode="url"
            required
            maxLength={500}
            placeholder="https://bidhamr.dk/auktion/..."
            className={`${felt} mt-1.5 h-12`}
          />
          <p className="mt-1 text-[13px] text-tekst-svag">Kopiér adressen på auktionen eller profilen.</p>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-tekst">Hvad drejer det sig om?</legend>
        {ANMELD_KATEGORIER.map((k) => (
          <label
            key={k.vaerdi}
            className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
              kategori === k.vaerdi ? "border-groen bg-groen-lys text-tekst" : "border-kant text-tekst-daempet hover:bg-groen-lys"
            }`}
          >
            <input
              type="radio"
              name="kategori"
              value={k.vaerdi}
              checked={kategori === k.vaerdi}
              onChange={(e) => setKategori(e.target.value)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-groen"
            />
            <span>
              <span className="block font-medium text-tekst">{k.label}</span>
              <span className="block text-[13px] text-tekst-svag">{k.hjaelp}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <label htmlFor={`${uid}-begr`} className="block text-sm font-medium text-tekst">
          Hvorfor er det ulovligt eller imod reglerne?
        </label>
        <textarea
          id={`${uid}-begr`}
          name="begrundelse"
          rows={4}
          required
          minLength={DSA_BEGRUNDELSE_MIN}
          maxLength={DSA_BEGRUNDELSE_MAKS}
          value={begrundelse}
          onChange={(e) => setBegrundelse(e.target.value)}
          placeholder="Forklar så præcist som muligt, fx hvilken lov eller regel det bryder, og hvordan du ved det."
          aria-describedby={`${uid}-begr-hjaelp`}
          className={`${felt} mt-1.5 min-h-[112px]`}
        />
        <p id={`${uid}-begr-hjaelp`} className="mt-1 text-right text-[13px] text-tekst-svag">
          {begrundelse.length.toLocaleString("da-DK")} / {DSA_BEGRUNDELSE_MAKS.toLocaleString("da-DK")}
        </p>
      </div>

      {loggetInd ? (
        <p className="text-[13px] text-tekst-svag">Vi bruger navn og e-mail fra din konto, så vi kan give dig svar.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-navn`} className="block text-sm font-medium text-tekst">
              Dit navn {!kontaktKraeves && <span className="font-normal text-tekst-svag">(valgfrit)</span>}
            </label>
            <input
              id={`${uid}-navn`}
              name="navn"
              autoComplete="name"
              required={kontaktKraeves}
              maxLength={DSA_NAVN_MAKS}
              className={`${felt} mt-1.5 h-12`}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-email`} className="block text-sm font-medium text-tekst">
              Din e-mail {!kontaktKraeves && <span className="font-normal text-tekst-svag">(valgfri)</span>}
            </label>
            <input
              id={`${uid}-email`}
              name="email"
              type="email"
              autoComplete="email"
              required={kontaktKraeves}
              maxLength={DSA_EMAIL_MAKS}
              className={`${felt} mt-1.5 h-12`}
            />
          </div>
          <p className="text-[13px] text-tekst-svag sm:col-span-2">
            {kategori === "misbrug_boern"
              ? "Ved misbrug af børn behøver du ikke oplyse navn og e-mail. Uden e-mail kan vi ikke give dig svar."
              : "Vi bruger dem kun til at sende dig en kvittering og vores svar. Den anmeldte får aldrig at vide, hvem du er."}
          </p>
        </div>
      )}

      <label className="flex items-start gap-3 text-sm text-tekst">
        <input type="checkbox" name="god_tro" required className="mt-0.5 h-5 w-5 shrink-0 accent-groen" />
        <span>Jeg bekræfter, at oplysningerne er rigtige og fyldestgørende efter min bedste overbevisning.</span>
      </label>

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
        {onLuk && (
          <button type="button" onClick={onLuk} disabled={sender} className="btn btn-sekundaer">
            Annullér
          </button>
        )}
        <button type="submit" disabled={sender} aria-busy={sender || undefined} className="btn btn-primaer">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Send anmeldelse
        </button>
      </div>

      <p className="text-[13px] text-tekst-svag">
        Bevidst falske anmeldelser kan føre til, at vi ikke behandler dine anmeldelser i en periode.{" "}
        <Link href="/dsa" className="font-medium text-groen hover:underline">
          Sådan behandler vi anmeldelser
        </Link>
      </p>
    </form>
  );
}
