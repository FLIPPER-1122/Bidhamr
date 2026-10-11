import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervKlager } from "@/app/actions/adminErhvervKlager";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner, { datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import AdvarselForslagHandlinger from "@/components/admin/erhverv/AdvarselForslagHandlinger";
import { KlageStatusMaerke } from "@/components/erhverv/klager/visning";
import { ADMIN_ERHVERV } from "@/lib/tekster/erhverv";
import { KLAGE_ADMIN as A, KLAGE_KATEGORI_NAVN } from "@/lib/tekster/erhvervKlager";
import {
  KLAGE_FORSLAG_ANTAL,
  KLAGE_FORSLAG_MAANEDER,
  KLAGE_STATUSSER,
  erKlageStatus,
  type KlageStatus,
} from "@/lib/erhverv/klager";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Admin → Erhverv → Klager: købernes klager over firmaer (åbne, under
// behandling, afsluttede) og forslag om advarsel. Kun chef og saelger
// (kraevErhvervSide + erhverv_har_adgang i databasen).
export default async function ErhvervKlagerSide({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; firma?: string }>;
}) {
  await kraevErhvervSide();
  const { status: raa, firma: raaFirma } = await searchParams;
  const status: KlageStatus = erKlageStatus(raa) ? raa : "aaben";
  const firma = raaFirma && UUID.test(raaFirma) ? raaFirma : null;

  const res = await hentErhvervKlager({ status, firma });
  const fejl = "fejl" in res ? res.fejl : null;
  const liste = "fejl" in res ? [] : res.klager;
  const antal = "fejl" in res ? null : res.antal;
  const forslag = "fejl" in res ? [] : res.forslag;
  const firmaQ = firma ? `&firma=${firma}` : "";

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <AdminSideHoved titel={ADMIN_ERHVERV.menupunkt} forklaring={A.forklaring} />
      <ErhvervFaner aktiv="klager" />

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      {forslag.length > 0 && (
        <section aria-labelledby="forslag-titel" className="space-y-3 rounded-xl border border-orange-300 bg-orange-lys/40 p-5">
          <div>
            <h2 id="forslag-titel" className="font-sans text-lg font-semibold text-neutral-900">
              {A.forslagTitel} ({forslag.length})
            </h2>
            <p className="text-sm text-neutral-600">{A.forslagForklaring(KLAGE_FORSLAG_ANTAL, KLAGE_FORSLAG_MAANEDER)}</p>
          </div>
          <ul className="space-y-3">
            {forslag.map((f) => (
              <li key={f.id} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-neutral-900">
                    {f.firmanavn} <span className="font-normal text-neutral-500">· CVR {f.cvr}</span>
                  </p>
                  <Link
                    href={`/admin/erhverv/klager?status=afsluttet&firma=${f.firma_id}`}
                    className="text-sm font-medium text-groen hover:underline"
                  >
                    {A.seFirma}
                  </Link>
                </div>
                <p className="mt-1 text-sm text-neutral-600">
                  {A.forslagGrundlag[f.grundlag](f.antal_klager)} · {A.advarslerAntal(f.advarsler_antal)} ·{" "}
                  {datoTid(f.oprettet_kl)}
                </p>
                <div className="mt-3">
                  <AdvarselForslagHandlinger forslagId={f.id} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div>
        <h2 className="font-sans text-lg font-semibold text-neutral-900">{A.titel}</h2>
      </div>

      <nav aria-label="Filter" className="flex flex-wrap gap-2">
        {KLAGE_STATUSSER.map((s) => (
          <Link
            key={s}
            href={`/admin/erhverv/klager?status=${s}${firmaQ}`}
            aria-current={status === s ? "page" : undefined}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium ${
              status === s
                ? "border-groen bg-groen text-white"
                : "border-neutral-300 bg-white text-neutral-700 hover:border-groen"
            }`}
          >
            {A.filter[s]}
            {antal && s !== "afsluttet" && antal[s] > 0 && (
              <span className="rounded-full bg-[#A32020] px-2 py-0.5 text-xs font-bold text-white">{antal[s]}</span>
            )}
          </Link>
        ))}
        {firma && (
          <Link
            href={`/admin/erhverv/klager?status=${status}`}
            className="inline-flex min-h-11 items-center rounded-full border border-neutral-300 bg-white px-4 text-sm text-neutral-700 hover:border-groen"
          >
            × {A.tilbage}
          </Link>
        )}
      </nav>

      {!fejl && liste.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-neutral-500">{A.tom}</p>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {liste.map((k) => (
            <li key={k.id}>
              <Link
                href={`/admin/erhverv/klager/${k.id}`}
                className="flex flex-col gap-1 px-5 py-4 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-neutral-900">
                    <span>{A.klageNr(k.nummer)}</span>
                    <span className="break-words">{k.firmanavn}</span>
                    <KlageStatusMaerke status={k.status} afgoerelse={k.afgoerelse} />
                  </p>
                  <p className="text-sm text-neutral-600">
                    {KLAGE_KATEGORI_NAVN[k.kategori]} · {k.titel ?? "–"} · {A.kolonne.koeber}: {k.koeber_navn ?? "–"}
                    {k.behandles_af_navn && <> · {k.behandles_af_navn}</>}
                    {k.antal_noter > 0 && <> · {k.antal_noter} noter</>}
                  </p>
                </div>
                <p className="shrink-0 text-sm text-neutral-500">{datoTid(k.oprettet_kl)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
