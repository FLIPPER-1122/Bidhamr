-- Appens manglende endpoints (docs/APP-ENDPOINTS.md, 15. okt. 2026).
--
--   1. auktion_budhistorik(p_auktion) - anonym budhistorik som på
--      auktionssiden: "Byder 1", "Byder 2" ... i den rækkefølge, de først bød
--      (egne bud: "Dig" og er_mig = true), beløb (kr.), tidspunkt og
--      "automatisk". Højst de 50 højeste bud (som siden). Aldrig byder-id,
--      navn eller maksimum. Kun for auktioner, kalderen må se efter
--      RLS-reglen på auctions (auctions_select_anon/-authenticated, også
--      kunst_kontrol = 'afventer' og skjulte). anon og authenticated.
--   2. mine_kunst_kontrol(p_ids) - kunst-kontrollens status for kalderens
--      EGNE auktioner (auctions.bruger_id = auth.uid()), højst 500 id'er.
--      Kun authenticated.
--   3. min_auktion_boost: grund = 'kunst_kontrol' (før: 'ikke_aktiv'), når
--      auktionen afventer kunst-kontrol. md5-drift-tjek som 20261024010000.
--   4. saelger_kan_saelge(p_saelger) - false, hvis sælgeren er frosset
--      (betalingsprofiler.saelger_frosset_kl, BHU03 - der kan ikke bydes på
--      sælgerens auktioner). Kun ja/nej, intet andet om sælgeren. Samme
--      regel, som auktionssiden viser før buddet. anon og authenticated.
--   5. Handelschat læst-status: tabellen handel_chat_laest (én række pr.
--      bruger pr. handel) + handel_chat_marker_laest(p_trade) og
--      antal_ulaeste_handelsbeskeder(). Kun egne handler (køber/sælger).
--      Ved oprettelsen markeres alle eksisterende handler som læst nu, så
--      gamle beskeder ikke tæller som nye.
--   6. app_bud_noegler - idempotens for appens bud (POST /api/bud/app):
--      samme nøgle fra samme bruger giver samme svar. Kun service_role.
--
-- Nye funktioner: security definer, search_path = '', brugeren udledes af
-- auth.uid(). Ingen af dem ændrer handelsdata.
--
-- Forudsætning: 20261023010000_kunst_forbudt.sql og 20261023030000_boost.sql
-- (kører ikke i produktion endnu - kør dem først).
-- Idempotent (kan køres igen). Én transaktion: filen køres som én samlet
-- forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'auctions' and column_name = 'kunst_kontrol') then
    raise exception 'Forudsætning mangler: kør 20261023010000_kunst_forbudt.sql først';
  end if;
  if to_regprocedure('public.min_auktion_boost(uuid)') is null then
    raise exception 'Forudsætning mangler: kør 20261023030000_boost.sql først';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'betalingsprofiler' and column_name = 'saelger_frosset_kl')
     or to_regclass('public.messages') is null or to_regclass('public.trades') is null then
    raise exception 'Forudsætning mangler: betalingsprofiler.saelger_frosset_kl, messages eller trades';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session) - som 20261024010000
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- md5 før (gammel) eller allerede rettet (ny); hvert mønster skal findes
-- præcis det forventede antal gange; md5 bagefter skal være "ny". Ellers
-- afbrydes migrationen (intet ændres).
create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- ===========================================================================
-- 1. Anonym budhistorik
-- ===========================================================================
-- supabase.rpc("auktion_budhistorik", { p_auktion }) -> [{ id, byder, beloeb,
-- oprettet, automatisk, er_mig }], højeste bud først (som auktionssiden).
-- beloeb er i hele kroner (som bids."beløb" og auctions."nuværende_bud").
create or replace function public.auktion_budhistorik(p_auktion uuid)
returns table (id uuid, byder text, beloeb numeric, oprettet timestamptz, automatisk boolean, er_mig boolean)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  a record;
begin
  if p_auktion is null then return; end if;
  select x.id, x.bruger_id, x.arkiveret_kl, coalesce(x.skjult, false) as skjult, x.kunst_kontrol
    into a from public.auctions x where x.id = p_auktion;
  if a.id is null then return; end if;

  -- Samme regel som RLS på auctions (auctions_select_anon og
  -- auctions_select_authenticated, 20261023010000): synlig for alle, når
  -- den ikke er arkiveret, skjult eller afventer kunst-kontrol; ellers kun
  -- for sælgeren, staff og deltagere (auktion_arkiv_adgang).
  if not (
    (a.arkiveret_kl is null and not a.skjult and a.kunst_kontrol is distinct from 'afventer')
    or (v_uid is not null and (a.bruger_id = v_uid or public.er_staff() or public.auktion_arkiv_adgang(a.id)))
  ) then
    return;
  end if;

  return query
  with top as (
    -- De 50 højeste bud (bud stiger altid, så beløb giver samme rækkefølge
    -- som tidspunktet - også for automatiske bud i samme transaktion).
    select b.id, b.bruger_id, b."beløb" as beloeb, b.oprettet, coalesce(b.automatisk, false) as automatisk
      from public.bids b
     where b.auktion_id = p_auktion
     order by b."beløb" desc, b.oprettet desc, b.id desc
     limit 50
  ), foerste as (
    -- "Byder N" i den rækkefølge, byderne først bød (blandt de viste bud).
    select t.bruger_id, min(t.pos) as pos
      from (select top.bruger_id,
                   row_number() over (order by top.beloeb asc, top.oprettet asc, top.id asc) as pos
              from top) t
     group by t.bruger_id
  ), nr as (
    select f.bruger_id, row_number() over (order by f.pos) as nr from foerste f
  )
  select top.id,
         case when v_uid is not null and top.bruger_id = v_uid then 'Dig' else 'Byder ' || nr.nr end,
         top.beloeb,
         top.oprettet,
         top.automatisk,
         (v_uid is not null and top.bruger_id = v_uid)
    from top
    join nr on nr.bruger_id = top.bruger_id
   order by top.beloeb desc, top.oprettet desc, top.id desc;
end;
$fn$;

revoke all on function public.auktion_budhistorik(uuid) from public;
grant execute on function public.auktion_budhistorik(uuid) to anon, authenticated, service_role;

-- ===========================================================================
-- 2. Kunst-kontrol for egne auktioner
-- ===========================================================================
-- supabase.rpc("mine_kunst_kontrol", { p_ids: [id, ...] }) -> [{ auction_id,
-- kunst_kontrol: null | 'afventer' | 'godkendt' | 'afvist' }]. Kun kalderens
-- egne auktioner; andres id'er giver ingen række.
create or replace function public.mine_kunst_kontrol(p_ids uuid[])
returns table (auction_id uuid, kunst_kontrol text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id, a.kunst_kontrol
    from public.auctions a
   where a.id = any ((coalesce(p_ids, '{}'::uuid[]))[1:500])
     and a.bruger_id = (select auth.uid());
$fn$;

revoke all on function public.mine_kunst_kontrol(uuid[]) from public, anon;
grant execute on function public.mine_kunst_kontrol(uuid[]) to authenticated, service_role;

-- ===========================================================================
-- 3. min_auktion_boost: grund 'kunst_kontrol'
-- ===========================================================================
-- "gammel" = test før denne migration (hentet med SELECT 15. okt. 2026, ens
-- med 20261023030000_boost.sql; prod har endnu ikke funktionen), "ny" = efter.
do $do$
begin
  raise notice 'min_auktion_boost: %', pg_temp.ps_ret(
    'public.min_auktion_boost(uuid)',
    '97acd0e76c8b0af99f5d3b454168009a',
    '38f1a10851e79db6549365803513166b',
    jsonb_build_array(jsonb_build_array(
      $g$    when public.boost_kunst_afventer(p_auktion) then 'ikke_aktiv'
$g$,
      $n$    when public.boost_kunst_afventer(p_auktion) then 'kunst_kontrol'
$n$,
      1)));
end $do$;

-- create or replace (via ps_ret) bevarer rettighederne; sat igen for en sikkerheds skyld.
revoke all on function public.min_auktion_boost(uuid) from public, anon;
grant execute on function public.min_auktion_boost(uuid) to authenticated, service_role;

-- ===========================================================================
-- 4. Kan der bydes på sælgerens auktioner? (BHU03)
-- ===========================================================================
-- supabase.rpc("saelger_kan_saelge", { p_saelger }) -> true | false.
-- false = sælgeren er frosset (bids_kraev_saelger_ikke_frosset afviser
-- buddet med BHU03). Kun ja/nej - aldrig hvorfor eller hvornår.
create or replace function public.saelger_kan_saelge(p_saelger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select not exists (
    select 1 from public.betalingsprofiler bp
     where bp.user_id = p_saelger and bp.saelger_frosset_kl is not null);
$fn$;

revoke all on function public.saelger_kan_saelge(uuid) from public;
grant execute on function public.saelger_kan_saelge(uuid) to anon, authenticated, service_role;

-- ===========================================================================
-- 5. Handelschat: læst-status
-- ===========================================================================
do $do$
begin
  if to_regclass('public.handel_chat_laest') is null then
    create table public.handel_chat_laest (
      trade_id   uuid not null references public.trades(id) on delete cascade,
      bruger_id  uuid not null references public.users(id) on delete cascade,
      laest_kl   timestamptz not null default now(),
      primary key (trade_id, bruger_id)
    );
    -- Første gang: alle eksisterende handler regnes som læst nu, så gamle
    -- beskeder ikke tæller som nye (køres kun, når tabellen oprettes).
    insert into public.handel_chat_laest (trade_id, bruger_id, laest_kl)
    select t.id, p.bruger_id, now()
      from public.trades t
      cross join lateral (values (t.buyer_id), (t.seller_id)) as p(bruger_id)
     where p.bruger_id is not null
    on conflict do nothing;
  end if;
end $do$;

comment on table public.handel_chat_laest is
  'Hvornår brugeren sidst har læst chatten i en handel (ulæste-tæller i appen). Skrives kun via handel_chat_marker_laest.';

alter table public.handel_chat_laest enable row level security;
revoke all on table public.handel_chat_laest from public, anon, authenticated;
grant select on table public.handel_chat_laest to authenticated;
grant all on table public.handel_chat_laest to service_role;

drop policy if exists handel_chat_laest_select_egen on public.handel_chat_laest;
create policy handel_chat_laest_select_egen on public.handel_chat_laest
  for select to authenticated
  using (bruger_id = (select auth.uid()));

-- supabase.rpc("handel_chat_marker_laest", { p_trade }) -> true (markeret)
-- | false (ikke din handel). Kun køber og sælger. Tidspunktet flyttes aldrig
-- tilbage.
create or replace function public.handel_chat_marker_laest(p_trade uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or p_trade is null then return false; end if;
  if not exists (select 1 from public.trades t
                  where t.id = p_trade and (t.buyer_id = v_uid or t.seller_id = v_uid)) then
    return false;
  end if;
  insert into public.handel_chat_laest as l (trade_id, bruger_id, laest_kl)
  values (p_trade, v_uid, now())
  on conflict (trade_id, bruger_id) do update set laest_kl = greatest(l.laest_kl, excluded.laest_kl);
  return true;
end;
$fn$;

revoke all on function public.handel_chat_marker_laest(uuid) from public, anon;
grant execute on function public.handel_chat_marker_laest(uuid) to authenticated;

-- supabase.rpc("antal_ulaeste_handelsbeskeder") -> antal beskeder fra
-- modparten (og fra BidHamr) i kalderens handler efter sidste læsning.
-- Spamblokerede beskeder tæller ikke (modtageren kan ikke se dem).
create or replace function public.antal_ulaeste_handelsbeskeder()
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::integer
    from public.messages m
    join public.trades t on t.id = m.trade_id
    left join public.handel_chat_laest l
      on l.trade_id = m.trade_id and l.bruger_id = (select auth.uid())
   where (t.buyer_id = (select auth.uid()) or t.seller_id = (select auth.uid()))
     and m.sender_id is distinct from (select auth.uid())
     and m.blokeret_grund is null
     and m.created_at > coalesce(l.laest_kl, '-infinity'::timestamptz);
$fn$;

revoke all on function public.antal_ulaeste_handelsbeskeder() from public, anon;
grant execute on function public.antal_ulaeste_handelsbeskeder() to authenticated;

-- ===========================================================================
-- 6. Idempotens for appens bud
-- ===========================================================================
create table if not exists public.app_bud_noegler (
  bruger_id    uuid not null references public.users(id) on delete cascade,
  noegle       uuid not null,
  auktion_id   uuid not null,
  -- Svaret, appen fik (null, mens buddet behandles).
  svar         jsonb,
  oprettet_kl  timestamptz not null default now(),
  primary key (bruger_id, noegle)
);

comment on table public.app_bud_noegler is
  'Idempotens-nøgler for POST /api/bud/app (samme nøgle = samme svar). Kun serveren (service_role). Ryddes efter et døgn. Ikke handelsdata - buddene står i bids.';

alter table public.app_bud_noegler enable row level security;
revoke all on table public.app_bud_noegler from public, anon, authenticated;
grant all on table public.app_bud_noegler to service_role;
