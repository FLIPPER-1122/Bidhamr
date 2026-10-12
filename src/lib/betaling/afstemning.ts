import "server-only";

// Daglig fuld pengeafstemning med Stripe (sikkerhedsnet B, okt. 2026).
// Kører fra /api/cron/afstemning (eget pg_cron-job hver time), men højst én gang pr. 20 timer
// (penge_afstemning_claim, 20261019020000_pengeafstemning.sql). Flytter ALDRIG
// penge - den læser Stripe og databasen og skriver uoverensstemmelser i
// penge_afstemning_afvigelser (én række pr. tilfælde) med ÉN drift-alarm pr.
// ny afvigelse. Kørslen logges i penge_afstemning_koersler.
//
// Vindue: de seneste 30 dage hos Stripe.
//   1. Platformens PaymentIntents: forældreløse (ukendte) betalinger, betalt
//      hos Stripe men ikke i databasen (eller omvendt), forkert beløb.
//      Abonnementer (firmaets Stripe-kunde) er ikke handler og springes over.
//   2. Application fees: hvert gebyr og hver gebyr-refusion mod betalingens
//      application_fee_oere og refusionsplanens G - og summen (Stripe:
//      gebyrer minus gebyr-refusioner) mod databasens forventede indtjening.
//   3. Refusioner og tilbageførsler lavet uden om BidHamr (fx i Stripe-
//      dashboardet): refusioner, som ikke er BidHamrs, og transfers, hvor der
//      er tilbageført et andet beløb, end databasen har registreret.
//   4. Udbetalinger: payouts på sælgerkonti mod saelger_udbetalinger (ukendte,
//      andet beløb/status, eller registreret men ukendt hos Stripe).
//   5. Indsigelser, der ikke er på en handel: abonnementsfakturaer (firma)
//      og helt ukendte. (Indsigelser på handler spejles af overvågningen.)
// Til sidst gemmes platformens saldo (snapshot) til økonomioverblikket.
//
// Kaster aldrig. Fejl i et trin logges med kilde 'cron' (kørslen markeres
// som fejlet, ligesom overvågningen). Før migrationen er kørt, gør den intet.

import Stripe from "stripe";
import { getStripe, StripeTilstandFejl } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { logDriftFejl } from "@/lib/drift";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { dkk } from "@/lib/betaling/udbetaling";

type Admin = ReturnType<typeof createAdminClient>;

const INTERVAL_TIMER = 20;
const DAG = 24 * 60 * 60_000;
const VINDUE_DAGE = 30;
const KALD: Stripe.RequestOptions = { timeout: 20_000, maxNetworkRetries: 1 };
// Grænser, så én kørsel ikke kan løbe løbsk (resten tages i næste kørsel og
// står som "ufuldstændig" i loggen).
const MAKS_OBJEKTER = 3000;
const MAKS_KONTI = 200;
// Regnet fra starten af forespørgslen (/api/cron/afstemning har maxDuration
// 300 s). Budgettet er 180 s minus Stripe-kaldenes timeout, så et kald, der
// starter lige før grænsen, også når at blive færdigt. Er der under 45 s
// tilbage, startes afstemningen slet ikke (den claimes ikke). Budgettet
// tjekkes inde i alle løkker med Stripe-kald; løber det ud, stoppes trinnet,
// kørslen står som "ufuldstændig" (blokerer kun 2 timer), og næste kørsel
// starter ved det første trin, der ikke blev nået.
const TIDSBUDGET_MS = 180_000 - Number(KALD.timeout ?? 20_000);
const MINDST_TILBAGE_MS = 45_000;

class TidenErGaaet extends Error {}

// Sendes som parameter til alle trin (ingen modulvariabel).
export type Budget = { slutKl: number };

function tjekTid(budget: Budget): void {
  if (Date.now() > budget.slutKl) throw new TidenErGaaet("Tidsbudgettet er brugt");
}

export type AfvigelseType =
  | "ukendt_betaling"
  | "betaling_status"
  | "betaling_beloeb"
  | "gebyr"
  | "ukendt_gebyr"
  | "refusion_udenom"
  | "refusion_beloeb"
  | "udbetaling_negativ"
  | "tilbagefoersel_udenom"
  | "udbetaling_ukendt"
  | "udbetaling_afviger"
  | "udbetaling_mangler"
  | "abonnement_indsigelse"
  | "ukendt_indsigelse"
  | "gebyrsum";

export type Afvigelse = {
  noegle: string;
  type: AfvigelseType;
  beskrivelse: string;
  stripeId?: string | null;
  betalingId?: string | null;
  stripeKonto?: string | null;
  beloebStripe?: number | null;
  beloebDb?: number | null;
  // Samme alarmnøgle som webhookens alarm (sikkerhedsnet A), så samme tilfælde
  // kun giver ÉN drift-alarm: webhooken alarmerer med det samme, afstemningen
  // registrerer afvigelsen og alarmerer kun, hvis webhooken ikke har gjort det.
  alarmNoegle?: string;
};

export type Afstemning = {
  koert: number;
  afvigelser: number;
  nye: number;
  ufuldstaendig: number;
  // Trin, der fejlede (kørslen er ok = false).
  fejlede: number;
  betalinger: number;
  gebyrer: number;
  refusioner: number;
  transfers: number;
  konti: number;
  payouts: number;
  indsigelser: number;
  // Summer i øre (kun tal - ingen persondata).
  gebyrStripeOere: number;
  gebyrDbOere: number;
  // Trin, der ikke blev nået (tidsbudgettet), og hvor næste kørsel starter
  // (indeks i TRIN).
  trinIkkeNaaet: number;
  naesteTrin: number;
};

// Rækkefølgen. Næste kørsel efter en ufuldstændig starter ved det første
// trin, der ikke blev nået, og tager resten bagefter (rotation), så de sidste
// trin aldrig sulter.
export const TRIN = ["betalinger", "gebyrer", "refusioner", "tilbageførsler", "udbetalinger", "indsigelser", "saldo"] as const;

// Den rækkefølge, trinnene køres i, når der startes ved indeks start.
export function trinRaekkefoelge(start: number): number[] {
  const n = TRIN.length;
  const s = Number.isInteger(start) && start >= 0 && start < n ? start : 0;
  return Array.from({ length: n }, (_, i) => (s + i) % n);
}

function manglerIDatabasen(err: { code?: string } | null): boolean {
  return !!err && ["PGRST202", "PGRST204", "PGRST205", "42883", "42703", "42P01"].includes(err.code ?? "");
}

function id(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// I bidder af 100 (PostgREST-URL'er må ikke blive for lange).
function bidder<T>(liste: T[], n = 100): T[][] {
  const ud: T[][] = [];
  for (let i = 0; i < liste.length; i += n) ud.push(liste.slice(i, i + n));
  return ud;
}

async function liste<T>(it: AsyncIterable<T>, r: Afstemning, budget: Budget): Promise<T[]> {
  const ud: T[] = [];
  for await (const x of it) {
    tjekTid(budget);
    if (ud.length >= MAKS_OBJEKTER) {
      r.ufuldstaendig++;
      break;
    }
    ud.push(x);
  }
  return ud;
}

type BetalingAfst = {
  id: string;
  bidhamr_daekker_refund_id: string | null;
  bidhamr_daekker_oere: number | null;
  bidhamr_daekker_kl: string | null;
  bidhamr_daekker_refunderet_kl: string | null;
  refusion_oere: number | null;
  refusion_anmodet_kl: string | null;
  status: string;
  total_oere: number;
  udbetaling_oere: number;
  application_fee_oere: number | null;
  refusion_gebyr_oere: number | null;
  gebyr_refunderet_kl: string | null;
  refusion_tilbagefoert_kl: string | null;
  refusion_fra_saelger_oere: number | null;
  indsigelse_tilbagefoersel_id: string | null;
  indsigelse_tilbagefoert_oere: number | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_application_fee_id: string | null;
  stripe_destination_transfer_id: string | null;
  stripe_transfer_id: string | null;
  stripe_refund_id: string | null;
  tidligere_payment_intents: string[] | null;
  betalt_kl: string | null;
  saelger_stripe_konto: string | null;
  seller_id: string;
};

const BETALING_KOLONNER =
  "id, bidhamr_daekker_refund_id, bidhamr_daekker_oere, bidhamr_daekker_kl, bidhamr_daekker_refunderet_kl, refusion_oere, refusion_anmodet_kl, status, total_oere, udbetaling_oere, application_fee_oere, refusion_gebyr_oere, gebyr_refunderet_kl, refusion_tilbagefoert_kl, refusion_fra_saelger_oere, indsigelse_tilbagefoersel_id, indsigelse_tilbagefoert_oere, stripe_payment_intent_id, stripe_charge_id, stripe_application_fee_id, stripe_destination_transfer_id, stripe_transfer_id, stripe_refund_id, tidligere_payment_intents, betalt_kl, saelger_stripe_konto, seller_id";

async function betalingerVed(
  admin: Admin,
  kolonne: "stripe_payment_intent_id" | "stripe_charge_id" | "stripe_application_fee_id" | "stripe_destination_transfer_id" | "stripe_transfer_id",
  ids: string[],
): Promise<Map<string, BetalingAfst>> {
  const ud = new Map<string, BetalingAfst>();
  for (const del of bidder([...new Set(ids)])) {
    if (!del.length) continue;
    const { data, error } = await admin.from("betalinger").select(BETALING_KOLONNER).in(kolonne, del);
    if (error) throw new Error(`betalinger (${kolonne}): ${error.message}`);
    for (const b of (data ?? []) as BetalingAfst[]) {
      const v = b[kolonne];
      if (v) ud.set(v, b);
    }
  }
  return ud;
}

type AfvigelseRaekke = {
  betaling_id: string;
  stripe_refund_id: string | null;
  refunderet_kl: string | null;
  modtaget_oere: number;
};

// Kendte PaymentIntents/charges med forkert beløb (betaling_afvigelser).
async function afvigelsesRaekker(admin: Admin, kolonne: "stripe_payment_intent_id" | "stripe_charge_id", ids: string[]) {
  const ud = new Map<string, AfvigelseRaekke>();
  for (const del of bidder([...new Set(ids)])) {
    if (!del.length) continue;
    const { data, error } = await admin
      .from("betaling_afvigelser")
      .select("betaling_id, stripe_payment_intent_id, stripe_charge_id, stripe_refund_id, refunderet_kl, modtaget_oere")
      .in(kolonne, del);
    if (error) throw new Error(`betaling_afvigelser: ${error.message}`);
    for (const a of data ?? []) {
      const v = a[kolonne] as string | null;
      if (v) ud.set(v, a as AfvigelseRaekke);
    }
  }
  return ud;
}

async function firmaKunder(admin: Admin): Promise<Set<string>> {
  const { data, error } = await admin.from("firmaer").select("stripe_customer_id").not("stripe_customer_id", "is", null);
  if (error) {
    if (manglerIDatabasen(error)) return new Set();
    throw new Error(`firmaer: ${error.message}`);
  }
  return new Set((data ?? []).map((f) => f.stripe_customer_id as string));
}

// ------------------------------------------------------------- de rene regler
// (eksporteret, så de kan testes uden Stripe og database)

// Hvad Stripe skal have refunderet af application fee'en: G, når gebyr-
// refusionen er gennemført.
export function forventetGebyrRefunderet(b: Pick<BetalingAfst, "gebyr_refunderet_kl" | "refusion_gebyr_oere">): number {
  return b.gebyr_refunderet_kl ? Number(b.refusion_gebyr_oere ?? 0) : 0;
}

// Hvad der skal være tilbageført af transferen til sælgeren: U + G ved
// refusion (refusion.ts) og det låste beløb ved tabt indsigelse.
export function forventetTilbagefoert(
  b: Pick<
    BetalingAfst,
    "refusion_tilbagefoert_kl" | "udbetaling_oere" | "refusion_gebyr_oere" | "indsigelse_tilbagefoersel_id" | "indsigelse_tilbagefoert_oere"
  >,
): number {
  let x = 0;
  if (b.refusion_tilbagefoert_kl) x += Number(b.udbetaling_oere) + Number(b.refusion_gebyr_oere ?? 0);
  if (b.indsigelse_tilbagefoersel_id) x += Number(b.indsigelse_tilbagefoert_oere ?? 0);
  return x;
}

// En refusion er BidHamrs egen, når databasen har registreret netop den
// (stripe_refund_id, bidhamr_daekker_refund_id eller afvigelsens
// stripe_refund_id). Et rent metadata-match (betaling_id, eller
// bidhamr_daekker for "BidHamr dækker") godtages kun, så længe databasen
// endnu IKKE har et refund-id af den type - en refusion i gang, hvis id endnu
// ikke er gemt. Har databasen allerede et andet id, er det en ekstra
// (dobbelt) refusion, også selv om den er lavet af BidHamrs egen kode.
export function erBidhamrsRefusion(
  x: { id: string; metadata?: Record<string, string> | null },
  b: { id: string; stripe_refund_id?: string | null; bidhamr_daekker_refund_id?: string | null } | null,
  a: { betaling_id: string; stripe_refund_id?: string | null } | null,
): boolean {
  const md = x.metadata ?? {};
  if (a?.stripe_refund_id === x.id) return true;
  if (b && (b.stripe_refund_id === x.id || b.bidhamr_daekker_refund_id === x.id)) return true;
  if (a && md.betaling_id === a.betaling_id && !a.stripe_refund_id) return true;
  if (b && md.bidhamr_daekker === b.id) return !b.bidhamr_daekker_refund_id && !b.stripe_refund_id;
  if (b && md.betaling_id === b.id) return !b.stripe_refund_id;
  return false;
}

// Hvad databasen forventer er refunderet på chargen i alt - null, når en
// refusion er i gang (beløbet kan ikke afstemmes endnu):
//   betaling refunderet med "BidHamr dækker" -> bidhamr_daekker_oere
//   betaling refunderet ellers                -> refusion_oere, ellers total
//   betaling med forkert beløb refunderet     -> modtaget_oere
//   ikke refunderet (og intet i gang)         -> 0
export function forventetRefunderet(
  b: Pick<
    BetalingAfst,
    "status" | "total_oere" | "refusion_oere" | "refusion_anmodet_kl" | "bidhamr_daekker_kl" | "bidhamr_daekker_oere" | "bidhamr_daekker_refunderet_kl"
  > | null,
  a: Pick<AfvigelseRaekke, "refunderet_kl" | "modtaget_oere"> | null,
): number | null {
  if (a) return a.refunderet_kl ? Number(a.modtaget_oere) : null;
  if (!b) return null;
  if (b.bidhamr_daekker_refunderet_kl) return Number(b.bidhamr_daekker_oere ?? 0);
  if (b.status === "refunderet") return Number(b.refusion_oere ?? b.total_oere);
  if (b.refusion_anmodet_kl || b.bidhamr_daekker_kl) return null;
  return 0;
}

// Højst maks konti, startende ved et offset, der flytter sig hver dag.
export function kontoUdvalg<T>(konti: T[], maks: number, dag: number): T[] {
  if (konti.length <= maks) return konti;
  const start = (((dag * maks) % konti.length) + konti.length) % konti.length;
  return [...konti.slice(start), ...konti.slice(0, start)].slice(0, maks);
}

// Payouts med negativt beløb er Stripe, der henter et underskud på kontoen
// fra sælgerens bank (debit_negative_balances) - ikke en udbetaling, og
// webhooken alarmerer selv (negativ-payout, sikkerhedsnet A).
export function payoutAfstemmes(p: { amount: number }): boolean {
  return Number(p.amount) >= 0;
}

// Stripe-payoutens status passer til databasens? Lige betalte payouts kan
// mangle eventet endnu (overvågningen spejler dem efter 2 døgn) - kun en
// afvigelse, når Stripe har været afgjort i over 2 døgn.
export function payoutStatusPasser(stripeStatus: string, dbStatus: string, afgjortForMs: number): boolean {
  if (stripeStatus === dbStatus) return true;
  if ((stripeStatus === "pending" || stripeStatus === "in_transit") && dbStatus === "oprettet") return true;
  if (["paid", "failed", "canceled"].includes(stripeStatus) && dbStatus === "oprettet") return afgjortForMs < 2 * DAG;
  return false;
}

// ------------------------------------------------------------- kørslen

export async function koerPengeafstemning(
  o: { tving?: boolean; vindueDage?: number; startKl?: number; budgetMs?: number } = {},
): Promise<Afstemning> {
  const r: Afstemning = {
    koert: 0,
    afvigelser: 0,
    nye: 0,
    ufuldstaendig: 0,
    fejlede: 0,
    betalinger: 0,
    gebyrer: 0,
    refusioner: 0,
    transfers: 0,
    konti: 0,
    payouts: 0,
    indsigelser: 0,
    gebyrStripeOere: 0,
    gebyrDbOere: 0,
    trinIkkeNaaet: 0,
    naesteTrin: 0,
  };
  const slut = (o.startKl ?? Date.now()) + (o.budgetMs ?? TIDSBUDGET_MS);
  if (slut - Date.now() < MINDST_TILBAGE_MS) return r; // næste kørsel
  const admin = createAdminClient();
  const { data: koersel, error } = await admin.rpc("penge_afstemning_claim", { p_timer: o.tving ? 0 : INTERVAL_TIMER });
  if (error) {
    if (!manglerIDatabasen(error)) {
      await logDriftFejl({ kilde: "cron", sti: "pengeafstemning", hvor: "Pengeafstemning", fejl: error });
    }
    return r;
  }
  if (koersel === null || koersel === undefined) return r;
  const koerselId = Number(koersel);
  r.koert = 1;
  const budget: Budget = { slutKl: slut };
  // Hvor startes? Var den forrige kørsel ufuldstændig, ved dens næste trin.
  let start = 0;
  {
    const { data: forrige } = await admin
      .from("penge_afstemning_koersler")
      .select("ufuldstaendig, resultat")
      .lt("id", koerselId)
      .not("afsluttet_kl", "is", null)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle<{ ufuldstaendig: boolean; resultat: { naesteTrin?: number } | null }>();
    if (forrige?.ufuldstaendig) start = Number(forrige.resultat?.naesteTrin ?? 0);
  }
  const fra = Math.floor((Date.now() - (o.vindueDage ?? VINDUE_DAGE) * DAG) / 1000);
  const fejl: string[] = [];

  const registrer = async (a: Afvigelse) => {
    const { data: svar, error: rFejl } = await admin.rpc("penge_afvigelse_registrer", {
      p_koersel: koerselId,
      p_noegle: a.noegle.slice(0, 200),
      p_type: a.type,
      p_stripe_id: a.stripeId ?? null,
      p_betaling: a.betalingId ?? null,
      p_stripe_konto: a.stripeKonto ?? null,
      p_beskrivelse: a.beskrivelse.slice(0, 1000),
      p_beloeb_stripe: a.beloebStripe ?? null,
      p_beloeb_db: a.beloebDb ?? null,
    });
    if (rFejl) throw new Error(`penge_afvigelse_registrer: ${rFejl.message}`);
    r.afvigelser++;
    // 'ny': første gang - én drift-alarm, med webhookens nøgle, hvis den
    //   findes (så webhook og afstemning kun giver én alarm).
    // 'genaabnet': markeret løst, men beløbene er ændret siden - alarm med
    //   afstemningens EGEN nøgle (webhookens tilfælde kan stå åbent).
    // 'kendt': åben og kendt, eller løst med uændrede beløb - ingen alarm.
    if (svar === "ny" || svar === "genaabnet") {
      r.nye++;
      const noegle = svar === "ny" && a.alarmNoegle ? a.alarmNoegle : `afstemning:${a.noegle}`;
      if (noegle.startsWith("afstemning:")) await lukTilfaelde(noegle);
      await alarmPrTilfaelde({
        noegle,
        kilde: "cron",
        hvor: "betaling/afstemning",
        fejl: `Pengeafstemning: ${a.beskrivelse} Se Admin -> Penge.`,
      });
    }
  };

  // true = trinnet blev kørt færdigt (eller fejlede); false = tiden slap op.
  const trin = async (navn: string, fn: () => Promise<void>): Promise<boolean> => {
    if (Date.now() > budget.slutKl) return false;
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof TidenErGaaet) return false;
      if (err instanceof StripeTilstandFejl) {
        // Vagten har givet alarm; kørslen tæller som fejlet (også for vagten
        // udefra - kilde 'cron' gør kørslen fejlet).
        fejl.push(`${navn}: Stripe-tilstand`);
        await logDriftFejl({ kilde: "cron", sti: "pengeafstemning", hvor: `Pengeafstemning: ${navn} (Stripe-tilstand)`, fejl: err });
        return true;
      }
      console.error(`Pengeafstemning (${navn}) fejlede:`, err);
      fejl.push(navn);
      await logDriftFejl({ kilde: "cron", sti: "pengeafstemning", hvor: `Pengeafstemning: ${navn}`, fejl: err });
      return true;
    }
  };

  const stripe = getStripe();
  const firma = await firmaKunder(admin).catch(() => new Set<string>());

  const koer: Record<(typeof TRIN)[number], () => Promise<void>> = {
    betalinger: () => afstemBetalinger(admin, stripe, fra, firma, r, registrer, budget),
    gebyrer: () => afstemGebyrer(admin, stripe, fra, r, registrer, budget),
    refusioner: () => afstemRefusioner(admin, stripe, fra, firma, r, registrer, budget),
    tilbageførsler: () => afstemTilbagefoersler(admin, stripe, fra, r, registrer, budget),
    udbetalinger: () => afstemUdbetalinger(admin, stripe, fra, r, registrer, budget),
    indsigelser: () => afstemIndsigelser(admin, stripe, fra, firma, r, registrer, budget),
    saldo: () => gemSaldo(admin, stripe, budget),
  };
  const raekkefoelge = trinRaekkefoelge(start);
  for (let i = 0; i < raekkefoelge.length; i++) {
    const nr = raekkefoelge[i];
    if (!(await trin(TRIN[nr], koer[TRIN[nr]]))) {
      r.trinIkkeNaaet = raekkefoelge.length - i;
      r.naesteTrin = nr;
      break;
    }
  }
  // Ufuldstændig (trin ikke nået, eller for mange objekter/konti): én
  // drift-alarm, til en kørsel er fuldstændig igen.
  r.ufuldstaendig += r.trinIkkeNaaet > 0 ? 1 : 0;
  if (r.ufuldstaendig > 0) {
    await alarmPrTilfaelde({
      noegle: "afstemning:ufuldstaendig",
      kilde: "server",
      hvor: "betaling/afstemning",
      fejl: `Pengeafstemningen er ufuldstændig${r.trinIkkeNaaet ? ` - ${r.trinIkkeNaaet} trin ikke nået (fortsætter ved "${TRIN[r.naesteTrin]}" om ca. 2 timer)` : " - for mange objekter eller konti til én kørsel"}. Se Admin -> Penge.`,
    });
  } else {
    await lukTilfaelde("afstemning:ufuldstaendig");
  }

  r.fejlede = fejl.length;
  const ok = fejl.length === 0;
  const { error: aFejl } = await admin.rpc("penge_afstemning_afslut", {
    p_koersel: koerselId,
    p_ok: ok,
    p_fejl: ok ? null : `Fejl i: ${fejl.join(", ")}`.slice(0, 2000),
    p_resultat: r,
  });
  if (aFejl) console.error("penge_afstemning_afslut:", aFejl.message);
  return r;
}

type Registrer = (a: Afvigelse) => Promise<void>;

// 1. PaymentIntents på platformen.
async function afstemBetalinger(
  admin: Admin,
  stripe: Stripe,
  fra: number,
  firma: Set<string>,
  r: Afstemning,
  registrer: Registrer,
  budget: Budget,
): Promise<void> {
  const pis = await liste(stripe.paymentIntents.list({ created: { gte: fra }, limit: 100 }, KALD), r, budget);
  const betalte = pis.filter((p) => p.status === "succeeded" || p.status === "processing");
  r.betalinger = betalte.length;
  const ids = betalte.map((p) => p.id);
  const kendte = await betalingerVed(admin, "stripe_payment_intent_id", ids);
  const afv = await afvigelsesRaekker(admin, "stripe_payment_intent_id", ids);
  // Kasserede PaymentIntents (pi_forsoeg + 1): betales en af dem alligevel,
  // er det en dobbeltbetaling.
  const tidligere = new Map<string, string>();
  for (const del of bidder(ids)) {
    if (!del.length) continue;
    const { data, error } = await admin.from("betalinger").select("id, tidligere_payment_intents").overlaps("tidligere_payment_intents", del);
    if (error) throw new Error(`tidligere_payment_intents: ${error.message}`);
    for (const b of data ?? []) for (const x of (b.tidligere_payment_intents as string[]) ?? []) tidligere.set(x, b.id as string);
  }

  for (const pi of betalte) {
    tjekTid(budget);
    const b = kendte.get(pi.id);
    const kunde = id(pi.customer as string | { id: string } | null);
    if (afv.has(pi.id)) continue; // forkert beløb - refunderes af betalings-cron'en
    if (b) {
      if (pi.status === "succeeded" && !["betalt", "refunderet"].includes(b.status)) {
        await registrer({
          noegle: `betaling-status:${pi.id}`,
          type: "betaling_status",
          stripeId: pi.id,
          betalingId: b.id,
          beskrivelse: `PaymentIntent ${pi.id} er betalt hos Stripe, men betaling ${b.id} står som '${b.status}' i databasen.`,
          beloebStripe: pi.amount_received,
          beloebDb: Number(b.total_oere),
        });
      }
      if (pi.status === "succeeded" && pi.amount_received !== Number(b.total_oere)) {
        await registrer({
          noegle: `betaling-beloeb:${pi.id}`,
          type: "betaling_beloeb",
          stripeId: pi.id,
          betalingId: b.id,
          beskrivelse: `PaymentIntent ${pi.id} har modtaget et andet beløb end betaling ${b.id}'s total.`,
          beloebStripe: pi.amount_received,
          beloebDb: Number(b.total_oere),
        });
      }
      continue;
    }
    const gammel = tidligere.get(pi.id);
    if (gammel) {
      if (pi.status !== "succeeded") continue;
      const ch = pi.latest_charge ? await stripe.charges.retrieve(id(pi.latest_charge as string)!, {}, KALD) : null;
      if (ch?.refunded) continue;
      await registrer({
        noegle: `betaling-kasseret-betalt:${pi.id}`,
        type: "betaling_status",
        stripeId: pi.id,
        betalingId: gammel,
        beskrivelse: `En kasseret PaymentIntent (${pi.id}) for betaling ${gammel} er betalt hos Stripe og ikke refunderet - mulig dobbeltbetaling.`,
        beloebStripe: pi.amount_received,
      });
      continue;
    }
    // Abonnement (firmaets kunde) eller noget, BidHamr ikke har lavet.
    if (kunde && firma.has(kunde) && !pi.metadata?.betaling_id) continue;
    await registrer({
      noegle: `ukendt-betaling:${pi.id}`,
      alarmNoegle: `ukendt-pi:${pi.id}`,
      type: "ukendt_betaling",
      stripeId: pi.id,
      beskrivelse: `PaymentIntent ${pi.id} (${pi.status}) findes hos Stripe, men hverken som handel, kasseret betaling, forkert beløb eller abonnement i databasen.`,
      beloebStripe: pi.amount_received || pi.amount,
    });
  }

  // Omvendt: betalt i databasen inden for vinduet, men ikke betalt hos Stripe.
  const fraIso = new Date(fra * 1000).toISOString();
  const { data: db, error } = await admin
    .from("betalinger")
    .select("id, stripe_payment_intent_id, status")
    .eq("pengemodel", "destination")
    .gte("betalt_kl", fraIso)
    .not("stripe_payment_intent_id", "is", null)
    .limit(MAKS_OBJEKTER);
  if (error) throw new Error(`betalte betalinger: ${error.message}`);
  const stripeStatus = new Map(pis.map((p) => [p.id, p.status]));
  for (const b of db ?? []) {
    const st = stripeStatus.get(b.stripe_payment_intent_id as string);
    if (!st || st === "succeeded") continue; // oprettet før vinduet: ikke i listen
    await registrer({
      noegle: `betaling-status:${b.stripe_payment_intent_id}`,
      type: "betaling_status",
      stripeId: b.stripe_payment_intent_id as string,
      betalingId: b.id as string,
      beskrivelse: `Betaling ${b.id} står som betalt i databasen, men PaymentIntent ${b.stripe_payment_intent_id} er '${st}' hos Stripe.`,
    });
  }
}

// 2. Application fees.
async function afstemGebyrer(admin: Admin, stripe: Stripe, fra: number, r: Afstemning, registrer: Registrer, budget: Budget): Promise<void> {
  const fees = await liste(stripe.applicationFees.list({ created: { gte: fra }, limit: 100 }, KALD), r, budget);
  r.gebyrer = fees.length;
  const vedId = await betalingerVed(admin, "stripe_application_fee_id", fees.map((f) => f.id));
  const charges = fees.map((f) => id(f.charge as string | { id: string })).filter((x): x is string => !!x);
  const vedCharge = await betalingerVed(admin, "stripe_charge_id", charges);
  const afv = await afvigelsesRaekker(admin, "stripe_charge_id", charges);
  for (const f of fees) {
    tjekTid(budget);
    const ch = id(f.charge as string | { id: string });
    const b = vedId.get(f.id) ?? (ch ? vedCharge.get(ch) : undefined);
    if (!b) {
      if (ch && afv.has(ch)) continue; // betaling med forkert beløb (refunderes helt)
      await registrer({
        noegle: `ukendt-gebyr:${f.id}`,
        type: "ukendt_gebyr",
        stripeId: f.id,
        stripeKonto: id(f.account as string | { id: string }),
        beskrivelse: `Application fee ${f.id} findes hos Stripe, men ikke på nogen betaling i databasen.`,
        beloebStripe: f.amount - f.amount_refunded,
      });
      continue;
    }
    const forventet = Number(b.application_fee_oere ?? 0);
    const forventetRefunderet = forventetGebyrRefunderet(b);
    r.gebyrStripeOere += f.amount - f.amount_refunded;
    r.gebyrDbOere += forventet - forventetRefunderet;
    if (f.amount !== forventet || f.amount_refunded !== forventetRefunderet) {
      await registrer({
        noegle: `gebyr:${f.id}`,
        type: "gebyr",
        stripeId: f.id,
        betalingId: b.id,
        stripeKonto: b.saelger_stripe_konto,
        beskrivelse:
          f.amount !== forventet
            ? `Application fee ${f.id} er et andet beløb end betaling ${b.id}'s gebyr.`
            : `Der er refunderet et andet beløb af gebyret ${f.id} hos Stripe, end betaling ${b.id}'s refusionsplan siger (fx en gebyr-refusion i dashboardet).`,
        beloebStripe: f.amount - f.amount_refunded,
        beloebDb: forventet - forventetRefunderet,
      });
    }
  }
  if (r.gebyrStripeOere !== r.gebyrDbOere) {
    await registrer({
      noegle: "gebyrsum",
      type: "gebyrsum",
      beskrivelse: `Summen af BidHamrs gebyrer hos Stripe (gebyrer minus gebyr-refusioner, ${VINDUE_DAGE} dage) passer ikke med databasens forventede indtjening.`,
      beloebStripe: r.gebyrStripeOere,
      beloebDb: r.gebyrDbOere,
    });
  }
}

// 3a. Refusioner på platformen.
async function afstemRefusioner(
  admin: Admin,
  stripe: Stripe,
  fra: number,
  firma: Set<string>,
  r: Afstemning,
  registrer: Registrer,
  budget: Budget,
): Promise<void> {
  const refusioner = (await liste(stripe.refunds.list({ created: { gte: fra }, limit: 100 }, KALD), r, budget)).filter(
    (x) => x.status !== "failed" && x.status !== "canceled",
  );
  r.refusioner = refusioner.length;
  const charges = refusioner.map((x) => id(x.charge as string | { id: string } | null)).filter((x): x is string => !!x);
  const vedCharge = await betalingerVed(admin, "stripe_charge_id", charges);
  const afv = await afvigelsesRaekker(admin, "stripe_charge_id", charges);
  for (const x of refusioner) {
    tjekTid(budget);
    const ch = id(x.charge as string | { id: string } | null);
    const b = ch ? vedCharge.get(ch) : undefined;
    const a = ch ? afv.get(ch) : undefined;
    if (erBidhamrsRefusion(x, b ?? null, a ?? null)) continue;
    if (!b && !a) {
      // Ikke en handel: abonnementets refusioner er Billing (firma).
      const piId = id(x.payment_intent as string | { id: string } | null);
      if (piId) {
        const pi = await stripe.paymentIntents.retrieve(piId, {}, KALD);
        const kunde = id(pi.customer as string | { id: string } | null);
        if (kunde && firma.has(kunde) && !pi.metadata?.betaling_id) continue;
      }
    }
    await registrer({
      noegle: `refusion:${x.id}`,
      type: "refusion_udenom",
      stripeId: x.id,
      betalingId: b?.id ?? a?.betaling_id ?? null,
      beskrivelse: `Refusion ${x.id}${ch ? ` på ${ch}` : ""} er ikke registreret af BidHamr (lavet i Stripe-dashboardet, eller en ekstra refusion)${b ? ` - betaling ${b.id}` : ""}. Kontrollér, at sælgerens del er taget tilbage, og at køberen ikke er refunderet to gange.`,
      beloebStripe: x.amount,
    });
  }

  // Summen pr. charge: alle ikke-fejlede refusioner hos Stripe mod det,
  // databasen forventer er refunderet (fanger også en dobbelt refusion fra
  // BidHamrs egen kode).
  for (const ch of [...new Set(charges)]) {
    tjekTid(budget);
    const b = vedCharge.get(ch) ?? null;
    const a = afv.get(ch) ?? null;
    if (!b && !a) continue;
    const forventet = forventetRefunderet(b, a);
    if (forventet === null) continue; // refusion i gang
    let sum = 0;
    for await (const x of stripe.refunds.list({ charge: ch, limit: 100 }, KALD)) {
      if (x.status !== "failed" && x.status !== "canceled") sum += x.amount;
    }
    if (sum !== forventet) {
      await registrer({
        noegle: `refusion-beloeb:${ch}`,
        type: "refusion_beloeb",
        stripeId: ch,
        betalingId: b?.id ?? a?.betaling_id ?? null,
        beskrivelse: `Der er refunderet et andet beløb i alt på charge ${ch} hos Stripe, end databasen forventer${b ? ` (betaling ${b.id})` : ""} - fx en dobbelt refusion. Kontrollér refusionerne i Stripe.`,
        beloebStripe: sum,
        beloebDb: forventet,
      });
    }
  }
}

// 3b. Tilbageførsler (transfer reversals) på transfers til sælgerne.
async function afstemTilbagefoersler(admin: Admin, stripe: Stripe, fra: number, r: Afstemning, registrer: Registrer, budget: Budget): Promise<void> {
  const transfers = await liste(stripe.transfers.list({ created: { gte: fra }, limit: 100 }, KALD), r, budget);
  r.transfers = transfers.length;
  const ids = transfers.map((t) => t.id);
  const dest = await betalingerVed(admin, "stripe_destination_transfer_id", ids);
  const gammel = await betalingerVed(admin, "stripe_transfer_id", ids);
  for (const t of transfers) {
    tjekTid(budget);
    const b = dest.get(t.id);
    if (!b) {
      // Den gamle model (separat) eller en transfer, databasen ikke kender:
      // tilbageførsler kan ikke afstemmes - kun gamle med tilbageførsel nævnes.
      if (!gammel.has(t.id) && t.amount_reversed > 0) {
        await registrer({
          noegle: `tilbagefoersel:${t.id}`,
          type: "tilbagefoersel_udenom",
          stripeId: t.id,
          stripeKonto: id(t.destination as string | { id: string } | null),
          beskrivelse: `Transfer ${t.id} er (delvist) tilbageført hos Stripe, men transferen kendes ikke i databasen.`,
          beloebStripe: t.amount_reversed,
        });
      }
      continue;
    }
    const forventet = forventetTilbagefoert(b);
    if (t.amount_reversed !== forventet) {
      await registrer({
        noegle: `tilbagefoersel:${t.id}`,
        type: "tilbagefoersel_udenom",
        stripeId: t.id,
        betalingId: b.id,
        stripeKonto: b.saelger_stripe_konto,
        beskrivelse: `Transfer ${t.id} til sælgeren (betaling ${b.id}) er tilbageført med et andet beløb hos Stripe, end databasen har registreret (fx en tilbageførsel i dashboardet).`,
        beloebStripe: t.amount_reversed,
        beloebDb: forventet,
      });
    }
  }
}

// 4. Payouts på sælgerkonti.
async function afstemUdbetalinger(admin: Admin, stripe: Stripe, fra: number, r: Afstemning, registrer: Registrer, budget: Budget): Promise<void> {
  const { data: rk, error } = await admin
    .from("saelger_udbetalinger")
    .select("id, stripe_konto, stripe_payout_id, status, beloeb_oere, oprettet")
    .gte("oprettet", new Date(fra * 1000 - 5 * DAG).toISOString())
    .limit(MAKS_OBJEKTER);
  if (error) throw new Error(`saelger_udbetalinger: ${error.message}`);
  const { data: aktive, error: pFejl } = await admin
    .from("betalingsprofiler")
    .select("stripe_account_id")
    .not("stripe_account_id", "is", null)
    .is("connect_frakoblet_kl", null)
    .eq("connect_charges_enabled", true)
    .limit(MAKS_KONTI * 5);
  if (pFejl) throw new Error(`betalingsprofiler: ${pFejl.message}`);
  const konti = [...new Set([...(rk ?? []).map((u) => u.stripe_konto as string), ...(aktive ?? []).map((p) => p.stripe_account_id as string)])]
    .filter(Boolean)
    .sort();
  if (konti.length > MAKS_KONTI) r.ufuldstaendig++;
  // Flere konti end grænsen: start et nyt sted hver dag (rotation), så alle
  // kommer med over nogle dage.
  const udvalgte = kontoUdvalg(konti, MAKS_KONTI, Math.floor(Date.now() / DAG));
  const vedPayout = new Map((rk ?? []).filter((u) => u.stripe_payout_id).map((u) => [u.stripe_payout_id as string, u]));
  const set = new Set<string>();
  for (const konto of udvalgte) {
    tjekTid(budget);
    let payouts: Stripe.Payout[];
    try {
      payouts = await liste(stripe.payouts.list({ created: { gte: fra }, limit: 100 }, { stripeAccount: konto, ...KALD }), r, budget);
    } catch (err) {
      if (err instanceof Stripe.errors.StripePermissionError) continue; // frakoblet - overvågningen alarmerer
      throw err;
    }
    r.konti++;
    for (const p of payouts) {
      r.payouts++;
      set.add(p.id);
      // Negativ payout (Stripe henter et underskud på kontoen fra sælgerens
      // bank, debit_negative_balances): ingen udbetaling fra BidHamr og ingen
      // fremmed udbetaling. Registreres for overblikket med webhookens
      // alarmnøgle (negativ-payout, sikkerhedsnet A) - kun én alarm.
      if (!payoutAfstemmes(p)) {
        await registrer({
          noegle: `payout-negativ:${p.id}`,
          alarmNoegle: `negativ-payout:${p.id}`,
          type: "udbetaling_negativ",
          stripeId: p.id,
          stripeKonto: konto,
          beskrivelse: `Stripe har hentet ${(-Number(p.amount) / 100).toFixed(2)} kr. fra sælgerkonto ${konto}s bank (payout ${p.id}, '${p.status}') for at dække et underskud på kontoen. Kontrollér, hvorfor saldoen var negativ (refusion eller indsigelse).`,
          beloebStripe: p.amount,
        });
        continue;
      }
      const u = vedPayout.get(p.id);
      if (!u) {
        // Kan være oprettet før vinduet i databasen: slå op.
        const { data: aeldre } = await admin
          .from("saelger_udbetalinger")
          .select("id, status, beloeb_oere")
          .eq("stripe_payout_id", p.id)
          .maybeSingle();
        if (!aeldre) {
          await registrer({
            noegle: `payout-ukendt:${p.id}`,
            alarmNoegle: `fremmed-payout:${p.id}`,
            type: "udbetaling_ukendt",
            stripeId: p.id,
            stripeKonto: konto,
            beskrivelse: `Payout ${p.id} (${p.status}) på sælgerkonto ${konto} er ikke lavet af BidHamr (findes ikke i saelger_udbetalinger).`,
            beloebStripe: p.amount,
          });
        }
        continue;
      }
      const afgjortFor = Date.now() - p.arrival_date * 1000;
      if (p.amount !== Number(u.beloeb_oere) || !payoutStatusPasser(p.status, u.status as string, afgjortFor)) {
        await registrer({
          noegle: `payout-afviger:${p.id}`,
          type: "udbetaling_afviger",
          stripeId: p.id,
          stripeKonto: konto,
          beskrivelse: `Payout ${p.id} står som '${p.status}' hos Stripe, men udbetaling ${u.id} står som '${u.status}' i databasen${p.amount !== Number(u.beloeb_oere) ? " (og beløbet er forskelligt)" : ""}.`,
          beloebStripe: p.amount,
          beloebDb: Number(u.beloeb_oere),
        });
      }
    }
  }
  // Registreret som sendt i databasen inden for vinduet, men ukendt hos Stripe.
  for (const u of rk ?? []) {
    tjekTid(budget);
    if (!u.stripe_payout_id || set.has(u.stripe_payout_id as string)) continue;
    if (!["oprettet", "paid"].includes(u.status as string)) continue;
    if (new Date(u.oprettet as string).getTime() < fra * 1000) continue;
    if (!udvalgte.includes(u.stripe_konto as string)) continue;
    try {
      await stripe.payouts.retrieve(u.stripe_payout_id as string, undefined, { stripeAccount: u.stripe_konto as string, ...KALD });
      continue; // findes (fx oprettet lige på grænsen)
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    }
    await registrer({
      noegle: `payout-mangler:${u.stripe_payout_id}`,
      type: "udbetaling_mangler",
      stripeId: u.stripe_payout_id as string,
      stripeKonto: u.stripe_konto as string,
      beskrivelse: `Udbetaling ${u.id} står som '${u.status}' i databasen, men payout ${u.stripe_payout_id} findes ikke hos Stripe.`,
      beloebDb: Number(u.beloeb_oere),
    });
  }
}

// 5. Indsigelser, der ikke er på en handel (abonnementer og ukendte).
async function afstemIndsigelser(
  admin: Admin,
  stripe: Stripe,
  fra: number,
  firma: Set<string>,
  r: Afstemning,
  registrer: Registrer,
  budget: Budget,
): Promise<void> {
  const disputes = await liste(stripe.disputes.list({ created: { gte: fra }, limit: 100 }, KALD), r, budget);
  r.indsigelser = disputes.length;
  const pis = disputes.map((d) => id(d.payment_intent as string | { id: string } | null)).filter((x): x is string => !!x);
  const kendte = await betalingerVed(admin, "stripe_payment_intent_id", pis);
  const afv = await afvigelsesRaekker(admin, "stripe_payment_intent_id", pis);
  for (const d of disputes) {
    tjekTid(budget);
    const piId = id(d.payment_intent as string | { id: string } | null);
    if (piId && (kendte.has(piId) || afv.has(piId))) continue; // handel - overvågningen spejler den
    let kunde: string | null = null;
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId, {}, KALD);
      kunde = id(pi.customer as string | { id: string } | null);
    }
    const abonnement = !!kunde && firma.has(kunde);
    await registrer({
      noegle: `indsigelse:${d.id}`,
      alarmNoegle: `indsigelse-${abonnement ? "abonnement" : "ukendt"}:${d.id}`,
      type: abonnement ? "abonnement_indsigelse" : "ukendt_indsigelse",
      stripeId: d.id,
      beskrivelse: abonnement
        ? `Indsigelse ${d.id} (${d.status}) på et firmas abonnementsbetaling - håndtér den i Stripe (frist for svar) og tjek firmaets abonnement.`
        : `Indsigelse ${d.id} (${d.status}) er hverken på en handel eller et abonnement i databasen.`,
      beloebStripe: d.amount,
    });
  }
}

// Platformens saldo (BidHamrs penge) og sælgernes saldi (konti med betalte,
// ikke-udbetalte handler) gemmes til økonomioverblikket.
async function gemSaldo(admin: Admin, stripe: Stripe, budget: Budget): Promise<void> {
  const b = await stripe.balance.retrieve({}, KALD);
  const { data, error } = await admin
    .from("betalinger")
    .select("saelger_stripe_konto, udbetaling_oere, refusion_gebyr_oere, gebyr_refunderet_kl, refusion_tilbagefoert_kl, indsigelse_tilbagefoersel_id, indsigelse_tilbagefoert_oere")
    .eq("pengemodel", "destination")
    .eq("status", "betalt")
    .is("saelger_udbetaling_id", null)
    .not("saelger_stripe_konto", "is", null)
    .limit(MAKS_OBJEKTER);
  if (error) throw new Error(`saldo: ${error.message}`);
  const konti = [...new Set((data ?? []).map((x) => x.saelger_stripe_konto as string))].sort().slice(0, MAKS_KONTI);
  let saelgere: number | null = 0;
  for (const k of konti) {
    tjekTid(budget);
    try {
      const s = await stripe.balance.retrieve({}, { stripeAccount: k, ...KALD });
      saelgere += dkk(s.available, false) + dkk(s.pending, false);
    } catch (err) {
      if (err instanceof Stripe.errors.StripePermissionError) continue;
      saelgere = null;
      break;
    }
  }
  const { error: sFejl } = await admin.rpc("penge_saldo_snapshot_gem", {
    p_kilde: "afstemning",
    p_livemode: b.livemode,
    p_tilgaengelig: dkk(b.available, false),
    p_afventer: dkk(b.pending, false),
    p_saelgere: saelgere,
    p_konti: konti.length,
  });
  if (sFejl) throw new Error(`penge_saldo_snapshot_gem: ${sFejl.message}`);
}
