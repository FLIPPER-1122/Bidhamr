import Link from "next/link";
import { notFound } from "next/navigation";
import { kraevErhvervSide } from "@/lib/adminAuth";
import { hentErhvervPakker, hentFirmaer } from "@/app/actions/adminErhverv";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { dato, datoTid } from "@/components/admin/erhverv/ErhvervFaner";
import FirmaRedigering from "@/components/admin/erhverv/FirmaRedigering";
import { ADMIN_ERHVERV as A, ADMIN_ERHVERV_EKSTRA as X } from "@/lib/tekster/erhverv";
import { ABONNEMENT_STATUS_NAVN } from "@/lib/erhverv/regler";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FirmaSide({ params }: { params: Promise<{ id: string }> }) {
  const { rolle } = await kraevErhvervSide();
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const [res, pakkerSvar] = await Promise.all([hentFirmaer(), hentErhvervPakker()]);
  if ("fejl" in res) throw new Error(res.fejl);
  const f = res.firmaer.find((x) => x.id === id);
  if (!f) notFound();
  const pakker = "fejl" in pakkerSvar ? [] : pakkerSvar.pakker;

  const info: [string, string][] = [
    [X.felter.loginEmail, f.login_email],
    [X.felter.loggetInd, f.har_logget_ind ? X.ja : X.nej],
    [A.firmaer.kolonnePakke, f.pakke?.navn ?? "–"],
    [X.feltStatus, ABONNEMENT_STATUS_NAVN[f.abonnement_status] ?? f.abonnement_status],
    [X.aktiveAuktioner, String(f.aktive_auktioner)],
    [X.oprettetAf, `${f.oprettet_af_navn ?? "–"} (${datoTid(f.oprettet_kl)})`],
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <Link href="/admin/erhverv/firmaer" className="inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline">
        ← {X.tilbageTilFirmaer}
      </Link>
      <AdminSideHoved titel={f.firmanavn} forklaring={`${A.firmaer.kolonneCvr} ${f.cvr}`} />

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {info.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs font-medium text-neutral-500">{k}</dt>
              <dd className="break-words text-[15px] text-neutral-900">{v}</dd>
            </div>
          ))}
        </dl>
        {f.afventende_opgradering && (
          <p className="mt-4 rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
            {X.afventerOpgradering(f.afventende_opgradering.navn)}
          </p>
        )}
        {f.naeste_pakke && f.naeste_pakke_fra && (
          <p className="mt-4 rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
            {X.planlagtSkift(f.naeste_pakke.navn, dato(f.naeste_pakke_fra))}
          </p>
        )}
        {f.henvendelse_id && (
          <Link href={`/admin/erhverv/henvendelser/${f.henvendelse_id}`} className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-groen hover:underline">
            {A.henvendelser.titel} →
          </Link>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <FirmaRedigering
          firmaId={f.id}
          erChef={rolle === "chef"}
          harLoggetInd={f.har_logget_ind}
          pakkeId={f.pakke_id}
          status={f.abonnement_status}
          pakker={pakker}
          start={{
            firmanavn: f.firmanavn,
            cvr: f.cvr,
            adresse: f.adresse,
            postnummer: f.postnummer,
            by: f.bynavn,
            telefon: f.telefon,
            kontaktEmail: f.kontakt_email,
            kontaktperson: f.kontaktperson,
          }}
        />
      </section>
    </div>
  );
}
