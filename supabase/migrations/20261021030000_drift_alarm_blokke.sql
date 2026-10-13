-- Drift-alarmmailen i blokke (Filip, 13. okt. 2026).
--
-- Mailen "Der er noget galt på BidHamr" viste én teknisk linje pr. hændelse.
-- Nu samles hændelser af samme type i én blok (src/lib/driftAlarmMail.ts),
-- og spam-værnet gælder pr. blok i stedet for pr. slags:
--
--   1. drift_alarm_kode(kilde, besked): koden for en hændelse uden id'er
--      (fx "betaling/ukendt-betaling"). SKAL følges ad med alarmKode() i
--      src/lib/driftAlarmTyper.ts:
--        - kilde 'klient' -> 'klient' (browser-fejl: aldrig tekst)
--        - id-agtige ord (>= 10 tegn [A-Za-z0-9_-] med et ciffer) -> '#'
--        - "hvor: fejl" (logDriftFejl) -> hvor; ellers de første 60 tegn
--   2. drift_alarm_blokke: én række pr. blok (kilde|kode) - hvornår den sidst
--      blev sendt, med hvilket antal, og hvad der venter.
--   3. drift_alarm_vurder_blokke(p_kan_sende): finder hændelserne (samme
--      kilder og vinduer som drift_alarm_vurder fra 20261008011000),
--      grupperer dem i blokke og afgør pr. blok:
--        - aldrig sendt, eller sidst sendt for over 1 time siden: send
--        - sendt inden for timen: send kun igen, hvis antallet er steget
--          markant (mindst det dobbelte og mindst 3) - ellers venter
--          hændelserne og kommer med, når timen er gået
--        - 'mange_fejl' er en tilstand (seneste 15 min.) og venter ikke
--      Slags-niveauets "højst én mail pr. 30 min." er erstattet af dette.
--      Hændelserne læses stadig præcis én gang pr. slags (daekket_til).
--   4. drift_alarm_blokke_fejlet(): mailen kunne ikke sendes - blokkene
--      lægges tilbage som ventende og sendes ved næste kørsel.
--
-- drift_alarm_vurder() og drift_alarm_mail_fejlet() er UÆNDREDE: en ældre
-- app-version bruger dem stadig, og den nye app falder tilbage til dem,
-- hvis denne migration ikke er kørt. De tager samme advisory-lås, så de to
-- aldrig kører samtidig.
--
-- Ingen persondata: kun kilde, sti og den allerede rensede fejltekst
-- (src/lib/drift.ts); browser-fejl kun som antal. Alle tabeller: RLS uden
-- policies, kun service_role. Rører ingen eksisterende funktioner, så intet
-- md5-drift-tjek er nødvendigt. Idempotent: kan køres flere gange.
-- KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ============================================================ 1. kode

create or replace function public.drift_alarm_kode(p_kilde text, p_besked text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when p_kilde = 'klient' then 'klient'
    else coalesce(
      nullif(btrim(coalesce(substring(x.n from '^([^:]{1,80}): '), left(x.n, 60))), ''),
      '(ingen besked)')
  end
  from (select regexp_replace(coalesce(p_besked, ''),
                              '(?=[A-Za-z_-]*[0-9])[A-Za-z0-9_-]{10,}', '#', 'g') as n) x
$fn$;

revoke all on function public.drift_alarm_kode(text, text) from public, anon, authenticated;
grant execute on function public.drift_alarm_kode(text, text) to service_role;

-- ============================================================ 2. blokke

create table if not exists public.drift_alarm_blokke (
  -- kilde|kode, fx "webhook|betaling/ukendt-betaling".
  noegle            text primary key,
  slags             text not null,
  kilde             text not null,
  kode              text not null,
  sidst_sendt_kl    timestamptz,
  -- Antal i den sidst sendte mail (til "steget markant").
  sidst_sendt_antal bigint not null default 0,
  antal_sendt       integer not null default 0,
  -- Hændelser, der er holdt tilbage siden sidste mail.
  venter_antal      bigint not null default 0,
  venter_fra        timestamptz,
  venter_til        timestamptz,
  venter_eksempler  jsonb not null default '[]'::jsonb,
  opdateret_kl      timestamptz not null default now(),
  constraint drift_alarm_blokke_noegle_laengde check (char_length(noegle) <= 200),
  constraint drift_alarm_blokke_slags check (slags in ('ny_fejl', 'mange_fejl', 'cron', 'webhook')),
  constraint drift_alarm_blokke_antal check (venter_antal >= 0 and sidst_sendt_antal >= 0 and antal_sendt >= 0)
);

create index if not exists drift_alarm_blokke_venter_idx
  on public.drift_alarm_blokke (sidst_sendt_kl) where venter_antal > 0;

alter table public.drift_alarm_blokke enable row level security;
revoke all on public.drift_alarm_blokke from public, anon, authenticated;
grant select on public.drift_alarm_blokke to service_role;

-- ============================================================ 3. vurdering

-- Returnerer:
--   {"blokke": [{"noegle", "slags", "kilde", "kode", "antal", "fra", "til",
--                "eksempler": [{"sti", "besked"} ...] (højst 3),
--                "gentaget", "forrige_sendt_kl", "forrige_antal"}],
--    "ingen_modtager": [{"slags", "noegle", "antal"}],
--    "holdt": <antal blokke, der venter>, "tidspunkt": "..."}
-- p_kan_sende = false (ingen modtager): intet markeres som sendt, men
-- hændelserne regnes for set, så der ikke kommer en stor bunke, når
-- modtageren sættes.
-- security definer: læser cron.job_run_details og net._http_response.
create or replace function public.drift_alarm_vurder_blokke(p_kan_sende boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_nu       timestamptz := now();
  -- Hændelser ses kun til og med 10 sekunder siden (se drift_alarm_vurder).
  v_graense  timestamptz := now() - interval '10 seconds';
  v_frist    constant interval := interval '1 hour';
  r          record;
  b          public.drift_alarm_blokke%rowtype;
  g          jsonb;
  v_grupper  jsonb;
  v_ekstra   jsonb;
  v_alle     jsonb := '[]'::jsonb;
  v_sidst_ok timestamptz;
  v_mange    bigint;
  v_noegle   text;
  v_slags    text;
  v_total    bigint;
  v_fra      timestamptz;
  v_til      timestamptz;
  v_eks      jsonb;
  v_sendes   boolean;
  v_set      text[] := '{}';
  v_send     jsonb := '[]'::jsonb;
  v_ingen    jsonb := '[]'::jsonb;
  v_holdt    integer := 0;
  -- slags -> 'sendt' | 'undertrykt' | 'ingen_modtager'
  v_status   jsonb := '{}'::jsonb;
  v_resultat text;
begin
  -- Samme lås som drift_alarm_vurder: de to kører aldrig samtidig.
  perform pg_advisory_xact_lock(hashtext('public.drift_alarm_vurder'));

  delete from public.drift_fejl_minut where minut < v_nu - interval '2 days';
  delete from public.drift_alarm_kald where oprettet_kl < v_nu - interval '2 days';
  delete from public.drift_alarm_blokke
   where venter_antal = 0 and opdateret_kl < v_nu - interval '30 days';

  -- ---------------------------------------------------- hændelser pr. slags
  for r in select a.* from public.drift_alarmer a order by a.slags for update loop
    v_grupper := '[]'::jsonb;

    if r.slags = 'ny_fejl' then
      -- En ny slags fejl (kilde + besked ikke set de seneste 30 dage).
      select coalesce(jsonb_agg(jsonb_build_object(
               'kilde', q.kilde, 'kode', q.kode, 'antal', q.antal,
               'fra', q.fra, 'til', q.til, 'eksempler', q.eksempler)), '[]'::jsonb)
        into v_grupper
        from (
          select f.kilde,
                 public.drift_alarm_kode(f.kilde, f.besked) as kode,
                 count(*) as antal, min(f.oprettet_kl) as fra, max(f.oprettet_kl) as til,
                 -- Browser-fejl er indsendt af brugere: aldrig tekst eller sti.
                 to_jsonb((array_agg(jsonb_build_object(
                     'sti', case when f.kilde = 'klient' then null else f.sti end,
                     'besked', case when f.kilde = 'klient' then null else left(f.besked, 300) end)
                   order by f.id desc))[1:3]) as eksempler
            from public.drift_fejl f
           where f.oprettet_kl > r.daekket_til
             and f.oprettet_kl <= v_graense
             and f.kilde not in ('cron', 'webhook')
             and not exists (
                   select 1 from public.drift_fejl o
                    where o.id < f.id
                      and o.kilde = f.kilde
                      and md5(o.besked) = md5(f.besked)
                      and o.besked = f.besked
                      and o.oprettet_kl > f.oprettet_kl - interval '30 days')
           group by 1, 2) q;

    elsif r.slags = 'mange_fejl' then
      -- Tilstand, ikke hændelse: måles altid over de seneste 15 minutter.
      select coalesce(sum(m.antal), 0) into v_mange
        from public.drift_fejl_minut m
       where m.minut > v_nu - interval '15 minutes';
      if v_mange > 20 then
        select jsonb_build_array(jsonb_build_object(
                 'kilde', '*', 'kode', 'mange-fejl', 'antal', v_mange,
                 'fra', v_nu - interval '15 minutes', 'til', v_nu,
                 'eksempler', coalesce(jsonb_agg(jsonb_build_object(
                     'kilde', p.kilde, 'sti', p.sti, 'besked', p.besked, 'antal', p.antal)
                   order by p.antal desc), '[]'::jsonb)))
          into v_grupper
          from (
            select f.kilde,
                   case when f.kilde = 'klient' then null else f.sti end as sti,
                   case when f.kilde = 'klient' then null else left(f.besked, 300) end as besked,
                   f.antal
              from public.drift_fejl f
             where f.senest_kl > v_nu - interval '15 minutes'
             order by f.antal desc
             limit 5) p;
      end if;

    elsif r.slags = 'webhook' then
      select coalesce(jsonb_agg(jsonb_build_object(
               'kilde', q.kilde, 'kode', q.kode, 'antal', q.antal,
               'fra', q.fra, 'til', q.til, 'eksempler', q.eksempler)), '[]'::jsonb)
        into v_grupper
        from (
          select f.kilde,
                 public.drift_alarm_kode(f.kilde, f.besked) as kode,
                 count(*) as antal, min(f.senest_kl) as fra, max(f.senest_kl) as til,
                 to_jsonb((array_agg(jsonb_build_object('sti', f.sti, 'besked', left(f.besked, 300))
                   order by f.senest_kl desc))[1:3]) as eksempler
            from public.drift_fejl f
           where f.kilde = 'webhook'
             and f.senest_kl > r.daekket_til
             and f.senest_kl <= v_graense
           group by 1, 2) q;

    elsif r.slags = 'cron' then
      -- 1) cron-fejl i drift_fejl
      select coalesce(jsonb_agg(jsonb_build_object(
               'kilde', q.kilde, 'kode', q.kode, 'antal', q.antal,
               'fra', q.fra, 'til', q.til, 'eksempler', q.eksempler)), '[]'::jsonb)
        into v_grupper
        from (
          select f.kilde,
                 public.drift_alarm_kode(f.kilde, f.besked) as kode,
                 count(*) as antal, min(f.senest_kl) as fra, max(f.senest_kl) as til,
                 to_jsonb((array_agg(jsonb_build_object('sti', f.sti, 'besked', left(f.besked, 300))
                   order by f.senest_kl desc))[1:3]) as eksempler
            from public.drift_fejl f
           where f.kilde = 'cron'
             and f.senest_kl > r.daekket_til
             and f.senest_kl <= v_graense
           group by 1, 2) q;

      -- 2) betalings-cron fejlede eller hænger (ikke afsluttet efter 10 min)
      select coalesce(jsonb_agg(jsonb_build_object(
               'kilde', 'cron', 'kode', q.kode, 'antal', q.antal,
               'fra', q.fra, 'til', q.til, 'eksempler', q.eksempler)), '[]'::jsonb)
        into v_ekstra
        from (
          select case when k.ok is false then 'cron/koersel-fejlede' else 'cron/koersel-haenger' end as kode,
                 count(*) as antal, min(k.startet_kl) as fra, max(k.startet_kl) as til,
                 to_jsonb((array_agg(jsonb_build_object('sti', k.job, 'besked', left(coalesce(k.fejl, ''), 300))
                   order by k.startet_kl desc))[1:3]) as eksempler
            from public.drift_cron_koersler k
           where (k.ok is false and k.afsluttet_kl > r.daekket_til and k.afsluttet_kl <= v_graense)
              or (k.afsluttet_kl is null
                  and k.startet_kl + interval '10 minutes' > r.daekket_til
                  and k.startet_kl + interval '10 minutes' <= v_graense)
           group by 1) q;
      v_grupper := v_grupper || v_ekstra;

      -- 3) betalings-cron er holdt op: ingen vellykket kørsel i 20 minutter.
      --    Meldes én gang pr. udfald. Aldrig kørt = ikke sat op (fx test).
      select max(k.startet_kl) into v_sidst_ok
        from public.drift_cron_koersler k
       where k.job = 'betalings-cron' and k.ok;
      if v_sidst_ok is not null
         and v_sidst_ok + interval '20 minutes' > r.daekket_til
         and v_sidst_ok + interval '20 minutes' <= v_graense then
        v_grupper := v_grupper || jsonb_build_array(jsonb_build_object(
          'kilde', 'cron', 'kode', 'cron/holdt-op', 'antal', 1,
          'fra', v_sidst_ok, 'til', v_sidst_ok,
          'eksempler', jsonb_build_array(jsonb_build_object('sti', 'betalings-cron', 'besked', null))));
      end if;

      -- 4) pg_cron-jobs, der fejlede
      if to_regclass('cron.job_run_details') is not null and to_regclass('cron.job') is not null then
        execute $q$
          select coalesce(jsonb_agg(jsonb_build_object(
                   'kilde', 'cron', 'kode', 'cron/pg-cron-job', 'antal', q.antal,
                   'fra', q.fra, 'til', q.til, 'eksempler', q.eksempler)), '[]'::jsonb)
            from (
              select count(*) as antal, min(d.start_time) as fra, max(d.start_time) as til,
                     to_jsonb((array_agg(jsonb_build_object(
                         'sti', j.jobname::text, 'besked', left(coalesce(d.return_message, ''), 300))
                       order by d.runid desc))[1:3]) as eksempler
                from cron.job_run_details d
                left join cron.job j on j.jobid = d.jobid
               where d.status = 'failed'
                 and coalesce(d.end_time, d.start_time) > $1
                 and coalesce(d.end_time, d.start_time) <= $2
              having count(*) > 0) q
        $q$ into v_ekstra using r.daekket_til, v_graense;
        v_grupper := v_grupper || v_ekstra;
      end if;

      -- 5) pg_net-kald (cron-ruterne) med fejl, timeout eller ikke-2xx
      if to_regclass('net._http_response') is not null then
        execute $q$
          select coalesce(jsonb_agg(jsonb_build_object(
                   'kilde', 'cron', 'kode', 'cron/http-kald', 'antal', q.antal,
                   'fra', q.fra, 'til', q.til, 'eksempler', q.eksempler)), '[]'::jsonb)
            from (
              select count(*) as antal, min(h.created) as fra, max(h.created) as til,
                     to_jsonb((array_agg(jsonb_build_object(
                         'sti', null::text,
                         'besked', case when h.timed_out then 'Timeout'
                                        when h.error_msg is not null then left(h.error_msg, 200)
                                        else 'HTTP ' || coalesce(h.status_code::text, '?') end)
                       order by h.id desc))[1:3]) as eksempler
                from net._http_response h
               where h.created > $1
                 and h.created <= $2
                 and (coalesce(h.timed_out, false)
                      or h.error_msg is not null
                      or h.status_code is null
                      or h.status_code not between 200 and 299)
                 -- Drift-alarmens egne kald tæller ikke med.
                 and not exists (select 1 from public.drift_alarm_kald k
                                  where k.request_id = h.id)
              having count(*) > 0) q
        $q$ into v_ekstra using r.daekket_til, v_graense;
        v_grupper := v_grupper || v_ekstra;
      end if;
    end if;

    -- Hændelserne er nu læst: vinduet flyttes altid frem. Det, der holdes
    -- tilbage, gemmes i drift_alarm_blokke.
    update public.drift_alarmer set daekket_til = v_graense where slags = r.slags;

    select v_alle || coalesce(jsonb_agg(e || jsonb_build_object('slags', r.slags)), '[]'::jsonb)
      into v_alle
      from jsonb_array_elements(v_grupper) e;
  end loop;

  -- ---------------------------------------------------- afgørelse pr. blok
  for g in select e from jsonb_array_elements(v_alle) e loop
    v_slags := g->>'slags';
    v_noegle := left((g->>'kilde') || '|' || (g->>'kode'), 200);
    v_set := v_set || v_noegle;

    insert into public.drift_alarm_blokke (noegle, slags, kilde, kode)
    values (v_noegle, v_slags, left(g->>'kilde', 20), left(g->>'kode', 180))
    on conflict (noegle) do nothing;
    select * into b from public.drift_alarm_blokke where noegle = v_noegle for update;

    if v_slags = 'mange_fejl' then
      -- Tilstand: ingen opsamling.
      v_total := (g->>'antal')::bigint;
      v_fra := (g->>'fra')::timestamptz;
      v_til := (g->>'til')::timestamptz;
      v_eks := coalesce(g->'eksempler', '[]'::jsonb);
    else
      v_total := (g->>'antal')::bigint + b.venter_antal;
      v_fra := least((g->>'fra')::timestamptz, b.venter_fra);
      v_til := greatest((g->>'til')::timestamptz, b.venter_til);
      select coalesce(jsonb_agg(t.e order by t.i), '[]'::jsonb) into v_eks
        from jsonb_array_elements(coalesce(g->'eksempler', '[]'::jsonb) || b.venter_eksempler)
             with ordinality t(e, i)
       where t.i <= 3;
    end if;

    v_sendes := b.sidst_sendt_kl is null
             or b.sidst_sendt_kl <= v_nu - v_frist
             or v_total >= greatest(3, 2 * b.sidst_sendt_antal);

    if not p_kan_sende then
      update public.drift_alarm_blokke
         set venter_antal = 0, venter_fra = null, venter_til = null,
             venter_eksempler = '[]'::jsonb, opdateret_kl = v_nu
       where noegle = v_noegle;
      v_ingen := v_ingen || jsonb_build_array(jsonb_build_object(
        'slags', v_slags, 'noegle', v_noegle, 'antal', v_total));
      if not (v_status ? v_slags) then
        v_status := v_status || jsonb_build_object(v_slags, 'ingen_modtager');
      end if;
    elsif v_sendes then
      update public.drift_alarm_blokke
         set sidst_sendt_kl = v_nu,
             sidst_sendt_antal = v_total,
             antal_sendt = least(antal_sendt, 2147483646) + 1,
             venter_antal = 0, venter_fra = null, venter_til = null,
             venter_eksempler = '[]'::jsonb, opdateret_kl = v_nu
       where noegle = v_noegle;
      v_send := v_send || jsonb_build_array(jsonb_build_object(
        'noegle', v_noegle, 'slags', v_slags, 'kilde', b.kilde, 'kode', b.kode,
        'antal', v_total, 'fra', v_fra, 'til', v_til, 'eksempler', v_eks,
        'gentaget', b.sidst_sendt_kl is not null and b.sidst_sendt_kl > v_nu - v_frist,
        'forrige_sendt_kl', b.sidst_sendt_kl, 'forrige_antal', b.sidst_sendt_antal));
      v_status := v_status || jsonb_build_object(v_slags, 'sendt');
    else
      if v_slags = 'mange_fejl' then
        update public.drift_alarm_blokke set opdateret_kl = v_nu where noegle = v_noegle;
      else
        update public.drift_alarm_blokke
           set venter_antal = least(v_total, 2147483646), venter_fra = v_fra, venter_til = v_til,
               venter_eksempler = v_eks, opdateret_kl = v_nu
         where noegle = v_noegle;
      end if;
      v_holdt := v_holdt + 1;
      if not (v_status ? v_slags) then
        v_status := v_status || jsonb_build_object(v_slags, 'undertrykt');
      end if;
    end if;
  end loop;

  -- ---------------------------------------------------- ventende blokke
  -- Holdt tilbage, og timen er gået: sendes nu, også uden nye hændelser.
  for b in
    select * from public.drift_alarm_blokke k
     where k.venter_antal > 0
       and not (k.noegle = any (v_set))
       and (k.sidst_sendt_kl is null or k.sidst_sendt_kl <= v_nu - v_frist)
     order by k.noegle
     for update
  loop
    if p_kan_sende then
      update public.drift_alarm_blokke
         set sidst_sendt_kl = v_nu,
             sidst_sendt_antal = b.venter_antal,
             antal_sendt = least(antal_sendt, 2147483646) + 1,
             venter_antal = 0, venter_fra = null, venter_til = null,
             venter_eksempler = '[]'::jsonb, opdateret_kl = v_nu
       where noegle = b.noegle;
      v_send := v_send || jsonb_build_array(jsonb_build_object(
        'noegle', b.noegle, 'slags', b.slags, 'kilde', b.kilde, 'kode', b.kode,
        'antal', b.venter_antal, 'fra', b.venter_fra, 'til', b.venter_til,
        'eksempler', b.venter_eksempler, 'gentaget', false,
        'forrige_sendt_kl', b.sidst_sendt_kl, 'forrige_antal', b.sidst_sendt_antal));
      v_status := v_status || jsonb_build_object(b.slags, 'sendt');
    else
      update public.drift_alarm_blokke
         set venter_antal = 0, venter_fra = null, venter_til = null,
             venter_eksempler = '[]'::jsonb, opdateret_kl = v_nu
       where noegle = b.noegle;
    end if;
  end loop;

  -- ---------------------------------------------------- status pr. slags
  update public.drift_alarmer a
     set sidst_udloest_kl = v_nu,
         sidste_resultat = v_status->>a.slags,
         sidst_sendt_kl = case when v_status->>a.slags = 'sendt' then v_nu else a.sidst_sendt_kl end,
         antal_sendt = case when v_status->>a.slags = 'sendt'
                            then least(a.antal_sendt, 2147483646) + 1 else a.antal_sendt end
   where v_status ? a.slags;

  v_resultat := case
    when jsonb_array_length(v_send) > 0 then 'sendt'
    when jsonb_array_length(v_ingen) > 0 then 'ingen_modtager'
    when v_holdt > 0 then 'undertrykt'
    else 'ingen' end;

  update public.drift_alarm_tilstand
     set sidst_tjekket_kl = v_nu, sidste_resultat = v_resultat, sidste_fejl = null
   where id;

  return jsonb_build_object(
    'blokke', v_send, 'ingen_modtager', v_ingen, 'holdt', v_holdt, 'tidspunkt', v_nu);
end;
$fn$;

revoke all on function public.drift_alarm_vurder_blokke(boolean) from public, anon, authenticated;
grant execute on function public.drift_alarm_vurder_blokke(boolean) to service_role;

-- ============================================================ 4. mail fejlede

-- Mailen kunne ikke sendes: blokkene lægges tilbage som ventende uden
-- "sidst sendt", så de sendes ved næste kørsel. p_tidspunkt er "tidspunkt"
-- fra drift_alarm_vurder_blokke; kun rækker, der stadig er markeret af netop
-- det kald, røres. p_blokke er "blokke" fra samme kald.
create or replace function public.drift_alarm_blokke_fejlet(
  p_tidspunkt timestamptz,
  p_blokke jsonb,
  p_fejl text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_b jsonb;
begin
  if jsonb_typeof(p_blokke) = 'array' then
    for v_b in select * from jsonb_array_elements(p_blokke) loop
      update public.drift_alarm_blokke
         set venter_antal = least(venter_antal + greatest(coalesce((v_b->>'antal')::bigint, 0), 0), 2147483646),
             venter_fra = least(venter_fra, (v_b->>'fra')::timestamptz),
             venter_til = greatest(venter_til, (v_b->>'til')::timestamptz),
             venter_eksempler = case when jsonb_typeof(v_b->'eksempler') = 'array'
                                     then (select coalesce(jsonb_agg(t.e order by t.i), '[]'::jsonb)
                                             from jsonb_array_elements(v_b->'eksempler') with ordinality t(e, i)
                                            where t.i <= 3)
                                     else venter_eksempler end,
             sidst_sendt_kl = null,
             sidst_sendt_antal = greatest(coalesce((v_b->>'forrige_antal')::bigint, 0), 0),
             antal_sendt = greatest(antal_sendt - 1, 0),
             opdateret_kl = now()
       where noegle = v_b->>'noegle'
         and sidst_sendt_kl = p_tidspunkt;
    end loop;
  end if;

  update public.drift_alarmer
     set sidste_resultat = 'mail_fejlet',
         antal_sendt = greatest(antal_sendt - 1, 0)
   where sidst_sendt_kl = p_tidspunkt;

  update public.drift_alarm_tilstand
     set sidste_resultat = 'mail_fejlet', sidste_fejl = left(p_fejl, 500)
   where id;
end;
$fn$;

revoke all on function public.drift_alarm_blokke_fejlet(timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.drift_alarm_blokke_fejlet(timestamptz, jsonb, text) to service_role;
