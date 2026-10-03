import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import HandelStatusBadge, { HANDEL_STATUS } from "@/components/HandelStatusBadge";
import HandelChat, { type Besked } from "@/components/HandelChat";
import {
  SendPakkeForm,
  MarkerModtagetKnap,
  GodkendPakkeKnap,
} from "@/components/HandelHandlinger";
import { hentBetalingsstatus } from "@/app/actions/betaling";
import BetalingSektion from "@/components/betaling/BetalingSektion";
import Nedtaelling from "@/components/betaling/Nedtaelling";
import { hentAndenchanceStatus } from "@/app/actions/andenchance";
import { erAnnulleretUbetalt } from "@/app/actions/andenchanceBruger";
import SaelgerUbetaltBoks from "@/components/andenchance/SaelgerUbetaltBoks";
import { hentSagForHandel, hentSagMuligheder } from "@/app/actions/sager";
import SagVisning from "@/components/sager/SagVisning";
import OpretSagForm from "@/components/sager/OpretSagForm";
import { sagTid } from "@/components/sager/visning";
import { hentMinSagSamtale } from "@/app/actions/staffChat";

// En sag kan tidligst oprettes, når pakken er sendt, og vises også efter
// afgørelsen (handlen kan da være leveret eller annulleret).
const SAG_STATUSSER_HANDEL = ["pakke_sendt", "modtaget", "leveret", "afsluttet", "annulleret"];

export const dynamic = "force-dynamic";

type HandelRaekke = {
  id: string;
  auction_id: string;
  seller_id: string;
  buyer_id: string;
  amount: number | string;
  status: string;
  tracking_number: string | null;
  received_at: string | null;
  created_at: string;
};

export default async function HandelDetaljePage({
  params,
  searchParams,
}: {
  params: Promise<{ trade_id: string }>;
  searchParams: Promise<{ betaling?: string }>;
}) {
  const { trade_id } = await params;
  const { betaling: betalingParam } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?redirect=/mine-handler/${trade_id}`);
  }

  // Vender køberen tilbage fra Stripe, spejles betalingen FØR handlen hentes.
  // hentBetalingsstatus spørger Stripe og opdaterer handlens status, så
  // statusmærket og trinlinjen nedenfor viser den nye status med det samme.
  // (Funktionen tjekker selv, at brugeren er køber eller sælger.)
  const returBetaling =
    betalingParam === "retur" ? await hentBetalingsstatus(trade_id) : null;

  // Medlemskab tjekkes eksplicit. RLS er ikke nok: policyen tillader også
  // staff, og uden dette filter kunne en medarbejder åbne en hvilken som
  // helst handel og læse den private chat mellem køber og sælger.
  // Handlen ses i admin-panelet, ikke her.
  const { data: handel } = await supabase
    .from("trades")
    .select("id, auction_id, seller_id, buyer_id, amount, status, tracking_number, received_at, created_at")
    .eq("id", trade_id)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle<HandelRaekke>();

  if (!handel) notFound();

  const modpartId =
    handel.buyer_id === user.id ? handel.seller_id : handel.buyer_id;

  const [{ data: auktion }, { data: modpart }, { data: beskeder }] =
    await Promise.all([
      supabase.from("auctions").select("titel, billeder, startpris").eq("id", handel.auction_id).maybeSingle(),
      supabase.from("users").select("navn").eq("id", modpartId).maybeSingle(),
      // Sikker uden medlemskabsfilter, fordi notFound() ovenfor allerede har
      // afvist alle andre end køber og sælger. Flyttes denne query op over
      // det tjek, lækker den chatten til staff.
      supabase
        .from("messages")
        .select("id, sender_id, content, created_at, fra_bidhamr")
        .eq("trade_id", trade_id)
        .order("created_at", { ascending: true })
        .overrideTypes<Besked[], { merge: false }>(),
    ]);

  const erSaelger = handel.seller_id === user.id;
  const erKoeber = handel.buyer_id === user.id;
  const aktivtTrin = HANDEL_STATUS.findIndex((s) => s.vaerdi === handel.status);
  const billede = (auktion?.billeder as string[] | null)?.[0] ?? null;

  // Betalingen hentes kun, når den er relevant: mens der ventes på den, og
  // når køberen lige er vendt tilbage fra Stripe.
  const betaling =
    returBetaling ??
    (handel.status === "afventer_betaling" ? await hentBetalingsstatus(handel.id) : null);
  const betalingsstatus = betaling && "ok" in betaling ? betaling : null;

  // Vinderen betalte ikke: sælgeren vælger næste skridt, køberen får besked.
  const annulleret = handel.status === "annulleret";
  const [andenchance, koeberUbetalt] = await Promise.all([
    annulleret && erSaelger ? hentAndenchanceStatus(handel.id) : Promise.resolve(null),
    annulleret && erKoeber ? erAnnulleretUbetalt(handel.id) : Promise.resolve(null),
  ]);

  // Sag fra køberen: vises for både køber og sælger. Køberen kan oprette en,
  // hvis der ingen er (mulighederne afgøres på serveren).
  const sagRes = SAG_STATUSSER_HANDEL.includes(handel.status)
    ? await hentSagForHandel(handel.id)
    : null;
  const sag = sagRes && "sag" in sagRes ? sagRes.sag : null;
  const sagFejl = sagRes && "fejl" in sagRes ? sagRes.fejl : null;
  const sagAktiv = sag?.status === "aaben" || sag?.status === "afventer_retur";
  const [mulighederRes, samtaleRes] = await Promise.all([
    erKoeber && !sag && !sagFejl && (handel.status === "pakke_sendt" || handel.status === "modtaget")
      ? hentSagMuligheder(handel.id)
      : Promise.resolve(null),
    // Seneste besked fra BidHamr om sagen (vises i sagsboksen).
    sag ? hentMinSagSamtale(sag.id) : Promise.resolve(null),
  ]);
  const sagSamtale = samtaleRes && "samtale" in samtaleRes ? samtaleRes.samtale : null;
  const muligheder = mulighederRes && !("fejl" in mulighederRes) ? mulighederRes : null;

  return (
    <main className="flex-1 bg-white px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/mine-handler"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-800"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Tilbage til mine handler
        </Link>

        {/* Sagen står øverst, så køber og sælger straks kan se, hvor den er. */}
        {sagFejl && (
          <div className="rounded-xl border border-fejl-kant bg-fejl-bg p-6 text-sm text-fejl-tekst">
            Sagen kunne ikke hentes lige nu. Genindlæs siden om lidt.
          </div>
        )}
        {sag && <SagVisning sag={sag} brugerId={user.id} samtale={sagSamtale} />}

        {/* Overblik */}
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100">
              {billede ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={billede} alt="" className="h-full w-full object-cover" />
              ) : (
                <svg className="h-6 w-6 text-neutral-400" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.5h16.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold text-neutral-900">
                {auktion?.titel ?? "Slettet auktion"}
              </h1>
              <p className="mt-0.5 text-sm text-neutral-500">
                {erKoeber ? "Du er køber" : "Du er sælger"} ·{" "}
                {Number(handel.amount).toLocaleString("da-DK")} kr
              </p>
            </div>
            <HandelStatusBadge status={handel.status} />
          </div>

          {/* Statustidslinje */}
          <ol className="mt-6 flex flex-wrap gap-2">
            {HANDEL_STATUS.map((trin, i) => {
              const naaet = i <= aktivtTrin;
              return (
                <li
                  key={trin.vaerdi}
                  className={`flex-1 rounded-lg border px-3 py-2 text-center text-xs font-medium ${
                    naaet
                      ? "border-brand bg-orange-lys text-brand"
                      : "border-neutral-200 text-neutral-400"
                  }`}
                >
                  {trin.label}
                </li>
              );
            })}
          </ol>

          {handel.tracking_number && (
            <p className="mt-4 rounded-lg bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
              Sporingsnummer:{" "}
              <span className="font-semibold">{handel.tracking_number}</span>
            </p>
          )}
        </div>

        {/* Betaling */}
        {betaling && "fejl" in betaling && handel.status === "afventer_betaling" && (
          <div className="rounded-xl border border-[#F3C4C4] bg-[#FDECEC] p-6 text-sm text-[#A32020]">
            Betalingen kunne ikke hentes lige nu. {betaling.fejl}
          </div>
        )}

        {betalingsstatus && betalingsstatus.status === "betalt" && betalingParam === "retur" && (
          <div className="rounded-xl border border-[#B9D8CC] bg-groen-lys p-6">
            <p className="font-semibold text-groen-mork">Tak – din betaling er gennemført</p>
            <p className="mt-1 text-sm text-groen-mork">
              Sælgeren får besked og sender varen. Pengene frigives først, når du har godkendt den.
            </p>
          </div>
        )}

        {betalingsstatus && betalingsstatus.status === "behandles" && erKoeber && (
          <div className="rounded-xl border border-[#C9DCEB] bg-[#EDF3F8] p-6 text-sm text-[#1F4E79]">
            <p className="font-semibold">Din betaling behandles</p>
            <p className="mt-1">Det tager normalt kun et øjeblik. Genindlæs siden om lidt.</p>
          </div>
        )}

        {erKoeber && handel.status === "afventer_betaling" && betalingsstatus?.status === "afventer" && (
          <section className="rounded-xl border border-kant bg-white p-6">
            <h2 className="font-serif text-xl font-semibold text-tekst">Betal for din vare</h2>
            {betalingsstatus.fristOverskredet ? (
              <p className="mt-2 text-sm text-[#A32020]">
                Fristen for at betale er overskredet. Kontakt os, hvis du mener, det er en fejl.
              </p>
            ) : (
              <>
                <p className="mt-1 mb-5 text-sm text-tekst-daempet">
                  Betal senest{" "}
                  {new Date(betalingsstatus.betalSenest).toLocaleString("da-DK", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}{" "}
                  · <span className="font-semibold text-[#8A4210]"><Nedtaelling til={betalingsstatus.betalSenest} /></span>
                </p>
                {/* Kun når en automatisk betaling med gemt kort faktisk er
                    forsøgt og fejlet - ikke efter et afvist manuelt kort. */}
                {betalingsstatus.autobetalingResultat?.startsWith("fejlet_") ? (
                  <p className="mb-4 rounded-xl border border-[#F5D9B0] bg-[#FEF3E2] px-4 py-3 text-sm text-[#8A4210]">
                    Den automatiske betaling gik ikke igennem. Betal herunder.
                  </p>
                ) : betalingsstatus.sidsteFejl ? (
                  <p className="mb-4 rounded-xl border border-[#F5D9B0] bg-[#FEF3E2] px-4 py-3 text-sm text-[#8A4210]">
                    Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.
                  </p>
                ) : null}
                <BetalingSektion status={betalingsstatus} />
              </>
            )}
          </section>
        )}

        {erSaelger && handel.status === "afventer_betaling" && (
          <div className="rounded-xl border border-[#F5D9B0] bg-[#FEF3E2] p-6 text-sm text-[#8A4210]">
            <p className="font-semibold">Afventer købers betaling</p>
            {betalingsstatus ? (
              <p className="mt-1">
                Køberen skal betale senest{" "}
                {new Date(betalingsstatus.betalSenest).toLocaleString("da-DK", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                (<Nedtaelling til={betalingsstatus.betalSenest} />). Send ikke varen, før
                betalingen er modtaget.
              </p>
            ) : (
              <p className="mt-1">Køberen har 24 timer til at betale. Send ikke varen før.</p>
            )}
          </div>
        )}

        {andenchance && "fejl" in andenchance && (
          <div className="rounded-xl border border-[#F3C4C4] bg-[#FDECEC] p-6 text-sm text-[#A32020]">
            Mulighederne for varen kunne ikke hentes lige nu. {andenchance.fejl}
          </div>
        )}

        {andenchance && "ok" in andenchance && andenchance.ubetalt && (
          <SaelgerUbetaltBoks
            tradeId={handel.id}
            auktionId={handel.auction_id}
            status={andenchance}
            standardStartpris={Math.round(Number(auktion?.startpris ?? 0))}
          />
        )}

        {koeberUbetalt && (
          <div className="rounded-xl border border-[#F3C4C4] bg-[#FDECEC] p-6 text-sm text-[#A32020]">
            <p className="font-semibold">Handlen er annulleret</p>
            {koeberUbetalt === "admin_annulleret" ? (
              <p className="mt-1">Handlen er annulleret af BidHamr.</p>
            ) : (
              <>
                <p className="mt-1">Du betalte ikke inden fristen, så handlen er annulleret.</p>
                <p className="mt-1">En medarbejder ser på sagen, og du kan få en advarsel.</p>
              </>
            )}
          </div>
        )}

        {/* Handlinger */}
        {erSaelger && handel.status === "betaling_modtaget" && (
          <div className="rounded-xl border border-neutral-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-neutral-900">Send pakken</h2>
            <p className="mt-1 mb-4 text-sm text-neutral-500">
              Indtast sporingsnummeret, når du har sendt varen. Køberen får besked.
            </p>
            <SendPakkeForm tradeId={handel.id} />
          </div>
        )}

        {/* TRIN 1: kvittering for pakken. Ingen penge flyttes her. */}
        {erKoeber && handel.status === "pakke_sendt" && (
          <div className="rounded-xl border border-neutral-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-neutral-900">
              Har du modtaget pakken?
            </h2>
            <p className="mt-1 mb-4 text-sm text-neutral-500">
              Kvittér når pakken er kommet frem. Du skal godkende varen
              bagefter — først da får sælgeren pengene.
            </p>
            <MarkerModtagetKnap tradeId={handel.id} />
          </div>
        )}

        {/* TRIN 2: godkendelse udbetaler til sælgeren. */}
        {erKoeber && handel.status === "modtaget" && !sagAktiv && (
          <div className="rounded-xl border border-succes-kant bg-groen-lys p-6">
            <h2 className="text-sm font-semibold text-neutral-900">
              Tjek varen
            </h2>
            <p className="mt-1 mb-4 text-sm text-neutral-700">
              Kontrollér at varen svarer til beskrivelsen og ikke er
              beskadiget. Når du godkender, frigives beløbet til sælgeren.
            </p>
            <GodkendPakkeKnap tradeId={handel.id} />
          </div>
        )}

        {erSaelger && handel.status === "modtaget" && !sagAktiv && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6">
            <p className="font-semibold text-indigo-900">
              Køberen har modtaget pakken
            </p>
            <p className="mt-1 text-sm text-indigo-900">
              Køberen har modtaget pakken og tjekker varen. Du får pengene, når
              køberen godkender.
            </p>
          </div>
        )}

        {(handel.status === "leveret" || handel.status === "afsluttet") && (
          <div className="rounded-xl border border-green-300 bg-green-50 p-6">
            <p className="font-semibold text-green-700">Handlen er gennemført</p>
            <p className="mt-1 text-sm text-green-700">
              Varen er bekræftet modtaget.
            </p>
          </div>
        )}

        {/* Køberen kan oprette en sag */}
        {muligheder && !muligheder.harSag && (muligheder.typer.length > 0 || muligheder.kraeverBeskyttelse.length > 0) && (
          <OpretSagForm tradeId={handel.id} koeberId={user.id} muligheder={muligheder} />
        )}
        {muligheder &&
          muligheder.typer.length === 0 &&
          // Typerne er tomme, men datoen er sat: fristen for "bortkommet" er
          // ikke nået endnu (ellers ville typen være mulig).
          muligheder.bortkommetFraKl && (
            <p className="rounded-xl border border-kant bg-neutral-50 px-4 py-3 text-sm text-tekst-daempet">
              Er pakken ikke kommet frem? Du kan melde det fra {sagTid(muligheder.bortkommetFraKl)}
              {muligheder.fristKl && <> til {sagTid(muligheder.fristKl)}</>}.
            </p>
          )}

        <HandelChat
          tradeId={handel.id}
          brugerId={user.id}
          modpartNavn={modpart?.navn ?? "modparten"}
          startBeskeder={beskeder ?? []}
        />
      </div>
    </main>
  );
}
