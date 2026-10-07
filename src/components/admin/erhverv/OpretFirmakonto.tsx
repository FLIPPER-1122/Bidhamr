"use client";

// Opret firmakonto fra en godkendt henvendelse: CVR-opslag (slaaCvrOp) der
// udfylder navn og adresse (ellers tastes de selv), pakke og firmaets e-mail,
// bekræftelse -> opretFirmakonto. Resultatet vises tydeligt bagefter.
import Link from "next/link";
import { useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import FirmaFelter, { ADMIN_FELT, ADMIN_LABEL, type FirmaVaerdier } from "@/components/admin/erhverv/FirmaFelter";
import { opretFirmakonto, slaaCvrOp } from "@/app/actions/adminErhverv";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import { EMAIL, type ErhvervPakke } from "@/lib/erhverv/regler";

export default function OpretFirmakonto({
  henvendelseId,
  start,
  loginEmail: startLogin,
  pakker,
}: {
  henvendelseId: string;
  start: FirmaVaerdier;
  loginEmail: string;
  pakker: ErhvervPakke[];
}) {
  const [v, setV] = useState<FirmaVaerdier>(start);
  const [loginEmail, setLoginEmail] = useState(startLogin);
  const [pakkeId, setPakkeId] = useState(pakker.length === 1 ? pakker[0].id : "");
  const [cvrBesked, setCvrBesked] = useState<{ tekst: string; ok: boolean } | null>(null);
  const [slaarOp, startOpslag] = useTransition();
  const [resultat, setResultat] = useState<{ firmaId: string; besked: string; mailSendt: boolean } | null>(null);

  function cvrOpslag() {
    setCvrBesked(null);
    startOpslag(async () => {
      const svar = await slaaCvrOp(v.cvr);
      if (!("firma" in svar) || !svar.ok) {
        setCvrBesked({ tekst: "fejl" in svar && svar.fejl ? svar.fejl : A.opret.fejl.cvrOpslagFejl, ok: false });
        return;
      }
      const f = svar.firma;
      if (!f.aktiv) {
        setCvrBesked({ tekst: A.opret.fejl.cvrIkkeAktivt, ok: false });
        return;
      }
      setV((gl) => ({
        ...gl,
        cvr: f.cvr,
        firmanavn: f.firmanavn || gl.firmanavn,
        adresse: f.adresse ?? gl.adresse,
        postnummer: f.postnummer ?? gl.postnummer,
        by: f.by ?? gl.by,
      }));
      setCvrBesked({ tekst: X.cvrFundet, ok: true });
    });
  }

  if (resultat) {
    return (
      <div
        role="status"
        className={`rounded-xl border p-5 ${resultat.mailSendt ? "border-succes-kant bg-succes-bg text-succes-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"}`}
      >
        <p className="text-base font-semibold">{resultat.besked}</p>
        <Link href={`/admin/erhverv/firmaer/${resultat.firmaId}`} className="btn btn-sekundaer mt-4">
          {X.seFirma}
        </Link>
      </div>
    );
  }

  const klar = !!pakkeId && EMAIL.test(loginEmail.trim());

  return (
    <div className="space-y-5">
      <p className="text-sm text-neutral-600">{A.opret.forklaring}</p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="opret-cvr-opslag" className={ADMIN_LABEL}>
            {X.felter.cvr}
          </label>
          <input
            id="opret-cvr-opslag"
            inputMode="numeric"
            value={v.cvr}
            onChange={(e) => setV({ ...v, cvr: e.target.value })}
            className={ADMIN_FELT}
          />
        </div>
        <button type="button" onClick={cvrOpslag} disabled={slaarOp} aria-busy={slaarOp || undefined} className="btn btn-sekundaer">
          {slaarOp && <span className="btn-spinner" aria-hidden="true" />}
          {X.knapSlaaCvrOp}
        </button>
      </div>
      {cvrBesked && (
        <p
          role={cvrBesked.ok ? "status" : "alert"}
          className={`rounded-lg border px-4 py-3 text-sm ${cvrBesked.ok ? "border-succes-kant bg-succes-bg text-succes-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"}`}
        >
          {cvrBesked.tekst}
        </p>
      )}

      <FirmaFelter vaerdier={v} onChange={setV} idPraefiks="opret" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="opret-login" className={ADMIN_LABEL}>
            {A.opret.feltEmail}
          </label>
          <input
            id="opret-login"
            type="email"
            inputMode="email"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            className={ADMIN_FELT}
          />
        </div>
        <div>
          <label htmlFor="opret-pakke" className={ADMIN_LABEL}>
            {A.opret.feltPakke}
          </label>
          <select id="opret-pakke" value={pakkeId} onChange={(e) => setPakkeId(e.target.value)} className={ADMIN_FELT} aria-describedby="opret-pakke-hjaelp">
            <option value="">{A.opret.fejl.ingenPakke}</option>
            {pakker.map((p) => (
              <option key={p.id} value={p.id}>
                {p.navn} – {A.pakker.feltAuktioner.toLowerCase()}: {p.auktioner_pr_uge}
                {p.maanedspris != null ? ` – ${p.maanedspris.toLocaleString("da-DK")} kr./md.` : ""}
              </option>
            ))}
          </select>
          <p id="opret-pakke-hjaelp" className="mt-1.5 text-[13px] text-tekst-daempet">
            {A.opret.feltPakkeHjaelp}
          </p>
        </div>
      </div>

      <BekraeftDialog
        triggerLabel={A.opret.knapOpret}
        triggerClassName="btn btn-primaer btn-stor w-full sm:w-auto disabled:opacity-50"
        title={X.bekraeftOpretTitel}
        description={X.bekraeftOpret(loginEmail.trim())}
        confirmLabel={A.opret.knapOpret}
        confirmDisabled={!klar}
        onConfirm={async () => {
          if (!pakkeId) return { fejl: A.opret.fejl.ingenPakke };
          const svar = await opretFirmakonto({
            ...v,
            loginEmail,
            pakkeId,
            henvendelseId,
          });
          if ("fejl" in svar) return { fejl: svar.fejl };
          // Ingen router.refresh her: så ville siden skifte væk fra resultatet.
          setResultat({ firmaId: svar.firmaId, besked: svar.besked, mailSendt: svar.mailSendt });
        }}
      />
    </div>
  );
}
