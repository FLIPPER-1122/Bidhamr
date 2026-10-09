import "server-only";

// Betalingsmodel trin 3: udbetaling (docs/BETALINGSMODEL-PLAN.md 1.4 og 6.3).
//
// Destination charges: købers penge står på sælgerens Stripe Connect-konto
// med manuel udbetalingsplan. BidHamr opretter selv udbetalingen (payout) fra
// sælgerens konto til sælgerens bank - og KUN, når handlen er helt færdig
// (Filip, ufravigeligt): køberen har godkendt, fristen uden sag er udløbet,
// eller en sag er afgjort til sælgeren. Sag, indsigelse, uløst svindelvarsel
// og åbent Radar-review stopper udbetalingen (betaling_udbetaling_blokeret,
// 20261011030000).
//
// Rækkefølgen for én sælger (udbetalSaelger):
//   1. En uafklaret udbetaling (claimet/usikker) afklares først - aldrig to
//      payouts samtidig, og aldrig en ny, før det vides, om den forrige findes
//      hos Stripe.
//   2. Kandidater: frigivne destination-betalinger på sælgerens låste konto,
//      hvor betaling_udbetaling_blokeret er null.
//   3. F03 - frisk tjek hos Stripe af hver betaling: charge betalt og ikke
//      refunderet, ingen indsigelse, ingen tidligt svindelvarsel, intet åbent
//      Radar-review, transferen til sælgeren ikke tilbageført. Fund spejles
//      (indsigelse/svindelvarsel) eller markeres til staff.
//   4. Sælgerens konto hentes frisk: udbetalinger aktive, manuel plan.
//   5. Saldo-afstemning: available + pending på kontoen skal dække alle
//      betalte, ikke-udbetalte handler (ellers stop + drift-alarm), og
//      available skal dække udbetalingen (ellers færre handler eller vent +
//      drift-alarm).
//   6. Claim i databasen (låser betalingerne og tjekker blokeringen igen
//      under lås), derefter payouts.create med idempotency key
//      bidhamr-payout-<udbetaling>-<forsøg>.
// Flere handler samles i én payout pr. sælger pr. kørsel (højst 50).
//
// Destination er den eneste model (trin 5): alt her virker kun på betalinger
// med pengemodel 'destination'. Historiske rækker fra den gamle model
// (separat) udbetales aldrig herfra (drift-alarm - staff).

import Stripe from "stripe";
import { getStripe, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { send } from "@/lib/notifikationer/send";
import { sendSaelgerAfregning } from "@/lib/betaling/handelsbeskeder";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { kronerFraOere } from "@/lib/mails/handel";
import {
  alarmGammelModel,
  type BetalingRaekke,
  markerUdbetalingskonto,
  spejlConnectKonto,
  spejlDestinationCharge,
  spejlIndsigelse,
  spejlSvindelvarsel,
} from "@/lib/betaling/stripeBetaling";

const MAKS_PR_UDBETALING = 50;
// En claimet/usikker udbetaling, der er rørt for nylig, kan have et kald i
// gang hos Stripe (samme idempotency-nøgle) - den overtages først efter
// dette. Langt over den længste kaldetid (PAYOUT_KALD: 2 x 30 s + backoff).
const CLAIM_I_GANG_MS = 10 * 60_000;
const PAYOUT_KALD: Stripe.RequestOptions = { timeout: 30_000, maxNetworkRetries: 1 };
// Stripes idempotency-nøgler udløber efter 24 timer.
const NOEGLE_LEVETID_MS = 23 * 60 * 60_000;

type Admin = ReturnType<typeof createAdminClient>;

// Kolonne eller funktion findes ikke (migrationen er ikke kørt endnu) - som
// trin 2: ingen alarm.
function manglerIDatabasen(err: { code?: string } | null): boolean {
  return !!err && ["PGRST202", "PGRST204", "42883", "42703"].includes(err.code ?? "");
}

type UdbetalingRaekke = {
  id: string;
  seller_id: string;
  stripe_konto: string;
  beloeb_oere: number;
  valuta: string;
  stripe_payout_id: string | null;
  status: "claimet" | "oprettet" | "paid" | "failed" | "canceled" | "usikker" | "afvist";
  forsoeg: number;
  oprettet: string;
  opdateret: string;
  betaling_ids: string[];
  // 20261011030000: sidste gang payouts.create blev kaldt (null = aldrig) og
  // hvornår der er givet drift-alarm for claimen (højst én af hver).
  sidst_sendt_kl?: string | null;
  alarm_stoppet_kl?: string | null;
  alarm_saldo_kl?: string | null;
};

// Højst én drift-alarm pr. claim og slags (feltet claimes atomisk).
async function alarmEnGang(
  admin: Admin,
  u: UdbetalingRaekke,
  felt: "alarm_stoppet_kl" | "alarm_saldo_kl",
  hvor: string,
  tekst: string,
): Promise<void> {
  const { data } = await admin
    .from("saelger_udbetalinger")
    .update({ [felt]: new Date().toISOString() })
    .eq("id", u.id)
    .is(felt, null)
    .select("id");
  if (!data || data.length === 0) return;
  await logDriftFejl({ kilde: "server", hvor, fejl: tekst, brugerId: u.seller_id });
}

function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

async function hentBetaling(admin: Admin, id: string): Promise<BetalingRaekke | null> {
  const { data, error } = await admin.from("betalinger").select("*").eq("id", id).maybeSingle<BetalingRaekke>();
  if (error) throw new Error(`hentBetaling: ${error.message}`);
  return data;
}

async function blokeret(admin: Admin, betalingId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("betaling_udbetaling_blokeret", { p_betaling: betalingId });
  if (error) throw new Error(`betaling_udbetaling_blokeret: ${error.message}`);
  return (data as string | null) ?? null;
}

// Markerer en betaling til staff (kraever_opmaerksomhed stopper udbetalingen)
// og giver drift-alarm. Teksten må ikke indeholde beløb (medarbejdere ser den).
async function markerBetaling(admin: Admin, b: BetalingRaekke, tekst: string): Promise<void> {
  const { error } = await admin
    .from("betalinger")
    .update({
      kraever_opmaerksomhed: true,
      sidste_fejl: tekst.slice(0, 500),
      opdateret: new Date().toISOString(),
    })
    .eq("id", b.id);
  if (error) console.error("Markering af betaling fejlede:", b.id, error.message);
  await logDriftFejl({
    kilde: "server",
    hvor: "betaling/udbetaling-stoppet",
    fejl: `${tekst} Betaling ${b.id}.`,
    brugerId: b.seller_id,
  });
}

// --------------------------------------------------------------- dispatcher

// Pengene gives til sælgeren efter frigivelse. Bruges af ALLE frigivelsesveje
// (køberens godkendelse, afhentningskode, 48 t/14 dage uden sag, sag afgjort
// til sælger, admin-frigivelse, afsluttet indsigelse, cron og webhook):
// udbetalTilSaelger (payout fra sælgerens Connect-konto til banken).
// Resultat "udbetalt"/"allerede_udbetalt" = pengene er sendt videre.
export async function pengeTilSaelger(betalingId: string): Promise<string> {
  return udbetalTilSaelger(betalingId);
}

export function erSendtTilSaelger(resultat: string): boolean {
  return resultat === "udbetalt" || resultat === "allerede_udbetalt";
}

// Grunde, hvor handlen ER færdig for sælgeren, og afregningen ("pengene er
// frigivet") må sendes - pengene venter kun på Stripe/kontoen. Ved sag,
// indsigelse, refusion, svindelvarsel og annullering sendes den ikke (samme
// værn som før hver udbetaling).
const AFREGNING_OK = new Set([
  "midler_ikke_tilgaengelige",
  "ventetid",
  "transfer_ukendt",
  "plan_ikke_manuel",
  "udbetalinger_inaktive",
  "venter_paa_bank",
  "allerede_udbetalt",
]);

// Én destination-betaling er frigivet: afregning til sælgeren og et forsøg
// på at udbetale (sammen med sælgerens andre klar-betalinger). Venter
// udbetalingen (fx midlerne er ikke tilgængelige endnu, eller ventetiden ved
// afhentning), prøver cron og webhooken (balance.available) igen.
export async function udbetalTilSaelger(betalingId: string): Promise<string> {
  const admin = createAdminClient();
  const b = await hentBetaling(admin, betalingId);
  if (!b) return "ikke_fundet";
  if (b.pengemodel !== "destination") {
    // Historisk række fra den gamle model: aldrig automatisk (staff).
    if (b.status === "betalt" && b.frigivet_kl && !b.stripe_transfer_id && !b.refusion_anmodet_kl) {
      await alarmGammelModel(b.id, "Udbetaling");
    }
    return "gammel_model";
  }
  if (b.saelger_udbetaling_id) {
    const { data: u } = await admin
      .from("saelger_udbetalinger")
      .select("status")
      .eq("id", b.saelger_udbetaling_id)
      .maybeSingle<{ status: string }>();
    if (u && (u.status === "oprettet" || u.status === "paid")) return "allerede_udbetalt";
  }
  let grund = await blokeret(admin, b.id);
  // Webhooken (charge.updated) er ikke kommet endnu: hent chargen frisk.
  if (grund === "transfer_ukendt" || (grund === "midler_ikke_tilgaengelige" && !b.midler_tilgaengelige_kl)) {
    await spejlManglendeCharges(undefined, b.id);
    grund = await blokeret(admin, b.id);
  }
  if (grund === null || AFREGNING_OK.has(grund)) await sendSaelgerAfregning(b.trade_id, "standard");
  if (grund !== null && grund !== "allerede_udbetalt") return `venter_${grund}`;

  const r = await udbetalSaelger(b.seller_id);
  const efter = await hentBetaling(admin, b.id);
  if (efter?.saelger_udbetaling_id && efter.overfoert_kl) return "udbetalt";
  return r === "udbetalt" ? "venter_naeste_udbetaling" : r;
}

// Payouts, betalingen tidligere har været med i, og som databasen har som
// failed/canceled: hentes frisk hos Stripe. Står en af dem ikke som
// failed/canceled hos Stripe, stoppes betalingen (markering + drift-alarm),
// så pengene aldrig udbetales to gange.
async function tidligereUdbetalingBekraeftetFejlet(admin: Admin, b: BetalingRaekke): Promise<boolean> {
  const { data, error } = await admin
    .from("saelger_udbetalinger")
    .select("id, stripe_konto, stripe_payout_id, status")
    .contains("betaling_ids", [b.id])
    .in("status", ["failed", "canceled", "afvist"]);
  if (error) throw new Error(`tidligere udbetalinger: ${error.message}`);
  for (const u of data ?? []) {
    if (!u.stripe_payout_id) continue; // afvist uden payout: intet er sendt
    const p = await getStripe().payouts.retrieve(u.stripe_payout_id as string, undefined, {
      stripeAccount: u.stripe_konto as string,
    });
    if (p.status !== "failed" && p.status !== "canceled") {
      await markerBetaling(
        admin,
        b,
        `Udbetaling stoppet: en tidligere udbetaling (${p.id}) står som '${p.status}' hos Stripe, men som '${u.status}' i databasen - kontrollér, at pengene ikke allerede er udbetalt.`,
      );
      return false;
    }
  }
  return true;
}

// --------------------------------------------------------------- F03

// Frisk tjek hos Stripe lige før udbetaling (Niels F03). null = i orden.
// Fund spejles/markeres, så betaling_udbetaling_blokeret stopper betalingen
// fremover. Kaster ved netværksfejl (betalingen udbetales så ikke i denne
// kørsel).
export async function tjekFoerUdbetaling(b: BetalingRaekke): Promise<string | null> {
  const stripe = getStripe();
  const admin = createAdminClient();
  if (!b.stripe_charge_id) return "ingen_charge";
  const charge = await stripe.charges.retrieve(b.stripe_charge_id);

  // Beløbene skal være præcis dem, databasen har låst (en afvigelse kan ikke
  // omgås med "Prøv igen" - tjekket kører før hver udbetaling).
  const feeOere = Number(charge.application_fee_amount ?? -1);
  if (
    charge.currency !== "dkk" ||
    Number(charge.amount) !== Number(b.total_oere) ||
    b.application_fee_oere === null ||
    b.application_fee_oere === undefined ||
    feeOere !== Number(b.application_fee_oere) ||
    Number(charge.amount) - feeOere !== Number(b.udbetaling_oere)
  ) {
    await markerBetaling(admin, b, "Udbetaling stoppet: beløb, gebyr eller valuta hos Stripe passer ikke med handlen.");
    return "beloeb_afviger";
  }
  if (charge.status !== "succeeded" || !charge.paid) {
    await markerBetaling(admin, b, `Udbetaling stoppet: betalingen står som '${charge.status}' hos Stripe.`);
    return "charge_ikke_betalt";
  }
  if (charge.disputed) {
    // charge.disputed bliver stående, også når indsigelsen er vundet. Kun en
    // åben eller tabt indsigelse stopper (trin 4: vundet = handlen fortsætter).
    const d = await stripe.disputes.list({ charge: charge.id, limit: 10 });
    for (const dispute of d.data) await spejlIndsigelse(dispute.id);
    if (!d.data.length) {
      await markerBetaling(admin, b, "Udbetaling stoppet: Stripe melder indsigelse på betalingen.");
      return "indsigelse";
    }
    if (d.has_more || d.data.some((x) => !["won", "warning_closed", "prevented"].includes(x.status))) {
      return "indsigelse";
    }
  }
  if (charge.refunded || Number(charge.amount_refunded) > 0) {
    await markerBetaling(admin, b, "Udbetaling stoppet: betalingen er helt eller delvist refunderet hos Stripe.");
    return "refunderet_hos_stripe";
  }
  const varsler = await stripe.radar.earlyFraudWarnings.list({ charge: charge.id, limit: 10 });
  if (varsler.data.length) {
    for (const v of varsler.data) await spejlSvindelvarsel(v.id);
    // Allerede gennemgået af staff (svindelvarsel_loest_kl): må udbetales.
    const igen = await hentBetaling(admin, b.id);
    if (!igen?.svindelvarsel_loest_kl) return "svindelvarsel";
  }
  const reviewId = stripeId(charge.review as string | Stripe.Review | null);
  if (reviewId) {
    const review = await stripe.reviews.retrieve(reviewId);
    if (review.open) {
      await admin.from("betalinger").update({ radar_review_aaben: true }).eq("id", b.id);
      await markerBetaling(admin, b, "Udbetaling stoppet: Stripe Radar gennemgår betalingen (åbent review).");
      return "radar_review";
    }
  }
  const konto = stripeId(charge.transfer_data?.destination ?? null);
  const transferId = stripeId(charge.transfer as string | Stripe.Transfer | null);
  if (konto !== b.saelger_stripe_konto || !transferId || transferId !== b.stripe_destination_transfer_id) {
    await markerBetaling(admin, b, "Udbetaling stoppet: betalingens sælgerkonto eller transfer passer ikke med Stripe.");
    return "transfer_afviger";
  }
  const tr = await stripe.transfers.retrieve(transferId);
  if (Number(tr.amount) !== Number(charge.amount) || tr.currency !== "dkk") {
    await markerBetaling(admin, b, "Udbetaling stoppet: overførslen til sælgerens konto har et andet beløb end betalingen.");
    return "transfer_afviger";
  }
  if (tr.reversed || Number(tr.amount_reversed) > 0) {
    await markerBetaling(admin, b, "Udbetaling stoppet: overførslen til sælgerens konto er helt eller delvist tilbageført hos Stripe.");
    return "transfer_tilbagefoert";
  }
  return null;
}

// --------------------------------------------------------------- saldo

export function dkk(liste: Stripe.Balance.Available[] | Stripe.Balance.Pending[] | undefined, kunKort: boolean): number {
  let sum = 0;
  for (const x of liste ?? []) {
    if (x.currency !== "dkk") continue;
    sum += kunKort ? Number(x.source_types?.card ?? 0) : Number(x.amount);
  }
  return sum;
}

// Det, sælgerens konto skal kunne dække: for hver betalt destination-betaling
// på kontoen, der ikke er udbetalt, det beløb, der stadig står på kontoen for
// handlen (trin 4 - hænger sammen med refusioner og indsigelser):
//   udbetaling_oere (U)
//   + gebyr-refusionen (G), når den er gennemført, og tilbageførslen endnu ikke
//   - refusionsbeløbet (R = S + G), når tilbageførslen er gennemført
//   - det tilbageførte ved tabt indsigelse
// Betalinger med en refusion i gang tæller altså med, til tilbageførslen er
// gennemført; en refunderet betaling står med 0 (S = U).
export function staarPaaKontoen(r: {
  udbetaling_oere: number;
  refusion_fra_saelger_oere?: number | null;
  refusion_gebyr_oere?: number | null;
  gebyr_refunderet_kl?: string | null;
  refusion_tilbagefoert_kl?: string | null;
  indsigelse_tilbagefoersel_id?: string | null;
  indsigelse_tilbagefoert_oere?: number | null;
}): number {
  let beloeb = Number(r.udbetaling_oere);
  const g = Number(r.refusion_gebyr_oere ?? 0);
  const s = Number(r.refusion_fra_saelger_oere ?? 0);
  if (r.gebyr_refunderet_kl) beloeb += g;
  if (r.refusion_tilbagefoert_kl) beloeb -= s + g;
  if (r.indsigelse_tilbagefoersel_id) beloeb -= Number(r.indsigelse_tilbagefoert_oere ?? 0);
  // Kan være negativ, hvis der er taget mere fra kontoen end handlen - det
  // skjules ikke (skyldigOere markerer og alarmerer).
  return beloeb;
}

export async function skyldigOere(admin: Admin, saelgerId: string, konto: string): Promise<number> {
  const { data, error } = await admin
    .from("betalinger")
    .select(
      "id, trade_id, udbetaling_oere, refusion_fra_saelger_oere, refusion_gebyr_oere, gebyr_refunderet_kl, refusion_tilbagefoert_kl, indsigelse_tilbagefoersel_id, indsigelse_tilbagefoert_oere",
    )
    .eq("seller_id", saelgerId)
    .eq("pengemodel", "destination")
    .eq("saelger_stripe_konto", konto)
    // 'betalt': også med en refusion i gang. En refunderet betaling står med 0.
    .eq("status", "betalt")
    .is("saelger_udbetaling_id", null)
    .limit(1000);
  if (error) throw new Error(`skyldigOere: ${error.message}`);
  let sum = 0;
  for (const r of data ?? []) {
    const x = staarPaaKontoen(r);
    if (x < 0) {
      // Mere taget fra sælgerens konto end handlen: aldrig skjult. Tæller 0 i
      // summen (så andre handler ikke ser dækket ud af et minus), markeres
      // til staff og giver drift-alarm - højst én gang pr. handel.
      const { data: foerste } = await admin.rpc("betaling_saldo_negativ_alarm", { p_betaling: r.id });
      if (foerste !== true) continue;
      await admin.rpc("betaling_marker_refusion", {
        p_betaling: r.id,
        p_besked: "Saldo-afstemning: der er taget mere fra sælgerens Stripe-konto for handlen, end handlen gav - kontrollér tilbageførsler og refusioner i Stripe",
      });
      await logDriftFejl({
        kilde: "server",
        hvor: "betaling/saldo",
        fejl: `Saldo-afstemning: der er taget mere fra sælgerkonto ${konto} for handel ${r.trade_id}, end handlen gav (negativt beløb). Kontrollér i Stripe.`,
        brugerId: saelgerId,
      });
      continue;
    }
    sum += x;
  }
  return sum;
}

// --------------------------------------------------------------- én sælger

// Udbetaler alle klar-betalinger for én sælger i én payout. Resultat:
// "udbetalt", "intet", "i_gang", "konto_ikke_klar", "venter_saldo",
// "saldo_afviger", "afvist", "usikker" m.fl. Kaster ved uventede fejl.
export async function udbetalSaelger(saelgerId: string): Promise<string> {
  const admin = createAdminClient();
  const { data: profil, error: pFejl } = await admin
    .from("betalingsprofiler")
    .select("user_id, stripe_account_id, connect_frakoblet_kl")
    .eq("user_id", saelgerId)
    .maybeSingle<{ user_id: string; stripe_account_id: string | null; connect_frakoblet_kl: string | null }>();
  if (pFejl) throw new Error(`udbetalSaelger: ${pFejl.message}`);
  const konto = profil?.stripe_account_id;
  if (!konto || profil?.connect_frakoblet_kl) return "ingen_konto";

  // 1. Uafklaret udbetaling først.
  const { data: uafklarede, error: uFejl } = await admin
    .from("saelger_udbetalinger")
    .select("*")
    .eq("seller_id", saelgerId)
    .in("status", ["claimet", "usikker"]);
  if (uFejl) throw new Error(`udbetalSaelger: ${uFejl.message}`);
  for (const u of (uafklarede ?? []) as UdbetalingRaekke[]) {
    if (u.status === "claimet" && Date.now() - new Date(u.opdateret).getTime() < CLAIM_I_GANG_MS) return "i_gang";
    const r = await opretPayout(admin, u);
    if (r !== "udbetalt" && r !== "afvist") return r;
  }

  // 2. Kandidater.
  const { data: raekker, error: kFejl } = await admin
    .from("betalinger")
    .select("*")
    .eq("seller_id", saelgerId)
    .eq("pengemodel", "destination")
    .eq("saelger_stripe_konto", konto)
    .eq("status", "betalt")
    .not("frigivet_kl", "is", null)
    .is("saelger_udbetaling_id", null)
    .is("refusion_anmodet_kl", null)
    .eq("kraever_opmaerksomhed", false)
    .order("frigivet_kl", { ascending: true })
    .limit(MAKS_PR_UDBETALING)
    .overrideTypes<BetalingRaekke[], { merge: false }>();
  if (kFejl) throw new Error(`udbetalSaelger: ${kFejl.message}`);
  const klar: BetalingRaekke[] = [];
  for (const b of raekker ?? []) {
    if ((await blokeret(admin, b.id)) !== null) continue;
    // Har betalingen været med i en fejlet/annulleret udbetaling, skal Stripe
    // bekræfte, at den payout virkelig ikke gik igennem - ellers ingen ny.
    if (!(await tidligereUdbetalingBekraeftetFejlet(admin, b))) continue;
    // 3. F03.
    if ((await tjekFoerUdbetaling(b)) !== null) continue;
    klar.push(b);
  }
  if (!klar.length) return "intet";

  // 4. Kontoen frisk.
  let stripeKonto: Stripe.Account;
  try {
    stripeKonto = await getStripe().accounts.retrieve(konto);
  } catch (err) {
    if (err instanceof Stripe.errors.StripePermissionError) return "konto_ingen_adgang";
    throw err;
  }
  await spejlConnectKonto(stripeKonto);
  if (!stripeKonto.payouts_enabled || stripeKonto.settings?.payouts?.schedule?.interval !== "manual") {
    return "konto_ikke_klar";
  }

  // 5. Saldo-afstemning.
  const saldo = await getStripe().balance.retrieve({}, { stripeAccount: konto });
  const tilgaengelig = dkk(saldo.available, true);
  const iAlt = dkk(saldo.available, false) + dkk(saldo.pending, false);
  const skyldig = await skyldigOere(admin, saelgerId, konto);
  // Én drift-alarm pr. tilfælde (F06): samme konto alarmerer først igen, når
  // afstemningen har passet imellem.
  if (iAlt < skyldig) {
    await alarmPrTilfaelde({
      noegle: `saldo:${konto}`,
      hvor: "betaling/saldo",
      fejl: `Saldo-afstemning: sælgerkonto ${konto} har mindre på saldoen (tilgængelig + afventende) end de betalte, ikke-udbetalte handler kræver. Udbetalinger til sælgeren er stoppet - kontrollér kontoen i Stripe.`,
      brugerId: saelgerId,
    });
    return "saldo_afviger";
  }
  await lukTilfaelde(`saldo:${konto}`);
  const valgte: BetalingRaekke[] = [];
  let sum = 0;
  for (const b of klar) {
    if (sum + Number(b.udbetaling_oere) > tilgaengelig) continue;
    valgte.push(b);
    sum += Number(b.udbetaling_oere);
  }
  if (valgte.length < klar.length) {
    await alarmPrTilfaelde({
      noegle: `saldo-tilgaengelig:${konto}`,
      hvor: "betaling/saldo",
      fejl: `Saldo-afstemning: sælgerkonto ${konto} har ikke nok tilgængelige midler til ${klar.length - valgte.length} frigivne handel(er), selv om de burde være tilgængelige - udbetalingen venter og prøves igen.`,
      brugerId: saelgerId,
    });
  } else {
    await lukTilfaelde(`saldo-tilgaengelig:${konto}`);
  }
  if (!valgte.length) return "venter_saldo";

  // 6. Claim og payout.
  const { data: claim, error: cFejl } = await admin.rpc("saelger_udbetaling_claim", {
    p_saelger: saelgerId,
    p_konto: konto,
    p_betalinger: valgte.map((b) => b.id),
  });
  if (cFejl) throw new Error(`saelger_udbetaling_claim: ${cFejl.message}`);
  const c = claim as { kode: string; udbetaling_id?: string; beloeb_oere?: number };
  if (c.kode !== "ok" || !c.udbetaling_id) return c.kode;
  if (Number(c.beloeb_oere) > tilgaengelig) {
    await admin.rpc("saelger_udbetaling_afvist", {
      p_udbetaling: c.udbetaling_id,
      p_fejl: "Saldoen dækkede ikke beløbet ved claim",
      p_marker: false,
    });
    return "venter_saldo";
  }
  const { data: u, error: hFejl } = await admin
    .from("saelger_udbetalinger")
    .select("*")
    .eq("id", c.udbetaling_id)
    .single<UdbetalingRaekke>();
  if (hFejl || !u) throw new Error(`saelger_udbetalinger: ${hFejl?.message}`);
  return opretPayout(admin, u);
}

// En ældre claim er blokeret, før den er sendt (igen). Den frigøres kun, når
// intet kald med dens nøgle kan være i gang eller gemt hos Stripe: opslaget
// via metadata har ikke fundet en payout, OG nøglen er udløbet (over 24 t
// siden payouts.create sidst blev kaldt - sidst_sendt_kl; er den aldrig
// kaldt, er intet sendt). Ellers beholdes den (én drift-alarm pr. claim).
async function frigoerGammelClaim(admin: Admin, u: UdbetalingRaekke, aarsag: string): Promise<string> {
  const sidst = u.sidst_sendt_kl ? new Date(u.sidst_sendt_kl).getTime() : null;
  if (sidst === null || Date.now() - sidst > 24 * 60 * 60_000) {
    await admin.rpc("saelger_udbetaling_afvist", { p_udbetaling: u.id, p_fejl: aarsag, p_marker: true });
    return "afvist";
  }
  await alarmEnGang(
    admin,
    u,
    "alarm_stoppet_kl",
    "betaling/udbetaling-stoppet",
    `${aarsag}. Uafklaret udbetaling ${u.id} sendes ikke til Stripe; den beholdes (et tidligere kald kan være gemt hos Stripe) og frigøres automatisk 24 timer efter sidste kald, hvis Stripe ingen payout har.`,
  );
  return "stoppet";
}

// Opretter (eller finder) payouten for en claimet/usikker udbetaling.
async function opretPayout(admin: Admin, u: UdbetalingRaekke): Promise<string> {
  const stripe = getStripe();
  const valg = { stripeAccount: u.stripe_konto };
  // Ikke en frisk claim fra denne kørsel: et tidligere kald kan have nået Stripe.
  const gammel = u.status === "usikker" || u.forsoeg > 0 || Date.now() - new Date(u.oprettet).getTime() > CLAIM_I_GANG_MS;

  // Findes payouten allerede (fx svaret gik tabt)? Slås op via metadata.
  if (gammel) {
    // Alle sider (auto-paginering) siden claimen blev oprettet.
    let fundet: Stripe.Payout | null = null;
    for await (const p of stripe.payouts.list(
      { limit: 100, created: { gte: Math.floor(new Date(u.oprettet).getTime() / 1000) - 3600 } },
      valg,
    )) {
      if (p.metadata?.saelger_udbetaling_id === u.id) {
        fundet = p;
        break;
      }
    }
    if (fundet) return registrerOprettet(admin, u, fundet);
  }

  // Afklaring af en ældre claim (et tidligere kald kan have nået Stripe):
  // claimen frigøres ALDRIG på lav saldo - den beholdes, og næste forsøg
  // bruger samme nøgle. Blokeringen og F03 tjekkes igen for hver betaling.
  if (gammel) {
    for (const id of u.betaling_ids) {
      const { data: grund, error } = await admin.rpc("betaling_udbetaling_blokeret_i_claim", {
        p_betaling: id,
        p_udbetaling: u.id,
      });
      if (error) throw new Error(`betaling_udbetaling_blokeret_i_claim: ${error.message}`);
      let stop = (grund as string | null) ?? null;
      if (!stop) {
        const b = await hentBetaling(admin, id);
        stop = b ? await tjekFoerUdbetaling(b) : "ikke_fundet";
      }
      if (stop) return frigoerGammelClaim(admin, u, `Betaling ${id} blokeret (${stop}) før nyt forsøg`);
    }
    const saldo = await stripe.balance.retrieve({}, valg);
    if (dkk(saldo.available, true) < Number(u.beloeb_oere)) {
      await admin.rpc("saelger_udbetaling_usikker", {
        p_udbetaling: u.id,
        p_fejl: "Saldoen dækker ikke beløbet - claimen beholdes, prøves igen med samme nøgle",
        p_ny_noegle: false,
      });
      await alarmEnGang(
        admin,
        u,
        "alarm_saldo_kl",
        "betaling/saldo",
        `Saldo-afstemning: sælgerkonto ${u.stripe_konto} dækker ikke den uafklarede udbetaling ${u.id}. Claimen beholdes og prøves igen med samme nøgle.`,
      );
      return "venter_saldo";
    }
  }

  // Nøglen er udløbet (over 23 t): nyt forsøg med ny nøgle - payouten findes
  // med sikkerhed ikke (opslaget ovenfor).
  let forsoeg = u.forsoeg;
  if (Date.now() - new Date(u.oprettet).getTime() > NOEGLE_LEVETID_MS * (forsoeg + 1)) {
    forsoeg += 1;
    await admin.rpc("saelger_udbetaling_usikker", {
      p_udbetaling: u.id,
      p_fejl: "Ny idempotency-nøgle efter 24 timer",
      p_ny_noegle: true,
    });
  }

  // Sidste kald med nøglen (24-timers-uret i frigoerGammelClaim).
  const { error: sendtFejl } = await admin
    .from("saelger_udbetalinger")
    .update({ sidst_sendt_kl: new Date().toISOString() })
    .eq("id", u.id)
    .in("status", ["claimet", "usikker"]);
  if (sendtFejl) throw new Error(`sidst_sendt_kl: ${sendtFejl.message}`);

  let payout: Stripe.Payout;
  try {
    payout = await stripe.payouts.create(
      {
        amount: Number(u.beloeb_oere),
        currency: u.valuta || "dkk",
        description: "BidHamr udbetaling",
        metadata: {
          saelger_udbetaling_id: u.id,
          saelger_id: u.seller_id,
          antal_handler: String(u.betaling_ids.length),
        },
      },
      { ...valg, ...PAYOUT_KALD, idempotencyKey: `bidhamr-payout-${u.id}-${forsoeg}` },
    );
  } catch (err) {
    return registrerPayoutFejl(admin, u, err, gammel);
  }
  return registrerOprettet(admin, u, payout);
}

async function registrerOprettet(admin: Admin, u: UdbetalingRaekke, payout: Stripe.Payout): Promise<string> {
  const { data, error } = await admin.rpc("saelger_udbetaling_oprettet", {
    p_udbetaling: u.id,
    p_payout: payout.id,
    p_bank: stripeId(payout.destination as string | Stripe.BankAccount | Stripe.Card | null),
    p_status: payout.status,
  });
  if (error) throw new Error(`saelger_udbetaling_oprettet: ${error.message}`);
  if (String(data) === "konflikt") {
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/udbetaling-konflikt",
      fejl: `Udbetaling ${u.id} var afvist/fejlet i databasen, men payout ${payout.id} findes hos Stripe (sælgerkonto ${u.stripe_konto}). Betalingerne er stoppet og markeret - kontrollér, at intet udbetales to gange.`,
      brugerId: u.seller_id,
    });
    return "konflikt";
  }
  // En evt. fejlet/annulleret payout spejles af webhooken (payout.failed).
  if (payout.status === "failed" || payout.status === "canceled") {
    await spejlBidhamrPayout(u.stripe_konto, payout);
    return "fejlet";
  }
  if (String(data) === "oprettet" || String(data) === "paid") {
    // Afregningen ("pengene er frigivet") som fallback, hvis frigivelsesvejen
    // ikke sendte den (én gang pr. handel - kaster aldrig).
    for (const t of await titler(admin, u.betaling_ids)) await sendSaelgerAfregning(t.tradeId, "standard");
    await beskedUdbetalingPaaVej(admin, u);
  }
  return "udbetalt";
}

// En fejl fra payouts.create.
//   Vagten stoppede kaldet (StripeTilstandFejl): intet sendt - claimet
//     frigøres uden markering (drift-alarmen er givet af vagten).
//   Endelig (4xx - Stripe afviste): ingen payout. balance_insufficient =
//     vent og prøv igen (drift-alarm); andet markeres til staff.
//   Usikker (netværk, 5xx, rate limit, idempotency-konflikt): claimet
//     beholdes, og næste kørsel slår op og prøver med samme nøgle.
async function registrerPayoutFejl(admin: Admin, u: UdbetalingRaekke, err: unknown, gammel: boolean): Promise<string> {
  // En ældre claim frigøres aldrig her (et tidligere kald med samme nøgle kan
  // være gemt hos Stripe) - den beholdes som usikker og prøves igen.
  if (gammel) {
    const kode = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : err instanceof StripeTilstandFejl ? "stripe_stoppet" : "ukendt_fejl";
    const endelig =
      err instanceof Stripe.errors.StripeInvalidRequestError ||
      err instanceof Stripe.errors.StripePermissionError ||
      err instanceof Stripe.errors.StripeCardError;
    // Stripe afviste endeligt (ikke saldo): frigøres kun efter 24 t uden
    // payout (frigoerGammelClaim) - ellers beholdes den og markeres.
    if (endelig && kode !== "balance_insufficient") {
      return frigoerGammelClaim(admin, u, `Stripe afviste nyt forsøg (${kode})`);
    }
    await admin.rpc("saelger_udbetaling_usikker", {
      p_udbetaling: u.id,
      p_fejl: `Nyt forsøg fejlede (${kode}) - claimen beholdes`,
      p_ny_noegle: false,
    });
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/udbetaling",
      fejl: `Nyt forsøg på uafklaret udbetaling ${u.id} (sælgerkonto ${u.stripe_konto}) fejlede (${kode}). Claimen beholdes og prøves igen.`,
      brugerId: u.seller_id,
    });
    return "usikker";
  }
  if (err instanceof StripeTilstandFejl) {
    await admin.rpc("saelger_udbetaling_afvist", { p_udbetaling: u.id, p_fejl: "Stripe-vagten stoppede kaldet", p_marker: false });
    return "stripe_stoppet";
  }
  const kode = err instanceof Stripe.errors.StripeError ? (err.code ?? err.type) : "ukendt_fejl";
  const endelig =
    err instanceof Stripe.errors.StripeInvalidRequestError ||
    err instanceof Stripe.errors.StripePermissionError ||
    err instanceof Stripe.errors.StripeCardError;
  if (endelig) {
    const saldo = kode === "balance_insufficient";
    await admin.rpc("saelger_udbetaling_afvist", {
      p_udbetaling: u.id,
      p_fejl: `Stripe afviste udbetalingen (${kode})`,
      p_marker: !saldo,
    });
    await logDriftFejl({
      kilde: "server",
      hvor: saldo ? "betaling/saldo" : "betaling/udbetaling",
      fejl: `Udbetaling ${u.id} til sælgerkonto ${u.stripe_konto} afvist af Stripe (${kode}).${saldo ? " Prøves igen." : " Betalingerne er markeret til staff."}`,
      brugerId: u.seller_id,
    });
    return "afvist";
  }
  await admin.rpc("saelger_udbetaling_usikker", {
    p_udbetaling: u.id,
    p_fejl: `Usikkert svar fra Stripe (${kode}) - prøves igen`,
    p_ny_noegle: false,
  });
  throw err;
}

async function titler(admin: Admin, betalingIds: string[]): Promise<{ titel: string; tradeId: string }[]> {
  if (!betalingIds.length) return [];
  const { data: b } = await admin.from("betalinger").select("trade_id, auction_id").in("id", betalingIds);
  const auktioner = [...new Set((b ?? []).map((x) => x.auction_id as string))];
  const { data: a } = auktioner.length
    ? await admin.from("auctions").select("id, titel").in("id", auktioner)
    : { data: [] as { id: string; titel: string }[] };
  const navn = new Map((a ?? []).map((x) => [x.id as string, x.titel as string]));
  return (b ?? []).map((x) => ({ titel: navn.get(x.auction_id as string) ?? "din vare", tradeId: x.trade_id as string }));
}

function salgTekst(liste: { titel: string }[]): string {
  if (liste.length === 1) return `"${liste[0].titel}"`;
  return `${liste.length} salg`;
}

// "Udbetalingen er på vej" - én gang pr. udbetaling. Kaster aldrig.
async function beskedUdbetalingPaaVej(admin: Admin, u: UdbetalingRaekke): Promise<void> {
  try {
    const liste = await titler(admin, u.betaling_ids);
    await send(u.seller_id, "udbetaling", {
      titel: "Din udbetaling er på vej",
      tekst: `Vores betalingspartner Stripe sender ${kronerFraOere(Number(u.beloeb_oere))} kr for ${salgTekst(liste)} til din bankkonto. Der går normalt 1-3 bankdage, før pengene står på kontoen.`,
      link: liste.length === 1 ? `/mine-handler/${liste[0].tradeId}` : "/konto#udbetaling",
      data: liste.length === 1 ? { trade_id: liste[0].tradeId } : undefined,
      noegle: `udbetaling_paa_vej:${u.id}`,
    });
  } catch (err) {
    console.error("Besked om udbetaling fejlede:", u.id, err);
  }
}

// --------------------------------------------------------------- cron

// Alle sælgere med frigivne destination-betalinger, der kan være klar til
// udbetaling (eller en uafklaret udbetaling). Kaster aldrig - fejl logges
// (kilde 'cron' = kørslen markeres som fejlet, Niels F06).
// Betalte destination-betalinger, hvor transferen eller available_on endnu
// ikke er spejlet (charge.updated-webhooken er ikke kommet - transfer_ukendt
// / midler_ikke_tilgaengelige): chargen hentes frisk hos Stripe, så
// udbetalingen ikke afhænger af webhooken. Mangler det stadig over 1 time
// efter betalingen, gives én drift-alarm pr. betaling. Kaster aldrig.
export async function spejlManglendeCharges(saelgerId?: string, betalingId?: string): Promise<number> {
  const admin = createAdminClient();
  // Betalinger, der allerede har en åben charge-mangler-alarm, prøves kun
  // med højst 10 pr. kørsel bagefter, og markerede betalinger (staff ser på
  // dem) springes over - så de ikke skubber nyere betalinger ud af grænsen.
  const { data: aabne } = await admin
    .from("drift_tilfaelde")
    .select("noegle")
    .is("loest_kl", null)
    .like("noegle", "charge-mangler:%")
    .limit(500);
  const alarmeret = (aabne ?? []).map((x) => String(x.noegle).slice("charge-mangler:".length)).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  type Raekke = { id: string; seller_id: string; stripe_charge_id: string; betalt_kl: string | null };
  const hent = async (gamle: boolean) => {
    let q = admin
      .from("betalinger")
      .select("id, seller_id, stripe_charge_id, betalt_kl")
      .eq("pengemodel", "destination")
      .eq("status", "betalt")
      .not("stripe_charge_id", "is", null)
      .is("saelger_udbetaling_id", null)
      .or("stripe_destination_transfer_id.is.null,midler_tilgaengelige_kl.is.null");
    if (saelgerId) q = q.eq("seller_id", saelgerId);
    if (betalingId) q = q.eq("id", betalingId);
    else if (gamle) q = q.in("id", alarmeret.slice(0, 200));
    else {
      q = q.eq("kraever_opmaerksomhed", false);
      if (alarmeret.length) q = q.filter("id", "not.in", `(${alarmeret.join(",")})`);
    }
    return q
      .order("betalt_kl", { ascending: true })
      .limit(gamle ? 10 : 50)
      .overrideTypes<Raekke[], { merge: false }>();
  };
  const { data, error } = await hent(false);
  if (error) {
    if (!manglerIDatabasen(error)) {
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Spejling af charges", fejl: error });
    }
    return 0;
  }
  const raekker: Raekke[] = [...(data ?? [])];
  if (alarmeret.length && !betalingId) {
    const { data: gamle } = await hent(true);
    raekker.push(...(gamle ?? []));
  }
  let antal = 0;
  for (const b of raekker) {
    try {
      const r = await spejlDestinationCharge(b.stripe_charge_id as string);
      const { data: efter } = await admin
        .from("betalinger")
        .select("stripe_destination_transfer_id, midler_tilgaengelige_kl")
        .eq("id", b.id)
        .maybeSingle<{ stripe_destination_transfer_id: string | null; midler_tilgaengelige_kl: string | null }>();
      if (efter?.stripe_destination_transfer_id && efter.midler_tilgaengelige_kl) {
        antal++;
        await lukTilfaelde(`charge-mangler:${b.id}`);
        continue;
      }
      if (b.betalt_kl && Date.now() - new Date(b.betalt_kl as string).getTime() > 60 * 60_000) {
        await alarmPrTilfaelde({
          noegle: `charge-mangler:${b.id}`,
          hvor: "betaling/charge-mangler",
          fejl: `Betaling ${b.id} er betalt for over 1 time siden, men transferen til sælgerens konto eller tidspunktet for tilgængelige midler kendes ikke (${r}). Pengene kan ikke udbetales - kontrollér chargen i Stripe.`,
          brugerId: b.seller_id as string,
        });
      }
    } catch (err) {
      console.error("Spejling af charge fejlede:", b.id, err);
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Spejling af charges", fejl: err, brugerId: b.seller_id as string });
    }
  }
  return antal;
}

export async function udbetalVentende(saelgerId?: string): Promise<number> {
  const admin = createAdminClient();
  await spejlManglendeCharges(saelgerId);
  const saelgere = new Set<string>();
  if (saelgerId) {
    saelgere.add(saelgerId);
  } else {
    const nu = new Date().toISOString();
    const { data, error } = await admin
      .from("betalinger")
      .select("seller_id")
      .eq("pengemodel", "destination")
      .eq("status", "betalt")
      .not("frigivet_kl", "is", null)
      .is("saelger_udbetaling_id", null)
      .is("refusion_anmodet_kl", null)
      .eq("kraever_opmaerksomhed", false)
      .lte("midler_tilgaengelige_kl", nu)
      .or(`udbetal_tidligst.is.null,udbetal_tidligst.lte."${nu}"`)
      .limit(1000);
    if (error) {
      // Migrationen er ikke kørt endnu (kolonne/funktion mangler): ingen alarm.
      if (manglerIDatabasen(error)) return 0;
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Udbetaling til sælger", fejl: error });
      return 0;
    }
    for (const r of data ?? []) saelgere.add(r.seller_id as string);
    const { data: uaf, error: uafFejl } = await admin
      .from("saelger_udbetalinger")
      .select("seller_id")
      .in("status", ["claimet", "usikker"])
      .limit(200);
    if (uafFejl && !manglerIDatabasen(uafFejl)) {
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Udbetaling til sælger", fejl: uafFejl });
    }
    for (const r of uaf ?? []) saelgere.add(r.seller_id as string);
  }
  let antal = 0;
  for (const s of saelgere) {
    try {
      if ((await udbetalSaelger(s)) === "udbetalt") antal++;
    } catch (err) {
      console.error("Udbetaling til sælger fejlede:", s, err);
      await logDriftFejl({ kilde: "cron", sti: "betalings-cron", hvor: "Udbetaling til sælger", fejl: err, brugerId: s });
    }
  }
  return antal;
}

// --------------------------------------------------------------- webhook

// payout.paid/failed/canceled (Connect). Returnerer null, hvis payouten ikke
// er en BidHamr-udbetaling (så giver spejlUdbetaling drift-alarm).
export async function spejlBidhamrPayout(konto: string, payoutArg: Stripe.Payout): Promise<string | null> {
  let payout = payoutArg;
  const admin = createAdminClient();
  const fraMetadata = payout.metadata?.saelger_udbetaling_id ?? null;
  const { data: kendt } = await admin
    .from("saelger_udbetalinger")
    .select("id")
    .eq("stripe_payout_id", payout.id)
    .maybeSingle<{ id: string }>();
  if (!kendt && !fraMetadata) return null;
  // Metadata stoles kun på, hvis udbetalingen hører til samme konto.
  const udbetalingId = kendt?.id ?? fraMetadata;
  const { data: u } = await admin
    .from("saelger_udbetalinger")
    .select("*")
    .eq("id", udbetalingId)
    .maybeSingle<UdbetalingRaekke>();
  if (!u || u.stripe_konto !== konto) return null;

  // Betalingerne frigøres kun på Stripes egen, friske status - aldrig på et
  // objekt, der er givet med (fx fra et event eller et svar).
  if (payout.status === "failed" || payout.status === "canceled") {
    payout = await getStripe().payouts.retrieve(payout.id, undefined, { stripeAccount: konto });
  }
  const status = payout.status === "paid" || payout.status === "failed" || payout.status === "canceled" ? payout.status : null;
  if (!status) {
    // pending/in_transit: payout-id'et gemmes, hvis svaret ved oprettelsen gik
    // tabt. Er udbetalingen afvist/fejlet i databasen, giver det 'konflikt'
    // (betalingerne markeres + drift-alarm).
    if (u.status !== "oprettet" && u.status !== "paid") await registrerOprettet(admin, u, payout);
    return payout.status;
  }
  const bank = stripeId(payout.destination as string | Stripe.BankAccount | Stripe.Card | null);
  const { data, error } = await admin.rpc("saelger_udbetaling_spejl", {
    p_udbetaling: u.id,
    p_payout: payout.id,
    p_status: status,
    p_fejlkode: payout.failure_code ?? null,
    p_bank: bank,
  });
  if (error) throw new Error(`saelger_udbetaling_spejl: ${error.message}`);
  const kode = String((data as { kode?: string } | null)?.kode ?? "ukendt");

  if (kode === "konflikt") {
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/udbetaling-konflikt",
      fejl: `Payout ${payout.id} er udbetalt hos Stripe, men udbetaling ${u.id} står som afvist/fejlet (sælgerkonto ${konto}). Betalingerne er stoppet og markeret - kontrollér, at intet udbetales to gange.`,
      brugerId: u.seller_id,
    });
  } else if (kode === "paid") {
    const liste = await titler(admin, u.betaling_ids);
    await send(u.seller_id, "udbetaling", {
      titel: "Pengene er sendt til din bank",
      tekst: `Vores betalingspartner Stripe har sendt ${kronerFraOere(Number(u.beloeb_oere))} kr for ${salgTekst(liste)} til din bankkonto.`,
      link: liste.length === 1 ? `/mine-handler/${liste[0].tradeId}` : "/konto#udbetaling",
      data: liste.length === 1 ? { trade_id: liste[0].tradeId } : undefined,
      noegle: `payout_betalt:${payout.id}`,
    });
  } else if (kode === "failed") {
    await markerUdbetalingskonto(
      konto,
      `Udbetaling til sælgerens bank fejlede hos Stripe (${payout.failure_code ?? "ukendt årsag"}, ${payout.id}). Nye udbetalinger venter, til sælgeren har rettet sin bankkonto hos Stripe - eller tryk "Prøv igen" på betalingen.`,
    );
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/udbetaling-fejlet",
      fejl: `Udbetaling ${u.id} (${payout.id}) til sælgerkonto ${konto} fejlede (${payout.failure_code ?? "ukendt"}). Pengene er tilbage på sælgerens Stripe-konto; sælgeren skal rette bankkontoen.`,
      brugerId: u.seller_id,
    });
    await send(u.seller_id, "udbetaling", {
      titel: "Udbetalingen til din bank fejlede",
      tekst:
        "Vores betalingspartner Stripe kunne ikke sende pengene til din bankkonto. Ret dine bankoplysninger hos Stripe – du finder dem under Min konto. Når bankkontoen er rettet, sendes pengene automatisk igen.",
      link: "/konto#udbetaling",
      noegle: `payout_fejlet:${payout.id}`,
    });
  } else if (kode === "canceled") {
    await logDriftFejl({
      kilde: "server",
      hvor: "betaling/udbetaling-fejlet",
      fejl: `Udbetaling ${u.id} (${payout.id}) til sælgerkonto ${konto} blev annulleret hos Stripe. Betalingerne er markeret til staff.`,
      brugerId: u.seller_id,
    });
  }
  return kode;
}

// account.updated / account.external_account.*: er sælgerens standard-
// bankkonto (DKK) nu en anden end den, udbetalingen fejlede til, ophæves
// "venter på bank", og der udbetales igen. Kaster aldrig.
export async function bankKontoRettet(konto: Stripe.Account, userId: string): Promise<boolean> {
  try {
    const eksterne = (konto.external_accounts?.data ?? []) as (Stripe.BankAccount | Stripe.Card)[];
    const standard =
      eksterne.find((e) => e.currency === "dkk" && e.default_for_currency) ??
      eksterne.find((e) => e.default_for_currency) ??
      null;
    if (!standard || !konto.payouts_enabled) return false;
    const { data, error } = await createAdminClient().rpc("saelger_udbetaling_bank_rettet", {
      p_saelger: userId,
      p_bank: standard.id,
      p_tving: false,
    });
    if (error) {
      // Migrationen 20261011030000 er ikke kørt endnu: intet at gøre.
      if (manglerIDatabasen(error)) return false;
      throw new Error(error.message);
    }
    if (!data) return false;
    await udbetalVentende(userId);
    return true;
  } catch (err) {
    console.error("bankKontoRettet fejlede:", konto.id, err);
    await logDriftFejl({ kilde: "server", hvor: "betaling/udbetaling", fejl: err, brugerId: userId });
    return false;
  }
}

// review.opened / review.closed (Stripe Radar, platform). Et åbent review
// stopper udbetalingen (radar_review_aaben) og markeres til staff. Lukkes
// det, fjernes stoppet - markeringen lukker staff selv.
export async function spejlReview(reviewId: string): Promise<string> {
  const review = await getStripe().reviews.retrieve(reviewId);
  const chargeId = stripeId(review.charge as string | Stripe.Charge | null);
  if (!chargeId) return "ingen_charge";
  const admin = createAdminClient();
  const { data: b } = await admin
    .from("betalinger")
    .select("*")
    .eq("stripe_charge_id", chargeId)
    .maybeSingle<BetalingRaekke>();
  if (!b) return "ukendt";
  if (review.open) {
    await admin.from("betalinger").update({ radar_review_aaben: true, opdateret: new Date().toISOString() }).eq("id", b.id);
    await markerBetaling(admin, b, "Stripe Radar gennemgår betalingen (åbent review) - pengene udbetales ikke, før det er lukket.");
    return "aaben";
  }
  await admin.from("betalinger").update({ radar_review_aaben: false, opdateret: new Date().toISOString() }).eq("id", b.id);
  return "lukket";
}

// balance.available (Connect): sælgerens midler er blevet tilgængelige.
export async function udbetalForKonto(konto: string): Promise<number> {
  const { data } = await createAdminClient()
    .from("betalingsprofiler")
    .select("user_id")
    .eq("stripe_account_id", konto)
    .maybeSingle<{ user_id: string }>();
  if (!data) return 0;
  return udbetalVentende(data.user_id);
}

// --------------------------------------------------------------- admin

// Admin/chef: "Prøv igen" på en destination-betaling - ophæver "venter på
// bank" for sælgeren og prøver udbetalingen med det samme. Kaldes kun fra en
// admin-server-action (assertRole).
export async function proevUdbetalingIgen(betalingId: string): Promise<string> {
  const admin = createAdminClient();
  const b = await hentBetaling(admin, betalingId);
  if (!b || b.pengemodel !== "destination") return "ikke_tilladt";
  if (b.status !== "betalt" || !b.frigivet_kl || b.saelger_udbetaling_id || b.refusion_anmodet_kl) {
    return "ikke_klar";
  }
  // Staff har bevidst valgt at prøve igen: markeringen på betalingen lukkes
  // (et uløst svindelvarsel holder den åben - trigger fra trin 2). Sag,
  // indsigelse, refusion og svindelvarsel stopper stadig (betaling_
  // udbetaling_blokeret), og F03-tjekket hos Stripe køres igen.
  await admin
    .from("betalinger")
    .update({ kraever_opmaerksomhed: false, sidste_fejl: null, opdateret: new Date().toISOString() })
    .eq("id", b.id)
    .is("saelger_udbetaling_id", null);
  const { error } = await admin.rpc("saelger_udbetaling_bank_rettet", {
    p_saelger: b.seller_id,
    p_bank: null,
    p_tving: true,
  });
  if (error) throw new Error(`saelger_udbetaling_bank_rettet: ${error.message}`);
  // Uafhængigt af charge.updated-webhooken: transfer/available_on hentes frisk.
  if (!b.stripe_destination_transfer_id || !b.midler_tilgaengelige_kl) await spejlManglendeCharges(undefined, b.id);
  return udbetalTilSaelger(betalingId);
}
