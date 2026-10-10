import Link from "next/link";
import { notFound } from "next/navigation";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervKlage } from "@/app/actions/adminErhvervKlager";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import KlageHandlinger from "@/components/admin/erhverv/KlageHandlinger";
import AdvarselForslagHandlinger from "@/components/admin/erhverv/AdvarselForslagHandlinger";
import { KlageStatusMaerke } from "@/components/erhverv/klager/visning";
import { KLAGE_ADMIN as A, KLAGE_KANAL_NAVN, KLAGE_KATEGORI_NAVN } from "@/lib/tekster/erhvervKlager";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const kr = (v: number | string) =>
  `${Number(v).toLocaleString("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kr.`;

function Felt({ navn, children }: { navn: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-neutral-500">{navn}</dt>
      <dd className="break-words text-[15px] text-neutral-900">{children}</dd>
    </div>
  );
}

// Admin → Erhverv → Klager → én klage. Kun chef og saelger. Købers e-mail
// vises kun for chef (som firma_faktura_salg).
export default async function ErhvervKlageSide({ params }: { params: Promise<{ id: string }> }) {
  await kraevErhvervSide();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const res = await hentErhvervKlage(id);
  if ("fejl" in res) {
    return (
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {res.fejl}
        </p>
      </div>
    );
  }
  const d = res.detalje;
  const k = d.klage;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Link href="/admin/erhverv/klager" className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline">
        ← {A.tilbage}
      </Link>
      <AdminSideHoved
        titel={`${A.klageNr(k.nummer)} · ${d.firma.firmanavn}`}
        forklaring={`${KLAGE_KATEGORI_NAVN[k.kategori]} · ${datoTid(k.oprettet_kl)}`}
        hoejre={<KlageStatusMaerke status={k.status} afgoerelse={k.afgoerelse} />}
      />

      {d.inhabil && (
        <p role="note" className="rounded-xl border border-orange-300 bg-orange-lys p-4 text-sm text-[#8A4210]">
          {A.inhabil}
        </p>
      )}
      {d.statistik.lukning_foreslaaet && (
        <p className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {A.lukningForeslaaet}{" "}
          <Link
            href={`/admin/erhverv/firmaer/${d.firma.id}#firmakonto`}
            className="inline-flex min-h-11 items-center font-semibold underline"
          >
            {A.lukningLink}
          </Link>
        </p>
      )}

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-sans text-base font-semibold text-neutral-900">{A.beskrivelse}</h2>
        {/* Inhabil: databasen sender hverken beskrivelse eller billeder. */}
        {d.inhabil ? (
          <p className="mt-2 text-[15px] font-semibold text-[#8A4210]">{A.inhabilSkjult}</p>
        ) : (
          <>
        <p className="mt-2 whitespace-pre-line break-words text-[15px] text-neutral-900">{k.beskrivelse}</p>
        <h3 className="mt-4 text-sm font-semibold text-neutral-900">{A.billeder}</h3>
        {d.billeder.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">{A.ingenBilleder}</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {d.billeder.map((b) => (
              <li key={b.sti}>
                {b.url ? (
                  <a href={b.url} target="_blank" rel="noopener noreferrer" className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element -- signeret, kortlivet link */}
                    <img src={b.url} alt="" className="h-28 w-28 rounded-lg border border-neutral-200 object-cover" />
                  </a>
                ) : (
                  <span className="block h-28 w-28 rounded-lg border border-neutral-200 bg-neutral-100" />
                )}
              </li>
            ))}
          </ul>
        )}
          </>
        )}
        {k.status === "afsluttet" && k.begrundelse && (
          <div className="mt-4 rounded-lg bg-neutral-50 p-3 text-sm">
            <p className="font-semibold text-neutral-900">
              {A.afgjortAf}: {k.afgjort_af_navn ?? "–"} · {datoTid(k.afgjort_kl)}
            </p>
            <p className="mt-1 whitespace-pre-line break-words text-neutral-800">{k.begrundelse}</p>
          </div>
        )}
      </section>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="font-sans text-base font-semibold text-neutral-900">{A.firma}</h2>
          <dl className="mt-3 grid gap-3">
            <Felt navn="Firma">
              {d.firma.firmanavn} (CVR {d.firma.cvr})
            </Felt>
            <Felt navn="Kontaktperson">{d.firma.kontaktperson}</Felt>
            <Felt navn="Telefon">
              <a href={`tel:${d.firma.telefon.replace(/\s/g, "")}`} className="text-groen underline">
                {d.firma.telefon}
              </a>
            </Felt>
            <Felt navn="E-mail">
              <a href={`mailto:${d.firma.kontakt_email}`} className="text-groen underline">
                {d.firma.kontakt_email}
              </a>
            </Felt>
            <Felt navn="Adresse">
              {d.firma.adresse}, {d.firma.postnummer} {d.firma.bynavn}
            </Felt>
          </dl>
          <Link href={`/admin/erhverv/firmaer/${d.firma.id}`} className="mt-3 inline-flex text-sm font-medium text-groen hover:underline">
            {A.seFirma}
          </Link>
        </section>

        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="font-sans text-base font-semibold text-neutral-900">{A.handel}</h2>
          {d.handel ? (
            <dl className="mt-3 grid gap-3">
              <Felt navn="Vare">{d.handel.titel ?? "–"}</Felt>
              <Felt navn="Pris">{kr(d.handel.beloeb)}</Felt>
              <Felt navn="Status">{d.handel.status}</Felt>
              <Felt navn="Købt">{datoTid(d.handel.oprettet_kl)}</Felt>
              <Felt navn="Betalt">{datoTid(d.handel.betalt_kl)}</Felt>
              <Felt navn={d.handel.afhentning ? "Afhentning" : "Sendt"}>
                {d.handel.afhentning ? "Ja" : datoTid(d.handel.sendt_kl)}
              </Felt>
              {d.handel.refunderet_kl && <Felt navn="Refunderet">{datoTid(d.handel.refunderet_kl)}</Felt>}
            </dl>
          ) : (
            <p className="mt-2 text-sm text-neutral-500">–</p>
          )}
          <h3 className="mt-4 text-sm font-semibold text-neutral-900">{A.koeber}</h3>
          <p className="text-[15px] text-neutral-900">
            {d.koeber?.navn ?? "–"}
            {d.koeber?.email && (
              <>
                {" · "}
                <a href={`mailto:${d.koeber.email}`} className="text-groen underline">
                  {d.koeber.email}
                </a>
              </>
            )}
          </p>
          {!d.er_chef && <p className="text-xs text-neutral-500">{A.koeberEmailKunChef}</p>}
        </section>
      </div>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-sans text-base font-semibold text-neutral-900">{A.statistik}</h2>
        <dl className="mt-3 grid grid-cols-3 gap-3">
          <Felt navn={A.klagerIAlt}>{d.statistik.klager_i_alt}</Felt>
          <Felt navn={A.berettigede12}>{d.statistik.berettigede_12_mdr}</Felt>
          <Felt navn={A.advarsler}>{d.statistik.advarsler_antal}</Felt>
        </dl>
        {d.statistik.afventende_forslag && !d.inhabil && (
          <div className="mt-4 rounded-xl border border-orange-300 bg-orange-lys/40 p-4">
            <p className="text-sm font-semibold text-neutral-900">
              {A.forslagTitel}: {A.forslagGrundlag[d.statistik.afventende_forslag.grundlag](d.statistik.afventende_forslag.antal_klager)}
            </p>
            <div className="mt-3">
              <AdvarselForslagHandlinger forslagId={d.statistik.afventende_forslag.id} />
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-sans text-base font-semibold text-neutral-900">{A.noter}</h2>
        {d.noter.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">{A.ingenNoter}</p>
        ) : (
          <ol className="mt-3 space-y-3">
            {d.noter.map((n) => (
              <li key={n.id} className="rounded-lg border border-neutral-100 bg-neutral-50 p-3">
                <p className="text-xs font-medium text-neutral-500">
                  {A.noteType[n.type]}
                  {n.kanal && <> ({KLAGE_KANAL_NAVN[n.kanal]})</>} · {n.staff_navn ?? "–"} · {datoTid(n.oprettet_kl)}
                </p>
                <p className="mt-1 whitespace-pre-line break-words text-[15px] text-neutral-900">{n.tekst}</p>
              </li>
            ))}
          </ol>
        )}
        {!d.inhabil && (
          <div className="mt-5">
            <KlageHandlinger id={k.id} status={k.status} />
          </div>
        )}
      </section>
    </div>
  );
}
