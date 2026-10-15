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
// auktion_billede_laast før migrationen (som i produktion - md5-drift-tjekket).
const BILLEDE_LAAST = readFileSync(path.resolve(import.meta.dirname, "fixtures/auktion_billede_laast_20261010060000.sql"), "utf8");

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
  slutter_kl timestamptz default now() + interval '3 days', erhverv boolean default false, billeder text[] default '{}', kunst_kontrol text);
create table public.dsa_afgoerelser (id uuid primary key default gen_random_uuid(), bruger_id uuid not null, auktion_id uuid,
  klage_frist_kl timestamptz not null default (now() + interval '6 months'));
create table public.dsa_anmeldelser (id uuid primary key default gen_random_uuid(), indhold_type text not null,
  indhold_id uuid, auktion_id uuid, anmeldt_bruger_id uuid, status text not null default 'ny', eskaleret_kl timestamptz);
create table public.dsa_klager (id uuid primary key default gen_random_uuid(), afgoerelse_id uuid, anmeldelse_id uuid,
  status text not null default 'afventer');
create table public.reports (id uuid primary key default gen_random_uuid(), auction_id uuid, status text not null default 'pending');
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
  auction_id uuid, status text default 'betaling_modtaget');
-- Storage (som Supabase): objekter i buckets, med RLS. Policyerne for
-- auktion-billeder som i produktion (20261009020000 og 20261010060000);
-- storage.foldername og storage_to_trin_ok forenklet.
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null);
grant select, insert, update, delete on storage.objects to authenticated;
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select string_to_array(name, '/') $$;
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

// Sletning i bucket auktion-billeder (som produktionen): egen mappe (permissiv)
// og aldrig et låst billede (restriktiv - auktion_billede_laast).
const POLICYER = `
create policy auktion_billeder_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'auktion-billeder' and (select auth.uid())::text = (storage.foldername(name))[1]);
create policy auktion_billeder_select_egen on storage.objects for select to authenticated
  using (bucket_id = 'auktion-billeder' and (select auth.uid())::text = (storage.foldername(name))[1]);
create policy auktion_billeder_slet_ikke_laast on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'auktion-billeder' or not public.auktion_billede_laast(name));
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
  await db.exec(BILLEDE_LAAST + POLICYER);
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
             has_function_privilege('anon', 'public.auktion_saelger_kan_saelge(uuid)', 'execute') as anon_frosset,
             to_regprocedure('public.saelger_kan_saelge(uuid)') is null as gammel_fjernet,
             has_function_privilege('authenticated', 'public.auktion_billeder_sletbare(uuid,text[])', 'execute') as auth_slet,
             has_function_privilege('service_role', 'public.auktion_billeder_sletbare(uuid,text[])', 'execute') as sr_slet,
             to_regprocedure('public.auktion_billeder_sletbare(uuid,uuid,text[])') is null as gammel_slet_fjernet,
             has_function_privilege('authenticated', 'public.app_bruger_har_aaben_sag(uuid)', 'execute') as auth_sag,
             has_function_privilege('service_role', 'public.app_bruger_har_aaben_sag(uuid)', 'execute') as sr_sag,
             has_function_privilege('anon', 'public.app_auktion_synlig(uuid)', 'execute') as anon_synlig,
             has_function_privilege('authenticated', 'public.app_auktion_synlig(uuid)', 'execute') as auth_synlig,
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
      gammel_fjernet: true,
      auth_slet: false,
      sr_slet: true,
      gammel_slet_fjernet: true,
      auth_sag: false,
      sr_sag: false,
      anon_synlig: false,
      auth_synlig: false,
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
         and proname in ('auktion_budhistorik','mine_kunst_kontrol','auktion_saelger_kan_saelge','app_auktion_synlig',
                         'handel_chat_marker_laest','antal_ulaeste_handelsbeskeder','min_auktion_boost',
                         'auktion_billeder_sletbare','app_bruger_har_aaben_sag','auktion_billede_laast')`);
    expect(r).toHaveLength(10);
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
      await d.exec(BILLEDE_LAAST);
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

describe("auktion_saelger_kan_saelge", () => {
  const kan = async (a: string) => (await en<{ v: boolean | null }>(`select public.auktion_saelger_kan_saelge($1) as v`, [a])).v;

  it("false for en frosset sælgers auktion, ellers true", async () => {
    const frosset = await auktion(FROSSET);
    const normal = await auktion(SAELGER);
    const udenProfil = await auktion(KOEBER);
    await som(null);
    expect(await kan(frosset)).toBe(false);
    expect(await kan(normal)).toBe(true);
    expect(await kan(udenProfil)).toBe(true);
    const t = await en<{ t: string }>(`select pg_typeof(public.auktion_saelger_kan_saelge($1))::text as t`, [frosset]);
    expect(t.t).toBe("boolean");
  });

  it("null for en auktion, kalderen ikke kan se (skjult, kunst 'afventer', ukendt)", async () => {
    const skjult = await auktion(FROSSET, { skjult: true });
    const kunst = await auktion(FROSSET, { kunst: "afventer" });
    await som(null);
    expect(await kan(skjult)).toBeNull();
    expect(await kan(kunst)).toBeNull();
    expect(await kan("00000000-0000-4000-8000-00000000ffff")).toBeNull();
    await som(FREMMED);
    expect(await kan(skjult)).toBeNull();
    // Sælgeren selv og staff kan se den.
    await som(FROSSET);
    expect(await kan(skjult)).toBe(false);
    await som(STAFF);
    expect(await kan(kunst)).toBe(false);
  });
});

describe("billeder er bevis i en åben sag", () => {
  const URL = "https://x.supabase.co/storage/v1/object/public/auktion-billeder/";
  const EJER = "00000000-0000-4000-8000-0000000000c5";
  const sletbare = async (stier: string[], bruger = EJER) =>
    (await en<{ v: { kode: string; stier?: string[] } }>(`select public.auktion_billeder_sletbare($1, $2::text[]) as v`, [
      bruger,
      stier,
    ])).v;
  const aabenSag = async (bruger = EJER) =>
    (await en<{ v: boolean }>(`select public.app_bruger_har_aaben_sag($1) as v`, [bruger])).v;

  // Sletter som ejeren selv direkte i Storage (med sit eget token).
  async function sletIStorage(sti: string): Promise<number> {
    await db.query(`insert into storage.objects (bucket_id, name) values ('auktion-billeder', $1)`, [sti]);
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [EJER]);
    await db.exec("set role authenticated");
    try {
      return (await db.query(`delete from storage.objects where bucket_id = 'auktion-billeder' and name = $1`, [sti])).affectedRows ?? 0;
    } finally {
      await db.exec("reset role");
      await db.query(`delete from storage.objects where name = $1`, [sti]);
    }
  }

  it("kun egne stier, som ingen af ejerens auktioner bruger (URL eller sti)", async () => {
    const a = await auktion(EJER);
    await db.query(`update public.auctions set billeder = $2 where id = $1`, [a, [`${URL}${EJER}/i-brug.jpg?v=2`, `${EJER}/sti-i-brug.jpg`]]);
    // En anden af ejerens auktioner bruger også et billede.
    const b = await auktion(EJER);
    await db.query(`update public.auctions set billeder = $2 where id = $1`, [b, [`${URL}${EJER}/genopsat.jpg`]]);
    const r = await sletbare([
      `${EJER}/gammel.jpg`,
      `${EJER}/i-brug.jpg`,
      `${EJER}/sti-i-brug.jpg`,
      `${EJER}/genopsat.jpg`,
      `${FREMMED}/andens.jpg`,
      `${EJER}/../${FREMMED}/x.jpg`,
      `${EJER}/gammel.jpg`,
    ]);
    expect(r).toEqual({ kode: "ok", stier: [`${EJER}/gammel.jpg`] });
    expect(await sletIStorage(`${EJER}/fri.jpg`)).toBe(1);
  });

  it("åbne sager om NOGEN af brugerens auktioner eller brugeren: server og Storage afviser", async () => {
    const andenAuktion = await auktion(EJER);
    const sti = [`${EJER}/fjernet.jpg`];
    const tjek = async (forventetAaben: boolean) => {
      expect(await aabenSag()).toBe(forventetAaben);
      expect((await sletbare(sti)).kode).toBe(forventetAaben ? "sag_aaben" : "ok");
      expect(await sletIStorage(`${EJER}/direkte.jpg`)).toBe(forventetAaben ? 0 : 1);
    };
    await tjek(false);

    // Videresendt anmeldelse (status 'ny' + eskaleret_kl) om en ANDEN auktion.
    const anm = (await en<{ id: string }>(
      `insert into public.dsa_anmeldelser (indhold_type, indhold_id, auktion_id, status, eskaleret_kl)
       values ('auktion', $1, $1, 'ny', now()) returning id`,
      [andenAuktion],
    )).id;
    await tjek(true);
    await db.query(`update public.dsa_anmeldelser set status = 'afgjort' where id = $1`, [anm]);
    await tjek(false);

    // Åben rapport.
    const rap = (await en<{ id: string }>(
      `insert into public.reports (auction_id, status) values ($1, 'under_behandling') returning id`,
      [andenAuktion],
    )).id;
    await tjek(true);
    await db.query(`update public.reports set status = 'behandlet' where id = $1`, [rap]);
    await tjek(false);

    // Anmeldelse om brugeren selv (fx profilen).
    const pro = (await en<{ id: string }>(
      `insert into public.dsa_anmeldelser (indhold_type, anmeldt_bruger_id) values ('profil', $1) returning id`,
      [EJER],
    )).id;
    await tjek(true);
    await db.query(`update public.dsa_anmeldelser set status = 'afgjort' where id = $1`, [pro]);
    await tjek(false);

    // Afgørelse om en af brugerens auktioner: åben, så længe klagefristen løber.
    const afg = (await en<{ id: string }>(
      `insert into public.dsa_afgoerelser (bruger_id, auktion_id) values ($1, $2) returning id`,
      [EJER, andenAuktion],
    )).id;
    await tjek(true);
    await db.query(`update public.dsa_afgoerelser set klage_frist_kl = now() - interval '1 minute' where id = $1`, [afg]);
    await tjek(false);

    // Klage, der afventer (selvom klagefristen er udløbet).
    const klage = (await en<{ id: string }>(`insert into public.dsa_klager (afgoerelse_id) values ($1) returning id`, [afg])).id;
    await tjek(true);
    await db.query(`update public.dsa_klager set status = 'afgjort' where id = $1`, [klage]);
    await tjek(false);
  });

  it("billeder fra en auktion med bud er stadig låst i Storage (som før)", async () => {
    const LAAST = "00000000-0000-4000-8000-0000000000c6";
    const a = await auktion(LAAST);
    await db.query(`update public.auctions set billeder = $2 where id = $1`, [a, [`${URL}${LAAST}/med-bud.jpg`]]);
    await bud(a, KOEBER, 100, 5);
    const r = await en<{ v: boolean }>(`select public.auktion_billede_laast($1) as v`, [`${LAAST}/med-bud.jpg`]);
    expect(r.v).toBe(true);
    // Ugyldig sti (ingen uuid først): ingen fejl.
    expect((await en<{ v: boolean }>(`select public.auktion_billede_laast('ikke-en-uuid/x.jpg') as v`)).v).toBe(false);
  });

  it("uden bruger: ugyldig", async () => {
    expect((await en<{ v: { kode: string } }>(`select public.auktion_billeder_sletbare(null, '{}') as v`)).v.kode).toBe("ugyldig");
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
    await db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id, type, beloeb_oere) values ($1, $2, $3, 'bud', 15000)`, [
      KOEBER,
      "00000000-0000-4000-8000-00000000e001",
      "00000000-0000-4000-8000-00000000e002",
    ]);
    await expect(
      db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id, type, beloeb_oere) values ($1, $2, $3, 'bud', 15000)`, [
        KOEBER,
        "00000000-0000-4000-8000-00000000e001",
        "00000000-0000-4000-8000-00000000e003",
      ]),
    ).rejects.toThrow(/duplicate key/);
    // En anden bruger må gerne bruge samme nøgle.
    await db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id, type, beloeb_oere) values ($1, $2, $3, 'bud', 15000)`, [
      SAELGER,
      "00000000-0000-4000-8000-00000000e001",
      "00000000-0000-4000-8000-00000000e002",
    ]);
    const rls = await en<{ r: boolean }>(`select relrowsecurity as r from pg_class where oid = 'public.app_bud_noegler'::regclass`);
    expect(rls.r).toBe(true);
    // Type og beløb er bundet til nøglen og tjekkes.
    await expect(
      db.query(`insert into public.app_bud_noegler (bruger_id, noegle, auktion_id, type, beloeb_oere) values ($1, $2, $3, 'andet', 100)`, [
        BYDER2,
        "00000000-0000-4000-8000-00000000e004",
        "00000000-0000-4000-8000-00000000e002",
      ]),
    ).rejects.toThrow(/check constraint/);
  });
});
