-- Anmeldelser af auktionsopslag. Bemærk: kolonnenavnene er engelske/ASCII
-- (i modsætning til de øvrige tabeller, der bruger dansk med æ/ø). Det er
-- bevidst her - supabase-js' query-parser kan ikke tokenisere æ/ø i
-- select-strenge, hvilket ellers kræver .overrideTypes() overalt.

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions(id) on delete cascade,
  reporter_id uuid not null references public.users(id) on delete cascade,
  category text not null check (category in (
    'ulovlig_vare',
    'forfalsket_vare',
    'spam_duplikat',
    'stoedende_indhold',
    'mistaenkelig_saelger',
    'andet'
  )),
  description text,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'handled'))
);

create index reports_status_idx on public.reports (status, created_at desc);
create index reports_auction_idx on public.reports (auction_id);

alter table public.reports enable row level security;

-- Brugere må kun oprette anmeldelser i eget navn og kun se deres egne.
-- Admin/medarbejdere læser og opdaterer via service-role-klienten.
create policy reports_insert_own on public.reports
  for insert with check (auth.uid() = reporter_id);

create policy reports_select_own on public.reports
  for select using (auth.uid() = reporter_id);
