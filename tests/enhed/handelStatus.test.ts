// hentHandelAppStatus (src/lib/handel/handelStatus.ts) - data til appens
// /api/handel/app/status fra de samme funktioner, handelssiden bruger.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { falskKlient } from "./hjaelpere/falskSupabase";

const KOEBER = "22222222-2222-4222-8222-222222222222";
const HANDEL = "44444444-4444-4444-8444-444444444444";

const m = vi.hoisted(() => ({
  ubetalt: null as null | { aarsag: string },
  betalingStatus: "annulleret",
  sag: false,
  afsendelse: vi.fn(),
  afhentning: vi.fn(),
  ikkeAfhentet: vi.fn(),
  betalingsstatus: vi.fn(),
  labels: true,
  retur: false,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    falskKlient((q) => {
      if (q.tabel === "ubetalte_vindere") return { data: m.ubetalt ? { id: "u", ...m.ubetalt } : null, error: null };
      if (q.tabel === "betalinger") return { data: { status: m.betalingStatus }, error: null };
      if (q.tabel === "sager") return { data: m.sag ? [{ id: "s" }] : [], error: null };
      return undefined;
    }).klient,
}));
vi.mock("@/lib/betaling/afsendelsesfrist", () => ({ hentAfsendelsesfristAnnullering: m.afsendelse }));
vi.mock("@/lib/betaling/afhentningsfrist", () => ({ hentAfhentningsfristAnnullering: m.afhentning }));
vi.mock("@/lib/betaling/ikkeAfhentet", () => ({ hentIkkeAfhentet: m.ikkeAfhentet }));
vi.mock("@/lib/betaling/betalingsstatus", () => ({ hentBetalingsstatusFor: m.betalingsstatus }));
vi.mock("@/lib/fragt", () => ({ fragtLabelsAktiv: () => m.labels, fragtReturlabelAktiv: () => m.retur }));

const { hentHandelAppStatus } = await import("@/lib/handel/handelStatus");

const status = (s: string, afhentning = false) => hentHandelAppStatus({} as never, KOEBER, { id: HANDEL, status: s, afhentning });

beforeEach(() => {
  vi.clearAllMocks();
  m.ubetalt = null;
  m.betalingStatus = "annulleret";
  m.sag = false;
  m.afsendelse.mockResolvedValue(null);
  m.afhentning.mockResolvedValue(null);
  m.ikkeAfhentet.mockResolvedValue(null);
});

describe("hentHandelAppStatus", () => {
  it("ikke annulleret: annullering null; fragt-flagene", async () => {
    expect(await status("pakke_sendt")).toEqual({ annullering: null, betaling: null, fragt: { labelsAktiv: true, returlabelAktiv: false } });
  });

  it("afventer betaling: sidsteFejl kun for køberen", async () => {
    m.betalingsstatus.mockResolvedValue({ ok: true, erKoeber: true, sidsteFejl: "Betalingen kunne ikke gennemføres." });
    expect((await status("afventer_betaling")).betaling).toEqual({ sidsteFejl: true });
    m.betalingsstatus.mockResolvedValue({ ok: true, erKoeber: false });
    expect((await status("afventer_betaling")).betaling).toEqual({ sidsteFejl: false });
    m.betalingsstatus.mockResolvedValue({ fejl: "Betalingen findes ikke." });
    expect((await status("afventer_betaling")).betaling).toBeNull();
  });

  it("årsagerne i samme rækkefølge som handelssiden", async () => {
    m.ubetalt = { aarsag: "ubetalt" };
    expect((await status("annulleret")).annullering).toEqual({ aarsag: "ubetalt", refunderet: false });
    m.ubetalt = { aarsag: "admin_annulleret" };
    expect((await status("annulleret")).annullering?.aarsag).toBe("admin_annulleret");
    m.ubetalt = null;
    m.afsendelse.mockResolvedValue({ annulleretKl: "x", refunderet: true });
    expect((await status("annulleret")).annullering).toEqual({ aarsag: "afsendelsesfrist", refunderet: true });
    m.afsendelse.mockResolvedValue(null);
    m.afhentning.mockResolvedValue({ annulleretKl: "x", refunderet: false });
    expect((await status("annulleret", true)).annullering).toEqual({ aarsag: "afhentningsfrist", refunderet: false });
    m.ikkeAfhentet.mockResolvedValue({ refunderet: true });
    expect((await status("annulleret")).annullering).toEqual({ aarsag: "ikke_afhentet", refunderet: true });
    m.ikkeAfhentet.mockResolvedValue(null);
    m.sag = true;
    m.betalingStatus = "refunderet";
    expect((await status("annulleret")).annullering).toEqual({ aarsag: "sag", refunderet: true });
    m.sag = false;
    expect((await status("annulleret")).annullering).toEqual({ aarsag: null, refunderet: true });
  });
});
