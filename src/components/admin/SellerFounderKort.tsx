import Link from "next/link";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { opretSellerFounder, retSellerFounderStart, stopSellerFounder } from "@/app/actions/adminSellerFounder";
import { kroner } from "@/lib/kroner";
import { anslaaetStripeTabOere, STRIPE_GEBYR_SKOEN_TEKST } from "@/lib/betaling/stripeGebyrSkoen";
import type { createAdminClient } from "@/lib/supabase/admin";

// Admin -> brugeren -> Seller founder (KUN chef - serveren og databasen
// tjekker det igen). Ét klik + én dialog pr. handling: "Gør til founder"
// (startdato = i dag som standard), "Ret startdato" og "Stop aftalen". Fasen
// står øverst: "0 kr. til og med <dato>" eller "50 %". Reglen:
// ROADMAP-BESLUTNINGER "Seller founder" (Filip, 29. okt. 2026).
// 20261102460000 ("Founderens gratis handler"): anslået Stripe-tab i fasen
// med 100 %, mistanke om falske handler (alarmer), og den første oprettelse
// bevares ved genoptagelse. Staff kan ikke være founder.

export type FounderAftale = {
  bruger_id: string;
  navn: string | null;
  email: string | null;
  start_dato: string;
  stoppet_kl: string | null;
  note: string | null;
  oprettet_kl: string;
  oprettet_af_navn: string | null;
  er_firma: boolean;
  rabat_nu: number;
  fri_til: string;
  halv_fra: string;
  // Betalte handler med rabat, uden refunderede (20261102460000).
  handler: number;
  rabat_oere: number;
  // Felterne herunder kommer med 20261102460000 (mangler før migrationen).
  refunderede?: number;
  // Betalte handler med 100 % rabat inkl. refunderede, og hvad køberne betalte.
  gratis_handler?: number;
  gratis_total_oere?: number;
  genoptaget_kl?: string | null;
  genoptaget_af_navn?: string | null;
  er_staff?: boolean;
  alarm_aktiv?: boolean;
  alarmer?: FounderAlarm[];
};

export type FounderAlarm = {
  koeber_id: string;
  koeber_navn: string | null;
  handler: number;
  foerste_betalt_kl: string;
  seneste_betalt_kl: string;
  oprettet_kl: string;
};

// Anslået Stripe-tab (skøn) i fasen med 100 %.
export function founderStripeTabOere(a: FounderAftale): number {
  return anslaaetStripeTabOere(Number(a.gratis_handler ?? 0), Number(a.gratis_total_oere ?? 0));
}

const kortDato = (iso: string) => new Date(iso).toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen" });

// Markering ved mistanke om falske handler inden for 30 dage (listen og boksen).
export function FounderAlarmMaerke({ a }: { a: FounderAftale }) {
  if (!a.alarm_aktiv) return null;
  return <span className="rounded-none bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">Mulige falske handler</span>;
}

// ÅÅÅÅ-MM-DD -> "28. apr. 2027".
export function founderDato(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Copenhagen",
  });
}

// Fasen i én linje (boksen og listen).
export function founderFase(a: FounderAftale): { tekst: string; tone: "groen" | "blaa" | "graa" } {
  if (a.stoppet_kl) {
    return { tekst: `Stoppet ${new Date(a.stoppet_kl).toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen" })}`, tone: "graa" };
  }
  if (a.er_firma) return { tekst: "Firmakonto - ingen rabat", tone: "graa" };
  if (a.er_staff) return { tekst: "Staff-konto - ingen rabat", tone: "graa" };
  if (a.rabat_nu === 100) return { tekst: `0 kr. til og med ${founderDato(a.fri_til)}`, tone: "groen" };
  if (a.rabat_nu === 50) return { tekst: "50 % af gebyrerne", tone: "blaa" };
  return { tekst: `Starter ${founderDato(a.start_dato)}`, tone: "graa" };
}

const TONE: Record<string, string> = {
  groen: "bg-green-100 text-green-800",
  blaa: "bg-blue-50 text-blue-800",
  graa: "bg-neutral-100 text-neutral-700",
};

export function FounderFaseMaerke({ a }: { a: FounderAftale }) {
  const f = founderFase(a);
  return <span className={`rounded-none px-2 py-0.5 text-xs font-semibold ${TONE[f.tone]}`}>{f.tekst}</span>;
}

export default async function SellerFounderKort({
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
  const { data, error } = await admin.rpc("seller_founder_admin", { p_chef: chefId, p_bruger: brugerId });
  if (error || !data) return null; // migrationen er ikke kørt, eller ingen adgang
  const v = data as { kode: string; i_dag: string; er_firma: boolean; er_staff?: boolean; founder: FounderAftale | null };
  if (v.kode !== "ok") return null;
  const a = v.founder;
  const aktiv = !!a && !a.stoppet_kl;
  const egen = chefId === brugerId;
  const staff = !!v.er_staff;

  return (
    <section aria-labelledby="founder-titel" className="rounded-xl border border-neutral-200 bg-white p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="founder-titel" className="text-sm font-semibold text-neutral-800">
          Seller founder <span className="font-normal text-neutral-500">(kun chef)</span>
        </h2>
        {a && (
          <div className="flex flex-wrap items-center gap-2">
            <FounderAlarmMaerke a={a} />
            <FounderFaseMaerke a={a} />
          </div>
        )}
      </div>

      {v.er_firma && !aktiv ? (
        <p className="mt-2 text-sm text-neutral-500">Firmakonto - kan ikke være seller founder.</p>
      ) : staff && !aktiv ? (
        <p className="mt-2 text-sm text-neutral-500">Staff-konto - kan ikke være seller founder.</p>
      ) : !a ? (
        <p className="mt-2 text-sm text-neutral-500">
          Ikke founder. Founders betaler 0 kr. i gebyr (købergebyr og sælgergebyr) i 6 måneder fra startdatoen og
          derefter 50 %. Mærket &quot;Founding seller&quot; vises på profilen og auktionerne. I måned 1-6 betaler BidHamr
          selv Stripes gebyr på founderens handler ({STRIPE_GEBYR_SKOEN_TEKST} pr. handel), fordi der ikke kommer gebyr ind.
        </p>
      ) : (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-neutral-500">Startdato</dt>
            <dd className="text-neutral-900">{founderDato(a.start_dato)}</dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-neutral-500">50 % fra</dt>
            <dd className="text-neutral-900">{founderDato(a.halv_fra)}</dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-neutral-500">Betalte handler med rabat (uden refunderede)</dt>
            <dd className="text-neutral-900">
              {a.handler}
              {Number(a.refunderede ?? 0) > 0 && <span className="text-neutral-500"> · {a.refunderede} refunderet</span>}
            </dd>
          </div>
          <div className="flex justify-between gap-3 sm:block">
            <dt className="text-neutral-500">Rabat givet i alt (købergebyr + sælgergebyr)</dt>
            <dd className="text-neutral-900">{kroner(Number(a.rabat_oere))}</dd>
          </div>
          {a.gratis_handler !== undefined && (
            <div className="sm:col-span-2">
              <dt className="text-neutral-500">Anslået Stripe-gebyr betalt af BidHamr (skøn)</dt>
              <dd className="text-neutral-900">
                ca. {kroner(founderStripeTabOere(a))}
                <span className="block text-xs text-neutral-500">
                  Skøn: {STRIPE_GEBYR_SKOEN_TEKST} pr. betalt handel med 0 kr. i gebyr ({a.gratis_handler}{" "}
                  {a.gratis_handler === 1 ? "handel" : "handler"}, også refunderede, for Stripe beholder sit gebyr).
                  Det præcise beløb står i Stripe.
                </span>
              </dd>
            </div>
          )}
          <p className="text-xs text-neutral-700 sm:col-span-2">
            I måned 1-6 betaler BidHamr selv Stripes gebyr på founderens handler, fordi der ikke kommer gebyr ind.
          </p>
          {a.alarmer && a.alarmer.length > 0 && (
            <div className="rounded-none border border-red-200 bg-red-50 p-3 sm:col-span-2">
              <dt className="font-semibold text-red-800">Mistanke om falske handler</dt>
              <dd className="mt-1 text-red-900">
                <span className="block text-xs">
                  Samme køber har mindst 3 betalte handler hos founderen inden for 30 dage. Tjek handlerne, og stop
                  aftalen, hvis de ikke er ægte.
                </span>
                <ul className="mt-2 space-y-1">
                  {a.alarmer.map((x) => (
                    <li key={`${x.koeber_id}-${x.oprettet_kl}`}>
                      <Link href={`/admin/brugere/${x.koeber_id}`} className="font-medium underline">
                        {x.koeber_navn ?? "Køber uden navn"}
                      </Link>
                      : {x.handler} handler fra {kortDato(x.foerste_betalt_kl)} til {kortDato(x.seneste_betalt_kl)}{" "}
                      <span className="text-xs text-red-700">(alarm {kortDato(x.oprettet_kl)})</span>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {a.note && (
            <div className="sm:col-span-2">
              <dt className="text-neutral-500">Note (intern)</dt>
              <dd className="whitespace-pre-line text-neutral-900">{a.note}</dd>
            </div>
          )}
          <p className="text-xs text-neutral-500 sm:col-span-2">
            Oprettet {new Date(a.oprettet_kl).toLocaleDateString("da-DK", { timeZone: "Europe/Copenhagen" })}
            {a.oprettet_af_navn ? ` af ${a.oprettet_af_navn}` : ""}
            {a.genoptaget_kl
              ? `, genoptaget ${kortDato(a.genoptaget_kl)}${a.genoptaget_af_navn ? ` af ${a.genoptaget_af_navn}` : ""}`
              : ""}
            . Ændringer gælder kun nye handler - gebyret er låst på
            handler, der allerede er vundet.
          </p>
        </dl>
      )}

      {!egen && !(v.er_firma && !aktiv) && !(staff && !aktiv) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {!aktiv && (
            <ConfirmDialog
              triggerLabel={a ? "Gør til founder igen" : "Gør til founder"}
              triggerClassName="btn btn-primaer btn-lille"
              title={`Gør ${brugerNavn} til seller founder?`}
              description="Fra startdatoen er købergebyr og sælgergebyr 0 kr. på brugerens salg i 6 måneder og derefter 50 %. BidHamr Beskyttelse og fragt er uændret. Gebyret låses på hver handel, når den er vundet. Handlingen logges."
              confirmLabel="Gør til founder"
              action={opretSellerFounder}
              hiddenFields={{ brugerId }}
              datoFelt={{
                name: "startDato",
                label: "Startdato (aftalens dato)",
                standard: v.i_dag,
                min: "2026-01-01",
                hjaelp: "Måned 1-6 regnes fra denne dato (dansk tid).",
              }}
              tekstFelter={[{ name: "note", label: "Note (intern)", required: false, maxLength: 1000, placeholder: "Fx hvad aftalen går ud på" }]}
              kvittering="Brugeren er nu seller founder"
            />
          )}
          {aktiv && a && (
            <>
              <ConfirmDialog
                triggerLabel="Ret startdato"
                triggerClassName="btn btn-sekundaer btn-lille"
                title="Ret startdatoen"
                description="Den nye dato gælder for handler, der vindes fra nu af. Handler, der allerede er vundet, beholder deres gebyr. Ændringen logges."
                confirmLabel="Gem startdato"
                action={retSellerFounderStart}
                hiddenFields={{ brugerId }}
                fakta={[{ label: "Nuværende startdato", vaerdi: founderDato(a.start_dato) }]}
                datoFelt={{ name: "startDato", label: "Ny startdato", standard: a.start_dato, min: "2026-01-01" }}
                kvittering="Startdatoen er ændret"
              />
              <ConfirmDialog
                triggerLabel="Stop aftalen"
                triggerClassName="btn btn-fare btn-lille"
                fare
                title={`Stop ${brugerNavn}s seller founder-aftale?`}
                description="Nye handler får de almindelige gebyrer, og mærket »Founding seller« forsvinder med det samme. Handler, der allerede er vundet, beholder deres gebyr. Handlingen logges."
                confirmLabel="Stop aftalen"
                action={stopSellerFounder}
                hiddenFields={{ brugerId }}
                aarsagField={{ name: "begrundelse", label: "Begrundelse (intern)", placeholder: "Hvorfor stoppes aftalen?", required: false }}
                kvittering="Aftalen er stoppet"
              />
            </>
          )}
        </div>
      )}
    </section>
  );
}
