-- Henvis en ven (Filip, 27. okt. 2026 - ROADMAP-BESLUTNINGER, "Nye funktioner
-- før lancering", punkt 3).
--
-- Regler:
--   - Hver privat bruger har et personligt link (bidhamr.dk/?ven=KODE). Koden
--     er 10 tilfældige tegn (A-Z uden I og O, 2-9 - 50 bit fra
--     gen_random_bytes) og afslører hverken id eller navn.
--   - Koden knyttes til en NY konto, når vennen bekræfter sin e-mail med koden
--     fra mailen (bekraeftKode, src/lib/kontoOprettelse.ts - hjemmesiden via
--     cookien bh_ven, appen via feltet henvisningskode). Kun én henviser pr.
--     konto, og den kan aldrig skiftes (ven_id er unik, rækken er låst).
--   - Når vennen bliver MitID-verificeret (ny række i mitid_verificeringer
--     med status 'aktiv'), vurderes henvisningen ÉN gang i samme transaktion
--     (trigger): henviseren får 10 boost-point (ny posteringstype
--     'henvisning' i boost_posteringer) - eller 0 point med en grund.
--   - Loft: højst 10 belønnede venner pr. kalendermåned (dansk tid). Over
--     loftet registreres henvisningen med status 'loft' og 0 point.
--   - Kun private: er henviseren en firmakonto, gives 0 point ('firma').
--   - Snyd: samme MitID-identitet giver aldrig point to gange. Har MitID'en
--     været brugt på en anden konto (også slettet/nulstillet), eller er den
--     allerede vurderet i en anden henvisning, gives 0 point
--     ('tidligere_konto'). Er det henviserens egen MitID: 'samme_person'.
--   - Før lancering: ingen point ('foer_lancering'), ligesom "ingen point for
--     salg før lanceringen". Databasen kender ikke LANCERET-flaget, så
--     henvisning_indstillinger.optjening_fra_kl er null, indtil serveren
--     (som kender foerLancering(), src/lib/lancering.ts) kalder
--     henvisning_start_optjening(). Det sker i cron'en og lige før MitID-
--     registreringen, når siden er lanceret (src/lib/henvisning.ts). På
--     testdatabasen er siden altid "lanceret", så den åbnes ved første kald.
--   - RLS: brugeren ser kun sine egne henvisninger (status, point, datoer) -
--     aldrig vennens id, e-mail eller MitID. Vennens navn kun som kort
--     visningsnavn ("Kasper K.") via min_henvisning(). Ingen kan selv indsætte
--     henvisninger eller point.
--
-- Indhold:
--   1. henvisning_indstillinger (konstanter + optjening_fra_kl)
--   2. henvisning_koder (én kode pr. privat bruger)
--   3. henvisninger (én pr. henvist konto; slettes aldrig)
--   4. boost_posteringer: type 'henvisning' + kolonnen henvisning_id
--   5. henvisning_knyt (server, service_role)
--   6. henvisning_vurder + trigger på mitid_verificeringer + henvisning_synk (cron)
--   7. henvisning_start_optjening (server, service_role)
--   8. min_henvisning (brugeren, authenticated - også appen)
--
-- Ændrer ingen eksisterende funktioner. Ændrer boost_posteringer (ny kolonne,
-- ny type i CHECK'en, nyt unikt indeks) og lægger en AFTER INSERT-trigger på
-- mitid_verificeringer. Idempotent (kan køres igen). Én transaktion. Kun
-- testdatabasen, indtil Filip siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.users') is null or to_regclass('public.boost_posteringer') is null
     or to_regclass('public.mitid_verificeringer') is null then
    raise exception 'Forudsætning mangler: users, boost_posteringer (20261023030000_boost.sql) og mitid_verificeringer (20261013010000_mitid.sql)';
  end if;
  if to_regprocedure('public.boost_bruger_spaerret(uuid)') is null
     or to_regprocedure('public.boost_laas_bruger(uuid)') is null
     or to_regprocedure('public.kort_visningsnavn(text)') is null
     or to_regprocedure('public.drift_fejl_log(text, text, text, text, uuid)') is null then
    raise exception 'Forudsætning mangler: boost_bruger_spaerret, boost_laas_bruger, kort_visningsnavn og drift_fejl_log';
  end if;
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'Forudsætning mangler: pgcrypto (extensions.gen_random_bytes)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Indstillinger (konstanter - ændres med en ny migration)
-- ===========================================================================
create table if not exists public.henvisning_indstillinger (
  id                boolean primary key default true,
  -- Point til henviseren pr. MitID-verificeret ven.
  point_pr_ven      integer not null default 10,
  -- Højst så mange belønnede venner pr. kalendermåned (dansk tid).
  maks_pr_maaned    integer not null default 10,
  -- En konto er "ny", hvis den er oprettet for højst så mange dage siden,
  -- når koden knyttes (og endnu ikke er MitID-verificeret).
  ny_konto_dage     integer not null default 7,
  -- null = før lancering: ingen point. Sættes én gang af
  -- henvisning_start_optjening() (serveren, når siden er lanceret).
  optjening_fra_kl  timestamptz,
  constraint henvisning_indstillinger_en check (id),
  constraint henvisning_indstillinger_tal check (
    point_pr_ven between 1 and 1000 and maks_pr_maaned between 0 and 1000 and ny_konto_dage between 1 and 90)
);
comment on table public.henvisning_indstillinger is
  'Henvis en ven (Filip, 27. okt. 2026): point pr. ven (10), loft pr. kalendermåned (10), hvor ny en konto skal være (7 dage), og hvornår optjeningen startede (null = før lancering). Én række. Ændres med en migration.';
insert into public.henvisning_indstillinger (id) values (true) on conflict (id) do nothing;

alter table public.henvisning_indstillinger enable row level security;
drop policy if exists henvisning_indstillinger_laes on public.henvisning_indstillinger;
create policy henvisning_indstillinger_laes on public.henvisning_indstillinger
  for select to authenticated using (true);
revoke all on public.henvisning_indstillinger from public, anon, authenticated, service_role;
grant select on public.henvisning_indstillinger to authenticated, service_role;

-- ===========================================================================
-- 2. Koder
-- ===========================================================================
create table if not exists public.henvisning_koder (
  bruger_id    uuid primary key references public.users(id) on delete restrict,
  kode         text not null unique,
  oprettet_kl  timestamptz not null default now(),
  constraint henvisning_koder_form check (kode ~ '^[A-HJ-NP-Z2-9]{10}$')
);
comment on table public.henvisning_koder is
  'Henvis en ven: brugerens personlige kode (10 tegn, tilfældig, afslører intet). Laves af min_henvisning(). Brugeren kan kun læse sin egen.';

alter table public.henvisning_koder enable row level security;
drop policy if exists henvisning_koder_egen on public.henvisning_koder;
create policy henvisning_koder_egen on public.henvisning_koder
  for select to authenticated using (bruger_id = (select auth.uid()));
revoke all on public.henvisning_koder from public, anon, authenticated, service_role;
grant select (kode, oprettet_kl) on public.henvisning_koder to authenticated;
grant select on public.henvisning_koder to service_role;

-- ===========================================================================
-- 3. Henvisninger
-- ===========================================================================
create table if not exists public.henvisninger (
  id           uuid primary key default gen_random_uuid(),
  henviser_id  uuid not null references public.users(id) on delete restrict,
  -- Én henviser pr. konto - kan aldrig skiftes.
  ven_id       uuid not null unique references public.users(id) on delete restrict,
  kode         text not null,
  oprettet_kl  timestamptz not null default now(),
  status       text not null default 'afventer',
  point        integer not null default 0,
  -- Vennens MitID-hash (samme HMAC som mitid_verificeringer.id_hash), sat
  -- når henvisningen vurderes. Kun service_role kan læse den.
  mitid_hash   text,
  vurderet_kl  timestamptz,
  -- Kalendermåned (dansk tid) for vurderingen, fx '2026-11' (loftet).
  maaned       text,
  constraint henvisninger_ikke_selv check (henviser_id <> ven_id),
  constraint henvisninger_status_check check (status in (
    'afventer',        -- vennen er ikke MitID-verificeret endnu
    'belonnet',        -- henviseren fik point
    'loft',            -- over månedens loft: 0 point
    'firma',           -- henviseren er en firmakonto: 0 point
    'spaerret',        -- henviserens konto er lukket, slettet eller suspenderet: 0 point
    'foer_lancering',  -- verificeret før lanceringen: 0 point
    'samme_person',    -- vennens MitID er henviserens egen: 0 point
    'tidligere_konto'  -- MitID'en har været brugt før (anden konto eller henvisning): 0 point
  )),
  constraint henvisninger_point_check check ((status = 'belonnet') = (point > 0) and point between 0 and 1000),
  constraint henvisninger_vurderet_check check (
    (status = 'afventer') = (vurderet_kl is null)
    and (status = 'afventer' or (maaned ~ '^\d{4}-\d{2}$' and mitid_hash ~ '^[0-9a-f]{64}$'))),
  constraint henvisninger_kode_form check (kode ~ '^[A-HJ-NP-Z2-9]{10}$')
);
comment on table public.henvisninger is
  'Henvis en ven: én række pr. henvist konto (ven_id unik - henviseren kan ikke skiftes). Vurderes én gang, når vennen bliver MitID-verificeret. Skrives kun af security definer-funktionerne. Henviseren kan læse status og point på sine egne. Slettes aldrig.';

-- Samme MitID kan højst give point én gang (hård garanti oven på tjekket i
-- henvisning_vurder).
create unique index if not exists henvisninger_mitid_belonnet
  on public.henvisninger (mitid_hash) where status = 'belonnet';
create index if not exists henvisninger_mitid on public.henvisninger (mitid_hash) where mitid_hash is not null;
create index if not exists henvisninger_henviser on public.henvisninger (henviser_id, oprettet_kl desc);
create index if not exists henvisninger_loft on public.henvisninger (henviser_id, maaned) where status = 'belonnet';
create index if not exists henvisninger_afventer on public.henvisninger (ven_id) where status = 'afventer';

-- Låst: henviser, ven, kode og oprettelse ændres aldrig, og en vurdering kan
-- ikke laves om. Ingen sletning.
create or replace function public.henvisninger_laast()
returns trigger language plpgsql set search_path = public as $fn$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'Henvisninger kan ikke slettes' using errcode = '42501';
  end if;
  if new.id <> old.id or new.henviser_id <> old.henviser_id or new.ven_id <> old.ven_id
     or new.kode <> old.kode or new.oprettet_kl <> old.oprettet_kl then
    raise exception 'Henvisningen kan ikke ændres' using errcode = '42501';
  end if;
  if old.status <> 'afventer' and (new.status, new.point, new.mitid_hash, new.vurderet_kl, new.maaned)
       is distinct from (old.status, old.point, old.mitid_hash, old.vurderet_kl, old.maaned) then
    raise exception 'Henvisningen er allerede vurderet' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
drop trigger if exists henvisninger_laast on public.henvisninger;
create trigger henvisninger_laast before update or delete on public.henvisninger
  for each row execute function public.henvisninger_laast();
drop trigger if exists henvisninger_ingen_truncate on public.henvisninger;
create trigger henvisninger_ingen_truncate before truncate on public.henvisninger
  for each statement execute function public.henvisninger_laast();
drop trigger if exists henvisning_koder_laast on public.henvisning_koder;
create trigger henvisning_koder_laast before update or delete on public.henvisning_koder
  for each row execute function public.boost_forbyd_aendring();
drop trigger if exists henvisning_koder_ingen_truncate on public.henvisning_koder;
create trigger henvisning_koder_ingen_truncate before truncate on public.henvisning_koder
  for each statement execute function public.boost_forbyd_aendring();
revoke all on function public.henvisninger_laast() from public, anon, authenticated, service_role;

alter table public.henvisninger enable row level security;
drop policy if exists henvisninger_egne on public.henvisninger;
create policy henvisninger_egne on public.henvisninger
  for select to authenticated using (henviser_id = (select auth.uid()));
revoke all on public.henvisninger from public, anon, authenticated, service_role;
-- Kun status, point og datoer - aldrig vennens id, koden eller MitID-hashen.
grant select (id, status, point, oprettet_kl, vurderet_kl, maaned) on public.henvisninger to authenticated;
grant select on public.henvisninger to service_role;

-- ===========================================================================
-- 4. Pointkontoen: ny type 'henvisning'
-- ===========================================================================
alter table public.boost_posteringer
  add column if not exists henvisning_id uuid references public.henvisninger(id) on delete restrict;

alter table public.boost_posteringer drop constraint if exists boost_posteringer_type_check;
alter table public.boost_posteringer add constraint boost_posteringer_type_check
  check (type in ('koeb', 'optjening', 'forbrug', 'tilbagefoersel', 'staff', 'henvisning'));

-- De eksisterende former (20261023030000) er uændrede. En henvisning:
-- positive point, kun henvisning_id. henvisning_id bruges ikke af andre typer.
alter table public.boost_posteringer drop constraint if exists boost_posteringer_form;
alter table public.boost_posteringer add constraint boost_posteringer_form check (
  (type = 'koeb' and point > 0 and boost_koeb_id is not null and betaling_id is null and boost_id is null
     and staff_id is null and oensket_point is null)
  or (type = 'optjening' and point > 0 and betaling_id is not null and boost_koeb_id is null and boost_id is null
     and staff_id is null and oensket_point is null)
  or (type = 'forbrug' and point < 0 and boost_id is not null and boost_koeb_id is null and betaling_id is null
     and staff_id is null and oensket_point is null)
  or (type = 'tilbagefoersel' and point <= 0 and oensket_point > 0 and -point <= oensket_point
     and ((betaling_id is not null) <> (boost_koeb_id is not null)) and boost_id is null)
  or (type = 'staff' and point <> 0 and staff_id is not null and begrundelse is not null
     and idempotens_noegle is not null and boost_koeb_id is null and betaling_id is null and boost_id is null
     and oensket_point is null)
  or (type = 'henvisning' and point > 0 and henvisning_id is not null and boost_koeb_id is null
     and betaling_id is null and boost_id is null and staff_id is null and oensket_point is null
     and idempotens_noegle is null));
alter table public.boost_posteringer drop constraint if exists boost_posteringer_henvisning_kun_type;
alter table public.boost_posteringer add constraint boost_posteringer_henvisning_kun_type
  check (henvisning_id is null or type = 'henvisning');

-- Én postering pr. henvisning (idempotens).
create unique index if not exists boost_post_henvisning on public.boost_posteringer (henvisning_id)
  where type = 'henvisning';

grant select (henvisning_id) on public.boost_posteringer to authenticated;

-- ===========================================================================
-- 5. Knyt en kode til en ny konto (serveren, efter bekræftelsen af e-mailen)
-- ===========================================================================
-- p_ven SKAL være den bruger, der lige har bekræftet sin e-mail med koden
-- fra mailen (verifyOtp på serveren). Kun service_role. Svar {kode}:
--   ok | findes (har allerede en henviser - uændret) | ugyldig | ukendt |
--   selv | ikke_ny | ikke_privat
create or replace function public.henvisning_knyt(p_ven uuid, p_kode text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  s        public.henvisning_indstillinger%rowtype;
  v_kode   text := upper(btrim(coalesce(p_kode, '')));
  v_henv   uuid;
  u        record;
  n        integer;
begin
  if p_ven is null or v_kode !~ '^[A-HJ-NP-Z2-9]{10}$' then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  select * into s from public.henvisning_indstillinger where id;

  -- To samtidige kald for samme konto: ven_id er unik (on conflict nedenfor).
  select id, konto_type, oprettet, konto_lukket_kl, konto_slettet_kl, mitid_verificeret_kl
    into u from public.users where id = p_ven;
  if not found then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if exists (select 1 from public.henvisninger h where h.ven_id = p_ven) then
    return jsonb_build_object('kode', 'findes');
  end if;

  select k.bruger_id into v_henv
    from public.henvisning_koder k
    join public.users x on x.id = k.bruger_id
   where k.kode = v_kode and x.konto_slettet_kl is null and x.konto_lukket_kl is null;
  if v_henv is null then
    return jsonb_build_object('kode', 'ukendt');
  end if;
  if v_henv = p_ven then
    return jsonb_build_object('kode', 'selv');
  end if;
  if u.konto_type is distinct from 'privat' then
    return jsonb_build_object('kode', 'ikke_privat');
  end if;
  -- Kun en NY konto: oprettet for nylig, ikke lukket/slettet, ikke
  -- MitID-verificeret, og aldrig verificeret før (heller ikke nulstillet).
  if u.konto_lukket_kl is not null or u.konto_slettet_kl is not null
     or u.mitid_verificeret_kl is not null
     or u.oprettet is null or u.oprettet < now() - make_interval(days => s.ny_konto_dage)
     or exists (select 1 from public.mitid_verificeringer v where v.bruger_id = p_ven) then
    return jsonb_build_object('kode', 'ikke_ny');
  end if;

  insert into public.henvisninger (henviser_id, ven_id, kode)
  values (v_henv, p_ven, v_kode)
  on conflict (ven_id) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('kode', case when n > 0 then 'ok' else 'findes' end);
end;
$fn$;
revoke all on function public.henvisning_knyt(uuid, text) from public, anon, authenticated;
grant execute on function public.henvisning_knyt(uuid, text) to service_role;

-- ===========================================================================
-- 6. Vurdering, når vennen bliver MitID-verificeret
-- ===========================================================================
-- Intern (kun triggeren og henvisning_synk). Idempotent: kun en henvisning
-- med status 'afventer' vurderes, og opdateringen sker med
-- "where status = 'afventer'". Svar: den nye status, eller null (intet at gøre).
create or replace function public.henvisning_vurder(p_ven uuid, p_hash text)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  s        public.henvisning_indstillinger%rowtype;
  h        public.henvisninger%rowtype;
  v_maaned text := to_char(now() at time zone 'Europe/Copenhagen', 'YYYY-MM');
  v_status text;
  v_point  integer := 0;
  v_antal  integer;
  v_henv   record;
  n        integer;
begin
  if p_ven is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into h from public.henvisninger where ven_id = p_ven and status = 'afventer' for update;
  if not found then
    return null;
  end if;
  select * into s from public.henvisning_indstillinger where id;

  -- Lås henviserens pointkonto (samme lås som boost_posteringer), så loftet
  -- holder ved samtidige verificeringer, og MitID'en, så samme identitet ikke
  -- vurderes to steder på én gang.
  perform public.boost_laas_bruger(h.henviser_id);
  perform pg_advisory_xact_lock(hashtextextended('bidhamr-henvisning-mitid:' || p_hash, 0));

  select u.konto_type into v_henv from public.users u where u.id = h.henviser_id;

  if s.optjening_fra_kl is null or now() < s.optjening_fra_kl then
    v_status := 'foer_lancering';
  elsif v_henv.konto_type is distinct from 'privat' then
    v_status := 'firma';
  elsif exists (select 1 from public.mitid_verificeringer v
                 where v.bruger_id = h.henviser_id and v.id_hash = p_hash) then
    v_status := 'samme_person';
  elsif exists (select 1 from public.mitid_verificeringer v
                 where v.id_hash = p_hash and v.bruger_id <> p_ven)
     or exists (select 1 from public.henvisninger x
                 where x.mitid_hash = p_hash and x.id <> h.id) then
    -- Personen har haft en konto før (fx slettet og oprettet igen), eller
    -- MitID'en har allerede været vurderet i en anden henvisning.
    v_status := 'tidligere_konto';
  elsif public.boost_bruger_spaerret(h.henviser_id) is not null then
    v_status := 'spaerret';
  else
    select count(*) into v_antal from public.henvisninger x
     where x.henviser_id = h.henviser_id and x.status = 'belonnet' and x.maaned = v_maaned;
    if v_antal >= s.maks_pr_maaned then
      v_status := 'loft';
    else
      v_status := 'belonnet';
      v_point := s.point_pr_ven;
    end if;
  end if;

  update public.henvisninger
     set status = v_status, point = v_point, mitid_hash = p_hash, vurderet_kl = now(), maaned = v_maaned
   where id = h.id and status = 'afventer';
  get diagnostics n = row_count;
  if n = 0 then
    return null;
  end if;

  if v_point > 0 then
    insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, henvisning_id)
    values (h.henviser_id, 'henvisning', v_point, 0, h.id)
    on conflict do nothing;
  end if;
  return v_status;
end;
$fn$;
revoke all on function public.henvisning_vurder(uuid, text) from public, anon, authenticated, service_role;

-- AFTER INSERT på mitid_verificeringer: en ny, aktiv verificering (det er
-- dér, mitid_registrer/mitid_app_afslut markerer verificeringen - samme
-- transaktion). En fejl her må aldrig stoppe selve MitID-verificeringen: den
-- logges i drift_fejl, henvisningen forbliver 'afventer', og
-- henvisning_synk (cron) prøver igen.
create or replace function public.mitid_verificeringer_henvisning()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'aktiv' then
    begin
      perform public.henvisning_vurder(new.bruger_id, new.id_hash);
    exception when others then
      begin
        perform public.drift_fejl_log('server', 'henvisning_vurder',
          left('Henvis en ven: vurderingen fejlede (' || sqlstate || '): ' || sqlerrm, 900), null, new.bruger_id);
      exception when others then
        null;
      end;
    end;
  end if;
  return new;
end;
$fn$;
revoke all on function public.mitid_verificeringer_henvisning() from public, anon, authenticated, service_role;
drop trigger if exists mitid_verificeringer_henvisning on public.mitid_verificeringer;
create trigger mitid_verificeringer_henvisning after insert on public.mitid_verificeringer
  for each row execute function public.mitid_verificeringer_henvisning();

-- Sikkerhedsnet (cron, service_role): henvisninger, der stadig afventer,
-- selvom vennen har en aktiv MitID-verificering (fx fordi triggeren fejlede).
-- Svar: { vurderet, fejl }.
create or replace function public.henvisning_synk(p_graense integer default 200)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  r        record;
  v_ok     integer := 0;
  v_fejl   integer := 0;
begin
  for r in
    select h.ven_id, v.id_hash
      from public.henvisninger h
      join public.mitid_verificeringer v on v.bruger_id = h.ven_id and v.status = 'aktiv'
     where h.status = 'afventer'
     order by h.oprettet_kl
     limit greatest(1, least(coalesce(p_graense, 200), 1000))
  loop
    begin
      if public.henvisning_vurder(r.ven_id, r.id_hash) is not null then
        v_ok := v_ok + 1;
      end if;
    exception when others then
      v_fejl := v_fejl + 1;
    end;
  end loop;
  return jsonb_build_object('vurderet', v_ok, 'fejl', v_fejl);
end;
$fn$;
revoke all on function public.henvisning_synk(integer) from public, anon, authenticated;
grant execute on function public.henvisning_synk(integer) to service_role;

-- ===========================================================================
-- 7. Start optjeningen (serveren, når siden er lanceret)
-- ===========================================================================
-- Sætter optjening_fra_kl én gang (kan ikke flyttes eller slås fra igen).
-- Kun service_role - kaldes af src/lib/henvisning.ts, når foerLancering() er
-- false. Svar: tidspunktet.
create or replace function public.henvisning_start_optjening()
returns timestamptz language plpgsql security definer set search_path = public as $fn$
declare
  v timestamptz;
begin
  update public.henvisning_indstillinger set optjening_fra_kl = now()
   where id and optjening_fra_kl is null;
  select optjening_fra_kl into v from public.henvisning_indstillinger where id;
  return v;
end;
$fn$;
revoke all on function public.henvisning_start_optjening() from public, anon, authenticated;
grant execute on function public.henvisning_start_optjening() to service_role;

-- ===========================================================================
-- 8. Brugeren (hjemmesiden og appen)
-- ===========================================================================
-- Ny tilfældig kode: 10 tegn fra 32 tegn (A-Z uden I og O, 2-9). 256 er
-- deleligt med 32, så hvert tegn er ligeligt fordelt.
create or replace function public.henvisning_ny_kode()
returns text language plpgsql volatile set search_path = public as $fn$
declare
  v_tegn  constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := extensions.gen_random_bytes(10);
  v_kode  text := '';
begin
  for i in 0..9 loop
    v_kode := v_kode || substr(v_tegn, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  return v_kode;
end;
$fn$;
revoke all on function public.henvisning_ny_kode() from public, anon, authenticated, service_role;

-- supabase.rpc("min_henvisning") (indlogget) ->
--   null (ikke logget ind) eller
--   { kan_henvise: false, grund: 'erhverv' }  (firmakonto: intet link)
--   { kan_henvise: true, kode, sti: '/?ven=KODE',
--     kan_faa_point: boolean, grund: null | 'spaerret',
--     optjening_aaben: boolean (false = før lancering),
--     point_pr_ven, maks_pr_maaned, maaned: 'ÅÅÅÅ-MM',
--     belonnet_denne_maaned, tilbage_denne_maaned,
--     antal_venner, antal_afventer, antal_belonnet, point_i_alt,
--     venner: [{ navn, status, point, oprettet_kl, vurderet_kl }] (nyeste først, højst 100) }
-- Brugeren udledes af auth.uid(). navn er vennens korte visningsnavn.
create or replace function public.min_henvisning()
returns jsonb language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_bruger uuid := (select auth.uid());
  s        public.henvisning_indstillinger%rowtype;
  u        record;
  v_kode   text;
  v_maaned text := to_char(now() at time zone 'Europe/Copenhagen', 'YYYY-MM');
  v_md     integer;
begin
  if v_bruger is null then return null; end if;
  select id, konto_type, konto_slettet_kl into u from public.users where id = v_bruger;
  if not found or u.konto_slettet_kl is not null then return null; end if;
  if u.konto_type is distinct from 'privat' then
    return jsonb_build_object('kan_henvise', false, 'grund', 'erhverv');
  end if;
  select * into s from public.henvisning_indstillinger where id;

  select k.kode into v_kode from public.henvisning_koder k where k.bruger_id = v_bruger;
  if v_kode is null then
    for i in 1..5 loop
      begin
        insert into public.henvisning_koder (bruger_id, kode) values (v_bruger, public.henvisning_ny_kode())
        on conflict (bruger_id) do nothing;
        exit;
      exception when unique_violation then
        -- Samme kode findes allerede hos en anden (meget usandsynligt): ny kode.
        null;
      end;
    end loop;
    select k.kode into v_kode from public.henvisning_koder k where k.bruger_id = v_bruger;
    if v_kode is null then
      raise exception 'min_henvisning: koden kunne ikke laves';
    end if;
  end if;

  select count(*) into v_md from public.henvisninger h
   where h.henviser_id = v_bruger and h.status = 'belonnet' and h.maaned = v_maaned;

  return jsonb_build_object(
    'kan_henvise', true,
    'kode', v_kode,
    'sti', '/?ven=' || v_kode,
    'kan_faa_point', public.boost_bruger_spaerret(v_bruger) is null,
    'grund', case when public.boost_bruger_spaerret(v_bruger) is null then null else 'spaerret' end,
    'optjening_aaben', s.optjening_fra_kl is not null and s.optjening_fra_kl <= now(),
    'point_pr_ven', s.point_pr_ven,
    'maks_pr_maaned', s.maks_pr_maaned,
    'maaned', v_maaned,
    'belonnet_denne_maaned', v_md,
    'tilbage_denne_maaned', greatest(s.maks_pr_maaned - v_md, 0),
    'antal_venner', (select count(*) from public.henvisninger h where h.henviser_id = v_bruger),
    'antal_afventer', (select count(*) from public.henvisninger h where h.henviser_id = v_bruger and h.status = 'afventer'),
    'antal_belonnet', (select count(*) from public.henvisninger h where h.henviser_id = v_bruger and h.status = 'belonnet'),
    'point_i_alt', (select coalesce(sum(h.point), 0) from public.henvisninger h where h.henviser_id = v_bruger),
    'venner', coalesce((
      select jsonb_agg(jsonb_build_object(
               'navn', case when x.konto_slettet_kl is not null then 'Slettet bruger'
                            else public.kort_visningsnavn(x.navn) end,
               'status', h.status, 'point', h.point,
               'oprettet_kl', h.oprettet_kl, 'vurderet_kl', h.vurderet_kl)
             order by h.oprettet_kl desc, h.id)
        from (select * from public.henvisninger y where y.henviser_id = v_bruger
               order by y.oprettet_kl desc, y.id limit 100) h
        join public.users x on x.id = h.ven_id), '[]'::jsonb));
end;
$fn$;
revoke all on function public.min_henvisning() from public, anon;
grant execute on function public.min_henvisning() to authenticated, service_role;
