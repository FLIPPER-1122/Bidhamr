// "Få erstatning fra DAO/GLS" på sælgerens handelsside (ROADMAP-BESLUTNINGER
// afsnit 4, "Reklamation – sælger anmelder selv", Filip 21. okt. 2026).
// Sælgeren anmelder selv skaden hos fragtfirmaet; BidHamr samler alt, så det
// er færrest mulige klik: 1) hent billederne som én ZIP, 2) åbn anmeldelsen,
// 3) fortæl os, hvordan det gik. Alle felter har deres egen kopiér-knap.
// Server-komponent - kun kopiér-knapperne og statusknapperne er klientkode.
import type { Reklamationspakke, PakkePart } from "@/lib/reklamation/pakke";
import {
  kroner,
  reklamationStatusSaelger,
  transportoerNavn,
  type SaelgerReklamation,
} from "@/lib/reklamation/typer";
import KopierKnap from "./KopierKnap";
import ReklamationSaelgerHandlinger from "./ReklamationSaelgerHandlinger";
import ReklamationMaerke from "./ReklamationMaerke";

// Sagen er ændret efter anmeldelsen, og BidHamr har ikke kvitteret endnu.
const SAG_AENDRET_TEKST =
  "Sagen om handlen er ændret, og BidHamr kigger på det. Vent med at registrere, at erstatningen er godkendt, til du har hørt fra os.";

function dato(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString("da-DK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

function partTekst(p: PakkePart): string | null {
  const by = [p.postnummer, p.by].filter(Boolean).join(" ");
  return [p.navn, p.adresse, by, p.telefon, p.email].filter(Boolean).join(", ") || null;
}

function Trin({ nr, titel, children }: { nr: number; titel: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 sm:gap-4">
      <span
        aria-hidden="true"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-groen text-sm font-bold text-white"
      >
        {nr}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className="font-sans text-[16px] font-semibold text-tekst">
          <span className="sr-only">Trin {nr}: </span>
          {titel}
        </h3>
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}

function FeltRaekke({ navn, vaerdi, lang = false }: { navn: string; vaerdi: string | null; lang?: boolean }) {
  return (
    <div className="flex items-start gap-3 border-t border-kant py-3 first:border-t-0">
      <div className="min-w-0 flex-1">
        <dt className="text-[13px] text-tekst-daempet">{navn}</dt>
        <dd className={`mt-0.5 break-words text-[15px] text-tekst ${lang ? "whitespace-pre-wrap" : "font-medium"}`}>
          {vaerdi ?? <span className="text-tekst-svag">Ikke oplyst</span>}
        </dd>
      </div>
      {vaerdi && <KopierKnap tekst={vaerdi} label={navn.toLowerCase()} />}
    </div>
  );
}

export default function ReklamationKort({
  r,
  pakke,
  tradeId,
  kanHandle = true,
}: {
  r: SaelgerReklamation;
  // null, når reklamationen er afsluttet (pakken kan kun hentes, mens den er åben)
  // eller ikke kunne hentes.
  pakke: Reklamationspakke | null;
  tradeId: string;
  // false i firma-dashboardet før lancering (server actions er lukket).
  kanHandle?: boolean;
}) {
  const navn = transportoerNavn(r.transportoer);
  const aaben = r.status === "afventer_saelger" || r.status === "anmeldt";

  // Afsluttet: kun en kort status.
  if (!aaben) {
    const tone =
      r.status === "godkendt"
        ? "border-succes-kant bg-succes-bg text-succes-tekst"
        : r.status === "afvist"
          ? "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
          : "border-kant bg-white text-tekst-daempet";
    return (
      <section id="reklamation" aria-labelledby="reklamation-titel" className={`scroll-mt-24 rounded-[14px] border p-5 sm:p-6 ${tone}`}>
        <h2 id="reklamation-titel" className="font-sans text-[16px] font-semibold">
          {reklamationStatusSaelger(r.status, r.transportoer)}
        </h2>
        <p className="mt-1 text-sm">
          {r.status === "godkendt" && r.godkendt_beloeb_oere != null && (
            <>Godkendt beløb: {kroner(r.godkendt_beloeb_oere)}. {navn} betaler direkte til dig.</>
          )}
          {r.status === "afvist" && (r.afvisningsgrund ? <>Begrundelse: {r.afvisningsgrund}</> : <>Du får ikke erstatning for varen.</>)}
          {r.status === "fravalgt" && <>Du får ikke erstatning for varen.</>}
          {r.status === "annulleret" && (r.annulleret_grund ? <>Begrundelse fra BidHamr: {r.annulleret_grund}</> : null)}
        </p>
        {r.transportoerens_sagsnummer && (
          <p className="mt-1 text-sm">
            {navn}s sagsnummer: <span className="font-semibold">{r.transportoerens_sagsnummer}</span>
          </p>
        )}
        {r.afventer_bidhamr && <p className="mt-2 text-sm font-semibold">{SAG_AENDRET_TEKST}</p>}
      </section>
    );
  }

  const p = pakke;
  const antalBilleder = p?.billeder.length ?? 0;
  const anmeldUrl = p?.anmeldUrl ?? (r.transportoer === "dao" ? "https://omdeling.info" : null);
  const felter: { navn: string; vaerdi: string | null; lang?: boolean }[] = p
    ? [
        { navn: "Trackingnummer", vaerdi: p.trackingnummer },
        ...(p.forsendelsesId ? [{ navn: "Forsendelses-id", vaerdi: p.forsendelsesId }] : []),
        { navn: "Afsender", vaerdi: partTekst(p.afsender) },
        { navn: "Modtager", vaerdi: partTekst(p.modtager) },
        { navn: "Afsendt", vaerdi: dato(p.afsendtKl) },
        { navn: "Leveret", vaerdi: dato(p.leveretKl) },
        { navn: "Vare", vaerdi: p.varetitel },
        { navn: "Varens værdi", vaerdi: kroner(p.varensVaerdiOere) },
        { navn: "Kravbeløb", vaerdi: kroner(p.kravbeloebOere) },
        { navn: "Skadebeskrivelse", vaerdi: p.skadebeskrivelse, lang: true },
      ]
    : [];

  return (
    <section
      id="reklamation"
      aria-labelledby="reklamation-titel"
      className="scroll-mt-24 rounded-[14px] border-2 border-orange bg-white p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="reklamation-titel" className="text-[20px] leading-tight lg:text-[22px]">
          Få erstatning fra {navn}
        </h2>
        <ReklamationMaerke status={r.status} />
      </div>
      <p className="mt-2 text-[15px] text-tekst-daempet">
        Køberen har fået pengene tilbage, fordi varen blev skadet under fragten. Du pakkede ordentligt, så du kan
        selv søge erstatning hos {navn} – op til {kroner(r.kravbeloeb_oere)}. Det er {navn}, der afgør sagen, og
        pengene udbetales direkte til dig.
      </p>
      {r.status === "anmeldt" && (
        <p className="mt-3 rounded-xl bg-info-bg px-4 py-3 text-sm text-info-tekst">
          {reklamationStatusSaelger(r.status, r.transportoer)}.
          {r.transportoerens_sagsnummer && <> Sagsnummer: <span className="font-semibold">{r.transportoerens_sagsnummer}</span>.</>}
        </p>
      )}
      {r.afventer_bidhamr && (
        <p role="status" className="mt-3 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
          {SAG_AENDRET_TEKST}
        </p>
      )}

      {!p && (
        <p role="alert" className="mt-4 rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
          Oplysningerne kunne ikke hentes lige nu. Genindlæs siden om lidt.
        </p>
      )}

      <ol className="mt-5 space-y-6">
        <Trin nr={1} titel="Hent billederne">
          <p className="mb-3 text-sm text-tekst-daempet">
            Dine billeder af indpakningen og køberens billeder af skaden – samlet i én fil, klar til at vedhæfte.
          </p>
          <a
            href={`/api/reklamation/${r.id}/billeder`}
            download
            className="btn btn-sekundaer w-full sm:w-auto"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2M7 11l5 5l5 -5M12 4v12" />
            </svg>
            Hent billeder{p ? ` (${antalBilleder})` : ""}
          </a>
        </Trin>

        <Trin nr={2} titel={`Anmeld skaden hos ${navn}`}>
          <p className="mb-3 text-sm text-tekst-daempet">{p?.anmeldTekst}</p>
          {anmeldUrl && (
            <a href={anmeldUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primaer w-full sm:w-auto">
              Åbn anmeldelsen hos {navn}
              <span className="sr-only"> (åbner i et nyt vindue)</span>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6M11 13l9 -9M15 4h5v5" />
              </svg>
            </a>
          )}

          {p && (
            <div className="mt-4 rounded-xl border border-kant bg-white">
              <div className="flex flex-col gap-2 border-b border-kant px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-semibold text-tekst">Oplysninger til anmeldelsen</p>
                <KopierKnap tekst={p.tekst} label="alle oplysninger" stor />
              </div>
              <dl className="px-4">
                {felter.map((f) => (
                  <FeltRaekke key={f.navn} navn={f.navn} vaerdi={f.vaerdi} lang={f.lang} />
                ))}
              </dl>
              {p.maksErstatningOere != null && (
                <p className="border-t border-kant px-4 py-3 text-[13px] text-tekst-daempet">
                  {navn} erstatter højst {kroner(p.maksErstatningOere)} pr. pakke.
                </p>
              )}
            </div>
          )}
        </Trin>

        <Trin nr={3} titel="Fortæl os, hvordan det gik">
          {kanHandle ? (
            <ReklamationSaelgerHandlinger
              reklamationId={r.id}
              tradeId={tradeId}
              status={r.status === "anmeldt" ? "anmeldt" : "afventer_saelger"}
              transportoerNavn={navn}
              kravbeloebOere={r.kravbeloeb_oere}
              sagsnummer={r.transportoerens_sagsnummer}
            />
          ) : (
            <p className="text-sm text-tekst-daempet">Du kan registrere svaret, når BidHamr er åbnet.</p>
          )}
        </Trin>
      </ol>
    </section>
  );
}
