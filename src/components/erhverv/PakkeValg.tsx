"use client";

// Abonnement i Firma oversigt: nuværende pakke + alle andre pakker MED
// priser. "Opgradér" (flere auktioner) og "Skift til denne pakke fra næste
// måned" (færre) - altid med en bekræftelse, før noget sker -> skiftFirmaPakke
// via /api/offentlig/firma-skift-pakke (ikke som server action: firmakonti må
// før lancering ikke kalde server actions - se src/lib/supabase/middleware.ts).
// Bekræftelsen vises direkte under pakken (ingen pop op), med store knapper.
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { SkiftPakkeSvar } from "@/app/actions/erhverv";
import { kaldOffentligHandling } from "@/lib/offentligHandling";
import { FIRMA_ABONNEMENT as FA, FIRMA_OVERSIGT, FIRMA_OVERSIGT_EKSTRA as X, FIRMA_PAKKER } from "@/lib/tekster/erhverv";
import { erStoerrePakke, type ErhvervPakke } from "@/lib/erhverv/regler";
import { kr, krFraOere } from "@/lib/erhverv/visning";
import { oereMedRabat, velkomstVisning, type VelkomstSkiftUdfald } from "@/lib/erhverv/abonnementRegler";
import { E_KNAP_PRIMAER, E_KNAP_SEKUNDAER, E_TEKST, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { erStripeAdresse } from "@/components/erhverv/StripeKnap";

const A = FIRMA_OVERSIGT.abonnement;

export function PakkeInfo({ pakke }: { pakke: ErhvervPakke }) {
  return (
    <>
      <p className="text-[22px] font-semibold text-tekst">{pakke.navn}</p>
      <p className={E_TEKST}>{FIRMA_PAKKER.auktionerPrMaaned(pakke.auktioner_pr_maaned)}</p>
      {pakke.fremhaevninger_pr_maaned > 0 && (
        <p className={E_TEKST}>{FIRMA_PAKKER.fremhaevningerPrMaaned(pakke.fremhaevninger_pr_maaned)}</p>
      )}
      {pakke.statistik !== "ingen" && <p className={E_TEKST}>{FIRMA_PAKKER.statistik[pakke.statistik]}</p>}
      {pakke.ugens_butik_rabat_procent > 0 && pakke.ugens_butik_rabat_antal > 0 && (
        <p className={E_TEKST}>{FIRMA_PAKKER.ugensButikRabat(pakke.ugens_butik_rabat_procent, pakke.ugens_butik_rabat_antal)}</p>
      )}
      {pakke.fast_kontaktperson && <p className={E_TEKST}>{FIRMA_PAKKER.fastKontaktperson}</p>}
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
  iGratisPeriode = false,
  velkomstSkift = null,
}: {
  nuvaerende: ErhvervPakke;
  andre: ErhvervPakke[];
  // Første dag i næste periode (dansk dato, fx "1. november 2026").
  naestePeriode: string;
  // false, når abonnementet ikke er aktivt (pause/opsagt).
  kanSkifte: boolean;
  // Pakken, der venter på betaling (vises som valgt).
  afventerId: string | null;
  // I den gratis periode gælder et pakkeskift med det samme uden betaling.
  iGratisPeriode?: boolean;
  // Den gratis periode er kun Starts velkomstmåned: et skift op til en pakke
  // med halv pris i måned 1 (Butik/Pro) koster pakkens pris med rabat nu
  // (Filip, 27. okt. 2026). Hvad skiftet gør (velkomstSkiftVisning - samme
  // regel som serveren): skift med en rabat (beløbet vises), venter (rabatten
  // sættes op først, intet trækkes) eller ret_rabat (kan ikke skifte nu).
  // null: ikke Starts velkomstmåned.
  velkomstSkift?: VelkomstSkiftUdfald | null;
}) {
  const router = useRouter();
  const [aaben, setAaben] = useState<string | null>(null);
  const [svar, setSvar] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const [sender, start] = useTransition();
  const svarRef = useRef<HTMLDivElement>(null);

  // Et skift op fra Starts gratis måned til en pakke, der ikke er gratis i
  // måned 1: siden viser beløbet ud fra velkomstSkift og sender det viste med.
  const fraVelkomst = (p: ErhvervPakke, op: boolean) =>
    !!velkomstSkift && iGratisPeriode && op && p.maaned1 !== "gratis" && p.maanedspris != null;

  function skift(p: ErhvervPakke, op: boolean) {
    setSvar(null);
    start(async () => {
      const fd = new FormData();
      fd.set("pakkeId", p.id);
      if (velkomstSkift && fraVelkomst(p, op)) fd.set("visning", velkomstVisning(velkomstSkift));
      const res = await kaldOffentligHandling<SkiftPakkeSvar>("firma-skift-pakke", fd);
      // Kortet skal godkendes (3D Secure), eller betalingen fejlede: videre
      // til Stripes fakturaside for at betale forskellen.
      if (!("fejl" in res) && res.kode === "betal_forskellen" && erStripeAdresse(res.url)) {
        setSvar({ tekst: res.besked, fejl: false });
        window.location.assign(res.url);
        return;
      }
      setAaben(null);
      if ("fejl" in res) setSvar({ tekst: res.fejl || A.fejlSkift, fejl: true });
      // Planlagt nedgradering og opgradering, der venter på betaling: siden
      // viser selv en fast besked om det (role="status") efter refresh - så
      // vises der ikke også en besked her (ellers står det samme to gange).
      else if (
        res.kode === "opgradering_afventer_betaling" ||
        res.kode === "nedgradering_planlagt" ||
        res.kode === "betal_forskellen"
      )
        setSvar(null);
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
          const op = erStoerrePakke(p, nuvaerende);
          const erAaben = aaben === p.id;
          const afventer = afventerId === p.id;
          return (
            <li key={p.id} className="rounded-none border-2 border-kant p-5">
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
                  {op ? A.knapOpgrader : iGratisPeriode ? FA.knapSkiftNu : A.knapNedgrader}
                </button>
              ) : null}

              {erAaben && (
                <div role="group" aria-labelledby={`skift-${p.id}`} className="mt-4 rounded-xl bg-groen-lys p-4">
                  <p id={`skift-${p.id}`} className="text-[19px] font-semibold text-tekst">
                    {op || iGratisPeriode ? A.bekraeftOpgraderTitel(p.navn) : A.bekraeftNedgraderTitel(p.navn)}
                  </p>
                  <p className={`mt-2 ${E_TEKST}`}>
                    {velkomstSkift && fraVelkomst(p, op) && p.maanedspris != null
                      ? velkomstSkift.udfald === "skift"
                        ? FA.bekraeftOpgraderFraGratisMaaned(
                            p.navn,
                            FA.beloebMedMoms(
                              krFraOere(oereMedRabat(p.maanedspris, velkomstSkift.rabat.procent).ekskl),
                              krFraOere(oereMedRabat(p.maanedspris, velkomstSkift.rabat.procent).inkl),
                            ),
                            velkomstSkift.rabat,
                          )
                        : velkomstSkift.udfald === "venter"
                          ? FA.bekraeftOpgraderVenterRabat
                          : FA.bekraeftOpgraderRetRabat
                      : iGratisPeriode
                        ? op
                          ? FA.bekraeftOpgraderGratis
                          : FA.bekraeftNedgraderGratis
                        : op
                          ? X.bekraeftOpgraderTekstAfventer
                          : A.bekraeftNedgraderTekst(naestePeriode)}
                  </p>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    {/* ret_rabat: intet at trykke på (serveren ville afvise). */}
                    {!(velkomstSkift?.udfald === "ret_rabat" && fraVelkomst(p, op)) && (
                      <button
                        type="button"
                        onClick={() => skift(p, op)}
                        disabled={sender}
                        aria-busy={sender || undefined}
                        className={E_KNAP_PRIMAER}
                      >
                        {sender && <span className="btn-spinner" aria-hidden="true" />}
                        {velkomstSkift?.udfald === "venter" && fraVelkomst(p, op)
                          ? FA.knapSaetRabatOp
                          : op
                            ? A.bekraeftOpgraderJa(p.navn)
                            : iGratisPeriode
                              ? FA.bekraeftNedgraderGratisJa
                              : A.bekraeftNedgraderJa}
                      </button>
                    )}
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
