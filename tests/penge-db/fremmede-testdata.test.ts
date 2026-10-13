// Fremmede testdata (delt Stripe-testkonto før fase 6), Test eller live-
// lampen og grupperingen af drift-fejl. Ingen database, intet netværk: hele
// koerPengeafstemning køres mod en falsk Stripe og en falsk database i
// hukommelsen - én gang med TESTnøgle og én gang med LIVE-nøgle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------- falsk database

type Raekke = Record<string, unknown>;
const db: Record<string, Raekke[]> = {};
const registrerede: { noegle: string; type: string }[] = [];
const alarmer: string[] = [];
const driftFejl: string[] = [];

class Forespoergsel implements PromiseLike<{ data: unknown; error: null }> {
  private filtre: ((r: Raekke) => boolean)[] = [];
  private maks = Infinity;
  private enkelt = false;
  constructor(private tabel: string) {}
  select() {
    return this;
  }
  in(k: string, v: unknown[]) {
    this.filtre.push((r) => v.includes(r[k]));
    return this;
  }
  eq(k: string, v: unknown) {
    this.filtre.push((r) => r[k] === v);
    return this;
  }
  neq(k: string, v: unknown) {
    this.filtre.push((r) => r[k] !== v);
    return this;
  }
  is(k: string, v: unknown) {
    this.filtre.push((r) => (r[k] ?? null) === v);
    return this;
  }
  not(k: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.filtre.push((r) => (r[k] ?? null) !== null);
    return this;
  }
  gte(k: string, v: string) {
    this.filtre.push((r) => r[k] != null && String(r[k]) >= v);
    return this;
  }
  lt(k: string, v: unknown) {
    this.filtre.push((r) => r[k] != null && (r[k] as number) < (v as number));
    return this;
  }
  overlaps(k: string, v: string[]) {
    this.filtre.push((r) => Array.isArray(r[k]) && (r[k] as string[]).some((x) => v.includes(x)));
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.maks = n;
    return this;
  }
  maybeSingle() {
    this.enkelt = true;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, fejl?: ((e: unknown) => B | PromiseLike<B>) | null) {
    const ud = (db[this.tabel] ?? []).filter((r) => this.filtre.every((f) => f(r))).slice(0, this.maks);
    return Promise.resolve({ data: this.enkelt ? (ud[0] ?? null) : ud, error: null }).then(ok, fejl);
  }
}

const falskAdmin = {
  from: (t: string) => new Forespoergsel(t),
  rpc: async (navn: string, args: Record<string, unknown>) => {
    if (navn === "penge_afstemning_claim") return { data: 1, error: null };
    if (navn === "penge_afvigelse_registrer") {
      registrerede.push({ noegle: String(args.p_noegle), type: String(args.p_type) });
      return { data: "ny", error: null };
    }
    return { data: null, error: null };
  },
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => falskAdmin }));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: async (x: { fejl: unknown }) => {
    driftFejl.push(String(x.fejl instanceof Error ? x.fejl.message : x.fejl));
    return "ny";
  },
}));
vi.mock("@/lib/betaling/driftTilfaelde", () => ({
  alarmPrTilfaelde: async (x: { noegle: string }) => {
    alarmer.push(x.noegle);
    return true;
  },
  lukTilfaelde: async () => {},
}));
vi.mock("@/lib/betaling/udbetaling", () => ({ dkk: () => 0 }));

// ------------------------------------------------------------- falsk Stripe

type Obj = Record<string, unknown> & { id: string };
const stripeData: Record<string, Obj[]> = {};
const liste = (xs: Obj[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const x of xs) yield x;
  },
});
const falskStripe = {
  paymentIntents: {
    list: () => liste(stripeData.pis ?? []),
    retrieve: async (id: string) => (stripeData.pis ?? []).find((p) => p.id === id),
  },
  charges: { retrieve: async (id: string) => ({ id, refunded: false }) },
  applicationFees: { list: () => liste(stripeData.fees ?? []) },
  refunds: {
    list: (p: { charge?: string }) => liste((stripeData.refunds ?? []).filter((x) => !p.charge || x.charge === p.charge)),
  },
  transfers: { list: () => liste(stripeData.transfers ?? []) },
  payouts: { list: () => liste([]), retrieve: async () => ({}) },
  disputes: { list: () => liste(stripeData.disputes ?? []) },
  balance: { retrieve: async () => ({ available: [], pending: [], livemode: false }) },
};
vi.mock("@/lib/stripe", async () => {
  const rigtig = await vi.importActual<typeof import("@/lib/stripe")>("@/lib/stripe");
  return { ...rigtig, getStripe: () => falskStripe };
});

const { koerPengeafstemning, erFremmedTestdata, henviserTilKendt, ingenKendte } = await import("@/lib/betaling/afstemning");
const { stripeTilstandLampe } = await import("@/lib/admin/stripeLampe");
const { egenDatabase, erFremmedTestobjekt, erFremmedTestCharge, piHenvisning } = await import("@/lib/betaling/fremmedeTestdata");
const { normaliserFejlbesked, fejlGruppeNoegle, tilfoejEksempler, MAKS_EKSEMPLER } = await import("@/lib/driftGruppering");

// ------------------------------------------------------------- scenariet
//
// Databasen kender én betaling (B1) på sælgerkonto acct_egen1. Hos Stripe
// ligger desuden:
//   *_fremmed  - den anden databases testdata (henviser til intet, vi kender)
//   *_egen*    - ukendt for databasen, men på VORES Connect-konto eller med
//                VORES betaling i metadata (skal altid meldes)
//   re_udenom  - en dashboard-refusion på vores kendte charge

const B1 = "11111111-1111-4111-8111-000000000001";
const FREMMED_BETALING = "22222222-2222-4222-8222-000000000002";
const nu = () => new Date().toISOString();
const sek = () => Math.floor(Date.now() / 1000);

function fyld(livemode = false) {
  for (const k of Object.keys(db)) delete db[k];
  db.betalinger = [
    {
      id: B1, status: "betalt", pengemodel: "destination", total_oere: 10000, udbetaling_oere: 9000,
      application_fee_oere: 1000, refusion_gebyr_oere: null, gebyr_refunderet_kl: null, refusion_tilbagefoert_kl: null,
      indsigelse_tilbagefoersel_id: null, indsigelse_tilbagefoert_oere: null, refusion_oere: null, refusion_anmodet_kl: null,
      stripe_payment_intent_id: "pi_kendt1", stripe_charge_id: "ch_kendt1", stripe_application_fee_id: "fee_kendt1",
      stripe_destination_transfer_id: "tr_kendt1", stripe_transfer_id: null, stripe_refund_id: null,
      bidhamr_daekker_refund_id: null, bidhamr_daekker_oere: null, bidhamr_daekker_kl: null, bidhamr_daekker_refunderet_kl: null,
      tidligere_payment_intents: [], betalt_kl: nu(), saelger_stripe_konto: "acct_egen1", seller_id: "s1", saelger_udbetaling_id: null,
    },
  ];
  db.betalingsprofiler = [{ stripe_account_id: "acct_egen1", stripe_customer_id: "cus_egen1", connect_frakoblet_kl: null, connect_charges_enabled: true }];
  db.saelger_udbetalinger = [];
  db.betaling_afvigelser = [];
  db.firmaer = [];
  db.penge_afstemning_koersler = [];

  const pi = (id: string, md: Record<string, string>, dest: string | null) => ({
    id, object: "payment_intent", status: "succeeded", amount: 10000, amount_received: 10000, livemode, created: sek(),
    metadata: md, customer: null, latest_charge: `ch_${id.slice(3)}`, transfer_data: dest ? { destination: dest } : null, on_behalf_of: null,
  });
  stripeData.pis = [
    pi("pi_kendt1", { betaling_id: B1 }, "acct_egen1"),
    pi("pi_fremmed1", { betaling_id: FREMMED_BETALING }, "acct_fremmed"),
    pi("pi_egenkonto", {}, "acct_egen1"),
    pi("pi_egenmeta", { betaling_id: B1 }, "acct_fremmed"),
  ];
  stripeData.fees = [
    { id: "fee_kendt1", amount: 1000, amount_refunded: 0, account: "acct_egen1", charge: "py_kendt1", originating_transaction: "ch_kendt1", livemode },
    { id: "fee_fremmed", amount: 700, amount_refunded: 0, account: "acct_fremmed", charge: "py_fremmed", originating_transaction: "ch_fremmed1", livemode },
    { id: "fee_egenkonto", amount: 300, amount_refunded: 0, account: "acct_egen1", charge: "py_egenkonto", originating_transaction: "ch_egenkonto", livemode },
  ];
  stripeData.refunds = [
    { id: "re_fremmed", amount: 5000, status: "succeeded", charge: "ch_fremmed1", payment_intent: "pi_fremmed1", metadata: {}, created: sek() },
    { id: "re_udenom", amount: 1000, status: "succeeded", charge: "ch_kendt1", payment_intent: "pi_kendt1", metadata: {}, created: sek() },
  ];
  stripeData.transfers = [
    { id: "tr_kendt1", amount: 9000, amount_reversed: 0, destination: "acct_egen1", source_transaction: "ch_kendt1", metadata: {}, livemode },
    { id: "tr_fremmed", amount: 4000, amount_reversed: 4000, destination: "acct_fremmed", source_transaction: "ch_fremmed1", metadata: {}, livemode },
    { id: "tr_egenkonto", amount: 2000, amount_reversed: 500, destination: "acct_egen1", source_transaction: null, metadata: {}, livemode },
  ];
  stripeData.disputes = [
    { id: "du_fremmed", amount: 10000, status: "needs_response", payment_intent: "pi_fremmed1", charge: "ch_fremmed1", metadata: {}, livemode },
    { id: "du_egen", amount: 10000, status: "needs_response", payment_intent: "pi_egenkonto", charge: "ch_egenkonto", metadata: {}, livemode },
  ];
}

const EGNE = [
  "ukendt-betaling:pi_egenkonto",
  "ukendt-betaling:pi_egenmeta",
  "ukendt-gebyr:fee_egenkonto",
  "refusion:re_udenom",
  "refusion-beloeb:ch_kendt1",
  "tilbagefoersel:tr_egenkonto",
  "indsigelse:du_egen",
].sort();
const FREMMEDE = [
  "ukendt-betaling:pi_fremmed1",
  "ukendt-gebyr:fee_fremmed",
  "refusion:re_fremmed",
  "tilbagefoersel:tr_fremmed",
  "indsigelse:du_fremmed",
].sort();

const noegleFoer = process.env.STRIPE_SECRET_KEY;
beforeEach(() => {
  registrerede.length = 0;
  alarmer.length = 0;
  driftFejl.length = 0;
});
afterEach(() => {
  process.env.STRIPE_SECRET_KEY = noegleFoer;
});

async function koer() {
  return koerPengeafstemning({ tving: true, startKl: Date.now(), budgetMs: 120_000 });
}

describe("afstemningen: fremmede testdata (delt Stripe-testkonto)", () => {
  it("TESTnøgle: kun denne databases objekter afstemmes; fremmede tælles og giver hverken afvigelse eller alarm", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_falsk";
    fyld(false);
    const r = await koer();
    expect(driftFejl).toEqual([]);
    expect(r.fejlede).toBe(0);
    expect(registrerede.map((x) => x.noegle).sort()).toEqual(EGNE);
    expect(r.fremmedeTestdata).toBe(FREMMEDE.length);
    for (const f of ["pi_fremmed1", "fee_fremmed", "re_fremmed", "tr_fremmed", "du_fremmed"]) {
      expect(alarmer.some((a) => a.includes(f))).toBe(false);
    }
    // De egne giver stadig alarm.
    expect(alarmer).toContain("ukendt-pi:pi_egenkonto");
    expect(alarmer).toContain("afstemning:ukendt-gebyr:fee_egenkonto");
  });

  it("LIVE-nøgle: alt ukendt er en afvigelse med alarm (uændret, fuldt strengt)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_falsk";
    fyld(true);
    const r = await koer();
    expect(driftFejl).toEqual([]);
    expect(registrerede.map((x) => x.noegle).sort()).toEqual([...EGNE, ...FREMMEDE].sort());
    expect(r.fremmedeTestdata).toBe(0);
    expect(alarmer).toContain("ukendt-pi:pi_fremmed1");
    expect(alarmer).toContain("afstemning:refusion:re_fremmed");
    expect(alarmer).toContain("indsigelse-ukendt:du_fremmed");
  });

  it("TESTnøgle, men objekter med livemode = true: aldrig fremmede", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_falsk";
    fyld(true);
    const r = await koer();
    // Refusioner har intet livemode-felt hos Stripe; re_fremmed arver
    // livemode fra sin PaymentIntent og er derfor heller ikke fremmed.
    expect(r.fremmedeTestdata).toBe(0);
    expect(registrerede.map((x) => x.noegle).sort()).toEqual([...EGNE, ...FREMMEDE].sort());
  });

  it("ingen gyldig nøgle: strengt", () => {
    const k = ingenKendte();
    expect(erFremmedTestdata(null, { livemode: false }, k)).toBe(false);
    expect(erFremmedTestdata("live", { livemode: false }, k)).toBe(false);
    expect(erFremmedTestdata("test", { livemode: false }, k)).toBe(true);
    expect(erFremmedTestdata("test", {}, k)).toBe(true);
    expect(erFremmedTestdata("test", { livemode: true }, k)).toBe(false);
  });

  it("henvisninger: betaling, udbetaling, PaymentIntent, charge, konto og kunde tæller som kendt", () => {
    const k = ingenKendte();
    k.betalinger.add(B1);
    k.udbetalinger.add("u1");
    k.pis.add("pi_1");
    k.charges.add("ch_1");
    k.konti.add("acct_1");
    k.kunder.add("cus_1");
    for (const h of [{ betalinger: [B1] }, { udbetalinger: ["u1"] }, { pis: ["pi_1"] }, { charges: ["ch_1"] }, { konti: [null, "acct_1"] }, { kunder: ["cus_1"] }]) {
      expect(henviserTilKendt(h, k)).toBe(true);
      expect(erFremmedTestdata("test", h, k)).toBe(false);
    }
    expect(henviserTilKendt({ betalinger: [FREMMED_BETALING], konti: ["acct_x"], pis: [undefined] }, k)).toBe(false);
  });
});

// ------------------------------------------------------------- webhooken

describe("webhooken: fremmede testdata giver ingen alarm (kun i testtilstand)", () => {
  const urlFoer = process.env.NEXT_PUBLIC_SUPABASE_URL;
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://lkifkrexeldimmghnsie.supabase.co";
    fyld(false);
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = urlFoer;
  });
  const pi = (md: Record<string, string>, dest: string | null, livemode = false) =>
    ({ id: "pi_x1", livemode, metadata: md, customer: null, latest_charge: "ch_x1", transfer_data: dest ? { destination: dest } : null, on_behalf_of: null }) as never;

  it("projekt-ref fra NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(egenDatabase("https://pjiigmzqwlfepxnjdvug.supabase.co")).toBe("pjiigmzqwlfepxnjdvug");
    expect(egenDatabase("https://example.com")).toBeNull();
    expect(egenDatabase("")).toBeNull();
  });

  it("metadata bidhamr_db afgør: egen database = vores, anden = fremmed; live = altid vores", () => {
    const k = ingenKendte("lkifkrexeldimmghnsie");
    expect(erFremmedTestdata("test", { bidhamrDb: "pjiigmzqwlfepxnjdvug" }, k)).toBe(true);
    expect(erFremmedTestdata("test", { bidhamrDb: "lkifkrexeldimmghnsie" }, k)).toBe(false);
    expect(erFremmedTestdata("live", { bidhamrDb: "pjiigmzqwlfepxnjdvug" }, k)).toBe(false);
  });

  it("TESTnøgle: anden databases PaymentIntent er fremmed; en med vores betaling eller konto er ikke", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_falsk";
    expect(await erFremmedTestobjekt(piHenvisning(pi({ betaling_id: FREMMED_BETALING }, "acct_fremmed")))).toBe(true);
    expect(await erFremmedTestobjekt(piHenvisning(pi({ betaling_id: FREMMED_BETALING, bidhamr_db: "pjiigmzqwlfepxnjdvug" }, null)))).toBe(true);
    expect(await erFremmedTestobjekt(piHenvisning(pi({ betaling_id: B1 }, "acct_fremmed")))).toBe(false);
    expect(await erFremmedTestobjekt(piHenvisning(pi({}, "acct_egen1")))).toBe(false);
    expect(await erFremmedTestobjekt(piHenvisning(pi({ bidhamr_db: "lkifkrexeldimmghnsie" }, "acct_fremmed")))).toBe(false);
    expect(await erFremmedTestobjekt(piHenvisning(pi({ betaling_id: FREMMED_BETALING }, "acct_fremmed", true)))).toBe(false);
  });

  it("LIVE-nøgle: aldrig fremmed (alarmen kommer som altid)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_falsk";
    expect(await erFremmedTestobjekt(piHenvisning(pi({ betaling_id: FREMMED_BETALING }, "acct_fremmed")))).toBe(false);
    expect(await erFremmedTestCharge({ id: "ch_fremmed1", payment_intent: "pi_fremmed1", livemode: false, metadata: {} } as never)).toBe(false);
  });

  it("charge og indsigelse: PaymentIntent hentes, og den anden databases charge er fremmed", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_falsk";
    const ch = (id: string, piId: string, dest: string) =>
      ({ id, payment_intent: piId, livemode: false, metadata: {}, customer: null, transfer_data: { destination: dest }, on_behalf_of: null }) as never;
    expect(await erFremmedTestCharge(ch("ch_fremmed1", "pi_fremmed1", "acct_fremmed"))).toBe(true);
    expect(await erFremmedTestCharge(ch("ch_egenkonto", "pi_egenkonto", "acct_egen1"))).toBe(false);
    // pi_egenmeta har vores betaling i metadata (men en fremmed konto).
    expect(await erFremmedTestCharge(ch("ch_egenmeta", "pi_egenmeta", "acct_fremmed"))).toBe(false);
  });
});

// ------------------------------------------------------------- lampen

describe("Test eller live-lampen følger Stripe-vagten", () => {
  const vagtGodkender = (n: "test" | "live", d: "test" | "live" | null) => d === n || (d === null && n === "test");

  it("aldrig rød, når kraevSammeStripeTilstand ville godkende - og altid rød, når den afviser", () => {
    for (const n of ["test", "live"] as const)
      for (const d of ["test", "live", null] as const)
        for (const testdb of [true, false]) {
          const l = stripeTilstandLampe(n, d, testdb)!;
          expect(l.tone === "roed").toBe(!vagtGodkender(n, d));
        }
  });

  it("teksterne", () => {
    expect(stripeTilstandLampe("test", "test", false)).toMatchObject({ tone: "blaa", tekst: "Stripe testmiljø (før lancering)" });
    expect(stripeTilstandLampe("test", "test", true)).toMatchObject({ tone: "blaa", tekst: "testnøgle + testdatabase" });
    expect(stripeTilstandLampe("live", "live", false)).toMatchObject({ tone: "groen" });
    expect(stripeTilstandLampe("live", "test", false)).toMatchObject({ tone: "roed", tekst: "Stripe-nøglen passer ikke til databasen" });
    expect(stripeTilstandLampe("test", "live", true)).toMatchObject({ tone: "roed" });
    expect(stripeTilstandLampe(null, "test", false)).toBeNull();
  });
});

// ------------------------------------------------------------- drift-grupper

describe("drift-fejl grupperes uden id'er", () => {
  const fejl = (ch: string) =>
    `betaling/afstemning: Pengeafstemning: Refusion [nøgle] på ${ch} er ikke registreret af BidHamr (lavet i Stripe-dashboardet, eller en ekstra refusion).`;

  it("ens fejl med hvert sit charge-id får samme gruppe", () => {
    const a = fejl("ch_3UPl1wCvpAH61Yvq0fTgNX7Z");
    const b = fejl("ch_3UPTUzCvpAH61Yvq1FAyhX0u");
    expect(fejlGruppeNoegle("cron", a)).toBe(fejlGruppeNoegle("cron", b));
    expect(fejlGruppeNoegle("cron", a)).not.toBe(fejlGruppeNoegle("webhook", a));
    expect(normaliserFejlbesked(a)).toEqual({ tekst: fejl("ch_…"), ids: ["ch_3UPl1wCvpAH61Yvq0fTgNX7Z"] });
  });

  it("alle Stripe-præfikser og uuid'er; almindelige ord røres ikke", () => {
    const t =
      "pi_3ULjcgCvpAH61Yvq1qdD3HJp re_3ABCdef12345 po_1Abcdefgh2 tr_1Xyzabcd9 fee_1Qwertyu7 dp_1Asdfghj3 du_1UOICZCvpAH61Yvq acct_1TfjCQ9PRzxEwkZ cus_Q1w2e3r4t5 in_1Zxcvbnm8 evt_1Poiuytr6 betaling 11111111-1111-4111-8111-0000000005E1 in_progress fee_refund";
    const n = normaliserFejlbesked(t);
    expect(n.tekst).toBe("pi_… re_… po_… tr_… fee_… dp_… du_… acct_… cus_… in_… evt_… betaling <uuid> in_progress fee_refund");
    expect(n.ids).toHaveLength(12);
    expect(n.ids).toContain("11111111-1111-4111-8111-0000000005e1");
  });

  it("højst 5 eksempler pr. gruppe", () => {
    const e: string[] = [];
    for (let i = 0; i < 20; i++) tilfoejEksempler(e, [`ch_${i}abcdefgh`]);
    tilfoejEksempler(e, ["ch_0abcdefgh"]);
    expect(MAKS_EKSEMPLER).toBe(5);
    expect(e).toHaveLength(5);
  });
});
