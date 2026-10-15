// Scenarie: boost (Filip, 13. okt. 2026). Mod testdatabasen og Stripes
// testmiljø, gennem den rigtige kode (appens endpoints, webhook-ruten,
// cron-trinnene og chefens refusion).
//
//   A. Køb af 100 point for 39 kr. via POST /api/betaling/app/boost-koeb:
//      PaymentIntent på PLATFORMSKONTOEN (ingen destination charge, intet
//      gebyr), tvungen 3DS, metadata type 'boost', idempotens (samme
//      PaymentIntent igen). Betalt med pm_card_bypassPending -> webhook to
//      gange (forskellige events) -> pointene krediteres præcis én gang.
//      Faktura (39 kr., moms 7,80 kr.).
//   B. Firmaer afvist; en fremmed kan ikke booste andres auktion.
//   C. Boost via POST /api/betaling/app/boost-brug: samme nøgle = samme boost
//      (point trækkes én gang), ny nøgle = "allerede boostet". Mærket
//      "Boostet" (aktive_boosts) og plads i toppen (boost_top).
//   D. Nødstop: et åbent boost-køb annulleres hos Stripe og kasseres.
//   E. Point ved salg: frigivet salg -> 10 point (én gang); refunderet før
//      frigivelse -> ingen point. Pengene ender i en sluttilstand (payout
//      betalt / refunderet).
//   F. Sluttilstand for købet: chefen refunderer det (Stripe-refusion med
//      metadata), pointene trækkes tilbage, charge.refunded giver intet
//      nyt, kreditnota planlægges.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/betaling/app/[handling]/route";
import { egenDatabase } from "@/lib/betaling/fremmedeTestdata";
import { startBoostKoeb, staffRefunderBoostKoeb, synkBoostRetur, koerBoostCron } from "@/lib/betaling/boost";
import { annullerAabneBoostKoeb } from "@/lib/betaling/noedstop";
import { CHEF_ID, FREMMED, KOEBER, SAELGER, type PengeBruger } from "./brugere";
import { logIndSom } from "./session";
import {
  admin,
  afslutPayout,
  betal,
  betaling,
  forberedSaelger,
  fuldRefusion,
  koeberGodkender,
  opretHandel,
  piId,
  rydOp,
  sendWebhook,
  stripe,
  udenTvungen3ds,
  type TestHandel,
} from "./handel";

// klientIp() læser next/headers, som kun findes i en Next-forespørgsel.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "127.0.0.251" }),
}));

let auktionId: string;
let koebId: string;
let koebPi: string;
let saldoFoer = 0;
let hSalg: TestHandel | null = null;
let hRefunderet: TestHandel | null = null;
let konto: string;

async function token(b: PengeBruger): Promise<string> {
  const k = await logIndSom(b.id, b.email);
  const { data } = await k.auth.getSession();
  if (!data.session) throw new Error("ingen session");
  return data.session.access_token;
}

async function kald(handling: string, krop: Record<string, unknown>, bruger: PengeBruger | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bruger) headers.authorization = `Bearer ${await token(bruger)}`;
  const req = new NextRequest(`http://localhost/api/betaling/app/${handling}`, {
    method: "POST",
    body: JSON.stringify(krop),
    headers,
  });
  const res = await POST(req, { params: Promise.resolve({ handling }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function saldo(bruger: string): Promise<number> {
  const { data, error } = await admin().rpc("boost_saldo", { p_bruger: bruger });
  if (error) throw new Error(`boost_saldo: ${error.message}`);
  return Number(data);
}

async function koeb(id: string) {
  const { data, error } = await admin()
    .from("boost_koeb")
    .select("id, status, point, beloeb_oere, stripe_payment_intent_id, stripe_charge_id, pi_forsoeg, tidligere_payment_intents, stripe_refund_id, refunderet_kl")
    .eq("id", id)
    .single();
  if (error) throw new Error(`boost_koeb: ${error.message}`);
  return data as {
    id: string;
    status: string;
    point: number;
    beloeb_oere: number;
    stripe_payment_intent_id: string | null;
    stripe_charge_id: string | null;
    pi_forsoeg: number;
    tidligere_payment_intents: string[];
    stripe_refund_id: string | null;
    refunderet_kl: string | null;
  };
}

beforeAll(async () => {
  konto = await forberedSaelger();
  // KOEBER (privat) sælger også: en aktiv TEST-auktion, der kan boostes.
  const { data, error } = await admin()
    .from("auctions")
    .insert({
      bruger_id: KOEBER.id,
      titel: `TEST pengetest: boost [${randomUUID().slice(0, 8)}]`,
      beskrivelse: "TEST - oprettet af pengetestene (npm run test:penge). Ingen rigtig vare.",
      billeder: [],
      startpris: 10,
      kategori: "Andet",
      postnummer: "2100",
      lokation: "København Ø",
      forsendelse_mulig: true,
      afhentning_mulig: false,
      stand: "god",
      varighed_dage: 3,
      forbudt_bekraeftet: true,
      pakkestoerrelse: "lille",
      vaegt_gram: 500,
      fragt_pakkeshop_oere: 4000,
      slutter_kl: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      status: "aktiv",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`auktion: ${error?.message}`);
  auktionId = data.id;
  saldoFoer = await saldo(KOEBER.id);
});

afterAll(async () => {
  // Auktionen fjernes fra listerne (handelsdata slettes aldrig).
  if (auktionId) {
    await admin().from("auctions").update({ status: "annulleret", arkiveret_kl: new Date().toISOString() }).eq("id", auktionId);
  }
  if (hSalg) await rydOp(hSalg);
  if (hRefunderet) await rydOp(hRefunderet);
  // Et åbent køb (fra D) må ikke kunne betales efter testen.
  const { data } = await admin().from("boost_koeb").select("stripe_payment_intent_id").eq("bruger_id", KOEBER.id).eq("status", "afventer");
  for (const r of data ?? []) {
    if (!r.stripe_payment_intent_id) continue;
    const pi = await stripe().paymentIntents.retrieve(r.stripe_payment_intent_id).catch(() => null);
    if (pi && ["requires_payment_method", "requires_confirmation", "requires_action"].includes(pi.status)) {
      await stripe().paymentIntents.cancel(pi.id).catch(() => null);
    }
  }
});

describe("A. køb af boost-point", () => {
  it("uden login: 401", async () => {
    const r = await kald("boost-koeb", {}, null);
    expect(r.status).toBe(401);
  });

  it("PaymentIntent på platformen: 39 kr., ingen destination, 3DS, metadata - og samme igen", async () => {
    const s = await kald("boost-koeb", {}, KOEBER);
    expect(s.status).toBe(200);
    expect(s.body.beloebOere).toBe(3900);
    expect(s.body.point).toBe(100);
    expect(String(s.body.publishableKey)).toMatch(/^pk_test_/);
    expect(String(s.body.customerId)).toMatch(/^cus_/);
    koebId = String(s.body.koebId);
    koebPi = piId(String(s.body.clientSecret));
    const pi = await stripe().paymentIntents.retrieve(koebPi);
    expect(pi.amount).toBe(3900);
    expect(pi.currency).toBe("dkk");
    expect(pi.on_behalf_of).toBeNull();
    expect(pi.transfer_data ?? null).toBeNull();
    expect(pi.application_fee_amount ?? null).toBeNull();
    expect(pi.payment_method_options?.card?.request_three_d_secure).toBe("any");
    expect(pi.metadata.type).toBe("boost");
    expect(pi.metadata.boost_koeb_id).toBe(koebId);
    expect(pi.metadata.bruger_id).toBe(KOEBER.id);
    if (egenDatabase()) expect(pi.metadata.bidhamr_db).toBe(egenDatabase());
    expect(pi.customer).toBe(s.body.customerId);
    // Gentaget kald: samme køb og samme PaymentIntent.
    const igen = await kald("boost-koeb", {}, KOEBER);
    expect(igen.body.koebId).toBe(koebId);
    expect(piId(String(igen.body.clientSecret))).toBe(koebPi);
  });

  it("betalt -> webhook to gange -> 100 point præcis én gang", async () => {
    await udenTvungen3ds(koebPi);
    await stripe().paymentIntents.confirm(koebPi, {
      payment_method: "pm_card_bypassPending",
      return_url: "https://bidhamr.dk/test-betaling",
    });
    const pi = await stripe().paymentIntents.retrieve(koebPi);
    expect(pi.status).toBe("succeeded");
    expect(await saldo(KOEBER.id)).toBe(saldoFoer); // ingen point før Stripe har bekræftet
    const w1 = await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string });
    const w2 = await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string });
    expect(w1.status).toBe(200);
    expect(w2.status).toBe(200);
    expect(await saldo(KOEBER.id)).toBe(saldoFoer + 100);
    // Returen fra betalingen spejler også - intet nyt.
    expect(await synkBoostRetur(KOEBER.id, koebPi)).toBe("allerede");
    // En fremmed kan ikke spejle andres køb via returen.
    expect(await synkBoostRetur(FREMMED.id, koebPi)).toBeNull();
    expect(await saldo(KOEBER.id)).toBe(saldoFoer + 100);
    const { count } = await admin()
      .from("boost_posteringer")
      .select("id", { count: "exact", head: true })
      .eq("boost_koeb_id", koebId)
      .eq("type", "koeb");
    expect(count).toBe(1);
    const k = await koeb(koebId);
    expect(k.status).toBe("betalt");
    expect(k.stripe_charge_id).toBeTruthy();
    // Et nyt kald starter et NYT køb (det betalte er afsluttet).
    const nyt = await kald("boost-koeb", {}, KOEBER);
    expect(nyt.status).toBe(200);
    expect(nyt.body.koebId).not.toBe(koebId);
  });

  it("faktura på købet: 39 kr. inkl. 7,80 kr. moms, uden handel", async () => {
    const { error } = await admin().rpc("faktura_planlaeg_boost", { p_graense: 200 });
    expect(error).toBeNull();
    const { data } = await admin()
      .from("fakturaer")
      .select("dokument, part, bruger_id, beloeb_oere, moms_oere, slags, betaling_id, trade_id, linjer")
      .eq("boost_koeb_id", koebId);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      dokument: "faktura",
      part: "koeber",
      bruger_id: KOEBER.id,
      beloeb_oere: 3900,
      moms_oere: 780,
      slags: "boost",
      betaling_id: null,
      trade_id: null,
    });
  });
});

describe("B. kun private", () => {
  it("en firmakonto kan ikke købe point", async () => {
    const { data } = await admin().from("users").select("id").eq("konto_type", "erhverv").limit(1).maybeSingle<{ id: string }>();
    if (!data) return; // ingen firmakonto i testdatabasen
    const r = await startBoostKoeb(data.id);
    expect("fejl" in r && r.kode).toBe("erhverv");
    const { count } = await admin().from("boost_koeb").select("id", { count: "exact", head: true }).eq("bruger_id", data.id);
    expect(count).toBe(0);
  });

  it("en fremmed kan ikke booste andres auktion", async () => {
    const r = await kald("boost-brug", { auktion_id: auktionId, noegle: randomUUID() }, FREMMED);
    expect(r.status).toBe(403);
    expect(r.body.kode).toBe("ikke_ejer");
  });
});

describe("C. boost i 24 timer for 50 point", () => {
  it("samme nøgle = samme boost; point trækkes én gang; ét aktivt boost pr. auktion", async () => {
    const foer = await saldo(KOEBER.id);
    const noegle = randomUUID();
    const b1 = await kald("boost-brug", { auktion_id: auktionId, noegle }, KOEBER);
    expect(b1.status).toBe(200);
    expect(b1.body.kode).toBe("ok");
    const b2 = await kald("boost-brug", { auktion_id: auktionId, noegle }, KOEBER);
    expect(b2.status).toBe(200);
    expect(b2.body.kode).toBe("allerede");
    expect(b2.body.boostId).toBe(b1.body.boostId);
    const b3 = await kald("boost-brug", { auktion_id: auktionId, noegle: randomUUID() }, KOEBER);
    expect(b3.status).toBe(409);
    expect(b3.body.kode).toBe("boostet");
    expect(await saldo(KOEBER.id)).toBe(foer - 50);
    const timer = (new Date(String(b1.body.slutKl)).getTime() - Date.now()) / 3_600_000;
    expect(timer).toBeGreaterThan(23.9);
    expect(timer).toBeLessThanOrEqual(24);
  });

  it("mærket 'Boostet' og plads i toppen (anon kan læse det)", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { offentligNoegle } = await import("@/lib/supabase/noegler");
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, offentligNoegle(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: aktive, error } = await anon.rpc("aktive_boosts", { p_auktioner: [auktionId] });
    expect(error).toBeNull();
    expect((aktive as { auktion_id: string }[]).map((r) => r.auktion_id)).toEqual([auktionId]);
    const { data: top, error: tFejl } = await anon.rpc("boost_top", { p_kategori: "Andet", p_soeg: "TEST pengetest: boost" });
    expect(tFejl).toBeNull();
    expect((top as { auktion_id: string }[]).length).toBeLessThanOrEqual(4);
    // Boostet i dag af denne test: med i toppen, medmindre flere end 4
    // TEST-boosts deler pladserne (rotation).
    const { count } = await admin()
      .from("auktion_boosts")
      .select("id", { count: "exact", head: true })
      .gt("slut_kl", new Date().toISOString());
    if ((count ?? 0) <= 4) expect((top as { auktion_id: string }[]).map((r) => r.auktion_id)).toContain(auktionId);
    // Anon kan hverken læse ledgeren eller købene.
    const { data: ledger } = await anon.from("boost_posteringer").select("id").limit(1);
    expect(ledger ?? []).toEqual([]);
  });
});

describe("D. nødstop", () => {
  it("et åbent boost-køb annulleres hos Stripe og kasseres", async () => {
    const s = await kald("boost-koeb", {}, KOEBER);
    expect(s.status).toBe(200);
    const id = String(s.body.koebId);
    const pi = piId(String(s.body.clientSecret));
    const r = await annullerAabneBoostKoeb();
    expect(r.fejlet).toBe(0);
    expect((await stripe().paymentIntents.retrieve(pi)).status).toBe("canceled");
    const k = await koeb(id);
    expect(k.stripe_payment_intent_id).toBeNull();
    expect(k.tidligere_payment_intents).toContain(pi);
    // Næste start laver en ny PaymentIntent på samme køb.
    const igen = await kald("boost-koeb", {}, KOEBER);
    expect(igen.body.koebId).toBe(id);
    expect(piId(String(igen.body.clientSecret))).not.toBe(pi);
  });
});

describe("E. point ved salg", () => {
  it("frigivet salg giver 10 point én gang; refunderet før frigivelse giver ingen", async () => {
    hSalg = await opretHandel({ navn: "boost-optjening", budOere: 20_000 });
    hRefunderet = await opretHandel({ navn: "boost-ingen-point", budOere: 15_000 });
    await betal(hSalg);
    await betal(hRefunderet);
    expect((await fuldRefusion(hRefunderet)).resultat).toBe("refunderet");
    expect(await koeberGodkender(hSalg)).toEqual({ ok: true });
    expect((await betaling(hSalg.betalingId)).frigivet_kl).toBeTruthy();

    const r1 = await koerBoostCron();
    expect(r1).not.toBeNull();
    await koerBoostCron();
    const { data: post } = await admin()
      .from("boost_posteringer")
      .select("type, point, bruger_id")
      .in("betaling_id", [hSalg.betalingId, hRefunderet.betalingId]);
    expect(post).toEqual([{ type: "optjening", point: 10, bruger_id: SAELGER.id }]);
  });

  it("sluttilstand: udbetalingen af salget betales", async () => {
    const b = await betaling(hSalg!.betalingId);
    expect(await afslutPayout(konto, b.saelger_udbetaling_id!)).toBe("paid");
  });
});

describe("F. chefen refunderer købet", () => {
  it("Stripe-refusion med metadata, pointene trækkes tilbage, charge.refunded giver intet nyt, kreditnota", async () => {
    const foer = await saldo(KOEBER.id);
    const r = await staffRefunderBoostKoeb(CHEF_ID, koebId, "TEST pengetest: refusion af boost-køb");
    expect(r).toMatchObject({ ok: true, kode: "refunderet", oensket: 100 });
    const trukket = "ok" in r ? r.trukket : -1;
    expect(trukket).toBe(Math.min(100, foer));
    expect(await saldo(KOEBER.id)).toBe(foer - trukket);
    const k = await koeb(koebId);
    expect(k.status).toBe("refunderet");
    const refund = await stripe().refunds.retrieve(k.stripe_refund_id!);
    expect(refund.amount).toBe(3900);
    expect(refund.metadata?.type).toBe("boost");
    expect(refund.metadata?.boost_koeb_id).toBe(koebId);
    // Igen: afvist (allerede refunderet) - ingen ny refusion.
    expect(await staffRefunderBoostKoeb(CHEF_ID, koebId, "igen")).toHaveProperty("fejl");
    const ch = await stripe().charges.retrieve(k.stripe_charge_id!, { expand: ["refunds"] });
    const w = await sendWebhook("charge.refunded", ch as unknown as { id: string });
    expect(w.status).toBe(200);
    expect(await saldo(KOEBER.id)).toBe(foer - trukket);
    const alle = await stripe().refunds.list({ payment_intent: koebPi, limit: 10 });
    expect(alle.data.filter((x) => x.status !== "failed" && x.status !== "canceled")).toHaveLength(1);
    await admin().rpc("faktura_planlaeg_boost", { p_graense: 200 });
    const { data } = await admin().from("fakturaer").select("dokument").eq("boost_koeb_id", koebId).order("dokument");
    expect((data ?? []).map((x) => x.dokument)).toEqual(["faktura", "kreditnota"]);
    // Logget i medarbejder-loggen.
    const { count } = await admin()
      .from("moderation_log")
      .select("id", { count: "exact", head: true })
      .eq("handling", "boost_refunderet")
      .eq("bruger_id", KOEBER.id);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
