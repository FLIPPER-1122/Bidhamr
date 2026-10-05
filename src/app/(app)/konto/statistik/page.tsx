import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { kanOptimeres } from "@/lib/billedUrl";
import { kroner } from "@/lib/kroner";
import { formatTidTilbage } from "@/lib/auctionTid";
import KontoSideHoved from "@/components/konto/KontoSideHoved";
import LiveOpdatering from "@/components/konto/LiveOpdatering";
import TomTilstand from "@/components/TomTilstand";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Min statistik", robots: { index: false, follow: false } };

// Svar fra min_statistik() (migration 20261007010000). Beløb i øre.
type Statistik = {
  auktioner: { i_alt: number; aktive: number; solgte: number };
  indtjening_oere: {
    uge: number;
    maaned: number;
    aar: number;
    i_alt: number;
    udbetalt: number;
    paa_vej: number;
    antal_handler: number;
  };
  bud_paa: number;
};

type BudStatus = "foerer" | "overbudt" | "vundet" | "tabt" | "annulleret";

type BudRaekke = {
  auktion_id: string;
  titel: string;
  billede: string | null;
  slutter_kl: string;
  nuvaerende_bud: number | string;
  mit_bud: number | string;
  antal_bud: number;
  min_status: BudStatus;
};

const STATUS: Record<BudStatus, { tekst: string; klasse: string }> = {
  foerer: { tekst: "Du fører", klasse: "border-succes-kant bg-succes-bg text-succes-tekst" },
  overbudt: { tekst: "Overbudt", klasse: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" },
  vundet: { tekst: "Vundet", klasse: "border-succes-kant bg-succes-bg text-succes-tekst" },
  tabt: { tekst: "Ikke vundet", klasse: "border-kant bg-white text-tekst-daempet" },
  annulleret: { tekst: "Annulleret", klasse: "border-kant bg-white text-tekst-daempet" },
};

const kr = (v: number | string) => `${Number(v).toLocaleString("da-DK")} kr`;

function Tal({ tal, tekst, stor = false }: { tal: string; tekst: string; stor?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl bg-groen-lys px-3 py-3.5">
      <p className={`${stor ? "text-[20px] sm:text-[22px]" : "text-[22px]"} leading-tight font-bold break-words text-tekst tabular-nums`}>
        {tal}
      </p>
      <p className="mt-0.5 text-[13px] leading-snug text-tekst-daempet">{tekst}</p>
    </div>
  );
}

export default async function StatistikSide() {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) redirect("/login?redirect=/konto/statistik");

  // Begge funktioner udleder brugeren af auth.uid() - man kan kun se egne tal.
  const [{ data: statData, error: statFejl }, { data: budData, error: budFejl }] = await Promise.all([
    supabase.rpc("min_statistik"),
    supabase.rpc("mine_bud_auktioner", { p_graense: 100 }),
  ]);
  if (statFejl) console.error("Statistik kunne ikke hentes:", statFejl.message);
  if (budFejl) console.error("Bud kunne ikke hentes:", budFejl.message);
  const stat = (statData ?? null) as Statistik | null;
  const bud = (budData ?? []) as BudRaekke[];
  const ind = stat?.indtjening_oere;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 lg:py-10">
      <LiveOpdatering />
      <KontoSideHoved
        titel="Min statistik"
        krumme="Statistik"
        tekst="Dit overblik over salg og bud. Kun du kan se dine tal."
      />

      {!stat || !ind ? (
        <p role="alert" className="mt-6 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Din statistik kunne ikke hentes lige nu. Prøv igen om lidt.
        </p>
      ) : (
        <>
          <section aria-labelledby="indtjening" className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 id="indtjening" className="text-[20px] leading-tight lg:text-[22px]">Indtjening</h2>
            <p className="mt-1 text-sm text-tekst-daempet">
              Udbetalt eller på vej til dig efter sælgergebyr.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tal stor tal={kroner(ind.uge)} tekst="Denne uge" />
              <Tal stor tal={kroner(ind.maaned)} tekst="Denne måned" />
              <Tal stor tal={kroner(ind.aar)} tekst="I år" />
              <Tal stor tal={kroner(ind.i_alt)} tekst="I alt" />
            </div>
            <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-3 rounded-xl border border-kant px-4 py-3">
                <dt className="text-tekst-daempet">Udbetalt</dt>
                <dd className="font-semibold text-tekst tabular-nums">{kroner(ind.udbetalt)}</dd>
              </div>
              <div className="flex justify-between gap-3 rounded-xl border border-kant px-4 py-3">
                <dt className="text-tekst-daempet">På vej til dig</dt>
                <dd className="font-semibold text-tekst tabular-nums">{kroner(ind.paa_vej)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-[13px] text-tekst-daempet">
              Tallene dækker solgte varer, som køberen har betalt: buddet minus sælgergebyret på 5 %.
              Fragt er ikke med. &quot;På vej til dig&quot; er betalt, men endnu ikke sendt til din
              udbetalingskonto – fx fordi køberen ikke har godkendt varen endnu. Det kan ændre sig, hvis
              en handel ender i en sag. Betalingen håndteres af vores betalingspartner Stripe.{" "}
              <Link href="/konto" className="font-medium text-groen hover:underline">
                Se dine udbetalinger
              </Link>
            </p>
          </section>

          <section aria-labelledby="auktioner" className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="auktioner" className="text-[20px] leading-tight lg:text-[22px]">Dine auktioner</h2>
              <Link href="/opret-auktion" className="text-sm font-medium text-groen hover:underline">
                Opret auktion →
              </Link>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Tal tal={String(stat.auktioner.i_alt)} tekst="Oprettet i alt" />
              <Tal tal={String(stat.auktioner.aktive)} tekst="Aktive nu" />
              <Tal tal={String(stat.auktioner.solgte)} tekst="Solgt" />
            </div>
          </section>
        </>
      )}

      <section aria-labelledby="budt-paa" className="mt-6">
        <h2 id="budt-paa" className="text-[20px] leading-tight lg:text-[22px]">
          Auktioner du har budt på{bud.length > 0 ? ` (${stat?.bud_paa ?? bud.length})` : ""}
        </h2>
        {budFejl ? (
          <p role="alert" className="mt-3 text-sm text-fejl-tekst">
            Listen kunne ikke hentes lige nu. Prøv igen om lidt.
          </p>
        ) : bud.length === 0 ? (
          <TomTilstand
            className="mt-3"
            ikon="soeg"
            titel="Du har ikke budt på noget endnu"
            tekst="Når du byder, kan du følge med her og se, om du fører."
            knap={{ href: "/auktioner", tekst: "Find en auktion" }}
          />
        ) : (
          <ul className="mt-3 divide-y divide-kant rounded-[14px] border border-kant bg-white">
            {bud.map((b) => {
              const status = STATUS[b.min_status] ?? STATUS.tabt;
              const koerer = b.min_status === "foerer" || b.min_status === "overbudt";
              return (
                <li key={b.auktion_id}>
                  <Link
                    href={`/auktion/${b.auktion_id}`}
                    className="flex items-center gap-3 rounded-[14px] px-4 py-3.5 hover:bg-groen-lys/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-groen sm:gap-4"
                  >
                    <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-skelet">
                      {b.billede && (
                        <Image
                          src={b.billede}
                          alt=""
                          fill
                          sizes="56px"
                          unoptimized={!kanOptimeres(b.billede)}
                          className="object-cover"
                        />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-tekst">{b.titel}</span>
                      <span className="mt-0.5 block text-[13px] text-tekst-svag">
                        Dit bud <span className="font-semibold text-tekst">{kr(b.mit_bud)}</span>
                        {Number(b.nuvaerende_bud) !== Number(b.mit_bud) && (
                          <>
                            {" "}· Højeste <span className="font-semibold text-tekst">{kr(b.nuvaerende_bud)}</span>
                          </>
                        )}
                        {koerer && <> · {formatTidTilbage(b.slutter_kl)} tilbage</>}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${status.klasse}`}>
                      {status.tekst}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {bud.some((b) => b.min_status === "vundet") && (
          <p className="mt-3 text-sm text-tekst-daempet">
            Betaling og levering af det, du har vundet, finder du under{" "}
            <Link href="/mine-handler" className="font-medium text-groen hover:underline">
              Mine handler
            </Link>
            .
          </p>
        )}
      </section>
    </main>
  );
}
