// Sporingsfeed i fragt-cron'en (koerSporingsfeed i src/lib/fragt/server.ts):
// det nye token gemmes KUN, når alle hændelser er gemt. Databasen er en
// falsk Supabase-klient, der logger kaldene.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Svar = { data: unknown; error: { message: string } | null };
const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];
let rpcSvar: Record<string, (args: Record<string, unknown>) => Svar> = {};
let forsendelserListe: Svar = { data: [], error: null };

function kaede(tabel: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "not", "or", "limit", "gte", "lt", "update", "neq"]) {
    q[m] = () => q;
  }
  q.maybeSingle = async () => ({ data: null, error: null });
  q.single = async () => ({ data: null, error: null });
  q.then = (ok: (v: Svar) => unknown, fejl?: (e: unknown) => unknown) =>
    Promise.resolve(tabel === "forsendelser" ? forsendelserListe : { data: [], error: null }).then(ok, fejl);
  return q;
}

const falskAdmin = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcLog.push({ fn, args });
    return rpcSvar[fn]?.(args) ?? { data: null, error: null };
  },
  from: (tabel: string) => kaede(tabel),
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => falskAdmin }));
vi.mock("@/lib/drift", () => ({
  logDriftFejl: vi.fn(async () => "ny"),
  renFejltekst: (e: unknown) => String(e instanceof Error ? e.message : e),
}));
vi.mock("@/lib/notifikationer/send", () => ({ send: vi.fn(async () => undefined) }));
vi.mock("@/lib/betaling/stripeBetaling", () => ({ annullerPaymentIntentForLevering: vi.fn() }));

import { koerSporingsfeed } from "@/lib/fragt/server";
import type { Fragtfirma, SporingsFeed } from "@/lib/fragt/types";

const SN = "00057099990000412345";

function feedFirma(feed: () => Promise<SporingsFeed>): Fragtfirma & { kaldt: number } {
  const f = {
    kaldt: 0,
    navn: "dao",
    visningsnavn: "DAO",
    erSatOp: () => true,
    async hentSporingFeed() {
      f.kaldt++;
      return feed();
    },
  } as unknown as Fragtfirma & { kaldt: number };
  return f;
}

const toHaendelser: SporingsFeed = {
  nyToken: "1000234",
  haendelser: [
    { type: "i_transit", tidspunkt: "2026-10-14T07:40:00.000Z", noegle: `dao:${SN}:11:2026-10-14 09:40:00`, sporingsnummer: SN },
    { type: "i_transit", tidspunkt: "2026-10-14T06:05:00.000Z", noegle: `dao:${SN}:10:2026-10-14 08:05:00`, sporingsnummer: SN },
    // Ikke vores pakke (fx forældreløs) - springes over.
    { type: "i_transit", tidspunkt: "2026-10-14T06:05:00.000Z", noegle: "dao:FREMMED123456:10:x", sporingsnummer: "FREMMED123456" },
  ],
  ukendte: [{ kode: "77", liste: null, beskrivelse: "x", sporingsnummer: SN }],
};

const fns = () => rpcLog.map((r) => r.fn);

beforeEach(() => {
  rpcLog.length = 0;
  forsendelserListe = { data: [{ id: "F1", sporingsnummer: SN, oprettet_kl: "2026-10-13T10:00:00Z" }], error: null };
  rpcSvar = {
    fragt_sporing_token_claim: () => ({ data: "0", error: null }),
    fragt_sporing_token_gem: () => ({ data: true, error: null }),
    fragt_sporing_token_fejl: () => ({ data: 1, error: null }),
    fragt_ukendt_kode_registrer: () => ({ data: true, error: null }),
    forsendelse_registrer_haendelse: () => ({ data: { ny: true }, error: null }),
  };
});

describe("koerSporingsfeed", () => {
  it("gemmer hændelserne (ældste først) og DEREFTER det nye token", async () => {
    const firma = feedFirma(async () => toHaendelser);
    const r = await koerSporingsfeed(firma);
    expect(r).toEqual({ haendelser: 2, nye: 2, ukendte: 1, gemt: true });
    const reg = rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse");
    expect(reg.map((x) => x.args.p_noegle)).toEqual([
      `dao:${SN}:10:2026-10-14 08:05:00`,
      `dao:${SN}:11:2026-10-14 09:40:00`,
    ]);
    expect(reg.every((x) => x.args.p_forsendelse === "F1" && x.args.p_kilde === "sporing")).toBe(true);
    const gemIdx = fns().indexOf("fragt_sporing_token_gem");
    expect(gemIdx).toBeGreaterThan(fns().lastIndexOf("forsendelse_registrer_haendelse"));
    expect(rpcLog[gemIdx].args).toMatchObject({ p_fragtfirma: "dao", p_gammel: "0", p_ny: "1000234" });
    expect(fns()).not.toContain("fragt_sporing_token_fejl");
  });

  it("databasefejl midt i: tokenet gemmes IKKE (næste kørsel henter dem igen)", async () => {
    let n = 0;
    rpcSvar.forsendelse_registrer_haendelse = () =>
      ++n === 2 ? { data: null, error: { message: "timeout" } } : { data: { ny: true }, error: null };
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.gemt).toBe(false);
    expect(fns()).not.toContain("fragt_sporing_token_gem");
    expect(fns()).toContain("fragt_sporing_token_fejl");
  });

  it("fejl i opslaget på sporingsnumre: tokenet gemmes ikke", async () => {
    forsendelserListe = { data: null, error: { message: "nede" } };
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.gemt).toBe(false);
    expect(fns()).not.toContain("fragt_sporing_token_gem");
    expect(fns()).not.toContain("forsendelse_registrer_haendelse");
  });

  it("tidsbudgettet slap op: tokenet gemmes ikke", async () => {
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser), -1);
    expect(r?.gemt).toBe(false);
    expect(fns()).not.toContain("fragt_sporing_token_gem");
    expect(fns()).toContain("fragt_sporing_token_fejl");
  });

  it("fragtfirmaet svarer ikke: fejl registreres, tokenet er uændret", async () => {
    const r = await koerSporingsfeed(feedFirma(async () => Promise.reject(new Error("DAO /TrackNTrace_v2.php: timeout"))));
    expect(r?.gemt).toBe(false);
    expect(fns()).toEqual(["fragt_sporing_token_claim", "fragt_sporing_token_fejl"]);
  });

  it("ikke tid endnu (eller en anden kørsel er i gang): intet kald til fragtfirmaet", async () => {
    rpcSvar.fragt_sporing_token_claim = () => ({ data: null, error: null });
    const firma = feedFirma(async () => toHaendelser);
    expect(await koerSporingsfeed(firma)).toBeNull();
    expect(firma.kaldt).toBe(0);
  });

  it("ikke sat op (ingen nøgler): intet sker", async () => {
    const firma = feedFirma(async () => toHaendelser);
    (firma as { erSatOp: () => boolean }).erSatOp = () => false;
    expect(await koerSporingsfeed(firma)).toBeNull();
    expect(rpcLog).toHaveLength(0);
  });

  it("ukendte koder: drift kun første gang (databasen svarer false bagefter)", async () => {
    rpcSvar.fragt_ukendt_kode_registrer = () => ({ data: false, error: null });
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.ukendte).toBe(0);
    expect(r?.gemt).toBe(true);
  });
});
