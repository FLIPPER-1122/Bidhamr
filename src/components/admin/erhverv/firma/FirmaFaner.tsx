// Fanernes indhold på firmasiden i admin. Serverkomponenter; data hentes af
// siden (src/app/admin/erhverv/firmaer/[id]/page.tsx) - kun for den aktive fane.
import type { ReactNode } from "react";
import Link from "next/link";
import AdminBadge, { type BadgeTone } from "@/components/admin/AdminBadge";
import AdminFejl from "@/components/admin/AdminFejl";
import { dato, datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import { AnnullerUgeKnap, BookUgeKnap, UgensRabatKort, type LedigUge } from "@/components/admin/erhverv/firma/FirmaHandlinger";
import { mandag, ugeNr } from "@/components/admin/erhverv/firma/stil";
import { KlageStatusMaerke } from "@/components/erhverv/klager/visning";
import type { FirmaAuktion, FirmaHandel, FirmaKvote, FirmaLogRaekke, FirmaRegning, FirmaUgensButik, UgensBooking } from "@/lib/admin/firmaSide";
import type { AdminKlageRaekke } from "@/app/actions/adminErhvervKlager";
import { salgStatus } from "@/lib/erhverv/firmaStatus";
import { kr, krFraOere } from "@/lib/erhverv/visning";
import { handlingNavn } from "@/lib/moderationLog";
import { ADMIN_FIRMA as T } from "@/lib/tekster/adminFirma";
import { KLAGE_ADMIN, KLAGE_KATEGORI_NAVN } from "@/lib/tekster/erhvervKlager";

export function Felt({ titel, children, id }: { titel?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-24 border border-kant bg-white p-4 sm:p-5">
      {titel && <h3 className="mb-2 text-[15px] font-bold text-tekst">{titel}</h3>}
      {children}
    </section>
  );
}

export function Raekker({ raekker }: { raekker: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-kant">
      {raekker.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:justify-between sm:gap-4">
          <dt className="text-sm text-tekst-daempet">{k}</dt>
          <dd className="break-words text-sm font-semibold text-tekst tabular-nums sm:text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Maaler({ pct }: { pct: number }) {
  return (
    <div className="mt-2 h-2.5 bg-kant" aria-hidden="true">
      <div className="h-full bg-groen" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function Tom({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-tekst-svag">{children}</p>;
}

// --- Kvoter -----------------------------------------------------------------

export function FaneKvoter({ kvote, ugens }: { kvote: FirmaKvote | null; ugens: FirmaUgensButik | null }) {
  const K = T.kvoter;
  const r = ugens?.rabat ?? null;
  const aar = ugens ? Number(ugens.denneUge.slice(0, 4)) : new Date().getFullYear();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Felt titel={K.auktionerTitel}>
        {kvote ? (
          <>
            <Raekker raekker={[[K.brugt, T.status.brugtAf(kvote.brugt, kvote.max)]]} />
            <Maaler pct={kvote.max ? (kvote.brugt / kvote.max) * 100 : 0} />
            <p className="mt-2 text-xs text-tekst-daempet">
              {kvote.brugt >= kvote.max && kvote.max > 0 && <>{K.alleOptaget} </>}
              {kvote.naeste_uge && K.nulstilles(dato(kvote.naeste_uge))}
            </p>
          </>
        ) : (
          <Tom>{K.ikkeTilgaengelig}</Tom>
        )}
      </Felt>
      <Felt titel={K.ugensTitel}>
        {!r ? (
          <Tom>{K.ikkeTilgaengelig}</Tom>
        ) : r.procent === 0 || r.antal === 0 ? (
          <Tom>{K.ingenRabat}</Tom>
        ) : (
          <>
            <Raekker raekker={[[K.rabat(r.procent), K.tilbage(Math.max(0, r.antal - r.brugt), r.antal, aar)]]} />
            <Maaler pct={(Math.max(0, r.antal - r.brugt) / r.antal) * 100} />
          </>
        )}
      </Felt>
    </div>
  );
}

// --- Ugens butik --------------------------------------------------------------

const UGE_TONE: Record<string, BadgeTone> = {
  reserveret: "gul",
  behandles: "blaa",
  betalt: "groen",
  manuel: "groen",
  udloebet: "graa",
  annulleret: "graa",
  refunderes: "gul",
  refunderet: "graa",
};

// Annullér/refundér for en booking (chef og sælger-rollen - databasen
// afgør det endelige).
export function UgeHandlinger({ b }: { b: UgensBooking }) {
  const nr = ugeNr(b.uge_start);
  if (b.status === "reserveret" || b.status === "manuel") {
    return <AnnullerUgeKnap bookingId={b.id} ugeNr={nr} slags="annuller" beloebOere={b.beloeb_oere} />;
  }
  if (b.status === "betalt") {
    return (
      <div className="flex flex-wrap gap-2">
        <AnnullerUgeKnap bookingId={b.id} ugeNr={nr} slags="refunder" beloebOere={b.beloeb_oere} />
        <AnnullerUgeKnap bookingId={b.id} ugeNr={nr} slags="udenRefusion" beloebOere={b.beloeb_oere} />
      </div>
    );
  }
  if (b.status === "annulleret" && b.betalt_kl && !b.refunderet_kl) {
    return <AnnullerUgeKnap bookingId={b.id} ugeNr={nr} slags="refunderSenere" beloebOere={b.beloeb_oere} />;
  }
  return null;
}

export function FaneUgensButik({
  firmaId,
  ugens,
  ledigeUger,
  kanBooke,
  medBetalingMulig,
}: {
  firmaId: string;
  ugens: FirmaUgensButik | { fejl: "mangler" | "fejl" };
  ledigeUger: LedigUge[];
  kanBooke: boolean;
  medBetalingMulig: boolean;
}) {
  const U = T.uger;
  if ("fejl" in ugens) return <AdminFejl>{ugens.fejl === "mangler" ? U.mangler : U.fejl}</AdminFejl>;
  return (
    <div className="space-y-4">
      <Felt titel={U.titel}>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {ugens.uger.map((u) => {
            const dette = u.firma_id === firmaId;
            const andet = !!u.booking_id && !dette;
            const ledig = ledigeUger.find((l) => l.uge_start === u.uge_start);
            return (
              <li
                key={u.uge_start}
                className={`flex min-h-[92px] flex-col gap-1 border p-2 text-center text-xs ${
                  dette ? "border-groen bg-groen text-white" : andet ? "border-kant bg-admin-graa text-tekst-daempet" : "border-kant bg-white text-tekst"
                }`}
              >
                <span className="text-[13px] font-bold">
                  {`Uge ${u.uge_nr}`}
                  {u.uge_start === ugens.denneUge && <span className="block text-[11px] font-normal">({U.denneUge})</span>}
                </span>
                <span>{mandag(u.uge_start)}</span>
                <span className="font-semibold">
                  {dette ? `${U.dette} · ${U.status[u.status ?? ""] ?? ""}` : andet ? U.andet : U.ledig}
                </span>
                {ledig && kanBooke && (
                  <span className="mt-auto">
                    <BookUgeKnap
                      firmaId={firmaId}
                      uger={ledigeUger}
                      startUge={ledig.uge_start}
                      trigger="lille"
                      medBetalingMulig={medBetalingMulig}
                    />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-tekst-daempet">
          {U.pris(krFraOere(ugens.pris.inkl_moms_oere), krFraOere(ugens.pris.ekskl_moms_oere))}
        </p>
      </Felt>

      {ugens.rabatIndstilling && (
        <Felt titel={T.hurtig.rabat.titel}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm text-tekst">
              <p className="font-semibold">
                {ugens.rabatIndstilling.egen
                  ? T.hurtig.rabat.nuEgen(ugens.rabatIndstilling.egen.procent, ugens.rabatIndstilling.egen.antal)
                  : T.hurtig.rabat.nuPakke(ugens.rabatIndstilling.pakkeProcent, ugens.rabatIndstilling.pakkeAntal)}
              </p>
              {ugens.rabat && (
                <p className="text-tekst-daempet">
                  {T.kvoter.tilbage(Math.max(0, ugens.rabat.antal - ugens.rabat.brugt), ugens.rabat.antal, Number(ugens.denneUge.slice(0, 4)))}
                </p>
              )}
              {ugens.rabatIndstilling.egen && (
                <p className="break-words text-tekst-daempet">
                  {ugens.rabatIndstilling.egen.begrundelse}
                  {ugens.rabatIndstilling.egen.opdateret_kl &&
                    ` · ${ugens.rabatIndstilling.egen.opdateret_af_navn ?? "–"}, ${datoTid(ugens.rabatIndstilling.egen.opdateret_kl)}`}
                </p>
              )}
            </div>
            <div className="shrink-0">
              <UgensRabatKort firmaId={firmaId} rabat={ugens.rabatIndstilling} trigger="knap" />
            </div>
          </div>
        </Felt>
      )}

      <Felt titel={U.bookinger}>
        {ugens.bookinger.length === 0 ? (
          <Tom>{U.ingenBookinger}</Tom>
        ) : (
          <ul className="divide-y divide-kant">
            {ugens.bookinger.map((b) => (
              <li key={b.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                    {`Uge ${ugeNr(b.uge_start)}`} <span className="font-normal text-tekst-daempet">({mandag(b.uge_start)} {b.uge_start.slice(0, 4)})</span>
                    <AdminBadge tone={UGE_TONE[b.status] ?? "graa"}>{U.status[b.status] ?? b.status}</AdminBadge>
                  </p>
                  <p className="text-tekst-daempet">
                    {b.betaling === "ingen" ? T.hurtig.uge.udenBetaling : krFraOere(b.beloeb_oere)}
                    {b.rabat_procent > 0 && ` (${b.rabat_procent} % rabat)`}
                    {b.status === "reserveret" && b.reserveret_til && ` · betales senest ${datoTid(b.reserveret_til)}`}
                    {" · "}
                    {datoTid(b.oprettet_kl)}
                  </p>
                  {b.note && <p className="break-words text-tekst-daempet">{b.note}</p>}
                  {b.kraever_opmaerksomhed && b.opmaerksomhed_tekst && (
                    <p className="mt-1 break-words font-medium text-advarsel-tekst">{b.opmaerksomhed_tekst}</p>
                  )}
                </div>
                <div className="shrink-0">
                  <UgeHandlinger b={b} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Felt>
    </div>
  );
}

// --- Auktioner og salg ---------------------------------------------------------

export function FaneSalg({ data }: { data: { auktioner: FirmaAuktion[]; salg: FirmaHandel[] } | null }) {
  const S = T.salg;
  if (!data) return <AdminFejl>{S.fejl}</AdminFejl>;
  return (
    <div className="space-y-4">
      <Felt titel={S.aktiveTitel}>
        {data.auktioner.length === 0 ? (
          <Tom>{S.ingenAktive}</Tom>
        ) : (
          <ul className="divide-y divide-kant">
            {data.auktioner.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="break-words font-semibold text-tekst">{a.titel}</p>
                  <p className="text-tekst-daempet">
                    {a.antal_bud} bud · {a.hoejeste != null ? `${S.kolonne.hoejeste} ${kr(a.hoejeste)}` : `Startpris ${kr(a.startpris)}`} ·{" "}
                    {S.kolonne.slutter.toLowerCase()} {datoTid(a.slutter_kl)}
                  </p>
                </div>
                <Link href={`/auktion/${a.id}`} className="btn btn-sekundaer btn-lille shrink-0">
                  {S.aabn}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Felt>
      <Felt titel={S.salgTitel}>
        {data.salg.length === 0 ? (
          <Tom>{S.ingenSalg}</Tom>
        ) : (
          <ul className="divide-y divide-kant">
            {data.salg.map((h) => {
              const st = salgStatus({ status: h.status, afhentning: h.afhentning, retur: false });
              return (
                <li key={h.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="break-words font-semibold text-tekst">{h.titel ?? "–"}</p>
                    <p className="flex flex-wrap items-center gap-2 text-tekst-daempet">
                      {dato(h.created_at)} · {kr(h.amount)}
                      <span className={`inline-flex border px-2 py-0.5 text-xs font-semibold ${st.farve}`}>{st.tekst}</span>
                    </p>
                  </div>
                  <Link href={`/admin/handler/${h.id}`} className="btn btn-sekundaer btn-lille shrink-0">
                    {S.aabn}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {data.salg.length >= 20 && <p className="mt-2 text-xs text-tekst-svag">{S.visesMaks(data.salg.length)}</p>}
      </Felt>
    </div>
  );
}

// --- Regninger -----------------------------------------------------------------

const REGNING_TONE: Record<string, BadgeTone> = {
  afventer: "gul",
  betalt: "groen",
  mislykket: "roed",
  krediteret: "graa",
  annulleret: "graa",
};

export function FaneRegninger({
  regninger,
  ugens,
}: {
  regninger: FirmaRegning[] | null;
  ugens: FirmaUgensButik | null;
}) {
  const R = T.regninger;
  if (!regninger) return <AdminFejl>{R.fejl}</AdminFejl>;
  // Ugens butik med betaling, der er betalt (også senere annulleret/refunderet).
  const uger = (ugens?.bookinger ?? []).filter((b) => b.betaling === "stripe" && b.betalt_kl);
  type Linje = { id: string; kl: string; tekst: string; beloeb: number; status: ReactNode; handling?: ReactNode; link?: ReactNode };
  const linjer: Linje[] = [
    ...regninger.map((r) => ({
      id: r.id,
      kl: r.oprettet_kl,
      tekst:
        (r.type === "abonnement"
          ? R.abonnement(r.periode_fra ? dato(r.periode_fra) : null, r.periode_til ? dato(r.periode_til) : null)
          : r.type === "opgradering"
            ? R.opgradering
            : R.andet) + (r.nummer ? ` · nr. ${r.nummer}` : ""),
      beloeb: r.beloeb_oere,
      status: <AdminBadge tone={REGNING_TONE[r.status] ?? "graa"}>{R.status[r.status] ?? r.status}</AdminBadge>,
      link:
        r.pdf_url || r.hosted_url ? (
          <a href={r.pdf_url ?? r.hosted_url ?? undefined} target="_blank" rel="noopener noreferrer" className="btn btn-sekundaer btn-lille">
            {r.pdf_url ? R.pdf : R.se}
          </a>
        ) : undefined,
    })),
    ...uger.map((b) => ({
      id: b.id,
      kl: b.betalt_kl!,
      tekst: R.ugensButik(ugeNr(b.uge_start)) + (b.rabat_procent > 0 ? ` (${b.rabat_procent} % rabat)` : ""),
      beloeb: b.beloeb_oere,
      status: <AdminBadge tone={UGE_TONE[b.status] ?? "graa"}>{T.uger.status[b.status] ?? b.status}</AdminBadge>,
      handling: <UgeHandlinger b={b} />,
    })),
  ].sort((a, b) => b.kl.localeCompare(a.kl));

  return (
    <Felt titel={R.titel}>
      {linjer.length === 0 ? (
        <Tom>{R.ingen}</Tom>
      ) : (
        <ul className="divide-y divide-kant">
          {linjer.map((l) => (
            <li key={l.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 text-sm">
                <p className="break-words font-semibold text-tekst">{l.tekst}</p>
                <p className="flex flex-wrap items-center gap-2 text-tekst-daempet">
                  {dato(l.kl)} · {krFraOere(l.beloeb)} {l.status}
                </p>
              </div>
              {(l.handling || l.link) && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  {l.link}
                  {l.handling}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {regninger.length > 0 && <p className="mt-2 text-xs text-tekst-svag">{R.refusionAbonnement}</p>}
    </Felt>
  );
}

// --- Noter og log ---------------------------------------------------------------

export function LogListe({ log }: { log: FirmaLogRaekke[] | null }) {
  const L = T.log;
  if (!log) return <AdminFejl>{L.fejl}</AdminFejl>;
  if (log.length === 0) return <Tom>{L.ingenLog}</Tom>;
  return (
    <ul className="divide-y divide-kant">
      {log.map((l) => (
        <li key={l.id} className="grid gap-0.5 py-2.5 text-sm sm:grid-cols-[150px_150px_1fr] sm:gap-3">
          <span className="text-tekst-daempet">{datoTid(l.oprettet_kl)}</span>
          <span className="font-medium text-tekst">{l.system ? L.system : (l.medarbejder_navn ?? "–")}</span>
          <span className="min-w-0 break-words text-tekst">
            <span className="font-semibold">{handlingNavn(l.handling)}</span>
            {l.aarsag && <span className="text-tekst-daempet"> – {l.aarsag}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function KlageListe({ klager, firmaId }: { klager: AdminKlageRaekke[]; firmaId: string }) {
  const L = T.log;
  return (
    <>
      {klager.length === 0 ? (
        <Tom>{L.ingenKlager}</Tom>
      ) : (
        <ul className="divide-y divide-kant">
          {klager.slice(0, 10).map((k) => (
            <li key={k.id}>
              <Link
                href={`/admin/erhverv/klager/${k.id}`}
                className="flex flex-col gap-1 py-2.5 text-sm hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                  {KLAGE_ADMIN.klageNr(k.nummer)} <KlageStatusMaerke status={k.status} afgoerelse={k.afgoerelse} />
                </span>
                <span className="text-tekst-daempet">
                  {KLAGE_KATEGORI_NAVN[k.kategori]} · {k.titel ?? "–"} · {datoTid(k.oprettet_kl)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href={`/admin/erhverv/klager?status=aaben&firma=${firmaId}`}
        className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-groen hover:underline sm:min-h-9"
      >
        {L.alleKlager} →
      </Link>
    </>
  );
}
