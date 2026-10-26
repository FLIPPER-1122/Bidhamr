"use client";

// Ret firmaets oplysninger (opdaterFirma) og send velkomstmailen igen
// (gensendFirmaVelkomst). Chef og sælger må ændre alt ved firmaet (Filip,
// 10. okt. 2026). Pakke og abonnementsstatus skiftes under Hurtighandlinger
// på firmasiden (FirmaHandlinger.tsx).
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import FirmaFelter, { ADMIN_FELT, ADMIN_LABEL, type FirmaVaerdier } from "@/components/admin/erhverv/FirmaFelter";
import { gensendFirmaVelkomst, opdaterFirma } from "@/app/actions/adminErhverv";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";

export default function FirmaRedigering({
  firmaId,
  start,
  harLoggetInd,
}: {
  firmaId: string;
  start: FirmaVaerdier;
  harLoggetInd: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState(start);
  const [note, setNote] = useState("");
  const [besked, setBesked] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const [sender, startSend] = useTransition();

  function gensend() {
    setBesked(null);
    startSend(async () => {
      const svar = await gensendFirmaVelkomst(firmaId);
      setBesked("fejl" in svar ? { tekst: svar.fejl, fejl: true } : { tekst: A.opret.sendtIgen, fejl: false });
    });
  }

  return (
    <div className="space-y-6">
      <FirmaFelter
        vaerdier={v}
        onChange={setV}
        idPraefiks="firma"
      />

      <div>
        <label htmlFor="firma-note" className={ADMIN_LABEL}>
          {X.feltNote}
        </label>
        <input id="firma-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} className={ADMIN_FELT} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <BekraeftDialog
          triggerLabel={X.knapGemFirma}
          title={X.bekraeftGemFirma}
          confirmLabel={X.knapGemFirma}
          onConfirm={async () => {
            setBesked(null);
            const svar = await opdaterFirma({
              firmaId,
              felter: v,
              note: note || null,
            });
            if ("fejl" in svar) return { fejl: svar.fejl };
            setBesked({ tekst: svar.besked ?? X.firmaGemt, fejl: false });
            setNote("");
            router.refresh();
          }}
        />
        {!harLoggetInd && (
          <button type="button" onClick={gensend} disabled={sender} aria-busy={sender || undefined} className="btn btn-sekundaer">
            {sender && <span className="btn-spinner" aria-hidden="true" />}
            {A.opret.knapSendIgen}
          </button>
        )}
      </div>
      {besked && (
        <p
          role={besked.fejl ? "alert" : "status"}
          className={`rounded-lg border px-4 py-3 text-sm font-medium ${besked.fejl ? "border-fejl-kant bg-fejl-bg text-fejl-tekst" : "border-succes-kant bg-succes-bg text-succes-tekst"}`}
        >
          {besked.tekst}
        </p>
      )}
    </div>
  );
}
