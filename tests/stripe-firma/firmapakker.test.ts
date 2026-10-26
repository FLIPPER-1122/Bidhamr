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
//   8. Hel refusion af en betalt regning med kreditnota.
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
});
