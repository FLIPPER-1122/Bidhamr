-- Henvis en ven og Påmindelse før slut: rettelser efter review (27. okt. 2026).
-- Bygger på 20261102230000_henvis_en_ven.sql og
-- 20261102250000_paamindelse_foer_slut.sql (rettes ikke - denne fil ændrer
-- funktionerne med create or replace).
--
-- 1. Henviseren skal selv være MitID-verificeret (Filip, 27. okt. 2026 -
--    ROADMAP-BESLUTNINGER.md, "Nye funktioner før lancering", punkt 3). Uden
--    en aktiv verificering gives 0 point med den nye status
--    'henviser_uverificeret'. Lukker hullet, hvor en person uden MitID
--    henviste sin egen anden konto: 'samme_person' kunne ikke se det, fordi
--    henviseren ingen MitID havde.
-- 2. henvisning_vurder venter aldrig på en lås: den kaldes fra triggeren på
--    mitid_verificeringer (midt i MitID-registreringen). Rækken tages med
--    "for update skip locked", og pointkontoen og MitID'en med
--    pg_try_advisory_xact_lock. Kan en lås ikke tages, forbliver
--    henvisningen 'afventer', og henvisning_synk (cron) tager den senere.
-- 3. henvisning_synk: rækker, der bliver ved med at fejle (eller ikke kan
--    låses), blokerer ikke nye. Nye kolonner synk_forsoeg og synk_sidst_kl;
--    synk tager de mindst forsøgte først. Fejl logges i drift ved 1., 10.
--    og 100. forsøg.
-- 4. min_henvisningskode(): let, læsende opslag af brugerens egen kode (kun
--    private, auth.uid(), opretter intet) til Del-knappen på auktionssiden.
--    Koden laves stadig kun af min_henvisning() (/konto/henvis og appens
--    POST /api/konto/henvisning). min_henvisning() får feltet
--    mitid_verificeret.
-- 5. paamindelser_foer_slut_claim: aldrig til lukkede eller suspenderede
--    konti (konto_lukket_kl, suspenderet/suspenderet_til - samme regel som
--    budmotoren).
-- 6. "Download dine data" (mine_data): nøglen 'henvis_en_ven' med egen kode,
--    egne henvisninger (status, point, datoer - aldrig vennens id, navn eller
--    MitID) og om man selv er henvist (kun datoen - ikke af hvem).
--
-- Ingen cookie (Filip, 27. okt. 2026): ændrer intet i databasen - koden
-- sendes med fra formularen og knyttes som før af henvisning_knyt efter
-- verifyOtp.
--
-- Idempotent (kan køres igen). Kun testdatabasen, indtil Filip siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.henvisninger') is null or to_regprocedure('public.henvisning_vurder(uuid, text)') is null then
    raise exception 'Forudsætning mangler: 20261102230000_henvis_en_ven.sql';
  end if;
  if to_regclass('public.auktion_paamindelser') is null then
    raise exception 'Forudsætning mangler: 20261102250000_paamindelse_foer_slut.sql';
  end if;
  if to_regprocedure('public.mine_data()') is null or to_regprocedure('public.mine_data_erhverv_klager(uuid)') is null then
    raise exception 'Forudsætning mangler: mine_data og mine_data_erhverv_klager (20261016020000_erhverv_klager.sql)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Ny status + synk-kolonner
-- ===========================================================================
alter table public.henvisninger drop constraint if exists henvisninger_status_check;
alter table public.henvisninger add constraint henvisninger_status_check check (status in (
  'afventer',              -- vennen er ikke MitID-verificeret endnu
  'belonnet',              -- henviseren fik point
  'loft',                  -- over månedens loft: 0 point
  'firma',                 -- henviseren er en firmakonto: 0 point
  'spaerret',              -- henviserens konto er lukket, slettet eller suspenderet: 0 point
  'foer_lancering',        -- verificeret før lanceringen: 0 point
  'samme_person',          -- vennens MitID er henviserens egen: 0 point
  'tidligere_konto',       -- MitID'en har været brugt før (anden konto eller henvisning): 0 point
  'henviser_uverificeret'  -- henviseren havde ingen aktiv MitID-verificering: 0 point
));

-- Sikkerhedsnettet (henvisning_synk): hvor mange gange en afventende
-- henvisning er forsøgt uden resultat, og hvornår sidst. Kun service_role kan
-- læse dem (ingen kolonne-grant til authenticated).
alter table public.henvisninger add column if not exists synk_forsoeg integer not null default 0;
alter table public.henvisninger add column if not exists synk_sidst_kl timestamptz;
alter table public.henvisninger drop constraint if exists henvisninger_synk_forsoeg_check;
alter table public.henvisninger add constraint henvisninger_synk_forsoeg_check check (synk_forsoeg >= 0);
create index if not exists henvisninger_synk
  on public.henvisninger (synk_forsoeg, synk_sidst_kl nulls first, oprettet_kl) where status = 'afventer';

-- ===========================================================================
-- 2. Lås uden at vente (samme nøgle som boost_laas_bruger, 20261023030000)
-- ===========================================================================
create or replace function public.boost_proev_laas_bruger(p_bruger uuid)
returns boolean language sql volatile set search_path = '' as $fn$
  select pg_try_advisory_xact_lock(hashtextextended('bidhamr-boost-point:' || p_bruger::text, 0));
$fn$;
revoke all on function public.boost_proev_laas_bruger(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. henvisning_vurder: MitID-krav for henviseren + låse uden ventetid
-- ===========================================================================
-- Intern (kun triggeren og henvisning_synk). Idempotent: kun en henvisning
-- med status 'afventer' vurderes, og opdateringen sker med
-- "where status = 'afventer'". Svar: den nye status, eller null (intet at
-- gøre, eller en lås var optaget - så forbliver den 'afventer').
create or replace function public.henvisning_vurder(p_ven uuid, p_hash text)
returns text language plpgsql security definer set search_path = public as $fn$
declare
  s        public.henvisning_indstillinger%rowtype;
  h        public.henvisninger%rowtype;
  v_maaned text := to_char(now() at time zone 'Europe/Copenhagen', 'YYYY-MM');
  v_status text;
  v_point  integer := 0;
  v_antal  integer;
  v_henv   record;
  n        integer;
begin
  if p_ven is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  -- Ingen ventetid: er rækken låst af en anden (fx synk), springes den over.
  select * into h from public.henvisninger
   where ven_id = p_ven and status = 'afventer'
   for update skip locked;
  if not found then
    return null;
  end if;

  -- Lås henviserens pointkonto (samme nøgle som boost_posteringer), så loftet
  -- holder ved samtidige verificeringer, og MitID'en, så samme identitet ikke
  -- vurderes to steder på én gang. Begge uden at vente: triggeren må aldrig
  -- holde MitID-registreringen hen. Optaget = prøv igen senere (synk).
  if not public.boost_proev_laas_bruger(h.henviser_id)
     or not pg_try_advisory_xact_lock(hashtextextended('bidhamr-henvisning-mitid:' || p_hash, 0)) then
    return null;
  end if;

  select * into s from public.henvisning_indstillinger where id;
  select u.konto_type into v_henv from public.users u where u.id = h.henviser_id;

  if s.optjening_fra_kl is null or now() < s.optjening_fra_kl then
    v_status := 'foer_lancering';
  elsif v_henv.konto_type is distinct from 'privat' then
    v_status := 'firma';
  elsif exists (select 1 from public.mitid_verificeringer v
                 where v.bruger_id = h.henviser_id and v.id_hash = p_hash) then
    v_status := 'samme_person';
  elsif exists (select 1 from public.mitid_verificeringer v
                 where v.id_hash = p_hash and v.bruger_id <> p_ven)
     or exists (select 1 from public.henvisninger x
                 where x.mitid_hash = p_hash and x.id <> h.id) then
    -- Personen har haft en konto før (fx slettet og oprettet igen), eller
    -- MitID'en har allerede været vurderet i en anden henvisning.
    v_status := 'tidligere_konto';
  elsif not exists (select 1 from public.mitid_verificeringer v
                     where v.bruger_id = h.henviser_id and v.status = 'aktiv') then
    -- Henviseren skal selv være MitID-verificeret (Filip, 27. okt. 2026).
    -- Ellers kan samme person uden MitID henvise sin egen anden konto, og
    -- 'samme_person' ovenfor kan ikke se det.
    v_status := 'henviser_uverificeret';
  elsif public.boost_bruger_spaerret(h.henviser_id) is not null then
    v_status := 'spaerret';
  else
    select count(*) into v_antal from public.henvisninger x
     where x.henviser_id = h.henviser_id and x.status = 'belonnet' and x.maaned = v_maaned;
    if v_antal >= s.maks_pr_maaned then
      v_status := 'loft';
    else
      v_status := 'belonnet';
      v_point := s.point_pr_ven;
    end if;
  end if;

  update public.henvisninger
     set status = v_status, point = v_point, mitid_hash = p_hash, vurderet_kl = now(), maaned = v_maaned
   where id = h.id and status = 'afventer';
  get diagnostics n = row_count;
  if n = 0 then
    return null;
  end if;

  if v_point > 0 then
    insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, henvisning_id)
    values (h.henviser_id, 'henvisning', v_point, 0, h.id)
    on conflict do nothing;
  end if;
  return v_status;
end;
$fn$;
revoke all on function public.henvisning_vurder(uuid, text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. henvisning_synk: de mindst forsøgte først
-- ===========================================================================
-- Sikkerhedsnet (cron, service_role): henvisninger, der stadig afventer,
-- selvom vennen har en aktiv MitID-verificering (triggeren fejlede, eller en
-- lås var optaget). En række, der ikke blev vurderet, får synk_forsoeg + 1
-- og synk_sidst_kl = now() og kommer bagerst i køen - så kan den aldrig
-- blokere nye. Svar: { vurderet, fejl, udskudt }.
create or replace function public.henvisning_synk(p_graense integer default 200)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  r        record;
  v_res    text;
  v_err    text;
  v_ok     integer := 0;
  v_fejl   integer := 0;
  v_udsk   integer := 0;
begin
  for r in
    select h.id, h.ven_id, v.id_hash, h.synk_forsoeg
      from public.henvisninger h
      join public.mitid_verificeringer v on v.bruger_id = h.ven_id and v.status = 'aktiv'
     where h.status = 'afventer'
     order by h.synk_forsoeg, h.synk_sidst_kl nulls first, h.oprettet_kl, h.id
     limit greatest(1, least(coalesce(p_graense, 200), 1000))
  loop
    v_res := null;
    v_err := null;
    begin
      v_res := public.henvisning_vurder(r.ven_id, r.id_hash);
    exception when others then
      v_err := left(sqlstate || ': ' || sqlerrm, 800);
    end;
    if v_res is not null then
      v_ok := v_ok + 1;
    else
      if v_err is not null then v_fejl := v_fejl + 1; else v_udsk := v_udsk + 1; end if;
      -- Uden at vente: er rækken låst lige nu, tælles den bare ikke op.
      update public.henvisninger
         set synk_forsoeg = synk_forsoeg + 1, synk_sidst_kl = now()
       where id = (select x.id from public.henvisninger x
                    where x.id = r.id and x.status = 'afventer'
                    for update skip locked);
      if v_err is not null and r.synk_forsoeg + 1 in (1, 10, 100) then
        begin
          perform public.drift_fejl_log('server', 'henvisning_synk',
            left('Henvis en ven: vurderingen fejlede (forsøg ' || (r.synk_forsoeg + 1) || '): ' || v_err, 900),
            null, r.ven_id);
        exception when others then
          null;
        end;
      end if;
    end if;
  end loop;
  return jsonb_build_object('vurderet', v_ok, 'fejl', v_fejl, 'udskudt', v_udsk);
end;
$fn$;
revoke all on function public.henvisning_synk(integer) from public, anon, authenticated;
grant execute on function public.henvisning_synk(integer) to service_role;

-- ===========================================================================
-- 5. Brugeren: let opslag af egen kode + mitid_verificeret i min_henvisning
-- ===========================================================================
-- supabase.rpc("min_henvisningskode") -> kode | null. Kun læsning (stable),
-- opretter aldrig en kode, kun private, ikke lukkede/slettede konti.
-- Bruges af Del-knappen på auktionssiden ved hver visning.
create or replace function public.min_henvisningskode()
returns text language sql stable security definer set search_path = '' as $fn$
  select k.kode
    from public.henvisning_koder k
    join public.users u on u.id = k.bruger_id
   where k.bruger_id = (select auth.uid())
     and u.konto_type = 'privat'
     and u.konto_slettet_kl is null
     and u.konto_lukket_kl is null;
$fn$;
revoke all on function public.min_henvisningskode() from public, anon;
grant execute on function public.min_henvisningskode() to authenticated;

-- Som 20261102230000 + 'mitid_verificeret' (henviseren har selv en aktiv
-- MitID-verificering - kræves for point).
create or replace function public.min_henvisning()
returns jsonb language plpgsql volatile security definer set search_path = public as $fn$
declare
  v_bruger uuid := (select auth.uid());
  s        public.henvisning_indstillinger%rowtype;
  u        record;
  v_kode   text;
  v_maaned text := to_char(now() at time zone 'Europe/Copenhagen', 'YYYY-MM');
  v_md     integer;
begin
  if v_bruger is null then return null; end if;
  select id, konto_type, konto_slettet_kl into u from public.users where id = v_bruger;
  if not found or u.konto_slettet_kl is not null then return null; end if;
  if u.konto_type is distinct from 'privat' then
    return jsonb_build_object('kan_henvise', false, 'grund', 'erhverv');
  end if;
  select * into s from public.henvisning_indstillinger where id;

  select k.kode into v_kode from public.henvisning_koder k where k.bruger_id = v_bruger;
  if v_kode is null then
    for i in 1..5 loop
      begin
        insert into public.henvisning_koder (bruger_id, kode) values (v_bruger, public.henvisning_ny_kode())
        on conflict (bruger_id) do nothing;
        exit;
      exception when unique_violation then
        -- Samme kode findes allerede hos en anden (meget usandsynligt): ny kode.
        null;
      end;
    end loop;
    select k.kode into v_kode from public.henvisning_koder k where k.bruger_id = v_bruger;
    if v_kode is null then
      raise exception 'min_henvisning: koden kunne ikke laves';
    end if;
  end if;

  select count(*) into v_md from public.henvisninger h
   where h.henviser_id = v_bruger and h.status = 'belonnet' and h.maaned = v_maaned;

  return jsonb_build_object(
    'kan_henvise', true,
    'kode', v_kode,
    'sti', '/?ven=' || v_kode,
    'kan_faa_point', public.boost_bruger_spaerret(v_bruger) is null,
    'grund', case when public.boost_bruger_spaerret(v_bruger) is null then null else 'spaerret' end,
    'mitid_verificeret', exists (select 1 from public.mitid_verificeringer m
                                  where m.bruger_id = v_bruger and m.status = 'aktiv'),
    'optjening_aaben', s.optjening_fra_kl is not null and s.optjening_fra_kl <= now(),
    'point_pr_ven', s.point_pr_ven,
    'maks_pr_maaned', s.maks_pr_maaned,
    'maaned', v_maaned,
    'belonnet_denne_maaned', v_md,
    'tilbage_denne_maaned', greatest(s.maks_pr_maaned - v_md, 0),
    'antal_venner', (select count(*) from public.henvisninger h where h.henviser_id = v_bruger),
    'antal_afventer', (select count(*) from public.henvisninger h where h.henviser_id = v_bruger and h.status = 'afventer'),
    'antal_belonnet', (select count(*) from public.henvisninger h where h.henviser_id = v_bruger and h.status = 'belonnet'),
    'point_i_alt', (select coalesce(sum(h.point), 0) from public.henvisninger h where h.henviser_id = v_bruger),
    'venner', coalesce((
      select jsonb_agg(jsonb_build_object(
               'navn', case when x.konto_slettet_kl is not null then 'Slettet bruger'
                            else public.kort_visningsnavn(x.navn) end,
               'status', h.status, 'point', h.point,
               'oprettet_kl', h.oprettet_kl, 'vurderet_kl', h.vurderet_kl)
             order by h.oprettet_kl desc, h.id)
        from (select * from public.henvisninger y where y.henviser_id = v_bruger
               order by y.oprettet_kl desc, y.id limit 100) h
        join public.users x on x.id = h.ven_id), '[]'::jsonb));
end;
$fn$;
revoke all on function public.min_henvisning() from public, anon;
grant execute on function public.min_henvisning() to authenticated, service_role;

-- ===========================================================================
-- 6. Påmindelse før slut: ikke til lukkede eller suspenderede konti
-- ===========================================================================
-- Som 20261102250000, plus: u.konto_lukket_kl is null og ikke suspenderet
-- (suspenderet og suspenderet_til i fremtiden eller uden udløb - samme regel
-- som budmotoren og login, 20260930070000_bud_suspenderet_skjult_tid.sql).
create or replace function public.paamindelser_foer_slut_claim(p_graense integer default 2000)
returns table (
  auktion_id uuid,
  bruger_id  uuid,
  titel      text,
  slutter_kl timestamptz,
  budt       boolean,
  foerer     boolean,
  klokke     boolean,
  mail       boolean,
  push       boolean
)
language sql
security definer
set search_path = public
as $fn$
  with auk as (
    select a.id, a.titel, a.slutter_kl, a.bruger_id as saelger
      from public.auctions a
     where a.status = 'aktiv'
       and a.skjult = false
       and a.pauset_kl is null
       and a.kunst_kontrol is distinct from 'afventer'
       and a.slutter_kl > now() + interval '10 minutes'
       and a.slutter_kl <= now() + interval '1 hour'
  ),
  foerende as (
    select distinct on (b.auktion_id) b.auktion_id, b.bruger_id
      from public.bids b
      join auk on auk.id = b.auktion_id
     order by b.auktion_id, b."beløb" desc, b.oprettet asc
  ),
  deltagere as (
    select b.auktion_id, b.bruger_id, true as budt
      from public.bids b
      join auk on auk.id = b.auktion_id
    union all
    select f.auction_id, f.user_id, false
      from public.favorites f
      join auk on auk.id = f.auction_id
  ),
  modtagere as (
    select d.auktion_id, d.bruger_id, bool_or(d.budt) as budt
      from deltagere d
     group by d.auktion_id, d.bruger_id
  ),
  kandidater as materialized (
    select m.auktion_id,
           m.bruger_id,
           auk.titel,
           auk.slutter_kl,
           m.budt,
           (m.budt and fo.bruger_id is not distinct from m.bruger_id) as foerer,
           coalesce(ni.klokke, true) as klokke,
           coalesce(ni.mail, true)   as mail,
           coalesce(ni.push, true)   as push
      from modtagere m
      join auk on auk.id = m.auktion_id
      join public.users u on u.id = m.bruger_id
      left join foerende fo on fo.auktion_id = m.auktion_id
      left join public.notifikation_indstillinger ni
        on ni.bruger_id = m.bruger_id and ni.type = 'fulgt_slutter_snart'
     where m.bruger_id <> auk.saelger
       and u.konto_slettet_kl is null
       and u.konto_lukket_kl is null
       and not (coalesce(u.suspenderet, false) and (u.suspenderet_til is null or u.suspenderet_til > now()))
       and (ni.bruger_id is null or ni.klokke or ni.mail or ni.push)
       and not exists (
         select 1 from public.auktion_paamindelser p
          where p.auktion_id = m.auktion_id and p.bruger_id = m.bruger_id)
       and not exists (
         select 1 from public.notifikation_afsendelser n
          where n.noegle = 'slutter:' || m.auktion_id::text || ':' || m.bruger_id::text)
     order by auk.slutter_kl, m.auktion_id, m.bruger_id
     limit greatest(1, least(coalesce(p_graense, 2000), 5000))
  ),
  claimet as (
    insert into public.auktion_paamindelser as p (auktion_id, bruger_id, budt, foerer)
    select k.auktion_id, k.bruger_id, k.budt, k.foerer from kandidater k
    on conflict on constraint auktion_paamindelser_pkey do nothing
    returning p.auktion_id, p.bruger_id
  )
  select k.auktion_id, k.bruger_id, k.titel, k.slutter_kl, k.budt, k.foerer,
         k.klokke, k.mail, k.push
    from kandidater k
    join claimet c on c.auktion_id = k.auktion_id and c.bruger_id = k.bruger_id;
$fn$;
revoke all on function public.paamindelser_foer_slut_claim(integer) from public, anon, authenticated;
grant execute on function public.paamindelser_foer_slut_claim(integer) to service_role;

-- ===========================================================================
-- 7. "Download dine data": Henvis en ven
-- ===========================================================================
-- Hjælperen kaldes kun af mine_data (security definer, ejer postgres) med
-- auth.uid(). Egne henvisninger: status, point og datoer - aldrig vennens
-- id, navn, koden pr. ven eller MitID-hashen. Er man selv henvist, vises kun
-- datoen (ikke henviseren - det er hans oplysninger).
create or replace function public.mine_data_henvisninger(p_uid uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when p_uid is null then null else jsonb_build_object(
    'kode', (select k.kode from public.henvisning_koder k where k.bruger_id = p_uid),
    'henvisninger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'status', h.status,
               'point', h.point,
               'oprettet_kl', h.oprettet_kl,
               'vurderet_kl', h.vurderet_kl,
               'maaned', h.maaned) order by h.oprettet_kl, h.id)
        from public.henvisninger h where h.henviser_id = p_uid), '[]'::jsonb),
    'point_i_alt', (select coalesce(sum(h.point), 0) from public.henvisninger h where h.henviser_id = p_uid),
    'henvist_af_en_ven', (select jsonb_build_object('oprettet_kl', h.oprettet_kl)
                            from public.henvisninger h where h.ven_id = p_uid))
  end;
$$;
revoke all on function public.mine_data_henvisninger(uuid) from public, anon, authenticated, service_role;

-- mine_data (20261014010000_dac7.sql + 20261016020000_erhverv_klager.sql):
-- nøglen 'henvis_en_ven'. Samme mønster som 20261016020000 (tekst-erstatning
-- i pg_get_functiondef, der kræver, at ankeret findes præcis én gang).
-- Allerede rettet (kroppen kalder mine_data_henvisninger) = intet at gøre.
create or replace function pg_temp.ret_krop(p regprocedure, p_gl text, p_ny text)
returns void language plpgsql as $$
declare
  v_def text := replace(pg_get_functiondef(p), E'\r\n', E'\n');
  v_n   integer;
begin
  v_n := (length(v_def) - length(replace(v_def, p_gl, ''))) / nullif(length(p_gl), 0);
  if v_n is distinct from 1 then
    raise exception '%: forventet tekst fundet % gange (skal være 1) - ret manuelt', p, coalesce(v_n, 0);
  end if;
  execute replace(v_def, p_gl, p_ny);
end $$;

do $$
begin
  if position('mine_data_henvisninger' in pg_get_functiondef('public.mine_data()'::regprocedure)) = 0 then
    perform pg_temp.ret_krop('public.mine_data()'::regprocedure,
      E'       || jsonb_build_object(''erhverv_klager'', public.mine_data_erhverv_klager(v_uid));\n',
      E'       || jsonb_build_object(''erhverv_klager'', public.mine_data_erhverv_klager(v_uid))\n' ||
      E'       || jsonb_build_object(''henvis_en_ven'', public.mine_data_henvisninger(v_uid));\n');
  end if;
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;
