"use client";

// Momsordning på en fakturakladde (kun faktura, kun kladde - databasen
// afviser alt andet: firma_faktura_kladde_momsordning, 20261102390000).
// Advarer (blokerer ikke), hvis brugtmoms vælges på en ny vare.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { skiftFirmaFakturaMomsordning } from "@/app/actions/firmaFaktura";
import { E_FEJL, E_HJAELP } from "@/components/erhverv/stil";
import { FIRMA_FAKTURA_TEKST as T, erNyVare, type Momsordning } from "@/lib/erhverv/firmaFaktura";

export default function FirmaFakturaMomsValg({
  id,
  momsordning,
  fraStandard,
  stand,
}: {
  id: string;
  momsordning: Momsordning;
  fraStandard: boolean;
  stand: string | null;
}) {
  const router = useRouter();
  const [valg, setValg] = useState<Momsordning>(momsordning);
  const [fejl, setFejl] = useState<string | null>(null);
  const [travl, startTransition] = useTransition();

  const skift = (ny: Momsordning) => {
    const forrige = valg;
    setValg(ny);
    startTransition(async () => {
      setFejl(null);
      const svar = await skiftFirmaFakturaMomsordning(id, ny);
      if ("fejl" in svar) {
        setValg(forrige);
        setFejl(svar.fejl);
        return;
      }
      router.refresh();
    });
  };

  return (
    <fieldset className="space-y-3" disabled={travl}>
      <legend className="text-[20px] font-semibold text-tekst">{T.momsTitel}</legend>
      <label className="flex items-start gap-3 text-[18px]">
        <input type="radio" name={`moms-${id}`} value="moms" checked={valg === "moms"} onChange={() => skift("moms")} className="mt-1 h-6 w-6" />
        <span>{T.momsAlmindelig}</span>
      </label>
      <label className="flex items-start gap-3 text-[18px]">
        <input type="radio" name={`moms-${id}`} value="brugtmoms" checked={valg === "brugtmoms"} onChange={() => skift("brugtmoms")} className="mt-1 h-6 w-6" />
        <span>{T.momsBrugt}</span>
      </label>
      {valg === "brugtmoms" && erNyVare(stand) && (
        <p role="alert" className="rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-[16px] text-advarsel-tekst">
          {T.brugtmomsNyAdvarsel}
        </p>
      )}
      <p className={E_HJAELP}>
        {fraStandard ? `${T.momsFraStandard} ` : ""}
        {T.momsKunKladde}
      </p>
      {fejl && (
        <p role="alert" className={E_FEJL}>
          {fejl}
        </p>
      )}
    </fieldset>
  );
}
