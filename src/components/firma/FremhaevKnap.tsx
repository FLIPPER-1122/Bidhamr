"use client";

// "Fremhæv i 7 dage" på en af firmaets aktive auktioner (Firma oversigt ->
// Auktioner). Bekræftelsen vises direkte under knappen (ingen pop op), med
// store knapper. Databasen (firma_fremhaev_auktion) håndhæver alle regler og
// svarer med en kode, som vises som dansk tekst (FIRMA_FREMHAEVNING.fejl).
// Kun efter lancering (før lancering vises knappen ikke - firmaet kan ikke
// kalde server actions, se src/lib/supabase/middleware.ts).
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { fremhaevFirmaAuktion } from "@/app/actions/erhverv";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST } from "@/components/erhverv/stil";
import { FIRMA_FREMHAEV_KNAP as K, FIRMA_FREMHAEVNING as F } from "@/lib/tekster/erhverv";
import { langDato } from "@/lib/erhverv/visning";

export default function FremhaevKnap({ auktionId, tilbage }: { auktionId: string; tilbage: number }) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [svar, setSvar] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const [sender, start] = useTransition();
  const svarRef = useRef<HTMLParagraphElement>(null);

  function fremhaev() {
    setSvar(null);
    start(async () => {
      const res = await fremhaevFirmaAuktion(auktionId);
      setAaben(false);
      if ("fejl" in res) {
        setSvar({ tekst: F.fejl[res.kode] ?? res.fejl ?? F.fejl.generisk, fejl: true });
      } else {
        setSvar({ tekst: F.fremhaevet(langDato(res.slutKl)), fejl: false });
        router.refresh();
      }
      window.requestAnimationFrame(() => svarRef.current?.focus());
    });
  }

  return (
    <div className="w-full sm:w-auto">
      {!aaben && (
        <button
          type="button"
          onClick={() => {
            setAaben(true);
            setSvar(null);
          }}
          className={`${E_KNAP_SEKUNDAER} w-full sm:w-auto`}
        >
          {F.knap}
        </button>
      )}
      {aaben && (
        <div role="group" aria-labelledby={`${id}-t`} className="bg-groen-lys p-4">
          <p id={`${id}-t`} className="text-[19px] font-semibold text-tekst">
            {K.bekraeftTitel}
          </p>
          <p className={`mt-2 ${E_TEKST}`}>{K.bekraeftTekst(tilbage)}</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={fremhaev} disabled={sender} aria-busy={sender || undefined} className={E_KNAP_PRIMAER}>
              {sender && <span className="btn-spinner" aria-hidden="true" />}
              {K.ja}
            </button>
            <button type="button" onClick={() => setAaben(false)} disabled={sender} className={E_KNAP_SEKUNDAER}>
              {K.annuller}
            </button>
          </div>
        </div>
      )}
      {svar && (
        <p
          ref={svarRef}
          tabIndex={-1}
          role={svar.fejl ? "alert" : "status"}
          className={`mt-3 border-2 p-4 text-[18px] font-semibold outline-none ${
            svar.fejl ? "border-fejl-kant bg-fejl-bg text-fejl-tekst" : "border-succes-kant bg-succes-bg text-succes-tekst"
          }`}
        >
          {svar.tekst}
        </p>
      )}
    </div>
  );
}
