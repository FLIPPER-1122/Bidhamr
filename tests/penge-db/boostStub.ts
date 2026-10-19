// Stubs til boost-migrationerne i PGlite (fælles for boost.test.ts og
// boostPakker.test.ts): de tabeller og funktioner, 20261023030000_boost.sql
// bygger på.
export const PRIVAT = "00000000-0000-4000-8000-0000000000a1";
export const PRIVAT2 = "00000000-0000-4000-8000-0000000000a2";
export const FIRMA = "00000000-0000-4000-8000-0000000000b1";
export const SPAERRET = "00000000-0000-4000-8000-0000000000c1";
export const CHEF = "00000000-0000-4000-8000-0000000000d1";
export const ADMIN = "00000000-0000-4000-8000-0000000000d2";
export const SYSTEM = "00000000-0000-4000-8000-000000000000";

export const STUB = `
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
  -- Som efter 20261022010000_returfragt_betaling.sql (migrationen drift-tjekker den).
  constraint fakturaer_slags_check check (slags in ('salg', 'returfragt', 'sag_returfragt')
         and (slags = 'salg'
              or (slags = 'returfragt' and dokument = 'faktura' and part = 'koeber')
              or (slags = 'sag_returfragt' and dokument in ('faktura', 'kreditnota') and part = 'koeber'))));
create function public.faktura_linje(p_kode text, p_tekst text, p_beloeb bigint) returns jsonb language sql immutable as
  $$ select case when p_beloeb is null or p_beloeb <= 0 then null
            else jsonb_build_object('kode', p_kode, 'tekst', p_tekst, 'beloeb_oere', p_beloeb) end $$;
create function public.faktura_moms(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint - round((l->>'beloeb_oere')::numeric * 4 / 5)::bigint), 0)::bigint
     from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
create function public.faktura_sum(p_linjer jsonb) returns bigint language sql immutable as
  $$ select coalesce(sum((l->>'beloeb_oere')::bigint), 0)::bigint from jsonb_array_elements(coalesce(p_linjer, '[]'::jsonb)) l $$;
`;
