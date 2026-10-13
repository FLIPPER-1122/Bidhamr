// Scenarie: retur i en sag (Filip, 13. okt. 2026). Køberen har fået medhold
// (skadet, BidHamr Beskyttelse), ankefristen er udløbet, og varen skal sendes
// retur. Køberen betaler selv returfragten (= fragten ud, 40 kr.) til
// BidHamrs PLATFORMSKONTO - ingen destination charge, intet gebyr - med
// testkortet pm_card_bypassPending. Returkoden må først laves, når webhooken
// har bekræftet betalingen.
//
//   A. Betaling -> webhook -> returkode (testfragtfirmaet) -> faktura.
//      Gentaget webhook og ny "betal" giver ingen ny betaling eller label.
//   B. Betalt, men fragtfirmaet afviser labelen -> staff markeres, køberen
//      betaler ikke igen -> kan ikke laves -> HELE returfragten refunderes
//      automatisk (én refusion hos Stripe) -> kreditnota.
// Til sidst afvikles sagerne (køberen refunderes for varen som i 02), så
// pengene er i en sluttilstand.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { udfoerSagAfvikling, type SagAfvikling } from "@/lib/sagerServer";
import { lavReturlabel, startReturfragt } from "@/lib/fragt/handlinger";
import { koerReturfragtCron, refunderReturfragt } from "@/lib/betaling/returfragt";
import { testFirma } from "@/lib/fragt/testFirma";
import { FragtFejl } from "@/lib/fragt/types";
import {
  admin,
  betal,
  forberedSaelger,
  opretHandel,
  piId,
  rydOp,
  sendWebhook,
  stripe,
  udenTvungen3ds,
  ventPaa,
  PAKKESHOP_FRAGT_OERE,
  type TestHandel,
} from "./handel";
import { CHEF_ID } from "./brugere";
import { aktivKlient, logIndSom } from "./session";

const AFSENDER = { navn: "TEST Penge Køber", adresse: "Testvej 2", postnummer: "2100", by: "København Ø", telefon: "20000000" };

let hA: TestHandel;
let hB: TestHandel;
const sager = new Map<string, string>();

type Rf = {
  id: string;
  status: string;
  beloeb_oere: number;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  label_klar_kl: string | null;
  label_fejl_antal: number;
  forsendelse_id: string | null;
  stripe_refund_id: string | null;
  refunderet_kl: string | null;
  kraever_opmaerksomhed: boolean;
};

async function rf(tradeId: string): Promise<Rf | null> {
  const { data, error } = await admin()
    .from("returfragt_betalinger")
    .select("id, status, beloeb_oere, stripe_payment_intent_id, stripe_charge_id, label_klar_kl, label_fejl_antal, forsendelse_id, stripe_refund_id, refunderet_kl, kraever_opmaerksomhed")
    .eq("trade_id", tradeId)
    .order("oprettet_kl", { ascending: false })
    .limit(1)
    .maybeSingle<Rf>();
  if (error) throw new Error(`returfragt_betalinger: ${error.message}`);
  return data;
}

async function returForsendelser(tradeId: string) {
  const { data } = await admin().from("forsendelser").select("id, status, qr_kode, kraever_opmaerksomhed").eq("trade_id", tradeId).eq("type", "retur");
  return (data ?? []) as { id: string; status: string; qr_kode: string | null; kraever_opmaerksomhed: boolean }[];
}

// Betalt handel -> modtaget -> sag med medhold, der afventer retur
// (ankefristen udløbet). Sælgerens adresse står på den udgående label.
async function sagMedRetur(navn: string): Promise<TestHandel> {
  const h = await opretHandel({ navn, budOere: 30_000, beskyttelse: true });
  await betal(h);
  const db = admin();
  const nu = new Date().toISOString();
  const { error: tFejl } = await db
    .from("trades")
    .update({ status: "modtaget", sendt_kl: nu, received_at: nu, tracking_number: "TESTPENGE", sag_aaben: true })
    .eq("id", h.tradeId);
  if (tFejl) throw new Error(`handel: ${tFejl.message}`);
  const { error: fFejl } = await db.from("forsendelser").insert({
    trade_id: h.tradeId,
    type: "udgaaende",
    fragtfirma: "test",
    status: "leveret",
    pakkestoerrelse: "lille",
    levering: "pakkeshop",
    sporingsnummer: `TESTPENGE${Date.now()}`,
    afsender: { navn: "TEST Penge Sælger", adresse: "Sælgervej 1", postnummer: "8000", by: "Aarhus C", telefon: "+4520000001", land: "DK" },
    leveret_kl: nu,
  });
  if (fFejl) throw new Error(`udgående forsendelse: ${fFejl.message}`);
  const afgjort = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
  const { data: s, error } = await db
    .from("sager")
    .insert({
      trade_id: h.tradeId,
      oprettet_af: h.koeber.id,
      type: "skadet",
      beskrivelse: "TEST pengetest: varen kom frem i stykker (retur).",
      status: "afventer_retur",
      beskyttelse: true,
      handel_status_ved_oprettelse: "modtaget",
      retur_kraeves: true,
      returfragt_betaler: "koeber",
      afgjort_af: CHEF_ID,
      afgjort_kl: afgjort,
      begrundelse: "TEST pengetest: medhold - send varen retur.",
      penge_handling: "refunder",
      penge_flyttes_efter_kl: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !s) throw new Error(`sag: ${error?.message}`);
  sager.set(h.tradeId, s.id);
  return h;
}

// Køberen betaler returfragten med testkortet (3DS-tjek som i handel.ts).
async function betalReturfragt(h: TestHandel): Promise<Stripe.PaymentIntent> {
  const s = await startReturfragt(h.tradeId, h.koeber.id, AFSENDER);
  if (!("ok" in s)) throw new Error(`startReturfragt: ${s.fejl}`);
  const id = piId(s.clientSecret);
  await udenTvungen3ds(id);
  await stripe().paymentIntents.confirm(id, {
    payment_method: "pm_card_bypassPending",
    return_url: "https://bidhamr.dk/test-returfragt",
  });
  return stripe().paymentIntents.retrieve(id);
}

beforeAll(async () => {
  process.env.FRAGT_RETURLABEL_AKTIV = "true";
  await forberedSaelger();
  hA = await sagMedRetur("returfragt-betalt");
  hB = await sagMedRetur("returfragt-label-fejler");
});

afterAll(async () => {
  vi.restoreAllMocks();
  const db = admin();
  // Sluttilstand: sagen afgøres til køberen og afvikles (refusion af varen).
  for (const h of [hA, hB].filter(Boolean)) {
    const sagId = sager.get(h.tradeId);
    if (sagId) {
      await db
        .from("sager")
        .update({ status: "afgjort_koeber", penge_flyttes_efter_kl: new Date(Date.now() - 60_000).toISOString() })
        .eq("id", sagId);
      const { data: a } = await db.rpc("sag_afvikl", { p_sag: sagId });
      if ((a as { kode?: string } | null)?.kode === "ok") {
        await udfoerSagAfvikling(a as SagAfvikling, { notificer: false }).catch((e: unknown) => console.error("Afvikling:", e));
      }
    }
    // Ubetalte returfragter annulleres hos Stripe.
    const r = await rf(h.tradeId).catch(() => null);
    if (r?.stripe_payment_intent_id && r.status === "afventer") {
      await stripe().paymentIntents.cancel(r.stripe_payment_intent_id).catch(() => null);
    }
    await rydOp(h);
  }
  delete process.env.FRAGT_RETURLABEL_AKTIV;
});

describe("returfragt i en sag", () => {
  it("før betaling: ingen returkode, og databasen afviser en returlabel", async () => {
    const r = await lavReturlabel(hA.tradeId, hA.koeber.id, AFSENDER);
    expect(r).toEqual({ fejl: "Betal returfragten, før returkoden kan laves." });
    const { error } = await admin().from("forsendelser").insert({
      trade_id: hA.tradeId,
      type: "retur",
      fragtfirma: "test",
      status: "opretter",
      pakkestoerrelse: "lille",
    });
    expect(error?.message ?? "").toMatch(/returfragt_ikke_betalt/);
    expect(await returForsendelser(hA.tradeId)).toEqual([]);
  });

  it("køberen ser prisen (= fragten ud), og betalingen er til platformen med 3DS og metadata", async () => {
    await logIndSom(hA.koeber.id, hA.koeber.email);
    const { data: m } = await aktivKlient().rpc("min_returfragt", { p_trade: hA.tradeId });
    expect(m).toMatchObject({ rolle: "koeber", beloeb_oere: PAKKESHOP_FRAGT_OERE, sag: { kode: "ok" } });

    const s1 = await startReturfragt(hA.tradeId, hA.koeber.id, AFSENDER);
    const s2 = await startReturfragt(hA.tradeId, hA.koeber.id, AFSENDER);
    if (!("ok" in s1) || !("ok" in s2)) throw new Error("startReturfragt fejlede");
    // Samme PaymentIntent ved gentagelse (én række, idempotency key).
    expect(piId(s2.clientSecret)).toBe(piId(s1.clientSecret));
    expect(s1.beloebOere).toBe(PAKKESHOP_FRAGT_OERE);
    const pi = await stripe().paymentIntents.retrieve(piId(s1.clientSecret));
    expect(pi.amount).toBe(PAKKESHOP_FRAGT_OERE);
    expect(pi.currency).toBe("dkk");
    expect(pi.transfer_data).toBeNull();
    expect(pi.on_behalf_of).toBeNull();
    expect(pi.application_fee_amount).toBeNull();
    expect(pi.payment_method_options?.card?.request_three_d_secure).toBe("any");
    const r = await rf(hA.tradeId);
    expect(pi.metadata).toMatchObject({
      type: "returfragt",
      returfragt_id: r!.id,
      trade_id: hA.tradeId,
      sag_id: sager.get(hA.tradeId),
      bidhamr_db: "pjiigmzqwlfepxnjdvug",
    });
  });

  it("A: betalt hos Stripe, men ingen kode før webhooken; efter webhooken er koden klar", async () => {
    const pi = await betalReturfragt(hA);
    expect(pi.status).toBe("succeeded");
    // Ingen webhook endnu: ikke betalt i databasen, ingen returkode.
    expect((await rf(hA.tradeId))!.status).toBe("afventer");
    expect(await returForsendelser(hA.tradeId)).toEqual([]);

    const w = await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string });
    expect(w.status).toBe(200);
    const efter = await ventPaa(() => rf(hA.tradeId), (x) => !!x?.label_klar_kl, 60_000, 1000);
    expect(efter).toMatchObject({ status: "betalt", beloeb_oere: PAKKESHOP_FRAGT_OERE });
    expect(efter!.stripe_charge_id).toBeTruthy();
    const f = await returForsendelser(hA.tradeId);
    expect(f).toHaveLength(1);
    expect(f[0].status).toBe("oprettet");
    expect(f[0].qr_kode).toBeTruthy();
    expect(efter!.forsendelse_id).toBe(f[0].id);
  });

  it("A: gentaget webhook og ny betaling giver hverken ny betaling eller ny label", async () => {
    const r = (await rf(hA.tradeId))!;
    const pi = await stripe().paymentIntents.retrieve(r.stripe_payment_intent_id!);
    expect((await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string })).status).toBe(200);
    const igen = await startReturfragt(hA.tradeId, hA.koeber.id, AFSENDER);
    expect(igen).toMatchObject({ betalt: true });
    expect(await returForsendelser(hA.tradeId)).toHaveLength(1);
    const { data: alle } = await admin().from("returfragt_betalinger").select("id").eq("trade_id", hA.tradeId);
    expect(alle).toHaveLength(1);
    // Køberen ser koden; sælgeren ser, at returen er på vej.
    await logIndSom(hA.saelger.id, hA.saelger.email);
    const { data: s } = await aktivKlient().rpc("min_returfragt", { p_trade: hA.tradeId });
    expect(s).toEqual({ rolle: "saelger", retur_paa_vej: true });
  });

  it("A: fakturaen på returfragten (fragtkonto, 25 % moms) planlægges én gang", async () => {
    const r = (await rf(hA.tradeId))!;
    await admin().rpc("faktura_planlaeg_returfragt", { p_graense: 200 });
    await admin().rpc("faktura_planlaeg_returfragt", { p_graense: 200 });
    const { data } = await admin()
      .from("fakturaer")
      .select("dokument, part, slags, beloeb_oere, moms_oere, betaling_id")
      .eq("returfragt_id", r.id);
    expect(data).toEqual([
      { dokument: "faktura", part: "koeber", slags: "sag_returfragt", beloeb_oere: 4000, moms_oere: 800, betaling_id: hA.betalingId },
    ]);
  });

  it("B: labelen fejler efter betaling -> staff markeres, køberen betaler ikke igen", async () => {
    const spion = vi.spyOn(testFirma, "opretReturforsendelse").mockRejectedValue(new FragtFejl("Adressen blev afvist af fragtfirmaet."));
    const pi = await betalReturfragt(hB);
    expect((await sendWebhook("payment_intent.succeeded", pi as unknown as { id: string })).status).toBe(200);
    const efter = await ventPaa(() => rf(hB.tradeId), (x) => (x?.label_fejl_antal ?? 0) >= 1, 60_000, 1000);
    expect(efter).toMatchObject({ status: "betalt", label_klar_kl: null, kraever_opmaerksomhed: true });
    expect(spion).toHaveBeenCalled();
    const f = await returForsendelser(hB.tradeId);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: "fejlet", kraever_opmaerksomhed: true });
    expect(await startReturfragt(hB.tradeId, hB.koeber.id, AFSENDER)).toMatchObject({ betalt: true });
    // Køberen retter adressen og prøver igen: stadig afvist, stadig ingen ny betaling.
    const igen = await lavReturlabel(hB.tradeId, hB.koeber.id, { ...AFSENDER, adresse: "Testvej 3" });
    expect(igen).toEqual({ fejl: "Adressen blev afvist af fragtfirmaet." });
    const { data: alle } = await admin().from("returfragt_betalinger").select("id").eq("trade_id", hB.tradeId);
    expect(alle).toHaveLength(1);
  });

  it("B: kan ikke laves -> hele returfragten refunderes automatisk, én gang", async () => {
    const r = (await rf(hB.tradeId))!;
    // Samme trin som cron'en ved 5 fejl/48 timer (tiden kan ikke spoles frem
    // mod den rigtige database): claim + refusion.
    const { data: claim } = await admin().rpc("returfragt_refusion_claim", { p_id: r.id, p_aarsag: "label_umulig" });
    expect(claim).toBe("ok");
    expect(await refunderReturfragt(r.id)).toBe("refunderet");
    expect(await refunderReturfragt(r.id)).toBe("allerede");
    // Cron'en finder intet at gøre for den.
    await koerReturfragtCron();
    const efter = (await rf(hB.tradeId))!;
    expect(efter.status).toBe("refunderet");
    const refusioner = await stripe().refunds.list({ payment_intent: r.stripe_payment_intent_id!, limit: 10 });
    const aktive = refusioner.data.filter((x) => x.status !== "failed" && x.status !== "canceled");
    expect(aktive).toHaveLength(1);
    expect(aktive[0].amount).toBe(PAKKESHOP_FRAGT_OERE);
    expect(aktive[0].id).toBe(efter.stripe_refund_id);
    expect(aktive[0].metadata).toMatchObject({ type: "returfragt", returfragt_id: r.id });
    // Faktura + kreditnota.
    await admin().rpc("faktura_planlaeg_returfragt", { p_graense: 200 });
    const { data } = await admin().from("fakturaer").select("dokument, beloeb_oere").eq("returfragt_id", r.id).order("dokument");
    expect(data).toEqual([
      { dokument: "faktura", beloeb_oere: 4000 },
      { dokument: "kreditnota", beloeb_oere: 4000 },
    ]);
    vi.restoreAllMocks();
  });
});
