-- Handler: sporet fra "auktionen er slut" til "varen er modtaget".
-- Adskilt fra transactions: transactions = escrow/penge, trades = varens vej
-- fra sælger til køber. De to rører ikke hinanden.
-- Engelske/ASCII-kolonnenavne som i reports — supabase-js' query-parser kan
-- ikke tokenisere æ/ø i select-strenge.

-- Driftrettelse: vinder_id bruges af afslut_udloebne_auktioner() og BidPanel,
-- men blev aldrig lagt i en migration. Uden denne linje fejler et frisk
-- `supabase db reset`. No-op på produktion, hvor kolonnen allerede findes.
alter table public.auctions
  add column if not exists vinder_id uuid references public.users(id) on delete set null;

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null unique references public.auctions(id) on delete cascade,
  seller_id uuid not null references public.users(id) on delete cascade,
  buyer_id uuid not null references public.users(id) on delete cascade,
  amount numeric(12,2) not null,
  status text not null default 'betaling_modtaget' check (status in (
    'betaling_modtaget',
    'pakke_sendt',
    'leveret',
    'afsluttet'
  )),
  tracking_number text,
  created_at timestamptz not null default now()
);

comment on column public.trades.status is
  'betaling_modtaget: sat når auktionen lukkes (køber trækkes automatisk fra e-money). '
  'pakke_sendt: sælger har afsendt og indtastet tracking. '
  'leveret: køber har bekræftet modtagelse. '
  'afsluttet: RESERVERET — sættes af intet endnu, tiltænkt udbetaling/rating senere.';

create index trades_buyer_idx on public.trades (buyer_id, created_at desc);
create index trades_seller_idx on public.trades (seller_id, created_at desc);
create index trades_status_idx on public.trades (status, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid not null references public.trades(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index messages_trade_idx on public.messages (trade_id, created_at);

alter table public.trades enable row level security;
alter table public.messages enable row level security;

-- Egen funktion til staff-tjekket, så policy-udtrykket ikke rammer users-RLS
-- rekursivt.
create or replace function public.er_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users u
     where u.id = auth.uid() and u.rolle in ('medarbejder', 'admin', 'chef')
  );
$$;

revoke all on function public.er_staff() from public;
grant execute on function public.er_staff() to authenticated;

-- TRADES: parterne ser og opdaterer egne handler; staff må læse alt.
-- Ingen insert-policy: kun service-role (cron-ruten) opretter handler.
create policy trades_select_own on public.trades
  for select using (
    auth.uid() = buyer_id or auth.uid() = seller_id or public.er_staff()
  );

-- Hvilken part der må lave hvilket statusskift håndhæves i server actions;
-- denne policy er det ydre hegn om hvem der overhovedet må røre rækken.
create policy trades_update_own on public.trades
  for update using (auth.uid() = buyer_id or auth.uid() = seller_id)
  with check (auth.uid() = buyer_id or auth.uid() = seller_id);

-- MESSAGES: kun handlens to parter (staff må læse med).
create policy messages_select_part on public.messages
  for select using (
    public.er_staff() or exists (
      select 1 from public.trades t
       where t.id = messages.trade_id
         and (auth.uid() = t.buyer_id or auth.uid() = t.seller_id)
    )
  );

create policy messages_insert_part on public.messages
  for insert with check (
    auth.uid() = sender_id and exists (
      select 1 from public.trades t
       where t.id = messages.trade_id
         and (auth.uid() = t.buyer_id or auth.uid() = t.seller_id)
    )
  );

-- Ingen update/delete-policy: beskeder kan ikke ændres eller slettes, som bids.

-- Realtime på messages (chatten). trades holdes udenfor — statusskift er
-- sjældne og dækkes af router.refresh().
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
