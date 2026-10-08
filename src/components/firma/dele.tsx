// Fælles byggeklodser til firma-dashboardets sider (/firma/*). Stor tekst,
// tydelige overskrifter og ét emne pr. side.
import Image from "next/image";
import Link from "next/link";
import { kanOptimeres } from "@/lib/billedUrl";
import { E_KNAP_PRIMAER, E_KORT, E_KORT_TITEL, E_TEKST_DAEMPET } from "@/components/erhverv/stil";
import { FIRMA_FOER_LANCERING, FIRMA_OVERSIGT } from "@/lib/tekster/erhverv";

export function FirmaSide({
  titel,
  intro,
  tilbage,
  children,
}: {
  titel: string;
  intro?: string;
  tilbage?: { href: string; tekst: string };
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[900px] space-y-6">
      <div>
        {tilbage && (
          <Link
            href={tilbage.href}
            className="mb-2 inline-flex min-h-12 items-center rounded-md text-[17px] font-semibold text-groen underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            ← {tilbage.tekst}
          </Link>
        )}
        <h1 className="text-[32px] leading-tight sm:text-[38px]">{titel}</h1>
        {intro && <p className={`mt-2 ${E_TEKST_DAEMPET}`}>{intro}</p>}
      </div>
      {children}
    </div>
  );
}

export function Kort({
  id,
  titel,
  forklaring,
  children,
}: {
  id: string;
  titel?: string;
  forklaring?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={titel ? id : undefined} className={E_KORT}>
      {titel && (
        <h2 id={id} className={E_KORT_TITEL}>
          {titel}
        </h2>
      )}
      {forklaring && <p className={`mt-1 ${E_TEKST_DAEMPET}`}>{forklaring}</p>}
      <div className={titel || forklaring ? "mt-5" : ""}>{children}</div>
    </section>
  );
}

export function Tal({ label, vaerdi }: { label: string; vaerdi: string }) {
  return (
    <div className="rounded-[14px] bg-groen-lys p-4">
      <p className="text-[17px] text-groen-mork">{label}</p>
      <p className="mt-1 text-[28px] leading-tight font-bold text-tekst tabular-nums">{vaerdi}</p>
    </div>
  );
}

// "BidHamr åbner snart" - øverst på sider, der ikke kan bruges før lancering.
export function LukketBoks({ tekst }: { tekst?: string }) {
  return (
    <div role="status" className="rounded-[18px] border-2 border-info-kant bg-info-bg p-5 text-info-tekst">
      <p className="text-[22px] font-semibold">{FIRMA_FOER_LANCERING.titel}</p>
      <p className="mt-1 text-[18px]">{tekst ?? FIRMA_FOER_LANCERING.tekst}</p>
    </div>
  );
}

// "Opret en auktion": et link til /firma/auktioner/ny, eller en slået-fra
// knap med forklaringen lige under (kvote brugt, intet abonnement, før
// lancering).
export function OpretKnap({ status, id = "opret-forklaring" }: { status: { kan: boolean; forklaring: string | null }; id?: string }) {
  if (status.kan) {
    return (
      <Link href="/firma/auktioner/ny" className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
        {FIRMA_OVERSIGT.auktioner.knapOpret}
      </Link>
    );
  }
  return (
    <div>
      <button type="button" disabled aria-describedby={id} className={`${E_KNAP_PRIMAER} w-full sm:w-auto`}>
        {FIRMA_OVERSIGT.auktioner.knapOpret}
      </button>
      {status.forklaring && (
        <p id={id} className="mt-3 rounded-lg bg-advarsel-bg px-4 py-3 text-[17px] text-advarsel-tekst">
          {status.forklaring}
        </p>
      )}
    </div>
  );
}

// Varens første billede (eller en tom flade) i lister.
export function VareBillede({ url }: { url: string | null }) {
  return (
    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-skelet">
      {url && <Image src={url} alt="" fill sizes="80px" unoptimized={!kanOptimeres(url)} className="object-cover" />}
    </div>
  );
}

export function StatusMaerke({ tekst, farve }: { tekst: string; farve: string }) {
  return (
    <span className={`inline-flex min-h-9 items-center rounded-full border-2 px-3 py-1 text-[16px] font-semibold ${farve}`}>
      {tekst}
    </span>
  );
}

export function Advarsel({ titel, tekst }: { titel?: string; tekst: string }) {
  return (
    <div role="status" className="rounded-[18px] border-2 border-advarsel-kant bg-advarsel-bg p-5 text-advarsel-tekst">
      {titel && <p className="text-[20px] font-semibold">{titel}</p>}
      <p className={`${titel ? "mt-1 " : ""}text-[18px]`}>{tekst}</p>
    </div>
  );
}
