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
//   5. Særpris afvises, mens introrabatten kører (særpris og introrabat kan
//      ikke kombineres - Filip, 27. okt. 2026), og +1 gratis måned
//      (introrabatten flyttes).
//   6. Tiden spoles frem: 2 gratis måneder (0 kr.), 6 fakturaer med 50 % rabat
//      på Butiks pris (999 kr.) + moms, og derefter fuld pris.
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
//
// Tredje del (egne test clocks, 20261102030000):
//  13. Gratis måneder, mens firmaet har en åben Checkout: sessionen lukkes;
//      betaler firmaet alligevel med den gamle, lægges de manglende måneder
//      (velkomst + ventende) på ved start - én gang - og introrabatten flyttes.
//  14. Introrabat mod en planlagt nedgradering: venter (staff, webhook, cron),
//      til planen er afgjort; "fjern" afvises med en dansk besked.
//  15. Introkupon fra Checkout, der ikke rammer præcis N betalte måneder,
//      sættes på igen ved spejlingen.
//
// Femte del (egne test clocks, 20261102070000 - regel for måned 1):
//  M1. Start: første måned gratis, fuld pris fra måned 2; kun kort; CVR-felt.
//  M2. Butik: 50 % i måned 1, fuld pris fra måned 2; nedgradering til Start
//      i måned 1 gælder fra måned 2.
//  M3. Start opgraderet til Pro i den gratis måned: 50 % af Pro nu, fuld pris
//      fra næste måned.
//  M4. Introrabat på Start og Butik: 6 x 50 %, ingen gratis måned.
//  M5. Tidligere CVR med og uden særaftale; CVR-skift kan ikke omgå reglen.
//
// Fjerde del (kun databasen, 20261102050000):
//  16. Særpris og introrabat kan ikke kombineres: begge veje, fjerne er altid
//      tilladt, og en udløbet introrabat blokerer ikke.
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  fjernIntroStripe,
  givGratisPeriodeStripe,
  introTilStripe,
  lukAabneCheckout,
  refunderRegningStripe,
  saetSaerprisStripe,
  startBetaling,
  synkAbonnement,
  synkFaktura,
  sikrMomssats,
  firmaPris,
  koerAbonnementSynk,
  synkKundeStripe,
  skiftPrisAdmin,
  frigivPakkeskiftLaas,
  udloebetOpgradering,
} from "@/lib/erhverv/betaling";
import { skiftPakkeForBruger } from "@/lib/erhverv/pakkeskift";
import { introPasser, plusMaaneder } from "@/lib/erhverv/abonnementRegler";
import { ADMIN_FIRMA_ABONNEMENT, FIRMA_ABONNEMENT } from "@/lib/tekster/erhverv";

const FIRMA = "26849ab7-6678-47b7-a8bd-4d618dfdf9f3";
const SAELGERROLLE = "11111111-1111-4111-8111-000000000008";
const START = "7e57a000-0000-4000-8000-000000000001";
const BUTIK = "7e57a000-0000-4000-8000-000000000002";
const PRO = "7e57a000-0000-4000-8000-000000000003";
// Butiks pris ekskl. moms i øre (999 kr.).
const BUTIK_OERE = 99_900;

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
      // 1 gratis måned som særaftale fra staff (ny regel for måned 1, Filip
      // 27. okt. 2026: en introrabat gælder ellers fra måned 1 uden gratis
      // måned). Så testes gratis periode + introrabat efter den.
      proeve_ekstra_ventende: 1,
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
      kort_maerke: null,
      kort_sidste4: null,
      kort_udloeb_maaned: null,
      kort_udloeb_aar: null,
    })
    .eq("id", FIRMA);
  if (error) throw new Error(error.message);
  // Testen skifter pakke 5 gange (højst 10 pr. time pr. firma): en tidligere
  // kørsel inden for timen må ikke ramme grænsen (kun testfirmaets nøgle).
  await db.from("rate_limits").delete().eq("noegle", `firma_skift_pakke:${brugerId}`);
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
  it("1-2. Checkout med 1 gratis måned (særaftale) og introrabat oprettes (og lukkes igen)", async () => {
    const svar = await startBetaling(brugerId, "https://test.bidhamr.dk");
    expect(svar).toMatchObject({ ok: true });
    const sessioner = await stripe.checkout.sessions.list({ customer: kunde, status: "open", limit: 5 });
    expect(sessioner.data).toHaveLength(1);
    const s = sessioner.data[0];
    expect(s.metadata).toMatchObject({ firma_id: FIRMA, pakke_id: START, gratis_maaneder: "1", gratis_ekstra: "1", gratis_velkomst: "0", maaned1: "ingen" });
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
    const sub = await stripe.subscriptions.create({
      customer: kunde,
      items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, START), quantity: 1 }],
      default_tax_rates: [await sikrMomssats()],
      default_payment_method: pm.id,
      trial_end: plusMaaneder(t0, 1),
      // Som startBetaling: 1 staff-måned (særaftale), ingen velkomstfordel
      // (introrabatten gælder i stedet).
      metadata: { firma_id: FIRMA, pakke_id: START, gratis_ekstra: "1", gratis_velkomst: "0", maaned1: "ingen", gratis_saeraftale: "ja" },
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

  it("4. opgradering i en gratis periode fra staff (særaftale) sker med det samme uden betaling", async () => {
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

  it("5. særpris afvises, mens introrabatten kører; +1 gratis måned (introrabatten flyttes med)", async () => {
    // Særpris og introrabat kan ikke kombineres (Filip, 27. okt. 2026): Stripe
    // røres ikke, og databasen afviser også.
    const saer = await saetSaerprisStripe(FIRMA, BUTIK, 79_900, "naeste_betaling");
    expect(saer).toMatchObject({ status: "afvist", kode: "intro_aktiv", fejl: ADMIN_FIRMA_ABONNEMENT.saerpris.introAktiv });
    expect(
      await rpc("erhverv_firma_saerpris_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_oere: 79_900,
        p_pakke: BUTIK,
        p_aftale: "Stripe-test: aftalt særpris",
        p_fra: "naeste_betaling",
      }),
    ).toMatchObject({ kode: "intro_aktiv" });
    expect((await firma()).saerpris_oere).toBeNull();
    const s = await stripe.subscriptions.retrieve(subId);
    expect(s.items.data[0].price).toMatchObject({ unit_amount: BUTIK_OERE, metadata: { pakke_id: BUTIK } });

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

  it("6. fakturaerne: 2 gratis måneder, 6 med 50 % rabat på 999 kr. + moms, så fuld pris", async () => {
    // Højst 2 måneder pr. spol (Stripes grænse for månedlige abonnementer).
    for (const m of [2, 4, 6, 8]) await spol(plusMaaneder(t0, m) + 1800);
    await spol(plusMaaneder(t0, 9) + 1800);
    const alle = (await fakturaer()).filter((f) => f.billing_reason === "subscription_cycle" || f.billing_reason === "subscription_create");
    const beloeb = alle.map((f) => f.total);
    // Fakturaen ved oprettelsen (gratis), 2. måned gratis ligger i samme trial,
    // derefter 6 x (499,50 kr. + 25 % moms = 624,38 kr.) og fuld pris (1.248,75 kr.).
    const halv = Math.round(BUTIK_OERE * 0.5 * 1.25);
    const fuld = Math.round(BUTIK_OERE * 1.25);
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
    // Ingen særpris (den blev afvist i 5 - introrabatten kørte).
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
    const halv = Math.round(BUTIK_OERE * 0.5 * 1.25);
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

// =============================================================================
// Tredje del: eget test clock (20261102030000)
// =============================================================================
async function nulstilFirma(pakke: string, ekstra: Record<string, unknown> = {}): Promise<void> {
  if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
  if (ur) await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
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
      pakke_id: pakke,
      naeste_pakke_id: null,
      naeste_pakke_fra: null,
      pakkeskift_i_gang_kl: null,
      pakkeskift_laas: null,
      stripe_pris_synk: false,
      ...ekstra,
    })
    .eq("id", FIRMA);
  if (error) throw new Error(error.message);
  // Betalte og refunderede regninger fra tidligere tests må ikke tælle som
  // "har betalt" (velkomstfordelen er brugt, 20261102070000).
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
  subId = "";
  await db.from("firmaer").update({ stripe_customer_id: kunde }).eq("id", FIRMA);
  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: kunde });
  await stripe.customers.update(kunde, { invoice_settings: { default_payment_method: pm.id } });
}

async function introRabat(): Promise<Stripe.Discount | null> {
  const s = await stripe.subscriptions.retrieve(subId, { expand: ["discounts", "discounts.source.coupon"] });
  return (s.discounts.find((d) => typeof d !== "string" && (d.source.coupon as Stripe.Coupon)?.metadata?.bidhamr === "intro") as Stripe.Discount) ?? null;
}

describe("gratis måneder under en åben Checkout og introrabat mod en planlagt nedgradering (20261102030000)", () => {
  let gammelMeta: Record<string, string> = {};
  let gammelKupon = "";

  beforeAll(async () => {
    // Nyt firma med introrabat 50 % i 3 betalte måneder og 1 gratis måned
    // som særaftale (ny regel for måned 1: introrabatten erstatter
    // velkomstfordelen, så den gratis periode her er staffs).
    await nulstilFirma(BUTIK, { proeve_ekstra_ventende: 1 });
    expect(
      await rpc("erhverv_firma_intro_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_procent: 50,
        p_maaneder: 3,
        p_fra: "efter_gratis",
        p_begrundelse: "Stripe-test: introrabat før Checkout",
      }),
    ).toMatchObject({ kode: "ok" });
    await nytUr("BidHamr firmapakker-rettelser2");
  }, 120_000);

  afterAll(async () => {
    await db
      .from("firmaer")
      .update({ proeve_ekstra_ventende: 0, proeve_ekstra_sub: null, proeve_ekstra_sub_antal: 0, gratis_afstemt_sub: null, proeve_maaneder: 1 })
      .eq("id", FIRMA);
  }, 60_000);

  it("13a. staff giver gratis måneder, mens Checkout er åben: sessionen lukkes", async () => {
    expect(await startBetaling(brugerId, "https://test.bidhamr.dk")).toMatchObject({ ok: true });
    const aabne = await stripe.checkout.sessions.list({ customer: kunde, status: "open", limit: 5 });
    expect(aabne.data).toHaveLength(1);
    const sess = aabne.data[0];
    gammelMeta = { ...(sess.metadata ?? {}) };
    expect(gammelMeta).toMatchObject({ gratis_maaneder: "1", gratis_velkomst: "0", gratis_ekstra: "1", maaned1: "ingen" });
    gammelKupon = String(gammelMeta.intro_kupon);
    expect(gammelKupon).toMatch(/^bidhamr_intro_50_/);

    // +2 måneder (firmaet har ikke startet endnu): venter altid i
    // proeve_ekstra_ventende (20261102070000).
    expect(
      await rpc("erhverv_firma_gratis_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_maaneder: 2,
        p_begrundelse: "Stripe-test: 2 gratis måneder mens Checkout er åben",
        p_stripe: false,
        p_proeve_slut: null,
        p_klik: randomUUID(),
      }),
    ).toMatchObject({ kode: "ok", hvor: "ventende", gratis_maaneder_ved_start: 3 });
    expect(await lukAabneCheckout(FIRMA)).toBe(1);
    expect((await stripe.checkout.sessions.retrieve(sess.id)).status).toBe("expired");
    // Igen: intet at lukke.
    expect(await lukAabneCheckout(FIRMA)).toBe(0);
  });

  it("13b. firmaet nåede at betale med den gamle session: de manglende måneder lægges på ved start (én gang)", async () => {
    // Som Checkout med den GAMLE session: 1 gratis måned, introkuponen fra
    // sessionen og sessionens metadata. Abonnementet oprettes EFTER sessionen
    // (som i Checkout): uret står ellers før sessionens tidspunkt, og
    // kuponen fra sessionen ville ikke passe - så sætter den deployede
    // test-webhook (test.bidhamr.dk, samme testdatabase) introrabatten på
    // igen i kapløb med testen.
    await spol(t0 + 600);
    const f = await firma();
    const sub = await stripe.subscriptions.create({
      customer: kunde,
      items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, BUTIK), quantity: 1 }],
      default_tax_rates: [await sikrMomssats()],
      trial_end: plusMaaneder(t0, 1),
      discounts: [{ coupon: gammelKupon }],
      metadata: {
        firma_id: FIRMA,
        pakke_id: BUTIK,
        gratis_velkomst: "0",
        gratis_ekstra: "1",
        maaned1: "ingen",
        gratis_saeraftale: "ja",
        intro_noegle: String(f.intro_noegle),
        intro_kupon: gammelKupon,
      },
    });
    subId = sub.id;
    await spol(t0 + 3600);
    await spejlAlt();
    const s = await stripe.subscriptions.retrieve(subId);
    // 1 (sessionen) + 2 (givet, mens sessionen var åben) = 3 gratis måneder.
    expect(s.trial_end).toBe(plusMaaneder(plusMaaneder(t0, 1), 2));
    expect(s.metadata).toMatchObject({ gratis_velkomst: "0", gratis_ekstra: "3" });
    const efter = await firma();
    expect(efter).toMatchObject({
      abonnement_status: "aktiv",
      stripe_abonnement_status: "trialing",
      proeve_ekstra_ventende: 0,
      proeve_ekstra_sub: subId,
      proeve_ekstra_sub_antal: 3,
      gratis_afstemt_sub: subId,
      intro_status: "aktiv",
    });
    expect(new Date(String(efter.proeve_slut)).getTime() / 1000).toBe(s.trial_end);
    // Introrabatten er flyttet: præcis 3 betalte måneder efter den nye periode.
    const rabat = await introRabat();
    expect(rabat).toBeTruthy();
    expect(introPasser({ naesteFakturaSek: s.trial_end!, rabatSlutSek: rabat!.end, maaneder: 3 })).toBe(true);

    // Webhooken igen + cron'en: intet gives dobbelt.
    await spejlAlt();
    await koerAbonnementSynk();
    const igen = await stripe.subscriptions.retrieve(subId);
    expect(igen.trial_end).toBe(s.trial_end);
    expect((await firma()).proeve_ekstra_ventende).toBe(0);
  }, 180_000);

  it("13c. fakturaerne: 3 gratis måneder, 3 med 50 %, så fuld pris", async () => {
    for (const m of [2, 4, 6, 8]) await spol(plusMaaneder(t0, m) + 1800);
    const betalte = (await fakturaer()).filter((x) => x.billing_reason === "subscription_cycle");
    const halv = Math.round(99_900 * 0.5 * 1.25);
    const fuld = Math.round(99_900 * 1.25);
    // Første betalte faktura ved trial_end (t0 + 3 md.), så 4, 5, 6, 7 og 8 md.
    expect(betalte.map((x) => x.total)).toEqual([halv, halv, halv, fuld, fuld, fuld]);
    await spejlAlt();
  }, 600_000);

  it("14. introrabat mod en planlagt nedgradering: venter, til planen er afgjort", async () => {
    // Nedgradering Butik -> Start: Stripe-plan, hvis faser peger på rabatten.
    await db.from("firmaer").update({ pakkeskift_i_gang_kl: null, pakkeskift_laas: null }).eq("id", FIRMA);
    expect(await skiftPakkeForBruger(brugerId, START)).toMatchObject({ ok: true, kode: "nedgradering_planlagt" });
    const foer = await stripe.subscriptions.retrieve(subId, { expand: ["discounts"] });
    expect(foer.schedule).toBeTruthy();
    const rabatterFoer = foer.discounts.map((d) => (typeof d === "string" ? d : d.id));

    // Ny introrabat (25 % i 2 måneder): gemmes som planlagt, men sættes IKKE
    // på, mens planen findes - hverken af staff-handlingen, webhooken eller cron'en.
    expect(
      await rpc("erhverv_firma_intro_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_procent: 25,
        p_maaneder: 2,
        p_fra: "efter_gratis",
        p_begrundelse: "Stripe-test: ny introrabat under nedgradering",
      }),
    ).toMatchObject({ kode: "ok" });
    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "afvist", kode: "skift_venter" });
    await synkAbonnement(await stripe.subscriptions.retrieve(subId));
    await koerAbonnementSynk();
    const fjern = await fjernIntroStripe(FIRMA, randomUUID());
    // Ingen rabat på abonnementet nu (den første er brugt op) - så er der intet
    // at fjerne i Stripe; ligger der en, afvises det.
    if ((await introRabat()) == null) expect(fjern.status).toBe("ok");
    else expect(fjern).toMatchObject({ status: "afvist", kode: "skift_venter" });
    const midt = await stripe.subscriptions.retrieve(subId, { expand: ["discounts"] });
    expect(midt.discounts.map((d) => (typeof d === "string" ? d : d.id))).toEqual(rabatterFoer);
    expect(midt.schedule).toBeTruthy();
    expect((await firma()).intro_status).toBe("planlagt");

    // Firmaet beholder alligevel Butik: planen frigives - så sætter cron'en
    // introrabatten på.
    await db.from("firmaer").update({ pakkeskift_i_gang_kl: null, pakkeskift_laas: null }).eq("id", FIRMA);
    expect(await skiftPakkeForBruger(brugerId, BUTIK)).toMatchObject({ ok: true, kode: "uaendret" });
    expect((await stripe.subscriptions.retrieve(subId)).schedule).toBeNull();
    await db.from("firmaer").update({ stripe_synk_forsoegt_kl: null }).eq("id", FIRMA);
    await koerAbonnementSynk();
    const f = await firma();
    expect(f.intro_status).toBe("aktiv");
    const rabat = await introRabat();
    expect((rabat!.source.coupon as Stripe.Coupon).percent_off).toBe(25);
    const s = await stripe.subscriptions.retrieve(subId);
    expect(introPasser({ naesteFakturaSek: s.items.data[0].current_period_end, rabatSlutSek: rabat!.end, maaneder: 2 })).toBe(true);
  }, 180_000);

  it("14b. med rabatten på og en plan på abonnementet: fjern afvises med en dansk besked", async () => {
    // En plan på abonnementet (som ved en nedgradering - firmaets egne
    // pakkeskift er begrænset pr. time, så planen laves direkte her).
    const plan = await stripe.subscriptionSchedules.create({ from_subscription: subId });
    try {
      const fjern = await fjernIntroStripe(FIRMA, randomUUID());
      expect(fjern).toMatchObject({ status: "afvist", kode: "skift_venter" });
      if (fjern.status === "afvist") expect(fjern.fejl).toContain("pakkeskift, der venter");
      expect(await introRabat()).toBeTruthy();
      expect(await givGratisPeriodeStripe(FIRMA, 1, randomUUID())).toMatchObject({ status: "afvist", kode: "skift_venter" });
    } finally {
      await stripe.subscriptionSchedules.release(plan.id).catch(() => {});
    }
    // Uden planen kan rabatten fjernes.
    expect(await fjernIntroStripe(FIRMA, randomUUID())).toMatchObject({ status: "ok" });
    expect(await introRabat()).toBeNull();
  }, 120_000);
});

describe("introrabat fra Checkout, der ikke rammer præcis N betalte måneder (20261102030000)", () => {
  beforeAll(async () => {
    await nulstilFirma(START);
    expect(
      await rpc("erhverv_firma_intro_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_procent: 50,
        p_maaneder: 6,
        p_fra: "efter_gratis",
        p_begrundelse: "Stripe-test: introrabat fra Checkout",
      }),
    ).toMatchObject({ kode: "ok" });
    await nytUr("BidHamr firmapakker-intro-checkout");
  }, 120_000);

  afterAll(async () => {
    await db.from("firmaer").update({ gratis_afstemt_sub: null }).eq("id", FIRMA);
  }, 60_000);

  it("15. kuponen fra Checkout giver kun 4 betalte måneder (abonnementet oprettet for sent): sættes på igen med præcis 6", async () => {
    const f = await firma();
    // Som en Checkout-session, hvis kupon (K = 5) ikke passer, fordi
    // abonnementet blev oprettet senere end sessionen ventede.
    const forkert = "bidhamr_intro_50_5";
    await stripe.coupons.retrieve(forkert).catch(() =>
      stripe.coupons.create({
        id: forkert,
        name: "Introrabat 50 %",
        percent_off: 50,
        duration: "repeating",
        duration_in_months: 5,
        metadata: { bidhamr: "intro", procent: "50", maaneder: "5" },
      }),
    );
    const sub = await stripe.subscriptions.create({
      customer: kunde,
      items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, START), quantity: 1 }],
      default_tax_rates: [await sikrMomssats()],
      trial_end: plusMaaneder(t0, 1),
      discounts: [{ coupon: forkert }],
      metadata: { firma_id: FIRMA, pakke_id: START, gratis_velkomst: "1", intro_noegle: String(f.intro_noegle), intro_kupon: forkert },
    });
    subId = sub.id;
    const foer = await introRabat();
    expect(introPasser({ naesteFakturaSek: sub.trial_end!, rabatSlutSek: foer!.end, maaneder: 6 })).toBe(false);
    await spol(t0 + 3600);
    await spejlAlt();
    const efter = await introRabat();
    expect(efter!.id).not.toBe(foer!.id);
    expect(introPasser({ naesteFakturaSek: sub.trial_end!, rabatSlutSek: efter!.end, maaneder: 6 })).toBe(true);
    expect((await firma()).intro_status).toBe("aktiv");
    // Fakturaerne: 6 med 50 %, så fuld pris.
    for (const m of [2, 4, 6, 8]) await spol(plusMaaneder(t0, m) + 1800);
    const betalte = (await fakturaer()).filter((x) => x.billing_reason === "subscription_cycle");
    const halv = Math.round(49_900 * 0.5 * 1.25);
    const fuld = Math.round(49_900 * 1.25);
    expect(betalte.map((x) => x.total)).toEqual([halv, halv, halv, halv, halv, halv, fuld, fuld]);
  }, 600_000);
});

// =============================================================================
// Fjerde del: særpris og introrabat kan ikke kombineres (20261102050000)
// =============================================================================
describe("særpris og introrabat kan ikke kombineres (20261102050000)", () => {
  const saerprisArgs = (oere: number | null) => ({
    p_staff: SAELGERROLLE,
    p_firma: FIRMA,
    p_oere: oere,
    p_pakke: BUTIK,
    p_aftale: "Stripe-test: særpris-regel",
    p_fra: "naeste_betaling",
  });
  const introArgs = (procent: number | null) => ({
    p_staff: SAELGERROLLE,
    p_firma: FIRMA,
    p_procent: procent,
    p_maaneder: procent == null ? null : 6,
    p_fra: procent == null ? null : "efter_gratis",
    p_begrundelse: "Stripe-test: introrabat-regel",
  });

  beforeAll(async () => {
    // Intet abonnement i Stripe: kun databasen.
    await nulstilFirma(BUTIK, {
      intro_procent: null,
      intro_maaneder: null,
      intro_fra: null,
      intro_status: null,
      intro_coupon_id: null,
      intro_til: null,
    });
    subId = "";
  }, 120_000);

  afterAll(async () => {
    await db
      .from("firmaer")
      .update({
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
      })
      .eq("id", FIRMA);
  }, 60_000);

  it("16a. særpris først: introrabat afvises med saerpris_aktiv, til særprisen er fjernet", async () => {
    expect(await rpc("erhverv_firma_saerpris_gem", saerprisArgs(79_900))).toMatchObject({ kode: "ok" });
    expect(await rpc("erhverv_firma_intro_gem", introArgs(50))).toMatchObject({ kode: "saerpris_aktiv" });
    expect((await firma()).intro_procent).toBeNull();
    // Fjerne særprisen er altid tilladt - så kan introrabatten gives.
    expect(await rpc("erhverv_firma_saerpris_gem", saerprisArgs(null))).toMatchObject({ kode: "ok" });
    expect(await rpc("erhverv_firma_intro_gem", introArgs(50))).toMatchObject({ kode: "ok" });
  });

  it("16b. introrabat (planlagt eller kører): særpris afvises med intro_aktiv - også før Stripe", async () => {
    // Planlagt (intro_til tom).
    expect(await rpc("erhverv_firma_saerpris_gem", saerprisArgs(79_900))).toMatchObject({ kode: "intro_aktiv" });
    expect(await saetSaerprisStripe(FIRMA, BUTIK, 79_900, "naeste_betaling")).toMatchObject({ status: "afvist", kode: "intro_aktiv" });
    // Kører (intro_status 'aktiv', slutdato i fremtiden).
    await db
      .from("firmaer")
      .update({ intro_status: "aktiv", intro_til: new Date(Date.now() + 30 * 86400_000).toISOString() })
      .eq("id", FIRMA);
    expect(await rpc("erhverv_firma_saerpris_gem", saerprisArgs(79_900))).toMatchObject({ kode: "intro_aktiv" });
    expect((await firma()).saerpris_oere).toBeNull();
    // At fjerne en (ikke-eksisterende) særpris er stadig tilladt.
    expect(await rpc("erhverv_firma_saerpris_gem", saerprisArgs(null))).toMatchObject({ kode: "ok" });
  });

  it("16c. en udløbet introrabat (endnu ikke meldt færdig af Stripe) blokerer ikke en særpris", async () => {
    await db
      .from("firmaer")
      .update({ intro_status: "aktiv", intro_til: new Date(Date.now() - 86400_000).toISOString() })
      .eq("id", FIRMA);
    expect(await rpc("erhverv_firma_saerpris_gem", saerprisArgs(79_900))).toMatchObject({ kode: "ok" });
    expect((await firma()).saerpris_oere).toBe(79_900);
  });

  it("16d. en særpris på en anden pakke (bortfaldet ved pakkeskift) blokerer ikke en introrabat", async () => {
    await db.from("firmaer").update({ pakke_id: PRO }).eq("id", FIRMA);
    expect(await rpc("erhverv_firma_intro_gem", introArgs(50))).toMatchObject({ kode: "ok" });
  });
});

// =============================================================================
// Femte del: regel for måned 1 (Filip, 27. okt. 2026 - 20261102070000)
//   Start: første måned gratis. Butik og Pro: første måned til halv pris,
//   derefter fuld pris. Introrabat: 50 % i måned 1-6, ingen gratis måned.
//   Tidligere CVR: ingen fordel - med særaftale pakkens regel.
// =============================================================================
const START_OERE = 49_900;
const PRO_OERE = 199_900;

// Den åbne Checkout-session, startBetaling lige har lavet (lukkes igen).
async function nySession(): Promise<Stripe.Checkout.Session> {
  const svar = await startBetaling(brugerId, "https://test.bidhamr.dk");
  expect(svar).toMatchObject({ ok: true });
  // Stripes liste kan være et øjeblik bagud lige efter oprettelsen.
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
async function abonnementSomCheckout(s: Stripe.Checkout.Session, pakke: string): Promise<Stripe.Subscription> {
  const m = s.metadata ?? {};
  const gratis = Number(m.gratis_maaneder ?? 0);
  const k = kuponer(s);
  // Abonnementet oprettes efter sessionen (som i Checkout).
  await spol(t0 + 600);
  const sub = await stripe.subscriptions.create({
    customer: kunde,
    items: [{ price: await firmaPris({ id: FIRMA, saerpris_oere: null, saerpris_pakke_id: null }, pakke), quantity: 1 }],
    default_tax_rates: [await sikrMomssats()],
    ...(gratis > 0 ? { trial_end: plusMaaneder(t0, gratis) } : {}),
    ...(k.length ? { discounts: [{ coupon: k[0] }] } : {}),
    metadata: {
      firma_id: FIRMA,
      pakke_id: pakke,
      gratis_velkomst: m.gratis_velkomst ?? "0",
      maaned1: m.maaned1 ?? "",
      ...(m.velkomst_kupon ? { velkomst_kupon: m.velkomst_kupon } : {}),
      ...(m.intro_noegle ? { intro_noegle: m.intro_noegle, intro_kupon: m.intro_kupon ?? "" } : {}),
    },
  });
  subId = sub.id;
  return sub;
}

// Beløb ekskl. moms på abonnementets fakturaer med et beløb (i rækkefølge).
async function beloeb(): Promise<number[]> {
  return (await fakturaer()).filter((x) => x.total > 0).map((x) => x.total_excluding_tax ?? -1);
}

async function nulstilSkiftGraense(): Promise<void> {
  await db.from("rate_limits").delete().eq("noegle", `firma_skift_pakke:${brugerId}`);
}

describe("regel for måned 1 (20261102070000)", () => {
  afterAll(async () => {
    if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
    if (ur) await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
    await nulstilFirma(START);
    await db.from("firmaer").update({ stripe_customer_id: null, intro_procent: null, intro_maaneder: null, intro_fra: null, intro_status: null, intro_noegle: null, intro_coupon_id: null, intro_til: null }).eq("id", FIRMA);
  }, 120_000);

  it("M1. Start: første måned gratis (0 kr. i Checkout), fuld pris fra måned 2; abonnementet låses til kun kort", async () => {
    await nulstilFirma(START, { intro_procent: null, intro_maaneder: null, intro_fra: null, intro_status: null, intro_til: null });
    await nytUr("BidHamr maaned1 start");
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("gratis");
    const s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "gratis", gratis_maaneder: "1", gratis_velkomst: "1", gratis_ekstra: "0" });
    expect(s.amount_total).toBe(0);
    expect(kuponer(s)).toEqual([]);
    expect(s.payment_method_types).toEqual(["card"]);

    await abonnementSomCheckout(s, START);
    await spol(t0 + 3600);
    await spejlAlt();
    expect(await firma()).toMatchObject({ abonnement_status: "aktiv", stripe_abonnement_status: "trialing", kort_laast_sub: subId });
    const sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.payment_settings?.payment_method_types).toEqual(["card"]);
    // Velkomstfordelen er brugt (gratis periode givet).
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");

    await spol(plusMaaneder(t0, 1) + 1800);
    await spol(plusMaaneder(t0, 2) + 1800);
    expect(await beloeb()).toEqual([START_OERE, START_OERE]);
    // Fakturaen viser firmaets CVR som eget felt (kunden er synket).
    // Ny version (unik idempotency key - testens kunde er ny hver gang).
    const version = 1_000 + Math.floor(Math.random() * 1_000_000);
    await db.from("firmaer").update({ stripe_kunde_version: version }).eq("id", FIRMA);
    const f = await firma();
    expect(await synkKundeStripe(FIRMA, version)).toBe("ok");
    const k = (await stripe.customers.retrieve(kunde)) as Stripe.Customer;
    expect(k.invoice_settings.custom_fields).toEqual([{ name: "CVR", value: String(f.cvr) }]);
  }, 300_000);

  it("M2. Butik: første måned til halv pris (engangskupon), fuld pris fra måned 2; nedgradering til Start i måned 1 gælder fra måned 2", async () => {
    await nulstilFirma(BUTIK);
    await nytUr("BidHamr maaned1 butik");
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("halv");
    const s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "halv", gratis_maaneder: "0", velkomst_kupon: "bidhamr_velkomst_50_once" });
    expect(kuponer(s)).toEqual(["bidhamr_velkomst_50_once"]);
    expect(s.amount_subtotal).toBe(BUTIK_OERE);
    expect(s.total_details?.amount_discount).toBe(BUTIK_OERE / 2);
    const kupon = await stripe.coupons.retrieve("bidhamr_velkomst_50_once");
    expect(kupon).toMatchObject({ percent_off: 50, duration: "once", metadata: { bidhamr: "velkomst" } });

    await abonnementSomCheckout(s, BUTIK);
    await spol(t0 + 3600);
    await spejlAlt();
    expect(await firma()).toMatchObject({ abonnement_status: "aktiv", stripe_abonnement_status: "active" });
    expect(await beloeb()).toEqual([BUTIK_OERE / 2]);
    // Fordelen er brugt - en ny Checkout (fx efter en mislykket betaling) får den ikke igen.
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");

    // Nedgradering i måned 1: Butik resten af måned 1 (betalt med 50 %), Start
    // fra måned 2 til fuld pris - ingen refusion, ingen gratis Start-måned.
    await nulstilSkiftGraense();
    expect(await skiftPakkeForBruger(brugerId, START)).toMatchObject({ ok: true, kode: "nedgradering_planlagt" });
    await spol(plusMaaneder(t0, 1) + 1800);
    await spejlAlt();
    await spol(plusMaaneder(t0, 2) + 1800);
    expect(await beloeb()).toEqual([BUTIK_OERE / 2, START_OERE, START_OERE]);
    expect((await firma()).pakke_id).toBe(START);
  }, 300_000);

  it("M3. Start opgraderet til Pro i den gratis måned: den gratis periode slutter, Pro koster 50 % nu og fuld pris fra næste måned", async () => {
    await nulstilFirma(START);
    await nytUr("BidHamr maaned1 start-pro");
    const s = await nySession();
    await abonnementSomCheckout(s, START);
    await spol(t0 + 3600);
    await spejlAlt();
    const t1 = t0 + 10 * 86_400;
    await spol(t1);

    await nulstilSkiftGraense();
    expect(await skiftPakkeForBruger(brugerId, PRO)).toMatchObject({ ok: true, kode: "opgraderet" });
    const sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.status).toBe("active");
    expect(sub.items.data[0].price).toMatchObject({ unit_amount: PRO_OERE, metadata: { pakke_id: PRO } });
    expect(sub.metadata.skift_id ?? "").toBe("");
    const f = await firma();
    expect(f).toMatchObject({ pakke_id: PRO, abonnement_status: "aktiv", stripe_abonnement_status: "active" });
    // Pro aldrig gratis: 50 % af Pro nu.
    expect(await beloeb()).toEqual([PRO_OERE / 2]);
    const { data: skift } = await db
      .from("firma_pakkeskift")
      .select("status, stripe_invoice_id")
      .eq("firma_id", FIRMA)
      .eq("til_pakke_id", PRO)
      .order("oprettet_kl", { ascending: false })
      .limit(1)
      .single();
    expect(skift).toMatchObject({ status: "gennemfoert" });
    const { data: regning } = await db
      .from("firma_regninger")
      .select("status, type, beloeb_oere")
      .eq("stripe_invoice_id", String(skift!.stripe_invoice_id))
      .single();
    expect(regning).toMatchObject({ status: "betalt", type: "abonnement" });

    // Webhooken igen: intet sker dobbelt.
    await spejlAlt();
    expect((await firma()).pakke_id).toBe(PRO);
    await spol(plusMaaneder(t1, 1) + 1800);
    expect(await beloeb()).toEqual([PRO_OERE / 2, PRO_OERE]);
  }, 300_000);

  for (const [navn, pakke, oere] of [
    ["Start", START, START_OERE],
    ["Butik", BUTIK, BUTIK_OERE],
  ] as const) {
    it(`M4. introrabat på ${navn}: 50 % i måned 1-6 (ingen gratis måned), fuld pris fra måned 7`, async () => {
      await nulstilFirma(pakke);
      expect(
        await rpc("erhverv_firma_intro_gem", {
          p_staff: SAELGERROLLE,
          p_firma: FIRMA,
          p_procent: 50,
          p_maaneder: 6,
          p_fra: "efter_gratis",
          p_begrundelse: `Stripe-test: introrabat ${navn}`,
        }),
      ).toMatchObject({ kode: "ok" });
      await nytUr(`BidHamr maaned1 intro ${navn}`);
      expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");
      const s = await nySession();
      expect(s.metadata).toMatchObject({ maaned1: "ingen", gratis_maaneder: "0", intro_kupon: "bidhamr_intro_50_6" });
      expect(kuponer(s)).toEqual(["bidhamr_intro_50_6"]);
      expect(s.total_details?.amount_discount).toBe(oere / 2);

      await abonnementSomCheckout(s, pakke);
      await spol(t0 + 3600);
      await spejlAlt();
      expect((await firma()).intro_status).toBe("aktiv");
      for (const m of [2, 4, 6, 7]) await spol(plusMaaneder(t0, m) + 1800);
      const h = oere / 2;
      expect(await beloeb()).toEqual([h, h, h, h, h, h, oere, oere]);
      await db.from("firmaer").update({ intro_procent: null, intro_maaneder: null, intro_fra: null, intro_status: null, intro_noegle: null, intro_coupon_id: null, intro_til: null }).eq("id", FIRMA);
    }, 600_000);
  }

  it("M5. tidligere CVR: ingen fordel uden særaftale; med særaftale pakkens regel; et CVR-skift bagefter kan ikke omgå reglen", async () => {
    await nulstilFirma(BUTIK, { proeve_maaneder: 0 });
    await nytUr("BidHamr maaned1 tidligere-cvr");
    expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");
    let s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "ingen", gratis_maaneder: "0" });
    expect(kuponer(s)).toEqual([]);
    expect(s.total_details?.amount_discount ?? 0).toBe(0);
    expect(s.amount_subtotal).toBe(BUTIK_OERE);

    // Særaftale (proeve_maaneder = 1, som erhverv_firma_opret giver den).
    await db.from("firmaer").update({ proeve_maaneder: 1 }).eq("id", FIRMA);
    s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "halv" });
    expect(kuponer(s)).toEqual(["bidhamr_velkomst_50_once"]);
    await db.from("firmaer").update({ pakke_id: START }).eq("id", FIRMA);
    s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "gratis", gratis_maaneder: "1" });
    expect(s.amount_total).toBe(0);

    // CVR'et rettes til et CVR, der har haft abonnement før: fordelen fjernes,
    // og både gammelt og nyt CVR logges.
    const gammelt = String((await firma()).cvr);
    const tidligere = "24256790";
    const svar = await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: FIRMA, p_cvr: tidligere });
    try {
      expect(svar).toMatchObject({ kode: "ok", velkomst_fjernet: true });
      expect((await firma()).proeve_maaneder).toBe(0);
      expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");
      const { data: log } = await db
        .from("moderation_log")
        .select("aarsag")
        .eq("maal_id", FIRMA)
        .ilike("aarsag", `%CVR ændret: ${gammelt} → ${tidligere}%`)
        .limit(1);
      expect(log?.length).toBe(1);
    } finally {
      const tilbage = await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: FIRMA, p_cvr: gammelt });
      expect(tilbage).toMatchObject({ kode: "ok" });
    }
    const { data: log2 } = await db
      .from("moderation_log")
      .select("aarsag")
      .eq("maal_id", FIRMA)
      .ilike("aarsag", `%CVR ændret: ${tidligere} → ${gammelt}%`)
      .limit(1);
    expect(log2?.length).toBe(1);
  }, 300_000);
});

// =============================================================================
// Sjette del: rettelser til reglen for måned 1 (20261102150000)
// =============================================================================
// R1. Særpris udelukker velkomstfordelen: Start uden gratis måned, Butik uden
//     50 % - særprisen fra første betaling.
// R2. Skift op fra Starts gratis måned med et afvist kort (4000000000000341):
//     abonnementet er stadig 'trialing' på Start med en ventende ændring; den
//     mislykkede betaling er IKKE en mislykket abonnementsbetaling; når den
//     ventende ændring udløber (pending_update_expired), annulleres faktura og
//     skift, og 50 %-kuponen bliver ikke hængende.
// R3. Samme med et 3D Secure-kort (4000002500003155): firmaet sendes til
//     fakturasiden; chefens pakkeskift i admin annullerer den ventende faktura
//     (ventende ændring væk), og skiftet sker uden betaling i den gratis periode.
// R4. Introrabat aftalt, men ikke sat på abonnementet: skiftet venter (ingen
//     dobbelt rabat). Når den er sat på: kun introrabatten (30 %), ingen 50 %.
// R5. CVR-historik: ændres CVR'et på et firma, der har haft abonnement, tæller
//     det gamle CVR stadig som "har haft abonnement før".
describe("rettelser til reglen for måned 1 (20261102150000)", () => {
  afterAll(async () => {
    if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
    if (ur) await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
    await nulstilFirma(START);
    await db.from("firmaer").update({ stripe_customer_id: null, intro_procent: null, intro_maaneder: null, intro_fra: null, intro_status: null, intro_noegle: null, intro_coupon_id: null, intro_til: null }).eq("id", FIRMA);
  }, 120_000);

  // Start med velkomstmåneden (som Checkout), på dag 10.
  async function startIGratisMaaned(navn: string): Promise<number> {
    await nulstilFirma(START, { intro_procent: null, intro_maaneder: null, intro_fra: null, intro_status: null, intro_noegle: null, intro_til: null });
    await nytUr(navn);
    const s = await nySession();
    expect(s.metadata).toMatchObject({ maaned1: "gratis" });
    await abonnementSomCheckout(s, START);
    await spol(t0 + 3600);
    await spejlAlt();
    const t1 = t0 + 10 * 86_400;
    await spol(t1);
    return t1;
  }

  // Beløb ekskl. moms på BETALTE fakturaer med et beløb (annullerede tæller ikke).
  async function betalt(): Promise<number[]> {
    return (await fakturaer()).filter((x) => x.status === "paid" && x.total > 0).map((x) => x.total_excluding_tax ?? -1);
  }

  async function nytKort(pm: string): Promise<void> {
    const kort = await stripe.paymentMethods.attach(pm, { customer: kunde });
    await stripe.customers.update(kunde, { invoice_settings: { default_payment_method: kort.id } });
  }

  async function senesteSkift(pakke: string): Promise<{ id: string; status: string; stripe_invoice_id: string | null }> {
    const { data, error } = await db
      .from("firma_pakkeskift")
      .select("id, status, stripe_invoice_id")
      .eq("firma_id", FIRMA)
      .eq("til_pakke_id", pakke)
      .order("oprettet_kl", { ascending: false })
      .limit(1)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  it("R1. særpris: ingen gratis Start-måned og ingen 50 % på Butik - særprisen fra første betaling", async () => {
    for (const [pakke, saerpris] of [
      [START, 39_900],
      [BUTIK, 79_900],
    ] as const) {
      await nulstilFirma(pakke, {
        saerpris_oere: saerpris,
        saerpris_pakke_id: pakke,
        saerpris_aftale: "Stripe-test: særpris",
        intro_procent: null,
        intro_maaneder: null,
        intro_fra: null,
        intro_status: null,
        intro_noegle: null,
        intro_til: null,
      });
      await nytUr(`BidHamr maaned1 saerpris ${pakke.slice(-1)}`);
      expect(await rpc("erhverv_maaned1", { p_firma: FIRMA })).toBe("ingen");
      const json = await rpc("erhverv_firma_abonnement_json", { p_firma: FIRMA });
      expect(json).toMatchObject({ maaned1: "ingen", gratis_maaneder_ved_start: 0, pris: saerpris / 100 });
      const s = await nySession();
      expect(s.metadata).toMatchObject({ maaned1: "ingen", gratis_maaneder: "0" });
      expect(kuponer(s)).toEqual([]);
      expect(s.amount_subtotal).toBe(saerpris);
      expect(s.total_details?.amount_discount ?? 0).toBe(0);
      await stripe.testHelpers.testClocks.del(ur.id).catch(() => {});
    }
  }, 300_000);

  it("R2. afvist kort (4000000000000341) ved skift op fra Starts gratis måned: Start beholdes gratis; udløbet ændring annullerer faktura og skift", async () => {
    const t1 = await startIGratisMaaned("BidHamr maaned1 afvist");
    await nytKort("pm_card_chargeCustomerFail");
    await nulstilSkiftGraense();
    const svar = await skiftPakkeForBruger(brugerId, PRO);
    expect(svar).toMatchObject({ ok: true, kode: "betal_forskellen" });

    let sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
    expect(sub.status).toBe("trialing");
    expect(sub.pending_update).not.toBeNull();
    expect(sub.items.data[0].price.metadata.pakke_id).toBe(START);
    expect(sub.discounts).toEqual([]);
    const faktura = sub.latest_invoice as Stripe.Invoice;
    expect(faktura.status).toBe("open");
    expect(faktura.billing_reason).toBe("subscription_update");
    expect(faktura.total_excluding_tax).toBe(PRO_OERE / 2);
    const skift = await senesteSkift(PRO);
    expect(skift).toMatchObject({ status: "afventer_betaling", stripe_invoice_id: faktura.id });

    // invoice.payment_failed: ikke en mislykket abonnementsbetaling.
    expect(await synkFaktura(faktura, "payment_failed")).toBe("spejlet");
    expect(await firma()).toMatchObject({ pakke_id: START, abonnement_status: "aktiv", betaling_mislykket_kl: null });

    // Den ventende ændring udløber (23 timer): Stripe annullerer fakturaen.
    await spol(t1 + 24 * 3600);
    sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.pending_update).toBeNull();
    expect((await stripe.invoices.retrieve(faktura.id!)).status).toBe("void");
    // Webhooks: customer.subscription.pending_update_expired og invoice.voided
    // (test clock'ets hændelser kan også nå testserverens webhook, som bruger
    // samme database - så er skiftet allerede annulleret: 'intet_skift').
    expect(await udloebetOpgradering(sub)).toMatch(/^(udloebet:|intet_skift$)/);
    expect(await synkFaktura(await stripe.invoices.retrieve(faktura.id!), null)).toMatch(/^void/);
    expect((await senesteSkift(PRO)).status).toBe("annulleret");
    const { data: regning } = await db.from("firma_regninger").select("status").eq("stripe_invoice_id", faktura.id!).single();
    expect(regning?.status).toBe("annulleret");
    sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.status).toBe("trialing");
    expect(sub.items.data[0].price.metadata.pakke_id).toBe(START);
    expect(sub.discounts).toEqual([]);
    expect(sub.metadata.skift_id ?? "").toBe("");
    expect(await firma()).toMatchObject({ pakke_id: START, abonnement_status: "aktiv", stripe_abonnement_status: "trialing" });

    // Fornyelsen efter den gratis måned: fuld Start-pris (ingen 50 %-kupon hængende).
    await nytKort("pm_card_visa");
    await spol(plusMaaneder(t0, 1) + 7200); // fakturaen udstedes og betales ca. 1 time efter fornyelsen
    expect(await betalt()).toEqual([START_OERE]);
  }, 400_000);

  it("R3. 3D Secure-kort (4000002500003155): fakturasiden; chefens pakkeskift annullerer den ventende faktura og skifter uden betaling", async () => {
    await startIGratisMaaned("BidHamr maaned1 3ds");
    await nytKort("pm_card_authenticationRequiredOnSetup");
    await nulstilSkiftGraense();
    const svar = await skiftPakkeForBruger(brugerId, PRO);
    expect(svar).toMatchObject({ ok: true, kode: "betal_forskellen" });
    if ("url" in svar) expect(svar.url).toMatch(/^https:\/\/invoice\.stripe\.com\//);
    let sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
    expect(sub.status).toBe("trialing");
    expect(sub.pending_update).not.toBeNull();
    const faktura = sub.latest_invoice as Stripe.Invoice;
    expect(faktura.status).toBe("open");
    const betaling = await stripe.invoicePayments.list({ invoice: faktura.id!, limit: 1 });
    const pi = betaling.data[0]?.payment.payment_intent;
    const piStatus = pi ? (await stripe.paymentIntents.retrieve(typeof pi === "string" ? pi : pi.id)).status : null;
    expect(piStatus).toBe("requires_action");

    // Chefen skifter til Butik i admin (som skiftFirmaPakkeAdmin).
    const admin = await skiftPrisAdmin(FIRMA, BUTIK);
    expect(admin).toMatchObject({ status: "ok", annulleredeFakturaer: 1 });
    try {
      expect(await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: FIRMA, p_pakke: BUTIK, p_note: "Stripe-test" })).toMatchObject({ kode: "ok" });
    } finally {
      if (admin.status === "ok") await frigivPakkeskiftLaas(FIRMA, admin.laas);
    }
    expect((await stripe.invoices.retrieve(faktura.id!)).status).toBe("void");
    sub = await stripe.subscriptions.retrieve(subId);
    expect(sub.pending_update).toBeNull();
    expect(sub.status).toBe("trialing");
    expect(sub.items.data[0].price.metadata.pakke_id).toBe(BUTIK);
    expect(sub.discounts).toEqual([]);
    expect((await senesteSkift(PRO)).status).toBe("annulleret");
    expect(await firma()).toMatchObject({ pakke_id: BUTIK, abonnement_status: "aktiv" });
    // Ingen betaling i den gratis periode.
    expect(await betalt()).toEqual([]);
  }, 400_000);

  it("R4. introrabat aftalt, men ikke på abonnementet: skiftet venter; derefter kun introrabatten (30 %), ingen 50 %", async () => {
    await startIGratisMaaned("BidHamr maaned1 intro-skift");
    expect(
      await rpc("erhverv_firma_intro_gem", {
        p_staff: SAELGERROLLE,
        p_firma: FIRMA,
        p_procent: 30,
        p_maaneder: 3,
        p_fra: "efter_gratis",
        p_begrundelse: "Stripe-test: introrabat i den gratis måned",
      }),
    ).toMatchObject({ kode: "ok" });
    await nulstilSkiftGraense();
    expect(await skiftPakkeForBruger(brugerId, PRO)).toEqual({ fejl: FIRMA_ABONNEMENT.skiftVenterRabat, kode: "stripe_fejl" });
    let sub = await stripe.subscriptions.retrieve(subId);
    expect(sub).toMatchObject({ status: "trialing", pending_update: null });
    expect(sub.items.data[0].price.metadata.pakke_id).toBe(START);
    expect((await firma()).pakke_id).toBe(START);

    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "ok" });
    await nulstilSkiftGraense();
    expect(await skiftPakkeForBruger(brugerId, PRO)).toMatchObject({ ok: true, kode: "opgraderet" });
    sub = await stripe.subscriptions.retrieve(subId, { expand: ["discounts", "discounts.source.coupon"] });
    expect(sub.status).toBe("active");
    const kuponIder = sub.discounts.map((d) => (typeof d === "string" ? d : ((d.source.coupon as Stripe.Coupon)?.id ?? "")));
    expect(kuponIder.some((k) => k.startsWith("bidhamr_intro_30_"))).toBe(true);
    expect(kuponIder).not.toContain("bidhamr_velkomst_50_once");
    expect(await beloeb()).toEqual([Math.round(PRO_OERE * 0.7)]);
  }, 400_000);

  it("R5. CVR-historik: det gamle CVR på et firma med abonnement tæller stadig som 'har haft abonnement før'", async () => {
    const f = await firma();
    expect(f.stripe_subscription_id).toBeTruthy();
    const gammelt = String(f.cvr);
    const nyt = "87654328";
    const ANDET = "1501ba4c-5c26-4626-abc4-5e1d1c8e3348";
    const { data: andet } = await db
      .from("firmaer")
      .select("cvr, proeve_maaneder, abonnement_status, stripe_subscription_id, proeve_givet_kl")
      .eq("id", ANDET)
      .single();
    expect(andet).toMatchObject({ abonnement_status: "afventer_betaling", stripe_subscription_id: null, proeve_givet_kl: null });
    try {
      expect(await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: FIRMA, p_cvr: nyt })).toMatchObject({ kode: "ok", velkomst_fjernet: false });
      const { data: h } = await db
        .from("firma_cvr_historik")
        .select("havde_abonnement")
        .eq("firma_id", FIRMA)
        .eq("cvr", gammelt)
        .eq("nyt_cvr", nyt)
        .order("aendret_kl", { ascending: false })
        .limit(1)
        .single();
      expect(h).toMatchObject({ havde_abonnement: true });
      // Et andet firma (ikke startet) får det gamle CVR: velkomstfordelen fjernes.
      await db.from("firmaer").update({ proeve_maaneder: 1 }).eq("id", ANDET);
      expect(await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: ANDET, p_cvr: gammelt })).toMatchObject({ kode: "ok", velkomst_fjernet: true });
      expect(await rpc("erhverv_maaned1", { p_firma: ANDET })).toBe("ingen");
    } finally {
      await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: ANDET, p_cvr: String(andet!.cvr) });
      await db.from("firmaer").update({ proeve_maaneder: andet!.proeve_maaneder }).eq("id", ANDET);
      await rpc("erhverv_firma_opdater", { p_staff: SAELGERROLLE, p_firma: FIRMA, p_cvr: gammelt });
    }
    // Historikken kan ikke slettes af service role (handelsdata).
    const { error: sletFejl } = await db.from("firma_cvr_historik").delete().eq("firma_id", FIRMA);
    expect(sletFejl).not.toBeNull();
  }, 120_000);
});
