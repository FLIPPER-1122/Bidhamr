-- Admin: Drift (/admin/drift, admin og chef). Fase 1B.
--
--   A. drift_cron_koersler   - en raekke pr. koersel af vores cron-rute
--                              (/api/cron/afslut-auktioner). Skrives af ruten
--                              i en try/finally, saa ogsaa fejl logges.
--   B. drift_fejl            - simpel fejllog: fejl paa siden (error
--                              boundaries), serverfejl (instrumentation
--                              onRequestError) og udvalgte catch-blokke i
--                              betaling/sager/cron/webhook. Dedup pr. digest
--                              og loft over nye raekker pr. minut.
--   C. notifikation_afsendelser faar status pr. afsendelse, saa claimede
--                              men ikke sendte og fejlede notifikationer kan
--                              ses. Kun raekker claimet af send() faar status;
--                              andre (fx markerBudBehandlet, beskeder) er null.
--   D. admin_cron_status()   - status for pg_cron-jobs uden at give adgang
--                              til cron-skemaet. admin_cron_http_svar() -
--                              pg_net-svar paa kald til cron-ruten.
--
-- Alle tabeller: RLS slaaet til uden policies, kun service_role. Ingen
-- personfoelsomme data og ingen hemmeligheder: fejltekster renses i
-- serverkoden (src/lib/drift.ts), og stier gemmes uden query-streng.
-- Data slettes IKKE automatisk i denne omgang.
--
-- Idempotent: kan koeres flere gange.

-- ============================================================ A. cron-koersler

create table if not exists public.drift_cron_koersler (
  id           bigint generated always as identity primary key,
  job          text not null default 'betalings-cron',
  -- 'POST' = pg_cron/pg_net eller manuelt kald, 'GET' = Vercel Cron.
  metode       text,
  startet_kl   timestamptz not null default now(),
  afsluttet_kl timestamptz,
  -- null = koerer stadig eller blev afbrudt (fx timeout) foer finally.
  ok           boolean,
  fejl         text,
  -- Kort resume (taellere), aldrig persondata.
  resultat     jsonb,
  constraint drift_cron_koersler_fejl_laengde check (fejl is null or char_length(fejl) <= 1000),
  constraint drift_cron_koersler_job_laengde check (char_length(job) <= 100)
);

create index if not exists drift_cron_koersler_startet_idx
  on public.drift_cron_koersler (job, startet_kl desc);
create index if not exists drift_cron_koersler_ok_idx
  on public.drift_cron_koersler (job, startet_kl desc) where ok;

alter table public.drift_cron_koersler enable row level security;
revoke all on public.drift_cron_koersler from public, anon, authenticated;
grant all on public.drift_cron_koersler to service_role;

-- ============================================================ B. fejllog

create table if not exists public.drift_fejl (
  id          bigint generated always as identity primary key,
  oprettet_kl timestamptz not null default now(),
  senest_kl   timestamptz not null default now(),
  antal       integer not null default 1,
  -- klient: error boundary i browseren (via server action)
  -- server: instrumentation onRequestError (render/route/action)
  -- action, cron, webhook, notifikation: catch-blokke i serverkoden
  kilde       text not null,
  sti         text,
  besked      text not null,
  digest      text,
  -- Kun hvis kendt (logget ind, eller modtageren af en notifikation).
  bruger_id   uuid references public.users(id) on delete set null,
  constraint drift_fejl_kilde check (kilde in ('klient', 'server', 'action', 'cron', 'webhook', 'notifikation')),
  constraint drift_fejl_besked_laengde check (char_length(besked) <= 1000),
  constraint drift_fejl_sti_laengde check (sti is null or char_length(sti) <= 300),
  constraint drift_fejl_digest_laengde check (digest is null or char_length(digest) <= 100)
);

create index if not exists drift_fejl_oprettet_idx on public.drift_fejl (oprettet_kl desc);
create index if not exists drift_fejl_senest_idx on public.drift_fejl (senest_kl desc);
create index if not exists drift_fejl_digest_idx
  on public.drift_fejl (digest, senest_kl desc) where digest is not null;
create index if not exists drift_fejl_kilde_idx on public.drift_fejl (kilde, senest_kl desc);

alter table public.drift_fejl enable row level security;
revoke all on public.drift_fejl from public, anon, authenticated;
grant all on public.drift_fejl to service_role;

-- Logger en fejl. Kun service_role (serverkoden renser teksten foer kaldet).
-- Returnerer:
--   'ny'          ny raekke
--   'dublet'      samme fejl set for nylig: antal + 1 paa den eksisterende
--                 (samme digest inden for 24 t, ellers samme kilde + sti +
--                 besked + bruger inden for 1 t)
--   'begraenset'  for mange nye raekker det seneste minut: droppet
--                 (klient: 30/min globalt, alt andet: 120/min globalt - saa
--                 en, der spammer fra browseren, ikke kan skjule serverfejl)
create or replace function public.drift_fejl_log(
  p_kilde text,
  p_sti text,
  p_besked text,
  p_digest text default null,
  p_bruger_id uuid default null)
returns text
language plpgsql
set search_path = public
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
  -- Fejl er sjaeldne; laasen holdes kun i denne korte transaktion.
  perform pg_advisory_xact_lock(hashtext('public.drift_fejl_log'));

  if v_digest is not null then
    select id into v_id
      from drift_fejl
     where digest = v_digest
       and senest_kl > now() - interval '24 hours'
     order by senest_kl desc
     limit 1;
  else
    select id into v_id
      from drift_fejl
     where kilde = v_kilde
       and sti is not distinct from v_sti
       and besked = v_besked
       and bruger_id is not distinct from p_bruger_id
       and digest is null
       and senest_kl > now() - interval '1 hour'
     order by senest_kl desc
     limit 1;
  end if;

  if v_id is not null then
    update drift_fejl
       set antal = least(antal, 2147483646) + 1,
           senest_kl = now()
     where id = v_id;
    return 'dublet';
  end if;

  select count(*) into v_antal
    from drift_fejl
   where oprettet_kl > now() - interval '1 minute'
     and (kilde = 'klient') = v_klient;
  if v_antal >= case when v_klient then 30 else 120 end then
    return 'begraenset';
  end if;

  insert into drift_fejl (kilde, sti, besked, digest, bruger_id)
  values (
    v_kilde, v_sti, v_besked, v_digest,
    -- En ukendt bruger (fx slettet auth-bruger) maa ikke vaelte logningen.
    (select id from users where id = p_bruger_id));
  return 'ny';
end;
$fn$;

revoke all on function public.drift_fejl_log(text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.drift_fejl_log(text, text, text, text, uuid) to service_role;

-- ============================================================ C. notifikationer

-- status (kun raekker claimet af send()):
--   claimet      noeglen er taget, afsendelsen er ikke meldt faerdig. Staar
--                den laenge, er processen doed midt i afsendelsen.
--   sendt        mindst een kanal lykkedes, ingen fejlede
--   delvis       mindst een kanal lykkedes, mindst een fejlede
--   fejlet       ingen kanal lykkedes, mindst een fejlede
--   ingen_kanal  intet at sende (alle kanaler fra, ingen e-mail/push-token)
-- kanaler: {"klokke": "...", "mail": "...", "push": "..."} med vaerdierne
--   sendt / fejl / fra / ingen. Ingen indhold, kun status.
alter table public.notifikation_afsendelser
  add column if not exists status text,
  add column if not exists afsluttet_kl timestamptz,
  add column if not exists kanaler jsonb,
  add column if not exists fejl text;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notifikation_afsendelser_status_gyldig'
       and conrelid = 'public.notifikation_afsendelser'::regclass) then
    alter table public.notifikation_afsendelser
      add constraint notifikation_afsendelser_status_gyldig
      check (status is null or status in ('claimet', 'sendt', 'delvis', 'fejlet', 'ingen_kanal'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'notifikation_afsendelser_fejl_laengde'
       and conrelid = 'public.notifikation_afsendelser'::regclass) then
    alter table public.notifikation_afsendelser
      add constraint notifikation_afsendelser_fejl_laengde
      check (fejl is null or char_length(fejl) <= 1000);
  end if;
end;
$do$;

create index if not exists notifikation_afsendelser_drift_idx
  on public.notifikation_afsendelser (oprettet_kl desc)
  where status in ('claimet', 'delvis', 'fejlet');

-- ============================================================ D. cron-status

-- Status for alle pg_cron-jobs. Kommandoen returneres ikke (kan indeholde
-- interne detaljer), og fejlbeskeder afkortes. Kun service_role: siden
-- /admin/drift kalder den med service-role efter assertRole('admin').
create or replace function public.admin_cron_status()
returns table (
  jobid           bigint,
  jobname         text,
  schedule        text,
  active          boolean,
  sidste_start    timestamptz,
  sidste_slut     timestamptz,
  sidste_status   text,
  sidste_besked   text,
  sidste_ok       timestamptz,
  koersler_24t    bigint,
  fejl_24t        bigint,
  seneste_fejl_kl timestamptz,
  seneste_fejl    text)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    return;
  end if;

  return query execute $q$
    select j.jobid::bigint,
           j.jobname::text,
           j.schedule::text,
           j.active,
           s.start_time,
           s.end_time,
           s.status::text,
           left(s.return_message, 500),
           o.sidste_ok,
           coalesce(d.koersler, 0)::bigint,
           coalesce(d.fejl, 0)::bigint,
           f.start_time,
           left(f.return_message, 500)
      from cron.job j
      left join lateral (
        select r.start_time, r.end_time, r.status, r.return_message
          from cron.job_run_details r
         where r.jobid = j.jobid
         order by r.runid desc
         limit 1) s on true
      left join lateral (
        select r.start_time as sidste_ok
          from cron.job_run_details r
         where r.jobid = j.jobid and r.status = 'succeeded'
         order by r.runid desc
         limit 1) o on true
      left join lateral (
        select count(*) as koersler,
               count(*) filter (where r.status = 'failed') as fejl
          from cron.job_run_details r
         where r.jobid = j.jobid
           and r.start_time > now() - interval '24 hours') d on true
      left join lateral (
        select r.start_time, r.return_message
          from cron.job_run_details r
         where r.jobid = j.jobid and r.status = 'failed'
         order by r.runid desc
         limit 1) f on true
     order by j.jobname
  $q$;
end;
$fn$;

revoke all on function public.admin_cron_status() from public, anon, authenticated;
grant execute on function public.admin_cron_status() to service_role;

-- pg_net-svar (gemmes af pg_net i ca. 6 timer). betalings-cron kalder ruten
-- asynkront, saa en 401/500/timeout ses kun her - ikke i job_run_details.
-- Kun statuskode, timeout og fejlbesked; aldrig body eller headers.
create or replace function public.admin_cron_http_svar()
returns table (
  id          bigint,
  oprettet_kl timestamptz,
  status_code integer,
  timed_out   boolean,
  fejl        text)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if to_regclass('net._http_response') is null then
    return;
  end if;

  return query execute $q$
    select r.id::bigint,
           r.created,
           r.status_code::integer,
           r.timed_out,
           left(r.error_msg, 300)
      from net._http_response r
     order by r.id desc
     limit 50
  $q$;
end;
$fn$;

revoke all on function public.admin_cron_http_svar() from public, anon, authenticated;
grant execute on function public.admin_cron_http_svar() to service_role;
