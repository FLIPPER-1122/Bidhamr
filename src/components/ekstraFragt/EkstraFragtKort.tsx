"use client";

// "Ekstra fragt: X kr." på sælgerens handelsside (ROADMAP-BESLUTNINGER, "For
// lille pakkestørrelse – sælgeren betaler forskellen", Filip 21. okt. 2026).
// Fragtfirmaet har målt pakken større/tungere end den valgte størrelse, og
// sælgeren betaler forskellen. Færrest klik: "Betal X kr." viser Stripes
// betaling direkte i kortet; "Jeg er uenig" er en diskret tekstknap
// (indsigelse, kun én gang og kun før fristen - Filip, 21. okt. 2026; efter
// fristen henvises sælgeren til at kontakte BidHamr). Der trækkes aldrig
// automatisk i sælgerens penge.
//
// Alt, der afgør noget (status, frist, spærring, kan_betale,
// kan_goere_indsigelse), kommer fra databasen (mine_ekstra_fragt_regninger).
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ekstraFragtDokumentationLink,
  ekstraFragtIndsigelse,
  startEkstraFragtBetalingAction,
  type MinEkstraFragt,
} from "@/app/actions/ekstraFragt";
import { EKSTRA_FRAGT_FRIST_OVERSKREDET_UENIG, EKSTRA_FRAGT_SPAERRET_TEKST } from "@/lib/ekstraFragt/tekster";
import { ekstraFragtDato, maalingTekst, valgtStoerrelseNavn } from "@/lib/ekstraFragt/visning";
import { transportoerNavn } from "@/lib/fragt/types";
import { kroner } from "@/lib/kroner";
import { useHydreret } from "@/lib/useHydreret";

const EkstraFragtBetaling = dynamic(() => import("@/components/ekstraFragt/EkstraFragtBetaling"), {
  ssr: false,
  loading: () => (
    <div aria-busy="true" className="mt-4 space-y-3">
      <span className="sr-only">Indlæser betalingen…</span>
      <div className="h-12 animate-pulse rounded-xl bg-skelet" />
      <div className="h-12 animate-pulse rounded-xl bg-skelet" />
      <div className="h-[52px] w-full animate-pulse rounded-lg bg-skelet sm:w-48" />
    </div>
  ),
});

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

// Regningen er åbnet igen, fordi sælgerens bank har tilbageført betalingen.
function Genaabnet({ r }: { r: MinEkstraFragt }) {
  if (!r.genaabnet_kl) return null;
  return (
    <div role="note" className="mt-3 rounded-lg border border-kant bg-white/70 px-3 py-2 text-sm text-tekst">
      <p>
        <span className="font-semibold">
          Regningen er åbnet igen, fordi din bank har tilbageført betalingen{r.genaabn_begrundelse ? ":" : "."}
        </span>
        {r.genaabn_begrundelse && <span className="whitespace-pre-wrap break-words"> {r.genaabn_begrundelse}</span>}
      </p>
      <p className="mt-0.5 text-[13px] text-tekst-daempet">Åbnet igen den {ekstraFragtDato(r.genaabnet_kl)}.</p>
    </div>
  );
}

type Start = { clientSecret: string; customerSessionClientSecret: string | null; beloebOere: number };

export default function EkstraFragtKort({
  r,
  returSti,
  autoBetal = false,
  kanHandle = true,
}: {
  r: MinEkstraFragt;
  // Handelssiden uden query, fx "/mine-handler/<id>" (Stripe sender tilbage hertil).
  returSti: string;
  // ?ekstrafragt=betal: sælgeren kom fra bjælken/mærket - åbn betalingen med det samme.
  autoBetal?: boolean;
  // false i firma-dashboardet før lancering (server actions er lukket).
  kanHandle?: boolean;
}) {
  const beloeb = kroner(r.beloeb_oere);
  const firma = transportoerNavn(r.transportoer) ?? "Fragtfirmaet";
  const titelId = `ekstra-fragt-${r.id}`;

  if (r.status === "betalt") {
    return (
      <Ramme titelId={titelId} tone="succes">
        <h2 id={titelId} className="font-sans text-[16px] font-semibold">
          Ekstra fragt betalt: {beloeb}.
        </h2>
        <p className="mt-1 text-sm">
          Tak, vi har fået din betaling{r.betalt_kl ? ` den ${ekstraFragtDato(r.betalt_kl)}` : ""}. Du får en kvittering på mail, og fakturaen kommer under Min konto → Fakturaer.
        </p>
      </Ramme>
    );
  }
  if (r.status === "frafaldet") {
    return (
      <Ramme titelId={titelId} tone="neutral">
        <h2 id={titelId} className="font-sans text-[16px] font-semibold text-tekst">
          Regningen for ekstra fragt er frafaldet. Du skal ikke betale.
        </h2>
        {(r.afgoerelse_begrundelse || r.frafald_grund) && (
          <p className="mt-1 text-sm text-tekst-daempet">
            Begrundelse fra BidHamr: {r.afgoerelse_begrundelse ?? r.frafald_grund}
          </p>
        )}
      </Ramme>
    );
  }
  if (r.status === "refunderet") {
    return (
      <Ramme titelId={titelId} tone="neutral">
        <h2 id={titelId} className="font-sans text-[16px] font-semibold text-tekst">
          Ekstra fragt refunderet: {beloeb}.
        </h2>
        <p className="mt-1 text-sm text-tekst-daempet">Vi har sendt pengene tilbage til dig. Der kan gå nogle dage, før de står på din konto.</p>
      </Ramme>
    );
  }
  if (r.status === "behandles") {
    return (
      <Ramme titelId={titelId} tone="info">
        <h2 id={titelId} className="font-sans text-[16px] font-semibold">
          Ekstra fragt: {beloeb}. Vi behandler din betaling
        </h2>
        <p className="mt-1 text-sm">Det tager som regel kun et øjeblik. Genindlæs siden om lidt.</p>
        <Genaabnet r={r} />
      </Ramme>
    );
  }
  if (r.status === "indsigelse") {
    return (
      <Ramme titelId={titelId} tone="info">
        <h2 id={titelId} className="font-sans text-[16px] font-semibold">
          BidHamr ser på din indsigelse
        </h2>
        <p className="mt-1 text-sm">
          Ekstra fragt: {beloeb}. Du skal ikke betale, mens vi ser på den. Du kan stadig oprette auktioner. Du får besked, når vi har afgjort den.
        </p>
        <Genaabnet r={r} />
        {r.indsigelse_tekst && (
          <blockquote className="mt-3 rounded-lg border border-info-kant bg-white/70 px-3 py-2 text-sm whitespace-pre-wrap break-words text-tekst">
            {r.indsigelse_tekst}
          </blockquote>
        )}
      </Ramme>
    );
  }

  // afventer_betaling
  return (
    <Ramme titelId={titelId} tone={r.spaerrer ? "fejl" : "advarsel"}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <h2 id={titelId} className="text-[20px] leading-tight text-tekst lg:text-[22px]">
          Ekstra fragt: <span className="font-bold tabular-nums">{beloeb}</span>
        </h2>
        <span
          className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
            r.spaerrer ? "border-fejl-kant bg-white text-fejl-tekst" : "border-advarsel-kant bg-white text-advarsel-tekst"
          }`}
        >
          {r.spaerrer ? "Fristen er overskredet" : `Betal senest ${ekstraFragtDato(r.frist)}`}
        </span>
      </div>
      <p className="mt-2 text-[15px] text-tekst">
        Du valgte <strong className="font-semibold">{valgtStoerrelseNavn(r.valgt_stoerrelse)}</strong>, men{" "}
        {transportoerNavn(r.transportoer) ?? "fragtfirmaet"} målte pakken til{" "}
        <strong className="font-semibold">{maalingTekst(r)}</strong>. Derfor har{" "}
        {transportoerNavn(r.transportoer) ?? "fragtfirmaet"} opkrævet {beloeb} ekstra. Det er fragtfirmaets pris, og som sælger betaler du forskellen.
      </p>
      {r.forklaring && <p className="mt-2 text-sm whitespace-pre-wrap break-words text-tekst-daempet">{r.forklaring}</p>}
      <Genaabnet r={r} />
      {r.afgoerelse === "fastholdt" && r.afgoerelse_begrundelse && (
        <p className="mt-2 rounded-lg border border-kant bg-white/70 px-3 py-2 text-sm text-tekst">
          <span className="font-semibold">Vi har set på din indsigelse og fastholder regningen:</span>{" "}
          {r.afgoerelse_begrundelse}
        </p>
      )}
      {r.spaerrer && (
        <p role="alert" className="mt-3 rounded-lg border border-fejl-kant bg-white px-3 py-2 text-sm font-medium text-fejl-tekst">
          {EKSTRA_FRAGT_SPAERRET_TEKST}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] text-tekst-daempet sm:grid-cols-2">
        {r.sporingsnummer && (
          <div className="min-w-0">
            <dt className="inline">Sporingsnummer: </dt>
            <dd className="inline break-all font-medium text-tekst">{r.sporingsnummer}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="inline">{firma}s fakturanummer: </dt>
          <dd className="inline break-all font-medium text-tekst">{r.fragtfirma_fakturanummer}</dd>
        </div>
      </dl>

      {kanHandle ? (
        <Handlinger r={r} returSti={returSti} autoBetal={autoBetal} />
      ) : (
        <p className="mt-4 text-sm text-tekst-daempet">Du kan betale, når BidHamr åbner for erhvervssælgere.</p>
      )}
    </Ramme>
  );
}

function Ramme({
  titelId,
  tone,
  children,
}: {
  titelId: string;
  tone: "succes" | "neutral" | "info" | "advarsel" | "fejl";
  children: React.ReactNode;
}) {
  const stil = {
    succes: "border-succes-kant bg-succes-bg text-succes-tekst",
    neutral: "border-kant bg-white",
    info: "border-info-kant bg-info-bg text-info-tekst",
    advarsel: "border-advarsel-kant bg-advarsel-bg",
    fejl: "border-fejl-kant bg-fejl-bg",
  }[tone];
  return (
    <section aria-labelledby={titelId} className={`rounded-[14px] border p-5 sm:p-6 ${stil}`}>
      {children}
    </section>
  );
}

function DokumentationKnap({ regningId }: { regningId: string }) {
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  async function hent() {
    if (henter) return;
    setHenter(true);
    setFejl(null);
    try {
      const res = await ekstraFragtDokumentationLink(regningId);
      if ("fejl" in res) setFejl(res.fejl);
      // Linket henter filen (download) - siden bliver stående.
      else window.location.assign(res.url);
    } catch {
      setFejl(GENERISK);
    } finally {
      setHenter(false);
    }
  }
  return (
    <span className="inline-flex flex-col">
      <button type="button" onClick={hent} disabled={henter} aria-busy={henter || undefined} className="btn btn-tekst min-h-11 justify-start">
        {henter && <span className="btn-spinner text-groen" aria-hidden="true" />}
        Se fragtfirmaets dokumentation
      </button>
      {fejl && (
        <span role="alert" className="text-sm text-fejl-tekst">
          {fejl}
        </span>
      )}
    </span>
  );
}

function Handlinger({ r, returSti, autoBetal }: { r: MinEkstraFragt; returSti: string; autoBetal: boolean }) {
  const hydreret = useHydreret();
  const [start, setStart] = useState<Start | null>(null);
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [uenig, setUenig] = useState(false);
  const autoStartet = useRef(false);
  const betalRef = useRef<HTMLDivElement>(null);

  async function begynd() {
    if (henter) return;
    setHenter(true);
    setFejl(null);
    try {
      const res = await startEkstraFragtBetalingAction(r.id);
      if ("fejl" in res) setFejl(res.fejl);
      else
        setStart({
          clientSecret: res.clientSecret,
          customerSessionClientSecret: res.customerSessionClientSecret,
          beloebOere: res.beloebOere,
        });
    } catch {
      setFejl(GENERISK);
    } finally {
      setHenter(false);
    }
  }

  // Fra bjælken/mærket (?ekstrafragt=betal): start betalingen med det samme.
  useEffect(() => {
    if (!autoBetal || !r.kan_betale || autoStartet.current) return;
    autoStartet.current = true;
    void begynd();
    betalRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBetal, r.kan_betale]);

  return (
    <div ref={betalRef} className="mt-4">
      {r.kan_betale && !start && !uenig && (
        <button
          type="button"
          onClick={begynd}
          disabled={henter || !hydreret}
          aria-busy={henter || undefined}
          className="btn btn-primaer btn-stor w-full sm:w-auto"
        >
          {henter && <span className="btn-spinner" aria-hidden="true" />}
          Betal {kroner(r.beloeb_oere)}.
        </button>
      )}
      {start && (
        <EkstraFragtBetaling
          clientSecret={start.clientSecret}
          customerSessionClientSecret={start.customerSessionClientSecret}
          beloebOere={start.beloebOere}
          returSti={returSti}
          onFejl={setFejl}
          onGenstart={() => {
            setStart(null);
            void begynd();
          }}
          onAnnuller={() => {
            setStart(null);
            setFejl(null);
          }}
        />
      )}
      {fejl && (
        <p role="alert" className="mt-3 text-sm font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}

      {!start && (
        <div className="mt-3 flex flex-col items-start gap-x-5 sm:flex-row sm:flex-wrap sm:items-center">
          {r.har_dokumentation && <DokumentationKnap regningId={r.id} />}
          {r.kan_goere_indsigelse && !uenig && (
            <button type="button" onClick={() => setUenig(true)} className="btn btn-tekst min-h-11 font-normal text-tekst-daempet">
              Jeg er uenig i målingen
            </button>
          )}
        </div>
      )}
      {/* Efter fristen kan der ikke gøres indsigelse: henvis til kontakt. */}
      {!start && !r.kan_goere_indsigelse && r.spaerrer && (
        <p className="mt-2 text-sm text-tekst-daempet">
          {EKSTRA_FRAGT_FRIST_OVERSKREDET_UENIG}{" "}
          <Link
            href={`/kontakt?emne=handel&handel=${encodeURIComponent(r.trade_id)}`}
            className="font-medium text-groen underline-offset-2 hover:underline"
          >
            Kontakt os
          </Link>
        </p>
      )}
      {uenig && !start && <Indsigelse r={r} onLuk={() => setUenig(false)} />}
    </div>
  );
}

function Indsigelse({ r, onLuk }: { r: MinEkstraFragt; onLuk: () => void }) {
  const id = useId();
  const router = useRouter();
  const [tekst, setTekst] = useState("");
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const feltRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => feltRef.current?.focus(), []);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (sender) return;
    if (tekst.trim().length < 10) {
      setFejl("Skriv kort, hvorfor du mener, at målingen er forkert (mindst 10 tegn).");
      return;
    }
    setSender(true);
    setFejl(null);
    try {
      const res = await ekstraFragtIndsigelse(r.id, tekst, r.trade_id);
      if ("fejl" in res) {
        setFejl(res.fejl);
        // Fristen er overskredet imens: kortet viser henvisningen til kontakt.
        if (res.kode === "frist_overskredet") router.refresh();
      } else router.refresh();
    } catch {
      setFejl(GENERISK);
    } finally {
      setSender(false);
    }
  }

  return (
    <form onSubmit={send} method="post" noValidate className="mt-3 rounded-xl border border-kant bg-white p-4">
      <label htmlFor={`${id}-tekst`} className="block text-sm font-medium text-tekst">
        Hvorfor mener du, at målingen er forkert?
      </label>
      <p id={`${id}-hjaelp`} className="mt-1 text-[13px] text-tekst-daempet">
        Fx hvor stor pakken var, og hvad den vejede, da du sendte den. Du kan kun gøre indsigelse én gang, og kun før fristen. Du skal ikke betale, mens vi ser på den.
      </p>
      <textarea
        ref={feltRef}
        id={`${id}-tekst`}
        value={tekst}
        onChange={(e) => setTekst(e.target.value)}
        rows={4}
        maxLength={2000}
        disabled={sender}
        aria-describedby={`${id}-hjaelp`}
        aria-invalid={fejl ? true : undefined}
        className="mt-2 min-h-[120px] w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25"
      />
      {fejl && (
        <p role="alert" className="mt-1.5 text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <button type="submit" disabled={sender} aria-busy={sender || undefined} className="btn btn-sekundaer w-full sm:w-auto">
          {sender && <span className="btn-spinner text-groen" aria-hidden="true" />}
          Send indsigelse
        </button>
        <button type="button" onClick={onLuk} disabled={sender} className="btn btn-tekst min-h-11 self-center sm:self-auto">
          Fortryd
        </button>
      </div>
    </form>
  );
}
