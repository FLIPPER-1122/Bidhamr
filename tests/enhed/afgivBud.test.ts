// Den fælles bud-kode (src/lib/bud/afgivBud.ts): buddet indsættes med
// brugerens egen klient, fejlene giver samme danske tekst som før og
// databasens BH-kode til appen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { falskKlient } from "./hjaelpere/falskSupabase";

const BYDER = "22222222-2222-4222-8222-222222222222";
const AUKTION = "55555555-5555-4555-8555-555555555555";

const m = vi.hoisted(() => ({ graense: true, after: vi.fn(), insertFejl: null as null | { code: string; message: string } }));

vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/lib/rateLimit", () => ({ FOR_MANGE_FORSOEG: "For mange forsøg.", tjekGraenser: async () => m.graense }));
vi.mock("@/lib/drift", () => ({ logDriftFejl: vi.fn(async () => {}) }));
vi.mock("@/lib/notifikationer/bud", () => ({ notificerEgetNyesteBud: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    falskKlient((q) => {
      if (q.tabel === "auctions") return { data: { slutter_kl: "2026-10-20T10:00:00Z", "nuværende_bud": 150 }, error: null };
      if (q.tabel === "bids") return { data: { bruger_id: BYDER }, error: null };
      return undefined;
    }).klient,
}));

const { afgivBudFor, saetMaksimumFor } = await import("@/lib/bud/afgivBud");

function brugerKlient() {
  return falskKlient(
    (q) => (q.tabel === "bids" && q.handling === "insert" ? { data: null, error: m.insertFejl } : undefined),
    (navn) => (navn === "saet_maksimum" ? { data: null, error: m.insertFejl } : { data: null, error: null }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.graense = true;
  m.insertFejl = null;
});

describe("afgivBudFor", () => {
  it("indsætter med brugerens egen klient og returnerer status", async () => {
    const k = brugerKlient();
    const r = await afgivBudFor(k.klient as never, BYDER, "ip", AUKTION, 150, true, null);
    expect(r).toEqual({ ok: true, slutterKl: "2026-10-20T10:00:00Z", foerer: true, nuvaerendeBud: 150 });
    expect(k.log[0]).toMatchObject({
      tabel: "bids",
      handling: "insert",
      vaerdi: { auktion_id: AUKTION, bruger_id: BYDER, beløb: 150, beskyttelse: true, auktion_redigeret_kl: null },
    });
    expect(m.after).toHaveBeenCalled();
  });

  it("BH-koder fra databasen og faste koder", async () => {
    const tilfaelde: [{ code: string; message: string }, string][] = [
      [{ code: "BHU03", message: "saelger_frosset: Sælgeren skal ..." }, "BHU03"],
      [{ code: "BHV01", message: "mitid" }, "BHV01"],
      [{ code: "BHV02", message: "vilkaar" }, "BHV02"],
      [{ code: "BHK01", message: "kunst_kontrol: Auktionen afventer ..." }, "BHK01"],
      [{ code: "P0001", message: "own_auction" }, "own_auction"],
      [{ code: "P0001", message: "samme_bud" }, "samme_bud"],
      [{ code: "P0001", message: "minimum_bid: Buddet skal være mindst 160 kr" }, "minimum_bid"],
      [{ code: "BHU05", message: "saelger_spaerret: Der kan ikke bydes på sælgerens auktioner lige nu." }, "BHU05"],
      [{ code: "P0001", message: "noget helt andet" }, "fejl"],
    ];
    for (const [fejl, kode] of tilfaelde) {
      m.insertFejl = fejl;
      const r = await afgivBudFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 150, false);
      expect(r, fejl.message).toMatchObject({ kode });
      expect("fejl" in r && r.fejl.length > 0).toBe(true);
    }
  });

  it("over 500.000 kr.: BHB05; rate limit: for_mange", async () => {
    expect(await afgivBudFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 500_001, false)).toMatchObject({ kode: "BHB05" });
    m.graense = false;
    expect(await afgivBudFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 150, false)).toMatchObject({ kode: "for_mange" });
  });
});

describe("saetMaksimumFor", () => {
  it("fejl fra saet_maksimum: samme tekster, kode til appen", async () => {
    m.insertFejl = { code: "P0001", message: "beskyttelse_laast" };
    expect(await saetMaksimumFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 300, false)).toMatchObject({
      kode: "beskyttelse_laast",
      fejl: "Du fører allerede. BidHamr Beskyttelse følger dit bud og kan ikke ændres, mens du fører.",
    });
    m.insertFejl = { code: "P0001", message: "maks_for_lavt: Dit maksimum skal være mindst 200 kr" };
    expect(await saetMaksimumFor(brugerKlient().klient as never, BYDER, "ip", AUKTION, 100, false)).toMatchObject({
      kode: "maks_for_lavt",
      fejl: "Dit maksimum skal være mindst 200 kr.",
    });
  });
});
