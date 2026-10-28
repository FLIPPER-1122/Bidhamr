// Boksen med varen og fristen ("Meld et problem" og kvitteringen). På
// computeren står den til højre; på mobilen under trinnet. Ingen "use client".
import Image from "next/image";
import Ikon from "@/components/Ikon";
import { kanOptimeres } from "@/lib/billedUrl";
import { SAG_FLOW, SAG_STRIPE, sagUdfyld } from "@/lib/tekster/sagValg";

export type SagVare = {
  titel: string;
  billede: string | null;
  // Fx "2.400 kr".
  beloeb: string;
  saelgerNavn: string | null;
};

export type SagFristVisning = {
  // "1 dag og 4 timer" (regnet på serveren) - null, når fristen ikke gælder.
  tid: string | null;
  dato: string | null;
};

export function VareLinje({ vare, lille = false }: { vare: SagVare; lille?: boolean }) {
  const s = lille ? "h-12 w-12" : "h-[60px] w-[60px]";
  return (
    <div className="flex items-center gap-3">
      <div className={`relative ${s} shrink-0 overflow-hidden border border-kant bg-skelet`}>
        {vare.billede ? (
          <Image
            src={vare.billede}
            alt=""
            fill
            sizes={lille ? "48px" : "60px"}
            unoptimized={!kanOptimeres(vare.billede)}
            className="object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-tekst-svag">
            <Ikon navn="billede" className="h-5 w-5" />
          </span>
        )}
      </div>
      <div className="min-w-0">
        <p className="break-words font-medium leading-snug text-tekst">{vare.titel}</p>
        <p className="text-xs text-tekst-svag">
          {sagUdfyld(SAG_FLOW.side.bud, { beloeb: vare.beloeb })}
          {vare.saelgerNavn ? ` · ${vare.saelgerNavn}` : ""}
        </p>
      </div>
    </div>
  );
}

export function FristBoks({ frist, kort = false }: { frist: SagFristVisning; kort?: boolean }) {
  if (!frist.tid || !frist.dato) return null;
  return (
    <div className="flex items-start gap-2.5 border border-advarsel-kant bg-advarsel-bg px-3.5 py-3 text-advarsel-tekst">
      <Ikon navn="ur" className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        {kort ? (
          <>
            <p className="font-semibold leading-snug">{sagUdfyld(SAG_FLOW.side.fristTid, { tid: frist.tid })}</p>
            <p className="text-[13px]">{sagUdfyld(SAG_FLOW.side.fristUnder, { dato: frist.dato })}</p>
          </>
        ) : (
          <>
            <p className="text-base font-semibold leading-snug">
              {sagUdfyld(SAG_FLOW.handel.fristTitel, { tid: frist.tid })}
            </p>
            <p className="text-[13px]">{sagUdfyld(SAG_FLOW.handel.fristUnder, { dato: frist.dato })}</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function SagVareKort({ vare, frist }: { vare: SagVare; frist: SagFristVisning | null }) {
  return (
    <aside className="border border-kant bg-white p-5" aria-label="Handlen">
      <VareLinje vare={vare} />
      {frist && (
        <div className="mt-4">
          <FristBoks frist={frist} kort />
        </div>
      )}
      <p className="mt-4 text-sm text-tekst-daempet">
        {SAG_FLOW.trin1.note} {SAG_STRIPE}
      </p>
    </aside>
  );
}
