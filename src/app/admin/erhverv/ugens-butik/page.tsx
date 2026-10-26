import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { manglerUgensButik } from "@/lib/betaling/ugensButik";
import AdminSide from "@/components/admin/AdminSide";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import AdminBadge, { type BadgeTone } from "@/components/admin/AdminBadge";
import AdminFejl from "@/components/admin/AdminFejl";
import ErhvervFaner, { datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import UgensButikPris from "@/components/admin/erhverv/UgensButikPris";
import LoftMaerker from "@/components/admin/erhverv/LoftMaerker";
import { Felt, UgeHandlinger } from "@/components/admin/erhverv/firma/FirmaFaner";
import { mandag } from "@/components/admin/erhverv/firma/stil";
import type { UgensBooking } from "@/lib/admin/firmaSide";
import { krFraOere } from "@/lib/erhverv/visning";
import { nrITraek } from "@/lib/erhverv/ugensButikStribe";
import { ADMIN_FIRMA } from "@/lib/tekster/adminFirma";
import { UGENS_ADMIN as T } from "@/lib/tekster/ugensButik";

export const metadata = { title: "Ugens butik" };

// Admin -> Erhverv -> Ugens butik (chef og sælger-rollen). Alle uger fra den
// igangværende og frem, alle bookinger (ugens_butik_admin, service role
// efter kraevErhvervSide) og prisen - kun chefen kan ændre den. Booking,
// annullering, refusion og firmaets rabat ligger på firmasiden
// (Firmaer -> [firma] -> Ugens butik), annullering/refusion også her.

type AdminUge = {
  uge_start: string;
  uge_nr: number;
  aar: number;
  igangvaerende: boolean;
  booking_id: string | null;
  status: string | null;
  firma_id: string | null;
  firmanavn: string | null;
  // Loft-status for en booket uge (20261102020000): uger i træk inkl. denne,
  // om firmaets uger omkring denne bryder loftet, og om staff omgik loftet.
  i_traek?: number | null;
  loft_brudt?: boolean | null;
  loft_omgaaet?: boolean | null;
};

type AdminBooking = {
  id: string;
  uge_start: string;
  uge_nr: number;
  firma_id: string;
  firmanavn: string | null;
  kilde: "firma" | "staff";
  betaling: "stripe" | "ingen";
  status: string;
  reserveret_til: string | null;
  beloeb_oere: number;
  rabat_procent: number;
  betalt_kl: string | null;
  refunderet_kl: string | null;
  annulleret_kl: string | null;
  note: string | null;
  oprettet_af_navn: string | null;
  oprettet_kl: string;
  loft_omgaaet: boolean;
  kraever_opmaerksomhed: boolean;
  opmaerksomhed_tekst: string | null;
};

type AdminData = {
  rolle: string;
  pris: { ekskl_moms_oere: number; inkl_moms_oere: number; opdateret_kl: string | null };
  denne_uge: string;
  loft?: { maks_uger_i_traek: number; pause_uger: number };
  uger: AdminUge[];
  bookinger: AdminBooking[];
};

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

const FILTRE = ["aabne", "opmaerksomhed", "alle"] as const;
type Filter = (typeof FILTRE)[number];
const SIDE = 50;

export default async function UgensButikAdmin({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string; antal?: string }>;
}) {
  const { admin, userId, rolle } = await kraevErhvervSide();
  const sp = await searchParams;
  const filter: Filter = (FILTRE as readonly string[]).includes(sp.vis ?? "") ? (sp.vis as Filter) : "aabne";
  const antal = Math.min(300, Math.max(SIDE, Number.parseInt(sp.antal ?? "", 10) || SIDE));

  const { data, error } = await admin.rpc("ugens_butik_admin", { p_staff: userId });
  const d = (error ? null : data) as AdminData | null;
  if (error) console.error("ugens_butik_admin:", error.message);

  const U = ADMIN_FIRMA.uger;
  const nr = nrITraek(d?.uger ?? []);
  const alle = d?.bookinger ?? [];
  const filtreret = alle.filter((b) =>
    filter === "alle"
      ? true
      : filter === "opmaerksomhed"
        ? b.kraever_opmaerksomhed
        : ["reserveret", "behandles", "betalt", "manuel", "refunderes"].includes(b.status),
  );
  const vist = filtreret.slice(0, antal);
  const href = (vis: Filter, n?: number) => `/admin/erhverv/ugens-butik?vis=${vis}${n ? `&antal=${n}` : ""}`;

  return (
    <AdminSide>
      <AdminSideHoved titel={T.titel} forklaring={T.forklaring} />
      <ErhvervFaner aktiv="ugens-butik" />

      {!d ? (
        <AdminFejl>{error && manglerUgensButik(error) ? T.mangler : T.fejl}</AdminFejl>
      ) : (
        <>
          <Felt titel={T.prisTitel}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <p className="text-base font-bold text-tekst tabular-nums">
                  {T.pris(krFraOere(d.pris.ekskl_moms_oere), krFraOere(d.pris.inkl_moms_oere))}
                </p>
                {d.pris.opdateret_kl && <p className="text-tekst-daempet">{T.prisOpdateret(datoTid(d.pris.opdateret_kl))}</p>}
                <p className="text-tekst-daempet">{T.prisForklaring}</p>
              </div>
              <div className="shrink-0">
                {rolle === "chef" ? (
                  <UgensButikPris eksklKr={Math.round(d.pris.ekskl_moms_oere / 100)} />
                ) : (
                  <p className="text-xs text-tekst-daempet">{T.prisKunChef}</p>
                )}
              </div>
            </div>
          </Felt>

          <Felt titel={T.ugerTitel}>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {d.uger.map((u, i) => (
                <li
                  key={u.uge_start}
                  className={`flex min-h-[84px] flex-col gap-0.5 border p-2 text-center text-xs ${
                    u.booking_id ? "border-groen bg-groen text-white" : "border-kant bg-white text-tekst"
                  }`}
                >
                  <span className="text-[13px] font-bold">
                    {`Uge ${u.uge_nr}`}
                    {u.igangvaerende && <span className="block text-[11px] font-normal">({T.denneUge})</span>}
                  </span>
                  <span>{mandag(u.uge_start)}</span>
                  {u.booking_id && u.firma_id ? (
                    <span className="mt-auto flex flex-col gap-0.5">
                      <Link
                        href={`/admin/erhverv/firmaer/${u.firma_id}?fane=ugens-butik`}
                        className="font-semibold break-words underline underline-offset-2"
                      >
                        {u.firmanavn ?? "–"}
                        <span className="block font-normal">{U.status[u.status ?? ""] ?? u.status}</span>
                      </Link>
                      {/* Kun i en stribe på mindst 2 uger ("1. uge i træk" siger intet). */}
                      {Number(u.i_traek) > 1 && nr[i] != null && <span>{T.iTraek(nr[i]!)}</span>}
                      <LoftMaerker brudt={!!u.loft_brudt} omgaaet={!!u.loft_omgaaet} maks={d.loft?.maks_uger_i_traek ?? 4} />
                    </span>
                  ) : (
                    <span className="mt-auto font-semibold">{T.ledig}</span>
                  )}
                </li>
              ))}
            </ul>
          </Felt>

          <Felt titel={`${T.bookingerTitel} (${filtreret.length})`}>
            <nav aria-label={T.bookingerTitel} className="mb-3 flex flex-wrap gap-2">
              {FILTRE.map((f) => (
                <Link
                  key={f}
                  href={href(f)}
                  aria-current={filter === f ? "page" : undefined}
                  className={`btn btn-lille ${filter === f ? "btn-primaer" : "btn-sekundaer"}`}
                >
                  {T.filter[f]}
                </Link>
              ))}
            </nav>
            {vist.length === 0 ? (
              <p className="py-2 text-sm text-tekst-svag">{T.bookingerTom}</p>
            ) : (
              <ul className="divide-y divide-kant">
                {vist.map((b) => {
                  const handling: UgensBooking = {
                    id: b.id,
                    uge_start: b.uge_start,
                    status: b.status,
                    kilde: b.kilde,
                    betaling: b.betaling,
                    beloeb_oere: Number(b.beloeb_oere),
                    rabat_procent: Number(b.rabat_procent ?? 0),
                    reserveret_til: b.reserveret_til,
                    betalt_kl: b.betalt_kl,
                    refunderet_kl: b.refunderet_kl,
                    annulleret_kl: b.annulleret_kl,
                    note: b.note,
                    kraever_opmaerksomhed: b.kraever_opmaerksomhed,
                    opmaerksomhed_tekst: b.opmaerksomhed_tekst,
                    oprettet_kl: b.oprettet_kl,
                  };
                  return (
                    <li key={b.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 text-sm">
                        <p className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                          {`Uge ${b.uge_nr}`}{" "}
                          <span className="font-normal text-tekst-daempet">
                            ({mandag(b.uge_start)} {b.uge_start.slice(0, 4)})
                          </span>
                          <Link
                            href={`/admin/erhverv/firmaer/${b.firma_id}?fane=ugens-butik`}
                            className="break-words text-groen underline underline-offset-2"
                          >
                            {b.firmanavn ?? "–"}
                          </Link>
                          <AdminBadge tone={UGE_TONE[b.status] ?? "graa"}>{U.status[b.status] ?? b.status}</AdminBadge>
                          {b.loft_omgaaet && <AdminBadge tone="orange">{T.loftOmgaaet}</AdminBadge>}
                        </p>
                        <p className="text-tekst-daempet">
                          {b.betaling === "ingen" ? T.udenBetaling : krFraOere(Number(b.beloeb_oere))}
                          {Number(b.rabat_procent) > 0 && ` (${T.rabat(Number(b.rabat_procent))})`}
                          {" · "}
                          {b.kilde === "staff" ? T.afStaff(b.oprettet_af_navn) : T.afFirma}
                          {" · "}
                          {datoTid(b.oprettet_kl)}
                          {b.status === "reserveret" && b.reserveret_til && ` · betales senest ${datoTid(b.reserveret_til)}`}
                        </p>
                        {b.note && <p className="break-words text-tekst-daempet">{b.note}</p>}
                        {b.kraever_opmaerksomhed && b.opmaerksomhed_tekst && (
                          <p className="mt-1 break-words font-medium text-advarsel-tekst">{b.opmaerksomhed_tekst}</p>
                        )}
                      </div>
                      <div className="shrink-0">
                        <UgeHandlinger b={handling} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {filtreret.length > vist.length && (
              <Link href={href(filter, antal + SIDE)} className="btn btn-sekundaer btn-lille mt-3">
                {T.visFlere}
              </Link>
            )}
            {alle.length >= 300 && <p className="mt-2 text-xs text-tekst-svag">{T.visesMaks(300)}</p>}
          </Felt>
        </>
      )}
    </AdminSide>
  );
}
