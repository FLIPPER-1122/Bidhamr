// Migrationen 20261029020000_ekstra_fragt.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). Stubs af de tabeller, migrationen bygger
// på; derefter køres migrationen TO gange, og reglerne testes: staff opretter
// (rolle, inhabilitet, dokumentation), én åben regning pr. forsendelse,
// spærringen (BHX01) på nye auktioner og "tilbud til næste byder" - også at
// den IKKE gælder under indsigelse og ophæves straks ved betaling/frafald -,
// indsigelse én gang, fasthold/frafald, spejling fra Stripe (idempotent,
// kasseret PaymentIntent adopteres eller refunderes), fakturaer og rettigheder.
// Også de rene regler (kroner/kg, afstemning, beskeder).
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ekstraFragtStatusAfviger,
  erKasseretEkstraFragtRefusion,
  forventetEkstraFragtRefunderet,
} from "@/lib/betaling/afstemning";
import { erEkstraFragtFejl, kgTilGram, kronerTilOere } from "@/lib/ekstraFragt/tekster";
import { ekstraFragtBeskeder, type EkstraFragtBeskedRaekke } from "@/lib/ekstraFragt/notifikationer";
import { erOprydningsdag } from "@/lib/ekstraFragt/oprydning";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261029020000_ekstra_fragt.sql"),
  "utf8",
);

const KOEBER = "00000000-0000-4000-8000-0000000000a1";
const SAELGER = "00000000-0000-4000-8000-0000000000b1";
const SAELGER2 = "00000000-0000-4000-8000-0000000000b2";
const FREMMED = "00000000-0000-4000-8000-0000000000c1";
const STAFF = "00000000-0000-4000-8000-0000000000d1";
const SYSTEM = "00000000-0000-4000-8000-000000000000";

const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text,
  metadata jsonb, created_at timestamptz not null default now());
create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger');
insert into public.users values ('${KOEBER}', 'Køber', 'bruger'), ('${SAELGER}', 'Sælger', 'bruger'),
  ('${SAELGER2}', 'Sælger 2', 'bruger'), ('${FREMMED}', 'Fremmed', 'bruger'), ('${STAFF}', 'Medarbejder', 'medarbejder'),
  ('${SYSTEM}', 'BidHamr', 'bruger');
create function public.bidhamr_system_id() returns uuid language sql immutable as $$ select '${SYSTEM}'::uuid $$;
-- Stub: staff = rolle (aal2 antages).
create function public.er_staff() returns boolean language sql stable as
  $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.rolle in ('medarbejder','admin','chef')) $$;
-- Stub: inhabil = part i handlen.
create function public.penge_inhabil(p_m uuid, p_k uuid, p_s uuid) returns boolean language sql as
  $$ select p_m = p_k or p_m = p_s $$;
create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  constraint moderation_log_handling_check check (handling = any (array['advarsel','returfragt_refunderet'])),
  constraint moderation_log_maal_type_check check (maal_type = any (array['bruger','handel'])));
create table public.auctions (id uuid primary key default gen_random_uuid(), bruger_id uuid, titel text);
create table public.trades (id uuid primary key default gen_random_uuid(), auction_id uuid references public.auctions(id),
  buyer_id uuid, seller_id uuid, afhentning boolean default false);
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid, betalt_kl timestamptz);
create table public.forsendelser (id uuid primary key default gen_random_uuid(), trade_id uuid, type text,
  fragtfirma text default 'shipmondo', transportoer text default 'dao', status text default 'leveret',
  pakkestoerrelse text default 'lille', sporingsnummer text default 'DAO123');
create table public.andenchance_tilbud (id uuid primary key default gen_random_uuid(), seller_id uuid, auction_id uuid);
create table public.fakturaer (
  id uuid primary key default gen_random_uuid(), dokument text not null, part text not null, bruger_id uuid not null,
  betaling_id uuid, trade_id uuid, firma_regning_id uuid, krediterer_id uuid references public.fakturaer(id),
  linjer jsonb not null, beloeb_oere bigint not null, moms_oere bigint not null, betalt_dato date not null,
  stripe_reference text, status text not null default 'venter', manuel boolean not null default false, sidste_fejl text,
  slags text not null default 'salg', returfragt_id uuid, boost_koeb_id uuid, oprettet_kl timestamptz default now());
-- Som efter 20261023030000_boost.sql (migrationen drift-tjekker den).
alter table public.fakturaer add constraint fakturaer_slags_check
  check (slags in ('salg', 'returfragt', 'sag_returfragt', 'boost')
         and (slags = 'salg'
              or (slags = 'returfragt' and dokument = 'faktura' and part = 'koeber')
              or (slags = 'sag_returfragt' and dokument in ('faktura', 'kreditnota') and part = 'koeber')
              or (slags = 'boost' and dokument in ('faktura', 'kreditnota') and part = 'koeber')));
create unique index fakturaer_handel_part_slags_v2 on public.fakturaer (betaling_id, part, dokument, slags)
  where betaling_id is not null and slags <> 'sag_returfragt';
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
  return (await en<{ v: Record<string, unknown> }>(sql, p)).v;
}
async function fejl(sql: string, p: unknown[] = []): Promise<{ code: string; message: string } | null> {
  try {
    await db.query(sql, p);
    return null;
  } catch (err) {
    return { code: String((err as { code?: string }).code ?? ""), message: (err as Error).message };
  }
}
// Kalderen (auth.uid()).
async function som(uid: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ""]);
}

let n = 0;
// En betalt handel med en udgående pakke. Svar: ids.
async function handel(o: { saelger?: string; afhentning?: boolean; status?: string; type?: string; betalt?: boolean } = {}) {
  const saelger = o.saelger ?? SAELGER;
  const a = await en<{ id: string }>(`insert into public.auctions (bruger_id, titel) values ($1, 'Vare') returning id`, [saelger]);
  const t = await en<{ id: string }>(
    `insert into public.trades (auction_id, buyer_id, seller_id, afhentning) values ($1, $2, $3, $4) returning id`,
    [a.id, KOEBER, saelger, o.afhentning ?? false],
  );
  const b = await en<{ id: string }>(
    `insert into public.betalinger (trade_id, betalt_kl) values ($1, $2) returning id`,
    [t.id, o.betalt === false ? null : new Date(Date.now() - 20 * 86_400_000).toISOString()],
  );
  const f = await en<{ id: string }>(
    `insert into public.forsendelser (trade_id, type, status) values ($1, $2, $3) returning id`,
    [t.id, o.type ?? "udgaaende", o.status ?? "leveret"],
  );
  return { tradeId: t.id, betalingId: b.id, forsendelseId: f.id };
}

// Uploadet dokumentation for handlen.
const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic" };
async function dok(tradeId: string, endelse = "pdf", mimetype = MIME[endelse]) {
  n++;
  const sti = `${tradeId}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}.${endelse}`;
  await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('ekstra-fragt-dokumentation', $1, $2)`, [
    sti,
    JSON.stringify({ mimetype }),
  ]);
  return sti;
}

type Opret = { beloeb?: number; maalt?: string | null; gram?: number | null; nr?: string; sti?: string; type?: string };
async function opret(forsendelseId: string, tradeId: string, o: Opret = {}) {
  const sti = o.sti ?? (await dok(tradeId));
  return j(
    `select public.ekstra_fragt_opret($1, $2, $3, $4, '60x40x30 cm', $5, 'DAO målte 7,2 kg', $6, $7, 'faktura.pdf') as v`,
    [forsendelseId, o.beloeb ?? 3500, o.maalt === undefined ? "mellem" : o.maalt, o.gram === undefined ? 7200 : o.gram,
     o.nr ?? `F-${++n}`, sti, o.type ?? "application/pdf"],
  );
}

async function regning(id: string) {
  return en<Record<string, unknown>>(`select * from public.ekstra_fragt_regninger where id = $1`, [id]);
}

// Ny regning (staff), med fristen flyttet (dage fra nu; negativ = overskredet).
async function nyRegning(o: { saelger?: string; fristDage?: number } = {}) {
  const h = await handel({ saelger: o.saelger });
  await som(STAFF);
  const r = await opret(h.forsendelseId, h.tradeId);
  expect(r.kode).toBe("ok");
  if (o.fristDage !== undefined) {
    await db.query(`update public.ekstra_fragt_regninger set frist = now() + ($2 || ' days')::interval where id = $1`, [r.id, o.fristDage]);
  }
  await som(null);
  return { ...h, id: r.id as string };
}

const nyAuktion = (saelger: string) => fejl(`insert into public.auctions (bruger_id, titel) values ($1, 'Ny')`, [saelger]);
const nytTilbud = (saelger: string) => fejl(`insert into public.andenchance_tilbud (seller_id) values ($1)`, [saelger]);

async function betal(id: string, beloeb = 3500, forsoeg = 0) {
  const pi = `pi_test_${id.replace(/-/g, "").slice(0, 16)}_${forsoeg}`;
  const s = await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [id, SAELGER]);
  expect(s.kode).toBe("ok");
  expect(await en(`select public.ekstra_fragt_gem_pi($1, $2, $3) as v`, [id, pi, forsoeg])).toEqual({ v: true });
  const r = await j(`select public.ekstra_fragt_registrer($1, 'succeeded', $2, $3, null) as v`, [pi, `ch_${pi}`, beloeb]);
  return { pi, r };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  // Kan køres igen.
  await db.exec(MIGRATION);
});

afterAll(async () => {
  await db.close();
});

describe("staff opretter en ekstraregning", () => {
  it("kun staff, ikke inhabil, kun udgående og sendt pakke, betalt handel, gyldige felter", async () => {
    const h = await handel();
    await som(SAELGER);
    expect((await opret(h.forsendelseId, h.tradeId)).kode).toBe("ingen_adgang");
    await som(null);
    expect((await opret(h.forsendelseId, h.tradeId)).kode).toBe("ingen_adgang");
    await som(STAFF);
    expect((await opret(h.forsendelseId, h.tradeId, { beloeb: 299 })).kode).toBe("ugyldigt_beloeb");
    expect((await opret(h.forsendelseId, h.tradeId, { beloeb: 1_000_001 })).kode).toBe("ugyldigt_beloeb");
    expect((await opret(h.forsendelseId, h.tradeId, { maalt: null, gram: null })).kode).toBe("maaling_mangler");
    expect((await opret(h.forsendelseId, h.tradeId, { maalt: "kæmpe" })).kode).toBe("ugyldig_stoerrelse");
    expect((await opret(h.forsendelseId, h.tradeId, { nr: "  " })).kode).toBe("fakturanummer_mangler");
    // Dokumentationen skal ligge under handlens mappe og findes i bucket'en.
    const anden = await handel();
    expect((await opret(h.forsendelseId, h.tradeId, { sti: await dok(anden.tradeId) })).kode).toBe("dokumentation_mangler");
    expect(
      (await opret(h.forsendelseId, h.tradeId, { sti: `${h.tradeId}/00000000-0000-4000-8000-999999999999.pdf` })).kode,
    ).toBe("dokumentation_mangler");
    expect((await opret(h.forsendelseId, h.tradeId, { type: "text/html" })).kode).toBe("dokumentation_mangler");

    const retur = await handel({ type: "retur" });
    expect((await opret(retur.forsendelseId, retur.tradeId)).kode).toBe("ikke_udgaaende");
    const aldrig = await handel({ status: "fejlet" });
    expect((await opret(aldrig.forsendelseId, aldrig.tradeId)).kode).toBe("ikke_sendt");
    const afh = await handel({ afhentning: true });
    expect((await opret(afh.forsendelseId, afh.tradeId)).kode).toBe("afhentning");
    const ubetalt = await handel({ betalt: false });
    expect((await opret(ubetalt.forsendelseId, ubetalt.tradeId)).kode).toBe("ingen_betaling");
    // Inhabil: staff er selv sælger.
    const egen = await handel({ saelger: STAFF });
    expect((await opret(egen.forsendelseId, egen.tradeId)).kode).toBe("inhabil");

    const ok = await opret(h.forsendelseId, h.tradeId);
    expect(ok).toMatchObject({ kode: "ok", trade_id: h.tradeId, saelger_id: SAELGER });
    const r = await regning(ok.id as string);
    expect(r).toMatchObject({
      status: "afventer_betaling",
      beloeb_oere: 3500,
      valgt_stoerrelse: "lille",
      maalt_stoerrelse: "mellem",
      maalt_vaegt_gram: 7200,
      saelger_id: SAELGER,
      betaling_id: h.betalingId,
      transportoer: "dao",
    });
    const fristDage = (new Date(r.frist as string).getTime() - new Date(r.oprettet_kl as string).getTime()) / 86_400_000;
    expect(Math.round(fristDage)).toBe(14);
    const log = await en(`select handling, maal_type, maal_id, bruger_id, medarbejder_id from public.moderation_log order by ctid desc limit 1`);
    expect(log).toEqual({ handling: "ekstra_fragt_oprettet", maal_type: "handel", maal_id: h.tradeId, bruger_id: SAELGER, medarbejder_id: STAFF });

    // Én åben regning pr. forsendelse.
    expect((await opret(h.forsendelseId, h.tradeId)).kode).toBe("findes_allerede");
    await som(null);
  });

  it("beløb, parter og dokumentation er låst; ingen sletning; service role kan ikke skrive direkte", async () => {
    const r = await nyRegning();
    expect((await fejl(`update public.ekstra_fragt_regninger set beloeb_oere = 1 where id = $1`, [r.id]))?.code).toBe("42501");
    expect((await fejl(`update public.ekstra_fragt_regninger set dokumentation_sti = 'x' where id = $1`, [r.id]))?.code).toBe("42501");
    expect((await fejl(`delete from public.ekstra_fragt_regninger where id = $1`, [r.id]))?.code).toBe("42501");
    const p = await en(`
      select has_table_privilege('service_role', 'public.ekstra_fragt_regninger', 'update') as sr_upd,
             has_table_privilege('service_role', 'public.ekstra_fragt_regninger', 'insert') as sr_ins,
             has_table_privilege('authenticated', 'public.ekstra_fragt_regninger', 'insert') as auth_ins,
             has_table_privilege('anon', 'public.ekstra_fragt_regninger', 'select') as anon_sel,
             has_function_privilege('authenticated', 'public.ekstra_fragt_registrer(text,text,text,bigint,text)', 'execute') as auth_reg,
             has_function_privilege('authenticated', 'public.ekstra_fragt_betal_start(uuid,uuid)', 'execute') as auth_start,
             has_function_privilege('anon', 'public.mine_ekstra_fragt_regninger(uuid)', 'execute') as anon_mine,
             has_function_privilege('authenticated', 'public.mine_ekstra_fragt_regninger(uuid)', 'execute') as auth_mine,
             has_function_privilege('authenticated', 'public.ekstra_fragt_opret(uuid,bigint,text,integer,text,text,text,text,text,text)', 'execute') as auth_opret,
             has_function_privilege('service_role', 'public.ekstra_fragt_registrer(text,text,text,bigint,text)', 'execute') as sr_reg,
             has_function_privilege('authenticated', 'public.ekstra_fragt_spaerret(uuid)', 'execute') as auth_spaerret`);
    expect(p).toEqual({
      sr_upd: false, sr_ins: false, auth_ins: false, anon_sel: false, auth_reg: false, auth_start: false,
      anon_mine: false, auth_mine: true, auth_opret: true, sr_reg: true, auth_spaerret: false,
    });
  });

  it("RLS: kun staff læser tabellen direkte", async () => {
    const r = await nyRegning();
    await som(SAELGER);
    await db.exec(`set role authenticated`);
    const egen = await db.query(`select id from public.ekstra_fragt_regninger where id = $1`, [r.id]);
    expect(egen.rows).toHaveLength(0);
    await db.exec(`reset role`);
    await som(STAFF);
    await db.exec(`set role authenticated`);
    const staff = await db.query(`select id from public.ekstra_fragt_regninger where id = $1`, [r.id]);
    expect(staff.rows).toHaveLength(1);
    await db.exec(`reset role`);
    await som(null);
  });
});

describe("spærringen (BHX01)", () => {
  it("ingen spærring før fristen; spærret efter fristen; ophæves straks ved betaling", async () => {
    const r = await nyRegning({ saelger: SAELGER, fristDage: 3 });
    expect(await nyAuktion(SAELGER)).toBeNull();
    await db.query(`update public.ekstra_fragt_regninger set frist = now() - interval '1 minute' where id = $1`, [r.id]);
    const f = await nyAuktion(SAELGER);
    expect(f?.code).toBe("BHX01");
    expect(erEkstraFragtFejl(f?.code, f?.message)).toBe(true);
    expect((await nytTilbud(SAELGER))?.code).toBe("BHX01");
    // Andre sælgere og systemet rammes ikke.
    expect(await nyAuktion(SAELGER2)).toBeNull();
    expect(await nyAuktion(SYSTEM)).toBeNull();
    // Status til sælgeren.
    await som(SAELGER);
    expect((await j(`select public.min_ekstra_fragt_status() as v`)).spaerret).toBe(true);
    await som(null);
    // Betalt: ophævet med det samme.
    const { r: reg } = await betal(r.id);
    expect(reg.kode).toBe("betalt");
    expect(await nyAuktion(SAELGER)).toBeNull();
    expect(await nytTilbud(SAELGER)).toBeNull();
  });

  it("ingen spærring under indsigelse gjort før fristen; fastholdt: ny frist mindst 7 dage; frafald ophæver", async () => {
    const r = await nyRegning({ saelger: SAELGER2, fristDage: 2 });
    expect(await nyAuktion(SAELGER2)).toBeNull();
    await som(SAELGER2);
    expect((await j(`select public.mit_ekstra_fragt_indsigelse($1, 'kort') as v`, [r.id])).kode).toBe("for_kort");
    expect((await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Pakken vejede kun 900 g, da jeg sendte den.') as v`, [r.id])).kode).toBe("ok");
    // Kun én gang.
    expect((await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Igen igen igen igen.') as v`, [r.id])).kode).toBe("allerede_indsigelse");
    await som(null);
    expect(await nyAuktion(SAELGER2)).toBeNull();
    // Betaling er ikke mulig under indsigelse.
    expect((await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, SAELGER2])).kode).toBe("indsigelse");

    // Staff fastholder: tilbage til afventer_betaling, frist mindst 7 dage.
    await som(STAFF);
    expect((await j(`select public.ekstra_fragt_afgoer_indsigelse($1, 'fasthold', '') as v`, [r.id])).kode).toBe("begrundelse_mangler");
    expect(
      (await j(`select public.ekstra_fragt_afgoer_indsigelse($1, 'fasthold', 'Fragtfirmaets vejning viser 7,2 kg.') as v`, [r.id])).kode,
    ).toBe("ok");
    await som(null);
    const efter = await regning(r.id);
    expect(efter).toMatchObject({ status: "afventer_betaling", afgoerelse: "fastholdt" });
    expect(new Date(efter.frist as string).getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    expect(await nyAuktion(SAELGER2)).toBeNull();
    // Indsigelsen kan ikke ændres.
    expect((await fejl(`update public.ekstra_fragt_regninger set indsigelse_tekst = 'ny' where id = $1`, [r.id]))?.code).toBe("42501");

    // Efter fristen igen -> spærret; staff frafalder -> ophævet.
    await db.query(`update public.ekstra_fragt_regninger set frist = now() - interval '1 minute' where id = $1`, [r.id]);
    expect((await nyAuktion(SAELGER2))?.code).toBe("BHX01");
    await som(STAFF);
    expect((await j(`select public.ekstra_fragt_frafald($1, '') as v`, [r.id])).kode).toBe("grund_mangler");
    expect((await j(`select public.ekstra_fragt_frafald($1, 'Vi kan ikke dokumentere målingen.') as v`, [r.id])).kode).toBe("ok");
    expect((await j(`select public.ekstra_fragt_frafald($1, 'igen') as v`, [r.id])).kode).toBe("forkert_status");
    await som(null);
    expect(await nyAuktion(SAELGER2)).toBeNull();
    expect((await regning(r.id)).status).toBe("frafaldet");
  });
});

describe("betalingen (spejl fra Stripe)", () => {
  it("idempotent: samme succeeded to gange giver 'allerede'; andre statusser", async () => {
    const r = await nyRegning();
    const s = await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, SAELGER]);
    expect(s).toMatchObject({ kode: "ok", beloeb_oere: 3500, pi: null, pi_forsoeg: 0 });
    // En fremmed kan ikke starte betalingen.
    expect((await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, FREMMED])).kode).toBe("ikke_fundet");
    const pi = "pi_test_idem_1";
    expect(await en(`select public.ekstra_fragt_gem_pi($1, $2, 0) as v`, [r.id, pi])).toEqual({ v: true });
    // En anden PaymentIntent kan ikke gemmes oven på.
    expect(await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_anden', 0) as v`, [r.id])).toEqual({ v: false });
    expect((await j(`select public.ekstra_fragt_registrer($1, 'processing', null, null, null) as v`, [pi])).kode).toBe("behandles");
    expect((await regning(r.id)).status).toBe("behandles");
    expect((await j(`select public.ekstra_fragt_registrer($1, 'requires_payment_method', null, null, 'card_declined') as v`, [pi])).kode).toBe("afventer");
    expect((await j(`select public.ekstra_fragt_registrer($1, 'succeeded', 'ch_idem', 3500, null) as v`, [pi])).kode).toBe("betalt");
    expect((await j(`select public.ekstra_fragt_registrer($1, 'succeeded', 'ch_idem', 3500, null) as v`, [pi])).kode).toBe("allerede");
    const b = await regning(r.id);
    expect(b).toMatchObject({ status: "betalt", modtaget_oere: 3500, stripe_charge_id: "ch_idem" });
    expect(b.betalt_kl).not.toBeNull();
    expect((await j(`select public.ekstra_fragt_registrer('pi_ukendt', 'succeeded', null, 100, null) as v`)).kode).toBe("ukendt");
    // Betalt: kan ikke frafaldes eller indsiges.
    await som(STAFF);
    expect((await j(`select public.ekstra_fragt_frafald($1, 'grund') as v`, [r.id])).kode).toBe("forkert_status");
    await som(SAELGER);
    expect((await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Det er forkert målt.') as v`, [r.id])).kode).toBe("forkert_status");
    await som(null);
  });

  it("andet beløb: betalt, men markeret til staff (fakturaen kræver handling)", async () => {
    const r = await nyRegning();
    const { r: reg } = await betal(r.id, 3499);
    expect(reg.kode).toBe("beloeb_afviger");
    expect(await regning(r.id)).toMatchObject({ status: "betalt", kraever_opmaerksomhed: true, modtaget_oere: 3499 });
  });

  it("annulleret PaymentIntent nulstilles (ny idempotency key)", async () => {
    const r = await nyRegning();
    await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, SAELGER]);
    await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_annul', 0)`, [r.id]);
    expect((await j(`select public.ekstra_fragt_registrer('pi_test_annul', 'canceled', null, null, null) as v`)).kode).toBe("nulstillet");
    expect(await regning(r.id)).toMatchObject({ stripe_payment_intent_id: null, pi_forsoeg: 1, tidligere_payment_intents: ["pi_test_annul"] });
  });

  it("indsigelse kasserer PaymentIntenten; betales den alligevel, adopteres den (sælgeren skylder stadig)", async () => {
    const r = await nyRegning();
    await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, SAELGER]);
    await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_adopt', 0)`, [r.id]);
    await som(SAELGER);
    expect(await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Pakken var lille, se mine billeder.') as v`, [r.id])).toEqual({
      kode: "ok",
      annuller_pi: "pi_test_adopt",
      spaerret_til_afgoerelse: false,
    });
    await som(null);
    expect(await regning(r.id)).toMatchObject({ status: "indsigelse", stripe_payment_intent_id: null, annuller_pi: "pi_test_adopt" });
    // Cron'en ser den kasserede PaymentIntent (skal annulleres hos Stripe).
    const cron = await db.query<{ id: string; handling: string; pi: string }>(`select * from public.ekstra_fragt_cron(100)`);
    expect(cron.rows).toContainEqual({ id: r.id, handling: "annuller", pi: "pi_test_adopt" });
    // Betalt alligevel (i samme øjeblik): adopteres.
    const reg = await j(`select public.ekstra_fragt_registrer('pi_test_adopt', 'succeeded', 'ch_adopt', 3500, null) as v`);
    expect(reg).toMatchObject({ kode: "betalt", id: r.id });
    expect(await regning(r.id)).toMatchObject({
      status: "betalt",
      stripe_payment_intent_id: "pi_test_adopt",
      annuller_pi: null,
      kraever_opmaerksomhed: true,
    });
  });

  it("frafaldet: en kasseret PaymentIntent, der betales, refunderes (kode 'kasseret')", async () => {
    const r = await nyRegning();
    await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, SAELGER]);
    await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_frafald', 0)`, [r.id]);
    await som(STAFF);
    expect(await j(`select public.ekstra_fragt_frafald($1, 'Fejl i fragtfirmaets faktura.') as v`, [r.id])).toMatchObject({
      kode: "ok",
      annuller_pi: "pi_test_frafald",
    });
    await som(null);
    const reg = await j(`select public.ekstra_fragt_registrer('pi_test_frafald', 'succeeded', 'ch_frafald', 3500, null) as v`);
    expect(reg).toMatchObject({ kode: "kasseret", id: r.id });
    expect((await regning(r.id)).status).toBe("frafaldet");
    // Rydning efter annullering hos Stripe.
    expect(await en(`select public.ekstra_fragt_pi_annulleret($1, 'pi_test_frafald') as v`, [r.id])).toEqual({ v: true });
  });

  it("refusion i Stripe-dashboardet spejles: fuld -> refunderet; delvis -> markeret", async () => {
    const r = await nyRegning();
    const { pi } = await betal(r.id);
    expect(await en(`select public.ekstra_fragt_registrer_charge_refusion($1, 're_1', false) as v`, [`ch_${pi}`])).toEqual({ v: "markeret" });
    expect(await en(`select public.ekstra_fragt_registrer_charge_refusion($1, 're_2', true) as v`, [`ch_${pi}`])).toEqual({ v: "refunderet" });
    expect(await en(`select public.ekstra_fragt_registrer_charge_refusion($1, 're_2', true) as v`, [`ch_${pi}`])).toEqual({ v: "allerede" });
    expect(await regning(r.id)).toMatchObject({ status: "refunderet", stripe_refund_id: "re_2" });
  });
});

describe("sælgerens visning og dokumentation", () => {
  it("kun egne regninger og kun offentlige felter", async () => {
    const r = await nyRegning();
    await db.query(`update public.ekstra_fragt_regninger set intern_note = 'hemmelig' where id = $1`, [r.id]);
    await som(SAELGER);
    const mine = await db.query<Record<string, unknown>>(`select * from public.mine_ekstra_fragt_regninger($1)`, [r.tradeId]);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ id: r.id, kan_betale: true, kan_goere_indsigelse: true, spaerrer: false, titel: "Vare" });
    expect(Object.keys(mine.rows[0])).not.toContain("intern_note");
    expect(Object.keys(mine.rows[0])).not.toContain("stripe_payment_intent_id");
    expect((await j(`select public.min_ekstra_fragt_dokumentation($1) as v`, [r.id])).kode).toBe("ok");
    await som(FREMMED);
    expect((await db.query(`select * from public.mine_ekstra_fragt_regninger($1)`, [r.tradeId])).rows).toHaveLength(0);
    expect((await j(`select public.min_ekstra_fragt_dokumentation($1) as v`, [r.id])).kode).toBe("ikke_fundet");
    expect((await j(`select public.ekstra_fragt_dokumentation_staff($1) as v`, [r.id])).kode).toBe("ingen_adgang");
    await som(STAFF);
    expect((await j(`select public.ekstra_fragt_dokumentation_staff($1) as v`, [r.id])).kode).toBe("ok");
    expect(await j(`select public.ekstra_fragt_antal() as v`)).toMatchObject({ afventer_betaling: expect.any(Number) });
    await som(null);
  });
});

describe("fakturaer", () => {
  it("betalt -> sælgerens faktura (fragtkonto); refunderet -> kreditnota; idempotent", async () => {
    const r = await nyRegning();
    const { pi } = await betal(r.id);
    const p1 = await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);
    expect(Number(p1.fakturaer)).toBeGreaterThanOrEqual(1);
    const f = await en<Record<string, unknown>>(
      `select dokument, part, bruger_id, betaling_id, slags, beloeb_oere, moms_oere, linjer->0->>'kode' as kode, status
         from public.fakturaer where ekstra_fragt_id = $1 and dokument = 'faktura'`,
      [r.id],
    );
    expect(f).toMatchObject({
      dokument: "faktura", part: "saelger", bruger_id: SAELGER, betaling_id: r.betalingId, slags: "ekstra_fragt",
      beloeb_oere: 3500, moms_oere: 700, kode: "fragt", status: "venter",
    });
    // Igen: intet nyt.
    await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where ekstra_fragt_id = $1`, [r.id])).n).toBe(1);
    // En anden regning på samme handel (samme betaling) kan også faktureres.
    await som(STAFF);
    const r2 = await opret(r.forsendelseId, r.tradeId);
    await som(null);
    expect(r2.kode).toBe("ok");
    await betal(r2.id as string);
    await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);
    expect((await en<{ n: number }>(`select count(*)::int as n from public.fakturaer where ekstra_fragt_id = $1`, [r2.id])).n).toBe(1);
    // Refunderet: kreditnota.
    await en(`select public.ekstra_fragt_registrer_charge_refusion($1, 're_k', true)`, [`ch_${pi}`]);
    await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);
    const k = await en<Record<string, unknown>>(
      `select part, slags, beloeb_oere, krediterer_id is not null as har_moder from public.fakturaer where ekstra_fragt_id = $1 and dokument = 'kreditnota'`,
      [r.id],
    );
    expect(k).toEqual({ part: "saelger", slags: "ekstra_fragt", beloeb_oere: 3500, har_moder: true });
    // Faktura med ekstra_fragt kræver ekstra_fragt_id (og omvendt).
    expect(
      (await fejl(
        `insert into public.fakturaer (dokument, part, bruger_id, betaling_id, linjer, beloeb_oere, moms_oere, betalt_dato, slags)
         values ('faktura', 'saelger', $1, $2, '[]', 1, 0, current_date, 'ekstra_fragt')`,
        [SAELGER, r.betalingId],
      ))?.code,
    ).toBe("23514");
  });
});

describe("M1: tabt bankindsigelse og genåbning", () => {
  const tabt = (ch: string, du: string, status = "lost", beloeb = 3500) =>
    j(`select public.ekstra_fragt_registrer_bankindsigelse($1, $2, $3, $4) as v`, [ch, du, status, beloeb]);
  const genaabn = (id: string, beg = "Din bank har tilbageført betalingen.") =>
    j(`select public.ekstra_fragt_genaabn($1, $2) as v`, [id, beg]);
  const fakturaer = (id: string) =>
    db.query<Record<string, unknown>>(
      `select dokument, coalesce(ekstra_fragt_runde, 0) as runde, beloeb_oere, stripe_reference, krediterer_id, id, status
         from public.fakturaer where ekstra_fragt_id = $1 order by oprettet_kl, dokument desc`,
      [id],
    );

  it("markeres (ikke genåbnet automatisk); staff genåbner: kreditnota, ny frist, ny runde, ny PaymentIntent, ny faktura", async () => {
    const r = await nyRegning();
    const { pi } = await betal(r.id);
    const ch = `ch_${pi}`;
    await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);

    // Ingen tabt indsigelse: kan ikke genåbnes.
    await som(STAFF);
    expect((await genaabn(r.id)).kode).toBe("ingen_tabt_bankindsigelse");
    await som(null);
    // Åben indsigelse spejles, men regningen er stadig betalt.
    expect((await tabt(ch, "du_test_m1", "needs_response")).kode).toBe("registreret");
    expect(await regning(r.id)).toMatchObject({ status: "betalt", bankindsigelse_status: "needs_response", bankindsigelse_tabt_kl: null });
    await som(STAFF);
    expect((await genaabn(r.id)).kode).toBe("ingen_tabt_bankindsigelse");
    await som(null);

    // Tabt: markeret, idempotent - og en senere status overskriver den ikke.
    expect(await tabt(ch, "du_test_m1")).toMatchObject({ kode: "tabt", id: r.id, status: "betalt" });
    expect((await tabt(ch, "du_test_m1")).kode).toBe("allerede");
    expect((await tabt(ch, "du_test_m1", "won")).kode).toBe("registreret");
    const markeret = await regning(r.id);
    expect(markeret).toMatchObject({ status: "betalt", bankindsigelse_id: "du_test_m1", bankindsigelse_status: "lost" });
    expect(markeret.bankindsigelse_tabt_kl).not.toBeNull();
    // Ugyldige id'er og ukendte charges.
    expect((await tabt(ch, "x_ugyldig")).kode).toBe("ugyldig");
    expect((await tabt("ch_ukendt", "du_test_x")).kode).toBe("ukendt");
    // Admin-lampen.
    await som(STAFF);
    expect(Number((await j(`select public.ekstra_fragt_antal() as v`)).tabte_bankindsigelser)).toBeGreaterThanOrEqual(1);

    // Kun staff, med begrundelse.
    await som(SAELGER);
    expect((await genaabn(r.id)).kode).toBe("ingen_adgang");
    await som(STAFF);
    expect((await genaabn(r.id, "  ")).kode).toBe("begrundelse_mangler");
    const ok = await genaabn(r.id);
    expect(ok).toMatchObject({ kode: "ok", runde: 1, trade_id: r.tradeId, saelger_id: SAELGER });
    expect((await genaabn(r.id)).kode).toBe("forkert_status");
    await som(null);

    const g = await regning(r.id);
    expect(g).toMatchObject({
      status: "afventer_betaling",
      runde: 1,
      pi_forsoeg: 1,
      stripe_payment_intent_id: null,
      stripe_charge_id: null,
      betalt_kl: null,
      modtaget_oere: null,
      bankindsigelse_tabt_kl: null,
      tilbagefoerte_payment_intents: [pi],
      tilbagefoerte_charges: [ch],
      genaabnet_af: STAFF,
    });
    const fristDage = (new Date(g.frist as string).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(fristDage)).toBe(14);
    const log = await en(`select handling, medarbejder_id from public.moderation_log order by ctid desc limit 1`);
    expect(log).toEqual({ handling: "ekstra_fragt_genaabnet", medarbejder_id: STAFF });

    // Bogføringen: faktura (runde 0) + kreditnota for den (reference = indsigelsen).
    const f1 = (await fakturaer(r.id)).rows;
    expect(f1).toHaveLength(2);
    const faktura0 = f1.find((x) => x.dokument === "faktura")!;
    const kredit0 = f1.find((x) => x.dokument === "kreditnota")!;
    expect(kredit0).toMatchObject({ runde: 0, beloeb_oere: 3500, stripe_reference: "du_test_m1", krediterer_id: faktura0.id, status: "venter" });

    // Den tilbageførte betaling tæller aldrig igen (gentaget webhook/cron).
    expect((await j(`select public.ekstra_fragt_registrer($1, 'succeeded', $2, 3500, null) as v`, [pi, ch])).kode).toBe("tilbagefoert");
    expect((await regning(r.id)).status).toBe("afventer_betaling");
    expect((await tabt(ch, "du_test_m1")).kode).toBe("genaabnet");
    // Spærret efter den nye frist, som enhver ubetalt regning.
    await db.query(`update public.ekstra_fragt_regninger set frist = now() - interval '1 minute' where id = $1`, [r.id]);
    expect((await nyAuktion(SAELGER))?.code).toBe("BHX01");

    // Ny betaling (ny runde, nyt forsøg = ny idempotency key) -> ny faktura.
    const { r: reg2 } = await betal(r.id, 3500, 1);
    expect(reg2.kode).toBe("betalt");
    expect(await nyAuktion(SAELGER)).toBeNull();
    await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);
    const f2 = (await fakturaer(r.id)).rows;
    expect(f2).toHaveLength(3);
    expect(f2.filter((x) => x.dokument === "faktura").map((x) => Number(x.runde)).sort()).toEqual([0, 1]);
    // Igen: intet nyt.
    await j(`select public.faktura_planlaeg_ekstra_fragt(1000) as v`);
    expect((await fakturaer(r.id)).rows).toHaveLength(3);
    // Historikken kan ikke slettes.
    expect(
      (await fejl(`update public.ekstra_fragt_regninger set tilbagefoerte_payment_intents = '{}' where id = $1`, [r.id]))?.code,
    ).toBe("42501");
    expect((await fejl(`update public.ekstra_fragt_regninger set runde = 0 where id = $1`, [r.id]))?.code).toBe("42501");
  });

  it("genåbning før fakturakøen: rundens faktura laves først; delvis tilbageførsel kan ikke genåbnes", async () => {
    const a = await nyRegning();
    const { pi } = await betal(a.id);
    expect((await tabt(`ch_${pi}`, "du_test_m1b")).kode).toBe("tabt");
    await som(STAFF);
    expect((await genaabn(a.id)).kode).toBe("ok");
    await som(null);
    const f = (await fakturaer(a.id)).rows;
    expect(f.map((x) => x.dokument).sort()).toEqual(["faktura", "kreditnota"]);

    const b = await nyRegning();
    const { pi: pib } = await betal(b.id);
    expect((await tabt(`ch_${pib}`, "du_test_m1c", "lost", 1000)).kode).toBe("tabt");
    await som(STAFF);
    expect((await genaabn(b.id)).kode).toBe("delvis_bankindsigelse");
    await som(null);
    expect((await regning(b.id)).status).toBe("betalt");
  });
});

describe("M2: indsigelse efter fristen", () => {
  const SAELGER3 = "00000000-0000-4000-8000-0000000000b3";
  it("tilladt, men spærringen gælder, til indsigelsen er afgjort", async () => {
    await db.query(`insert into public.users (id, navn) values ($1, 'Sælger 3') on conflict do nothing`, [SAELGER3]);
    const r = await nyRegning({ saelger: SAELGER3, fristDage: -1 });
    expect((await nyAuktion(SAELGER3))?.code).toBe("BHX01");
    await som(SAELGER3);
    expect((await db.query<Record<string, unknown>>(`select * from public.mine_ekstra_fragt_regninger($1)`, [r.tradeId])).rows[0])
      .toMatchObject({ kan_goere_indsigelse: true, spaerrer: true });
    expect(await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Pakken vejede kun 900 g, da jeg sendte den.') as v`, [r.id])).toEqual({
      kode: "ok",
      annuller_pi: null,
      spaerret_til_afgoerelse: true,
    });
    const mine = (await db.query<Record<string, unknown>>(`select * from public.mine_ekstra_fragt_regninger($1)`, [r.tradeId])).rows[0];
    expect(mine).toMatchObject({ status: "indsigelse", spaerrer: true, indsigelse_efter_frist: true, kan_betale: false });
    expect((await j(`select public.min_ekstra_fragt_status() as v`)).spaerret).toBe(true);
    await som(null);
    expect((await nyAuktion(SAELGER3))?.code).toBe("BHX01");
    expect((await nytTilbud(SAELGER3))?.code).toBe("BHX01");
    // Fastholdt: mindst 7 dage fra afgørelsen -> ikke længere spærret.
    await som(STAFF);
    expect((await j(`select public.ekstra_fragt_afgoer_indsigelse($1, 'fasthold', 'Vejningen er korrekt.') as v`, [r.id])).kode).toBe("ok");
    await som(null);
    expect(await nyAuktion(SAELGER3)).toBeNull();
  });

  it("frafaldet efter en sen indsigelse ophæver spærringen", async () => {
    const r = await nyRegning({ saelger: SAELGER3, fristDage: -2 });
    await som(SAELGER3);
    expect((await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Fragtfirmaet har målt forkert.') as v`, [r.id])).kode).toBe("ok");
    await som(null);
    expect((await nyAuktion(SAELGER3))?.code).toBe("BHX01");
    await som(STAFF);
    expect((await j(`select public.ekstra_fragt_afgoer_indsigelse($1, 'frafald', 'Du har ret.') as v`, [r.id])).kode).toBe("ok");
    await som(null);
    expect(await nyAuktion(SAELGER3)).toBeNull();
  });
});

describe("L2: kasseret PaymentIntent giver nyt forsøg (ny idempotency key)", () => {
  it("indsigelse og frafald tæller pi_forsoeg op, når der var en PaymentIntent", async () => {
    const r = await nyRegning();
    await j(`select public.ekstra_fragt_betal_start($1, $2) as v`, [r.id, SAELGER]);
    await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_l2_0', 0)`, [r.id]);
    await som(SAELGER);
    await j(`select public.mit_ekstra_fragt_indsigelse($1, 'Pakken var lille, se billederne.') as v`, [r.id]);
    await som(STAFF);
    await j(`select public.ekstra_fragt_afgoer_indsigelse($1, 'fasthold', 'Målingen står ved magt.') as v`, [r.id]);
    await som(null);
    expect(await regning(r.id)).toMatchObject({ pi_forsoeg: 1, stripe_payment_intent_id: null });
    // Næste PaymentIntent gemmes kun med det nye forsøg.
    expect(await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_l2_x', 0) as v`, [r.id])).toEqual({ v: false });
    expect(await en(`select public.ekstra_fragt_gem_pi($1, 'pi_test_l2_1', 1) as v`, [r.id])).toEqual({ v: true });
    await som(STAFF);
    await j(`select public.ekstra_fragt_frafald($1, 'Vi frafalder alligevel.') as v`, [r.id]);
    await som(null);
    expect(await regning(r.id)).toMatchObject({ pi_forsoeg: 2, status: "frafaldet", annuller_pi: "pi_test_l2_1" });
    // Uden PaymentIntent: uændret.
    const u = await nyRegning();
    await som(STAFF);
    await j(`select public.ekstra_fragt_frafald($1, 'Fejl.') as v`, [u.id]);
    await som(null);
    expect((await regning(u.id)).pi_forsoeg).toBe(0);
  });
});

describe("L3 og oprydning: dokumentationsfiler", () => {
  it("filtypen i Storage skal passe til den angivne (HEIC/HEIF er samme format)", async () => {
    const h = await handel();
    await som(STAFF);
    expect((await opret(h.forsendelseId, h.tradeId, { sti: await dok(h.tradeId, "pdf", "text/html") })).kode).toBe("dokumentation_mangler");
    expect((await opret(h.forsendelseId, h.tradeId, { sti: await dok(h.tradeId, "pdf", "image/png") })).kode).toBe("dokumentation_mangler");
    expect(
      (await opret(h.forsendelseId, h.tradeId, { sti: await dok(h.tradeId, "heic", "image/heif"), type: "image/heic" })).kode,
    ).toBe("ok");
    await som(null);
  });

  it("ekstra_fragt_ubrugte_filer: kun ubrugte filer over 7 dage", async () => {
    const r = await nyRegning();
    const brugt = (await regning(r.id)).dokumentation_sti as string;
    const gammel = await dok(r.tradeId);
    const ny = await dok(r.tradeId);
    await db.query(`update storage.objects set created_at = now() - interval '8 days' where name = any($1)`, [[brugt, gammel]]);
    await db.query(`insert into storage.objects (bucket_id, name, created_at) values ('andet', 'x/y.pdf', now() - interval '30 days')`);
    const ud = (await db.query<{ v: string }>(`select v from public.ekstra_fragt_ubrugte_filer(1000) as v`)).rows.map((x) => x.v);
    expect(ud).toContain(gammel);
    expect(ud).not.toContain(brugt);
    expect(ud).not.toContain(ny);
    expect(ud).not.toContain("x/y.pdf");
    const p = await en(`
      select has_function_privilege('authenticated', 'public.ekstra_fragt_ubrugte_filer(integer)', 'execute') as auth,
             has_function_privilege('service_role', 'public.ekstra_fragt_ubrugte_filer(integer)', 'execute') as sr,
             has_function_privilege('authenticated', 'public.ekstra_fragt_registrer_bankindsigelse(text,text,text,bigint)', 'execute') as auth_bi,
             has_function_privilege('authenticated', 'public.ekstra_fragt_genaabn(uuid,text)', 'execute') as auth_gen,
             has_function_privilege('anon', 'public.ekstra_fragt_genaabn(uuid,text)', 'execute') as anon_gen`);
    expect(p).toEqual({ auth: false, sr: true, auth_bi: false, auth_gen: true, anon_gen: false });
  });

  it("oprydningen kører kun den 1. i måneden (dansk tid)", () => {
    expect(erOprydningsdag(new Date("2026-11-01T10:00:00Z"))).toBe(true);
    // 31. okt. kl. 23:30 UTC er 1. nov. i Danmark (vintertid, UTC+1).
    expect(erOprydningsdag(new Date("2026-10-31T23:30:00Z"))).toBe(true);
    expect(erOprydningsdag(new Date("2026-11-02T10:00:00Z"))).toBe(false);
  });
});

describe("rene regler", () => {
  it("kroner og kg til heltal (ingen kommatal)", () => {
    expect(kronerTilOere("35")).toBe(3500);
    expect(kronerTilOere("35,5")).toBe(3550);
    expect(kronerTilOere("1.250,05")).toBe(125005);
    expect(kronerTilOere("1.250")).toBe(125000);
    expect(kronerTilOere("19.99")).toBe(1999);
    expect(kronerTilOere("0,10")).toBe(10);
    expect(kronerTilOere("abc")).toBeNull();
    expect(kronerTilOere("1,2,3")).toBeNull();
    expect(kronerTilOere("0")).toBeNull();
    expect(kgTilGram("7,2")).toBe(7200);
    expect(kgTilGram("0,9")).toBe(900);
    expect(kgTilGram("15")).toBe(15000);
    expect(kgTilGram("x")).toBeNull();
  });

  it("afstemningens regler for ekstra fragt", () => {
    expect(ekstraFragtStatusAfviger("succeeded", "betalt")).toBe(false);
    expect(ekstraFragtStatusAfviger("succeeded", "afventer_betaling")).toBe(true);
    expect(ekstraFragtStatusAfviger("requires_payment_method", "betalt")).toBe(true);
    expect(forventetEkstraFragtRefunderet({ status: "betalt", beloeb_oere: 3500, modtaget_oere: 3500 })).toBe(0);
    expect(forventetEkstraFragtRefunderet({ status: "refunderet", beloeb_oere: 3500, modtaget_oere: 3500 })).toBe(3500);
    expect(erKasseretEkstraFragtRefusion({ metadata: { type: "ekstra_fragt", kasseret: "ja", ekstra_fragt_id: "x" } }, "x")).toBe(true);
    expect(erKasseretEkstraFragtRefusion({ metadata: { type: "boost", kasseret: "ja", ekstra_fragt_id: "x" } }, "x")).toBe(false);
  });

  it("beskederne: oprettet, påmindelse efter 7 dage, spærret ved fristen, afgjort", () => {
    const nu = Date.parse("2026-11-20T12:00:00Z");
    const base: EkstraFragtBeskedRaekke = {
      id: "r1",
      trade_id: "t1",
      saelger_id: SAELGER,
      status: "afventer_betaling",
      beloeb_oere: 3500,
      valgt_stoerrelse: "lille",
      maalt_stoerrelse: "mellem",
      maalt_vaegt_gram: 7200,
      frist: "2026-11-24T12:00:00Z",
      oprettet_kl: "2026-11-10T12:00:00Z",
      afgoerelse: null,
      afgoerelse_begrundelse: null,
      afgjort_kl: null,
      frafaldet_kl: null,
      frafald_grund: null,
      betalt_kl: null,
    };
    const noegler = (r: EkstraFragtBeskedRaekke, t = nu) => ekstraFragtBeskeder(r, t).map((o) => o.input.noegle);
    expect(noegler(base)).toEqual(["ekstrafragt:r1:oprettet", "ekstrafragt:r1:paamind"]);
    const tekst = ekstraFragtBeskeder(base, nu)[0].input.tekst;
    expect(tekst).toContain("35 kr.");
    expect(tekst).toContain("24. november 2026");
    expect(tekst).not.toMatch(/forsikring/i);
    expect(noegler(base, Date.parse("2026-11-12T12:00:00Z"))).toEqual(["ekstrafragt:r1:oprettet"]);
    expect(noegler(base, Date.parse("2026-11-25T12:00:00Z"))).toEqual([
      "ekstrafragt:r1:oprettet",
      `ekstrafragt:r1:spaerret:${Date.parse("2026-11-24T12:00:00Z")}`,
    ]);
    const fastholdt = { ...base, afgoerelse: "fastholdt" as const, afgoerelse_begrundelse: "Vejningen er korrekt", afgjort_kl: "2026-11-19T10:00:00Z" };
    expect(noegler(fastholdt)).toContain(`ekstrafragt:r1:afgjort:${Date.parse("2026-11-19T10:00:00Z")}`);
    // L8: allerede betalt, før "ny regning" blev sendt - kun kvitteringen.
    const betalt = { ...base, status: "betalt" as const, betalt_kl: "2026-11-19T10:00:00Z" };
    expect(noegler(betalt)).toEqual(["ekstrafragt:r1:betalt"]);
    // Frafaldet før beskeden blev sendt: ingen "betal"-besked.
    const frafaldet = { ...base, status: "frafaldet" as const, frafaldet_kl: "2026-11-10T13:00:00Z", frafald_grund: "Fejl" };
    expect(noegler(frafaldet)).toEqual([`ekstrafragt:r1:frafaldet:${Date.parse("2026-11-10T13:00:00Z")}`]);
    // L1: frafaldet EFTER en fastholdt indsigelse - besked om både afgørelsen og frafaldet.
    const fastholdtFrafaldet = { ...fastholdt, status: "frafaldet" as const, frafaldet_kl: "2026-11-20T09:00:00Z", frafald_grund: "Ny vurdering" };
    expect(noegler(fastholdtFrafaldet)).toEqual([
      `ekstrafragt:r1:afgjort:${Date.parse("2026-11-19T10:00:00Z")}`,
      `ekstrafragt:r1:frafaldet:${Date.parse("2026-11-20T09:00:00Z")}`,
    ]);
    // Indsigelsen frafaldet: kun afgørelsen (ingen dobbeltbesked).
    const medhold = {
      ...base,
      status: "frafaldet" as const,
      afgoerelse: "frafaldet" as const,
      afgoerelse_begrundelse: "Du har ret",
      afgjort_kl: "2026-11-19T10:00:00Z",
      frafaldet_kl: "2026-11-19T10:00:00Z",
      frafald_grund: "Du har ret",
    };
    expect(noegler(medhold)).toEqual([`ekstrafragt:r1:afgjort:${Date.parse("2026-11-19T10:00:00Z")}`]);
  });

  it("beskederne ved genåbning: egen besked, påmindelse og kvittering pr. runde", () => {
    const g: EkstraFragtBeskedRaekke = {
      id: "r2",
      trade_id: "t2",
      saelger_id: SAELGER,
      status: "afventer_betaling",
      beloeb_oere: 3500,
      valgt_stoerrelse: "lille",
      maalt_stoerrelse: "mellem",
      maalt_vaegt_gram: null,
      frist: "2026-12-15T12:00:00Z",
      oprettet_kl: "2026-10-01T12:00:00Z",
      afgoerelse: null,
      afgoerelse_begrundelse: null,
      afgjort_kl: null,
      frafaldet_kl: null,
      frafald_grund: null,
      betalt_kl: null,
      runde: 1,
      genaabnet_kl: "2026-12-01T12:00:00Z",
      genaabn_begrundelse: "Din bank har tilbageført betalingen",
    };
    const noegler = (r: EkstraFragtBeskedRaekke, t: number) => ekstraFragtBeskeder(r, t).map((o) => o.input.noegle);
    const gk = `ekstrafragt:r2:genaabnet:${Date.parse("2026-12-01T12:00:00Z")}`;
    expect(noegler(g, Date.parse("2026-12-02T12:00:00Z"))).toEqual([gk]);
    expect(ekstraFragtBeskeder(g, Date.parse("2026-12-02T12:00:00Z"))[0].input.tekst).toContain("tilbageført");
    expect(noegler(g, Date.parse("2026-12-09T12:00:00Z"))).toEqual([gk, "ekstrafragt:r2:paamind:1"]);
    expect(noegler({ ...g, status: "betalt", betalt_kl: "2026-12-10T12:00:00Z" }, Date.parse("2026-12-10T13:00:00Z"))).toEqual([
      "ekstrafragt:r2:betalt:1",
    ]);
  });
});
