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
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { totalOere } from "@/lib/betaling/beregn";

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
  saelgerBetaltMail,
  saelgerOpretUdbetalingskontoMail,
  sideUrl,
} from "@/lib/mails/handel";
import { send } from "@/lib/notifikationer/send";

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
    const { data: a } = await admin.from("auctions").select("titel").eq("id", b.auction_id).single();
    const titel = (a?.titel as string | undefined) ?? "din vare";
    // Nøglen sikrer, at webhook + autobetaling + retur fra betaling ikke giver
    // flere beskeder for samme handel.
    await send(b.seller_id, "betaling_modtaget", {
      titel: "Køberen har betalt",
      tekst: `Køberen har betalt for "${titel}". Send varen, og indtast sporingsnummeret på handelssiden.`,
      link: `/mine-handler/${b.trade_id}`,
      data: { trade_id: b.trade_id },
      mail: saelgerBetaltMail(titel, b.trade_id),
      noegle: `betalt:${b.trade_id}`,
    });
  } catch (err) {
    console.error("Mail om modtaget betaling fejlede:", err);
  }
}

// ------------------------------------------------------------------ autobetaling

// Forsøger at trække vinderens gemte kort off-session. Kører højst én gang
// pr. betaling (atomisk claim i databasen + idempotency key hos Stripe).
// Fejler det (fx 3D Secure kræves), står PaymentIntenten tilbage som
// requires_payment_method, og køberen betaler selv inden for 24 timer med
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
    // tilbage til den almindelige 24-timers betaling.
    const kode =
      err instanceof Stripe.errors.StripeError
        ? (err.code ?? err.decline_code ?? err.type)
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

  const profil = await hentProfil(b.seller_id);
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
// Idempotent: idempotency key pr. betaling og forsøg, og en allerede refunderet
// charge behandles som gennemført. Status 'refunderet' spejles af webhooken
// (charge.refunded) - og her med det samme, hvis Stripe svarer "succeeded".
export async function refunderBetaling(betalingId: string): Promise<string> {
  const admin = createAdminClient();
  const b = await hentBetaling(betalingId);
  if (b.status === "refunderet") return "allerede_refunderet";
  if (!b.refusion_anmodet_kl) throw new Error("Refusion er ikke claimet.");
  if (b.stripe_transfer_id || b.overfoersel_paabegyndt_kl) {
    throw new Error("Betalingen er overført til sælger - refusion afvist.");
  }
  if (!b.stripe_payment_intent_id) throw new Error("Ingen PaymentIntent at refundere.");

  const stripe = getStripe();

  // Findes der allerede en refusion, oprettes der kun en ny, hvis den forrige
  // endeligt er failed/canceled. Så tælles forsøget op (atomisk), og den nye
  // refusion får en ny idempotency key - ellers ville Stripe bare returnere
  // den fejlede refusion igen.
  let forsoeg = b.refusion_forsoeg;
  if (b.stripe_refund_id) {
    const forrige = await stripe.refunds.retrieve(b.stripe_refund_id);
    if (forrige.status === "succeeded") {
      await registrerRefunderet(b.stripe_payment_intent_id, forrige.id);
      return "refunderet";
    }
    if (forrige.status !== "failed" && forrige.status !== "canceled") {
      return "refusion_afventer"; // pending/requires_action - vent på Stripe
    }
    const { data: n, error } = await admin.rpc("betaling_refusion_nyt_forsoeg", {
      p_betaling: b.id,
      p_gammel_refund: forrige.id,
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
    await admin
      .from("betalinger")
      .update({
        kraever_opmaerksomhed: true,
        sidste_fejl: "Refusionsbeløbet er ugyldigt - refusion stoppet",
        opdateret: new Date().toISOString(),
      })
      .eq("id", b.id);
    throw new Error(`Ugyldigt refusionsbeløb for betaling ${b.id}`);
  }

  // Idempotency keys hos Stripe udløber efter 24 timer. Tjek derfor først,
  // om en refusion for denne betaling allerede findes (samme mønster som
  // transfers.list i overfoerTilSaelger) - ellers kunne et forsøg efter 24 t
  // (fx cron efter nedetid) give en ekstra delvis refusion oveni. Kun
  // refusioner, der ikke er endeligt fejlet, genbruges.
  const eksisterende = await stripe.refunds.list({
    payment_intent: b.stripe_payment_intent_id,
    limit: 100,
  });
  let refund: Stripe.Refund | null =
    eksisterende.data.find(
      (r) =>
        r.metadata?.betaling_id === b.id && r.status !== "failed" && r.status !== "canceled",
    ) ?? null;
  try {
    if (!refund) {
      refund = await stripe.refunds.create(
        {
          payment_intent: b.stripe_payment_intent_id,
          ...(delvis !== null ? { amount: delvis } : {}),
          reason: "requested_by_customer",
          metadata: {
            betaling_id: b.id,
            handel_id: b.trade_id,
            aarsag: b.refusion_aarsag ?? "",
          },
        },
        { idempotencyKey: nøgle },
      );
    }
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === "charge_already_refunded") {
      refund = null; // allerede refunderet - spejles nedenfor
    } else {
      await admin
        .from("betalinger")
        .update({
          kraever_opmaerksomhed: true,
          sidste_fejl: `Refusion fejlede: ${
            err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt"
          }`,
          opdateret: new Date().toISOString(),
        })
        .eq("id", b.id);
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
      await admin
        .from("betalinger")
        .update({
          kraever_opmaerksomhed: true,
          sidste_fejl: `Refusion ${refund.status} hos Stripe`,
          opdateret: new Date().toISOString(),
        })
        .eq("id", b.id);
      return `refusion_${refund.status}`;
    }
    if (refund.status === "succeeded") {
      await registrerRefunderet(b.stripe_payment_intent_id, refund.id);
      return "refunderet";
    }
    return "refusion_afventer"; // pending: charge.refunded/refund.updated følger
  }

  const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, {
    expand: ["latest_charge"],
  });
  const charge = pi.latest_charge;
  if (charge && typeof charge !== "string" && charge.refunded) {
    await registrerRefunderet(b.stripe_payment_intent_id, null);
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

// Cron: sagsrefusioner, der er claimet (sag_claim_refusion), men hvor kaldet
// til Stripe fejlede eller aldrig blev lavet (fx serveren døde midt i
// afgørelsen). Kun betalinger, der er claimet for mindst 10 minutter siden,
// så cron ikke kører samtidig med afgørelsen. refunderBetaling er idempotent
// (idempotency key + eksisterende refund tjekkes først).
export async function refunderSagerVentende(): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("betalinger")
    .select("id")
    .eq("status", "betalt")
    .eq("refusion_aarsag", "sag")
    .not("refusion_anmodet_kl", "is", null)
    .lt("refusion_anmodet_kl", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .is("stripe_transfer_id", null)
    .is("overfoersel_paabegyndt_kl", null)
    .lt("refusion_forsoeg", 5)
    .limit(50);
  if (error) {
    console.error("Hentning af ventende sagsrefusioner fejlede:", error.message);
    return 0;
  }
  let antal = 0;
  for (const { id } of (data ?? []) as { id: string }[]) {
    try {
      if ((await refunderBetaling(id)) === "refunderet") antal++;
    } catch (err) {
      console.error("Sagsrefusion fejlede (prøves igen):", id, err);
    }
  }
  return antal;
}

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
    if (b.status === "refunderet") return "allerede_refunderet";
    // En gammel, fejlet refusion, der allerede er erstattet af et nyt forsøg.
    if (b.stripe_refund_id && b.stripe_refund_id !== refund.id) return "erstattet";
    const { error } = await admin.rpc("betaling_marker_opmaerksomhed", {
      p_payment_intent: piId,
      p_besked: besked,
    });
    if (error) throw new Error(`betaling_marker_opmaerksomhed: ${error.message}`);
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

  const stripe = getStripe();
  const pm = await stripe.paymentMethods.retrieve(pmId);
  const kort = pm.card;

  await admin
    .from("betalingsprofiler")
    .update({
      gemt_betalingsmetode_id: pmId,
      gemt_kort_maerke: kort?.brand ?? pm.type,
      gemt_kort_sidste4: kort?.last4 ?? null,
      gemt_kort_udloeb: kort ? `${String(kort.exp_month).padStart(2, "0")}/${kort.exp_year}` : null,
      opdateret: new Date().toISOString(),
    })
    .eq("user_id", profil.user_id);

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

// ------------------------------------------------------------------ Connect

export async function spejlConnectKonto(konto: Stripe.Account): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("betalingsprofiler")
    .update({
      connect_detaljer_indsendt: !!konto.details_submitted,
      connect_overfoersler_aktiv: konto.capabilities?.transfers === "active",
      connect_udbetalinger_aktiv: !!konto.payouts_enabled,
      opdateret: new Date().toISOString(),
    })
    .eq("stripe_account_id", konto.id)
    .select("user_id")
    .maybeSingle<{ user_id: string }>();
  return data?.user_id ?? null;
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
      { idempotencyKey: `bidhamr-connect-${userId}` },
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
