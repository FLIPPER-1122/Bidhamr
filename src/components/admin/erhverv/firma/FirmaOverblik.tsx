// Toppen af firmasiden i admin: statuslinjen, "Kræver handling" og
// hurtighandlingerne. Serverkomponenter - knapperne er små klientkomponenter
// (FirmaHandlinger.tsx).
import type { ReactNode } from "react";
import Link from "next/link";
import {
  BookUgeKnap,
  EkstraKort,
  GratisPeriodeKort,
  IntrorabatKort,
  SaerprisKort,
  SkiftPakkeKort,
  StatusKort,
  UgensRabatKort,
  type FirmaRabatTilstand,
  type IntroTilstand,
  type LedigUge,
  type PakkeValg,
} from "@/components/admin/erhverv/firma/FirmaHandlinger";
import { ADMIN_FIRMA as T } from "@/lib/tekster/adminFirma";
import { KORT_LAAST } from "@/components/admin/erhverv/firma/stil";
import type { AbonnementStatus } from "@/lib/erhverv/regler";

export type Lampe = "groen" | "gul" | "roed";

const LAMPE: Record<Lampe, string> = { groen: "bg-lampe-groen", gul: "bg-lampe-gul", roed: "bg-lampe-roed" };

export function StatusLampe({ tone }: { tone: Lampe }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${LAMPE[tone]}`} />;
}

export type StatusCelle = { label: string; vaerdi: ReactNode; under?: ReactNode };

export function FirmaStatuslinje({ celler }: { celler: StatusCelle[] }) {
  return (
    <dl className="grid grid-cols-2 border border-kant bg-white lg:grid-cols-4">
      {celler.map((c, i) => (
        <div
          key={c.label}
          className={`min-w-0 px-4 py-3 ${i % 2 === 1 ? "border-l border-kant" : ""} ${i >= 2 ? "border-t border-kant lg:border-t-0" : ""} ${
            i === 2 ? "lg:border-l" : ""
          }`}
        >
          <dt className="text-xs text-tekst-daempet">{c.label}</dt>
          <dd className="mt-0.5 flex items-center gap-2 break-words text-base font-bold text-tekst">{c.vaerdi}</dd>
          {c.under && <dd className="text-xs text-tekst-daempet">{c.under}</dd>}
        </div>
      ))}
    </dl>
  );
}

export type KraeverPunkt = { id: string; tone: Lampe; tekst: ReactNode; handling?: ReactNode };

export function FirmaKraeverHandling({ punkter }: { punkter: KraeverPunkt[] }) {
  if (punkter.length === 0) return null;
  return (
    <section aria-labelledby="kraever-titel" className="border border-advarsel-kant bg-advarsel-bg px-4 py-3">
      <h2 id="kraever-titel" className="text-sm font-bold text-tekst">
        {T.kraever.titel}
      </h2>
      <ul className="mt-1 divide-y divide-advarsel-kant">
        {punkter.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <p className="flex min-w-0 items-start gap-2 text-sm text-tekst">
              <span className="mt-1.5">
                <StatusLampe tone={p.tone} />
              </span>
              <span className="min-w-0">{p.tekst}</span>
            </p>
            {p.handling && <div className="shrink-0">{p.handling}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Et kort, der ikke kan bruges lige nu, med forklaringen (ingen død knap).
function LaastKort({ titel, under }: { titel: string; under: string }) {
  return (
    <div className={KORT_LAAST}>
      <span className="block text-sm font-bold text-tekst-daempet">{titel}</span>
      {under}
    </div>
  );
}

// Hurtighandlingerne: hvert kort åbner en dialog med bekræftelse og
// begrundelse (alt logges med navn).
export function FirmaHurtighandlinger({
  firmaId,
  pakkeId,
  pakkeNavn,
  pakkePris,
  pakker,
  status,
  opsiges,
  ledigeUger,
  kanBookeUge,
  medBetalingMulig,
  rabat,
  abonnement,
  lukket,
}: {
  firmaId: string;
  pakkeId: string;
  pakkeNavn: string;
  pakkePris: number | null;
  pakker: PakkeValg[];
  status: AbonnementStatus;
  opsiges: boolean;
  ledigeUger: LedigUge[] | null;
  // null = kan bookes; ellers forklaringen.
  kanBookeUge: string | null;
  medBetalingMulig: boolean;
  rabat: FirmaRabatTilstand | null;
  abonnement: {
    saerpris: number | null;
    gratisTil: string | null;
    gratisVedStart: number;
    intro: IntroTilstand;
    // "Behold Starts gratis måned + introrabat" kan vælges (Start, intet
    // abonnement endnu, gratis måned til gode, ingen særpris).
    beholdGratisMulig: boolean;
    // Introrabatten er planlagt eller kører (intro_til tom eller i fremtiden).
    introAktiv: boolean;
    ekstraAuktioner: number;
    ekstraFremh: number;
    ubegraenset: boolean;
  };
  // Kontoen er lukket permanent: abonnementet kan ikke ændres mere.
  lukket: boolean;
}) {
  const a = abonnement;
  return (
    <section aria-labelledby="hurtig-titel">
      <h2 id="hurtig-titel" className="mb-2 text-sm font-bold text-tekst">
        {T.hurtig.titel}
      </h2>
      <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2 lg:grid-cols-4">
        <SkiftPakkeKort firmaId={firmaId} pakkeId={pakkeId} pakker={pakker} harSaerpris={a.saerpris != null} />
        <StatusKort firmaId={firmaId} status={status} opsiges={opsiges} />
        {lukket ? (
          <LaastKort titel={T.hurtig.gratis.titel} under={T.hurtig.uge.underIkkeAktiv} />
        ) : (
          <GratisPeriodeKort firmaId={firmaId} gratisTil={a.gratisTil} vedStart={a.gratisVedStart} />
        )}
        {/* Særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026): har
            firmaet den ene, er kortet for den anden låst med en forklaring.
            Har et firma begge fra før reglen, er begge kort åbne, så den ene
            kan fjernes (serveren afviser at sætte en ny). */}
        {lukket ? (
          <LaastKort titel={T.hurtig.intro.titel} under={T.hurtig.uge.underIkkeAktiv} />
        ) : a.saerpris != null && !a.introAktiv ? (
          <LaastKort titel={T.hurtig.intro.titel} under={T.hurtig.intro.laastSaerpris} />
        ) : (
          <IntrorabatKort firmaId={firmaId} intro={a.intro} iGratisPeriode={a.gratisTil != null} beholdGratisMulig={a.beholdGratisMulig} />
        )}
        {lukket ? (
          <LaastKort titel={T.hurtig.saerpris.titel} under={T.hurtig.uge.underIkkeAktiv} />
        ) : a.introAktiv && a.saerpris == null ? (
          <LaastKort titel={T.hurtig.saerpris.titel} under={T.hurtig.saerpris.laastIntro} />
        ) : (
          <SaerprisKort firmaId={firmaId} saerpris={a.saerpris} pakkeNavn={pakkeNavn} pakkePris={pakkePris} />
        )}
        {a.ubegraenset ? (
          <LaastKort titel={T.hurtig.ekstra.auktionerTitel} under={T.hurtig.ekstra.ubegraenset} />
        ) : (
          <EkstraKort firmaId={firmaId} hvad="auktioner" ekstra={a.ekstraAuktioner} />
        )}
        <EkstraKort firmaId={firmaId} hvad="fremhaevninger" ekstra={a.ekstraFremh} />
        {ledigeUger && ledigeUger.length > 0 && !kanBookeUge ? (
          <BookUgeKnap firmaId={firmaId} uger={ledigeUger} trigger="kort" medBetalingMulig={medBetalingMulig} />
        ) : ledigeUger ? (
          <LaastKort titel={T.hurtig.uge.titel} under={kanBookeUge ?? T.hurtig.uge.underIngen} />
        ) : null}
        {rabat && <UgensRabatKort firmaId={firmaId} rabat={rabat} trigger="kort" />}
      </div>
    </section>
  );
}

export function FaneLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex min-h-11 items-center text-sm font-semibold text-groen hover:underline sm:min-h-9">
      {children} →
    </Link>
  );
}
