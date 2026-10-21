"use client";

import { useState, useTransition } from "react";
import type { DineroTestResultat } from "@/lib/faktura/forbindelsesTest";

// Admin -> Fakturaer: "Test Dinero-forbindelse" (kun chef). Viser, hvad Dinero
// svarer på login og opslaget af regnskaber. Svaret indeholder aldrig nøgler,
// secret eller token (src/lib/faktura/forbindelsesTest.ts).
type Props = {
  action: () => Promise<{ ok: true; resultat: DineroTestResultat } | { fejl: string }>;
};

const janej = (b: boolean) => (b ? "ja" : "nej");

function Punkt({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const farve = ok === null ? "text-gray-500" : ok ? "text-green-700" : "text-red-700";
  const tegn = ok === null ? "–" : ok ? "✓" : "✗";
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className={`w-4 shrink-0 font-bold ${farve}`}>
        {tegn}
      </span>
      <div className="min-w-0 break-words">{children}</div>
    </li>
  );
}

export default function DineroTestKnap({ action }: Props) {
  const [pending, startTransition] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  const [r, setR] = useState<DineroTestResultat | null>(null);
  const [kl, setKl] = useState<string | null>(null);

  function test() {
    startTransition(async () => {
      setFejl(null);
      const svar = await action();
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      setR(svar.resultat);
      setKl(new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    });
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={test}
        disabled={pending}
        aria-busy={pending}
        className="btn btn-sekundaer btn-lille disabled:opacity-60"
      >
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        Test Dinero-forbindelse
      </button>
      {fejl && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {fejl}
        </p>
      )}
      {r && (
        <div
          role="status"
          className={`rounded-lg border p-4 text-sm ${r.ok ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}
        >
          <p className={`font-semibold ${r.ok ? "text-green-800" : "text-red-800"}`}>{r.overskrift}</p>
          {kl && <p className="mt-0.5 text-xs text-gray-500">Testet kl. {kl}</p>}
          <ul className="mt-3 space-y-1.5">
            <Punkt ok={r.konfigOk}>
              Opsætning: {r.konfigOk ? "godkendt" : r.konfigBesked}
            </Punkt>
            <Punkt ok={r.login === null ? null : r.login.ok}>
              Login hos Dinero:{" "}
              {r.login === null ? "ikke forsøgt" : r.login.ok ? "virker" : r.login.tekst}
            </Punkt>
            <Punkt ok={r.regnskaber === null ? (r.regnskaberFejl ? false : null) : r.regnskaber.length > 0}>
              Regnskaber, nøglen har adgang til:{" "}
              {r.regnskaber === null ? (r.regnskaberFejl ?? "ikke hentet") : r.regnskaber.length === 0 ? "ingen" : null}
              {r.regnskaber && r.regnskaber.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {r.regnskaber.map((o) => (
                    <li key={o.id}>
                      {o.id} – {o.navn}
                      {o.id === r.orgId ? " (DINERO_ORG_ID)" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Punkt>
            <Punkt ok={r.orgFundet}>
              DINERO_ORG_ID {r.orgId ?? "(ugyldig)"} er blandt dem:{" "}
              {r.orgFundet === null ? "ikke tjekket" : janej(r.orgFundet)}
            </Punkt>
            <Punkt ok={r.vaern === null ? null : r.vaern.ok}>
              Regnskabs-værnet (navn og CVR):{" "}
              {r.vaern === null ? "ikke kørt" : r.vaern.ok ? "godkendt" : r.vaern.tekst}
            </Punkt>
          </ul>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-black/10 pt-3 text-xs text-gray-700 sm:grid-cols-2">
            <div>
              <dt className="inline font-medium">Database: </dt>
              <dd className="inline">{r.database === "test" ? "testdatabasen" : "produktion"}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Dinero-miljø: </dt>
              <dd className="inline">{r.miljoe}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Stripe-nøgle: </dt>
              <dd className="inline">
                {r.stripe === "test" ? "test" : r.stripe === "live" ? "live" : r.stripe === "mangler" ? "mangler" : "ukendt form"}
              </dd>
            </div>
            {r.variabler.map((v) => (
              <div key={v.navn}>
                <dt className="inline font-medium">{v.navn}: </dt>
                <dd className="inline">
                  udfyldt {janej(v.udfyldt)}
                  {v.udfyldt ? `, ${v.laengde} tegn` : ""}
                  {v.advarsel && <span className="block text-red-700">{v.advarsel}</span>}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-gray-500">
            Testen sender intet til Dinero og ændrer ikke lampen. Lampen og status her opdateres, næste gang
            fakturakøen kører (betalings-cron&apos;en).
          </p>
        </div>
      )}
    </div>
  );
}
