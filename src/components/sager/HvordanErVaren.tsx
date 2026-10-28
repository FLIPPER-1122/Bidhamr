// Handelssiden, køberen: indgangen til "Meld et problem"
// (showcase/opret-sag-showcase.html skærm 0 og 2). Server-komponent.
//   - Pakken er leveret: "Hvordan er varen?" øverst med tid tilbage og to lige
//     store valg - "Alt er i orden" (godkend) og "Der er et problem med varen".
//   - Fristen er udløbet: det står tydeligt, og kun "Godkend" er tilbage.
//   - Pakken er på vej: "Jeg har ikke fået pakken", når det kan meldes -
//     ellers hvornår det kan.
import Link from "next/link";
import Ikon from "@/components/Ikon";
import { GodkendPakkeKnap } from "@/components/HandelHandlinger";
import type { SagMuligheder } from "@/lib/sagMuligheder";
import { SAG_FLOW, sagUdfyld } from "@/lib/tekster/sagValg";
import { FristBoks, type SagFristVisning } from "./meld/SagVareKort";
import { sagTid } from "./visning";

const VALG_KLASSE =
  "flex min-h-[128px] w-full flex-col items-start gap-2.5 border-[1.5px] bg-white p-3.5 text-left transition-colors hover:bg-groen-lys focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen";

export function meldSti(tradeId: string): string {
  return `/mine-handler/${encodeURIComponent(tradeId)}/sag`;
}

export function HvordanErVaren({
  tradeId,
  muligheder,
  frist,
  udloebetKl,
  erhverv,
}: {
  tradeId: string;
  muligheder: SagMuligheder;
  // Tid tilbage (regnet på serveren); null = fristen er udløbet.
  frist: SagFristVisning | null;
  // Fristen, når den er udløbet (til teksten).
  udloebetKl: string | null;
  // Køb fra et firma (ingen BidHamr Beskyttelse - forklaringen vises).
  erhverv: boolean;
}) {
  const h = SAG_FLOW.handel;
  const kan = muligheder.kanOprettes;
  return (
    <section aria-labelledby="hvordan-titel" className="border border-kant bg-white">
      <div className="bg-groen-lys p-4 sm:p-5">
        <h2 id="hvordan-titel" className="text-[17px] leading-snug text-groen-mork lg:text-lg">
          {h.leveretTitel}
        </h2>
        <p className="mt-1 text-sm text-tekst">{h.leveretTekst}</p>
      </div>
      <div className="p-4 sm:p-5">
        {kan && frist ? (
          <FristBoks frist={frist} />
        ) : (
          !kan &&
          udloebetKl && (
            <div className="border border-advarsel-kant bg-advarsel-bg px-3.5 py-3 text-advarsel-tekst">
              <p className="font-semibold">{h.udloebetTitel}</p>
              <p className="text-sm">{sagUdfyld(h.udloebetTekst, { dato: sagTid(udloebetKl) })}</p>
            </div>
          )
        )}

        {muligheder.kraeverBeskyttelse.length > 0 && (
          <p className="mt-3 border border-info-kant bg-info-bg p-3 text-sm text-info-tekst">
            {erhverv
              ? h.kraeverBeskyttelseErhverv
              : h.kraeverBeskyttelse}{" "}
            <Link href="/bidhamr-beskyttelse" className="font-semibold underline">
              {h.laesMere}
            </Link>
          </p>
        )}

        <h3 className="mt-5 text-[17px] font-semibold text-tekst">{h.hvordan}</h3>
        <div className={`mt-2.5 grid gap-2.5 ${kan ? "grid-cols-2" : "grid-cols-1 sm:max-w-xs"}`}>
          <GodkendPakkeKnap
            tradeId={tradeId}
            triggerClassName={`${VALG_KLASSE} border-kant-staerk hover:border-groen`}
            triggerLabel={
              <>
                <span className="grid h-[46px] w-[46px] place-items-center bg-groen-lys text-groen-mork" aria-hidden="true">
                  <Ikon navn="flueben" className="h-6 w-6" />
                </span>
                <span>
                  <span className="block text-base font-semibold leading-snug text-tekst">{h.altIOrden}</span>
                  <span className="mt-0.5 block text-[13.5px] font-normal text-tekst-daempet">{h.altIOrdenUnder}</span>
                </span>
              </>
            }
          />
          {kan && (
            <Link href={meldSti(tradeId)} className={`${VALG_KLASSE} border-orange-knap`}>
              <span className="grid h-[46px] w-[46px] place-items-center bg-orange-lys text-orange-knap" aria-hidden="true">
                <AdvarselIkon />
              </span>
              <span>
                <span className="block text-base font-semibold leading-snug text-tekst">{h.problem}</span>
                <span className="mt-0.5 block text-[13.5px] text-tekst-daempet">{h.problemUnder}</span>
              </span>
            </Link>
          )}
        </div>
        {kan && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-tekst-svag">
            <Ikon navn="pakke" className="h-4 w-4 shrink-0" />
            {h.gemPakken}
          </p>
        )}
      </div>
    </section>
  );
}

// Pakken er på vej: "Jeg har ikke fået pakken" (når det kan meldes), eller
// hvornår det kan.
export function IkkeKommet({ tradeId, muligheder }: { tradeId: string; muligheder: SagMuligheder }) {
  const h = SAG_FLOW.handel;
  if (muligheder.kanOprettes) {
    return (
      <div className="mt-4 border-t border-kant pt-4">
        <p className="text-sm font-semibold text-tekst">{h.ikkeKommetTitel}</p>
        {muligheder.fristKl && (
          <p className="mt-0.5 text-sm text-tekst-daempet">
            {sagUdfyld(h.ikkeKommetNu, { dato: sagTid(muligheder.fristKl) })}
          </p>
        )}
        <Link href={meldSti(tradeId)} className="btn btn-sekundaer mt-3 w-full sm:w-auto">
          {h.ikkeKommet}
        </Link>
      </div>
    );
  }
  if (!muligheder.bortkommetFraKl) return null;
  return (
    <div className="mt-4 border-t border-kant pt-4">
      <p className="text-sm font-semibold text-tekst">{h.ikkeKommetTitel}</p>
      <p className="mt-0.5 text-sm text-tekst-daempet">
        {sagUdfyld(h.ikkeKommetVenter, { dato: sagTid(muligheder.bortkommetFraKl) })}
      </p>
    </div>
  );
}

function AdvarselIkon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z" />
      <path d="M12 16h.01" />
    </svg>
  );
}
