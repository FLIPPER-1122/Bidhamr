// Sporingsfeed i fragt-cron'en (koerSporingsfeed i src/lib/fragt/server.ts):
// det nye token gemmes KUN, når alle hændelser er gemt. Databasen er en
// falsk Supabase-klient, der logger kaldene.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Svar = { data: unknown; error: { message: string } | null };
const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];
let rpcSvar: Record<string, (args: Record<string, unknown>) => Svar> = {};
let forsendelserListe: Svar = { data: [], error: null };
let haendelserListe: Svar = { data: [], error: null };
const tabelKald: string[] = [];

function kaede(tabel: string) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "not", "or", "limit", "gte", "lt", "update", "neq"]) {
    q[m] = () => q;
  }
  q.maybeSingle = async () => ({ data: null, error: null });
  q.single = async () => ({ data: null, error: null });
  q.then = (ok: (v: Svar) => unknown, fejl?: (e: unknown) => unknown) => {
    tabelKald.push(tabel);
    const svar =
      tabel === "forsendelser" ? forsendelserListe : tabel === "forsendelse_haendelser" ? haendelserListe : { data: [], error: null };
    return Promise.resolve(svar).then(ok, fejl);
  };
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

import { koerSporingsfeed, _test } from "@/lib/fragt/server";
import { logDriftFejl } from "@/lib/drift";
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

const LAAS = "6f1c1d2e-0000-4000-8000-000000000001";

beforeEach(() => {
  rpcLog.length = 0;
  tabelKald.length = 0;
  forsendelserListe = { data: [{ id: "F1", sporingsnummer: SN, oprettet_kl: "2026-10-13T10:00:00Z" }], error: null };
  haendelserListe = { data: [], error: null };
  rpcSvar = {
    fragt_sporing_token_claim: () => ({ data: { token: "0", laas: LAAS }, error: null }),
    fragt_sporing_token_gem: () => ({ data: true, error: null }),
    fragt_sporing_token_fejl: () => ({ data: 1, error: null }),
    fragt_ukendt_kode_registrer: () => ({ data: true, error: null }),
    forsendelse_registrer_haendelse: () => ({ data: { ny: true }, error: null }),
    fragt_feed_haendelse_fejl: () => ({ data: { opgivet: false, nu: false }, error: null }),
  };
});

const driftHvor = () => vi.mocked(logDriftFejl).mock.calls.map((c) => String((c[0] as { hvor?: string }).hvor ?? ""));

describe("koerSporingsfeed", () => {
  beforeEach(() => {
    vi.mocked(logDriftFejl).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gemmer hændelserne (ældste først) og DEREFTER det nye token - med vores lås", async () => {
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r).toEqual({ haendelser: 2, nye: 2, ukendte: 1, sprunget: 0, ugyldige: 0, gemt: true });
    const reg = rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse");
    expect(reg.map((x) => x.args.p_noegle)).toEqual([
      `dao:${SN}:10:2026-10-14 08:05:00`,
      `dao:${SN}:11:2026-10-14 09:40:00`,
    ]);
    expect(reg.every((x) => x.args.p_forsendelse === "F1" && x.args.p_kilde === "sporing")).toBe(true);
    const gemIdx = fns().indexOf("fragt_sporing_token_gem");
    expect(gemIdx).toBeGreaterThan(fns().lastIndexOf("forsendelse_registrer_haendelse"));
    expect(rpcLog[gemIdx].args).toMatchObject({ p_fragtfirma: "dao", p_laas: LAAS, p_gammel: "0", p_ny: "1000234" });
    expect(fns()).not.toContain("fragt_sporing_token_fejl");
  });

  it("kendte hændelser slås op samlet og springes over uden et kald pr. hændelse", async () => {
    haendelserListe = { data: [{ forsendelse_id: "F1", noegle: `dao:${SN}:10:2026-10-14 08:05:00` }], error: null };
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.haendelser).toBe(1);
    expect(rpcLog.filter((x) => x.fn === "forsendelse_registrer_haendelse")).toHaveLength(1);
    expect(tabelKald.filter((t) => t === "forsendelse_haendelser")).toHaveLength(1);
    expect(r?.gemt).toBe(true);
  });

  it("databasefejl midt i (ikke poison endnu): tokenet gemmes IKKE", async () => {
    let n = 0;
    rpcSvar.forsendelse_registrer_haendelse = () =>
      ++n === 2 ? { data: null, error: { message: "timeout" } } : { data: { ny: true }, error: null };
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.gemt).toBe(false);
    expect(fns()).toContain("fragt_feed_haendelse_fejl");
    expect(fns()).not.toContain("fragt_sporing_token_gem");
    expect(rpcLog.find((x) => x.fn === "fragt_sporing_token_fejl")?.args.p_laas).toBe(LAAS);
  });

  it("poison event: efter 3 kørsler springes den over, drift alarmeres, og tokenet gemmes", async () => {
    let n = 0;
    rpcSvar.forsendelse_registrer_haendelse = () =>
      ++n === 1 ? { data: null, error: { message: "kaput" } } : { data: { ny: true }, error: null };
    rpcSvar.fragt_feed_haendelse_fejl = () => ({ data: { opgivet: true, nu: true }, error: null });
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r).toMatchObject({ haendelser: 1, sprunget: 1, gemt: true });
    expect(rpcLog.find((x) => x.fn === "fragt_feed_haendelse_fejl")?.args).toMatchObject({ p_forsendelse: "F1", p_maks: 3 });
    expect(driftHvor()).toContain("Fragt: sporingshændelse sprunget over");
  });

  it("kan fejlen ikke engang registreres, er databasen nede: intet springes over", async () => {
    rpcSvar.forsendelse_registrer_haendelse = () => ({ data: null, error: { message: "nede" } });
    rpcSvar.fragt_feed_haendelse_fejl = () => ({ data: null, error: { message: "nede" } });
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.gemt).toBe(false);
    expect(r?.sprunget).toBe(0);
  });

  it("fejl i opslaget på sporingsnumre: tokenet gemmes ikke", async () => {
    forsendelserListe = { data: null, error: { message: "nede" } };
    const r = await koerSporingsfeed(feedFirma(async () => toHaendelser));
    expect(r?.gemt).toBe(false);
    expect(fns()).not.toContain("fragt_sporing_token_gem");
    expect(fns()).not.toContain("forsendelse_registrer_haendelse");
  });

  it("budgettet starter efter hentningen, er aldrig negativt, og opbrugt budget gemmer ikke tokenet", async () => {
    let nu = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nu);
    // En langsom hentning tæller ikke med i budgettet.
    const langsom = feedFirma(async () => {
      nu += 60_000;
      return toHaendelser;
    });
    rpcSvar.forsendelse_registrer_haendelse = () => {
      nu += 10_000; // hver hændelse tager 10 s - over minimumsbudgettet på 3 s
      return { data: { ny: true }, error: null };
    };
    const r = await koerSporingsfeed(langsom, -5_000);
    expect(r?.haendelser).toBe(1);
    expect(r?.gemt).toBe(false);
    expect(fns()).toContain("fragt_sporing_token_fejl");
  });

  it("afkortet svar: tokenet gemmes ikke, og drift alarmeres", async () => {
    const r = await koerSporingsfeed(feedFirma(async () => ({ ...toHaendelser, afkortet: true })));
    expect(r?.gemt).toBe(false);
    expect(fns()).not.toContain("forsendelse_registrer_haendelse");
    expect(driftHvor()).toContain("Fragt: sporingsfeed afkortet");
  });

  it("ulæselige hændelser tælles og alarmeres, men stopper ikke feedet", async () => {
    const r = await koerSporingsfeed(feedFirma(async () => ({ ...toHaendelser, ugyldige: 2 })));
    expect(r).toMatchObject({ ugyldige: 2, gemt: true });
    expect(driftHvor()).toContain("Fragt: ulæselige sporingshændelser");
  });

  it("samme token fejler 12 gange i træk: alarm om, at sporingen står stille", async () => {
    rpcSvar.fragt_sporing_token_fejl = () => ({ data: 12, error: null });
    await koerSporingsfeed(feedFirma(async () => Promise.reject(new Error("timeout"))));
    expect(driftHvor()).toContain("Fragt: sporingsfeed står stille");
  });

  it("fragtfirmaet svarer ikke: fejl registreres, tokenet er uændret", async () => {
    const r = await koerSporingsfeed(feedFirma(async () => Promise.reject(new Error("DAO /TrackNTrace_v2.php: timeout"))));
    expect(r?.gemt).toBe(false);
    expect(fns()).toEqual(["fragt_sporing_token_claim", "fragt_sporing_token_fejl"]);
  });

  it("ikke tid endnu (eller en anden kørsel har låsen): intet kald til fragtfirmaet", async () => {
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

describe("opgivet opret-kald (V2)", () => {
  it("giver kaldet senere en stregkode, registreres den som forældreløs og annulleres", async () => {
    let slip!: (v: unknown) => void;
    const kald = new Promise((ok) => (slip = ok));
    rpcSvar.fragt_foraeldreloes_registrer = () => ({ data: true, error: null });
    rpcSvar.fragt_foraeldreloese_claim = () => ({ data: [], error: null });
    _test.efterOpgivetOpret(falskAdmin as never, "F9", kald as never);
    expect(fns()).not.toContain("fragt_foraeldreloes_registrer");
    slip({ forsendelsesId: "00057099990000477777" });
    await new Promise((r) => setTimeout(r, 10));
    const reg = rpcLog.find((x) => x.fn === "fragt_foraeldreloes_registrer");
    expect(reg?.args).toEqual({ p_forsendelse: "F9", p_forsendelses_id: "00057099990000477777" });
    expect(fns()).toContain("fragt_foraeldreloese_claim");
  });

  it("fejler kaldet senere uden stregkode, sker der intet", async () => {
    const kald = Promise.reject(new Error("timeout"));
    _test.efterOpgivetOpret(falskAdmin as never, "F9", kald as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(fns()).not.toContain("fragt_foraeldreloes_registrer");
  });
});
