// Den daglige afstemning (src/lib/betaling/afstemning.ts) mod Stripes
// RIGTIGE testmiljø og testdatabasen, efter alle scenarierne (01-12).
// Kræver migrationen 20261019020000_pengeafstemning.sql på testdatabasen.
//
// Forventet: refusionen lavet "i dashboardet" i scenarie 03 (og staff's
// manuelle tilbageførsel bagefter) findes; ingen af BidHamrs egne
// betalinger, gebyrer, refusioner eller udbetalinger fra denne kørsel giver
// afvigelser. Afstemningen kører på hele Stripes testkonto (vindue 1 døgn) -
// også andres testdata - og registrerer det, den finder, som cron'en gør.
// Testens egne afvigelser markeres løst bagefter (som chefen ville).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { koerPengeafstemning, type Afstemning } from "@/lib/betaling/afstemning";
import { admin, kontekst } from "./handel";
import { CHEF_ID } from "./brugere";

type Afv = { id: string; type: string; betaling_id: string | null; noegle: string };
let r: Afstemning;
let koerselsBetalinger: { id: string; titel: string }[] = [];
let fundne: Afv[] = [];

beforeAll(async () => {
  const { data: auk } = await admin()
    .from("auctions")
    .select("id, titel")
    .like("titel", `%[${kontekst().koersel}]%`);
  const ids = (auk ?? []).map((a) => a.id as string);
  const { data: bet } = await admin().from("betalinger").select("id, auction_id").in("auction_id", ids);
  const titel = new Map((auk ?? []).map((a) => [a.id as string, a.titel as string]));
  koerselsBetalinger = (bet ?? []).map((b) => ({ id: b.id as string, titel: titel.get(b.auction_id as string) ?? "" }));
});

afterAll(async () => {
  const egne = new Set(koerselsBetalinger.map((b) => b.id));
  for (const a of fundne.filter((x) => x.betaling_id && egne.has(x.betaling_id))) {
    await admin().rpc("admin_penge_afvigelse_loes", {
      p_chef: CHEF_ID,
      p_id: a.id,
      p_note: "TEST pengetest: forventet afvigelse fra testen (dashboard-refusion) - løst af testen",
    });
  }
});

describe("daglig afstemning med Stripe", () => {
  it("kører hele vejen igennem og logges", async () => {
    r = await koerPengeafstemning({ tving: true, vindueDage: 1 });
    expect(r.koert).toBe(1);
    expect(r.betalinger).toBeGreaterThan(0);
    expect(r.gebyrer).toBeGreaterThan(0);
    expect(r.refusioner).toBeGreaterThan(0);
    expect(r.konti).toBeGreaterThan(0);
    expect(r.payouts).toBeGreaterThan(0);
    const { data: k } = await admin()
      .from("penge_afstemning_koersler")
      .select("id, ok, afsluttet_kl, antal_afvigelser")
      .order("startet_kl", { ascending: false })
      .limit(1)
      .single<{ id: number; ok: boolean; afsluttet_kl: string | null; antal_afvigelser: number }>();
    expect(k?.afsluttet_kl).toBeTruthy();
    expect(k?.ok).toBe(true);
    const { data } = await admin()
      .from("penge_afstemning_afvigelser")
      .select("id, type, betaling_id, noegle")
      .eq("sidste_koersel_id", k!.id);
    fundne = (data ?? []) as Afv[];
    expect(fundne.length).toBe(k!.antal_afvigelser);
    const { data: s } = await admin()
      .from("penge_saldo_snapshot")
      .select("kilde, livemode")
      .order("kl", { ascending: false })
      .limit(1)
      .single<{ kilde: string; livemode: boolean }>();
    expect(s).toEqual({ kilde: "afstemning", livemode: false });
  });

  it("finder refusionen og tilbageførslen, der er lavet uden om BidHamr", () => {
    const dashboard = koerselsBetalinger.find((b) => b.titel.includes("refusion-i-dashboardet"));
    expect(dashboard).toBeTruthy();
    const typer = fundne.filter((x) => x.betaling_id === dashboard!.id).map((x) => x.type);
    expect(typer).toContain("refusion_udenom");
    expect(typer).toContain("tilbagefoersel_udenom");
  });

  it("ingen afvigelser på BidHamrs egne pengebevægelser i denne kørsel", () => {
    const egne = new Set(koerselsBetalinger.filter((b) => !b.titel.includes("refusion-i-dashboardet")).map((b) => b.id));
    expect(fundne.filter((x) => x.betaling_id && egne.has(x.betaling_id))).toEqual([]);
  });

  it("ingen afvigelser på returfragt i sager (13) - betalinger og refusioner til platformen", async () => {
    const { data: auk } = await admin().from("auctions").select("id").like("titel", `%[${kontekst().koersel}]%`);
    const { data: t } = await admin().from("trades").select("id").in("auction_id", (auk ?? []).map((a) => a.id as string));
    const { data: rf } = await admin()
      .from("returfragt_betalinger")
      .select("stripe_payment_intent_id, stripe_charge_id, stripe_refund_id")
      .in("trade_id", (t ?? []).map((x) => x.id as string));
    const ids = (rf ?? []).flatMap((x) => [x.stripe_payment_intent_id, x.stripe_charge_id, x.stripe_refund_id]).filter((x): x is string => !!x);
    expect(ids.length).toBeGreaterThan(0);
    expect(fundne.filter((x) => ids.some((i) => x.noegle.includes(i)))).toEqual([]);
  });

  it("en ny tvungen kørsel registrerer de samme afvigelser uden at åbne dem som nye", async () => {
    const r2 = await koerPengeafstemning({ tving: true, vindueDage: 1 });
    expect(r2.koert).toBe(1);
    expect(r2.nye).toBe(0);
  });
});
