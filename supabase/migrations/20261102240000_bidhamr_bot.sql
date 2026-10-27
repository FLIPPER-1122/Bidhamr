-- BidHamr-bot (ROADMAP-BESLUTNINGER "Nye funktioner før lancering", punkt 2,
-- Filip 27. okt. 2026): en AI-chat på hjemmesiden og i appen.
--
-- Indhold:
--   1. bot_samtaler og bot_beskeder: samtalen og forbruget (tokens og pris i
--      USD) pr. svar. Kun service-role (serveren) kan læse og skrive -
--      browseren og appen kommer aldrig direkte til tabellerne.
--   2. bot_ny_besked(): loftet mod misbrug i databasen (atomisk tjek og
--      registrering): 30 beskeder pr. bruger pr. døgn, 30 pr. IP pr. døgn for
--      besøgende uden login, 100 pr. IP pr. døgn i alt (CGNAT), 40 pr.
--      samtale og 5.000 i alt pr. døgn. Kun service-role.
--   3. bot_gem_svar(): gemmer bottens svar og forbruget. Kun service-role.
--   4. bot_overdrag(): "Kontakt en rigtig medarbejder" - opretter en
--      henvendelse i kontakt_henvendelser (emne 'bot') med hele samtalen.
--      Idempotent: kun første klik opretter henvendelsen. Kun service-role.
--      Medarbejderen svarer i staff-chatten ("Fra BidHamr" i Beskeder) med
--      den eksisterende Svar-knap på /admin/kontakt.
--   5. bot_forbrug_oversigt(): samlet forbrug og pris til /admin/bot (chef).
--      Kun service-role.
--
-- Botten har INGEN skriveadgang til handelsdata: dens læseværktøjer kører
-- med brugerens egen session (RLS) i serveren, ikke via disse funktioner.
-- Idempotent: if not exists / create or replace / drop ... if exists.
-- Ingen eksisterende data ændres. Handelsdata slettes aldrig.

-- ============================================================ 1. Tabeller

create table if not exists public.bot_samtaler (
  id           uuid primary key default gen_random_uuid(),
  -- null = besøgende uden login.
  bruger_id    uuid references public.users(id) on delete set null,
  -- HMAC af IP-adressen (aldrig selve adressen) - til loftet pr. IP.
  ip_hash      text not null,
  kilde        text not null default 'web',
  -- Kun besøgende uden login: e-mailen, de angav ved "Kontakt en rigtig
  -- medarbejder".
  email        text,
  overdraget_kl timestamptz,
  oprettet_kl  timestamptz not null default now(),
  opdateret_kl timestamptz not null default now(),
  constraint bot_samtaler_kilde_check check (kilde in ('web', 'app')),
  constraint bot_samtaler_ip_hash_laengde check (char_length(ip_hash) between 16 and 128),
  constraint bot_samtaler_email_laengde check (email is null or char_length(email) between 3 and 254)
);

comment on table public.bot_samtaler is
  'Samtaler med BidHamr-bot. Kun service-role. bruger_id null = uden login. '
  'overdraget_kl = sendt videre til en medarbejder (kontakt_henvendelser.bot_samtale_id).';

create index if not exists bot_samtaler_bruger_idx on public.bot_samtaler (bruger_id, oprettet_kl desc);
create index if not exists bot_samtaler_opdateret_idx on public.bot_samtaler (opdateret_kl desc);

create table if not exists public.bot_beskeder (
  id                 uuid primary key default gen_random_uuid(),
  samtale_id         uuid not null references public.bot_samtaler(id) on delete restrict,
  rolle              text not null,
  tekst              text not null,
  -- Kopieret fra samtalen, så loftet kan tælles med et indeks.
  bruger_id          uuid,
  ip_hash            text,
  -- Forbrug (kun på bottens svar; summen af alle runder i tool-løkken).
  model              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  pris_usd           numeric(14, 6) not null default 0,
  vaerktoejer        text[] not null default '{}',
  stop_aarsag        text,
  runder             integer not null default 0,
  oprettet_kl        timestamptz not null default now(),
  constraint bot_beskeder_rolle_check check (rolle in ('bruger', 'bot')),
  constraint bot_beskeder_tekst_laengde check (char_length(tekst) between 1 and 8000),
  constraint bot_beskeder_tokens_check check (
    input_tokens >= 0 and output_tokens >= 0 and cache_read_tokens >= 0
    and cache_write_tokens >= 0 and pris_usd >= 0 and runder >= 0)
);

comment on table public.bot_beskeder is
  'Beskeder i samtaler med BidHamr-bot og forbruget pr. svar (tokens og pris i USD). Kun service-role.';

create index if not exists bot_beskeder_samtale_idx on public.bot_beskeder (samtale_id, oprettet_kl);
create index if not exists bot_beskeder_bruger_loft_idx
  on public.bot_beskeder (bruger_id, oprettet_kl) where rolle = 'bruger';
create index if not exists bot_beskeder_ip_loft_idx
  on public.bot_beskeder (ip_hash, oprettet_kl) where rolle = 'bruger';
create index if not exists bot_beskeder_tid_idx on public.bot_beskeder (oprettet_kl);

alter table public.bot_samtaler enable row level security;
alter table public.bot_beskeder enable row level security;
revoke all on public.bot_samtaler from public, anon, authenticated;
revoke all on public.bot_beskeder from public, anon, authenticated;
grant select, insert, update on public.bot_samtaler to service_role;
grant select, insert on public.bot_beskeder to service_role;

-- Henvendelser fra botten genbruger kontakt_henvendelser (/admin/kontakt).
alter table public.kontakt_henvendelser
  add column if not exists bot_samtale_id uuid references public.bot_samtaler(id) on delete restrict;
create unique index if not exists kontakt_henvendelser_bot_samtale_unik
  on public.kontakt_henvendelser (bot_samtale_id) where bot_samtale_id is not null;

alter table public.kontakt_henvendelser drop constraint if exists kontakt_emne_check;
alter table public.kontakt_henvendelser add constraint kontakt_emne_check
  check (emne in ('generelt', 'handel', 'betaling', 'fejl', 'bot'));

-- ============================================================ 2. Loftet

-- Registrerer brugerens besked, hvis loftet tillader det. Atomisk: en
-- transaktionslås gør tjek og indsættelse til ét skridt, så mange samtidige
-- kald ikke kan slippe forbi loftet. p_bruger er den bruger, serveren har
-- verificeret (auth.getUser) - funktionen kan kun kaldes med service-role.
-- p_samtale null = ny samtale. En eksisterende samtale skal tilhøre samme
-- bruger (eller være uden login, når p_bruger er null).
create or replace function public.bot_ny_besked(
  p_samtale uuid,
  p_bruger  uuid,
  p_ip_hash text,
  p_kilde   text,
  p_tekst   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c_maks_bruger   constant integer := 30;
  c_maks_ip_anon  constant integer := 30;
  c_maks_ip       constant integer := 100;
  c_maks_samtale  constant integer := 40;
  c_maks_alle     constant integer := 5000;
  c_maks_tegn     constant integer := 1000;
  v_fra     timestamptz := now() - interval '24 hours';
  v_samtale uuid := p_samtale;
  v_ejer    uuid;
  v_tekst   text := btrim(coalesce(p_tekst, ''));
  v_id      uuid;
  n         integer;
begin
  if char_length(v_tekst) = 0 or char_length(v_tekst) > c_maks_tegn then
    return jsonb_build_object('kode', 'ugyldig_laengde');
  end if;
  if p_ip_hash is null or char_length(p_ip_hash) not between 16 and 128 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if p_kilde is null or p_kilde not in ('web', 'app') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  perform pg_advisory_xact_lock(hashtext('bidhamr_bot_loft'));

  if v_samtale is not null then
    select s.bruger_id into v_ejer from public.bot_samtaler s where s.id = v_samtale;
    if not found or v_ejer is distinct from p_bruger then
      return jsonb_build_object('kode', 'ukendt_samtale');
    end if;
    select count(*) into n from public.bot_beskeder b
     where b.samtale_id = v_samtale and b.rolle = 'bruger';
    if n >= c_maks_samtale then
      return jsonb_build_object('kode', 'samtale_fuld');
    end if;
  end if;

  if p_bruger is not null then
    select count(*) into n from public.bot_beskeder b
     where b.bruger_id = p_bruger and b.rolle = 'bruger' and b.oprettet_kl > v_fra;
    if n >= c_maks_bruger then
      return jsonb_build_object('kode', 'loft_bruger');
    end if;
  else
    select count(*) into n from public.bot_beskeder b
     where b.ip_hash = p_ip_hash and b.rolle = 'bruger' and b.bruger_id is null
       and b.oprettet_kl > v_fra;
    if n >= c_maks_ip_anon then
      return jsonb_build_object('kode', 'loft_ip');
    end if;
  end if;

  select count(*) into n from public.bot_beskeder b
   where b.ip_hash = p_ip_hash and b.rolle = 'bruger' and b.oprettet_kl > v_fra;
  if n >= c_maks_ip then
    return jsonb_build_object('kode', 'loft_ip');
  end if;

  select count(*) into n from public.bot_beskeder b
   where b.rolle = 'bruger' and b.oprettet_kl > v_fra;
  if n >= c_maks_alle then
    return jsonb_build_object('kode', 'loft_alle');
  end if;

  if v_samtale is null then
    insert into public.bot_samtaler (bruger_id, ip_hash, kilde)
    values (p_bruger, p_ip_hash, p_kilde)
    returning id into v_samtale;
  else
    update public.bot_samtaler set opdateret_kl = now() where id = v_samtale;
  end if;

  insert into public.bot_beskeder (samtale_id, rolle, tekst, bruger_id, ip_hash)
  values (v_samtale, 'bruger', v_tekst, p_bruger, p_ip_hash)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'samtale_id', v_samtale, 'besked_id', v_id);
end;
$fn$;

revoke all on function public.bot_ny_besked(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.bot_ny_besked(uuid, uuid, text, text, text) to service_role;

-- ============================================================ 3. Svar og forbrug

create or replace function public.bot_gem_svar(
  p_samtale     uuid,
  p_tekst       text,
  p_model       text,
  p_input       integer,
  p_output      integer,
  p_cache_read  integer,
  p_cache_write integer,
  p_pris_usd    numeric,
  p_vaerktoejer text[],
  p_stop        text,
  p_runder      integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s record;
  v_tekst text := left(btrim(coalesce(p_tekst, '')), 8000);
begin
  select id, bruger_id, ip_hash into s from public.bot_samtaler where id = p_samtale;
  if not found then
    return jsonb_build_object('kode', 'ukendt_samtale');
  end if;
  if char_length(v_tekst) = 0 then
    v_tekst := '(intet svar)';
  end if;
  insert into public.bot_beskeder (
    samtale_id, rolle, tekst, bruger_id, ip_hash, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    pris_usd, vaerktoejer, stop_aarsag, runder)
  values (
    p_samtale, 'bot', v_tekst, s.bruger_id, s.ip_hash, left(p_model, 100),
    greatest(coalesce(p_input, 0), 0), greatest(coalesce(p_output, 0), 0),
    greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0),
    greatest(coalesce(p_pris_usd, 0), 0), coalesce(p_vaerktoejer, '{}'),
    left(p_stop, 40), greatest(coalesce(p_runder, 0), 0));
  update public.bot_samtaler set opdateret_kl = now() where id = p_samtale;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.bot_gem_svar(uuid, text, text, integer, integer, integer, integer, numeric, text[], text, integer)
  from public, anon, authenticated;
grant execute on function public.bot_gem_svar(uuid, text, text, integer, integer, integer, integer, numeric, text[], text, integer)
  to service_role;

-- ============================================================ 4. Overdrag til medarbejder

-- "Kontakt en rigtig medarbejder". p_bruger er den verificerede bruger
-- (null = uden login, så kræves p_email). p_besked er samtalen som tekst
-- (bygget af serveren ud fra bot_beskeder). Idempotent: samtalen markeres i
-- samme update ... where overdraget_kl is null, så et dobbeltklik ikke giver
-- to henvendelser.
create or replace function public.bot_overdrag(
  p_samtale uuid,
  p_bruger  uuid,
  p_email   text,
  p_besked  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ejer   uuid;
  v_email  text;
  v_besked text := left(btrim(coalesce(p_besked, '')), 4000);
  v_id     uuid;
  n        integer;
begin
  select s.bruger_id into v_ejer from public.bot_samtaler s where s.id = p_samtale;
  if not found or v_ejer is distinct from p_bruger then
    return jsonb_build_object('kode', 'ukendt_samtale');
  end if;

  select count(*) into n from public.bot_beskeder b
   where b.samtale_id = p_samtale and b.rolle = 'bruger';
  if n = 0 then
    return jsonb_build_object('kode', 'tom_samtale');
  end if;

  if p_bruger is not null then
    select u.email into v_email from public.users u where u.id = p_bruger;
  else
    v_email := lower(btrim(coalesce(p_email, '')));
    if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 254 then
      return jsonb_build_object('kode', 'ugyldig_email');
    end if;
  end if;
  if v_email is null or char_length(v_email) < 3 then
    return jsonb_build_object('kode', 'ugyldig_email');
  end if;
  if char_length(v_besked) < 10 then
    v_besked := rpad(v_besked, 10, '.');
  end if;

  update public.bot_samtaler
     set overdraget_kl = now(),
         opdateret_kl = now(),
         email = case when p_bruger is null then v_email else email end
   where id = p_samtale and overdraget_kl is null;
  get diagnostics n = row_count;
  if n = 0 then
    select k.id into v_id from public.kontakt_henvendelser k where k.bot_samtale_id = p_samtale;
    return jsonb_build_object('kode', 'allerede', 'henvendelse_id', v_id);
  end if;

  insert into public.kontakt_henvendelser (bruger_id, email, emne, besked, bot_samtale_id)
  values (p_bruger, v_email, 'bot', v_besked, p_samtale)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'henvendelse_id', v_id);
end;
$fn$;

revoke all on function public.bot_overdrag(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.bot_overdrag(uuid, uuid, text, text) to service_role;

-- ============================================================ 5. Forbrug til admin

-- Samlet forbrug pr. periode (døgn, 7 og 30 dage, i alt). Kun service-role;
-- /admin/bot kalder den efter kraevSideRolle('chef').
create or replace function public.bot_forbrug_oversigt()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with p(navn, fra) as (
    values ('doegn', now() - interval '24 hours'),
           ('uge', now() - interval '7 days'),
           ('maaned', now() - interval '30 days'),
           ('alt', '-infinity'::timestamptz))
  select jsonb_object_agg(p.navn, jsonb_build_object(
           'samtaler', (select count(distinct b.samtale_id) from public.bot_beskeder b where b.oprettet_kl > p.fra),
           'beskeder', (select count(*) from public.bot_beskeder b where b.rolle = 'bruger' and b.oprettet_kl > p.fra),
           'input_tokens', (select coalesce(sum(b.input_tokens), 0) from public.bot_beskeder b where b.oprettet_kl > p.fra),
           'output_tokens', (select coalesce(sum(b.output_tokens), 0) from public.bot_beskeder b where b.oprettet_kl > p.fra),
           'cache_read_tokens', (select coalesce(sum(b.cache_read_tokens), 0) from public.bot_beskeder b where b.oprettet_kl > p.fra),
           'cache_write_tokens', (select coalesce(sum(b.cache_write_tokens), 0) from public.bot_beskeder b where b.oprettet_kl > p.fra),
           'pris_usd', (select coalesce(sum(b.pris_usd), 0) from public.bot_beskeder b where b.oprettet_kl > p.fra),
           'overdraget', (select count(*) from public.bot_samtaler s where s.overdraget_kl > p.fra)))
    from p;
$fn$;

revoke all on function public.bot_forbrug_oversigt() from public, anon, authenticated;
grant execute on function public.bot_forbrug_oversigt() to service_role;
