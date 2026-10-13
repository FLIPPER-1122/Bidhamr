import "server-only";

// ------------------------------------------------------------- fremmede testdata
//
// Indtil fase 6 deler produktionsdatabasen og testdatabasen ÉN Stripe-
// testkonto (docs/TEST-PENGE.md). I testtilstand ser produktionen derfor også
// testdatabasens og pengetestenes betalinger, refusioner, gebyrer, transfers
// og indsigelser - både i den daglige afstemning og i webhooken (Stripe
// sender testkontoens events til alle testendepunkter). Det er penge, denne
// database aldrig har haft med at gøre; de gav hundredvis af falske
// afvigelser og alarmmails.
//
// Reglen (erFremmedTestdata), brugt af afstemning.ts og webhooken:
//   - LIVE-nøgle, eller en nøgle, der ikke kan aflæses: ALDRIG fremmed. Alt
//     ukendt er en afvigelse/alarm - fuldt strengt, uændret.
//   - Et objekt med livemode = true: aldrig fremmed (ekstra sikring).
//   - TESTnøgle:
//       1. metadata bidhamr_db (sættes på PaymentIntents): er det denne
//          databases projekt-ref, er objektet vores.
//       2. ellers (også ved en anden bidhamr_db): objektet er kun fremmed, hvis
//          det ikke henviser til noget, DENNE database kender:
//            betaling   (metadata betaling_id/bidhamr_daekker = betalinger.id)
//            betaling   (PaymentIntent, også kasseret, eller charge)
//            returfragt (returfragt_betalinger: PaymentIntent, også kasseret, eller charge)
//            afvigelse  (betaling_afvigelser: PaymentIntent eller charge)
//            udbetaling (metadata saelger_udbetaling_id)
//            Connect-konto (betalingsprofiler, betalinger, saelger_udbetalinger)
//            Stripe-kunde (betalingsprofiler eller firmaer)
//     Fremmede objekter springes over uden afvigelse, alarm eller mail.
// Objekter, databasen allerede kender (fx en ekstra refusion på en kendt
// charge), behandles strengt i begge tilstande.

import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, noeglensTilstand, type StripeTilstand } from "@/lib/stripe";

type Admin = ReturnType<typeof createAdminClient>;

// Denne databases Supabase-projekt-ref (fx "lkifkrexeldimmghnsie"), læst af
// NEXT_PUBLIC_SUPABASE_URL. null, hvis den ikke kan aflæses.
export function egenDatabase(url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""): string | null {
  const m = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

// Det, et Stripe-objekt henviser til (id'er fra objektet og evt. dets
// PaymentIntent). null/undefined ignoreres.
export type Henvisning = {
  livemode?: boolean | null;
  // metadata.bidhamr_db (projekt-ref'en for den database, der lavede det).
  bidhamrDb?: string | null;
  betalinger?: (string | null | undefined)[];
  udbetalinger?: (string | null | undefined)[];
  pis?: (string | null | undefined)[];
  charges?: (string | null | undefined)[];
  konti?: (string | null | undefined)[];
  kunder?: (string | null | undefined)[];
};

export type Kendte = {
  egenDb: string | null;
  betalinger: Set<string>;
  udbetalinger: Set<string>;
  pis: Set<string>;
  charges: Set<string>;
  konti: Set<string>;
  kunder: Set<string>;
};

export function ingenKendte(egenDb: string | null = null): Kendte {
  return {
    egenDb,
    betalinger: new Set(),
    udbetalinger: new Set(),
    pis: new Set(),
    charges: new Set(),
    konti: new Set(),
    kunder: new Set(),
  };
}

export function henviserTilKendt(h: Henvisning, k: Kendte): boolean {
  const i = (xs: (string | null | undefined)[] | undefined, s: Set<string>) => (xs ?? []).some((x) => !!x && s.has(x));
  return (
    i(h.betalinger, k.betalinger) ||
    i(h.udbetalinger, k.udbetalinger) ||
    i(h.pis, k.pis) ||
    i(h.charges, k.charges) ||
    i(h.konti, k.konti) ||
    i(h.kunder, k.kunder)
  );
}

// true = spring over (fremmede testdata). Kun med testnøgle - se reglen ovenfor.
export function erFremmedTestdata(tilstand: StripeTilstand | null, h: Henvisning, k: Kendte): boolean {
  if (tilstand !== "test") return false;
  if (h.livemode === true) return false;
  // bidhamr_db = denne database: vores. En ANDEN bidhamr_db gør det ikke
  // fremmed alene - det er kun fremmed, hvis det heller ikke henviser til noget,
  // vi kender (betaling, PaymentIntent, konto ...).
  if (h.bidhamrDb && k.egenDb && h.bidhamrDb.toLowerCase() === k.egenDb) return false;
  return !henviserTilKendt(h, k);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_ID_RE = /^[A-Za-z0-9_]{1,255}$/;

function bidder<T>(liste: T[], n = 100): T[][] {
  const ud: T[][] = [];
  for (let i = 0; i < liste.length; i += n) ud.push(liste.slice(i, i + n));
  return ud;
}

function rene(xs: (string | null | undefined)[], re: RegExp): string[] {
  return [...new Set(xs.filter((x): x is string => typeof x === "string" && re.test(x)))];
}

async function findes(admin: Admin, tabel: string, kolonne: string, ids: string[], ud: Set<string>): Promise<void> {
  for (const del of bidder(ids)) {
    if (!del.length) continue;
    const { data, error } = await admin.from(tabel).select(kolonne).in(kolonne, del);
    // Fail closed: mangler tabellen eller kolonnen, kastes der - trinnet
    // fejler og logges (hellere end at alt ser fremmed ud).
    if (error) throw new Error(`kendte (${tabel}.${kolonne}): ${error.message}`);
    for (const raekke of (data ?? []) as unknown as Record<string, unknown>[]) {
      const v = raekke[kolonne];
      if (typeof v === "string") ud.add(v);
    }
  }
}

// Som findes, men tabellen må mangle (returfragt_betalinger før migrationen
// 20261022010000) - så kendes intet derfra.
async function findesHvisTabel(admin: Admin, tabel: string, kolonne: string, ids: string[], ud: Set<string>): Promise<void> {
  try {
    await findes(admin, tabel, kolonne, ids, ud);
  } catch (err) {
    if (/does not exist|Could not find the table|42P01|PGRST205/i.test(String((err as Error)?.message ?? err))) return;
    throw err;
  }
}

// Slår op, hvilke af henvisningerne denne database kender. Kun i
// testtilstand (live: tom - erFremmedTestdata er altid false dér).
export async function hentKendte(
  admin: Admin,
  tilstand: StripeTilstand | null,
  hs: Henvisning[],
  firma: Set<string> = new Set(),
): Promise<Kendte> {
  const k = ingenKendte(egenDatabase());
  if (tilstand !== "test" || hs.length === 0) return k;
  const alle = (f: (h: Henvisning) => (string | null | undefined)[] | undefined) => hs.flatMap((h) => f(h) ?? []);
  const betalinger = rene(alle((h) => h.betalinger), UUID_RE);
  const udbetalinger = rene(alle((h) => h.udbetalinger), UUID_RE);
  const pis = rene(alle((h) => h.pis), STRIPE_ID_RE);
  const charges = rene(alle((h) => h.charges), STRIPE_ID_RE);
  const konti = rene(alle((h) => h.konti), STRIPE_ID_RE);
  const kunder = rene(alle((h) => h.kunder), STRIPE_ID_RE);

  await findes(admin, "betalinger", "id", betalinger, k.betalinger);
  await findes(admin, "saelger_udbetalinger", "id", udbetalinger, k.udbetalinger);
  await findes(admin, "betalinger", "stripe_payment_intent_id", pis, k.pis);
  await findes(admin, "betaling_afvigelser", "stripe_payment_intent_id", pis, k.pis);
  for (const del of bidder(pis)) {
    if (!del.length) continue;
    const { data, error } = await admin.from("betalinger").select("tidligere_payment_intents").overlaps("tidligere_payment_intents", del);
    if (error) throw new Error(`kendte (tidligere_payment_intents): ${error.message}`);
    for (const b of data ?? []) for (const x of (b.tidligere_payment_intents as string[] | null) ?? []) if (del.includes(x)) k.pis.add(x);
  }
  // Returfragt i sager (betaling til platformen, returfragt.ts).
  await findesHvisTabel(admin, "returfragt_betalinger", "stripe_payment_intent_id", pis, k.pis);
  await findesHvisTabel(admin, "returfragt_betalinger", "stripe_charge_id", charges, k.charges);
  // Kasserede returfragt-PaymentIntents (refunderes automatisk, hvis de betales).
  for (const del of bidder(pis)) {
    if (!del.length) continue;
    const { data, error } = await admin
      .from("returfragt_betalinger")
      .select("tidligere_payment_intents")
      .overlaps("tidligere_payment_intents", del);
    if (error) {
      if (/does not exist|Could not find the table|42P01|PGRST205/i.test(`${error.code ?? ""} ${error.message}`)) break;
      throw new Error(`kendte (returfragt tidligere_payment_intents): ${error.message}`);
    }
    for (const b of data ?? []) for (const x of (b.tidligere_payment_intents as string[] | null) ?? []) if (del.includes(x)) k.pis.add(x);
  }
  await findes(admin, "betalinger", "stripe_charge_id", charges, k.charges);
  await findes(admin, "betaling_afvigelser", "stripe_charge_id", charges, k.charges);
  await findes(admin, "betalingsprofiler", "stripe_account_id", konti, k.konti);
  await findes(admin, "betalinger", "saelger_stripe_konto", konti, k.konti);
  await findes(admin, "saelger_udbetalinger", "stripe_konto", konti, k.konti);
  await findes(admin, "betalingsprofiler", "stripe_customer_id", kunder, k.kunder);
  await findes(admin, "firmaer", "stripe_customer_id", kunder, k.kunder);
  for (const x of kunder) if (firma.has(x)) k.kunder.add(x);
  return k;
}

function sid(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

// Henvisningerne fra en PaymentIntent (også brugt for refusioner, charges og
// indsigelser, når deres PaymentIntent er hentet).
export function piHenvisning(pi: Stripe.PaymentIntent | null | undefined): Henvisning {
  if (!pi) return {};
  const md = pi.metadata ?? {};
  return {
    livemode: pi.livemode,
    bidhamrDb: md.bidhamr_db ?? null,
    betalinger: [md.betaling_id, md.bidhamr_daekker],
    pis: [pi.id],
    charges: [sid(pi.latest_charge as string | { id: string } | null)],
    konti: [sid(pi.transfer_data?.destination as string | { id: string } | null | undefined), sid(pi.on_behalf_of as string | { id: string } | null)],
    kunder: [sid(pi.customer as string | { id: string } | null)],
  };
}

export function chargeHenvisning(ch: Stripe.Charge): Henvisning {
  const md = ch.metadata ?? {};
  return {
    livemode: ch.livemode,
    bidhamrDb: md.bidhamr_db ?? null,
    betalinger: [md.betaling_id],
    pis: [sid(ch.payment_intent as string | { id: string } | null)],
    charges: [ch.id],
    konti: [sid(ch.transfer_data?.destination as string | { id: string } | null | undefined), sid(ch.on_behalf_of as string | { id: string } | null)],
    kunder: [sid(ch.customer as string | { id: string } | null)],
  };
}

export function flet(...hs: Henvisning[]): Henvisning {
  const ud: Required<Omit<Henvisning, "livemode" | "bidhamrDb">> & { livemode: boolean | null; bidhamrDb: string | null } = {
    livemode: null,
    bidhamrDb: null,
    betalinger: [],
    udbetalinger: [],
    pis: [],
    charges: [],
    konti: [],
    kunder: [],
  };
  for (const h of hs) {
    if (h.livemode === true) ud.livemode = true;
    else if (h.livemode === false && ud.livemode === null) ud.livemode = false;
    if (h.bidhamrDb && !ud.bidhamrDb) ud.bidhamrDb = h.bidhamrDb;
    ud.betalinger.push(...(h.betalinger ?? []));
    ud.udbetalinger.push(...(h.udbetalinger ?? []));
    ud.pis.push(...(h.pis ?? []));
    ud.charges.push(...(h.charges ?? []));
    ud.konti.push(...(h.konti ?? []));
    ud.kunder.push(...(h.kunder ?? []));
  }
  return ud;
}

// --- Webhooken -------------------------------------------------------------
//
// Bruges lige før en "ukendt"-alarm i webhooken (ukendt betaling, ukendt
// charge, ukendt indsigelse). true = fremmede testdata: ingen alarm, ingen
// drift-fejl, ingen mail - kun en stille linje i serverloggen. I live altid
// false (uden opslag). Kan opslaget ikke gennemføres: false (hellere en
// alarm for meget).

export async function erFremmedTestobjekt(h: Henvisning): Promise<boolean> {
  const tilstand = noeglensTilstand();
  if (tilstand !== "test") return false;
  try {
    const k = await hentKendte(createAdminClient(), tilstand, [h]);
    return erFremmedTestdata(tilstand, h, k);
  } catch (err) {
    console.error("Fremmede testdata: opslag fejlede - alarmerer som normalt:", err);
    return false;
  }
}

// En charge (fra et event) med dens PaymentIntent (hentes kun i testtilstand).
export async function erFremmedTestCharge(ch: Stripe.Charge): Promise<boolean> {
  if (noeglensTilstand() !== "test") return false;
  let pi: Stripe.PaymentIntent | null = null;
  const piId = sid(ch.payment_intent as string | { id: string } | null);
  if (piId) {
    try {
      pi = await getStripe().paymentIntents.retrieve(piId);
    } catch (err) {
      console.error("Fremmede testdata: PaymentIntent kunne ikke hentes - alarmerer som normalt:", piId, err);
      return false;
    }
  }
  return erFremmedTestobjekt(flet(chargeHenvisning(ch), piHenvisning(pi)));
}

export function logFremmedTestdata(hvad: string, id: string): void {
  console.log(`Fremmede testdata (delt Stripe-testkonto, ikke denne database): ${hvad} ${id} - ingen alarm.`);
}
