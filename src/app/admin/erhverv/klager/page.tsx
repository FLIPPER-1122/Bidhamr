import Link from "next/link";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervKlager } from "@/app/actions/adminErhvervKlager";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import ErhvervFaner, { datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import AdvarselForslagHandlinger from "@/components/admin/erhverv/AdvarselForslagHandlinger";
import { KlageStatusMaerke } from "@/components/erhverv/klager/visning";
import { KLAGE_ADMIN as A, KLAGE_KATEGORI_NAVN } from "@/lib/tekster/erhvervKlager";
import {
  KLAGE_FORSLAG_ANTAL,
  KLAGE_FORSLAG_MAANEDER,
  KLAGE_STATUSSER,
  erKlageStatus,
  type KlageStatus,
} from "@/lib/erhverv/klager";
import AdminSide from "@/components/admin/AdminSide";
import TagKlageKnap from "@/components/admin/erhverv/TagKlageKnap";

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
    <AdminSide>
      <AdminSideHoved titel="Købers klager over firmaer" forklaring={A.forklaring} />
      <ErhvervFaner aktiv="klager" />

      {fejl && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      {forslag.length > 0 && (
        <section aria-labelledby="forslag-titel" className="space-y-3 rounded-xl border border-orange-300 bg-orange-lys/40 p-5">
          <div>
            <h2 id="forslag-titel" className="font-sans text-lg font-semibold text-tekst">
              {A.forslagTitel} ({forslag.length})
            </h2>
            <p className="text-sm text-tekst-daempet">{A.forslagForklaring(KLAGE_FORSLAG_ANTAL, KLAGE_FORSLAG_MAANEDER)}</p>
          </div>
          <ul className="space-y-3">
            {forslag.map((f) => (
              <li key={f.id} className="rounded-[14px] border border-admin-kant bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-tekst">
                    {f.firmanavn} <span className="font-normal text-tekst-svag">· CVR {f.cvr}</span>
                  </p>
                  <Link
                    href={`/admin/erhverv/klager?status=afsluttet&firma=${f.firma_id}`}
                    className="text-sm font-medium text-groen hover:underline"
                  >
                    {A.seFirma}
                  </Link>
                </div>
                <p className="mt-1 text-sm text-tekst-daempet">
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
        <h2 className="font-sans text-lg font-semibold text-tekst">{A.titel}</h2>
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
                : "border-neutral-300 bg-white text-tekst hover:border-groen"
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
            className="inline-flex min-h-11 items-center rounded-full border border-neutral-300 bg-white px-4 text-sm text-tekst hover:border-groen"
          >
            × {A.tilbage}
          </Link>
        )}
      </nav>

      {!fejl && liste.length === 0 ? (
        <p className="rounded-[14px] border border-admin-kant bg-white p-8 text-center text-tekst-svag">{A.tom}</p>
      ) : (
        <ul className="divide-y divide-admin-kant overflow-hidden rounded-[14px] border border-admin-kant bg-white">
          {liste.map((k) => (
            <li key={k.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:pr-4">
              <Link
                href={`/admin/erhverv/klager/${k.id}`}
                className="flex min-w-0 flex-1 flex-col gap-1 px-5 py-4 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-tekst">
                    <span>{A.klageNr(k.nummer)}</span>
                    <span className="break-words">{k.firmanavn}</span>
                    <KlageStatusMaerke status={k.status} afgoerelse={k.afgoerelse} />
                  </p>
                  <p className="text-sm text-tekst-daempet">
                    {KLAGE_KATEGORI_NAVN[k.kategori]} · {k.titel ?? "–"} · {A.kolonne.koeber}: {k.koeber_navn ?? "–"}
                    {k.behandles_af_navn && <> · {k.behandles_af_navn}</>}
                    {k.antal_noter > 0 && <> · {k.antal_noter} noter</>}
                  </p>
                </div>
                <p className="shrink-0 text-sm text-tekst-svag">{datoTid(k.oprettet_kl)}</p>
              </Link>
              {k.status === "aaben" && (
                <div className="px-5 pb-4 sm:p-0">
                  <TagKlageKnap id={k.id} nummer={k.nummer} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </AdminSide>
  );
}
