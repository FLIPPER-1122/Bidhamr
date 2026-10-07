"use client";

// Abonnement i Firma oversigt: nuværende pakke + alle andre pakker MED
// priser. "Opgradér" (flere auktioner) og "Skift til denne pakke fra næste
// måned" (færre) - altid med en bekræftelse, før noget sker -> skiftFirmaPakke.
// Bekræftelsen vises direkte under pakken (ingen pop op), med store knapper.
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { skiftFirmaPakke } from "@/app/actions/erhverv";
import { FIRMA_OVERSIGT, FIRMA_OVERSIGT_EKSTRA as X } from "@/lib/tekster/erhverv";
import type { ErhvervPakke } from "@/lib/erhverv/regler";
import { kr } from "@/lib/erhverv/visning";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";

const A = FIRMA_OVERSIGT.abonnement;

export function PakkeInfo({ pakke }: { pakke: ErhvervPakke }) {
  return (
    <>
      <p className="text-[22px] font-semibold text-tekst">{pakke.navn}</p>
      <p className={E_TEKST}>{A.auktionerPrUge(pakke.auktioner_pr_uge)}</p>
      <p className={E_TEKST}>{pakke.maanedspris == null ? X.prisIkkeSat : A.prisPrMaaned(kr(pakke.maanedspris))}</p>
      {pakke.beskrivelse && <p className={`mt-1 ${E_TEKST_DAEMPET}`}>{pakke.beskrivelse}</p>}
    </>
  );
}

export default function PakkeValg({
  nuvaerende,
  andre,
  naestePeriode,
  kanSkifte,
  afventerId,
}: {
  nuvaerende: ErhvervPakke;
  andre: ErhvervPakke[];
  // Første dag i næste periode (dansk dato, fx "1. november 2026").
  naestePeriode: string;
  // false, når abonnementet ikke er aktivt (pause/opsagt).
  kanSkifte: boolean;
  // Pakken, der venter på betaling (vises som valgt).
  afventerId: string | null;
}) {
  const router = useRouter();
  const [aaben, setAaben] = useState<string | null>(null);
  const [svar, setSvar] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const [sender, start] = useTransition();
  const svarRef = useRef<HTMLDivElement>(null);

  function skift(p: ErhvervPakke) {
    setSvar(null);
    start(async () => {
      const res = await skiftFirmaPakke(p.id);
      setAaben(null);
      if ("fejl" in res) setSvar({ tekst: res.fejl || A.fejlSkift, fejl: true });
      // Planlagt nedgradering og opgradering, der venter på betaling: siden
      // viser selv en fast besked om det (role="status") efter refresh - så
      // vises der ikke også en besked her (ellers står det samme to gange).
      else if (res.kode === "opgradering_afventer_betaling" || res.kode === "nedgradering_planlagt") setSvar(null);
      else setSvar({ tekst: res.besked, fejl: false });
      router.refresh();
      window.requestAnimationFrame(() => svarRef.current?.focus());
    });
  }

  return (
    <div className="space-y-4">
      {svar && (
        <div
          ref={svarRef}
          tabIndex={-1}
          role={svar.fejl ? "alert" : "status"}
          className={`rounded-xl border-2 p-4 text-[18px] font-semibold outline-none ${
            svar.fejl ? "border-fejl-kant bg-fejl-bg text-fejl-tekst" : "border-succes-kant bg-succes-bg text-succes-tekst"
          }`}
        >
          {svar.tekst}
        </div>
      )}

      {andre.length > 0 && <h3 className="font-sans text-[20px] font-semibold text-tekst">{A.andrePakker}</h3>}
      <ul className="space-y-4">
        {andre.map((p) => {
          const op = p.auktioner_pr_uge > nuvaerende.auktioner_pr_uge;
          const erAaben = aaben === p.id;
          const afventer = afventerId === p.id;
          return (
            <li key={p.id} className="rounded-[14px] border-2 border-kant p-5">
              <PakkeInfo pakke={p} />
              {afventer ? (
                <p className="mt-3 rounded-lg bg-advarsel-bg px-4 py-3 text-[17px] font-semibold text-advarsel-tekst">
                  {X.afventerTitel}
                </p>
              ) : kanSkifte && !erAaben ? (
                <button
                  type="button"
                  onClick={() => {
                    setAaben(p.id);
                    setSvar(null);
                  }}
                  className={`${op ? E_KNAP_PRIMAER : E_KNAP_SEKUNDAER} mt-4 w-full sm:w-auto`}

                >
                  {op ? A.knapOpgrader : A.knapNedgrader}
                </button>
              ) : null}

              {erAaben && (
                <div role="group" aria-labelledby={`skift-${p.id}`} className="mt-4 rounded-xl bg-groen-lys p-4">
                  <p id={`skift-${p.id}`} className="text-[19px] font-semibold text-tekst">
                    {op ? A.bekraeftOpgraderTitel(p.navn) : A.bekraeftNedgraderTitel(p.navn)}
                  </p>
                  <p className={`mt-2 ${E_TEKST}`}>
                    {op ? X.bekraeftOpgraderTekstAfventer : A.bekraeftNedgraderTekst(naestePeriode)}
                  </p>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => skift(p)}
                      disabled={sender}
                      aria-busy={sender || undefined}
                      className={E_KNAP_PRIMAER}
                    >
                      {sender && <span className="btn-spinner" aria-hidden="true" />}
                      {op ? A.bekraeftOpgraderJa(p.navn) : A.bekraeftNedgraderJa}
                    </button>
                    <button type="button" onClick={() => setAaben(null)} disabled={sender} className={E_KNAP_SEKUNDAER}>
                      {A.knapAnnuller}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
