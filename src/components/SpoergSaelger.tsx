"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  besvarSpoergsmaal,
  saetSpoergsmaalAktiv,
  skjulSpoergsmaal,
  stilSpoergsmaal,
} from "@/app/actions/spoergsmaal";
import { KONTAKTINFO_FEJL, indeholderKontaktinfo } from "@/lib/kontaktInfo";
import AnmeldKnap from "@/components/dsa/AnmeldKnap";
import { REGEL_VALG } from "@/lib/dsa/regler";
import { AuktionLaastTekst } from "@/components/SaelgerAuktionHandlinger";
import { NETVAERKSFEJL, erAuktionLaastBesked } from "@/lib/auktionRegler";
import {
  MAKS_SPOERGSMAAL,
  MAKS_SVAR,
  MIN_SPOERGSMAAL,
  SPOERGSMAAL_SLAAET_FRA,
  type SpoergsmaalVisning,
} from "@/lib/spoergsmaal";

// "Spørg sælger" på auktionssiden. Spørgsmål og svar er offentlige og vises
// kun med fornavn + initial. Al kontrol sker igen i databasen.

const felt =
  "w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25";
const primaer =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-orange-knap px-5 text-[15px] font-semibold text-white transition-colors hover:bg-orange-knap-mork focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:cursor-not-allowed disabled:bg-orange-knap/40 disabled:text-white/80";
const sekundaer =
  "inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-groen bg-white px-4 text-sm font-semibold text-groen transition-colors hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:cursor-not-allowed disabled:border-kant-staerk disabled:text-tekst-svag";

const ANMELD_KNAP =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md text-xs font-medium text-tekst-svag hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:min-h-8";

function dato(iso: string) {
  return new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

function Fejltekst({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
      {children}
    </p>
  );
}

export default function SpoergSaelger({
  auktionId,
  spoergsmaal,
  aktiv,
  auktionKoerer,
  erSaelger,
  erStaff,
  loggetInd,
  kanIkkeSpoerge = false,
  laast = false,
}: {
  auktionId: string;
  spoergsmaal: SpoergsmaalVisning[];
  aktiv: boolean;
  auktionKoerer: boolean;
  erSaelger: boolean;
  erStaff: boolean;
  loggetInd: boolean;
  /** Blokering/spærring mellem sælger og den indloggede (art afsløres ikke). */
  kanIkkeSpoerge?: boolean;
  /** Der er budt: auktionen er låst, så "Modtag spørgsmål" kan ikke ændres
   * (Filip, 7. okt. 2026). Sælgeren kan stadig besvare spørgsmål. */
  laast?: boolean;
}) {
  const router = useRouter();
  const [tekst, setTekst] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const [sender, startSend] = useTransition();
  const [modtager, setModtager] = useState(aktiv);
  const [skifter, startSkift] = useTransition();
  const [skiftFejl, setSkiftFejl] = useState<string | null>(null);
  // Gammel fane: serveren svarer, at auktionen er låst (der er budt, siden
  // siden blev åbnet). Kontakten skjules, og låst-beskeden vises med link.
  const [laastLokalt, setLaastLokalt] = useState(false);
  const erLaast = laast || laastLokalt;

  const kontaktAdvarsel = tekst.length > 0 && indeholderKontaktinfo(tekst);

  function send(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    setSendt(false);
    const t = tekst.trim();
    if (t.length < MIN_SPOERGSMAAL) {
      setFejl(`Skriv mindst ${MIN_SPOERGSMAAL} tegn.`);
      return;
    }
    startSend(async () => {
      let svar: Awaited<ReturnType<typeof stilSpoergsmaal>>;
      try {
        svar = await stilSpoergsmaal(auktionId, t);
      } catch (err) {
        console.error("stilSpoergsmaal fejlede:", err);
        setFejl(NETVAERKSFEJL);
        return;
      }
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      setTekst("");
      setSendt(true);
      router.refresh();
    });
  }

  function skift() {
    setSkiftFejl(null);
    const ny = !modtager;
    startSkift(async () => {
      let svar: Awaited<ReturnType<typeof saetSpoergsmaalAktiv>>;
      try {
        svar = await saetSpoergsmaalAktiv(auktionId, ny);
      } catch (err) {
        console.error("saetSpoergsmaalAktiv fejlede:", err);
        setSkiftFejl(NETVAERKSFEJL);
        return;
      }
      if ("fejl" in svar) {
        if (erAuktionLaastBesked(svar.fejl)) {
          setLaastLokalt(true);
          router.refresh();
          return;
        }
        setSkiftFejl(svar.fejl);
        return;
      }
      setModtager(svar.aktiv);
      router.refresh();
    });
  }

  const synlige = spoergsmaal;

  return (
    <section id="spoergsmaal" aria-labelledby="spoergsmaal-overskrift" className="scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="spoergsmaal-overskrift" className="font-serif text-[17px] font-semibold text-tekst sm:text-lg">
          Spørg sælger
        </h2>
        {erSaelger && auktionKoerer && !erLaast && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-tekst">
            Modtag spørgsmål
            <button
              type="button"
              role="switch"
              aria-checked={modtager}
              onClick={skift}
              disabled={skifter}
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen disabled:opacity-60 ${
                modtager ? "bg-groen" : "bg-kant-staerk"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform motion-reduce:transition-none ${
                  modtager ? "translate-x-5" : ""
                }`}
              />
            </button>
          </label>
        )}
      </div>
      {skiftFejl && <Fejltekst>{skiftFejl}</Fejltekst>}
      {laastLokalt && (
        <p role="alert" className="mt-3 rounded-xl border border-kant bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
          <AuktionLaastTekst />
        </p>
      )}

      {!modtager ? (
        <p className="mt-3 rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
          {SPOERGSMAAL_SLAAET_FRA}
        </p>
      ) : erSaelger ? (
        <p className="mt-2 text-sm text-tekst-daempet">
          Købere kan stille spørgsmål, mens auktionen kører. Dine svar kan ses af alle.
        </p>
      ) : !auktionKoerer ? null : !loggetInd ? (
        <p className="mt-2 text-sm text-tekst-daempet">
          <Link href={`/login?redirect=/auktion/${auktionId}%23spoergsmaal`} className="font-medium text-groen hover:underline">
            Log ind
          </Link>{" "}
          for at stille sælgeren et spørgsmål.
        </p>
      ) : kanIkkeSpoerge ? (
        <p className="mt-3 rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
          Du kan ikke stille spørgsmål til denne sælger.
        </p>
      ) : (
        <form onSubmit={send} className="mt-3" noValidate>
          <label htmlFor="nyt-spoergsmaal" className="mb-1.5 block text-sm font-medium text-tekst">
            Dit spørgsmål
          </label>
          <textarea
            id="nyt-spoergsmaal"
            value={tekst}
            onChange={(e) => setTekst(e.target.value)}
            maxLength={MAKS_SPOERGSMAAL}
            rows={3}
            placeholder="Fx: Er der ridser på skærmen?"
            aria-invalid={kontaktAdvarsel || !!fejl}
            aria-describedby="spoergsmaal-hjaelp"
            className={`${felt} min-h-[96px] ${kontaktAdvarsel ? "border-fejl-kant bg-fejl-bg/40" : ""}`}
          />
          <p id="spoergsmaal-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
            Spørgsmål og svar kan ses af alle – dog kun med dit fornavn. Del aldrig telefonnummer, e-mail eller links.{" "}
            <span className="text-tekst-svag">
              {tekst.length}/{MAKS_SPOERGSMAAL}
            </span>
          </p>
          {kontaktAdvarsel && !fejl && <Fejltekst>{KONTAKTINFO_FEJL}</Fejltekst>}
          {fejl && <Fejltekst>{fejl}</Fejltekst>}
          {sendt && (
            <p role="status" className="mt-1.5 text-[13px] font-medium text-succes-tekst">
              Dit spørgsmål er sendt til sælgeren.
            </p>
          )}
          <button
            type="submit"
            disabled={sender || tekst.trim().length < MIN_SPOERGSMAAL}
            aria-busy={sender}
            className={`${primaer} mt-3 w-full sm:w-auto`}
          >
            {sender && <Spinner />}
            Send spørgsmål
          </button>
        </form>
      )}

      {synlige.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {synlige.map((q) => (
            <SpoergsmaalPunkt
              key={q.id}
              auktionId={auktionId}
              q={q}
              kanSvare={erSaelger && auktionKoerer && !q.answer && !q.hidden}
              erStaff={erStaff}
              erSaelger={erSaelger}
              loggetInd={loggetInd}
            />
          ))}
        </ul>
      ) : (
        modtager && (
          <p className="mt-3 text-sm text-tekst-svag">Der er ingen spørgsmål endnu.</p>
        )
      )}
    </section>
  );
}

function SpoergsmaalPunkt({
  auktionId,
  q,
  kanSvare,
  erStaff,
  erSaelger,
  loggetInd,
}: {
  auktionId: string;
  q: SpoergsmaalVisning;
  kanSvare: boolean;
  erStaff: boolean;
  erSaelger: boolean;
  loggetInd: boolean;
}) {
  const router = useRouter();
  const [svar, setSvar] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [sender, startSend] = useTransition();
  const [skjulAaben, setSkjulAaben] = useState(false);
  const [grund, setGrund] = useState("");
  const [regel, setRegel] = useState("chikane");
  const [skjulFejl, setSkjulFejl] = useState<string | null>(null);
  const [skjuler, startSkjul] = useTransition();

  const kontaktAdvarsel = svar.length > 0 && indeholderKontaktinfo(svar);
  const svarId = `svar-${q.id}`;

  function besvar(e: FormEvent) {
    e.preventDefault();
    setFejl(null);
    if (!svar.trim()) {
      setFejl("Skriv et svar.");
      return;
    }
    startSend(async () => {
      let r: Awaited<ReturnType<typeof besvarSpoergsmaal>>;
      try {
        r = await besvarSpoergsmaal(auktionId, q.id, svar.trim());
      } catch (err) {
        console.error("besvarSpoergsmaal fejlede:", err);
        setFejl(NETVAERKSFEJL);
        return;
      }
      if ("fejl" in r) {
        setFejl(r.fejl);
        return;
      }
      setSvar("");
      router.refresh();
    });
  }

  function skjul(e?: FormEvent) {
    e?.preventDefault();
    setSkjulFejl(null);
    const nyTilstand = !q.hidden;
    if (nyTilstand && !grund.trim()) {
      setSkjulFejl("Skriv en begrundelse.");
      return;
    }
    startSkjul(async () => {
      let r: Awaited<ReturnType<typeof skjulSpoergsmaal>>;
      try {
        r = await skjulSpoergsmaal(auktionId, q.id, nyTilstand, grund.trim(), regel);
      } catch (err) {
        console.error("skjulSpoergsmaal fejlede:", err);
        setSkjulFejl(NETVAERKSFEJL);
        return;
      }
      if ("fejl" in r) {
        setSkjulFejl(r.fejl);
        return;
      }
      setSkjulAaben(false);
      setGrund("");
      router.refresh();
    });
  }

  return (
    <li
      id={`spoergsmaal-${q.id}`}
      className={`scroll-mt-24 rounded-[14px] border p-4 ${q.hidden ? "border-advarsel-kant bg-advarsel-bg" : "border-kant bg-white"}`}
    >
      {q.hidden && (
        <p className="mb-2 text-[13px] font-semibold text-advarsel-tekst">
          Skjult af BidHamr – kun staff kan se det
        </p>
      )}
      <p className="text-xs text-tekst-svag">
        {q.is_mine ? "Dit spørgsmål" : q.asker_name} · {dato(q.asked_at)}
      </p>
      <p className="mt-1 whitespace-pre-line break-words text-[15px] text-tekst">{q.question}</p>
      {!q.is_mine && !q.hidden && (
        <AnmeldKnap
          type="spoergsmaal"
          id={q.id}
          hvad={`Spørgsmålet "${q.question.slice(0, 80)}${q.question.length > 80 ? "…" : ""}"`}
          loggetInd={loggetInd}
          label="Anmeld spørgsmål"
          className={ANMELD_KNAP}
        />
      )}

      {q.answer ? (
        <div className="mt-3 rounded-xl bg-groen-lys px-4 py-3">
          <p className="text-xs font-medium text-groen-mork">
            Sælgerens svar{q.answered_at ? ` · ${dato(q.answered_at)}` : ""}
          </p>
          <p className="mt-1 whitespace-pre-line break-words text-[15px] text-tekst">{q.answer}</p>
          {!erSaelger && !q.hidden && (
            <AnmeldKnap
              type="spoergsmaal_svar"
              id={q.id}
              hvad="Sælgerens svar på et spørgsmål"
              loggetInd={loggetInd}
              label="Anmeld svar"
              className={ANMELD_KNAP}
            />
          )}
        </div>
      ) : (
        !kanSvare && <p className="mt-2 text-[13px] text-tekst-svag">Sælgeren har ikke svaret endnu.</p>
      )}

      {kanSvare && (
        <form onSubmit={besvar} className="mt-3" noValidate>
          <label htmlFor={svarId} className="mb-1.5 block text-sm font-medium text-tekst">
            Dit svar
          </label>
          <textarea
            id={svarId}
            value={svar}
            onChange={(e) => setSvar(e.target.value)}
            maxLength={MAKS_SVAR}
            rows={2}
            aria-invalid={kontaktAdvarsel || !!fejl}
            className={`${felt} min-h-[72px] ${kontaktAdvarsel ? "border-fejl-kant bg-fejl-bg/40" : ""}`}
          />
          <p className="mt-1.5 text-[13px] text-tekst-daempet">
            Svaret kan ses af alle og kan ikke rettes bagefter.
          </p>
          {kontaktAdvarsel && !fejl && <Fejltekst>{KONTAKTINFO_FEJL}</Fejltekst>}
          {fejl && <Fejltekst>{fejl}</Fejltekst>}
          <button
            type="submit"
            disabled={sender || !svar.trim()}
            aria-busy={sender}
            className={`${sekundaer} mt-2 w-full sm:w-auto`}
          >
            {sender && <Spinner />}
            Svar
          </button>
        </form>
      )}

      {erStaff && (
        <div className="mt-3 border-t border-kant pt-3">
          {q.hidden ? (
            <button type="button" onClick={() => skjul()} disabled={skjuler} className={sekundaer}>
              {skjuler && <Spinner />}
              Vis spørgsmålet igen
            </button>
          ) : skjulAaben ? (
            <form onSubmit={skjul} noValidate>
              <label htmlFor={`regel-${q.id}`} className="mb-1.5 block text-sm font-medium text-tekst">
                Hvilken regel bryder det?
              </label>
              <select
                id={`regel-${q.id}`}
                value={regel}
                onChange={(e) => setRegel(e.target.value)}
                className={`${felt} mb-3 h-11 py-0`}
              >
                {REGEL_VALG.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <label htmlFor={`grund-${q.id}`} className="mb-1.5 block text-sm font-medium text-tekst">
                Begrundelse til den, der skrev det (vises for brugeren, som kan klage)
              </label>
              <input
                id={`grund-${q.id}`}
                value={grund}
                onChange={(e) => setGrund(e.target.value)}
                maxLength={500}
                className={`${felt} h-11 py-0`}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="submit" disabled={skjuler} className={sekundaer}>
                  {skjuler && <Spinner />}
                  Skjul
                </button>
                <button
                  type="button"
                  onClick={() => setSkjulAaben(false)}
                  className="inline-flex h-11 items-center px-3 text-sm font-medium text-groen hover:underline"
                >
                  Annullér
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setSkjulAaben(true)}
              className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline"
            >
              Skjul spørgsmål (staff)
            </button>
          )}
          {skjulFejl && <Fejltekst>{skjulFejl}</Fejltekst>}
        </div>
      )}
    </li>
  );
}
