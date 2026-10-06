-- Accept af brugerbetingelserne + daglig oprydning af rate_limits.
--
-- 1. users.vilkaar_version (text) og users.vilkaar_accepteret_kl (timestamptz):
--    hvilken version af brugerbetingelserne brugeren har accepteret, og
--    hvornaar. Begge NULL = ikke accepteret (fx eksisterende brugere, eller
--    appen sender ikke vilkaar_version endnu).
--    Kun systemet skriver dem:
--      - handle_new_user saetter dem ved oprettelse, hvis signup-metadata
--        indeholder vilkaar_version = den aktuelle version. Tidspunktet er
--        ALTID databasens now() - aldrig en vaerdi fra klienten.
--      - accepter_vilkaar(p_version) (security definer, auth.uid()) for
--        eksisterende brugere - kun den aktuelle version.
--      - users_beskyt_privilegerede_kolonner afviser aendring fra brugeren
--        selv (users_update_own); users_beskyt_ny nulstiller dem ved en
--        direkte insert (der er ingen insert-policy, men for en sikkerheds
--        skyld).
--    Kolonnerne faar ingen select-grant (users har kolonne-grants), saa andre
--    brugere kan ikke se dem. Brugeren selv laeser dem via mine_vilkaar().
--
--    Den aktuelle version staar i vilkaar_aktuel_version() og SKAL holdes
--    synkron med VILKAAR_VERSION i src/lib/vilkaar.ts.
--
--    Expo-appen: send vilkaar_version i signup-metadata
--    (supabase.auth.signUp({ options: { data: { ..., vilkaar_version: '0.1' } } }))
--    og vis et paakraevet flueben. Sender appen den ikke (eller en forkert
--    version), gemmes NULL - appens signup brydes ikke.
--
-- 6. rate_limits: rate_limit_tjek sletter kun gamle raekker tilfaeldigt (1 %
--    af kaldene), saa ved lav trafik kan IP-adresser og e-mails blive liggende
--    laenge. Nyt timeligt pg_cron-job 'rate-limits-oprydning' sletter raekker,
--    hvis vindue startede for mere end 24 timer siden. Det laengste vindue i
--    src/lib/rateLimit.ts er 24 timer, saa et aktivt vindue roeres aldrig.
--    Det tilfaeldige oprydningskald i rate_limit_tjek beholdes.
--
-- Idempotent: if not exists / create or replace / cron.schedule med fast navn.

set local lock_timeout = '5s';

-- ============================================================ 1. Kolonner

alter table public.users
  add column if not exists vilkaar_version text,
  add column if not exists vilkaar_accepteret_kl timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_vilkaar_version_gyldig') then
    alter table public.users
      add constraint users_vilkaar_version_gyldig
      check (vilkaar_version is null or vilkaar_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_vilkaar_par') then
    alter table public.users
      add constraint users_vilkaar_par
      check ((vilkaar_version is null) = (vilkaar_accepteret_kl is null));
  end if;
end $$;

comment on column public.users.vilkaar_version is
  'Version af brugerbetingelserne, brugeren har accepteret (fx 0.1). NULL = ikke accepteret. Kun systemet skriver.';
comment on column public.users.vilkaar_accepteret_kl is
  'Hvornaar vilkaar_version blev accepteret (databasens now()). Kun systemet skriver.';

-- Ingen select-grant til anon/authenticated (users har kolonne-grants).
revoke select (vilkaar_version, vilkaar_accepteret_kl) on public.users from anon, authenticated;

-- Aktuel version. Hold synkron med VILKAAR_VERSION i src/lib/vilkaar.ts.
create or replace function public.vilkaar_aktuel_version()
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select '0.1'::text;
$fn$;

grant execute on function public.vilkaar_aktuel_version() to anon, authenticated, service_role;

-- ============================================================ Beskyttelse

create or replace function public.users_beskyt_privilegerede_kolonner()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if new.id                    is distinct from old.id
  or new.email                 is distinct from old.email
  or new.rolle                 is distinct from old.rolle
  or new.suspenderet           is distinct from old.suspenderet
  or new.suspenderet_aarsag    is distinct from old.suspenderet_aarsag
  or new.suspenderet_kl        is distinct from old.suspenderet_kl
  or new.suspenderet_til       is distinct from old.suspenderet_til
  or new.rating                is distinct from old.rating
  or new.oprettet              is distinct from old.oprettet
  or new.vilkaar_version       is distinct from old.vilkaar_version
  or new.vilkaar_accepteret_kl is distinct from old.vilkaar_accepteret_kl then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

create or replace function public.users_beskyt_ny()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  new.rolle                 := 'bruger';
  new.suspenderet           := false;
  new.suspenderet_aarsag    := null;
  new.suspenderet_kl        := null;
  new.suspenderet_til       := null;
  new.rating                := 0;
  new.oprettet              := now();
  new.vilkaar_version       := null;
  new.vilkaar_accepteret_kl := null;

  return new;
end;
$function$;

-- ============================================================ Oprettelse

-- Som foer (20261007050000), plus accept: kun den aktuelle version godtages,
-- og tidspunktet er altid now().
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_fornavn   text := left(nullif(btrim(new.raw_user_meta_data->>'fornavn'), ''), 100);
  v_efternavn text := left(nullif(btrim(new.raw_user_meta_data->>'efternavn'), ''), 100);
  v_navn      text := left(nullif(btrim(new.raw_user_meta_data->>'navn'), ''), 200);
  v_vilkaar   text := case
                        when new.raw_user_meta_data->>'vilkaar_version' = public.vilkaar_aktuel_version()
                        then public.vilkaar_aktuel_version()
                      end;
begin
  if public.navn_har_kontaktinfo(v_fornavn) then v_fornavn := null; end if;
  if public.navn_har_kontaktinfo(v_efternavn) then v_efternavn := null; end if;
  if public.navn_har_kontaktinfo(v_navn) then v_navn := null; end if;
  if v_navn is null then
    v_navn := nullif(btrim(concat_ws(' ', v_fornavn, v_efternavn)), '');
  end if;
  insert into public.users (id, navn, fornavn, efternavn, email, telefon,
                            vilkaar_version, vilkaar_accepteret_kl)
  values (
    new.id,
    coalesce(v_navn, 'Bruger'),
    v_fornavn,
    v_efternavn,
    new.email,
    new.raw_user_meta_data->>'telefon',
    v_vilkaar,
    case when v_vilkaar is not null then now() end
  );
  return new;
end;
$function$;

-- ============================================================ RPC'er

-- Brugerens egen accept (til bjaelken paa /konto og appen).
create or replace function public.mine_vilkaar()
returns table (version text, accepteret_kl timestamptz, aktuel_version text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select u.vilkaar_version, u.vilkaar_accepteret_kl, public.vilkaar_aktuel_version()
    from public.users u
   where u.id = (select auth.uid());
$fn$;

revoke all on function public.mine_vilkaar() from public, anon;
grant execute on function public.mine_vilkaar() to authenticated, service_role;

-- Eksisterende brugere accepterer den aktuelle version. p_version er den
-- version, brugeren har faaet vist; er den ikke den aktuelle (fx en gammel
-- fane), afvises kaldet, saa man ikke accepterer noget, man ikke har set.
-- Tidspunktet er altid now(). Kan kaldes igen (opdaterer tidspunktet ikke,
-- hvis versionen allerede er accepteret).
create or replace function public.accepter_vilkaar(p_version text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_kl  timestamptz;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if p_version is distinct from public.vilkaar_aktuel_version() then
    raise exception 'Brugerbetingelserne er blevet opdateret. Genindlæs siden, og læs dem igen.'
      using errcode = 'P0001';
  end if;

  update public.users u
     set vilkaar_version = p_version,
         vilkaar_accepteret_kl = now()
   where u.id = v_uid
     and u.vilkaar_version is distinct from p_version
     and u.konto_slettet_kl is null;

  select u.vilkaar_accepteret_kl into v_kl
    from public.users u
   where u.id = v_uid and u.vilkaar_version = p_version;

  if v_kl is null then
    raise exception 'Din accept kunne ikke gemmes.' using errcode = 'P0001';
  end if;
  return v_kl;
end;
$fn$;

revoke all on function public.accepter_vilkaar(text) from public, anon;
grant execute on function public.accepter_vilkaar(text) to authenticated, service_role;

-- ============================================================ 6. rate_limits

-- Engangs-oprydning (tabellen er lille; ingen batches).
delete from public.rate_limits where vindue_start < now() - interval '24 hours';

-- Hver time (minut 23), saa raekker hoejst lever ca. 25 timer.
select cron.schedule(
  'rate-limits-oprydning',
  '23 * * * *',
  $$delete from public.rate_limits where vindue_start < now() - interval '24 hours'$$
);
