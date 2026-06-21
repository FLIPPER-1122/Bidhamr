-- Hamr: initial schema (users, auctions, bids, transactions, ratings)

create extension if not exists "pgcrypto";

-- =========================================================
-- USERS
-- =========================================================
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  navn text not null,
  email text not null unique,
  telefon text,
  avatar_url text,
  rating numeric(3,2) not null default 0,
  oprettet timestamptz not null default now()
);

-- =========================================================
-- AUCTIONS
-- =========================================================
create table public.auctions (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid not null references public.users(id) on delete cascade,
  titel text not null,
  beskrivelse text,
  billeder text[] not null default '{}',
  startpris numeric(12,2) not null,
  nuværende_bud numeric(12,2),
  lokation text,
  forsendelse_mulig boolean not null default false,
  status text not null default 'aktiv' check (status in ('aktiv', 'afsluttet', 'annulleret')),
  slutter_kl timestamptz not null,
  oprettet timestamptz not null default now()
);

create index auctions_bruger_id_idx on public.auctions (bruger_id);
create index auctions_status_idx on public.auctions (status);

-- =========================================================
-- BIDS
-- =========================================================
create table public.bids (
  id uuid primary key default gen_random_uuid(),
  auktion_id uuid not null references public.auctions(id) on delete cascade,
  bruger_id uuid not null references public.users(id) on delete cascade,
  beløb numeric(12,2) not null,
  oprettet timestamptz not null default now()
);

create index bids_auktion_id_idx on public.bids (auktion_id);
create index bids_bruger_id_idx on public.bids (bruger_id);

-- =========================================================
-- TRANSACTIONS
-- =========================================================
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  auktion_id uuid not null references public.auctions(id) on delete cascade,
  køber_id uuid not null references public.users(id) on delete cascade,
  sælger_id uuid not null references public.users(id) on delete cascade,
  beløb numeric(12,2) not null,
  gebyr numeric(12,2) not null default 0,
  status text not null default 'afventer' check (status in ('afventer', 'frigivet', 'refunderet')),
  oprettet timestamptz not null default now()
);

create index transactions_auktion_id_idx on public.transactions (auktion_id);
create index transactions_køber_id_idx on public.transactions (køber_id);
create index transactions_sælger_id_idx on public.transactions (sælger_id);

-- =========================================================
-- RATINGS
-- =========================================================
create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  fra_bruger_id uuid not null references public.users(id) on delete cascade,
  til_bruger_id uuid not null references public.users(id) on delete cascade,
  auktion_id uuid not null references public.auctions(id) on delete cascade,
  stjerner smallint not null check (stjerner between 1 and 5),
  kommentar text,
  oprettet timestamptz not null default now(),
  unique (fra_bruger_id, auktion_id)
);

create index ratings_til_bruger_id_idx on public.ratings (til_bruger_id);

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================
alter table public.users enable row level security;
alter table public.auctions enable row level security;
alter table public.bids enable row level security;
alter table public.transactions enable row level security;
alter table public.ratings enable row level security;

-- USERS: alle kan se profiler (offentlige), men kun ejeren kan redigere/oprette sin egen
create policy "users_select_all" on public.users
  for select using (true);

create policy "users_insert_own" on public.users
  for insert with check (auth.uid() = id);

create policy "users_update_own" on public.users
  for update using (auth.uid() = id);

create policy "users_delete_own" on public.users
  for delete using (auth.uid() = id);

-- AUCTIONS: alle kan se aktive auktioner, kun ejeren kan oprette/redigere/slette sine egne
create policy "auctions_select_all" on public.auctions
  for select using (true);

create policy "auctions_insert_own" on public.auctions
  for insert with check (auth.uid() = bruger_id);

create policy "auctions_update_own" on public.auctions
  for update using (auth.uid() = bruger_id);

create policy "auctions_delete_own" on public.auctions
  for delete using (auth.uid() = bruger_id);

-- BIDS: alle kan se bud, kun autentificerede brugere kan oprette bud i eget navn
create policy "bids_select_all" on public.bids
  for select using (true);

create policy "bids_insert_own" on public.bids
  for insert with check (auth.uid() = bruger_id);

-- bud kan ikke redigeres eller slettes af brugere (ingen update/delete policy = ingen adgang)

-- TRANSACTIONS: kun køber eller sælger kan se egne transaktioner
create policy "transactions_select_own" on public.transactions
  for select using (auth.uid() = køber_id or auth.uid() = sælger_id);

create policy "transactions_insert_own" on public.transactions
  for insert with check (auth.uid() = køber_id or auth.uid() = sælger_id);

create policy "transactions_update_own" on public.transactions
  for update using (auth.uid() = køber_id or auth.uid() = sælger_id);

-- RATINGS: alle kan se ratings, kun afgiveren kan oprette/redigere/slette sin egen rating
create policy "ratings_select_all" on public.ratings
  for select using (true);

create policy "ratings_insert_own" on public.ratings
  for insert with check (auth.uid() = fra_bruger_id);

create policy "ratings_update_own" on public.ratings
  for update using (auth.uid() = fra_bruger_id);

create policy "ratings_delete_own" on public.ratings
  for delete using (auth.uid() = fra_bruger_id);
