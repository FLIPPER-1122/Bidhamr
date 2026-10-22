// Scenarie: reklamation hos fragtfirma (BidHamr anmelder, chefen udbetaler -
// Filip, 22. okt. 2026; migration 20261029010000). Varen blev skadet under
// fragten (DAO), køberen får medhold og pengene tilbage, sælgeren pakkede
// ordentligt -> reklamationen oprettes automatisk. Staff anmelder og
// registrerer DAO's godkendelse; chefen bekræfter, at erstatningen er
// modtaget, og udbetaler: Stripe Transfer fra BidHamrs platformssaldo til
// sælgerens Connect-konto og derfra en payout til sælgerens bank.
//
// Staff- og chef-RPC'erne kræver to-trins-login (aal2) og testes for sig på
// testdatabasen (se docs/FRAGT.md); her sættes de samme felter med service
// role, og ALT med penge går gennem den rigtige kode
// (src/lib/reklamation/udbetaling.ts + webhook-ruten) mod Stripes testmiljø.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { udfoerSagAfvikling, type SagAfvikling } from "@/lib/sagerServer";
import {
  transferGruppe,
  udbetalReklamationTilBank,
  udfoerReklamationTransfer,
  type UdbetalClaim,
} from "@/lib/reklamation/udbetaling";
import { spejlUdbetaling } from "@/lib/betaling/stripeBetaling";
import { admin, betal, betaling, forberedSaelger, opretHandel, rydOp, saldo, sendWebhook, stripe, ventPaa, ventPaaPayout, type TestHandel } from "./handel";
import { CHEF_ID } from "./brugere";

let h: TestHandel;
let konto: string;
let sagId: string;
let rekId: string;
const GODKENDT = 40_000;

async function rek() {
  const { data, error } = await admin().from("fragt_reklamationer").select("*").eq("id", rekId).single();
  if (error || !data) throw new Error(`fragt_reklamationer: ${error?.message}`);
  return data as Record<string, unknown>;
}

// Chefens claim (fragt_reklamation_udbetal_claim) - samme felter.
async function claim(): Promise<UdbetalClaim> {
  const r = await rek();
  const nu = new Date().toISOString();
  if (!r.udbetaling_paabegyndt_kl) {
    const { error } = await admin()
      .from("fragt_reklamationer")
      .update({
        erstatning_modtaget_kl: nu,
        erstatning_modtaget_af: CHEF_ID,
        udbetaling_paabegyndt_kl: nu,
        udbetaling_paabegyndt_af: CHEF_ID,
        udbetaling_stripe_konto: konto,
      })
      .eq("id", rekId);
    expect(error).toBeNull();
  }
  const e = await rek();
  return {
    beloeb_oere: Number(e.godkendt_beloeb_oere),
    konto,
    forsoeg: Number(e.udbetaling_forsoeg),
    trade_id: h.tradeId,
    sag_id: sagId,
    saelger_id: h.saelger.id,
    sagsnummer: e.transportoerens_sagsnummer as string,
    transportoer: "dao",
    genoptag: !!r.udbetaling_paabegyndt_kl,
    paabegyndt_kl: String(e.udbetaling_paabegyndt_kl),
  };
}

beforeAll(async () => {
  konto = await forberedSaelger();
  h = await opretHandel({ navn: "reklamation", budOere: 50_000 });
});

// Testserveren (test.bidhamr.dk) modtager også Stripes rigtige events for
// testkontoen. Kører den ældre kode uden reklamations-payouts, fryser den
// sælgeren ved netop denne payout - ikke denne kodes fejl, men ryddes op (som
// saelger_frysning_ophaev), så de næste testfiler ikke rammes. true = ryddet.
let bankPayout: string | null = null;
async function rydGammelFrysning(): Promise<boolean> {
  if (!bankPayout || !h) return false;
  const db = admin();
  const { data: grund } = await db.from("saelger_frysning_grunde").select("tekst").eq("user_id", h.saelger.id).maybeSingle();
  if (!grund?.tekst?.includes(bankPayout)) return false;
  console.warn("Testserveren kører ældre webhook-kode: sælgeren blev frosset ved reklamations-payouten - ophæves.");
  await db.from("betalingsprofiler").update({ udbetaling_frosset_kl: null, salg_frosset_kl: null }).eq("user_id", h.saelger.id);
  await db.from("saelger_frysning_grunde").delete().eq("user_id", h.saelger.id);
  return true;
}

afterAll(async () => {
  await rydGammelFrysning();
  if (h) await rydOp(h);
});

describe("reklamation: BidHamr anmelder, chefen udbetaler", () => {
  it("skadet under fragten + medhold + refusion + ordentlig indpakning: reklamationen oprettes", async () => {
    await betal(h);
    const db = admin();
    const nu = new Date().toISOString();
    expect(
      (await db.from("trades").update({ status: "modtaget", sendt_kl: nu, received_at: nu, tracking_number: "TESTREKL", sag_aaben: true }).eq("id", h.tradeId)).error,
    ).toBeNull();
    expect(
      (
        await db.from("forsendelser").insert({
          trade_id: h.tradeId,
          type: "udgaaende",
          fragtfirma: "dao",
          status: "oprettet",
          pakkestoerrelse: "lille",
          sporingsnummer: `TEST${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          levering: "pakkeshop",
        })
      ).error,
    ).toBeNull();
    const { data: s, error } = await db
      .from("sager")
      .insert({
        trade_id: h.tradeId,
        oprettet_af: h.koeber.id,
        type: "skadet",
        beskrivelse: "TEST pengetest: varen kom frem i stykker (reklamation).",
        status: "aaben",
        beskyttelse: false,
        handel_status_ved_oprettelse: "modtaget",
      })
      .select("id")
      .single<{ id: string }>();
    expect(error).toBeNull();
    sagId = s!.id;
    // Staff vurderer indpakningen ordentlig (indpakning_ordentlig kræver aal2 -
    // samme række med service role).
    expect((await db.from("indpakning_ordentlig").insert({ sag_id: sagId, trade_id: h.tradeId, vurderet_af: CHEF_ID })).error).toBeNull();
    // Medhold til køberen; ankefristen (4 dage) er udløbet.
    const afgjort = new Date(Date.now() - 5 * 24 * 3600_000).toISOString();
    expect(
      (
        await db
          .from("sager")
          .update({
            status: "afgjort_koeber",
            afgjort_af: CHEF_ID,
            afgjort_kl: afgjort,
            begrundelse: "TEST pengetest: medhold (reklamation).",
            penge_handling: "refunder",
            penge_flyttes_efter_kl: new Date(Date.now() - 60_000).toISOString(),
          })
          .eq("id", sagId)
      ).error,
    ).toBeNull();
    const { data: a } = await db.rpc("sag_afvikl", { p_sag: sagId });
    expect((a as { kode: string }).kode).toBe("ok");
    expect(await udfoerSagAfvikling(a as SagAfvikling, { notificer: false })).toBe("refunderet");
    expect((await betaling(h.betalingId)).status).toBe("refunderet");

    // Triggeren/cron'en opretter reklamationen.
    await db.rpc("fragt_reklamationer_synkroniser_alle", { p_graense: 50 });
    const { data: r } = await db.from("fragt_reklamationer").select("id, status, kravbeloeb_oere").eq("sag_id", sagId).single();
    expect(r?.status).toBe("afventer_bidhamr");
    expect(Number(r?.kravbeloeb_oere)).toBe(50_000); // varens værdi (under DAO's 2.500 kr.)
    rekId = r!.id as string;
  });

  it("staff anmelder og registrerer DAO's godkendelse", async () => {
    const nu = new Date().toISOString();
    const db = admin();
    expect(
      (await db.from("fragt_reklamationer").update({ status: "anmeldt", anmeldt_kl: nu, transportoerens_sagsnummer: "DAO-PENGETEST" }).eq("id", rekId)).error,
    ).toBeNull();
    expect(
      (
        await db
          .from("fragt_reklamationer")
          .update({ status: "godkendt", godkendt_beloeb_oere: GODKENDT, afgjort_kl: nu, afgjort_af: CHEF_ID })
          .eq("id", rekId)
      ).error,
    ).toBeNull();
    // Over kravbeløbet afvises af databasen.
    const { error } = await db.from("fragt_reklamationer").update({ godkendt_beloeb_oere: 60_000 }).eq("id", rekId);
    expect(error).not.toBeNull();
  });

  it("chefen udbetaler: Stripe Transfer til sælgerens konto med reklamationens metadata", async () => {
    // BidHamrs testsaldo skal dække beløbet (testmiljøet: fyld op med et
    // testkort, der gør pengene tilgængelige med det samme).
    const p = await stripe().balance.retrieve();
    const tilg = p.available.filter((x) => x.currency === "dkk").reduce((s, x) => s + Number(x.source_types?.card ?? 0), 0);
    if (tilg < GODKENDT) {
      await stripe().paymentIntents.create({
        amount: GODKENDT * 2,
        currency: "dkk",
        payment_method: "pm_card_bypassPending",
        payment_method_types: ["card"],
        confirm: true,
        description: "TEST pengetest: testsaldo til reklamation",
        metadata: { pengetest: "reklamation_saldo" },
      });
    }
    const foer = await saldo(konto);
    const res = await udfoerReklamationTransfer(rekId, await claim());
    expect(res).toBe("udbetalt");
    const r = await rek();
    expect(r.status).toBe("udbetalt");
    expect(r.udbetalt_af).toBe(CHEF_ID);
    expect(r.erstatning_modtaget_af).toBe(CHEF_ID);
    const t = await stripe().transfers.retrieve(String(r.stripe_transfer_id));
    expect(t.amount).toBe(GODKENDT);
    expect(t.currency).toBe("dkk");
    expect(t.destination).toBe(konto);
    expect(t.transfer_group).toBe(transferGruppe(h.tradeId));
    expect(t.metadata).toMatchObject({ type: "reklamation", reklamation_id: rekId, trade_id: h.tradeId, transportoer_sagsnummer: "DAO-PENGETEST" });
    const efter = await saldo(konto);
    expect(efter.tilgaengelig + efter.afventer - (foer.tilgaengelig + foer.afventer)).toBe(GODKENDT);
  });

  it("et gentaget forsøg (fx usikkert svar) udbetaler aldrig to gange", async () => {
    const c = await claim();
    const res = await udfoerReklamationTransfer(rekId, { ...c, genoptag: true });
    expect(res).toBe("udbetalt");
    const liste = await stripe().transfers.list({ destination: konto, transfer_group: transferGruppe(h.tradeId), limit: 100 });
    expect(liste.data.filter((t) => t.metadata?.reklamation_id === rekId)).toHaveLength(1);
  });

  it("videre til sælgerens bank: egen payout, genkendt af webhooken (ikke en fremmed udbetaling)", async () => {
    expect(await udbetalReklamationTilBank(rekId)).toBe("oprettet");
    const r = await rek();
    expect(r.bank_status).toBe("oprettet");
    const payoutId = String(r.bank_payout_id);
    const p = await stripe().payouts.retrieve(payoutId, undefined, { stripeAccount: konto });
    expect(p.amount).toBe(GODKENDT);
    expect(p.metadata).toMatchObject({ type: "reklamation", reklamation_id: rekId });
    // payout.* via den rigtige spejling: BidHamrs egen - ikke "fremmed".
    expect(await spejlUdbetaling(konto, payoutId)).toMatch(/^reklamation_/);
    const svar = await sendWebhook("payout.created", p as unknown as { id: string }, { konto });
    expect(svar.status).toBe(200);
    // Testserveren (test.bidhamr.dk) modtager også Stripes rigtige events for
    // testkontoen. Kører den ældre kode uden reklamations-payouts, fryser den
    // sælgeren ved netop denne payout - det er ikke denne kodes fejl, men
    // ryddes op, så de næste testfiler ikke rammes (som saelger_frysning_ophaev).
    const db = admin();
    bankPayout = payoutId;
    await ventPaa(() => rydGammelFrysning(), (v) => v, 20_000, 4000);
    const { data: prof } = await db.from("betalingsprofiler").select("udbetaling_frosset_kl").eq("user_id", h.saelger.id).single();
    expect(prof?.udbetaling_frosset_kl).toBeNull();
    // Igen: ingen ny payout.
    expect(await udbetalReklamationTilBank(rekId)).toBe("faerdig");
    // Stripe betaler testpayouten -> payout.paid spejles.
    const betalt = await ventPaaPayout(konto, payoutId);
    await sendWebhook(`payout.${betalt.status}`, betalt as unknown as { id: string }, { konto });
    if (betalt.status === "paid") expect((await rek()).bank_status).toBe("paid");
    const s = await saldo(konto);
    expect(s.tilgaengelig + s.afventer).toBe(0);
  });
});
