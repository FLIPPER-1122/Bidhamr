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
  rangFejl: false,
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
          // introBeholdGratis (20261102450000): det seneste hentede firma -
          // tæller ikke som et opslag af firmaet.
          if (q.kolonner === "intro_behold_gratis") {
            const sidste = t.firmaer[Math.max(0, Math.min(t.firmaKald - 1, t.firmaer.length - 1))];
            return { data: { intro_behold_gratis: sidste?.intro_behold_gratis === true }, error: null };
          }
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
        if (navn === "erhverv_pakke_rang") {
          if (t.rangFejl) return { data: null, error: { message: "timeout", code: "57014" } };
          // Som databasens funktion: [coalesce(auktioner, 1e9), fremhævninger, coalesce(pris, 0)].
          const p = t.pakker.find((x) => x.id === (args as { p_pakke: string }).p_pakke);
          if (!p) return { data: null, error: null };
          return {
            data: [p.auktioner_pr_maaned ?? 1_000_000_000, p.fremhaevninger_pr_maaned, p.maanedspris ?? 0],
            error: null,
          };
        }
        const v = t.rpc[navn];
        return { data: v === undefined ? { kode: "ok" } : v, error: null };
      },
    ).klient,
}));

process.env.STRIPE_SECRET_KEY = "sk_test_enhed";

const {
  startOpgradering,
  udloebetOpgradering,
  introTilStripe,
  velkomstSkiftForPakke,
  velkomstSkiftVisning,
  spejlIntroEfterVelkomstSkift,
  betaltVelkomstOpgradering,
} = await import("@/lib/erhverv/betaling");
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
  t.rangFejl = false;
  t.pakker = [
    { id: START, navn: "Start", maanedspris: 499, auktioner_pr_maaned: 10, fremhaevninger_pr_maaned: 0, maaned1: "gratis", aktiv: true, arkiveret_kl: null },
    { id: PRO, navn: "Pro", maanedspris: 1999, auktioner_pr_maaned: 100, fremhaevninger_pr_maaned: 4, maaned1: "halv", aktiv: true, arkiveret_kl: null },
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

  it("op/ned afgøres med databasens rang (erhverv_pakke_rang), ikke en kopi i koden", async () => {
    await velkomstSkiftForPakke(BRUGER, PRO);
    const rang = t.rpcLog.filter((k) => k.navn === "erhverv_pakke_rang").map((k) => k.args.p_pakke);
    expect(rang.sort()).toEqual([START, PRO].sort());
  });

  it("arkiveret nuværende pakke: et skift op som i databasen - GET kræver visning, og POST'en uden giver visning_mangler", async () => {
    // Den nuværende pakke er arkiveret og har en højere rang end målet: en
    // kopi af rangen ville sige "ned" (ingen visning), men databasen siger op.
    t.pakker = [
      { id: START, navn: "Gammel", maanedspris: 4999, auktioner_pr_maaned: null, fremhaevninger_pr_maaned: 9, maaned1: "gratis", aktiv: false, arkiveret_kl: "2026-10-01T00:00:00Z" },
      { id: PRO, navn: "Pro", maanedspris: 1999, auktioner_pr_maaned: 100, fremhaevninger_pr_maaned: 4, maaned1: "halv", aktiv: true, arkiveret_kl: null },
    ];
    const r = await velkomstSkiftForPakke(BRUGER, PRO);
    expect(r).toMatchObject({ status: "ok", tilbud: { udfald: "skift", visning: "velkomst:50", kanSkifte: true } });
    const uden = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", null);
    expect(uden).toMatchObject({ afvistKode: "visning_mangler" });
  });

  it("pakken har ingen pris: stadig velkomstSkift (POST'en kræver visning), men ingen knap og en forklaring", async () => {
    t.pakker = [t.pakker[0], { ...t.pakker[1], maanedspris: null }];
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toMatchObject({
      status: "ok",
      tilbud: { udfald: "skift", visning: "velkomst:50", kanSkifte: false, beloeb: null, knap: "", tekst: FIRMA_ABONNEMENT.bekraeftOpgraderPrisIkkeSat },
    });
  });

  it("inaktiv eller arkiveret målpakke: ugyldig_pakke (som databasen ved POST'en)", async () => {
    t.pakker = [t.pakker[0], { ...t.pakker[1], aktiv: false }];
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toEqual({ status: "ugyldig_pakke" });
    t.pakker = [t.pakker[0], { ...t.pakker[1], aktiv: true, arkiveret_kl: "2026-10-01T00:00:00Z" }];
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toEqual({ status: "ugyldig_pakke" });
  });

  it("databasens rang kan ikke hentes: kaster (vis ikke et forkert udfald)", async () => {
    t.rangFejl = true;
    await expect(velkomstSkiftForPakke(BRUGER, PRO)).rejects.toThrow("erhverv_pakke_rang");
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

// Skift op i den gratis måned (Filip, 29. okt. 2026): introrabatten gælder
// ALTID i præcis N måneder fra skiftet - uafhængigt af valget "Behold Starts
// gratis måned + introrabat". Giver den kørende kupon flere end N fra nu
// (introFraSkiftet), sættes introkuponen på igen fra skiftet (K = N) i SAMME
// kald som trial_end 'now'. Giver den præcis N, bliver den liggende.
describe("skift op i den gratis måned: introrabatten i præcis N måneder fra skiftet", () => {
  const aktivIntro = {
    intro_status: "aktiv",
    intro_procent: 50,
    intro_maaneder: 6,
    intro_fra: "efter_gratis",
    intro_coupon_id: "bidhamr_intro_50_6",
    intro_noegle: NOEGLE,
  };
  // 170 dage: 6 rabatfakturaer fra nu (nu + 0..5 måneder). 200 dage: 7.
  const medKupon = (dage: number, over: Raekke = {}) =>
    abonnement({
      discounts: [
        {
          id: "di_1",
          end: NU + dage * 86_400,
          source: { coupon: { id: "bidhamr_intro_50_6", percent_off: 50, metadata: { bidhamr: "intro" } } },
        },
      ],
      ...over,
    });
  const noegler = () =>
    stripeFalsk.subscriptions.update.mock.calls.map((c) => (c as unknown[])[2] as { idempotencyKey?: string } | undefined);

  for (const behold of [true, false]) {
    it(`kuponen giver 7 fra nu (${behold ? "med" : "uden"} valget): bidhamr_intro_50_6_skift i samme kald som trial_end 'now' (idempotency key)`, async () => {
      t.firmaer = [firma({ ...aktivIntro, intro_behold_gratis: behold })];
      t.sub = medKupon(200);
      const r = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "intro:50:skift");
      expect(r).not.toMatchObject({ status: "fejl" });
      const kald = prisOpdateringer();
      expect(kald).toHaveLength(1);
      expect(kald[0]).toMatchObject({ trial_end: "now", discounts: [{ coupon: "bidhamr_intro_50_6_skift" }], payment_behavior: "pending_if_incomplete" });
      expect(noegler().every((n) => typeof n?.idempotencyKey === "string" && n.idempotencyKey.length > 0)).toBe(true);
    });

    it(`kuponen giver præcis 6 fra nu (${behold ? "med" : "uden"} valget): ingen discounts i kaldet (rabatten bliver liggende)`, async () => {
      t.firmaer = [firma({ ...aktivIntro, intro_behold_gratis: behold })];
      t.sub = medKupon(170);
      await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "intro:50");
      const kald = prisOpdateringer();
      expect(kald).toHaveLength(1);
      expect(kald[0]).toMatchObject({ trial_end: "now" });
      expect("discounts" in kald[0]).toBe(false);
    });
  }

  it("ikke kun Starts velkomstmåned (staff-givet gratis periode): ingen ny kupon", async () => {
    t.firmaer = [firma({ ...aktivIntro })];
    t.sub = medKupon(200, { metadata: { maaned1: "gratis", firma_id: FIRMA, gratis_ekstra: "1" } });
    await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "intro:50");
    expect(prisOpdateringer().some((k) => "discounts" in k)).toBe(false);
  });

  it("siden (GET) viser det samme: 'i 6 måneder' (til null) ved ny kupon, ellers Stripes slutdato", async () => {
    t.pakker = [t.pakker[0], { ...t.pakker[1], maaned1: "halv" }];
    t.firmaer = [firma({ ...aktivIntro })];
    t.sub = medKupon(200);
    const ny = await velkomstSkiftForPakke(BRUGER, PRO);
    expect(ny).toMatchObject({ status: "ok", tilbud: { udfald: "skift", visning: "intro:50:skift", rabat: { slags: "intro", til: null, maaneder: 6 } } });
    if (ny.status === "ok") expect(ny.tilbud?.tekst).toContain("50 % rabat i 6 måneder");
    t.sub = medKupon(170);
    const ligger = await velkomstSkiftForPakke(BRUGER, PRO);
    expect(ligger).toMatchObject({ status: "ok", tilbud: { udfald: "skift", visning: "intro:50", rabat: { slags: "intro", maaneder: 6 } } });
    if (ligger.status === "ok") expect(ligger.tilbud?.rabat).toMatchObject({ til: expect.stringMatching(/\d{4}$/) });
  });

  it("værnet (det friske abonnement): ligger skift-kuponen der allerede, afvises skiftet - intet trækkes", async () => {
    // Kun muligt, hvis databasen allerede peger på skift-kuponen (fx spejlet
    // fra et tidligere skift), og Stripes slutdato giver 7: Stripe ville
    // beholde den gamle rabat, så kaldet sendes ikke.
    t.firmaer = [firma({ ...aktivIntro, intro_coupon_id: "bidhamr_intro_50_6_skift" })];
    t.sub = medKupon(200);
    (t.sub.discounts as Raekke[])[0].source = {
      coupon: { id: "bidhamr_intro_50_6_skift", percent_off: 50, metadata: { bidhamr: "intro" } },
    };
    const r = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "intro:50:skift");
    expect(r).toMatchObject({ status: "fejl" });
    expect((r as { fejl?: string }).fejl).toMatch(/introkuponen bidhamr_intro_50_6_skift ligger allerede på sub_1/);
    expect(prisOpdateringer()).toEqual([]);
  });

  // Visningen siger, om kuponen sættes på igen (":skift" - "i N måneder")
  // eller bliver liggende (Stripes slutdato). Skifter det mellem GET og POST,
  // har firmaet set en anden tekst: pris_aendret, før noget ændres i Stripe.
  it("siden viste 'til <dato>' (intro:50), men nu sættes kuponen på igen: pris_aendret - intet ændres", async () => {
    t.firmaer = [firma({ ...aktivIntro })];
    t.sub = medKupon(200);
    const r = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "intro:50");
    expect(r).toMatchObject({ status: "fejl", intetTrukket: true, afvistKode: "pris_aendret", besked: FIRMA_ABONNEMENT.skiftPrisAendret });
    expect(stripeFalsk.subscriptions.update).not.toHaveBeenCalled();
  });

  it("siden viste 'i 6 måneder' (intro:50:skift), men nu bliver kuponen liggende: pris_aendret - intet ændres", async () => {
    t.firmaer = [firma({ ...aktivIntro })];
    t.sub = medKupon(170);
    const r = await startOpgradering(SKIFT, TILBAGERUL, "laas-1", "intro:50:skift");
    expect(r).toMatchObject({ status: "fejl", intetTrukket: true, afvistKode: "pris_aendret", besked: FIRMA_ABONNEMENT.skiftPrisAendret });
    expect(stripeFalsk.subscriptions.update).not.toHaveBeenCalled();
  });

  it("appens POST med visningen fra GET'en (intro:50:skift) gennemføres; intro:50 afvises med 409 pris_aendret", async () => {
    t.pakker = [t.pakker[0], { ...t.pakker[1], maaned1: "halv" }];
    t.firmaer = [firma({ ...aktivIntro })];
    t.sub = medKupon(200);
    const vist = await velkomstSkiftForPakke(BRUGER, PRO);
    expect(vist).toMatchObject({ status: "ok", tilbud: { visning: "intro:50:skift" } });
    expect(await skiftPakkeForBruger(BRUGER, PRO, "intro:50")).toEqual({ fejl: FIRMA_ABONNEMENT.skiftPrisAendret, kode: "pris_aendret" });
    expect(stripeFalsk.subscriptions.update).not.toHaveBeenCalled();
  });
});

// Spejlingen efter et betalt skift op fra den gratis måned: ingen stille fejl
// - alt, der ikke passer, giver en drift-alarm; slutdatoen kontrolleres
// (introPasser fra billing_cycle_anchor = skiftet).
describe("spejlIntroEfterVelkomstSkift: kontrol af slutdato og ingen stille fejl", () => {
  const ANKER = NU;
  const aktiv = {
    intro_status: "aktiv",
    intro_procent: 50,
    intro_maaneder: 6,
    intro_fra: "efter_gratis",
    intro_coupon_id: "bidhamr_intro_50_6",
    intro_noegle: NOEGLE,
  };
  const efterSkift = (over: Raekke = {}, slut = ANKER + 170 * 86_400, procent = 50) =>
    abonnement({
      status: "active",
      billing_cycle_anchor: ANKER,
      trial_end: ANKER,
      discounts: [
        {
          id: "di_2",
          end: slut,
          source: { coupon: { id: "bidhamr_intro_50_6_skift", percent_off: procent, metadata: { bidhamr: "intro" } } },
        },
      ],
      ...over,
    });
  const alarmer = () => t.drift.filter((d) => String(d.hvor).startsWith("erhverv/velkomst-intro"));
  const spejlinger = () => t.rpcLog.filter((r) => r.navn === "firma_intro_spejl");

  // En gentaget invoice.paid (eller en anden levering, der vandt og døde før
  // spejlingen - fx testserverens ældre kode): skiftet er allerede
  // registreret, men introrabatten spejles igen (idempotent).
  const betaltSkift = { id: SKIFT, firma_id: FIRMA, til_pakke_id: PRO, type: "opgradering", status: "gennemfoert", stripe_invoice_id: "in_ny" };
  const skiftFaktura = (created: number) =>
    ({ id: "in_ny", created, parent: { subscription_details: { subscription: "sub_1" } } }) as unknown as Parameters<
      typeof betaltVelkomstOpgradering
    >[1];

  it("allerede registreret: introrabatten spejles igen (idempotent), ingen ny registrering", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift();
    const r = await betaltVelkomstOpgradering(firma(aktiv) as never, skiftFaktura(NU - 3600), betaltSkift);
    expect(r).toBe("velkomst_opgradering:allerede_registreret");
    expect(spejlinger()).toHaveLength(1);
    expect(spejlinger()[0].args).toMatchObject({ p_coupon: "bidhamr_intro_50_6_skift" });
    expect(t.rpcLog.map((x) => x.navn)).not.toContain("firma_pakkeskift_uden_betaling");
    expect(alarmer()).toEqual([]);
  });

  it("allerede registreret, men fakturaen er ældre end Stripes genforsøg (4 dage): intet spejles", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift();
    const r = await betaltVelkomstOpgradering(firma(aktiv) as never, skiftFaktura(NU - 5 * 86_400), betaltSkift);
    expect(r).toBe("velkomst_opgradering:allerede_registreret");
    expect(spejlinger()).toEqual([]);
  });

  it("passer (6 fra skiftet): spejler kupon og slutdato, ingen alarm", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift();
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(spejlinger()).toHaveLength(1);
    expect(spejlinger()[0].args).toMatchObject({ p_coupon: "bidhamr_intro_50_6_skift", p_status: "aktiv", p_noegle: NOEGLE });
    expect(alarmer()).toEqual([]);
  });

  it("Stripes discount.end giver 7 fra skiftet: drift-alarm (velkomst-intro-antal)", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift({}, ANKER + 200 * 86_400);
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(alarmer().map((a) => a.hvor)).toEqual(["erhverv/velkomst-intro-antal"]);
    expect(String(alarmer()[0].fejl)).toMatch(/giver 7 fakturaer.*ikke præcis 6/);
  });

  it("Stripes discount.end giver 5: også alarm", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift({}, ANKER + 140 * 86_400);
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(alarmer().map((a) => a.hvor)).toEqual(["erhverv/velkomst-intro-antal"]);
  });

  it("ventende ændring: alarm i stedet for stille return - intet spejles", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift({ pending_update: { expires_at: NU + 3600 } });
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(alarmer().map((a) => a.hvor)).toEqual(["erhverv/velkomst-intro-spejl"]);
    expect(String(alarmer()[0].fejl)).toMatch(/ventende ændring/);
    expect(spejlinger()).toEqual([]);
  });

  it("anden procent end aftalen: alarm i stedet for stille return - intet spejles", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift({}, ANKER + 170 * 86_400, 30);
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(alarmer().map((a) => a.hvor)).toEqual(["erhverv/velkomst-intro-spejl"]);
    expect(String(alarmer()[0].fejl)).toMatch(/30 %.*aftalen er 50 %/);
    expect(spejlinger()).toEqual([]);
  });

  it("ingen introkupon, men en introrabat i databasen: alarm", async () => {
    t.firmaer = [firma(aktiv)];
    t.sub = efterSkift({ discounts: [] });
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(alarmer().map((a) => a.hvor)).toEqual(["erhverv/velkomst-intro-spejl"]);
  });

  it("ingen introrabat i databasen (velkomstrabatten): intet at spejle, ingen alarm", async () => {
    t.firmaer = [firma()];
    t.sub = efterSkift({ discounts: [] });
    await spejlIntroEfterVelkomstSkift(FIRMA, "sub_1");
    expect(alarmer()).toEqual([]);
    expect(spejlinger()).toEqual([]);
  });

  it("Stripe fejler: alarm, kaster ikke", async () => {
    t.firmaer = [firma(aktiv)];
    stripeFalsk.subscriptions.retrieve.mockImplementationOnce(async () => {
      throw new Error("Stripe nede");
    });
    await expect(spejlIntroEfterVelkomstSkift(FIRMA, "sub_1")).resolves.toBeUndefined();
    expect(alarmer().map((a) => a.hvor)).toEqual(["erhverv/velkomst-intro-spejl"]);
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

  it("alarmen kommer allerede, når ret_rabat vises (siden og appen skjuler knappen) - samme digest som klikket", async () => {
    t.firmaer = [
      firma({ intro_status: "aktiv", intro_procent: 30, intro_maaneder: 3, intro_coupon_id: "bidhamr_intro_30_3", intro_noegle: NOEGLE }),
    ];
    // Hjemmesiden (Firma oversigt -> Abonnement).
    expect(await velkomstSkiftVisning(BRUGER)).toMatchObject({ velkomstGratis: true, udfald: { udfald: "ret_rabat" } });
    // Appen (GET /api/firma/skift-pakke).
    expect(await velkomstSkiftForPakke(BRUGER, PRO)).toMatchObject({ status: "ok", tilbud: { udfald: "ret_rabat", kanSkifte: false } });
    // Et klik alligevel (fx en gammel app).
    await skiftPakkeForBruger(BRUGER, PRO, "ret_rabat");
    const alarmer = t.drift.filter((d) => d.hvor === "erhverv/velkomst-rabat-uenig");
    expect(alarmer).toHaveLength(3);
    // Én nøgle og én tekst: databasen dedupper til én alarm.
    expect(new Set(alarmer.map((d) => d.digest))).toEqual(new Set([retRabatAlarmNoegle(FIRMA, NOEGLE)]));
    expect(new Set(alarmer.map((d) => d.fejl)).size).toBe(1);
  });

  it("ingen alarm, når udfaldet ikke er ret_rabat", async () => {
    await velkomstSkiftVisning(BRUGER);
    await velkomstSkiftForPakke(BRUGER, PRO);
    expect(t.drift.filter((d) => d.hvor === "erhverv/velkomst-rabat-uenig")).toEqual([]);
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
