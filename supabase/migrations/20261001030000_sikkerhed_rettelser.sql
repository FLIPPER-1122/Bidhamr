-- Sikkerhedsrettelser efter sikkerhedsgennemgangen og testrapporten 2026-10-01.
--
-- Filen er idempotent og kan koeres sikkert i produktion senere. Produktion
-- har IKKE wallet-tabellerne/-funktionerne (og maaske endnu ikke betalinger),
-- saa alt, der roerer dem, er bag to_regclass/to_regprocedure-tjek.
-- Filens regel: intet nyt, der oprettes her, kan kaldes af anon.
--
-- H1 (push_tokens with check) ligger i 20261001025000_push_tokens_with_check.sql.
--
-- Indhold:
--   H2  Pengetal (betalinger, betaling_afvigelser, wallets) kun for chef.
--   T4  Koeber/saelger kan kun laese ufarlige kolonner i betalinger.
--   M2  Execute lukkes paa trigger-funktioner. auction_views og
--       visningsfunktionerne (appen) indfanges fra produktion.
--   L2  Visningstal: kraever login, hoejst een visning pr. bruger pr. auktion,
--       ejerens egne visninger taeller ikke. antal_bud kan ikke saettes af brugere.
--   L3  Postgres-baseret rate limiter (kun service_role).
--   L6  Bydernes og foelgernes privatliv: bids og seller_follows kan kun
--       laeses af brugeren selv. Antal bud ligger paa auctions.antal_bud.

-- =============================================================== H2 + T4 betalinger
-- min_rolle() (20260930100000) er security definer og udleder brugeren af
-- auth.uid(); returnerer users.rolle. Kun 'chef' maa se andres beloeb.
do $$
begin
  if to_regclass('public.betalinger') is not null then
    execute 'drop policy if exists betalinger_select_part on public.betalinger';
    execute 'create policy betalinger_select_part on public.betalinger
               for select to authenticated using (
                 buyer_id = auth.uid() or seller_id = auth.uid()
                 or public.min_rolle() = ''chef'')';

    -- T4: kolonne-grants. Interne felter (sidste_fejl, autobetaling_*,
    -- stripe_*, mail-tidsstempler, pi_forsoeg, saelgergebyr/udbetaling) kan
    -- ikke laeses med brugerens JWT. Hjemmesiden laeser dem via service-role
    -- i hentBetalingsstatus og filtrerer pr. part.
    execute 'revoke select on public.betalinger from anon, authenticated';
    execute 'grant select (id, trade_id, auction_id, buyer_id, seller_id,
               bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
               total_oere, valuta, status, betal_senest, betalt_kl,
               frigivet_kl, overfoert_kl, oprettet, opdateret)
             on public.betalinger to authenticated';
  end if;

  if to_regclass('public.betaling_afvigelser') is not null then
    execute 'drop policy if exists betaling_afvigelser_select_staff on public.betaling_afvigelser';
    execute 'drop policy if exists betaling_afvigelser_select_chef on public.betaling_afvigelser';
    execute 'create policy betaling_afvigelser_select_chef on public.betaling_afvigelser
               for select to authenticated using (public.min_rolle() = ''chef'')';
  end if;

  if to_regclass('public.wallets') is not null then
    execute 'drop policy if exists wallets_select_own on public.wallets';
    execute 'create policy wallets_select_own on public.wallets
               for select using (auth.uid() = user_id or public.min_rolle() = ''chef'')';
  end if;

  if to_regclass('public.wallet_entries') is not null then
    execute 'drop policy if exists wallet_entries_select_own on public.wallet_entries';
    execute 'create policy wallet_entries_select_own on public.wallet_entries
               for select using (auth.uid() = user_id or public.min_rolle() = ''chef'')';
  end if;
end $$;

-- =============================================================== M2 trigger-funktioner
-- Trigger-funktioner skal aldrig kunne kaldes direkte. Revoke paavirker ikke,
-- at triggerne fyrer.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.handle_new_user()',
    'public.check_ikke_egen_auktion()',
    'public.check_minimum_bid()',
    'public.handle_new_bid()',
    'public.bids_tving_tidspunkt()',
    'public.bids_reserver_midler()',
    'public.opret_wallet_til_ny_bruger()',
    'public.rls_auto_enable()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;

-- =============================================================== L2 visninger
-- Produktion (appen) taeller visninger i auction_views via
-- registrer_auktion_visning og viser dem for ejeren via hent_mine_visninger.
-- Kolonnen auctions.visninger og oeg_auktion_visning er udgaaet i produktion
-- (findes kun paa testdatabasen fra 20260930130000). Definitionerne herunder
-- er hentet ordret fra produktion 2026-10-01, med een aendring: visninger
-- taeller KUN for indloggede (en "enhed" kunne foerhen opdigtes frit, saa
-- tallet kunne pumpes op). Een visning pr. bruger pr. auktion (primary key),
-- ejerens egne visninger taeller ikke.
create table if not exists public.auction_views (
  auktion_id      uuid not null references public.auctions(id) on delete cascade,
  seer            text not null check (char_length(seer) between 1 and 80),
  foerste_visning timestamptz not null default now(),
  primary key (auktion_id, seer)
);
alter table public.auction_views enable row level security;
drop policy if exists auction_views_select_ejer on public.auction_views;
create policy auction_views_select_ejer on public.auction_views
  for select using (exists (
    select 1 from public.auctions a
     where a.id = auction_views.auktion_id and a.bruger_id = auth.uid()));
revoke insert, update, delete, truncate on public.auction_views from anon, authenticated;

-- Signaturen (p_auktion_id, p_enhed) bevares, saa appen ikke skal aendres;
-- p_enhed ignoreres nu.
create or replace function public.registrer_auktion_visning(p_auktion_id uuid, p_enhed text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ejer uuid;
  mig    uuid := auth.uid();
begin
  if mig is null then return; end if;
  select bruger_id into v_ejer from public.auctions where id = p_auktion_id;
  if not found or v_ejer = mig then return; end if;
  insert into public.auction_views (auktion_id, seer)
  values (p_auktion_id, mig::text)
  on conflict do nothing;
end;
$function$;
revoke execute on function public.registrer_auktion_visning(uuid, text) from public, anon;
grant execute on function public.registrer_auktion_visning(uuid, text) to authenticated;

create or replace function public.hent_mine_visninger(p_ids uuid[])
returns table(auktion_id uuid, antal bigint)
language sql
stable security definer
set search_path to 'public'
as $function$
  select v.auktion_id, count(*)::bigint
  from public.auction_views v join public.auctions a on a.id = v.auktion_id
  where v.auktion_id = any (p_ids) and a.bruger_id = auth.uid()
  group by v.auktion_id;
$function$;
revoke execute on function public.hent_mine_visninger(uuid[]) from public, anon;
grant execute on function public.hent_mine_visninger(uuid[]) to authenticated;

-- Den gamle taeller (kun testdatabasen): kan ikke laengere kaldes af brugere.
do $$
begin
  if to_regprocedure('public.oeg_auktion_visning(uuid)') is not null then
    revoke execute on function public.oeg_auktion_visning(uuid) from public, anon, authenticated;
  end if;
end $$;

-- =============================================================== L6 antal bud
-- Bud er ikke laengere offentlige, saa bids(count) kan ikke bruges til
-- auktionskort. Antallet vedligeholdes i stedet paa auktionen.
alter table public.auctions
  add column if not exists antal_bud integer not null default 0;

update public.auctions a
   set antal_bud = sub.n
  from (select auktion_id, count(*)::int as n from public.bids group by auktion_id) sub
 where sub.auktion_id = a.id
   and a.antal_bud is distinct from sub.n;

create or replace function public.bids_oeg_antal()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.auctions set antal_bud = antal_bud + 1 where id = new.auktion_id;
  return null;
end;
$fn$;
revoke execute on function public.bids_oeg_antal() from public, anon, authenticated;

drop trigger if exists bids_oeg_antal on public.bids;
create trigger bids_oeg_antal
  after insert on public.bids
  for each row execute function public.bids_oeg_antal();

-- Taellerne (antal_bud, visninger) kan kun aendres af databasen selv
-- (security definer-funktioner ejet af postgres) og service_role.
create or replace function public.auctions_beskyt_taellere()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.antal_bud := 0;
    return new;
  end if;

  -- visninger findes kun paa testdatabasen; tjekkes via jsonb, saa
  -- triggeren ogsaa virker i produktion uden kolonnen.
  if new.antal_bud is distinct from old.antal_bud
     or (to_jsonb(new) -> 'visninger') is distinct from (to_jsonb(old) -> 'visninger') then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke execute on function public.auctions_beskyt_taellere() from public, anon, authenticated;

drop trigger if exists auctions_beskyt_taellere on public.auctions;
create trigger auctions_beskyt_taellere
  before insert or update on public.auctions
  for each row execute function public.auctions_beskyt_taellere();

-- =============================================================== L6 bids
-- Byderes bruger-id'er maa ikke kunne hentes af andre. Hjemmesiden viser en
-- anonymiseret budhistorik ("Byder 3"/"Dig"), som serveren bygger med
-- service-role. Realtime paa bids respekterer RLS, saa andre byderes bud
-- sendes ikke laengere ud; klienten lytter i stedet paa auctions.
drop policy if exists "bids_select_all" on public.bids;
drop policy if exists bids_select_all on public.bids;
drop policy if exists bids_select_own on public.bids;
create policy bids_select_own on public.bids
  for select to authenticated using (bruger_id = auth.uid());
revoke select on public.bids from anon;

-- =============================================================== L6 seller_follows
-- Kun brugeren selv kan se, hvem han foelger.
do $$
begin
  if to_regclass('public.seller_follows') is not null then
    execute 'drop policy if exists seller_follows_select_all on public.seller_follows';
    execute 'drop policy if exists seller_follows_select_own on public.seller_follows';
    execute 'create policy seller_follows_select_own on public.seller_follows
               for select to authenticated using (follower_id = auth.uid())';
    execute 'revoke select on public.seller_follows from anon';
  end if;
end $$;

-- =============================================================== L3 rate limiting
-- Fast tidsvindue pr. noegle (fx 'login_ip:1.2.3.4'). Kun service_role
-- (server-kode via createAdminClient) kan kalde funktionen.
-- Ikke handelsdata - gamle raekker ryddes loebende.
create table if not exists public.rate_limits (
  noegle        text not null,
  vindue_start  timestamptz not null,
  antal         integer not null default 0,
  primary key (noegle, vindue_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
grant all on public.rate_limits to service_role;

create or replace function public.rate_limit_tjek(
  p_noegle text,
  p_maks integer,
  p_vindue_sek integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  start timestamptz;
  n integer;
begin
  if p_noegle is null or length(p_noegle) > 400 or p_maks < 1 or p_vindue_sek < 1 then
    raise exception 'Ugyldige parametre';
  end if;

  start := to_timestamp(floor(extract(epoch from now()) / p_vindue_sek) * p_vindue_sek);

  insert into public.rate_limits as r (noegle, vindue_start, antal)
  values (p_noegle, start, 1)
  on conflict (noegle, vindue_start)
  do update set antal = r.antal + 1
  returning r.antal into n;

  -- Ryd op en gang imellem (ca. 1 af 100 kald).
  if random() < 0.01 then
    delete from public.rate_limits where vindue_start < now() - interval '1 day';
  end if;

  return n <= p_maks;
end;
$fn$;
revoke execute on function public.rate_limit_tjek(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_tjek(text, integer, integer) to service_role;
