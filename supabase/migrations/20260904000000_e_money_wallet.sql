-- E-money: saldo pr. bruger, reservation ved budgivning og automatisk
-- afregning naar en auktion lukker.
--
-- Erstatter escrow-flowet (transactions + Stripe-checkout pr. auktion).
-- Pengene ligger nu paa brugerens konto FOER der bydes og traekkes automatisk
-- ved auktionsluk - derfor er 'betaling_modtaget' en sand udtalelse.
--
-- Beloeb er numeric(12,2) i kroner. Alle bevaegelser skrives i wallet_entries
-- (append-only hovedbog); wallets.balance er en cache, der altid opdateres i
-- samme transaktion som hovedbogslinjen. sum(entries) skal = balance.

-- ---------------------------------------------------------------- tabeller

create table if not exists public.wallets (
  user_id    uuid primary key references public.users(id) on delete cascade,
  balance    numeric(12,2) not null default 0 check (balance >= 0),
  -- Reserveret af aktive hoejestebud. Kan ikke bruges til nye bud.
  reserved   numeric(12,2) not null default 0 check (reserved >= 0),
  updated_at timestamptz not null default now(),
  constraint wallets_reserved_within_balance check (reserved <= balance)
);

create table if not exists public.wallet_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  -- Fortegnet beloeb: positivt = ind, negativt = ud.
  amount      numeric(12,2) not null check (amount <> 0),
  kind        text not null check (kind in (
                'indbetaling','koeb','salg','koebergebyr','saelgergebyr','justering')),
  auction_id  uuid references public.auctions(id) on delete set null,
  note        text,
  -- Idempotensnoegle for Stripe-indbetalinger: samme session kan kun
  -- krediteres een gang, uanset hvor mange gange webhooken leveres.
  stripe_session_id text unique,
  balance_after numeric(12,2) not null,
  created_at  timestamptz not null default now()
);

create index if not exists wallet_entries_user_idx
  on public.wallet_entries (user_id, created_at desc);

-- Kun det aktuelle hoejestebud pr. auktion holder en reservation. Bliver man
-- overbudt, frigives pengene med det samme.
create table if not exists public.bid_reservations (
  auction_id uuid primary key references public.auctions(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  amount     numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- konti

create or replace function public.opret_wallet_til_ny_bruger()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.wallets (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$fn$;

drop trigger if exists users_opret_wallet on public.users;
create trigger users_opret_wallet
  after insert on public.users
  for each row execute function public.opret_wallet_til_ny_bruger();

-- Eksisterende brugere faar en konto med saldo 0.
insert into public.wallets (user_id)
select u.id from public.users u
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- bogfoering

-- Eneste vej til at aendre en saldo. Skriver hovedbogslinje og opdaterer
-- cachen atomisk. Negativt beloeb kan ikke foere saldoen under nul (check).
create or replace function public.wallet_bogfoer(
  p_user uuid,
  p_amount numeric,
  p_kind text,
  p_auction uuid default null,
  p_note text default null,
  p_stripe_session text default null
) returns numeric
language plpgsql security definer set search_path = public as $fn$
declare
  ny_saldo numeric(12,2);
begin
  update public.wallets
     set balance = balance + p_amount,
         updated_at = now()
   where user_id = p_user
  returning balance into ny_saldo;

  if not found then
    raise exception 'wallet_mangler: bruger % har ingen konto', p_user;
  end if;

  insert into public.wallet_entries
    (user_id, amount, kind, auction_id, note, stripe_session_id, balance_after)
  values
    (p_user, p_amount, p_kind, p_auction, p_note, p_stripe_session, ny_saldo);

  return ny_saldo;
end;
$fn$;

-- Indbetaling fra Stripe. Idempotent paa session-id: anden levering af samme
-- webhook krediterer ikke igen.
create or replace function public.wallet_indbetal(
  p_user uuid,
  p_amount numeric,
  p_stripe_session text
) returns numeric
language plpgsql security definer set search_path = public as $fn$
declare
  ny_saldo numeric(12,2);
begin
  if p_amount <= 0 then
    raise exception 'ugyldigt_beloeb';
  end if;

  if exists (select 1 from public.wallet_entries
              where stripe_session_id = p_stripe_session) then
    select balance into ny_saldo from public.wallets where user_id = p_user;
    return ny_saldo;
  end if;

  return public.wallet_bogfoer(
    p_user, p_amount, 'indbetaling', null, 'Indbetaling via Stripe',
    p_stripe_session);
end;
$fn$;

-- ---------------------------------------------------------------- reservation

create or replace function public.wallet_frigiv(p_auction uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  r record;
begin
  select * into r from public.bid_reservations where auction_id = p_auction;
  if not found then return; end if;

  update public.wallets
     set reserved = greatest(reserved - r.amount, 0), updated_at = now()
   where user_id = r.user_id;

  delete from public.bid_reservations where auction_id = p_auction;
end;
$fn$;

-- Reserverer bud + 5% koebergebyr hos den nye hoejestbydende og frigiver den
-- forriges reservation. Koerer som AFTER INSERT, saa de eksisterende
-- budvalideringer (minimumsbud, eget opslag) afvises foerst.
create or replace function public.bids_reserver_midler()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  kraevet numeric(12,2);
  ledig   numeric(12,2);
begin
  kraevet := round(new.beløb * 1.05, 2);

  -- Frigiv forrige hoejestbydende (ogsaa hvis det er samme bruger, der haever).
  perform public.wallet_frigiv(new.auktion_id);

  select balance - reserved into ledig
    from public.wallets where user_id = new.bruger_id for update;

  if ledig is null then
    raise exception 'wallet_mangler';
  end if;

  if ledig < kraevet then
    raise exception 'utilstraekkelig_saldo: mangler % kr',
      round(kraevet - ledig, 2);
  end if;

  update public.wallets
     set reserved = reserved + kraevet, updated_at = now()
   where user_id = new.bruger_id;

  insert into public.bid_reservations (auction_id, user_id, amount)
  values (new.auktion_id, new.bruger_id, kraevet);

  return new;
end;
$fn$;

drop trigger if exists bids_reserver_midler_trg on public.bids;
create trigger bids_reserver_midler_trg
  after insert on public.bids
  for each row execute function public.bids_reserver_midler();

-- ---------------------------------------------------------------- afregning

-- Traekker vinderen, krediterer saelgeren og opretter handlen - alt i een
-- transaktion. Idempotent: findes handlen allerede, sker intet.
create or replace function public.wallet_afregn_auktion(p_auction uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  a            record;
  bud          numeric(12,2);
  koebergebyr  numeric(12,2);
  saelgergebyr numeric(12,2);
begin
  select id, bruger_id, vinder_id, titel
    into a
    from public.auctions
   where id = p_auction and status = 'afsluttet' and vinder_id is not null;

  if not found then return false; end if;

  if exists (select 1 from public.trades where auction_id = p_auction) then
    return false;
  end if;

  select b.beløb into bud
    from public.bids b
   where b.auktion_id = p_auction and b.bruger_id = a.vinder_id
   order by b.beløb desc limit 1;

  if bud is null then return false; end if;

  koebergebyr  := round(bud * 0.05, 2);
  saelgergebyr := round(bud * 0.10, 2);

  -- Reservationen har holdt pengene siden budgivningen; frigiv den, saa
  -- beloebet kan traekkes af den almindelige saldo.
  perform public.wallet_frigiv(p_auction);

  perform public.wallet_bogfoer(
    a.vinder_id, -bud, 'koeb', p_auction, 'Vundet auktion: ' || a.titel);
  perform public.wallet_bogfoer(
    a.vinder_id, -koebergebyr, 'koebergebyr', p_auction, 'Koebergebyr 5%');
  perform public.wallet_bogfoer(
    a.bruger_id, bud - saelgergebyr, 'salg', p_auction,
    'Solgt: ' || a.titel || ' (fratrukket 10% saelgergebyr)');

  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (p_auction, a.bruger_id, a.vinder_id, bud, 'betaling_modtaget')
  on conflict (auction_id) do nothing;

  return true;
end;
$fn$;

-- Lukkefunktionen afregner nu ogsaa. Samme funktion kaldes af pg_cron og af
-- API-routen, saa de to kan ikke divergere.
create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
  r     record;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b.beløb desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now();

  get diagnostics antal = row_count;

  -- Afregn alt afsluttet med vinder og uden handel (ogsaa fra tidligere
  -- koersler, hvis afregningen skulle vaere strandet).
  for r in
    select a.id from public.auctions a
     where a.status = 'afsluttet'
       and a.vinder_id is not null
       and not exists (select 1 from public.trades t where t.auction_id = a.id)
  loop
    perform public.wallet_afregn_auktion(r.id);
  end loop;

  -- Auktioner der lukkede uden vinder maa ikke holde paa penge.
  for r in
    select br.auction_id from public.bid_reservations br
      join public.auctions a on a.id = br.auction_id
     where a.status <> 'aktiv'
  loop
    perform public.wallet_frigiv(r.auction_id);
  end loop;

  return antal;
end;
$fn$;

-- ---------------------------------------------------------------- RLS

alter table public.wallets enable row level security;
alter table public.wallet_entries enable row level security;
alter table public.bid_reservations enable row level security;

drop policy if exists wallets_select_own on public.wallets;
create policy wallets_select_own on public.wallets
  for select using (auth.uid() = user_id or public.er_staff());

drop policy if exists wallet_entries_select_own on public.wallet_entries;
create policy wallet_entries_select_own on public.wallet_entries
  for select using (auth.uid() = user_id or public.er_staff());

drop policy if exists bid_reservations_select_own on public.bid_reservations;
create policy bid_reservations_select_own on public.bid_reservations
  for select using (auth.uid() = user_id or public.er_staff());

-- Ingen insert/update/delete-policies: saldi aendres udelukkende gennem
-- security definer-funktionerne ovenfor. En bruger kan aldrig skrive til sin
-- egen konto direkte.
