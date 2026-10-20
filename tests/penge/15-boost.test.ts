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
//   H. Pakkerne (19. okt. 2026): 300 point for 99 kr. og 700 for 199 kr.
//      (kun pakkens id sendes), skift af pakke annullerer den gamle
//      PaymentIntent hos Stripe først, ukendt pakke afvises, 700 point
//      krediteres én gang, faktura 199 kr., chefens refusion trækker 700
//      point tilbage.
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
  ventPaa,
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
    // Betalingsmetoder (Filip, 20. okt. 2026): præcis kort, MobilePay og
    // Revolut Pay - ingen Klarna eller Link.
    expect(pi.payment_method_types).toEqual(["card", "mobilepay", "revolut_pay"]);
    expect(pi.automatic_payment_methods?.enabled ?? false).toBe(false);
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
    expect(await synkBoostRetur(KOEBER.id, koebPi)).toEqual({ kode: "allerede", point: 100, beloebOere: 3900 });
    // En fremmed kan ikke spejle andres køb via returen.
    expect((await synkBoostRetur(FREMMED.id, koebPi)).kode).toBe("ikke_fundet");
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
    // Lille tolerance: slut_kl sættes af databasens ur, Date.now() er testmaskinens.
    expect(timer).toBeLessThanOrEqual(24.01);
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
      .select("type, point, bruger_id, betaling_id")
      .in("betaling_id", [hSalg.betalingId, hRefunderet.betalingId]);
    // Det refunderede salg giver aldrig point.
    expect((post ?? []).filter((p) => p.betaling_id === hRefunderet!.betalingId)).toEqual([]);
    // Højst 10 point pr. køber pr. sælger pr. måned (Filip, 15. okt. 2026):
    // andre testfiler (01 ...) har ofte allerede givet SAELGER 10 point fra
    // KOEBER i denne måned. Så er salget afvist - ellers giver det 10 point.
    const egne = (post ?? []).filter((p) => p.betaling_id === hSalg!.betalingId);
    const { data: afvist } = await admin()
      .from("boost_optjening_afvist")
      .select("grund")
      .eq("betaling_id", hSalg.betalingId);
    // Point, KOEBER allerede har givet SAELGER i måneden (før dette salg).
    const maaned = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit" }).format(new Date());
    const start = new Date(`${maaned}-01T00:00:00+02:00`).getTime() - 2 * 3_600_000; // rummelig grænse
    const { data: alle } = await admin()
      .from("boost_posteringer")
      .select("point, betaling_id, betalinger!inner(buyer_id, frigivet_kl)")
      .eq("type", "optjening")
      .eq("bruger_id", SAELGER.id)
      .eq("betalinger.buyer_id", KOEBER.id)
      .gte("betalinger.frigivet_kl", new Date(start).toISOString())
      .neq("betaling_id", hSalg.betalingId);
    const tidligere = (alle ?? []).reduce((s, x) => s + Number(x.point), 0);
    if (tidligere >= 10) {
      expect(egne).toEqual([]);
      expect(afvist).toEqual([{ grund: "maks_pr_koeber" }]);
    } else {
      expect(egne).toHaveLength(1);
      expect(egne[0]).toMatchObject({ type: "optjening", point: 10 - tidligere, bruger_id: SAELGER.id });
      expect(afvist).toEqual([]);
    }
  });

  it("sluttilstand: udbetalingen af salget betales", async () => {
    const b = await betaling(hSalg!.betalingId);
    expect(await afslutPayout(konto, b.saelger_udbetaling_id!)).toBe("paid");
  });
});

describe("G. indsigelse på et køb - uden webhook (overvågningen)", () => {
  it("D2 finder den åbne indsigelse og låser pointene; D1 ser, at BidHamr vandt, og ophæver låsen", async () => {
    const s = await kald("boost-koeb", {}, KOEBER);
    expect(s.status).toBe(200);
    const id = String(s.body.koebId);
    const pi = piId(String(s.body.clientSecret));
    await udenTvungen3ds(pi);
    await stripe().paymentIntents.confirm(pi, {
      payment_method: "pm_card_createDispute",
      return_url: "https://bidhamr.dk/test-betaling",
    });
    const betalt = await stripe().paymentIntents.retrieve(pi);
    expect((await sendWebhook("payment_intent.succeeded", betalt as unknown as { id: string })).status).toBe(200);
    const liste = await ventPaa(
      () => stripe().disputes.list({ payment_intent: pi, limit: 1 }),
      (l) => l.data.length > 0,
      120_000,
    );
    const dispute = liste.data[0];
    expect(dispute).toBeTruthy();
    const laast = async () => {
      const { data } = await admin().rpc("boost_point_laast", { p_bruger: KOEBER.id });
      return data === true;
    };
    // Ingen charge.dispute-webhook: databasen kender ikke indsigelsen.
    expect((await koeb(id)).status).toBe("betalt");
    const { data: foer } = await admin().from("boost_koeb").select("indsigelse_status").eq("id", id).single();
    expect(foer?.indsigelse_status).toBeNull();

    const { opsamlBoostIndsigelser } = await import("@/lib/betaling/overvaagning");
    const alarmer: string[] = [];
    const alarm = async (o: { noegle: string }) => {
      alarmer.push(o.noegle);
    };
    // D2
    expect(await opsamlBoostIndsigelser(alarm as never, { minAlderMs: 0 })).toBeGreaterThanOrEqual(1);
    const { data: aaben } = await admin().from("boost_koeb").select("indsigelse_status, stripe_dispute_id").eq("id", id).single();
    expect(aaben?.stripe_dispute_id).toBe(dispute.id);
    expect(["needs_response", "warning_needs_response", "under_review", "warning_under_review"]).toContain(aaben?.indsigelse_status);
    expect(alarmer).toContain(`indsigelse-ukendt:${dispute.id}`);
    expect(await laast()).toBe(true);
    const b = await kald("boost-brug", { auktion_id: auktionId, noegle: randomUUID() }, KOEBER);
    expect(b.status).toBe(409);
    expect(b.body.kode).toBe("laast");
    const saldoAaben = await saldo(KOEBER.id);

    // BidHamr vinder (testmiljøet: "winning_evidence") - stadig uden webhook.
    await stripe().disputes.update(dispute.id, { evidence: { uncategorized_text: "winning_evidence" }, submit: true });
    const vundet = await ventPaa(
      () => stripe().disputes.retrieve(dispute.id),
      (d) => d.status === "won",
      180_000,
    );
    expect(vundet.status).toBe("won");
    // D1
    expect(await opsamlBoostIndsigelser(alarm as never, { minAlderMs: 0 })).toBeGreaterThanOrEqual(1);
    const { data: efter } = await admin().from("boost_koeb").select("indsigelse_status").eq("id", id).single();
    expect(efter?.indsigelse_status).toBe("won");
    expect(alarmer).toContain(`indsigelse-event:${dispute.id}:won`);
    expect(await laast()).toBe(false);
    expect(await saldo(KOEBER.id)).toBe(saldoAaben); // intet trukket
  });
});

describe("H. større pakker (Filip, 19. okt. 2026)", () => {
  let id300 = "";
  let pi300 = "";
  let id700 = "";
  let pi700 = "";

  it("300 point for 99 kr.: serveren vælger pris og point ud fra pakkens id", async () => {
    const s = await kald("boost-koeb", { pakke: "point_300" }, KOEBER);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ beloebOere: 9900, point: 300, pakke: "point_300" });
    id300 = String(s.body.koebId);
    pi300 = piId(String(s.body.clientSecret));
    const pi = await stripe().paymentIntents.retrieve(pi300);
    expect(pi.amount).toBe(9900);
    expect(pi.metadata.point).toBe("300");
    expect(pi.payment_method_options?.card?.request_three_d_secure).toBe("any");
    expect(await koeb(id300)).toMatchObject({ point: 300, beloeb_oere: 9900, status: "afventer" });
    // Samme pakke igen: samme køb og PaymentIntent.
    const igen = await kald("boost-koeb", { pakke: "point_300" }, KOEBER);
    expect(igen.body.koebId).toBe(id300);
    expect(piId(String(igen.body.clientSecret))).toBe(pi300);
  });

  it("skift til 700: den gamle PaymentIntent annulleres hos Stripe først, og et nyt køb startes", async () => {
    const s = await kald("boost-koeb", { pakke: "point_700" }, KOEBER);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ beloebOere: 19900, point: 700, pakke: "point_700" });
    id700 = String(s.body.koebId);
    pi700 = piId(String(s.body.clientSecret));
    expect(id700).not.toBe(id300);
    expect((await stripe().paymentIntents.retrieve(pi300)).status).toBe("canceled");
    const gl = await koeb(id300);
    expect(gl.status).toBe("annulleret");
    expect(gl.tidligere_payment_intents).toContain(pi300);
    expect((await stripe().paymentIntents.retrieve(pi700)).amount).toBe(19900);
  });

  it("ukendt pakke: 409 pakke_ukendt; ugyldig værdi: 400 - og intet ændres", async () => {
    const u = await kald("boost-koeb", { pakke: "point_999" }, KOEBER);
    expect(u.status).toBe(409);
    expect(u.body.kode).toBe("pakke_ukendt");
    const v = await kald("boost-koeb", { pakke: 700 }, KOEBER);
    expect(v.status).toBe(400);
    expect((await koeb(id700)).status).toBe("afventer");
  });

  it("betalt -> 700 point præcis én gang; kvittering og faktura med 199 kr.", async () => {
    const foer = await saldo(KOEBER.id);
    await udenTvungen3ds(pi700);
    await stripe().paymentIntents.confirm(pi700, {
      payment_method: "pm_card_bypassPending",
      return_url: "https://bidhamr.dk/test-betaling",
    });
    const pi = await stripe().paymentIntents.retrieve(pi700);
    expect(pi.status).toBe("succeeded");
    expect((await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string })).status).toBe(200);
    expect((await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string })).status).toBe(200);
    expect(await saldo(KOEBER.id)).toBe(foer + 700);
    expect(await synkBoostRetur(KOEBER.id, pi700)).toEqual({ kode: "allerede", point: 700, beloebOere: 19900 });
    await admin().rpc("faktura_planlaeg_boost", { p_graense: 200 });
    const { data } = await admin()
      .from("fakturaer")
      .select("dokument, beloeb_oere, moms_oere, linjer")
      .eq("boost_koeb_id", id700);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ dokument: "faktura", beloeb_oere: 19900, moms_oere: 3980 });
    expect((data![0].linjer as { tekst: string }[])[0].tekst).toBe("Boost-point (700 point)");
  });

  it("chefens refusion: 199 kr. refunderes, og pakkens 700 point trækkes tilbage", async () => {
    const foer = await saldo(KOEBER.id);
    const r = await staffRefunderBoostKoeb(CHEF_ID, id700, "TEST pengetest: refusion af 700-pakke");
    expect(r).toMatchObject({ ok: true, kode: "refunderet", oensket: 700 });
    const trukket = "ok" in r ? r.trukket : -1;
    expect(trukket).toBe(Math.min(700, foer));
    expect(await saldo(KOEBER.id)).toBe(foer - trukket);
    const k = await koeb(id700);
    expect(k.status).toBe("refunderet");
    expect((await stripe().refunds.retrieve(k.stripe_refund_id!)).amount).toBe(19900);
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
