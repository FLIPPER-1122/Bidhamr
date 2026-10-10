-- Erhverv: klager over firmaer (reklamation). Fase 7 i ROADMAP.md:
-- "Reklamation: køber kan se virksomhedens kontaktoplysninger og klage;
-- gentagne klager → advarsel/lukning".
--
-- Regler: ROADMAP-BESLUTNINGER.md, "Erhvervskonti" (reklamation er mellem
-- køber og firma; BidHamr hjælper med kontaktoplysninger, og gentagne klager
-- kan give advarsel/lukning - BidHamr trækker ikke penge tilbage).
--
-- Indhold:
--   1. Tabeller (ASCII-navne, slettes aldrig - handelsdata):
--      erhverv_klager           klagen (kategori, beskrivelse, status, afgørelse)
--      erhverv_klage_billeder   købers billeder (bucket 'erhverv-klage-billeder')
--      erhverv_klage_noter      staffs interne noter og log over kontakt med firmaet
--      erhverv_advarsel_forslag forslag til staff om at give firmaet en advarsel
--      Ingen direkte adgang for anon/authenticated - kun via RPC'erne herunder.
--   2. Køberen (authenticated, auth.uid()):
--      erhverv_klager_handel(p_trade)  status + egne klager på handlen
--      erhverv_klage_opret(...)        opret klage (én åben pr. handel)
--      erhverv_klage_traek_tilbage(p_klage)
--      Fejl kastes med stabilt præfiks + errcode (som BHE01-08):
--        erhverv_klage_ikke_tilladt: …  BHE11 (ikke din handel / ikke et firma /
--                                         ikke betalt / for sent)
--        erhverv_klage_findes: …        BHE12 (der er allerede en åben klage)
--        erhverv_klage_for_mange: …     BHE13 (rate limit)
--        erhverv_klage_ugyldig: …       BHE14 (kategori, beskrivelse, billeder)
--   3. Firmaet (authenticated): firma_klager() - egne klager med status og
--      afgørelse. Aldrig købers beskrivelse, billeder eller kontaktoplysninger.
--   4. Staff (kun service_role, p_staff fra serveren efter assertErhverv;
--      databasen tjekker igen med erhverv_har_adgang - chef og saelger):
--      erhverv_klager_liste, erhverv_klage_detalje, erhverv_klage_behandl,
--      erhverv_klage_note, erhverv_klage_afgoer, erhverv_forslag_giv_advarsel,
--      erhverv_forslag_afvis. Alt logges i moderation_log.
--   5. Forslag om advarsel (chefens valg - til Filips godkendelse):
--      - 3 berettigede klager inden for 12 måneder (regnet fra afgørelsen),
--        som ikke allerede indgår i et forslag, giver et forslag.
--      - Har firmaet allerede fået en advarsel (alle typer), giver HVER ny
--        berettiget klage et nyt forslag.
--      - Højst ét afventende forslag pr. firma; nye berettigede klager lægges
--        ind i det.
--      - Et afvist forslag "bruger" klagerne: der skal 3 nye til (eller 1, hvis
--        firmaet har en advarsel).
--      Advarslen gives af staff (chef eller saelger) - aldrig automatisk.
--      Advarslen er en almindelig advarsel (public.advarsler, grund
--      'erhverv_klage'), så 3-advarsler-reglen (advarsler_tre_foreslaa_lukning)
--      giver et forslag om lukning som for alle andre konti.
--   6. Lukning af en firmakonto kræver chef: bruger_luk_konto_permanent (som
--      både dsa_indgreb og konto_lukning_godkend kalder) og konto_lukning_afvis
--      svarer 'kun_chef' for firmakonti, når kalderen ikke er chef.
--      Begge erstattes med md5-drift-tjek.
--
-- Klagefrist (chefens valg): op til 2 år og 3 måneder efter betalingen
-- (reklamationsretten er 2 år; lidt ekstra, så en afvist reklamation sent i
-- perioden kan nås).
-- Rate limit (chefens valg): højst 3 nye klager pr. køber pr. døgn, 10 pr. 30
-- dage og 3 i alt pr. handel.
--
-- Idempotent (kan køres igen). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper: flet værdier ind i en eksisterende CHECK (som 20261015010000).
-- ---------------------------------------------------------------------------
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_maal_type_check', 'maal_type',
  array['erhverv_klage']);

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['erhverv_klage_behandles', 'erhverv_klage_note', 'erhverv_klage_kontakt',
        'erhverv_klage_afgjort', 'erhverv_forslag_afvist']);

-- null tillades stadig (null = almindelig advarsel; CHECK er sand ved null).
select pg_temp.flet_check('public.advarsler'::regclass, 'advarsler_grund_check', 'grund',
  array['erhverv_klage']);

-- ---------------------------------------------------------------------------
-- 1. Tabeller
-- ---------------------------------------------------------------------------
create table if not exists public.erhverv_advarsel_forslag (
  id               uuid primary key default gen_random_uuid(),
  firma_id         uuid not null references public.firmaer(id) on delete restrict,
  firma_bruger_id  uuid not null references public.users(id) on delete restrict,
  status           text not null default 'afventer'
                   check (status in ('afventer', 'advarsel_givet', 'afvist')),
  -- tre_klager: 3 berettigede klager på 12 måneder. tidligere_advarsel:
  -- firmaet har allerede en advarsel, så hver ny berettiget klage tæller.
  grundlag         text not null check (grundlag in ('tre_klager', 'tidligere_advarsel')),
  antal_klager     integer not null default 0 check (antal_klager >= 0),
  advarsel_id      uuid references public.advarsler(id) on delete restrict,
  begrundelse      text check (begrundelse is null or char_length(begrundelse) <= 2000),
  behandlet_af     uuid references public.users(id) on delete restrict,
  behandlet_kl     timestamptz,
  oprettet_kl      timestamptz not null default now(),
  opdateret_kl     timestamptz not null default now(),
  constraint erhverv_advarsel_forslag_behandlet check (
    (status = 'afventer') = (behandlet_kl is null)
    and (status <> 'advarsel_givet' or advarsel_id is not null)
    and (status <> 'afvist' or begrundelse is not null))
);

create unique index if not exists erhverv_advarsel_forslag_en_afventer
  on public.erhverv_advarsel_forslag (firma_id) where status = 'afventer';
create index if not exists erhverv_advarsel_forslag_firma_idx
  on public.erhverv_advarsel_forslag (firma_id, oprettet_kl desc);

comment on table public.erhverv_advarsel_forslag is
  'Forslag til staff om at give et firma en advarsel efter berettigede klager (erhverv_klage_vurder_forslag). Staff giver advarslen (erhverv_forslag_giv_advarsel) eller afviser (erhverv_forslag_afvis). Slettes aldrig.';

create table if not exists public.erhverv_klager (
  id                     uuid primary key default gen_random_uuid(),
  nummer                 bigint generated always as identity unique,
  trade_id               uuid not null references public.trades(id) on delete restrict,
  firma_id               uuid not null references public.firmaer(id) on delete restrict,
  firma_bruger_id        uuid not null references public.users(id) on delete restrict,
  koeber_id              uuid not null references public.users(id) on delete restrict,
  kategori               text not null check (kategori in (
                           'ikke_som_beskrevet', 'ikke_leveret', 'reklamation_afvist',
                           'fortrydelsesret', 'andet')),
  beskrivelse            text not null check (char_length(btrim(beskrivelse)) between 20 and 4000),
  status                 text not null default 'aaben'
                         check (status in ('aaben', 'under_behandling', 'afsluttet')),
  afgoerelse             text check (afgoerelse is null
                                     or afgoerelse in ('berettiget', 'ikke_berettiget', 'trukket_tilbage')),
  -- Til køber og firma (begge kan se den).
  begrundelse            text check (begrundelse is null or char_length(btrim(begrundelse)) between 1 and 2000),
  behandles_af           uuid references public.users(id) on delete restrict,
  behandling_startet_kl  timestamptz,
  afgjort_af             uuid references public.users(id) on delete restrict,
  afgjort_kl             timestamptz,
  forslag_id             uuid references public.erhverv_advarsel_forslag(id) on delete restrict,
  oprettet_kl            timestamptz not null default now(),
  opdateret_kl           timestamptz not null default now(),
  constraint erhverv_klager_afsluttet check (
    (status = 'afsluttet') = (afgoerelse is not null)
    and (afgoerelse is null) = (afgjort_kl is null)),
  constraint erhverv_klager_afgjort_af_staff check (
    afgoerelse is null or afgoerelse = 'trukket_tilbage'
    or (afgjort_af is not null and begrundelse is not null)),
  constraint erhverv_klager_forslag_kun_berettiget check (
    forslag_id is null or afgoerelse = 'berettiget')
);

-- Højst én åben klage pr. handel.
create unique index if not exists erhverv_klager_en_aaben
  on public.erhverv_klager (trade_id) where status <> 'afsluttet';
create index if not exists erhverv_klager_status_idx
  on public.erhverv_klager (status, oprettet_kl desc);
create index if not exists erhverv_klager_firma_idx
  on public.erhverv_klager (firma_id, oprettet_kl desc);
create index if not exists erhverv_klager_berettiget_idx
  on public.erhverv_klager (firma_id, afgjort_kl) where afgoerelse = 'berettiget';
create index if not exists erhverv_klager_koeber_idx
  on public.erhverv_klager (koeber_id, oprettet_kl desc);
create index if not exists erhverv_klager_trade_idx
  on public.erhverv_klager (trade_id);

comment on table public.erhverv_klager is
  'Købers klager over et firma (erhvervssælger) på en handel. Oprettes kun via erhverv_klage_opret (auth.uid() = køber). Staff (chef/saelger) afgør via erhverv_klage_afgoer. Firmaet ser status og afgørelse via firma_klager. Slettes aldrig.';
comment on column public.erhverv_klager.begrundelse is
  'Staffs begrundelse for afgørelsen. Vises for både køber og firma.';

create table if not exists public.erhverv_klage_billeder (
  id           uuid primary key default gen_random_uuid(),
  klage_id     uuid not null references public.erhverv_klager(id) on delete restrict,
  sti          text not null unique check (char_length(sti) <= 200),
  oprettet_kl  timestamptz not null default now()
);
create index if not exists erhverv_klage_billeder_klage_idx on public.erhverv_klage_billeder (klage_id);

comment on table public.erhverv_klage_billeder is
  'Købers billeder til en klage. Filen ligger i bucket erhverv-klage-billeder (<køber-id>/<handel-id>/<fil>). Firmaet kan ikke se dem. Slettes aldrig.';

create table if not exists public.erhverv_klage_noter (
  id           uuid primary key default gen_random_uuid(),
  klage_id     uuid not null references public.erhverv_klager(id) on delete restrict,
  staff_id     uuid not null references public.users(id) on delete restrict,
  type         text not null check (type in ('note', 'kontakt_firma')),
  kanal        text check (kanal is null or kanal in ('telefon', 'email', 'andet')),
  tekst        text not null check (char_length(btrim(tekst)) between 1 and 4000),
  oprettet_kl  timestamptz not null default now(),
  constraint erhverv_klage_noter_kanal check ((type = 'kontakt_firma') = (kanal is not null))
);
create index if not exists erhverv_klage_noter_klage_idx on public.erhverv_klage_noter (klage_id, oprettet_kl);

comment on table public.erhverv_klage_noter is
  'Interne noter (type note) og log over kontakt med firmaet (type kontakt_firma) på en klage. Kun staff. Slettes og ændres aldrig.';

-- RLS: ingen policies - kun service_role og security definer-funktionerne.
alter table public.erhverv_klager           enable row level security;
alter table public.erhverv_klage_billeder   enable row level security;
alter table public.erhverv_klage_noter      enable row level security;
alter table public.erhverv_advarsel_forslag enable row level security;

revoke all on public.erhverv_klager, public.erhverv_klage_billeder,
              public.erhverv_klage_noter, public.erhverv_advarsel_forslag
  from public, anon, authenticated, service_role;
-- service_role (serveren) kan kun læse; alle ændringer går gennem
-- funktionerne herunder (de kører som ejeren).
grant select on public.erhverv_klager, public.erhverv_klage_billeder,
                public.erhverv_klage_noter, public.erhverv_advarsel_forslag to service_role;

-- Ingen sletning (samme værn som de øvrige erhvervstabeller).
do $$
declare t text;
begin
  foreach t in array array['erhverv_klager', 'erhverv_klage_billeder', 'erhverv_klage_noter', 'erhverv_advarsel_forslag'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_sletning', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.erhverv_ingen_sletning()',
                   t || '_ingen_sletning', t);
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.erhverv_ingen_sletning()',
                   t || '_ingen_truncate', t);
  end loop;
end $$;

-- Noter og billeder ændres aldrig (log/bevis).
create or replace function public.erhverv_klage_uaendrelig()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Dette kan ikke ændres.' using errcode = '42501';
end $$;
revoke all on function public.erhverv_klage_uaendrelig() from public, anon, authenticated;

drop trigger if exists erhverv_klage_noter_uaendrelig on public.erhverv_klage_noter;
create trigger erhverv_klage_noter_uaendrelig
  before update on public.erhverv_klage_noter
  for each row execute function public.erhverv_klage_uaendrelig();
drop trigger if exists erhverv_klage_billeder_uaendrelig on public.erhverv_klage_billeder;
create trigger erhverv_klage_billeder_uaendrelig
  before update on public.erhverv_klage_billeder
  for each row execute function public.erhverv_klage_uaendrelig();

-- Klagen: parter, kategori og beskrivelse kan aldrig ændres, og en afsluttet
-- klage kan ikke genåbnes eller få en anden afgørelse (kun forslag_id kan
-- sættes bagefter af erhverv_klage_vurder_forslag).
create or replace function public.erhverv_klager_beskyt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.trade_id is distinct from old.trade_id
     or new.firma_id is distinct from old.firma_id
     or new.firma_bruger_id is distinct from old.firma_bruger_id
     or new.koeber_id is distinct from old.koeber_id
     or new.kategori is distinct from old.kategori
     or new.beskrivelse is distinct from old.beskrivelse
     or new.nummer is distinct from old.nummer
     or new.oprettet_kl is distinct from old.oprettet_kl then
    raise exception 'Klagens oplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  if old.status = 'afsluttet'
     and (new.status is distinct from old.status
          or new.afgoerelse is distinct from old.afgoerelse
          or new.begrundelse is distinct from old.begrundelse
          or new.afgjort_af is distinct from old.afgjort_af
          or new.afgjort_kl is distinct from old.afgjort_kl) then
    raise exception 'En afsluttet klage kan ikke ændres.' using errcode = '42501';
  end if;
  if old.forslag_id is not null and new.forslag_id is distinct from old.forslag_id then
    raise exception 'Klagen hører allerede til et forslag.' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end $$;
revoke all on function public.erhverv_klager_beskyt() from public, anon, authenticated;

drop trigger if exists erhverv_klager_beskyt on public.erhverv_klager;
create trigger erhverv_klager_beskyt
  before update on public.erhverv_klager
  for each row execute function public.erhverv_klager_beskyt();

-- ---------------------------------------------------------------------------
-- 2. Hjælpere
-- ---------------------------------------------------------------------------

-- Må p_koeber klage over handlen? null = ja (åben klage og grænser tjekkes
-- for sig). Ellers: ikke_fundet (ikke købers handel), ikke_erhverv (sælgeren
-- er ikke et firma), ikke_betalt, for_sent.
create or replace function public.erhverv_klage_adgang(p_koeber uuid, p_trade uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when t.id is null then 'ikke_fundet'
           when f.id is null then 'ikke_erhverv'
           when b.betalt_kl is null then 'ikke_betalt'
           when b.betalt_kl < now() - interval '2 years 3 months' then 'for_sent'
           else null
         end
    from (select 1) x
    left join public.trades t
           on p_koeber is not null and t.id = p_trade and t.buyer_id = p_koeber
    left join public.firmaer f on f.bruger_id = t.seller_id
    left join public.betalinger b on b.trade_id = t.id;
$$;
revoke all on function public.erhverv_klage_adgang(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klage_adgang(uuid, uuid) to service_role;

-- Grænser for nye klager (rate limit). null = ok, ellers 'for_mange'.
create or replace function public.erhverv_klage_graense(p_koeber uuid, p_trade uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when (select count(*) from public.erhverv_klager k where k.trade_id = p_trade) >= 3
             then 'for_mange_handel'
           when (select count(*) from public.erhverv_klager k
                  where k.koeber_id = p_koeber and k.oprettet_kl > now() - interval '24 hours') >= 3
             then 'for_mange'
           when (select count(*) from public.erhverv_klager k
                  where k.koeber_id = p_koeber and k.oprettet_kl > now() - interval '30 days') >= 10
             then 'for_mange'
           else null
         end;
$$;
revoke all on function public.erhverv_klage_graense(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klage_graense(uuid, uuid) to service_role;

-- Er staff inhabil over for firmaet (har selv handlet med det)? Et firma kan
-- ikke købe, så kun staff som køber hos firmaet tæller - begge retninger
-- tjekkes alligevel.
create or replace function public.erhverv_klage_inhabil(p_staff uuid, p_firma_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trades t
     where (t.buyer_id = p_staff and t.seller_id = p_firma_bruger)
        or (t.seller_id = p_staff and t.buyer_id = p_firma_bruger));
$$;
revoke all on function public.erhverv_klage_inhabil(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klage_inhabil(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Storage: bucket 'erhverv-klage-billeder' (privat)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('erhverv-klage-billeder', 'erhverv-klage-billeder', false, 10485760,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Upload kun i købers egen mappe (<eget id>/<handel-id>/<fil>) på en handel,
-- han må klage over. Højst 30 filer pr. handel (misbrugsværn - en klage
-- bruger højst 6).
create or replace function public.erhverv_klage_billede_maa_uploade(p_sti text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bruger uuid := auth.uid();
  v_dele   text[] := string_to_array(coalesce(p_sti, ''), '/');
  v_trade  uuid;
begin
  if v_bruger is null or coalesce(array_length(v_dele, 1), 0) <> 3 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if v_dele[3] !~ '^[A-Za-z0-9._-]{1,100}$' then return false; end if;
  v_trade := v_dele[2]::uuid;

  if public.erhverv_klage_adgang(v_bruger, v_trade) is not null then
    return false;
  end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'erhverv-klage-billeder'
             and o.name like v_bruger::text || '/' || v_trade::text || '/%') < 30;
end;
$$;
revoke all on function public.erhverv_klage_billede_maa_uploade(text) from public, anon, service_role;
grant execute on function public.erhverv_klage_billede_maa_uploade(text) to authenticated;

drop policy if exists "erhverv_klage_billeder_upload_koeber" on storage.objects;
create policy "erhverv_klage_billeder_upload_koeber"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'erhverv-klage-billeder'
    and public.erhverv_klage_billede_maa_uploade(name)
  );

-- Kun uploaderen selv læser direkte. Staff får signerede links fra serveren
-- (service role). Firmaet kan ikke se billederne.
drop policy if exists "erhverv_klage_billeder_laes_egne" on storage.objects;
create policy "erhverv_klage_billeder_laes_egne"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'erhverv-klage-billeder'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

-- Ingen update/delete-policies: bevis kan ikke overskrives eller slettes.

-- ---------------------------------------------------------------------------
-- 4. Køberen
-- ---------------------------------------------------------------------------

-- Status og egne klager på handlen. null, hvis handlen ikke er købers, eller
-- sælgeren ikke er et firma (så viser UI ingenting).
-- { kan_klage, grund (null | aaben_findes | for_mange | for_mange_handel |
--   ikke_betalt | for_sent), klager: [...] }
create or replace function public.erhverv_klager_handel(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_grund  text;
begin
  if v_uid is null then return null; end if;
  v_grund := public.erhverv_klage_adgang(v_uid, p_trade);
  if v_grund in ('ikke_fundet', 'ikke_erhverv') then return null; end if;

  if v_grund is null and exists (select 1 from public.erhverv_klager k
                                  where k.trade_id = p_trade and k.status <> 'afsluttet') then
    v_grund := 'aaben_findes';
  end if;
  if v_grund is null then
    v_grund := public.erhverv_klage_graense(v_uid, p_trade);
  end if;

  return jsonb_build_object(
    'kan_klage', v_grund is null,
    'grund', v_grund,
    'klager', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id,
               'nummer', k.nummer,
               'kategori', k.kategori,
               'beskrivelse', k.beskrivelse,
               'status', k.status,
               'afgoerelse', k.afgoerelse,
               'begrundelse', k.begrundelse,
               'oprettet_kl', k.oprettet_kl,
               'afgjort_kl', k.afgjort_kl,
               'billeder', coalesce((select jsonb_agg(b.sti order by b.oprettet_kl)
                                       from public.erhverv_klage_billeder b
                                      where b.klage_id = k.id), '[]'::jsonb))
             order by k.oprettet_kl desc)
        from public.erhverv_klager k
       where k.trade_id = p_trade and k.koeber_id = v_uid), '[]'::jsonb));
end;
$$;
revoke all on function public.erhverv_klager_handel(uuid) from public, anon;
grant execute on function public.erhverv_klager_handel(uuid) to authenticated;

-- Køberen opretter en klage. p_billeder: [{ "sti": "<eget id>/<handel>/<fil>" }]
-- (højst 6, uploadet til 'erhverv-klage-billeder' først).
-- Returnerer { kode: 'ok', klage_id, nummer }. Fejl kastes (BHE11-BHE14).
create or replace function public.erhverv_klage_opret(
  p_trade       uuid,
  p_kategori    text,
  p_beskrivelse text,
  p_billeder    jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_beskr    text := btrim(coalesce(p_beskrivelse, ''));
  v_billeder jsonb := coalesce(p_billeder, '[]'::jsonb);
  v_grund    text;
  t          record;
  f          record;
  e          jsonb;
  v_sti      text;
  v_stier    text[] := '{}';
  v_id       uuid;
  v_nummer   bigint;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  -- Validering først (billig).
  if p_kategori is null or p_kategori not in
     ('ikke_som_beskrevet', 'ikke_leveret', 'reklamation_afvist', 'fortrydelsesret', 'andet') then
    raise exception 'erhverv_klage_ugyldig: Vælg, hvad klagen handler om.' using errcode = 'BHE14';
  end if;
  if char_length(v_beskr) < 20 or char_length(v_beskr) > 4000 then
    raise exception 'erhverv_klage_ugyldig: Beskrivelsen skal være mellem 20 og 4000 tegn.' using errcode = 'BHE14';
  end if;
  if jsonb_typeof(v_billeder) <> 'array' or jsonb_array_length(v_billeder) > 6 then
    raise exception 'erhverv_klage_ugyldig: Du kan højst vedhæfte 6 billeder.' using errcode = 'BHE14';
  end if;

  -- Serialisér pr. handel og pr. køber (én åben klage, rate limit).
  perform pg_advisory_xact_lock(hashtextextended('erhverv_klage_handel:' || coalesce(p_trade::text, ''), 0));
  perform pg_advisory_xact_lock(hashtextextended('erhverv_klage_koeber:' || v_uid::text, 0));

  v_grund := public.erhverv_klage_adgang(v_uid, p_trade);
  if v_grund in ('ikke_fundet', 'ikke_erhverv') then
    -- Samme svar, uanset om handlen findes - afslører ikke andres handler.
    raise exception 'erhverv_klage_ikke_tilladt: Handlen findes ikke, eller du kan ikke klage over den.' using errcode = 'BHE11';
  elsif v_grund = 'ikke_betalt' then
    raise exception 'erhverv_klage_ikke_tilladt: Du kan først klage, når handlen er betalt.' using errcode = 'BHE11';
  elsif v_grund = 'for_sent' then
    raise exception 'erhverv_klage_ikke_tilladt: Fristen for at klage over handlen er udløbet.' using errcode = 'BHE11';
  end if;

  if exists (select 1 from public.erhverv_klager k
              where k.trade_id = p_trade and k.status <> 'afsluttet') then
    raise exception 'erhverv_klage_findes: Der er allerede en åben klage på denne handel.' using errcode = 'BHE12';
  end if;

  v_grund := public.erhverv_klage_graense(v_uid, p_trade);
  if v_grund = 'for_mange_handel' then
    raise exception 'erhverv_klage_for_mange: Du har klaget over denne handel det største antal gange. Kontakt BidHamr, hvis der er mere.' using errcode = 'BHE13';
  elsif v_grund is not null then
    raise exception 'erhverv_klage_for_mange: Du har oprettet mange klager på kort tid. Prøv igen senere.' using errcode = 'BHE13';
  end if;

  -- Billeder: egne, på denne handel, findes i storage, ikke brugt før.
  for e in select * from jsonb_array_elements(v_billeder) loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'erhverv_klage_ugyldig: Et billede er ugyldigt.' using errcode = 'BHE14';
    end if;
    v_sti := e->>'sti';
    if v_sti is null
       or v_sti !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'
       or split_part(v_sti, '/', 1) <> v_uid::text
       or split_part(v_sti, '/', 2) <> p_trade::text
       or v_sti = any(v_stier) then
      raise exception 'erhverv_klage_ugyldig: Et billede er ugyldigt.' using errcode = 'BHE14';
    end if;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'erhverv-klage-billeder' and o.name = v_sti) then
      raise exception 'erhverv_klage_ugyldig: Et billede mangler. Prøv at vedhæfte det igen.' using errcode = 'BHE14';
    end if;
    if exists (select 1 from public.erhverv_klage_billeder b where b.sti = v_sti) then
      raise exception 'erhverv_klage_ugyldig: Et billede er ugyldigt.' using errcode = 'BHE14';
    end if;
    v_stier := v_stier || v_sti;
  end loop;

  select tr.id, tr.seller_id into t from public.trades tr where tr.id = p_trade;
  select fm.id into f from public.firmaer fm where fm.bruger_id = t.seller_id;

  begin
    insert into public.erhverv_klager (trade_id, firma_id, firma_bruger_id, koeber_id, kategori, beskrivelse)
    values (p_trade, f.id, t.seller_id, v_uid, p_kategori, v_beskr)
    returning id, nummer into v_id, v_nummer;
  exception when unique_violation then
    raise exception 'erhverv_klage_findes: Der er allerede en åben klage på denne handel.' using errcode = 'BHE12';
  end;

  insert into public.erhverv_klage_billeder (klage_id, sti)
  select v_id, s from unnest(v_stier) s;

  return jsonb_build_object('kode', 'ok', 'klage_id', v_id, 'nummer', v_nummer);
end;
$$;
revoke all on function public.erhverv_klage_opret(uuid, text, text, jsonb) from public, anon;
grant execute on function public.erhverv_klage_opret(uuid, text, text, jsonb) to authenticated;

-- Køberen trækker sin klage tilbage (fx fordi firmaet har løst det).
-- { kode: 'ok' } | { kode: 'afsluttet' } (allerede afsluttet - dobbeltklik).
create or replace function public.erhverv_klage_traek_tilbage(p_klage uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  k     record;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select kl.id, kl.status, kl.trade_id into k
    from public.erhverv_klager kl
   where kl.id = p_klage and kl.koeber_id = v_uid;
  if not found then
    raise exception 'erhverv_klage_ikke_tilladt: Klagen findes ikke.' using errcode = 'BHE11';
  end if;

  update public.erhverv_klager
     set status = 'afsluttet', afgoerelse = 'trukket_tilbage', afgjort_kl = now()
   where id = p_klage and koeber_id = v_uid and status in ('aaben', 'under_behandling');
  if not found then
    return jsonb_build_object('kode', 'afsluttet', 'trade_id', k.trade_id);
  end if;
  return jsonb_build_object('kode', 'ok', 'trade_id', k.trade_id);
end;
$$;
revoke all on function public.erhverv_klage_traek_tilbage(uuid) from public, anon;
grant execute on function public.erhverv_klage_traek_tilbage(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Firmaet
-- ---------------------------------------------------------------------------

-- Firmaets egne klager. null, hvis brugeren ikke er en firmakonto.
-- Kun kategori, status, afgørelse og begrundelse - aldrig købers beskrivelse,
-- billeder, navn eller kontaktoplysninger (dem viser handlen selv).
create or replace function public.firma_klager()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  f     record;
begin
  if v_uid is null then return null; end if;
  select fm.id into f from public.firmaer fm where fm.bruger_id = v_uid;
  if not found then return null; end if;

  return jsonb_build_object(
    'berettigede_12_mdr', (select count(*) from public.erhverv_klager k
                            where k.firma_id = f.id and k.afgoerelse = 'berettiget'
                              and k.afgjort_kl > now() - interval '12 months'),
    'klager', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id,
               'nummer', k.nummer,
               'trade_id', k.trade_id,
               'titel', a.titel,
               'kategori', k.kategori,
               'status', k.status,
               'afgoerelse', k.afgoerelse,
               'begrundelse', case when k.status = 'afsluttet' then k.begrundelse end,
               'oprettet_kl', k.oprettet_kl,
               'afgjort_kl', k.afgjort_kl)
             order by k.oprettet_kl desc)
        from (select * from public.erhverv_klager k0
               where k0.firma_id = f.id
               order by k0.oprettet_kl desc
               limit 500) k
        left join public.trades t on t.id = k.trade_id
        left join public.auctions a on a.id = t.auction_id), '[]'::jsonb));
end;
$$;
revoke all on function public.firma_klager() from public, anon;
grant execute on function public.firma_klager() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Forslag om advarsel (intern - kaldes kun af erhverv_klage_afgoer)
-- ---------------------------------------------------------------------------
-- Returnerer { forslag_id, ny } eller null (intet forslag).
create or replace function public.erhverv_klage_vurder_forslag(p_firma uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  f            record;
  v_forslag    uuid;
  v_ny         boolean := false;
  v_tidligere  boolean;
  v_antal      integer;
  v_graense    integer;
begin
  -- Serialisér pr. firma (samtidige afgørelser).
  perform pg_advisory_xact_lock(hashtextextended('erhverv_forslag:' || p_firma::text, 0));
  select fm.id, fm.bruger_id into f from public.firmaer fm where fm.id = p_firma;
  if not found then return null; end if;

  v_tidligere := exists (select 1 from public.advarsler a where a.bruger_id = f.bruger_id);

  select count(*) into v_antal
    from public.erhverv_klager k
   where k.firma_id = f.id
     and k.afgoerelse = 'berettiget'
     and k.forslag_id is null
     and k.afgjort_kl > now() - interval '12 months';

  select fs.id into v_forslag
    from public.erhverv_advarsel_forslag fs
   where fs.firma_id = f.id and fs.status = 'afventer'
   for update;

  if v_forslag is null then
    -- 3 berettigede klager, eller 1, hvis firmaet allerede har en advarsel.
    v_graense := 3;
    if v_tidligere then
      v_graense := 1;
    end if;
    if v_antal < v_graense then
      return null;
    end if;
    insert into public.erhverv_advarsel_forslag (firma_id, firma_bruger_id, grundlag)
    values (f.id, f.bruger_id, case when v_tidligere then 'tidligere_advarsel' else 'tre_klager' end)
    returning id into v_forslag;
    v_ny := true;
  end if;

  update public.erhverv_klager k
     set forslag_id = v_forslag
   where k.firma_id = f.id
     and k.afgoerelse = 'berettiget'
     and k.forslag_id is null
     and k.afgjort_kl > now() - interval '12 months';

  update public.erhverv_advarsel_forslag fs
     set antal_klager = (select count(*) from public.erhverv_klager k where k.forslag_id = v_forslag),
         opdateret_kl = now()
   where fs.id = v_forslag;

  return jsonb_build_object('forslag_id', v_forslag, 'ny', v_ny);
end;
$$;
revoke all on function public.erhverv_klage_vurder_forslag(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Staff (kun service_role; p_staff fra serveren, tjekkes igen her)
-- ---------------------------------------------------------------------------

-- Liste. p_status: aaben | under_behandling | afsluttet (null = alle).
-- p_firma: kun ét firma (firmaer.id), valgfri.
create or replace function public.erhverv_klager_liste(p_staff uuid, p_status text default null, p_firma uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  return jsonb_build_object(
    'kode', 'ok',
    'antal', (select jsonb_build_object(
                'aaben', count(*) filter (where k.status = 'aaben'),
                'under_behandling', count(*) filter (where k.status = 'under_behandling'),
                'afsluttet', count(*) filter (where k.status = 'afsluttet'))
                from public.erhverv_klager k
               where p_firma is null or k.firma_id = p_firma),
    'klager', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id,
               'nummer', k.nummer,
               'trade_id', k.trade_id,
               'titel', a.titel,
               'firma_id', k.firma_id,
               'firmanavn', fm.firmanavn,
               'cvr', fm.cvr,
               'koeber_navn', ku.navn,
               'kategori', k.kategori,
               'status', k.status,
               'afgoerelse', k.afgoerelse,
               'oprettet_kl', k.oprettet_kl,
               'afgjort_kl', k.afgjort_kl,
               'behandles_af_navn', bu.navn,
               'antal_noter', (select count(*) from public.erhverv_klage_noter n where n.klage_id = k.id))
             order by k.oprettet_kl desc)
        from (select * from public.erhverv_klager k0
               where (p_status is null or k0.status = p_status)
                 and (p_firma is null or k0.firma_id = p_firma)
               order by k0.oprettet_kl desc
               limit 500) k
        join public.firmaer fm on fm.id = k.firma_id
        left join public.users ku on ku.id = k.koeber_id
        left join public.users bu on bu.id = k.behandles_af
        left join public.trades t on t.id = k.trade_id
        left join public.auctions a on a.id = t.auction_id), '[]'::jsonb),
    'forslag', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', fs.id,
               'firma_id', fs.firma_id,
               'firma_bruger_id', fs.firma_bruger_id,
               'firmanavn', fm.firmanavn,
               'cvr', fm.cvr,
               'grundlag', fs.grundlag,
               'antal_klager', fs.antal_klager,
               'advarsler_antal', (select count(*) from public.advarsler a where a.bruger_id = fs.firma_bruger_id),
               'oprettet_kl', fs.oprettet_kl)
             order by fs.oprettet_kl)
        from public.erhverv_advarsel_forslag fs
        join public.firmaer fm on fm.id = fs.firma_id
       where fs.status = 'afventer'
         and (p_firma is null or fs.firma_id = p_firma)), '[]'::jsonb));
end;
$$;
revoke all on function public.erhverv_klager_liste(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klager_liste(uuid, text, uuid) to service_role;

-- Én klage med alt til staff. Købers e-mail kun for chef (som
-- firma_faktura_salg: rollen saelger ser ikke købers kontaktoplysninger).
create or replace function public.erhverv_klage_detalje(p_staff uuid, p_klage uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_chef boolean;
  k      record;
  fm     record;
  fs     record;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  v_chef := public.erhverv_har_adgang(p_staff, true);

  select * into k from public.erhverv_klager where id = p_klage;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select * into fm from public.firmaer where id = k.firma_id;
  select * into fs from public.erhverv_advarsel_forslag
   where firma_id = k.firma_id and status = 'afventer';

  return jsonb_build_object(
    'kode', 'ok',
    'er_chef', v_chef,
    'inhabil', public.erhverv_klage_inhabil(p_staff, k.firma_bruger_id) or p_staff = k.koeber_id,
    'klage', jsonb_build_object(
      'id', k.id, 'nummer', k.nummer, 'trade_id', k.trade_id, 'kategori', k.kategori,
      'beskrivelse', k.beskrivelse, 'status', k.status, 'afgoerelse', k.afgoerelse,
      'begrundelse', k.begrundelse, 'oprettet_kl', k.oprettet_kl, 'afgjort_kl', k.afgjort_kl,
      'afgjort_af_navn', (select u.navn from public.users u where u.id = k.afgjort_af),
      'behandles_af_navn', (select u.navn from public.users u where u.id = k.behandles_af),
      'behandling_startet_kl', k.behandling_startet_kl,
      'forslag_id', k.forslag_id),
    'billeder', coalesce((select jsonb_agg(b.sti order by b.oprettet_kl)
                            from public.erhverv_klage_billeder b where b.klage_id = k.id), '[]'::jsonb),
    'noter', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', n.id, 'type', n.type, 'kanal', n.kanal, 'tekst', n.tekst,
               'oprettet_kl', n.oprettet_kl, 'staff_navn', u.navn)
             order by n.oprettet_kl)
        from public.erhverv_klage_noter n
        left join public.users u on u.id = n.staff_id
       where n.klage_id = k.id), '[]'::jsonb),
    'handel', (
      select jsonb_build_object(
               'id', t.id, 'titel', a.titel, 'beloeb', t.amount, 'status', t.status,
               'oprettet_kl', t.created_at, 'afhentning', coalesce(t.afhentning, false),
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl,
               'sendt_kl', t.sendt_kl, 'modtaget_kl', t.received_at)
        from public.trades t
        left join public.auctions a on a.id = t.auction_id
        left join public.betalinger b on b.trade_id = t.id
       where t.id = k.trade_id),
    'firma', jsonb_build_object(
      'id', fm.id, 'bruger_id', fm.bruger_id, 'firmanavn', fm.firmanavn, 'cvr', fm.cvr,
      'kontaktperson', fm.kontaktperson, 'telefon', fm.telefon, 'kontakt_email', fm.kontakt_email,
      'adresse', fm.adresse, 'postnummer', fm.postnummer, 'bynavn', fm.bynavn,
      'abonnement_status', fm.abonnement_status,
      'konto_lukket', exists (select 1 from public.users u where u.id = fm.bruger_id and u.konto_lukket_kl is not null)),
    'koeber', (
      select jsonb_build_object(
               'id', u.id, 'navn', u.navn,
               'email', case when v_chef then coalesce(nullif(btrim(u.email), ''),
                               (select au.email::text from auth.users au where au.id = u.id)) end)
        from public.users u where u.id = k.koeber_id),
    'statistik', jsonb_build_object(
      'klager_i_alt', (select count(*) from public.erhverv_klager x where x.firma_id = k.firma_id),
      'berettigede_12_mdr', (select count(*) from public.erhverv_klager x
                              where x.firma_id = k.firma_id and x.afgoerelse = 'berettiget'
                                and x.afgjort_kl > now() - interval '12 months'),
      'advarsler_antal', (select count(*) from public.advarsler a where a.bruger_id = k.firma_bruger_id),
      'afventende_forslag', case when fs.id is null then null else jsonb_build_object(
                              'id', fs.id, 'grundlag', fs.grundlag, 'antal_klager', fs.antal_klager,
                              'oprettet_kl', fs.oprettet_kl) end,
      'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag l
                                     where l.bruger_id = k.firma_bruger_id and l.status = 'afventer')));
end;
$$;
revoke all on function public.erhverv_klage_detalje(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klage_detalje(uuid, uuid) to service_role;

-- "Tag klagen": aaben -> under_behandling. Idempotent (dobbeltklik giver
-- 'uaendret').
create or replace function public.erhverv_klage_behandl(p_staff uuid, p_klage uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k record;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select * into k from public.erhverv_klager where id = p_klage;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_staff = k.koeber_id or public.erhverv_klage_inhabil(p_staff, k.firma_bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.erhverv_klager
     set status = 'under_behandling', behandles_af = p_staff, behandling_startet_kl = now()
   where id = p_klage and status = 'aaben';
  if not found then return jsonb_build_object('kode', 'uaendret'); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_klage_behandles', 'erhverv_klage', k.id, k.firma_bruger_id,
          'Klage nr. ' || k.nummer || ' sat under behandling');
  return jsonb_build_object('kode', 'ok');
end;
$$;
revoke all on function public.erhverv_klage_behandl(uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_klage_behandl(uuid, uuid) to service_role;

-- Intern note eller log over kontakt med firmaet. p_type: note | kontakt_firma
-- (p_kanal: telefon | email | andet). En åben klage sættes under behandling.
create or replace function public.erhverv_klage_note(
  p_staff uuid, p_klage uuid, p_type text, p_kanal text, p_tekst text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k       record;
  v_tekst text := btrim(coalesce(p_tekst, ''));
  v_kanal text := case when p_type = 'kontakt_firma' then p_kanal end;
  v_id    uuid;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_type is null or p_type not in ('note', 'kontakt_firma') then
    return jsonb_build_object('kode', 'ugyldig_type');
  end if;
  if p_type = 'kontakt_firma' and (v_kanal is null or v_kanal not in ('telefon', 'email', 'andet')) then
    return jsonb_build_object('kode', 'ugyldig_kanal');
  end if;
  if char_length(v_tekst) < 1 then return jsonb_build_object('kode', 'tekst_mangler'); end if;
  if char_length(v_tekst) > 4000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select * into k from public.erhverv_klager where id = p_klage for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_staff = k.koeber_id or public.erhverv_klage_inhabil(p_staff, k.firma_bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- Dobbeltklik: samme tekst fra samme staff inden for 30 sekunder.
  if exists (select 1 from public.erhverv_klage_noter n
              where n.klage_id = k.id and n.staff_id = p_staff and n.tekst = v_tekst
                and n.oprettet_kl > now() - interval '30 seconds') then
    return jsonb_build_object('kode', 'uaendret');
  end if;

  insert into public.erhverv_klage_noter (klage_id, staff_id, type, kanal, tekst)
  values (k.id, p_staff, p_type, v_kanal, v_tekst)
  returning id into v_id;

  update public.erhverv_klager
     set status = 'under_behandling', behandles_af = p_staff, behandling_startet_kl = now()
   where id = k.id and status = 'aaben';

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff,
          case when p_type = 'kontakt_firma' then 'erhverv_klage_kontakt' else 'erhverv_klage_note' end,
          'erhverv_klage', k.id, k.firma_bruger_id,
          left('Klage nr. ' || k.nummer
               || case when p_type = 'kontakt_firma' then ' | Kontakt med firmaet (' || v_kanal || ')' else ' | Note' end
               || ' | ' || v_tekst, 4000));

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end;
$$;
revoke all on function public.erhverv_klage_note(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_klage_note(uuid, uuid, text, text, text) to service_role;

-- Afgør klagen: berettiget | ikke_berettiget, med begrundelse (til køber og
-- firma). Idempotent: kun fra aaben/under_behandling. Berettiget kører
-- forslagsreglen.
-- { kode: 'ok', trade_id, koeber_id, firma_bruger_id, nummer, afgoerelse,
--   forslag_id, forslag_ny } | { kode: ingen_adgang | ugyldig_afgoerelse |
--   begrundelse_mangler | for_lang_tekst | ikke_fundet | inhabil | afsluttet }
create or replace function public.erhverv_klage_afgoer(
  p_staff uuid, p_klage uuid, p_afgoerelse text, p_begrundelse text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  k        record;
  v_grund  text := btrim(coalesce(p_begrundelse, ''));
  v_fs     jsonb;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_afgoerelse is null or p_afgoerelse not in ('berettiget', 'ikke_berettiget') then
    return jsonb_build_object('kode', 'ugyldig_afgoerelse');
  end if;
  if char_length(v_grund) < 1 then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select * into k from public.erhverv_klager where id = p_klage for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_staff = k.koeber_id or public.erhverv_klage_inhabil(p_staff, k.firma_bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.erhverv_klager
     set status = 'afsluttet', afgoerelse = p_afgoerelse, begrundelse = v_grund,
         afgjort_af = p_staff, afgjort_kl = now(),
         behandles_af = coalesce(behandles_af, p_staff),
         behandling_startet_kl = coalesce(behandling_startet_kl, now())
   where id = k.id and status in ('aaben', 'under_behandling');
  if not found then return jsonb_build_object('kode', 'afsluttet'); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_klage_afgjort', 'erhverv_klage', k.id, k.firma_bruger_id,
          left('Klage nr. ' || k.nummer || ' afgjort: '
               || case when p_afgoerelse = 'berettiget' then 'berettiget' else 'ikke berettiget' end
               || ' | ' || v_grund, 4000));

  if p_afgoerelse = 'berettiget' then
    v_fs := public.erhverv_klage_vurder_forslag(k.firma_id);
  end if;

  return jsonb_build_object(
    'kode', 'ok', 'trade_id', k.trade_id, 'koeber_id', k.koeber_id,
    'firma_bruger_id', k.firma_bruger_id, 'nummer', k.nummer, 'afgoerelse', p_afgoerelse,
    'forslag_id', v_fs->>'forslag_id', 'forslag_ny', coalesce((v_fs->>'ny')::boolean, false));
end;
$$;
revoke all on function public.erhverv_klage_afgoer(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_klage_afgoer(uuid, uuid, text, text) to service_role;

-- Giv firmaet en advarsel ud fra et forslag (chef eller saelger). Samme
-- advarsel som alle andre (public.advarsler): brugeren får besked via
-- notifikations-cron'en, og 3 advarsler giver et forslag om lukning
-- (advarsler_tre_foreslaa_lukning) - lukningen godkendes kun af chef.
-- { kode: 'ok', advarsel_id, advarsler_antal, lukning_foreslaaet } eller
-- ingen_adgang | begrundelse_bruger_mangler | begrundelse_bruger_for_lang |
-- for_lang_tekst | ikke_fundet | behandlet | inhabil | konto_lukket
create or replace function public.erhverv_forslag_giv_advarsel(
  p_staff uuid, p_forslag uuid, p_begrundelse_bruger text, p_intern_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bruger text := nullif(btrim(coalesce(p_begrundelse_bruger, '')), '');
  v_note   text := nullif(btrim(coalesce(p_intern_note, '')), '');
  v_firma_bruger uuid;
  u        record;
  fs       record;
  v_id     uuid;
  v_antal  integer;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_bruger is null then return jsonb_build_object('kode', 'begrundelse_bruger_mangler'); end if;
  if char_length(v_bruger) > 1000 then return jsonb_build_object('kode', 'begrundelse_bruger_for_lang'); end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select firma_bruger_id into v_firma_bruger from public.erhverv_advarsel_forslag where id = p_forslag;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_staff = v_firma_bruger or public.erhverv_klage_inhabil(p_staff, v_firma_bruger) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  -- Låserækkefølge som admin_advar_bruger og advarsler_tre_foreslaa_lukning:
  -- bruger -> (forslag).
  select id, konto_lukket_kl into u from public.users where id = v_firma_bruger for no key update;
  select * into fs from public.erhverv_advarsel_forslag where id = p_forslag for update;
  if fs.status <> 'afventer' then
    return jsonb_build_object('kode', 'behandlet', 'status', fs.status);
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'konto_lukket');
  end if;

  insert into public.advarsler (bruger_id, oprettet_af, aarsag, begrundelse_bruger, grund)
  values (v_firma_bruger, p_staff, v_note, v_bruger, 'erhverv_klage')
  returning id into v_id;

  update public.erhverv_advarsel_forslag
     set status = 'advarsel_givet', advarsel_id = v_id, behandlet_af = p_staff,
         behandlet_kl = now(), begrundelse = v_note, opdateret_kl = now()
   where id = fs.id and status = 'afventer';

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'advarsel', 'bruger', v_firma_bruger, v_firma_bruger,
          left('Erhverv: advarsel efter ' || fs.antal_klager || ' berettigede klager (forslag ' || fs.id::text || ')'
               || coalesce(' | ' || v_note, '') || ' | Til firmaet: ' || v_bruger, 4000));

  select count(*) into v_antal from public.advarsler where bruger_id = v_firma_bruger;

  return jsonb_build_object(
    'kode', 'ok', 'advarsel_id', v_id, 'firma_bruger_id', v_firma_bruger,
    'advarsler_antal', v_antal,
    'lukning_foreslaaet', exists (select 1 from public.konto_lukning_forslag l
                                   where l.bruger_id = v_firma_bruger and l.status = 'afventer'));
end;
$$;
revoke all on function public.erhverv_forslag_giv_advarsel(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_forslag_giv_advarsel(uuid, uuid, text, text) to service_role;

-- Afvis et forslag (ingen advarsel). Begrundelse (intern) påkrævet.
create or replace function public.erhverv_forslag_afvis(p_staff uuid, p_forslag uuid, p_begrundelse text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  fs      record;
begin
  if not public.erhverv_har_adgang(p_staff) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select * into fs from public.erhverv_advarsel_forslag where id = p_forslag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if fs.status <> 'afventer' then
    return jsonb_build_object('kode', 'behandlet', 'status', fs.status);
  end if;
  if p_staff = fs.firma_bruger_id or public.erhverv_klage_inhabil(p_staff, fs.firma_bruger_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.erhverv_advarsel_forslag
     set status = 'afvist', begrundelse = v_grund, behandlet_af = p_staff,
         behandlet_kl = now(), opdateret_kl = now()
   where id = fs.id and status = 'afventer';

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_forslag_afvist', 'firma', fs.firma_id, fs.firma_bruger_id,
          left('Forslag om advarsel afvist (' || fs.antal_klager || ' berettigede klager, forslag '
               || fs.id::text || ') | ' || v_grund, 4000));

  return jsonb_build_object('kode', 'ok', 'firma_bruger_id', fs.firma_bruger_id);
end;
$$;
revoke all on function public.erhverv_forslag_afvis(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.erhverv_forslag_afvis(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Lukning af en firmakonto kræver chef
-- ---------------------------------------------------------------------------
-- bruger_luk_konto_permanent kaldes af dsa_indgreb (luk konto) og
-- konto_lukning_godkend (3 advarsler). Kopieret præcist fra
-- 20261003011000_sager_rettelser.sql med ét nyt tjek: er brugeren en
-- firmakonto, skal medarbejderen være chef ('kun_chef').
do $$
declare
  v_md5 text;
begin
  select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_md5
    from pg_proc p
   where p.oid = 'public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)'::regprocedure;
  if v_md5 is distinct from '664e673cfd531acd6371e3dd948da1e1'
     and v_md5 is distinct from 'af779e44c42d90dc60ce6c36580ba8be' then
    raise exception 'bruger_luk_konto_permanent er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

create or replace function public.bruger_luk_konto_permanent(
  p_medarbejder uuid,
  p_bruger      uuid,
  p_aarsag      text,
  p_sag         uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_aarsag text := nullif(btrim(coalesce(p_aarsag, '')), '');
  u        record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_aarsag is null then return jsonb_build_object('kode', 'aarsag_mangler'); end if;
  if char_length(v_aarsag) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_medarbejder then return jsonb_build_object('kode', 'sig_selv'); end if;

  select * into u from public.users where id = p_bruger for update;
  if not found then return jsonb_build_object('kode', 'ugyldig_bruger'); end if;
  if u.rolle in ('medarbejder', 'admin', 'chef') then
    return jsonb_build_object('kode', 'staff');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'allerede_lukket');
  end if;
  -- Erhverv (20261016010000): en firmakonto lukkes kun af chef.
  if u.konto_type = 'erhverv' and not public.erhverv_har_adgang(p_medarbejder, true) then
    return jsonb_build_object('kode', 'kun_chef');
  end if;
  if p_sag is not null and not exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where s.id = p_sag and (t.buyer_id = p_bruger or t.seller_id = p_bruger)) then
    return jsonb_build_object('kode', 'ugyldig_sag');
  end if;
  if exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where (s.id = p_sag
            and (t.buyer_id = p_medarbejder or t.seller_id = p_medarbejder))
        or (t.buyer_id = p_medarbejder and t.seller_id = p_bruger)
        or (t.seller_id = p_medarbejder and t.buyer_id = p_bruger)) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.users
     set suspenderet = true,
         suspenderet_aarsag = v_aarsag,
         suspenderet_kl = now(),
         suspenderet_til = null,
         konto_lukket_kl = now(),
         konto_lukket_af = p_medarbejder
   where id = p_bruger;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'konto_lukket', 'bruger', p_bruger, p_bruger,
          left('Konto lukket permanent' || coalesce(' (sag ' || p_sag::text || ')', '')
               || ' | ' || v_aarsag, 4000));

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)
  to service_role;

-- konto_lukning_afvis: også at afvise et forslag om at lukke en firmakonto
-- kræver chef. Kopieret præcist fra 20261003050000_indpakning_advarsel.sql
-- med ét nyt tjek.
do $$
declare
  v_md5 text;
begin
  select md5(replace(p.prosrc, E'\r\n', E'\n')) into v_md5
    from pg_proc p
   where p.oid = 'public.konto_lukning_afvis(uuid, uuid, text)'::regprocedure;
  if v_md5 is distinct from '18882b17fc7fc174c5f525318188b23d'
     and v_md5 is distinct from 'b404c345538befc52c9867dc8910f3ac' then
    raise exception 'konto_lukning_afvis er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

create or replace function public.konto_lukning_afvis(
  p_medarbejder uuid,
  p_forslag     uuid,
  p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f      record;
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_grund) > 2000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select * into f from public.konto_lukning_forslag where id = p_forslag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if f.status <> 'afventer' then
    return jsonb_build_object('kode', 'behandlet', 'status', f.status);
  end if;
  if f.bruger_id = p_medarbejder then return jsonb_build_object('kode', 'sig_selv'); end if;
  -- Erhverv (20261016010000): et forslag om en firmakonto behandles kun af chef.
  if exists (select 1 from public.users u where u.id = f.bruger_id and u.konto_type = 'erhverv')
     and not public.erhverv_har_adgang(p_medarbejder, true) then
    return jsonb_build_object('kode', 'kun_chef');
  end if;
  if exists (
    select 1 from public.sager s join public.trades t on t.id = s.trade_id
     where (t.buyer_id = p_medarbejder and t.seller_id = f.bruger_id)
        or (t.seller_id = p_medarbejder and t.buyer_id = f.bruger_id)) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  update public.konto_lukning_forslag
     set status = 'afvist', behandlet_af = p_medarbejder, behandlet_kl = now(),
         begrundelse = v_grund, opdateret_kl = now()
   where id = f.id and status = 'afventer';
  if not found then return jsonb_build_object('kode', 'behandlet'); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'konto_lukning_afvist', 'bruger', f.bruger_id, f.bruger_id,
          left('Lukning efter ' || f.advarsler_antal || ' advarsler afvist | ' || v_grund, 4000));

  return jsonb_build_object('kode', 'ok', 'bruger_id', f.bruger_id);
end;
$fn$;

revoke all on function public.konto_lukning_afvis(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.konto_lukning_afvis(uuid, uuid, text) to service_role;
