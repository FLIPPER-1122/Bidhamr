// Scenarie: de nye sagsregler (Filip, 27. okt. 2026 - 20261102210000) med
// rigtige Stripe-refusioner og -betalinger i testmiljøet.
//
//   A. Bortkommet pakke (fragtfirmaet meldte leveret, køberen har den ikke):
//      køberen opretter sagen (sag_opret uden billeder), staff giver medhold
//      (sag_afgoer), ankefristen udløber -> køberen får HELE beløbet tilbage
//      (bud + gebyr + fragt). Hele application fee refunderes, hele sælgerens
//      del tilbageføres, BidHamr står med 0, sælgerens konto med 0.
//   B. Transportskade, SÆLGEREN betaler returfragten (dårlig indpakning):
//      staff vælger 'saelger' -> returfragten er dækket (ingen PaymentIntent
//      til køberen), returen registreres afleveret -> køberen får hele
//      beløbet, og sælgeren får en regning (ekstra fragt, slags
//      'returfragt_sag') på fragten ud. Sælgeren betaler regningen med en
//      PaymentIntent på BidHamrs platformskonto (ingen destination charge,
//      intet application fee, 3DS) -> webhook -> 'betalt' (én gang).
//   C. Transportskade, BIDHAMR betaler returfragten (god indpakning):
//      indpakningen registreres ordentlig, ingen regning til sælgeren, og
//      reklamationen hos fragtfirmaet oprettes, når køberen er refunderet.
// Afgørelsen (sag_afgoer) skrives direkte som i 02: testdatabasens staff-
// brugere har handlet med pengetest-brugerne og er derfor inhabile
// (penge_inhabil). Selve sag_afgoer - valget af betaler, "andet", indpakningen -
// er testet i tests/penge-db/sagsregler.test.ts. Alt efter afgørelsen er den
// rigtige kode (sag_afvikl, refusionen hos Stripe, returfragt_start,
// sag_retur_afleveret, regningen og sælgerens betaling).
// Testkort: pm_card_bypassPending (4000 0000 0000 0077).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udfoerSagAfvikling, type SagAfvikling } from "@/lib/sagerServer";
import { startEkstraFragtBetaling } from "@/lib/betaling/ekstraFragt";
import {
  admin,
  betal,
  betaling,
  forberedSaelger,
  forventet,
  opretHandel,
  piId,
  rydOp,
  saldo,
  sendWebhook,
  stripe,
  stripeTal,
  udenTvungen3ds,
  type TestHandel,
} from "./handel";
import { CHEF_ID } from "./brugere";
import { logIndSom } from "./session";

const BUD = 40_000;
const X = forventet(BUD);
const DAG = 24 * 60 * 60_000;

let konto: string;
let hA: TestHandel;
let hB: TestHandel;
let hC: TestHandel;

beforeAll(async () => {
  konto = await forberedSaelger();
  hA = await opretHandel({ navn: "sag-bortkommet-hele", budOere: BUD });
  hB = await opretHandel({ navn: "sag-skade-saelger-betaler", budOere: BUD });
  hC = await opretHandel({ navn: "sag-skade-bidhamr-betaler", budOere: BUD });
});

afterAll(async () => {
  for (const h of [hA, hB, hC]) if (h) await rydOp(h);
});

// Betalt, sendt med "BidHamrs label" (DAO-fixture) og leveret.
async function leveret(h: TestHandel, kilde: "fragt" | null) {
  await betal(h);
  const nu = new Date().toISOString();
  const db = admin();
  const { error: fFejl } = await db.from("forsendelser").insert({
    trade_id: h.tradeId,
    type: "udgaaende",
    fragtfirma: "dao",
    status: "leveret",
    pakkestoerrelse: "lille",
    levering: "pakkeshop",
    sporingsnummer: `TESTPENGE${Date.now()}${Math.floor(Math.random() * 1000)}`,
    afsender: { navn: "TEST Penge Sælger", adresse: "Sælgervej 1", postnummer: "8000", by: "Aarhus C", telefon: "+4520000001", land: "DK" },
    leveret_kl: nu,
  });
  if (fFejl) throw new Error(`forsendelse: ${fFejl.message}`);
  const { error } = await db
    .from("trades")
    .update({ status: "modtaget", sendt_kl: nu, received_at: nu, tracking_number: "TESTPENGE", modtaget_kilde: kilde })
    .eq("id", h.tradeId);
  if (error) throw new Error(`handel: ${error.message}`);
}

// Pengene efter en fuld refusion: køberen har det hele, sælgeren og BidHamr intet.
async function hele(h: TestHandel) {
  const b = await betaling(h.betalingId);
  expect(b.status).toBe("refunderet");
  expect(b.refusion_oere).toBe(X.total);
  const t = await stripeTal(b);
  expect(t.refunderet).toBe(X.total);
  // Hele application fee (købergebyr + sælgergebyr + fragt) er givet tilbage.
  expect(t.gebyr).toBe(X.gebyr);
  expect(t.gebyrRefunderet).toBe(X.gebyr);
  // Hele sælgerens del er hentet tilbage fra hans Connect-konto.
  expect(t.tilbagefoert).toBe(X.udbetaling + X.gebyr);
  // BidHamr: gebyr - gebyr-refusion + tilbageført - refunderet = 0.
  expect(t.gebyr - t.gebyrRefunderet + t.tilbagefoert - t.refunderet).toBe(0);
  expect(b.saelger_udbetaling_id).toBeNull();
}

async function skadeSag(h: TestHandel): Promise<string> {
  const { data, error } = await admin()
    .from("sager")
    .insert({
      trade_id: h.tradeId,
      oprettet_af: h.koeber.id,
      type: "skadet",
      beskrivelse: "TEST pengetest: varen kom frem i stykker.",
      status: "aaben",
      beskyttelse: true,
      handel_status_ved_oprettelse: "modtaget",
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`sag: ${error?.message}`);
  await admin().from("trades").update({ sag_aaben: true }).eq("id", h.tradeId);
  return data.id;
}

// Medhold til køberen som sag_afgoer skriver det (ankefristen er udløbet).
async function medhold(sagId: string, retur: { betaler: "saelger" | "bidhamr" } | null) {
  const { error } = await admin()
    .from("sager")
    .update({
      status: retur ? "afventer_retur" : "afgjort_koeber",
      retur_kraeves: !!retur,
      returfragt_betaler: retur?.betaler ?? null,
      afgjort_af: CHEF_ID,
      afgjort_kl: new Date(Date.now() - 5 * DAG).toISOString(),
      begrundelse: "TEST pengetest: medhold til køberen.",
      penge_handling: "refunder",
      penge_flyttes_efter_kl: new Date(Date.now() - 60_000).toISOString(),
    })
    .eq("id", sagId);
  if (error) throw new Error(`medhold: ${error.message}`);
}

describe("A: bortkommet pakke - hele beløbet tilbage", () => {
  let sagId: string;

  it("køberen melder pakken bortkommet efter leveringsmeldingen (uden billeder)", async () => {
    await leveret(hA, "fragt");
    // 72-timers fristen er låst på handlen.
    const { data: t } = await admin().from("trades").select("received_at, problem_frist_kl").eq("id", hA.tradeId).single();
    expect(Date.parse(t!.problem_frist_kl as string) - Date.parse(t!.received_at as string)).toBe(72 * 60 * 60_000);
    const klient = await logIndSom(hA.koeber.id, hA.koeber.email);
    const { data, error } = await klient.rpc("sag_opret", {
      p_trade: hA.tradeId,
      p_type: "bortkommet",
      p_beskrivelse: "TEST pengetest: der står leveret, men jeg har ikke fået pakken.",
      p_billeder: [],
    });
    expect(error).toBeNull();
    expect((data as { kode: string }).kode).toBe("ok");
    sagId = (data as { sag_id: string }).sag_id;
  });

  it("medhold + ankefristen udløbet: hele beløbet (bud + gebyr + fragt) refunderes, gentaget afvikling flytter intet", async () => {
    await medhold(sagId, null);
    const { data: v } = await admin().rpc("sag_afvikl", { p_sag: sagId });
    expect((v as { kode: string }).kode).toBe("ok");
    expect(await udfoerSagAfvikling(v as SagAfvikling, { notificer: false })).toBe("refunderet");
    await hele(hA);
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(0);
    const { data: igen } = await admin().rpc("sag_afvikl", { p_sag: sagId });
    expect((igen as { kode: string }).kode).toBe("intet");
    expect((await stripeTal(await betaling(hA.betalingId))).refunderet).toBe(X.total);
  });
});

describe("B: transportskade - sælgeren betaler returfragten", () => {
  let sagId: string;
  let regningId: string;

  it("'saelger' betaler -> køberen starter returen uden at betale (dækket, ingen PaymentIntent)", async () => {
    await leveret(hB, null);
    sagId = await skadeSag(hB);
    await medhold(sagId, { betaler: "saelger" });
    // Køberen starter returen: dækket - ingen PaymentIntent.
    const { data: r } = await admin().rpc("returfragt_start", { p_trade: hB.tradeId, p_koeber: hB.koeber.id });
    expect(r).toMatchObject({ kode: "daekket", betaler: "saelger", beloeb_oere: X.fragt });
    const { data: rf } = await admin()
      .from("returfragt_betalinger")
      .select("status, betaler, stripe_payment_intent_id")
      .eq("trade_id", hB.tradeId)
      .single();
    expect(rf).toMatchObject({ status: "betalt", betaler: "saelger", stripe_payment_intent_id: null });
  });

  it("returen afleveret: køberen får hele beløbet, og sælgeren får en regning på returfragten", async () => {
    const { data: r, error } = await admin().rpc("sag_retur_afleveret", {
      p_medarbejder: CHEF_ID,
      p_sag: sagId,
      p_note: "TEST pengetest: returpakken er afleveret.",
    });
    expect(error).toBeNull();
    const svar = r as { kode: string; handling: string; returfragt_regning: { kode: string; id: string } };
    expect(svar.kode).toBe("ok");
    expect(svar.returfragt_regning.kode).toBe("ok");
    regningId = svar.returfragt_regning.id;
    // Afviklingen (som admin-handlingen gør efter sag_retur_afleveret).
    const { data: v } = await admin().rpc("sag_afvikl", { p_sag: sagId });
    if ((v as { kode: string }).kode === "ok") await udfoerSagAfvikling(v as SagAfvikling, { notificer: false });
    else {
      // sag_retur_afleveret afviklede allerede (fristen var udløbet).
      const { data: s } = await admin().from("sager").select("afviklet_kl").eq("id", sagId).single();
      expect(s?.afviklet_kl).not.toBeNull();
      const { refunderBetaling } = await import("@/lib/betaling/stripeBetaling");
      await refunderBetaling(hB.betalingId);
    }
    await hele(hB);
    const { data: x } = await admin()
      .from("ekstra_fragt_regninger")
      .select("slags, beloeb_oere, saelger_id, status, sag_id")
      .eq("id", regningId)
      .single();
    expect(x).toMatchObject({ slags: "returfragt_sag", beloeb_oere: X.fragt, saelger_id: hB.saelger.id, status: "afventer_betaling", sag_id: sagId });
    // Ingen ny regning ved gentagelse.
    const { data: igen } = await admin().rpc("sag_returfragt_regning", { p_sag: sagId });
    expect((igen as { kode: string }).kode).toBe("findes");
  });

  it("sælgeren betaler regningen på BidHamrs platformskonto (ingen destination, intet gebyr) - én gang", async () => {
    const s = await startEkstraFragtBetaling(regningId, hB.saelger.id);
    if (!("ok" in s)) throw new Error(`startEkstraFragtBetaling: ${s.fejl}`);
    expect(s.beloebOere).toBe(X.fragt);
    const id = piId(s.clientSecret);
    await udenTvungen3ds(id);
    const pi0 = await stripe().paymentIntents.retrieve(id);
    expect(pi0.transfer_data ?? null).toBeNull();
    expect(pi0.application_fee_amount ?? null).toBeNull();
    expect(pi0.on_behalf_of ?? null).toBeNull();
    expect(pi0.metadata?.type).toBe("ekstra_fragt");
    await stripe().paymentIntents.confirm(id, { payment_method: "pm_card_bypassPending", return_url: "https://bidhamr.dk/test-betaling" });
    const pi = await stripe().paymentIntents.retrieve(id);
    expect(pi.status).toBe("succeeded");
    const w1 = await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string } & Record<string, unknown>);
    expect(w1.status).toBe(200);
    const w2 = await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string } & Record<string, unknown>);
    expect(w2.status).toBe(200);
    const { data: x } = await admin().from("ekstra_fragt_regninger").select("status, modtaget_oere").eq("id", regningId).single();
    expect(x).toMatchObject({ status: "betalt", modtaget_oere: X.fragt });
    // Samme betaling igen: allerede betalt - ingen ny PaymentIntent.
    const igen = await startEkstraFragtBetaling(regningId, hB.saelger.id);
    expect("ok" in igen).toBe(false);
  });
});

describe("C: transportskade - BidHamr betaler returfragten (reklamation)", () => {
  let sagId: string;

  it("'bidhamr': indpakningen registreres ordentlig; returen er dækket; ingen regning; reklamationen oprettes efter refusionen", async () => {
    await leveret(hC, null);
    sagId = await skadeSag(hC);
    // Som sag_afgoer med 'bidhamr': indpakningen registreres ordentlig.
    const { error: oFejl } = await admin()
      .from("indpakning_ordentlig")
      .insert({ sag_id: sagId, trade_id: hC.tradeId, vurderet_af: CHEF_ID, intern_note: "TEST pengetest: BidHamr betaler returfragten" });
    expect(oFejl).toBeNull();
    await medhold(sagId, { betaler: "bidhamr" });
    const { data: r } = await admin().rpc("returfragt_start", { p_trade: hC.tradeId, p_koeber: hC.koeber.id });
    expect(r).toMatchObject({ kode: "daekket", betaler: "bidhamr" });
    const { data: ra } = await admin().rpc("sag_retur_afleveret", {
      p_medarbejder: CHEF_ID,
      p_sag: sagId,
      p_note: "TEST pengetest: returpakken er afleveret.",
    });
    expect((ra as { kode: string; returfragt_regning: unknown }).returfragt_regning ?? null).toBeNull();
    const { data: v } = await admin().rpc("sag_afvikl", { p_sag: sagId });
    if ((v as { kode: string }).kode === "ok") await udfoerSagAfvikling(v as SagAfvikling, { notificer: false });
    else {
      const { refunderBetaling } = await import("@/lib/betaling/stripeBetaling");
      await refunderBetaling(hC.betalingId);
    }
    await hele(hC);
    const { count } = await admin().from("ekstra_fragt_regninger").select("id", { count: "exact", head: true }).eq("sag_id", sagId);
    expect(count ?? 0).toBe(0);
    await admin().rpc("fragt_reklamationer_synkroniser_alle", { p_graense: 200 });
    const { data: rek } = await admin().from("fragt_reklamationer").select("status, transportoer").eq("sag_id", sagId).maybeSingle();
    expect(rek).toMatchObject({ status: "afventer_bidhamr", transportoer: "dao" });
  });
});
