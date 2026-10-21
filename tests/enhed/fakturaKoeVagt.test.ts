// Fakturakøen (src/lib/faktura/koe.ts) håndhæver regnskabs-vagten: i test
// sendes der kun til Dinero-regnskabet "BidHamr Test" - aldrig til "Bidhamr
// ApS" (Filip, 20. okt. 2026). Falsk database og falsk Dinero (fetch) - intet
// netværk.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcKald: string[] = [];
const alarmer: string[] = [];
const lukket: string[] = [];

// Fluent falsk Supabase-forespørgsel: alle filtre giver sig selv; await giver
// tomme svar.
function forespoergsel() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "lt", "limit", "neq", "or", "order", "maybeSingle"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown) => ok({ data: [], error: null, count: 0 });
  return q;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => forespoergsel(),
    rpc: async (navn: string) => {
      rpcKald.push(navn);
      if (navn.startsWith("faktura_planlaeg")) return { data: { fakturaer: 0, kreditnotaer: 0 }, error: null };
      return { data: [], error: null };
    },
  }),
}));
vi.mock("@/lib/drift", () => ({ logDriftFejl: async () => null }));
vi.mock("@/lib/betaling/driftTilfaelde", () => ({
  alarmPrTilfaelde: async (o: { noegle: string; fejl: string }) => {
    alarmer.push(`${o.noegle}: ${o.fejl}`);
    return true;
  },
  lukTilfaelde: async (n: string) => {
    lukket.push(n);
  },
}));

let organisationer: { Id: number; Name: string; VatNumber: string | null }[] = [];
const dineroKald: string[] = [];

beforeEach(() => {
  vi.resetModules();
  rpcKald.length = 0;
  alarmer.length = 0;
  lukket.length = 0;
  dineroKald.length = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://pjiigmzqwlfepxnjdvug.supabase.co");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("DINERO_CLIENT_ID", "id");
  vi.stubEnv("DINERO_CLIENT_SECRET", "hemmelig");
  vi.stubEnv("DINERO_API_KEY", "noegle");
  vi.stubEnv("DINERO_ORG_ID", "659420");
  vi.stubEnv("DINERO_MILJOE", "");
  vi.stubEnv("DINERO_LIVE_ORG_ID", "");
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    dineroKald.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("oauth/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith("/v1.1/organizations")) return new Response(JSON.stringify(organisationer), { status: 200 });
    return new Response("{}", { status: 500 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fakturakøen sender kun til BidHamr Test", () => {
  it("DINERO_ORG_ID peger på Bidhamr ApS: intet claimes eller sendes, og der gives alarm", async () => {
    organisationer = [{ Id: 659420, Name: "Bidhamr ApS", VatNumber: null }];
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const r = await koerFakturaKoe();
    expect(r.springetOver).toBe("ikke_konfigureret");
    expect(rpcKald).not.toContain("faktura_claim");
    expect(dineroKald.filter((k) => k.startsWith("POST https://api.dinero.dk"))).toEqual([]);
    expect(alarmer.some((a) => a.startsWith("faktura:konfiguration:") && a.includes('hedder ikke "BidHamr Test"'))).toBe(true);
    expect(lukket).not.toContain("faktura:konfiguration");
    expect(r.grund).toBe("konfiguration: regnskab afvist");
    // Login lykkedes: faktura:adgang lukkes, så lampen viser den rigtige fejl.
    expect(lukket).toContain("faktura:adgang");
  });
  it("regnskabet har BidHamrs CVR: intet sendes", async () => {
    organisationer = [{ Id: 659420, Name: "BidHamr Test", VatNumber: "46836219" }];
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const r = await koerFakturaKoe();
    expect(r.springetOver).toBe("ikke_konfigureret");
    expect(rpcKald).not.toContain("faktura_claim");
  });
  it("Dinero afviser login: alarmen faktura:adgang, intet claimes", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 400 }));
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const r = await koerFakturaKoe();
    expect(r.springetOver).toBe("adgang");
    expect(r.grund).toBe("adgang: 400 login");
    expect(rpcKald).not.toContain("faktura_claim");
    expect(alarmer.some((a) => a.startsWith("faktura:adgang:"))).toBe(true);
    expect(lukket).not.toContain("faktura:adgang");
  });
  it("Dinero afviser login med 401: springetOver og grund kommer med i cron-resultatet", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }));
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const { kortResultat } = await import("@/lib/driftCronResultat");
    const r = await koerFakturaKoe();
    const gemt = kortResultat({ fakturaer: r }) as { fakturaer: Record<string, unknown> };
    expect(gemt.fakturaer).toEqual({ behandlet: 0, faerdige: 0, fejl: 0, stoppet: 0, springetOver: "adgang", grund: "adgang: 401 login" });
  });
  it("Dinero virker igen efter et afvist login: faktura:adgang lukkes", async () => {
    organisationer = [{ Id: 659420, Name: "BidHamr Test", VatNumber: null }];
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    await koerFakturaKoe();
    expect(lukket).toContain("faktura:adgang");
  });
  it("Dinero svarer midlertidigt ikke: kørslen springes over uden alarm, intet claimes", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("oauth/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      return new Response("{}", { status: 503 });
    });
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const r = await koerFakturaKoe();
    expect(r.springetOver).toBe("forbigaaende");
    expect(r.grund).toBe("forbigaaende: 503");
    expect(rpcKald).not.toContain("faktura_claim");
    expect(alarmer).toEqual([]);
    expect(lukket).not.toContain("faktura:konfiguration");
  });
  it("produktion med Stripe-testnøgle og DINERO_MILJOE=live: intet sendes, og der gives alarm", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://lkifkrexeldimmghnsie.supabase.co");
    vi.stubEnv("DINERO_MILJOE", "live");
    vi.stubEnv("DINERO_LIVE_ORG_ID", "659420");
    organisationer = [{ Id: 659420, Name: "Bidhamr ApS", VatNumber: "46836219" }];
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const r = await koerFakturaKoe();
    expect(r.springetOver).toBe("ikke_konfigureret");
    expect(r.grund).toBe("konfiguration: forkert_miljoe");
    expect(rpcKald).not.toContain("faktura_claim");
    expect(dineroKald).toEqual([]);
    expect(alarmer.some((a) => a.startsWith("faktura:konfiguration:") && a.includes("live-nøgle"))).toBe(true);
  });
  it("BidHamr Test: køen fortsætter (claim)", async () => {
    organisationer = [
      { Id: 1, Name: "Bidhamr ApS", VatNumber: "46836219" },
      { Id: 659420, Name: "BidHamr Test", VatNumber: null },
    ];
    const { koerFakturaKoe } = await import("@/lib/faktura/koe");
    const r = await koerFakturaKoe();
    expect(r.springetOver).toBeUndefined();
    expect(rpcKald).toContain("faktura_claim");
    expect(lukket).toContain("faktura:konfiguration");
  });
});
