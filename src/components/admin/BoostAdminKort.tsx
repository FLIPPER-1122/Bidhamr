import { randomUUID } from "node:crypto";
import Link from "next/link";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { justerBoostPoint, refunderBoostKoebAction } from "@/app/actions/adminBoost";
import { BOOST_TEKST } from "@/lib/boost/tekster";
import { kroner } from "@/lib/kroner";
import type { createAdminClient } from "@/lib/supabase/admin";

// Admin -> brugeren -> Boost-point (KUN chef - serveren og databasen tjekker
// det igen): saldo, posteringer og køb, justering med begrundelse (logges i
// medarbejder-loggen) og refusion af et køb. Køb i appen (Apple/Google) står
// for sig: de refunderes kun af Apple/Google (pointene trækkes så tilbage af
// sig selv - også i minus), og BidHamr laver ingen faktura for dem.

type Posteringer = {
  id: string;
  type: string;
  point: number;
  oensket_point: number | null;
  saldo_efter: number;
  kl: string;
  begrundelse: string | null;
  staff_navn: string | null;
  auktion_id: string | null;
  auktion_titel: string | null;
}[];

type Koeb = {
  id: string;
  point: number;
  beloeb_oere: number;
  status: string;
  oprettet_kl: string;
  betalt_kl: string | null;
  refunderet_kl: string | null;
  refusion_aarsag: string | null;
  kraever_opmaerksomhed: boolean;
  opmaerksomhed_tekst: string | null;
  stripe_payment_intent_id: string | null;
}[];

type AppKoeb = {
  id: string;
  platform: "ios" | "android";
  produkt_id: string;
  point: number;
  miljoe: "produktion" | "test";
  markering?: "testkoeb_prod" | "promo" | null;
  koebt_kl: string;
  pris_milli: number | null;
  valuta: string | null;
  ekstern_id: string;
  forbrugt_kl: string | null;
  refunderet_point: number;
  refunderet_kl: string | null;
  kraever_opmaerksomhed: boolean;
  opmaerksomhed_tekst: string | null;
}[];

const PLATFORM: Record<string, string> = { ios: "App Store", android: "Google Play" };

// Apples pris i milliunits (39000 = 39,00) i købets valuta.
function appPris(k: AppKoeb[number]): string {
  if (k.pris_milli === null || !k.valuta) return "pris ukendt";
  if (k.valuta === "DKK") return kroner(Math.round(Number(k.pris_milli) / 10));
  return `${(Number(k.pris_milli) / 1000).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${k.valuta}`;
}

const STATUS: Record<string, string> = {
  afventer: "Ikke betalt",
  behandles: "Behandles",
  betalt: "Betalt",
  refunderes: "Refunderes",
  refunderet: "Refunderet",
  annulleret: "Annulleret",
};

const dato = (iso: string) =>
  new Date(iso).toLocaleString("da-DK", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" });

export default async function BoostAdminKort({
  admin,
  chefId,
  brugerId,
  brugerNavn,
}: {
  admin: ReturnType<typeof createAdminClient>;
  chefId: string;
  brugerId: string;
  brugerNavn: string;
}) {
  const { data, error } = await admin.rpc("boost_admin_bruger", { p_staff: chefId, p_bruger: brugerId });
  if (error || !data) return null; // migrationen er ikke kørt, eller ingen adgang
  const v = data as { saldo: number; spaerret: string | null; posteringer: Posteringer; koeb: Koeb };
  // Køb i appen (20261102320000) - tom liste, hvis migrationen ikke er kørt.
  const { data: appData } = await admin.rpc("boost_iap_admin_bruger", { p_staff: chefId, p_bruger: brugerId });
  const appKoeb = (Array.isArray(appData) ? appData : []) as AppKoeb;
  const egen = chefId === brugerId;

  return (
    <section aria-labelledby="boost-admin-titel" className="rounded-xl border border-neutral-200 bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="boost-admin-titel" className="text-sm font-semibold text-neutral-800">
          Boost-point <span className="font-normal text-neutral-500">(kun chef)</span>
        </h2>
        <p className="text-lg font-bold text-neutral-900">{BOOST_TEKST.saldo(v.saldo)}</p>
      </div>
      {v.spaerret === "erhverv" && <p className="mt-1 text-sm text-neutral-500">Firmakonto - kan ikke købe eller bruge boost.</p>}
      {v.saldo < 0 && (
        <p className="mt-1 text-sm text-red-700">
          Saldoen er i minus, fordi Apple eller Google har refunderet et køb, hvor pointene var brugt. Nye boost er blokeret, til saldoen er over prisen for et boost.
        </p>
      )}

      {!egen && (
        <div className="mt-4">
          <ConfirmDialog
            triggerLabel="Justér point"
            triggerClassName="btn btn-sekundaer btn-lille"
            title={`Justér ${brugerNavn}s boost-point`}
            description="Skriv et positivt tal for at give point og et negativt for at trække point. Et træk kan ikke gøre saldoen negativ (point kan altid lægges til - også når saldoen er i minus efter en refusion i appen). Justeringen logges i medarbejder-loggen og kan ikke slettes."
            confirmLabel="Justér point"
            action={justerBoostPoint}
            hiddenFields={{ brugerId, noegle: randomUUID() }}
            fakta={[{ label: "Saldo nu", vaerdi: BOOST_TEKST.saldo(v.saldo) }]}
            tekstFelter={[{ name: "point", label: "Point (fx 50 eller -50)", required: true, maxLength: 7 }]}
            aarsagField={{ name: "begrundelse", label: "Begrundelse (intern)", placeholder: "Hvorfor justeres pointene?", required: true }}
            kvittering="Pointene er justeret"
          />
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-neutral-800">Køb på bidhamr.dk (Stripe)</h3>
      {v.koeb.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">Ingen køb.</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-100 text-sm">
          {v.koeb.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-neutral-900">
                  {k.point} point · {kroner(Number(k.beloeb_oere))} · {STATUS[k.status] ?? k.status}
                </p>
                <p className="text-xs text-neutral-500">
                  {dato(k.betalt_kl ?? k.oprettet_kl)}
                  {k.stripe_payment_intent_id ? ` · ${k.stripe_payment_intent_id}` : ""}
                </p>
                {k.kraever_opmaerksomhed && k.opmaerksomhed_tekst && (
                  <p className="mt-1 whitespace-pre-line text-xs text-red-700">{k.opmaerksomhed_tekst}</p>
                )}
              </div>
              {k.status === "betalt" && !egen && (
                <ConfirmDialog
                  triggerLabel="Refundér køb"
                  triggerClassName="btn btn-tekst btn-lille"
                  title="Refundér købet af boost-point?"
                  description={
                    v.saldo < 0
                      ? `Advarsel: saldoen er i minus (${v.saldo} point) efter en refusion i appen. Hele beløbet (${kroner(Number(k.beloeb_oere))}) sendes tilbage via Stripe, men der trækkes INGEN point tilbage, fordi saldoen ikke kan blive mere negativ. Brugeren får altså pengene tilbage og har stadig minusset. Brugeren får en kreditnota.`
                      : `Hele beløbet (${kroner(Number(k.beloeb_oere))}) sendes tilbage via Stripe, og brugerens point trækkes tilbage - højst ${k.point}, og saldoen kan ikke blive negativ. Brugeren får en kreditnota.`
                  }
                  confirmLabel="Refundér"
                  action={refunderBoostKoebAction}
                  hiddenFields={{ koebId: k.id, brugerId }}
                  fakta={[
                    { label: "Beløb", vaerdi: kroner(Number(k.beloeb_oere)) },
                    { label: "Point trækkes", vaerdi: `${Math.max(0, Math.min(k.point, v.saldo))} af ${k.point}` },
                    ...(v.saldo < 0
                      ? [{ label: "Saldo", vaerdi: <span className="font-semibold text-red-700">{`${v.saldo} point (i minus)`}</span> }]
                      : []),
                  ]}
                  aarsagField={{ name: "begrundelse", label: "Begrundelse (intern)", placeholder: "Hvorfor refunderes købet?", required: true }}
                  fare
                  kanIkkeFortrydes
                  kvittering="Købet er refunderet"
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-sm font-semibold text-neutral-800">Køb i appen (Apple og Google)</h3>
      <p className="mt-0.5 text-xs text-neutral-500">
        Apple og Google er sælger: de har opkrævet køberen, udstedt kvitteringen og refunderer selv. BidHamr laver ingen faktura for disse køb.
      </p>
      {appKoeb.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">Ingen køb i appen.</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-100 text-sm">
          {appKoeb.map((k) => (
            <li key={k.id} className="py-2">
              <p className="text-neutral-900">
                {k.point} point · {PLATFORM[k.platform] ?? k.platform} · {appPris(k)}
                {k.markering === "testkoeb_prod" ? " · testkøb i produktion" : k.miljoe === "test" ? " · testkøb" : ""}
                {k.markering === "promo" ? " · promokode (ikke betalt)" : ""}
                {k.refunderet_point > 0 ? ` · refunderet (${k.refunderet_point} point trukket)` : ""}
              </p>
              <p className="text-xs text-neutral-500">
                {dato(k.koebt_kl)} · {k.ekstern_id}
                {k.platform === "android" && !k.forbrugt_kl && k.refunderet_point < k.point ? " · ikke forbrugt hos Google endnu" : ""}
              </p>
              {k.kraever_opmaerksomhed && k.opmaerksomhed_tekst && (
                <p className="mt-1 whitespace-pre-line text-xs text-red-700">{k.opmaerksomhed_tekst}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-6 text-sm font-semibold text-neutral-800">Posteringer</h3>
      {v.posteringer.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-500">Ingen posteringer.</p>
      ) : (
        <ul className="mt-2 divide-y divide-neutral-100 text-sm">
          {v.posteringer.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="text-neutral-900">
                  {BOOST_TEKST.type[p.type] ?? p.type}
                  {p.type === "forbrug" && p.auktion_id && (
                    <>
                      {": "}
                      <Link href={`/admin/auktioner/${p.auktion_id}`} className="text-groen underline">
                        {p.auktion_titel ?? "auktion"}
                      </Link>
                    </>
                  )}
                  {p.type === "staff" && p.staff_navn ? ` (${p.staff_navn})` : ""}
                </p>
                <p className="text-xs text-neutral-500">
                  {dato(p.kl)}
                  {p.type === "tilbagefoersel" && p.oensket_point !== null ? ` · ${-p.point} af ${p.oensket_point}` : ""}
                </p>
                {p.begrundelse && <p className="mt-0.5 text-xs text-neutral-600">{p.begrundelse}</p>}
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <p className="font-semibold text-neutral-900">
                  {p.point > 0 ? "+" : ""}
                  {p.point}
                </p>
                <p className="text-xs text-neutral-500">Saldo {p.saldo_efter}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
