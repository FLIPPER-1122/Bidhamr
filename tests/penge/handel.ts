// Hjælpere til pengetestene: opret en TEST-handel, betal den med et Stripe-
// testkort, lever webhooks (signeret som Stripe), frigiv, udbetal og ryd op.
//
// Alt går gennem den rigtige kode i src/ (server actions, webhook-ruten,
// cron-trinnene) mod testdatabasen og Stripes testmiljø. Kun opsætningen af
// selve handlen (auktion, handel, leveringsvalg og betalingsrække) skrives
// direkte med service role - det samme, som afslut_udloebne_auktioner og
// checkout gør - så testene ikke afhænger af budgivning og timing.
import { koebergebyrOere, saelgergebyrOere } from "@/lib/betaling/beregn";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { inject } from "vitest";
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, STRIPE_API_VERSION } from "@/lib/stripe";
import { POST as webhookPOST } from "@/app/api/webhooks/stripe/route";
import { spejlConnectKonto } from "@/lib/betaling/stripeBetaling";
import { CHEF_ID, KOEBER, SAELGER, type PengeBruger } from "./brugere";
import { logIndSom } from "./session";

export const admin = () => createAdminClient();
export const stripe = () => getStripe();

export function kontekst() {
  return inject("penge");
}

export function kontoFor(saelger: PengeBruger): string {
  const k = kontekst().konti[saelger.id];
  if (!k) throw new Error(`Ingen testkonto for ${saelger.email}`);
  return k;
}

// Sælgerens Connect-konto spejles med den rigtige kode (som account.updated),
// og 14-dages-intervallet nulstilles for testsælgeren (se nedenfor).
export async function forberedSaelger(saelger: PengeBruger = SAELGER): Promise<string> {
  const konto = kontoFor(saelger);
  const a = await stripe().accounts.retrieve(konto);
  const bruger = await spejlConnectKonto(a);
  if (bruger !== saelger.id) throw new Error(`Spejlet af ${konto} gav ${bruger}, ikke ${saelger.id}`);
  await nulstilUdbetalingsinterval(saelger);
  return konto;
}

const DAG_MS = 24 * 60 * 60_000;

// Udbetaling hver 14. dag (20261031010000/20261031020000): de faste
// testsælgere får en payout i mange scenarier - i samme kørsel og i kørsler
// med under 14 dages mellemrum - så intervallet ville blokere næste scenarie.
// KUN TESTDATABASEN: testsælgerens payouts (oprettet/paid) fra de seneste 15
// dage flyttes 15 dage tilbage i tiden (saelger_udbetalinger.oprettet).
// Payouts slettes aldrig (handelsdata), status og beløb røres ikke, og
// afstemningen finder dem stadig via payout-id'et. En payout, der stadig står
// som 'oprettet', afsluttes først, som Stripe har den (payout-webhooken), så
// overvågningen ikke ser en hængende udbetaling.
export async function nulstilUdbetalingsinterval(saelger: PengeBruger): Promise<void> {
  if (!String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("pjiigmzqwlfepxnjdvug")) {
    throw new Error("nulstilUdbetalingsinterval: kun testdatabasen");
  }
  const db = admin();
  const graense = new Date(Date.now() - 15 * DAG_MS).toISOString();
  type Raekke = { id: string; status: string; oprettet: string; stripe_konto: string; stripe_payout_id: string | null };
  const { data, error } = await db
    .from("saelger_udbetalinger")
    .select("id, status, oprettet, stripe_konto, stripe_payout_id")
    .eq("seller_id", saelger.id)
    .in("status", ["oprettet", "paid"])
    .gt("oprettet", graense)
    .overrideTypes<Raekke[], { merge: false }>();
  if (error) throw new Error(`nulstilUdbetalingsinterval: ${error.message}`);
  for (const u of data ?? []) {
    if (u.status === "oprettet" && u.stripe_payout_id) {
      try {
        const p = await ventPaaPayout(u.stripe_konto, u.stripe_payout_id, 60_000);
        if (p.status === "paid" || p.status === "failed" || p.status === "canceled") {
          await sendWebhook(`payout.${p.status}`, p as unknown as { id: string }, { konto: u.stripe_konto });
        }
      } catch (err) {
        // Fx en gammel testkonto uden adgang: payouten flyttes alligevel (testdata).
        console.error("nulstilUdbetalingsinterval: payout kunne ikke afsluttes", u.id, err);
      }
    }
    const { error: oFejl } = await db
      .from("saelger_udbetalinger")
      .update({ oprettet: new Date(new Date(u.oprettet).getTime() - 15 * DAG_MS).toISOString() })
      .eq("id", u.id);
    if (oFejl) throw new Error(`nulstilUdbetalingsinterval: ${oFejl.message}`);
  }
  const { data: naeste, error: nFejl } = await db.rpc("saelger_naeste_udbetaling_kl", { p_saelger: saelger.id });
  if (nFejl) throw new Error(`saelger_naeste_udbetaling_kl: ${nFejl.message}`);
  if (typeof naeste === "string" && new Date(naeste).getTime() > Date.now()) {
    throw new Error(`Testsælgeren ${saelger.email} har stadig ventetid til ${naeste}`);
  }
}

// Lille pakkeshop (fragt_pakkestoerrelser, 20261031010000: 42 kr.).
export const PAKKESHOP_FRAGT_OERE = 4200;

// De beløb, en privat TEST-handel skal ende med (ny prismodel - samme formler
// som databasen, src/lib/betaling/beregn.ts). Øre.
//   total = bud + købergebyr + fragt (BidHamr Beskyttelse er i gebyret)
//   gebyr (application fee) = købergebyr + sælgergebyr + fragt
//   udbetaling = bud - sælgergebyr = total - gebyr
export function forventet(budOere: number, o: { afhentning?: boolean } = {}) {
  const fragt = o.afhentning ? 0 : PAKKESHOP_FRAGT_OERE;
  const koeb = koebergebyrOere(budOere, false);
  const saelg = saelgergebyrOere(budOere, false);
  return { koeb, saelg, fragt, total: budOere + koeb + fragt, gebyr: koeb + saelg + fragt, udbetaling: budOere - saelg };
}

export type TestHandel = {
  navn: string;
  auktionId: string;
  tradeId: string;
  betalingId: string;
  saelger: PengeBruger;
  koeber: PengeBruger;
};

// Gebyrer som databasen (ny prismodel, 20261031010000 - triggeren
// betalinger_b_prismodel regner dem alligevel om ved oprettelse): privat
// auktion, BidHamr Beskyttelse inkluderet i købergebyret (intet særskilt
// beløb). "beskyttelse" ignoreres (bevaret for de eksisterende kald). Øre.
function beregn(budOere: number, _beskyttelse: boolean, fragtOere: number) {
  const koeb = koebergebyrOere(budOere, false);
  const saelg = saelgergebyrOere(budOere, false);
  const besk = 0;
  return { koeb, saelg, besk, total: budOere + koeb + fragtOere, udbetaling: budOere - saelg };
}

export async function opretHandel(o: {
  navn: string;
  budOere: number;
  beskyttelse?: boolean;
  saelger?: PengeBruger;
  koeber?: PengeBruger;
  // Kun afhentning hos sælgeren (auktion uden forsendelse, ingen fragt).
  afhentning?: boolean;
}): Promise<TestHandel> {
  const saelger = o.saelger ?? SAELGER;
  const koeber = o.koeber ?? KOEBER;
  const db = admin();
  const titel = `TEST pengetest: ${o.navn} [${kontekst().koersel}]`.slice(0, 120);
  // Slutter for 8 dage siden: afslut_udloebne_auktioner (pg_cron hvert
  // minut) laver kun handler for auktioner, der sluttede inden for 7 dage, så
  // den aldrig laver sin egen handel på testens auktion.
  const slut = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
  const { data: a, error: aFejl } = await db
    .from("auctions")
    .insert({
      bruger_id: saelger.id,
      titel,
      beskrivelse: "TEST - oprettet af pengetestene (npm run test:penge). Ingen rigtig vare.",
      billeder: [],
      startpris: Math.max(1, Math.floor(o.budOere / 100)),
      kategori: "Andet",
      postnummer: "2100",
      lokation: "København Ø",
      forsendelse_mulig: !o.afhentning,
      afhentning_mulig: !!o.afhentning,
      stand: "god",
      varighed_dage: 3,
      forbudt_bekraeftet: true,
      pakkestoerrelse: "lille",
      vaegt_gram: 500,
      fragt_pakkeshop_oere: o.afhentning ? null : PAKKESHOP_FRAGT_OERE,
      slutter_kl: slut,
      status: "afsluttet",
      vinder_id: koeber.id,
      afsluttet_kl: slut,
    })
    .select("id")
    .single<{ id: string }>();
  if (aFejl || !a) throw new Error(`auktion: ${aFejl?.message}`);

  const { data: t, error: tFejl } = await db
    .from("trades")
    .insert({
      auction_id: a.id,
      seller_id: saelger.id,
      buyer_id: koeber.id,
      amount: o.budOere / 100,
      status: "afventer_betaling",
    })
    .select("id")
    .single<{ id: string }>();
  if (tFejl || !t) throw new Error(`handel: ${tFejl?.message}`);

  const fragtOere = o.afhentning ? 0 : PAKKESHOP_FRAGT_OERE;
  const { error: lFejl } = o.afhentning ? { error: null } : await db.from("handel_levering").insert({
    trade_id: t.id,
    maade: "pakkeshop",
    fragtfirma: "shipmondo",
    transportoer: "dao",
    pakkeshop_id: "TEST",
    pakkeshop_navn: "TEST pakkeshop",
    pakkeshop_adresse: "Testvej 1",
    pakkeshop_postnummer: "2100",
    pakkeshop_by: "København Ø",
    modtager_navn: koeber.navn,
    modtager_telefon: "+4520000000",
    modtager_email: koeber.email,
    fragt_oere: PAKKESHOP_FRAGT_OERE,
  });
  if (lFejl) throw new Error(`levering: ${lFejl.message}`);

  const x = beregn(o.budOere, !!o.beskyttelse, fragtOere);
  const { data: b, error: bFejl } = await db
    .from("betalinger")
    .insert({
      trade_id: t.id,
      auction_id: a.id,
      buyer_id: koeber.id,
      seller_id: saelger.id,
      bud_oere: o.budOere,
      koebergebyr_oere: x.koeb,
      fragt_oere: fragtOere,
      beskyttelse: !o.afhentning,
      beskyttelse_oere: x.besk,
      total_oere: x.total,
      saelgergebyr_oere: x.saelg,
      udbetaling_oere: x.udbetaling,
      betal_senest: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
      // Testen sender ingen "du vandt"-mails.
      vundet_mail_sendt_kl: new Date().toISOString(),
    })
    .select("id, venter_paa_saelgerkonto_kl")
    .single<{ id: string; venter_paa_saelgerkonto_kl: string | null }>();
  if (bFejl || !b) throw new Error(`betaling: ${bFejl?.message}`);
  if (b.venter_paa_saelgerkonto_kl) throw new Error("Betalingen venter på sælgerkontoen - er forberedSaelger kørt?");

  return { navn: o.navn, auktionId: a.id, tradeId: t.id, betalingId: b.id, saelger, koeber };
}

export type BetalingDB = Record<string, unknown> & {
  id: string;
  status: string;
  total_oere: number;
  udbetaling_oere: number;
  application_fee_oere: number | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_destination_transfer_id: string | null;
  saelger_udbetaling_id: string | null;
  frigivet_kl: string | null;
  overfoert_kl: string | null;
  refunderet_kl: string | null;
  refusion_oere: number | null;
  kraever_opmaerksomhed: boolean;
  sidste_fejl: string | null;
  saelger_stripe_konto: string | null;
};

export async function betaling(id: string): Promise<BetalingDB> {
  const { data, error } = await admin().from("betalinger").select("*").eq("id", id).single<BetalingDB>();
  if (error || !data) throw new Error(`betaling ${id}: ${error?.message}`);
  return data;
}

// --- Webhook -----------------------------------------------------------------

export type WebhookSvar = { status: number; body: Record<string, unknown> };

// Leverer et event til den rigtige webhook-rute, signeret som Stripe gør
// (Stripe-Signature med hemmeligheden fra opsaetning.ts). Objektet bør være
// hentet frisk fra Stripe - ruten henter det alligevel igen.
export async function sendWebhook(
  type: string,
  objekt: { id: string } & Record<string, unknown>,
  o: { konto?: string; eventId?: string; signatur?: string } = {},
): Promise<WebhookSvar> {
  const event = {
    id: o.eventId ?? `evt_test_pengetest_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: objekt },
    ...(o.konto ? { account: o.konto } : {}),
  };
  const payload = JSON.stringify(event);
  const signatur =
    o.signatur ??
    Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
  const req = new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": signatur, "content-type": "application/json" },
  });
  const res = await webhookPOST(req);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

export function piId(clientSecret: string | null): string {
  // null = dækket returfragt (ingen betaling) - må ikke ske her.
  if (!clientSecret) throw new Error("Ingen client_secret (dækket returfragt?)");
  return clientSecret.split("_secret_")[0];
}

// Køberen starter betalingen (server action startBetaling som køber) og
// betaler med testkortet. Webhooks leveres kun, hvis medWebhook er sat.
export async function betal(
  h: TestHandel,
  o: { kort?: string; medWebhook?: boolean } = {},
): Promise<Stripe.PaymentIntent> {
  const { startBetaling } = await import("@/app/actions/betaling");
  await logIndSom(h.koeber.id, h.koeber.email);
  const s = await startBetaling(h.tradeId);
  if (!("ok" in s)) throw new Error(`startBetaling: ${s.fejl}`);
  const id = piId(s.clientSecret);
  await udenTvungen3ds(id);
  let pi = await stripe().paymentIntents.confirm(id, {
    payment_method: o.kort ?? "pm_card_bypassPending",
    return_url: "https://bidhamr.dk/test-betaling",
  });
  if (o.medWebhook !== false) {
    pi = await stripe().paymentIntents.retrieve(id);
    await leverBetalingsWebhooks(pi);
  }
  return pi;
}

// Sikkerhedsnet A tvinger 3D Secure (request_three_d_secure = 'any') på alle
// PaymentIntents. Testmiljøets 3DS-side kan kun klikkes igennem i en browser,
// så pengetestene kontrollerer først, at den rigtige kode HAR sat 3DS på, og
// slår den derefter fra på netop testens egen PaymentIntent (kun testmiljøet)
// lige før betalingen. Resten af pengestrømmen er uændret.
export async function udenTvungen3ds(id: string): Promise<void> {
  const pi = await stripe().paymentIntents.retrieve(id);
  if (pi.payment_method_options?.card?.request_three_d_secure !== "any") {
    throw new Error(`PaymentIntent ${id} har ikke tvungen 3D Secure (sikkerhedsnet A)`);
  }
  await stripe().paymentIntents.update(id, {
    payment_method_options: { card: { request_three_d_secure: "automatic" } },
  });
}

// payment_intent.succeeded + charge.updated (som Stripe sender dem).
export async function leverBetalingsWebhooks(pi: Stripe.PaymentIntent): Promise<void> {
  const r1 = await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string });
  if (r1.status !== 200) throw new Error(`webhook payment_intent.succeeded: ${r1.status} ${JSON.stringify(r1.body)}`);
  const chId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id;
  if (chId) {
    const ch = await ventPaaTransfer(chId);
    const r2 = await sendWebhook("charge.updated", ch as unknown as { id: string });
    if (r2.status !== 200) throw new Error(`webhook charge.updated: ${r2.status} ${JSON.stringify(r2.body)}`);
  }
}

// Ved destination charges sætter Stripe transferen lidt efter charge.succeeded.
export async function ventPaaTransfer(chargeId: string): Promise<Stripe.Charge> {
  const slut = Date.now() + 60_000;
  for (;;) {
    const ch = await stripe().charges.retrieve(chargeId);
    if (ch.transfer || Date.now() > slut) return ch;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// --- Frigivelse ------------------------------------------------------------

// Pakken er sendt og modtaget (fixture: fragtens sporing er ikke en del af
// pengetestene), og køberen godkender med den rigtige server action
// (godkendPakke: bedømmelse + frigivelse + udbetaling i samme flow).
export async function koeberGodkender(h: TestHandel): Promise<unknown> {
  const db = admin();
  const nu = new Date().toISOString();
  const { error } = await db
    .from("trades")
    .update({ status: "modtaget", sendt_kl: nu, received_at: nu, tracking_number: "TESTPENGE" })
    .eq("id", h.tradeId);
  if (error) throw new Error(`handel -> modtaget: ${error.message}`);
  const { godkendPakke } = await import("@/app/actions/trades");
  await logIndSom(h.koeber.id, h.koeber.email);
  return godkendPakke(h.tradeId, 5, null);
}

// Kun databasedelen af køberens godkendelse (samme RPC som godkendPakke, som
// køberen selv) - uden udbetalingsforsøget bagefter. Til test af cron og
// samtidige kørsler.
export async function koeberGodkenderUdenUdbetaling(h: TestHandel): Promise<void> {
  const nu = new Date().toISOString();
  const { error } = await admin()
    .from("trades")
    .update({ status: "modtaget", sendt_kl: nu, received_at: nu, tracking_number: "TESTPENGE" })
    .eq("id", h.tradeId);
  if (error) throw new Error(`handel -> modtaget: ${error.message}`);
  const klient = await logIndSom(h.koeber.id, h.koeber.email);
  const { data, error: gFejl } = await klient.rpc("handel_godkend_med_bedoemmelse", {
    p_trade: h.tradeId,
    p_stjerner: 5,
    p_kommentar: null,
  });
  if (gFejl || data !== "ok") throw new Error(`handel_godkend_med_bedoemmelse: ${gFejl?.message ?? data}`);
}

// Handlen er sendt (fixture - sporingen er ikke en del af pengetestene).
export async function pakkeSendt(h: TestHandel): Promise<void> {
  const { error } = await admin()
    .from("trades")
    .update({ status: "pakke_sendt", sendt_kl: new Date().toISOString(), tracking_number: "TESTPENGE" })
    .eq("id", h.tradeId);
  if (error) throw new Error(`handel -> pakke_sendt: ${error.message}`);
}

// Fuld refusion som "Refundér køber" i admin: refusionen claimes i databasen
// (betaling_paabegynd_refusion) og sendes til Stripe (refunderBetaling).
export async function fuldRefusion(h: TestHandel): Promise<{ claimet: unknown; resultat: string | null }> {
  const { data: claimet, error } = await admin().rpc("betaling_paabegynd_refusion", {
    p_trade: h.tradeId,
    p_aarsag: "admin",
  });
  if (error) throw new Error(`betaling_paabegynd_refusion: ${error.message}`);
  if (claimet === null) return { claimet, resultat: null };
  const { refunderBetaling } = await import("@/lib/betaling/stripeBetaling");
  return { claimet, resultat: await refunderBetaling(h.betalingId) };
}

// Charge, application fee og transfer hos Stripe for en betaling.
export async function stripeTal(b: BetalingDB) {
  const ch = await stripe().charges.retrieve(b.stripe_charge_id!, { expand: ["application_fee", "transfer"] });
  const fee = ch.application_fee as Stripe.ApplicationFee | null;
  const tr = ch.transfer as Stripe.Transfer | null;
  return {
    beloeb: ch.amount,
    refunderet: ch.amount_refunded,
    gebyr: fee?.amount ?? 0,
    gebyrRefunderet: fee?.amount_refunded ?? 0,
    transfer: tr?.amount ?? 0,
    tilbagefoert: tr?.amount_reversed ?? 0,
  };
}

export async function saelgerUdbetaling(id: string) {
  const { data, error } = await admin().from("saelger_udbetalinger").select("*").eq("id", id).single();
  if (error || !data) throw new Error(`saelger_udbetalinger ${id}: ${error?.message}`);
  return data as Record<string, unknown> & {
    id: string;
    status: string;
    beloeb_oere: number;
    stripe_payout_id: string | null;
    stripe_konto: string;
    betaling_ids: string[];
  };
}

// Venter, til Stripe har afgjort en payout (paid/failed/canceled).
export async function ventPaaPayout(konto: string, payoutId: string, maksMs = 180_000): Promise<Stripe.Payout> {
  const slut = Date.now() + maksMs;
  for (;;) {
    const p = await stripe().payouts.retrieve(payoutId, undefined, { stripeAccount: konto });
    if (p.status === "paid" || p.status === "failed" || p.status === "canceled") return p;
    if (Date.now() > slut) return p;
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// Venter, til payouten er betalt hos Stripe, og leverer payout.paid.
export async function afslutPayout(konto: string, udbetalingId: string): Promise<string> {
  const u = await saelgerUdbetaling(udbetalingId);
  const p = await ventPaaPayout(konto, u.stripe_payout_id!);
  await sendWebhook(`payout.${p.status}`, p as unknown as { id: string }, { konto });
  return (await saelgerUdbetaling(udbetalingId)).status;
}

export async function ventPaa<T>(hent: () => Promise<T>, ok: (v: T) => boolean, maksMs = 120_000, pauseMs = 3000): Promise<T> {
  const slut = Date.now() + maksMs;
  for (;;) {
    const v = await hent();
    if (ok(v) || Date.now() > slut) return v;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
}

// Saldo på sælgerens testkonto (DKK, øre).
export async function saldo(konto: string): Promise<{ tilgaengelig: number; afventer: number }> {
  const b = await stripe().balance.retrieve({}, { stripeAccount: konto });
  const sum = (l: { amount: number; currency: string }[]) =>
    l.filter((x) => x.currency === "dkk").reduce((s, x) => s + x.amount, 0);
  return { tilgaengelig: sum(b.available), afventer: sum(b.pending) };
}

// --- Oprydning -------------------------------------------------------------

// Handelsdata slettes aldrig (bogføringsloven) - heller ikke testdata. En
// TEST-handel ryddes op ved at bringe pengene til en sluttilstand (udbetalt
// eller refunderet - det gør testene selv) og arkivere auktionen. Her:
// en PaymentIntent, der stadig kan betales, annulleres hos Stripe; auktionen
// arkiveres; åbne drift-tilfælde for handlen lukkes.
export async function rydOp(h: TestHandel): Promise<void> {
  const db = admin();
  const b = await betaling(h.betalingId).catch(() => null);
  // Ikke betalt: annulleres som admin gør det (ingen advarsel til køberen -
  // ellers ville betalings-cron'en give TEST-køberen en "ubetalt vinder"-
  // advarsel, når fristen udløber).
  if (b && (b.status === "afventer" || b.status === "behandles")) {
    const { error } = await db.rpc("admin_annuller_ikke_betalt", {
      p_trade: h.tradeId,
      p_admin: CHEF_ID,
      p_begrundelse: "TEST pengetest: oprydning efter testen",
    });
    if (error) console.error("Oprydning: admin_annuller_ikke_betalt:", error.message);
  }
  if (b?.stripe_payment_intent_id) {
    const pi = await stripe().paymentIntents.retrieve(b.stripe_payment_intent_id).catch(() => null);
    if (pi && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
      await stripe().paymentIntents.cancel(pi.id).catch(() => null);
    }
  }
  await db.from("auctions").update({ arkiveret_kl: new Date().toISOString() }).eq("id", h.auktionId);
  const { data: tilfaelde } = await db
    .from("drift_tilfaelde")
    .select("noegle")
    .is("loest_kl", null)
    .like("noegle", `%${h.betalingId}%`);
  for (const t of tilfaelde ?? []) await db.rpc("drift_tilfaelde_luk", { p_noegle: t.noegle });
}
