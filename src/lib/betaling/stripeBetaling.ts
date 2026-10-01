// Server-only: Stripe-kald for den nye betalingsmodel ("betal når du vinder").
// Må aldrig importeres i klientkode - bruger STRIPE_SECRET_KEY og service-role.
//
// Pengestrømmen ("separate charges and transfers", manuelle udbetalinger):
//   1. Køberen betaler en PaymentIntent på BidHamrs platformskonto
//      (ingen transfer_data / on_behalf_of). transfer_group = handel_<id>.
//   2. Webhooken spejler payment_intent.succeeded til tabellen betalinger.
//   3. Ved frigivelse oprettes en Transfer til sælgerens Connect Express-konto
//      på udbetaling_oere (bud minus 5% sælgergebyr) med
//      source_transaction = chargen.
//
// Alle kald, der flytter penge, har en idempotency key. Databasen spejler
// kun - Stripe er sandheden om penge. Alle beløb i øre.

import Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { totalOere } from "@/lib/betaling/beregn";
import { getResend } from "@/lib/resend";
import {
  HANDEL_AFSENDER,
  saelgerBetaltMail,
  sideUrl,
} from "@/lib/mails/handel";

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
};

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
  if (betaling.stripe_payment_intent_id) {
    return stripe.paymentIntents.retrieve(betaling.stripe_payment_intent_id);
  }

  const kunde = await sikrStripeKunde(betaling.buyer_id);

  // PaymentIntenten oprettes altid UDEN beskyttelse; beskyttelsen lægges på
  // bagefter med en update. Så er parametrene ens ved et gentaget kald, og
  // idempotency key'en giver præcis samme PaymentIntent tilbage.
  const basis = totalOere(betaling, false);
  const pi = await stripe.paymentIntents.create(
    {
      amount: basis,
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
        beskyttelse: "nej",
      },
    },
    { idempotencyKey: `bidhamr-pi-${betaling.id}` },
  );

  const admin = createAdminClient();
  await admin
    .from("betalinger")
    .update({ stripe_payment_intent_id: pi.id, opdateret: new Date().toISOString() })
    .eq("id", betaling.id)
    .is("stripe_payment_intent_id", null);

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

// Sætter BidHamr Beskyttelse til/fra på en ikke-betalt PaymentIntent.
// Stripe opdateres FØRST; databasen spejler bagefter.
export async function saetBeskyttelse(
  betaling: BetalingRaekke,
  pi: Stripe.PaymentIntent,
  beskyttelse: boolean,
): Promise<Stripe.PaymentIntent> {
  const nyTotal = totalOere(betaling, beskyttelse);
  const harBeskyttelse = pi.metadata?.beskyttelse === "ja";
  if (pi.amount === nyTotal && harBeskyttelse === beskyttelse) return pi;

  if (!OPDATERBARE.includes(pi.status)) {
    throw new BetalingsFejl(
      "Betalingen er allerede i gang og kan ikke ændres lige nu.",
    );
  }

  const opdateret = await getStripe().paymentIntents.update(pi.id, {
    amount: nyTotal,
    metadata: { beskyttelse: beskyttelse ? "ja" : "nej" },
  });

  const { data, error } = await createAdminClient().rpc("betaling_saet_beskyttelse", {
    p_betaling: betaling.id,
    p_beskyttelse: beskyttelse,
  });
  if (error) throw new Error(`betaling_saet_beskyttelse: ${error.message}`);
  if (Number(data) !== nyTotal) {
    throw new Error(`Beløb afviger efter beskyttelse: db=${data} stripe=${nyTotal}`);
  }
  return opdateret;
}

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
      console.error("KRITISK: betalt beløb stemmer ikke med betalingen:", pi.id);
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
    const resend = getResend();
    if (!resend) return;
    const [{ data: a }, { data: s }] = await Promise.all([
      admin.from("auctions").select("titel").eq("id", b.auction_id).single(),
      admin.from("users").select("email").eq("id", b.seller_id).single(),
    ]);
    if (!s?.email) return;
    const mail = saelgerBetaltMail(a?.titel ?? "din vare", b.trade_id);
    await resend.emails.send({
      from: HANDEL_AFSENDER,
      to: s.email,
      subject: mail.subject,
      html: mail.html,
    });
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
  if (b.status !== "betalt" || !b.frigivet_kl || !b.stripe_charge_id) {
    return "ikke_klar";
  }
  if (b.udbetaling_oere <= 0) return "intet_at_overfoere";

  const profil = await hentProfil(b.seller_id);
  if (!profil?.stripe_account_id || !profil.connect_overfoersler_aktiv) {
    // Sælgeren har ikke en aktiv udbetalingskonto endnu. Overførslen laves,
    // når account.updated viser, at kontoen er klar (webhook/cron).
    return "afventer_saelgerkonto";
  }

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
    transfer = await stripe.transfers.create(
      {
        amount: b.udbetaling_oere,
        currency: b.valuta,
        destination: profil.stripe_account_id,
        source_transaction: b.stripe_charge_id,
        description: `BidHamr handel ${b.trade_id}`,
        metadata: {
          betaling_id: b.id,
          handel_id: b.trade_id,
          saelger_id: b.seller_id,
        },
      },
      { idempotencyKey: `bidhamr-overfoersel-${b.id}` },
    );
  }

  await createAdminClient()
    .from("betalinger")
    .update({
      stripe_transfer_id: transfer.id,
      overfoert_kl: new Date().toISOString(),
      opdateret: new Date().toISOString(),
    })
    .eq("id", b.id)
    .is("stripe_transfer_id", null);

  return "overfoert";
}

// Prøver alle frigivne, ikke-overførte betalinger for en sælger (eller alle).
export async function overfoerVentende(saelgerId?: string): Promise<number> {
  let q = createAdminClient()
    .from("betalinger")
    .select("id")
    .eq("status", "betalt")
    .not("frigivet_kl", "is", null)
    .is("stripe_transfer_id", null)
    .limit(100);
  if (saelgerId) q = q.eq("seller_id", saelgerId);
  const { data } = await q;
  let antal = 0;
  for (const { id } of data ?? []) {
    try {
      if ((await overfoerTilSaelger(id)) === "overfoert") antal++;
    } catch (err) {
      console.error("Overførsel til sælger fejlede:", id, err);
    }
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
export async function onboardingLink(userId: string): Promise<string> {
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
          url: sideUrl("/"),
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
    refresh_url: sideUrl("/api/stripe/connect/onboarding"),
    return_url: sideUrl("/konto?stripe=retur"),
    type: "account_onboarding",
  });
  return link.url;
}
