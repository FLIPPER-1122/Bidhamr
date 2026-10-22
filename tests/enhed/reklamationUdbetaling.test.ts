// Enhedstest af chefens udbetaling af en reklamation
// (src/lib/reklamation/udbetaling.ts) med en falsk Stripe og en falsk
// database - ingen netværk. Databasens låse og tællere (bank_start, claim,
// udbetal_afvist) testes mod den rigtige testdatabase i
// tests/penge/18-reklamation-udbetaling.test.ts; her testes, at serveren
// reagerer rigtigt på svarene, også ved samtidige kald:
//   H1  payouten til banken tager aldrig andre penge (tilbageført/afvigende
//       transfer, saldoen skal dække handlerne + andre erstatninger)
//   M1  bank_start afgør nøglen (serveren sender ikke p_ny_noegle) - i_gang
//       stopper; samtidige kald giver én payout
//   M2  en anden live payout giver alarm
//   M3  findTransfer altid før transfers.create; frigiv sender forsøget
//   L1  cron'en frigør en claim uden transfer efter 24 timer
//   L2  findPayout matcher kun det aktuelle forsøg
import { beforeEach, describe, expect, it, vi } from "vitest";
import { falskKlient, type Forespoergsel, type Svar } from "./hjaelpere/falskSupabase";

const m = vi.hoisted(() => ({
  klient: null as unknown,
  stripe: null as unknown,
  alarm: vi.fn<(o: { noegle: string; fejl: string }) => Promise<boolean>>(async () => true),
  luk: vi.fn<(n: string) => Promise<void>>(async () => {}),
  log: vi.fn<(o: unknown) => Promise<void>>(async () => {}),
  skyldig: vi.fn(async () => 0),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => m.klient }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => m.stripe, StripeTilstandFejl: class extends Error {} }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: m.log }));
vi.mock("@/lib/betaling/driftTilfaelde", () => ({ alarmPrTilfaelde: m.alarm, lukTilfaelde: m.luk }));
vi.mock("@/lib/betaling/noedstop", () => ({ hentNoedstop: async () => ({ udbetalingerStoppet: false }) }));
vi.mock("@/lib/betaling/stripeBetaling", () => ({ markerUdbetalingskonto: vi.fn(async () => {}) }));
vi.mock("@/lib/betaling/udbetaling", () => ({
  skyldigOere: m.skyldig,
  dkk: (liste: { currency: string; amount: number; source_types?: { card?: number } }[] | undefined, kunKort: boolean) =>
    (liste ?? []).filter((x) => x.currency === "dkk").reduce((s, x) => s + (kunKort ? Number(x.source_types?.card ?? 0) : x.amount), 0),
}));

import {
  erAktuelPayout,
  udbetalReklamationTilBank,
  udbetalReklamationerTilBank,
  udfoerReklamationTransfer,
  type UdbetalClaim,
} from "@/lib/reklamation/udbetaling";
import { erDobbeltReklamationPayout } from "@/lib/reklamation/typer";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KONTO = "acct_saelger";
const BELOEB = 40_000;
const TR = "tr_reklamation1";

type Raekke = Record<string, unknown>;
let raekke: Raekke;
let andre: Raekke[];
let udbetalinger: Raekke[];
let rpcLog: { navn: string; args: Record<string, unknown> }[];
// bank_start som i databasen (rækken låses - JS er én tråd, så kaldene
// afvikles ét ad gangen ligesom under låsen).
function bankStart(): Svar {
  if (raekke.transfer_tilbagefoert_kl) return { data: { kode: "tilbagefoert" }, error: null };
  if (["oprettet", "paid", "canceled"].includes(String(raekke.bank_status))) return { data: { kode: "faerdig" }, error: null };
  const sidst = raekke.bank_sidst_sendt_kl ? Date.parse(String(raekke.bank_sidst_sendt_kl)) : 0;
  if (raekke.bank_status === "claimet" && Date.now() - sidst < 10 * 60_000) return { data: { kode: "i_gang" }, error: null };
  if (raekke.bank_status === "failed" || (raekke.bank_status === "claimet" && Date.now() - sidst > 23 * 3600_000)) {
    raekke.bank_forsoeg = Number(raekke.bank_forsoeg) + 1;
  }
  raekke.bank_status = "claimet";
  raekke.bank_sidst_sendt_kl = new Date().toISOString();
  return { data: { kode: "ok", konto: KONTO, beloeb_oere: BELOEB, forsoeg: raekke.bank_forsoeg }, error: null };
}

function rpc(navn: string, args: unknown): Svar {
  const a = args as Record<string, unknown>;
  rpcLog.push({ navn, args: a });
  switch (navn) {
    case "fragt_reklamation_bank_start":
      return bankStart();
    case "fragt_reklamation_bank_spejl": {
      raekke.bank_payout_id = a.p_payout;
      raekke.bank_status = a.p_status === "pending" ? "oprettet" : a.p_status;
      return { data: { kode: "ok", til: raekke.bank_status }, error: null };
    }
    case "fragt_reklamation_udbetal_registrer": {
      if (raekke.stripe_transfer_id) return { data: raekke.stripe_transfer_id === a.p_transfer ? "allerede" : "afviger", error: null };
      raekke.stripe_transfer_id = a.p_transfer;
      raekke.status = "udbetalt";
      return { data: "ok", error: null };
    }
    case "fragt_reklamation_udbetal_afvist": {
      if (a.p_frigiv && a.p_forsoeg !== raekke.udbetaling_forsoeg) return { data: false, error: null };
      if (a.p_frigiv) {
        raekke.udbetaling_paabegyndt_kl = null;
        raekke.udbetaling_forsoeg = Number(raekke.udbetaling_forsoeg) + 1;
      }
      return { data: true, error: null };
    }
    case "fragt_reklamation_transfer_tilbagefoert":
      raekke.transfer_tilbagefoert_kl = new Date().toISOString();
      return { data: ID, error: null };
    default:
      return { data: true, error: null };
  }
}

function handler(q: Forespoergsel): Svar {
  if (q.tabel === "betalingsprofiler") {
    return { data: { udbetaling_frosset_kl: null, stripe_account_id: KONTO, connect_frakoblet_kl: null }, error: null };
  }
  if (q.tabel === "saelger_udbetalinger") {
    // skalBliveOere: sælgerens claimede/usikre almindelige udbetalinger.
    const v = (f: string) => q.filtre.find((x) => x[0] === "eq" && x[1] === f)?.[2];
    const statusser = (q.filtre.find((x) => x[0] === "in" && x[1] === "status")?.[2] ?? []) as string[];
    return {
      data: udbetalinger.filter((u) => u.seller_id === v("seller_id") && u.stripe_konto === v("stripe_konto") && statusser.includes(String(u.status))),
      error: null,
    };
  }
  if (q.tabel !== "fragt_reklamationer") return { data: null, error: null };
  // skalBliveOere: andre erstatninger på kontoen.
  if (q.filtre.some((f) => f[0] === "neq")) return { data: andre, error: null };
  // Cron'ens lister.
  const status = q.filtre.find((f) => f[0] === "eq" && f[1] === "status")?.[2];
  if (q.filtre.some((f) => f[0] === "limit")) {
    if (status === "godkendt") return { data: raekke.status === "godkendt" ? [{ ...raekke }] : [], error: null };
    return { data: [], error: null };
  }
  return { data: { ...raekke }, error: null };
}

type FalskTransfer = { id: string; amount: number; amount_reversed: number; reversed: boolean; currency: string; destination: string; metadata: Record<string, string> };
let transfers: FalskTransfer[];
let payouts: { id: string; status: string; amount: number; metadata: Record<string, string>; destination: string | null; failure_code: null }[];
let saldo: { available: number; pending: number };

function falskStripe() {
  const noegler = new Map<string, unknown>();
  const idem = async <T>(noegle: string | undefined, lav: () => T): Promise<T> => {
    // Lidt ventetid, så samtidige kald faktisk overlapper.
    await new Promise((r) => setTimeout(r, 5));
    if (noegle && noegler.has(noegle)) return noegler.get(noegle) as T;
    const v = lav();
    if (noegle) noegler.set(noegle, v);
    return v;
  };
  return {
    transfers: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const t of [...transfers]) yield t;
        },
      }),
      retrieve: vi.fn(async (id: string) => transfers.find((t) => t.id === id)),
      create: vi.fn(async (p: { amount: number; destination: string; metadata: Record<string, string> }, o: { idempotencyKey?: string }) =>
        idem(o.idempotencyKey, () => {
          const t = { id: `tr_${transfers.length + 1}`, amount: p.amount, amount_reversed: 0, reversed: false, currency: "dkk", destination: p.destination, metadata: p.metadata };
          transfers.push(t);
          return t;
        }),
      ),
    },
    payouts: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const p of [...payouts]) yield p;
        },
      }),
      create: vi.fn(async (p: { amount: number; metadata: Record<string, string> }, o: { idempotencyKey?: string }) =>
        idem(o.idempotencyKey, () => {
          const po = { id: `po_${payouts.length + 1}`, status: "pending", amount: p.amount, metadata: p.metadata, destination: null, failure_code: null as null };
          payouts.push(po);
          return po;
        }),
      ),
    },
    accounts: {
      retrieve: async () => ({ capabilities: { transfers: "active" }, payouts_enabled: true, settings: { payouts: { schedule: { interval: "manual" } } } }),
    },
    balance: {
      retrieve: async (_p: unknown, o?: { stripeAccount?: string }) =>
        o?.stripeAccount
          ? {
              available: [{ currency: "dkk", amount: saldo.available, source_types: { card: saldo.available } }],
              pending: [{ currency: "dkk", amount: saldo.pending }],
            }
          : { available: [{ currency: "dkk", amount: 10_000_000, source_types: { card: 10_000_000 } }], pending: [] },
    },
  };
}

type FS = ReturnType<typeof falskStripe>;
const S = () => m.stripe as FS;

beforeEach(() => {
  vi.clearAllMocks();
  rpcLog = [];
  andre = [];
  udbetalinger = [];
  transfers = [];
  payouts = [];
  saldo = { available: BELOEB, pending: 0 };
  m.skyldig.mockResolvedValue(0);
  m.stripe = falskStripe();
  const { klient } = falskKlient(handler, rpc);
  m.klient = klient;
});

function udbetaltRaekke(o: Raekke = {}): Raekke {
  return {
    id: ID,
    status: "udbetalt",
    trade_id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
    saelger_id: "ssssssss-ssss-4sss-8sss-ssssssssssss",
    godkendt_beloeb_oere: BELOEB,
    stripe_transfer_id: TR,
    udbetaling_stripe_konto: KONTO,
    udbetalt_kl: new Date().toISOString(),
    transfer_tilbagefoert_kl: null,
    bank_status: null,
    bank_payout_id: null,
    bank_forsoeg: 0,
    bank_claimet_kl: null,
    bank_sidst_sendt_kl: null,
    ...o,
  };
}

function rigtigTransfer(o: Partial<FalskTransfer> = {}): FalskTransfer {
  return { id: TR, amount: BELOEB, amount_reversed: 0, reversed: false, currency: "dkk", destination: KONTO, metadata: { type: "reklamation", reklamation_id: ID }, ...o };
}

describe("H1: payouten til banken tager aldrig andre penge", () => {
  it.each([
    ["helt tilbageført", { reversed: true, amount_reversed: BELOEB }],
    ["delvist tilbageført", { amount_reversed: 1 }],
    ["andet beløb", { amount: BELOEB + 1 }],
    ["anden konto", { destination: "acct_anden" }],
  ])("transferen er %s: markeres, alarm, ingen payout", async (_navn, afvig) => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer(afvig)];
    expect(await udbetalReklamationTilBank(ID)).toBe("tilbagefoert");
    expect(S().payouts.create).not.toHaveBeenCalled();
    expect(rpcLog.some((r) => r.navn === "fragt_reklamation_bank_start")).toBe(false);
    const mark = rpcLog.find((r) => r.navn === "fragt_reklamation_transfer_tilbagefoert");
    expect(mark?.args).toMatchObject({ p_transfer: TR });
    expect(String(mark?.args.p_grund)).not.toBe("");
    expect(m.alarm).toHaveBeenCalledWith(expect.objectContaining({ noegle: `reklamation-transfer-tilbagefoert:${TR}` }));
    // Bagefter stopper både serveren og databasen.
    expect(await udbetalReklamationTilBank(ID)).toBe("tilbagefoert");
    expect(S().payouts.create).not.toHaveBeenCalled();
  });

  it("markeret som tilbageført i databasen: ingen Stripe-kald", async () => {
    raekke = udbetaltRaekke({ transfer_tilbagefoert_kl: new Date().toISOString() });
    transfers = [rigtigTransfer()];
    expect(await udbetalReklamationTilBank(ID)).toBe("tilbagefoert");
    expect(S().transfers.retrieve).not.toHaveBeenCalled();
    expect(S().payouts.create).not.toHaveBeenCalled();
  });

  it("saldoen dækker ikke erstatningen + sælgerens handler: ingen payout, alarm", async () => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer()];
    saldo = { available: BELOEB + 10_000, pending: 20_000 };
    m.skyldig.mockResolvedValue(30_001); // 70.000 - 40.000 = 30.000 < 30.001
    expect(await udbetalReklamationTilBank(ID)).toBe("saldo_afviger");
    expect(S().payouts.create).not.toHaveBeenCalled();
    expect(rpcLog.some((r) => r.navn === "fragt_reklamation_bank_start")).toBe(false);
    expect(m.alarm).toHaveBeenCalledWith(expect.objectContaining({ noegle: `reklamation-bank-skyldig:${ID}` }));
  });

  it("andre erstatninger, der endnu ikke er sendt til banken, tæller med", async () => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer()];
    saldo = { available: BELOEB * 2 - 1, pending: 0 };
    andre = [
      { id: "x", godkendt_beloeb_oere: BELOEB, bank_status: "failed" },
      { id: "y", godkendt_beloeb_oere: 99_999, bank_status: "paid" }, // allerede ude af kontoen
    ];
    expect(await udbetalReklamationTilBank(ID)).toBe("saldo_afviger");
    expect(S().payouts.create).not.toHaveBeenCalled();
  });

  it("sælgerens claimede/usikre almindelige udbetalinger på kontoen tæller med", async () => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer()];
    const saelger = String(raekke.saelger_id);
    saldo = { available: BELOEB + 30_000 - 1, pending: 0 };
    udbetalinger = [
      { id: "u1", seller_id: saelger, stripe_konto: KONTO, status: "claimet", beloeb_oere: 20_000 },
      { id: "u2", seller_id: saelger, stripe_konto: KONTO, status: "usikker", beloeb_oere: 10_000 },
      // Tæller ikke: allerede ude af kontoen / anden konto / anden sælger.
      { id: "u3", seller_id: saelger, stripe_konto: KONTO, status: "oprettet", beloeb_oere: 99_999 },
      { id: "u4", seller_id: saelger, stripe_konto: KONTO, status: "paid", beloeb_oere: 99_999 },
      { id: "u5", seller_id: saelger, stripe_konto: "acct_anden", status: "claimet", beloeb_oere: 99_999 },
      { id: "u6", seller_id: "anden-saelger", stripe_konto: KONTO, status: "claimet", beloeb_oere: 99_999 },
    ];
    expect(await udbetalReklamationTilBank(ID)).toBe("saldo_afviger");
    expect(S().payouts.create).not.toHaveBeenCalled();
    expect(m.alarm).toHaveBeenCalledWith(expect.objectContaining({ noegle: `reklamation-bank-skyldig:${ID}` }));
    // Med én øre mere dækker saldoen præcis: payout.
    saldo = { available: BELOEB + 30_000, pending: 0 };
    expect(await udbetalReklamationTilBank(ID)).toBe("oprettet");
    expect(S().payouts.create).toHaveBeenCalledTimes(1);
  });

  it("præcis dækket: payout med det godkendte beløb og forsøget i metadata", async () => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer()];
    saldo = { available: BELOEB + 30_000, pending: 0 };
    m.skyldig.mockResolvedValue(30_000);
    expect(await udbetalReklamationTilBank(ID)).toBe("oprettet");
    expect(S().payouts.create).toHaveBeenCalledTimes(1);
    const [p, o] = S().payouts.create.mock.calls[0];
    expect(p).toMatchObject({ amount: BELOEB, metadata: { type: "reklamation", reklamation_id: ID, bank_forsoeg: "0" } });
    expect(o).toMatchObject({ stripeAccount: KONTO, idempotencyKey: `bidhamr-reklamation-payout-${ID}-0` });
    expect(m.luk).toHaveBeenCalledWith(`reklamation-bank-skyldig:${ID}`);
  });
});

describe("M1: databasen afgør nøglen; samtidige kald giver én payout", () => {
  it("serveren sender ikke selv en nøgle-beslutning til bank_start", async () => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer()];
    await udbetalReklamationTilBank(ID);
    const start = rpcLog.find((r) => r.navn === "fragt_reklamation_bank_start");
    expect(start?.args).toEqual({ p_reklamation: ID });
  });

  it("claimet for under 10 minutter siden: i_gang, intet hos Stripe", async () => {
    raekke = udbetaltRaekke({ bank_status: "claimet", bank_claimet_kl: new Date().toISOString(), bank_sidst_sendt_kl: new Date().toISOString() });
    transfers = [rigtigTransfer()];
    expect(await udbetalReklamationTilBank(ID)).toBe("i_gang");
    expect(S().payouts.create).not.toHaveBeenCalled();
  });

  it("to samtidige kald: én payout", async () => {
    raekke = udbetaltRaekke();
    transfers = [rigtigTransfer()];
    const res = await Promise.all([udbetalReklamationTilBank(ID), udbetalReklamationTilBank(ID), udbetalReklamationTilBank(ID)]);
    expect(res.filter((x) => x === "oprettet")).toHaveLength(1);
    for (const x of res) expect(["oprettet", "i_gang", "faerdig"]).toContain(x);
    expect(payouts).toHaveLength(1);
  });

  it("claimet over 23 timer uden payout hos Stripe: nyt forsøg (ny nøgle), én payout", async () => {
    const gammel = new Date(Date.now() - 24 * 3600_000).toISOString();
    raekke = udbetaltRaekke({ bank_status: "claimet", bank_claimet_kl: gammel, bank_sidst_sendt_kl: gammel });
    transfers = [rigtigTransfer()];
    expect(await udbetalReklamationTilBank(ID)).toBe("oprettet");
    expect(S().payouts.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `bidhamr-reklamation-payout-${ID}-1` });
  });
});

describe("L2: findPayout matcher kun det aktuelle forsøg", () => {
  const r = { id: ID, bank_payout_id: "po_gammel", bank_forsoeg: 1 };
  const md = (o: Record<string, string> = {}) => ({ type: "reklamation", reklamation_id: ID, ...o });
  it("bank_forsoeg i metadata skal være det aktuelle", () => {
    expect(erAktuelPayout(r, { id: "po_ny", status: "pending", metadata: md({ bank_forsoeg: "1" }) })).toBe(true);
    expect(erAktuelPayout(r, { id: "po_ny", status: "pending", metadata: md({ bank_forsoeg: "0" }) })).toBe(false);
  });
  it("uden bank_forsoeg (ældre kode): ikke den kendte, ikke fejlet/annulleret", () => {
    expect(erAktuelPayout(r, { id: "po_gammel", status: "pending", metadata: md() })).toBe(false);
    expect(erAktuelPayout(r, { id: "po_x", status: "failed", metadata: md() })).toBe(false);
    expect(erAktuelPayout(r, { id: "po_x", status: "canceled", metadata: md() })).toBe(false);
    expect(erAktuelPayout(r, { id: "po_x", status: "in_transit", metadata: md() })).toBe(true);
  });
  it("en anden reklamation eller type tæller aldrig", () => {
    expect(erAktuelPayout(r, { id: "po_x", status: "pending", metadata: { type: "reklamation", reklamation_id: "andet", bank_forsoeg: "1" } })).toBe(false);
    expect(erAktuelPayout(r, { id: "po_x", status: "pending", metadata: { reklamation_id: ID, bank_forsoeg: "1" } })).toBe(false);
  });
  it("en ældre, fejlet payout får ikke et nyt forsøg til at se afsluttet ud", async () => {
    const for11 = new Date(Date.now() - 11 * 60_000).toISOString();
    raekke = udbetaltRaekke({ bank_status: "claimet", bank_forsoeg: 1, bank_payout_id: "po_gammel", bank_claimet_kl: for11, bank_sidst_sendt_kl: for11 });
    transfers = [rigtigTransfer()];
    payouts = [{ id: "po_gammel", status: "failed", amount: BELOEB, metadata: md({ bank_forsoeg: "0" }), destination: null, failure_code: null }];
    expect(await udbetalReklamationTilBank(ID)).toBe("oprettet");
    expect(S().payouts.create).toHaveBeenCalledTimes(1);
    expect(S().payouts.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `bidhamr-reklamation-payout-${ID}-1` });
  });
});

describe("M2: en anden live payout = måske sendt to gange", () => {
  const p = (o: { id?: string; status?: string; bank_forsoeg?: string } = {}) => ({
    id: o.id ?? "po_anden",
    status: o.status ?? "pending",
    metadata: { type: "reklamation", reklamation_id: ID, ...(o.bank_forsoeg ? { bank_forsoeg: o.bank_forsoeg } : {}) },
  });
  it("aktuel payout i live + en anden i live: dobbelt", () => {
    expect(erDobbeltReklamationPayout({ bank_payout_id: "po_1", bank_status: "paid", bank_forsoeg: 0 }, p())).toBe(true);
    expect(erDobbeltReklamationPayout({ bank_payout_id: "po_1", bank_status: "oprettet", bank_forsoeg: 0 }, p({ status: "in_transit" }))).toBe(true);
  });
  it("den aktuelle selv, eller en fejlet/annulleret: ikke dobbelt", () => {
    expect(erDobbeltReklamationPayout({ bank_payout_id: "po_anden", bank_status: "paid", bank_forsoeg: 0 }, p())).toBe(false);
    expect(erDobbeltReklamationPayout({ bank_payout_id: "po_1", bank_status: "paid", bank_forsoeg: 0 }, p({ status: "failed" }))).toBe(false);
    expect(erDobbeltReklamationPayout({ bank_payout_id: "po_1", bank_status: "paid", bank_forsoeg: 0 }, p({ status: "canceled" }))).toBe(false);
  });
  it("nyt forsøg i gang: dets egen payout er ikke dobbelt, et ældre forsøgs live payout er", () => {
    const r = { bank_payout_id: "po_fejlet", bank_status: "claimet" as const, bank_forsoeg: 2 };
    expect(erDobbeltReklamationPayout(r, p({ bank_forsoeg: "2" }))).toBe(false);
    expect(erDobbeltReklamationPayout(r, p({ bank_forsoeg: "1" }))).toBe(true);
  });
});

function claimRaekke(o: Raekke = {}): Raekke {
  return {
    id: ID,
    status: "godkendt",
    trade_id: "tttttttt-tttt-4ttt-8ttt-tttttttttttt",
    sag_id: "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
    saelger_id: "ssssssss-ssss-4sss-8sss-ssssssssssss",
    godkendt_beloeb_oere: BELOEB,
    udbetaling_stripe_konto: KONTO,
    udbetaling_paabegyndt_kl: new Date().toISOString(),
    udbetaling_sidst_sendt_kl: new Date().toISOString(),
    udbetaling_forsoeg: 2,
    stripe_transfer_id: null,
    oprettet_kl: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    transportoerens_sagsnummer: "DAO-1",
    transportoer: "dao",
    ...o,
  };
}

function claim(o: Partial<UdbetalClaim> = {}): UdbetalClaim {
  return {
    beloeb_oere: BELOEB,
    konto: KONTO,
    forsoeg: 2,
    trade_id: String(raekke.trade_id),
    sag_id: String(raekke.sag_id),
    saelger_id: String(raekke.saelger_id),
    sagsnummer: "DAO-1",
    transportoer: "dao",
    genoptag: false,
    paabegyndt_kl: String(raekke.udbetaling_paabegyndt_kl),
    oprettet_kl: String(raekke.oprettet_kl),
    ...o,
  };
}

describe("M3: transfer-claimen", () => {
  it("frisk claim: en eksisterende transfer (metadata) registreres - aldrig en ny", async () => {
    raekke = claimRaekke();
    transfers = [rigtigTransfer()];
    expect(await udfoerReklamationTransfer(ID, claim())).toBe("udbetalt");
    expect(S().transfers.create).not.toHaveBeenCalled();
    expect(raekke.stripe_transfer_id).toBe(TR);
  });

  it("frisk claim uden tidligere transfer: én transfer med forsøgets nøgle", async () => {
    raekke = claimRaekke();
    expect(await udfoerReklamationTransfer(ID, claim())).toBe("udbetalt");
    expect(S().transfers.create).toHaveBeenCalledTimes(1);
    expect(S().transfers.create.mock.calls[0][1]).toMatchObject({ idempotencyKey: `bidhamr-reklamation-transfer-${ID}-2` });
  });

  it("en afvigende transfer (anden konto) registreres ikke; én alarm pr. reklamation", async () => {
    raekke = claimRaekke();
    transfers = [rigtigTransfer({ destination: "acct_anden" })];
    expect(await udfoerReklamationTransfer(ID, claim())).toBe("afviger");
    expect(await udfoerReklamationTransfer(ID, claim())).toBe("afviger");
    expect(S().transfers.create).not.toHaveBeenCalled();
    expect(raekke.stripe_transfer_id ?? null).toBeNull();
    const noegler = m.alarm.mock.calls.map((c) => c[0].noegle);
    expect(noegler.filter((n) => n === `reklamation-transfer-afviger:${ID}`)).toHaveLength(2);
    expect(m.log).not.toHaveBeenCalled();
  });

  it("samtidige kald med samme claim: én transfer", async () => {
    raekke = claimRaekke();
    const res = await Promise.all([udfoerReklamationTransfer(ID, claim()), udfoerReklamationTransfer(ID, claim()), udfoerReklamationTransfer(ID, claim({ genoptag: true }))]);
    for (const x of res) expect(x).toBe("udbetalt");
    expect(transfers).toHaveLength(1);
  });

  it("frigiv sender forsøget; et forsinket svar fra et ældre forsøg frigør ikke", async () => {
    raekke = claimRaekke();
    S().transfers.create.mockRejectedValueOnce(
      new (await import("stripe")).default.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "nej", code: "x" } as never),
    );
    expect(await udfoerReklamationTransfer(ID, claim({ forsoeg: 1 }))).toBe("afvist");
    const frigiv = rpcLog.find((r) => r.navn === "fragt_reklamation_udbetal_afvist");
    expect(frigiv?.args).toMatchObject({ p_frigiv: true, p_forsoeg: 1 });
    // Databasen afviste (forsøg 1 er ikke det aktuelle 2): claimen er urørt.
    expect(raekke.udbetaling_paabegyndt_kl).not.toBeNull();
    expect(raekke.udbetaling_forsoeg).toBe(2);
  });
});

describe("L1: cron'en frigør en fastlåst claim", () => {
  it("ingen transfer hos Stripe og nøglen over 24 timer gammel: frigøres med forsøget", async () => {
    const gammel = new Date(Date.now() - 25 * 3600_000).toISOString();
    raekke = claimRaekke({ udbetaling_paabegyndt_kl: gammel, udbetaling_sidst_sendt_kl: gammel });
    await udbetalReklamationerTilBank();
    const frigiv = rpcLog.find((r) => r.navn === "fragt_reklamation_udbetal_afvist");
    expect(frigiv?.args).toMatchObject({ p_reklamation: ID, p_frigiv: true, p_forsoeg: 2 });
    expect(raekke.udbetaling_paabegyndt_kl).toBeNull();
    expect(S().transfers.create).not.toHaveBeenCalled();
    expect(m.log).toHaveBeenCalled();
  });

  it("under 24 timer: kun alarm, claimen beholdes", async () => {
    const for2t = new Date(Date.now() - 2 * 3600_000).toISOString();
    raekke = claimRaekke({ udbetaling_paabegyndt_kl: for2t, udbetaling_sidst_sendt_kl: for2t });
    await udbetalReklamationerTilBank();
    expect(rpcLog.some((r) => r.navn === "fragt_reklamation_udbetal_afvist")).toBe(false);
    expect(m.alarm).toHaveBeenCalledWith(expect.objectContaining({ noegle: `reklamation-transfer-haenger:${ID}` }));
  });

  it("genoptaget for under 10 minutter siden: røres ikke (kaldet kan være i gang)", async () => {
    raekke = claimRaekke({
      udbetaling_paabegyndt_kl: new Date(Date.now() - 25 * 3600_000).toISOString(),
      udbetaling_sidst_sendt_kl: new Date().toISOString(),
    });
    await udbetalReklamationerTilBank();
    expect(rpcLog.some((r) => r.navn === "fragt_reklamation_udbetal_afvist")).toBe(false);
  });

  it("transferen findes: registreres i stedet", async () => {
    const gammel = new Date(Date.now() - 25 * 3600_000).toISOString();
    raekke = claimRaekke({ udbetaling_paabegyndt_kl: gammel, udbetaling_sidst_sendt_kl: gammel });
    transfers = [rigtigTransfer()];
    await udbetalReklamationerTilBank();
    expect(raekke.stripe_transfer_id).toBe(TR);
    expect(rpcLog.some((r) => r.navn === "fragt_reklamation_udbetal_afvist")).toBe(false);
  });
});
