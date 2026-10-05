import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { kanOptimeres } from "@/lib/billedUrl";
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
import ForlaengBetalingsfrist from "@/components/betaling/ForlaengBetalingsfrist";
import { hentAndenchanceStatus } from "@/app/actions/andenchance";
import { erAnnulleretUbetalt } from "@/app/actions/andenchanceBruger";
import SaelgerUbetaltBoks from "@/components/andenchance/SaelgerUbetaltBoks";
import { hentSagForHandel, hentSagMuligheder } from "@/app/actions/sager";
import SagVisning from "@/components/sager/SagVisning";
import OpretSagForm from "@/components/sager/OpretSagForm";
import { sagTid } from "@/components/sager/visning";
import { hentMinSagSamtale } from "@/app/actions/staffChat";
import { hentAfhentningInfo } from "@/app/actions/afhentning";
import { VisAfhentningskode, IndtastAfhentningskode } from "@/components/Afhentning";
import { hentMinKvittering } from "@/lib/betaling/kvittering";
import { KvitteringBoks } from "@/components/Kvittering";
import { sendSenest, sendSenestTekst } from "@/lib/afsendelsesfrist";
import { hentAfsendelsesfristAnnullering } from "@/lib/betaling/afsendelsesfrist";
import { hentAfhentningsfristAnnullering } from "@/lib/betaling/afhentningsfrist";
import { afhentningTilbagebetalKl, afhentningsfristTekst } from "@/lib/afhentningsfrist";
import ForlaengAfhentningsfrist from "@/components/ForlaengAfhentningsfrist";
import FragtlabelBoks from "@/components/fragt/FragtlabelBoks";
import { hentMinForsendelse } from "@/app/actions/fragt";
import { fragtLabelsAktiv } from "@/lib/fragt";

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
  afhentning: boolean;
};

export const metadata: Metadata = { title: "Handel", robots: { index: false, follow: false } };

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
    .select("id, auction_id, seller_id, buyer_id, amount, status, tracking_number, received_at, created_at, afhentning")
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
        .select("id, sender_id, content, created_at, fra_bidhamr, blokeret_grund")
        .eq("trade_id", trade_id)
        .order("created_at", { ascending: true })
        .overrideTypes<Besked[], { merge: false }>(),
    ]);

  const erSaelger = handel.seller_id === user.id;
  const erKoeber = handel.buyer_id === user.id;
  // Afhentningshandler (kun afhentning, fragt 0 kr) springer pakketrinnene
  // over: køberen viser en kode, og sælgeren indtaster den.
  const afhentning = handel.afhentning === true;
  const tidslinje = afhentning
    ? HANDEL_STATUS.filter((s) => s.vaerdi !== "pakke_sendt" && s.vaerdi !== "modtaget").map((s) =>
        s.vaerdi === "leveret" ? { ...s, label: "Hentet og afregnet" } : s,
      )
    : HANDEL_STATUS;
  const aktivtTrin = tidslinje.findIndex((s) => s.vaerdi === handel.status);
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

  const afhentningInfo =
    afhentning && handel.status === "betaling_modtaget"
      ? await hentAfhentningInfo(handel.id)
      : null;

  // Sælgerens adresse og telefon vises kun for køberen, når en
  // afhentningsvare er betalt og endnu ikke hentet (handel_afhentningsadresse).
  let afhentningsadresse: { adresse: string | null; telefon: string | null } | null = null;
  if (afhentning && erKoeber && handel.status === "betaling_modtaget") {
    const { data } = await supabase.rpc("handel_afhentningsadresse", { p_trade: handel.id });
    const d = data as { kode?: string; adresse?: string | null; telefon?: string | null } | null;
    if (d?.kode === "ok") afhentningsadresse = { adresse: d.adresse ?? null, telefon: d.telefon ?? null };
  }

  // Afsendelsesfrist (kun forsendelse): pakken skal markeres sendt senest 5
  // dage efter betalingen, ellers annulleres handlen, og køberen refunderes
  // fuldt. betalt_kl kan læses af køber og sælger (kolonne-grant).
  const venterPaaAfsendelse = !afhentning && handel.status === "betaling_modtaget";

  // Fragtlabel i BidHamr (kun bag flaget FRAGT_LABELS_AKTIV=true). Uden flaget
  // er "Send pakke" præcis som før.
  const visFragtlabel = fragtLabelsAktiv() && erSaelger && venterPaaAfsendelse;
  const forsendelse = visFragtlabel ? await hentMinForsendelse(handel.id) : null;
  const [{ data: betaltRaekke }, afsendelsesAnnullering, afhentningsAnnullering] = await Promise.all([
    venterPaaAfsendelse
      ? supabase
          .from("betalinger")
          .select("betalt_kl")
          .eq("trade_id", handel.id)
          .maybeSingle<{ betalt_kl: string | null }>()
      : Promise.resolve({ data: null }),
    annulleret ? hentAfsendelsesfristAnnullering(handel.id, user.id) : Promise.resolve(null),
    annulleret && afhentning
      ? hentAfhentningsfristAnnullering(handel.id, user.id)
      : Promise.resolve(null),
  ]);
  const afsendSenest = venterPaaAfsendelse ? sendSenest(betaltRaekke?.betalt_kl) : null;

  // Kvittering (køber, når betalingen er modtaget) / afregning (sælger, når
  // pengene er frigivet). null, indtil den findes.
  const kvittering =
    handel.status === "afventer_betaling" ? null : await hentMinKvittering(handel.id);

  return (
    <main className="flex-1 px-4 pt-4 pb-8 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10">
      <div className="mx-auto max-w-3xl space-y-5 sm:space-y-6">
        <Link
          href="/mine-handler"
          className="-mb-1 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-tekst-daempet hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Tilbage til mine handler
        </Link>

        {/* Sagen står øverst, så køber og sælger straks kan se, hvor den er. */}
        {sagFejl && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
            Sagen kunne ikke hentes lige nu. Genindlæs siden om lidt.
          </div>
        )}
        {sag && <SagVisning sag={sag} brugerId={user.id} samtale={sagSamtale} />}

        {/* Overblik */}
        <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
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
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.5h16.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H3.75a1.5 1.5 0 01-1.5-1.5V6a1.5 1.5 0 011.5-1.5z" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] leading-tight break-words sm:text-[26px]">
                {auktion?.titel ?? "Slettet auktion"}
              </h1>
              <p className="mt-0.5 text-sm text-tekst-svag">
                {erKoeber ? "Du er køber" : "Du er sælger"} ·{" "}
                {Number(handel.amount).toLocaleString("da-DK")} kr
              </p>
            </div>
            <HandelStatusBadge status={handel.status} />
          </div>

          {/* Statustidslinje */}
          <ol className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" aria-label="Handlens forløb">
            {tidslinje.map((trin, i) => {
              const naaet = i <= aktivtTrin;
              return (
                <li
                  key={trin.vaerdi}
                  aria-current={i === aktivtTrin ? "step" : undefined}
                  className={`flex min-h-9 flex-1 items-center justify-center rounded-lg border px-3 py-2 text-center text-xs font-medium ${
                    naaet
                      ? "border-groen bg-groen-lys text-groen-mork"
                      : "border-kant text-tekst-svag"
                  }`}
                >
                  {trin.label}
                </li>
              );
            })}
          </ol>

          {handel.tracking_number && (
            <p className="mt-4 rounded-lg bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
              Sporingsnummer:{" "}
              <span className="font-semibold">{handel.tracking_number}</span>
            </p>
          )}
        </div>

        {/* Betaling */}
        {betaling && "fejl" in betaling && handel.status === "afventer_betaling" && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
            Betalingen kunne ikke hentes lige nu. {betaling.fejl}
          </div>
        )}

        {betalingsstatus && betalingsstatus.status === "betalt" && betalingParam === "retur" && (
          <div className="rounded-[14px] border border-succes-kant bg-groen-lys p-5 sm:p-6">
            <p className="font-semibold text-groen-mork">Tak – din betaling er gennemført</p>
            <p className="mt-1 text-sm text-groen-mork">
              {afhentning
                ? "Sælgeren får besked. Aftal afhentningen med sælgeren i chatten herunder."
                : "Sælgeren får besked og sender varen. Sælgeren får først pengene, når du har godkendt den."}
            </p>
          </div>
        )}

        {betalingsstatus && betalingsstatus.status === "behandles" && erKoeber && (
          <div className="rounded-[14px] border border-info-kant bg-info-bg p-5 sm:p-6 text-sm text-info-tekst">
            <p className="font-semibold">Din betaling behandles</p>
            <p className="mt-1">Det tager normalt kun et øjeblik. Genindlæs siden om lidt.</p>
          </div>
        )}

        {erKoeber &&
          betalingsstatus?.erKoeber === true &&
          handel.status === "afventer_betaling" &&
          betalingsstatus.status === "afventer" && (
          <section className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[20px] leading-tight lg:text-[22px]">Betal for din vare</h2>
            {betalingsstatus.fristOverskredet ? (
              <p className="mt-2 text-sm text-fejl-tekst">
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
                  · <span className="font-semibold text-advarsel-tekst"><Nedtaelling til={betalingsstatus.betalSenest} /></span>
                </p>
                {/* Kun når en automatisk betaling med gemt kort faktisk er
                    forsøgt og fejlet - ikke efter et afvist manuelt kort. */}
                {betalingsstatus.autobetalingResultat?.startsWith("fejlet_") ? (
                  <p className="mb-4 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
                    Den automatiske betaling gik ikke igennem. Betal herunder.
                  </p>
                ) : betalingsstatus.sidsteFejl ? (
                  <p className="mb-4 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
                    Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.
                  </p>
                ) : null}
                <BetalingSektion status={betalingsstatus} />
              </>
            )}
          </section>
        )}

        {erSaelger && handel.status === "afventer_betaling" && (
          <div className="rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-5 sm:p-6 text-sm text-advarsel-tekst">
            <p className="font-semibold">Afventer købers betaling</p>
            {betalingsstatus ? (
              <p className="mt-1">
                Køberen skal betale senest{" "}
                {new Date(betalingsstatus.betalSenest).toLocaleString("da-DK", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                (<Nedtaelling til={betalingsstatus.betalSenest} />).{" "}
                {afhentning
                  ? "Udlevér ikke varen, før betalingen er modtaget."
                  : "Send ikke varen, før betalingen er modtaget."}
              </p>
            ) : (
              <p className="mt-1">
                Køberen har 48 timer til at betale. {afhentning ? "Udlevér" : "Send"} ikke varen før.
              </p>
            )}
            {betalingsstatus &&
              !betalingsstatus.fristOverskredet &&
              (betalingsstatus.status === "afventer" || betalingsstatus.status === "behandles") && (
                <ForlaengBetalingsfrist
                  key={betalingsstatus.betalSenest}
                  tradeId={handel.id}
                  betalSenest={betalingsstatus.betalSenest}
                  maksBetalSenest={betalingsstatus.maksBetalSenest}
                />
              )}
          </div>
        )}

        {andenchance && "fejl" in andenchance && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
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
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
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

        {/* Afhentning hos sælger: køberen bedømmer og viser koden, sælgeren
            indtaster den, og pengene frigives med det samme. */}
        {afhentning && erKoeber && handel.status === "betaling_modtaget" && (
          <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[17px] leading-snug lg:text-lg">Hent varen hos sælgeren</h2>
            <p className="mt-1 text-sm text-tekst-svag">
              Aftal tid og sted for afhentningen med sælgeren i chatten herunder. Når du henter
              varen, viser du sælgeren din afhentningskode.
            </p>
            {afhentningsadresse && (afhentningsadresse.adresse || afhentningsadresse.telefon) && (
              <dl className="mt-3 rounded-lg bg-groen-lys px-4 py-3 text-sm text-tekst">
                {afhentningsadresse.adresse && (
                  <div>
                    <dt className="font-medium text-groen-mork">Afhentningsadresse</dt>
                    <dd className="whitespace-pre-line">{afhentningsadresse.adresse}</dd>
                  </div>
                )}
                {afhentningsadresse.telefon && (
                  <div className={afhentningsadresse.adresse ? "mt-2" : ""}>
                    <dt className="font-medium text-groen-mork">Sælgerens telefon</dt>
                    <dd>{afhentningsadresse.telefon}</dd>
                  </div>
                )}
                <p className="mt-2 text-xs text-tekst-daempet">
                  Kun du kan se oplysningerne, og kun indtil varen er hentet.
                </p>
              </dl>
            )}
            {afhentningInfo?.frist && (
              <AfhentningsfristLinje
                frist={afhentningInfo.frist}
                maksFrist={afhentningInfo.maksFrist}
                udloebet={afhentningInfo.fristUdloebet}
                koeber
              />
            )}
            <p className="mt-2 mb-4 text-sm text-tekst-svag">
              Tjek varen, før du viser koden. Når sælgeren har indtastet koden, frigives pengene til
              sælgeren med det samme, og du kan ikke klage over handlen bagefter.
            </p>
            {afhentningInfo ? (
              <VisAfhentningskode tradeId={handel.id} kode={afhentningInfo.kode} />
            ) : (
              <p className="text-sm text-fejl-tekst">
                Afhentningskoden kunne ikke hentes lige nu. Genindlæs siden om lidt.
              </p>
            )}
          </div>
        )}

        {afhentning && erSaelger && handel.status === "betaling_modtaget" && (
          <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[17px] leading-snug lg:text-lg">Køberen henter varen hos dig</h2>
            <p className="mt-1 text-sm text-tekst-svag">
              Aftal tid og sted for afhentningen med køberen i chatten herunder. Når køberen henter
              varen, viser han dig en kode på 6 cifre. Indtast koden her – så frigives pengene til
              dig med det samme. Giv ikke varen fra dig, før du har indtastet den rigtige kode.
            </p>
            {afhentningInfo?.frist && (
              <AfhentningsfristLinje
                frist={afhentningInfo.frist}
                maksFrist={afhentningInfo.maksFrist}
                udloebet={afhentningInfo.fristUdloebet}
              />
            )}
            {afhentningInfo?.kanForlaenges && afhentningInfo.frist && afhentningInfo.maksFrist && (
              <ForlaengAfhentningsfrist
                key={afhentningInfo.frist}
                tradeId={handel.id}
                frist={afhentningInfo.frist}
                maksFrist={afhentningInfo.maksFrist}
              />
            )}
            {afhentningInfo && !afhentningInfo.vist && (
              <p className="mt-3 rounded-lg bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
                Køberen har ikke hentet sin kode frem endnu.
              </p>
            )}
            {afhentningInfo?.laast ? (
              <p className="mt-4 rounded-lg border border-fejl-kant bg-fejl-bg px-4 py-3 text-sm text-fejl-tekst">
                Koden er låst efter for mange forkerte forsøg. BidHamr kigger på handlen – kontakt
                support@bidhamr.dk.
              </p>
            ) : (
              <div className="mt-4">
                <IndtastAfhentningskode tradeId={handel.id} />
              </div>
            )}
          </div>
        )}

        {erKoeber && venterPaaAfsendelse && (
          <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[17px] leading-snug lg:text-lg">Venter på, at sælgeren sender varen</h2>
            <p className="mt-1 text-sm text-tekst-svag">
              {afsendSenest ? (
                <>
                  Sælgeren skal sende pakken senest{" "}
                  <span className="font-semibold text-tekst-daempet">{sendSenestTekst(afsendSenest)}</span>.{" "}
                </>
              ) : (
                <>Sælgeren skal sende pakken senest 5 dage efter din betaling. </>
              )}
              Sendes den ikke i tide, annulleres handlen, og du får hele beløbet tilbage.
            </p>
          </div>
        )}

        {afsendelsesAnnullering && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
            <p className="font-semibold">Handlen er annulleret</p>
            {erKoeber ? (
              <>
                <p className="mt-1">Sælgeren sendte ikke varen i tide. Du får hele beløbet tilbage.</p>
                <p className="mt-1">
                  {afsendelsesAnnullering.refunderet
                    ? "Pengene er sendt tilbage til den betalingsmetode, du betalte med. Der kan gå nogle dage, før de står på din konto."
                    : "Tilbagebetalingen er sat i gang. Der kan gå nogle dage, før pengene står på din konto."}{" "}
                  Betalingen håndteres af vores betalingspartner Stripe.
                </p>
              </>
            ) : (
              <>
                <p className="mt-1">
                  Pakken blev ikke markeret som sendt inden 5 dage efter betalingen, så handlen er
                  annulleret, og køberen får hele beløbet tilbage. Du skal ikke sende varen.
                </p>
                <p className="mt-1">
                  Har du allerede sendt den, så skriv straks til support@bidhamr.dk med
                  sporingsnummeret.
                </p>
              </>
            )}
          </div>
        )}

        {afhentningsAnnullering && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
            <p className="font-semibold">Handlen er annulleret</p>
            {erKoeber ? (
              <>
                <p className="mt-1">Varen blev ikke hentet, og du får alle pengene tilbage.</p>
                <p className="mt-1">
                  {afhentningsAnnullering.refunderet
                    ? "Pengene er sendt tilbage til den betalingsmetode, du betalte med. Der kan gå nogle dage, før de står på din konto."
                    : "Tilbagebetalingen er sat i gang. Der kan gå nogle dage, før pengene står på din konto."}{" "}
                  Betalingen håndteres af vores betalingspartner Stripe.
                </p>
              </>
            ) : (
              <>
                <p className="mt-1">Handlen er annulleret, fordi varen ikke blev hentet. Du beholder varen.</p>
                <p className="mt-1">
                  Har køberen alligevel hentet varen, så skriv straks til support@bidhamr.dk.
                </p>
              </>
            )}
          </div>
        )}

        {/* Handlinger */}
        {visFragtlabel && <FragtlabelBoks tradeId={handel.id} forsendelse={forsendelse} />}

        {erSaelger && !afhentning && handel.status === "betaling_modtaget" && (
          <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[17px] leading-snug lg:text-lg">Send pakken</h2>
            <p className="mt-1 mb-4 text-sm text-tekst-svag">
              Tag to billeder, mens du pakker, og indtast sporingsnummeret, når du har sendt
              varen. Køberen får besked.
            </p>
            {afsendSenest && (
              <p className="mb-4 rounded-lg border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
                Send pakken senest <span className="font-semibold">{sendSenestTekst(afsendSenest)}</span>{" "}
                (<Nedtaelling til={afsendSenest} />). Ellers annulleres handlen, og køberen får hele
                beløbet tilbage.
              </p>
            )}
            <SendPakkeForm
              key={forsendelse?.sporingsnummer ?? "uden-label"}
              tradeId={handel.id}
              saelgerId={user.id}
              forslagTracking={forsendelse?.sporingsnummer ?? null}
            />
          </div>
        )}

        {/* TRIN 1: kvittering for pakken. Ingen penge flyttes her. */}
        {erKoeber && !afhentning && handel.status === "pakke_sendt" && (
          <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 className="text-[17px] leading-snug lg:text-lg">
              Har du modtaget pakken?
            </h2>
            <p className="mt-1 mb-4 text-sm text-tekst-svag">
              Kvittér når pakken er kommet frem. Du skal godkende varen
              bagefter — først da får sælgeren pengene.
            </p>
            <MarkerModtagetKnap tradeId={handel.id} />
          </div>
        )}

        {/* TRIN 2: godkendelse udbetaler til sælgeren. */}
        {erKoeber && !afhentning && handel.status === "modtaget" && !sagAktiv && (
          <div className="rounded-[14px] border border-succes-kant bg-groen-lys p-5 sm:p-6">
            <h2 className="text-[17px] leading-snug lg:text-lg">
              Tjek varen
            </h2>
            <p className="mt-1 mb-4 text-sm text-tekst-daempet">
              Kontrollér at varen svarer til beskrivelsen og ikke er
              beskadiget. Når du godkender, frigives beløbet til sælgeren.
            </p>
            <GodkendPakkeKnap tradeId={handel.id} />
          </div>
        )}

        {erSaelger && !afhentning && handel.status === "modtaget" && !sagAktiv && (
          <div className="rounded-[14px] border border-info-kant bg-info-bg p-5 sm:p-6">
            <p className="font-semibold text-info-tekst">
              Køberen har modtaget pakken
            </p>
            <p className="mt-1 text-sm text-info-tekst">
              Køberen har modtaget pakken og tjekker varen. Du får pengene, når
              køberen godkender.
            </p>
          </div>
        )}

        {(handel.status === "leveret" || handel.status === "afsluttet") && (
          <div className="rounded-[14px] border border-succes-kant bg-succes-bg p-5 sm:p-6">
            <p className="font-semibold text-succes-tekst">Handlen er gennemført</p>
            <p className="mt-1 text-sm text-succes-tekst">
              {afhentning
                ? "Varen er hentet, og pengene er frigivet til sælgeren."
                : "Varen er bekræftet modtaget."}
            </p>
          </div>
        )}

        {kvittering && <KvitteringBoks k={kvittering} />}

        {/* Køberen kan oprette en sag */}
        {muligheder && !muligheder.harSag && (muligheder.typer.length > 0 || muligheder.kraeverBeskyttelse.length > 0) && (
          <OpretSagForm tradeId={handel.id} koeberId={user.id} muligheder={muligheder} />
        )}
        {muligheder &&
          muligheder.typer.length === 0 &&
          // Typerne er tomme, men datoen er sat: fristen for "bortkommet" er
          // ikke nået endnu (ellers ville typen være mulig).
          muligheder.bortkommetFraKl && (
            <p className="rounded-xl border border-kant bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
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

// Afhentningsfristen på handelssiden (køber og sælger).
function AfhentningsfristLinje({
  frist,
  maksFrist,
  udloebet,
  koeber = false,
}: {
  frist: string;
  maksFrist: string | null;
  udloebet: boolean;
  koeber?: boolean;
}) {
  if (udloebet) {
    // Datoen for den automatiske tilbagebetaling (samme regel som
    // afhentning_tilbagebetal_kl i databasen). Uden maksFrist vises den ikke.
    const tilbage = maksFrist ? afhentningsfristTekst(afhentningTilbagebetalKl(frist, maksFrist)) : null;
    return (
      <p className="mt-3 rounded-lg border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
        Fristen for at hente varen udløb {afhentningsfristTekst(frist)}. BidHamr kigger på handlen.
        {tilbage &&
          (koeber ? (
            <>
              {" "}Er varen ikke hentet senest <span className="font-semibold">{tilbage}</span>, får du
              automatisk alle pengene tilbage.
            </>
          ) : (
            <>
              {" "}Er varen ikke hentet senest <span className="font-semibold">{tilbage}</span>, annulleres
              handlen automatisk, og køberen får pengene tilbage. Giv ikke varen fra dig efter denne dato.
            </>
          ))}
      </p>
    );
  }
  return (
    <p className="mt-3 rounded-lg border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
      {koeber ? "Hent varen senest" : "Køberen skal hente varen senest"}{" "}
      <span className="font-semibold">{afhentningsfristTekst(frist)}</span>{" "}
      (<Nedtaelling til={frist} />).
    </p>
  );
}
