-- Drift-alarmer: besked til Filip, naar noget gaar galt (fase 6).
--
-- Ruten /api/cron/drift-alarm kaldes hvert 5. minut af pg_cron (jobbet
-- 'drift-alarm' nedenfor). Den kalder drift_alarm_vurder(), som finder:
--   ny_fejl     en ny slags fejl i drift_fejl (kilde+besked ikke set de
--               seneste 30 dage). Cron- og webhook-fejl har egne slags.
--   mange_fejl  over 20 fejl (inkl. gentagelser) paa 15 minutter
--   cron        betalings-cron fejlede/haenger/holdt op, et pg_cron-job
--               fejlede, et pg_net-kald fik fejl, eller cron-fejl i drift_fejl
--   webhook     webhook-fejl i drift_fejl
-- og sender een samlet mail (til DRIFT_ALARM_MAIL). Hoejst een mail pr.
-- slags pr. 30 minutter. Haendelser, der er udloest men undertrykt, tages
-- med i naeste mail, naar de 30 minutter er gaaet.
--
--   A. drift_fejl_minut     taeller pr. minut (ogsaa gentagelser og droppede),
--                           saa "mange fejl" kan maales. Kun tal.
--   B. drift_fejl_log()     uaendret logik + taelleren. search_path = ''.
--   C. drift_alarmer        status pr. slags (hvornaar sidst sendt m.m.)
--      drift_alarm_tilstand een raekke: sidste tjek og resultat
--   D. drift_alarm_vurder() / drift_alarm_mail_fejlet()
--   E. pg_cron-job 'drift-alarm'
--
-- Ingen persondata: kun kilde, sti og den allerede rensede fejltekst
-- (src/lib/drift.ts). Alle tabeller: RLS uden policies, kun service_role.
-- Idempotent: kan koeres flere gange.

-- ============================================================ A. minut-taeller

create table if not exists public.drift_fejl_minut (
  minut timestamptz primary key,
  antal integer not null default 0 check (antal >= 0)
);

alter table public.drift_fejl_minut enable row level security;
revoke all on public.drift_fejl_minut from public, anon, authenticated;
grant select, insert, update, delete on public.drift_fejl_minut to service_role;

-- ============================================================ B. drift_fejl_log

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

-- ============================================================ C. tabeller

create table if not exists public.drift_alarmer (
  slags            text primary key,
  -- Haendelser til og med dette tidspunkt er meldt (eller ikke relevante).
  daekket_til      timestamptz not null default now(),
  sidst_sendt_kl   timestamptz,
  antal_sendt      integer not null default 0,
  -- Sidst betingelsen var opfyldt (ogsaa hvis mailen blev undertrykt).
  sidst_udloest_kl timestamptz,
  -- sendt | undertrykt | ingen_modtager | mail_fejlet
  sidste_resultat  text,
  constraint drift_alarmer_slags check (slags in ('ny_fejl', 'mange_fejl', 'cron', 'webhook')),
  constraint drift_alarmer_resultat check (
    sidste_resultat is null
    or sidste_resultat in ('sendt', 'undertrykt', 'ingen_modtager', 'mail_fejlet'))
);

alter table public.drift_alarmer enable row level security;
revoke all on public.drift_alarmer from public, anon, authenticated;
grant select on public.drift_alarmer to service_role;

-- Start: intet gammelt meldes (daekket_til = nu).
insert into public.drift_alarmer (slags)
values ('ny_fejl'), ('mange_fejl'), ('cron'), ('webhook')
on conflict (slags) do nothing;

create table if not exists public.drift_alarm_tilstand (
  id               boolean primary key default true check (id),
  sidst_tjekket_kl timestamptz,
  -- ingen | sendt | ingen_modtager | mail_fejlet | undertrykt
  sidste_resultat  text,
  sidste_fejl      text,
  constraint drift_alarm_tilstand_fejl_laengde check (sidste_fejl is null or char_length(sidste_fejl) <= 500)
);

alter table public.drift_alarm_tilstand enable row level security;
revoke all on public.drift_alarm_tilstand from public, anon, authenticated;
grant select on public.drift_alarm_tilstand to service_role;

insert into public.drift_alarm_tilstand (id) values (true) on conflict (id) do nothing;

-- ============================================================ D. funktioner

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
  -- Samme laas som drift_fejl_log: alle fejl, der er logget foer dette
  -- kald, er committet, naar vi laeser.
  perform pg_advisory_xact_lock(hashtext('public.drift_fejl_log'));
  perform pg_advisory_xact_lock(hashtext('public.drift_alarm_vurder'));

  delete from public.drift_fejl_minut where minut < v_nu - interval '2 days';

  for r in select a.* from public.drift_alarmer a order by a.slags for update loop
    v_punkter := '[]'::jsonb;
    v_antal := 0;

    if r.slags = 'ny_fejl' then
      select count(*),
             coalesce(jsonb_agg(p order by p.oprettet_kl) filter (where p.nr <= 10), '[]'::jsonb)
        into v_antal, v_punkter
        from (
          select f.kilde, f.sti, left(f.besked, 300) as besked, f.antal, f.oprettet_kl,
                 row_number() over (order by f.id) as nr
            from public.drift_fejl f
           where f.oprettet_kl > r.daekket_til
             and f.oprettet_kl <= v_nu
             and f.kilde not in ('cron', 'webhook')
             and not exists (
                   select 1 from public.drift_fejl g
                    where g.id < f.id
                      and g.kilde = f.kilde
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
            select f.kilde, f.sti, left(f.besked, 300) as besked, f.antal, f.senest_kl
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
             and f.senest_kl <= v_nu) p;

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
             and f.senest_kl <= v_nu) p;

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
           where (k.ok is false and k.afsluttet_kl > r.daekket_til and k.afsluttet_kl <= v_nu)
              or (k.afsluttet_kl is null
                  and k.startet_kl + interval '10 minutes' > r.daekket_til
                  and k.startet_kl + interval '10 minutes' <= v_nu)) p;
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
         and v_sidst_ok + interval '20 minutes' <= v_nu then
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
        $q$ into v_ekstra using r.daekket_til, v_nu;
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
                      or h.status_code not between 200 and 299)) p
        $q$ into v_ekstra using r.daekket_til, v_nu;
        v_antal := v_antal + (v_ekstra->>'antal')::bigint;
        v_punkter := v_punkter || (v_ekstra->'punkter');
      end if;
    end if;

    if v_antal = 0 then
      -- Intet nyt: flyt vinduet frem.
      update public.drift_alarmer set daekket_til = v_nu where slags = r.slags;
    elsif r.sidst_sendt_kl is not null and r.sidst_sendt_kl > v_nu - v_kort_frist then
      -- Udloest, men der er sendt for nylig: tages med senere.
      update public.drift_alarmer
         set sidst_udloest_kl = v_nu, sidste_resultat = 'undertrykt'
       where slags = r.slags;
      v_undertrykt := v_undertrykt || to_jsonb(r.slags);
    elsif p_kan_sende then
      update public.drift_alarmer
         set daekket_til = v_nu,
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
         set daekket_til = v_nu, sidst_udloest_kl = v_nu, sidste_resultat = 'ingen_modtager'
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

-- Mailen kunne ikke sendes: rul markeringen tilbage, saa alarmen proeves
-- igen ved naeste koersel. p_tidspunkt er "tidspunkt" fra drift_alarm_vurder;
-- kun raekker, der stadig er markeret af netop det kald, roeres.
create or replace function public.drift_alarm_mail_fejlet(
  p_tidspunkt timestamptz,
  p_alarmer jsonb,
  p_fejl text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_a jsonb;
begin
  if jsonb_typeof(p_alarmer) = 'array' then
    for v_a in select * from jsonb_array_elements(p_alarmer) loop
      update public.drift_alarmer
         set daekket_til = coalesce((v_a->>'forrige_daekket_til')::timestamptz, daekket_til),
             sidst_sendt_kl = (v_a->>'forrige_sendt_kl')::timestamptz,
             antal_sendt = greatest(antal_sendt - 1, 0),
             sidste_resultat = 'mail_fejlet'
       where slags = v_a->>'slags'
         and sidst_sendt_kl = p_tidspunkt;
    end loop;
  end if;

  update public.drift_alarm_tilstand
     set sidste_resultat = 'mail_fejlet', sidste_fejl = left(p_fejl, 500)
   where id;
end;
$fn$;

revoke all on function public.drift_alarm_mail_fejlet(timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.drift_alarm_mail_fejlet(timestamptz, jsonb, text) to service_role;

-- ============================================================ E. pg_cron

-- Kalder /api/cron/drift-alarm. URL og hemmelighed staar i Supabase Vault -
-- ALDRIG i denne fil:
--   drift_alarm_url  (valgfri) fx https://bidhamr.dk/api/cron/drift-alarm.
--                    Mangler den, bruges cron_url med sidste del af stien
--                    skiftet ud: .../api/cron/afslut-auktioner -> .../api/cron/drift-alarm
--   cron_secret      samme som til betalings-cron (CRON_SECRET i Vercel)
-- Ikke konfigureret (fx testdatabasen): springes stille over.
create or replace function public.kald_drift_alarm()
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_url    text;
  v_secret text;
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

  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 30000);
end;
$fn$;

revoke all on function public.kald_drift_alarm() from public, anon, authenticated;

select cron.unschedule('drift-alarm')
 where exists (select 1 from cron.job where jobname = 'drift-alarm');

-- Minut 2, 7, 12 ... - lige efter betalings-cron (minut 0, 5, 10 ...).
select cron.schedule(
  'drift-alarm',
  '2-59/5 * * * *',
  $$select public.kald_drift_alarm();$$
);
