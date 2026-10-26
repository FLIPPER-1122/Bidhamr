// Firmapakkerne mod Stripes TESTMILJØ og TESTdatabasen (rigtige kald, ingen
// mocks ud over next/cache). npm run test:firmapakker:stripe
//
// Bruger testfirmaet "TEST admin: Firma 2" (testdatabasen) og sælger-rollen
// "Ebbe Erhvervssælger" som staff. Firmaets Stripe-kunde laves på et Stripe
// test clock, så tiden kan spoles frem og fakturaerne ses. Kortet er Stripes
// testkort 4242 4242 4242 4242 (pm_card_visa).
//
// Forløb:
//   1. Firmaet nulstilles til "Venter på første betaling" på Start med
//      introrabat 50 % i 6 måneder (som fra en godkendt henvendelse).
//   2. "Betal for din pakke": startBetaling laver en Checkout-session med 1
//      gratis måned (Stripe accepterer parametrene). Sessionen lukkes igen, og
//      Checkouts udfald efterlignes: kort 4242 + abonnement med trial_end.
//   3. Webhook-spejlet (synkAbonnement/synkFaktura): firmaet er aktivt i den
//      gratis periode, introrabatten er sat på (kupon, repeating), kortet spejlet.
//   4. Opgradering i den gratis periode (Start -> Butik): med det samme, uden
//      betaling.
//   5. Særpris på Butik (799 kr.) og +1 gratis måned (introrabatten flyttes).
//   6. Tiden spoles frem: 2 gratis måneder (0 kr.), 6 fakturaer med 50 % rabat
//      på 799 kr. + moms, og derefter fuld pris.
//   7. Opgradering, mens abonnementet er aktivt (Butik -> Pro): forskellen
//      trækkes på kortet med det samme, og pakken skifter.
//   8. Hel refusion af en betalt regning med kreditnota - også en regning
//      med introrabat (refund_amount = det betalte), og en refusion, hvor
//      databasen ikke nåede at følge med, spejles bagefter (sidder ikke fast).
//   9. Prissynk efter flytningen til de nye pakker: en gammel plan
//      (nedgradering annulleret i databasen) frigives i Stripe, før prisen
//      skiftes.
//
// Anden del (eget test clock, 20261102020000):
//  10. Gratis måneder til et firma, der har haft en gratis periode før:
//      lægges oven i Checkout (gratis_ekstra), dobbeltklik afvises, og de
//      trækkes fra, når abonnementet er startet.
//  11. Nedgradering med introrabat: rabatten følger med i planens faser og
//      gælder til introrabattens slutdato - også på den mindre pakke.
//  12. Firmaoplysninger (adresse og CVR) til Stripe-kunden, inkl. momsnummer.
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  givGratisPeriodeStripe,
  introTilStripe,
  refunderRegningStripe,
  saetSaerprisStripe,
  frigivPakkeskiftLaas,
  startBetaling,
  synkAbonnement,
  synkFaktura,
  sikrMomssats,
  firmaPris,
  koerAbonnementSynk,
  synkKundeStripe,
} from "@/lib/erhverv/betaling";
import { skiftPakkeForBruger } from "@/lib/erhverv/pakkeskift";
import { plusMaaneder } from "@/lib/erhverv/abonnementRegler";

const FIRMA = "26849ab7-6678-47b7-a8bd-4d618dfdf9f3";
const SAELGERROLLE = "11111111-1111-4111-8111-000000000008";
const START = "7e57a000-0000-4000-8000-000000000001";
const BUTIK = "7e57a000-0000-4000-8000-000000000002";
const PRO = "7e57a000-0000-4000-8000-000000000003";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-05-27.dahlia" });
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let brugerId = "";
let ur: Stripe.TestHelpers.TestClock;
let kunde = "";
let subId = "";
let t0 = 0;

async function rpc(navn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc(navn, args);
  if (error) throw new Error(`${navn}: ${error.message}`);
  return data as Record<string, unknown>;
}
async function firma(): Promise<Record<string, unknown>> {
  const { data, error } = await db.from("firmaer").select("*").eq("id", FIRMA).single();
  if (error) throw new Error(error.message);
  return data;
}
async function spol(til: number): Promise<void> {
  await stripe.testHelpers.testClocks.advance(ur.id, { frozen_time: til });
  for (let i = 0; i < 120; i++) {
    const u = await stripe.testHelpers.testClocks.retrieve(ur.id);
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
async function spejlAlt(): Promise<void> {
  await synkAbonnement(await stripe.subscriptions.retrieve(subId));
  for (const f of await fakturaer()) await synkFaktura(f, null);
}

beforeAll(async () => {
  const f = await firma();
  brugerId = String(f.bruger_id);
  // Nulstil et tidligere abonnement (fra en tidligere kørsel).
  if (f.stripe_subscription_id) {
    await stripe.subscriptions.cancel(String(f.stripe_subscription_id)).catch(() => {});
  }
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
      saerpris_oere: null,
      saerpris_pakke_id: null,
      saerpris_aftale: null,
      pakke_id: START,
      naeste_pakke_id: null,
      naeste_pakke_fra: null,
      pakkeskift_i_gang_kl: null,
      pakkeskift_laas: null,
      kort_maerke: null,
      kort_sidste4: null,
      kort_udloeb_maaned: null,
      kort_udloeb_aar: null,
    })
    .eq("id", FIRMA);
  if (error) throw new Error(error.message);
  // Gamle regninger fra en tidligere kørsel må ikke tælle som "har betalt".
  await db.from("firma_regninger").update({ status: "annulleret" }).eq("firma_id", FIRMA).eq("status", "betalt");
  await db.from("firma_pakkeskift").update({ status: "annulleret" }).eq("firma_id", FIRMA).in("status", ["afventer_betaling", "planlagt"]);

  // Introrabat som fra henvendelsen (sælger-rollen).
  expect(
    await rpc("erhverv_firma_intro_gem", {
      p_staff: SAELGERROLLE,
      p_firma: FIRMA,
      p_procent: 50,
      p_maaneder: 6,
      p_fra: "efter_gratis",
      p_begrundelse: "Stripe-test: introrabat fra henvendelsen",
    }),
  ).toMatchObject({ kode: "ok" });

  t0 = Math.floor(Date.now() / 1000);
  ur = await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: "BidHamr firmapakker" });
  const k = await stripe.customers.create({
    name: String(f.firmanavn),
    email: "firmapakker@test.bidhamr.dk",
    test_clock: ur.id,
    preferred_locales: ["da"],
    metadata: { firma_id: FIRMA, test: "firmapakker" },
  });
  kunde = k.id;
  await db.from("firmaer").update({ stripe_customer_id: kunde }).eq("id", FIRMA);
}, 120_000);

afterAll(async () => {
  // Test clock'et slettes med alt på det (kunde, abonnement, fakturaer).
  if (ur) await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
  // Firmaet efterlades som "Venter på første betaling" (som før testen).
  await db
    .from("firmaer")
    .update({
      stripe_subscription_id: null,
      stripe_customer_id: null,
      stripe_abonnement_status: null,
      abonnement_status: "afventer_betaling",
      proeve_slut: null,
      proeve_givet_kl: null,
      intro_procent: null,
      intro_maaneder: null,
      intro_fra: null,
      intro_status: null,
      intro_coupon_id: null,
      intro_til: null,
      saerpris_oere: null,
      saerpris_pakke_id: null,
      saerpris_aftale: null,
      pakke_id: START,
      periode_slut: null,
      betalt_til: null,
    })
    .eq("id", FIRMA);
}, 120_000);

describe("firmapakker mod Stripes testmiljø", () => {
  it("1-2. Checkout med 1 gratis måned oprettes (og lukkes igen)", async () => {
    const svar = await startBetaling(brugerId, "https://test.bidhamr.dk");
    expect(svar).toMatchObject({ ok: true });
    const sessioner = await stripe.checkout.sessions.list({ customer: kunde, status: "open", limit: 5 });
    expect(sessioner.data).toHaveLength(1);
    const s = sessioner.data[0];
    expect(s.metadata).toMatchObject({ firma_id: FIRMA, pakke_id: START, gratis_maaneder: "1" });
    expect(s.payment_method_collection).toBe("always");
    // Første betaling i dag er 0 kr. (gratis måned).
    expect(s.amount_total).toBe(0);
    // Introrabatten (50 % i 6 betalte måneder efter den gratis måned) er på
    // allerede i Checkout, så Stripe viser den rigtige pris bagefter. Kuponen
    // tæller fra oprettelsen: 1 gratis + 6 betalte = 6 måneder
    // (introKuponMaanederCheckout - abonnementet oprettes efter sessionen).
    expect((s.discounts ?? []).map((d) => (typeof d.coupon === "string" ? d.coupon : d.coupon?.id))).toEqual([
      "bidhamr_intro_50_6",
    ]);
    expect(s.metadata).toMatchObject({ intro_kupon: "bidhamr_intro_50_6" });
    expect(s.metadata?.intro_noegle).toBeTruthy();
    await stripe.checkout.sessions.expire(s.id);
  });

  it("3. abonnement med kort 4242 og trial: aktivt, introrabat og kort spejlet", async () => {
    // Som Checkout: kortet gemmes som standard, abonnementet starter med trial_end.
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: kunde });
    await stripe.customers.update(kunde, { invoice_settings: { default_payment_method: pm.id } });
    const f = await firma();
    const sub = await stripe.subscriptions.create({
      customer: kunde,
      items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, START), quantity: 1 }],
      default_tax_rates: [await sikrMomssats()],
      default_payment_method: pm.id,
      trial_end: plusMaaneder(t0, Number(f.proeve_maaneder)),
      metadata: { firma_id: FIRMA, pakke_id: START },
    });
    subId = sub.id;
    expect(sub.status).toBe("trialing");
    // Webhooken kommer et øjeblik efter Checkout (aldrig i samme sekund som
    // fakturaen): spol 1 time frem, og spejl som webhooken.
    await spol(t0 + 3600);
    await spejlAlt();
    const efter = await firma();
    expect(efter).toMatchObject({
      abonnement_status: "aktiv",
      stripe_abonnement_status: "trialing",
      intro_status: "aktiv",
      kort_maerke: "visa",
      kort_sidste4: "4242",
    });
    expect(new Date(String(efter.proeve_slut)).getTime() / 1000).toBe(plusMaaneder(t0, 1));
    const s = await stripe.subscriptions.retrieve(subId, { expand: ["discounts", "discounts.source.coupon"] });
    const d = s.discounts[0] as Stripe.Discount;
    const kupon = d.source.coupon as Stripe.Coupon;
    expect(kupon).toMatchObject({ percent_off: 50, duration: "repeating", duration_in_months: 6 });
  });

  it("4. opgradering i den gratis periode sker med det samme uden betaling", async () => {
    const svar = await skiftPakkeForBruger(brugerId, BUTIK);
    expect(svar).toMatchObject({ ok: true, kode: "opgraderet" });
    const f = await firma();
    expect(f.pakke_id).toBe(BUTIK);
    const s = await stripe.subscriptions.retrieve(subId);
    expect(s.items.data[0].price.metadata.pakke_id).toBe(BUTIK);
    expect(s.status).toBe("trialing");
    // Ingen ny regning med beløb.
    expect((await fakturaer()).filter((x) => x.amount_due > 0)).toHaveLength(0);
  });

  it("5. særpris 799 kr. og +1 gratis måned (introrabatten flyttes med)", async () => {
    const saer = await saetSaerprisStripe(FIRMA, BUTIK, 79_900, "naeste_betaling");
    expect(saer.status).toBe("ok");
    if (saer.status !== "ok") return;
    try {
      expect(
        await rpc("erhverv_firma_saerpris_gem", {
          p_staff: SAELGERROLLE,
          p_firma: FIRMA,
          p_oere: 79_900,
          p_pakke: BUTIK,
          p_aftale: "Stripe-test: aftalt særpris",
          p_fra: "naeste_betaling",
        }),
      ).toMatchObject({ kode: "ok" });
    } finally {
      await frigivPakkeskiftLaas(FIRMA, saer.laas);
    }
    const s = await stripe.subscriptions.retrieve(subId);
    expect(s.items.data[0].price).toMatchObject({ unit_amount: 79_900, metadata: { pakke_id: BUTIK, firma_id: FIRMA } });

    const gratis = await givGratisPeriodeStripe(FIRMA, 1);
    expect(gratis.status).toBe("ok");
    if (gratis.status !== "ok") return;
    expect(new Date(String(gratis.proeveSlut)).getTime() / 1000).toBe(plusMaaneder(plusMaaneder(t0, 1), 1));
    expect(
      await rpc("erhverv_firma_gratis_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_maaneder: 1,
        p_begrundelse: "Stripe-test: ekstra gratis måned",
        p_stripe: true,
        p_proeve_slut: gratis.proeveSlut,
      }),
    ).toMatchObject({ kode: "ok" });
    const efter = await stripe.subscriptions.retrieve(subId, { expand: ["discounts", "discounts.source.coupon"] });
    const kupon = (efter.discounts[0] as Stripe.Discount).source.coupon as Stripe.Coupon;
    // 2 gratis måneder i alt: kuponen dækker dem + 6 betalte.
    expect(kupon).toMatchObject({ percent_off: 50, duration_in_months: 7 });
    // introTilStripe er idempotent (samme aftale = intet nyt).
    expect((await introTilStripe(FIRMA)).status).toBe("ok");
  });

  it("6. fakturaerne: 2 gratis måneder, 6 med 50 % rabat på 799 kr. + moms, så fuld pris", async () => {
    // Højst 2 måneder pr. spol (Stripes grænse for månedlige abonnementer).
    for (const m of [2, 4, 6, 8]) await spol(plusMaaneder(t0, m) + 1800);
    await spol(plusMaaneder(t0, 9) + 1800);
    const alle = (await fakturaer()).filter((f) => f.billing_reason === "subscription_cycle" || f.billing_reason === "subscription_create");
    const beloeb = alle.map((f) => f.total);
    // Fakturaen ved oprettelsen (gratis), 2. måned gratis ligger i samme trial,
    // derefter 6 x (399,50 kr. + 25 % moms = 499,38 kr.) og fuld pris (998,75 kr.).
    const halv = Math.round(79_900 * 0.5 * 1.25);
    const fuld = Math.round(79_900 * 1.25);
    expect(beloeb[0]).toBe(0);
    expect(beloeb.slice(1, 7)).toEqual([halv, halv, halv, halv, halv, halv]);
    expect(beloeb[7]).toBe(fuld);
    for (const f of alle.slice(1, 8)) expect(f.status).toBe("paid");
    await spejlAlt();
    const { data: regninger } = await db
      .from("firma_regninger")
      .select("type, status, beloeb_oere")
      .eq("firma_id", FIRMA)
      .eq("type", "abonnement")
      .eq("status", "betalt");
    expect((regninger ?? []).filter((r) => r.beloeb_oere === halv)).toHaveLength(6);
  }, 600_000);

  it("7. opgradering, mens abonnementet er aktivt (Butik -> Pro): forskellen trækkes på kortet", async () => {
    await db.from("firmaer").update({ pakkeskift_i_gang_kl: null }).eq("id", FIRMA);
    const svar = await skiftPakkeForBruger(brugerId, PRO);
    expect(svar).toMatchObject({ ok: true, kode: "opgraderet" });
    const f = await firma();
    expect(f.pakke_id).toBe(PRO);
    // Særprisen gjaldt Butik og er bortfaldet.
    expect(f.saerpris_oere).toBeNull();
    const s = await stripe.subscriptions.retrieve(subId);
    expect(s.items.data[0].price).toMatchObject({ unit_amount: 199_900, metadata: { pakke_id: PRO } });
    const opg = (await fakturaer()).filter((x) => x.billing_reason === "subscription_update" && x.amount_paid > 0);
    expect(opg.length).toBe(1);
  }, 120_000);

  it("8. hel refusion af en betalt regning med kreditnota", async () => {
    const { data: r } = await db
      .from("firma_regninger")
      .select("id, stripe_invoice_id, beloeb_oere")
      .eq("firma_id", FIRMA)
      .eq("type", "abonnement")
      .eq("status", "betalt")
      .gt("beloeb_oere", 0)
      .order("oprettet_kl", { ascending: false })
      .limit(1)
      .single();
    const svar = await refunderRegningStripe(r!.id);
    expect(svar).toMatchObject({ status: "ok", beloebOere: r!.beloeb_oere });
    const noter = await stripe.creditNotes.list({ invoice: r!.stripe_invoice_id!, limit: 5 });
    expect(noter.data).toHaveLength(1);
    expect(noter.data[0].total).toBe(r!.beloeb_oere);
    expect(noter.data[0].refunds?.length ?? 0).toBeGreaterThan(0);
    // Igen: afvist (ingen dobbelt refusion).
    expect(await refunderRegningStripe(r!.id)).toMatchObject({ status: "afvist" });
    const { data: efter } = await db.from("firma_regninger").select("status").eq("id", r!.id).single();
    expect(efter!.status).toBe("krediteret");
  }, 120_000);

  it("8b. refusion af en regning med introrabat: refund_amount = det betalte; en refusion, databasen ikke fulgte, spejles", async () => {
    const halv = Math.round(79_900 * 0.5 * 1.25);
    const { data: r } = await db
      .from("firma_regninger")
      .select("id, stripe_invoice_id, beloeb_oere")
      .eq("firma_id", FIRMA)
      .eq("type", "abonnement")
      .eq("status", "betalt")
      .eq("beloeb_oere", halv)
      .order("oprettet_kl", { ascending: true })
      .limit(1)
      .single();
    const faktura = await stripe.invoices.retrieve(r!.stripe_invoice_id!);
    expect(faktura.amount_paid).toBe(halv);
    expect((faktura.total_discount_amounts ?? []).reduce((a, d) => a + d.amount, 0)).toBeGreaterThan(0);
    const svar = await refunderRegningStripe(r!.id);
    expect(svar).toMatchObject({ status: "ok", beloebOere: halv });
    const noter = await stripe.creditNotes.list({ invoice: r!.stripe_invoice_id!, limit: 5 });
    expect(noter.data).toHaveLength(1);
    expect(noter.data[0].total).toBe(halv);
    const refunderet = (noter.data[0].refunds ?? []).reduce((a, x) => a + x.amount_refunded, 0);
    expect(refunderet).toBe(halv);
    // Databasen "nåede ikke at følge med" (fx fejl lige efter Stripe-kaldet):
    // næste forsøg spejler kreditnotaen i stedet for at sidde fast.
    await db.from("firma_regninger").update({ status: "betalt" }).eq("id", r!.id);
    expect(await refunderRegningStripe(r!.id)).toMatchObject({ status: "ok", beloebOere: halv });
    expect((await stripe.creditNotes.list({ invoice: r!.stripe_invoice_id!, limit: 5 })).data).toHaveLength(1);
    const { data: efter } = await db.from("firma_regninger").select("status").eq("id", r!.id).single();
    expect(efter!.status).toBe("krediteret");
  }, 120_000);

  it("9. prissynk efter flytningen: en gammel plan frigives i Stripe, før prisen skiftes", async () => {
    // Firmaet planlægger en nedgradering (Pro -> Butik): Stripe-plan.
    await db.from("firmaer").update({ pakkeskift_i_gang_kl: null, pakkeskift_laas: null }).eq("id", FIRMA);
    const svar = await skiftPakkeForBruger(brugerId, BUTIK);
    expect(svar).toMatchObject({ ok: true, kode: "nedgradering_planlagt" });
    expect((await stripe.subscriptions.retrieve(subId)).schedule).toBeTruthy();
    // Som migrationen 20261102010000: skiftet annulleres i DATABASEN, og
    // prisen skal synkes - men planen ligger stadig i Stripe.
    await db.from("firma_pakkeskift").update({ status: "annulleret" }).eq("firma_id", FIRMA).eq("status", "planlagt");
    await db
      .from("firmaer")
      .update({ naeste_pakke_id: null, naeste_pakke_fra: null, stripe_pris_synk: true, stripe_synk_forsoegt_kl: null })
      .eq("id", FIRMA);
    const ud = await koerAbonnementSynk();
    expect(ud.priser).toBeGreaterThanOrEqual(1);
    const s = await stripe.subscriptions.retrieve(subId);
    expect(s.schedule).toBeNull();
    expect(s.items.data[0].price.metadata.pakke_id).toBe(PRO);
    const f = await firma();
    expect(f.stripe_pris_synk).toBe(false);
    expect(f.pakke_id).toBe(PRO);
  }, 180_000);
});

// =============================================================================
// Anden del: eget test clock (20261102020000)
// =============================================================================
describe("firmapakker-rettelser mod Stripes testmiljø", () => {
  const SAERCVR = String(90_000_000 + Math.floor(Math.random() * 9_999_999));
  let gammeltCvr = "";
  let rabatSlut = 0;

  beforeAll(async () => {
    // Første del er færdig: dens abonnement og test clock ryddes.
    if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
    if (ur) await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
    const f = await firma();
    gammeltCvr = String(f.cvr);
    // Firmaet har haft en gratis periode før (fx stoppet af Stripe pga.
    // manglende betaling) og venter nu på at betale igen - på Butik, med en
    // introrabat på 50 % i 3 måneder fra nu.
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
        proeve_givet_kl: new Date(Date.now() - 90 * 86400_000).toISOString(),
        proeve_ekstra_ventende: 0,
        proeve_ekstra_sub: null,
        saerpris_oere: null,
        saerpris_pakke_id: null,
        saerpris_aftale: null,
        pakke_id: BUTIK,
        naeste_pakke_id: null,
        naeste_pakke_fra: null,
        pakkeskift_i_gang_kl: null,
        pakkeskift_laas: null,
        stripe_pris_synk: false,
      })
      .eq("id", FIRMA);
    if (error) throw new Error(error.message);
    await db.from("firma_regninger").update({ status: "annulleret" }).eq("firma_id", FIRMA).eq("status", "betalt");
    await db.from("firma_pakkeskift").update({ status: "annulleret" }).eq("firma_id", FIRMA).in("status", ["afventer_betaling", "planlagt"]);
    expect(
      await rpc("erhverv_firma_intro_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_procent: 50,
        p_maaneder: 3,
        p_fra: "straks",
        p_begrundelse: "Stripe-test: introrabat før nedgradering",
      }),
    ).toMatchObject({ kode: "ok" });

    t0 = Math.floor(Date.now() / 1000);
    ur = await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: "BidHamr firmapakker-rettelser" });
    const k = await stripe.customers.create({
      name: String(f.firmanavn),
      email: "firmapakker@test.bidhamr.dk",
      test_clock: ur.id,
      preferred_locales: ["da"],
      metadata: { firma_id: FIRMA, test: "firmapakker-rettelser" },
    });
    kunde = k.id;
    subId = "";
    await db.from("firmaer").update({ stripe_customer_id: kunde }).eq("id", FIRMA);
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: kunde });
    await stripe.customers.update(kunde, { invoice_settings: { default_payment_method: pm.id } });
  }, 120_000);

  afterAll(async () => {
    // CVR'et tilbage (hvis testen 12 stoppede halvvejs).
    if (gammeltCvr) await db.from("firmaer").update({ cvr: gammeltCvr }).eq("id", FIRMA);
    await db.from("firmaer").update({ proeve_ekstra_ventende: 0, proeve_ekstra_sub: null }).eq("id", FIRMA);
  }, 60_000);

  it("10a. gratis måneder til et firma, der har haft en gratis periode: venter til Checkout; dobbeltklik afvises", async () => {
    const klik = randomUUID();
    const args = {
      p_staff: SAELGERROLLE,
      p_firma: FIRMA,
      p_maaneder: 2,
      p_begrundelse: "Stripe-test: 2 gratis måneder igen",
      p_stripe: false,
      p_proeve_slut: null,
      p_klik: klik,
    };
    expect(await rpc("erhverv_firma_gratis_gem", args)).toMatchObject({ kode: "ok", hvor: "ventende", gratis_maaneder_ved_start: 2 });
    expect(await rpc("erhverv_firma_gratis_gem", args)).toMatchObject({ kode: "allerede_udfoert" });
    expect((await firma()).proeve_ekstra_ventende).toBe(2);
    expect(await rpc("erhverv_staff_klik_brugt", { p_klik: klik })).toBe(true);

    // Checkout: 2 gratis måneder (ingen velkomstperiode - den er brugt).
    expect(await startBetaling(brugerId, "https://test.bidhamr.dk")).toMatchObject({ ok: true });
    const sessioner = await stripe.checkout.sessions.list({ customer: kunde, status: "open", limit: 5 });
    expect(sessioner.data).toHaveLength(1);
    const s = sessioner.data[0];
    expect(s.metadata).toMatchObject({ firma_id: FIRMA, pakke_id: BUTIK, gratis_maaneder: "2", gratis_ekstra: "2" });
    expect(s.amount_total).toBe(0);
    await stripe.checkout.sessions.expire(s.id);
  });

  it("10b. abonnementet starter med de ventende måneder: de trækkes fra (én gang)", async () => {
    // Som Checkout: trial_end + metadata gratis_ekstra (her 1 dag, så
    // nedgraderingen herunder kan testes på et betalt abonnement).
    const sub = await stripe.subscriptions.create({
      customer: kunde,
      items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, BUTIK), quantity: 1 }],
      default_tax_rates: [await sikrMomssats()],
      trial_end: t0 + 86_400,
      metadata: { firma_id: FIRMA, pakke_id: BUTIK, gratis_ekstra: "2" },
    });
    subId = sub.id;
    await spol(t0 + 3600);
    await spejlAlt();
    await spejlAlt();
    const f = await firma();
    expect(f).toMatchObject({ abonnement_status: "aktiv", proeve_ekstra_ventende: 0, proeve_ekstra_sub: subId, intro_status: "aktiv" });
    const s = await stripe.subscriptions.retrieve(subId, { expand: ["discounts"] });
    const d = s.discounts[0] as Stripe.Discount;
    expect(d.end).toBeTruthy();
    rabatSlut = d.end!;
  }, 120_000);

  it("11a. nedgradering Butik -> Start: introrabatten ligger i begge faser af planen", async () => {
    // Den gratis dag er slut: første betaling (Butik med 50 %).
    await spol(t0 + 86_400 + 3600);
    await spejlAlt();
    expect((await firma()).abonnement_status).toBe("aktiv");
    await db.from("firmaer").update({ pakkeskift_i_gang_kl: null, pakkeskift_laas: null }).eq("id", FIRMA);
    const svar = await skiftPakkeForBruger(brugerId, START);
    expect(svar).toMatchObject({ ok: true, kode: "nedgradering_planlagt" });
    const s = await stripe.subscriptions.retrieve(subId, { expand: ["discounts"] });
    const rabat = (s.discounts[0] as Stripe.Discount).id;
    const plan = await stripe.subscriptionSchedules.retrieve(String(typeof s.schedule === "string" ? s.schedule : s.schedule?.id));
    expect(plan.phases).toHaveLength(2);
    for (const fase of plan.phases) {
      expect(fase.discounts.map((x) => (typeof x.discount === "string" ? x.discount : x.discount?.id))).toContain(rabat);
    }
  }, 120_000);

  it("11b. fakturaerne efter nedgraderingen: Start med 50 % til introrabattens slutdato, derefter fuld pris", async () => {
    const forsteBetalt = t0 + 86_400;
    for (const m of [2, 4]) await spol(plusMaaneder(forsteBetalt, m) + 3600);
    await spejlAlt();
    const cyklus = (await fakturaer()).filter((x) => x.billing_reason === "subscription_cycle");
    // Første cyklus-faktura er Butik (ved trial_end); resten er Start.
    const startFakturaer = cyklus.filter((x) => x.created > forsteBetalt + 7200);
    expect(startFakturaer.length).toBeGreaterThanOrEqual(3);
    const halv = Math.round(49_900 * 0.5 * 1.25);
    const fuld = Math.round(49_900 * 1.25);
    for (const x of startFakturaer) {
      expect(x.status).toBe("paid");
      expect(x.total).toBe(x.created < rabatSlut ? halv : fuld);
    }
    // Rabatten gjaldt på Start (mindst én), og den sluttede (mindst én fuld).
    expect(startFakturaer.filter((x) => x.total === halv).length).toBeGreaterThanOrEqual(1);
    expect(startFakturaer.filter((x) => x.total === fuld).length).toBeGreaterThanOrEqual(1);
    const f = await firma();
    expect(f.pakke_id).toBe(START);
  }, 600_000);

  it("12. firmaoplysninger til Stripe-kunden: adresse og CVR (momsnummeret byttes ud)", async () => {
    await db.from("firmaer").update({ cvr: SAERCVR, adresse: "Testvej 12" }).eq("id", FIRMA);
    const f = await firma();
    expect(Number(f.stripe_kunde_version)).toBeGreaterThan(Number(f.stripe_kunde_synket_version));
    expect(await synkKundeStripe(FIRMA, Number(f.stripe_kunde_version))).toBe("ok");
    const k = (await stripe.customers.retrieve(kunde)) as Stripe.Customer;
    expect(k.address?.line1).toBe("Testvej 12");
    expect(k.metadata.cvr).toBe(SAERCVR);
    const moms = (await stripe.customers.listTaxIds(kunde, { limit: 10 })).data.filter((t) => t.type === "eu_vat");
    expect(moms.map((t) => t.value)).toEqual([`DK${SAERCVR}`]);
    expect((await firma()).stripe_kunde_synket_version).toBe(f.stripe_kunde_version);

    // CVR tilbage: det gamle momsnummer erstatter det nye.
    await db.from("firmaer").update({ cvr: gammeltCvr }).eq("id", FIRMA);
    const igen = await firma();
    expect(await synkKundeStripe(FIRMA, Number(igen.stripe_kunde_version))).toBe("ok");
    const moms2 = (await stripe.customers.listTaxIds(kunde, { limit: 10 })).data.filter((t) => t.type === "eu_vat");
    expect(moms2.map((t) => t.value)).toEqual([`DK${gammeltCvr}`]);
  }, 120_000);
});
