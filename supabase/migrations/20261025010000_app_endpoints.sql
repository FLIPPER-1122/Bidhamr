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
--   4. auktion_saelger_kan_saelge(p_auktion) - false, hvis auktionens
--      sælger er frosset (betalingsprofiler.saelger_frosset_kl, BHU03 - der
--      kan ikke bydes på sælgerens auktioner). Kun for en auktion, kalderen
--      kan se (samme regel som auktionssiden/RLS) - ellers null. Kun ja/nej.
--      anon og authenticated. Den tidligere saelger_kan_saelge(p_saelger)
--      (svarede for en vilkårlig bruger) fjernes.
--   5. Handelschat læst-status: tabellen handel_chat_laest (én række pr.
--      bruger pr. handel) + handel_chat_marker_laest(p_trade) og
--      antal_ulaeste_handelsbeskeder(). Kun egne handler (køber/sælger).
--      Ved oprettelsen markeres alle eksisterende handler som læst nu, så
--      gamle beskeder ikke tæller som nye.
--   6. app_bud_noegler - idempotens for appens bud (POST /api/bud/app):
--      samme nøgle fra samme bruger giver samme svar - bundet til auktion,
--      type (bud/maksimum) og beløb. Kun service_role.
--   7. Billeder er bevis i en åben sag:
--      - app_bruger_har_aaben_sag(p_bruger) - intern hjælper: har brugeren
--        en åben DSA-anmeldelse, rapport eller DSA-klage, eller en
--        afgørelse, hvor klagefristen stadig løber?
--      - auktion_billede_laast (storage-policyen auktion_billeder_slet_ikke_laast,
--        restriktiv) låser nu også alle billeder i mappen hos en bruger med
--        en åben sag - så sælgeren heller ikke kan slette dem direkte i
--        Storage med sit eget token. md5-drift-tjek.
--      - auktion_billeder_sletbare(p_bruger, p_stier) - hvilke af sælgerens
--        storage-stier serveren må slette efter en redigering (ingen af
--        sælgerens auktioner bruger dem), eller 'sag_aaben'. Kun service_role.
--
-- Nye funktioner: security definer, search_path = '', brugeren udledes af
-- auth.uid(). Ingen af dem ændrer handelsdata.
--
-- Forudsætning: 20261023010000_kunst_forbudt.sql og 20261023030000_boost.sql.
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
-- Må kalderen se auktionen? Samme regel som RLS på auctions
-- (auctions_select_anon og auctions_select_authenticated, 20261023010000):
-- synlig for alle, når den ikke er arkiveret, skjult eller afventer
-- kunst-kontrol; ellers kun for sælgeren, staff og deltagere
-- (auktion_arkiv_adgang). Intern hjælper - kun til funktionerne herunder.
create or replace function public.app_auktion_synlig(p_auktion uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  a record;
begin
  if p_auktion is null then return false; end if;
  select x.id, x.bruger_id, x.arkiveret_kl, coalesce(x.skjult, false) as skjult, x.kunst_kontrol
    into a from public.auctions x where x.id = p_auktion;
  if a.id is null then return false; end if;
  return (a.arkiveret_kl is null and not a.skjult and a.kunst_kontrol is distinct from 'afventer')
      or (v_uid is not null and (a.bruger_id = v_uid or public.er_staff() or public.auktion_arkiv_adgang(a.id)));
end;
$fn$;

revoke all on function public.app_auktion_synlig(uuid) from public, anon, authenticated, service_role;

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
begin
  -- Kun en auktion, kalderen må se (som RLS - app_auktion_synlig).
  if not public.app_auktion_synlig(p_auktion) then return; end if;

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
-- "gammel" = prod og test før denne migration (hentet med SELECT 16. okt.
-- 2026, ens med 20261023030000_boost.sql), "ny" = efter.
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
-- 4. Kan der bydes på auktionens sælger? (BHU03)
-- ===========================================================================
-- Den første udgave (saelger_kan_saelge(p_saelger)) svarede for en vilkårlig
-- bruger - fjernes.
drop function if exists public.saelger_kan_saelge(uuid);

-- supabase.rpc("auktion_saelger_kan_saelge", { p_auktion }) -> true | false |
-- null. false = sælgeren er frosset (bids_kraev_saelger_ikke_frosset
-- afviser buddet med BHU03). null = auktionen findes ikke, eller kalderen
-- kan ikke se den. Kun ja/nej - aldrig hvorfor eller hvornår.
create or replace function public.auktion_saelger_kan_saelge(p_auktion uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case when not public.app_auktion_synlig(p_auktion) then null
              else not exists (
                select 1 from public.auctions a
                  join public.betalingsprofiler bp on bp.user_id = a.bruger_id
                 where a.id = p_auktion and bp.saelger_frosset_kl is not null) end;
$fn$;

revoke all on function public.auktion_saelger_kan_saelge(uuid) from public;
grant execute on function public.auktion_saelger_kan_saelge(uuid) to anon, authenticated, service_role;

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
  -- Nøglen er bundet til buddet: samme nøgle med en anden auktion, type
  -- eller et andet beløb afvises (409 noegle_brugt).
  type         text check (type is null or type in ('bud', 'maksimum')),
  beloeb_oere  bigint check (beloeb_oere is null or beloeb_oere > 0),
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

-- Tabellen fandtes i den første udgave af migrationen uden type og beløb.
alter table public.app_bud_noegler add column if not exists type text;
alter table public.app_bud_noegler add column if not exists beloeb_oere bigint;
do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_bud_noegler_type_check') then
    alter table public.app_bud_noegler add constraint app_bud_noegler_type_check
      check (type is null or type in ('bud', 'maksimum'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_bud_noegler_beloeb_oere_check') then
    alter table public.app_bud_noegler add constraint app_bud_noegler_beloeb_oere_check
      check (beloeb_oere is null or beloeb_oere > 0);
  end if;
end $do$;

-- ===========================================================================
-- 7. Billeder er bevis i en åben sag
-- ===========================================================================
-- Har brugeren en åben sag, hvor billeder af brugerens auktioner kan være
-- bevis? Gælder HELE brugeren (alle brugerens auktioner), så et andet
-- auktion_id ikke kan bruges til at slette bevis:
--   - en DSA-anmeldelse, der ikke er afgjort (status 'ny' - også når den er
--     videresendt til admin, eskaleret_kl), om brugeren eller en af
--     brugerens auktioner,
--   - en rapport ('pending' / 'under_behandling') om en af brugerens auktioner,
--   - en DSA-klage, der afventer, over en afgørelse/anmeldelse om brugeren
--     eller en af brugerens auktioner,
--   - en DSA-afgørelse om brugeren eller en af brugerens auktioner, hvor
--     klagefristen stadig løber (klage_frist_kl > now()).
-- Intern hjælper: kun til auktion_billede_laast og auktion_billeder_sletbare.
create or replace function public.app_bruger_har_aaben_sag(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_bruger is not null and (
    exists (select 1 from public.dsa_anmeldelser d
             where d.status <> 'afgjort'
               and (d.anmeldt_bruger_id = p_bruger
                    or exists (select 1 from public.auctions a
                                where a.bruger_id = p_bruger
                                  and (a.id = d.auktion_id or (d.indhold_type = 'auktion' and a.id = d.indhold_id)))))
    or exists (select 1 from public.reports r
                 join public.auctions a on a.id = r.auction_id
                where a.bruger_id = p_bruger and r.status in ('pending', 'under_behandling'))
    or exists (select 1 from public.dsa_klager k
                 left join public.dsa_afgoerelser f on f.id = k.afgoerelse_id
                 left join public.dsa_anmeldelser d on d.id = k.anmeldelse_id
                where k.status <> 'afgjort'
                  and (f.bruger_id = p_bruger or d.anmeldt_bruger_id = p_bruger
                       or exists (select 1 from public.auctions a
                                   where a.bruger_id = p_bruger and (a.id = f.auktion_id or a.id = d.auktion_id))))
    or exists (select 1 from public.dsa_afgoerelser f
                where f.klage_frist_kl > now()
                  and (f.bruger_id = p_bruger
                       or exists (select 1 from public.auctions a where a.bruger_id = p_bruger and a.id = f.auktion_id)))
  );
$fn$;

revoke all on function public.app_bruger_har_aaben_sag(uuid) from public, anon, authenticated, service_role;

-- Storage: auktion_billede_laast(name) bruges af den restriktive policy
-- auktion_billeder_slet_ikke_laast på storage.objects. Før: kun billeder fra
-- auktioner med bud eller handel. Nu også alle billeder i mappen hos en
-- bruger med en åben sag (ejeren af mappen = første del af stien).
-- "gammel" = prod og test før denne migration (hentet med SELECT 16. okt.
-- 2026), "ny" = efter.
do $do$
begin
  raise notice 'auktion_billede_laast: %', pg_temp.ps_ret(
    'public.auktion_billede_laast(text)',
    '274d77676c299040c5661c7e68637893',
    '088aceada3f89c0cc6568884cb495b7b',
    jsonb_build_array(jsonb_build_array(
      $g$  select p_name is not null
     and exists (
$g$,
      $n$  select p_name is not null
     and public.app_bruger_har_aaben_sag(
           case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then split_part(p_name, '/', 1)::uuid end)
      or p_name is not null
     and exists (
$n$,
      1)));
end $do$;

revoke all on function public.auktion_billede_laast(text) from public, anon;
grant execute on function public.auktion_billede_laast(text) to authenticated, service_role;

-- Serverens oprydning efter en redigering (hjemmesiden og appen): hvilke af
-- p_stier ("<bruger-id>/<fil>.jpg" i bucket auktion-billeder) må slettes?
-- Kun stier i sælgerens egen mappe, som INGEN af sælgerens auktioner bruger
-- (som offentlig URL eller ren sti) - tjekket i SQL for præcis de stier.
-- Højst 100 stier. Åben sag (app_bruger_har_aaben_sag) = intet slettes.
-- Svar: { kode: 'ok', stier: [...] } | { kode: 'sag_aaben' } | { kode: 'ugyldig' }.
-- Kun service_role: serveren har verificeret sælgeren (p_bruger).
-- Den første udgave havde p_auktion (tjek af én auktion) - fjernes.
drop function if exists public.auktion_billeder_sletbare(uuid, uuid, text[]);

create or replace function public.auktion_billeder_sletbare(p_bruger uuid, p_stier text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_mark constant text := '/storage/v1/object/public/auktion-billeder/';
  v_stier text[];
begin
  if p_bruger is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if public.app_bruger_har_aaben_sag(p_bruger) then return jsonb_build_object('kode', 'sag_aaben'); end if;

  select coalesce(array_agg(distinct s.sti order by s.sti), '{}'::text[]) into v_stier
    from unnest((coalesce(p_stier, '{}'::text[]))[1:100]) as s(sti)
   where s.sti ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,100}\.[a-z0-9]{1,5}$'
     and left(s.sti, 37) = lower(p_bruger::text) || '/'
     and not exists (
       select 1
         from public.auctions a
         cross join lateral unnest(coalesce(a.billeder, '{}'::text[])) as u(url)
        where a.bruger_id = p_bruger
          and (u.url = s.sti
               or right(split_part(split_part(u.url, '?', 1), '#', 1), length(v_mark) + length(s.sti)) = v_mark || s.sti));
  return jsonb_build_object('kode', 'ok', 'stier', to_jsonb(v_stier));
end;
$fn$;

revoke all on function public.auktion_billeder_sletbare(uuid, text[]) from public, anon, authenticated;
grant execute on function public.auktion_billeder_sletbare(uuid, text[]) to service_role;
