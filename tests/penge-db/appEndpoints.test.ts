// Migrationen 20261025010000_app_endpoints.sql i PGlite (Postgres i processen
// - ingen database, intet netværk). Stubs af de tabeller og funktioner,
// migrationen bygger på (min_auktion_boost kopieres ordret fra
// 20261023030000_boost.sql, så md5-drift-tjekket rammer den rigtige krop);
// derefter køres migrationen TO gange, og reglerne testes: anonym
// budhistorik (synlighed som RLS), kunst-kontrol kun for egne auktioner,
// boost-grunden 'kunst_kontrol', frosset sælger (kun ja/nej), handelschat
// læst-status (kun egne handler) og rettighederne.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONER = path.resolve(import.meta.dirname, "../../supabase/migrations");
const MIGRATION = readFileSync(path.join(MIGRATIONER, "20261025010000_app_endpoints.sql"), "utf8");

// min_auktion_boost præcis som i boost-migrationen (samme krop = samme md5).
function minAuktionBoostFraBoost(): string {
  const s = readFileSync(path.join(MIGRATIONER, "20261023030000_boost.sql"), "utf8").replace(/\r/g, "");
  const start = s.indexOf("create or replace function public.min_auktion_boost(p_auktion uuid)");
  const slut = s.indexOf("$fn$;", s.indexOf("$fn$", start) + 4) + "$fn$;".length;
  if (start < 0 || slut < start) throw new Error("min_auktion_boost ikke fundet i boost-migrationen");
  return s.slice(start, slut);
}

const SAELGER = "00000000-0000-4000-8000-0000000000a1";
const KOEBER = "00000000-0000-4000-8000-0000000000a2";
const BYDER2 = "00000000-0000-4000-8000-0000000000a3";
const FREMMED = "00000000-0000-4000-8000-0000000000a4";
const STAFF = "00000000-0000-4000-8000-0000000000d1";
const FROSSET = "00000000-0000-4000-8000-0000000000b1";

const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger');
insert into public.users (id, navn, rolle) values
  ('${SAELGER}', 'Sælger', 'bruger'), ('${KOEBER}', 'Køber', 'bruger'), ('${BYDER2}', 'Byder', 'bruger'),
  ('${FREMMED}', 'Fremmed', 'bruger'), ('${STAFF}', 'Staff', 'medarbejder'), ('${FROSSET}', 'Frosset', 'bruger');
create function public.er_staff() returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.rolle in ('medarbejder','admin','chef')) $$;
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid, titel text,
  status text default 'aktiv', skjult boolean default false, arkiveret_kl timestamptz, pauset_kl timestamptz,
  slutter_kl timestamptz default now() + interval '3 days', erhverv boolean default false, kunst_kontrol text);
create table public.bids (id uuid primary key default gen_random_uuid(), auktion_id uuid, bruger_id uuid,
  "beløb" numeric not null, oprettet timestamptz not null default now(), automatisk boolean default false,
  beskyttelse boolean default false);
-- Deltagere (byder, vinder, køber) må se en skjult/arkiveret auktion.
create function public.auktion_arkiv_adgang(p_id uuid) returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from public.bids b where b.auktion_id = p_id and b.bruger_id = auth.uid()) $$;
create table public.betalingsprofiler (user_id uuid primary key, saelger_frosset_kl timestamptz, salg_frosset_kl timestamptz,
  stripe_konto_id text);
insert into public.betalingsprofiler (user_id, saelger_frosset_kl, stripe_konto_id) values
  ('${FROSSET}', now(), 'acct_hemmelig'), ('${SAELGER}', null, 'acct_saelger');
create table public.trades (id uuid primary key default gen_random_uuid(), buyer_id uuid, seller_id uuid,
  status text default 'betaling_modtaget');
create table public.messages (id uuid primary key default gen_random_uuid(), trade_id uuid not null references public.trades(id),
  sender_id uuid not null, content text not null, created_at timestamptz not null default now(),
  fra_bidhamr boolean not null default false, blokeret_grund text);
-- Boost (det min_auktion_boost læser).
create table public.boost_indstillinger (id boolean primary key default true, boost_point integer not null default 50,
  boost_timer integer not null default 24, pakke_point integer not null default 100, pakke_pris_oere integer not null default 3900,
  min_tid_tilbage_minutter integer not null default 60);
insert into public.boost_indstillinger default values;
create table public.auktion_boosts (auktion_id uuid, slut_kl timestamptz);
create function public.boost_saldo(p uuid) returns integer language sql stable as $$ select 100 $$;
create function public.boost_bruger_spaerret(p uuid) returns text language sql stable as $$ select null::text $$;
create function public.boost_point_laast(p uuid) returns boolean language sql stable as $$ select false $$;
create function public.boost_kunst_afventer(p_auktion uuid) returns boolean language sql stable security definer set search_path = '' as $fn$
  select coalesce((select (to_jsonb(a) ->> 'kunst_kontrol') = 'afventer'
                     from public.auctions a where a.id = p_auktion), false);
$fn$;
`;

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function alle<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, p)).rows;
}
async function som(bruger: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [bruger ?? ""]);
}
async function auktion(ejer: string, o: { skjult?: boolean; arkiveret?: boolean; kunst?: string | null } = {}) {
  return (
    await en<{ id: string }>(
      `insert into public.auctions (bruger_id, titel, skjult, arkiveret_kl, kunst_kontrol)
       values ($1, 'Cykel', $2, case when $3 then now() else null end, $4) returning id`,
      [ejer, o.skjult ?? false, o.arkiveret ?? false, o.kunst ?? null],
    )
  ).id;
}
async function bud(auktionId: string, byder: string, kr: number, sekunderSiden: number, automatisk = false) {
  await db.query(
    `insert into public.bids (auktion_id, bruger_id, "beløb", oprettet, automatisk)
     values ($1, $2, $3, now() - make_interval(secs => $4), $5)`,
    [auktionId, byder, kr, sekunderSiden, automatisk],
  );
}
type Historik = { id: string; byder: string; beloeb: string; automatisk: boolean; er_mig: boolean };
const historik = (a: string) => alle<Historik>(`select * from public.auktion_budhistorik($1)`, [a]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(minAuktionBoostFraBoost());
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("rettigheder: budhistorik og frosset sælger for alle; resten kun authenticated; bud-nøgler kun service role", async () => {
    const r = await en<Record<string, boolean>>(`
      select has_function_privilege('anon', 'public.auktion_budhistorik(uuid)', 'execute') as anon_hist,
             has_function_privilege('authenticated', 'public.auktion_budhistorik(uuid)', 'execute') as auth_hist,
             has_function_privilege('anon', 'public.saelger_kan_saelge(uuid)', 'execute') as anon_frosset,
             has_function_privilege('anon', 'public.mine_kunst_kontrol(uuid[])', 'execute') as anon_kunst,
             has_function_privilege('authenticated', 'public.mine_kunst_kontrol(uuid[])', 'execute') as auth_kunst,
             has_function_privilege('anon', 'public.handel_chat_marker_laest(uuid)', 'execute') as anon_laest,
             has_function_privilege('authenticated', 'public.handel_chat_marker_laest(uuid)', 'execute') as auth_laest,
             has_function_privilege('anon', 'public.antal_ulaeste_handelsbeskeder()', 'execute') as anon_antal,
             has_function_privilege('authenticated', 'public.antal_ulaeste_handelsbeskeder()', 'execute') as auth_antal,
             has_function_privilege('anon', 'public.min_auktion_boost(uuid)', 'execute') as anon_boost,
             has_table_privilege('authenticated', 'public.handel_chat_laest', 'select') as auth_laest_sel,
             has_table_privilege('authenticated', 'public.handel_chat_laest', 'insert') as auth_laest_ins,
             has_table_privilege('authenticated', 'public.handel_chat_laest', 'update') as auth_laest_upd,
             has_table_privilege('anon', 'public.handel_chat_laest', 'select') as anon_laest_sel,
             has_table_privilege('authenticated', 'public.app_bud_noegler', 'select') as auth_noegle,
             has_table_privilege('anon', 'public.app_bud_noegler', 'select') as anon_noegle,
             has_table_privilege('service_role', 'public.app_bud_noegler', 'insert') as sr_noegle`);
    expect(r).toEqual({
      anon_hist: true,
      auth_hist: true,
      anon_frosset: true,
      anon_kunst: false,
      auth_kunst: true,
      anon_laest: false,
      auth_laest: true,
      anon_antal: false,
      auth_antal: true,
      anon_boost: false,
      auth_laest_sel: true,
      auth_laest_ins: false,
      auth_laest_upd: false,
      anon_laest_sel: false,
      auth_noegle: false,
      anon_noegle: false,
      sr_noegle: true,
    });
  });

  it("alle nye funktioner er security definer med tom search_path", async () => {
    const r = await alle<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(`
      select proname, prosecdef, proconfig from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('auktion_budhistorik','mine_kunst_kontrol','saelger_kan_saelge',
                         'handel_chat_marker_laest','antal_ulaeste_handelsbeskeder','min_auktion_boost')`);
    expect(r).toHaveLength(6);
    for (const f of r) {
      expect(f.prosecdef).toBe(true);
      expect(f.proconfig).toEqual(['search_path=""']);
    }
  });

  it("drift-tjek: en ændret min_auktion_boost stopper migrationen", async () => {
    const d = new PGlite();
    try {
      await d.exec(STUB);
      await d.exec(minAuktionBoostFraBoost().replace("'slutter_snart'", "'slutter_snart_aendret'"));
      await expect(d.exec(MIGRATION)).rejects.toThrow(/hverken gammel eller ny/);
    } finally {
      await d.close();
    }
  });

  it("forudsætning: uden kunst-kolonnen afbrydes migrationen", async () => {
    const d = new PGlite();
    try {
      await d.exec(STUB.replace(", kunst_kontrol text);", ");"));
      await expect(d.exec(MIGRATION)).rejects.toThrow(/20261023010000/);
    } finally {
      await d.close();
    }
  });
});

describe("auktion_budhistorik", () => {
  let a: string;
  beforeAll(async () => {
    a = await auktion(SAELGER);
    await bud(a, KOEBER, 100, 50);
    await bud(a, BYDER2, 110, 40);
    await bud(a, KOEBER, 120, 30, true);
    await bud(a, FREMMED, 130, 20);
  });

  it("anonym: 'Byder N' i den rækkefølge, de først bød; højeste først; ingen id'er på byderne", async () => {
    await som(null);
    const h = await historik(a);
    expect(h.map((b) => [b.byder, Number(b.beloeb), b.automatisk, b.er_mig])).toEqual([
      ["Byder 3", 130, false, false],
      ["Byder 1", 120, true, false],
      ["Byder 2", 110, false, false],
      ["Byder 1", 100, false, false],
    ]);
    expect(Object.keys(h[0]).sort()).toEqual(["automatisk", "beloeb", "byder", "er_mig", "id", "oprettet"]);
    expect(JSON.stringify(h)).not.toContain(KOEBER);
  });

  it("egne bud: 'Dig' og er_mig = true; de andre beholder deres nummer", async () => {
    await som(KOEBER);
    const h = await historik(a);
    expect(h.map((b) => [b.byder, b.er_mig])).toEqual([
      ["Byder 3", false],
      ["Dig", true],
      ["Byder 2", false],
      ["Dig", true],
    ]);
  });

  it("skjult, arkiveret og kunst 'afventer': intet for anon og fremmede; sælger, deltagere og staff ser den", async () => {
    for (const o of [{ skjult: true }, { arkiveret: true }, { kunst: "afventer" }]) {
      const x = await auktion(SAELGER, o);
      await bud(x, KOEBER, 50, 10);
      await som(null);
      expect(await historik(x)).toEqual([]);
      await som(FREMMED);
      expect(await historik(x)).toEqual([]);
      await som(SAELGER);
      expect(await historik(x)).toHaveLength(1);
      await som(KOEBER);
      expect((await historik(x))[0].byder).toBe("Dig");
      await som(STAFF);
      expect(await historik(x)).toHaveLength(1);
    }
  });

  it("kunst 'godkendt' og ukendt auktion", async () => {
    const x = await auktion(SAELGER, { kunst: "godkendt" });
    await bud(x, KOEBER, 50, 10);
    await som(null);
    expect(await historik(x)).toHaveLength(1);
    expect(await historik("00000000-0000-4000-8000-00000000ffff")).toEqual([]);
    expect(await alle(`select * from public.auktion_budhistorik(null)`)).toEqual([]);
  });

  it("højst 50 bud", async () => {
    const x = await auktion(SAELGER);
    for (let i = 1; i <= 55; i++) await bud(x, i % 2 ? KOEBER : BYDER2, i * 10, 1000 - i);
    await som(null);
    const h = await historik(x);
    expect(h).toHaveLength(50);
    expect(Number(h[0].beloeb)).toBe(550);
  });
});

describe("mine_kunst_kontrol", () => {
  it("kun kalderens egne auktioner", async () => {
    const egen = await auktion(SAELGER, { kunst: "afventer" });
    const egen2 = await auktion(SAELGER);
    const andens = await auktion(FREMMED, { kunst: "afventer" });
    await som(SAELGER);
    const r = await alle<{ auction_id: string; kunst_kontrol: string | null }>(
      `select * from public.mine_kunst_kontrol($1::uuid[]) order by kunst_kontrol nulls last`,
      [[egen, egen2, andens]],
    );
    expect(r).toEqual([
      { auction_id: egen, kunst_kontrol: "afventer" },
      { auction_id: egen2, kunst_kontrol: null },
    ]);
    await som(null);
    expect(await alle(`select * from public.mine_kunst_kontrol($1::uuid[])`, [[egen]])).toEqual([]);
    await som(SAELGER);
    expect(await alle(`select * from public.mine_kunst_kontrol(null)`)).toEqual([]);
  });
});

describe("min_auktion_boost", () => {
  it("grund 'kunst_kontrol', når auktionen afventer; ellers som før", async () => {
    const afventer = await auktion(SAELGER, { kunst: "afventer" });
    const normal = await auktion(SAELGER);
    await som(SAELGER);
    const a = await en<{ v: { grund: string | null; kan_booste: boolean } }>(`select public.min_auktion_boost($1) as v`, [afventer]);
    expect(a.v.grund).toBe("kunst_kontrol");
    expect(a.v.kan_booste).toBe(false);
    const n = await en<{ v: { grund: string | null; kan_booste: boolean } }>(`select public.min_auktion_boost($1) as v`, [normal]);
    expect(n.v.grund).toBeNull();
    expect(n.v.kan_booste).toBe(true);
    // Andres auktion: null (uændret).
    await som(FREMMED);
    expect((await en<{ v: unknown }>(`select public.min_auktion_boost($1) as v`, [afventer])).v).toBeNull();
  });
});

describe("saelger_kan_saelge", () => {
  it("false for en frosset sælger, ellers true - kun en boolean", async () => {
    await som(null);
    expect((await en<{ v: boolean }>(`select public.saelger_kan_saelge($1) as v`, [FROSSET])).v).toBe(false);
    expect((await en<{ v: boolean }>(`select public.saelger_kan_saelge($1) as v`, [SAELGER])).v).toBe(true);
    // Ingen betalingsprofil: kan bydes på.
    expect((await en<{ v: boolean }>(`select public.saelger_kan_saelge($1) as v`, [KOEBER])).v).toBe(true);
    const t = await en<{ t: string }>(`select pg_typeof(public.saelger_kan_saelge($1))::text as t`, [FROSSET]);
    expect(t.t).toBe("boolean");
  });
});

describe("handelschat: læst-status", () => {
  let handel: string;
  let andenHandel: string;
  beforeAll(async () => {
    handel = (await en<{ id: string }>(`insert into public.trades (buyer_id, seller_id) values ($1, $2) returning id`, [KOEBER, SAELGER])).id;
    andenHandel = (await en<{ id: string }>(`insert into public.trades (buyer_id, seller_id) values ($1, $2) returning id`, [FREMMED, SAELGER])).id;
  });
  const antal = async (b: string) => {
    await som(b);
    return (await en<{ n: number }>(`select public.antal_ulaeste_handelsbeskeder() as n`)).n;
  };
  const besked = (t: string, fra: string, o: { blokeret?: string; sekunderSiden?: number } = {}) =>
    db.query(
      `insert into public.messages (trade_id, sender_id, content, blokeret_grund, created_at)
       values ($1, $2, 'Hej', $3, now() - make_interval(secs => $4))`,
      [t, fra, o.blokeret ?? null, o.sekunderSiden ?? 0],
    );

  it("beskeder fra modparten tæller; egne og spamblokerede gør ikke; andres handler tæller ikke", async () => {
    await besked(handel, SAELGER, { sekunderSiden: 30 });
    await besked(handel, SAELGER, { sekunderSiden: 20 });
    await besked(handel, KOEBER, { sekunderSiden: 10 });
    await besked(handel, SAELGER, { blokeret: "bank", sekunderSiden: 5 });
    await besked(andenHandel, FREMMED, { sekunderSiden: 5 });
    expect(await antal(KOEBER)).toBe(2);
    // Sælgeren: én fra køberen + én fra den anden handel.
    expect(await antal(SAELGER)).toBe(2);
    expect(await antal(BYDER2)).toBe(0);
  });

  it("marker læst: tælleren nulstilles kun for den handel; en fremmed kan ikke markere", async () => {
    await som(KOEBER);
    expect((await en<{ v: boolean }>(`select public.handel_chat_marker_laest($1) as v`, [handel])).v).toBe(true);
    expect(await antal(KOEBER)).toBe(0);
    await som(SAELGER);
    expect((await en<{ v: boolean }>(`select public.handel_chat_marker_laest($1) as v`, [handel])).v).toBe(true);
    expect(await antal(SAELGER)).toBe(1); // den anden handel
    await som(BYDER2);
    expect((await en<{ v: boolean }>(`select public.handel_chat_marker_laest($1) as v`, [handel])).v).toBe(false);
    await som(null);
    expect((await en<{ v: boolean }>(`select public.handel_chat_marker_laest($1) as v`, [handel])).v).toBe(false);
    const raekker = await alle<{ bruger_id: string }>(
      `select bruger_id from public.handel_chat_laest where trade_id = $1 order by bruger_id`,
      [handel],
    );
    expect(raekker.map((r) => r.bruger_id)).toEqual([SAELGER, KOEBER]);
  });

  it("en ny besked efter læsningen tæller igen; et nyt kald flytter aldrig tidspunktet tilbage", async () => {
    await besked(handel, SAELGER);
    expect(await antal(KOEBER)).toBe(1);
    await som(KOEBER);
    await db.query(`select public.handel_chat_marker_laest($1)`, [handel]);
    expect(await antal(KOEBER)).toBe(0);
    const foer = await en<{ l: string }>(`select laest_kl::text as l from public.handel_chat_laest where trade_id = $1 and bruger_id = $2`, [handel, KOEBER]);
    await db.query(`update public.handel_chat_laest set laest_kl = laest_kl + interval '1 hour' where trade_id = $1 and bruger_id = $2`, [handel, KOEBER]);
    await db.query(`select public.handel_chat_marker_laest($1)`, [handel]);
    const efter = await en<{ l: string }>(`select laest_kl::text as l from public.handel_chat_laest where trade_id = $1 and bruger_id = $2`, [handel, KOEBER]);
    expect(efter.l > foer.l).toBe(true);
  });

  it("RLS: brugeren ser kun sine egne læst-rækker", async () => {
    const p = await en<{ q: string }>(
      `select qual as q from pg_policies where tablename = 'handel_chat_laest' and policyname = 'handel_chat_laest_select_egen'`,
    );
    expect(p.q).toContain("auth.uid()");
    expect(p.q).toContain("bruger_id");
    const rls = await en<{ r: boolean }>(`select relrowsecurity as r from pg_class where oid = 'public.handel_chat_laest'::regclass`);
    expect(rls.r).toBe(true);
  });
});

describe("app_bud_noegler", () => {
  it("én nøgle pr. bruger (primærnøgle), RLS slået til", async () => {
    await db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id) values ($1, $2, $3)`, [
      KOEBER,
      "00000000-0000-4000-8000-00000000e001",
      "00000000-0000-4000-8000-00000000e002",
    ]);
    await expect(
      db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id) values ($1, $2, $3)`, [
        KOEBER,
        "00000000-0000-4000-8000-00000000e001",
        "00000000-0000-4000-8000-00000000e003",
      ]),
    ).rejects.toThrow(/duplicate key/);
    // En anden bruger må gerne bruge samme nøgle.
    await db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id) values ($1, $2, $3)`, [
      SAELGER,
      "00000000-0000-4000-8000-00000000e001",
      "00000000-0000-4000-8000-00000000e002",
    ]);
    const rls = await en<{ r: boolean }>(`select relrowsecurity as r from pg_class where oid = 'public.app_bud_noegler'::regclass`);
    expect(rls.r).toBe(true);
  });
});
