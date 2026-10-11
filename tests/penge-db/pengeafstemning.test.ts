// Migrationen 20261019020000_pengeafstemning.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). En stub af de tabeller og
// funktioner, migrationen bygger på, oprettes først; derefter køres
// migrationen TO gange (skal kunne køres flere gange), og funktionerne testes.
// Også de rene regler i afstemning.ts og CSV'en (pengeOekonomi.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvKr, maanedInterval, pengeCsv } from "@/lib/admin/pengeOekonomi";
import {
  erBidhamrsRefusion,
  forventetGebyrRefunderet,
  forventetTilbagefoert,
  payoutAfstemmes,
  payoutStatusPasser,
  TRIN,
  trinRaekkefoelge,
} from "@/lib/betaling/afstemning";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261019020000_pengeafstemning.sql"),
  "utf8",
);

const CHEF = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000002";

const STUB = `
create role anon; create role authenticated; create role service_role;
-- Som Supabase: nye tabeller giver som standard alle rettigheder til rollerne.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.users (id uuid primary key, rolle text not null default 'bruger');
insert into public.users values ('${CHEF}', 'chef'), ('${ADMIN}', 'admin');
create function public.staff_chat_har_rolle(p uuid, r text) returns boolean language sql as
  $$ select exists (select 1 from public.users u where u.id = p and
       case r when 'chef' then u.rolle = 'chef' when 'admin' then u.rolle in ('admin','chef') else u.rolle in ('medarbejder','admin','chef') end) $$;
create function public.betalinger_forbyd_sletning() returns trigger language plpgsql as
  $$ begin raise exception 'Handelsdata må ikke slettes'; end $$;
create table public.auctions (id uuid primary key default gen_random_uuid(), titel text);
create table public.betalinger (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null default gen_random_uuid(), auction_id uuid,
  pengemodel text not null default 'destination', status text not null default 'betalt',
  bud_oere bigint not null default 0,
  total_oere bigint not null, udbetaling_oere bigint not null, application_fee_oere bigint,
  koebergebyr_oere bigint not null default 0, saelgergebyr_oere bigint not null default 0,
  beskyttelse_oere bigint not null default 0, fragt_oere bigint not null default 0,
  refusion_oere bigint, refusion_gebyr_oere bigint, gebyr_refunderet_kl timestamptz,
  refusion_tilbagefoert_kl timestamptz, refunderet_kl timestamptz,
  indsigelse_kl timestamptz, indsigelse_status text, indsigelse_tabt_afklaret text,
  indsigelse_tabt_afklaret_kl timestamptz, indsigelse_tabt_kl timestamptz,
  indsigelse_tilbagefoersel_id text, indsigelse_tilbagefoert_oere bigint, indsigelse_tilbagefoert_kl timestamptz,
  saelger_udbetaling_id uuid, saelger_stripe_konto text, betalt_kl timestamptz,
  stripe_payment_intent_id text, stripe_fee_refund_id text, refusion_tilbagefoersel_id text,
  stripe_refund_id text, stripe_dispute_id text, opdateret timestamptz not null default now(),
  -- Sikkerhedsnet A (20261019010000): "BidHamr dækker".
  bidhamr_daekker_kl timestamptz, bidhamr_daekker_oere bigint, bidhamr_daekker_refund_id text,
  bidhamr_daekker_refunderet_kl timestamptz);
create table public.saelger_udbetalinger (
  id uuid primary key default gen_random_uuid(), stripe_konto text, status text not null,
  beloeb_oere bigint not null, stripe_payout_id text, oprettet timestamptz not null default now(),
  oprettet_hos_stripe_kl timestamptz, fejlet_kl timestamptz);
create table public.betaling_afvigelser (
  id uuid primary key default gen_random_uuid(), betaling_id uuid, trade_id uuid,
  stripe_payment_intent_id text, stripe_charge_id text, modtaget_oere bigint not null,
  stripe_refund_id text, refunderet_kl timestamptz, oprettet timestamptz not null default now());
`;

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("opretter én konfiguration - reserven er slået FRA med 0 %", async () => {
    const k = await en<{ n: number; slaaet_til: boolean; procent: string }>(
      "select count(*)::int as n, bool_or(reserve_slaaet_til) as slaaet_til, max(reserve_procent)::text as procent from public.penge_konfiguration",
    );
    expect(k.n).toBe(1);
    expect(k.slaaet_til).toBe(false);
    expect(Number(k.procent)).toBe(0);
  });

  it("kun service role har adgang; anon og authenticated intet", async () => {
    for (const t of ["penge_konfiguration", "penge_afstemning_koersler", "penge_afstemning_afvigelser", "penge_saldo_snapshot", "penge_konfiguration_historik"]) {
      const r = await en<{ a: boolean; u: boolean; s: boolean }>(
        `select has_table_privilege('anon', 'public.${t}', 'select') as a,
                has_table_privilege('authenticated', 'public.${t}', 'select') as u,
                has_table_privilege('service_role', 'public.${t}', 'select') as s`,
      );
      expect([t, r.a, r.u, r.s]).toEqual([t, false, false, true]);
    }
    for (const f of [
      "penge_afstemning_claim(integer)",
      "admin_penge_reserve(uuid, bigint)",
      "admin_penge_posteringer(uuid, timestamptz, timestamptz, integer)",
      "admin_penge_konfiguration_gem(uuid, boolean, numeric, integer, bigint, bigint)",
    ]) {
      const r = await en<{ a: boolean; u: boolean; s: boolean }>(
        `select has_function_privilege('anon', 'public.${f}', 'execute') as a,
                has_function_privilege('authenticated', 'public.${f}', 'execute') as u,
                has_function_privilege('service_role', 'public.${f}', 'execute') as s`,
      );
      expect([f, r.a, r.u, r.s]).toEqual([f, false, false, true]);
    }
  });
});

describe("kørslen", () => {
  it("claim: én kørsel ad gangen, højst én pr. interval", async () => {
    const a = await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id");
    expect(a.id).not.toBeNull();
    const b = await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id");
    expect(b.id).toBeNull();
    await db.query("select public.penge_afstemning_afslut($1, true, null, '{\"gebyrer\": 3}'::jsonb)", [a.id]);
    // Afsluttet inden for intervallet: stadig ingen ny.
    expect((await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id")).id).toBeNull();
    // Tvunget (0 timer): ny kørsel.
    expect((await en<{ id: string | null }>("select public.penge_afstemning_claim(0) as id")).id).not.toBeNull();
  });

  it("afvigelser: ny -> alarm, kendt -> ingen ny alarm, løst og igen -> ny alarm", async () => {
    const k = (await en<{ id: string }>("select public.penge_afstemning_claim(0) as id")).id;
    const reg = (n: string) =>
      en<{ ny: boolean }>(
        "select public.penge_afvigelse_registrer($1, $2, 'refusion_udenom', 're_1', null, null, 'Refusion uden om BidHamr', 100, null) as ny",
        [k, n],
      );
    expect((await reg("refusion:re_1")).ny).toBe(true);
    expect((await reg("refusion:re_1")).ny).toBe(false);
    const a = await en<{ id: string; antal_set: number }>("select id, antal_set from public.penge_afstemning_afvigelser where noegle = 'refusion:re_1'");
    expect(a.antal_set).toBe(2);
    expect((await en<{ r: string }>("select public.admin_penge_afvigelse_loes($1, $2, 'ok') as r", [ADMIN, a.id])).r).toBe("ingen_adgang");
    expect((await en<{ r: string }>("select public.admin_penge_afvigelse_loes($1, $2, '  ') as r", [CHEF, a.id])).r).toBe("note_mangler");
    expect((await en<{ r: string }>("select public.admin_penge_afvigelse_loes($1, $2, 'Tjekket i Stripe') as r", [CHEF, a.id])).r).toBe("ok");
    expect((await en<{ r: string }>("select public.admin_penge_afvigelse_loes($1, $2, 'igen') as r", [CHEF, a.id])).r).toBe("ikke_fundet");
    const k2 = (await en<{ id: string }>("select public.penge_afstemning_claim(0) as id")).id;
    const igen = await en<{ ny: boolean }>(
      "select public.penge_afvigelse_registrer($1, 'refusion:re_1', 'refusion_udenom', 're_1', null, null, 'Stadig forkert', 100, null) as ny",
      [k2],
    );
    expect(igen.ny).toBe(true);
    const efter = await en<{ loest_kl: string | null }>("select loest_kl from public.penge_afstemning_afvigelser where noegle = 'refusion:re_1'");
    expect(efter.loest_kl).toBeNull();
    await expect(db.query("delete from public.penge_afstemning_afvigelser")).rejects.toThrow(/slettes/);
  });

  it("snapshot fra admin: højst ét pr. 10 minutter; afstemningen altid", async () => {
    const g = (kilde: string) =>
      en<{ ok: boolean }>("select public.penge_saldo_snapshot_gem($1, false, 1000, 200, null, null) as ok", [kilde]);
    expect((await g("admin")).ok).toBe(true);
    expect((await g("admin")).ok).toBe(false);
    expect((await g("afstemning")).ok).toBe(true);
    expect((await g("afstemning")).ok).toBe(true);
  });
});

describe("overblikket (admin_penge_reserve)", () => {
  beforeAll(async () => {
    await db.exec(`
      -- Betalt, ikke udbetalt: sælgerens 475 kr. står på hans konto.
      insert into public.betalinger (total_oere, udbetaling_oere, application_fee_oere, fragt_oere, betalt_kl, saelger_stripe_konto)
      values (59000, 47500, 11500, 4000, now() - interval '1 day', 'acct_a');
      -- Refusion i gang: sælgerens del er tilbageført, køberen ikke refunderet endnu.
      insert into public.betalinger (total_oere, udbetaling_oere, application_fee_oere, refusion_oere, refusion_gebyr_oere,
                                     gebyr_refunderet_kl, refusion_tilbagefoert_kl, betalt_kl, saelger_stripe_konto)
      values (25000, 19000, 6000, 25000, 6000, now(), now(), now() - interval '2 days', 'acct_a');
      -- Åben indsigelse.
      insert into public.betalinger (total_oere, udbetaling_oere, application_fee_oere, indsigelse_kl, indsigelse_status,
                                     betalt_kl, saelger_stripe_konto, saelger_udbetaling_id)
      values (10000, 9500, 500, now(), 'needs_response', now() - interval '3 days', 'acct_b', gen_random_uuid());
      -- Tabt efter udbetaling: BidHamr bærer sælgerens del + fragt (95 + 40).
      insert into public.betalinger (total_oere, udbetaling_oere, application_fee_oere, fragt_oere, indsigelse_kl, indsigelse_status,
                                     indsigelse_tabt_afklaret, indsigelse_tabt_afklaret_kl, betalt_kl, saelger_stripe_konto, saelger_udbetaling_id)
      values (14500, 9500, 5000, 4000, now(), 'lost', 'udbetalt', now(), now() - interval '5 days', 'acct_b', gen_random_uuid());
      insert into public.saelger_udbetalinger (stripe_konto, status, beloeb_oere, stripe_payout_id) values ('acct_b', 'oprettet', 9500, 'po_1');
    `);
  });

  it("reserven er slået fra: ingen reserve i svaret, kan trækkes ud = saldo - refusioner i gang", async () => {
    const r = (await en<{ r: Record<string, unknown> }>("select public.admin_penge_reserve($1, 100000) as r", [CHEF])).r as {
      reserve: unknown;
      saelgere: { oere: number; antal_handler: number };
      skylder_koebere_oere: number;
      kan_traekkes_ud_oere: number;
      paa_vej_til_bank: { oere: number };
      aabne_indsigelser_oere: number;
      tab_efter_udbetaling: { oere: number };
    };
    expect(r.reserve).toBeNull();
    // 475 kr. (den betalte) + 0 (refusion: tilbageført) = 475 kr.
    expect(Number(r.saelgere.oere)).toBe(47_500);
    expect(Number(r.skylder_koebere_oere)).toBe(25_000);
    expect(Number(r.kan_traekkes_ud_oere)).toBe(100_000 - 25_000);
    expect(Number(r.paa_vej_til_bank.oere)).toBe(9_500);
    expect(Number(r.aabne_indsigelser_oere)).toBe(10_000);
    expect(Number(r.tab_efter_udbetaling.oere)).toBe(13_500);
  });

  it("kun chef kan slå reserven til; ugyldige værdier afvises", async () => {
    expect((await en<{ r: string }>("select public.admin_penge_konfiguration_gem($1, true, 10, 90, 0, 0) as r", [ADMIN])).r).toBe("ingen_adgang");
    expect((await en<{ r: string }>("select public.admin_penge_konfiguration_gem($1, true, 101, 90, 0, 0) as r", [CHEF])).r).toBe("ugyldig");
    expect((await en<{ r: string }>("select public.admin_penge_konfiguration_gem($1, true, 10, 3, 0, 0) as r", [CHEF])).r).toBe("ugyldig");
    expect((await en<{ r: string }>("select public.admin_penge_konfiguration_gem($1, true, 10, 90, 0, 5000) as r", [CHEF])).r).toBe("ok");
    const h = await en<{ n: number }>("select count(*)::int as n from public.penge_konfiguration_historik");
    expect(h.n).toBe(1);
  });

  it("slået til: mindst åbne indsigelser + forventede tab; tab efter udbetaling trækkes fra", async () => {
    const r = (await en<{ r: Record<string, unknown> }>("select public.admin_penge_reserve($1, 100000) as r", [CHEF])).r as {
      gebyrer_periode_oere: number;
      reserve: { procent_oere: number; minimum_oere: number; reserve_oere: number; brugt_paa_tab_oere: number; tilbage_oere: number };
      kan_traekkes_ud_oere: number;
    };
    // Gebyrer: 11500 + (6000 - 6000) + 500 + 5000 = 17000; 10 % = 1700.
    expect(Number(r.gebyrer_periode_oere)).toBe(17_000);
    expect(Number(r.reserve.procent_oere)).toBe(1_700);
    // Åbne indsigelser 10000 + forventet tab 5000 = 15000 > 1700.
    expect(Number(r.reserve.minimum_oere)).toBe(15_000);
    expect(Number(r.reserve.reserve_oere)).toBe(15_000);
    expect(Number(r.reserve.brugt_paa_tab_oere)).toBe(13_500);
    expect(Number(r.reserve.tilbage_oere)).toBe(1_500);
    expect(Number(r.kan_traekkes_ud_oere)).toBe(100_000 - 25_000 - 1_500);
    // Uden en saldo fra Stripe bruges seneste snapshot (afstemningen: 1000).
    const s = (await en<{ r: { kan_traekkes_ud_oere: number } }>("select public.admin_penge_reserve($1, null) as r", [CHEF])).r;
    expect(Number(s.kan_traekkes_ud_oere)).toBe(0);
    await db.query("select public.admin_penge_konfiguration_gem($1, false, 0, 90, 0, 0)", [CHEF]);
  });
});

describe("posteringer", () => {
  it("giver betaling, gebyr-refusion, tilbageførsel, udbetaling og tab i tidsorden", async () => {
    const r = (await en<{ r: { type: string; bidhamr_oere: number; beloeb_oere: number }[] }>(
      "select public.admin_penge_posteringer($1, now() - interval '30 days', now() + interval '1 day', 100) as r",
      [CHEF],
    )).r;
    const typer = r.map((x) => x.type);
    expect(typer).toContain("betaling");
    expect(typer).toContain("gebyr_refusion");
    expect(typer).toContain("tilbagefoersel");
    expect(typer).toContain("indsigelse");
    expect(typer).toContain("indsigelse_tab");
    const tab = r.find((x) => x.type === "indsigelse_tab")!;
    expect(Number(tab.bidhamr_oere)).toBe(-13_500);
    const tilbage = r.find((x) => x.type === "tilbagefoersel")!;
    expect(Number(tilbage.beloeb_oere)).toBe(19_000 + 6_000);
    expect((await en<{ r: unknown[] }>("select public.admin_penge_posteringer($1, null, null, 2) as r", [CHEF])).r.length).toBe(2);
  });
});

describe("rene regler", () => {
  it("forventet gebyr-refusion og tilbageførsel (som refusion.ts og udbetaling.ts)", () => {
    expect(forventetGebyrRefunderet({ gebyr_refunderet_kl: null, refusion_gebyr_oere: 900 })).toBe(0);
    expect(forventetGebyrRefunderet({ gebyr_refunderet_kl: "x", refusion_gebyr_oere: 900 })).toBe(900);
    const b = {
      refusion_tilbagefoert_kl: "x",
      udbetaling_oere: 47_500,
      refusion_gebyr_oere: 9_000,
      indsigelse_tilbagefoersel_id: null,
      indsigelse_tilbagefoert_oere: null,
    };
    expect(forventetTilbagefoert(b)).toBe(56_500);
    expect(forventetTilbagefoert({ ...b, refusion_tilbagefoert_kl: null, indsigelse_tilbagefoersel_id: "trr", indsigelse_tilbagefoert_oere: 19_000 })).toBe(19_000);
  });

  it("payout-status: afgjort hos Stripe men ikke i databasen er først en afvigelse efter 2 døgn", () => {
    expect(payoutStatusPasser("paid", "paid", 0)).toBe(true);
    expect(payoutStatusPasser("in_transit", "oprettet", 0)).toBe(true);
    expect(payoutStatusPasser("paid", "oprettet", 60_000)).toBe(true);
    expect(payoutStatusPasser("paid", "oprettet", 3 * 86_400_000)).toBe(false);
    expect(payoutStatusPasser("failed", "paid", 0)).toBe(false);
  });

  it("CSV: danske beløb, semikolon, BOM og ingen formel-injektion", () => {
    expect(csvKr(123456)).toBe("1234,56");
    expect(csvKr(-5)).toBe("-0,05");
    expect(csvKr(null)).toBe("");
    const csv = pengeCsv([
      {
        kl: "2026-10-11T10:00:00Z",
        type: "betaling",
        trade_id: "t1",
        betaling_id: "b1",
        stripe_id: "pi_1",
        titel: '=HYPERLINK("x");"Sofa"',
        beloeb_oere: 59000,
        bidhamr_oere: 11500,
        koebergebyr_oere: 2500,
        saelgergebyr_oere: 2500,
        beskyttelse_oere: 2500,
        fragt_oere: 4000,
        saelger_oere: 47500,
      },
    ]);
    expect(csv.startsWith("\uFEFF\"Dato")).toBe(true);
    expect(csv).not.toContain("sep=");
    const linje = csv.split("\r\n")[1];
    expect(linje).toContain('"Betaling fra køber"');
    expect(linje).toContain('"t1";"b1";"pi_1"');
    expect(linje).toContain(";590,00;115,00;25,00;25,00;25,00;40,00;475,00");
    expect(linje).toContain(`"'=HYPERLINK(""x"");""Sofa"""`);
  });

  it("måned: dansk tid, ugyldig = denne måned", () => {
    const m = maanedInterval("2026-10");
    expect(m.fra.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(m.til.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(maanedInterval("2026-13").maaned).toMatch(/^\d{4}-\d{2}$/);
  });

  it("CSV: over 20.000 rækker giver en fejl i stedet for at klippe stille", () => {
    const r = { kl: "2026-10-01T00:00:00Z", type: "betaling", trade_id: null, betaling_id: null, stripe_id: null, titel: null,
      beloeb_oere: 1, bidhamr_oere: 0, koebergebyr_oere: null, saelgergebyr_oere: null, beskyttelse_oere: null, fragt_oere: null, saelger_oere: null };
    expect(() => pengeCsv(Array.from({ length: 20_001 }, () => r))).toThrow(/over 20000/);
  });
});

describe("rettelser efter review", () => {
  it("kun chef kan læse overblikket og posteringerne (p_chef)", async () => {
    await expect(db.query("select public.admin_penge_reserve($1, 0)", [ADMIN])).rejects.toThrow(/ingen_adgang/);
    await expect(db.query("select public.admin_penge_reserve(null, 0)")).rejects.toThrow(/ingen_adgang/);
    await expect(db.query("select public.admin_penge_posteringer($1, null, null, 5)", [ADMIN])).rejects.toThrow(/ingen_adgang/);
    const r = await en<{ a: boolean; b: boolean }>(
      `select has_function_privilege('service_role', 'public.penge_reserve_beregn(bigint)', 'execute') as a,
              has_function_privilege('service_role', 'public.penge_posteringer_hent(timestamptz, timestamptz, integer)', 'execute') as b`,
    );
    expect([r.a, r.b]).toEqual([false, false]);
  });

  it("historikken kan hverken ændres eller slettes", async () => {
    await expect(db.query("update public.penge_konfiguration_historik set reserve_procent = 50")).rejects.toThrow(/kan ikke ændres/);
    await expect(db.query("delete from public.penge_konfiguration_historik")).rejects.toThrow(/kan ikke ændres/);
  });

  it("en fejlet kørsel blokerer kun i 2 timer; en vellykket i hele intervallet", async () => {
    await db.exec(
      "update public.penge_afstemning_koersler set startet_kl = now() - interval '30 days', afsluttet_kl = coalesce(afsluttet_kl, now() - interval '30 days')",
    );
    const a = (await en<{ id: string }>("select public.penge_afstemning_claim(20) as id")).id;
    await db.query("select public.penge_afstemning_afslut($1, false, 'fejl', null)", [a]);
    expect((await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id")).id).toBeNull();
    // 3 timer senere: den fejlede kørsel blokerer ikke længere.
    await db.query(
      "update public.penge_afstemning_koersler set startet_kl = now() - interval '3 hours', afsluttet_kl = now() - interval '3 hours' where id = $1",
      [a],
    );
    const b = (await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id")).id;
    expect(b).not.toBeNull();
    await db.query("select public.penge_afstemning_afslut($1, true, null, null)", [b]);
    await db.query(
      "update public.penge_afstemning_koersler set startet_kl = now() - interval '3 hours', afsluttet_kl = now() - interval '3 hours' where id = $1",
      [b],
    );
    expect((await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id")).id).toBeNull();
  });

  it("en ufuldstændig kørsel blokerer kun i 2 timer", async () => {
    await db.exec("update public.penge_afstemning_koersler set startet_kl = now() - interval '30 days', afsluttet_kl = now() - interval '30 days'");
    const a = (await en<{ id: string }>("select public.penge_afstemning_claim(20) as id")).id;
    await db.query(`select public.penge_afstemning_afslut($1, true, null, '{"ufuldstaendig": 1, "naesteTrin": 4}'::jsonb)`, [a]);
    const k = await en<{ ufuldstaendig: boolean }>("select ufuldstaendig from public.penge_afstemning_koersler where id = $1", [a]);
    expect(k.ufuldstaendig).toBe(true);
    expect((await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id")).id).toBeNull();
    await db.query(
      "update public.penge_afstemning_koersler set startet_kl = now() - interval '3 hours', afsluttet_kl = now() - interval '3 hours' where id = $1",
      [a],
    );
    const b = (await en<{ id: string | null }>("select public.penge_afstemning_claim(20) as id")).id;
    expect(b).not.toBeNull();
    await db.query("select public.penge_afstemning_afslut($1, true, null, '{\"ufuldstaendig\": 0}'::jsonb)", [b]);
  });

  it("service role kan kun læse logs, afvigelser, snapshots og konfiguration", async () => {
    for (const t of ["penge_konfiguration", "penge_konfiguration_historik", "penge_afstemning_koersler", "penge_afstemning_afvigelser", "penge_saldo_snapshot"]) {
      const r = await en<{ i: boolean; u: boolean; d: boolean; t: boolean }>(
        `select has_table_privilege('service_role', 'public.${t}', 'insert') as i,
                has_table_privilege('service_role', 'public.${t}', 'update') as u,
                has_table_privilege('service_role', 'public.${t}', 'delete') as d,
                has_table_privilege('service_role', 'public.${t}', 'truncate') as t`,
      );
      expect([t, r.i, r.u, r.d, r.t]).toEqual([t, false, false, false, false]);
    }
    const w = await en<{ d: boolean; t: boolean }>(
      `select has_table_privilege('service_role', 'public.betaling_webhook_tjek', 'delete') as d,
              has_table_privilege('service_role', 'public.betaling_webhook_tjek', 'truncate') as t`,
    );
    expect([w.d, w.t]).toEqual([false, false]);
  });

  it("kald_pengeafstemning findes og kan ikke kaldes af anon/authenticated", async () => {
    const r = await en<{ a: boolean; u: boolean }>(
      `select has_function_privilege('anon', 'public.kald_pengeafstemning()', 'execute') as a,
              has_function_privilege('authenticated', 'public.kald_pengeafstemning()', 'execute') as u`,
    );
    expect([r.a, r.u]).toEqual([false, false]);
  });

  it("trinrækkefølgen roterer fra det første trin, der ikke blev nået", () => {
    expect(trinRaekkefoelge(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(trinRaekkefoelge(4)).toEqual([4, 5, 6, 0, 1, 2, 3]);
    expect(trinRaekkefoelge(99)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(TRIN[4]).toBe("udbetalinger");
  });

  it("rotationstabellen til overvågningens tjek H er kun for service role", async () => {
    const r = await en<{ s: boolean; u: boolean }>(
      `select has_table_privilege('service_role', 'public.betaling_webhook_tjek', 'insert') as s,
              has_table_privilege('authenticated', 'public.betaling_webhook_tjek', 'select') as u`,
    );
    expect([r.s, r.u]).toEqual([true, false]);
  });
});

describe("BidHamr dækker (sikkerhedsnet A)", () => {
  let claimet: string;
  let refunderet: string;

  beforeAll(async () => {
    // Udbetalt til sælgerens bank; chefen har valgt "BidHamr dækker" (claimet,
    // Stripe-refusionen er ikke gennemført endnu).
    claimet = (
      await en<{ id: string }>(
        `insert into public.betalinger (total_oere, udbetaling_oere, application_fee_oere, betalt_kl, saelger_stripe_konto,
                                        saelger_udbetaling_id, bidhamr_daekker_kl, bidhamr_daekker_oere)
         values (30000, 24000, 6000, now() - interval '9 days', 'acct_c', gen_random_uuid(), now(), 30000) returning id`,
      )
    ).id;
    // Gennemført: køberen er refunderet af BidHamr (status refunderet).
    refunderet = (
      await en<{ id: string }>(
        `insert into public.betalinger (status, total_oere, udbetaling_oere, application_fee_oere, betalt_kl, saelger_stripe_konto,
                                        saelger_udbetaling_id, bidhamr_daekker_kl, bidhamr_daekker_oere, bidhamr_daekker_refund_id,
                                        bidhamr_daekker_refunderet_kl, refunderet_kl, refusion_oere)
         values ('refunderet', 20000, 15000, 5000, now() - interval '9 days', 'acct_c', gen_random_uuid(),
                 now() - interval '1 hour', 17500, 're_daekker', now() - interval '1 hour', now() - interval '1 hour', 17500) returning id`,
      )
    ).id;
  });

  it("posteringer: 'bidhamr_daekker' som udgift for BidHamr - ikke også som almindelig refusion", async () => {
    const r = (await en<{ r: { type: string; betaling_id: string; beloeb_oere: number; bidhamr_oere: number; stripe_id: string }[] }>(
      "select public.admin_penge_posteringer($1, now() - interval '30 days', now() + interval '1 day', 1000) as r",
      [CHEF],
    )).r;
    const egne = r.filter((x) => x.betaling_id === refunderet);
    expect(egne.map((x) => x.type).sort()).toEqual(["betaling", "bidhamr_daekker"]);
    const d = egne.find((x) => x.type === "bidhamr_daekker")!;
    expect(Number(d.beloeb_oere)).toBe(17_500);
    expect(Number(d.bidhamr_oere)).toBe(-17_500);
    expect(d.stripe_id).toBe("re_daekker");
    // Den claimede (ikke refunderet) giver ingen dækker-postering endnu.
    expect(r.some((x) => x.betaling_id === claimet && x.type === "bidhamr_daekker")).toBe(false);
  });

  it("overblikket: claimet, ikke refunderet dækning tæller som skyld til købere og trækkes fra 'kan trækkes ud'", async () => {
    const foer = (await en<{ r: { skylder_koebere_oere: number; kan_traekkes_ud_oere: number } }>(
      "select public.admin_penge_reserve($1, 200000) as r",
      [CHEF],
    )).r;
    // Uden den claimede dækning:
    await db.query("update public.betalinger set bidhamr_daekker_refunderet_kl = now() where id = $1", [claimet]);
    const efter = (await en<{ r: { skylder_koebere_oere: number; kan_traekkes_ud_oere: number } }>(
      "select public.admin_penge_reserve($1, 200000) as r",
      [CHEF],
    )).r;
    await db.query("update public.betalinger set bidhamr_daekker_refunderet_kl = null where id = $1", [claimet]);
    expect(Number(foer.skylder_koebere_oere) - Number(efter.skylder_koebere_oere)).toBe(30_000);
    expect(Number(efter.kan_traekkes_ud_oere) - Number(foer.kan_traekkes_ud_oere)).toBe(30_000);
  });

  it("afstemningen: dækker-refusion, BidHamrs refusioner og negative payouts giver ingen afvigelse", () => {
    const b = { id: "b1", stripe_refund_id: null, bidhamr_daekker_refund_id: "re_daekker" };
    // "BidHamr dækker": metadata.betaling_id + bidhamr_daekker (bidhamrDaekker.ts).
    expect(erBidhamrsRefusion({ id: "re_x", metadata: { betaling_id: "b1", bidhamr_daekker: "b1" } }, b, null)).toBe(true);
    // Registreret på betalingen, selv uden metadata.
    expect(erBidhamrsRefusion({ id: "re_daekker", metadata: {} }, b, null)).toBe(true);
    // Refusion af forkert beløb (betaling_afvigelser).
    expect(erBidhamrsRefusion({ id: "re_a", metadata: { betaling_id: "b2" } }, null, { betaling_id: "b2", stripe_refund_id: null })).toBe(true);
    // Lavet i dashboardet: ingen metadata, ikke registreret.
    expect(erBidhamrsRefusion({ id: "re_dash", metadata: {} }, b, null)).toBe(false);
    expect(erBidhamrsRefusion({ id: "re_dash", metadata: { betaling_id: "en-anden" } }, b, null)).toBe(false);
    expect(payoutAfstemmes({ amount: -1500 })).toBe(false);
    expect(payoutAfstemmes({ amount: 0 })).toBe(true);
    expect(payoutAfstemmes({ amount: 47_500 })).toBe(true);
  });
});
