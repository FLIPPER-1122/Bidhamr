// Den daglige afstemning (src/lib/betaling/afstemning.ts) mod Stripes
// RIGTIGE testmiljø og testdatabasen, efter alle scenarierne (01-12).
//
// Migrationen 20261019020000_pengeafstemning.sql er IKKE kørt på
// testdatabasen (den kræver chefens ok). Derfor svarer testen selv på de
// fire nye funktioner (penge_afstemning_claim/_afslut, penge_afvigelse_
// registrer, penge_saldo_snapshot_gem) og samler afvigelserne i hukommelsen.
// Alt andet - Stripe-listerne og databasens betalinger, refusioner,
// udbetalinger - er rigtigt. Selve SQL-funktionerne testes i PGlite
// (npm run test:penge:db).
//
// Forventet: refusionen lavet "i dashboardet" i scenarie 03 (og staff's
// manuelle tilbageførsel bagefter) findes; ingen af BidHamrs egne
// betalinger, gebyrer, refusioner eller udbetalinger fra denne kørsel giver
// afvigelser.
import { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { koerPengeafstemning, type Afstemning } from "@/lib/betaling/afstemning";
import { admin, kontekst } from "./handel";

type Reg = { p_noegle: string; p_type: string; p_betaling: string | null; p_stripe_id: string | null };
const registreret: Reg[] = [];
let snapshot: Record<string, unknown> | null = null;
let r: Afstemning;
let koerselsBetalinger: { id: string; titel: string }[] = [];

beforeAll(async () => {
  const ægte = SupabaseClient.prototype.rpc;
  vi.spyOn(SupabaseClient.prototype, "rpc").mockImplementation(function (this: SupabaseClient, fn: string, args?: object) {
    const svar = (data: unknown) => Promise.resolve({ data, error: null, count: null, status: 200, statusText: "OK" });
    if (fn === "penge_afstemning_claim") return svar(1) as never;
    if (fn === "penge_afstemning_afslut") return svar(null) as never;
    if (fn === "penge_afvigelse_registrer") {
      registreret.push(args as Reg);
      return svar(false) as never; // ingen drift-alarm fra testen
    }
    if (fn === "penge_saldo_snapshot_gem") {
      snapshot = args as Record<string, unknown>;
      return svar(true) as never;
    }
    return ægte.call(this, fn as never, args as never) as never;
  } as never);

  // Denne kørsels TEST-handler (titlen indeholder kørslens id).
  const { data: auk } = await admin()
    .from("auctions")
    .select("id, titel")
    .like("titel", `%[${kontekst().koersel}]%`);
  const ids = (auk ?? []).map((a) => a.id as string);
  const { data: bet } = await admin().from("betalinger").select("id, auction_id").in("auction_id", ids);
  const titel = new Map((auk ?? []).map((a) => [a.id as string, a.titel as string]));
  koerselsBetalinger = (bet ?? []).map((b) => ({ id: b.id as string, titel: titel.get(b.auction_id as string) ?? "" }));
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("daglig afstemning med Stripe", () => {
  it("kører hele vejen igennem uden fejl", async () => {
    r = await koerPengeafstemning({ tving: true, vindueDage: 1 });
    expect(r.koert).toBe(1);
    expect(r.betalinger).toBeGreaterThan(0);
    expect(r.gebyrer).toBeGreaterThan(0);
    expect(r.refusioner).toBeGreaterThan(0);
    expect(r.konti).toBeGreaterThan(0);
    expect(r.payouts).toBeGreaterThan(0);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.p_livemode).toBe(false);
  });

  it("finder refusionen og tilbageførslen, der er lavet uden om BidHamr", () => {
    const dashboard = koerselsBetalinger.find((b) => b.titel.includes("refusion-i-dashboardet"));
    expect(dashboard).toBeTruthy();
    const typer = registreret.filter((x) => x.p_betaling === dashboard!.id).map((x) => x.p_type);
    expect(typer).toContain("refusion_udenom");
    expect(typer).toContain("tilbagefoersel_udenom");
  });

  it("ingen afvigelser på BidHamrs egne pengebevægelser i denne kørsel", () => {
    const egne = new Set(koerselsBetalinger.filter((b) => !b.titel.includes("refusion-i-dashboardet")).map((b) => b.id));
    const fund = registreret.filter((x) => x.p_betaling && egne.has(x.p_betaling));
    expect(fund).toEqual([]);
    // Gebyrsummen for de gebyrer, der kunne matches, passer.
    expect(registreret.some((x) => x.p_type === "gebyrsum")).toBe(r.gebyrStripeOere !== r.gebyrDbOere);
  });
});
