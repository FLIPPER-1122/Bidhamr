"use client";

// Ejerens boks på egen aktive auktion: "Boost i 24 timer (50 point)".
// Status (saldo, pris, om auktionen kan boostes) kommer fra
// min_auktion_boost i databasen; selve boostet laves af serveren
// (brugBoostAction -> boost_brug) med en idempotens-nøgle, så et dobbeltklik
// aldrig trækker point to gange. Har brugeren for få point, vises et tilbud
// om at købe flere.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import BoostetMaerke from "@/components/boost/BoostetMaerke";
import { brugBoostAction } from "@/app/actions/boost";
import { BOOST_TEKST } from "@/lib/boost/tekster";

export type MinAuktionBoost = {
  boostet: boolean;
  slut_kl: string | null;
  kan_booste: boolean;
  grund: string | null;
  saldo: number;
  pris: number;
  timer: number;
  pakke: { point: number; pris_oere: number };
};

export function boostTid(iso: string): string {
  return new Date(iso).toLocaleString("da-DK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Copenhagen",
  });
}

export default function BoostAuktion({ auktionId, status }: { auktionId: string; status: MinAuktionBoost }) {
  const router = useRouter();
  // Én nøgle pr. visning: samme nøgle = samme boost (dobbeltklik, genforsøg).
  const [noegle] = useState(() => crypto.randomUUID());
  const [svar, setSvar] = useState<string | null>(null);
  const koebHref = `/konto/boost?fra=${encodeURIComponent(`/auktion/${auktionId}`)}#koeb`;

  return (
    <section aria-labelledby="boost-titel" className="mb-4 rounded-lg border border-kant bg-white p-4">
      <h2 id="boost-titel" className="text-[15px] font-semibold text-tekst">
        {BOOST_TEKST.auktionTitel}
      </h2>

      {status.boostet && status.slut_kl ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-tekst-daempet">
          <BoostetMaerke lille />
          <span>{BOOST_TEKST.boostetTil(boostTid(status.slut_kl))}</span>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-tekst-daempet">{BOOST_TEKST.auktionIntro(status.timer)}</p>
          {status.grund === "for_faa_point" ? (
            <div className="mt-3">
              <p className="text-sm text-tekst">{BOOST_TEKST.forFaaPoint(status.saldo, status.pris)}</p>
              <Link href={koebHref} className="btn btn-primaer btn-lille mt-3">
                {BOOST_TEKST.koebKnap(status.pakke.point, status.pakke.pris_oere)}
              </Link>
            </div>
          ) : status.kan_booste ? (
            <div className="mt-3">
              <p className="text-sm text-tekst">{BOOST_TEKST.duHar(status.saldo)}</p>
              <div className="mt-3">
                <BekraeftDialog
                  triggerLabel={BOOST_TEKST.boostKnap(status.timer, status.pris)}
                  triggerClassName="btn btn-primaer btn-lille"
                  title={BOOST_TEKST.bekraeftTitel}
                  description={BOOST_TEKST.bekraeftTekst(status.pris, status.timer)}
                  confirmLabel={BOOST_TEKST.boostKnap(status.timer, status.pris)}
                  cancelLabel="Fortryd"
                  onConfirm={async () => {
                    const r = await brugBoostAction(auktionId, noegle);
                    if ("fejl" in r) return { fejl: r.fejl };
                    setSvar(BOOST_TEKST.boostGennemfoert(boostTid(r.slutKl)));
                  }}
                  onSuccess={() => router.refresh()}
                />
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-tekst-daempet">
              {status.grund === "slutter_snart"
                ? BOOST_TEKST.slutterSnart
                : status.grund === "kunst_kontrol"
                  ? BOOST_TEKST.kunstKontrol
                  : status.grund === "erhverv"
                    ? BOOST_TEKST.kunPrivate
                    : status.grund === "spaerret"
                      ? BOOST_TEKST.spaerret
                      : status.grund === "laast"
                        ? BOOST_TEKST.fejl.laast
                        : BOOST_TEKST.fejl.ikke_aktiv}
            </p>
          )}
        </>
      )}
      {svar && (
        <p role="status" className="mt-2 text-sm text-succes-tekst">
          {svar}
        </p>
      )}
    </section>
  );
}
