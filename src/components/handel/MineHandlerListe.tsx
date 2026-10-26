// Listen over brugerens handler (køber og sælger). Vises under fanen
// "Mine handler" på egen profil (/profil/<id>?fane=handler). /mine-handler
// sender videre dertil, så links i mails og notifikationer stadig virker.
// Server-komponent: handlerne hentes kun, når fanen er åben.
import Image from "next/image";
import Link from "next/link";
import Ikon from "@/components/Ikon";
import TomTilstand from "@/components/TomTilstand";
import { kanOptimeres } from "@/lib/billedUrl";
import { createClient } from "@/lib/supabase/server";
import HandelStatusBadge, { AKTIVE_STATUSSER } from "@/components/HandelStatusBadge";
import { hentMineAktiveTilbud } from "@/app/actions/andenchanceBruger";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import { sagLink, type SagStatus } from "@/lib/sager";
import ReklamationMaerke from "@/components/reklamation/ReklamationMaerke";
import { hentMineEkstraFragtRegninger, type MinEkstraFragt } from "@/app/actions/ekstraFragt";
import EkstraFragtMaerke from "@/components/ekstraFragt/EkstraFragtMaerke";
import EkstraFragtBjaelke from "@/components/ekstraFragt/EkstraFragtBjaelke";
import { ekstraFragtHref, erAabenEkstraFragt } from "@/lib/ekstraFragt/visning";

// Åbne regninger for ekstra fragt (for lille pakke): handel-id -> regning.
type AabneEkstraFragt = Map<string, MinEkstraFragt>;

// Reklamationer i gang hos fragtfirmaet (BidHamr reklamerer for sælgeren): handel-id -> status.
type AabneReklamationer = Map<string, "afventer_bidhamr" | "anmeldt" | "godkendt">;

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
  | "ekstra_fragt"
  | "erstatning"
  | "betale"
  | "sende"
  | "afhentning"
  | "godkende"
  | "sager"
  | "venter_saelger"
  | "venter_koeber"
  | "paa_vej";

const GRUPPER: { id: GruppeId; titel: string; tekst: string }[] = [
  { id: "ekstra_fragt", titel: "Betal ekstra fragt", tekst: "Fragtfirmaet målte pakken større end den størrelse, du valgte." },
  { id: "betale", titel: "Du skal betale", tekst: "Betal inden fristen, så handlen ikke annulleres." },
  { id: "sende", titel: "Du skal sende", tekst: "Køberen har betalt. Send pakken inden fristen." },
  { id: "afhentning", titel: "Skal afhentes", tekst: "Varen er betalt. Aftal afhentningen i handlen." },
  { id: "godkende", titel: "Du skal godkende varen", tekst: "Tjek varen. Sælgeren får pengene, når du godkender." },
  { id: "sager", titel: "Sager i gang", tekst: "BidHamr ser på sagen. Følg med og svar i sagen." },
  // BidHamr reklamerer for sælgeren - intet at gøre, kun status.
  { id: "erstatning", titel: "Reklamation hos fragtfirmaet", tekst: "Varen blev skadet under fragten. Vi reklamerer for dig – du skal ikke gøre noget." },
  { id: "venter_saelger", titel: "Venter på sælgeren", tekst: "Du har betalt. Sælgeren sender pakken." },
  { id: "venter_koeber", titel: "Venter på køberen", tekst: "Køberen skal betale eller godkende varen." },
  { id: "paa_vej", titel: "På vej", tekst: "Pakken er sendt." },
];

function gruppeFor(h: HandelRaekke, brugerId: string, reklamationer: AabneReklamationer, ekstraFragt: AabneEkstraFragt): GruppeId {
  if (h.seller_id === brugerId && ekstraFragt.get(h.id)?.status === "afventer_betaling") return "ekstra_fragt";
  if (h.seller_id === brugerId && reklamationer.has(h.id)) return "erstatning";
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
  reklamation = null,
  ekstraFragt = null,
}: {
  handel: HandelRaekke;
  brugerId: string;
  reklamation?: "afventer_bidhamr" | "anmeldt" | "godkendt" | null;
  ekstraFragt?: MinEkstraFragt | null;
}) {
  const skalBetaleEkstra = ekstraFragt?.status === "afventer_betaling";
  const erKoeber = handel.buyer_id === brugerId;
  const billede = handel.auctions?.billeder?.[0] ?? null;
  const sag = nyesteSag(handel);
  const sagAktiv = !!sag && SAG_AKTIV.includes(sag.status);

  return (
    <Link
      href={
        ekstraFragt
          ? ekstraFragtHref(handel.id, { betal: skalBetaleEkstra })
          : reklamation
            ? `/mine-handler/${handel.id}#reklamation`
            : sagAktiv
              ? sagLink(handel.id)
              : `/mine-handler/${handel.id}`
      }
      className="flex gap-3 rounded-none border border-kant bg-white p-4 shadow-kort transition-[box-shadow,border-color] duration-200 ease-out hover:border-kant-staerk hover:shadow-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:gap-4"
    >
      <div className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-groen-lys">
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
          <Ikon navn="billede" className="h-6 w-6 text-groen/50" strøg={1.5} />
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
              className={`inline-block rounded-none border px-2.5 py-0.5 text-xs font-semibold ${SAG_MAERKE[sag.status].stil}`}
            >
              {SAG_MAERKE[sag.status].tekst}
            </span>
          )}
          {reklamation && <ReklamationMaerke status={reklamation} />}
          {ekstraFragt && (
            <EkstraFragtMaerke status={ekstraFragt.status} beloebOere={Number(ekstraFragt.beloeb_oere)} spaerrer={ekstraFragt.spaerrer} />
          )}
          {/* Hele kortet er linket til handelssiden (med chatten); dette er
              en synlig markering. Et <Link> her ville være et link i et link. */}
          <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-groen">
            {skalBetaleEkstra
              ? "Betal ekstra fragt"
              : reklamation
                ? "Se reklamation"
                : sagAktiv
                  ? "Åbn sag"
                  : "Åbn handel"}
            <Ikon navn="hoejre" className="h-4 w-4" />
          </span>
        </div>
      </div>
    </Link>
  );
}

// Afsluttede handler vises 20 ad gangen ("Vis flere" lægger 20 til via
// ?vis=). Aktive handler er altid få og vises alle.
export const AFSLUTTEDE_PR_SIDE = 20;
const MAKS_VIS = 1000;

export function visAfsluttedeFra(vis: string | string[] | undefined): number {
  const ønsket = Number(Array.isArray(vis) ? vis[0] : vis);
  return Number.isInteger(ønsket)
    ? Math.min(Math.max(ønsket, AFSLUTTEDE_PR_SIDE), MAKS_VIS)
    : AFSLUTTEDE_PR_SIDE;
}

// brugerId skal være den indloggede bruger, bekræftet af kalderen (getUser).
// visFlereBasis: linket til næste side uden tallet, fx
// "/profil/<id>?fane=handler&vis=" (tallet sættes bagpå).
export default async function MineHandlerListe({
  brugerId,
  visAfsluttede,
  visFlereBasis,
}: {
  brugerId: string;
  visAfsluttede: number;
  visFlereBasis: string;
}) {
  const supabase = await createClient();

  // or-filteret er det, der begrænser til egne handler. RLS alene ville ikke
  // gøre det: policyen tillader også staff at se alt.
  const kolonner =
    "id, status, amount, created_at, buyer_id, seller_id, afhentning, auctions(titel, billeder), sager(id, status, oprettet_kl)";
  const aktiveStatusser = `(${AKTIVE_STATUSSER.join(",")})`;
  const egne = `buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`;
  const [aktiveSvar, afsluttedeSvar, sagSvar, tilbud, reklamationSvar, ekstraFragtSvar] = await Promise.all([
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
    hentMineAktiveTilbud(),
    // Sælgerens reklamationer hos fragtfirmaet (få - én pr. sag om
    // transportskade). Fejl (fx før migrationen) = ingen.
    supabase.rpc("mine_fragt_reklamationer").then((r) => (r.error ? [] : ((r.data ?? []) as { trade_id: string; status: string }[]))),
    // Sælgerens regninger for ekstra fragt (få). null ved fejl = ingen.
    hentMineEkstraFragtRegninger(),
  ]);
  const ekstraFragt: AabneEkstraFragt = new Map();
  for (const r of ekstraFragtSvar ?? []) {
    if (!erAabenEkstraFragt(r.status)) continue;
    const kendt = ekstraFragt.get(r.trade_id);
    // Den, der skal betales, vinder over en, der behandles/er under indsigelse.
    if (!kendt || (kendt.status !== "afventer_betaling" && r.status === "afventer_betaling")) ekstraFragt.set(r.trade_id, r);
  }
  const reklamationer: AabneReklamationer = new Map();
  for (const r of reklamationSvar) {
    if ((r.status === "afventer_bidhamr" || r.status === "anmeldt" || r.status === "godkendt") && !reklamationer.has(r.trade_id)) {
      reklamationer.set(r.trade_id, r.status);
    }
  }
  // Handler med en åben reklamation, der ikke allerede er med (de er typisk
  // afsluttede og kan ligge længere nede end den viste side).
  const kendte = new Set([...(aktiveSvar.data ?? []), ...(sagSvar.data ?? [])].map((h) => h.id));
  const manglerIds = [...new Set([...ekstraFragt.keys(), ...reklamationer.keys()])].filter((id) => !kendte.has(id)).slice(0, 50);
  const reklamationHandler = manglerIds.length
    ? ((
        await supabase
          .from("trades")
          .select(kolonner)
          .or(egne)
          .in("id", manglerIds)
          .overrideTypes<HandelRaekke[], { merge: false }>()
      ).data ?? [])
    : [];

  // En tom liste ville fejlagtigt sige "ingen handler" - vis en fejl i stedet.
  if (aktiveSvar.error || afsluttedeSvar.error) {
    console.error("Mine handler kunne ikke hentes:", (aktiveSvar.error ?? afsluttedeSvar.error)?.message);
    return (
      <div role="alert" className="rounded-none border border-fejl-kant bg-fejl-bg p-5 text-fejl-tekst">
        <p className="font-semibold">Dine handler kunne ikke hentes lige nu.</p>
        <p className="mt-1 text-sm">Prøv at genindlæse siden om lidt.</p>
      </div>
    );
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
  for (const h of [
    ...reklamationHandler,
    ...aktive,
    ...medSag,
    ...afsluttede.filter((a) => reklamationer.has(a.id) || ekstraFragt.has(a.id)),
  ]) {
    if (sete.has(h.id)) continue;
    sete.add(h.id);
    const g = gruppeFor(h, brugerId, reklamationer, ekstraFragt);
    grupper.set(g, [...(grupper.get(g) ?? []), h]);
  }
  const antalAktive = sete.size;

  return (
    <div>
      <EkstraFragtBjaelke regninger={ekstraFragtSvar} className="mb-6" />
      {tilbud.length > 0 && (
        <section className="mb-8" aria-labelledby="tilbud-titel">
          <h2 id="tilbud-titel" className="text-[20px] leading-tight lg:text-[22px]">Tilbud til dig</h2>
          <div className="mt-3 space-y-2">
            {tilbud.map((t) => (
              <Link
                key={t.id}
                href={`/andenchance/${t.id}`}
                className="flex flex-col gap-3 rounded-none border border-advarsel-kant bg-advarsel-bg p-4 text-advarsel-tekst transition-shadow hover:shadow-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen sm:flex-row sm:items-center sm:justify-between"
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
          ikon="handler"
          titel="Du har ingen handler endnu"
          tekst="Når du vinder eller sælger en auktion, kan du følge handlen her."
          knap={{ href: "/auktioner", tekst: "Find auktioner" }}
        />
      ) : (
        <>
          <section aria-labelledby="aktive-titel">
            <h2 id="aktive-titel" className="text-[20px] leading-tight lg:text-[22px]">
              Aktive handler ({antalAktive})
            </h2>
            {antalAktive === 0 ? (
              <p className="mt-3 rounded-none border border-kant bg-white p-6 text-center text-sm text-tekst-svag">
                Ingen aktive handler lige nu.
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
                        <HandelKort key={h.id} handel={h} brugerId={brugerId} reklamation={h.seller_id === brugerId ? (reklamationer.get(h.id) ?? null) : null} ekstraFragt={h.seller_id === brugerId ? (ekstraFragt.get(h.id) ?? null) : null} />
                      ))}
                    </div>
                  </section>
                );
              })
            )}
          </section>

          {afsluttede.length > 0 && (
            <section className="mt-8" aria-labelledby="afsluttede-titel">
              <h2 id="afsluttede-titel" className="text-[20px] leading-tight lg:text-[22px]">
                Afsluttede handler ({antalAfsluttede})
              </h2>
              <div className="mt-3 space-y-2">
                {afsluttede.map((h) => (
                  <HandelKort key={h.id} handel={h} brugerId={brugerId} reklamation={h.seller_id === brugerId ? (reklamationer.get(h.id) ?? null) : null} ekstraFragt={h.seller_id === brugerId ? (ekstraFragt.get(h.id) ?? null) : null} />
                ))}
              </div>
              {afsluttede.length < antalAfsluttede && (
                <div className="mt-4 flex flex-col items-center gap-2">
                  <p className="text-sm text-tekst-svag">
                    Viser {afsluttede.length} af {antalAfsluttede}
                  </p>
                  <Link
                    href={`${visFlereBasis}${visAfsluttede + AFSLUTTEDE_PR_SIDE}`}
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
  );
}

// Skelet til fanen, mens handlerne hentes (samme geometri som HandelKort).
export function MineHandlerSkelet() {
  return (
    <div aria-busy="true">
      <span className="sr-only">Indlæser dine handler…</span>
      <div className="h-6 w-48 animate-pulse rounded bg-skelet" />
      <ul className="mt-4 space-y-2">
        {Array.from({ length: 4 }, (_, i) => (
          <li key={i} className="flex gap-3 rounded-none border border-kant bg-white p-4 sm:gap-4">
            <div className="h-16 w-16 shrink-0 animate-pulse rounded-lg bg-skelet" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-3/5 animate-pulse rounded bg-skelet" />
              <div className="h-3 w-2/5 animate-pulse rounded bg-skelet" />
              <div className="h-5 w-28 animate-pulse rounded-none bg-skelet" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
