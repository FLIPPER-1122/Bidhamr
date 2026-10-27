// Rettelser 4 af måned 1-skiftet (27. okt. 2026) - serverkoden med en falsk
// Stripe og en falsk database (ingen netværk):
//  - skift op fra Starts gratis måned UDEN visning afvises, før noget ændres
//    i Stripe (visning_mangler); en ugyldig visning afvises før databasen
//  - værnet henter firmaet igen (en introrabat gemt midt i skiftet fanges)
//  - "intet trukket" vises også, når tilbagerulningen fejler, eller låsen er
//    overtaget
//  - ret_rabat-alarmen har én nøgle pr. firma og aftale (digest) og ingen
//    ekstra alarm pr. klik
//  - udloebetOpgradering: skift uden faktura + ventende ændring = "venter"
//  - anvendIntro spejler kun en Checkout-kupon med aftalens procent
import { beforeEach, describe, expect, it, vi } from "vitest";
import { falskKlient, type Svar } from "./hjaelpere/falskSupabase";

const FIRMA = "26849ab7-6678-47b7-a8bd-4d618dfdf9f3";
const BRUGER = "33333333-3333-4333-8333-333333333333";
const SKIFT = "55555555-5555-4555-8555-555555555555";
const NOEGLE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const START = "7e57a000-0000-4000-8000-000000000001";
const PRO = "7e57a000-0000-4000-8000-000000000003";
const NU = Math.floor(Date.now() / 1000);

type Raekke = Record<string, unknown>;

const t = vi.hoisted(() => ({
  firmaer: [] as Record<string, unknown>[],
  firmaKald: 0,
  sub: {} as Record<string, unknown>,
  skift: null as Record<string, unknown> | null,
  rpc: {} as Record<string, unknown>,
  rpcLog: [] as { navn: string; args: Record<string, unknown> }[],
  drift: [] as Record<string, unknown>[],
  opdateringer: [] as Record<string, unknown>[],
  pakker: [] as Record<string, unknown>[],
}));

const stripeFalsk = vi.hoisted(() => ({
  subscriptions: {
    retrieve: vi.fn(async () => structuredClone(t.sub)),
    update: vi.fn(async (_id: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      t.opdateringer.push(params);
      return { ...structuredClone(t.sub), latest_invoice: { id: "in_ny", status: "open", hosted_invoice_url: null } };
    }),
  },
  subscriptionSchedules: { release: vi.fn(async () => ({})) },
  invoices: { retrieve: vi.fn(), voidInvoice: vi.fn() },
  coupons: {
    retrieve: vi.fn(async (id: string) =>
      id.includes("velkomst") ? { id, valid: true, percent_off: 50, duration: "once" } : { id, valid: true, duration: "repeating" },
    ),
    create: vi.fn(),
  },
  checkout: { sessions: { list: vi.fn() } },
  testHelpers: { testClocks: { retrieve: vi.fn() } },
}));

vi.mock("@/lib/stripe", () => ({ getStripe: () => stripeFalsk }));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async (x: Record<string, unknown>) => {
    t.drift.push(x);
    return "ny";
  }),
}));
vi.mock("@/lib/rateLimit", () => ({ FOR_MANGE_FORSOEG: "For mange forsøg." }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    falskKlient(
      (q) => {
        if (q.tabel === "firmaer") {
          // pakkeskift.ts slår kun id op (låsen frigives).
          if (q.kolonner === "id") return { data: { id: FIRMA }, error: null };
          const f = t.firmaer[Math.min(t.firmaKald, t.firmaer.length - 1)];
          t.firmaKald++;
          return { data: f, error: null };
        }
        if (q.tabel === "firma_pakkeskift") {
          if (q.handling === "select" && q.kolonner?.startsWith("id,")) return { data: t.skift, error: null };
          return { data: [], error: null };
        }
        if (q.tabel === "erhverv_pakker") {
          // velkomstSkiftForPakke: begge pakker på én gang.
          if (q.filtre.some((f) => f[0] === "in" && f[1] === "id")) return { data: t.pakker, error: null };
          return {
            data: { id: PRO, navn: "Pro", maanedspris: 1999, stripe_price_id: "price_pro", stripe_price_oere: 199_900, maaned1: "halv" },
            error: null,
          };
        }
        return { data: [], error: null };
      },
      (navn, args): Svar => {
        t.rpcLog.push({ navn, args: args as Record<string, unknown> });
        const v = t.rpc[navn];
        return { data: v === undefined ? { kode: "ok" } : v, error: null };
      },
    ).klient,
}));

process.env.STRIPE_SECRET_KEY = "sk_test_enhed";

const { startOpgradering, udloebetOpgradering, introTilStripe, velkomstSkiftForPakke } = await import("@/lib/erhverv/betaling");
const { skiftPakkeForBruger } = await import("@/lib/erhverv/pakkeskift");
const { retRabatAlarmNoegle } = await import("@/lib/erhverv/abonnementRegler");
const { FIRMA_ABONNEMENT, FIRMA_OVERSIGT_EKSTRA } = await import("@/lib/tekster/erhverv");

function firma(over: Raekke = {}): Raekke {
  return {
    id: FIRMA,
    bruger_id: BRUGER,
    firmanavn: "Test ApS",
    cvr: "12345678",
    pakke_id: START,
    abonnement_status: "aktiv",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    proeve_maaneder: 1,
    intro_procent: null,
    intro_maaneder: null,
    intro_fra: null,
    intro_status: null,
    intro_noegle: null,
    intro_coupon_id: null,
    intro_til: null,
    saerpris_oere: null,
    saerpris_pakke_id: null,
    ...over,
  };
}

function abonnement(over: Raekke = {}): Raekke {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "trialing",
    metadata: { maaned1: "gratis", firma_id: FIRMA },
    discounts: [],
    schedule: null,
    pending_update: null,
    test_clock: null,
    trial_end: NU + 20 * 86_400,
    latest_invoice: null,
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ id: "si_1", price: { id: "price_start", metadata: { pakke_id: START } }, current_period_end: NU + 20 * 86_400 }] },
    ...over,
  };
}

const TILBAGERUL = { naeste_pakke_id: null, naeste_pakke_fra: null, planlagt: null, afventer: null };

// Kald, der flytter penge eller ændrer prisen (alt andet end metadata).
function prisOpdateringer(): Record<string, unknown>[] {
  return t.opdateringer.filter((p) => "items" in p || "trial_end" in p || "discounts" in p);
}

beforeEach(() => {
  vi.clearAllMocks();
  t.firmaer = [firma()];
  t.firmaKald = 0;
  t.sub = abonnement();
  t.skift = { id: SKIFT, firma_id: FIRMA, til_pakke_id: PRO, type: "opgradering", status: "afventer_betaling", stripe_invoice_id: null };
  t.rpc = {
    firma_skift_pakke_server: {
      kode: "opgradering_afventer_betaling",
      skift_id: SKIFT,
      pakke: { id: PRO, navn: "Pro" },
      tilbagerul: TILBAGERUL,
      laas: "laas-1",
    },
    firma_pakkeskift_laas_tag: "laas-1",
  };
  t.rpcLog = [];
  t.drift = [];
  t.opdateringer = [];
  t.pakker = [
    { id: START, navn: "Start", maanedspris: 499, auktioner_pr_maaned: 10, fremhaevninger_pr_maaned: 0, maaned1: "gratis" },
    { id: PRO, navn: "Pro", maanedspris: 1999, auktioner_pr_maaned: 100, fremhaevninger_pr_maaned: 4, maaned1: "halv" },
  ];
});

describe("velkomstSkiftForPakke (appens GET): samme udfald som serveren ved skiftet", () => {
  it("Start -> Pro i velkomstmåneden: 50 % af Pro i dag, visning velkomst:50", async () => {
    const r = await velkomstSkiftForPakke(BRUGER, PRO);
    expect(r).toMatchObject({
      status: "ok",
      pakke: { id: PRO, navn: "Pro" },
      tilbud: {
        udfald: "skift",
        visning: "velkomst:50",
        rabat: { slags: "velkomst", procent: 50 },
        beloeb: { eksklOere: 99_950, inklOere: 124_938 },
        kanSkifte: true,
        knap: "Ja, vælg Pro",
      },
    });
    if (r.status === "ok") expect(r.tilbud?.tekst).toMatch(/999,50 kr\..*halv pris/);
    // Og POST'en med netop den visning ændrer prisen.
    await startOpgradering(SKIFT, TILBAGERUL, "laas-1", r.status === "ok" ? r.tilbud!.visning : null);
    expect(prisOpdateringer()).toHaveLength(1);
  });

  it("ret_rabat: ingen knap", async () => {
    t.firmaer = [firma({ intro_status: "aktiv", intro_procent: 30, intro_maaneder: 3, intro_coupon_id: "bidhamr_intro_30_3", intro_noegle: NOEGLE })];
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toMatchObject({ status: "ok", tilbud: { udfald: "ret_rabat", kanSkifte: false, knap: "", beloeb: null } });
  });

  it("ikke et skift op fra velkomstmåneden: tilbud null (nedgradering, aktivt abonnement, særaftale)", async () => {
    t.firmaer = [firma({ pakke_id: PRO })];
    expect(await velkomstSkiftForPakke(BRUGER, START)).toMatchObject({ status: "ok", tilbud: null });
    t.firmaer = [firma()];
    t.sub = abonnement({ status: "active" });
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toMatchObject({ status: "ok", tilbud: null });
    t.sub = abonnement({ metadata: { maaned1: "gratis", gratis_saeraftale: "ja" } });
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toMatchObject({ status: "ok", tilbud: null });
  });

  it("ukendt pakke og ikke-firma", async () => {
    expect(await velkomstSkiftForPakke(BRUGER, "7e57a000-0000-4000-8000-000000000009")).toEqual({ status: "ugyldig_pakke" });
    t.firmaer = [null as never];
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toEqual({ status: "ikke_firma" });
  });

  it("Stripe nede: kaster (appen må ikke tro, at intet skal vises)", async () => {
    stripeFalsk.subscriptions.retrieve.mockRejectedValueOnce(new Error("Stripe nede"));
    await expect(velkomstSkiftForPakke(BRUGER, PRO)).rejects.toThrow("Stripe nede");
  });
});

describe("skift op fra den gratis måned uden visning (blokerende fund)", () => {
  it("afvises med visning_mangler, før noget ændres i Stripe - og rulles tilbage", async () => {
    const r = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", null);
    expect(r).toMatchObject({
      status: "fejl",
      rulletTilbage: true,
      intetTrukket: true,
      afvistKode: "visning_mangler",
      besked: FIRMA_ABONNEMENT.skiftVisningMangler,
    });
    expect(stripeFalsk.subscriptions.update).not.toHaveBeenCalled();
    expect(stripeFalsk.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(t.rpcLog.map((x) => x.navn)).toContain("firma_pakkeskift_rul_tilbage");
  });

  it("appens POST uden visning: 409-koden visning_mangler og ingen driftalarm", async () => {
    expect(await skiftPakkeForBruger(BRUGER, PRO)).toEqual({ fejl: FIRMA_ABONNEMENT.skiftVisningMangler, kode: "visning_mangler" });
    expect(stripeFalsk.subscriptions.update).not.toHaveBeenCalled();
    expect(t.drift).toEqual([]);
  });

  it("en sendt, men ugyldig visning afvises, før databasen røres (ugyldig_visning)", async () => {
    for (const v of ["", "velkomst:abc", 50, { a: 1 }]) {
      expect(await skiftPakkeForBruger(BRUGER, PRO, v)).toEqual({ fejl: "Ugyldig forespørgsel.", kode: "ugyldig_visning" });
    }
    expect(t.rpcLog).toEqual([]);
  });

  it("hjemmesiden (visning sendt og rigtig) virker uændret: prisen ændres i Stripe", async () => {
    await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "velkomst:50");
    const kald = prisOpdateringer();
    expect(kald).toHaveLength(1);
    expect(kald[0]).toMatchObject({ trial_end: "now", items: [{ id: "si_1", price: "price_pro", quantity: 1 }] });
  });
});

describe("værnet henter firmaet igen (småt 1)", () => {
  it("en introrabat, staff gemmer midt i skiftet, afviser skiftet (pris_aendret) - intet ændres", async () => {
    t.firmaer = [
      firma(),
      firma({ intro_status: "planlagt", intro_procent: 30, intro_maaneder: 3, intro_fra: "efter_gratis", intro_noegle: NOEGLE }),
    ];
    const r = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "velkomst:50");
    expect(r).toMatchObject({ status: "fejl", intetTrukket: true, afvistKode: "pris_aendret", besked: FIRMA_ABONNEMENT.skiftPrisAendret });
    expect(prisOpdateringer()).toEqual([]);
    expect(t.firmaKald).toBe(2);
  });
});

describe("intet trukket - også når tilbagerulningen fejler, eller låsen er overtaget (småt 3)", () => {
  it("låsen overtaget: i_gang med 'Der er ikke trukket nogen penge'", async () => {
    t.rpc.firma_pakkeskift_rul_tilbage = { kode: "laas_overtaget" };
    const r = await skiftPakkeForBruger(BRUGER, PRO, "intro:30");
    expect(r).toEqual({ fejl: FIRMA_OVERSIGT_EKSTRA.pakkeskiftLaasOvertagetIntetTrukket, kode: "i_gang" });
    expect(FIRMA_OVERSIGT_EKSTRA.pakkeskiftLaasOvertagetIntetTrukket).toMatch(/ikke trukket nogen penge/);
    expect(prisOpdateringer()).toEqual([]);
  });

  it("tilbagerulningen fejlede: afvisningens kode og 'Der er ikke trukket nogen penge'", async () => {
    t.rpc.firma_pakkeskift_rul_tilbage = { kode: "fejl" };
    const r = await skiftPakkeForBruger(BRUGER, PRO, "intro:30");
    expect(r).toEqual({ fejl: FIRMA_OVERSIGT_EKSTRA.pakkeskiftIkkeRulletIntetTrukket, kode: "pris_aendret" });
    expect(FIRMA_OVERSIGT_EKSTRA.pakkeskiftIkkeRulletIntetTrukket).toMatch(/ikke trukket nogen penge/);
  });

  it("en almindelig Stripe-fejl (kan være trukket) får IKKE beskeden", async () => {
    stripeFalsk.subscriptions.update.mockImplementationOnce(async () => ({}) as never);
    stripeFalsk.subscriptions.update.mockImplementationOnce(async () => {
      throw new Error("Stripe nede");
    });
    t.rpc.firma_pakkeskift_rul_tilbage = { kode: "laas_overtaget" };
    // Kaldet fejlede, og prisen står uændret -> rulles tilbage, men uden
    // "intet trukket" (det er ikke en afvisning).
    const r = await skiftPakkeForBruger(BRUGER, PRO, "velkomst:50");
    expect(r).toEqual({ fejl: FIRMA_OVERSIGT_EKSTRA.pakkeskiftLaasOvertaget, kode: "i_gang" });
  });
});

describe("ret_rabat: én alarm pr. firma og aftale (småt 4) og egen kode (småt 5)", () => {
  it("to klik: samme digest begge gange (databasen tæller op), ingen ekstra alarm pr. klik", async () => {
    t.firmaer = [
      firma({ intro_status: "aktiv", intro_procent: 30, intro_maaneder: 3, intro_coupon_id: "bidhamr_intro_30_3", intro_noegle: NOEGLE }),
    ];
    for (let i = 0; i < 2; i++) {
      expect(await skiftPakkeForBruger(BRUGER, PRO, "ret_rabat")).toEqual({ fejl: FIRMA_ABONNEMENT.skiftRetRabat, kode: "ret_rabat" });
    }
    const alarmer = t.drift.filter((d) => d.hvor === "erhverv/velkomst-rabat-uenig");
    expect(alarmer).toHaveLength(2);
    expect(alarmer.every((d) => d.digest === retRabatAlarmNoegle(FIRMA, NOEGLE))).toBe(true);
    // Teksten er ens for hvert klik (intet skift-id).
    expect(new Set(alarmer.map((d) => d.fejl)).size).toBe(1);
    expect(t.drift.filter((d) => d.hvor === "skiftPakke/startOpgradering")).toEqual([]);
    expect(prisOpdateringer()).toEqual([]);
  });

  it("introrabatten venter: rabat_venter (rabatten sættes op, intet trukket)", async () => {
    t.firmaer = [
      firma({ intro_status: "planlagt", intro_procent: 30, intro_maaneder: 3, intro_fra: "straks", intro_noegle: NOEGLE }),
    ];
    const r = await skiftPakkeForBruger(BRUGER, PRO, "venter");
    expect(r).toMatchObject({ kode: "rabat_venter" });
    // Kun introrabatten (ingen pris, ingen trial_end).
    expect(t.opdateringer.filter((p) => "items" in p || "trial_end" in p)).toEqual([]);
  });

  it("prisen ændret siden visningen: pris_aendret", async () => {
    expect(await skiftPakkeForBruger(BRUGER, PRO, "intro:30")).toEqual({ fejl: FIRMA_ABONNEMENT.skiftPrisAendret, kode: "pris_aendret" });
  });
});

describe("udloebetOpgradering: skift uden faktura (småt 2)", () => {
  beforeEach(() => {
    t.skift = {
      id: SKIFT,
      firma_id: FIRMA,
      til_pakke_id: PRO,
      type: "opgradering",
      status: "afventer_betaling",
      stripe_invoice_id: null,
      oprettet_kl: new Date(Date.now() - 2 * 3600_000).toISOString(),
    };
  });

  it("abonnementet har stadig en ventende ændring: 'venter' - skiftet annulleres ikke", async () => {
    t.sub = abonnement({ pending_update: { expires_at: NU + 3600 } });
    expect(await udloebetOpgradering(t.sub as never)).toBe("venter");
    expect(t.rpcLog.map((x) => x.navn)).not.toContain("firma_pakkeskift_annuller");
  });

  it("ingen ventende ændring: skiftet annulleres", async () => {
    expect(await udloebetOpgradering(t.sub as never)).toBe("udloebet:ok");
    expect(t.rpcLog.map((x) => x.navn)).toContain("firma_pakkeskift_annuller");
  });
});

describe("anvendIntro: Checkout-kuponen spejles kun med aftalens procent (småt 6)", () => {
  function medCheckoutKupon(procent: number) {
    t.firmaer = [
      firma({ intro_status: "planlagt", intro_procent: 30, intro_maaneder: 3, intro_fra: "straks", intro_noegle: NOEGLE }),
    ];
    const kupon = { id: `bidhamr_intro_${procent}_3`, percent_off: procent, metadata: { bidhamr: "intro" } };
    t.sub = abonnement({
      metadata: { maaned1: "gratis", firma_id: FIRMA, intro_noegle: NOEGLE },
      discounts: [{ id: "di_1", source: { coupon: kupon }, end: NU + 90 * 86_400 }],
    });
  }

  it("samme procent: kun spejling (ingen ny kupon)", async () => {
    medCheckoutKupon(30);
    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "ok" });
    const spejl = t.rpcLog.find((x) => x.navn === "firma_intro_spejl");
    expect(spejl?.args).toMatchObject({ p_status: "aktiv", p_coupon: "bidhamr_intro_30_3" });
    expect(stripeFalsk.subscriptions.update).not.toHaveBeenCalled();
  });

  it("en anden procent (50 % mod aftalens 30 %): spejles ikke - aftalens kupon sættes på", async () => {
    medCheckoutKupon(50);
    stripeFalsk.subscriptions.update.mockImplementationOnce(async (_id: string, params: Record<string, unknown>) => {
      t.opdateringer.push(params);
      return {
        ...structuredClone(t.sub),
        discounts: [{ id: "di_2", source: { coupon: { id: "bidhamr_intro_30_3", percent_off: 30, metadata: { bidhamr: "intro" } } }, end: NU + 90 * 86_400 }],
      };
    });
    expect(await introTilStripe(FIRMA)).toMatchObject({ status: "ok" });
    expect(t.opdateringer[0]).toMatchObject({ discounts: [{ coupon: "bidhamr_intro_30_3" }] });
    const spejl = t.rpcLog.filter((x) => x.navn === "firma_intro_spejl");
    expect(spejl).toHaveLength(1);
    expect(spejl[0].args).toMatchObject({ p_coupon: "bidhamr_intro_30_3" });
  });
});
