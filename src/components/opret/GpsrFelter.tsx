"use client";

// Producent og sikkerhedsoplysninger (EU's produktsikkerhedsregler, GPSR).
// Vises KUN for firmakonti, når standen er "Ny med mærke" (ny_med_maerke) -
// databasen kræver dem i det tilfælde (auctions_zz_erhverv, BHE04). Private
// ser aldrig felterne.
import { FeltFejl, Hjaelp, tekstfeltKlasse } from "@/components/opret/formular";
import { ERHVERV_GPSR as T } from "@/lib/tekster/erhverv";
import { ERHVERV_GRAENSER as G } from "@/lib/erhverv/regler";

export const GPSR_MIN = 3;

export function gpsrFejl(producent: string, sikkerhed: string) {
  return {
    producent: producent.trim().length < GPSR_MIN ? T.producentMangler : null,
    sikkerhed: sikkerhed.trim().length < GPSR_MIN ? T.sikkerhedMangler : null,
  };
}

export default function GpsrFelter({
  producent,
  sikkerhed,
  onProducent,
  onSikkerhed,
  fejl,
}: {
  producent: string;
  sikkerhed: string;
  onProducent: (v: string) => void;
  onSikkerhed: (v: string) => void;
  fejl?: { producent: string | null; sikkerhed: string | null } | null;
}) {
  return (
    <div className="space-y-5 rounded-xl border border-info-kant bg-info-bg/60 p-4">
      <div>
        <h3 className="font-sans text-[16px] font-semibold text-tekst">{T.titel}</h3>
        <p className="mt-1 text-[14px] text-tekst-daempet">{T.intro}</p>
      </div>
      <div>
        <label htmlFor="producent" className="mb-1.5 block text-sm font-medium text-tekst">
          {T.producentLabel}
        </label>
        <textarea
          id="producent"
          rows={3}
          maxLength={G.producent}
          value={producent}
          onChange={(e) => onProducent(e.target.value)}
          aria-invalid={fejl?.producent ? true : undefined}
          aria-describedby={`producent-hjaelp${fejl?.producent ? " producent-fejl" : ""}`}
          className={`${tekstfeltKlasse(!!fejl?.producent)} min-h-[90px]`}
        />
        <Hjaelp id="producent-hjaelp">{T.producentHjaelp}</Hjaelp>
        {fejl?.producent && <FeltFejl id="producent-fejl">{fejl.producent}</FeltFejl>}
      </div>
      <div>
        <label htmlFor="sikkerhedsoplysninger" className="mb-1.5 block text-sm font-medium text-tekst">
          {T.sikkerhedLabel}
        </label>
        <textarea
          id="sikkerhedsoplysninger"
          rows={4}
          maxLength={G.sikkerhedsoplysninger}
          value={sikkerhed}
          onChange={(e) => onSikkerhed(e.target.value)}
          aria-invalid={fejl?.sikkerhed ? true : undefined}
          aria-describedby={`sikkerhed-hjaelp${fejl?.sikkerhed ? " sikkerhed-fejl" : ""}`}
          className={tekstfeltKlasse(!!fejl?.sikkerhed)}
        />
        <Hjaelp id="sikkerhed-hjaelp">{T.sikkerhedHjaelp}</Hjaelp>
        {fejl?.sikkerhed && <FeltFejl id="sikkerhed-fejl">{fejl.sikkerhed}</FeltFejl>}
      </div>
    </div>
  );
}
