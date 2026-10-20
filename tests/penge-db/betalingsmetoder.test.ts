// Betalingsmetoder (Filip, 20. okt. 2026): boost og returfragt laver
// PaymentIntents med PRÆCIS kort, MobilePay og Revolut Pay - aldrig
// automatic_payment_methods (Klarna, Link). En åben, gammel PaymentIntent med
// automatic_payment_methods annulleres og laves om med en ny idempotency key.
// Ingen database og intet netværk: koden køres mod en falsk Stripe og en
// falsk database i hukommelsen.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------- falsk Stripe

type Pi = {
  id: string;
  status: string;
  amount: number;
  customer: string;
  client_secret: string;
  metadata: Record<string, string>;
  payment_method_types: string[];
  automatic_payment_methods: { enabled: boolean } | null;
  payment_method_options: { card?: { request_three_d_secure?: string } };
  latest_charge: null;
  last_payment_error: null;
  amount_received: number;
};

const pis = new Map<string, Pi>();
const kald: { navn: string; params?: Record<string, unknown>; noegle?: string; id?: string }[] = [];
const brugteNoegler = new Map<string, string>(); // nøgle -> JSON af parametrene
let n = 0;

function nyPi(params: Record<string, unknown>): Pi {
  const id = `pi_test_${++n}`;
  const pi: Pi = {
    id,
    status: "requires_payment_method",
    amount: Number(params.amount),
    customer: String(params.customer),
    client_secret: `${id}_secret_x`,
    metadata: (params.metadata as Record<string, string>) ?? {},
    payment_method_types: params.automatic_payment_methods
      ? ["card", "klarna", "link", "mobilepay"]
      : ((params.payment_method_types as string[]) ?? []),
    automatic_payment_methods: params.automatic_payment_methods ? { enabled: true } : null,
    payment_method_options: (params.payment_method_options as Pi["payment_method_options"]) ?? {},
    latest_charge: null,
    last_payment_error: null,
    amount_received: 0,
  };
  pis.set(id, pi);
  return pi;
}

// Platformens standard-konfiguration (hvad der er slået til hos Stripe).
const platform: Record<string, { available: boolean }> = {};
// Simulerer en webhook (payment_intent.canceled), der nulstiller rækken,
// mens BidHamr annullerer.
let webhookVedAnnullering: (() => void) | null = null;
const ekstraKonfigurationer: Record<string, unknown>[] = [];
let konfigurationFejler = false;

const falskStripe = {
  paymentMethodConfigurations: {
    list: async () => {
      if (konfigurationFejler) throw new Error("Stripe svarer ikke");
      return {
      data: [
        { id: "pmc_barn", is_default: false, parent: "pmc_x", application: null, mobilepay: { available: true } },
        { id: "pmc_std", is_default: true, parent: null, application: null, ...platform },
        ...ekstraKonfigurationer,
      ],
      has_more: false,
      };
    },
  },
  paymentIntents: {
    create: async (params: Record<string, unknown>, opt?: { idempotencyKey?: string }) => {
      kald.push({ navn: "create", params, noegle: opt?.idempotencyKey });
      const json = JSON.stringify(params);
      if (opt?.idempotencyKey && brugteNoegler.has(opt.idempotencyKey) && brugteNoegler.get(opt.idempotencyKey) !== json) {
        throw new Error("Keys for idempotent requests can only be used with the same parameters");
      }
      if (opt?.idempotencyKey) brugteNoegler.set(opt.idempotencyKey, json);
      if (params.automatic_payment_methods && params.payment_method_types) {
        throw new Error("You cannot provide both `automatic_payment_methods` and `payment_method_types`.");
      }
      return { ...nyPi(params) };
    },
    retrieve: async (id: string) => {
      const pi = pis.get(id);
      if (!pi) throw new Error(`ukendt ${id}`);
      return { ...pi };
    },
    update: async (id: string, params: Record<string, unknown>) => {
      kald.push({ navn: "update", params, id });
      const pi = pis.get(id)!;
      // Som Stripe (verificeret 20. okt. 2026): en PaymentIntent med
      // automatic_payment_methods kan ikke få en eksplicit liste.
      if (pi.automatic_payment_methods?.enabled && params.payment_method_types) {
        throw new Error("You cannot provide both `automatic_payment_methods` and `payment_method_types`.");
      }
      if (params.payment_method_types) pi.payment_method_types = params.payment_method_types as string[];
      if (params.amount) pi.amount = Number(params.amount);
      if (params.payment_method_options) pi.payment_method_options = params.payment_method_options as Pi["payment_method_options"];
      if (params.metadata) pi.metadata = { ...pi.metadata, ...(params.metadata as Record<string, string>) };
      return { ...pi };
    },
    cancel: async (id: string, _p?: unknown, opt?: { idempotencyKey?: string }) => {
      kald.push({ navn: "cancel", id, noegle: opt?.idempotencyKey });
      const pi = pis.get(id)!;
      if (pi.status === "succeeded") throw new Error("kan ikke annulleres");
      pi.status = "canceled";
      webhookVedAnnullering?.();
      return { ...pi };
    },
  },
};

// ------------------------------------------------------------- falsk database

type Raekke = Record<string, unknown>;
const tabeller: Record<string, Raekke[]> = { boost_koeb: [], returfragt_betalinger: [] };

class Q implements PromiseLike<{ data: unknown; error: null }> {
  private filtre: ((r: Raekke) => boolean)[] = [];
  private enkelt = false;
  constructor(private tabel: string) {}
  select() {
    return this;
  }
  eq(k: string, v: unknown) {
    this.filtre.push((r) => r[k] === v);
    return this;
  }
  in(k: string, v: unknown[]) {
    this.filtre.push((r) => v.includes(r[k]));
    return this;
  }
  maybeSingle() {
    this.enkelt = true;
    return this;
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, fejl?: ((e: unknown) => B | PromiseLike<B>) | null) {
    const ud = (tabeller[this.tabel] ?? []).filter((r) => this.filtre.every((f) => f(r))).map((r) => ({ ...r }));
    return Promise.resolve({ data: this.enkelt ? (ud[0] ?? null) : ud, error: null }).then(ok, fejl);
  }
}

function raekke(tabel: string, id: unknown): Raekke {
  return tabeller[tabel].find((r) => r.id === id)!;
}

const falskAdmin = {
  from: (t: string) => new Q(t),
  rpc: async (navn: string, a: Record<string, unknown>) => {
    if (navn === "boost_koeb_start") return { data: { kode: "findes", id: "koeb-1", pakke: "p100" }, error: null };
    if (navn === "returfragt_start") return { data: { kode: "findes", id: "rf-1" }, error: null };
    const tabel = navn.startsWith("boost") ? "boost_koeb" : "returfragt_betalinger";
    const r = raekke(tabel, a.p_id);
    if (navn.endsWith("_gem_pi")) {
      if (r.stripe_payment_intent_id || r.pi_forsoeg !== a.p_forsoeg) return { data: navn.startsWith("boost") ? "aendret" : false, error: null };
      r.stripe_payment_intent_id = a.p_pi;
      return { data: navn.startsWith("boost") ? "ok" : true, error: null };
    }
    if (navn.endsWith("_nulstil_pi")) {
      if (r.stripe_payment_intent_id !== a.p_pi || r.status !== "afventer") return { data: false, error: null };
      r.stripe_payment_intent_id = null;
      r.pi_forsoeg = Number(r.pi_forsoeg) + 1;
      return { data: true, error: null };
    }
    if (navn === "boost_koeb_registrer" || navn === "returfragt_registrer") return { data: { kode: "uaendret" }, error: null };
    throw new Error(`ukendt rpc ${navn}`);
  },
};

// ------------------------------------------------------------- mocks

class StripeTilstandFejl extends Error {}
vi.mock("@/lib/stripe", () => ({
  getStripe: () => falskStripe,
  kraevSammeOffentligeNoegle: async () => {},
  StripeTilstandFejl,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => falskAdmin }));
vi.mock("@/lib/betaling/noedstop", () => ({
  hentNoedstop: async () => ({ nyeBetalingerStoppet: false }),
  NYE_BETALINGER_STOPPET_TEKST: "pause",
}));
vi.mock("@/lib/betaling/stripeBetaling", () => ({
  kundeSessionTilCheckout: async () => null,
  sikrStripeKunde: async () => "cus_test",
}));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: async (x: unknown) => {
    throw new Error(`uventet drift-fejl: ${JSON.stringify(x)}`);
  },
  renFejltekst: (x: unknown) => String(x),
}));
const alarmer: string[] = [];
const lukket: string[] = [];
vi.mock("@/lib/betaling/driftTilfaelde", () => ({
  alarmPrTilfaelde: async (o: { noegle: string }) => {
    alarmer.push(o.noegle);
    return true;
  },
  lukTilfaelde: async (n: string) => {
    lukket.push(n);
  },
}));
vi.mock("@/lib/betaling/fremmedeTestdata", () => ({ egenDatabase: () => "testdb" }));
vi.mock("@/lib/fragt", () => ({ fragtReturlabelAktiv: () => true }));
vi.mock("@/lib/fragt/server", () => ({
  opretReturForsendelse: async () => {},
  RETUR_I_GANG_TEKST: "",
  valideerAdresse: () => null,
}));
vi.mock("@/lib/notifikationer/send", () => ({ send: async () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const { startBoostKoeb } = await import("@/lib/betaling/boost");
const { startReturfragtBetaling } = await import("@/lib/betaling/returfragt");
const { BETALINGSMETODER } = await import("@/lib/betaling/betalingsmetoder");
const { nulstilPlatformMetoderCache } = await import("@/lib/betaling/platformMetoder");

const TILLADTE = ["card", "mobilepay", "revolut_pay"];

beforeEach(() => {
  nulstilPlatformMetoderCache();
  for (const k of Object.keys(platform)) delete platform[k];
  Object.assign(platform, {
    card: { available: true },
    mobilepay: { available: true },
    revolut_pay: { available: true },
    klarna: { available: true },
    link: { available: true },
  });
  webhookVedAnnullering = null;
  ekstraKonfigurationer.length = 0;
  konfigurationFejler = false;
  alarmer.length = 0;
  lukket.length = 0;
  pis.clear();
  kald.length = 0;
  brugteNoegler.clear();
  tabeller.boost_koeb = [
    { id: "koeb-1", bruger_id: "bruger-1", point: 100, beloeb_oere: 3900, status: "afventer", stripe_payment_intent_id: null, pi_forsoeg: 0 },
  ];
  tabeller.returfragt_betalinger = [
    {
      id: "rf-1",
      trade_id: "handel-1",
      sag_id: "sag-1",
      koeber_id: "bruger-1",
      beloeb_oere: 4900,
      status: "afventer",
      stripe_payment_intent_id: null,
      pi_forsoeg: 0,
    },
  ];
});

const flows = [
  { navn: "boost", tabel: "boost_koeb", start: () => startBoostKoeb("bruger-1") },
  { navn: "returfragt", tabel: "returfragt_betalinger", start: () => startReturfragtBetaling("handel-1", "bruger-1") },
] as const;

describe("den fælles liste", () => {
  it("er præcis kort, MobilePay og Revolut Pay", () => {
    expect([...BETALINGSMETODER]).toEqual(TILLADTE);
  });
});

for (const f of flows) {
  describe(`${f.navn}: PaymentIntentens betalingsmetoder`, () => {
    it("ny PaymentIntent: præcis den tilladte liste, ingen automatic_payment_methods, 3D Secure 'any'", async () => {
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      const c = kald.filter((k) => k.navn === "create");
      expect(c).toHaveLength(1);
      expect(c[0].params!.payment_method_types).toEqual(TILLADTE);
      expect(c[0].params!.automatic_payment_methods).toBeUndefined();
      expect(c[0].params!.on_behalf_of).toBeUndefined();
      expect(c[0].params!.transfer_data).toBeUndefined();
      expect(c[0].params!.payment_method_options).toEqual({ card: { request_three_d_secure: "any" } });
      expect(c[0].noegle).toMatch(/-0-testdb-m-card\.mobilepay\.revolut_pay$/);
    });

    it("gentaget kald: samme PaymentIntent, intet nyt træk", async () => {
      await f.start();
      await f.start();
      expect(kald.filter((k) => k.navn === "create")).toHaveLength(1);
      expect(kald.filter((k) => k.navn === "update")).toHaveLength(0);
    });

    it("åben gammel PaymentIntent med automatic_payment_methods: annulleres og laves om med ny nøgle", async () => {
      const gammel = nyPi({ amount: raekke(f.tabel, f.navn === "boost" ? "koeb-1" : "rf-1").beloeb_oere, customer: "cus_test", automatic_payment_methods: { enabled: true } });
      gammel.payment_method_options = { card: { request_three_d_secure: "any" } };
      gammel.metadata = f.navn === "boost" ? { boost_koeb_id: "koeb-1" } : { returfragt_id: "rf-1" };
      const r = raekke(f.tabel, f.navn === "boost" ? "koeb-1" : "rf-1");
      r.stripe_payment_intent_id = gammel.id;

      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      expect(pis.get(gammel.id)!.status).toBe("canceled");
      const annul = kald.find((k) => k.navn === "cancel" && k.id === gammel.id)!;
      expect(annul.noegle).toBe(`bidhamr-metoder-annuller-${gammel.id}`);
      // Aldrig forsøgt opdateret (Stripe afviser det).
      expect(kald.filter((k) => k.navn === "update")).toHaveLength(0);
      const c = kald.filter((k) => k.navn === "create");
      expect(c).toHaveLength(1);
      expect(c[0].params!.payment_method_types).toEqual(TILLADTE);
      expect(c[0].noegle).toMatch(/-1-testdb-m-card\.mobilepay\.revolut_pay$/);
      expect(r.pi_forsoeg).toBe(1);
      expect(r.stripe_payment_intent_id).toBe([...pis.keys()].at(-1));
      expect("clientSecret" in svar && svar.clientSecret).not.toContain(gammel.id);
    });

    it("gammel PaymentIntent i requires_action med Klarna/Link: annulleres også", async () => {
      const gammel = nyPi({ amount: 1, customer: "cus_test", automatic_payment_methods: { enabled: true } });
      gammel.status = "requires_action";
      raekke(f.tabel, f.navn === "boost" ? "koeb-1" : "rf-1").stripe_payment_intent_id = gammel.id;
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      expect(pis.get(gammel.id)!.status).toBe("canceled");
    });

    it("gammel PaymentIntent, der nåede at blive betalt: annulleres ikke, spejles som betalt", async () => {
      const gammel = nyPi({ amount: 1, customer: "cus_test", automatic_payment_methods: { enabled: true } });
      gammel.status = "succeeded";
      raekke(f.tabel, f.navn === "boost" ? "koeb-1" : "rf-1").stripe_payment_intent_id = gammel.id;
      const svar = await f.start();
      expect("fejl" in svar).toBe(true);
      expect(kald.filter((k) => k.navn === "cancel" || k.navn === "create")).toHaveLength(0);
    });

    it("eksplicit liste med andre metoder (fx kun kort+klarna): opdateres til den tilladte liste", async () => {
      const r = raekke(f.tabel, f.navn === "boost" ? "koeb-1" : "rf-1");
      const gammel = nyPi({ amount: r.beloeb_oere, customer: "cus_test", payment_method_types: ["card", "klarna"] });
      gammel.payment_method_options = { card: { request_three_d_secure: "any" } };
      gammel.metadata = f.navn === "boost" ? { boost_koeb_id: "koeb-1" } : { returfragt_id: "rf-1" };
      r.stripe_payment_intent_id = gammel.id;
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      const u = kald.filter((k) => k.navn === "update");
      expect(u).toHaveLength(1);
      expect(u[0].params!.payment_method_types).toEqual(TILLADTE);
      expect(pis.get(gammel.id)!.payment_method_types).toEqual(TILLADTE);
      expect(kald.filter((k) => k.navn === "create")).toHaveLength(0);
    });

    it("gammel nøgle brugt med automatic_payment_methods (aldrig gemt): ny nøgle, ingen idempotensfejl", async () => {
      // Sådan så den gamle nøgle ud før 20. okt. 2026.
      const id = f.navn === "boost" ? "koeb-1" : "rf-1";
      brugteNoegler.set(`bidhamr-${f.navn}-${id}-0-testdb`, JSON.stringify({ automatic_payment_methods: { enabled: true } }));
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
    });

    it("Revolut Pay ikke slået til på platformen: udelades (kort altid med), og betalingen kan stadig startes", async () => {
      platform.revolut_pay = { available: false };
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      const c = kald.filter((k) => k.navn === "create");
      expect(c[0].params!.payment_method_types).toEqual(["card", "mobilepay"]);
      expect(c[0].noegle).toMatch(/-m-card\.mobilepay$/);
    });

    it("intet slået til ud over kort (eller konfigurationen fejler): kun kort", async () => {
      platform.mobilepay = { available: false };
      platform.revolut_pay = { available: false };
      await f.start();
      expect(kald.find((k) => k.navn === "create")!.params!.payment_method_types).toEqual(["card"]);
    });

    it("to standard-konfigurationer: kun kort, og én drift-alarm med fast nøgle", async () => {
      ekstraKonfigurationer.push({ id: "pmc_std2", is_default: true, parent: null, application: null, ...platform });
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      expect(kald.find((k) => k.navn === "create")!.params!.payment_method_types).toEqual(["card"]);
      expect(alarmer).toEqual(["betalingsmetoder:platform-konfiguration"]);
    });

    it("Stripe svarer ikke på konfigurationen: kun kort og alarm; virker det igen, lukkes alarmen", async () => {
      konfigurationFejler = true;
      await f.start();
      expect(kald.find((k) => k.navn === "create")!.params!.payment_method_types).toEqual(["card"]);
      expect(alarmer).toEqual(["betalingsmetoder:platform-konfiguration"]);
      konfigurationFejler = false;
      nulstilPlatformMetoderCache();
      const { hentPlatformMetoder } = await import("@/lib/betaling/platformMetoder");
      expect(await hentPlatformMetoder()).toEqual(TILLADTE);
      expect(lukket).toContain("betalingsmetoder:platform-konfiguration");
    });

    it("webhooken nulstiller rækken under annulleringen: rækken hentes igen, og der laves en ny uden fejl", async () => {
      const id = f.navn === "boost" ? "koeb-1" : "rf-1";
      const r = raekke(f.tabel, id);
      const gammel = nyPi({ amount: r.beloeb_oere, customer: "cus_test", automatic_payment_methods: { enabled: true } });
      r.stripe_payment_intent_id = gammel.id;
      webhookVedAnnullering = () => {
        // Som boost_koeb_registrer / returfragt_registrer ved 'canceled'.
        r.stripe_payment_intent_id = null;
        r.pi_forsoeg = Number(r.pi_forsoeg) + 1;
      };
      const svar = await f.start();
      expect("ok" in svar && svar.ok).toBe(true);
      const c = kald.filter((k) => k.navn === "create");
      expect(c).toHaveLength(1);
      expect(c[0].noegle).toMatch(/-1-testdb-m-card\.mobilepay\.revolut_pay$/);
    });
  });
}
