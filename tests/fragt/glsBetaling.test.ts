// GLS er slået fra (SHIPMONDO_GLS_AKTIV): en GLS-levering, der blev gemt,
// før GLS blev slået fra, men ikke er betalt, kan ikke betales (heller ikke
// via app-API'et, som bruger samme sikrPaymentIntent). Køberen får den danske
// GLS-tekst med kode vaelg_levering og skal vælge levering igen. Er labelen
// allerede lavet, eller er GLS slået til, går betalingen videre.
// Databasen og Stripe er falske.
import { beforeEach, describe, expect, it, vi } from "vitest";

let levering: Record<string, unknown> | null = null;
let forsendelser: unknown[] = [];

function kaede(tabel: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "limit", "in", "order"]) q[m] = () => q;
  q.maybeSingle = async () => ({ data: tabel === "handel_levering" ? levering : null, error: null });
  q.then = (ok: (v: unknown) => unknown, fejl?: (e: unknown) => unknown) =>
    Promise.resolve({ data: tabel === "forsendelser" ? forsendelser : [], error: null }).then(ok, fejl);
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => kaede(t), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async () => "ny"),
  renFejltekst: (e: unknown) => String(e instanceof Error ? e.message : e),
}));
vi.mock("@/lib/notifikationer/send", () => ({ send: vi.fn(async () => ({})) }));
vi.mock("@/lib/betaling/model", () => ({ BetalingsmodelFejl: class extends Error {}, kraevDestination: vi.fn(async () => undefined) }));
vi.mock("@/lib/betaling/noedstop", () => ({
  hentNoedstop: vi.fn(async () => ({ nyeBetalingerStoppet: false })),
  NYE_BETALINGER_STOPPET_TEKST: "stop",
}));
// Stripe kaldes aldrig rigtigt: efter værnet fejler betalingen på et senere
// trin, og testen tjekker kun, at det ikke er levering-værnet.
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({}),
  kraevSammeOffentligeNoegle: vi.fn(async () => undefined),
  StripeTilstandFejl: class extends Error {},
}));
vi.mock("@/lib/betaling/connect", () => ({
  kontoSpejl: vi.fn(),
  nyKontoParametre: vi.fn(),
  sikrKontoopsaetning: vi.fn(),
}));

import { LeveringManglerFejl, sikrPaymentIntent, type BetalingRaekke } from "@/lib/betaling/stripeBetaling";

const GLS_LUKKET = "GLS kan ikke vælges lige nu. Vælg DAO eller PostNord.";

const betaling = {
  id: "B1",
  trade_id: "T1",
  fragt_oere: 4000,
  total_oere: 20000,
  pengemodel: "destination",
  venter_paa_saelgerkonto_kl: null,
  stripe_payment_intent_id: null,
  saelger_stripe_konto: "acct_1",
  status: "afventer",
} as unknown as BetalingRaekke;

beforeEach(() => {
  delete process.env.SHIPMONDO_GLS_AKTIV;
  levering = { fragt_oere: 4000, fragtfirma: "shipmondo", transportoer: "gls" };
  forsendelser = [];
});

async function fejlFra(): Promise<unknown> {
  try {
    await sikrPaymentIntent(betaling);
    return null;
  } catch (err) {
    return err;
  }
}

describe("betaling af en GLS-levering, mens GLS er slået fra", () => {
  it("afvises med den danske GLS-tekst og kode vaelg_levering", async () => {
    const err = await fejlFra();
    expect(err).toBeInstanceOf(LeveringManglerFejl);
    expect((err as LeveringManglerFejl).message).toBe(GLS_LUKKET);
    expect((err as LeveringManglerFejl).kode).toBe("vaelg_levering");
  });

  it("DAO og PostNord betales som før", async () => {
    for (const t of ["dao", "postnord"]) {
      levering = { fragt_oere: 4000, fragtfirma: "shipmondo", transportoer: t };
      expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
    }
  });

  it("med SHIPMONDO_GLS_AKTIV=true kan GLS betales", async () => {
    process.env.SHIPMONDO_GLS_AKTIV = "true";
    expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
  });

  it("er labelen allerede lavet, afvises betalingen ikke", async () => {
    forsendelser = [{ id: "F1" }];
    expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
  });

  it("intet leveringsvalg giver stadig den almindelige tekst", async () => {
    levering = null;
    expect(((await fejlFra()) as Error).message).toBe("Vælg levering, før du betaler.");
  });
});
