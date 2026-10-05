"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import RapporterDialog from "@/components/tryghed/RapporterDialog";
import { skrivBedoemmelseSvar, sletBedoemmelseSvar } from "@/app/actions/bedoemmelser";
import { indeholderKontaktinfo, KONTAKTINFO_FEJL } from "@/lib/kontaktInfo";
import {
  MAKS_SVAR_TEGN,
  SVAR_RET_TIMER,
  type BedoemmelseVisning,
} from "@/lib/bedoemmelser";

// Bedømmelser på en profil med "Svar fra sælger" under hver.
// - erSaelger: profilens ejer ser sin egen liste og kan svare (ét svar pr.
//   bedømmelse, kan rettes/slettes i 48 timer).
// - erLoggetInd: andre kan rapportere en bedømmelse eller et svar - aldrig
//   noget, de selv har skrevet (mitId).
// Reglerne håndhæves i databasen (20261007020000_bedoemmelse_svar.sql).

const TZ = "Europe/Copenhagen";
const dato = (iso: string) =>
  new Date(iso).toLocaleDateString("da-DK", { dateStyle: "medium", timeZone: TZ });
const tidspunkt = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ,
  });

function Stjerner({ antal }: { antal: number }) {
  return (
    <div className="flex gap-0.5" role="img" aria-label={`${antal} af 5 stjerner`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`h-4 w-4 ${i <= antal ? "fill-groen text-groen" : "fill-kant-staerk text-kant-staerk"}`}
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </div>
  );
}

const RAPPORT_KNAP =
  "inline-flex min-h-11 items-center rounded-md text-xs font-medium text-tekst-svag hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:min-h-0";

function SvarFormular({
  ratingId,
  startTekst,
  onLuk,
}: {
  ratingId: string;
  startTekst: string;
  onLuk: () => void;
}) {
  const id = useId();
  const [tekst, setTekst] = useState(startTekst);
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const erRet = startTekst !== "";
  const advarsel = indeholderKontaktinfo(tekst) ? KONTAKTINFO_FEJL : null;

  function gem() {
    const t = tekst.trim();
    if (!t) {
      setFejl("Skriv et svar.");
      return;
    }
    if (t.length > MAKS_SVAR_TEGN) {
      setFejl(`Svaret må højst være ${MAKS_SVAR_TEGN} tegn.`);
      return;
    }
    setFejl(null);
    startTransition(async () => {
      const res = await skrivBedoemmelseSvar(ratingId, t);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      onLuk();
    });
  }

  return (
    <div className="mt-3 rounded-xl border border-kant bg-white p-3 sm:p-4">
      <label htmlFor={`${id}-svar`} className="block text-sm font-medium text-tekst">
        {erRet ? "Ret dit svar" : "Dit offentlige svar"}
      </label>
      <p id={`${id}-hjaelp`} className="mt-0.5 text-xs text-tekst-svag">
        Alle kan se svaret. Hold en saglig tone, og skriv ikke telefonnummer, e-mail eller links. Du kan
        rette eller slette svaret i {SVAR_RET_TIMER} timer – derefter er det låst.
      </p>
      <textarea
        id={`${id}-svar`}
        rows={4}
        maxLength={MAKS_SVAR_TEGN}
        value={tekst}
        onChange={(e) => setTekst(e.target.value)}
        aria-describedby={`${id}-hjaelp${advarsel || fejl ? ` ${id}-fejl` : ""}`}
        disabled={pending}
        className="mt-2 w-full rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-base text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25 sm:text-sm"
        placeholder="Fx: Tak for handlen! Beklager, at pakken var forsinket."
      />
      <div className="mt-1 flex items-start justify-between gap-3">
        <p id={`${id}-fejl`} role={fejl ? "alert" : undefined} className="text-xs text-fejl-tekst">
          {fejl ?? advarsel}
        </p>
        <span className="shrink-0 text-xs text-tekst-svag">
          {tekst.length}/{MAKS_SVAR_TEGN}
        </span>
      </div>
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onLuk} disabled={pending} className="btn btn-sekundaer btn-lille">
          Annullér
        </button>
        <button
          type="button"
          onClick={gem}
          disabled={pending}
          aria-busy={pending || undefined}
          className="btn btn-primaer btn-lille"
        >
          {pending && <span className="btn-spinner" aria-hidden="true" />}
          {erRet ? "Gem ændringer" : "Offentliggør svar"}
        </button>
      </div>
    </div>
  );
}

function SletSvar({ ratingId }: { ratingId: string }) {
  const [bekraeft, setBekraeft] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!bekraeft) {
    return (
      <button type="button" onClick={() => setBekraeft(true)} className="btn btn-tekst btn-lille">
        Slet svar
      </button>
    );
  }
  return (
    <div className="w-full rounded-xl border border-fejl-kant bg-fejl-bg p-3 text-sm text-fejl-tekst">
      <p>Vil du slette dit svar? Der kan kun skrives ét svar pr. bedømmelse, så du kan ikke skrive et nyt.</p>
      {fejl && (
        <p role="alert" className="mt-1 font-medium">
          {fejl}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => setBekraeft(false)}
          className="btn btn-sekundaer btn-lille"
        >
          Behold svaret
        </button>
        <button
          type="button"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() =>
            startTransition(async () => {
              const res = await sletBedoemmelseSvar(ratingId);
              if ("fejl" in res) setFejl(res.fejl);
            })
          }
          className="btn btn-fare btn-lille"
        >
          {pending && <span className="btn-spinner" aria-hidden="true" />}
          Ja, slet svaret
        </button>
      </div>
    </div>
  );
}

function BedoemmelseKort({
  r,
  erSaelger,
  erLoggetInd,
  mitId,
  kortKlasse,
}: {
  r: BedoemmelseVisning;
  erSaelger: boolean;
  erLoggetInd: boolean;
  mitId: string | null;
  kortKlasse: string;
}) {
  const [skriver, setSkriver] = useState(false);
  const svar = r.svar;
  // Sælgerens svar er skrevet af profilens ejer (til_bruger_id) - på den
  // offentlige profil kan det aldrig være mitId; egenBedoemmelse dækker, at
  // man ser sin egen bedømmelse af en anden.
  const egenBedoemmelse = mitId !== null && r.fra_bruger_id === mitId;

  return (
    <li id={`bedoemmelse-${r.id}`} className={`scroll-mt-24 ${kortKlasse}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-groen-lys text-xs font-semibold text-tekst-daempet"
          >
            {r.fra_bruger_navn[0]}
          </div>
          <Link
            href={`/profil/${r.fra_bruger_id}`}
            className="truncate rounded-md text-sm font-medium text-tekst hover:text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            {r.fra_bruger_navn}
          </Link>
        </div>
        <span className="shrink-0 text-xs text-tekst-svag">{dato(r.oprettet)}</span>
      </div>

      <div className="mt-2">
        <Stjerner antal={r.stjerner} />
      </div>

      {r.kommentar && (
        <p className="mt-2 whitespace-pre-line break-words text-sm text-tekst-daempet">{r.kommentar}</p>
      )}

      {/* Svar fra sælger */}
      {svar && !skriver && (
        <div className="mt-3 rounded-xl border-l-4 border-groen bg-white/70 px-3 py-2.5 sm:px-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-groen-mork">Svar fra sælger</p>
            <span className="text-xs text-tekst-svag">
              {dato(svar.oprettet)}
              {svar.rettet_kl && " · rettet"}
            </span>
          </div>
          {svar.skjult && (
            <p className="mt-1.5 rounded-lg border border-advarsel-kant bg-advarsel-bg px-2.5 py-1.5 text-xs text-advarsel-tekst">
              Dit svar er skjult af BidHamr og kan ikke ses af andre. Du har fået en besked med begrundelsen.
            </p>
          )}
          <p className="mt-1 whitespace-pre-line break-words text-sm text-tekst">{svar.tekst}</p>
        </div>
      )}

      {/* Handlinger */}
      {erSaelger && !skriver && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!svar && !r.svarSlettet && (
            <button type="button" onClick={() => setSkriver(true)} className="btn btn-sekundaer btn-lille">
              Svar offentligt
            </button>
          )}
          {!svar && r.svarSlettet && (
            <span className="text-xs text-tekst-svag">
              Du har slettet dit svar. Der kan kun skrives ét svar pr. bedømmelse.
            </span>
          )}
          {svar && !svar.skjult && svar.kanRettes && (
            <>
              <button type="button" onClick={() => setSkriver(true)} className="btn btn-sekundaer btn-lille">
                Ret svar
              </button>
              <SletSvar ratingId={r.id} />
              <span className="text-xs text-tekst-svag">
                Kan rettes indtil {tidspunkt(new Date(new Date(svar.oprettet).getTime() + SVAR_RET_TIMER * 3600_000).toISOString())}
              </span>
            </>
          )}
          {svar && !svar.skjult && !svar.kanRettes && (
            <span className="text-xs text-tekst-svag">Svaret er låst og kan ikke længere ændres.</span>
          )}
        </div>
      )}
      {erSaelger && skriver && (
        <SvarFormular ratingId={r.id} startTekst={svar?.tekst ?? ""} onLuk={() => setSkriver(false)} />
      )}

      {!erSaelger && erLoggetInd && (!egenBedoemmelse || (svar && !svar.skjult)) && (
        <div className="mt-1 flex flex-wrap gap-x-4">
          {!egenBedoemmelse && (
            <RapporterDialog
              bedoemmelse={{ ratingId: r.id, del: "bedoemmelse" }}
              titel="Rapportér bedømmelse"
              triggerLabel="Rapportér bedømmelse"
              triggerClassName={RAPPORT_KNAP}
            />
          )}
          {svar && !svar.skjult && (
            <RapporterDialog
              bedoemmelse={{ ratingId: r.id, del: "svar" }}
              titel="Rapportér sælgerens svar"
              triggerLabel="Rapportér svar"
              triggerClassName={RAPPORT_KNAP}
            />
          )}
        </div>
      )}
      {erSaelger && (
        <div className="mt-1">
          <RapporterDialog
            bedoemmelse={{ ratingId: r.id, del: "bedoemmelse" }}
            titel="Rapportér bedømmelse"
            triggerLabel="Bryder bedømmelsen reglerne? Rapportér den"
            triggerClassName={RAPPORT_KNAP}
          />
        </div>
      )}
    </li>
  );
}

export default function BedoemmelseListe({
  ratings,
  erSaelger,
  erLoggetInd,
  mitId = null,
  kortKlasse,
  tomTekst,
}: {
  ratings: BedoemmelseVisning[];
  erSaelger: boolean;
  erLoggetInd: boolean;
  // Den indloggede brugers id - skjuler "Rapportér" på egne tekster.
  mitId?: string | null;
  kortKlasse: string;
  tomTekst: string;
}) {
  if (ratings.length === 0) {
    return <p className="text-sm text-tekst-svag">{tomTekst}</p>;
  }
  return (
    <ul className="space-y-3">
      {ratings.map((r) => (
        <BedoemmelseKort
          key={r.id}
          r={r}
          erSaelger={erSaelger}
          erLoggetInd={erLoggetInd}
          mitId={mitId}
          kortKlasse={kortKlasse}
        />
      ))}
    </ul>
  );
}
