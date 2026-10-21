"use client";

// Trin 3 på sælgerens reklamationskort: "Fortæl os, hvordan det gik".
// Én knap pr. udfald; knappen folder et lille felt ud lige under sig (ingen
// dialog - færrest klik og nemt på mobil). Databasen afgør adgangen og
// statusskiftene (src/app/actions/reklamation.ts).
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { reklamationAfvist, reklamationAnmeldt, reklamationFravaelg, reklamationGodkendt } from "@/app/actions/reklamation";
import { kroner, type ReklamationStatus } from "@/lib/reklamation/typer";
import { useHydreret } from "@/lib/useHydreret";

type Panel = "anmeldt" | "godkendt" | "afvist" | "fravaelg";

const FELT =
  "mt-1.5 h-11 w-full rounded-xl border border-kant-staerk bg-white px-4 text-base text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 sm:text-[15px]";

export default function ReklamationSaelgerHandlinger({
  reklamationId,
  tradeId,
  status,
  transportoerNavn,
  kravbeloebOere,
  sagsnummer,
}: {
  reklamationId: string;
  tradeId: string;
  status: Extract<ReklamationStatus, "afventer_saelger" | "anmeldt">;
  transportoerNavn: string;
  kravbeloebOere: number;
  sagsnummer: string | null;
}) {
  const router = useRouter();
  const id = useId();
  const hydreret = useHydreret();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [kvittering, setKvittering] = useState<string | null>(null);
  const laas = useRef(false);

  function aabn(p: Panel) {
    setFejl(null);
    setKvittering(null);
    setPanel((gl) => (gl === p ? null : p));
  }

  async function send(fn: () => Promise<{ ok: true; uaendret?: boolean } | { fejl: string }>, ok: string) {
    if (laas.current) return;
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const res = await fn();
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      setPanel(null);
      setKvittering(ok);
      router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setSender(false);
    }
  }

  function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const v = (k: string) => String(fd.get(k) ?? "").trim();
    if (panel === "anmeldt") {
      void send(() => reklamationAnmeldt(reklamationId, v("sagsnummer"), tradeId), "Tak. Vi har noteret, at du har anmeldt skaden.");
    } else if (panel === "godkendt") {
      if (!v("beloeb")) {
        setFejl("Skriv beløbet, du har fået godkendt.");
        return;
      }
      void send(() => reklamationGodkendt(reklamationId, v("beloeb"), tradeId), "Tak. Vi har noteret, at erstatningen er godkendt.");
    } else if (panel === "afvist") {
      void send(() => reklamationAfvist(reklamationId, v("grund"), tradeId), "Tak. Vi har noteret, at erstatningen er afvist.");
    } else if (panel === "fravaelg") {
      void send(() => reklamationFravaelg(reklamationId, tradeId), "Vi har noteret, at du ikke vil reklamere.");
    }
  }

  const knap = (p: Panel, tekst: string, primaer = false) => (
    <button
      type="button"
      onClick={() => aabn(p)}
      aria-expanded={panel === p}
      aria-controls={`${id}-panel`}
      disabled={sender}
      className={`btn w-full sm:w-auto ${primaer ? "btn-primaer" : "btn-sekundaer"}`}
    >
      {tekst}
    </button>
  );

  const sendKnap = (tekst: string, fare = false) => (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
      <button
        type="submit"
        disabled={sender || !hydreret}
        aria-busy={sender}
        className={`btn w-full sm:w-auto ${fare ? "btn-fare" : "btn-primaer"}`}
      >
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        {tekst}
      </button>
      <button type="button" onClick={() => setPanel(null)} disabled={sender} className="btn btn-sekundaer w-full sm:w-auto">
        Fortryd
      </button>
    </div>
  );

  return (
    <div>
      {kvittering && (
        <p role="status" className="mb-3 rounded-xl border border-succes-kant bg-succes-bg px-4 py-3 text-sm text-succes-tekst">
          {kvittering}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {status === "afventer_saelger" ? (
          <>
            {knap("anmeldt", "Jeg har anmeldt", true)}
            {knap("godkendt", "Godkendt")}
            {knap("afvist", "Afvist")}
          </>
        ) : (
          <>
            {knap("godkendt", "Godkendt", true)}
            {knap("afvist", "Afvist")}
            {knap("anmeldt", sagsnummer ? "Ret sagsnummer" : "Tilføj sagsnummer")}
          </>
        )}
      </div>

      {panel && (
        <form
          id={`${id}-panel`}
          onSubmit={indsend}
          method="post"
          className="mt-3 rounded-xl border border-kant bg-groen-lys/60 p-4"
        >
          {panel === "anmeldt" && (
            <>
              <label htmlFor={`${id}-nr`} className="block text-sm font-medium text-tekst">
                {transportoerNavn}s sagsnummer <span className="font-normal text-tekst-svag">(valgfrit)</span>
              </label>
              <input
                id={`${id}-nr`}
                name="sagsnummer"
                defaultValue={sagsnummer ?? ""}
                maxLength={100}
                autoComplete="off"
                disabled={sender}
                className={FELT}
              />
              <p className="mt-1.5 text-[13px] text-tekst-daempet">Står typisk i kvitteringen fra {transportoerNavn}.</p>
              {sendKnap(status === "anmeldt" ? "Gem sagsnummer" : "Ja, jeg har anmeldt")}
            </>
          )}

          {panel === "godkendt" && (
            <>
              <label htmlFor={`${id}-beloeb`} className="block text-sm font-medium text-tekst">
                Godkendt beløb i kr.
              </label>
              <input
                id={`${id}-beloeb`}
                name="beloeb"
                inputMode="decimal"
                autoComplete="off"
                required
                placeholder="Fx 1.250,00"
                disabled={sender}
                aria-describedby={`${id}-beloeb-hj`}
                className={FELT}
              />
              <p id={`${id}-beloeb-hj`} className="mt-1.5 text-[13px] text-tekst-daempet">
                Højst {kroner(kravbeloebOere)} {transportoerNavn} betaler direkte til dig.
              </p>
              {sendKnap("Gem")}
            </>
          )}

          {panel === "afvist" && (
            <>
              <label htmlFor={`${id}-grund`} className="block text-sm font-medium text-tekst">
                Hvad skrev {transportoerNavn}? <span className="font-normal text-tekst-svag">(valgfrit)</span>
              </label>
              <textarea
                id={`${id}-grund`}
                name="grund"
                rows={3}
                maxLength={1000}
                disabled={sender}
                className={`${FELT} h-auto min-h-[96px] py-3`}
              />
              {sendKnap("Gem")}
            </>
          )}

          {panel === "fravaelg" && (
            <>
              <p className="text-sm text-tekst">
                Så får du ikke erstatning for varen. Du kan ikke fortryde det bagefter.
              </p>
              {sendKnap("Jeg vil ikke reklamere", true)}
            </>
          )}

          {fejl && (
            <p role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
              {fejl}
            </p>
          )}
        </form>
      )}

      {panel !== "fravaelg" && (
        <button
          type="button"
          onClick={() => aabn("fravaelg")}
          disabled={sender}
          className="btn-tekst mt-3 text-sm text-tekst-daempet underline-offset-2 hover:underline"
        >
          Jeg vil ikke reklamere
        </button>
      )}
    </div>
  );
}
