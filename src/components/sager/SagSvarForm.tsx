"use client";

// Sælgerens forklaring på en sag (regel 3, Filip 27. okt. 2026): tekst og op
// til 10 billeder, én gang, inden for 48 timer fra oprettelsen. Databasen
// (sag_svar_send) tjekker part, frist, kontaktinfo og billeder - her vises
// kun fejlen tidligt. Billederne uploades til 'sag-billeder' i sælgerens egen
// mappe (<sælger-id>/<handel-id>/...) ved afsendelse.
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { svarPaaSag } from "@/app/actions/sager";
import Ikon from "@/components/Ikon";
import { indeholderKontaktinfo } from "@/lib/kontaktInfo";
import {
  SAG_SVAR_FEJL,
  SAG_SVAR_MAKS,
  SAG_SVAR_MAKS_BILLEDER,
  SAG_SVAR_MIN,
} from "@/lib/sager";
import { SAG_FLOW, SAG_SAELGER_SVAR, SAG_SAELGER_SVAR_FORM, SAG_TEKST, sagUdfyld } from "@/lib/tekster/sagValg";
import { useHydreret } from "@/lib/useHydreret";
import BilledVaelger, { useFrigivPreviews, type KategoriFelt } from "./BilledVaelger";
import { uploadBilleder, type ValgtBillede } from "./sagUpload";

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

export default function SagSvarForm({
  sagId,
  tradeId,
  saelgerId,
  fristTekst,
}: {
  sagId: string;
  tradeId: string;
  saelgerId: string;
  // Fx "ons. 29. okt. 10.24".
  fristTekst: string;
}) {
  const router = useRouter();
  const id = useId();
  const hydreret = useHydreret();
  const [aaben, setAaben] = useState(false);
  const [tekst, setTekst] = useState("");
  const [billeder, setBilleder] = useState<ValgtBillede[]>([]);
  const [visFejl, setVisFejl] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sender, setSender] = useState(false);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  const felter: KategoriFelt[] = [
    {
      kategori: "andet",
      overskrift: SAG_SAELGER_SVAR.billederTitel.replace(/\s*\(valgfrit\)$/, ""),
      hjaelp: SAG_SAELGER_SVAR.billederHjaelp,
      paakraevet: false,
    },
  ];
  const laengde = tekst.trim().length;
  const kontakt = indeholderKontaktinfo(tekst);
  const tekstFejl = kontakt
    ? SAG_SVAR_FEJL.kontaktinfo
    : visFejl && (laengde < SAG_SVAR_MIN || laengde > SAG_SVAR_MAKS)
      ? SAG_SVAR_FEJL.ugyldig_tekst
      : null;

  if (sendt) {
    return (
      <p role="status" className="border border-succes-kant bg-succes-bg px-4 py-3 text-sm text-succes-tekst">
        {SAG_SAELGER_SVAR_FORM.tak}
      </p>
    );
  }

  if (!aaben) {
    return (
      // Fristen står allerede i "Det skal du gøre nu" (SagVisning).
      <button type="button" onClick={() => setAaben(true)} className="btn btn-primaer w-full sm:w-auto">
        <Ikon navn="besked" className="h-5 w-5" />
        {SAG_SAELGER_SVAR_FORM.knap}
      </button>
    );
  }

  async function send() {
    if (laas.current) return;
    setFejl(null);
    if (kontakt || laengde < SAG_SVAR_MIN || laengde > SAG_SVAR_MAKS) {
      setVisFejl(true);
      return;
    }
    laas.current = true;
    setSender(true);
    try {
      let klare = billeder;
      if (billeder.length > 0) {
        const res = await uploadBilleder(saelgerId, tradeId, billeder, (n, i) =>
          setFremskridt(sagUdfyld(SAG_FLOW.trin4.uploader, { n, ialt: i })),
        );
        setBilleder(res.billeder);
        if ("fejl" in res) {
          setFejl(res.fejl);
          return;
        }
        klare = res.billeder;
      }
      setFremskridt(SAG_SAELGER_SVAR_FORM.sender);
      const r = await svarPaaSag(
        sagId,
        tekst,
        klare.map((b) => ({ sti: b.sti!, kategori: b.kategori })),
      );
      if ("fejl" in r) {
        setFejl(r.fejl);
        return;
      }
      setSendt(true);
      router.refresh();
    } catch {
      setFejl(GENERISK);
    } finally {
      laas.current = false;
      setSender(false);
      setFremskridt(null);
    }
  }

  return (
    <div className="border border-kant bg-white p-4">
      <h4 className="text-[17px] font-semibold text-tekst">{SAG_SAELGER_SVAR.titel}</h4>
      <p className="mt-1 text-sm text-tekst-daempet">{SAG_SAELGER_SVAR.hjaelp}</p>
      <p className="mt-1 text-xs text-tekst-svag">{sagUdfyld(SAG_SAELGER_SVAR_FORM.frist, { dato: fristTekst })}</p>

      <label htmlFor={`${id}-tekst`} className="mt-4 block text-sm font-semibold text-tekst">
        {SAG_SAELGER_SVAR_FORM.label}
      </label>
      <textarea
        id={`${id}-tekst`}
        value={tekst}
        onChange={(e) => setTekst(e.target.value)}
        maxLength={SAG_SVAR_MAKS}
        rows={5}
        disabled={sender}
        placeholder={SAG_SAELGER_SVAR_FORM.pladsholder}
        aria-invalid={!!tekstFejl}
        aria-describedby={tekstFejl ? `${id}-fejl` : undefined}
        className={`mt-1.5 min-h-[130px] w-full resize-y border bg-white px-3.5 py-3 text-base leading-relaxed text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25 ${
          tekstFejl ? "border-fejl-kant" : "border-kant-staerk"
        }`}
      />
      {tekstFejl && (
        <p id={`${id}-fejl`} role="alert" className="mt-1.5 text-sm text-fejl-tekst">
          {tekstFejl}
        </p>
      )}
      <p className="mb-2 mt-3 text-xs text-tekst-svag">{SAG_TEKST.forslagIntro}</p>
      <ul className="flex flex-wrap gap-2">
        {SAG_SAELGER_SVAR.forslag.map((f) => (
          <li key={f}>
            <button
              type="button"
              disabled={sender}
              onClick={() => setTekst((t) => (t.trim() ? `${t.trim()} ${f}` : f))}
              className="min-h-[38px] border border-groen-lys bg-groen-lys px-3 py-1.5 text-left text-sm font-medium leading-snug text-groen-mork hover:border-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
            >
              {f}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-5">
        <BilledVaelger
          felter={felter}
          billeder={billeder}
          onChange={setBilleder}
          maks={SAG_SVAR_MAKS_BILLEDER}
          laast={sender}
        />
      </div>

      {fejl && (
        <p role="alert" className="mt-4 border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      {fremskridt && (
        <p role="status" aria-live="polite" className="mt-3 text-sm text-tekst-daempet">
          {fremskridt}
        </p>
      )}
      <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={() => setAaben(false)} disabled={sender} className="btn btn-sekundaer">
          {SAG_FLOW.annuller}
        </button>
        <button
          type="button"
          onClick={send}
          disabled={sender || !hydreret}
          aria-busy={sender}
          className="btn btn-primaer"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          {SAG_SAELGER_SVAR_FORM.send}
        </button>
      </div>
    </div>
  );
}
