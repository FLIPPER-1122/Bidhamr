import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import Ikon from "@/components/Ikon";
import TomTilstand from "@/components/TomTilstand";
import { kanOptimeres } from "@/lib/billedUrl";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { bekraeftetBruger, hentBruger, sessionBrugerId } from "@/lib/supabase/bruger";
import HandelStatusBadge, { AKTIVE_STATUSSER } from "@/components/HandelStatusBadge";
import { hentMineAktiveTilbud } from "@/app/actions/andenchanceBruger";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import { sagLink, type SagStatus } from "@/lib/sager";

export const dynamic = "force-dynamic";

type HandelRaekke = {
  id: string;
  status: string;
  amount: number | string;
  created_at: string;
  buyer_id: string;
  seller_id: string;
  // Afhentning i stedet for forsendelse (sat ved oprettelsen af handlen).
  afhentning: boolean | null;
  auctions: { titel: string; billeder: string[] | null } | null;
  // Sager på handlen (hentes med i samme forespørgsel; RLS: kun parterne).
  sager: { id: string; status: SagStatus; oprettet_kl: string }[] | null;
};

const SAG_AKTIV: SagStatus[] = ["aaben", "afventer_retur"];

// Mærke på handelskortet, når der er en sag.
const SAG_MAERKE: Record<SagStatus, { tekst: string; stil: string }> = {
  aaben: { tekst: "Sag i gang", stil: "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst" },
  afventer_retur: { tekst: "Afventer retur", stil: "border-info-kant bg-info-bg text-info-tekst" },
  afgjort_koeber: { tekst: "Sag afgjort", stil: "border-kant-staerk bg-groen-lys text-tekst-daempet" },
  afgjort_saelger: { tekst: "Sag afgjort", stil: "border-kant-staerk bg-groen-lys text-tekst-daempet" },
  lukket: { tekst: "Sag lukket", stil: "border-kant-staerk bg-groen-lys text-tekst-daempet" },
};

// Den nyeste sag på handlen (der er normalt kun én).
function nyesteSag(h: HandelRaekke) {
  const sager = h.sager ?? [];
  if (sager.length === 0) return null;
  return sager.reduce((a, b) => (Date.parse(b.oprettet_kl) > Date.parse(a.oprettet_kl) ? b : a));
}

function harAktivSag(h: HandelRaekke) {
  const s = nyesteSag(h);
  return !!s && SAG_AKTIV.includes(s.status);
}

// Aktive handler grupperes efter, hvad der skal ske nu - det, du selv skal
// gøre, står øverst. Samme regler som handelssiden (/mine-handler/[id]).
type GruppeId =
  | "betale"
  | "sende"
  | "afhentning"
  | "godkende"
  | "sager"
  | "venter_saelger"
  | "venter_koeber"
  | "paa_vej";

const GRUPPER: { id: GruppeId; titel: string; tekst: string }[] = [
  { id: "betale", titel: "Du skal betale", tekst: "Betal inden fristen, så handlen ikke annulleres." },
  { id: "sende", titel: "Du skal sende", tekst: "Køberen har betalt. Send pakken inden fristen." },
  { id: "afhentning", titel: "Skal afhentes", tekst: "Varen er betalt. Aftal afhentningen i handlen." },
  { id: "godkende", titel: "Du skal godkende varen", tekst: "Tjek varen. Sælgeren får pengene, når du godkender." },
  { id: "sager", titel: "Sager i gang", tekst: "BidHamr ser på sagen. Følg med og svar i sagen." },
  { id: "venter_saelger", titel: "Venter på sælgeren", tekst: "Du har betalt. Sælgeren sender pakken." },
  { id: "venter_koeber", titel: "Venter på køberen", tekst: "Køberen skal betale eller godkende varen." },
  { id: "paa_vej", titel: "På vej", tekst: "Pakken er sendt." },
];

function gruppeFor(h: HandelRaekke, brugerId: string): GruppeId {
  if (harAktivSag(h)) return "sager";
  const erKoeber = h.buyer_id === brugerId;
  switch (h.status) {
    case "afventer_betaling":
      return erKoeber ? "betale" : "venter_koeber";
    case "betaling_modtaget":
      if (h.afhentning) return "afhentning";
      return erKoeber ? "venter_saelger" : "sende";
    case "pakke_sendt":
      return "paa_vej";
    case "modtaget":
      return erKoeber ? "godkende" : "venter_koeber";
    default:
      return "venter_koeber";
  }
}

function HandelKort({
  handel,
  brugerId,
}: {
  handel: HandelRaekke;
  brugerId: string;
}) {
  const erKoeber = handel.buyer_id === brugerId;
  const billede = handel.auctions?.billeder?.[0] ?? null;
  const sag = nyesteSag(handel);
  const sagAktiv = !!sag && SAG_AKTIV.includes(sag.status);

  return (
    <Link
      href={sagAktiv ? sagLink(handel.id) : `/mine-handler/${handel.id}`}
      className="flex gap-3 rounded-[14px] border border-kant bg-white p-4 shadow-kort transition-[box-shadow,border-color] duration-200 ease-out hover:border-kant-staerk hover:shadow-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:gap-4"
    >
      <div className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-skelet">
        {billede ? (
          <Image
            src={billede}
            alt=""
            fill
            sizes="64px"
            unoptimized={!kanOptimeres(billede)}
            className="object-cover"
          />
        ) : (
          <svg className="h-6 w-6 text-tekst-svag" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 4.5h16.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" />
          </svg>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="line-clamp-2 min-w-0 text-[15px] font-semibold text-tekst">
            {handel.auctions?.titel ?? "Slettet auktion"}
          </p>
          <span className="shrink-0 text-[15px] font-bold text-tekst tabular-nums">
            {Number(handel.amount).toLocaleString("da-DK")} kr
          </span>
        </div>
        <p className="mt-0.5 text-[13px] text-tekst-svag">
          {erKoeber ? "Du er køber" : "Du er sælger"} ·{" "}
          {new Date(handel.created_at).toLocaleDateString("da-DK")}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <HandelStatusBadge status={handel.status} />
          {sag && (
            <span
              className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-semibold ${SAG_MAERKE[sag.status].stil}`}
            >
              {SAG_MAERKE[sag.status].tekst}
            </span>
          )}
          {/* Hele kortet er linket til handelssiden (med chatten); dette er
              en synlig markering. Et <Link> her ville være et link i et link. */}
          <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-groen">
            {sagAktiv ? "Åbn sag" : "Åbn handel"}
            <Ikon navn="hoejre" className="h-4 w-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}

export const metadata: Metadata = { title: "Mine handler", robots: { index: false, follow: false } };

// Afsluttede handler vises 20 ad gangen ("Vis flere" lægger 20 til via
// ?vis=). Aktive handler er altid få og vises alle.
const AFSLUTTEDE_PR_SIDE = 20;
const MAKS_VIS = 1000;

export default async function MineHandlerPage({
  searchParams,
}: {
  searchParams: Promise<{ vis?: string }>;
}) {
  const supabase = await createClient();

  const visØnsket = Number((await searchParams).vis);
  const visAfsluttede = Number.isInteger(visØnsket)
    ? Math.min(Math.max(visØnsket, AFSLUTTEDE_PR_SIDE), MAKS_VIS)
    : AFSLUTTEDE_PR_SIDE;

  // or-filteret er det, der begrænser til egne handler. RLS alene ville ikke
  // gøre det: policyen tillader også staff at se alt.
  const kolonner =
    "id, status, amount, created_at, buyer_id, seller_id, afhentning, auctions(titel, billeder), sager(id, status, oprettet_kl)";
  const aktiveStatusser = `(${AKTIVE_STATUSSER.join(",")})`;
  const hentHandler = (brugerId: string) => {
    const egne = `buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`;
    return Promise.all([
      supabase
        .from("trades")
        .select(kolonner)
        .or(egne)
        .in("status", AKTIVE_STATUSSER)
        .order("created_at", { ascending: false })
        .overrideTypes<HandelRaekke[], { merge: false }>(),
      supabase
        .from("trades")
        .select(kolonner, { count: "exact" })
        .or(egne)
        .not("status", "in", aktiveStatusser)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(0, visAfsluttede - 1)
        .overrideTypes<HandelRaekke[], { merge: false }>(),
      // Handler med en igangværende sag - uanset om handlen er på den viste
      // side. "aktiv_sag" filtrerer kun rækkerne; "sager" er alle sager på handlen.
      supabase
        .from("trades")
        .select(`${kolonner}, aktiv_sag:sager!inner(id)`)
        .or(egne)
        .in("aktiv_sag.status", SAG_AKTIV)
        .order("created_at", { ascending: false })
        .overrideTypes<HandelRaekke[], { merge: false }>(),
    ]);
  };

  // Handlerne hentes SAMTIDIG med valideringen af brugeren: id'et fra
  // sessionens JWT (tjekket lokalt) bruges til opslaget, og intet vises, før
  // getUser har bekræftet præcis den bruger (bekraeftetBruger).
  const sessionId = await sessionBrugerId();
  const [user, tidligt, tilbud] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : hentBruger(),
    sessionId ? hentHandler(sessionId) : null,
    hentMineAktiveTilbud(),
  ]);

  if (!user) {
    redirect("/login?redirect=/mine-handler");
  }

  const [aktiveSvar, afsluttedeSvar, sagSvar] = tidligt ?? (await hentHandler(user.id));

  // Vises af error.tsx - en tom liste ville fejlagtigt sige "ingen handler".
  if (aktiveSvar.error || afsluttedeSvar.error) {
    throw new Error("Mine handler kunne ikke hentes");
  }
  if (sagSvar.error) console.error("Mine handler: sager kunne ikke hentes:", sagSvar.error.message);

  const aktive = aktiveSvar.data ?? [];
  const afsluttede = afsluttedeSvar.data ?? [];
  const antalAfsluttede = afsluttedeSvar.count ?? afsluttede.length;
  const handler = [...aktive, ...afsluttede];
  // Handler med en sag i gang, også hvis handlen ellers er afsluttet.
  const medSag = (sagSvar.data ?? []).filter(harAktivSag);
  const grupper = new Map<GruppeId, HandelRaekke[]>();
  const sete = new Set<string>();
  for (const h of [...aktive, ...medSag]) {
    if (sete.has(h.id)) continue;
    sete.add(h.id);
    const g = gruppeFor(h, user.id);
    grupper.set(g, [...(grupper.get(g) ?? []), h]);
  }
  const antalAktive = sete.size;

  return (
    <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-[26px] leading-tight sm:text-[32px]">Mine handler</h1>
        <p className="mt-2 text-[15px] text-tekst-daempet">
          Handler hvor du er køber eller sælger.
        </p>

        {tilbud.length > 0 && (
          <section className="mt-8">
            <h2 className="text-[20px] leading-tight lg:text-[22px]">Tilbud til dig</h2>
            <div className="mt-3 space-y-2">
              {tilbud.map((t) => (
                <Link
                  key={t.id}
                  href={`/andenchance/${t.id}`}
                  className="flex flex-col gap-3 rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst transition-shadow hover:shadow-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{t.titel}</span>
                    <span className="block text-sm">
                      Du kan købe varen for dit bud · <Nedtaelling til={t.udloeber} />
                    </span>
                  </span>
                  <span className="btn btn-primaer shrink-0">Se tilbud</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {handler.length === 0 ? (
          <TomTilstand
            className="mt-8"
            ikon="handler"
            titel="Du har ingen handler endnu"
            tekst="Når du vinder eller sælger en auktion, kan du følge handlen her."
            knap={{ href: "/auktioner", tekst: "Find auktioner" }}
          />
        ) : (
          <>
            <section aria-labelledby="aktive-titel" className="mt-8">
              <h2 id="aktive-titel" className="text-[20px] leading-tight lg:text-[22px]">
                Aktive handler ({antalAktive})
              </h2>
              {antalAktive === 0 ? (
                <p className="mt-3 rounded-[14px] border border-kant bg-white p-6 text-center text-sm text-tekst-svag">
                  Ingen aktive handler
                </p>
              ) : (
                GRUPPER.filter((g) => grupper.has(g.id)).map((g) => {
                  const liste = grupper.get(g.id)!;
                  return (
                    <section key={g.id} aria-labelledby={`gruppe-${g.id}`} className="mt-5 first-of-type:mt-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <h3 id={`gruppe-${g.id}`} className="font-sans text-[16px] font-semibold text-tekst">
                          {g.titel} <span className="font-normal text-tekst-svag">({liste.length})</span>
                        </h3>
                        <p className="text-[13px] text-tekst-svag">{g.tekst}</p>
                      </div>
                      <div className="mt-2 space-y-2">
                        {liste.map((h) => (
                          <HandelKort key={h.id} handel={h} brugerId={user.id} />
                        ))}
                      </div>
                    </section>
                  );
                })
              )}
            </section>

            {afsluttede.length > 0 && (
              <section className="mt-8">
                <h2 className="text-[20px] leading-tight lg:text-[22px]">
                  Afsluttede handler ({antalAfsluttede})
                </h2>
                <div className="mt-3 space-y-2">
                  {afsluttede.map((h) => (
                    <HandelKort key={h.id} handel={h} brugerId={user.id} />
                  ))}
                </div>
                {afsluttede.length < antalAfsluttede && (
                  <div className="mt-4 flex flex-col items-center gap-2">
                    <p className="text-sm text-tekst-svag">
                      Viser {afsluttede.length} af {antalAfsluttede}
                    </p>
                    <Link
                      href={`/mine-handler?vis=${visAfsluttede + AFSLUTTEDE_PR_SIDE}`}
                      scroll={false}
                      className="btn btn-sekundaer w-full sm:w-auto"
                    >
                      Vis flere handler
                    </Link>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
