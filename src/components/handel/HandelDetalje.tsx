import { MINE_HANDLER_HREF } from "@/lib/profilFaner";
import Image from "next/image";
import Link from "next/link";
import { kanOptimeres } from "@/lib/billedUrl";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { bekraeftetBruger, hentBruger, sessionBrugerId } from "@/lib/supabase/bruger";
import HandelStatusBadge, { HANDEL_STATUS } from "@/components/HandelStatusBadge";
import HandelChat, { type Besked } from "@/components/HandelChat";
import {
  SendPakkeForm,
  MarkerModtagetKnap,
  GodkendPakkeKnap,
} from "@/components/HandelHandlinger";
import { hentBetalingsstatus, hentMinUdbetalingsstatus } from "@/app/actions/betaling";
import UdbetalingStatusBoks from "@/components/betaling/UdbetalingStatusBoks";
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
import FakturaBoks from "@/components/faktura/FakturaBoks";
import { sendSenest, sendSenestTekst } from "@/lib/afsendelsesfrist";
import { hentAfsendelsesfristAnnullering } from "@/lib/betaling/afsendelsesfrist";
import { hentAfhentningsfristAnnullering } from "@/lib/betaling/afhentningsfrist";
import { hentIkkeAfhentet } from "@/lib/betaling/ikkeAfhentet";
import { kroner } from "@/lib/kroner";
import { afhentningTilbagebetalKl, afhentningsfristTekst } from "@/lib/afhentningsfrist";
import ForlaengAfhentningsfrist from "@/components/ForlaengAfhentningsfrist";
import FragtlabelBoks from "@/components/fragt/FragtlabelBoks";
import { hentForsendelserAction } from "@/app/actions/fragt";
import type { ForsendelseVisning } from "@/lib/fragt/handlinger";
import SporingTidslinje from "@/components/fragt/SporingTidslinje";
import Ikon from "@/components/Ikon";
import { PAKKESTOERRELSE_NAVN, erPakkestoerrelse, transportoerNavn } from "@/lib/fragt/types";
import { fragtLabelsAktiv, fragtReturlabelAktiv, labelGraense } from "@/lib/fragt";
import ReturlabelBoks, { type Afsender as ReturAfsender, type ReturfragtVisning } from "@/components/fragt/ReturlabelBoks";
import { hentKontoType } from "@/lib/supabase/bruger";
import { foerLancering } from "@/lib/lancering";
import FirmaKontaktBoks from "@/components/erhverv/FirmaKontaktBoks";
import KlageBoks from "@/components/erhverv/klager/KlageBoks";
import { FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";

// Handelssiden - fælles for /mine-handler/[trade_id] (private) og
// /firma/salg/[trade_id] (firma-dashboardet, sted="firma"), så handlens
// trin, "Send pakke" (inkl. pakkebilleder og fragtlabel), betaling, sager og
// kvittering ikke kopieres.
//
// Ingen beskeder med erhvervssælgere (Filip, 8. okt. 2026): er sælgeren en
// firmakonto (eller auktionen en erhvervsauktion), vises der ingen chat -
// databasen afviser også beskederne (BHE05, 20261010040000_firma_dashboard.sql).
// Køberen ser i stedet firmaets e-mail, telefon og et link til firmaprofilen.
// Beskeder fra BidHamr (fra_bidhamr) vises stadig, men kan ikke besvares her.

// En sag kan tidligst oprettes, når pakken er sendt, og vises også efter
// afgørelsen (handlen kan da være leveret eller annulleret).
const SAG_STATUSSER_HANDEL = ["pakke_sendt", "modtaget", "leveret", "afsluttet", "annulleret"];

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

export default async function HandelDetalje({
  trade_id,
  betalingParam,
  sted = "mine-handler",
  visHandel = false,
  returfragtRetur = false,
}: {
  trade_id: string;
  betalingParam?: string;
  // ?vis=handel: køberen vil se handlen (fx chatten) i stedet for checkout.
  visHandel?: boolean;
  // "firma": vist i firma-dashboardet (tilbage-link og stier dertil).
  sted?: "mine-handler" | "firma";
  // Køberen er lige vendt tilbage fra betalingen af returfragten.
  returfragtRetur?: boolean;
}) {
  const erFirmaSted = sted === "firma";
  // Firma-dashboardets layout har selv <main>.
  const Ramme = erFirmaSted ? "div" : "main";
  const grundsti = erFirmaSted ? "/firma/salg" : "/mine-handler";
  const supabase = await createClient();

  // Medlemskab tjekkes eksplicit. RLS er ikke nok: policyen tillader også
  // staff, og uden dette filter kunne en medarbejder åbne en hvilken som
  // helst handel og læse den private chat mellem køber og sælger.
  // Handlen ses i admin-panelet, ikke her.
  const hentHandel = (brugerId: string) =>
    supabase
      .from("trades")
      .select("id, auction_id, seller_id, buyer_id, amount, status, tracking_number, received_at, created_at, afhentning")
      .eq("id", trade_id)
      .or(`buyer_id.eq.${brugerId},seller_id.eq.${brugerId}`)
      .maybeSingle<HandelRaekke>();

  // Vender køberen tilbage fra Stripe, spejles betalingen FØR handlen hentes.
  // hentBetalingsstatus spørger Stripe og opdaterer handlens status, så
  // statusmærket og trinlinjen nedenfor viser den nye status med det samme.
  // (Funktionen tjekker selv, at brugeren er køber eller sælger.)
  // Ellers hentes handlen SAMTIDIG med valideringen af brugeren: id'et fra
  // sessionens JWT (tjekket lokalt) bruges til opslaget, og intet vises, før
  // getUser har bekræftet præcis den bruger (bekraeftetBruger).
  const sessionId = betalingParam === "retur" ? null : await sessionBrugerId();
  const [user, tidligHandel] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : hentBruger(),
    sessionId ? hentHandel(sessionId) : null,
  ]);
  if (!user) {
    redirect(`/login?redirect=${grundsti}/${encodeURIComponent(trade_id)}`);
  }

  const returBetaling =
    betalingParam === "retur" ? await hentBetalingsstatus(trade_id) : null;

  const { data: handel } = tidligHandel ?? (await hentHandel(user.id));

  if (!handel) notFound();

  const modpartId =
    handel.buyer_id === user.id ? handel.seller_id : handel.buyer_id;

  const erSaelger = handel.seller_id === user.id;
  const erKoeber = handel.buyer_id === user.id;

  // Ingen automatisk betaling (Filip, 9. okt. 2026): vinderen betaler altid i
  // checkout. Links i mails og notifikationer peger hertil, så køberen sendes
  // videre, så længe handlen ikke er betalt - også efter en mislykket
  // betaling hos Stripe (?betaling=retur). ?vis=handel viser handlen (chat).
  // Undtagelse: lige tilbage fra Stripe, og betalingen er betalt/behandles,
  // men handlen er endnu ikke opdateret - så vises status her (checkout ville
  // sende tilbage hertil og give en løkke).
  const returUnderBehandling =
    returBetaling !== null &&
    "ok" in returBetaling &&
    (returBetaling.status === "betalt" || returBetaling.status === "behandles");
  if (!erFirmaSted && erKoeber && handel.status === "afventer_betaling" && !visHandel && !returUnderBehandling) {
    redirect(`/mine-handler/${encodeURIComponent(handel.id)}/betal`);
  }

  const afhentning = handel.afhentning === true;
  const annulleret = handel.status === "annulleret";
  // Afsendelsesfrist (kun forsendelse): pakken skal markeres sendt senest 5
  // dage efter betalingen, ellers annulleres handlen, og køberen refunderes
  // fuldt. betalt_kl kan læses af køber og sælger (kolonne-grant).
  const venterPaaAfsendelse = !afhentning && handel.status === "betaling_modtaget";
  // Fragtlabel i BidHamr (kun bag flaget FRAGT_LABELS_AKTIV=true). Uden flaget
  // er "Send pakke" præcis som før.
  const visFragtlabel = fragtLabelsAktiv() && erSaelger && venterPaaAfsendelse;
  // Forsendelse, leveringsvalg og sporing (køber og sælger), mens pakken er på vej.
  const visFragt = !afhentning && ["betaling_modtaget", "pakke_sendt", "modtaget"].includes(handel.status);

  // Alt, der kun afhænger af handlen, hentes samtidig (før: ét opslag ad
  // gangen, op til 12 runder til databasen efter hinanden).
  //
  // Sag fra køberen: vises for både køber og sælger. Køberen kan oprette en,
  // hvis der ingen er (mulighederne afgøres på serveren). Seneste besked fra
  // BidHamr om sagen hentes, så snart sagen er kendt.
  const sagLoefte = SAG_STATUSSER_HANDEL.includes(handel.status)
    ? hentSagForHandel(handel.id)
    : Promise.resolve(null);
  const sagDetaljerLoefte = sagLoefte.then(async (sagRes) => {
    const sag = sagRes && "sag" in sagRes ? sagRes.sag : null;
    const sagFejl = sagRes && "fejl" in sagRes ? sagRes.fejl : null;
    return Promise.all([
      erKoeber && !sag && !sagFejl && (handel.status === "pakke_sendt" || handel.status === "modtaget")
        ? hentSagMuligheder(handel.id)
        : Promise.resolve(null),
      sag ? hentMinSagSamtale(sag.id) : Promise.resolve(null),
    ]);
  });

  const [
    { data: auktion },
    { data: modpart },
    { data: beskeder },
    betaling,
    andenchance,
    koeberUbetalt,
    sagRes,
    [mulighederRes, samtaleRes],
    afhentningInfo,
    afhentningsadresseSvar,
    forsendelserSvar,
    fragtInfo,
    { data: betaltRaekke },
    afsendelsesAnnullering,
    afhentningsAnnullering,
    kvittering,
    saelgerKontoType,
    udbetalingSvar,
    ikkeAfhentet,
  ] = await Promise.all([
    supabase.from("auctions").select("titel, billeder, startpris, erhverv, pakkestoerrelse, vaegt_gram").eq("id", handel.auction_id).maybeSingle(),
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
    // Betalingen hentes kun, når den er relevant: mens der ventes på den, og
    // når køberen lige er vendt tilbage fra Stripe.
    returBetaling ??
      (handel.status === "afventer_betaling" ? hentBetalingsstatus(handel.id) : Promise.resolve(null)),
    // Vinderen betalte ikke: sælgeren vælger næste skridt, køberen får besked.
    annulleret && erSaelger ? hentAndenchanceStatus(handel.id) : Promise.resolve(null),
    annulleret && erKoeber ? erAnnulleretUbetalt(handel.id) : Promise.resolve(null),
    sagLoefte,
    sagDetaljerLoefte,
    afhentning && handel.status === "betaling_modtaget"
      ? hentAfhentningInfo(handel.id)
      : Promise.resolve(null),
    // Sælgerens adresse og telefon vises kun for køberen, når en
    // afhentningsvare er betalt og endnu ikke hentet (handel_afhentningsadresse).
    afhentning && erKoeber && handel.status === "betaling_modtaget"
      ? supabase.rpc("handel_afhentningsadresse", { p_trade: handel.id }).then((r) => r.data)
      : Promise.resolve(null),
    visFragt ? hentForsendelserAction(handel.id) : Promise.resolve(null),
    // Køberens leveringsvalg (parterne kan læse pakkeshoppen, ikke adressen) og
    // - til "Send pakke" - sælgerens sidst brugte afsenderadresse (RLS: egen række).
    visFragt
      ? Promise.all([
          supabase
            .from("handel_levering")
            .select("maade, fragtfirma, transportoer, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by")
            .eq("trade_id", handel.id)
            .maybeSingle<{
              maade: string;
              fragtfirma: string | null;
              transportoer: string | null;
              pakkeshop_navn: string | null;
              pakkeshop_adresse: string | null;
              pakkeshop_postnummer: string | null;
              pakkeshop_by: string | null;
            }>(),
          visFragtlabel
            ? supabase
                .from("leveringsforslag")
                .select("afsender_navn, afsender_adresse, afsender_postnummer, afsender_by, afsender_telefon")
                .eq("user_id", user.id)
                .maybeSingle<{
                  afsender_navn: string | null;
                  afsender_adresse: string | null;
                  afsender_postnummer: string | null;
                  afsender_by: string | null;
                  afsender_telefon: string | null;
                }>()
            : Promise.resolve({ data: null }),
          visFragtlabel
            ? supabase.from("users").select("navn").eq("id", user.id).maybeSingle<{ navn: string | null }>()
            : Promise.resolve({ data: null }),
        ]).then(([lev, afs, mig]) => ({ levering: lev.data, afsender: afs.data, mitNavn: mig.data?.navn ?? null }))
      : Promise.resolve(null),
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
    // Kvittering (køber, når betalingen er modtaget) / afregning (sælger, når
    // pengene er frigivet). null, indtil den findes.
    handel.status === "afventer_betaling" ? Promise.resolve(null) : hentMinKvittering(handel.id),
    // users.konto_type kan læses af alle (20261010030000_erhverv.sql).
    hentKontoType(handel.seller_id),
    // Sælgerens udbetaling til banken (betalingsmodel destination, trin 3) -
    // null i den gamle model.
    erSaelger && (handel.status === "leveret" || handel.status === "afsluttet")
      ? hentMinUdbetalingsstatus(handel.id)
      : Promise.resolve(null),
    // Pakken blev ikke afhentet og er sendt retur til sælgeren.
    annulleret && !afhentning ? hentIkkeAfhentet(handel.id, user.id) : Promise.resolve(null),
  ]);
  const udbetaling = udbetalingSvar && "ok" in udbetalingSvar ? udbetalingSvar.visning : null;

  // Fragt: den aktive udgående forsendelse, antal labels og visningstekster.
  const forsendelser = forsendelserSvar && "ok" in forsendelserSvar ? forsendelserSvar.forsendelser : [];
  const udgaaende = forsendelser.filter((f) => f.type === "udgaaende");
  const forsendelse = udgaaende.find((f) => f.status !== "annulleret") ?? null;
  const lev = fragtInfo?.levering ?? null;
  const levFirma = transportoerNavn(lev?.transportoer);
  const leveringTekst = !lev
    ? null
    : lev.maade === "doer"
      ? `Køberens adresse (levering hjem${levFirma ? ` med ${levFirma}` : ""})`
      : `Pakkeshop${levFirma ? ` hos ${levFirma}` : ""}: ${[
          lev.pakkeshop_navn,
          lev.pakkeshop_adresse,
          [lev.pakkeshop_postnummer, lev.pakkeshop_by].filter(Boolean).join(" "),
        ]
          .filter(Boolean)
          .join(", ")}`;
  const pakkestoerrelse: unknown = auktion?.pakkestoerrelse;
  const vaegtGram = Number(auktion?.vaegt_gram ?? 0);
  const pakkeTekst = erPakkestoerrelse(pakkestoerrelse)
    ? `${PAKKESTOERRELSE_NAVN[pakkestoerrelse]}${
        vaegtGram > 0 ? ` · ${(vaegtGram / 1000).toLocaleString("da-DK", { maximumFractionDigits: 2 })} kg` : ""
      }`
    : null;
  const afs = fragtInfo?.afsender ?? null;
  const afsTelefon = afs?.afsender_telefon ?? "";
  const afsenderStart = {
    navn: afs?.afsender_navn ?? fragtInfo?.mitNavn ?? "",
    adresse: afs?.afsender_adresse ?? "",
    postnummer: afs?.afsender_postnummer ?? "",
    by: afs?.afsender_by ?? "",
    telefon: /^\+45\d{8}$/.test(afsTelefon) ? afsTelefon.slice(3) : afsTelefon,
  };

  // Erhvervshandel: ingen chat mellem køber og firma.
  const erhvervHandel = auktion?.erhverv === true || saelgerKontoType === "erhverv";
  const lukket = foerLancering();

  // Afhentningshandler (kun afhentning, fragt 0 kr) springer pakketrinnene
  // over: køberen viser en kode, og sælgeren indtaster den.
  const tidslinje = afhentning
    ? HANDEL_STATUS.filter((s) => s.vaerdi !== "pakke_sendt" && s.vaerdi !== "modtaget").map((s) =>
        s.vaerdi === "leveret" ? { ...s, label: "Hentet og afregnet" } : s,
      )
    : HANDEL_STATUS;
  const aktivtTrin = tidslinje.findIndex((s) => s.vaerdi === handel.status);
  const billede = (auktion?.billeder as string[] | null)?.[0] ?? null;

  const betalingsstatus = betaling && "ok" in betaling ? betaling : null;

  const sag = sagRes && "sag" in sagRes ? sagRes.sag : null;
  const sagFejl = sagRes && "fejl" in sagRes ? sagRes.fejl : null;
  const sagAktiv = sag?.status === "aaben" || sag?.status === "afventer_retur";
  const sagSamtale = samtaleRes && "samtale" in samtaleRes ? samtaleRes.samtale : null;
  const muligheder = mulighederRes && !("fejl" in mulighederRes) ? mulighederRes : null;

  // Retur i sagen (køberen sender varen retur nu) - kun bag flaget
  // FRAGT_RETURLABEL_AKTIV. Køberen betaler selv returfragten, før returkoden
  // laves (src/lib/betaling/returfragt.ts); sælgeren ser, at returen er på vej.
  const returSag = fragtReturlabelAktiv() && !!sag && sag.status === "afventer_retur" && sag.returKraeves;
  let returForsendelse: ForsendelseVisning | null = null;
  let returfragt: ReturfragtVisning | null = null;
  let returAfsender: ReturAfsender | null = null;
  if (returSag) {
    const [alle, rf] = await Promise.all([
      visFragt ? Promise.resolve(forsendelser) : hentForsendelserAction(handel.id).then((r) => ("ok" in r ? r.forsendelser : [])),
      erKoeber ? supabase.rpc("min_returfragt", { p_trade: handel.id }).then((r) => r.data) : Promise.resolve(null),
    ]);
    returForsendelse = alle.find((f) => f.type === "retur" && f.status !== "annulleret" && f.status !== "fejlet") ?? null;
    const m = rf as {
      rolle?: string;
      id?: string | null;
      sag?: { kode?: string };
      status?: ReturfragtVisning["status"];
      beloeb_oere?: number | null;
      label_fejl?: string | null;
      label_annulleret?: boolean;
      refusion_aarsag?: string | null;
      afsender?: Record<string, string | null> | null;
    } | null;
    if (erKoeber && m?.rolle === "koeber") {
      returfragt = {
        status: m.status ?? null,
        beloebOere: m.beloeb_oere ?? null,
        labelFejl: m.label_fejl ?? null,
        labelAnnulleret: m.label_annulleret === true,
        refusionAarsag: m.refusion_aarsag ?? null,
        kanSende: m.sag?.kode === "ok",
      };
      // Køberens gemte adresse (fra min_returfragt) - ellers profilens navn.
      const { data: mig } = await supabase.from("users").select("navn").eq("id", user.id).maybeSingle<{ navn: string | null }>();
      const g = m.afsender ?? null;
      const tlf = g?.telefon ?? "";
      returAfsender = {
        navn: g?.navn ?? mig?.navn ?? "",
        adresse: g?.adresse ?? "",
        postnummer: g?.postnummer ?? "",
        by: g?.by ?? "",
        telefon: /^\+45\d{8}$/.test(tlf) ? tlf.slice(3) : tlf,
      };
    }
  }
  const visReturlabel = erKoeber && !!returfragt && !!returAfsender;
  // Returen sendes med samme fragtfirma som pakken ud.
  const returTransportoer =
    returForsendelse?.transportoer ??
    forsendelser.find((f) => f.type === "udgaaende" && f.status !== "annulleret" && f.status !== "fejlet")?.transportoer ??
    lev?.transportoer ??
    null;
  const visReturPaaVej =
    erSaelger && returSag && !!returForsendelse && !["opretter", "annulleres", "fejlet"].includes(returForsendelse.status);

  const adresseSvar = afhentningsadresseSvar as { kode?: string; adresse?: string | null; telefon?: string | null } | null;
  const afhentningsadresse: { adresse: string | null; telefon: string | null } | null =
    adresseSvar?.kode === "ok" ? { adresse: adresseSvar.adresse ?? null, telefon: adresseSvar.telefon ?? null } : null;

  const afsendSenest = venterPaaAfsendelse ? sendSenest(betaltRaekke?.betalt_kl) : null;

  return (
    <Ramme className={erFirmaSted ? "" : "flex-1 px-4 pt-4 pb-8 sm:px-6 lg:px-8 lg:pt-6 lg:pb-10"}>
      <div className="mx-auto max-w-3xl space-y-5 sm:space-y-6">
        {erFirmaSted ? (
          <Link
            href="/firma/salg"
            className="-mb-1 inline-flex min-h-12 items-center rounded-md text-[17px] font-semibold text-groen underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
          >
            ← {FIRMA_DASHBOARD.tilbage(FIRMA_DASHBOARD.salg.titel)}
          </Link>
        ) : (
        <Link
          href={MINE_HANDLER_HREF}
          className="-mb-1 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-tekst-daempet hover:text-groen focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Tilbage til mine handler
        </Link>
        )}

        {/* Sagen står øverst, så køber og sælger straks kan se, hvor den er. */}
        {sagFejl && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
            Sagen kunne ikke hentes lige nu. Genindlæs siden om lidt.
          </div>
        )}
        {sag && <SagVisning sag={sag} brugerId={user.id} samtale={sagSamtale} />}
        {visReturlabel && returfragt && returAfsender && (
          <ReturlabelBoks
            tradeId={handel.id}
            retur={returForsendelse}
            info={returfragt}
            afsender={returAfsender}
            venterPaaBekraeftelse={returfragtRetur}
            transportoer={returTransportoer}
          />
        )}
        {visReturPaaVej && returForsendelse && (
          <section aria-labelledby="retur-paa-vej" className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 id="retur-paa-vej" className="text-[17px] leading-snug lg:text-lg">
              Returen er på vej
            </h2>
            <p className="mt-1 text-sm text-tekst-svag">
              {returTransportoer === "gls"
                ? "Køberen har betalt returfragten og fået en returkode. GLS bringer pakken til din adresse."
                : "Køberen har betalt returfragten og fået en returkode. Pakken sendes til en pakkeshop tæt på dig – du får besked, når den er klar til afhentning."}
            </p>
            <div className="mt-4">
              <SporingTidslinje f={returForsendelse} />
            </div>
          </section>
        )}

        {/* Overblik */}
        <div className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
          <div className="flex items-start gap-3 sm:items-center sm:gap-4">
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
              <h1 className="text-[22px] leading-tight break-words hyphens-none sm:text-[26px]">
                {auktion?.titel ?? "Slettet auktion"}
              </h1>
              <p className="mt-0.5 text-sm text-tekst-svag">
                {erKoeber ? "Du er køber" : "Du er sælger"} ·{" "}
                {Number(handel.amount).toLocaleString("da-DK")} kr
              </p>
              {/* Mobil: statusmærket under titlen, så titlen har hele bredden. */}
              <div className="mt-2 sm:hidden">
                <HandelStatusBadge status={handel.status} />
              </div>
            </div>
            <div className="hidden shrink-0 sm:block">
              <HandelStatusBadge status={handel.status} />
            </div>
          </div>

          {/* Statustidslinje */}
          {/* Fremskridt: lodret liste på mobil, vandrette trin fra sm. Ikke
              knapper - kun visning, så intet ser klikbart ud. */}
          <ol className="mt-5 flex flex-col gap-2 sm:flex-row sm:gap-2" aria-label="Handlens forløb">
            {tidslinje.map((trin, i) => {
              const naaet = i <= aktivtTrin;
              const aktiv = i === aktivtTrin;
              return (
                <li
                  key={trin.vaerdi}
                  aria-current={aktiv ? "step" : undefined}
                  className="flex items-center gap-2.5 sm:min-w-0 sm:flex-1 sm:flex-col sm:items-stretch sm:gap-2"
                >
                  <span aria-hidden="true" className={`hidden h-1.5 rounded-full sm:block ${naaet ? "bg-groen" : "bg-kant"}`} />
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                        naaet ? "bg-groen text-white" : "border border-kant-staerk bg-white text-tekst-svag"
                      }`}
                    >
                      {naaet && !aktiv ? <Ikon navn="flueben" className="h-3 w-3" strøg={2.5} /> : i + 1}
                    </span>
                    <span
                      className={`text-[13px] leading-snug ${
                        aktiv ? "font-semibold text-tekst" : naaet ? "font-medium text-groen-mork" : "text-tekst-svag"
                      }`}
                    >
                      {trin.label}
                      {naaet && !aktiv && <span className="sr-only"> (gennemført)</span>}
                    </span>
                  </span>
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
                ? erhvervHandel
                  ? "Sælgeren får besked. Kontakt firmaet for at aftale afhentningen - se kontaktoplysningerne herunder."
                  : "Sælgeren får besked. Aftal afhentningen med sælgeren i chatten herunder."
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
            {betalingsstatus.venterPaaSaelgerkonto ? (
              <p className="mt-2 rounded-xl border border-info-kant bg-info-bg px-4 py-3 text-sm text-info-tekst">
                Betalingen åbner, når sælgerens konto er godkendt hos vores betalingspartner Stripe. Du får
                besked, så snart du kan betale – derefter har du 48 timer. Bliver kontoen ikke godkendt
                inden for 7 dage, bliver handlen annulleret, og du bliver ikke trukket noget.
              </p>
            ) : betalingsstatus.fristOverskredet ? (
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
                {betalingsstatus.sidsteFejl ? (
                  <p className="mb-4 rounded-xl border border-advarsel-kant bg-advarsel-bg px-4 py-3 text-sm text-advarsel-tekst">
                    Betalingen gik ikke igennem. Prøv igen, eller vælg en anden betalingsmetode.
                  </p>
                ) : null}
                {/* Betalingen sker i checkout (levering + betaling). */}
                <Link href={`/mine-handler/${handel.id}/betal`} className="btn btn-primaer w-full sm:w-auto">
                  Gå til betaling
                </Link>
              </>
            )}
          </section>
        )}

        {erSaelger && handel.status === "afventer_betaling" && (
          <div className="rounded-[14px] border border-advarsel-kant bg-advarsel-bg p-5 sm:p-6 text-sm text-advarsel-tekst">
            <p className="font-semibold">Afventer købers betaling</p>
            {betalingsstatus?.venterPaaSaelgerkonto ? (
              <p className="mt-1">
                Køberen kan først betale, når din konto hos vores betalingspartner Stripe er godkendt.{" "}
                <Link href="/konto" className="font-semibold underline">Gør opsætningen færdig under Min konto</Link>.
                Er kontoen ikke godkendt senest 7 dage efter, at auktionen sluttede, bliver handlen
                annulleret. {afhentning ? "Udlevér" : "Send"} ikke varen, før køberen har betalt.
              </p>
            ) : betalingsstatus ? (
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
              !betalingsstatus.venterPaaSaelgerkonto &&
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
              {erhvervHandel
                ? "Kontakt firmaet for at aftale tid og sted for afhentningen. "
                : "Aftal tid og sted for afhentningen med sælgeren i chatten herunder. "}
              Når du henter varen, viser du sælgeren din afhentningskode.
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
              {erhvervHandel
                ? `${FIRMA_DASHBOARD.afhentning} `
                : "Aftal tid og sted for afhentningen med køberen i chatten herunder. "}
              Når køberen henter varen, viser han dig en kode på 6 cifre. Indtast koden her – så frigives pengene til
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
            {leveringTekst && (
              <p className="mt-3 rounded-lg bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
                Leveres til: <span className="font-medium text-tekst">{leveringTekst.replace(/^Køberens adresse/, "Din adresse")}</span>
              </p>
            )}
          </div>
        )}

        {/* Sporing for køberen, når pakken er på vej (sælgeren ser den i "Din fragtlabel"). */}
        {erKoeber && forsendelse && (handel.status === "pakke_sendt" || handel.status === "modtaget") && (
          <section aria-labelledby="sporing-titel" className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
            <h2 id="sporing-titel" className="text-[17px] leading-snug lg:text-lg">
              Følg pakken
            </h2>
            {leveringTekst && (
              <p className="mt-1 text-sm text-tekst-svag">
                {leveringTekst.replace(/^Køberens adresse/, "Din adresse")}
              </p>
            )}
            <div className="mt-4">
              <SporingTidslinje f={forsendelse} />
            </div>
          </section>
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

        {ikkeAfhentet && (
          <div className="rounded-[14px] border border-fejl-kant bg-fejl-bg p-5 sm:p-6 text-sm text-fejl-tekst">
            <p className="font-semibold">Pakken blev ikke hentet</p>
            {erKoeber ? (
              <>
                <p className="mt-1">
                  Pakken blev ikke hentet i tide og er sendt retur til sælgeren. Handlen er annulleret.
                </p>
                {ikkeAfhentet.refusionOere > 0 ? (
                  <>
                    <p className="mt-1">
                      Du får {kroner(ikkeAfhentet.refusionOere)} tilbage – købsbeløbet minus
                      købergebyret{ikkeAfhentet.beskyttelseOere > 0 ? ", BidHamr Beskyttelse" : ""} og
                      fragten begge veje (fragt {kroner(ikkeAfhentet.fragtOere)} og returfragt{" "}
                      {kroner(ikkeAfhentet.returfragtOere)}).
                    </p>
                    <p className="mt-1">
                      {ikkeAfhentet.refunderet
                        ? "Pengene er sendt tilbage til den betalingsmetode, du betalte med. Der kan gå nogle dage, før de står på din konto."
                        : "Tilbagebetalingen er sat i gang. Der kan gå nogle dage, før pengene står på din konto."}{" "}
                      Betalingen håndteres af vores betalingspartner Stripe.
                    </p>
                  </>
                ) : (
                  <p className="mt-1">
                    Købsbeløbet minus gebyrerne og fragten begge veje bliver 0 kr., så du får ikke noget
                    tilbage – og du skylder heller ikke noget. Har du spørgsmål, så skriv til
                    support@bidhamr.dk.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="mt-1">
                  Køberen hentede ikke pakken, så fragtfirmaet sender den retur til dig. Handlen er
                  annulleret, og du beholder varen.
                </p>
                <p className="mt-1">
                  Du betaler ikke for fragten – hverken ud eller retur – og der udbetales ikke penge for
                  handlen. Kommer pakken ikke frem til dig, så skriv til support@bidhamr.dk med
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
        {visFragtlabel && !(erFirmaSted && lukket) && (
          <FragtlabelBoks
            tradeId={handel.id}
            forsendelse={forsendelse}
            afsender={afsenderStart}
            pakke={pakkeTekst}
            levering={leveringTekst}
            brugteLabels={udgaaende.length}
            labelGraense={labelGraense(lev?.fragtfirma ?? forsendelse?.fragtfirma)}
            transportoer={lev?.transportoer ?? null}
          />
        )}

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
            {/* Firmaet kan ikke kalde server actions før lancering (gaten). */}
            {erFirmaSted && lukket ? (
              <p className="rounded-lg border border-info-kant bg-info-bg px-4 py-3 text-[17px] text-info-tekst">
                {FIRMA_DASHBOARD.salg.sendPakkeLukket}
              </p>
            ) : (
            <SendPakkeForm
              key={forsendelse?.sporingsnummer ?? "uden-label"}
              tradeId={handel.id}
              saelgerId={user.id}
              forslagTracking={forsendelse?.sporingsnummer ?? null}
            />
            )}
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

        {udbetaling && <UdbetalingStatusBoks v={udbetaling} />}
        {kvittering && <KvitteringBoks k={kvittering} />}
        {/* BidHamrs fakturaer på gebyrer, fragt og BidHamr Beskyttelse (src/lib/faktura). */}
        <FakturaBoks tradeId={handel.id} />

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

        {erhvervHandel ? (
          <>
            {erKoeber && <FirmaKontaktBoks saelgerId={handel.seller_id} />}
            {/* Klage over firmaet (reklamation) - databasen afgør, om den vises. */}
            {erKoeber && <KlageBoks tradeId={handel.id} koeberId={user.id} />}
            {erSaelger && (
              <p className="rounded-[14px] border border-kant bg-white p-5 text-[17px] text-tekst-daempet sm:p-6">
                {FIRMA_DASHBOARD.salg.ingenChat}
              </p>
            )}
            {/* Kun beskeder fra BidHamr - og uden svarfelt. */}
            {(beskeder ?? []).some((b) => b.fra_bidhamr) && (
              <HandelChat
                tradeId={handel.id}
                brugerId={user.id}
                modpartNavn={modpart?.navn ?? "modparten"}
                startBeskeder={(beskeder ?? []).filter((b) => b.fra_bidhamr)}
                kunFraBidhamr
              />
            )}
          </>
        ) : (
        <HandelChat
          tradeId={handel.id}
          brugerId={user.id}
          modpartNavn={modpart?.navn ?? "modparten"}
          startBeskeder={beskeder ?? []}
        />
        )}
      </div>
    </Ramme>
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
