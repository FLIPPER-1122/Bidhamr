// Migrationen 20261023030000_boost.sql i PGlite (Postgres i processen - ingen
// database, intet netværk). Stubs af de tabeller, migrationen bygger på;
// derefter køres migrationen TO gange, og reglerne testes: køb (ét køb giver
// point én gang), boost (point kan ikke bruges to gange, ét aktivt boost pr.
// auktion), saldoen kan aldrig blive negativ, append-only ledger, optjening
// og tilbageførsel ved salg, firmaer afvist, staff-justering og -refusion,
// visning (rotation) og fakturaer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  erBoostRefusion,
  forventetBoostRefunderet,
  boostStatusAfviger,
} from "@/lib/betaling/afstemning";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261023030000_boost.sql"),
  "utf8",
);

const PRIVAT = "00000000-0000-4000-8000-0000000000a1";
const PRIVAT2 = "00000000-0000-4000-8000-0000000000a2";
const FIRMA = "00000000-0000-4000-8000-0000000000b1";
const SPAERRET = "00000000-0000-4000-8000-0000000000c1";
const CHEF = "00000000-0000-4000-8000-0000000000d1";
const ADMIN = "00000000-0000-4000-8000-0000000000d2";
const SYSTEM = "00000000-0000-4000-8000-000000000000";

const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger',
  konto_type text not null default 'privat', konto_lukket_kl timestamptz, konto_slettet_kl timestamptz,
  suspenderet boolean default false, suspenderet_til timestamptz);
insert into public.users (id, navn, rolle, konto_type, suspenderet) values
  ('${PRIVAT}', 'Privat', 'bruger', 'privat', false), ('${PRIVAT2}', 'Privat 2', 'bruger', 'privat', false),
  ('${FIRMA}', 'Firma', 'bruger', 'erhverv', false), ('${SPAERRET}', 'Spærret', 'bruger', 'privat', true),
  ('${CHEF}', 'Chef', 'chef', 'privat', false), ('${ADMIN}', 'Admin', 'admin', 'privat', false),
  ('${SYSTEM}', 'BidHamr', 'bruger', 'privat', false);
create function public.bidhamr_system_id() returns uuid language sql immutable as $$ select '${SYSTEM}'::uuid $$;
create table public.stub_noedstop (stoppet boolean not null default false);
insert into public.stub_noedstop values (false);
create function public.nye_betalinger_stoppet() returns boolean language sql stable as
  $$ select stoppet from public.stub_noedstop $$;
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  constraint moderation_log_handling_check check (handling = any (array['advarsel','returfragt_refunderet'])),
  constraint moderation_log_maal_type_check check (maal_type = any (array['bruger','handel'])));
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid, titel text,
  kategori text default 'Andet', status text default 'aktiv', skjult boolean default false, arkiveret_kl timestamptz,
  pauset_kl timestamptz, slutter_kl timestamptz default now() + interval '3 days', erhverv boolean default false);
create table public.trades (id uuid primary key default gen_random_uuid(), status text default 'modtaget');
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid, seller_id uuid,
  buyer_id uuid default gen_random_uuid(), bud_oere bigint not null default 10000,
  status text default 'betalt', frigivet_kl timestamptz, annulleret_kl timestamptz, refusion_anmodet_kl timestamptz,
  refunderet_kl timestamptz, refusion_oere bigint, bidhamr_daekker_kl timestamptz, indsigelse_tabt_kl timestamptz,
  indsigelse_kl timestamptz, indsigelse_status text);
-- Den fælles definition fra 20261023020000_badge_konkurrence.sql (kopi).
create function public.gennemfoerte_salg_min_bud_oere() returns bigint language sql immutable as $$ select 5000::bigint $$;
create function public.gennemfoerte_salg(p_fra timestamptz default null, p_til timestamptz default null, p_saelger uuid default null)
returns table (betaling_id uuid, trade_id uuid, seller_id uuid, buyer_id uuid, frigivet_kl timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.id, b.trade_id, b.seller_id, b.buyer_id, b.frigivet_kl
    from public.betalinger b left join public.trades t on t.id = b.trade_id
   where b.status = 'betalt' and b.frigivet_kl is not null
     and (p_fra is null or b.frigivet_kl >= p_fra) and (p_til is null or b.frigivet_kl < p_til)
     and (p_saelger is null or b.seller_id = p_saelger)
     and b.seller_id <> public.bidhamr_system_id()
     and b.bud_oere >= public.gennemfoerte_salg_min_bud_oere()
     and b.annulleret_kl is null and b.refusion_anmodet_kl is null and b.refunderet_kl is null
     and coalesce(b.refusion_oere, 0) = 0 and b.bidhamr_daekker_kl is null and b.indsigelse_tabt_kl is null
     and (b.indsigelse_kl is null or coalesce(b.indsigelse_status, '') in ('won', 'warning_closed', 'prevented'))
     and coalesce(t.status, '') <> 'annulleret';
$$;
create table public.fakturaer (
  id uuid primary key default gen_random_uuid(), dokument text not null, part text not null, bruger_id uuid not null,
  betaling_id uuid, trade_id uuid, firma_regning_id uuid, krediterer_id uuid references public.fakturaer(id),
  linjer jsonb not null, beloeb_oere bigint not null, moms_oere bigint not null, betalt_dato date not null,
  stripe_reference text, status text not null default 'venter', manuel boolean not null default false, sidste_fejl text,
  slags text not null default 'salg', returfragt_id uuid, oprettet_kl timestamptz default now(),
  constraint fakturaer_kilde check (
    (dokument in ('faktura', 'kreditnota') and betaling_id is not null and firma_regning_id is null and part in ('koeber', 'saelger'))
    or (dokument in ('abonnement', 'abonnement_retur') and firma_regning_id is not null and betaling_id is null and part = 'firma')),
  constraint fakturaer_slags_check check (slags in ('salg', 'returfragt', 'sag_returfragt')));
create function public.faktura_linje(p_kode text, p_tekst text, p_beloeb bigint) returns jsonb language sql immutable as
  $$ select case when p_beloeb is null or p_beloeb <= 0 then null
            else jsonb_build_object('kode', p_kode, 'tekst', p_tekst, 'beloeb_oere', p_beloeb) end $$;
create function public.faktura_moms(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint - round((l->>'beloeb_oere')::numeric * 4 / 5)::bigint), 0)::bigint
     from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
create function public.faktura_sum(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint), 0)::bigint from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
`;

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}
async function j(sql: string, p: unknown[] = []): Promise<Record<string, unknown>> {
  const r = await en<{ v: Record<string, unknown> }>(sql, p);
  return r.v;
}
const saldo = async (b: string) => (await en<{ s: number }>(`select public.boost_saldo($1) as s`, [b])).s;
const koebStart = (b: string) => j(`select public.boost_koeb_start($1) as v`, [b]);
const brug = (b: string, a: string, n = randomUUID()) => j(`select public.boost_brug($1, $2, $3) as v`, [b, a, n]);

async function fejlkode(sql: string, p: unknown[] = []): Promise<string> {
  try {
    await db.query(sql, p);
    return "ingen fejl";
  } catch (err) {
    return String((err as { code?: string }).code ?? (err as Error).message);
  }
}

// Et betalt køb (100 point). Svar: købets id og PaymentIntent.
async function koebtPoint(b: string, beloeb = 3900) {
  const s = await koebStart(b);
  const pi = `pi_test_${String(s.id).replace(/-/g, "")}_${s.pi_forsoeg}`;
  expect((await en<{ v: string }>(`select public.boost_koeb_gem_pi($1, $2, $3) as v`, [s.id, pi, s.pi_forsoeg])).v).toBe("ok");
  const r = await j(`select public.boost_koeb_registrer($1, 'succeeded', $2, $3, null) as v`, [pi, `ch_${String(s.id).slice(0, 8)}`, beloeb]);
  return { id: s.id as string, pi, r };
}

async function auktion(ejer: string, o: { titel?: string; kategori?: string; slutterOm?: string; status?: string; erhverv?: boolean; skjult?: boolean } = {}) {
  const a = await en<{ id: string }>(
    `insert into public.auctions (bruger_id, titel, kategori, status, slutter_kl, erhverv, skjult)
     values ($1, $2, $3, $4, now() + $5::interval, $6, $7) returning id`,
    [ejer, o.titel ?? "Cykel", o.kategori ?? "Andet", o.status ?? "aktiv", o.slutterOm ?? "3 days", o.erhverv ?? false, o.skjult ?? false],
  );
  return a.id;
}

// Et frigivet salg (standard: ny køber og bud 100 kr.).
async function frigivetSalg(saelger: string, o: { foer?: boolean; koeber?: string; budOere?: number } = {}) {
  const t = await en<{ id: string }>(`insert into public.trades default values returning id`);
  const b = await en<{ id: string }>(
    `insert into public.betalinger (trade_id, seller_id, status, frigivet_kl, buyer_id, bud_oere)
     values ($1, $2, 'betalt', $3, $4, $5) returning id`,
    [
      t.id,
      saelger,
      o.foer ? new Date(Date.now() - 86_400_000).toISOString() : new Date().toISOString(),
      o.koeber ?? randomUUID(),
      o.budOere ?? 10_000,
    ],
  );
  return b.id;
}

// Brugeren tømmes til 0 med en staff-justering (testhjælper).
async function nulstil(b: string) {
  const s = await saldo(b);
  if (s > 0) await j(`select public.boost_staff_justering($1, $2, $3, 'test', $4) as v`, [CHEF, b, -s, randomUUID()]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
  // Salg frigivet før migrationen giver ikke point: flyt starttidspunktet en
  // time tilbage, så testenes "nu" ligger efter (foer = et døgn før).
  await db.exec(`update public.boost_indstillinger set optjening_fra_kl = now() - interval '1 hour'`);
});

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("rettigheder: kun service role har RPC'erne; brugeren mine_point/min_auktion_boost; alle boost_top/aktive_boosts", async () => {
    const r = await en<Record<string, boolean>>(`
      select has_function_privilege('authenticated', 'public.boost_brug(uuid,uuid,uuid)', 'execute') as auth_brug,
             has_function_privilege('service_role', 'public.boost_brug(uuid,uuid,uuid)', 'execute') as sr_brug,
             has_function_privilege('authenticated', 'public.boost_koeb_start(uuid,boolean)', 'execute') as auth_start,
             has_function_privilege('authenticated', 'public.boost_point_synk(integer)', 'execute') as auth_synk,
             has_function_privilege('authenticated', 'public.boost_staff_justering(uuid,uuid,integer,text,uuid)', 'execute') as auth_just,
             has_function_privilege('anon', 'public.mine_point()', 'execute') as anon_mine,
             has_function_privilege('authenticated', 'public.mine_point()', 'execute') as auth_mine,
             has_function_privilege('authenticated', 'public.min_auktion_boost(uuid)', 'execute') as auth_min,
             has_function_privilege('anon', 'public.boost_top(text,text)', 'execute') as anon_top,
             has_function_privilege('anon', 'public.aktive_boosts(uuid[])', 'execute') as anon_aktive,
             has_function_privilege('service_role', 'public.boost_laas_bruger(uuid)', 'execute') as sr_laas,
             has_function_privilege('service_role', 'public.boost_postering_indsaet(uuid,text,integer,uuid,uuid,uuid,uuid,text,uuid,integer)', 'execute') as sr_indsaet,
             has_function_privilege('service_role', 'public.boost_koeb_tilbagefoer(uuid)', 'execute') as sr_tilbage,
             has_function_privilege('service_role', 'public.boost_saldo(uuid)', 'execute') as sr_saldo,
             has_table_privilege('service_role', 'public.boost_posteringer', 'insert') as sr_ins,
             has_table_privilege('service_role', 'public.boost_posteringer', 'update') as sr_upd,
             has_table_privilege('service_role', 'public.boost_posteringer', 'delete') as sr_del,
             has_table_privilege('authenticated', 'public.boost_posteringer', 'insert') as auth_ins,
             has_table_privilege('anon', 'public.boost_posteringer', 'select') as anon_sel,
             has_column_privilege('authenticated', 'public.boost_posteringer', 'point', 'select') as auth_point,
             has_column_privilege('authenticated', 'public.boost_posteringer', 'begrundelse', 'select') as auth_begr,
             has_column_privilege('authenticated', 'public.boost_koeb', 'stripe_payment_intent_id', 'select') as auth_pi,
             has_table_privilege('service_role', 'public.boost_koeb', 'update') as sr_koeb_upd`);
    expect(r).toEqual({
      auth_brug: false,
      sr_brug: true,
      auth_start: false,
      auth_synk: false,
      auth_just: false,
      anon_mine: false,
      auth_mine: true,
      auth_min: true,
      anon_top: true,
      anon_aktive: true,
      sr_laas: false,
      sr_indsaet: false,
      sr_tilbage: false,
      sr_saldo: true,
      sr_ins: false,
      sr_upd: false,
      sr_del: false,
      auth_ins: false,
      anon_sel: false,
      auth_point: true,
      auth_begr: false,
      auth_pi: false,
      sr_koeb_upd: false,
    });
  });

  it("alle RPC'er er security definer med search_path = ''", async () => {
    const { rows } = await db.query<{ proname: string; sd: boolean; cfg: string[] | null }>(`
      select p.proname, p.prosecdef as sd, p.proconfig as cfg from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and (p.proname like 'boost%' or p.proname in ('mine_point', 'min_auktion_boost', 'aktive_boosts',
              'faktura_planlaeg_boost', 'auktion_boosts_et_aktivt'))
         and p.proname not in ('boost_forbyd_aendring', 'boost_koeb_forbyd_sletning', 'boost_koeb_laaste_felter', 'boost_laas_bruger')`);
    expect(rows.length).toBeGreaterThanOrEqual(22);
    for (const r of rows) {
      expect(r.sd, r.proname).toBe(true);
      expect(r.cfg, r.proname).toContain('search_path=""');
    }
  });

  it("konstanterne: 100 point for 39 kr., boost 50 point i 24 timer, 10 point pr. salg, 4 pladser", async () => {
    const s = await en(`select pakke_point, pakke_pris_oere::int as pris, boost_point, boost_timer, point_pr_salg, maks_pladser,
                               point_udloeber_dage, refusion_ved_lukning, kraev_fortrydelse_samtykke from public.boost_indstillinger`);
    expect(s).toEqual({
      pakke_point: 100,
      pris: 3900,
      boost_point: 50,
      boost_timer: 24,
      point_pr_salg: 10,
      maks_pladser: 4,
      point_udloeber_dage: null,
      refusion_ved_lukning: false,
      kraev_fortrydelse_samtykke: false,
    });
    // Udløb og refusion ved lukning kan ikke slås til, før logikken er bygget.
    expect(await fejlkode(`update public.boost_indstillinger set point_udloeber_dage = 365`)).toBe("23514");
    expect(await fejlkode(`update public.boost_indstillinger set refusion_ved_lukning = true`)).toBe("23514");
  });
});

describe("køb af point", () => {
  it("dobbelt køb: samme åbne køb igen, og betalingen giver point præcis én gang", async () => {
    const s1 = await koebStart(PRIVAT);
    expect(s1).toMatchObject({ kode: "ok", point: 100, beloeb_oere: 3900, pi_forsoeg: 0 });
    const s2 = await koebStart(PRIVAT);
    expect(s2).toMatchObject({ kode: "findes", id: s1.id });
    const pi = `pi_test_dobbelt_${String(s1.id).slice(0, 8)}`;
    expect((await en<{ v: string }>(`select public.boost_koeb_gem_pi($1, $2, 0) as v`, [s1.id, pi])).v).toBe("ok");
    // En anden PaymentIntent kan ikke gemmes oven på.
    expect((await en<{ v: string }>(`select public.boost_koeb_gem_pi($1, 'pi_andet', 0) as v`, [s1.id])).v).toBe("nej");
    const r1 = await j(`select public.boost_koeb_registrer($1, 'succeeded', 'ch_dobbelt', 3900, null) as v`, [pi]);
    const r2 = await j(`select public.boost_koeb_registrer($1, 'succeeded', 'ch_dobbelt', 3900, null) as v`, [pi]);
    expect(r1.kode).toBe("betalt");
    expect(r2.kode).toBe("allerede");
    expect(await saldo(PRIVAT)).toBe(100);
    const n = await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where boost_koeb_id = $1`, [s1.id]);
    expect(n.n).toBe(1);
    // Direkte forsøg på en ekstra køb-postering for samme køb: intet.
    const igen = await en<{ v: boolean }>(`select public.boost_postering_indsaet($1, 'koeb', 100, p_koeb => $2) as v`, [PRIVAT, s1.id]);
    expect(igen.v).toBe(false);
    expect(await saldo(PRIVAT)).toBe(100);
    // Nyt køb efter det betalte: et nyt køb.
    const s3 = await koebStart(PRIVAT);
    expect(s3.kode).toBe("ok");
    expect(s3.id).not.toBe(s1.id);
    await nulstil(PRIVAT);
  });

  it("betalt med et andet beløb: ingen point, claimet til refusion", async () => {
    const k = await koebtPoint(PRIVAT2, 100);
    expect(k.r.kode).toBe("beloeb_afviger");
    expect(await saldo(PRIVAT2)).toBe(0);
    const s = await en(`select status, refusion_aarsag from public.boost_koeb where id = $1`, [k.id]);
    expect(s).toEqual({ status: "refunderes", refusion_aarsag: "beloeb" });
    expect((await en<{ v: string }>(`select public.boost_koeb_refusion_resultat($1, true, 're_1', null) as v`, [k.id])).v).toBe("refunderet");
    // Ingen tilbageførsel - der var ingen point.
    const n = await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where boost_koeb_id = $1`, [k.id]);
    expect(n.n).toBe(0);
  });

  it("annulleret PaymentIntent kasseres; betales den alligevel, er den 'kasseret'", async () => {
    const s = await koebStart(PRIVAT2);
    const pi = `pi_test_kasseret_${String(s.id).slice(0, 8)}`;
    await en(`select public.boost_koeb_gem_pi($1, $2, 0)`, [s.id, pi]);
    expect((await j(`select public.boost_koeb_registrer($1, 'canceled', null, null, null) as v`, [pi])).kode).toBe("nulstillet");
    expect((await j(`select public.boost_koeb_registrer($1, 'succeeded', 'ch_k', 3900, null) as v`, [pi])).kode).toBe("kasseret");
    expect(await saldo(PRIVAT2)).toBe(0);
    const k = await en<{ pi_forsoeg: number; stripe_payment_intent_id: string | null }>(
      `select pi_forsoeg, stripe_payment_intent_id from public.boost_koeb where id = $1`, [s.id]);
    expect(k).toEqual({ pi_forsoeg: 1, stripe_payment_intent_id: null });
  });

  it("nødstop for nye betalinger: PaymentIntenten gemmes ikke", async () => {
    await db.exec(`update public.stub_noedstop set stoppet = true`);
    const s = await koebStart(PRIVAT2);
    const v = await en<{ v: string }>(`select public.boost_koeb_gem_pi($1, 'pi_noedstop', $2) as v`, [s.id, s.pi_forsoeg]);
    expect(v.v).toBe("noedstop");
    await db.exec(`update public.stub_noedstop set stoppet = false`);
  });

  it("firmaer og spærrede konti kan ikke købe", async () => {
    expect((await koebStart(FIRMA)).kode).toBe("erhverv");
    expect((await koebStart(SPAERRET)).kode).toBe("spaerret");
    expect((await koebStart(randomUUID())).kode).toBe("ikke_fundet");
  });
});

describe("boost", () => {
  it("dobbelt boost: samme nøgle giver samme boost, og point bruges kun én gang", async () => {
    await nulstil(PRIVAT);
    await koebtPoint(PRIVAT); // 100
    const a1 = await auktion(PRIVAT);
    const a2 = await auktion(PRIVAT);
    const a3 = await auktion(PRIVAT);
    const n = randomUUID();
    const b1 = await brug(PRIVAT, a1, n);
    expect(b1).toMatchObject({ kode: "ok", saldo: 50 });
    const b2 = await brug(PRIVAT, a1, n);
    expect(b2).toMatchObject({ kode: "allerede", boost_id: b1.boost_id, saldo: 50 });
    // Ny nøgle, samme auktion: højst ét aktivt boost.
    const b3 = await brug(PRIVAT, a1);
    expect(b3.kode).toBe("boostet");
    expect(await saldo(PRIVAT)).toBe(50);
    expect((await brug(PRIVAT, a2)).kode).toBe("ok");
    expect(await saldo(PRIVAT)).toBe(0);
    const tom = await brug(PRIVAT, a3);
    expect(tom).toMatchObject({ kode: "for_faa_point", saldo: 0, pris: 50 });
    // Varer 24 timer.
    const t = await en<{ timer: number }>(
      `select round(extract(epoch from (slut_kl - start_kl)) / 3600)::int as timer from public.auktion_boosts where id = $1`, [b1.boost_id]);
    expect(t.timer).toBe(24);
    // En nøgle kan ikke genbruges på en anden auktion.
    expect((await brug(PRIVAT, a3, n)).kode).toBe("ugyldig");
  });

  it("kun ejeren, kun aktive auktioner, ikke firmaer", async () => {
    await koebtPoint(PRIVAT2); // 100
    const fremmed = await auktion(PRIVAT);
    expect((await brug(PRIVAT2, fremmed)).kode).toBe("ikke_ejer");
    expect((await brug(PRIVAT2, await auktion(PRIVAT2, { status: "afsluttet" }))).kode).toBe("ikke_aktiv");
    expect((await brug(PRIVAT2, await auktion(PRIVAT2, { skjult: true }))).kode).toBe("ikke_aktiv");
    expect((await brug(PRIVAT2, await auktion(PRIVAT2, { slutterOm: "-1 hour" }))).kode).toBe("ikke_aktiv");
    expect((await brug(PRIVAT2, await auktion(PRIVAT2, { slutterOm: "30 minutes" }))).kode).toBe("slutter_snart");
    expect((await brug(PRIVAT2, randomUUID())).kode).toBe("ikke_fundet");
    expect((await brug(FIRMA, await auktion(FIRMA, { erhverv: true }))).kode).toBe("erhverv");
    expect((await brug(SPAERRET, await auktion(SPAERRET))).kode).toBe("spaerret");
    // Intet er brugt.
    expect(await saldo(PRIVAT2)).toBe(100);
  });

  it("et boost kan ikke indsættes oven i et aktivt (trigger, også uden RPC'en)", async () => {
    const a = await auktion(PRIVAT2);
    expect((await brug(PRIVAT2, a)).kode).toBe("ok");
    const kode = await fejlkode(
      `insert into public.auktion_boosts (auktion_id, bruger_id, point, slut_kl, idempotens_noegle)
       values ($1, $2, 50, now() + interval '1 hour', gen_random_uuid())`,
      [a, PRIVAT2],
    );
    expect(kode).toBe("BHB03");
  });
});

describe("saldoen kan aldrig blive negativ, og ledgeren er append-only", () => {
  it("et forbrug ud over saldoen afvises (BHB01) - også direkte", async () => {
    await nulstil(PRIVAT2);
    expect(await saldo(PRIVAT2)).toBe(0);
    const kode = await fejlkode(
      `insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, boost_id)
       values ($1, 'forbrug', -50, 999, (select id from public.auktion_boosts limit 1))`,
      [PRIVAT2],
    );
    expect(kode).toBe("BHB01");
    // saldo_efter kan ikke snydes: triggeren regner den selv.
    await j(`select public.boost_staff_justering($1, $2, 7, 'test', $3) as v`, [CHEF, PRIVAT2, randomUUID()]);
    const sidste = await en<{ saldo_efter: number }>(
      `select saldo_efter from public.boost_posteringer where bruger_id = $1 order by oprettet_kl desc, id desc limit 1`, [PRIVAT2]);
    expect(sidste.saldo_efter).toBe(7);
    const min = await en<{ m: number }>(`select min(saldo_efter)::int as m from public.boost_posteringer`);
    expect(min.m).toBeGreaterThanOrEqual(0);
    await nulstil(PRIVAT2);
  });

  it("posteringer, boosts og køb kan ikke ændres eller slettes", async () => {
    expect(await fejlkode(`update public.boost_posteringer set point = 1000`)).toBe("BHB02");
    expect(await fejlkode(`delete from public.boost_posteringer`)).toBe("BHB02");
    expect(await fejlkode(`truncate public.boost_posteringer`)).toBe("BHB02");
    expect(await fejlkode(`update public.auktion_boosts set slut_kl = now() + interval '100 days'`)).toBe("BHB02");
    expect(await fejlkode(`delete from public.auktion_boosts`)).toBe("BHB02");
    expect(await fejlkode(`delete from public.boost_koeb`)).not.toBe("ingen fejl");
    expect(await fejlkode(`update public.boost_koeb set point = 1000`)).not.toBe("ingen fejl");
  });
});

describe("point ved salg", () => {
  it("10 point pr. gennemført salg - én gang, kun private, ikke før starten", async () => {
    await nulstil(PRIVAT);
    const b1 = await frigivetSalg(PRIVAT);
    await frigivetSalg(PRIVAT, { foer: true });
    await frigivetSalg(FIRMA);
    await frigivetSalg(SYSTEM);
    // Betalt, men ikke frigivet: ingen point.
    const t = await en<{ id: string }>(`insert into public.trades default values returning id`);
    await db.query(`insert into public.betalinger (trade_id, seller_id, status) values ($1, $2, 'betalt')`, [t.id, PRIVAT]);
    // Frigivet, men refunderet: ingen point.
    const r = await frigivetSalg(PRIVAT);
    await db.query(`update public.betalinger set status = 'refunderet', refunderet_kl = now() where id = $1`, [r]);
    // Frigivet med en åben indsigelse: ingen point (endnu).
    const ind = await frigivetSalg(PRIVAT);
    await db.query(`update public.betalinger set indsigelse_kl = now(), indsigelse_status = 'needs_response' where id = $1`, [ind]);

    const s1 = await j(`select public.boost_point_synk() as v`);
    expect(s1.optjent).toBe(1);
    expect(await saldo(PRIVAT)).toBe(10);
    expect(await saldo(FIRMA)).toBe(0);
    expect(await saldo(SYSTEM)).toBe(0);
    const s2 = await j(`select public.boost_point_synk() as v`);
    expect(s2).toEqual({ optjent: 0, tilbagefoert: 0 });
    expect(await saldo(PRIVAT)).toBe(10);
    const o = await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where betaling_id = $1`, [b1]);
    expect(o.n).toBe(1);
    // Indsigelsen vindes: nu tæller salget.
    await db.query(`update public.betalinger set indsigelse_status = 'won' where id = $1`, [ind]);
    expect((await j(`select public.boost_point_synk() as v`)).optjent).toBe(1);
    expect(await saldo(PRIVAT)).toBe(20);
  });

  it("et salg under 50 kr. giver 0 point; 50 kr. præcis giver point", async () => {
    await nulstil(PRIVAT);
    const under = await frigivetSalg(PRIVAT, { budOere: 4_999 });
    const praecis = await frigivetSalg(PRIVAT, { budOere: 5_000 });
    await j(`select public.boost_point_synk() as v`);
    const n = async (b: string) =>
      (await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where betaling_id = $1`, [b])).n;
    expect(await n(under)).toBe(0);
    expect(await n(praecis)).toBe(1);
    expect(await saldo(PRIVAT)).toBe(10);
    expect((await en<{ v: number }>(`select public.gennemfoerte_salg_min_bud_oere()::int as v`)).v).toBe(5000);
  });

  it("højst 10 point pr. køber pr. sælger pr. måned: to salg til samme køber giver 10 point", async () => {
    await nulstil(PRIVAT);
    const koeber = ADMIN;
    const b1 = await frigivetSalg(PRIVAT, { koeber });
    const b2 = await frigivetSalg(PRIVAT, { koeber });
    const andenKoeber = await frigivetSalg(PRIVAT);
    await j(`select public.boost_point_synk() as v`);
    expect(await saldo(PRIVAT)).toBe(20); // 10 fra køberen + 10 fra en anden køber
    const point = await db.query<{ betaling_id: string }>(
      `select betaling_id from public.boost_posteringer where betaling_id = any($1) and type = 'optjening'`,
      [[b1, b2, andenKoeber]],
    );
    expect(point.rows.length).toBe(2);
    const afvist = await db.query<{ betaling_id: string; grund: string }>(
      `select betaling_id, grund from public.boost_optjening_afvist where betaling_id = any($1)`, [[b1, b2]]);
    expect(afvist.rows).toHaveLength(1);
    expect(afvist.rows[0].grund).toBe("maks_pr_koeber");
    // Ny kørsel: intet nyt, og det afviste salg giver heller ikke point senere.
    expect(await j(`select public.boost_point_synk() as v`)).toEqual({ optjent: 0, tilbagefoert: 0 });
    expect(await saldo(PRIVAT)).toBe(20);
    expect(await fejlkode(`delete from public.boost_optjening_afvist`)).toBe("BHB02");
  });

  it("refunderes salget senere, trækkes pointene tilbage - én gang og aldrig under 0", async () => {
    await nulstil(PRIVAT2);
    const b1 = await frigivetSalg(PRIVAT2);
    const b2 = await frigivetSalg(PRIVAT2);
    await j(`select public.boost_point_synk() as v`);
    expect(await saldo(PRIVAT2)).toBe(20);
    await db.query(`update public.betalinger set status = 'refunderet', refunderet_kl = now() where id = $1`, [b1]);
    expect((await j(`select public.boost_point_synk() as v`)).tilbagefoert).toBe(1);
    expect(await saldo(PRIVAT2)).toBe(10);
    expect((await j(`select public.boost_point_synk() as v`)).tilbagefoert).toBe(0);
    expect(await saldo(PRIVAT2)).toBe(10);
    // Brugeren har brugt en del af pointene: kun resten trækkes.
    await j(`select public.boost_staff_justering($1, $2, -7, 'brugt', $3) as v`, [CHEF, PRIVAT2, randomUUID()]);
    expect(await saldo(PRIVAT2)).toBe(3);
    await db.query(`update public.betalinger set bidhamr_daekker_kl = now() where id = $1`, [b2]);
    await j(`select public.boost_point_synk() as v`);
    expect(await saldo(PRIVAT2)).toBe(0);
    const t = await en(`select point, oensket_point, saldo_efter from public.boost_posteringer
                         where betaling_id = $1 and type = 'tilbagefoersel'`, [b2]);
    expect(t).toEqual({ point: -3, oensket_point: 10, saldo_efter: 0 });
  });
});

describe("staff (chef)", () => {
  it("justering med begrundelse og log; kun chef; ikke egen konto; idempotent", async () => {
    await nulstil(PRIVAT);
    const n = randomUUID();
    expect(await j(`select public.boost_staff_justering($1, $2, 25, 'Kompensation', $3) as v`, [ADMIN, PRIVAT, n])).toEqual({ kode: "ingen_adgang" });
    expect((await j(`select public.boost_staff_justering($1, $2, 25, '  ', $3) as v`, [CHEF, PRIVAT, n])).kode).toBe("begrundelse_mangler");
    expect((await j(`select public.boost_staff_justering($1, $2, 25, 'x', $3) as v`, [CHEF, CHEF, n])).kode).toBe("inhabil");
    expect(await j(`select public.boost_staff_justering($1, $2, 25, 'Kompensation', $3) as v`, [CHEF, PRIVAT, n])).toEqual({ kode: "ok", saldo: 25 });
    expect((await j(`select public.boost_staff_justering($1, $2, 25, 'Kompensation', $3) as v`, [CHEF, PRIVAT, n])).kode).toBe("allerede");
    expect(await saldo(PRIVAT)).toBe(25);
    expect(await j(`select public.boost_staff_justering($1, $2, -26, 'For meget', $3) as v`, [CHEF, PRIVAT, randomUUID()]))
      .toEqual({ kode: "for_lav_saldo", saldo: 25 });
    const log = await en<{ n: number }>(
      `select count(*)::int as n from public.moderation_log where handling = 'boost_justering' and bruger_id = $1`, [PRIVAT]);
    expect(log.n).toBeGreaterThanOrEqual(1);
    const vis = await j(`select public.boost_admin_bruger($1, $2) as v`, [CHEF, PRIVAT]);
    expect(vis.saldo).toBe(25);
    expect((await en<{ v: unknown }>(`select public.boost_admin_bruger($1, $2) as v`, [ADMIN, PRIVAT])).v).toBeNull();
  });

  it("refusion af et køb: pointene trækkes tilbage (så langt saldoen rækker) og logges", async () => {
    await nulstil(PRIVAT);
    const k = await koebtPoint(PRIVAT); // 100
    expect(await saldo(PRIVAT)).toBe(100);
    await brug(PRIVAT, await auktion(PRIVAT)); // 50 tilbage
    expect((await j(`select public.boost_staff_refusion($1, $2, 'Fejlkøb') as v`, [ADMIN, k.id])).kode).toBe("ingen_adgang");
    const r = await j(`select public.boost_staff_refusion($1, $2, 'Fejlkøb') as v`, [CHEF, k.id]);
    expect(r).toEqual({ kode: "ok", trukket: 50, oensket: 100 });
    expect(await saldo(PRIVAT)).toBe(0);
    expect((await j(`select public.boost_staff_refusion($1, $2, 'Igen') as v`, [CHEF, k.id])).kode).toBe("forkert_status");
    expect((await en<{ v: string }>(`select public.boost_koeb_refusion_resultat($1, true, 're_x', null) as v`, [k.id])).v).toBe("refunderet");
    // charge.refunded bagefter: allerede - intet trækkes igen.
    expect((await en<{ v: string }>(`select public.boost_koeb_registrer_charge_refusion((select stripe_charge_id from public.boost_koeb where id = $1), 're_x', true) as v`, [k.id])).v).toBe("allerede");
    const n = await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where boost_koeb_id = $1 and type = 'tilbagefoersel'`, [k.id]);
    expect(n.n).toBe(1);
    const log = await en<{ n: number }>(`select count(*)::int as n from public.moderation_log where handling = 'boost_refunderet'`);
    expect(log.n).toBe(1);
  });

  it("refunderet i Stripe uden om BidHamr: købet markeres, og pointene trækkes tilbage", async () => {
    await nulstil(PRIVAT2);
    const k = await koebtPoint(PRIVAT2);
    const ch = (await en<{ c: string }>(`select stripe_charge_id as c from public.boost_koeb where id = $1`, [k.id])).c;
    expect((await en<{ v: string }>(`select public.boost_koeb_registrer_charge_refusion($1, 're_d', false) as v`, [ch])).v).toBe("markeret");
    expect(await saldo(PRIVAT2)).toBe(100);
    expect((await en<{ v: string }>(`select public.boost_koeb_registrer_charge_refusion($1, 're_d', true) as v`, [ch])).v).toBe("refunderet");
    expect(await saldo(PRIVAT2)).toBe(0);
    const s = await en(`select status, refusion_aarsag, kraever_opmaerksomhed from public.boost_koeb where id = $1`, [k.id]);
    expect(s).toEqual({ status: "refunderet", refusion_aarsag: "ekstern", kraever_opmaerksomhed: true });
  });
});

describe("visning", () => {
  it("boost_top: højst 4, roteret, filtreret på kategori og søgning; skjulte og slut-auktioner ikke med", async () => {
    // Ryd: eksisterende boosts kan ikke slettes - brug en kategori kun til her.
    const ejer = PRIVAT;
    const ider: string[] = [];
    for (let i = 0; i < 6; i++) {
      await j(`select public.boost_staff_justering($1, $2, 50, 'test', $3) as v`, [CHEF, ejer, randomUUID()]);
      const a = await auktion(ejer, { kategori: "Rotation", titel: `Lampe ${i}` });
      expect((await brug(ejer, a)).kode).toBe("ok");
      ider.push(a);
    }
    const top = await db.query<{ auktion_id: string }>(`select auktion_id from public.boost_top('Rotation', null)`);
    expect(top.rows.length).toBe(4);
    for (const r of top.rows) expect(ider).toContain(r.auktion_id);
    // Alle 6 vises i løbet af tre rotationsvinduer (forskydning 4 pr. vindue).
    await db.exec(`update public.boost_indstillinger set rotation_minutter = 1`);
    const set = new Set<string>();
    for (let slot = 0; slot < 3; slot++) {
      const r = await db.query<{ nr: number }>(
        `select ((n - (( $1::bigint * 4) % 6) + 6) % 6) as nr from generate_series(0, 5) n`, [slot]);
      r.rows.forEach((x, i) => { if (x.nr < 4) set.add(ider[i]); });
    }
    expect(set.size).toBe(6);
    await db.exec(`update public.boost_indstillinger set rotation_minutter = 10`);
    // Søgning (uden forskel på store og små bogstaver) og kategori.
    const soeg = await db.query(`select auktion_id from public.boost_top('Rotation', 'LAMPE 3')`);
    expect(soeg.rows).toEqual([{ auktion_id: ider[3] }]);
    expect((await db.query(`select * from public.boost_top('Findes ikke', null)`)).rows).toEqual([]);
    // En skjult auktion med boost kommer ikke med.
    await db.query(`update public.auctions set skjult = true where id = $1`, [ider[0]]);
    const efter = await db.query<{ auktion_id: string }>(`select auktion_id from public.boost_top('Rotation', null)`);
    expect(efter.rows.map((r) => r.auktion_id)).not.toContain(ider[0]);
    // aktive_boosts: mærket "Boostet".
    const ak = await db.query<{ auktion_id: string }>(`select auktion_id from public.aktive_boosts($1)`, [[ider[1], randomUUID()]]);
    expect(ak.rows.map((r) => r.auktion_id)).toEqual([ider[1]]);
  });

  it("RLS: brugeren ser kun sin egen ledger; mine_point og min_auktion_boost bruger auth.uid()", async () => {
    const fremmedAuktion = (await en<{ id: string }>(`select id from public.auctions where bruger_id = $1 limit 1`, [PRIVAT])).id;
    const egenAuktion = await auktion(PRIVAT2);
    let synlige = 0;
    let mine: { saldo: number; historik: unknown[]; pakke: { point: number; pris_oere: number } };
    let minA: unknown;
    let minEgen: { boostet: boolean; kan_booste: boolean; grund: string | null; pris: number };
    let koebSynlige = 0;
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${PRIVAT2}', false);`);
    try {
      synlige = (await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer`)).n;
      koebSynlige = (await en<{ n: number }>(`select count(*)::int as n from public.boost_koeb`)).n;
      mine = (await en<{ v: typeof mine }>(`select public.mine_point() as v`)).v;
      minA = (await en<{ v: unknown }>(`select public.min_auktion_boost($1) as v`, [fremmedAuktion])).v;
      minEgen = (await en<{ v: typeof minEgen }>(`select public.min_auktion_boost($1) as v`, [egenAuktion])).v;
    } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    }
    const egne = await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer where bruger_id = $1`, [PRIVAT2]);
    const egneKoeb = await en<{ n: number }>(`select count(*)::int as n from public.boost_koeb where bruger_id = $1`, [PRIVAT2]);
    const alle = await en<{ n: number }>(`select count(*)::int as n from public.boost_posteringer`);
    expect(alle.n).toBeGreaterThan(egne.n);
    expect(synlige).toBe(egne.n);
    expect(koebSynlige).toBe(egneKoeb.n);
    expect(mine.saldo).toBe(await saldo(PRIVAT2));
    expect(mine.historik.length).toBe(egne.n);
    expect(mine.pakke).toEqual({ point: 100, pris_oere: 3900 });
    expect(minA).toBeNull();
    expect(minEgen).toMatchObject({ boostet: false, kan_booste: false, grund: "for_faa_point", pris: 50 });
  });
});

describe("kunst-kontrol (auctions.kunst_kontrol, 20261023010000)", () => {
  it("virker uden kolonnen; med 'afventer' kan auktionen ikke boostes og vises ikke i toppen eller som 'Boostet'", async () => {
    // Uden kolonnen: intet afventer.
    const foer = await auktion(PRIVAT, { kategori: "Kunsttest", titel: "Vase" });
    expect((await en<{ v: boolean }>(`select public.boost_kunst_afventer($1) as v`, [foer])).v).toBe(false);
    await j(`select public.boost_staff_justering($1, $2, 100, 'test', $3) as v`, [CHEF, PRIVAT, randomUUID()]);
    expect((await brug(PRIVAT, foer)).kode).toBe("ok");

    await db.exec(`alter table public.auctions add column if not exists kunst_kontrol text`);
    const afventer = await auktion(PRIVAT, { kategori: "Kunsttest", titel: "Maleri" });
    await db.query(`update public.auctions set kunst_kontrol = 'afventer' where id = $1`, [afventer]);
    expect((await brug(PRIVAT, afventer)).kode).toBe("ikke_aktiv");
    // Et boostet opslag, der bagefter sættes til kontrol, forsvinder fra toppen og mærket.
    await db.query(`update public.auctions set kunst_kontrol = 'afventer' where id = $1`, [foer]);
    expect((await db.query(`select * from public.boost_top('Kunsttest', null)`)).rows).toEqual([]);
    expect((await db.query(`select * from public.aktive_boosts($1)`, [[foer]])).rows).toEqual([]);
    await db.query(`update public.auctions set kunst_kontrol = 'godkendt' where id = $1`, [foer]);
    expect((await db.query<{ auktion_id: string }>(`select auktion_id from public.boost_top('Kunsttest', null)`)).rows.map((r) => r.auktion_id)).toEqual([foer]);
    await nulstil(PRIVAT);
  });
});

describe("fakturaer", () => {
  it("faktura ved betaling, kreditnota ved refusion - én gang; forkert beløb kræver handling", async () => {
    const r1 = await j(`select public.faktura_planlaeg_boost() as v`);
    expect(Number(r1.fakturaer)).toBeGreaterThanOrEqual(1);
    const r2 = await j(`select public.faktura_planlaeg_boost() as v`);
    expect(r2).toEqual({ fakturaer: 0, kreditnotaer: 0 });
    const f = await en<{ linjer: { kode: string; tekst: string; beloeb_oere: number }[]; beloeb_oere: number; moms_oere: number; part: string; slags: string }>(
      `select linjer, beloeb_oere::int, moms_oere::int, part, slags from public.fakturaer
        where slags = 'boost' and dokument = 'faktura' and status = 'venter' limit 1`);
    expect(f.linjer).toEqual([{ kode: "boost", tekst: "Boost-point (100 point)", beloeb_oere: 3900 }]);
    expect(f).toMatchObject({ beloeb_oere: 3900, moms_oere: 780, part: "koeber", slags: "boost" });
    const kredit = await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where slags = 'boost' and dokument = 'kreditnota'`);
    const refunderede = await en<{ n: number }>(`select count(*)::int as n from public.boost_koeb where status = 'refunderet' and betalt_kl is not null`);
    expect(kredit.n).toBe(refunderede.n);
    const manuel = await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where slags = 'boost' and dokument = 'faktura' and status = 'kraever_handling'`);
    expect(manuel.n).toBeGreaterThanOrEqual(1); // købet med forkert beløb
    // Fakturaen hænger på købet - ikke på en handel.
    expect(await fejlkode(`insert into public.fakturaer (dokument, part, bruger_id, linjer, beloeb_oere, moms_oere, betalt_dato, slags)
                          values ('faktura', 'koeber', '${PRIVAT}', '[]', 1, 0, current_date, 'boost')`)).toBe("23514");
  });
});

describe("afstemningens boost-regler", () => {
  it("forventet refunderet, BidHamrs egen refusion og status", () => {
    expect(forventetBoostRefunderet({ status: "betalt", beloeb_oere: 3900, modtaget_oere: 3900 })).toBe(0);
    expect(forventetBoostRefunderet({ status: "refunderes", beloeb_oere: 3900, modtaget_oere: 3900 })).toBeNull();
    expect(forventetBoostRefunderet({ status: "refunderet", beloeb_oere: 3900, modtaget_oere: 100 })).toBe(100);
    expect(erBoostRefusion({ id: "re_1", metadata: { type: "boost", boost_koeb_id: "k1" } }, { id: "k1", stripe_refund_id: null })).toBe(true);
    expect(erBoostRefusion({ id: "re_2", metadata: {} }, { id: "k1", stripe_refund_id: "re_2" })).toBe(true);
    expect(erBoostRefusion({ id: "re_3", metadata: {} }, { id: "k1", stripe_refund_id: null })).toBe(false);
    expect(boostStatusAfviger("succeeded", "betalt")).toBe(false);
    expect(boostStatusAfviger("succeeded", "afventer")).toBe(true);
    expect(boostStatusAfviger("canceled", "betalt")).toBe(true);
  });
});
