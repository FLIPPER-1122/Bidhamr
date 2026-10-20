// Fakturaer i Dinero: miljø-vagten (src/lib/faktura/konfig.ts) og systemlampen
// "Fakturaer" (src/lib/admin/fakturaLampe.ts). Ingen database, intet netværk.
//
// Filip, 20. okt. 2026: fakturaer må i test KUN sendes til Dinero-regnskabet
// "BidHamr Test" - aldrig til "Bidhamr ApS" (det rigtige regnskab).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BIDHAMR_CVR, TEST_ORG_NAVN, hentFakturaKonfig, kontrollerOrganisation } from "@/lib/faktura/konfig";
import { FAKTURA_GUL_TIMER, FAKTURA_ROED_TIMER, fakturaLampe } from "@/lib/admin/fakturaLampe";

const TEST_URL = "https://pjiigmzqwlfepxnjdvug.supabase.co";
const PROD_URL = "https://lkifkrexeldimmghnsie.supabase.co";
const NOEGLER = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "STRIPE_SECRET_KEY",
  "DINERO_CLIENT_ID",
  "DINERO_CLIENT_SECRET",
  "DINERO_API_KEY",
  "DINERO_ORG_ID",
  "DINERO_MILJOE",
  "DINERO_LIVE_ORG_ID",
  "DINERO_KONTO_SALG",
  "DINERO_KONTO_FRAGT",
  "DINERO_KONTO_INDBETALING",
] as const;
let gemt: Record<string, string | undefined> = {};

function saet(v: Partial<Record<(typeof NOEGLER)[number], string>>) {
  for (const k of NOEGLER) delete process.env[k];
  Object.assign(process.env, {
    DINERO_CLIENT_ID: "id",
    DINERO_CLIENT_SECRET: "hemmelig",
    DINERO_API_KEY: "noegle",
    DINERO_ORG_ID: "659420",
    ...v,
  });
}

beforeEach(() => {
  gemt = Object.fromEntries(NOEGLER.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of NOEGLER) {
    if (gemt[k] === undefined) delete process.env[k];
    else process.env[k] = gemt[k];
  }
});

describe("kontrollerOrganisation - test sender kun til 'BidHamr Test'", () => {
  const test = (Name: string | null, VatNumber: string | null = null, Id: number | string = 659420) =>
    kontrollerOrganisation("test", "659420", { Id, Name, VatNumber });

  it("godkender BidHamr Test (også med andet store/små bogstaver, mellemrum og et tillæg)", () => {
    expect(TEST_ORG_NAVN).toBe("BidHamr Test");
    expect(test("BidHamr Test")).toBeNull();
    expect(test("  bidhamr   TEST ")).toBeNull();
    expect(test("BidHamr Test Produktion")).toBeNull();
  });
  it("afviser Bidhamr ApS og alle andre navne", () => {
    for (const navn of ["Bidhamr ApS", "BidHamr", "BidHamr Testfirma", "Test BidHamr", "", null]) {
      expect(test(navn)).toMatch(/hedder ikke "BidHamr Test"/);
    }
  });
  it("afviser et regnskab med BidHamrs CVR - også selv om det hedder BidHamr Test", () => {
    expect(test("BidHamr Test", BIDHAMR_CVR)).toMatch(/BidHamrs CVR/);
    expect(test("BidHamr Test", "DK46836219")).toMatch(/BidHamrs CVR/);
    expect(test("Bidhamr ApS", "46 83 62 19")).toMatch(/BidHamrs CVR/);
  });
  it("afviser, når regnskabet ikke findes for nøglen eller har et andet id", () => {
    expect(kontrollerOrganisation("test", "659420", null)).toMatch(/findes ikke/);
    expect(test("BidHamr Test", null, 111)).toMatch(/findes ikke/);
  });
  it("live kræver BidHamrs CVR", () => {
    expect(kontrollerOrganisation("live", "1", { Id: 1, Name: "Bidhamr ApS", VatNumber: BIDHAMR_CVR })).toBeNull();
    expect(kontrollerOrganisation("live", "1", { Id: 1, Name: "BidHamr Test", VatNumber: null })).toMatch(/har ikke BidHamrs CVR/);
  });
});

describe("hentFakturaKonfig - test/live-vagten", () => {
  it("testdatabasen: test er standard; live og DINERO_LIVE_ORG_ID afvises", () => {
    saet({ NEXT_PUBLIC_SUPABASE_URL: TEST_URL, STRIPE_SECRET_KEY: "sk_test_x" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: true, miljoe: "test" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: TEST_URL, DINERO_MILJOE: "" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: true, miljoe: "test" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: TEST_URL, DINERO_MILJOE: "live", DINERO_LIVE_ORG_ID: "659420" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: TEST_URL, DINERO_LIVE_ORG_ID: "659420" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
  });
  it("produktion med Stripe-testnøgle: test kun når det er valgt udtrykkeligt", () => {
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_test_x", DINERO_MILJOE: "test" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: true, miljoe: "test" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "rk_test_x", DINERO_MILJOE: " Test " });
    expect(hentFakturaKonfig()).toMatchObject({ ok: true, miljoe: "test" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_test_x" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_test_x", DINERO_MILJOE: "" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
  });
  it("produktion med Stripes live-nøgle (eller ingen nøgle) kræver live", () => {
    for (const STRIPE_SECRET_KEY of ["sk_live_x", "rk_live_x", "", "noget"]) {
      saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY, DINERO_MILJOE: "test" });
      expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
    }
  });
  it("produktion i test må heller ikke bruge DINERO_LIVE_ORG_ID", () => {
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_test_x", DINERO_MILJOE: "test", DINERO_LIVE_ORG_ID: "659420" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_test_x", DINERO_MILJOE: "test", DINERO_LIVE_ORG_ID: "777" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: true, miljoe: "test" });
  });
  it("live kræver DINERO_ORG_ID = DINERO_LIVE_ORG_ID", () => {
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_live_x", DINERO_MILJOE: "live", DINERO_LIVE_ORG_ID: "777" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: false, grund: "forkert_miljoe" });
    saet({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, STRIPE_SECRET_KEY: "sk_live_x", DINERO_MILJOE: "live", DINERO_LIVE_ORG_ID: "659420" });
    expect(hentFakturaKonfig()).toMatchObject({ ok: true, miljoe: "live" });
  });
});

describe("systemlampen Fakturaer", () => {
  const tom = { ventetGul: 0, ventetRoed: 0, kraeverHandling: 0, aabne: [] as string[] };
  it("grøn, når intet venter", () => {
    expect(fakturaLampe(tom).tone).toBe("groen");
  });
  it("gul ved ventetid over grænsen eller dokumenter, der kræver handling", () => {
    expect(FAKTURA_GUL_TIMER).toBe(2);
    expect(fakturaLampe({ ...tom, ventetGul: 3 })).toMatchObject({ tone: "gul", tekst: "3 dokumenter har ventet over 2 t" });
    expect(fakturaLampe({ ...tom, kraeverHandling: 1 })).toMatchObject({ tone: "gul", tekst: "1 dokument kræver handling" });
  });
  it("rød ved lang ventetid, login-fejl eller forkert opsætning", () => {
    expect(FAKTURA_ROED_TIMER).toBe(6);
    expect(fakturaLampe({ ...tom, ventetGul: 5, ventetRoed: 1 })).toMatchObject({ tone: "roed", tekst: "1 dokument har ventet over 6 t" });
    expect(fakturaLampe({ ...tom, aabne: ["faktura:adgang"] })).toMatchObject({ tone: "roed", tekst: "Dinero afviser login" });
    expect(fakturaLampe({ ...tom, aabne: ["faktura:konfiguration"] }).tone).toBe("roed");
  });
});
