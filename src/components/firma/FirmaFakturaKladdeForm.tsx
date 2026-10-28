"use client";

// Ret/udfyld købers oplysninger m.m. i en fakturakladde. Tomme felter bruger
// oplysningerne fra købet (vist som pladsholder).
import { useActionState } from "react";
import { gemFirmaFakturaKladde, type GemKladdeSvar } from "@/app/actions/firmaFaktura";
import { E_FEJL, E_HJAELP, E_KNAP_SEKUNDAER, E_LABEL, eFelt } from "@/components/erhverv/stil";
import { FIRMA_FAKTURA_TEKST as T } from "@/lib/erhverv/firmaFaktura";

type Felter = {
  koeber_navn: string | null;
  koeber_adresse: string | null;
  koeber_postnummer: string | null;
  koeber_by: string | null;
  koeber_email: string | null;
  koeber_firmanavn: string | null;
  koeber_cvr: string | null;
  leveringsdato: string | null;
  varetekst: string | null;
};

export default function FirmaFakturaKladdeForm({
  id,
  rettelser,
  auto,
}: {
  id: string;
  rettelser: Felter;
  // Det, der bruges, hvis feltet er tomt.
  auto: Partial<Record<keyof Felter, string | null>>;
}) {
  const [svar, handling, travl] = useActionState<GemKladdeSvar | null, FormData>(gemFirmaFakturaKladde, null);

  const felt = (navn: keyof Felter, label: string, o: { type?: string; inputMode?: "numeric" | "email"; maks?: number; auto?: string } = {}) => (
    <div>
      <label htmlFor={`kladde-${navn}`} className={E_LABEL}>
        {label}
      </label>
      <input
        id={`kladde-${navn}`}
        name={navn}
        type={o.type ?? "text"}
        inputMode={o.inputMode}
        maxLength={o.maks ?? 200}
        autoComplete={o.auto ?? "off"}
        defaultValue={rettelser[navn] ?? ""}
        placeholder={auto[navn] ?? ""}
        className={eFelt()}
      />
    </div>
  );

  return (
    <form action={handling} className="space-y-4">
      <input type="hidden" name="id" value={id} />
      <p className={E_HJAELP}>{T.udfyldForklaring}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {felt("koeber_navn", "Købers navn")}
        {felt("koeber_email", "Købers e-mail", { type: "email", inputMode: "email", maks: 254 })}
        {felt("koeber_adresse", "Adresse (vej og nr.)")}
        {felt("koeber_postnummer", "Postnummer", { inputMode: "numeric", maks: 4 })}
        {felt("koeber_by", "By", { maks: 100 })}
        {felt("leveringsdato", "Leveringsdato", { type: "date", maks: 10 })}
        {felt("koeber_firmanavn", "Købers firmanavn (hvis oplyst)")}
        {felt("koeber_cvr", "Købers CVR (hvis oplyst)", { inputMode: "numeric", maks: 11 })}
      </div>
      {felt("varetekst", "Varebeskrivelse", { maks: 300 })}
      <button type="submit" disabled={travl} className={E_KNAP_SEKUNDAER}>
        {travl ? "Gemmer …" : "Gem kladden"}
      </button>
      {svar && "fejl" in svar && (
        <p role="alert" className={E_FEJL}>
          {svar.fejl}
        </p>
      )}
      {svar && "ok" in svar && (
        <p role="status" className={E_HJAELP}>
          {svar.mangler.length === 0 ? "Gemt. Fakturaen er klar til at blive sendt." : `Gemt. Mangler stadig: ${svar.mangler.join(" ")}`}
        </p>
      )}
    </form>
  );
}
