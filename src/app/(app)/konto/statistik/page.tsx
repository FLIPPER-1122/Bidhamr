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
  // pauset: skjult af BidHamr og på pause (20261009040000) - mangler i ældre svar.
  auktioner: { i_alt: number; aktive: number; solgte: number; pauset?: number };
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

// "pause": skjult af BidHamr og på pause - den slutter ikke imens.
type BudStatus = "foerer" | "overbudt" | "vundet" | "tabt" | "annulleret" | "pause";

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
  pause: { tekst: "På pause", klasse: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" },
};

// Filtre i budlisten. "Aktive" = auktionen kører stadig.
type Filter = "alle" | "aktive" | "vundet" | "ikke-vundet";
const FILTRE: { id: Filter; tekst: string; statusser: BudStatus[] | null }[] = [
  { id: "alle", tekst: "Alle", statusser: null },
  { id: "aktive", tekst: "Aktive", statusser: ["foerer", "overbudt", "pause"] },
  { id: "vundet", tekst: "Vundet", statusser: ["vundet"] },
  { id: "ikke-vundet", tekst: "Ikke vundet", statusser: ["tabt", "annulleret"] },
];

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

export default async function StatistikSide({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string }>;
}) {
  const { vis } = await searchParams;
  const filter: Filter = FILTRE.some((f) => f.id === vis) ? (vis as Filter) : "alle";
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
  const harSolgt = !!ind && (ind.i_alt > 0 || ind.paa_vej > 0 || ind.udbetalt > 0 || ind.antal_handler > 0);

  // Vundne auktioner linker til handlen under Mine handler, hvis vi kan finde
  // den. Kun egne handler (buyer_id), kun de to kolonner, siden bruger.
  const vundneIds = bud.filter((b) => b.min_status === "vundet").map((b) => b.auktion_id);
  const handelForAuktion = new Map<string, string>();
  if (vundneIds.length > 0) {
    const { data: handler, error: handelFejl } = await supabase
      .from("trades")
      .select("id, auction_id")
      .eq("buyer_id", authData.user.id)
      .in("auction_id", vundneIds)
      .order("created_at", { ascending: false })
      .limit(vundneIds.length * 2);
    if (handelFejl) console.error("Statistik: handler kunne ikke hentes:", handelFejl.message);
    for (const h of (handler ?? []) as { id: string; auction_id: string }[]) {
      if (!handelForAuktion.has(h.auction_id)) handelForAuktion.set(h.auction_id, h.id);
    }
  }

  const antal = (f: (typeof FILTRE)[number]) =>
    f.statusser ? bud.filter((b) => f.statusser!.includes(b.min_status)).length : bud.length;
  const valgtFilter = FILTRE.find((f) => f.id === filter)!;
  const vist = valgtFilter.statusser ? bud.filter((b) => valgtFilter.statusser!.includes(b.min_status)) : bud;

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
      ) : stat.auktioner.i_alt === 0 && !harSolgt ? (
        <TomTilstand
          className="mt-6"
          ikon="statistik"
          titel="Du har ikke solgt noget endnu"
          tekst="Når du sælger, kan du følge dine auktioner og din indtjening her."
          knap={{ href: "/opret-auktion", tekst: "Sæt din første ting til salg" }}
        />
      ) : (
        <>
          <section aria-labelledby="indtjening" className="mt-6 rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 id="indtjening" className="text-[20px] leading-tight lg:text-[22px]">Indtjening</h2>
            <p className="mt-1 text-sm text-tekst-daempet">
              Udbetalt eller på vej til dig efter sælgergebyr.
            </p>
            {!harSolgt ? (
              <p className="mt-4 rounded-xl bg-groen-lys px-4 py-3.5 text-[15px] text-tekst">
                Du har ikke tjent noget endnu. Når en køber har betalt for en af dine varer, kan du se beløbet her.
              </p>
            ) : (
            <>
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
              <Link href="/konto#udbetaling" className="font-medium text-groen hover:underline">
                Se dine udbetalinger
              </Link>
            </p>
            </>
            )}
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
              <Tal
                tal={String(stat.auktioner.aktive)}
                tekst={stat.auktioner.pauset ? `Aktive nu (+${stat.auktioner.pauset} på pause)` : "Aktive nu"}
              />
              <Tal tal={String(stat.auktioner.solgte)} tekst="Solgt" />
            </div>
          </section>
        </>
      )}

      <section id="budt-paa" aria-labelledby="budt-paa-titel" className="mt-6 scroll-mt-24">
        <h2 id="budt-paa-titel" className="text-[20px] leading-tight lg:text-[22px]">
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
          <>
            <nav aria-label="Filtrér dine bud" className="-mx-4 mt-3 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <ul className="flex gap-2">
                {FILTRE.map((f) => {
                  const valgt = f.id === filter;
                  return (
                    <li key={f.id} className="shrink-0">
                      <Link
                        href={f.id === "alle" ? "/konto/statistik#budt-paa" : `/konto/statistik?vis=${f.id}#budt-paa`}
                        scroll={false}
                        aria-current={valgt ? "page" : undefined}
                        className={`inline-flex min-h-11 items-center rounded-full px-4 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                          valgt ? "bg-groen text-white" : "bg-groen-lys text-groen-mork hover:bg-[#DCEAE4]"
                        }`}
                      >
                        {f.tekst} <span className="ml-1 tabular-nums opacity-80">{antal(f)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
            {vist.length === 0 ? (
              <p className="mt-3 rounded-[14px] border border-kant bg-white px-5 py-8 text-center text-[15px] text-tekst-daempet">
                {filter === "aktive"
                  ? "Du byder ikke på noget lige nu."
                  : filter === "vundet"
                    ? "Du har ikke vundet en auktion endnu."
                    : "Ingen auktioner her."}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-kant rounded-[14px] border border-kant bg-white">
                {vist.map((b) => {
                  const status = STATUS[b.min_status] ?? STATUS.tabt;
                  const koerer = b.min_status === "foerer" || b.min_status === "overbudt";
                  const vundet = b.min_status === "vundet";
                  const handelId = vundet ? handelForAuktion.get(b.auktion_id) : undefined;
                  const href = vundet
                    ? handelId
                      ? `/mine-handler/${handelId}`
                      : "/mine-handler"
                    : `/auktion/${b.auktion_id}`;
                  return (
                    <li key={b.auktion_id}>
                      <Link
                        href={href}
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
                            {vundet && (
                              <>
                                {" "}· <span className="font-medium text-groen">Se handlen</span>
                              </>
                            )}
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
          </>
        )}
        {vist.some((b) => b.min_status === "vundet") && (
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
