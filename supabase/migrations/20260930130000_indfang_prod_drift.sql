-- Indfanger det, der findes i produktionsdatabasen uden at staa i nogen
-- migration (oprettet direkte i Supabase, fx til Expo-appen). Uden denne fil
-- ville en ny database bygget fra supabase/migrations/ (testdatabasen) ikke
-- ligne produktion.
--
-- Alt er idempotent (if not exists / drop if exists), saa filen er en no-op
-- mod produktion, hvor objekterne allerede findes. Definitionerne er hentet
-- ordret fra produktion 2026-09-30.
--
-- IKKE indfanget med vilje:
--   cron-jobbet 'afslut-auktioner' i produktion kalder edge-funktionen
--   /functions/v1/afslut-auktioner via net.http_post, men pg_net er ikke
--   installeret i produktion, saa jobbet fejler hvert minut. Det egentlige
--   job er 'afslut-udloebne-auktioner' (20260825000000). Kopieres ikke.

-- ---------------------------------------------------------
-- Ekstra kolonner
-- ---------------------------------------------------------
alter table public.auctions
  add column if not exists maerke text,
  add column if not exists stand text,
  add column if not exists visninger integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auctions_stand_check') then
    alter table public.auctions add constraint auctions_stand_check
      check (stand is null or stand in ('Ny', 'Som ny', 'Brugt', 'Defekt'));
  end if;
end $$;

alter table public.users
  add column if not exists fornavn text,
  add column if not exists efternavn text,
  add column if not exists adresse text;

-- ---------------------------------------------------------
-- Visningstaeller (appen)
-- ---------------------------------------------------------
create or replace function public.oeg_auktion_visning(p_auktion_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  update public.auctions
  set visninger = visninger + 1
  where id = p_auktion_id;
$function$;

-- ---------------------------------------------------------
-- auction_templates
-- ---------------------------------------------------------
create table if not exists public.auction_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null check (char_length(trim(both from name)) between 1 and 60),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists auction_templates_user_idx
  on public.auction_templates (user_id, updated_at desc);
alter table public.auction_templates enable row level security;

create or replace function public.auction_templates_saet_updated_at()
returns trigger
language plpgsql
as $function$
begin new.updated_at := now(); return new; end; $function$;

drop trigger if exists auction_templates_updated_at on public.auction_templates;
create trigger auction_templates_updated_at
  before update on public.auction_templates
  for each row execute function public.auction_templates_saet_updated_at();

drop policy if exists auction_templates_select_own on public.auction_templates;
create policy auction_templates_select_own on public.auction_templates
  for select using (auth.uid() = user_id);
drop policy if exists auction_templates_insert_own on public.auction_templates;
create policy auction_templates_insert_own on public.auction_templates
  for insert with check (auth.uid() = user_id);
drop policy if exists auction_templates_update_own on public.auction_templates;
create policy auction_templates_update_own on public.auction_templates
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists auction_templates_delete_own on public.auction_templates;
create policy auction_templates_delete_own on public.auction_templates
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- employee_complaints
-- ---------------------------------------------------------
create table if not exists public.employee_complaints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  employee_id uuid not null references public.users(id) on delete cascade,
  description text not null check (char_length(trim(both from description)) between 1 and 2000),
  status text not null default 'pending'
    check (status in ('pending', 'under_behandling', 'behandlet', 'afvist')),
  created_at timestamptz not null default now()
);
create index if not exists employee_complaints_status_idx
  on public.employee_complaints (status, created_at desc);
alter table public.employee_complaints enable row level security;

drop policy if exists employee_complaints_insert_own on public.employee_complaints;
create policy employee_complaints_insert_own on public.employee_complaints
  for insert with check (auth.uid() = user_id);
drop policy if exists employee_complaints_select_chef on public.employee_complaints;
create policy employee_complaints_select_chef on public.employee_complaints
  for select using (public.min_rolle() = 'chef');
drop policy if exists employee_complaints_update_chef on public.employee_complaints;
create policy employee_complaints_update_chef on public.employee_complaints
  for update using (public.min_rolle() = 'chef');

-- ---------------------------------------------------------
-- push_tokens
-- ---------------------------------------------------------
create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token text not null constraint push_tokens_unikt_token unique,
  platform text not null check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on public.push_tokens (user_id);
alter table public.push_tokens enable row level security;

drop policy if exists push_tokens_select_own on public.push_tokens;
create policy push_tokens_select_own on public.push_tokens
  for select using (auth.uid() = user_id);
drop policy if exists push_tokens_insert_own on public.push_tokens;
create policy push_tokens_insert_own on public.push_tokens
  for insert with check (auth.uid() = user_id);
drop policy if exists push_tokens_update_own on public.push_tokens;
create policy push_tokens_update_own on public.push_tokens
  for update using (auth.uid() = user_id);
drop policy if exists push_tokens_delete_own on public.push_tokens;
create policy push_tokens_delete_own on public.push_tokens
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- saved_auctions
-- ---------------------------------------------------------
create table if not exists public.saved_auctions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  auction_id uuid not null references public.auctions(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint saved_auctions_unik unique (user_id, auction_id)
);
create index if not exists saved_auctions_user_idx
  on public.saved_auctions (user_id, created_at desc);
alter table public.saved_auctions enable row level security;

drop policy if exists saved_auctions_select_own on public.saved_auctions;
create policy saved_auctions_select_own on public.saved_auctions
  for select using (auth.uid() = user_id);
drop policy if exists saved_auctions_insert_own on public.saved_auctions;
create policy saved_auctions_insert_own on public.saved_auctions
  for insert with check (auth.uid() = user_id);
drop policy if exists saved_auctions_delete_own on public.saved_auctions;
create policy saved_auctions_delete_own on public.saved_auctions
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- seller_follows
-- ---------------------------------------------------------
create table if not exists public.seller_follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.users(id) on delete cascade,
  seller_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint seller_follows_unik unique (follower_id, seller_id),
  constraint seller_follows_ikke_sig_selv check (follower_id <> seller_id)
);
create index if not exists seller_follows_follower_idx on public.seller_follows (follower_id);
create index if not exists seller_follows_seller_idx on public.seller_follows (seller_id);
alter table public.seller_follows enable row level security;

drop policy if exists seller_follows_select_all on public.seller_follows;
create policy seller_follows_select_all on public.seller_follows
  for select using (true);
drop policy if exists seller_follows_insert_own on public.seller_follows;
create policy seller_follows_insert_own on public.seller_follows
  for insert with check (auth.uid() = follower_id);
drop policy if exists seller_follows_delete_own on public.seller_follows;
create policy seller_follows_delete_own on public.seller_follows
  for delete using (auth.uid() = follower_id);

-- ---------------------------------------------------------
-- Realtime: produktion udsender ogsaa wallets (saldo i headeren).
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'wallets'
  ) then
    alter publication supabase_realtime add table public.wallets;
  end if;
end $$;

-- ---------------------------------------------------------
-- Budreservation: 20260904000000 opretter bids_reserver_midler_trg, men den
-- findes ikke i produktion (fjernet manuelt). Uden denne linje ville hvert bud
-- i en frisk database kraeve saldo i wallet'en.
-- ---------------------------------------------------------
drop trigger if exists bids_reserver_midler_trg on public.bids;

-- ---------------------------------------------------------
-- Event trigger fra produktion: slaar RLS til paa nye tabeller i public.
-- ---------------------------------------------------------
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
     if cmd.schema_name is not null and cmd.schema_name in ('public') and cmd.schema_name not in ('pg_catalog','information_schema') and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
     else
        raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     end if;
  end loop;
end;
$function$;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      execute function public.rls_auto_enable();
  end if;
end $$;
