-- To-lags admin-roller (admin/medarbejder), ikke-destruktiv suspension,
-- skjul-flag til moderation og intern advarselslog.
-- Kolonnenavne bruger ASCII (aarsag, ikke årsag) fordi supabase-js' type-parser
-- ikke kan tokenisere æ/ø i select-strenge; UI viser stadig "Årsag".

alter table public.users
  add column if not exists rolle text not null default 'bruger',
  add column if not exists suspenderet boolean not null default false,
  add column if not exists suspenderet_aarsag text,
  add column if not exists suspenderet_kl timestamptz;

-- Tidligere blev suspension modelleret ved at overskrive rolle med
-- 'suspenderet' (destruktivt). Konverter til de nye kolonner.
update public.users set suspenderet = true, suspenderet_kl = now(), rolle = 'bruger'
  where rolle = 'suspenderet';

alter table public.users drop constraint if exists users_rolle_check;
alter table public.users add constraint users_rolle_check
  check (rolle in ('bruger', 'medarbejder', 'admin'));

alter table public.auctions add column if not exists skjult boolean not null default false;
alter table public.ratings  add column if not exists skjult boolean not null default false;

create table if not exists public.advarsler (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid not null references public.users(id) on delete cascade,
  oprettet_af uuid references public.users(id) on delete set null,
  aarsag text not null,
  oprettet_kl timestamptz not null default now()
);

-- Ingen policies: advarsler er interne og tilgås kun via service-role-klienten.
alter table public.advarsler enable row level security;
