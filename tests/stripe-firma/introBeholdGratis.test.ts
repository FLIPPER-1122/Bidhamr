// "Behold Starts gratis måned + introrabat" (20261102450000) mod Stripes
// TESTMILJØ og TESTdatabasen (rigtige kald, ingen mocks ud over next/cache).
// npm run test:firmapakker:stripe -- tests/stripe-firma/introBeholdGratis.test.ts
//
// Samme testfirma ("TEST admin: Firma 2") og sælger-rolle som
// firmapakker.test.ts. Firmaets Stripe-kunde laves på et test clock, så tiden
// kan spoles frem. Kortet er Stripes testkort 4242 4242 4242 4242 (pm_card_visa).
//
// Forløb (staff gør det i den "forkerte" rækkefølge, der før kostede den
// gratis måned): firmaet står som "Venter på første betaling" på Start; staff
// sætter introrabat 50 % i 6 måneder MED valget "Behold Starts gratis måned +
// introrabat" FØR Checkout. Checkout: 0 kr. i dag, 1 gratis måned og
// introkuponen. Fakturaerne: 0 kr., 6 x 249,50 kr. + moms og derefter 499 kr.
// + moms. Uden valget (kontrol): ingen gratis måned - 6 x 249,50 kr. fra måned 1.
//
// Skift op i den gratis måned (Filip, 29. okt. 2026): firmaet skifter til
// Butik på dag 10. Den gratis måned slutter, og introrabatten gælder ALTID i
// præcis 6 måneder regnet fra skiftet - med eller uden valget: præcis 6
// fakturaer med 50 % (499,50 kr. + moms, den første ved skiftet), derefter
// 999 kr. + moms - ikke 7. Tre forløb: med valget; valget nulstillet, fordi
// staff gemmer introrabatten igen efter Checkout; introrabat sat i den gratis
// måned uden valget. Hele forløbet tælles (alle fakturaer fra Stripe).
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  firmaPris,
  introTilStripe,
  sikrMomssats,
  startBetaling,
  synkAbonnement,
  synkFaktura,
  velkomstSkiftForPakke,
} from "@/lib/erhverv/betaling";
import { skiftPakkeForBruger } from "@/lib/erhverv/pakkeskift";
import { introPasser, introResterende, plusMaaneder } from "@/lib/erhverv/abonnementRegler";

const FIRMA = "26849ab7-6678-47b7-a8bd-4d618dfdf9f3";
const SAELGERROLLE = "11111111-1111-4111-8111-000000000008";
const START = "7e57a000-0000-4000-8000-000000000001";
const BUTIK = "7e57a000-0000-4000-8000-000000000002";
// Butiks pris ekskl. moms i øre (999 kr.) og halv pris (499,50 kr.).
const BUTIK_OERE = 99_900;
const BUTIK_HALV = 49_950;
// Starts pris ekskl. moms i øre (499 kr.) og halv pris (249,50 kr.).
const START_OERE = 49_900;
const HALV = 24_950;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-05-27.dahlia" });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let brugerId = "";
let ur: Stripe.TestHelpers.TestClock | null = null;
let kunde = "";
let subId = "";
let t0 = 0;

async function rpc(navn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(navn, args);
  if (error) throw new Error(`${navn}: ${error.message}`);
  return data;
}
async function firma(): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("firmaer").select("*").eq("id", FIRMA).single();
  if (error) throw new Error(error.message);
  return data;
}
async function spol(til: number): Promise<void> {
  await stripe.testHelpers.testClocks.advance(ur!.id, { frozen_time: til });
  for (let i = 0; i < 120; i++) {
    const u = await stripe.testHelpers.testClocks.retrieve(ur!.id);
    if (u.status === "ready") return;
    if (u.status === "internal_failure") throw new Error("test clock fejlede");
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("test clock blev ikke klar");
}
async function fakturaer(): Promise<Stripe.Invoice[]> {
  const ud: Stripe.Invoice[] = [];
  for await (const f of stripe.invoices.list({ subscription: subId, limit: 100 })) ud.push(f);
  return ud.sort((a, b) => a.created - b.created);
}
// ALLE fakturaer ekskl. moms (også 0-kr.-fakturaen for den gratis måned).
async function alleBeloeb(): Promise<number[]> {
  return (await fakturaer()).map((x) => x.total_excluding_tax ?? -1);
}
async function spejlAlt(): Promise<void> {
  await synkAbonnement(await stripe.subscriptions.retrieve(subId));
  for (const f of await fakturaer()) await synkFaktura(f, null);
}

const INTRO_NUL = {
  intro_procent: null,
  intro_maaneder: null,
  intro_fra: null,
  intro_status: null,
  intro_noegle: null,
  intro_coupon_id: null,
  intro_til: null,
  intro_behold_gratis: false,
};

async function nulstilFirma(): Promise<void> {
  if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
  if (ur) await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
  ur = null;
  subId = "";
  const { error } = await db
    .from("firmaer")
    .update({
      stripe_subscription_id: null,
      stripe_customer_id: null,
      stripe_abonnement_status: null,
      abonnement_status: "afventer_betaling",
      pauset_aarsag: null,
      opsiges_fra: null,
      periode_slut: null,
      betalt_til: null,
      proeve_maaneder: 1,
      proeve_slut: null,
      proeve_givet_kl: null,
      proeve_ekstra_ventende: 0,
      proeve_ekstra_sub: null,
      proeve_ekstra_sub_antal: 0,
      gratis_afstemt_sub: null,
      saerpris_oere: null,
      saerpris_pakke_id: null,
      saerpris_aftale: null,
      pakke_id: START,
      naeste_pakke_id: null,
      naeste_pakke_fra: null,
      pakkeskift_i_gang_kl: null,
      pakkeskift_laas: null,
      stripe_pris_synk: false,
      ...INTRO_NUL,
    })
    .eq("id", FIRMA);
  if (error) throw new Error(error.message);
  // Betalte og refunderede regninger fra tidligere tests må ikke tælle som
  // "har betalt" (velkomstfordelen er brugt).
  await db.from("firma_regninger").update({ status: "annulleret" }).eq("firma_id", FIRMA).in("status", ["betalt", "krediteret"]);
  await db.from("firma_pakkeskift").update({ status: "annulleret" }).eq("firma_id", FIRMA).in("status", ["afventer_betaling", "planlagt"]);
}

async function nytUr(navn: string): Promise<void> {
  const f = await firma();
  t0 = Math.floor(Date.now() / 1000);
  ur = await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: navn });
  const k = await stripe.customers.create({
    name: String(f.firmanavn),
    email: "firmapakker@test.bidhamr.dk",
    test_clock: ur.id,
    preferred_locales: ["da"],
    metadata: { firma_id: FIRMA, test: navn },
  });
  kunde = k.id;
  await db.from("firmaer").update({ stripe_customer_id: kunde }).eq("id", FIRMA);
  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: kunde });
  await stripe.customers.update(kunde, { invoice_settings: { default_payment_method: pm.id } });
}

// Den åbne Checkout-session, startBetaling lige har lavet (lukkes igen).
async function nySession(): Promise<Stripe.Checkout.Session> {
  const svar = await startBetaling(brugerId, "https://test.bidhamr.dk");
  expect(svar).toMatchObject({ ok: true });
  let aabne: Stripe.ApiList<Stripe.Checkout.Session> | null = null;
  for (let i = 0; i < 10; i++) {
    aabne = await stripe.checkout.sessions.list({ customer: kunde, status: "open", limit: 5, expand: ["data.discounts"] });
    if (aabne.data.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(aabne!.data).toHaveLength(1);
  const s = aabne!.data[0];
  if ("url" in svar) expect(s.url).toBe(svar.url);
  await stripe.checkout.sessions.expire(s.id);
  return s;
}

function kuponer(s: Stripe.Checkout.Session): string[] {
  return (s.discounts ?? []).map((d) => (typeof d.coupon === "string" ? d.coupon : (d.coupon?.id ?? "")));
}

// Som Checkout: abonnementet med sessionens gratis periode, kupon og metadata.
async function abonnementSomCheckout(s: Stripe.Checkout.Session): Promise<void> {
  const m = s.metadata ?? {};
  const gratis = Number(m.gratis_maaneder ?? 0);
  const k = kuponer(s);
  await spol(t0 + 600);
  const sub = await stripe.subscriptions.create({
    customer: kunde,
    items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, START), quantity: 1 }],
    default_tax_rates: [await sikrMomssats()],
    ...(gratis > 0 ? { trial_end: plusMaaneder(t0, gratis) } : {}),
    ...(k.length ? { discounts: [{ coupon: k[0] }] } : {}),
    metadata: {
      firma_id: FIRMA,
      pakke_id: START,
      gratis_velkomst: m.gratis_velkomst ?? "0",
      maaned1: m.maaned1 ?? "",
      ...(m.velkomst_kupon ? { velkomst_kupon: m.velkomst_kupon } : {}),
      ...(m.intro_noegle ? { intro_noegle: m.intro_noegle, intro_kupon: m.intro_kupon ?? "" } : {}),
    },
  });
  subId = sub.id;
}

// BidHamrs introrabat på abonnementet (id, kupon, start og slut).
async function introRabat(): Promise<{ id: string; kupon: string; start: number; end: number | null } | null> {
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["discounts", "discounts.source.coupon"] });
  const d = sub.discounts.find(
    (x): x is Stripe.Discount => typeof x !== "string" && (x.source.coupon as Stripe.Coupon | null)?.metadata?.bidhamr === "intro",
  );
  return d ? { id: d.id, kupon: (d.source.coupon as Stripe.Coupon).id, start: d.start, end: d.end ?? null } : null;
}

async function nulstilSkiftGraense(): Promise<void> {
  await db.from("rate_limits").delete().eq("noegle", `firma_skift_pakke:${brugerId}`);
}

// Fakturaerne til rapporten: dato (UTC), beløb ekskl. moms og rabat.
async function udskrivFakturaer(navn: string): Promise<void> {
  const linjer = (await fakturaer()).map((x) => {
    const rabat = (x.total_discount_amounts ?? []).reduce((a, r) => a + r.amount, 0);
    const dato = new Date(x.created * 1000).toISOString().slice(0, 10);
    return `${dato}  ${x.billing_reason}  ekskl. moms ${x.total_excluding_tax}  rabat ${rabat}  i alt ${x.total}`;
  });
  console.log(`${navn}:\n${linjer.join("\n")}`);
}

async function saetIntro(behold: boolean): Promise<void> {
  const args: Record<string, unknown> = {
    p_staff: SAELGERROLLE,
    p_firma: FIRMA,
    p_procent: 50,
    p_maaneder: 6,
    p_fra: "efter_gratis",
    p_begrundelse: behold ? "Stripe-test: behold Starts gratis måned + introrabat" : "Stripe-test: introrabat uden gratis måned",
    ...(behold ? { p_behold_gratis: true } : {}),
  };
  expect(await rpc("erhverv_firma_intro_gem", args)).toMatchObject({ kode: "ok" });
}

// Drift-alarmer om introrabatten efter skiftet for netop dette abonnement
// (logDriftFejl: besked = "<hvor>: <tekst>").
async function introAlarmer(siden: string): Promise<string[]> {
  const { data, error } = await db
    .from("drift_fejl")
    .select("besked")
    .like("besked", "erhverv/velkomst-intro-%")
    .gte("senest_kl", siden);
  if (error) throw new Error(`drift_fejl: ${error.message}`);
  return (data ?? []).map((r) => String(r.besked)).filter((b) => b.includes(subId));
}

// Skift op til Butik på dag 10 i den gratis måned, og tæl HELE forløbet:
// 0 kr. (den gratis måned), præcis 6 x 499,50 kr. + moms fra skiftet, derefter
// 999 kr. + moms. Den kørende introrabat (foer) erstattes af en ny med start
// ved skiftet, når den ville give mere end 6 (introFraSkiftet); siden viser
// samme beløb som serveren trækker.
async function skiftOpDag10OgTael(navn: string, forventPaaIgen: boolean): Promise<void> {
  const foer = await introRabat();
  expect(foer).not.toBeNull();
  const dag10 = t0 + 10 * 86_400;
  await spol(dag10);
  // Den kørende kupon set fra skiftet - til rapporten.
  const resterendeFoer = introResterende({ naesteFakturaSek: dag10, rabatSlutSek: foer!.end });
  console.log(
    `${navn}: kørende kupon ${foer!.kupon}, start ${new Date(foer!.start * 1000).toISOString()}, slut ${foer!.end ? new Date(foer!.end * 1000).toISOString() : "ingen"} - giver ${resterendeFoer} rabatfakturaer fra dag 10`,
  );
  const vist = await velkomstSkiftForPakke(brugerId, BUTIK);
  const saettesPaaIgen = resterendeFoer > 6;
  expect(saettesPaaIgen).toBe(forventPaaIgen);
  expect(vist).toMatchObject({
    status: "ok",
    tilbud: {
      udfald: "skift",
      visning: "intro:50",
      rabat: { slags: "intro", procent: 50, maaneder: 6, ...(saettesPaaIgen ? { til: null } : {}) },
      beloeb: { eksklOere: BUTIK_HALV },
      kanSkifte: true,
    },
  });
  if (vist.status === "ok" && saettesPaaIgen) expect(vist.tilbud?.tekst).toContain("50 % rabat i 6 måneder");

  const siden = new Date().toISOString();
  await nulstilSkiftGraense();
  expect(await skiftPakkeForBruger(brugerId, BUTIK, "intro:50")).toMatchObject({ ok: true, kode: "opgraderet" });
  const sub = await stripe.subscriptions.retrieve(subId);
  expect(sub.status).toBe("active");
  expect(sub.items.data[0].price.metadata.pakke_id).toBe(BUTIK);
  // trial_end 'now' nulstiller billing_cycle_anchor til skiftet (det, som
  // spejlingens kontrol regner fra).
  const periodeStart = sub.items.data[0].current_period_start;
  expect(Math.abs(sub.billing_cycle_anchor - periodeStart)).toBeLessThan(60);
  const efter = await introRabat();
  expect(efter).not.toBeNull();
  if (saettesPaaIgen) {
    expect(efter!.id).not.toBe(foer!.id);
    expect(efter!.kupon).toBe("bidhamr_intro_50_6_skift");
    expect(Math.abs(efter!.start - dag10)).toBeLessThan(3600);
  } else {
    expect(efter).toEqual(foer);
  }
  expect(introPasser({ naesteFakturaSek: sub.billing_cycle_anchor, rabatSlutSek: efter!.end, maaneder: 6 })).toBe(true);

  await spejlAlt();
  // Databasen spejler Stripes kupon og slutdato, og kontrollen giver ingen alarm.
  const f = await firma();
  expect(f).toMatchObject({ pakke_id: BUTIK, intro_status: "aktiv", intro_coupon_id: efter!.kupon });
  expect(new Date(String(f.intro_til)).getTime() / 1000).toBe(efter!.end);
  expect(await introAlarmer(siden)).toEqual([]);

  // Én måned ad gangen (Stripe: højst to intervaller pr. spoling).
  for (let m = 1; m <= 7; m++) await spol(plusMaaneder(periodeStart, m) + 1800);
  await spejlAlt();
  await udskrivFakturaer(navn);
  expect(await alleBeloeb()).toEqual([0, ...Array(6).fill(BUTIK_HALV), BUTIK_OERE, BUTIK_OERE]);
  const betalte = (await fakturaer()).filter((x) => x.total > 0);
  expect(betalte).toHaveLength(8);
  expect(betalte.filter((x) => (x.total_discount_amounts ?? []).some((r) => r.amount > 0))).toHaveLength(6);
  expect(betalte.slice(0, 6).map((x) => x.total)).toEqual(Array(6).fill(BUTIK_HALV + Math.round(BUTIK_HALV / 4)));
  expect(betalte[6].total).toBe(BUTIK_OERE + BUTIK_OERE / 4);
}

beforeAll(async () => {
  brugerId = String((await firma()).bruger_id);
  await nulstilFirma();
}, 120_000);

afterAll(async () => {
  await nulstilFirma();
}, 120_000);

describe("Behold Starts gratis måned + introrabat mod Stripes testmiljø (20261102450000)", () => {
  it("introrabat sat FØR Checkout med valget: 0 kr., 6 x 249,50 kr. og derefter 499 kr.", async () => {
    await saetIntro(true);
    expect((await firma()).intro_behold_gratis).toBe(true);
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("gratis");
    const ab = (await rpc("erhverv_firma_abonnement_json", { p_firma: FIRMA })) as Record<string, unknown>;
    expect(ab).toMatchObject({ maaned1: "gratis", gratis_maaneder_ved_start: 1, introrabat: { behold_gratis: true } });

    await nytUr("BidHamr behold gratis + intro");
    const s = await nySession();
    // Starts egen gratis måned (ingen staff-"gratis periode") + introkuponen.
    expect(s.metadata).toMatchObject({ maaned1: "gratis", gratis_maaneder: "1", gratis_velkomst: "1", gratis_ekstra: "0" });
    expect(s.metadata?.intro_kupon).toMatch(/^bidhamr_intro_50_\d+$/);
    expect(s.metadata?.velkomst_kupon).toBeUndefined();
    expect(kuponer(s)).toEqual([s.metadata?.intro_kupon]);
    expect(s.amount_total).toBe(0);
    expect(s.payment_method_types).toEqual(["card"]);

    await abonnementSomCheckout(s);
    await spol(t0 + 3600);
    await spejlAlt();
    const f = await firma();
    expect(f).toMatchObject({ abonnement_status: "aktiv", stripe_abonnement_status: "trialing", intro_status: "aktiv" });
    const sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.metadata.gratis_saeraftale).toBeUndefined();
    expect(sub.metadata.maaned1).toBe("gratis");

    // Én måned ad gangen: Stripe tillader højst to intervaller pr. spoling,
    // og ved månedens slutning (fx 28. feb.) er to intervaller kortere.
    for (let m = 1; m <= 8; m++) await spol(plusMaaneder(t0, m) + 1800);
    await spejlAlt();
    expect(await alleBeloeb()).toEqual([0, HALV, HALV, HALV, HALV, HALV, HALV, START_OERE, START_OERE]);
    // Momsen beregnes af det nedsatte beløb (25 %).
    const betalte = (await fakturaer()).filter((x) => x.total > 0);
    expect(betalte.slice(0, 6).map((x) => x.total)).toEqual(Array(6).fill(HALV + Math.round(HALV / 4)));
    expect(betalte[6].total).toBe(START_OERE + START_OERE / 4);
  }, 900_000);

  it("skift op til Butik på dag 10 med valget: 6 x 499,50 kr. fra skiftet (ikke 7), derefter 999 kr.", async () => {
    await nulstilFirma();
    await saetIntro(true);
    await nytUr("BidHamr behold gratis + skift op");
    const s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "gratis", gratis_maaneder: "1" });
    await abonnementSomCheckout(s);
    await spol(t0 + 3600);
    await spejlAlt();
    expect(await firma()).toMatchObject({ intro_status: "aktiv", intro_behold_gratis: true, stripe_abonnement_status: "trialing" });
    await skiftOpDag10OgTael("Med valget + skift op til Butik dag 10", false);
  }, 900_000);

  it("staff gemmer introrabatten igen efter Checkout (valget nulstilles) + skift op dag 10: præcis 6 med rabat", async () => {
    await nulstilFirma();
    await saetIntro(true);
    await nytUr("BidHamr behold gemt igen + skift op");
    const s = await nySession();
    await abonnementSomCheckout(s);
    await spol(t0 + 3600);
    await spejlAlt();
    expect(await firma()).toMatchObject({ intro_status: "aktiv", intro_behold_gratis: true });
    // Dag 2: staff gemmer introrabatten igen (uden valget - det kan ikke vælges
    // efter Checkout), og den sættes på abonnementet.
    await spol(t0 + 2 * 86_400);
    await saetIntro(false);
    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "ok" });
    expect(await firma()).toMatchObject({ intro_status: "aktiv", intro_behold_gratis: false });
    await skiftOpDag10OgTael("Gemt igen efter Checkout (uden valget) + skift op til Butik dag 10", false);
  }, 900_000);

  it("introrabat sat i den gratis måned uden valget + skift op dag 10: præcis 6 med rabat, derefter fuld pris", async () => {
    await nulstilFirma();
    await nytUr("BidHamr intro uden valget + skift op");
    const s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "gratis", gratis_maaneder: "1" });
    expect(kuponer(s)).toEqual([]);
    await abonnementSomCheckout(s);
    await spol(t0 + 3600);
    await spejlAlt();
    // Introrabat sat i den gratis måned, uden valget.
    await saetIntro(false);
    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "ok" });
    expect(await firma()).toMatchObject({ intro_status: "aktiv", intro_behold_gratis: false });
    await skiftOpDag10OgTael("Uden valget (sat i den gratis måned) + skift op til Butik dag 10", false);
  }, 900_000);

  it("kupon, der løber til trial_end + 6 md. (7 fra skiftet), uden valget + skift op dag 10: sættes på igen - præcis 6", async () => {
    await nulstilFirma();
    await nytUr("BidHamr intro til trial_end + 6 md. + skift op");
    const s = await nySession();
    await abonnementSomCheckout(s);
    await spol(t0 + 3600);
    await spejlAlt();
    await saetIntro(false);
    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "ok" });
    // Den kørende introrabat erstattes af en kupon i 7 måneder fra nu - den
    // løber til ca. trial_end + 6 md. og ville give 7 rabatfakturaer fra
    // skiftet. Databasen peger på den (som efter en spejling).
    const kuponId = "bidhamr_intro_50_7";
    try {
      await stripe.coupons.retrieve(kuponId);
    } catch {
      await stripe.coupons.create(
        {
          id: kuponId,
          name: "Introrabat 50 %",
          percent_off: 50,
          duration: "repeating",
          duration_in_months: 7,
          metadata: { bidhamr: "intro", procent: "50", maaneder: "7" },
        },
        { idempotencyKey: `test-kupon-${kuponId}` },
      );
    }
    await stripe.subscriptions.update(subId, { discounts: [{ coupon: kuponId }] }, { idempotencyKey: `test-intro7-${subId}` });
    const ny = await introRabat();
    expect(ny?.kupon).toBe(kuponId);
    const { error } = await db
      .from("firmaer")
      .update({ intro_coupon_id: kuponId, intro_til: new Date(ny!.end! * 1000).toISOString() })
      .eq("id", FIRMA);
    if (error) throw new Error(error.message);
    await skiftOpDag10OgTael("Kupon til trial_end + 6 md. (uden valget) + skift op til Butik dag 10", true);
  }, 900_000);

  it("kontrol uden valget: introrabatten erstatter den gratis måned (6 x 249,50 kr. fra måned 1)", async () => {
    await nulstilFirma();
    await saetIntro(false);
    expect((await firma()).intro_behold_gratis).toBe(false);
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");
    await nytUr("BidHamr intro uden gratis");
    const s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "ingen", gratis_maaneder: "0" });
    expect(s.total_details?.amount_discount).toBe(HALV);
  }, 300_000);
});
