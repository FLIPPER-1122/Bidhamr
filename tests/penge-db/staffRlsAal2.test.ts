// Migration B (20261027020000_staff_rls_aal2.sql) i PGlite (Postgres i
// processen - ingen database, intet netværk). Funktionerne og policies er de
// rigtige fra produktion/test før migrationen (fixtures/staff_rls_foer_20261027020000.sql),
// migration A (20261027010000_staff_to_trin.sql) køres først som i
// produktion. Testes med `set local request.jwt.claims` (aal1/aal2) og en
// aktiv/inaktiv række i staff_to_trin:
//   - er_staff() er kun sand ved aal2, aktivt to-trins-login og en frisk kode.
//   - RLS på alle 10 tabeller: staff med aal1 ser kun egne rækker, med aal2 alle.
//   - Storage-funktionerne (og policies på storage.objects) opfører sig ens.
//   - min_rolle()/min_profil() er uændrede ved aal1.
//   - md5-tjekket afviser en uventet krop/policy (og intet ændres).
//   - Migrationen kan køres to gange; rollback-filen gendanner den gamle opførsel.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rod = path.resolve(import.meta.dirname, "../..");
const laes = (p: string) => readFileSync(path.resolve(rod, p), "utf8");
const MIGRATION_A = laes("supabase/migrations/20261027010000_staff_to_trin.sql");
const MIGRATION_B = laes("supabase/migrations/20261027020000_staff_rls_aal2.sql");
const ROLLBACK = laes("supabase/rollback/20261027020000_staff_rls_aal2.sql");
const FOER = laes("tests/penge-db/fixtures/staff_rls_foer_20261027020000.sql");

const CHEF = "00000000-0000-4000-8000-0000000000c1";
const MEDARB = "00000000-0000-4000-8000-0000000000e1";
const SAELGER = "00000000-0000-4000-8000-0000000000e2";
const UDEN = "00000000-0000-4000-8000-0000000000e3"; // medarbejder uden to-trins-login
const B1 = "00000000-0000-4000-8000-0000000000b1";
const B2 = "00000000-0000-4000-8000-0000000000b2";

const A1 = "00000000-0000-4000-8000-00000000a001"; // synlig (B2)
const A2 = "00000000-0000-4000-8000-00000000a002"; // skjult (B2)
const A3 = "00000000-0000-4000-8000-00000000a003"; // afventer kunst-kontrol (B1)
const A4 = "00000000-0000-4000-8000-00000000a004"; // skjult (chefens egen)
const T1 = "00000000-0000-4000-8000-00000000d001"; // B1 køber af B2 (andres)
const T2 = "00000000-0000-4000-8000-00000000d002"; // chefen køber af B2
const T3 = "00000000-0000-4000-8000-00000000d003"; // medarbejderen køber af B1
const F1 = "00000000-0000-4000-8000-00000000f001";

const STUB = `
set check_function_bodies = off;
create role anon; create role authenticated; create role service_role;
create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;
grant usage on schema auth, storage, public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null,
  factor_type text not null default 'totp', status text not null default 'unverified');
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, aal text not null default 'aal1');
create table auth.users (id uuid primary key, email text);

create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger', email text, telefon text,
  suspenderet boolean not null default false, suspenderet_aarsag text, suspenderet_kl timestamptz, suspenderet_til timestamptz,
  konto_type text, konto_lukket_kl timestamptz, konto_slettet_kl timestamptz, fornavn text, efternavn text);
insert into public.users (id, navn, rolle) values
  ('${CHEF}', 'Chef', 'chef'), ('${MEDARB}', 'Medarbejder', 'medarbejder'), ('${SAELGER}', 'Sælger', 'saelger'),
  ('${UDEN}', 'Uden', 'medarbejder'), ('${B1}', 'Bruger 1', 'bruger'), ('${B2}', 'Bruger 2', 'bruger');
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet_kl timestamptz default now(),
  constraint moderation_log_handling_check check ((handling = ANY ('{advarsel,firma_faktura_opslag,rolle_aendret}'::text[]))));

create table public.auctions (id uuid primary key, bruger_id uuid not null, vinder_id uuid, titel text, stand text,
  arkiveret_kl timestamptz, skjult boolean default false, kunst_kontrol text);
create table public.bids (id uuid primary key default gen_random_uuid(), auktion_id uuid, bruger_id uuid);
create table public.trades (id uuid primary key, auction_id uuid, buyer_id uuid, seller_id uuid,
  created_at timestamptz default now(), amount numeric, afhentning boolean);
create table public.andenchance_tilbud (id uuid primary key default gen_random_uuid(), auction_id uuid, byder_id uuid);
create table public.messages (id uuid primary key default gen_random_uuid(), trade_id uuid, sender_id uuid,
  content text, blokeret_grund text);
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid, buyer_id uuid, seller_id uuid,
  betalt_kl timestamptz, refunderet_kl timestamptz, bud_oere bigint);
create table public.betaling_afvigelser (id uuid primary key default gen_random_uuid(), tekst text);
create table public.employee_complaints (id uuid primary key default gen_random_uuid(), user_id uuid, tekst text);
create table public.forsendelser (id uuid primary key default gen_random_uuid(), trade_id uuid, label_sti text,
  qr_kode text, status text, type text);
create table public.forsendelse_haendelser (id uuid primary key default gen_random_uuid(), forsendelse_id uuid);
create table public.handel_levering (trade_id uuid primary key, maade text, fragtfirma text, pakkeshop_id text,
  pakkeshop_navn text, pakkeshop_adresse text, pakkeshop_postnummer text, pakkeshop_by text,
  pakkeshop_lat double precision, pakkeshop_lng double precision, modtager_navn text, modtager_adresse text,
  modtager_postnummer text, modtager_by text, modtager_telefon text, modtager_email text, fragt_oere integer,
  valgt_kl timestamptz);
create table public.pakke_billeder (id uuid primary key default gen_random_uuid(), trade_id uuid, sti text);
create table public.sager (id uuid primary key default gen_random_uuid(), trade_id uuid, status text);
create table public.sag_billeder (id uuid primary key default gen_random_uuid(), sag_id uuid, sti text);
create table public.sag_anker (id uuid primary key default gen_random_uuid(), trade_id uuid, status text);
create table public.sag_anke_billeder (id uuid primary key default gen_random_uuid(), anke_id uuid, sti text);
create table public.staff_samtaler (id uuid primary key default gen_random_uuid(), bruger_id uuid, lukket_kl timestamptz);
create table public.staff_beskeder (id uuid primary key default gen_random_uuid(), samtale_id uuid, fra_staff boolean,
  oprettet_kl timestamptz default now());
create table public.auction_questions (id uuid primary key default gen_random_uuid(), auction_id uuid, asker_id uuid,
  question text, answer text, asked_at timestamptz default now(), answered_at timestamptz, hidden boolean default false);
create table public.beta_indstillinger (id boolean primary key default true, beta_aaben boolean not null default false);
insert into public.beta_indstillinger default values;
create table public.beta_invitationer (bruger_id uuid, tilbagekaldt_kl timestamptz);
create table public.firmaer (id uuid primary key default gen_random_uuid(), bruger_id uuid, firmanavn text, cvr text,
  bruger_brugtmoms boolean);

create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text,
  owner uuid, created_at timestamptz default now());
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(cardinality(string_to_array(name, '/')) - 1, 0)] $$;
create function public.auktion_billede_maa_slettes(text) returns boolean language sql as $$ select true $$;
create function public.auktion_billede_laast(text) returns boolean language sql as $$ select false $$;
create function public.storage_to_trin_ok() returns boolean language sql as $$ select true $$;

do $$
declare t text;
begin
  foreach t in array array['auctions','trades','andenchance_tilbud','messages','betalinger','betaling_afvigelser',
    'employee_complaints','forsendelser','forsendelse_haendelser','handel_levering'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
alter table storage.objects enable row level security;
grant select on all tables in schema public to authenticated, anon;
grant select, insert on storage.objects to authenticated;
`;

const DATA = `
insert into public.auctions (id, bruger_id, titel, skjult, kunst_kontrol) values
  ('${A1}', '${B2}', 'Synlig', false, null), ('${A2}', '${B2}', 'Skjult', true, null),
  ('${A3}', '${B1}', 'Kunst', false, 'afventer'), ('${A4}', '${CHEF}', 'Chefens skjulte', true, null);
insert into public.trades (id, auction_id, buyer_id, seller_id) values
  ('${T1}', '${A1}', '${B1}', '${B2}'), ('${T2}', '${A1}', '${CHEF}', '${B2}'), ('${T3}', '${A1}', '${MEDARB}', '${B1}');
insert into public.messages (trade_id, sender_id, content)
  select id, buyer_id, 'hej' from public.trades;
insert into public.betalinger (trade_id, buyer_id, seller_id, betalt_kl)
  select id, buyer_id, seller_id, now() from public.trades;
insert into public.forsendelser (id, trade_id, label_sti, status, type) values
  ('${F1}', '${T1}', '${B2}/t1.pdf', 'oprettet', 'udgaaende'),
  (gen_random_uuid(), '${T2}', '${B2}/t2.pdf', 'oprettet', 'udgaaende'),
  (gen_random_uuid(), '${T3}', '${B1}/t3.pdf', 'oprettet', 'udgaaende');
insert into public.forsendelse_haendelser (forsendelse_id) select id from public.forsendelser;
insert into public.handel_levering (trade_id, maade) select id, 'pakkeshop' from public.trades;
insert into public.andenchance_tilbud (auction_id, byder_id) values
  ('${A1}', '${B1}'), ('${A1}', '${CHEF}'), ('${A1}', '${MEDARB}');
insert into public.betaling_afvigelser (tekst) values ('afvigelse');
insert into public.employee_complaints (user_id, tekst) values ('${B1}', 'klage');
insert into public.auction_questions (auction_id, asker_id, question, hidden) values
  ('${A1}', '${B1}', 'Synligt spørgsmål', false), ('${A1}', '${B1}', 'Skjult spørgsmål', true),
  ('${A2}', '${B1}', 'Spørgsmål på skjult auktion', false);
insert into public.pakke_billeder (trade_id, sti) values ('${T1}', '${B2}/${T1}/pakke.jpg');
insert into public.sager (id, trade_id, status) values ('00000000-0000-4000-8000-00000000e501', '${T1}', 'aaben');
insert into public.sag_billeder (sag_id, sti) values ('00000000-0000-4000-8000-00000000e501', '${B1}/${T1}/sag.jpg');
insert into storage.objects (bucket_id, name) values
  ('fragt-labels', '${B2}/t1.pdf'), ('pakke-billeder', '${B2}/${T1}/pakke.jpg'),
  ('sag-billeder', '${B1}/${T1}/sag.jpg'), ('pakke-billeder', '${CHEF}/${T2}/egen.jpg');
insert into public.staff_samtaler (id, bruger_id) values ('00000000-0000-4000-8000-00000000e601', '${B1}');
insert into public.staff_beskeder (samtale_id, fra_staff) values ('00000000-0000-4000-8000-00000000e601', false);
`;

// To-trins-login aktivt (verificeret faktor, godkendt af serveren).
const AKTIVER = [CHEF, MEDARB, SAELGER]
  .map(
    (id) => `
with f as (insert into auth.mfa_factors (user_id, status) values ('${id}', 'verified') returning id)
insert into public.staff_to_trin (bruger_id, aktiv, faktor_ider, opsat_kl)
select '${id}', true, array[f.id], now() from f
on conflict (bruger_id) do update set aktiv = true, faktor_ider = excluded.faktor_ider, opsat_kl = now();`,
  )
  .join("\n");

type Opsaetning = { migrationB?: boolean };
async function nyDb({ migrationB = true }: Opsaetning = {}): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(STUB);
  await d.exec(FOER);
  await d.exec(MIGRATION_A);
  await d.exec(DATA);
  await d.exec(AKTIVER);
  if (migrationB) await d.exec(MIGRATION_B);
  return d;
}

const nu = () => Math.floor(Date.now() / 1000);
const aal1 = (sub: string) => ({ sub, role: "authenticated", aal: "aal1", amr: [{ method: "password", timestamp: nu() }] });
const aal2 = (sub: string, totpSek = nu()) => ({
  sub,
  role: "authenticated",
  aal: "aal2",
  amr: [{ method: "totp", timestamp: totpSek }, { method: "password", timestamp: totpSek - 60 }],
});

async function som<T>(d: PGlite, claims: Record<string, unknown> | null, f: (tx: Transaction) => Promise<T>): Promise<T> {
  return d.transaction(async (tx) => {
    await tx.exec(
      `set local role ${claims ? "authenticated" : "anon"};
       set local request.jwt.claims = '${JSON.stringify(claims ?? { role: "anon" }).replace(/'/g, "''")}';`,
    );
    return f(tx);
  });
}
async function v<T = unknown>(tx: Transaction, sql: string, p: unknown[] = []): Promise<T> {
  return (await tx.query<{ v: T }>(sql, p)).rows[0].v;
}
const antal = (tx: Transaction, tabel: string) => v<number>(tx, `select count(*)::int as v from ${tabel}`);

const TABELLER = [
  "public.trades",
  "public.messages",
  "public.betalinger",
  "public.forsendelser",
  "public.forsendelse_haendelser",
  "public.handel_levering",
  "public.andenchance_tilbud",
] as const;

async function md5Fn(d: PGlite, fn: string): Promise<string> {
  return (
    await d.query<{ m: string }>(
      `select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\\n]*', '', 'g'), '\\s', '', 'g'))) as m
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [fn],
    )
  ).rows[0].m;
}
async function md5Pol(d: PGlite, tabel: string, policy: string): Promise<string> {
  return (
    await d.query<{ m: string }>(
      `select md5(lower(regexp_replace(replace(permissive || '|' || cmd || '|' || array_to_string(roles, ',') || '|'
                || coalesce(qual, '') || '|' || coalesce(with_check, ''), 'public.', ''), '\\s', '', 'g'))) as m
         from pg_policies where schemaname = 'public' and tablename = $1 and policyname = $2`,
      [tabel, policy],
    )
  ).rows[0].m;
}

const GAMMEL_FN: Record<string, string> = {
  "public.er_staff()": "c60104d50290ed101923d4bb3d059840",
  "public.auktion_spoergsmaal_liste(uuid)": "38fc55bfba916542f7448e67aaf8bd6e",
  "public.beta_fejl_billede_maa_uploade(text)": "5a107368fca910d964b4cbfda56c7c78",
  "public.firma_faktura_salg(date,date,uuid,uuid)": "3e19eebfe328958da847fde4c09febc8",
};
const GAMMEL_POL: [string, string, string][] = [
  ["betaling_afvigelser", "betaling_afvigelser_select_chef", "c881bce9511c07a33de7f08341ab9f3d"],
  ["betalinger", "betalinger_select_part", "b6ee707d622710484e14086b0e01ade6"],
  ["employee_complaints", "employee_complaints_select_chef", "e17d2d7d9152046c5a00c81f4a6b4fe0"],
  ["employee_complaints", "employee_complaints_update_chef", "9daecf0383eeb2863ceb1c9723d0f9a1"],
  ["trades", "trades_select_own", "5acc25bf245a92e1288475f1d2d607dc"],
  ["messages", "messages_select_part", "debbc4a7f61cf249e5a71bdef365f86e"],
  ["forsendelser", "forsendelser_select_parter", "9efa06f6919426346483181c255aaca8"],
  ["forsendelse_haendelser", "forsendelse_haendelser_select_parter", "152a46d690321bbea1f65955743a1a41"],
  ["handel_levering", "handel_levering_select_parter", "9120622c45684afd1c0751f02dd887f5"],
  ["andenchance_tilbud", "andenchance_select_part", "b91b0b0a4f1c3f76c5405b7ae278aa5b"],
];
const NY_POL: [string, string, string][] = [
  ["trades", "trades_select_own", "2e89c2643eaa450ea0393cf576d1df5c"],
  ["messages", "messages_select_part", "023c3a5ab71305dac0fa6349b5f28d23"],
  ["forsendelser", "forsendelser_select_parter", "ab6c6b1d352f25cdeed87e813e2b204e"],
  ["forsendelse_haendelser", "forsendelse_haendelser_select_parter", "62cb6822f345370151e2cd43b7d3b7e2"],
  ["handel_levering", "handel_levering_select_parter", "3b4b7fc55aa1bd3db404a472e2dc8095"],
  ["andenchance_tilbud", "andenchance_select_part", "8b0272a18879686a9bbb036c80761865"],
];

let db: PGlite;
beforeAll(async () => {
  db = await nyDb();
  // Anden kørsel: alt er "allerede".
  const noter: string[] = [];
  await db.exec(MIGRATION_B, { onNotice: (n: { message: string }) => noter.push(n.message) } as never);
  expect(noter.filter((n) => n.includes(": ")).every((n) => n.endsWith("allerede"))).toBe(true);
  expect(noter.filter((n) => n.endsWith("allerede"))).toHaveLength(14);
});
afterAll(async () => {
  await db?.close();
});

describe("er_staff()", () => {
  it("kun sand ved aal2, aktivt to-trins-login og en frisk kode", async () => {
    const er = (c: Record<string, unknown> | null) => som(db, c, (tx) => v<boolean>(tx, `select public.er_staff() as v`));
    expect(await er(null)).toBe(false);
    expect(await er(aal1(B1))).toBe(false);
    expect(await er(aal2(B1))).toBe(false); // almindelig bruger med (falsk) aal2
    expect(await er(aal1(CHEF))).toBe(false);
    expect(await er(aal1(MEDARB))).toBe(false);
    expect(await er(aal2(CHEF))).toBe(true);
    expect(await er(aal2(MEDARB))).toBe(true);
    expect(await er(aal2(SAELGER))).toBe(false); // saelger er ikke staff i er_staff()
    expect(await er(aal2(UDEN))).toBe(false); // intet aktivt to-trins-login
    expect(await er(aal2(CHEF, nu() - 13 * 3600))).toBe(false); // koden er for gammel
    expect(await er({ ...aal2(CHEF), amr: [{ method: "password", timestamp: nu() }] })).toBe(false); // ingen totp i amr
  });

  it("inaktiv række i staff_to_trin giver ingen staff-adgang", async () => {
    await db.query(`update public.staff_to_trin set aktiv = false where bruger_id = $1`, [MEDARB]);
    try {
      expect(await som(db, aal2(MEDARB), (tx) => v<boolean>(tx, `select public.er_staff() as v`))).toBe(false);
      expect(await som(db, aal2(MEDARB), (tx) => antal(tx, "public.trades"))).toBe(1);
    } finally {
      await db.query(`update public.staff_to_trin set aktiv = true where bruger_id = $1`, [MEDARB]);
    }
  });

  it("ukendt (ikke godkendt) faktor giver ingen staff-adgang", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.mfa_factors (user_id, status) values ($1, 'verified') returning id`,
      [CHEF],
    );
    try {
      expect(await som(db, aal2(CHEF), (tx) => v<boolean>(tx, `select public.er_staff() as v`))).toBe(false);
    } finally {
      await db.query(`delete from auth.mfa_factors where id = $1`, [rows[0].id]);
    }
  });
});

describe("RLS på tabellerne", () => {
  for (const tabel of TABELLER) {
    it(`${tabel}: chef aal1 kun egne, aal2 alle; bruger kun egne`, async () => {
      expect(await som(db, aal1(CHEF), (tx) => antal(tx, tabel))).toBe(1);
      expect(await som(db, aal2(CHEF), (tx) => antal(tx, tabel))).toBe(3);
      expect(await som(db, aal1(MEDARB), (tx) => antal(tx, tabel))).toBe(1);
      expect(await som(db, aal2(MEDARB), (tx) => antal(tx, tabel))).toBe(tabel === "public.betalinger" ? 1 : 3);
      expect(await som(db, aal2(SAELGER), (tx) => antal(tx, tabel))).toBe(0);
      // B1 er part i T1 og T3 (byder på ét andenchance-tilbud).
      expect(await som(db, aal2(B1), (tx) => antal(tx, tabel))).toBe(tabel === "public.andenchance_tilbud" ? 1 : 2);
    });
  }

  it("auctions: skjulte og kunst-afventende kun for sælger, deltagere og staff med aal2", async () => {
    const ids = (c: Record<string, unknown> | null) =>
      som(db, c, async (tx) => (await tx.query<{ id: string }>(`select id from public.auctions order by id`)).rows.map((r) => r.id));
    expect(await ids(aal1(CHEF))).toEqual([A1, A4]);
    expect(await ids(aal2(CHEF))).toEqual([A1, A2, A3, A4]);
    expect(await ids(aal1(MEDARB))).toEqual([A1]);
    expect(await ids(aal2(MEDARB))).toEqual([A1, A2, A3, A4]);
    expect(await ids(aal1(B1))).toEqual([A1, A3]);
    expect(await ids(null)).toEqual([A1]);
  });

  it("betaling_afvigelser og employee_complaints: kun chef med aal2", async () => {
    for (const t of ["public.betaling_afvigelser", "public.employee_complaints"]) {
      expect(await som(db, aal1(CHEF), (tx) => antal(tx, t))).toBe(0);
      expect(await som(db, aal2(CHEF), (tx) => antal(tx, t))).toBe(1);
      expect(await som(db, aal2(MEDARB), (tx) => antal(tx, t))).toBe(0);
      expect(await som(db, aal2(B1), (tx) => antal(tx, t))).toBe(0);
    }
  });

  it("employee_complaints: chef med aal1 kan ikke opdatere, med aal2 kan", async () => {
    const opdater = (c: Record<string, unknown>) =>
      som(db, c, async (tx) => (await tx.query(`update public.employee_complaints set tekst = tekst`)).affectedRows);
    await db.exec(`grant update on public.employee_complaints to authenticated`);
    expect(await opdater(aal1(CHEF))).toBe(0);
    expect(await opdater(aal2(CHEF))).toBe(1);
  });
});

describe("policies med (select er_staff())", () => {
  it("de seks policies har den nye form (én evaluering pr. forespørgsel)", async () => {
    for (const [t, p, m] of NY_POL) expect(await md5Pol(db, t, p)).toBe(m);
    const { rows } = await db.query<{ qual: string }>(
      `select qual from pg_policies where schemaname = 'public' and policyname = any($1)`,
      [NY_POL.map((x) => x[1])],
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.qual).toMatch(/\( SELECT er_staff\(\) AS er_staff\)/);
  });
});

describe("funktioner for authenticated", () => {
  it("min_rolle() og min_profil() er uændrede ved aal1", async () => {
    expect(await som(db, aal1(CHEF), (tx) => v<string>(tx, `select public.min_rolle() as v`))).toBe("chef");
    expect(await som(db, aal1(MEDARB), (tx) => v<string>(tx, `select (public.min_profil()).rolle as v`))).toBe("medarbejder");
    expect(await som(db, aal1(SAELGER), (tx) => v<string>(tx, `select public.min_rolle() as v`))).toBe("saelger");
    expect(await md5Fn(db, "public.min_rolle()")).toBe("2e2b6b44f51252f5f292c9748367800c");
    expect(await md5Fn(db, "public.min_profil()")).toBe("5a4b00fa8869ba98b0c54fc56efca1c3");
  });

  it("auktion_spoergsmaal_liste: skjulte spørgsmål og skjulte auktioner kun for staff med aal2", async () => {
    const liste = (c: Record<string, unknown> | null, a: string) =>
      som(db, c, (tx) => v<number>(tx, `select count(*)::int as v from public.auktion_spoergsmaal_liste($1)`, [a]));
    expect(await liste(aal1(MEDARB), A1)).toBe(1);
    expect(await liste(aal2(MEDARB), A1)).toBe(2);
    expect(await liste(aal1(MEDARB), A2)).toBe(0);
    expect(await liste(aal2(MEDARB), A2)).toBe(1);
    expect(await liste(null, A1)).toBe(1);
    expect(await liste(aal2(B1), A1)).toBe(1);
  });

  it("hent_medarbejdere, antal_aabne_sager og antal_ubesvarede_staff_samtaler kræver aal2", async () => {
    const tal = (c: Record<string, unknown>) =>
      som(db, c, async (tx) => ({
        medarb: await v<number>(tx, `select count(*)::int as v from public.hent_medarbejdere()`),
        sager: await v<number>(tx, `select public.antal_aabne_sager() as v`),
        samtaler: await v<number>(tx, `select public.antal_ubesvarede_staff_samtaler() as v`),
      }));
    expect(await tal(aal1(MEDARB))).toEqual({ medarb: 0, sager: 0, samtaler: 0 });
    expect(await tal(aal2(MEDARB))).toEqual({ medarb: 3, sager: 1, samtaler: 1 });
  });

  it("mit_leveringsvalg og mine_forsendelse_label: andres kun med aal2", async () => {
    const lev = (c: Record<string, unknown>) =>
      som(db, c, (tx) => v<number>(tx, `select count(*)::int as v from public.mit_leveringsvalg($1)`, [T1]));
    const label = (c: Record<string, unknown>) =>
      som(db, c, (tx) => v<number>(tx, `select count(*)::int as v from public.mine_forsendelse_label($1)`, [F1]));
    expect(await lev(aal1(CHEF))).toBe(0);
    expect(await lev(aal2(CHEF))).toBe(1);
    expect(await lev(aal1(B1))).toBe(1); // køberen selv
    expect(await label(aal1(CHEF))).toBe(0);
    expect(await label(aal2(CHEF))).toBe(1);
    expect(await label(aal1(B2))).toBe(1); // sælgeren selv
  });

  it("firma_faktura_salg: chef slår et andet firma op kun med aal2", async () => {
    await expect(
      som(db, aal1(CHEF), (tx) => v(tx, `select public.firma_faktura_salg(null, null, null, $1) as v`, [B2])),
    ).rejects.toThrow(/Ingen adgang/);
    expect(await som(db, aal2(CHEF), (tx) => v(tx, `select public.firma_faktura_salg(null, null, null, $1) as v`, [B2]))).toBeNull();
    // Eget opslag (intet firma) virker ved aal1 som før.
    expect(await som(db, aal1(B2), (tx) => v(tx, `select public.firma_faktura_salg() as v`))).toBeNull();
  });
});

describe("storage", () => {
  const LAES: [string, string, string][] = [
    ["fragt_label_maa_laese", "fragt-labels", `${B2}/t1.pdf`],
    ["pakke_billede_maa_laese", "pakke-billeder", `${B2}/${T1}/pakke.jpg`],
    ["sag_billede_maa_laese", "sag-billeder", `${B1}/${T1}/sag.jpg`],
  ];
  for (const [fn, bucket, sti] of LAES) {
    it(`${fn}: andres fil kun for staff med aal2 (funktion og policy ens)`, async () => {
      const maa = (c: Record<string, unknown>) => som(db, c, (tx) => v<boolean>(tx, `select public.${fn}($1) as v`, [sti]));
      const ser = (c: Record<string, unknown>) =>
        som(db, c, (tx) => v<number>(tx, `select count(*)::int as v from storage.objects where bucket_id = $1 and name = $2`, [bucket, sti]));
      for (const c of [aal1(CHEF), aal1(MEDARB), aal2(SAELGER), aal2(UDEN)]) {
        expect(await maa(c)).toBe(false);
        expect(await ser(c)).toBe(0);
      }
      for (const c of [aal2(CHEF), aal2(MEDARB)]) {
        expect(await maa(c)).toBe(true);
        expect(await ser(c)).toBe(1);
      }
    });
  }

  it("egne filer kan stadig læses ved aal1", async () => {
    const sti = `${CHEF}/${T2}/egen.jpg`;
    expect(await som(db, aal1(CHEF), (tx) => v<boolean>(tx, `select public.pakke_billede_maa_laese($1) as v`, [sti]))).toBe(true);
    expect(
      await som(db, aal1(CHEF), (tx) => v<number>(tx, `select count(*)::int as v from storage.objects where name = $1`, [sti])),
    ).toBe(1);
  });

  it('"Meld fejl" før lancering: staff uploader til egen mappe uden aal2 - almindelige brugere kræver beta', async () => {
    const sti = (b: string) => `${b}/${crypto.randomUUID()}.jpg`;
    const maa = (c: Record<string, unknown>, s: string) =>
      som(db, c, (tx) => v<boolean>(tx, `select public.beta_fejl_billede_maa_uploade($1) as v`, [s]));
    expect(await maa(aal1(CHEF), sti(CHEF))).toBe(true);
    expect(await maa(aal1(MEDARB), sti(MEDARB))).toBe(true);
    expect(await maa(aal2(MEDARB), sti(MEDARB))).toBe(true);
    expect(await maa(aal1(MEDARB), sti(B1))).toBe(false); // ikke en andens mappe
    expect(await maa(aal1(SAELGER), sti(SAELGER))).toBe(false); // saelger: som før (kun beta)
    expect(await maa(aal1(B1), sti(B1))).toBe(false); // ingen beta-invitation
    // Policyen på storage.objects (insert) giver samme svar.
    await som(db, aal1(MEDARB), (tx) =>
      tx.query(`insert into storage.objects (bucket_id, name) values ('beta-fejl-billeder', $1)`, [sti(MEDARB)]),
    );
    await expect(
      som(db, aal1(B1), (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('beta-fejl-billeder', $1)`, [sti(B1)])),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("md5-drift-tjek", () => {
  it("afviser en uventet krop i er_staff() - intet ændres", async () => {
    const d = await nyDb({ migrationB: false });
    try {
      await d.exec(`create or replace function public.er_staff() returns boolean language sql stable security definer
        set search_path = public as $$ select exists (select 1 from public.users u where u.id = auth.uid()
        and u.rolle in ('medarbejder', 'admin', 'chef', 'saelger')) $$;`);
      await expect(d.exec(MIGRATION_B)).rejects.toThrow(/er_staff\(\): md5 .* hverken gammel eller ny/);
    } finally {
      await d.close();
    }
  });

  it("afviser en uventet policy - og ruller funktionerne tilbage (én transaktion)", async () => {
    const d = await nyDb({ migrationB: false });
    try {
      await d.exec(`drop policy betalinger_select_part on public.betalinger;
        create policy betalinger_select_part on public.betalinger for select to authenticated using (true);`);
      await expect(d.exec(MIGRATION_B)).rejects.toThrow(/betalinger_select_part: md5 .* hverken gammel eller ny/);
      for (const [fn, m] of Object.entries(GAMMEL_FN)) expect(await md5Fn(d, fn)).toBe(m);
      expect(await md5Pol(d, "betaling_afvigelser", "betaling_afvigelser_select_chef")).toBe(GAMMEL_POL[0][2]);
    } finally {
      await d.close();
    }
  });

  it("afviser, hvis migration A (staff_aal2_ok) ikke er kørt", async () => {
    const d = new PGlite();
    try {
      await d.exec(STUB);
      await d.exec(FOER);
      await expect(d.exec(MIGRATION_B)).rejects.toThrow(/Forudsætning mangler: kør 20261027010000/);
    } finally {
      await d.close();
    }
  });

  it("fixturen har de gamle md5 fra produktion/test", async () => {
    const d = await nyDb({ migrationB: false });
    try {
      for (const [fn, m] of Object.entries(GAMMEL_FN)) expect(await md5Fn(d, fn)).toBe(m);
      for (const [t, p, m] of GAMMEL_POL) expect(await md5Pol(d, t, p)).toBe(m);
    } finally {
      await d.close();
    }
  });
});

describe("rollback", () => {
  it("gendanner den gamle opførsel og de gamle md5 - og B kan køres igen bagefter", async () => {
    const d = await nyDb();
    try {
      await d.exec(ROLLBACK);
      await d.exec(ROLLBACK); // også idempotent
      for (const [fn, m] of Object.entries(GAMMEL_FN)) expect(await md5Fn(d, fn)).toBe(m);
      for (const [t, p, m] of GAMMEL_POL) expect(await md5Pol(d, t, p)).toBe(m);
      // Den gamle opførsel: rollen alene giver staff-adgang (også aal1).
      expect(await som(d, aal1(CHEF), (tx) => v<boolean>(tx, `select public.er_staff() as v`))).toBe(true);
      expect(await som(d, aal1(CHEF), (tx) => antal(tx, "public.trades"))).toBe(3);
      expect(await som(d, aal1(CHEF), (tx) => antal(tx, "public.betaling_afvigelser"))).toBe(1);
      expect(
        await som(d, aal1(MEDARB), (tx) => v<number>(tx, `select count(*)::int as v from public.auktion_spoergsmaal_liste($1)`, [A1])),
      ).toBe(2);
      await d.exec(MIGRATION_B);
      expect(await som(d, aal1(CHEF), (tx) => antal(tx, "public.trades"))).toBe(1);
    } finally {
      await d.close();
    }
  });
});
