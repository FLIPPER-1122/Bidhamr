-- BidHamr-bot: rettelser efter reviewer (20261102240000_bidhamr_bot.sql).
--
-- Indhold:
--   1. bot_indstillinger: døgnloftet i USD (standard 2 USD) og døgnloftet for
--      samtaler uden login (standard 2.000 beskeder), så indloggede altid har
--      plads. Ændres med en update af den ene række. Kun service-role.
--   2. bot_samtaler: ip_hash må være null (nulstilles efter 7 dage), og
--      renset_kl markerer en samtale, hvis tekst er slettet (bot_rens).
--   3. bot_ny_besked(): USD-loft og loft uden login (begge giver 'loft_alle'),
--      en samtale uden login kan kun fortsættes fra samme ip_hash, og en
--      renset samtale kan ikke fortsættes. 'alarm' = true højst én gang i
--      døgnet, når USD-loftet rammes (serveren skriver så i /admin/drift).
--   4. bot_overdrag(): samme ip_hash-krav for samtaler uden login. Ny
--      signatur med p_ip_hash (default null - så den gamle serverkode
--      stadig virker for indloggede, indtil den nye kode er ude).
--   5. Kontosletning (konto_slet, soft delete): en trigger på
--      users.konto_slettet_kl sætter brugerens bot-beskeder til '[slettet]',
--      fjerner e-mailen på samtalerne og erstatter samtalen i henvendelser
--      fra botten med en pladsholder. Tokens, pris og model bevares.
--   6. bot_rens(): dagligt pg_cron-job 'bot-rens':
--      - ikke overdragne samtaler uden aktivitet i 90 dage: tekst '[slettet]',
--        e-mail, bruger_id og ip_hash fjernes;
--      - ip_hash nulstilles efter 7 dage;
--      - overdragne samtaler: 2 år efter overdragelsen (også kopien i
--        kontakt_henvendelser.besked).
--      Tokens, pris og model bevares (omkostningen og statistikken).
--   7. mine_data(): "Download dine data" får nøglen 'bidhamr_bot' (samtaler med
--      kilde, oprettet_kl, overdraget_kl og beskeder med rolle, tekst,
--      oprettet_kl - ikke tokens og pris). Flettes ind i den nuværende
--      definition (andre migrationer kan også udvide mine_data).
--
-- Idempotent: if not exists / create or replace / drop ... if exists /
-- cron.schedule med fast navn / mine_data rettes kun, hvis 'bidhamr_bot' mangler.
-- Ingen handelsdata ændres.

-- ============================================================ 1. Indstillinger

create table if not exists public.bot_indstillinger (
  id              boolean primary key default true,
  -- Summen af pris_usd for bottens svar det seneste døgn.
  doegnloft_usd   numeric(10, 2) not null default 2,
  -- Beskeder fra besøgende uden login det seneste døgn (alle IP'er samlet).
  doegnloft_anon  integer not null default 2000,
  -- Sidste drift-alarm om USD-loftet (højst én pr. døgn).
  usd_alarm_kl    timestamptz,
  opdateret_kl    timestamptz not null default now(),
  constraint bot_indstillinger_en_raekke check (id),
  constraint bot_indstillinger_vaerdier check (doegnloft_usd >= 0 and doegnloft_anon >= 0)
);

comment on table public.bot_indstillinger is
  'BidHamr-bot: døgnlofter (USD og beskeder uden login). Én række. Kun service-role. '
  'Ændres med: update public.bot_indstillinger set doegnloft_usd = 5;';

insert into public.bot_indstillinger (id) values (true) on conflict (id) do nothing;

alter table public.bot_indstillinger enable row level security;
revoke all on public.bot_indstillinger from public, anon, authenticated;
grant select, update on public.bot_indstillinger to service_role;

-- ============================================================ 2. Kolonner og indeks

alter table public.bot_samtaler alter column ip_hash drop not null;
alter table public.bot_samtaler add column if not exists renset_kl timestamptz;

comment on column public.bot_samtaler.ip_hash is
  'HMAC af IP-adressen (IPv6 som /64). Nulstilles efter 7 dage (bot_rens).';
comment on column public.bot_samtaler.renset_kl is
  'Sat, når samtalens tekst, e-mail og bruger er fjernet (bot_rens). Kan ikke fortsættes.';

-- Til bot_rens.
create index if not exists bot_samtaler_rens_aktiv_idx
  on public.bot_samtaler (opdateret_kl) where overdraget_kl is null and renset_kl is null;
create index if not exists bot_samtaler_rens_overdraget_idx
  on public.bot_samtaler (overdraget_kl) where overdraget_kl is not null and renset_kl is null;
create index if not exists bot_samtaler_ip_idx
  on public.bot_samtaler (opdateret_kl) where ip_hash is not null;
create index if not exists bot_beskeder_ip_rens_idx
  on public.bot_beskeder (oprettet_kl) where ip_hash is not null;
-- Til USD-loftet og loftet uden login.
create index if not exists bot_beskeder_bot_tid_idx
  on public.bot_beskeder (oprettet_kl) where rolle = 'bot';
create index if not exists bot_beskeder_anon_tid_idx
  on public.bot_beskeder (oprettet_kl) where rolle = 'bruger' and bruger_id is null;

-- ============================================================ 3. Loftet

-- Som i 20261102240000, plus:
--   - en samtale uden login kræver samme ip_hash, og en renset samtale kan
--     ikke fortsættes ('ukendt_samtale');
--   - loft for alle besøgende uden login samlet (bot_indstillinger.doegnloft_anon);
--   - loft over prisen det seneste døgn (bot_indstillinger.doegnloft_usd).
--     Rammes det, svares 'loft_alle' med grund 'usd', og 'alarm' er true
--     første gang i døgnet.
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
  v_tekst   text := btrim(coalesce(p_tekst, ''));
  v_id      uuid;
  v_usd     numeric;
  v_alarm   boolean := false;
  s         record;
  ind       record;
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

  select coalesce(i.doegnloft_usd, 2) as usd, coalesce(i.doegnloft_anon, 2000) as anon
    into ind
    from (select 1) x left join public.bot_indstillinger i on i.id;

  if v_samtale is not null then
    select t.bruger_id, t.ip_hash, t.renset_kl into s from public.bot_samtaler t where t.id = v_samtale;
    if not found
       or s.bruger_id is distinct from p_bruger
       or s.renset_kl is not null
       or (p_bruger is null and s.ip_hash is distinct from p_ip_hash) then
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

  -- Alle uden login samlet: indloggede har altid plads.
  if p_bruger is null then
    select count(*) into n from public.bot_beskeder b
     where b.rolle = 'bruger' and b.bruger_id is null and b.oprettet_kl > v_fra;
    if n >= ind.anon then
      return jsonb_build_object('kode', 'loft_alle', 'grund', 'anon');
    end if;
  end if;

  select count(*) into n from public.bot_beskeder b
   where b.rolle = 'bruger' and b.oprettet_kl > v_fra;
  if n >= c_maks_alle then
    return jsonb_build_object('kode', 'loft_alle', 'grund', 'antal');
  end if;

  -- Loftet over regningen.
  select coalesce(sum(b.pris_usd), 0) into v_usd from public.bot_beskeder b
   where b.rolle = 'bot' and b.oprettet_kl > v_fra;
  if v_usd >= ind.usd then
    update public.bot_indstillinger
       set usd_alarm_kl = now()
     where id and (usd_alarm_kl is null or usd_alarm_kl < now() - interval '24 hours');
    get diagnostics n = row_count;
    v_alarm := n > 0;
    return jsonb_build_object('kode', 'loft_alle', 'grund', 'usd', 'alarm', v_alarm,
                              'usd', round(v_usd, 4), 'loft_usd', ind.usd);
  end if;

  if v_samtale is null then
    insert into public.bot_samtaler (bruger_id, ip_hash, kilde)
    values (p_bruger, p_ip_hash, p_kilde)
    returning id into v_samtale;
  else
    update public.bot_samtaler set opdateret_kl = now(), ip_hash = p_ip_hash where id = v_samtale;
  end if;

  insert into public.bot_beskeder (samtale_id, rolle, tekst, bruger_id, ip_hash)
  values (v_samtale, 'bruger', v_tekst, p_bruger, p_ip_hash)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'samtale_id', v_samtale, 'besked_id', v_id);
end;
$fn$;

revoke all on function public.bot_ny_besked(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.bot_ny_besked(uuid, uuid, text, text, text) to service_role;

-- ============================================================ 4. Overdrag

-- Som i 20261102240000, plus p_ip_hash: en samtale uden login kan kun
-- overdrages fra samme ip_hash, og en renset samtale kan ikke overdrages.
drop function if exists public.bot_overdrag(uuid, uuid, text, text);

create or replace function public.bot_overdrag(
  p_samtale uuid,
  p_bruger  uuid,
  p_email   text,
  p_besked  text,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  s        record;
  v_email  text;
  v_besked text := left(btrim(coalesce(p_besked, '')), 4000);
  v_id     uuid;
  n        integer;
begin
  select t.bruger_id, t.ip_hash, t.renset_kl into s from public.bot_samtaler t where t.id = p_samtale;
  if not found
     or s.bruger_id is distinct from p_bruger
     or s.renset_kl is not null
     or (p_bruger is null and (p_ip_hash is null or s.ip_hash is distinct from p_ip_hash)) then
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

revoke all on function public.bot_overdrag(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.bot_overdrag(uuid, uuid, text, text, text) to service_role;

-- ============================================================ 5. Kontosletning

-- konto_slet (20261007031000 m.fl.) er en soft delete: users-rækken bliver
-- stående med konto_slettet_kl. Triggeren rydder brugerens bot-samtaler i
-- samme transaktion. Tokens, pris og model bevares.
create or replace function public.bot_ved_kontosletning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.bot_beskeder b
     set tekst = '[slettet]'
    from public.bot_samtaler s
   where b.samtale_id = s.id
     and s.bruger_id = new.id
     and b.tekst <> '[slettet]';

  update public.kontakt_henvendelser k
     set besked = '[Samtalen med BidHamr-bot er slettet, fordi brugeren har slettet sin konto.]'
    from public.bot_samtaler s
   where k.bot_samtale_id = s.id
     and s.bruger_id = new.id
     and k.besked not like '[Samtalen med BidHamr-bot er slettet%';

  update public.bot_samtaler
     set email = null
   where bruger_id = new.id and email is not null;

  return new;
end;
$fn$;

revoke all on function public.bot_ved_kontosletning() from public, anon, authenticated;

drop trigger if exists users_bot_ved_sletning on public.users;
create trigger users_bot_ved_sletning
  after update of konto_slettet_kl on public.users
  for each row
  when (old.konto_slettet_kl is null and new.konto_slettet_kl is not null)
  execute function public.bot_ved_kontosletning();

-- ============================================================ 6. Daglig rensning

-- Højst 5.000 samtaler pr. slags pr. kørsel (resten tages næste dag).
-- Kun service-role/pg_cron.
create or replace function public.bot_rens()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_aktive      uuid[];
  v_overdragne  uuid[];
  v_alle        uuid[];
  n_beskeder    integer;
  n_henv        integer;
  n_ip_samtaler integer;
  n_ip_beskeder integer;
begin
  -- Ikke overdragne samtaler uden aktivitet i 90 dage.
  select coalesce(array_agg(x.id), '{}') into v_aktive from (
    select t.id from public.bot_samtaler t
     where t.overdraget_kl is null and t.renset_kl is null
       and t.opdateret_kl < now() - interval '90 days'
     order by t.opdateret_kl
     limit 5000
       for update skip locked) x;

  -- Overdragne samtaler: 2 år efter overdragelsen.
  select coalesce(array_agg(x.id), '{}') into v_overdragne from (
    select t.id from public.bot_samtaler t
     where t.overdraget_kl is not null and t.renset_kl is null
       and t.overdraget_kl < now() - interval '2 years'
     order by t.overdraget_kl
     limit 5000
       for update skip locked) x;

  v_alle := v_aktive || v_overdragne;

  update public.bot_samtaler
     set email = null, bruger_id = null, ip_hash = null, renset_kl = now()
   where id = any (v_alle);

  update public.bot_beskeder
     set tekst = '[slettet]', bruger_id = null, ip_hash = null
   where samtale_id = any (v_alle)
     and (tekst <> '[slettet]' or bruger_id is not null or ip_hash is not null);
  get diagnostics n_beskeder = row_count;

  update public.kontakt_henvendelser
     set besked = '[Samtalen med BidHamr-bot er slettet 2 år efter, at den blev sendt til en medarbejder.]'
   where bot_samtale_id = any (v_overdragne)
     and besked not like '[Samtalen med BidHamr-bot er slettet%';
  get diagnostics n_henv = row_count;

  -- ip_hash bruges kun til loftet (et døgn) og til at fortsætte en samtale
  -- uden login. Nulstilles efter 7 dage.
  update public.bot_samtaler
     set ip_hash = null
   where ip_hash is not null and opdateret_kl < now() - interval '7 days';
  get diagnostics n_ip_samtaler = row_count;

  update public.bot_beskeder
     set ip_hash = null
   where ip_hash is not null and oprettet_kl < now() - interval '7 days';
  get diagnostics n_ip_beskeder = row_count;

  return jsonb_build_object(
    'samtaler_90_dage', coalesce(array_length(v_aktive, 1), 0),
    'samtaler_2_aar', coalesce(array_length(v_overdragne, 1), 0),
    'beskeder', n_beskeder,
    'henvendelser', n_henv,
    'ip_samtaler', n_ip_samtaler,
    'ip_beskeder', n_ip_beskeder);
end;
$fn$;

revoke all on function public.bot_rens() from public, anon, authenticated;
grant execute on function public.bot_rens() to service_role;

-- Dagligt kl. 03:53 (UTC). Idempotent: et eksisterende job fjernes først.
-- Kun hvor pg_cron findes.
do $do$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron findes ikke - jobbet bot-rens oprettes ikke';
    return;
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'bot-rens';
  perform cron.schedule('bot-rens', '53 3 * * *', 'select public.bot_rens();');
end $do$;

-- ============================================================ 7. mine_data

-- Brugerens egne samtaler med BidHamr-bot til "Download dine data". Ikke
-- tokens, pris, model, ip_hash eller e-mail (e-mailen findes kun på samtaler
-- uden login). Kaldes kun af mine_data (security definer, ejer postgres).
create or replace function public.mine_data_bot(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'kilde', s.kilde,
           'oprettet_kl', s.oprettet_kl,
           'overdraget_kl', s.overdraget_kl,
           'beskeder', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'rolle', b.rolle,
                      'tekst', b.tekst,
                      'oprettet_kl', b.oprettet_kl) order by b.oprettet_kl)
               from public.bot_beskeder b where b.samtale_id = s.id), '[]'::jsonb))
           order by s.oprettet_kl), '[]'::jsonb)
    from public.bot_samtaler s
   where p_uid is not null and s.bruger_id = p_uid;
$fn$;

revoke all on function public.mine_data_bot(uuid) from public, anon, authenticated, service_role;

-- Flettes ind i den NUVÆRENDE mine_data (20261014010000_dac7.sql, rettet i
-- 20261016020000_erhverv_klager.sql; andre migrationer, fx henvisninger,
-- kan også have udvidet den) lige efter "v := public.mine_data_grund()".
-- Allerede med: intet sker.
create or replace function pg_temp.bot_flet_mine_data()
returns void language plpgsql as $$
declare
  v_def text := replace(pg_get_functiondef('public.mine_data()'::regprocedure), E'\r\n', E'\n');
  v_gl  text := E'  v := public.mine_data_grund()';
  v_n   integer;
begin
  if position('public.mine_data_bot(' in v_def) > 0 then
    return;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
  if v_n <> 1 then
    raise exception 'mine_data: "%" fundet % gange (skal være 1) - flet bot ind manuelt', v_gl, v_n;
  end if;
  execute replace(v_def, v_gl,
    v_gl || E'\n       || jsonb_build_object(''bidhamr_bot'', public.mine_data_bot(v_uid))');
end $$;

select pg_temp.bot_flet_mine_data();

do $$
begin
  if position('public.mine_data_bot(v_uid)' in pg_get_functiondef('public.mine_data()'::regprocedure)) = 0 then
    raise exception 'mine_data mangler bot-data efter fletningen';
  end if;
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;
