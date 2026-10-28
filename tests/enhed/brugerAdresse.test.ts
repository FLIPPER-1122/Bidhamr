// Adressen til fakturaer (20261102340000_bruger_adresse.sql):
//   - validering (samme regler som databasen, byen fra postnummerlisten),
//   - BHY01 fra databasen giver budpanelet "adresse: true" (bud og maksimum),
//   - startBetalingFor afviser første betaling uden adresse, før der laves
//     en PaymentIntent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { falskKlient } from "./hjaelpere/falskSupabase";
import {
  ADRESSE_TEKST,
  adresseKodeFejl,
  byForPostnummer,
  erAdresseFejl,
  validerAdresse,
} from "@/lib/adresse/regler";

const BYDER = "22222222-2222-4222-8222-222222222222";
const AUKTION = "55555555-5555-4555-8555-555555555555";
const HANDEL = "44444444-4444-4444-8444-000000000001";

const m = vi.hoisted(() => ({
  harAdresse: true,
  insertFejl: null as null | { code: string; message: string },
  sikrPi: vi.fn(),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ FOR_MANGE_FORSOEG: "For mange forsøg.", tjekGraenser: async () => true }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@/lib/notifikationer/bud", () => ({ notificerEgetNyesteBud: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => falskKlient(() => undefined).klient }));
vi.mock("@/lib/adresse/server", () => ({ harAdresse: async () => m.harAdresse }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/betaling/stripeBetaling", () => ({
  BetalingsFejl: class extends Error {},
  LeveringManglerFejl: class extends Error {},
  BetalingVenterFejl: class extends Error {},
  VENTER_TEKST: "venter",
  hentBetalingForHandel: async () => ({
    buyer_id: BYDER,
    status: "afventer",
    venter_paa_saelgerkonto_kl: null,
    betal_senest: new Date(Date.now() + 3600_000).toISOString(),
    total_oere: 10000,
  }),
  hentProfil: vi.fn(),
  kundeSessionTilCheckout: async () => null,
  onboardingLink: vi.fn(),
  registrerGemtKort: vi.fn(),
  sikrPaymentIntent: m.sikrPi,
  sikrStripeKunde: vi.fn(),
  spejlConnectKonto: vi.fn(),
  spejlPaymentIntent: vi.fn(),
  stripeOversigtLink: vi.fn(),
}));

const { afgivBudFor, saetMaksimumFor } = await import("@/lib/bud/afgivBud");
const { startBetalingFor } = await import("@/lib/betaling/betalingHandlinger");

function brugerKlient() {
  return falskKlient(
    (q) => (q.tabel === "bids" && q.handling === "insert" ? { data: null, error: m.insertFejl } : undefined),
    (navn) => (navn === "saet_maksimum" ? { data: null, error: m.insertFejl } : { data: null, error: null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.harAdresse = true;
  m.insertFejl = null;
});

describe("validerAdresse", () => {
  it("godkender vej og nr. med kendt postnummer, og byen kommer fra listen", () => {
    expect(validerAdresse({ adresse: "  Testvej   12, 2. th. ", postnummer: "2100" })).toEqual({
      ok: true,
      adresse: { adresse: "Testvej 12, 2. th.", postnummer: "2100", by: "København Ø" },
    });
    expect(validerAdresse({ adresse: "Åboulevarden 3", postnummer: " 8000 " })).toMatchObject({
      ok: true,
      adresse: { by: "Aarhus C" },
    });
  });

  it("afviser manglende husnummer, for kort, for lang og styretegn", () => {
    for (const adresse of ["", "Testvej", "12", "a1", "x".repeat(199) + " 1", "Testvej 1\u0000", 42, null]) {
      expect(validerAdresse({ adresse, postnummer: "2100" }), String(adresse)).toMatchObject({ felt: "adresse" });
    }
  });

  it("afviser postnumre, der ikke har 4 cifre eller ikke findes", () => {
    expect(validerAdresse({ adresse: "Testvej 1", postnummer: "210" })).toEqual({
      fejl: ADRESSE_TEKST.fejl.postnummer,
      felt: "postnummer",
    });
    expect(validerAdresse({ adresse: "Testvej 1", postnummer: "21000" })).toMatchObject({ felt: "postnummer" });
    expect(validerAdresse({ adresse: "Testvej 1", postnummer: "0001" })).toEqual({
      fejl: ADRESSE_TEKST.fejl.postnummerUkendt,
      felt: "postnummer",
    });
    expect(validerAdresse({ adresse: "Testvej 1", postnummer: undefined })).toMatchObject({ felt: "postnummer" });
  });

  it("byen til feltet og databasens koder som danske fejl", () => {
    expect(byForPostnummer("4700")).toBe("Næstved");
    expect(byForPostnummer("47")).toBe("");
    expect(adresseKodeFejl("adresse")).toMatchObject({ felt: "adresse" });
    expect(adresseKodeFejl("postnummer")).toMatchObject({ felt: "postnummer" });
    expect(adresseKodeFejl("konto")).toMatchObject({ konto: true });
    expect(adresseKodeFejl("noget")).toEqual({ fejl: ADRESSE_TEKST.fejl.generisk });
    expect(erAdresseFejl("BHY01")).toBe(true);
    expect(erAdresseFejl("P0001", "adresse_mangler: ...")).toBe(true);
    expect(erAdresseFejl("BHV01", "mitid_mangler")).toBe(false);
  });
});

describe("krav før første bud (BHY01)", () => {
  it("bud: budpanelet får adresse: true og koden til appen", async () => {
    m.insertFejl = { code: "BHY01", message: "adresse_mangler: Udfyld din adresse, før du byder." };
    expect(await afgivBudFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 150, false)).toEqual({
      fejl: ADRESSE_TEKST.kraevesBud,
      kode: "BHY01",
      adresse: true,
    });
  });

  it("maksimum: samme svar", async () => {
    m.insertFejl = { code: "BHY01", message: "adresse_mangler: Udfyld din adresse, før du byder." };
    expect(await saetMaksimumFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 500, false)).toMatchObject({
      kode: "BHY01",
      adresse: true,
    });
  });
});

describe("krav før første betaling", () => {
  it("uden adresse: adresse_mangler, og der laves ingen PaymentIntent", async () => {
    m.harAdresse = false;
    expect(await startBetalingFor(BYDER, HANDEL, "web")).toEqual({
      fejl: ADRESSE_TEKST.kraevesBetaling,
      kode: "adresse_mangler",
    });
    expect(m.sikrPi).not.toHaveBeenCalled();
  });

  it("med adresse: betalingen fortsætter", async () => {
    m.sikrPi.mockResolvedValue({
      status: "requires_payment_method",
      amount: 10000,
      client_secret: "pi_x_secret_y",
      customer: "cus_1",
      payment_method_types: ["card"],
    });
    expect(await startBetalingFor(BYDER, HANDEL, "web")).toMatchObject({ ok: true, clientSecret: "pi_x_secret_y" });
    expect(m.sikrPi).toHaveBeenCalledTimes(1);
  });
});
