"use client";

// "Se din faktura" + "Send" ved et betalt salg (og på fakturasiden).
// "Send" kræver altid en bekræftelse - der sendes aldrig noget uden firmaets
// eget tryk. Efter afsendelse: "Sendt <dato>", "Download PDF" og
// "Lav kreditnota".
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { E_FEJL, E_HJAELP, E_KNAP_PRIMAER, E_KNAP_SEKUNDAER } from "@/components/erhverv/stil";
import { lavFirmaKreditnota, lavNyFirmaFaktura, sendFirmaFaktura, sendFirmaFakturaMailIgen } from "@/app/actions/firmaFaktura";
import { FIRMA_FAKTURA_TEKST as T, datoTekst } from "@/lib/erhverv/firmaFaktura";

export type FakturaKnapperProps = {
  id: string;
  type: "faktura" | "kreditnota";
  status: "kladde" | "sendt";
  fakturanummer: string | null;
  naesteNummer: string;
  koeberEmail: string | null;
  mangler: string[];
  sendtKl: string | null;
  mailFejl: string | null;
  mailSendtKl: string | null;
  kreditnotaId: string | null;
  // Handlen (til "Lav ny faktura" efter kreditnota).
  tradeId?: string;
  // Fakturaen er krediteret (kreditnotaen er sendt).
  krediteretKl?: string | null;
  nyFakturaId?: string | null;
  kanLaveNy?: boolean;
  // Firmaet har ændret modtagerens e-mail, så den afviger fra købers.
  emailAfviger?: boolean;
  // Lukket firmakonto: kun se og hente.
  kunLaes?: boolean;
  // Vis "Se din faktura" (ikke på selve fakturasiden).
  visSe?: boolean;
};

export default function FirmaFakturaKnapper(p: FakturaKnapperProps) {
  const router = useRouter();
  const [bekraeft, setBekraeft] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [fejlListe, setFejlListe] = useState<string[]>([]);
  const [besked, setBesked] = useState<string | null>(null);
  const [travl, startTransition] = useTransition();
  const jaRef = useRef<HTMLButtonElement>(null);
  const kredit = p.type === "kreditnota";

  useEffect(() => {
    if (bekraeft) jaRef.current?.focus();
  }, [bekraeft]);

  const send = () =>
    startTransition(async () => {
      setFejl(null);
      setFejlListe([]);
      const svar = await sendFirmaFaktura(p.id);
      setBekraeft(false);
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        setFejlListe(svar.mangler ?? []);
        return;
      }
      // Det endelige nummer vises nu (bekræftelsen viste kun et eksempel).
      setBesked(svar.mailSendt ? T.sendtSom(svar.fakturanummer, svar.modtager) : T.mailFejl);
      router.refresh();
    });

  const nyFaktura = () =>
    startTransition(async () => {
      setFejl(null);
      if (!p.tradeId) return;
      const svar = await lavNyFirmaFaktura(p.tradeId);
      if ("fejl" in svar) setFejl(svar.fejl);
      else router.push(`/firma/fakturaer/${svar.id}`);
    });

  const mailIgen = () =>
    startTransition(async () => {
      setFejl(null);
      const svar = await sendFirmaFakturaMailIgen(p.id);
      if ("fejl" in svar) setFejl(svar.fejl);
      else setBesked(T.mailSendtIgen);
      router.refresh();
    });

  const kreditnota = () =>
    startTransition(async () => {
      setFejl(null);
      const svar = await lavFirmaKreditnota(p.id);
      if ("fejl" in svar) setFejl(svar.fejl);
      else router.push(`/firma/fakturaer/${svar.id}`);
    });

  const seLink = p.visSe !== false && (
    <Link href={`/firma/fakturaer/${p.id}`} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
      {kredit ? T.seKreditnota : T.seFaktura}
    </Link>
  );

  if (p.status === "sendt") {
    return (
      <div className="space-y-3">
        <p className="text-[17px] font-semibold text-succes-tekst">
          {T.sendt(datoTekst(p.sendtKl))} · {T.nummer} {p.fakturanummer}
        </p>
        <div className="flex flex-wrap gap-3">
          {seLink}
          <a href={`/firma/fakturaer/${p.id}/pdf?download=1`} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
            {T.downloadPdf}
          </a>
          {!kredit && !p.kreditnotaId && !p.kunLaes && (
            <button type="button" onClick={kreditnota} disabled={travl} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
              {T.lavKreditnota}
            </button>
          )}
          {!kredit && p.kreditnotaId && (
            <Link href={`/firma/fakturaer/${p.kreditnotaId}`} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
              {T.seKreditnota}
            </Link>
          )}
          {!kredit && p.krediteretKl && p.kanLaveNy && !p.kunLaes && p.tradeId && (
            <button type="button" onClick={nyFaktura} disabled={travl} className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
              {T.lavNyFaktura}
            </button>
          )}
          {!kredit && p.nyFakturaId && (
            <Link href={`/firma/fakturaer/${p.nyFakturaId}`} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
              {T.seNyFaktura}
            </Link>
          )}
        </div>
        {(p.mailFejl || besked === T.mailFejl) && !p.mailSendtKl && !p.kunLaes && (
          <div role="alert" className="rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-[16px] text-advarsel-tekst">
            <p>{T.mailFejl}</p>
            <button type="button" onClick={mailIgen} disabled={travl} className={`${E_KNAP_SEKUNDAER} mt-3`}>
              {T.sendMailIgen}
            </button>
          </div>
        )}
        {besked && besked !== T.mailFejl && (
          <p role="status" className={E_HJAELP}>
            {besked}
          </p>
        )}
        {fejl && (
          <p role="alert" className={E_FEJL}>
            {fejl}
          </p>
        )}
      </div>
    );
  }

  if (p.kunLaes) {
    return (
      <div className="space-y-3">
        <p className={E_HJAELP}>{T.kunLaes}</p>
        {seLink && <div className="flex flex-wrap gap-3">{seLink}</div>}
      </div>
    );
  }

  const spaerret = p.mangler.length > 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {seLink}
        <button
          type="button"
          onClick={() => setBekraeft(true)}
          disabled={spaerret || travl || bekraeft}
          aria-describedby={spaerret ? `mangler-${p.id}` : undefined}
          className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}
        >
          {travl ? T.sender : T.send}
        </button>
      </div>
      {spaerret && (
        <div id={`mangler-${p.id}`} className="rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-[16px] text-advarsel-tekst">
          <p className="font-semibold">{T.spaerret}</p>
          <ul className="mt-1 list-disc pl-5">
            {p.mangler.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          {p.visSe !== false && (
            <Link href={`/firma/fakturaer/${p.id}`} className="mt-2 inline-block font-semibold text-groen underline underline-offset-2">
              {T.seFaktura}
            </Link>
          )}
        </div>
      )}
      {bekraeft && (
        <div role="alertdialog" aria-labelledby={`bekraeft-${p.id}`} className="rounded-xl border-2 border-groen bg-groen-lys px-4 py-4">
          <p id={`bekraeft-${p.id}`} className="text-[18px] font-semibold text-tekst">
            {T.sendBekraeft(kredit)}
          </p>
          <dl className="mt-2 space-y-1 text-[17px] text-tekst">
            <div>
              <dt className="inline font-semibold">{T.modtager}: </dt>
              <dd className="inline break-all">{p.koeberEmail || T.modtagerMangler}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">{T.nummer}: </dt>
              <dd className="inline">{T.naesteLedige(p.naesteNummer)}</dd>
            </div>
          </dl>
          {p.emailAfviger && (
            <p role="alert" className="mt-2 rounded-xl border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-[16px] text-advarsel-tekst">
              {T.emailAfviger}
            </p>
          )}
          <p className={E_HJAELP}>{T.sendBekraeftForklaring}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button ref={jaRef} type="button" onClick={send} disabled={travl} className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
              {travl ? T.sender : T.sendJa}
            </button>
            <button type="button" onClick={() => setBekraeft(false)} disabled={travl} className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}>
              {T.fortryd}
            </button>
          </div>
        </div>
      )}
      {fejl && (
        <div role="alert" className={E_FEJL}>
          <div>
            <p>{fejl}</p>
            {fejlListe.length > 0 && (
              <ul className="list-disc pl-5 font-normal">
                {fejlListe.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
