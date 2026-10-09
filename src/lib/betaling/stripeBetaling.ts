// Server-only: Stripe-kald for betalingen ("betal når du vinder").
// Må aldrig importeres i klientkode - bruger STRIPE_SECRET_KEY og service-role.
//
// Pengestrømmen (destination charges - den ENESTE model, trin 5; den gamle
// "separate charges and transfers" er fjernet):
//   1. Køberen betaler en PaymentIntent på sælgerens vegne: on_behalf_of =
//      transfer_data.destination = sælgerens Connect Express-konto,
//      application_fee_amount = BidHamrs gebyrer (købergebyr + sælgergebyr +
//      fragt + BidHamr Beskyttelse). transfer_group = handel_<id>.
//   2. Webhooken spejler payment_intent.succeeded og charge.* til tabellen
//      betalinger. Pengene (bud minus sælgergebyr) står på sælgerens konto,
//      som har manuel udbetalingsplan.
//   3. Når handlen er helt færdig, udbetaler BidHamr fra sælgerens konto til
//      banken (src/lib/betaling/udbetaling.ts). Refusioner og indsigelser:
//      src/lib/betaling/refusion.ts og indsigelse.ts.
//
// Alle kald, der flytter penge, har en idempotency key. Databasen spejler
// kun - Stripe er sandheden om penge. Alle beløb i øre.

import Stripe from "stripe";
import { getStripe, kraevSammeOffentligeNoegle, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { applicationFeeOere, totalOere } from "@/lib/betaling/beregn";
import { sendIndsigelseTilSaelger } from "@/lib/betaling/indsigelseBeskeder";
import { kontoSpejl, nyKontoParametre, sikrKontoopsaetning } from "@/lib/betaling/connect";
import { BetalingsmodelFejl, kraevDestination } from "@/lib/betaling/model";

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
  koeberBetalingPauseMail,
  saelgerBetalingPauseMail,
  saelgerBetaltAfhentningMail,
  saelgerBetaltMail,
  sideUrl,
} from "@/lib/mails/handel";
import { send } from "@/lib/notifikationer/send";
import {
  koeberKvittering,
  sendKoeberKvittering,
  sendRefusionForsinket,
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
  // Historik: automatisk betaling findes ikke længere (Filip, 9. okt. 2026).
  // Kolonnerne bevares (handelsdata), men skrives aldrig mere.
  autobetaling_forsoegt_kl: string | null;
  autobetaling_resultat: string | null;
  vundet_mail_sendt_kl: string | null;
  paamindelse_24_sendt_kl: string | null;
  paamindelse_40_sendt_kl: string | null;
  frigivet_kl: string | null;
  stripe_transfer_id: string | null;
  overfoert_kl: string | null;
  // 'destination' (alle nye betalinger - pengene står på sælgerens
  // Connect-konto). 'separat' findes kun på historiske rækker fra den gamle
  // model (arkiveret - kode afviser dem). 20261011010000/20261011050000.
  pengemodel?: "separat" | "destination";
  // Destination (20261011010000/20261011020000, valgfri indtil kørt).
  saelger_stripe_konto?: string | null;
  application_fee_oere?: number | null;
  stripe_destination_transfer_id?: string | null;
  midler_tilgaengelige_kl?: string | null;
  svindelvarsel_kl?: string | null;
  svindelvarsel_loest_kl?: string | null;
  // Trin 3 (udbetaling, 20261011030000): payout til sælgerens bank påbegyndt,
  // tidligste udbetaling (F02) og åbent Radar-review.
  saelger_udbetaling_id?: string | null;
  udbetal_tidligst?: string | null;
  radar_review_aaben?: boolean;
  indsigelse_tilbagefoersel_id?: string | null;
  // Betalingen venter på sælgerens konto (betal_senest = fristen for
  // kontoens godkendelse, ikke købers betalingsfrist).
  venter_paa_saelgerkonto_kl?: string | null;
  venter_aarsag?: string | null;
  // Hvornår en ventende betaling åbnede - betalingsfristen regnes herfra.
  betaling_aabnet_kl?: string | null;
  aabnet_besked_sendt_kl?: string | null;
  venter_paamindet_kl?: string | null;
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
// tabt indsigelse (chargeback) blokerer frigivelse og udbetaling.
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
  // Altid false (20261012020000_ingen_autobetaling.sql) - bruges ikke.
  autobetaling?: boolean;
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
  // Fra 20261011010000_betalingsmodel_fundament.sql (valgfri, indtil kørt).
  connect_charges_enabled?: boolean | null;
  connect_kort_aktiv?: boolean | null;
  connect_betalingsmetoder?: Record<string, string> | null;
  connect_udbetalingsplan?: string | null;
  connect_plan_ok?: boolean | null;
  // Fra 20261011020000: sælgeren er frosset (kontoen blev ikke godkendt i tide).
  saelger_frosset_kl?: string | null;
  // Fra 20261011030000: en udbetaling til sælgerens bank er fejlet ("venter
  // på bank").
  connect_udbetaling_fejlet_kl?: string | null;
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

// Stripe Customer til køberen (bruges til gemt kort og checkout).
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

// ------------------------------------------------------------------ destination

// Fejl, når betalingen venter på sælgerens Stripe-konto (betalingsmodel
// destination). Teksten må vises for køberen.
export const VENTER_TEKST =
  "Betalingen åbner, når sælgerens konto er godkendt hos vores betalingspartner Stripe. Du får besked, så snart du kan betale.";

export class BetalingVenterFejl extends Error {
  constructor() {
    super(VENTER_TEKST);
  }
}

export type KontoTjek = { ok: true } | { ok: false; aarsag: string };

// Frisk tjek af sælgerens Connect-konto hos Stripe, før der laves (eller
// betales) en destination-PaymentIntent: charges_enabled, card_payments aktiv
// og manuel udbetalingsplan (BidHamr udbetaler først, når handlen er helt
// færdig - Filip, ufravigeligt). Kontoen spejles samtidig (spejlConnectKonto
// sætter også en forkert plan tilbage til manual og giver drift-alarm).
// Står planen ikke til manual, stoppes betalingen (drift-alarm) - den
// åbner igen, når account.updated viser en manuel plan.
export async function kontrollerSaelgerkonto(kontoId: string): Promise<KontoTjek> {
  let konto: Stripe.Account;
  try {
    konto = await getStripe().accounts.retrieve(kontoId);
  } catch (err) {
    if (err instanceof Stripe.errors.StripePermissionError) {
      // Ingen adgang til kontoen lige nu: kan ikke tage imod betaling, og
      // staff får besked (ikke permanent - kun account.application.
      // deauthorized frakobler kontoen).
      await markerKontoUdenAdgang(kontoId);
      return { ok: false, aarsag: "konto_ingen_adgang" };
    }
    throw err;
  }
  const profilId = await spejlConnectKonto(konto);
  const { data: profil } = await createAdminClient()
    .from("betalingsprofiler")
    .select("connect_frakoblet_kl")
    .eq("stripe_account_id", kontoId)
    .maybeSingle<{ connect_frakoblet_kl: string | null }>();
  if (!profilId || profil?.connect_frakoblet_kl) return { ok: false, aarsag: "konto_frakoblet" };
  if (!konto.charges_enabled) return { ok: false, aarsag: "charges_disabled" };
  if (konto.capabilities?.card_payments !== "active") return { ok: false, aarsag: "card_payments_ikke_aktiv" };
  const plan = konto.settings?.payouts?.schedule?.interval ?? null;
  if (plan !== "manual") {
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/kontotjek",
      fejl: `Betaling stoppet: sælgerkonto ${kontoId} har udbetalingsplan '${plan ?? "ukendt"}' (skal være manual). Betalingen venter, til planen er manual.`,
      brugerId: profilId,
    });
    return { ok: false, aarsag: "plan_ikke_manual" };
  }
  return { ok: true };
}

// Stripe giver ingen adgang til sælgerens konto (StripePermissionError). Ikke
// permanent: kontoen kan ikke tage imod betaling (connect_charges_enabled =
// false, så betaling_kan_aabnes bliver falsk), staff får en markering og
// drift-alarm. Næste vellykkede spejling (account.updated / frisk hentning)
// retter tilstanden. Kun account.application.deauthorized frakobler kontoen.
export async function markerKontoUdenAdgang(kontoId: string): Promise<void> {
  const admin = createAdminClient();
  // Kun en konto, der stod til at kunne tage imod betaling, ændres - og kun
  // en ændret række giver markering og drift-alarm (ellers ville hvert kald
  // markere og alarmere igen).
  const { data, error } = await admin
    .from("betalingsprofiler")
    .update({ connect_charges_enabled: false, opdateret: new Date().toISOString() })
    .eq("stripe_account_id", kontoId)
    .is("connect_frakoblet_kl", null)
    .eq("connect_charges_enabled", true)
    .select("user_id")
    .maybeSingle<{ user_id: string }>();
  if (error && !erManglerKolonne(error)) throw new Error(`markerKontoUdenAdgang: ${error.message}`);
  if (!data) return;
  await markerUdbetalingskonto(
    kontoId,
    "Stripe giver ingen adgang til sælgerens udbetalingskonto. Betalinger kan ikke tages imod, før adgangen er tilbage - kontrollér kontoen hos Stripe.",
  );
  await logDriftFejl({
    kilde: "server",
    hvor: "connect/ingen-adgang",
    fejl: `Ingen adgang til sælgerkonto ${kontoId} hos Stripe - kan ikke tage imod betaling (ikke frakoblet).`,
    brugerId: data.user_id,
  });
}

// Sætter betalingen til at vente på sælgerens konto og kaster
// BetalingVenterFejl (betaling_saet_venter, 20261011020000). Har betalingen
// en PaymentIntent, annulleres den først hos Stripe (en gammel client_secret
// kan så ikke betales), og databasen fjerner den og tæller pi_forsoeg op, så
// der laves en ny, når betalingen åbner. Er den alligevel betalt eller under
// behandling, gives den tilbage (kalderen spejler den), og betalingen sættes
// ikke til at vente.
async function saetVenter(b: BetalingRaekke, aarsag: string): Promise<Stripe.PaymentIntent> {
  let annulleret: string | null = null;
  if (b.stripe_payment_intent_id) {
    const ikkeAnnulleret = await annullerAfventendePi(b.stripe_payment_intent_id);
    if (ikkeAnnulleret) return ikkeAnnulleret;
    annulleret = b.stripe_payment_intent_id;
  }
  const { data, error } = await createAdminClient().rpc("betaling_saet_venter", {
    p_betaling: b.id,
    p_aarsag: aarsag,
    p_annulleret_pi: annulleret,
  });
  if (error) throw new Error(`betaling_saet_venter: ${error.message}`);
  const svar = String(data);
  if (svar !== "venter" && svar !== "venter_ny_frist") {
    // Betalingen er ændret samtidig (fx betalt eller annulleret).
    throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
  }
  // Første gang en åben betaling venter: køber og sælger får fristen.
  if (svar === "venter_ny_frist") await beskedOmVenterFrist(b.id);
  throw new BetalingVenterFejl();
}

// En betaling, der var åben, venter nu på sælgerens konto. Køber og sælger
// får fristen (venter_frist). Kaster aldrig.
async function beskedOmVenterFrist(betalingId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: b } = await admin
      .from("betalinger")
      .select("trade_id, auction_id, buyer_id, seller_id, betal_senest")
      .eq("id", betalingId)
      .maybeSingle<{ trade_id: string; auction_id: string; buyer_id: string; seller_id: string; betal_senest: string }>();
    if (!b) return;
    const { data: a } = await admin.from("auctions").select("titel").eq("id", b.auction_id).maybeSingle();
    const titel = (a?.titel as string | undefined) ?? "din vare";
    const frist = new Date(b.betal_senest).toLocaleString("da-DK", {
      timeZone: "Europe/Copenhagen",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
    const link = `/mine-handler/${b.trade_id}`;
    await send(b.buyer_id, "betalingsfrist", {
      titel: "Betalingen er sat på pause",
      tekst: `Sælgerens konto hos vores betalingspartner Stripe kan ikke tage imod betaling lige nu, så du kan ikke betale for "${titel}" endnu. Vi giver dig besked, når du kan betale. Er kontoen ikke klar senest ${frist}, bliver handlen annulleret, og du bliver ikke trukket noget.`,
      link,
      data: { trade_id: b.trade_id },
      mail: koeberBetalingPauseMail(titel, b.trade_id, b.betal_senest),
      noegle: `venter_frist:${betalingId}:koeber`,
    });
    await send(b.seller_id, "udbetaling", {
      titel: "Din konto kan ikke tage imod betaling",
      tekst: `Køberen kan ikke betale for "${titel}", fordi din konto hos Stripe ikke kan tage imod betaling lige nu. Ret det under Min konto senest ${frist} – ellers bliver handlen annulleret.`,
      link: "/konto",
      data: { trade_id: b.trade_id },
      mail: saelgerBetalingPauseMail(titel, b.betal_senest),
      noegle: `venter_frist:${betalingId}:saelger`,
    });
  } catch (err) {
    console.error("Besked om ventefrist fejlede:", betalingId, err);
  }
}

// PaymentIntents, der kan annulleres, når betalingen skal vente (ingen penge
// er trukket).
const ANNULLERBARE: Stripe.PaymentIntent.Status[] = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
];

// Annullerer en afventende PaymentIntent, når betalingen skal vente på
// sælgerens konto. Returnerer null, når den er annulleret, ellers
// PaymentIntenten (fx succeeded/processing - så annulleres der ikke, og den
// spejles).
async function annullerAfventendePi(piId: string): Promise<Stripe.PaymentIntent | null> {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId);
  if (pi.status === "canceled") return null;
  if (!ANNULLERBARE.includes(pi.status)) return pi;
  try {
    await stripe.paymentIntents.cancel(
      piId,
      { cancellation_reason: "abandoned" },
      // Uændret nøgle fra trin 2 (samme annullering må ikke få en ny nøgle).
      { idempotencyKey: `bidhamr-skift-annuller-${piId}` },
    );
    return null;
  } catch (err) {
    const igen = await stripe.paymentIntents.retrieve(piId);
    if (igen.status === "canceled") return null;
    if (igen.status === "succeeded" || igen.status === "processing") return igen;
    throw err;
  }
}

// Købers leveringsvalg ændrer fragten (checkout før betaling): den gemte
// PaymentIntent annulleres hos Stripe, før databasen nulstiller den
// (handel_gem_levering, pi_forsoeg + 1). Svar: 'annulleret' (eller var det
// allerede) | 'betalt' (succeeded/processing - spejlet, beløbet må ikke ændres).
export async function annullerPaymentIntentForLevering(
  piId: string,
): Promise<"annulleret" | "betalt"> {
  const pi = await annullerAfventendePi(piId);
  if (!pi) return "annulleret";
  if (pi.status === "succeeded" || pi.status === "processing") {
    await spejlPaymentIntent(pi);
    return "betalt";
  }
  throw new Error(`PaymentIntent ${piId} kunne ikke annulleres (${pi.status})`);
}

async function harGyldigtLeveringsvalg(b: BetalingRaekke): Promise<boolean> {
  if (Number(b.fragt_oere) <= 0) return true;
  const { data, error } = await createAdminClient()
    .from("handel_levering")
    .select("fragt_oere")
    .eq("trade_id", b.trade_id)
    .maybeSingle<{ fragt_oere: number }>();
  if (error) throw new Error(`handel_levering: ${error.message}`);
  return data !== null && Number(data.fragt_oere) === Number(b.fragt_oere);
}

// Låser sælgerkonto og gebyr i databasen før en PaymentIntent
// (betaling_klargoer_destination).
async function klargoerDestination(b: BetalingRaekke, konto: string): Promise<BetalingRaekke> {
  const { data, error } = await createAdminClient().rpc("betaling_klargoer_destination", {
    p_betaling: b.id,
    p_konto: konto,
    p_gammel_pi: null,
  });
  if (error) throw new Error(`betaling_klargoer_destination: ${error.message}`);
  const svar = String(data);
  if (svar === "venter") throw new BetalingVenterFejl();
  if (svar !== "klar" && svar !== "har_pi") {
    // ikke_afventer / konto_aendret / ikke_destination: noget ændrede sig
    // samtidig (eller en historisk række fra den gamle model).
    throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
  }
  return hentBetaling(b.id);
}

// En historisk betaling fra den gamle model (separat) kan ikke betales,
// udbetales eller refunderes automatisk længere (trin 5). Drift-alarm, så
// staff ser den. Kaster aldrig.
// Én alarm pr. betaling og sted (drift_tilfaelde).
export async function alarmGammelModel(betalingId: string, hvor: string): Promise<void> {
  const { alarmPrTilfaelde } = await import("@/lib/betaling/driftTilfaelde");
  await alarmPrTilfaelde({
    noegle: `gammel-model:${hvor}:${betalingId}`,
    hvor: "betaling/gammel-model",
    fejl: `${hvor}: betaling ${betalingId} er fra den gamle betalingsmodel (separat), som er fjernet - intet sendt til Stripe. Håndtér den manuelt i Stripe.`,
  });
}

// ------------------------------------------------------------------ PaymentIntent

// Opretter (én gang) PaymentIntenten for en betaling. Beløbet er altid det,
// databasen har beregnet - aldrig noget fra klienten.
//
// Destination (den eneste model): on_behalf_of = transfer_data.destination =
// sælgerens Connect-konto, application_fee_amount = BidHamrs gebyrer
// (købergebyr + sælgergebyr + fragt + BidHamr Beskyttelse, inkl. moms).
// Sælgerkontoen tjekkes FRISK hos Stripe først; er den ikke klar, venter
// betalingen (BetalingVenterFejl).
//
// Vagter: er databasen ikke migreret til destination (stripe_tilstand), eller
// er betalingen en historisk række fra den gamle model, oprettes INGEN
// PaymentIntent (BetalingsFejl + drift-alarm) - der faldes aldrig tilbage.
export async function sikrPaymentIntent(
  betaling: BetalingRaekke,
  forsoeg = 0,
): Promise<Stripe.PaymentIntent> {
  const stripe = getStripe();
  const beloeb = Number(betaling.total_oere);
  try {
    await kraevDestination();
    await kraevSammeOffentligeNoegle();
  } catch (err) {
    if (err instanceof BetalingsmodelFejl || err instanceof StripeTilstandFejl) {
      throw new BetalingsFejl(new BetalingsmodelFejl().message);
    }
    throw err;
  }
  if (betaling.pengemodel !== "destination") {
    await alarmGammelModel(betaling.id, "Betaling");
    throw new BetalingsFejl("Betalingen kunne ikke startes. Skriv til support@bidhamr.dk, så hjælper vi dig.");
  }
  if (betaling.venter_paa_saelgerkonto_kl) throw new BetalingVenterFejl();
  // Ingen betaling uden leveringsvalg (databasen håndhæver det også ved nye
  // PaymentIntents: betalinger_kraev_levering). En PaymentIntent fra før
  // checkout (intet gyldigt valg) annulleres og nulstilles, så køberen skal
  // vælge levering først; er den allerede betalt/i gang, gives den tilbage
  // (kalderen spejler den).
  if (!(await harGyldigtLeveringsvalg(betaling))) {
    if (betaling.stripe_payment_intent_id) {
      const ikkeAnnulleret = await annullerAfventendePi(betaling.stripe_payment_intent_id);
      if (ikkeAnnulleret) return ikkeAnnulleret;
      const { error: nFejl } = await createAdminClient().rpc("betaling_nulstil_annulleret_pi", {
        p_betaling: betaling.id,
        p_pi: betaling.stripe_payment_intent_id,
      });
      if (nFejl) throw new Error("betaling_nulstil_annulleret_pi: " + nFejl.message);
    }
    throw new LeveringManglerFejl();
  }

  if (betaling.stripe_payment_intent_id) {
    // Frisk kontotjek, også før en eksisterende PaymentIntent betales.
    const tjek = await kontrollerSaelgerkonto(betaling.saelger_stripe_konto!);
    if (!tjek.ok) return saetVenter(betaling, tjek.aarsag);
    const eksisterende = await stripe.paymentIntents.retrieve(
      betaling.stripe_payment_intent_id,
    );
    // Annulleret hos Stripe, mens betalingen afventer (fx uden for BidHamr):
    // fjern den (pi_forsoeg + 1) og lav en ny.
    if (eksisterende.status === "canceled" && betaling.status === "afventer") {
      const { data: nulstillet, error: nFejl } = await createAdminClient().rpc(
        "betaling_nulstil_annulleret_pi",
        { p_betaling: betaling.id, p_pi: eksisterende.id },
      );
      if (nFejl) throw new Error(`betaling_nulstil_annulleret_pi: ${nFejl.message}`);
      if (nulstillet !== true) throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
      return sikrPaymentIntent(await hentBetaling(betaling.id));
    }
    // Sikkerhedsnet for PaymentIntents oprettet før beskyttelsen blev låst ved
    // buddet: beløbet bringes i trit med databasens total. Klienten har
    // aldrig indflydelse på beløbet. Gebyret følger med.
    const fee = Number(betaling.application_fee_oere);
    if (
      (eksisterende.amount !== beloeb || eksisterende.application_fee_amount !== fee) &&
      OPDATERBARE.includes(eksisterende.status)
    ) {
      return stripe.paymentIntents.update(eksisterende.id, {
        amount: beloeb,
        application_fee_amount: fee,
        metadata: { beskyttelse: betaling.beskyttelse ? "ja" : "nej" },
      });
    }
    return eksisterende;
  }
  if (totalOere(betaling, betaling.beskyttelse) !== beloeb) {
    // Databasen og TS-beregningen er uenige - betal aldrig et forkert beløb.
    throw new Error(`Beløb stemmer ikke for betaling ${betaling.id}`);
  }

  const klar = await klargoerSaelgerkonto(betaling);
  if ("pi" in klar) return klar.pi;
  const b = klar.b;
  const fee = Number(b.application_fee_oere);
  if (
    b.pengemodel !== "destination" ||
    !b.saelger_stripe_konto ||
    !Number.isInteger(fee) ||
    fee < 0 ||
    fee !== applicationFeeOere(b) ||
    beloeb - fee !== Number(b.udbetaling_oere)
  ) {
    throw new Error(`Gebyr eller sælgerkonto stemmer ikke for betaling ${b.id}`);
  }

  const kunde = await sikrStripeKunde(b.buyer_id);

  // PaymentIntenten oprettes én gang med det fulde beløb fra databasen
  // (bud + købergebyr + fragt + evt. BidHamr Beskyttelse valgt ved buddet).
  // pi_forsoeg > 0 betyder, at en tidligere PaymentIntent er kasseret (fx
  // afvigende beløb, eller betalingen har ventet på sælgerens konto) - så
  // skal der en ny key til, ellers giver Stripe den gamle tilbage.
  const nøgle = `bidhamr-pi-dest-${b.id}-${b.pi_forsoeg}`;
  const pi = await stripe.paymentIntents.create(
    {
      amount: beloeb,
      currency: b.valuta,
      customer: kunde,
      // Kort, MobilePay, Apple Pay, Google Pay - styres fra Stripe Dashboard.
      automatic_payment_methods: { enabled: true },
      transfer_group: `handel_${b.trade_id}`,
      description: `BidHamr handel ${b.trade_id}`,
      on_behalf_of: b.saelger_stripe_konto,
      transfer_data: { destination: b.saelger_stripe_konto },
      application_fee_amount: fee,
      metadata: {
        betaling_id: b.id,
        handel_id: b.trade_id,
        auktion_id: b.auction_id,
        koeber_id: b.buyer_id,
        beskyttelse: b.beskyttelse ? "ja" : "nej",
        pengemodel: "destination",
      },
    },
    { idempotencyKey: nøgle },
  );

  // Gemmes kun, hvis beløb, gebyr og forsøg stadig er dem, PaymentIntenten
  // blev lavet med (købers leveringsvalg kan have ændret fragten imens -
  // handel_gem_levering tæller altid pi_forsoeg op).
  const admin = createAdminClient();
  const { data: gemtRaekker, error: gemFejl } = await admin
    .from("betalinger")
    .update({ stripe_payment_intent_id: pi.id, opdateret: new Date().toISOString() })
    .eq("id", b.id)
    .is("stripe_payment_intent_id", null)
    .eq("pi_forsoeg", b.pi_forsoeg)
    .eq("total_oere", beloeb)
    .eq("application_fee_oere", fee)
    .select("id");
  if (gemFejl && /levering_mangler/.test(gemFejl.message)) {
    // Databasens værn: intet gyldigt leveringsvalg. Vores PaymentIntent må
    // aldrig kunne betales.
    await stripe.paymentIntents.cancel(pi.id).catch((err: unknown) => {
      console.error("Kunne ikke annullere PaymentIntent uden leveringsvalg:", pi.id, err);
    });
    throw new LeveringManglerFejl();
  }
  if (gemFejl) {
    // PaymentIntenten findes hos Stripe, men er ikke gemt. Næste kald får den
    // samme tilbage via idempotency key'en (24 t). Betal aldrig en intent,
    // databasen ikke kender.
    console.error("Kunne ikke gemme PaymentIntent:", b.id, pi.id, gemFejl.message);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Kunne ikke gemme PaymentIntent", fejl: gemFejl });
    throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
  }

  const efter = await hentBetaling(b.id);
  if ((gemtRaekker ?? []).length === 0 && !efter.stripe_payment_intent_id) {
    // Beløbet eller forsøget er ændret, mens PaymentIntenten blev lavet:
    // annullér den og lav en ny med det nye beløb (højst 2 gange).
    try {
      await stripe.paymentIntents.cancel(pi.id);
    } catch (err) {
      await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "Forældet PaymentIntent ikke annulleret", fejl: err });
      throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
    }
    if (forsoeg >= 2) throw new BetalingsFejl("Betalingen kunne ikke startes. Prøv igen om lidt.");
    return sikrPaymentIntent(efter, forsoeg + 1);
  }
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

// Før en ny PaymentIntent (betalingen har ingen): sælgerens konto tjekkes
// frisk, og sælgerkonto + gebyr låses på betalingen. Venter betalingen,
// kastes BetalingVenterFejl (saetVenter); { pi } kun hvis saetVenter fandt en
// betalt/igangværende PaymentIntent (spejles af kalderen).
async function klargoerSaelgerkonto(
  b: BetalingRaekke,
): Promise<{ b: BetalingRaekke } | { pi: Stripe.PaymentIntent }> {
  const profil = await hentProfil(b.seller_id);
  const konto = profil?.stripe_account_id ?? null;
  if (!konto) return { pi: await saetVenter(b, "ingen_saelgerkonto") };
  const tjek = await kontrollerSaelgerkonto(konto);
  if (!tjek.ok) return { pi: await saetVenter(b, tjek.aarsag) };
  return { b: await klargoerDestination(b, konto) };
}

const OPDATERBARE: Stripe.PaymentIntent.Status[] = [
  "requires_payment_method",
  "requires_confirmation",
];

// Fejl, hvis tekst må vises for brugeren.
export class BetalingsFejl extends Error {}

// Fragt kræver købers leveringsvalg, før der kan betales (Filip 9. okt. 2026).
// Klassen står efter BetalingsFejl (klasser hoistes ikke).
export const LEVERING_MANGLER_TEKST = "Vælg levering, før du betaler.";
export class LeveringManglerFejl extends BetalingsFejl {
  readonly kode = "vaelg_levering";
  constructor() {
    super(LEVERING_MANGLER_TEKST);
  }
}

function chargeId(pi: Stripe.PaymentIntent): string | null {
  if (!pi.latest_charge) return null;
  return typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
}

// Spejler en PaymentIntent fra Stripe ind i databasen. Bruges af webhooken og
// når køberen vender tilbage fra betalingen. Idempotent.
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
    // Destination: spejl transfer, gebyr og hvornår pengene er tilgængelige
    // på sælgerens konto (charge.succeeded/updated gør det også).
    if (pi.transfer_data?.destination && chargeId(pi)) {
      try {
        await spejlDestinationCharge(chargeId(pi)!);
      } catch (err) {
        console.error("Spejling af destination-charge fejlede (webhook prøver igen):", pi.id, err);
      }
    }
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
    // Nøglen sikrer, at webhook + retur fra betaling ikke giver
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

// ------------------------------------------------------------------ gemt kort i checkout

// Ingen automatisk betaling (Filip, 9. okt. 2026): vinderen betaler ALTID
// selv på checkout-siden. Et gemt kort bruges kun til at forudfylde
// betalingen - det trækkes først, når køberen selv trykker Betal (on-session,
// stripe.confirmPayment i Payment Element; 3D Secure vises, hvis banken
// kræver det).
//
// Payment Element viser kun kundens gemte kort med en CustomerSession
// (components.payment_element.features.payment_method_redisplay = enabled), og
// kun kort med allow_redisplay = 'always' (standardfilteret). Kortet er gemt
// af brugeren selv under Min konto ("Gem kort"), så det markeres 'always' her,
// hvis det ikke allerede er det (kort gemt før denne ændring).
//   - Kun brugerens ENE gemte kort (betalingsprofiler.gemt_betalingsmetode_id),
//     og kun hvis det sidder på samme Stripe-kunde som PaymentIntenten.
//   - Fjern og gem i checkout er slået fra: kortet styres kun fra Min konto,
//     så databasen altid er i trit.
// Returnerer CustomerSessionens client_secret (til Elements-optionen
// customerSessionClientSecret) eller null. Kaster aldrig - uden sessionen kan
// køberen stadig betale med et nyt kort, MobilePay osv.
export async function kundeSessionTilCheckout(
  koeberId: string,
  pi: Stripe.PaymentIntent,
): Promise<string | null> {
  try {
    const kunde = typeof pi.customer === "string" ? pi.customer : (pi.customer?.id ?? null);
    if (!kunde) return null;
    const profil = await hentProfil(koeberId);
    if (!profil?.gemt_betalingsmetode_id || profil.stripe_customer_id !== kunde) return null;

    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(profil.gemt_betalingsmetode_id);
    const pmKunde = typeof pm.customer === "string" ? pm.customer : (pm.customer?.id ?? null);
    if (pmKunde !== kunde) return null; // fjernet hos Stripe i mellemtiden
    if (pm.allow_redisplay !== "always") {
      await stripe.paymentMethods.update(pm.id, { allow_redisplay: "always" });
    }

    // Ingen penge flyttes - en CustomerSession giver kun Payment Element
    // adgang til at vise kortet (kortlivet client_secret).
    const session = await stripe.customerSessions.create({
      customer: kunde,
      components: {
        payment_element: {
          enabled: true,
          features: {
            payment_method_redisplay: "enabled",
            payment_method_redisplay_limit: 1,
            payment_method_remove: "disabled",
            payment_method_save: "disabled",
          },
        },
      },
    });
    return session.client_secret;
  } catch (err) {
    console.warn("Gemt kort kunne ikke vises i checkout:", err instanceof Error ? err.message : err);
    await logDriftFejl({ kilde: "action", sti: "betaling", hvor: "kundeSessionTilCheckout", fejl: err, brugerId: koeberId });
    return null;
  }
}

// ------------------------------------------------------------------ refusion

// Refusion af en betaling hos Stripe. Fuld, medmindre refusion_oere er sat
// (sag med medhold: alt undtagen BidHamr Beskyttelse). Kræver, at refusionen allerede er
// claimet i databasen (refusion_anmodet_kl - sat af betaling_paabegynd_refusion
// eller af betaling_registrer_betalt ved sen betaling / afvigende beløb), så
// en udbetaling til sælger aldrig kan ske samtidig.
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
// under låsen (højst ca. 12 Stripe-kald med destination-trinnene i
// refusion.ts: refusion, PaymentIntent, refusionsliste, charge, indsigelser,
// saldo x2, gebyr-refusion, tilbageførsel, opslag og refusion) tager dermed
// højst ca. 8-9 minutter, og låsen (betaling_refusion_laas) varer 15
// minutter - den udløber ikke, mens et kald stadig er i gang. Genforsøg sker
// med samme idempotency key. Et trin registreres kun, mens låsen holdes
// (betaling_refusion_trin) - ellers stopper forsøget.
const UNDER_LAAS: Stripe.RequestOptions = { timeout: 20_000, maxNetworkRetries: 1 };

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
async function markerRefusionskonflikt(
  betalingId: string,
  laas: string,
  besked = "Anden refusion fundet hos Stripe - kontrollér betalingen, før der refunderes igen",
): Promise<void> {
  const { error } = await createAdminClient().rpc("betaling_refusion_konflikt", {
    p_betaling: betalingId,
    p_noegle: laas,
    p_besked: besked,
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
  // Pengene står på sælgerens Connect-konto. Refusionen (fuld og delvis)
  // laves efter en låst refusionsplan i tre eksakte trin
  // (src/lib/betaling/refusion.ts): BidHamrs gebyr tilbage til sælgerens
  // konto, tilbageførsel fra sælgerens konto, refusion til køberen fra
  // platformen - ellers ville BidHamr betale køberen af sin egen saldo, mens
  // sælgeren beholdt pengene. En betaling fra den gamle model (separat, uden
  // transfer_data) refunderes ikke automatisk længere (trin 5) - staff.
  const destination = !!pi.transfer_data?.destination;
  if (!destination || b.pengemodel !== "destination") {
    await markerRefusionskonflikt(
      b.id,
      laas,
      b.pengemodel !== "destination"
        ? "Betalingen er fra den gamle betalingsmodel - refunderes ikke automatisk. Refundér den manuelt i Stripe"
        : "Betalingens pengemodel passer ikke med Stripe - refusion stoppet",
    );
    if (b.pengemodel !== "destination") await alarmGammelModel(b.id, "Refusion");
    return "refusion_konflikt";
  }

  // Idempotency keys hos Stripe udløber efter 24 timer, og et nyt forsøg har
  // en ny key. Slå derfor ALLE refusioner på PaymentIntenten op, før en ny
  // oprettes (samme mønster som payouts-opslaget i udbetaling.ts). Kun
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
      // Trin (a) gebyr og (b) tilbageførsel - kun det, der mangler hos Stripe.
      const { forberedDestinationRefusion } = await import("@/lib/betaling/refusion");
      const klar = await forberedDestinationRefusion(b, laas, forsoeg, maal, UNDER_LAAS);
      if (klar.kode === "indsigelse") {
        // Banken afgør pengene (cron prøver ikke, mens indsigelsen er åben).
        await markerRefusion(b.id, "Refusion venter: køberen har lavet en indsigelse hos sin bank");
        return "refusion_afventer";
      }
      if (klar.kode === "konflikt") {
        await markerRefusionskonflikt(b.id, laas, klar.besked);
        return "refusion_konflikt";
      }
    }
    if (!refund) {
      refund = await stripe.refunds.create(
        {
          payment_intent: piId,
          // Destination: altid det eksakte beløb fra planen; pengene er
          // allerede hentet tilbage til platformen (trin a og b).
          amount: maal,
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

  // Pengene tages tilbage fra sælgerens konto, og gebyret gives tilbage
  // (hele den kasserede betaling). En PaymentIntent fra den gamle model (uden
  // transfer_data) refunderes ikke automatisk længere - staff (trin 5).
  const piAfv = await stripe.paymentIntents.retrieve(paymentIntentId);
  if (!piAfv.transfer_data?.destination) {
    await admin
      .from("betaling_afvigelser")
      .update({
        sidste_fejl: "Fra den gamle betalingsmodel - refunderes ikke automatisk. Refundér den manuelt i Stripe.",
        opdateret: new Date().toISOString(),
      })
      .eq("id", a.id);
    await alarmGammelModel(a.betaling_id, "Refusion af afvigende beløb");
    return "gammel_model";
  }
  let refund: Stripe.Refund | null = null;
  try {
    refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reverse_transfer: true,
        refund_application_fee: true,
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
  // Destination (trin 4): sælgeren skal stå med 0 på handlen bagefter - også
  // når refusionen er lavet i Stripe-dashboardet. Kaster aldrig.
  if (String(data) === "refunderet") {
    const { kontrollerDestinationRefusion } = await import("@/lib/betaling/refusion");
    await kontrollerDestinationRefusion(paymentIntentId);
  }
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
  // Markeres til admin og blokerer udbetaling (refusion_anmodet_kl sættes).
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
// indsigelse blokerer frigivelse og udbetaling og markeres til admin. Er den
// vundet/lukket, prøves en ventende udbetaling med det samme.
export async function spejlIndsigelse(disputeId: string): Promise<string> {
  const stripe = getStripe();
  let d: Stripe.Dispute = await stripe.disputes.retrieve(disputeId);
  const piId =
    typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
  const chId = typeof d.charge === "string" ? d.charge : d.charge.id;
  // Har chargen flere indsigelser, spejles den "værste" (tabt før åben før
  // afgjort til BidHamrs fordel) - ikke blot den sidst spejlede (trin 4).
  {
    const alle = await stripe.disputes.list({ charge: chId, limit: 10 });
    const rang = (st: string) => (st === "lost" ? 3 : ["won", "warning_closed", "prevented"].includes(st) ? 1 : 2);
    for (const x of alle.data) if (rang(x.status) > rang(d.status)) d = x;
  }
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
  // Destination (trin 4): beviser lægges klar ved en åben indsigelse; en tabt
  // indsigelse før udbetaling henter beløbet tilbage fra sælgerens konto, og
  // køberen får besked om at sende varen retur. Kaster aldrig.
  if (resultat === "blokeret" || resultat === "tabt") {
    const { efterIndsigelseDestination } = await import("@/lib/betaling/indsigelse");
    await efterIndsigelseDestination(d, resultat);
  }
  if (resultat === "afsluttet" && piId) {
    const { data: b } = await createAdminClient()
      .from("betalinger")
      .select("id")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle<{ id: string }>();
    if (b) {
      try {
        // Udbetaling til sælgerens bank (udbetaling.ts).
        const { pengeTilSaelger } = await import("@/lib/betaling/udbetaling");
        await pengeTilSaelger(b.id);
      } catch (err) {
        console.error("Udbetaling efter afsluttet indsigelse fejlede (cron prøver igen):", err);
      }
    }
  }
  return resultat;
}

// ------------------------------------------------------------------ destination: charge

type DestinationRaekke = {
  id: string;
  pengemodel: string;
  total_oere: number;
  application_fee_oere: number | null;
  saelger_stripe_konto: string | null;
  stripe_destination_transfer_id: string | null;
  stripe_application_fee_id: string | null;
  stripe_destination_payment_id: string | null;
  midler_tilgaengelige_kl: string | null;
};

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Spejler en destination-charge (charge.succeeded/charge.updated, eller
// efter betalt): Stripes automatiske transfer til sælgerens konto, BidHamrs
// application fee og hvornår pengene er "available" på sælgerens konto
// (destination_payment -> balance_transaction.available_on - trin 3 bruger
// det før udbetaling). Kontrollerer, at beløb, gebyr og konto er som låst i
// databasen; ellers drift-alarm og markering til staff. Flytter ingen penge.
// Idempotent.
export async function spejlDestinationCharge(chargeIdArg: string): Promise<string> {
  const stripe = getStripe();
  const admin = createAdminClient();
  const charge = await stripe.charges.retrieve(chargeIdArg);
  const piId = stripeId(charge.payment_intent);
  const konto = stripeId(charge.transfer_data?.destination ?? null);
  if (!piId || !konto) return "ikke_destination";

  const { data: b, error } = await admin
    .from("betalinger")
    .select(
      "id, pengemodel, total_oere, application_fee_oere, saelger_stripe_konto, stripe_destination_transfer_id, stripe_application_fee_id, stripe_destination_payment_id, midler_tilgaengelige_kl",
    )
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle<DestinationRaekke>();
  if (error) throw new Error(`spejlDestinationCharge: ${error.message}`);
  if (!b) return "ukendt";
  if (charge.status !== "succeeded") return charge.status;

  const afvigelser: string[] = [];
  if (b.pengemodel !== "destination") afvigelser.push("betalingen er ikke destination i databasen");
  if (b.saelger_stripe_konto !== konto) afvigelser.push("anden sælgerkonto end låst");
  if (Number(charge.amount) !== Number(b.total_oere)) afvigelser.push("beløb");
  if (b.application_fee_oere === null || Number(charge.application_fee_amount ?? -1) !== Number(b.application_fee_oere)) {
    afvigelser.push("application fee");
  }

  const transferId = stripeId(charge.transfer as string | Stripe.Transfer | null);
  const feeId = stripeId(charge.application_fee as string | Stripe.ApplicationFee | null);
  let destPaymentId: string | null = null;
  let tilgaengelig: string | null = null;
  if (transferId) {
    const tr = await stripe.transfers.retrieve(transferId);
    destPaymentId = stripeId(tr.destination_payment as string | Stripe.Charge | null);
    if (Number(tr.amount) !== Number(charge.amount)) afvigelser.push("transfer-beløb");
    if (stripeId(tr.destination as string | Stripe.Account) !== konto) afvigelser.push("transfer-konto");
    if (destPaymentId) {
      const py = await stripe.charges.retrieve(
        destPaymentId,
        { expand: ["balance_transaction"] },
        { stripeAccount: konto },
      );
      const bt = py.balance_transaction;
      if (bt && typeof bt !== "string" && bt.available_on) {
        tilgaengelig = new Date(bt.available_on * 1000).toISOString();
      }
    }
  }

  if (b.pengemodel === "destination") {
    const { error: e2 } = await admin
      .from("betalinger")
      .update({
        stripe_destination_transfer_id: b.stripe_destination_transfer_id ?? transferId,
        stripe_application_fee_id: b.stripe_application_fee_id ?? feeId,
        stripe_destination_payment_id: b.stripe_destination_payment_id ?? destPaymentId,
        midler_tilgaengelige_kl: tilgaengelig ?? b.midler_tilgaengelige_kl,
        opdateret: new Date().toISOString(),
      })
      .eq("id", b.id)
      .eq("pengemodel", "destination");
    if (e2) throw new Error(`spejlDestinationCharge: ${e2.message}`);
    if (b.stripe_destination_transfer_id && transferId && b.stripe_destination_transfer_id !== transferId) {
      afvigelser.push("anden transfer end spejlet");
    }
  }

  if (afvigelser.length) {
    const tekst = `Destination-betaling afviger fra databasen (${afvigelser.join(", ")}) - kontrollér betalingen i Stripe. Pengene udbetales ikke automatisk.`;
    // Én alarm pr. betaling (spejlingen gentages af webhooks og cron).
    const { alarmPrTilfaelde } = await import("@/lib/betaling/driftTilfaelde");
    await alarmPrTilfaelde({
      noegle: `destination-charge:${b.id}`,
      hvor: "betaling/destination-charge",
      fejl: `${tekst} Charge ${charge.id}.`,
    });
    await admin
      .from("betalinger")
      .update({ kraever_opmaerksomhed: true, sidste_fejl: tekst, opdateret: new Date().toISOString() })
      .eq("id", b.id);
    return "afviger";
  }
  return transferId ? "spejlet" : "ingen_transfer";
}

// ------------------------------------------------------------------ tidligt svindelvarsel

// radar.early_fraud_warning.created/updated (Filip 8. okt. 2026): INGEN
// automatisk refusion. Betalingen markeres til staff under Betalinger, og
// pengene gives ikke til sælger, før staff har lukket markeringen
// (svindelvarsel_loest_kl - trin 3's
// betaling_udbetaling_blokeret). Varslet hentes frisk hos Stripe.
export async function spejlSvindelvarsel(varselId: string): Promise<string> {
  const v = await getStripe().radar.earlyFraudWarnings.retrieve(varselId);
  const { data, error } = await createAdminClient().rpc("betaling_registrer_svindelvarsel", {
    p_payment_intent: stripeId(v.payment_intent ?? null),
    p_charge: stripeId(v.charge),
    p_varsel: v.id,
    p_type: v.fraud_type ?? "",
  });
  if (error) throw new Error(`betaling_registrer_svindelvarsel: ${error.message}`);
  const resultat = String(data);
  if (resultat === "ukendt") {
    console.error("Svindelvarsel på ukendt betaling:", v.id, stripeId(v.charge));
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
export async function markerUdbetalingskonto(
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
  const status = {
    ...basis,
    connect_mangler_nu: manglerNu,
    connect_mangler_forfaldne: forfaldne,
    connect_spaerret_aarsag: spaerret,
    ...(mangler ? {} : { connect_mangler_siden: null }),
  };
  // Destination-felterne (20261011010000). En frakoblet konto kan ikke tage
  // imod betaling, uanset hvad Stripe siger.
  const spejl = kontoSpejl(konto);
  if (frakoblet) {
    spejl.connect_charges_enabled = false;
    spejl.connect_kort_aktiv = false;
  }
  let { error } = await admin
    .from("betalingsprofiler")
    .update({ ...status, ...spejl })
    .eq("user_id", userId);
  if (erManglerKolonne(error)) {
    // Migrationen 20261011010000 er ikke kørt endnu: spejl uden de nye felter.
    ({ error } = await admin.from("betalingsprofiler").update(status).eq("user_id", userId));
  }
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
      `Stripe har afvist sælgerens udbetalingskonto (${spaerret}). Betalinger og udbetalinger kan ikke gennemføres.`,
    );
  }

  if (!frakoblet) await kontrollerUdbetalingsplan(konto.id, profil, spejl.connect_udbetalingsplan);

  return userId;
}

// Niels F01: udbetalingsplanen på sælgerens konto SKAL være manual (BidHamr
// udbetaler, når handlen er afsluttet). Står den til andet, sættes den
// tilbage hos Stripe, og der gives drift-alarm. Kaster aldrig (spejlingen må
// ikke fejle pga. kontrollen).
async function kontrollerUdbetalingsplan(
  kontoId: string,
  profil: ProfilRaekke,
  plan: string | null,
): Promise<void> {
  if (plan === "manual") return;
  try {
    const rettet = await getStripe().accounts.update(kontoId, {
      settings: { payouts: { schedule: { interval: "manual" } } },
    });
    const nyPlan = rettet.settings?.payouts?.schedule?.interval ?? null;
    await createAdminClient()
      .from("betalingsprofiler")
      .update({ connect_udbetalingsplan: nyPlan, connect_plan_ok: nyPlan === "manual" })
      .eq("user_id", profil.user_id);
    await logDriftFejl({
      kilde: "server",
      hvor: "connect/udbetalingsplan",
      fejl: `Sælgerkonto ${kontoId} havde udbetalingsplan '${plan ?? "ukendt"}' - sat tilbage til '${nyPlan ?? "ukendt"}' (kræver manual).`,
      brugerId: profil.user_id,
    });
  } catch (err) {
    console.error("kontrollerUdbetalingsplan fejlede:", kontoId, err);
    // Én alarm pr. konto (hvert account.updated ville ellers alarmere igen).
    // Betalinger og udbetalinger stoppes alligevel (connect_plan_ok = false).
    const { alarmPrTilfaelde } = await import("@/lib/betaling/driftTilfaelde");
    await alarmPrTilfaelde({
      noegle: `plan-fejl:${kontoId}`,
      hvor: "connect/udbetalingsplan",
      fejl: `Sælgerkonto ${kontoId} står ikke til manuel udbetaling, og den kunne ikke sættes tilbage: ${err instanceof Error ? err.message : String(err)}`,
      brugerId: profil.user_id,
    });
  }
}

// account.application.deauthorized: sælgeren har frakoblet/lukket sin
// Connect-konto. Profilen markeres (én gang), betalinger og udbetalinger
// stoppes (connect_frakoblet_kl - kontrollerSaelgerkonto og
// betaling_udbetaling_blokeret), og admin får en markering. Idempotent: kun
// første event ændrer noget.
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
        "Sælgeren har lukket eller frakoblet sin udbetalingskonto hos Stripe. Beløb på kontoen kan ikke udbetales af BidHamr - kontrollér kontoen i Stripe.",
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

// payout.paid / payout.failed / payout.canceled fra en Connect-konto.
// Udbetalingen hentes frisk hos Stripe som Connect-kontoen. BidHamrs egne
// udbetalinger spejles i saelger_udbetalinger (udbetaling.ts). En payout,
// BidHamr IKKE har lavet, må ikke forekomme (sælgerkontoen har manuel plan, og
// kun BidHamr udbetaler): den kan have sendt penge fra handler, der ikke er
// færdige, til banken - drift-alarm og markering til staff (én gang pr.
// payout). Sælgeren får ingen besked om den.
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

  const { spejlBidhamrPayout } = await import("@/lib/betaling/udbetaling");
  const bidhamr = await spejlBidhamrPayout(stripeAccountId, payout);
  if (bidhamr !== null) return bidhamr;

  const { alarmPrTilfaelde } = await import("@/lib/betaling/driftTilfaelde");
  const ny = await alarmPrTilfaelde({
    noegle: `fremmed-payout:${payout.id}`,
    hvor: "betaling/fremmed-udbetaling",
    fejl: `Udbetaling ${payout.id} (status '${payout.status}') fra sælgerkonto ${stripeAccountId} er IKKE lavet af BidHamr. Sælgerkonti skal stå til manuel udbetaling, og kun BidHamr udbetaler - kontrollér kontoen og saldoen i Stripe.`,
    brugerId: profil.user_id,
  });
  if (ny) {
    await markerUdbetalingskonto(
      stripeAccountId,
      `Stripe har lavet en udbetaling fra sælgerens konto, som BidHamr ikke har lavet (${payout.id}). Kontrollér kontoen og saldoen i Stripe.`,
    );
  }
  return `fremmed_${payout.status}`;
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
        "Din lukkede udbetalingskonto er fjernet fra BidHamr. Opret en ny udbetalingskonto hos vores betalingspartner Stripe under Min konto. Har du penge til gode fra et salg, kontakter vi dig om dem.",
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

  const { data: bruger } = await createAdminClient()
    .from("users")
    .select("email, konto_type")
    .eq("id", userId)
    .single<{ email: string; konto_type: string | null }>();
  const erFirma = bruger?.konto_type === "erhverv";

  if (!profil?.stripe_account_id) {
    const konto = await stripe.accounts.create(
      // card_payments + transfers + MobilePay, firma/privat, manuel plan,
      // MCC/url/descriptor - src/lib/betaling/connect.ts.
      nyKontoParametre({ userId, email: bruger?.email, erFirma, url: offentligSideUrl() }),
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
  } else {
    // Eksisterende konto: anmod om det, der mangler (fx card_payments), og
    // sæt manuel plan, så onboarding-linket også samler de oplysninger ind.
    // Fejl her må ikke stoppe onboardingen.
    try {
      await sikrKontoopsaetning(stripe, profil.stripe_account_id, {
        erFirma,
        url: offentligSideUrl(),
      });
    } catch (err) {
      console.error("sikrKontoopsaetning fejlede:", profil.stripe_account_id, err);
      await logDriftFejl({ kilde: "server", hvor: "connect/kontoopsaetning", fejl: err, brugerId: userId });
    }
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
