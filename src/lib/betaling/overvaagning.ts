import "server-only";

// Betalingsovervågning (Niels F06, trin 5). Kører fra betalings-cron'en, men
// højst én gang i timen (betaling_overvaagning_claim - Stripe-opslag). Hvert
// fund giver ÉN drift-alarm pr. tilfælde (drift_tilfaelde) - ikke en ny hver
// time. Heartbeat (HEARTBEAT_URL) og "fejlet trin = fejlet kørsel" ligger i
// /api/cron/afslut-auktioner som før.
//
//   A. Udbetalinger til sælgerens bank, der står 'claimet', 'usikker' eller
//      'oprettet' i over 7 dage (normalt 1-3 bankdage).
//   B. Payout-events, der er udeblevet: en 'oprettet' udbetaling, der er over
//      2 døgn gammel, slås op hos Stripe; er den afgjort dér (paid/failed/
//      canceled), spejles den nu, og der gives alarm (webhooken har ikke
//      leveret payout.*-eventet).
//   C. Tabte indsigelser uden afklaring i over 7 dage (fx venter på en
//      uafklaret udbetaling - trin 4).
//   D. Indsigelses-events, der er udeblevet: åbne indsigelser i databasen
//      slås op hos Stripe (anden status = event mangler), og nye indsigelser
//      hos Stripe (14 dage), som databasen ikke kender, spejles. Samme for
//      tidlige svindelvarsler.
//   E. Saldo-afstemning for hver sælgerkonto med betalte, ikke-udbetalte
//      handler: tilgængelig + afventende saldo skal dække det, der skyldes
//      (samme regel som før hver udbetaling). Alarmen lukkes, når den passer.
//   F. Penge, der har stået på sælgerens konto i over 60 og 80 dage uden
//      udbetaling (Stripe kan returnere/udbetale ældre midler - [VERIFICÉR]).
//
// Kaster aldrig. Fejl i et tjek logges med kilde 'cron' (kørslen markeres som
// fejlet); Stripe-vagten (StripeTilstandFejl) giver selv alarm.

import Stripe from "stripe";
import { getStripe, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { dkk, skyldigOere, spejlBidhamrPayout } from "@/lib/betaling/udbetaling";
import { spejlIndsigelse, spejlSvindelvarsel } from "@/lib/betaling/stripeBetaling";

const INTERVAL_MIN = 60;
const DAG = 24 * 60 * 60_000;
const KALD: Stripe.RequestOptions = { timeout: 20_000, maxNetworkRetries: 1 };
const AFGJORT_INDSIGELSE = ["won", "lost", "warning_closed", "prevented"];

type Admin = ReturnType<typeof createAdminClient>;

export type Overvaagning = {
  koert: number;
  alarmer: number;
  udbetalingerSpejlet: number;
  indsigelserSpejlet: number;
  konti: number;
};

function siden(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

async function tjek(navn: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof StripeTilstandFejl) return; // vagten har givet alarm
    console.error(`Overvågning (${navn}) fejlede:`, err);
    await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: `Overvågning: ${navn}`, fejl: err });
  }
}

export async function koerBetalingsovervaagning(tving = false): Promise<Overvaagning> {
  const r: Overvaagning = { koert: 0, alarmer: 0, udbetalingerSpejlet: 0, indsigelserSpejlet: 0, konti: 0 };
  const admin = createAdminClient();
  if (!tving) {
    const { data, error } = await admin.rpc("betaling_overvaagning_claim", { p_minutter: INTERVAL_MIN });
    if (error) {
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Overvågning", fejl: error });
      return r;
    }
    if (data !== true) return r;
  }
  r.koert = 1;
  const alarm = async (o: Parameters<typeof alarmPrTilfaelde>[0]) => {
    if (await alarmPrTilfaelde(o)) r.alarmer++;
  };

  await tjek("payout-events", () => payoutEvents(admin, r, alarm));
  await tjek("udbetalinger", () => haengendeUdbetalinger(admin, alarm));
  await tjek("tabte indsigelser", () => tabteIndsigelser(admin, alarm));
  await tjek("indsigelses-events", () => indsigelsesEvents(admin, r, alarm));
  await tjek("svindelvarsler", () => svindelvarselEvents(admin, alarm));
  await tjek("saldo", () => saldoAfstemning(admin, r, alarm));
  await tjek("gamle midler", () => gamleMidler(admin, alarm));
  return r;
}

type Alarm = (o: Parameters<typeof alarmPrTilfaelde>[0]) => Promise<void>;

// B. Udeblevne payout-events.
async function payoutEvents(admin: Admin, r: Overvaagning, alarm: Alarm): Promise<void> {
  const { data, error } = await admin
    .from("saelger_udbetalinger")
    .select("id, seller_id, stripe_konto, stripe_payout_id, oprettet")
    .eq("status", "oprettet")
    .not("stripe_payout_id", "is", null)
    .lt("oprettet", siden(2 * DAG))
    .order("oprettet", { ascending: true })
    .limit(50);
  if (error) throw new Error(`saelger_udbetalinger: ${error.message}`);
  const stripe = getStripe();
  for (const u of data ?? []) {
    let p: Stripe.Payout;
    try {
      p = await stripe.payouts.retrieve(u.stripe_payout_id as string, undefined, {
        stripeAccount: u.stripe_konto as string,
        ...KALD,
      });
    } catch (err) {
      if (err instanceof Stripe.errors.StripePermissionError) continue; // frakoblet konto - A alarmerer
      throw err;
    }
    if (p.status !== "paid" && p.status !== "failed" && p.status !== "canceled") continue;
    await spejlBidhamrPayout(u.stripe_konto as string, p);
    r.udbetalingerSpejlet++;
    await alarm({
      noegle: `payout-event:${p.id}`,
      hvor: "betaling/webhook-udeblev",
      fejl: `Udbetaling ${u.id} (${p.id}) står som '${p.status}' hos Stripe, men webhooken har ikke leveret payout-eventet - spejlet nu. Kontrollér Connect-webhooken (payout.paid/failed/canceled) i Stripe-dashboardet.`,
      brugerId: u.seller_id as string,
    });
  }
}

// A. Udbetalinger, der hænger i over 7 dage.
async function haengendeUdbetalinger(admin: Admin, alarm: Alarm): Promise<void> {
  const { data, error } = await admin
    .from("saelger_udbetalinger")
    .select("id, seller_id, stripe_konto, stripe_payout_id, status, oprettet")
    .in("status", ["claimet", "usikker", "oprettet"])
    .lt("oprettet", siden(7 * DAG))
    .limit(200);
  if (error) throw new Error(`saelger_udbetalinger: ${error.message}`);
  for (const u of data ?? []) {
    await alarm({
      noegle: `udbetaling-haenger:${u.id}`,
      hvor: "betaling/udbetaling-haenger",
      fejl: `Udbetaling ${u.id} til sælgerkonto ${u.stripe_konto} har stået som '${u.status}' i over 7 dage${u.stripe_payout_id ? ` (payout ${u.stripe_payout_id})` : ""}. Kontrollér den i Stripe og under /admin/betalinger.`,
      brugerId: u.seller_id as string,
    });
  }
}

// C. Tabte indsigelser uden afklaring i over 7 dage.
async function tabteIndsigelser(admin: Admin, alarm: Alarm): Promise<void> {
  const { data, error } = await admin
    .from("betalinger")
    .select("id, trade_id, seller_id, indsigelse_tabt_afklaret, saelger_udbetaling_id")
    .eq("pengemodel", "destination")
    .eq("indsigelse_status", "lost")
    .or("indsigelse_tabt_afklaret.is.null,indsigelse_tabt_afklaret.eq.udbetaling_fejlet")
    .lt("indsigelse_tabt_kl", siden(7 * DAG))
    .limit(200);
  if (error) throw new Error(`tabte indsigelser: ${error.message}`);
  for (const b of data ?? []) {
    await alarm({
      noegle: `indsigelse-uafklaret:${b.id}`,
      hvor: "betaling/indsigelse-uafklaret",
      fejl: `Tabt indsigelse på handel ${b.trade_id} er ikke afklaret efter 7 dage${b.saelger_udbetaling_id ? " (venter på en udbetaling, der ikke er afklaret)" : ""} - beløbet er hverken hentet tilbage fra sælgeren eller afgjort. Se /admin/betalinger.`,
      brugerId: b.seller_id as string,
    });
  }
}

// D. Udeblevne indsigelses-events.
async function indsigelsesEvents(admin: Admin, r: Overvaagning, alarm: Alarm): Promise<void> {
  const stripe = getStripe();
  // D1: åbne i databasen - har Stripe en anden status?
  const { data: aabne, error } = await admin
    .from("betalinger")
    .select("id, stripe_dispute_id, indsigelse_status")
    .eq("pengemodel", "destination")
    .not("stripe_dispute_id", "is", null)
    .not("indsigelse_status", "in", `(${AFGJORT_INDSIGELSE.join(",")})`)
    .lt("opdateret", siden(60 * 60_000))
    .limit(100);
  if (error) throw new Error(`åbne indsigelser: ${error.message}`);
  for (const b of aabne ?? []) {
    const d = await stripe.disputes.retrieve(b.stripe_dispute_id as string, undefined, KALD);
    if (d.status === b.indsigelse_status) continue;
    await spejlIndsigelse(d.id);
    r.indsigelserSpejlet++;
    await alarm({
      noegle: `indsigelse-event:${d.id}:${d.status}`,
      hvor: "betaling/webhook-udeblev",
      fejl: `Indsigelse ${d.id} står som '${d.status}' hos Stripe, men som '${b.indsigelse_status}' i databasen - webhooken har ikke leveret charge.dispute-eventet. Spejlet nu. Kontrollér platform-webhooken i Stripe-dashboardet.`,
    });
  }
  // D2: nye hos Stripe (14 dage), som databasen ikke kender.
  const fra = Math.floor((Date.now() - 14 * DAG) / 1000);
  // Mindst 1 time gammel - et event kan stadig være på vej.
  const til = Math.floor((Date.now() - 60 * 60_000) / 1000);
  let n = 0;
  for await (const d of stripe.disputes.list({ created: { gte: fra, lte: til }, limit: 100 }, KALD)) {
    if (++n > 300) break;
    const piId = typeof d.payment_intent === "string" ? d.payment_intent : (d.payment_intent?.id ?? null);
    if (!piId) continue;
    const { data: b } = await admin
      .from("betalinger")
      .select("id, indsigelse_kl")
      .eq("stripe_payment_intent_id", piId)
      .maybeSingle<{ id: string; indsigelse_kl: string | null }>();
    if (!b || b.indsigelse_kl) continue;
    await spejlIndsigelse(d.id);
    r.indsigelserSpejlet++;
    await alarm({
      noegle: `indsigelse-ukendt:${d.id}`,
      hvor: "betaling/webhook-udeblev",
      fejl: `Indsigelse ${d.id} findes hos Stripe, men var ikke registreret på betalingen - webhooken har ikke leveret charge.dispute.created. Spejlet nu (pengene er frosset). Kontrollér platform-webhooken.`,
    });
  }
}

// D3: tidlige svindelvarsler (14 dage), som databasen ikke kender.
async function svindelvarselEvents(admin: Admin, alarm: Alarm): Promise<void> {
  const stripe = getStripe();
  const fra = Math.floor((Date.now() - 14 * DAG) / 1000);
  // Mindst 1 time gammel - et event kan stadig være på vej.
  const til = Math.floor((Date.now() - 60 * 60_000) / 1000);
  let n = 0;
  for await (const v of stripe.radar.earlyFraudWarnings.list({ created: { gte: fra, lte: til }, limit: 100 }, KALD)) {
    if (++n > 300) break;
    const chId = typeof v.charge === "string" ? v.charge : v.charge?.id;
    if (!chId) continue;
    const { data: b } = await admin
      .from("betalinger")
      .select("id, stripe_svindelvarsel_id")
      .eq("stripe_charge_id", chId)
      .maybeSingle<{ id: string; stripe_svindelvarsel_id: string | null }>();
    if (!b || b.stripe_svindelvarsel_id) continue;
    await spejlSvindelvarsel(v.id);
    await alarm({
      noegle: `svindelvarsel-ukendt:${v.id}`,
      hvor: "betaling/webhook-udeblev",
      fejl: `Tidligt svindelvarsel ${v.id} findes hos Stripe, men var ikke registreret på betalingen - webhooken har ikke leveret radar.early_fraud_warning-eventet. Spejlet nu (udbetalingen er stoppet).`,
    });
  }
}

// E. Saldo-afstemning pr. sælgerkonto.
async function saldoAfstemning(admin: Admin, r: Overvaagning, alarm: Alarm): Promise<void> {
  const { data, error } = await admin
    .from("betalinger")
    .select("seller_id, saelger_stripe_konto")
    .eq("pengemodel", "destination")
    .eq("status", "betalt")
    .is("saelger_udbetaling_id", null)
    .not("saelger_stripe_konto", "is", null)
    .not("stripe_destination_transfer_id", "is", null)
    .limit(2000);
  if (error) throw new Error(`saldo-afstemning: ${error.message}`);
  const konti = new Map<string, string>();
  for (const b of data ?? []) konti.set(b.saelger_stripe_konto as string, b.seller_id as string);
  const stripe = getStripe();
  for (const [konto, saelger] of [...konti].slice(0, 50)) {
    let saldo: Stripe.Balance;
    try {
      saldo = await stripe.balance.retrieve({}, { stripeAccount: konto, ...KALD });
    } catch (err) {
      if (err instanceof Stripe.errors.StripePermissionError) {
        await alarm({
          noegle: `saldo-ingen-adgang:${konto}`,
          hvor: "betaling/saldo",
          fejl: `Saldo-afstemning: ingen adgang til sælgerkonto ${konto} hos Stripe, men der står betalte, ikke-udbetalte handler på den. Kontrollér kontoen.`,
          brugerId: saelger,
        });
        continue;
      }
      throw err;
    }
    r.konti++;
    const iAlt = dkk(saldo.available, false) + dkk(saldo.pending, false);
    const skyldig = await skyldigOere(admin, saelger, konto);
    if (iAlt < skyldig) {
      await alarm({
        noegle: `saldo:${konto}`,
        hvor: "betaling/saldo",
        fejl: `Saldo-afstemning (overvågning): sælgerkonto ${konto} har mindre på saldoen (tilgængelig + afventende) end de betalte, ikke-udbetalte handler kræver. Udbetalinger til sælgeren stoppes - kontrollér kontoen i Stripe.`,
        brugerId: saelger,
      });
    } else {
      await lukTilfaelde(`saldo:${konto}`);
    }
  }
}

// F. Penge, der har stået på sælgerens konto længe uden udbetaling.
async function gamleMidler(admin: Admin, alarm: Alarm): Promise<void> {
  for (const dage of [80, 60]) {
    const { data, error } = await admin
      .from("betalinger")
      .select("id, trade_id, seller_id, betalt_kl")
      .eq("pengemodel", "destination")
      .eq("status", "betalt")
      .is("saelger_udbetaling_id", null)
      .is("refusion_anmodet_kl", null)
      .lt("betalt_kl", siden(dage * DAG))
      .limit(200);
    if (error) throw new Error(`gamle midler: ${error.message}`);
    for (const b of data ?? []) {
      await alarm({
        noegle: `gamle-midler-${dage}:${b.id}`,
        hvor: "betaling/gamle-midler",
        fejl: `Handel ${b.trade_id} blev betalt for over ${dage} dage siden, men pengene er hverken udbetalt til sælgeren eller refunderet. Afgør handlen - Stripe kan håndtere midler, der står længe på en konto, anderledes.`,
        brugerId: b.seller_id as string,
      });
    }
  }
}
