-- Fase 4 – brugerens egne ting (ROADMAP-BESLUTNINGER afsnit 5 og 9):
--   1. Statistik under profilen (kun brugeren selv): min_statistik(),
--      mine_bud_auktioner().
--   2. Foelg saelgere (seller_follows fra appen; stramning i 20261007012000) +
--      foelg_saelger(), stop_foelg_saelger(), antal_foelgere(),
--      mine_fulgte_saelgere(). Blokerede kan ikke foelge hinanden, og en
--      navngiven blokering fjerner foelgningen i begge retninger.
--      Notifikationen 'ny_auktion_fulgt_saelger' sendes af hjemmesidens cron
--      (src/lib/notifikationer/cron.ts), som nu ogsaa springer blokerede over.
--   3. Gemte soegninger med besked: gemte_soegninger (maks 20 pr. bruger) +
--      gemte_soegninger_find_nye() til cron'en. Ny valgfri notifikationstype
--      'gemt_soegning'. Hoejst een besked pr. soegning pr. 6 timer (samlet).
--      Matching sker i cron'en (hvert 5. minut), ikke ved oprettelse af
--      auktionen, saa oprettelse ikke bliver langsommere.
--
-- notifikation_kendt_type FLETTES: de nuvaerende vaerdier laeses fra
-- funktionens kildetekst (pg_proc), og 'gemt_soegning' laegges til. Saa
-- slettes ingen typer, som andre migrationer (fx 20261007020000 /
-- 20261007030000) har tilfoejet. HOLD SYNKRON med src/lib/notifikationer/typer.ts.
--
-- Idempotent: if not exists / create or replace / drop ... if exists.
-- Ingen eksisterende data aendres (undtagen: foelgninger mellem brugere, der
-- har blokeret hinanden ved navn, fjernes - det er ikke handelsdata).

-- ============================================================ 0. Notifikationstype

do $$
declare
  v_src  text;
  v_vals text[];
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = 'public.notifikation_kendt_type(text)'::regprocedure;

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x
      from regexp_matches(coalesce(v_src, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array[
      'overbudt', 'bud_paa_egen', 'like', 'fulgt_slutter_snart',
      'ny_auktion_fulgt_saelger', 'ny_besked', 'spoergsmaal',
      'gemt_soegning'])
  ) s;

  execute format($f$
    create or replace function public.notifikation_kendt_type(p_type text)
    returns boolean
    language sql immutable set search_path = public as $fn$
      select public.notifikation_paakraevet(p_type) or p_type = any (array[%s]::text[]);
    $fn$;$f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) v));
end $$;

grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;

-- ============================================================ 1. Statistik

-- Brugerens egne tal. Indtjening = sælgers beløb efter sælgergebyr
-- (udbetaling_oere = bud - 5 %; fragt og købers gebyrer er ikke med) for
-- betalte handler, der ikke er refunderet eller annulleret. "udbetalt" =
-- overført til saelgerens Stripe-konto, "paa_vej" = betalt, men endnu ikke
-- overført (venter paa godkendelse, frist eller sag). Perioder regnes fra
-- betalingstidspunktet i dansk tid: denne uge (mandag), denne maaned, i aar.
-- Kolonnerne udbetaling_oere/saelgergebyr_oere kan ikke laeses direkte af
-- brugeren (kolonne-grants), derfor security definer. Kun auth.uid().
create or replace function public.min_statistik()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_nu    timestamp := (now() at time zone 'Europe/Copenhagen');
  v_uge   timestamptz := (date_trunc('week', v_nu)  at time zone 'Europe/Copenhagen');
  v_md    timestamptz := (date_trunc('month', v_nu) at time zone 'Europe/Copenhagen');
  v_aar   timestamptz := (date_trunc('year', v_nu)  at time zone 'Europe/Copenhagen');
  v_auk   jsonb;
  v_ind   jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  select jsonb_build_object(
           'i_alt',   count(*),
           'aktive',  count(*) filter (where a.status = 'aktiv' and a.slutter_kl > now()),
           'solgte',  count(*) filter (where exists (
                        select 1 from public.betalinger b
                         where b.auction_id = a.id
                           and b.status in ('betalt', 'frigivet')
                           and b.refunderet_kl is null and b.annulleret_kl is null)))
    into v_auk
    from public.auctions a
   where a.bruger_id = v_uid;

  select jsonb_build_object(
           'uge',      coalesce(sum(b.udbetaling_oere) filter (where b.betalt_kl >= v_uge), 0),
           'maaned',   coalesce(sum(b.udbetaling_oere) filter (where b.betalt_kl >= v_md), 0),
           'aar',      coalesce(sum(b.udbetaling_oere) filter (where b.betalt_kl >= v_aar), 0),
           'i_alt',    coalesce(sum(b.udbetaling_oere), 0),
           'udbetalt', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is not null), 0),
           'paa_vej',  coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is null), 0),
           'antal_handler', count(*))
    into v_ind
    from public.betalinger b
   where b.seller_id = v_uid
     and b.status in ('betalt', 'frigivet')
     and b.betalt_kl is not null
     and b.refunderet_kl is null
     and b.annulleret_kl is null;

  return jsonb_build_object(
    'auktioner', v_auk,
    'indtjening_oere', v_ind,
    'bud_paa', (select count(distinct bi.auktion_id) from public.bids bi where bi.bruger_id = v_uid));
end;
$fn$;

revoke all on function public.min_statistik() from public, anon;
grant execute on function public.min_statistik() to authenticated, service_role;

-- Auktioner, brugeren har budt paa, med status for brugeren:
--   foerer   - auktionen koerer, og brugerens bud er det hoejeste
--   overbudt - auktionen koerer, og en anden byder mere
--   vundet   - brugeren er vinder (auctions.vinder_id, ogsaa efter "tilbud
--              til naeste byder")
--   tabt     - auktionen er slut, og en anden vandt
--   annulleret
-- Andre byderes id'er returneres aldrig. Skjulte (fjernede) auktioner vises ikke.
create or replace function public.mine_bud_auktioner(p_graense integer default 100)
returns table (
  auktion_id     uuid,
  titel          text,
  billede        text,
  slutter_kl     timestamptz,
  nuvaerende_bud numeric,
  mit_bud        numeric,
  antal_bud      integer,
  min_status     text,
  sidste_bud_kl  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with mine as (
    select bi.auktion_id, max(bi."beløb") as mit_bud, max(bi.oprettet) as sidste_bud_kl
      from public.bids bi
     where bi.bruger_id = auth.uid()
     group by bi.auktion_id
  )
  select a.id,
         a.titel,
         a.billeder[1],
         a.slutter_kl,
         coalesce(a."nuværende_bud", a.startpris),
         m.mit_bud,
         coalesce(a.antal_bud, 0),
         case
           when a.status = 'annulleret' then 'annulleret'
           when a.status = 'aktiv' and a.slutter_kl > now() then
             case when f.bruger_id = auth.uid() then 'foerer' else 'overbudt' end
           when coalesce(a.vinder_id, case when a.status = 'aktiv' then f.bruger_id end) = auth.uid()
             then 'vundet'
           else 'tabt'
         end,
         m.sidste_bud_kl
    from mine m
    join public.auctions a on a.id = m.auktion_id
    left join lateral (
      select bi.bruger_id from public.bids bi
       where bi.auktion_id = a.id
       order by bi."beløb" desc, bi.oprettet asc
       limit 1
    ) f on true
   where not coalesce(a.skjult, false)
   order by (a.status = 'aktiv' and a.slutter_kl > now()) desc,
            case when a.status = 'aktiv' and a.slutter_kl > now() then a.slutter_kl end asc,
            m.sidste_bud_kl desc
   limit least(greatest(coalesce(p_graense, 100), 1), 200);
$fn$;

revoke all on function public.mine_bud_auktioner(integer) from public, anon;
grant execute on function public.mine_bud_auktioner(integer) to authenticated, service_role;

-- ============================================================ 2. Foelg saelgere

-- Tabellen blev lavet til appen (20260930130000). Stramningen af rettigheder
-- og policies (kun egne raekker, ingen anon/UPDATE/TRUNCATE) ligger i
-- 20261007012000_seller_follows_stramning.sql, som holdes tilbage i
-- produktion, indtil Expo-appen kun bruger antal_foelgere() og insert/delete.
-- Alt i denne fil virker uden den: funktionerne nedenfor er security definer,
-- og hjemmesiden filtrerer altid sine egne foelgninger paa follower_id.
do $$
begin
  if to_regclass('public.seller_follows') is null then
    raise exception 'seller_follows mangler - koer 20260930130000 foerst';
  end if;
end $$;

-- Tjek ved hver ny foelgning (ogsaa direkte inserts fra appen):
-- ikke BidHamr-systembrugeren, ikke ved navngiven blokering i en af
-- retningerne, og et loft mod misbrug. Anonyme byder-spaerringer stopper
-- ikke foelgningen (saa kunne en saelger afsloere en spaerret byder), men
-- cron'en sender ingen besked ved dem.
create or replace function public.seller_follows_tjek()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  if new.seller_id = public.bidhamr_system_id() then
    raise exception 'ikke_fundet' using errcode = 'P0001';
  end if;
  if public.er_blokeret_navngivet_mellem(new.follower_id, new.seller_id) then
    raise exception 'blokeret' using errcode = 'P0001';
  end if;
  select count(*) into n from public.seller_follows where follower_id = new.follower_id;
  if n >= 1000 then
    raise exception 'for_mange' using errcode = 'P0001';
  end if;
  new.created_at := now();
  return new;
end;
$fn$;

revoke all on function public.seller_follows_tjek() from public, anon, authenticated;

drop trigger if exists seller_follows_tjek on public.seller_follows;
create trigger seller_follows_tjek
  before insert on public.seller_follows
  for each row execute function public.seller_follows_tjek();

-- En navngiven blokering fjerner foelgningen i begge retninger.
create or replace function public.brugerblokeringer_fjern_foelg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.kilde_auktion_id is null then
    delete from public.seller_follows f
     where (f.follower_id = new.blokerer_id and f.seller_id = new.blokeret_id)
        or (f.follower_id = new.blokeret_id and f.seller_id = new.blokerer_id);
  end if;
  return null;
end;
$fn$;

revoke all on function public.brugerblokeringer_fjern_foelg() from public, anon, authenticated;

drop trigger if exists brugerblokeringer_fjern_foelg on public.brugerblokeringer;
create trigger brugerblokeringer_fjern_foelg
  after insert on public.brugerblokeringer
  for each row execute function public.brugerblokeringer_fjern_foelg();

-- Ryd eksisterende foelgninger mellem brugere, der har blokeret hinanden.
delete from public.seller_follows f
 using public.brugerblokeringer b
 where b.kilde_auktion_id is null
   and ((f.follower_id = b.blokerer_id and f.seller_id = b.blokeret_id)
     or (f.follower_id = b.blokeret_id and f.seller_id = b.blokerer_id));

-- Foelg en saelger. Svar: {kode: ok | ikke_logget_ind | ikke_fundet |
-- sig_selv | blokeret | for_mange}. Allerede fulgt = ok.
create or replace function public.foelg_saelger(p_saelger uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_saelger is null or p_saelger = public.bidhamr_system_id()
     or not exists (select 1 from public.users u
                     where u.id = p_saelger and u.konto_lukket_kl is null) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_saelger = v_uid then
    return jsonb_build_object('kode', 'sig_selv');
  end if;
  begin
    insert into public.seller_follows (follower_id, seller_id)
    values (v_uid, p_saelger)
    on conflict (follower_id, seller_id) do nothing;
  exception when sqlstate 'P0001' then
    return jsonb_build_object('kode',
      case when sqlerrm in ('blokeret', 'for_mange', 'ikke_fundet') then sqlerrm else 'fejl' end);
  end;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.foelg_saelger(uuid) from public, anon;
grant execute on function public.foelg_saelger(uuid) to authenticated;

create or replace function public.stop_foelg_saelger(p_saelger uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  delete from public.seller_follows
   where follower_id = v_uid and seller_id = p_saelger;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.stop_foelg_saelger(uuid) from public, anon;
grant execute on function public.stop_foelg_saelger(uuid) to authenticated;

-- Antal foelgere er offentligt - HVEM der foelger er ikke.
create or replace function public.antal_foelgere(p_bruger uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::integer from public.seller_follows where seller_id = p_bruger;
$fn$;

revoke all on function public.antal_foelgere(uuid) from public;
grant execute on function public.antal_foelgere(uuid) to anon, authenticated, service_role;

-- Saelgere, jeg foelger (listen under Min konto), med antal aktive auktioner.
-- Lukkede konti vises ikke.
create or replace function public.mine_fulgte_saelgere()
returns table (
  saelger_id      uuid,
  navn            text,
  avatar_url      text,
  aktive_auktioner integer,
  fulgt_siden     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select u.id, u.navn, u.avatar_url,
         (select count(*)::integer from public.auctions a
           where a.bruger_id = u.id and a.status = 'aktiv'
             and not coalesce(a.skjult, false) and a.slutter_kl > now()),
         f.created_at
    from public.seller_follows f
    join public.users u on u.id = f.seller_id
   where f.follower_id = auth.uid()
     and u.konto_lukket_kl is null
   order by f.created_at desc;
$fn$;

revoke all on function public.mine_fulgte_saelgere() from public, anon;
grant execute on function public.mine_fulgte_saelgere() to authenticated;

-- ============================================================ 3. Gemte soegninger

create table if not exists public.gemte_soegninger (
  id              uuid primary key default gen_random_uuid(),
  bruger_id       uuid not null default auth.uid() references public.users(id) on delete cascade,
  navn            text not null,
  soegeord        text not null default '',
  kategori        text,
  postnummer      text,
  radius_km       integer,
  lat             double precision,
  lng             double precision,
  pris_min        integer,
  pris_max        integer,
  besked          boolean not null default true,
  oprettet_kl     timestamptz not null default now(),
  opdateret_kl    timestamptz not null default now(),
  -- Cron: auktioner oprettet efter dette tidspunkt er endnu ikke vurderet.
  tjekket_fra_kl  timestamptz not null default now(),
  sidst_besked_kl timestamptz,
  constraint gemte_soegninger_navn_laengde check (char_length(btrim(navn)) between 1 and 60),
  constraint gemte_soegninger_soegeord_laengde check (char_length(soegeord) <= 100),
  constraint gemte_soegninger_kategori_laengde check (kategori is null or char_length(kategori) between 1 and 60),
  constraint gemte_soegninger_noget_at_soege check (soegeord <> '' or kategori is not null),
  constraint gemte_soegninger_postnummer check (postnummer is null or postnummer ~ '^[0-9]{4}$'),
  -- Afstand kraever postnummer og koordinat (fra den lokale postnummerliste).
  constraint gemte_soegninger_afstand check (
    radius_km is null
    or (radius_km between 5 and 150 and postnummer is not null
        and lat is not null and lng is not null)),
  constraint gemte_soegninger_koordinat check (
    (lat is null) = (lng is null)
    and (lat is null or (lat between 54 and 58 and lng between 7.5 and 15.5))),
  constraint gemte_soegninger_pris check (
    (pris_min is null or pris_min >= 0) and (pris_max is null or pris_max >= 0)
    and (pris_min is null or pris_max is null or pris_min <= pris_max))
);

comment on table public.gemte_soegninger is
  'Brugerens gemte soegninger fra /auktioner (maks 20). besked = notifikation '
  '(type gemt_soegning), naar nye auktioner matcher - hoejst een pr. 6 timer. '
  'Brugeren maa oprette, omdoebe (navn), slaa besked til/fra og slette egne.';

-- Samme soegning kan kun gemmes een gang pr. bruger.
create unique index if not exists gemte_soegninger_unik
  on public.gemte_soegninger (bruger_id, lower(soegeord), coalesce(kategori, ''),
                              coalesce(postnummer, ''), coalesce(radius_km, 0),
                              coalesce(pris_min, -1), coalesce(pris_max, -1));
create index if not exists gemte_soegninger_bruger_idx
  on public.gemte_soegninger (bruger_id, oprettet_kl desc);
create index if not exists gemte_soegninger_cron_idx
  on public.gemte_soegninger (tjekket_fra_kl) where besked;

alter table public.gemte_soegninger enable row level security;

revoke all on public.gemte_soegninger from public, anon, authenticated;
grant select, delete on public.gemte_soegninger to authenticated;
grant insert (navn, soegeord, kategori, postnummer, radius_km, lat, lng, pris_min, pris_max, besked)
  on public.gemte_soegninger to authenticated;
grant update (navn, besked) on public.gemte_soegninger to authenticated;
grant all on public.gemte_soegninger to service_role;

drop policy if exists gemte_soegninger_select_own on public.gemte_soegninger;
create policy gemte_soegninger_select_own on public.gemte_soegninger
  for select to authenticated using (bruger_id = auth.uid());
drop policy if exists gemte_soegninger_insert_own on public.gemte_soegninger;
create policy gemte_soegninger_insert_own on public.gemte_soegninger
  for insert to authenticated with check (bruger_id = auth.uid());
drop policy if exists gemte_soegninger_update_own on public.gemte_soegninger;
create policy gemte_soegninger_update_own on public.gemte_soegninger
  for update to authenticated using (bruger_id = auth.uid()) with check (bruger_id = auth.uid());
drop policy if exists gemte_soegninger_delete_own on public.gemte_soegninger;
create policy gemte_soegninger_delete_own on public.gemte_soegninger
  for delete to authenticated using (bruger_id = auth.uid());

-- Normaliserer felterne og haandhaever maks 20 pr. bruger (laas pr. bruger,
-- saa to samtidige inserts ikke kan snyde loftet). Interne felter saettes her.
create or replace function public.gemte_soegninger_foer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  new.navn := btrim(regexp_replace(coalesce(new.navn, ''), '\s+', ' ', 'g'));
  new.soegeord := btrim(regexp_replace(coalesce(new.soegeord, ''), '\s+', ' ', 'g'));
  new.kategori := nullif(btrim(coalesce(new.kategori, '')), '');
  new.postnummer := nullif(btrim(coalesce(new.postnummer, '')), '');
  if new.postnummer is null then
    new.radius_km := null; new.lat := null; new.lng := null;
  end if;

  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('gemte_soegninger:' || new.bruger_id::text, 0));
    select count(*) into n from public.gemte_soegninger where bruger_id = new.bruger_id;
    if n >= 20 then
      raise exception 'for_mange' using errcode = 'P0001';
    end if;
    new.oprettet_kl := now();
    new.tjekket_fra_kl := now();
    new.sidst_besked_kl := null;
  else
    -- Slaas besked til igen, regnes kun auktioner fra nu af med.
    if new.besked and not old.besked then
      new.tjekket_fra_kl := now();
    end if;
    -- Kun brugerens egne aendringer (navn, besked) - ikke cron'ens.
    if new.navn is distinct from old.navn or new.besked is distinct from old.besked then
      new.opdateret_kl := now();
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function public.gemte_soegninger_foer() from public, anon, authenticated;

drop trigger if exists gemte_soegninger_foer on public.gemte_soegninger;
create trigger gemte_soegninger_foer
  before insert or update on public.gemte_soegninger
  for each row execute function public.gemte_soegninger_foer();

-- Cron (service_role): finder gemte soegninger med nye matchende auktioner.
-- For hver soegning med besked til, hvor der ikke er sendt besked de sidste
-- 6 timer, vurderes auktioner oprettet efter tjekket_fra_kl (hoejst 48 timer
-- tilbage) og indtil for 1 minut siden (saa ingen auktion i en transaktion,
-- der endnu ikke er committet, springes over). tjekket_fra_kl flyttes frem
-- for alle vurderede soegninger; sidst_besked_kl saettes for dem med match.
-- Under de 6 timers pause flyttes tjekket_fra_kl ikke, saa auktionerne
-- samles i naeste besked. Egne auktioner, auktioner fra blokerede (begge
-- retninger, ogsaa anonyme spaerringer) og lukkede konti springes over.
create or replace function public.gemte_soegninger_find_nye(p_maks integer default 500)
returns table (
  soegning_id    uuid,
  bruger_id      uuid,
  navn           text,
  soegeord       text,
  kategori       text,
  postnummer     text,
  radius_km      integer,
  pris_min       integer,
  pris_max       integer,
  antal          integer,
  foerste_id     uuid,
  foerste_titel  text,
  besked_kl      timestamptz
)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_til timestamptz := now() - interval '1 minute';
begin
  -- Hurtig udgang: ingen nye aktive auktioner de sidste 48 timer.
  if not exists (
    select 1 from public.auctions a
     where a.oprettet > now() - interval '48 hours' and a.status = 'aktiv') then
    update public.gemte_soegninger s
       set tjekket_fra_kl = v_til
     where s.besked and s.tjekket_fra_kl < v_til
       and (s.sidst_besked_kl is null or s.sidst_besked_kl <= now() - interval '6 hours');
    return;
  end if;

  return query
  with kandidater as (
    select s.*
      from public.gemte_soegninger s
      join public.users u on u.id = s.bruger_id
     where s.besked
       and s.tjekket_fra_kl < v_til
       and (s.sidst_besked_kl is null or s.sidst_besked_kl <= now() - interval '6 hours')
       and u.konto_lukket_kl is null
     order by s.tjekket_fra_kl
     limit least(greatest(coalesce(p_maks, 500), 1), 2000)
       for update of s skip locked
  ),
  match as (
    select k.id as sid, a.id as aid, a.titel, a.oprettet
      from kandidater k
      join public.auctions a
        on a.oprettet > greatest(k.tjekket_fra_kl, now() - interval '48 hours')
       and a.oprettet <= v_til
       and a.status = 'aktiv'
       and not coalesce(a.skjult, false)
       and a.slutter_kl > now()
       and a.bruger_id <> k.bruger_id
       and (k.soegeord = '' or a.titel ilike
              '%' || replace(replace(replace(k.soegeord, '\', '\\'), '%', '\%'), '_', '\_') || '%')
       and (k.kategori is null or a.kategori = k.kategori)
       and (k.pris_min is null or coalesce(a."nuværende_bud", a.startpris) >= k.pris_min)
       and (k.pris_max is null or coalesce(a."nuværende_bud", a.startpris) <= k.pris_max)
       and (k.radius_km is null or (
              a.lat is not null and a.lng is not null
              and 2 * 6371 * asin(least(1, sqrt(
                    power(sin(radians(a.lat - k.lat) / 2), 2)
                    + cos(radians(k.lat)) * cos(radians(a.lat))
                      * power(sin(radians(a.lng - k.lng) / 2), 2)))) <= k.radius_km))
     where not public.er_blokeret_mellem(k.bruger_id, a.bruger_id)
  ),
  samlet as (
    select m.sid, count(*)::integer as antal,
           (array_agg(m.aid order by m.oprettet desc))[1] as foerste_id,
           (array_agg(m.titel order by m.oprettet desc))[1] as foerste_titel
      from match m
     group by m.sid
  ),
  opdateret as (
    update public.gemte_soegninger s
       set tjekket_fra_kl = v_til,
           sidst_besked_kl = case when sa.sid is not null then now() else s.sidst_besked_kl end
      from kandidater k
      left join samlet sa on sa.sid = k.id
     where s.id = k.id
    returning s.id, s.bruger_id, s.navn, s.soegeord, s.kategori, s.postnummer,
              s.radius_km, s.pris_min, s.pris_max, s.sidst_besked_kl
  )
  select o.id, o.bruger_id, o.navn, o.soegeord, o.kategori, o.postnummer,
         o.radius_km, o.pris_min, o.pris_max, sa.antal, sa.foerste_id,
         sa.foerste_titel, o.sidst_besked_kl
    from opdateret o
    join samlet sa on sa.sid = o.id;
end;
$fn$;

revoke all on function public.gemte_soegninger_find_nye(integer) from public, anon, authenticated;
grant execute on function public.gemte_soegninger_find_nye(integer) to service_role;
