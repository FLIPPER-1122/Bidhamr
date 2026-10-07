import Link from "next/link";
import { notFound } from "next/navigation";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervHenvendelser, hentErhvervPakker } from "@/app/actions/adminErhverv";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { HenvendelseStatusBadge, datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import HenvendelseHandlinger from "@/components/admin/erhverv/HenvendelseHandlinger";
import OpretFirmakonto from "@/components/admin/erhverv/OpretFirmakonto";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HenvendelseSide({ params }: { params: Promise<{ id: string }> }) {
  await kraevErhvervSide();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  // Ingen enkelt-opslag-RPC: henvendelsen findes i listen (aktive eller arkiv).
  const [aktive, arkiv, pakkerSvar] = await Promise.all([
    hentErhvervHenvendelser({}),
    hentErhvervHenvendelser({ arkiverede: true }),
    hentErhvervPakker(),
  ]);
  if ("fejl" in aktive) throw new Error(aktive.fejl);
  const h =
    aktive.henvendelser.find((x) => x.id === id) ??
    ("fejl" in arkiv ? undefined : arkiv.henvendelser.find((x) => x.id === id));
  if (!h) notFound();
  const pakker = "fejl" in pakkerSvar ? [] : pakkerSvar.pakker.filter((p) => p.aktiv);

  const raekker: [string, string | null][] = [
    [X.felter.firmanavn, h.firmanavn],
    [X.felter.cvr, h.cvr],
    [X.felter.kontaktperson, h.kontaktperson],
    [X.felter.telefon, h.telefon],
    [X.felter.email, h.email],
    [X.felter.adresse, h.adresse],
    [X.felter.postnummer, h.postnummer],
    [X.felter.by, h.bynavn],
    [X.felter.antalVarer, h.antal_varer_ca != null ? h.antal_varer_ca.toLocaleString("da-DK") : null],
    [X.felter.modtaget, datoTid(h.oprettet_kl)],
    [X.felter.behandletAf, h.behandlet_af_navn ? `${h.behandlet_af_navn} (${datoTid(h.behandlet_kl)})` : null],
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Link href="/admin/erhverv" className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline">
        ← {X.tilbageTilListe}
      </Link>
      <AdminSideHoved
        titel={h.firmanavn}
        forklaring={`${A.henvendelser.kolonneCvr} ${h.cvr} · ${datoTid(h.oprettet_kl)}`}
        hoejre={<HenvendelseStatusBadge status={h.status} />}
      />

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {raekker.map(([k, vaerdi]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs font-medium text-neutral-500">{k}</dt>
              <dd className="break-words text-[15px] text-neutral-900">
                {k === X.felter.email && vaerdi ? (
                  <a href={`mailto:${vaerdi}`} className="text-groen underline">{vaerdi}</a>
                ) : k === X.felter.telefon && vaerdi ? (
                  <a href={`tel:${vaerdi.replace(/\s/g, "")}`} className="text-groen underline">{vaerdi}</a>
                ) : (
                  (vaerdi ?? "–")
                )}
              </dd>
            </div>
          ))}
          <div className="min-w-0 sm:col-span-2">
            <dt className="text-xs font-medium text-neutral-500">{X.felter.hvadSaelger}</dt>
            <dd className="whitespace-pre-line break-words text-[15px] text-neutral-900">{h.hvad_saelger_i}</dd>
          </div>
          {h.besked && (
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs font-medium text-neutral-500">{X.felter.besked}</dt>
              <dd className="whitespace-pre-line break-words text-[15px] text-neutral-900">{h.besked}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <HenvendelseHandlinger id={h.id} status={h.status} noter={h.noter} arkiveret={!!h.arkiveret_kl} />
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="font-sans text-lg font-semibold text-neutral-900">{A.opret.titel}</h2>
        <div className="mt-3">
          {h.firma_id ? (
            <div className="rounded-xl border border-succes-kant bg-succes-bg p-4 text-succes-tekst">
              <p className="font-semibold">{X.firmaOprettet}</p>
              <Link href={`/admin/erhverv/firmaer/${h.firma_id}`} className="btn btn-sekundaer mt-3">
                {X.seFirma}
              </Link>
            </div>
          ) : h.status !== "godkendt" ? (
            <p className="rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
              {A.opret.fejl.ikkeGodkendt}
            </p>
          ) : (
            <OpretFirmakonto
              henvendelseId={h.id}
              loginEmail={h.email}
              pakker={pakker}
              start={{
                firmanavn: h.firmanavn,
                cvr: h.cvr,
                adresse: h.adresse ?? "",
                postnummer: h.postnummer ?? "",
                by: h.bynavn ?? "",
                telefon: h.telefon,
                kontaktEmail: h.email,
                kontaktperson: h.kontaktperson,
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}
