-- Venteliste til "Tilmeld venteliste" på landingsiden. Ingen login krævet.

create table public.venteliste (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  oprettet timestamptz not null default now()
);

alter table public.venteliste enable row level security;

-- Alle (også anonyme besøgende) kan tilmelde sig. Ingen select/update/delete
-- policies findes, så ingen kan læse listen tilbage via API'et.
create policy "venteliste_insert_alle"
  on public.venteliste for insert
  with check (true);
