// Fragtfirmaer (Filip, 20. okt. 2026): kun DAO og GLS - PostNord er slået fra
// (SHIPMONDO_POSTNORD_AKTIV). En PostNord-levering, der blev gemt, før
// PostNord blev slået fra, men ikke er betalt, kan ikke betales (heller ikke
// via app-API'et, som bruger samme sikrPaymentIntent). Køberen får den danske
// tekst med kode vaelg_levering og skal vælge levering igen. Er labelen
// allerede lavet, eller er PostNord slået til, går betalingen videre.
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

const POSTNORD_LUKKET = "PostNord kan ikke vælges lige nu. Vælg DAO eller GLS.";
const ENV = ["SHIPMONDO_GLS_AKTIV", "SHIPMONDO_POSTNORD_AKTIV", "SHIPMONDO_TRANSPORTOERER"] as const;

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
  for (const k of ENV) delete process.env[k];
  levering = { fragt_oere: 4000, fragtfirma: "shipmondo", transportoer: "postnord" };
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

describe("betaling af en gemt PostNord-levering, mens PostNord er slået fra", () => {
  it("afvises med den danske tekst og kode vaelg_levering", async () => {
    const err = await fejlFra();
    expect(err).toBeInstanceOf(LeveringManglerFejl);
    expect((err as LeveringManglerFejl).message).toBe(POSTNORD_LUKKET);
    expect((err as LeveringManglerFejl).kode).toBe("vaelg_levering");
  });

  it("DAO og GLS betales som før (GLS er slået til som standard)", async () => {
    for (const t of ["dao", "gls"]) {
      levering = { fragt_oere: 4000, fragtfirma: "shipmondo", transportoer: t };
      expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
    }
  });

  it("med SHIPMONDO_POSTNORD_AKTIV=true kan PostNord betales", async () => {
    process.env.SHIPMONDO_POSTNORD_AKTIV = "true";
    expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
  });

  it("er GLS fjernet fra SHIPMONDO_TRANSPORTOERER, afvises en gemt GLS-levering", async () => {
    process.env.SHIPMONDO_TRANSPORTOERER = "dao";
    levering = { fragt_oere: 4000, fragtfirma: "shipmondo", transportoer: "gls" };
    expect(((await fejlFra()) as Error).message).toBe("GLS kan ikke vælges lige nu. Vælg DAO.");
  });

  it("er labelen allerede lavet, afvises betalingen ikke", async () => {
    forsendelser = [{ id: "F1" }];
    expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
  });

  it("DAO direkte (ikke Shipmondo) rammes ikke af listen", async () => {
    levering = { fragt_oere: 4000, fragtfirma: "dao", transportoer: "postnord" };
    expect(await fejlFra()).not.toBeInstanceOf(LeveringManglerFejl);
  });

  it("intet leveringsvalg giver stadig den almindelige tekst", async () => {
    levering = null;
    expect(((await fejlFra()) as Error).message).toBe("Vælg levering, før du betaler.");
  });
});
