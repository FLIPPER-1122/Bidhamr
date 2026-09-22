-- Favoritter: en bruger kan gemme auktioner og finde dem igen paa /favoritter.
--
-- Engelske ASCII-kolonnenavne som i reports, trades og wallets - ae/oe/aa
-- braekker supabase-js' select-parser og tvinger .overrideTypes() overalt.

create table if not exists public.favorites (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  auction_id uuid not null references public.auctions(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Samme auktion kan kun gemmes een gang pr. bruger. Constrainten goer
  -- toggle-knappen robust: et dobbeltklik kan ikke lave to raekker.
  unique (user_id, auction_id)
);

-- Opslaget paa /favoritter er "alle mine favoritter, nyeste foerst".
create index if not exists favorites_user_idx
  on public.favorites (user_id, created_at desc);

-- Bruges naar en auktion slettes, og til at taelle favoritter pr. auktion.
create index if not exists favorites_auction_idx
  on public.favorites (auction_id);

alter table public.favorites enable row level security;

-- Brugeren kan kun se og aendre sine egne favoritter. Der er bevidst ingen
-- staff-undtagelse: hvad en bruger har kigget paa, er ikke noget
-- medarbejdere har brug for at se.
drop policy if exists favorites_select_own on public.favorites;
create policy favorites_select_own on public.favorites
  for select using (auth.uid() = user_id);

drop policy if exists favorites_insert_own on public.favorites;
create policy favorites_insert_own on public.favorites
  for insert with check (auth.uid() = user_id);

drop policy if exists favorites_delete_own on public.favorites;
create policy favorites_delete_own on public.favorites
  for delete using (auth.uid() = user_id);

-- Ingen update-policy: en favorit er til stede eller ej. Toggle sker som
-- insert/delete, saa der er intet felt at rette.
