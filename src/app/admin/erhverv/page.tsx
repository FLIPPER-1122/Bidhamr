import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervHenvendelser } from "@/app/actions/adminErhverv";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner, { HenvendelseStatusBadge, datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import { ADMIN_ERHVERV, ADMIN_ERHVERV_EKSTRA } from "@/lib/tekster/erhverv";
import { HENVENDELSE_STATUSSER, HENVENDELSE_STATUS_NAVN, erHenvendelseStatus } from "@/lib/erhverv/regler";

// Admin → Erhverv → Henvendelser (formularen fra /erhverv). Kun chef og
// saelger (kraevErhvervSide + erhverv_har_adgang i databasen).
export default async function ErhvervHenvendelserSide({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; arkiv?: string }>;
}) {
  await kraevErhvervSide();
  const { status: raaStatus, arkiv } = await searchParams;
  const status = erHenvendelseStatus(raaStatus) ? raaStatus : null;
  const arkiverede = arkiv === "1";

  const [res, alleAktive] = await Promise.all([
    hentErhvervHenvendelser({ status, arkiverede }),
    // Antal nye (til filteret) - samme liste uden filter.
    status || arkiverede ? hentErhvervHenvendelser({}) : null,
  ]);
  const fejl = "fejl" in res ? res.fejl : null;
  const liste = "fejl" in res ? [] : res.henvendelser;
  const ufiltreret = alleAktive && !("fejl" in alleAktive) ? alleAktive.henvendelser : liste;
  const antalNye = ufiltreret.filter((h) => h.status === "ny").length;

  const filtre: { id: string; label: string; href: string; antal?: number }[] = [
    { id: "alle", label: ADMIN_ERHVERV.henvendelser.filterAlle, href: "/admin/erhverv" },
    ...HENVENDELSE_STATUSSER.map((s) => ({
      id: s,
      label: HENVENDELSE_STATUS_NAVN[s],
      href: `/admin/erhverv?status=${s}`,
      antal: s === "ny" ? antalNye : undefined,
    })),
    { id: "arkiv", label: ADMIN_ERHVERV_EKSTRA.arkiverede, href: "/admin/erhverv?arkiv=1" },
  ];
  const aktivFilter = arkiverede ? "arkiv" : (status ?? "alle");

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <AdminSideHoved titel={ADMIN_ERHVERV.menupunkt} forklaring={ADMIN_ERHVERV_EKSTRA.forklaring} />
      <ErhvervFaner aktiv="henvendelser" />

      <div>
        <h2 className="font-sans text-lg font-semibold text-neutral-900">{ADMIN_ERHVERV.henvendelser.titel}</h2>
        <p className="text-sm text-neutral-600">{ADMIN_ERHVERV.henvendelser.forklaring}</p>
      </div>

      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {filtre.map((f) => (
          <Link
            key={f.id}
            href={f.href}
            aria-current={aktivFilter === f.id ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium ${
              aktivFilter === f.id
                ? "border-groen bg-groen text-white"
                : "border-neutral-300 bg-white text-neutral-700 hover:border-groen"
            }`}
          >
            {f.label}
            {!!f.antal && (
              <span className="rounded-full bg-[#A32020] px-2 py-0.5 text-xs font-bold text-white" aria-label={`${f.antal} nye`}>
                {f.antal}
              </span>
            )}
          </Link>
        ))}
      </nav>

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      {!fejl && liste.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-neutral-500">
          {status || arkiverede ? ADMIN_ERHVERV.henvendelser.tomFilter : ADMIN_ERHVERV.henvendelser.tom}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {liste.map((h) => (
            <li key={h.id}>
              <Link
                href={`/admin/erhverv/henvendelser/${h.id}`}
                className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-neutral-900">
                    <span className="break-words">{h.firmanavn}</span>
                    <HenvendelseStatusBadge status={h.status} />
                    {h.firma_id && (
                      <span className="rounded-full bg-succes-bg px-2.5 py-0.5 text-xs font-semibold text-succes-tekst">
                        {ADMIN_ERHVERV_EKSTRA.kontoOprettet}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-neutral-600">
                    {ADMIN_ERHVERV.henvendelser.kolonneCvr} {h.cvr} · {h.kontaktperson} · {h.telefon}
                  </p>
                </div>
                <p className="shrink-0 text-sm text-neutral-500">{datoTid(h.oprettet_kl)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
