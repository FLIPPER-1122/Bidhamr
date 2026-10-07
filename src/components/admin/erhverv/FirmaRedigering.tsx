"use client";

// Ret et firma (opdaterFirma) og send velkomstmailen igen (gensendFirmaVelkomst).
// Rollen saelger må KUN rette adresse og kontaktoplysninger. Firmanavn, CVR,
// pakke og abonnementsstatus kan kun chefen ændre (backend håndhæver det også).
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import FirmaFelter, { ADMIN_FELT, ADMIN_LABEL, type FirmaVaerdier } from "@/components/admin/erhverv/FirmaFelter";
import { gensendFirmaVelkomst, opdaterFirma } from "@/app/actions/adminErhverv";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import {
  ABONNEMENT_STATUSSER,
  ABONNEMENT_STATUS_NAVN,
  type AbonnementStatus,
  type ErhvervPakke,
} from "@/lib/erhverv/regler";

export default function FirmaRedigering({
  firmaId,
  start,
  pakkeId: startPakke,
  status: startStatus,
  pakker,
  erChef,
  harLoggetInd,
}: {
  firmaId: string;
  start: FirmaVaerdier;
  pakkeId: string;
  status: AbonnementStatus;
  pakker: ErhvervPakke[];
  erChef: boolean;
  harLoggetInd: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState(start);
  const [pakkeId, setPakkeId] = useState(startPakke);
  const [status, setStatus] = useState<AbonnementStatus>(startStatus);
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
        laaste={erChef ? [] : ["firmanavn", "cvr"]}
      />

      {erChef && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="firma-pakke" className={ADMIN_LABEL}>
              {A.opret.feltPakke}
            </label>
            <select
              id="firma-pakke"
              value={pakkeId}
              onChange={(e) => setPakkeId(e.target.value)}
              aria-describedby="firma-pakke-hjaelp"
              className={ADMIN_FELT}
            >
              {pakker.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.navn} ({p.auktioner_pr_uge}/uge){p.aktiv ? "" : ` – ${X.skjult}`}
                </option>
              ))}
            </select>
            <p id="firma-pakke-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
              {X.aendrPakkeHjaelp}
            </p>
          </div>
          <div>
            <label htmlFor="firma-status" className={ADMIN_LABEL}>
              {X.feltStatus}
            </label>
            <select
              id="firma-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as AbonnementStatus)}
              className={ADMIN_FELT}
            >
              {ABONNEMENT_STATUSSER.map((s) => (
                <option key={s} value={s}>
                  {ABONNEMENT_STATUS_NAVN[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

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
              pakkeId: erChef && pakkeId !== startPakke ? pakkeId : null,
              status: erChef && status !== startStatus ? status : null,
              note: note || null,
            });
            if ("fejl" in svar) return { fejl: svar.fejl };
            setBesked({ tekst: X.firmaGemt, fejl: false });
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
