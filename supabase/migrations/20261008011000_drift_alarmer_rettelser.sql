-- Rettelser til 20261008010000_drift_alarmer.sql efter review (fase 6).
--
-- 010000 er rettet direkte (koeres endnu ikke i produktion), men var allerede
-- koert paa testdatabasen. Denne fil bringer en database, der har koert den
-- gamle 010000, frem til samme slutresultat. Idempotent: kan koeres flere
-- gange og efter den rettede 010000 uden at aendre noget.
--
--   1. drift_fejl_log: lock_timeout 2s / statement_timeout 3s, saa logningen
--      fejler stille i stedet for at haenge.
--      drift_alarm_vurder tager IKKE laengere drift_fejl_log's advisory-laas;
--      i stedet ses kun haendelser til og med 10 sekunder siden (v_graense),
--      saa fejl, der logges samtidig, ikke gaar tabt.
--      Nyt indeks drift_fejl (kilde, md5(besked), id) til "ny slags fejl".
--   2. Browser-fejl (kilde klient): tekst og sti sendes ikke med i alarmen,
--      kun antal (mailen henviser til /admin/drift).
--   5. service_role maa opdatere drift_alarm_tilstand.sidste_resultat /
--      sidste_fejl (appen noterer, hvis tilbagerulningen fejler).
--   6. Drift-alarmens egne pg_net-kald (drift_alarm_kald) udloeser ikke
--      cron-alarmen (fx timeout, mens mailen sendes).
--   7. helbred_ping() til /api/helbred med anon-noeglen.

-- ============================================================ 1. logning

-- Samme logik som i 20261005060000_admin_drift.sql. Nyt: hvert kald med
-- gyldig kilde taeller i drift_fejl_minut (ny, dublet og begraenset).
create or replace function public.drift_fejl_log(
  p_kilde text,
  p_sti text,
  p_besked text,
  p_digest text default null,
  p_bruger_id uuid default null)
returns text
language plpgsql
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '3s'
as $fn$
declare
  v_kilde  text := left(coalesce(p_kilde, ''), 20);
  v_sti    text := nullif(left(btrim(coalesce(p_sti, '')), 300), '');
  v_besked text := left(coalesce(nullif(btrim(p_besked), ''), '(ingen besked)'), 1000);
  v_digest text := nullif(left(btrim(coalesce(p_digest, '')), 100), '');
  v_klient boolean := v_kilde = 'klient';
  v_id     bigint;
  v_antal  integer;
begin
  if v_kilde not in ('klient', 'server', 'action', 'cron', 'webhook', 'notifikation') then
    return 'ugyldig';
  end if;

  -- Serialiserer kaldene, saa dedup og loft holder ved samtidige fejl.
  perform pg_advisory_xact_lock(hashtext('public.drift_fejl_log'));

  insert into public.drift_fejl_minut as m (minut, antal)
  values (date_trunc('minute', now()), 1)
  on conflict (minut) do update set antal = least(m.antal, 2147483646) + 1;

  if v_digest is not null then
    select f.id into v_id
      from public.drift_fejl f
     where f.digest = v_digest
       and f.senest_kl > now() - interval '24 hours'
     order by f.senest_kl desc
     limit 1;
  else
    select f.id into v_id
      from public.drift_fejl f
     where f.kilde = v_kilde
       and f.sti is not distinct from v_sti
       and f.besked = v_besked
       and f.bruger_id is not distinct from p_bruger_id
       and f.digest is null
       and f.senest_kl > now() - interval '1 hour'
     order by f.senest_kl desc
     limit 1;
  end if;

  if v_id is not null then
    update public.drift_fejl
       set antal = least(antal, 2147483646) + 1,
           senest_kl = now()
     where id = v_id;
    return 'dublet';
  end if;

  select count(*) into v_antal
    from public.drift_fejl f
   where f.oprettet_kl > now() - interval '1 minute'
     and (f.kilde = 'klient') = v_klient;
  if v_antal >= (case when v_klient then 30 else 120 end) then
    return 'begraenset';
  end if;

  insert into public.drift_fejl (kilde, sti, besked, digest, bruger_id)
  values (
    v_kilde, v_sti, v_besked, v_digest,
    -- En ukendt bruger (fx slettet auth-bruger) maa ikke vaelte logningen.
    (select u.id from public.users u where u.id = p_bruger_id));
  return 'ny';
end;
$fn$;

revoke all on function public.drift_fejl_log(text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.drift_fejl_log(text, text, text, text, uuid) to service_role;

-- "Ny slags fejl" (drift_alarm_vurder) slaar op paa kilde + md5(besked).
create index if not exists drift_fejl_kilde_besked_md5_idx
  on public.drift_fejl (kilde, md5(besked), id);

-- ============================================================ 5. tilstand

-- Appen noterer selv, hvis tilbagerulningen efter en fejlet mail fejler.
grant update (sidste_resultat, sidste_fejl) on public.drift_alarm_tilstand to service_role;

-- ============================================================ 6. egne kald

-- Request-id'er fra kald_drift_alarm(). Alarmens egne pg_net-kald (fx
-- timeout mens mailen sendes) maa ikke selv udloese en cron-alarm.
create table if not exists public.drift_alarm_kald (
  request_id  bigint primary key,
  oprettet_kl timestamptz not null default now()
);

alter table public.drift_alarm_kald enable row level security;
revoke all on public.drift_alarm_kald from public, anon, authenticated;
grant select on public.drift_alarm_kald to service_role;

-- ============================================================ 1+2+6. vurdering

-- Finder hvad der skal meldes, og markerer det atomisk (to samtidige kald
-- kan ikke sende samme alarm). p_kan_sende = false (ingen modtager sat):
-- intet markeres som sendt, men haendelserne regnes for set, saa der ikke
-- kommer en stor bunke, naar modtageren saettes.
--
-- Returnerer:
--   {"send": [{"slags", "antal", "punkter": [...], "forrige_daekket_til",
--              "forrige_sendt_kl"}],
--    "undertrykt": ["slags", ...], "tidspunkt": "..."}
-- security definer: laeser cron.job_run_details og net._http_response.
create or replace function public.drift_alarm_vurder(p_kan_sende boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_nu         timestamptz := now();
  -- Haendelser ses kun til og med 10 sekunder siden (se nedenfor).
  v_graense    timestamptz := now() - interval '10 seconds';
  v_kort_frist constant interval := interval '30 minutes';
  r            record;
  v_punkter    jsonb;
  v_antal      bigint;
  v_ekstra     jsonb;
  v_send       jsonb := '[]'::jsonb;
  v_undertrykt jsonb := '[]'::jsonb;
  v_sidst_ok   timestamptz;
  v_resultat   text;
begin
  -- Tager IKKE drift_fejl_log's laas: logningen maa aldrig vente paa
  -- alarmen. I stedet ses kun haendelser til og med v_graense (10 sek.
  -- siden), saa en fejl, der logges samtidig, er committet, foer dens
  -- tidspunkt kommer med i et vindue - den tages med i naeste koersel i
  -- stedet for at gaa tabt.
  perform pg_advisory_xact_lock(hashtext('public.drift_alarm_vurder'));

  delete from public.drift_fejl_minut where minut < v_nu - interval '2 days';
  delete from public.drift_alarm_kald where oprettet_kl < v_nu - interval '2 days';

  for r in select a.* from public.drift_alarmer a order by a.slags for update loop
    v_punkter := '[]'::jsonb;
    v_antal := 0;

    if r.slags = 'ny_fejl' then
      select count(*),
             coalesce(jsonb_agg(p order by p.oprettet_kl) filter (where p.nr <= 10), '[]'::jsonb)
        into v_antal, v_punkter
        from (
          -- Browser-fejl (kilde klient) er indsendt af brugere: kun antal
          -- i mailen, aldrig tekst eller sti.
          select f.kilde,
                 case when f.kilde = 'klient' then null else f.sti end as sti,
                 case when f.kilde = 'klient' then null else left(f.besked, 300) end as besked,
                 f.antal, f.oprettet_kl,
                 row_number() over (order by f.id) as nr
            from public.drift_fejl f
           where f.oprettet_kl > r.daekket_til
             and f.oprettet_kl <= v_graense
             and f.kilde not in ('cron', 'webhook')
             and not exists (
                   select 1 from public.drift_fejl g
                    where g.id < f.id
                      and g.kilde = f.kilde
                      and md5(g.besked) = md5(f.besked)
                      and g.besked = f.besked
                      and g.oprettet_kl > f.oprettet_kl - interval '30 days')) p;

    elsif r.slags = 'mange_fejl' then
      -- Tilstand, ikke haendelse: maales altid over de seneste 15 minutter.
      select coalesce(sum(m.antal), 0) into v_antal
        from public.drift_fejl_minut m
       where m.minut > v_nu - interval '15 minutes';
      if v_antal > 20 then
        select coalesce(jsonb_agg(p order by p.antal desc), '[]'::jsonb) into v_punkter
          from (
            select f.kilde,
                   case when f.kilde = 'klient' then null else f.sti end as sti,
                   case when f.kilde = 'klient' then null else left(f.besked, 300) end as besked,
                   f.antal, f.senest_kl
              from public.drift_fejl f
             where f.senest_kl > v_nu - interval '15 minutes'
             order by f.antal desc
             limit 5) p;
      else
        v_antal := 0;
      end if;

    elsif r.slags = 'webhook' then
      select count(*),
             coalesce(jsonb_agg(p order by p.senest_kl) filter (where p.nr <= 10), '[]'::jsonb)
        into v_antal, v_punkter
        from (
          select f.kilde, f.sti, left(f.besked, 300) as besked, f.antal, f.senest_kl,
                 row_number() over (order by f.senest_kl desc) as nr
            from public.drift_fejl f
           where f.kilde = 'webhook'
             and f.senest_kl > r.daekket_til
             and f.senest_kl <= v_graense) p;

    elsif r.slags = 'cron' then
      -- 1) cron-fejl i drift_fejl
      select count(*),
             coalesce(jsonb_agg(p order by p.senest_kl) filter (where p.nr <= 5), '[]'::jsonb)
        into v_antal, v_punkter
        from (
          select 'Cron-fejl' as type, f.sti, left(f.besked, 300) as besked, f.antal, f.senest_kl,
                 row_number() over (order by f.senest_kl desc) as nr
            from public.drift_fejl f
           where f.kilde = 'cron'
             and f.senest_kl > r.daekket_til
             and f.senest_kl <= v_graense) p;

      -- 2) betalings-cron fejlede eller haenger (ikke afsluttet efter 10 min)
      select jsonb_build_object(
               'antal', count(*),
               'punkter', coalesce(jsonb_agg(p order by p.startet_kl) filter (where p.nr <= 5), '[]'::jsonb))
        into v_ekstra
        from (
          select case when k.ok is false then 'Cron-kørsel fejlede' else 'Cron-kørsel blev ikke færdig' end as type,
                 k.job as sti, left(coalesce(k.fejl, ''), 300) as besked, k.startet_kl,
                 row_number() over (order by k.startet_kl desc) as nr
            from public.drift_cron_koersler k
           where (k.ok is false and k.afsluttet_kl > r.daekket_til and k.afsluttet_kl <= v_graense)
              or (k.afsluttet_kl is null
                  and k.startet_kl + interval '10 minutes' > r.daekket_til
                  and k.startet_kl + interval '10 minutes' <= v_graense)) p;
      v_antal := v_antal + (v_ekstra->>'antal')::bigint;
      v_punkter := v_punkter || (v_ekstra->'punkter');

      -- 3) betalings-cron er holdt op: ingen vellykket koersel i 20 minutter.
      --    Meldes een gang pr. udfald (naar de 20 minutter passeres), ikke
      --    hver halve time. Aldrig koert = ikke sat op (fx testdatabasen).
      select max(k.startet_kl) into v_sidst_ok
        from public.drift_cron_koersler k
       where k.job = 'betalings-cron' and k.ok;
      if v_sidst_ok is not null
         and v_sidst_ok + interval '20 minutes' > r.daekket_til
         and v_sidst_ok + interval '20 minutes' <= v_graense then
        v_antal := v_antal + 1;
        v_punkter := v_punkter || jsonb_build_array(jsonb_build_object(
          'type', 'Cron er holdt op',
          'sti', 'betalings-cron',
          'besked', 'Ingen vellykket kørsel i over 20 minutter',
          'startet_kl', v_sidst_ok));
      end if;

      -- 4) pg_cron-jobs, der fejlede
      if to_regclass('cron.job_run_details') is not null and to_regclass('cron.job') is not null then
        execute $q$
          select jsonb_build_object(
                   'antal', count(*),
                   'punkter', coalesce(jsonb_agg(p order by p.startet_kl) filter (where p.nr <= 5), '[]'::jsonb))
            from (
              select 'pg_cron-job fejlede' as type, j.jobname::text as sti,
                     left(coalesce(d.return_message, ''), 300) as besked, d.start_time as startet_kl,
                     row_number() over (order by d.runid desc) as nr
                from cron.job_run_details d
                left join cron.job j on j.jobid = d.jobid
               where d.status = 'failed'
                 and coalesce(d.end_time, d.start_time) > $1
                 and coalesce(d.end_time, d.start_time) <= $2) p
        $q$ into v_ekstra using r.daekket_til, v_graense;
        v_antal := v_antal + (v_ekstra->>'antal')::bigint;
        v_punkter := v_punkter || (v_ekstra->'punkter');
      end if;

      -- 5) pg_net-kald (cron-ruterne) med fejl, timeout eller ikke-2xx
      if to_regclass('net._http_response') is not null then
        execute $q$
          select jsonb_build_object(
                   'antal', count(*),
                   'punkter', coalesce(jsonb_agg(p order by p.startet_kl) filter (where p.nr <= 5), '[]'::jsonb))
            from (
              select 'Kald til cron-rute fejlede' as type, null::text as sti,
                     case when h.timed_out then 'Timeout'
                          when h.error_msg is not null then left(h.error_msg, 200)
                          else 'HTTP ' || coalesce(h.status_code::text, '?') end as besked,
                     h.created as startet_kl,
                     row_number() over (order by h.id desc) as nr
                from net._http_response h
               where h.created > $1
                 and h.created <= $2
                 and (coalesce(h.timed_out, false)
                      or h.error_msg is not null
                      or h.status_code is null
                      or h.status_code not between 200 and 299)
                 -- Drift-alarmens egne kald taeller ikke med.
                 and not exists (select 1 from public.drift_alarm_kald k
                                  where k.request_id = h.id)) p
        $q$ into v_ekstra using r.daekket_til, v_graense;
        v_antal := v_antal + (v_ekstra->>'antal')::bigint;
        v_punkter := v_punkter || (v_ekstra->'punkter');
      end if;
    end if;

    if v_antal = 0 then
      -- Intet nyt: flyt vinduet frem.
      update public.drift_alarmer set daekket_til = v_graense where slags = r.slags;
    elsif r.sidst_sendt_kl is not null and r.sidst_sendt_kl > v_nu - v_kort_frist then
      -- Udloest, men der er sendt for nylig: tages med senere.
      update public.drift_alarmer
         set sidst_udloest_kl = v_nu, sidste_resultat = 'undertrykt'
       where slags = r.slags;
      v_undertrykt := v_undertrykt || to_jsonb(r.slags);
    elsif p_kan_sende then
      update public.drift_alarmer
         set daekket_til = v_graense,
             sidst_sendt_kl = v_nu,
             antal_sendt = least(antal_sendt, 2147483646) + 1,
             sidst_udloest_kl = v_nu,
             sidste_resultat = 'sendt'
       where slags = r.slags;
      v_send := v_send || jsonb_build_array(jsonb_build_object(
        'slags', r.slags,
        'antal', v_antal,
        'punkter', v_punkter,
        'forrige_daekket_til', r.daekket_til,
        'forrige_sendt_kl', r.sidst_sendt_kl));
    else
      update public.drift_alarmer
         set daekket_til = v_graense, sidst_udloest_kl = v_nu, sidste_resultat = 'ingen_modtager'
       where slags = r.slags;
      v_send := v_send || jsonb_build_array(jsonb_build_object('slags', r.slags, 'antal', v_antal));
    end if;
  end loop;

  v_resultat := case
    when jsonb_array_length(v_send) > 0 then case when p_kan_sende then 'sendt' else 'ingen_modtager' end
    when jsonb_array_length(v_undertrykt) > 0 then 'undertrykt'
    else 'ingen' end;

  update public.drift_alarm_tilstand
     set sidst_tjekket_kl = v_nu, sidste_resultat = v_resultat, sidste_fejl = null
   where id;

  return jsonb_build_object('send', v_send, 'undertrykt', v_undertrykt, 'tidspunkt', v_nu);
end;
$fn$;

revoke all on function public.drift_alarm_vurder(boolean) from public, anon, authenticated;
grant execute on function public.drift_alarm_vurder(boolean) to service_role;

-- ============================================================ 6. kald_drift_alarm

create or replace function public.kald_drift_alarm()
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_url    text;
  v_secret text;
  v_id     bigint;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;

  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'drift_alarm_url' limit 1$q$
     into v_url;
  if coalesce(v_url, '') = '' then
    execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_url' limit 1$q$
       into v_url;
    if v_url !~ '/api/cron/[A-Za-z0-9_-]+/?$' then
      return null;
    end if;
    v_url := regexp_replace(v_url, '/api/cron/[A-Za-z0-9_-]+/?$', '/api/cron/drift-alarm');
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1$q$
     into v_secret;

  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return null;
  end if;

  v_id := net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 30000);
  -- Huskes, saa drift_alarm_vurder ikke melder alarmens eget kald.
  if v_id is not null then
    insert into public.drift_alarm_kald (request_id) values (v_id)
    on conflict (request_id) do nothing;
  end if;
  return v_id;
end;
$fn$;

revoke all on function public.kald_drift_alarm() from public, anon, authenticated;

-- ============================================================ 7. sundhedstjek

-- /api/helbred kalder denne med anon-noeglen (ikke service_role): et billigt
-- tjek af, at PostgREST og databasen svarer. Returnerer altid true og laeser
-- intet - aabner ikke for noget.
create or replace function public.helbred_ping()
returns boolean
language sql
stable
set search_path = ''
as $fn$ select true $fn$;

revoke all on function public.helbred_ping() from public;
grant execute on function public.helbred_ping() to anon, service_role;
