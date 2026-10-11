-- Beta-test: "Meld fejl"-knappen (docs/BETA-TEST.md, docs/BETA-FEJLSKABELON.md).
--
-- Beta-testere og staff kan før lancering melde en fejl direkte fra siden.
-- Fejlene ses under Admin -> Beta-fejl (admin og chef).
--
--   1. Tabel public.beta_fejl. RLS slået til og INGEN policies eller grants
--      til anon/authenticated: indsendelse sker via server actionen
--      indsendBetaFejl (src/app/actions/betaFejl.ts) med service_role, som
--      kalder beta_fejl_opret herunder. Admin-siden læser og opdaterer med
--      service_role efter assertRole('admin').
--   2. Privat bucket 'beta-fejl-billeder' (5 MB, kun jpeg/png/webp).
--      Brugeren må kun uploade i sin egen mappe: <eget id>/<uuid>.jpg, og kun
--      som beta-tester (min_beta_adgang) eller staff (er_staff). Højst 30 filer
--      pr. bruger pr. time. Ingen select/update/delete-policies: billederne
--      vises kun for staff via signerede links (service_role).
--   3. beta_fejl_opret(...) (kun service_role): validerer felterne og
--      billedstierne (skal ligge i brugerens mappe, findes i storage, være
--      uploadet af brugeren og ikke brugt før), har et ekstra loft på 20
--      fejl pr. bruger pr. time og indsætter rækken.
--
-- Ingen eksisterende funktioner ændres (derfor intet md5-drift-tjek).
-- Idempotent (kan køres flere gange). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Tabel
-- ---------------------------------------------------------------------------
create table if not exists public.beta_fejl (
  id           uuid primary key default gen_random_uuid(),
  bruger_id    uuid references public.users(id) on delete set null,
  sti          text check (sti is null or char_length(sti) <= 300),
  alvor        text not null check (alvor in ('blokerer', 'irriterende', 'lille')),
  -- "Hvad gjorde du, og hvad skete der?"
  tekst        text not null check (char_length(btrim(tekst)) between 1 and 4000),
  -- "Hvad havde du forventet?" (valgfrit)
  forventet    text check (forventet is null or char_length(forventet) <= 2000),
  browser      text check (browser is null or char_length(browser) <= 400),
  skaerm       text check (skaerm is null or char_length(skaerm) <= 100),
  -- Stier i bucket 'beta-fejl-billeder' (højst 3).
  billeder     text[] not null default '{}'
               check (coalesce(array_length(billeder, 1), 0) <= 3),
  status       text not null default 'ny'
               check (status in ('ny', 'i_gang', 'loest', 'afvist')),
  staff_note   text check (staff_note is null or char_length(staff_note) <= 2000),
  opdateret_af uuid references public.users(id) on delete set null,
  opdateret_kl timestamptz,
  oprettet_kl  timestamptz not null default now()
);

-- Kolonner, der kan mangle, hvis en tidlig udgave af tabellen findes.
alter table public.beta_fejl add column if not exists billeder text[] not null default '{}';
alter table public.beta_fejl add column if not exists opdateret_af uuid references public.users(id) on delete set null;
alter table public.beta_fejl add column if not exists opdateret_kl timestamptz;

create index if not exists beta_fejl_oprettet_idx on public.beta_fejl (oprettet_kl desc);
create index if not exists beta_fejl_status_idx on public.beta_fejl (status, oprettet_kl desc);
create index if not exists beta_fejl_bruger_idx on public.beta_fejl (bruger_id, oprettet_kl desc)
  where bruger_id is not null;

comment on table public.beta_fejl is
  'Fejl meldt af beta-testere og staff via "Meld fejl"-knappen før lancering. Kun service_role (server actions). Ses i Admin -> Beta-fejl.';

alter table public.beta_fejl enable row level security;
revoke all on table public.beta_fejl from public, anon, authenticated;
grant select, insert, update on table public.beta_fejl to service_role;

-- ---------------------------------------------------------------------------
-- 2. Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('beta-fejl-billeder', 'beta-fejl-billeder', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Må den kaldende bruger uploade til stien? Kun i egen mappe
-- (<eget id>/<uuid>.jpg), kun som beta-tester eller staff, og højst 30 filer
-- pr. time (misbrugsværn - en fejl har højst 3 billeder, og der kan meldes
-- højst 20 fejl i timen).
create or replace function public.beta_fejl_billede_maa_uploade(p_sti text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_bruger uuid := (select auth.uid());
  v_dele   text[] := string_to_array(coalesce(p_sti, ''), '/');
begin
  if v_bruger is null or coalesce(array_length(v_dele, 1), 0) <> 2 then return false; end if;
  if v_dele[1] <> v_bruger::text then return false; end if;
  if v_dele[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return false;
  end if;
  if not (public.min_beta_adgang() or public.er_staff()) then return false; end if;

  return (select count(*) from storage.objects o
           where o.bucket_id = 'beta-fejl-billeder'
             and o.name like v_bruger::text || '/%'
             and o.created_at > now() - interval '1 hour') < 30;
end;
$fn$;

revoke all on function public.beta_fejl_billede_maa_uploade(text) from public, anon;
grant execute on function public.beta_fejl_billede_maa_uploade(text) to authenticated;

drop policy if exists "beta_fejl_billeder_upload_egen" on storage.objects;
create policy "beta_fejl_billeder_upload_egen"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'beta-fejl-billeder'
    and public.beta_fejl_billede_maa_uploade(name)
  );

-- Ingen select/update/delete-policies: brugeren kan hverken se, overskrive
-- eller slette filerne (upload sker derfor med upsert: false). Staff ser dem
-- via signerede links fra service_role.

-- ---------------------------------------------------------------------------
-- 3. Indsendelse (kun service_role)
-- ---------------------------------------------------------------------------
-- p_bruger kommer fra serveren (getUser), efter at server actionen har tjekket,
-- at brugeren er beta-tester eller staff, og at siden ikke er lanceret.
-- Returnerer { kode: 'ok', id } eller { kode: <fejlkode> }:
--   ugyldig_alvor, ugyldig_tekst, ugyldige_billeder, billede_mangler,
--   for_mange.
create or replace function public.beta_fejl_opret(
  p_bruger    uuid,
  p_sti       text,
  p_alvor     text,
  p_tekst     text,
  p_forventet text,
  p_browser   text,
  p_skaerm    text,
  p_billeder  text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_tekst     text := btrim(coalesce(p_tekst, ''));
  v_forventet text := nullif(btrim(coalesce(p_forventet, '')), '');
  v_billeder  text[] := coalesce(p_billeder, '{}');
  v_sti       text;
  v_id        uuid;
begin
  if p_bruger is null then return jsonb_build_object('kode', 'ugyldig_bruger'); end if;
  if p_alvor is null or p_alvor not in ('blokerer', 'irriterende', 'lille') then
    return jsonb_build_object('kode', 'ugyldig_alvor');
  end if;
  if char_length(v_tekst) < 1 or char_length(v_tekst) > 4000
     or (v_forventet is not null and char_length(v_forventet) > 2000) then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;

  -- Højst 20 fejl pr. bruger pr. time (server actionen har samme loft).
  -- Låsen gør tællingen atomisk ved samtidige indsendelser.
  perform pg_advisory_xact_lock(hashtext('beta_fejl:' || p_bruger::text));
  if (select count(*) from public.beta_fejl f
       where f.bruger_id = p_bruger and f.oprettet_kl > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  if coalesce(array_length(v_billeder, 1), 0) > 3 then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;
  if (select count(distinct x) from unnest(v_billeder) x) <> coalesce(array_length(v_billeder, 1), 0) then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;
  foreach v_sti in array v_billeder loop
    if v_sti is null
       or v_sti !~ ('^' || p_bruger::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$') then
      return jsonb_build_object('kode', 'ugyldige_billeder');
    end if;
    if not exists (select 1 from storage.objects o
                    where o.bucket_id = 'beta-fejl-billeder'
                      and o.name = v_sti
                      and o.owner_id = p_bruger::text) then
      return jsonb_build_object('kode', 'billede_mangler');
    end if;
    if exists (select 1 from public.beta_fejl f where v_sti = any (f.billeder)) then
      return jsonb_build_object('kode', 'ugyldige_billeder');
    end if;
  end loop;

  insert into public.beta_fejl (bruger_id, sti, alvor, tekst, forventet, browser, skaerm, billeder)
  values (
    p_bruger,
    left(nullif(btrim(coalesce(p_sti, '')), ''), 300),
    p_alvor,
    v_tekst,
    v_forventet,
    left(nullif(btrim(coalesce(p_browser, '')), ''), 400),
    left(nullif(btrim(coalesce(p_skaerm, '')), ''), 100),
    v_billeder
  )
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end;
$fn$;

revoke all on function public.beta_fejl_opret(uuid, text, text, text, text, text, text, text[])
  from public, anon, authenticated;
grant execute on function public.beta_fejl_opret(uuid, text, text, text, text, text, text, text[])
  to service_role;
