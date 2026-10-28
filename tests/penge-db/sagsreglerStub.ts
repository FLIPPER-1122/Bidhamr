// Fælles opsætning for tests/penge-db/sagsregler.test.ts (migrationen
// 20261102210000_sagsregler.sql i PGlite): stubs af de tabeller og
// hjælpefunktioner, sagsfunktionerne bruger, og de RIGTIGE funktioner fra
// testdatabasen før migrationen (fixtures/sagsregler_foer_20261102210000.sql -
// så md5-drift-tjekket genkender dem som "gammel").
import { readFileSync } from "node:fs";
import path from "node:path";

export const MIG = path.resolve(import.meta.dirname, "../../supabase/migrations");
export const SAGSREGLER = readFileSync(path.join(MIG, "20261102210000_sagsregler.sql"), "utf8");
export const FOER = readFileSync(path.resolve(import.meta.dirname, "fixtures/sagsregler_foer_20261102210000.sql"), "utf8");

export const KOEBER = "00000000-0000-4000-8000-0000000000a1";
export const SAELGER = "00000000-0000-4000-8000-0000000000b1";
export const FREMMED = "00000000-0000-4000-8000-0000000000c1";
export const MEDARBEJDER = "00000000-0000-4000-8000-0000000000d2";
export const ADMIN = "00000000-0000-4000-8000-0000000000d1";
export const SYSTEM = "00000000-0000-4000-8000-00000000000f";

export const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);

create table public.users (id uuid primary key, navn text, rolle text not null default 'bruger');
insert into public.users values ('${KOEBER}', 'Køber', 'bruger'), ('${SAELGER}', 'Sælger', 'bruger'),
  ('${FREMMED}', 'Fremmed', 'bruger'), ('${ADMIN}', 'Admin', 'admin'), ('${MEDARBEJDER}', 'Medarbejder', 'medarbejder'),
  ('${SYSTEM}', 'BidHamr', 'bruger');
create function public.bidhamr_system_id() returns uuid language sql immutable as $$ select '${SYSTEM}'::uuid $$;
create function public.staff_chat_har_rolle(p uuid, r text) returns boolean language sql as
  $$ select exists (select 1 from public.users u where u.id = p and
       case r when 'chef' then u.rolle = 'chef' when 'admin' then u.rolle in ('admin','chef') else u.rolle in ('medarbejder','admin','chef') end) $$;
create function public.er_staff() returns boolean language sql stable as
  $$ select exists (select 1 from public.users u where u.id = auth.uid() and u.rolle in ('medarbejder','admin','chef')) $$;
create function public.penge_inhabil(p_m uuid, p_k uuid, p_s uuid) returns boolean language sql as
  $$ select p_m = p_k or p_m = p_s $$;
create function public.betaling_indsigelse_blokerer(p_kl timestamptz, p_status text) returns boolean
  language sql immutable as $$ select p_kl is not null and coalesce(p_status, '') not in ('won', 'lost') $$;
-- Som repoets filter: e-mail eller 8 cifre.
create function public.indeholder_kontaktinfo(p text) returns boolean language sql immutable as
  $$ select coalesce(p, '') ~* '[a-z0-9._-]+@[a-z0-9.-]+\\.[a-z]{2,}' or regexp_replace(coalesce(p, ''), '[\\s-]', '', 'g') ~ '\\d{8}' $$;
create function public.sag_anke_vurder(p_sag uuid, p_bruger uuid) returns jsonb language sql as
  $$ select jsonb_build_object('kode', 'ingen_anke') $$;
create function public.fragt_reklamation_synkroniser_sikker(p_sag uuid) returns text language sql as $$ select 'stub' $$;
create function public.udbetalinger_stoppet() returns boolean language sql as $$ select false $$;
create function public.staff_aal2_ok(p integer default null) returns boolean language sql as $$ select true $$;

create table public.moderation_log (id uuid primary key default gen_random_uuid(), medarbejder_id uuid not null,
  handling text not null, maal_type text not null, maal_id uuid not null, bruger_id uuid, aarsag text not null,
  oprettet timestamptz default now(),
  constraint moderation_log_handling_check check (handling = any (array['advarsel','sag_afgjort_koeber',
    'sag_afgjort_saelger','sag_lukket','sag_afviklet','sag_retur_afleveret','indpakning_ordentlig',
    'ekstra_fragt_oprettet','returfragt_refunderet','sag_anke_omgjort','sag_anke_stadfaestet'])),
  constraint moderation_log_maal_type_check check (maal_type = any (array['bruger','sag','handel'])));

create table public.auctions (id uuid primary key default gen_random_uuid(), titel text default 'Vare',
  pakkestoerrelse text default 'lille', fragt_pakkeshop_oere bigint default 4200);
create table public.trades (id uuid primary key default gen_random_uuid(), auction_id uuid references public.auctions(id),
  buyer_id uuid, seller_id uuid, amount numeric, afhentning boolean default false, status text default 'modtaget',
  received_at timestamptz, sendt_kl timestamptz, modtaget_kilde text, sag_aaben boolean default false,
  sag_note text, sag_aabnet_af uuid, sag_aabnet_at timestamptz, tracking_number text);
create table public.betalinger (id uuid primary key default gen_random_uuid(), trade_id uuid unique, status text default 'betalt',
  beskyttelse boolean default true, betalt_kl timestamptz default now() - interval '10 days', frigivet_kl timestamptz,
  refusion_anmodet_kl timestamptz, overfoersel_paabegyndt_kl timestamptz, stripe_transfer_id text,
  saelger_udbetaling_id uuid, indsigelse_kl timestamptz, indsigelse_status text, prismodel text default 'ny2',
  bud_oere bigint default 100000, koebergebyr_oere bigint default 7500, saelgergebyr_oere bigint default 5500,
  fragt_oere bigint default 4200, beskyttelse_oere bigint default 0, total_oere bigint default 111700,
  udbetaling_oere bigint default 94500, application_fee_oere bigint default 17200, pengemodel text default 'destination',
  refusion_aarsag text, refusion_oere bigint, auto_frigiv_opgave_kl timestamptz, kraever_opmaerksomhed boolean default false,
  sidste_fejl text, opdateret timestamptz default now(), refunderet_kl timestamptz,
  bidhamr_daekker_kl timestamptz, bidhamr_daekker_af uuid, bidhamr_daekker_oere bigint, bidhamr_daekker_begrundelse text,
  bidhamr_daekker_noegle uuid, stripe_refund_id text, gebyr_refunderet_kl timestamptz, refusion_tilbagefoert_kl timestamptz);
create table public.sager (id uuid primary key default gen_random_uuid(), trade_id uuid not null unique, oprettet_af uuid,
  type text not null, beskrivelse text not null, status text not null default 'aaben', beskyttelse boolean default false,
  handel_status_ved_oprettelse text, oprettet_kl timestamptz not null default now(), afgjort_af uuid, afgjort_kl timestamptz,
  begrundelse text, intern_note text, retur_kraeves boolean default false, returfragt_betaler text,
  retur_afleveret_kl timestamptz, retur_registreret_af uuid, refusion_oere bigint, genaabnet_antal integer default 0,
  genaabnet_kl timestamptz, penge_handling text, penge_flyttes_efter_kl timestamptz, afviklet_kl timestamptz,
  penge_fejl text, tjek_sporing boolean default false, notificeret_kl timestamptz, opdateret timestamptz default now(),
  constraint sager_type_check check (type in ('bortkommet', 'skadet', 'ikke_som_beskrevet', 'svindel')),
  constraint sager_returfragt_check check (returfragt_betaler is null or returfragt_betaler in ('koeber', 'bidhamr')));
create table public.sag_billeder (id uuid primary key default gen_random_uuid(), sag_id uuid, sti text unique, kategori text,
  oprettet_kl timestamptz default now(),
  constraint sag_billeder_kategori_check check (kategori in ('pakke', 'label', 'indhold', 'andet')));
create table public.sag_anker (id uuid primary key default gen_random_uuid(), sag_id uuid, trade_id uuid, status text,
  part text, indgivet_af uuid, ankede_afgjort_af uuid, behandlet_af uuid, behandlet_kl timestamptz,
  afgoerelse_begrundelse text, intern_note text, indgivet_kl timestamptz default now());
create table public.sag_anke_billeder (id uuid primary key default gen_random_uuid(), anke_id uuid, sti text unique);
create table public.forsendelser (id uuid primary key default gen_random_uuid(), trade_id uuid, type text,
  fragtfirma text default 'shipmondo', transportoer text default 'dao', status text default 'oprettet',
  pakkestoerrelse text default 'lille', sporingsnummer text, afsender jsonb, leveret_kl timestamptz,
  leveret_frigiver boolean default true, returneret_kl timestamptz, oprettet_kl timestamptz default now(),
  forsoegt_kl timestamptz default now(), ukendt_udfald_kl timestamptz, fejl text);
create table public.forsendelse_haendelser (id uuid primary key default gen_random_uuid(), forsendelse_id uuid,
  type text, modtaget_kl timestamptz default now());
create table public.handel_ikke_afhentet (trade_id uuid, betaling_id uuid);
create table public.fragt_pakkestoerrelser (kode text primary key, pakkeshop_oere bigint);
insert into public.fragt_pakkestoerrelser values ('lille', 4200), ('mellem', 5200), ('stor', 6700);
create table public.indpakning_ordentlig (sag_id uuid primary key, trade_id uuid, vurderet_af uuid,
  vurderet_kl timestamptz default now(), intern_note text, tilbagekaldt_kl timestamptz, tilbagekaldt_af uuid,
  tilbagekaldt_grund text);
create table public.paamindelser (id uuid primary key default gen_random_uuid(), sag_id uuid, grund text);
create table public.advarsler (id uuid primary key default gen_random_uuid(), sag_id uuid, grund text);
create table public.fragt_reklamationer (id uuid primary key default gen_random_uuid(), sag_id uuid unique);
create table public.returfragt_betalinger (
  id uuid primary key default gen_random_uuid(), trade_id uuid not null, sag_id uuid not null, koeber_id uuid not null,
  betaling_id uuid, beloeb_oere bigint not null, pakkestoerrelse text, valuta text not null default 'dkk',
  status text not null default 'afventer', stripe_payment_intent_id text, tidligere_payment_intents text[] not null default '{}',
  pi_forsoeg integer not null default 0, stripe_charge_id text, modtaget_oere bigint, sidste_fejl text, afsender jsonb,
  oprettet_kl timestamptz not null default now(), betalt_kl timestamptz, forsendelse_id uuid, label_klar_kl timestamptz,
  label_annulleret_bekraeftet_kl timestamptz, label_forsoeg integer not null default 0, label_fejl_antal integer not null default 0,
  label_naeste_kl timestamptz, label_brugerfejl text, label_intern_fejl text, refusion_aarsag text, refusion_anmodet_kl timestamptz,
  refusion_forsoeg integer not null default 0, refusion_naeste_kl timestamptz, refusion_sidste_fejl text, stripe_refund_id text,
  refunderet_kl timestamptz, annulleret_kl timestamptz, kraever_opmaerksomhed boolean not null default false,
  opmaerksomhed_tekst text, synket_kl timestamptz, opdateret timestamptz not null default now(),
  constraint returfragt_status_check check (status in ('afventer', 'behandles', 'betalt', 'refunderes', 'refunderet', 'annulleret')),
  constraint returfragt_beloeb_check check (beloeb_oere between 300 and 1000000),
  constraint returfragt_betalt_check check (status not in ('betalt', 'refunderes', 'refunderet') or betalt_kl is not null));
create unique index returfragt_en_aktiv on public.returfragt_betalinger (trade_id)
  where status in ('afventer', 'behandles', 'betalt', 'refunderes');
create table public.ekstra_fragt_regninger (
  id uuid primary key default gen_random_uuid(), trade_id uuid not null, forsendelse_id uuid not null, saelger_id uuid not null,
  betaling_id uuid not null, transportoer text, sporingsnummer text, valgt_stoerrelse text not null, maalt_stoerrelse text,
  maalt_vaegt_gram integer, maalt_maal text, beloeb_oere bigint not null, valuta text not null default 'dkk',
  fragtfirma_fakturanummer text not null, forklaring text, dokumentation_sti text not null, dokumentation_type text not null,
  dokumentation_navn text, status text not null default 'afventer_betaling', frist timestamptz not null,
  oprettet_af uuid not null, oprettet_kl timestamptz not null default now(), stripe_payment_intent_id text,
  stripe_charge_id text, modtaget_oere bigint, betalt_kl timestamptz, indsigelse_tekst text, afgoerelse_begrundelse text,
  frafald_grund text, sidste_fejl text, opmaerksomhed_tekst text, intern_note text, runde integer not null default 0,
  constraint ekstra_fragt_beloeb_check check (beloeb_oere between 300 and 1000000),
  constraint ekstra_fragt_stoerrelse_check check (
    valgt_stoerrelse in ('lille', 'mellem', 'stor')
    and (maalt_stoerrelse is null or maalt_stoerrelse in ('lille', 'mellem', 'stor', 'over_stor'))
    and (maalt_vaegt_gram is null or maalt_vaegt_gram between 1 and 1000000)
    and (maalt_stoerrelse is not null or maalt_vaegt_gram is not null)),
  constraint ekstra_fragt_dokumentation_check check (
    dokumentation_sti ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(pdf|jpg|png|webp|heic)$'),
  constraint ekstra_fragt_tekst_laengde check (char_length(fragtfirma_fakturanummer) between 1 and 100));
create table public.fakturaer (
  id uuid primary key default gen_random_uuid(), dokument text not null, part text not null, bruger_id uuid not null,
  betaling_id uuid, trade_id uuid, krediterer_id uuid, linjer jsonb not null, beloeb_oere bigint not null,
  moms_oere bigint not null, betalt_dato date not null, stripe_reference text, status text not null default 'venter',
  manuel boolean not null default false, sidste_fejl text, slags text not null default 'salg', returfragt_id uuid,
  ekstra_fragt_id uuid, ekstra_fragt_runde integer, oprettet_kl timestamptz default now());
create function public.faktura_linje(p_kode text, p_tekst text, p_beloeb bigint) returns jsonb language sql immutable as
  $$ select case when p_beloeb is null or p_beloeb <= 0 then null
            else jsonb_build_object('kode', p_kode, 'tekst', p_tekst, 'beloeb_oere', p_beloeb) end $$;
create function public.faktura_moms(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint - round((l->>'beloeb_oere')::numeric * 4 / 5)::bigint), 0)::bigint
     from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
create function public.faktura_sum(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint), 0)::bigint from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
`;

// Efter fixturen (triggerne bruger de rigtige funktioner).
export const EFTER_FOER = `
create trigger sager_beskyt before update on public.sager for each row execute function public.sager_beskyt();
`;

// Opsætning: stubs, de rigtige funktioner (uden at validere SQL-kroppe mod
// tabeller, stubben ikke har) og triggerne.
export async function opsaet(db: { exec: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.exec(STUB);
  await db.exec("set check_function_bodies = off;");
  await db.exec(FOER);
  await db.exec(EFTER_FOER);
}

// ------------------------------------------------------------------ 20261102350000

export const RETTELSER = readFileSync(path.join(MIG, "20261102350000_sagsregler_rettelser.sql"), "utf8");
export const FOER_RETTELSER = readFileSync(
  path.resolve(import.meta.dirname, "fixtures/sagsregler_rettelser_foer_20261102350000.sql"),
  "utf8",
);

// Det, rettelserne bruger ud over stubben ovenfor (efter 20261102210000).
export const STUB_RETTELSER = `
create table public.notifikation_afsendelser (noegle text primary key, bruger_id uuid, type text, status text);
create table public.drift_fejl_stub (id serial primary key, kilde text, sti text, besked text, digest text);
create function public.drift_fejl_log(p_kilde text, p_sti text, p_besked text, p_digest text default null,
  p_bruger_id uuid default null) returns text language sql as
  $$ insert into public.drift_fejl_stub (kilde, sti, besked, digest) values (p_kilde, p_sti, p_besked, p_digest) returning 'ny' $$;
create function public.mine_data_grund() returns jsonb language sql as $$ select '{"grund": true}'::jsonb $$;
create function public.mine_data() returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  v := public.mine_data_grund();
  return v;
end $fn$;
alter table public.ekstra_fragt_regninger
  add column frafaldet_kl timestamptz, add column frafaldet_af uuid, add column afgoerelse text,
  add column afgjort_kl timestamptz, add column afgjort_af uuid,
  add column tidligere_payment_intents text[] not null default '{}', add column annuller_pi text,
  add column pi_forsoeg integer not null default 0, add column kraever_opmaerksomhed boolean not null default false;
alter table public.fragt_reklamationer add column status text, add column fremdrift_kl timestamptz,
  add column annulleret_auto boolean default false, add column annulleret_kl timestamptz;
alter table public.moderation_log drop constraint moderation_log_handling_check;
alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (array['advarsel',
  'sag_afgjort_koeber','sag_afgjort_saelger','sag_lukket','sag_afviklet','sag_retur_afleveret','indpakning_ordentlig',
  'ekstra_fragt_oprettet','ekstra_fragt_frafaldet','returfragt_refunderet','sag_anke_omgjort','sag_anke_stadfaestet',
  'sag_genaabnet','sag_type_rettet']));
`;

// Efter 20261102210000: stubs + de rigtige funktioner fra testdatabasen.
export async function opsaetRettelser(db: { exec: (sql: string) => Promise<unknown> }): Promise<void> {
  await db.exec(STUB_RETTELSER);
  await db.exec(FOER_RETTELSER);
}
