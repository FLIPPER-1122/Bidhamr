// Server-only: Stripe-kald for den nye betalingsmodel ("betal når du vinder").
// Må aldrig importeres i klientkode - bruger STRIPE_SECRET_KEY og service-role.
//
// Pengestrømmen ("separate charges and transfers", manuelle udbetalinger):
//   1. Køberen betaler en PaymentIntent på BidHamrs platformskonto
//      (ingen transfer_data / on_behalf_of). transfer_group = handel_<id>.
//   2. Webhooken spejler payment_intent.succeeded til tabellen betalinger.
//   3. Ved frigivelse oprettes en Transfer til sælgerens Connect Express-konto
//      på udbetaling_oere (bud minus 5% sælgergebyr; fragten bliver på
//      platformskontoen og går til fragtfirmaet) med
//      source_transaction = chargen.
//
// Alle kald, der flytter penge, har en idempotency key. Databasen spejler
// kun - Stripe er sandheden om penge. Alle beløb i øre.

import Stripe from "stripe";
import { getStripe, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { totalOere } from "@/lib/betaling/beregn";
import { sendIndsigelseTilSaelger } from "@/lib/betaling/indsigelseBeskeder";

// Offentlig https-adresse til Stripes business_profile.url. Lokalt
// (http/localhost) bruges produktionsdomaenet, da Stripe afviser andet.
function offentligSideUrl(): string {
  const url = sideUrl("/");
  try {
    const u = new URL(url);
    const lokal = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(u.hostname);
    if (u.protocol === "https:" && !lokal) return url;
  } catch {
    // falder igennem
  }
  return "https://bidhamr.dk";
}
import {
  koeberAfhentningMail,
  saelgerBetaltAfhentningMail,
  saelgerBetaltMail,
  saelgerOpretUdbetalingskontoMail,
  sideUrl,
} from "@/lib/mails/handel";
import { send } from "@/lib/notifikationer/send";
import {
  koeberKvittering,
  sendKoeberKvittering,
  sendRefusionForsinket,
  sendSaelgerAfregning,
} from "@/lib/betaling/handelsbeskeder";

export type BetalingRaekke = {
  id: string;
  trade_id: string;
  auction_id: string;
  buyer_id: string;
  seller_id: string;
  bud_oere: number;
  koebergebyr_oere: number;
  fragt_oere: number;
  beskyttelse: boolean;
  beskyttelse_oere: number;
  total_oere: number;
  saelgergebyr_oere: number;
  udbetaling_oere: number;
  valuta: string;
  status: "afventer" | "behandles" | "betalt" | "annulleret" | "refunderet";
  betal_senest: string;
  // Hvornår betalingen (og 48-timersfristen) blev oprettet. Sælgeren kan
  // højst forlænge fristen til 7 dage efter dette tidspunkt.
  oprettet: string;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  betalt_kl: string | null;
  sidste_fejl: string | null;
  autobetaling_forsoegt_kl: string | null;
  autobetaling_resultat: string | null;
  vundet_mail_sendt_kl: string | null;
  paamindelse_24_sendt_kl: string | null;
  paamindelse_40_sendt_kl: string | null;
  frigivet_kl: string | null;
  stripe_transfer_id: string | null;
  overfoert_kl: string | null;
  refusion_anmodet_kl: string | null;
  refusion_aarsag: string | null;
  // Delvis refusion (sag: alt undtagen BidHamr Beskyttelse). null = fuld.
  refusion_oere: number | null;
  stripe_refund_id: string | null;
  refunderet_kl: string | null;
  overfoersel_paabegyndt_kl: string | null;
  annulleret_kl: string | null;
  kraever_opmaerksomhed: boolean;
  overfoersel_forsoeg: number;
  refusion_forsoeg: number;
  // Cron prøver refusionen, så længe refusion_forsoeg < refusion_graense
  // (20261005090000_tilbagebetaling_igen.sql).
  refusion_graense?: number;
  pi_forsoeg: number;
  overfoersel_graense: number;
  saelgerkonto_mail_1_kl: string | null;
  saelgerkonto_mail_2_kl: string | null;
  saelgerkonto_mail_3_kl: string | null;
  saelgerkonto_markeret_kl: string | null;
  indsigelse_kl: string | null;
  indsigelse_status: string | null;
  stripe_dispute_id: string | null;
  ikke_afsluttet_markeret_kl: string | null;
};

// Samme regel som betaling_indsigelse_blokerer i databasen: en åben eller
// tabt indsigelse (chargeback) blokerer frigivelse og overførsel.
const INDSIGELSE_AFSLUTTET = ["won", "warning_closed", "prevented"];
export function indsigelseBlokerer(
  b: Pick<BetalingRaekke, "indsigelse_kl" | "indsigelse_status">,
): boolean {
  return !!b.indsigelse_kl && !INDSIGELSE_AFSLUTTET.includes(b.indsigelse_status ?? "");
}

export type ProfilRaekke = {
  user_id: string;
  stripe_customer_id: string | null;
  gemt_betalingsmetode_id: string | null;
  gemt_kort_maerke: string | null;
  gemt_kort_sidste4: string | null;
  gemt_kort_udloeb: string | null;
  autobetaling: boolean;
  stripe_account_id: string | null;
  connect_detaljer_indsendt: boolean;
  connect_overfoersler_aktiv: boolean;
  connect_udbetalinger_aktiv: boolean;
  // Fra 20261003060000_connect_status.sql (valgfri, indtil migrationen er kørt).
  connect_mangler_nu?: string[] | null;
  connect_mangler_forfaldne?: string[] | null;
  connect_spaerret_aarsag?: string | null;
  connect_mangler_siden?: string | null;
  connect_klar_kl?: string | null;
  connect_frakoblet_kl?: string | null;
  connect_kraever_opmaerksomhed?: boolean | null;
  // Fra 20261003061000_connect_rettelser.sql: antal admin-nulstillinger af
  // udbetalingskontoen (indgår i idempotency key og beskednøgler).
  connect_nulstillet_antal?: number | null;
  connect_tidligere_konti?: string[] | null;
};

// ------------------------------------------------------------------ profiler

export async function hentProfil(userId: string): Promise<ProfilRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("betalingsprofiler")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle<ProfilRaekke>();
  if (error) throw new Error(`hentProfil: ${error.message}`);
  return data;
}

async function sikrProfilRaekke(userId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("betalingsprofiler")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) throw new Error(`sikrProfilRaekke: ${error.message}`);
}

// Stripe Customer til køberen (bruges til gemt kort og autobetaling).
export async function sikrStripeKunde(userId: string): Promise<string> {
  await sikrProfilRaekke(userId);
  const profil = await hentProfil(userId);
  if (profil?.stripe_customer_id) return profil.stripe_customer_id;

  const admin = createAdminClient();
  const { data: bruger } = await admin
    .from("users")
    .select("email")
    .eq("id", userId)
    .single<{ email: string }>();

  const kunde = await getStripe().customers.create(
    { email: bruger?.email, metadata: { bruger_id: userId } },
    { idempotencyKey: `bidhamr-kunde-${userId}` },
  );

  // Kun hvis feltet stadig er tomt - et samtidigt kald må ikke overskrive.
  await admin
    .from("betalingsprofiler")
    .update({ stripe_customer_id: kunde.id, opdateret: new Date().toISOString() })
    .eq("user_id", userId)
    .is("stripe_customer_id", null);

  const efter = await hentProfil(userId);
  if (!efter?.stripe_customer_id) throw new Error("Stripe-kunde kunne ikke gemmes.");
  return efter.stripe_customer_id;
}

// ------------------------------------------------------------------ betaling

export async function hentBetalingForHandel(
  tradeId: string,
): Promise<BetalingRaekke | null> {
  const { data, error } = await createAdminClient()
    .from("betalinger")
    .select("*")
    .eq("trade_id", tradeId)
    .maybeSingle<BetalingRaekke>();
  if (error) throw new Error(`hentBetalingForHandel: ${error.message}`);
  return data;
}

async function hentBetaling(id: string): Promise<BetalingRaekke> {
  const { data, error } = await createAdminClient()
    .from("betalinger")
    .select("*")
    .eq("id", id)
    .single<BetalingRaekke>();
  if (error || !data) throw new Error(`hentBetaling: ${error?.message}`);
  return data;
}

// Opretter (én gang) PaymentIntenten for en betaling. Beløbet er altid det,
// databasen har beregnet - aldrig noget fra klienten.
export async function sikrPaymentIntent(
  betaling: BetalingRaekke,
): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const beloeb = Number(betaling.total_oere);
  if (betaling.stripe_payment_intent_id) {
    const eksisterende = await stripe.paymentIntents.retrieve(
      betaling.stripe_payment_intent_id,
    );
    // Sikkerhedsnet for PaymentIntents oprettet før beskyttelsen blev låst ved
    // buddet: beløbet bringes i trit med databasens total. Klienten har
    // aldrig indflydelse på beløbet.
    if (eksisterende.amount !== beloeb && OPDATERBARE.includes(eksisterende.status)) {
      return stripe.paymentIntents.update(eksisterende.id, {
        amount: beloeb,
        metadata: { beskyttelse: betaling.beskyttelse ? "ja" : "nej" },
      });
    }
    return eksisterende;
  }
  if (totalOere(betaling, betaling.beskyttelse) !== beloeb) {
    // Databasen og TS-beregningen er uenige - betal aldrig et forkert beløb.
    throw new Error(`Beløb stemmer ikke for betaling ${betaling.id}`);
  }

  const kunde = await sikrStripeKunde(betaling.buyer_id);

  // PaymentIntenten oprettes én gang med det fulde beløb fra databasen
  // (bud + købergebyr + fragt + evt. BidHamr Beskyttelse valgt ved buddet).
  // pi_forsoeg > 0 betyder, at en tidligere PaymentIntent er kasseret pga.
  // afvigende beløb - så skal der en ny key til, ellers giver Stripe den
  // gamle tilbage.
  const nøgle =
    betaling.pi_forsoeg > 0
      ? `bidhamr-pi-${betaling.id}-${betaling.pi_forsoeg}`
      : `bidhamr-pi-${betaling.id}`;
  const pi = await stripe.paymentIntents.create(
    {
      amount: beloeb,
      currency: betaling.valuta,
      customer: kunde,
      // Kort, MobilePay, Apple Pay, Google Pay - styres fra Stripe Dashboard.
      automatic_payment_methods: { enabled: true },
      transfer_group: `handel_${betaling.trade_id}`,
      description: `BidHamr handel ${betaling.trade_id}`,
      metadata: {
        betaling_id: betaling.id,
        handel_id: betaling.trade_id,
        auktion_id: betaling.auction_id,
        koeber_id: betaling.buyer_id,
        beskyttelse: betaling.beskyttelse ? "ja" : "nej",
      },
    },
    { idempotencyKey: nøgle },
  );

  const admin = createAdminClient();
  const { error: gemFejl } = await admin
    .from("betalinger")
    .update({ stripe_payment_intent_id: pi.id, opdateret: new Date().toISOString() })
    .eq("id", betaling.id)
    .is("stripe_payment_intent_id", null);
  if (gemFejl) {
    // PaymentIntenten findes hos Stripe, men er ikke gemt. Næste kald får den
    // samme tilbage via idempotency key'en (24 t). Betal aldrig en intent,
    // databasen ikke kender.
    console.error("Kunne ikke gemme PaymentIntent:", betaling.id, pi.id, gemFejl.message);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Kunne ikke gemme PaymentIntent", fejl: gemFejl });
    throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
  }

  const efter = await hentBetaling(betaling.id);
  if (efter.stripe_payment_intent_id !== pi.id) {
    // Et samtidigt kald nåede at gemme en anden PaymentIntent. Brug den, og
    // annullér vores, så der aldrig ligger to betalbare intents.
    try {
      await stripe.paymentIntents.cancel(pi.id);
    } catch (err) {
      console.error("Kunne ikke annullere overskydende PaymentIntent:", pi.id, err);
    }
    return stripe.paymentIntents.retrieve(efter.stripe_payment_intent_id!);
  }
  return pi;
}

const OPDATERBARE: Stripe.PaymentIntent.Status[] = [
  "requires_payment_method",
  "requires_confirmation",
];

// Fejl, hvis tekst må vises for brugeren.
export class BetalingsFejl extends Error {}

function chargeId(pi: Stripe.PaymentIntent): string | null {
  if (!pi.latest_charge) return null;
  return typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
}

// Spejler en PaymentIntent fra Stripe ind i databasen. Bruges af webhooken,
// af autobetalingen og når køberen vender tilbage fra betalingen. Idempotent.
export async function spejlPaymentIntent(pi: Stripe.PaymentIntent): Promise<string> {
  const admin = createAdminClient();

  if (pi.status === "succeeded") {
    const { data, error } = await admin.rpc("betaling_registrer_betalt", {
      p_payment_intent: pi.id,
      p_charge: chargeId(pi),
      p_beloeb_oere: pi.amount_received,
      p_beskyttelse: pi.metadata?.beskyttelse === "ja",
    });
    if (error) throw new Error(`betaling_registrer_betalt: ${error.message}`);
    const resultat = String(data);
    if (resultat === "beloeb_afviger") {
      // Databasen har flyttet PaymentIntenten til betaling_afvigelser og sat
      // betalingen tilbage til 'afventer' (handlen fortsætter, køberen betaler
      // igen med en ny PaymentIntent). Den afvigende betaling refunderes her.
      // Kaster refusionen, får webhooken 500, og Stripe prøver igen; cron
      // prøver også igen (refunderAfvigelserVentende).
      console.error(`Betaling ${pi.id}: beløb afviger - refunderes automatisk.`);
      await refunderAfvigelse(pi.id);
    }
    if (resultat === "sen_betaling") {
      // Databasen har markeret betalingen (kraever_opmaerksomhed, sidste_fejl)
      // og claimet refusionen. Pengene sendes tilbage automatisk. Kaster
      // refusionen, får webhooken 500, og Stripe prøver igen.
      console.error(`Betaling ${pi.id}: ${resultat} - refunderes automatisk.`);
      const { data: b } = await admin
        .from("betalinger")
        .select("id")
        .eq("stripe_payment_intent_id", pi.id)
        .single<{ id: string }>();
      if (b) await refunderBetaling(b.id);
    }
    if (resultat === "betalt") await efterBetalt(pi.id);
    return resultat;
  }

  if (pi.status === "processing") {
    await admin
      .from("betalinger")
      .update({ status: "behandles", opdateret: new Date().toISOString() })
      .eq("stripe_payment_intent_id", pi.id)
      .eq("status", "afventer");
    return "behandles";
  }

  if (pi.status === "requires_payment_method") {
    // Mislykket forsøg (eller forsøg, der kræver ny betalingsmetode).
    // Kun en betaling, der ikke er betalt, sættes tilbage til 'afventer'.
    await admin
      .from("betalinger")
      .update({
        status: "afventer",
        sidste_fejl: pi.last_payment_error?.code ?? pi.last_payment_error?.message ?? null,
        opdateret: new Date().toISOString(),
      })
      .eq("stripe_payment_intent_id", pi.id)
      .in("status", ["afventer", "behandles"]);
    return "afventer";
  }

  return pi.status;
}

async function efterBetalt(paymentIntentId: string) {
  try {
    const admin = createAdminClient();
    const { data: b } = await admin
      .from("betalinger")
      .select("trade_id, auction_id, seller_id")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .single<{ trade_id: string; auction_id: string; seller_id: string }>();
    if (!b) return;
    const [{ data: a }, { data: t }] = await Promise.all([
      admin.from("auctions").select("titel").eq("id", b.auction_id).single(),
      admin.from("trades").select("afhentning, buyer_id").eq("id", b.trade_id).single(),
    ]);
    const titel = (a?.titel as string | undefined) ?? "din vare";
    const link = `/mine-handler/${b.trade_id}`;
    // Nøglen sikrer, at webhook + autobetaling + retur fra betaling ikke giver
    // flere beskeder for samme handel.
    if (t?.afhentning) {
      // Kun afhentning: ingen pakke. Køber og sælger aftaler afhentning, og
      // køberen viser sin kode, når han henter varen.
      await send(b.seller_id, "betaling_modtaget", {
        titel: "Køberen har betalt",
        tekst: `Køberen har betalt for "${titel}". Aftal afhentning med køberen i chatten, og indtast køberens kode, når varen er hentet.`,
        link,
        data: { trade_id: b.trade_id },
        mail: saelgerBetaltAfhentningMail(titel, b.trade_id),
        noegle: `betalt:${b.trade_id}`,
      });
      await send(t.buyer_id as string, "betaling_modtaget", {
        titel: "Aftal afhentning med sælgeren",
        tekst: `Aftal afhentning af "${titel}" med sælgeren – vis koden ved afhentning.`,
        link,
        data: { trade_id: b.trade_id },
        // Kvitteringen for købet er en del af afhentningsmailen.
        mail: koeberAfhentningMail(titel, b.trade_id, await koeberKvittering(b.trade_id)),
        noegle: `afhentning_betalt:${b.trade_id}`,
      });
      return;
    }
    await send(b.seller_id, "betaling_modtaget", {
      titel: "Køberen har betalt",
      tekst: `Køberen har betalt for "${titel}". Send varen, og indtast sporingsnummeret på handelssiden.`,
      link: `/mine-handler/${b.trade_id}`,
      data: { trade_id: b.trade_id },
      mail: saelgerBetaltMail(titel, b.trade_id),
      noegle: `betalt:${b.trade_id}`,
    });
    // Kvittering til køberen med beløbene opdelt (kaster aldrig).
    if (t?.buyer_id) await sendKoeberKvittering(b.trade_id, t.buyer_id as string);
  } catch (err) {
    console.error("Mail om modtaget betaling fejlede:", err);
  }
}

// ------------------------------------------------------------------ autobetaling

// Forsøger at trække vinderens gemte kort off-session. Kører højst én gang
// pr. betaling (atomisk claim i databasen + idempotency key hos Stripe).
// Fejler det (fx 3D Secure kræves), står PaymentIntenten tilbage som
// requires_payment_method, og køberen betaler selv inden for 48 timer med
// samme PaymentIntent.
export async function forsoegAutobetaling(betalingId: string): Promise<string> {
  const admin = createAdminClient();
  const nu = new Date().toISOString();

  const { data: claimed } = await admin
    .from("betalinger")
    .update({ autobetaling_forsoegt_kl: nu, opdateret: nu })
    .eq("id", betalingId)
    .is("autobetaling_forsoegt_kl", null)
    .eq("status", "afventer")
    .select("*")
    .maybeSingle<BetalingRaekke>();
  if (!claimed) return "ikke_relevant";

  const saetResultat = (resultat: string, fejl?: string | null) =>
    admin
      .from("betalinger")
      .update({
        autobetaling_resultat: resultat,
        ...(fejl !== undefined ? { sidste_fejl: fejl } : {}),
        opdateret: new Date().toISOString(),
      })
      .eq("id", betalingId);

  const profil = await hentProfil(claimed.buyer_id);
  if (
    !profil?.autobetaling ||
    !profil.gemt_betalingsmetode_id ||
    !profil.stripe_customer_id
  ) {
    await saetResultat("ikke_slaaet_til");
    return "ikke_slaaet_til";
  }

  try {
    const pi = await sikrPaymentIntent(claimed);
    if (pi.status === "succeeded") {
      await spejlPaymentIntent(pi);
      await saetResultat("betalt");
      return "betalt";
    }
    if (!OPDATERBARE.includes(pi.status)) {
      await saetResultat(`springet_over_${pi.status}`);
      return "springet_over";
    }

    const bekraeftet = await getStripe().paymentIntents.confirm(
      pi.id,
      {
        payment_method: profil.gemt_betalingsmetode_id,
        off_session: true,
        return_url: sideUrl(`/mine-handler/${claimed.trade_id}`),
      },
      { idempotencyKey: `bidhamr-autobetal-${claimed.id}` },
    );
    const resultat = await spejlPaymentIntent(bekraeftet);
    await saetResultat(resultat === "betalt" || resultat === "allerede_betalt" ? "betalt" : resultat);
    return resultat;
  } catch (err) {
    // Typisk authentication_required eller card_declined. Køberen falder
    // tilbage til den almindelige 48-timers betaling.
    const kode =
      err instanceof Stripe.errors.StripeError
        ? (err.code ?? err.decline_code ?? err.type)
        : err instanceof StripeTilstandFejl
          ? "stripe_stoppet"
          : "ukendt_fejl";
    console.warn("Autobetaling fejlede:", betalingId, kode);
    await saetResultat(`fejlet_${kode}`, kode);
    return `fejlet_${kode}`;
  }
}

// ------------------------------------------------------------------ frigivelse

// Overfører udbetaling_oere til sælgerens Connect-konto for en betaling, der
// er betalt OG frigivet (frigivet_kl sat af handel_godkend eller et senere
// frigivelsesflow). Sikker at kalde flere gange.
export async function overfoerTilSaelger(betalingId: string): Promise<string> {
  const b = await hentBetaling(betalingId);
  if (b.stripe_transfer_id) return "allerede_overfoert";
  if (b.status === "refunderet" || b.refusion_anmodet_kl) return "refunderet";
  if (b.status !== "betalt" || !b.frigivet_kl || !b.stripe_charge_id) {
    return "ikke_klar";
  }
  if (indsigelseBlokerer(b)) return "indsigelse";
  if (b.udbetaling_oere <= 0) return "intet_at_overfoere";

  const admin = createAdminClient();
  const { data: handel } = await admin
    .from("trades")
    .select("status, sag_aaben")
    .eq("id", b.trade_id)
    .single<{ status: string; sag_aaben: boolean | null }>();
  if (!handel || handel.status === "annulleret") return "annulleret";
  if (handel.sag_aaben) return "sag_aaben";

  // Handlen er frigivet: afregning til sælgeren, hvis kalderen ikke allerede
  // har sendt den med grunden (én gang pr. handel - kaster aldrig).
  await sendSaelgerAfregning(b.trade_id, "standard");

  const profil = await hentProfil(b.seller_id);
  if (profil?.connect_frakoblet_kl) {
    // Sælgeren har frakoblet/lukket sin Connect-konto hos Stripe. Der
    // overføres intet; betalingen markeres til admin (én gang). Profilen er
    // allerede markeret af webhooken (account.application.deauthorized).
    await markerFrakobletBetaling(b);
    return "saelgerkonto_frakoblet";
  }
  if (!profil?.stripe_account_id || !profil.connect_overfoersler_aktiv) {
    // Sælgeren har ikke en aktiv udbetalingskonto endnu. Overførslen laves,
    // når account.updated viser, at kontoen er klar (webhook/cron).
    // Sælgeren får en mail nu og igen efter 3 og 7 dage.
    await paamindSaelgerkonto(b);
    return "afventer_saelgerkonto";
  }

  // Atomisk claim i databasen: afviser åben sag, annulleret handel og
  // igangsat refusion, og blokerer en samtidig refusion fra admin.
  const { data: claimet, error: claimFejl } = await admin.rpc(
    "betaling_claim_overfoersel",
    { p_betaling: b.id },
  );
  if (claimFejl) throw new Error(`betaling_claim_overfoersel: ${claimFejl.message}`);
  if (!claimet) return "ikke_tilladt";

  const stripe = getStripe();
  const transferGroup = `handel_${b.trade_id}`;

  // Idempotency keys hos Stripe udløber efter 24 timer. Tjek derfor også, om
  // en overførsel for denne betaling allerede findes, før en ny oprettes.
  const eksisterende = await stripe.transfers.list({
    transfer_group: transferGroup,
    limit: 100,
  });
  let transfer = eksisterende.data.find(
    (t) => t.metadata?.betaling_id === b.id && !t.reversed,
  );

  if (!transfer) {
    // Stripe gemmer også fejlsvar under en idempotency key (24 t). Efter en
    // endelig fejl tælles overfoersel_forsoeg op, så næste forsøg får en ny
    // key. Forsøg 0 bruger den oprindelige key.
    const nøgle =
      b.overfoersel_forsoeg > 0
        ? `bidhamr-overfoersel-${b.id}-${b.overfoersel_forsoeg}`
        : `bidhamr-overfoersel-${b.id}`;
    try {
      transfer = await stripe.transfers.create(
        {
          amount: b.udbetaling_oere,
          currency: b.valuta,
          destination: profil.stripe_account_id,
          source_transaction: b.stripe_charge_id,
          transfer_group: transferGroup,
          description: `BidHamr handel ${b.trade_id}`,
          metadata: {
            betaling_id: b.id,
            handel_id: b.trade_id,
            saelger_id: b.seller_id,
          },
        },
        { idempotencyKey: nøgle },
      );
    } catch (err) {
      await registrerOverfoerselsfejl(b.id, err);
      throw err;
    }
  }

  await admin
    .from("betalinger")
    .update({
      stripe_transfer_id: transfer.id,
      overfoert_kl: new Date().toISOString(),
      opdateret: new Date().toISOString(),
    })
    .eq("id", b.id)
    .is("stripe_transfer_id", null);

  // Skyldtes en markering kun en tidligere fejlet/ventende overførsel, er den
  // nu løst (logges som systembrugeren). Andre markeringer røres ikke.
  await overfoerselLoestAutomatisk(b.id);

  // Kaster aldrig; nøglen forhindrer dobbelt besked ved gentagne forsøg.
  const { data: a } = await admin
    .from("auctions")
    .select("titel")
    .eq("id", b.auction_id)
    .maybeSingle();
  const titel = (a?.titel as string | undefined) ?? "din vare";
  await send(b.seller_id, "udbetaling", {
    titel: "Din udbetaling er på vej",
    tekst: `Udbetalingen for "${titel}" er sendt til din udbetalingskonto hos vores betalingspartner Stripe.`,
    link: `/mine-handler/${b.trade_id}`,
    data: { trade_id: b.trade_id },
    noegle: `udbetalt:${b.id}`,
  });

  return "overfoert";
}

// Fjerner en markering, der kun skyldes en fejlet/ventende overførsel, når
// overførslen er oprettet hos Stripe (betaling_overfoersel_loest_auto).
// Kaster aldrig - overførslen er sket, og markeringen kan løses manuelt.
async function overfoerselLoestAutomatisk(betalingId: string): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_overfoersel_loest_auto", {
    p_betaling: betalingId,
  });
  if (error && !manglerFunktion(error)) {
    console.error("betaling_overfoersel_loest_auto:", betalingId, error.message);
  }
}

// En fejl fra transfers.create. Er den ENDELIG (Stripe afviste anmodningen -
// 4xx: invalid_request, permission, card), er der med
// sikkerhed ikke oprettet en overførsel: claimet frigives (så admin fx kan
// refundere), forsøgstælleren tælles op og betalingen markeres til admin.
// Er fejlen USIKKER (netværk, 5xx, rate limit, idempotency-konflikt), kan
// overførslen være oprettet:
// claimet beholdes, og næste kørsel prøver igen med samme key - og finder en
// evt. oprettet overførsel via transfers.list først.
async function registrerOverfoerselsfejl(betalingId: string, err: unknown) {
  const admin = createAdminClient();
  if (err instanceof StripeTilstandFejl) {
    // Vagten stoppede kaldet, FØR det nåede Stripe: med sikkerhed intet
    // oprettet, og det tæller ikke som et forsøg. Claimet beholdes (samme
    // key næste gang), og drift-alarmen er givet af vagten.
    await admin
      .from("betalinger")
      .update({
        kraever_opmaerksomhed: true,
        sidste_fejl: "Overførsel til sælger stoppet: Stripe-nøglen passer ikke til databasen - intet sendt, prøves igen",
        opdateret: new Date().toISOString(),
      })
      .eq("id", betalingId)
      .is("stripe_transfer_id", null);
    return;
  }
  const endelig =
    err instanceof Stripe.errors.StripeInvalidRequestError ||
    err instanceof Stripe.errors.StripePermissionError ||
    err instanceof Stripe.errors.StripeCardError;
  const kode =
    err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt_fejl";
  if (endelig) {
    const { error } = await admin.rpc("betaling_overfoersel_fejlet", {
      p_betaling: betalingId,
      p_fejl: `Overførsel til sælger afvist af Stripe: ${kode}`,
    });
    if (error) console.error("betaling_overfoersel_fejlet:", error.message);
  } else {
    await admin
      .from("betalinger")
      .update({
        kraever_opmaerksomhed: true,
        sidste_fejl: `Overførsel til sælger usikker (${kode}) - prøves igen`,
        opdateret: new Date().toISOString(),
      })
      .eq("id", betalingId)
      .is("stripe_transfer_id", null);
  }
}

// ------------------------------------------------------------------ refusion

// Refusion af en betaling hos Stripe. Fuld, medmindre refusion_oere er sat
// (sag med medhold: alt undtagen BidHamr Beskyttelse). Kræver, at refusionen allerede er
// claimet i databasen (refusion_anmodet_kl - sat af betaling_paabegynd_refusion
// eller af betaling_registrer_betalt ved sen betaling / afvigende beløb), så
// en overførsel til sælger aldrig kan ske samtidig.
//
// Aldrig dobbelt refusion:
//   - Stripe-kaldet sker under en kort lås i databasen (betaling_refusion_laas),
//     så to forsøg (fx cron og admins "Prøv tilbagebetaling igen", der bruger
//     forskellige idempotency keys) aldrig kører samtidig. Er låsen taget,
//     returneres "refusion_i_gang".
//   - Idempotency key pr. betaling og forsøg.
//   - Før en ny refusion oprettes, slås ALLE refusioner på PaymentIntenten op
//     hos Stripe. Findes vores egen (metadata.betaling_id), genbruges den.
//     Findes andre (fx lavet i Stripe Dashboard), oprettes der intet nyt: dækker
//     de beløbet, er køberen refunderet, og ellers markeres betalingen til
//     admin - så summen af refusioner aldrig kan overstige det, der skal
//     refunderes.
//
// Status 'refunderet' spejles af webhooken (charge.refunded) - og her med det
// samme, hvis Stripe svarer "succeeded".
export async function refunderBetaling(betalingId: string): Promise<string> {
  const b = await hentBetaling(betalingId);
  if (b.status === "refunderet") return "allerede_refunderet";
  if (!b.refusion_anmodet_kl) throw new Error("Refusion er ikke claimet.");
  if (b.stripe_transfer_id || b.overfoersel_paabegyndt_kl) {
    throw new Error("Betalingen er overført til sælger - refusion afvist.");
  }
  if (!b.stripe_payment_intent_id) throw new Error("Ingen PaymentIntent at refundere.");

  const laas = await tagRefusionsLaas(b);
  if (laas === null) return "refusion_i_gang";
  try {
    return await refunderUnderLaas(b, b.stripe_payment_intent_id, laas);
  } finally {
    await frigivRefusionsLaas(b.id, laas);
  }
}

// Stripe-kald under refusionslåsen: højst 20 sekunder pr. forsøg og højst ét
// automatisk genforsøg (stripe-node's standard er 80 sekunder). Alle kald
// under låsen (højst 5 Stripe-kald) tager dermed højst ca. 4 minutter, og
// låsen (betaling_refusion_laas) varer 15 minutter - den udløber ikke, mens
// et kald stadig er i gang. Genforsøg sker med samme idempotency key.
const UNDER_LAAS: Stripe.RequestOptions = { timeout: 20_000, maxNetworkRetries: 1 };

function manglerFunktion(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === "PGRST202" || err.code === "42883");
}

// Låsens nøgle eller null (en anden er i gang, eller betalingen er ændret,
// siden den blev læst). Uden lås ingen refusion: mangler låsefunktionen,
// kastes der.
async function tagRefusionsLaas(b: BetalingRaekke): Promise<string | null> {
  const noegle = crypto.randomUUID();
  const { data, error } = await createAdminClient().rpc("betaling_refusion_laas", {
    p_betaling: b.id,
    p_noegle: noegle,
    p_forsoeg: b.refusion_forsoeg,
    p_refund: b.stripe_refund_id,
  });
  if (error) throw new Error(`betaling_refusion_laas: ${error.message}`);
  return data === true ? noegle : null;
}

async function frigivRefusionsLaas(betalingId: string, noegle: string): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_refusion_frigiv", {
    p_betaling: betalingId,
    p_noegle: noegle,
  });
  // Låsen udløber af sig selv efter 15 minutter.
  if (error) console.error("betaling_refusion_frigiv:", betalingId, error.message);
}

// Markerer betalingen til admin. Aldrig beløb i teksten - den vises for staff.
// Teksten TILFØJES til en eksisterende markering (betaling_marker_refusion),
// så en tidligere grund (fx afhentning eller sen betaling) ikke forsvinder.
async function markerRefusion(betalingId: string, besked: string): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_marker_refusion", {
    p_betaling: betalingId,
    p_besked: besked,
  });
  if (error) console.error("Markering af refusion fejlede:", betalingId, error.message);
}

// En anden refusion hos Stripe (fx fra Dashboard), der ikke dækker beløbet.
// Kaldes under låsen: betaling_refusion_konflikt markerer betalingen og sætter
// refusion_graense = refusion_forsoeg (kun når låsen holdes), så cron ikke
// prøver igen hver kørsel. Admin kan give et nyt forsøg. Kaster aldrig.
async function markerRefusionskonflikt(betalingId: string, laas: string): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_refusion_konflikt", {
    p_betaling: betalingId,
    p_noegle: laas,
    p_besked: "Anden refusion fundet hos Stripe - kontrollér betalingen, før der refunderes igen",
  });
  if (error) console.error("betaling_refusion_konflikt:", betalingId, error.message);
}

async function refunderUnderLaas(
  b: BetalingRaekke,
  piId: string,
  laas: string,
): Promise<string> {
  const admin = createAdminClient();
  const stripe = getStripe();

  // Findes der allerede en refusion, oprettes der kun en ny, hvis den forrige
  // endeligt er failed/canceled. Så tælles forsøget op (atomisk, kun af den,
  // der holder låsen), og den nye refusion får en ny idempotency key - ellers
  // ville Stripe bare returnere den fejlede refusion igen.
  let forsoeg = b.refusion_forsoeg;
  if (b.stripe_refund_id) {
    const forrige = await stripe.refunds.retrieve(b.stripe_refund_id, {}, UNDER_LAAS);
    if (forrige.status === "succeeded") {
      await registrerRefunderet(piId, forrige.id);
      return "refunderet";
    }
    if (forrige.status !== "failed" && forrige.status !== "canceled") {
      return "refusion_afventer"; // pending/requires_action - vent på Stripe
    }
    const { data: n, error } = await admin.rpc("betaling_refusion_nyt_forsoeg", {
      p_betaling: b.id,
      p_gammel_refund: forrige.id,
      p_noegle: laas,
    });
    if (error) throw new Error(`betaling_refusion_nyt_forsoeg: ${error.message}`);
    if (Number(n) < 0) throw new Error("Refusionen blev ændret samtidig - prøv igen.");
    forsoeg = Number(n);
  }
  const nøgle =
    forsoeg > 0 ? `bidhamr-refusion-${b.id}-${forsoeg}` : `bidhamr-refusion-${b.id}`;

  // Delvis refusion: beløbet er sat af databasen (sag_claim_refusion) og er
  // altid > 0 og <= total_oere (CHECK-constraint). Tjekkes igen her, så et
  // forkert beløb aldrig sendes til Stripe.
  const delvis = refusionsbeloeb(b);
  if (delvis === "ugyldigt") {
    await markerRefusion(b.id, "Refusionsbeløbet er ugyldigt - refusion stoppet");
    throw new Error(`Ugyldigt refusionsbeløb for betaling ${b.id}`);
  }

  // Det, der i alt skal refunderes: sagens beløb, eller alt det modtagne.
  const pi = await stripe.paymentIntents.retrieve(piId, {}, UNDER_LAAS);
  const modtaget = Number(pi.amount_received ?? 0);
  if (!Number.isInteger(modtaget) || modtaget <= 0) {
    throw new Error(`Intet modtaget at refundere for betaling ${b.id}`);
  }
  const maal = delvis ?? modtaget;
  if (maal > modtaget) {
    await markerRefusion(b.id, "Refusionsbeløbet er ugyldigt - refusion stoppet");
    throw new Error(`Refusionsbeløbet overstiger det modtagne for betaling ${b.id}`);
  }

  // Idempotency keys hos Stripe udløber efter 24 timer, og et nyt forsøg har
  // en ny key. Slå derfor ALLE refusioner på PaymentIntenten op, før en ny
  // oprettes (samme mønster som transfers.list i overfoerTilSaelger). Kun
  // refusioner, der ikke er endeligt fejlet, tæller.
  const eksisterende = await stripe.refunds.list(
    { payment_intent: piId, limit: 100 },
    UNDER_LAAS,
  );
  const aktive = eksisterende.data.filter(
    (r) => r.status !== "failed" && r.status !== "canceled",
  );
  let refund: Stripe.Refund | null =
    aktive.find((r) => r.metadata?.betaling_id === b.id) ?? null;

  if (!refund) {
    const allerede = aktive.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);
    if (eksisterende.has_more || allerede > 0) {
      // Andre refusioner (fx fra Stripe Dashboard). Dækker de beløbet, er
      // køberen refunderet; ellers oprettes INTET, og admin må tage stilling.
      if (!eksisterende.has_more && allerede >= maal) {
        if (aktive.every((r) => r.status === "succeeded")) {
          await registrerRefunderet(piId, null);
          return "refunderet";
        }
        return "refusion_afventer";
      }
      await markerRefusionskonflikt(b.id, laas);
      return "refusion_konflikt";
    }
  }

  try {
    if (!refund) {
      refund = await stripe.refunds.create(
        {
          payment_intent: piId,
          ...(delvis !== null ? { amount: delvis } : {}),
          reason: "requested_by_customer",
          metadata: {
            betaling_id: b.id,
            handel_id: b.trade_id,
            aarsag: b.refusion_aarsag ?? "",
          },
        },
        { idempotencyKey: nøgle, ...UNDER_LAAS },
      );
    }
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === "charge_already_refunded") {
      refund = null; // allerede refunderet - spejles nedenfor
    } else if (err instanceof StripeTilstandFejl) {
      // Vagten stoppede kaldet, før det nåede Stripe: intet oprettet, og
      // det tæller ikke som et forsøg (cron udskyder kun).
      throw err;
    } else {
      await markerRefusion(
        b.id,
        `Refusion fejlede: ${
          err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt"
        }`,
      );
      // Næste forsøg med ny idempotency key (Stripe gemmer fejlsvaret under
      // den gamle i 24 t) og backoff. En evt. oprettet refusion (usikker fejl)
      // findes næste gang via refunds.list (metadata.betaling_id).
      await registrerRefusionsfejl(b.id, laas);
      throw err;
    }
  }

  if (refund) {
    await admin
      .from("betalinger")
      .update({ stripe_refund_id: refund.id, opdateret: new Date().toISOString() })
      .eq("id", b.id)
      .is("stripe_refund_id", null);
    if (refund.status === "failed" || refund.status === "canceled") {
      await markerRefusion(b.id, `Refusion ${refund.status} hos Stripe`);
      await udskydRefusion(b.id);
      return `refusion_${refund.status}`;
    }
    if (refund.status === "succeeded") {
      await registrerRefunderet(piId, refund.id);
      return "refunderet";
    }
    return "refusion_afventer"; // pending: charge.refunded/refund.updated følger
  }

  const piNu = await stripe.paymentIntents.retrieve(
    piId,
    { expand: ["latest_charge"] },
    UNDER_LAAS,
  );
  const charge = piNu.latest_charge;
  if (charge && typeof charge !== "string" && charge.refunded) {
    await registrerRefunderet(piId, null);
  }
  return "refunderet";
}

// null = fuld refusion. Et tal = delvis refusion i øre (aldrig over det betalte).
function refusionsbeloeb(
  b: Pick<BetalingRaekke, "refusion_oere" | "total_oere">,
): number | null | "ugyldigt" {
  if (b.refusion_oere === null || b.refusion_oere === undefined) return null;
  const beloeb = Number(b.refusion_oere);
  const total = Number(b.total_oere);
  if (!Number.isInteger(beloeb) || beloeb <= 0 || beloeb > total) return "ugyldigt";
  return beloeb === total ? null : beloeb;
}

// Refusionen fejlede (Stripe-kaldet): nyt forsøg + backoff. Under låsen.
// Kaster aldrig.
async function registrerRefusionsfejl(betalingId: string, laas: string): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_refusion_fejl", {
    p_betaling: betalingId,
    p_noegle: laas,
  });
  if (error) console.error("betaling_refusion_fejl:", betalingId, error.message);
}

// Refusionen fejlede hos Stripe bagefter: næste forsøg efter backoff.
async function udskydRefusion(betalingId: string): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_refusion_udskyd", { p_betaling: betalingId });
  if (error) console.error("betaling_refusion_udskyd:", betalingId, error.message);
}

// Fra dette antal mislykkede forsøg står refusionen som "fejlet flere gange"
// i admin (/admin/betalinger), og der gives drift-alarm, når forsøgene er
// brugt op (refusion_graense, standard 5).
export const REFUSION_FEJLET_FLERE_GANGE = 2;

// Cron (Niels F05): ALLE lovede refusioner (refusion_anmodet_kl sat), uanset
// årsag - sag, admin ("Refundér køber"), sen betaling på annulleret handel,
// afsendelses- og afhentningsfrist - hvor Stripe-kaldet fejlede eller aldrig
// blev lavet. Kun:
//   - claimet for mindst 10 minutter siden (ikke samtidig med første forsøg),
//   - ikke overført til sælger, ikke en Dashboard-refusion
//     ('delvis_refusion_stripe' - den afgør staff), ingen blokerende
//     indsigelse (refusionen afgøres af banken),
//   - forsøg tilbage (refusion_forsoeg < refusion_graense; admin kan give
//     flere med "Prøv tilbagebetaling igen"),
//   - backoff udløbet (refusion_naeste_forsoeg_kl).
// refunderBetaling er idempotent (lås, idempotency key pr. forsøg, og
// eksisterende refusioner slås op hos Stripe først). Virker uanset hvor
// pengene står - refunderBetaling refunderer PaymentIntenten.
export async function refunderLoveteVentende(): Promise<number> {
  const nu = new Date().toISOString();
  const { data, error } = await createAdminClient()
    .from("betalinger")
    .select("id, trade_id, refusion_forsoeg, refusion_graense")
    .eq("status", "betalt")
    .not("refusion_anmodet_kl", "is", null)
    .lt("refusion_anmodet_kl", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .is("stripe_transfer_id", null)
    .is("overfoersel_paabegyndt_kl", null)
    .eq("refusion_opbrugt", false)
    .or("refusion_aarsag.is.null,refusion_aarsag.neq.delvis_refusion_stripe")
    .or("indsigelse_kl.is.null,indsigelse_status.in.(won,warning_closed,prevented)")
    .or(`refusion_naeste_forsoeg_kl.is.null,refusion_naeste_forsoeg_kl.lte.${nu}`)
    .order("refusion_anmodet_kl", { ascending: true })
    .limit(50);
  if (error) {
    console.error("Hentning af lovede refusioner fejlede:", error.message);
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Lovede refusioner", fejl: error });
    return 0;
  }
  let antal = 0;
  for (const r of (data ?? []) as { id: string; trade_id: string; refusion_forsoeg: number; refusion_graense: number }[]) {
    try {
      if ((await refunderBetaling(r.id)) === "refunderet") antal++;
    } catch (err) {
      console.error("Lovet refusion fejlede (prøves igen):", r.id, err);
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Lovet refusion", fejl: err });
      if (err instanceof StripeTilstandFejl) {
        // Stripe-kald stoppet af vagten (nøgle/database passer ikke): ikke
        // et forsøg - kun backoff. Vagten giver selv drift-alarm.
        await udskydRefusion(r.id);
        continue;
      }
      // Tæller som et forsøg, hvis det ikke allerede er talt under låsen
      // (betaling_refusion_fejl / _nyt_forsoeg): også fejl FØR refunds.create
      // (fx "Intet modtaget at refundere", ugyldigt beløb, Stripe svarer
      // ikke). Så når refusionen refusion_graense og opgives med én alarm -
      // i stedet for en ny alarm ved hver kørsel for evigt. Giver backoff.
      const { error: tFejl } = await createAdminClient().rpc("betaling_refusion_fejl_uden_laas", {
        p_betaling: r.id,
        p_forsoeg: r.refusion_forsoeg,
      });
      if (tFejl) {
        console.error("betaling_refusion_fejl_uden_laas:", r.id, tFejl.message);
        await udskydRefusion(r.id);
      }
      // Forsøgene er brugt op: tydelig alarm (admin skal tage over). Kun én
      // gang - en opbrugt refusion hentes ikke igen af cron.
      const { data: efter } = await createAdminClient()
        .from("betalinger")
        .select("refusion_opbrugt, refusion_forsoeg")
        .eq("id", r.id)
        .maybeSingle<{ refusion_opbrugt: boolean; refusion_forsoeg: number }>();
      if (efter?.refusion_opbrugt) {
        await logDriftFejl({
          kilde: "cron",
          sti: "betalings-cron",
          hvor: "Refusion opgivet",
          fejl: `Tilbagebetalingen for handel ${r.trade_id} er fejlet ${efter.refusion_forsoeg} gange og prøves ikke mere automatisk - se /admin/betalinger.`,
        });
      }
    }
  }
  return antal;
}

// Bagudkompatibelt navn (sagsrefusioner er nu en del af de lovede).
export const refunderSagerVentende = refunderLoveteVentende;

// Refunderer en kasseret PaymentIntent med afvigende beløb (betaling_afvigelser).
// Rører aldrig handlen eller den nye betaling. Idempotent: key pr.
// PaymentIntent og forsøg; ny key kun når forrige refusion er failed/canceled.
type AfvigelseRaekke = {
  id: string;
  betaling_id: string;
  trade_id: string;
  stripe_payment_intent_id: string;
  stripe_refund_id: string | null;
  refusion_forsoeg: number;
  refunderet_kl: string | null;
};

export async function refunderAfvigelse(paymentIntentId: string): Promise<string> {
  const admin = createAdminClient();
  const { data: a, error } = await admin
    .from("betaling_afvigelser")
    .select("*")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle<AfvigelseRaekke>();
  if (error) throw new Error(`betaling_afvigelser: ${error.message}`);
  if (!a) return "ukendt";
  if (a.refunderet_kl) return "allerede_refunderet";

  const stripe = getStripe();
  let forsoeg = a.refusion_forsoeg;
  if (a.stripe_refund_id) {
    const forrige = await stripe.refunds.retrieve(a.stripe_refund_id);
    if (forrige.status === "succeeded") {
      await registrerRefunderet(paymentIntentId, forrige.id);
      return "refunderet";
    }
    if (forrige.status !== "failed" && forrige.status !== "canceled") {
      return "refusion_afventer";
    }
    const { data: n, error: fejl } = await admin.rpc("afvigelse_refusion_nyt_forsoeg", {
      p_payment_intent: paymentIntentId,
      p_gammel_refund: forrige.id,
    });
    if (fejl) throw new Error(`afvigelse_refusion_nyt_forsoeg: ${fejl.message}`);
    if (Number(n) < 0) throw new Error("Afvigelsen blev ændret samtidig - prøv igen.");
    forsoeg = Number(n);
  }
  const nøgle =
    forsoeg > 0
      ? `bidhamr-afvigelse-refusion-${paymentIntentId}-${forsoeg}`
      : `bidhamr-afvigelse-refusion-${paymentIntentId}`;

  let refund: Stripe.Refund | null = null;
  try {
    refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason: "requested_by_customer",
        metadata: {
          betaling_id: a.betaling_id,
          handel_id: a.trade_id,
          aarsag: "beloeb_afviger",
        },
      },
      { idempotencyKey: nøgle },
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === "charge_already_refunded") {
      await registrerRefunderet(paymentIntentId, null);
      return "refunderet";
    }
    await admin
      .from("betaling_afvigelser")
      .update({
        sidste_fejl: `Refusion fejlede: ${
          err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt"
        }`,
        opdateret: new Date().toISOString(),
      })
      .eq("id", a.id);
    throw err;
  }

  await admin
    .from("betaling_afvigelser")
    .update({ stripe_refund_id: refund.id, opdateret: new Date().toISOString() })
    .eq("id", a.id)
    .is("stripe_refund_id", null);
  if (refund.status === "succeeded") {
    await registrerRefunderet(paymentIntentId, refund.id);
    return "refunderet";
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    await admin
      .from("betaling_afvigelser")
      .update({
        sidste_fejl: `Refusion ${refund.status} hos Stripe`,
        opdateret: new Date().toISOString(),
      })
      .eq("id", a.id);
    return `refusion_${refund.status}`;
  }
  return "refusion_afventer";
}

// Cron: prøver igen på afvigelser, der endnu ikke er refunderet.
export async function refunderAfvigelserVentende(): Promise<number> {
  const { data } = await createAdminClient()
    .from("betaling_afvigelser")
    .select("stripe_payment_intent_id")
    .is("refunderet_kl", null)
    .lt("refusion_forsoeg", 5)
    .limit(100);
  let antal = 0;
  for (const { stripe_payment_intent_id } of data ?? []) {
    try {
      if ((await refunderAfvigelse(stripe_payment_intent_id)) === "refunderet") antal++;
    } catch (err) {
      console.error("Refusion af afvigelse fejlede:", stripe_payment_intent_id, err);
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Refusion af afvigelse", fejl: err });
    }
  }
  return antal;
}

export async function registrerRefunderet(
  paymentIntentId: string,
  refundId: string | null,
): Promise<string> {
  const { data, error } = await createAdminClient().rpc("betaling_registrer_refunderet", {
    p_payment_intent: paymentIntentId,
    p_refund: refundId,
  });
  if (error) throw new Error(`betaling_registrer_refunderet: ${error.message}`);
  return String(data);
}

// Spejler charge.refunded. Fuld refusion sætter status 'refunderet'. Det gør
// også en delvis refusion, som BidHamr selv har bestilt (refusion_oere sat af
// en sag), når mindst det beløb er refunderet. Anden delvis refusion (fx lavet
// i Stripe Dashboard) markeres til admin.
export async function spejlRefusion(charge: Stripe.Charge): Promise<string> {
  const piId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);
  if (!piId) return "ingen_payment_intent";
  const { data: bestilt } = await createAdminClient()
    .from("betalinger")
    .select("refusion_oere, refusion_anmodet_kl")
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<{ refusion_oere: number | null; refusion_anmodet_kl: string | null }>();
  // Der er refunderet MERE end sagens afgørelse (fx en ekstra refusion i
  // Stripe Dashboard, eller BidHamr Beskyttelse refunderet ved en fejl):
  // registreres som refunderet, men markeres til admin. Ingen beløb i teksten.
  const merEndBestilt =
    bestilt?.refusion_oere !== null &&
    bestilt?.refusion_oere !== undefined &&
    Number(charge.amount_refunded) > Number(bestilt.refusion_oere);
  const marker = async (resultat: string) => {
    if (!merEndBestilt) return resultat;
    const { error } = await createAdminClient().rpc("betaling_marker_opmaerksomhed", {
      p_payment_intent: piId,
      p_besked: "Der er refunderet mere end sagens afgørelse - kontrollér refusionen hos Stripe",
    });
    if (error) throw new Error(`betaling_marker_opmaerksomhed: ${error.message}`);
    return resultat;
  };
  if (charge.refunded) return marker(await registrerRefunderet(piId, null));
  if (
    bestilt?.refusion_anmodet_kl &&
    bestilt.refusion_oere !== null &&
    Number(charge.amount_refunded) >= Number(bestilt.refusion_oere)
  ) {
    return marker(await registrerRefunderet(piId, null));
  }
  // Markeres til admin og blokerer overførsel (refusion_anmodet_kl sættes).
  const { error } = await createAdminClient().rpc("betaling_registrer_delvis_refusion", {
    p_payment_intent: piId,
    // Aldrig beløb i sidste_fejl - den vises for medarbejdere.
    p_besked: "Delvis refusion hos Stripe",
  });
  if (error) throw new Error(`betaling_registrer_delvis_refusion: ${error.message}`);
  return "delvis_refusion";
}

// Spejler refund.updated / refund.failed (og charge.refund.updated). Refusionen
// hentes frisk (events kan komme i forkert rækkefølge). Er den endeligt
// fejlet hos Stripe (failed/canceled), markeres betalingen til admin - eller
// afvigelsen, hvis det er en kasseret PaymentIntent. Ingen beløb i teksten.
// Sagsrefusioner prøves igen af cron (refunderSagerVentende opretter en ny
// refusion med ny idempotency key, når den forrige er failed/canceled).
export async function spejlRefusionsfejl(refundId: string): Promise<string> {
  const refund = await getStripe().refunds.retrieve(refundId);
  if (refund.status !== "failed" && refund.status !== "canceled") return refund.status ?? "ukendt";
  const piId =
    typeof refund.payment_intent === "string"
      ? refund.payment_intent
      : (refund.payment_intent?.id ?? null);
  if (!piId) return "ingen_payment_intent";

  const admin = createAdminClient();
  const besked = `Refusion ${refund.status === "failed" ? "fejlede" : "blev annulleret"} hos Stripe${
    refund.failure_reason ? ` (${refund.failure_reason})` : ""
  } - tjek betalingen`;
  const { data: b } = await admin
    .from("betalinger")
    .select("id, status, stripe_refund_id")
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<{ id: string; status: string; stripe_refund_id: string | null }>();
  if (b) {
    if (b.status === "refunderet") return refusionFejletEfterRefunderet(b, refund, piId);
    // En gammel, fejlet refusion, der allerede er erstattet af et nyt forsøg.
    if (b.stripe_refund_id && b.stripe_refund_id !== refund.id) return "erstattet";
    const { error } = await admin.rpc("betaling_marker_opmaerksomhed", {
      p_payment_intent: piId,
      p_besked: besked,
    });
    if (error) throw new Error(`betaling_marker_opmaerksomhed: ${error.message}`);
    // Cron laver et nyt forsøg efter backoff (refunderLoveteVentende).
    await udskydRefusion(b.id);
    // Køberen får besked om, at pengene er forsinket (én gang pr. refusion).
    await sendRefusionForsinket(b.id, refund.id);
    return "markeret";
  }
  const { data: afv } = await admin
    .from("betaling_afvigelser")
    .update({ sidste_fejl: besked, opdateret: new Date().toISOString() })
    .eq("stripe_payment_intent_id", piId)
    .is("refunderet_kl", null)
    .select("id");
  return (afv ?? []).length > 0 ? "afvigelse_markeret" : "ukendt";
}

// Betalingen står som 'refunderet', men en refusion er bagefter fejlet hos
// Stripe (fx køberens kort er lukket). Er det vores refusion, og er pengene
// ikke stadig refunderet hos Stripe, sættes betalingen tilbage til 'betalt'
// med refusionen stadig claimet (betaling_refusion_fejlet), så cron prøver
// igen (refunderSagerVentende) og admin ser den. Ellers ignoreres hændelsen.
async function refusionFejletEfterRefunderet(
  b: { id: string; stripe_refund_id: string | null },
  refund: Stripe.Refund,
  piId: string,
): Promise<string> {
  // Vores refusion: den gemte (stripe_refund_id), eller - når ingen er gemt
  // (refunderet registreret via charge.refunded) - den, der fejlede. En gammel
  // refusion, der allerede er erstattet af et nyt, gennemført forsøg, ignoreres
  // (også selvom metadata.betaling_id er vores).
  if (b.stripe_refund_id && b.stripe_refund_id !== refund.id) return "allerede_refunderet";

  // Er chargen stadig (fuldt eller med det bestilte beløb) refunderet hos
  // Stripe - fx af en anden refusion - er der intet at gøre.
  const pi = await getStripe().paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return "allerede_refunderet";
  const { data: bestilt } = await createAdminClient()
    .from("betalinger")
    .select("refusion_oere")
    .eq("id", b.id)
    .maybeSingle<{ refusion_oere: number | null }>();
  const stadigRefunderet =
    charge.refunded ||
    (bestilt?.refusion_oere !== null &&
      bestilt?.refusion_oere !== undefined &&
      Number(charge.amount_refunded) >= Number(bestilt.refusion_oere));
  if (stadigRefunderet) return "allerede_refunderet";

  const { data, error } = await createAdminClient().rpc("betaling_refusion_fejlet", {
    p_betaling: b.id,
    p_refund: refund.id,
  });
  if (error) throw new Error(`betaling_refusion_fejlet: ${error.message}`);
  if (String(data) !== "genaabnet") return "allerede_refunderet";
  await sendRefusionForsinket(b.id, refund.id);
  return "refusion_genaabnet";
}

// Spejler en indsigelse (chargeback) fra Stripe. Disputen hentes frisk, så
// events i forkert rækkefølge giver den aktuelle status. Åben eller tabt
// indsigelse blokerer frigivelse og overførsel og markeres til admin. Er den
// vundet/lukket, prøves en ventende overførsel med det samme.
export async function spejlIndsigelse(disputeId: string): Promise<string> {
  const stripe = getStripe();
  const d = await stripe.disputes.retrieve(disputeId);
  const piId =
    typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
  const chId = typeof d.charge === "string" ? d.charge : d.charge.id;
  const { data, error } = await createAdminClient().rpc("betaling_registrer_indsigelse", {
    p_payment_intent: piId,
    p_charge: chId,
    p_dispute: d.id,
    p_status: d.status,
  });
  if (error) throw new Error(`betaling_registrer_indsigelse: ${error.message}`);
  const resultat = String(data);
  if (resultat === "ukendt") {
    console.error("Indsigelse på ukendt betaling:", d.id, piId, chId);
  }
  // Sælgeren får besked, når indsigelsen åbnes (så varen ikke sendes) og når
  // den er afgjort (Niels F04). Én besked pr. dispute og udfald.
  if (resultat === "blokeret" || resultat === "tabt" || resultat === "afsluttet") {
    const udfald = resultat === "blokeret" ? "aaben" : resultat === "tabt" ? "tabt" : "afgjort";
    // Et tidligt svindelvarsel, der lukkes uden en egentlig indsigelse
    // (warning_closed uden forudgående åben indsigelse), giver ingen besked.
    if (!(udfald === "afgjort" && d.status === "warning_closed")) {
      await sendIndsigelseTilSaelger(d.id, piId, chId, udfald);
    }
  }
  if (resultat === "afsluttet" && piId) {
    const { data: b } = await createAdminClient()
      .from("betalinger")
      .select("id")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle<{ id: string }>();
    if (b) {
      try {
        await overfoerTilSaelger(b.id);
      } catch (err) {
        console.error("Overførsel efter afsluttet indsigelse fejlede (cron prøver igen):", err);
      }
    }
  }
  return resultat;
}

// Annullerer en ikke-betalt betaling: først i databasen (atomisk), derefter
// PaymentIntenten hos Stripe, så den ikke kan betales. Går en betaling
// alligevel igennem, giver spejlingen 'sen_betaling' og automatisk refusion.
// Bruges af admin og af betalingsfristen (cron). Idempotent: betaling_annuller
// returnerer PaymentIntent-id'et igen for en allerede annulleret betaling.
//
// Resultat:
//   "ikke_annullerbar" - databasen afviste (fx allerede betalt). Intet at gøre hos Stripe.
//   "annulleret"       - annulleret hos Stripe (eller ingen PaymentIntent, eller
//                        betalt i mellemtiden - så refunderes den via spejlingen).
//   "stripe_fejlede"   - Stripe-annulleringen lykkedes ikke. Kalderen må IKKE
//                        sætte stripe_annulleret_kl, så cron prøver igen.
export type AnnullerResultat = "ikke_annullerbar" | "annulleret" | "stripe_fejlede";

export async function annullerBetaling(tradeId: string): Promise<AnnullerResultat> {
  const { data, error } = await createAdminClient().rpc("betaling_annuller", {
    p_trade: tradeId,
  });
  if (error) throw new Error(`betaling_annuller: ${error.message}`);
  if (!data) return "ikke_annullerbar";
  const piId = (data as { payment_intent: string | null }).payment_intent;
  if (!piId) return "annulleret";

  const stripe = getStripe();
  try {
    await stripe.paymentIntents.cancel(
      piId,
      { cancellation_reason: "abandoned" },
      { idempotencyKey: `bidhamr-annuller-${piId}` },
    );
    return "annulleret";
  } catch (err) {
    // Allerede annulleret, eller betalt i mellemtiden (så refunderes den).
    console.warn("Kunne ikke annullere PaymentIntent:", piId, err);
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status === "canceled") return "annulleret";
      if (pi.status === "succeeded") {
        await spejlPaymentIntent(pi);
        return "annulleret";
      }
    } catch (err2) {
      console.error("Kunne ikke hente PaymentIntent efter fejlet annullering:", piId, err2);
    }
    return "stripe_fejlede";
  }
}

// Prøver alle frigivne, ikke-overførte betalinger for en sælger (eller alle).
// Hele køen gennemløbes side for side (sorteret på id, så rækkefølgen er
// stabil, mens rækker forsvinder fra køen undervejs), så gamle betalinger, der
// venter på en sælgerkonto, aldrig kan sulte nye ud. Et loft på antal sider
// beskytter cron-kørslens tid; resten tages ved næste kørsel.
const OVERFOERSEL_SIDE = 100;
const OVERFOERSEL_MAKS_SIDER = 20;

export async function overfoerVentende(saelgerId?: string): Promise<number> {
  const admin = createAdminClient();
  let antal = 0;
  let efterId: string | null = null;
  for (let side = 0; side < OVERFOERSEL_MAKS_SIDER; side++) {
    let q = admin
      .from("betalinger")
      .select("id")
      .eq("status", "betalt")
      .not("frigivet_kl", "is", null)
      .is("stripe_transfer_id", null)
      .is("refusion_anmodet_kl", null)
      .order("id", { ascending: true })
      .limit(OVERFOERSEL_SIDE);
    if (efterId) q = q.gt("id", efterId);
    // Cron giver op, når forsøgene er brugt op (overfoersel_forsoeg >=
    // overfoersel_graense - betalingen er markeret til admin, som kan give nye
    // forsøg). account.updated for sælgeren prøver altid igen.
    if (saelgerId) q = q.eq("seller_id", saelgerId);
    else q = q.eq("overfoersel_opbrugt", false);
    const { data, error } = await q;
    if (error) {
      console.error("Hentning af ventende overførsler fejlede:", error.message);
      break;
    }
    const raekker = (data ?? []) as { id: string }[];
    for (const { id } of raekker) {
      try {
        if ((await overfoerTilSaelger(id)) === "overfoert") antal++;
      } catch (err) {
        console.error("Overførsel til sælger fejlede:", id, err);
        await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Overførsel til sælger", fejl: err });
      }
    }
    if (raekker.length < OVERFOERSEL_SIDE) break;
    efterId = raekker[raekker.length - 1].id;
  }
  return antal;
}

// ------------------------------------------------------------------ gemt kort

// Registrerer kortet fra en gennemført SetupIntent som brugerens gemte kort.
// Kunden på SetupIntenten afgør, hvem kortet tilhører - metadata stoles ikke på.
export async function registrerGemtKort(si: Stripe.SetupIntent): Promise<boolean> {
  if (si.status !== "succeeded" || !si.payment_method || !si.customer) return false;
  const kundeId = typeof si.customer === "string" ? si.customer : si.customer.id;
  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id;

  const admin = createAdminClient();
  const { data: profil } = await admin
    .from("betalingsprofiler")
    .select("*")
    .eq("stripe_customer_id", kundeId)
    .maybeSingle<ProfilRaekke>();
  if (!profil) return false;
  if (profil.gemt_betalingsmetode_id === pmId) return true;

  // Et forsinket Stripe-svar (fx en genleveret setup_intent.succeeded) må
  // ikke genskabe et kort, brugeren har fjernet, eller erstatte et nyere kort
  // (Niels M04): SetupIntenten skal være nyere end både det gemte kort og
  // seneste "Fjern kort", og kortet skal stadig sidde på kunden hos Stripe.
  // Sammenlignes i hele sekunder (Stripes created er i sekunder, databasens
  // tidspunkter i mikrosekunder): samme sekund som "Fjern kort" afvises.
  const siKl = new Date(si.created * 1000);
  const p = profil as ProfilRaekke & { gemt_kort_kl?: string | null; kort_fjernet_kl?: string | null };
  const stripe = getStripe();
  for (const graense of [p.gemt_kort_kl, p.kort_fjernet_kl]) {
    if (graense && si.created <= Math.floor(new Date(graense).getTime() / 1000)) {
      await fjernAfvistKort(profil.user_id, pmId);
      return false;
    }
  }

  const pm = await stripe.paymentMethods.retrieve(pmId);
  const pmKunde = typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
  if (pmKunde !== kundeId) return false; // fjernet (detached) i mellemtiden
  const kort = pm.card;

  // Kun hvis profilen ikke er ændret siden læsningen (samtidigt "Fjern kort"
  // eller et andet kort).
  let q = admin
    .from("betalingsprofiler")
    .update({
      gemt_betalingsmetode_id: pmId,
      gemt_kort_maerke: kort?.brand ?? pm.type,
      gemt_kort_sidste4: kort?.last4 ?? null,
      gemt_kort_udloeb: kort ? `${String(kort.exp_month).padStart(2, "0")}/${kort.exp_year}` : null,
      gemt_kort_kl: siKl.toISOString(),
      opdateret: new Date().toISOString(),
    })
    .eq("user_id", profil.user_id);
  q = profil.gemt_betalingsmetode_id
    ? q.eq("gemt_betalingsmetode_id", profil.gemt_betalingsmetode_id)
    : q.is("gemt_betalingsmetode_id", null);
  q = p.kort_fjernet_kl ? q.eq("kort_fjernet_kl", p.kort_fjernet_kl) : q.is("kort_fjernet_kl", null);
  const { data: gemt, error: gemFejl } = await q.select("user_id");
  if (gemFejl) throw new Error(`registrerGemtKort: ${gemFejl.message}`);
  if (!gemt?.length) {
    await fjernAfvistKort(profil.user_id, pmId);
    return false;
  }

  // Det tidligere gemte kort fjernes hos Stripe, så der kun er ét.
  if (profil.gemt_betalingsmetode_id) {
    try {
      await stripe.paymentMethods.detach(profil.gemt_betalingsmetode_id);
    } catch (err) {
      console.warn("Kunne ikke fjerne tidligere kort:", err);
    }
  }
  return true;
}

// Et kort fra et forsinket/afvist Stripe-svar fjernes (detach) hos Stripe, så
// det ikke bliver hængende på kunden. Aldrig det kort, profilen bruger nu
// (læses frisk). Kaster aldrig.
async function fjernAfvistKort(userId: string, pmId: string): Promise<void> {
  try {
    const { data, error } = await createAdminClient()
      .from("betalingsprofiler")
      .select("gemt_betalingsmetode_id")
      .eq("user_id", userId)
      .maybeSingle<{ gemt_betalingsmetode_id: string | null }>();
    if (error || !data || data.gemt_betalingsmetode_id === pmId) return;
    await getStripe().paymentMethods.detach(pmId);
  } catch (err) {
    console.warn("Kunne ikke fjerne afvist kort hos Stripe:", pmId, err instanceof Error ? err.message : err);
  }
}

// ------------------------------------------------------------------ Connect

// Markering af sælgerens udbetalingskonto til admin (/admin/betalinger).
// Teksten må aldrig indeholde beløb (medarbejdere ser den).
async function markerUdbetalingskonto(
  stripeAccountId: string,
  aarsag: string,
): Promise<void> {
  const nu = new Date().toISOString();
  const { error } = await createAdminClient()
    .from("betalingsprofiler")
    .update({
      connect_kraever_opmaerksomhed: true,
      connect_opmaerksomhed_aarsag: aarsag.slice(0, 500),
      connect_opmaerksomhed_kl: nu,
      opdateret: nu,
    })
    .eq("stripe_account_id", stripeAccountId);
  if (error) throw new Error(`markerUdbetalingskonto: ${error.message}`);
}

function erManglerKolonne(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === "42703" || err.code === "PGRST204");
}

// Spejler sælgerens Connect-konto (account.updated eller hentet direkte fra
// Stripe). Kald den med en FRISK konto (accounts.retrieve), så events i
// forkert rækkefølge giver den aktuelle status. Idempotent:
//   - "Din udbetalingskonto er klar" sendes én gang pr. sælger (første gang
//     overførsler og udbetalinger er aktive) - noegle connect_klar:<bruger>.
//   - "Stripe mangler oplysninger" sendes én gang pr. periode, hvor Stripe
//     mangler oplysninger efter indsendelse - noegle pr. connect_mangler_siden.
//   - En afvist konto (disabled_reason rejected.*) markeres til admin.
// En frakoblet konto (account.application.deauthorized) genaktiveres aldrig.
export async function spejlConnectKonto(konto: Stripe.Account): Promise<string | null> {
  const admin = createAdminClient();
  const { data: profil, error: profilFejl } = await admin
    .from("betalingsprofiler")
    .select("*")
    .eq("stripe_account_id", konto.id)
    .maybeSingle<ProfilRaekke>();
  if (profilFejl) throw new Error(`spejlConnectKonto: ${profilFejl.message}`);
  if (!profil) return null; // ikke en BidHamr-sælger
  const userId = profil.user_id;
  const frakoblet = !!profil.connect_frakoblet_kl;

  const krav = konto.requirements;
  const manglerNu = [...(krav?.currently_due ?? [])].sort();
  const forfaldne = [...(krav?.past_due ?? [])].sort();
  const spaerret = krav?.disabled_reason ?? null;
  const overfoersler = !frakoblet && konto.capabilities?.transfers === "active";
  const udbetalinger = !frakoblet && !!konto.payouts_enabled;
  const detaljer = !!konto.details_submitted;
  // Stripe mangler noget EFTER, at sælgeren har sendt sine oplysninger ind
  // (under selve opsætningen mangler der altid noget - det er ikke nyt).
  const mangler = detaljer && !frakoblet && (manglerNu.length > 0 || forfaldne.length > 0);
  const nu = new Date().toISOString();

  const basis = {
    connect_detaljer_indsendt: detaljer,
    connect_overfoersler_aktiv: overfoersler,
    connect_udbetalinger_aktiv: udbetalinger,
    opdateret: nu,
  };
  const { error } = await admin
    .from("betalingsprofiler")
    .update({
      ...basis,
      connect_mangler_nu: manglerNu,
      connect_mangler_forfaldne: forfaldne,
      connect_spaerret_aarsag: spaerret,
      ...(mangler ? {} : { connect_mangler_siden: null }),
    })
    .eq("user_id", userId);
  if (erManglerKolonne(error)) {
    // Migrationen 20261003060000 er ikke kørt endnu: spejl kun de tre felter.
    console.error("spejlConnectKonto: kør migrationen 20261003060000_connect_status.sql");
    const { error: e2 } = await admin.from("betalingsprofiler").update(basis).eq("user_id", userId);
    if (e2) throw new Error(`spejlConnectKonto: ${e2.message}`);
    return userId;
  }
  if (error) throw new Error(`spejlConnectKonto: ${error.message}`);

  // Klar til udbetaling første gang. Beskeden sendes FØR tidsstemplet sættes;
  // nøglen forhindrer dobbelt besked, hvis to events kører samtidig.
  if (overfoersler && udbetalinger && !profil.connect_klar_kl) {
    await send(userId, "udbetaling", {
      titel: "Din udbetalingskonto er klar",
      tekst:
        "Stripe har godkendt dine oplysninger. Når du sælger noget, udbetaler vores betalingspartner Stripe pengene til din bankkonto.",
      link: "/konto",
      // En ny konto efter admin-nulstilling får sin egen "klar"-besked.
      noegle: profil.connect_nulstillet_antal
        ? `connect_klar:${userId}:${profil.connect_nulstillet_antal}`
        : `connect_klar:${userId}`,
    });
    await admin
      .from("betalingsprofiler")
      .update({ connect_klar_kl: nu })
      .eq("user_id", userId)
      .is("connect_klar_kl", null);
  }

  // Stripe kræver nye oplysninger. connect_mangler_siden sættes atomisk
  // (kun hvis tom), så samtidige events bruger samme nøgle.
  if (mangler) {
    await admin
      .from("betalingsprofiler")
      .update({ connect_mangler_siden: nu })
      .eq("user_id", userId)
      .is("connect_mangler_siden", null);
    const { data: p2 } = await admin
      .from("betalingsprofiler")
      .select("connect_mangler_siden")
      .eq("user_id", userId)
      .maybeSingle<{ connect_mangler_siden: string | null }>();
    const siden = p2?.connect_mangler_siden;
    if (siden) {
      await send(userId, "udbetaling", {
        titel: "Stripe mangler oplysninger",
        tekst:
          "Vores betalingspartner Stripe skal bruge flere oplysninger fra dig, før dine penge kan udbetales. Fortsæt opsætningen under Min konto.",
        link: "/konto",
        noegle: `connect_mangler:${userId}:${siden}`,
      });
    }
  }

  // Stripe har afvist kontoen (fx svindel eller vilkår). Kun admin kan hjælpe.
  if (spaerret?.startsWith("rejected.") && profil.connect_spaerret_aarsag !== spaerret) {
    await markerUdbetalingskonto(
      konto.id,
      `Stripe har afvist sælgerens udbetalingskonto (${spaerret}). Overførsler kan ikke gennemføres.`,
    );
  }

  return userId;
}

// account.application.deauthorized: sælgeren har frakoblet/lukket sin
// Connect-konto. Profilen markeres (én gang), overførsler stoppes
// (overfoerTilSaelger tjekker connect_frakoblet_kl), og admin får en
// markering. Idempotent: kun første event ændrer noget.
export async function spejlFrakobling(stripeAccountId: string): Promise<string> {
  const admin = createAdminClient();
  const nu = new Date().toISOString();
  const { data, error } = await admin
    .from("betalingsprofiler")
    .update({
      connect_frakoblet_kl: nu,
      connect_overfoersler_aktiv: false,
      connect_udbetalinger_aktiv: false,
      connect_kraever_opmaerksomhed: true,
      connect_opmaerksomhed_aarsag:
        "Sælgeren har lukket eller frakoblet sin udbetalingskonto hos Stripe. Frigivne beløb kan ikke overføres.",
      connect_opmaerksomhed_kl: nu,
      opdateret: nu,
    })
    .eq("stripe_account_id", stripeAccountId)
    .is("connect_frakoblet_kl", null)
    .select("user_id")
    .maybeSingle<{ user_id: string }>();
  if (error) throw new Error(`spejlFrakobling: ${error.message}`);
  if (!data) return "ukendt_eller_allerede";

  await send(data.user_id, "udbetaling", {
    titel: "Din udbetalingskonto er lukket",
    tekst:
      "Din udbetalingskonto hos vores betalingspartner Stripe er lukket eller frakoblet BidHamr. Kontakt support@bidhamr.dk, hvis du har penge til gode eller vil sælge igen.",
    link: "/konto",
    noegle: `connect_frakoblet:${stripeAccountId}`,
  });
  return "frakoblet";
}

// payout.paid / payout.failed fra en Connect-konto. Udbetalingen hentes frisk
// hos Stripe som Connect-kontoen (en "paid" udbetaling kan senere fejle).
// Stripe udbetaler selv automatisk fra Connect-kontoen til sælgerens bank -
// BidHamr flytter ingen penge her og gemmer intet beløb.
export async function spejlUdbetaling(
  stripeAccountId: string,
  payoutId: string,
): Promise<string> {
  const admin = createAdminClient();
  const { data: profil, error } = await admin
    .from("betalingsprofiler")
    .select("user_id")
    .eq("stripe_account_id", stripeAccountId)
    .maybeSingle<{ user_id: string }>();
  if (error) throw new Error(`spejlUdbetaling: ${error.message}`);
  if (!profil) return "ukendt_konto";

  let payout: Stripe.Payout;
  try {
    payout = await getStripe().payouts.retrieve(payoutId, undefined, {
      stripeAccount: stripeAccountId,
    });
  } catch (err) {
    // Ingen adgang længere (kontoen er frakoblet): intet at gøre - et nyt
    // forsøg vil fejle igen. account.application.deauthorized markerer kontoen.
    if (err instanceof Stripe.errors.StripePermissionError) return "ingen_adgang";
    throw err;
  }

  if (payout.status === "failed") {
    await markerUdbetalingskonto(
      stripeAccountId,
      `Udbetaling til sælgerens bank fejlede hos Stripe (${payout.failure_code ?? "ukendt årsag"}, ${payout.id}). Sælger skal rette bankoplysningerne hos Stripe.`,
    );
    await send(profil.user_id, "udbetaling", {
      titel: "Udbetalingen til din bank fejlede",
      tekst:
        "Udbetalingen til din bank fejlede – tjek dine bankoplysninger hos Stripe. Du kan åbne din Stripe-oversigt under Min konto. Stripe prøver igen, når oplysningerne er rettet.",
      link: "/konto",
      noegle: `payout_fejlet:${payout.id}`,
    });
    return "fejlet";
  }

  if (payout.status === "paid") {
    await send(profil.user_id, "udbetaling", {
      titel: "Pengene er sendt til din bank",
      tekst:
        "Vores betalingspartner Stripe har sendt pengene til din bankkonto. Du kan se detaljerne i din Stripe-oversigt under Min konto.",
      link: "/konto",
      noegle: `payout_betalt:${payout.id}`,
    });
    return "betalt";
  }

  return payout.status;
}

// Engangs-link til sælgerens Express Dashboard hos Stripe (udbetalinger,
// bankkonto, saldo). Kaldes KUN med en id fra en verificeret session og kun
// for brugerens egen konto. Linket må ikke mailes - kun redirect med det samme.
export async function stripeOversigtLink(userId: string): Promise<string | null> {
  const profil = await hentProfil(userId);
  if (
    !profil?.stripe_account_id ||
    !profil.connect_detaljer_indsendt ||
    profil.connect_frakoblet_kl
  ) {
    return null;
  }
  const link = await getStripe().accounts.createLoginLink(profil.stripe_account_id);
  return link.url;
}

// overfoert: overført og står stadig hos sælgeren.
// tilbagefoert: Stripe har tilbageført overførslen (helt eller delvist).
// refunderet: køberen har fået pengene tilbage efter overførslen.
// indsigelse: køberens bank har en åben eller tabt indsigelse (chargeback).
export type OverfoerselStatus = "overfoert" | "tilbagefoert" | "refunderet" | "indsigelse";

export type Overfoersel = {
  handelId: string;
  titel: string;
  overfoertKl: string;
  beloebOere: number;
  status: OverfoerselStatus;
};

// Sælgerens egne overførsler fra BidHamr-handler til Connect-kontoen (spejl af
// betalinger.stripe_transfer_id). Service-role med eksplicit seller-filter:
// udbetaling_oere kan ikke læses med brugerens JWT. Kaldes KUN med en id fra
// en verificeret session.
// Stripe er sandheden: tilbageførte overførsler slås op hos Stripe (én liste
// pr. udbetalingskonto, nyeste 100). Fejler opslaget, bruges databasens status.
export async function hentOverfoersler(userId: string, antal = 50): Promise<Overfoersel[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("betalinger")
    .select(
      "trade_id, auction_id, udbetaling_oere, overfoert_kl, stripe_transfer_id, status, " +
        "refusion_anmodet_kl, indsigelse_kl, indsigelse_status",
    )
    .eq("seller_id", userId)
    .not("stripe_transfer_id", "is", null)
    .order("overfoert_kl", { ascending: false, nullsFirst: false })
    .limit(antal);
  if (error) throw new Error(`hentOverfoersler: ${error.message}`);
  const raekker = (data ?? []) as unknown as {
    trade_id: string;
    auction_id: string;
    udbetaling_oere: number;
    overfoert_kl: string | null;
    stripe_transfer_id: string;
    status: BetalingRaekke["status"];
    refusion_anmodet_kl: string | null;
    indsigelse_kl: string | null;
    indsigelse_status: string | null;
  }[];
  if (raekker.length === 0) return [];

  const tilbagefoert = new Set<string>();
  try {
    const profil = await hentProfil(userId);
    const konti = [
      ...new Set(
        [profil?.stripe_account_id, ...(profil?.connect_tidligere_konti ?? [])].filter(
          (k): k is string => !!k,
        ),
      ),
    ];
    const stripe = getStripe();
    for (const konto of konti) {
      const liste = await stripe.transfers.list({ destination: konto, limit: 100 });
      for (const t of liste.data) {
        if (t.reversed || t.amount_reversed > 0) tilbagefoert.add(t.id);
      }
    }
  } catch (err) {
    console.error("hentOverfoersler: tilbageførsler kunne ikke hentes hos Stripe:", err);
  }

  const auktionIds = [...new Set(raekker.map((r) => r.auction_id))];
  const { data: auktioner } = auktionIds.length
    ? await admin.from("auctions").select("id, titel").in("id", auktionIds)
    : { data: [] as { id: string; titel: string }[] };
  const titel = new Map((auktioner ?? []).map((a) => [a.id as string, a.titel as string]));
  return raekker.map((r) => {
    const status: OverfoerselStatus = tilbagefoert.has(r.stripe_transfer_id)
      ? "tilbagefoert"
      : r.status === "refunderet" || r.refusion_anmodet_kl
        ? "refunderet"
        : indsigelseBlokerer(r)
          ? "indsigelse"
          : "overfoert";
    return {
      handelId: r.trade_id,
      titel: titel.get(r.auction_id) ?? "Vare",
      overfoertKl: r.overfoert_kl ?? "",
      beloebOere: Number(r.udbetaling_oere),
      status,
    };
  });
}

// Betaling for en sælger med frakoblet konto. Markeres altid til admin
// (uanset saelgerkonto_markeret_kl - den kan være sat af påmindelserne om at
// oprette en konto), og cron stopper med at prøve: grænsen sættes ned til
// antal forsøg (overfoersel_opbrugt bliver sand). Tælleren røres ikke (den
// indgår i Stripes idempotency key). Nulstiller admin udbetalingskontoen
// (udbetalingskonto_nulstil), hæves grænsen igen, og account.updated for den
// nye konto overfører uanset grænsen. Filteret på overfoersel_forsoeg gør, at
// en samtidig nulstilling ikke overskrives med den gamle værdi.
async function markerFrakobletBetaling(b: BetalingRaekke): Promise<void> {
  const admin = createAdminClient();
  const nu = new Date().toISOString();
  const { error } = await admin
    .from("betalinger")
    .update({
      kraever_opmaerksomhed: true,
      sidste_fejl: "Sælgers udbetalingskonto er lukket eller frakoblet hos Stripe",
      overfoersel_graense: Math.min(b.overfoersel_graense, b.overfoersel_forsoeg),
      opdateret: nu,
    })
    .eq("id", b.id)
    .eq("overfoersel_forsoeg", b.overfoersel_forsoeg)
    .is("stripe_transfer_id", null);
  if (error) console.error("Markering (frakoblet sælgerkonto) fejlede:", b.id, error.message);
  const { error: e2 } = await admin
    .from("betalinger")
    .update({ saelgerkonto_markeret_kl: nu })
    .eq("id", b.id)
    .is("saelgerkonto_markeret_kl", null)
    .is("stripe_transfer_id", null);
  if (e2) console.error("Markering (frakoblet sælgerkonto) fejlede:", b.id, e2.message);
}

// Besked til sælgeren, når admin har nulstillet en lukket udbetalingskonto
// (udbetalingskonto_nulstil). Én gang pr. nulstilling. Kaster aldrig.
export async function sendUdbetalingskontoNulstillet(
  userId: string,
  nulstilletAntal: number,
): Promise<void> {
  try {
    await send(userId, "udbetaling", {
      titel: "Opret en ny udbetalingskonto",
      tekst:
        "Din lukkede udbetalingskonto er fjernet fra BidHamr. Opret en ny udbetalingskonto hos vores betalingspartner Stripe under Min konto. Har du penge til gode fra et salg, sendes de til den nye konto, når Stripe har godkendt den.",
      link: "/konto",
      noegle: `connect_nulstillet:${userId}:${nulstilletAntal}`,
    });
  } catch (err) {
    console.error("Besked om nulstillet udbetalingskonto fejlede:", userId, err);
  }
}

// Opretter (én gang) sælgerens Connect Express-konto og returnerer et
// onboarding-link. Kaldes KUN med en id fra en verificeret session (server
// action og GET /api/stripe/connect/onboarding).
// retur: hvor sælgeren sendes hen bagefter (fast liste - aldrig fri URL).
export type OnboardingRetur = "konto" | "opret-auktion";
export function erOnboardingRetur(v: unknown): v is OnboardingRetur {
  return v === "konto" || v === "opret-auktion";
}

export async function onboardingLink(
  userId: string,
  retur: OnboardingRetur = "konto",
): Promise<string> {
  const stripe = getStripe();
  await sikrStripeKunde(userId); // sikrer profilrækken
  let profil = await hentProfil(userId);
  if (profil?.connect_frakoblet_kl) {
    // Kontoen er frakoblet hos Stripe - et nyt onboarding-link virker ikke.
    throw new BetalingsFejl(
      "Din udbetalingskonto er lukket. Skriv til support@bidhamr.dk, så hjælper vi dig.",
    );
  }

  if (!profil?.stripe_account_id) {
    const { data: bruger } = await createAdminClient()
      .from("users")
      .select("email")
      .eq("id", userId)
      .single<{ email: string }>();

    const konto = await stripe.accounts.create(
      {
        type: "express",
        country: "DK",
        email: bruger?.email,
        business_type: "individual",
        // Separate charges and transfers: sælgeren modtager kun overførsler.
        capabilities: { transfers: { requested: true } },
        business_profile: {
          product_description: "Privat salg af brugte ting på BidHamr",
          // Stripe afviser http- og localhost-adresser som virksomheds-URL.
          // refresh_url/return_url maa gerne vaere http://localhost i testmode.
          url: offentligSideUrl(),
        },
        metadata: { bruger_id: userId },
      },
      // Efter en admin-nulstilling (udbetalingskonto_nulstil) skal der
      // oprettes en NY konto - med den gamle nøgle ville Stripe (inden for
      // 24 timer) svare med den gamle, frakoblede konto.
      {
        idempotencyKey: profil?.connect_nulstillet_antal
          ? `bidhamr-connect-${userId}-${profil.connect_nulstillet_antal}`
          : `bidhamr-connect-${userId}`,
      },
    );

    await createAdminClient()
      .from("betalingsprofiler")
      .update({ stripe_account_id: konto.id, opdateret: new Date().toISOString() })
      .eq("user_id", userId)
      .is("stripe_account_id", null);
    profil = await hentProfil(userId);
  }

  const link = await stripe.accountLinks.create({
    account: profil!.stripe_account_id!,
    refresh_url: sideUrl(
      retur === "konto" ? "/api/stripe/connect/onboarding" : `/api/stripe/connect/onboarding?retur=${retur}`,
    ),
    return_url: sideUrl(`/${retur}?stripe=retur`),
    type: "account_onboarding",
  });
  return link.url;
}

// ------------------------------------------------------------------ sælgerkonto

const DAG = 24 * 60 * 60 * 1000;

// Påmindelser til en sælger, der ikke har oprettet en udbetalingskonto:
// første mail med det samme ved frigivelse, derefter efter 3 og 7 dage (regnet
// fra frigivet_kl). Hver mail claimes atomisk før afsendelse. Efter 7 dage
// markeres betalingen til admin (én gang). Kaster aldrig - overførslen må ikke
// fejle pga. en mail.
async function paamindSaelgerkonto(b: BetalingRaekke): Promise<void> {
  try {
    if (!b.frigivet_kl) return;
    const admin = createAdminClient();
    const alder = Date.now() - new Date(b.frigivet_kl).getTime();

    if (alder >= 7 * DAG && !b.saelgerkonto_markeret_kl) {
      const nu = new Date().toISOString();
      const { error } = await admin
        .from("betalinger")
        .update({
          saelgerkonto_markeret_kl: nu,
          kraever_opmaerksomhed: true,
          sidste_fejl: "Sælger har ikke oprettet udbetalingskonto",
          opdateret: nu,
        })
        .eq("id", b.id)
        .is("saelgerkonto_markeret_kl", null)
        .is("stripe_transfer_id", null);
      if (error) console.error("Markering (sælgerkonto) fejlede:", b.id, error.message);
    }

    // Den seneste skyldige mail sendes; tidligere, ikke-sendte claimes samtidig,
    // så en kørsel efter nedetid ikke sender flere på én gang.
    const felter = [
      "saelgerkonto_mail_1_kl",
      "saelgerkonto_mail_2_kl",
      "saelgerkonto_mail_3_kl",
    ] as const;
    const trin = alder >= 7 * DAG ? 2 : alder >= 3 * DAG ? 1 : 0;
    if (b[felter[trin]]) return;

    const nu = new Date().toISOString();
    const opdatering: Record<string, string> = {};
    for (let i = 0; i <= trin; i++) if (!b[felter[i]]) opdatering[felter[i]] = nu;
    const { data: claimet, error } = await admin
      .from("betalinger")
      .update(opdatering)
      .eq("id", b.id)
      .is(felter[trin], null)
      .select("id");
    if (error) {
      console.error("Claim af sælgerkonto-mail fejlede:", b.id, error.message);
      return;
    }
    if (!claimet || claimet.length === 0) return;

    const { data: a } = await admin
      .from("auctions")
      .select("titel")
      .eq("id", b.auction_id)
      .maybeSingle();
    const titel = (a?.titel as string | undefined) ?? "din vare";
    await send(b.seller_id, "udbetaling", {
      titel: "Opret din udbetalingskonto",
      tekst: `Handlen om "${titel}" er afsluttet. Opret din udbetalingskonto hos vores betalingspartner Stripe, så du kan få pengene udbetalt.`,
      link: "/konto",
      data: { betaling_id: b.id },
      mail: saelgerOpretUdbetalingskontoMail(titel, Number(b.udbetaling_oere), trin > 0),
      noegle: `saelgerkonto:${b.id}:${trin}`,
    });
  } catch (err) {
    console.error("Påmindelse om udbetalingskonto fejlede:", b.id, err);
  }
}

// Admin: giv en fejlet overførsel nye forsøg og prøv med det samme.
// Kaldes kun fra en admin-server-action (assertRole).
export async function proevOverfoerselIgen(betalingId: string): Promise<string> {
  const { data, error } = await createAdminClient().rpc("betaling_overfoersel_nulstil", {
    p_betaling: betalingId,
  });
  if (error) throw new Error(`betaling_overfoersel_nulstil: ${error.message}`);
  if (!data) return "ikke_tilladt";
  const r = await overfoerTilSaelger(betalingId);
  // Markeringen ryddes først, når overførslen faktisk er gennemført.
  if (r === "overfoert" || r === "allerede_overfoert") {
    const { error: rydFejl } = await createAdminClient()
      .from("betalinger")
      .update({
        kraever_opmaerksomhed: false,
        sidste_fejl: null,
        opdateret: new Date().toISOString(),
      })
      .eq("id", betalingId)
      .not("stripe_transfer_id", "is", null);
    if (rydFejl) console.error("Rydning af markering efter overførsel fejlede:", betalingId, rydFejl.message);
  }
  return r;
}

// Admin/chef: giv en fejlet tilbagebetaling til køberen et nyt forsøg og prøv
// med det samme (én gang). Kaldes kun fra en admin-server-action; rolle og
// inhabilitet tjekkes igen i betaling_refusion_proev_igen.
//
// Først spørges Stripe om den seneste refusion: er den gennemført eller stadig
// i gang, gives der IKKE et nyt forsøg (så kunne der blive refunderet to gange).
// Kun en endeligt fejlet (failed/canceled) eller manglende refusion giver et
// nyt forsøg med ny idempotency key. refunderBetaling slår derefter alle
// refusioner på betalingen op hos Stripe, før en ny oprettes.
//
// Resultat: "ok:<resultat fra refunderBetaling>" eller en afvisningskode fra
// databasen (ingen_adgang, inhabil, ikke_fundet, allerede_refunderet,
// ikke_anmodet, ikke_bidhamr, overfoert, indsigelse, i_gang, aendret), eller
// "refunderet"/"refusion_afventer", hvis Stripe allerede har refusionen.
export async function proevRefusionIgen(
  betalingId: string,
  medarbejderId: string,
): Promise<string> {
  const b = await hentBetaling(betalingId);
  if (b.status === "refunderet") return "allerede_refunderet";
  if (!b.stripe_payment_intent_id) return "ikke_anmodet";

  if (b.stripe_refund_id) {
    const forrige = await getStripe().refunds.retrieve(b.stripe_refund_id);
    if (forrige.status === "succeeded") {
      // Kun hvis refusionen faktisk er BidHamrs egen og betalingen stadig er
      // claimet - registrerRefunderet er idempotent.
      if (b.refusion_anmodet_kl) await registrerRefunderet(b.stripe_payment_intent_id, forrige.id);
      return "refunderet";
    }
    if (forrige.status !== "failed" && forrige.status !== "canceled") {
      return "refusion_afventer";
    }
  }

  const { data, error } = await createAdminClient().rpc("betaling_refusion_proev_igen", {
    p_medarbejder: medarbejderId,
    p_betaling: betalingId,
    p_gammel_refund: b.stripe_refund_id,
  });
  if (error) throw new Error(`betaling_refusion_proev_igen: ${error.message}`);
  const kode = String((data as { kode?: string } | null)?.kode ?? "ukendt");
  if (kode !== "ok") return kode;

  return `ok:${await refunderBetaling(betalingId)}`;
}
