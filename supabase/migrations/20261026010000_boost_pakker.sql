-- Boost-pakker (Filip, 19. okt. 2026 - ROADMAP-BESLUTNINGER, "Boost-pakker").
--
-- Tre pakker boost-point med rabat (priserne er inkl. moms):
--   point_100: 100 point for  39 kr. (=  2 boost)
--   point_300: 300 point for  99 kr. (=  6 boost) - "Spar 18 kr."
--   point_700: 700 point for 199 kr. (= 14 boost) - "Spar 74 kr." og "Bedste køb"
-- Et boost koster stadig 50 point og varer 24 timer (boost_indstillinger).
--
--   1. Tabellen boost_pakker (id, point, pris_oere, aktiv, sortering,
--      bedste). Pakkerne ændres med en migration. Alle kan læse de aktive
--      (prislisten er offentlig); ingen kan skrive udefra.
--   2. boost_koeb.pakke_id: pakken, købet er startet med. Point og beløb
--      låses på købet som før (boost_koeb_laaste_felter låser nu også
--      pakken). Eksisterende køb (100 point, 39 kr.) får 'point_100'.
--   3. boost_koeb_start(p_bruger, p_samtykke, p_pakke): serveren vælger
--      pris og point ud fra pakkens id - klienten sender kun id'et. Uden
--      p_pakke bruges standardpakken (den første aktive = 100 point), så
--      den nuværende app og den gamle hjemmeside virker som før. Ukendt
--      eller inaktiv pakke: 'pakke_ukendt'.
--      Idempotens dækker pakken: med p_pakke genbruges et åbent køb KUN, hvis
--      det er samme pakke med samme point og pris. Uden p_pakke (den gamle
--      app) genbruges et åbent køb altid, uanset pakke. Ellers:
--        - uden PaymentIntent: det åbne køb annulleres, og der startes et nyt,
--        - med PaymentIntent: 'skift' (id, pi) - serveren annullerer FØRST
--          PaymentIntenten hos Stripe (eller spejler den, hvis den nåede at
--          blive betalt) og prøver igen. Så bliver en betaling, der allerede
--          er gennemført, aldrig kasseret og refunderet som dobbeltbetaling,
--          bare fordi brugeren skiftede pakke,
--        - behandles (fx MobilePay på vej): 'behandles' - vent.
--      7-dages-annulleringen er uændret.
--   4. mine_point: 'pakker' [{id, point, pris_oere, boost, spar_oere,
--      bedste}] (sorteret). 'pakke' er bevaret (standardpakken, nu med id) for
--      bagudkompatibilitet. aabent_koeb har pakke/point/beloeb_oere, og
--      historikken har beloeb_oere for køb (kvittering og historik viser den
--      rigtige pakke og det rigtige beløb).
--   5. min_auktion_boost: 'pakke' (standardpakken) og 'pakker'.
--   "spar_oere" regnes ud fra den mindste aktive pakke (pris pr. point):
--   300 point = 3 x 39 kr. = 117 kr. - 99 kr. = 18 kr. Så kan teksten "Spar
--   X kr." aldrig blive forkert, hvis en pris ændres (markedsføringsloven).
--
-- Refusion, kasserede PaymentIntents, indsigelse og tilbageførsel er
-- uændrede: de bruger allerede købets låste point (boost_koeb.point), så
-- de virker for alle pakker. Fakturaen bruger købets låste beløb og point.
--
-- Ændrede funktioner, der ligger i produktion, rettes på stedet med
-- md5-drift-tjek (mønstret fra 20261024010000): "gammel" = prod og test før
-- denne migration (hentet med SELECT 19. okt. 2026 - ens), "ny" = efter.
-- boost_koeb_start får en ny parameter: den gamle (uuid, boolean) droppes kun,
-- hvis den har den kendte md5. Andet afbryder migrationen.
--
-- Forudsætning: 20261023030000_boost.sql og 20261025010000_app_endpoints.sql
-- (min_auktion_boost med grunden 'kunst_kontrol').
-- Idempotent (kan køres igen). Én transaktion: filen køres som én samlet
-- forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.boost_koeb') is null or to_regclass('public.boost_indstillinger') is null then
    raise exception 'Forudsætning mangler: kør 20261023030000_boost.sql først';
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
    raise exception '%: funktionen findes ikke - kør de tidligere boost-migrationer først', p_fn;
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
-- 1. Pakkerne
-- ===========================================================================
create table if not exists public.boost_pakker (
  id           text primary key,
  point        integer not null,
  pris_oere    bigint  not null,
  aktiv        boolean not null default true,
  sortering    integer not null,
  -- Mærket "Bedste køb" (højst én aktiv pakke).
  bedste       boolean not null default false,
  oprettet_kl  timestamptz not null default now(),
  constraint boost_pakker_id_check check (id ~ '^[a-z0-9_]{1,40}$'),
  constraint boost_pakker_tal_check check (
    point between 1 and 100000 and pris_oere between 300 and 1000000 and sortering between 0 and 10000)
);
comment on table public.boost_pakker is
  'Boost-pakker (Filip, 19. okt. 2026): point og pris (øre, inkl. moms) pr. pakke. Serveren vælger pris og point ud fra id''et; prisen låses på købet (boost_koeb). Ændres med en migration. Slettes aldrig (købene peger på dem) - sæt aktiv = false.';
create unique index if not exists boost_pakker_en_bedste on public.boost_pakker ((true)) where bedste and aktiv;

insert into public.boost_pakker (id, point, pris_oere, aktiv, sortering, bedste) values
  ('point_100', 100,  3900, true, 10, false),
  ('point_300', 300,  9900, true, 20, false),
  ('point_700', 700, 19900, true, 30, true)
on conflict (id) do nothing;

alter table public.boost_pakker enable row level security;
drop policy if exists boost_pakker_laes on public.boost_pakker;
create policy boost_pakker_laes on public.boost_pakker for select to anon, authenticated using (aktiv);
revoke all on public.boost_pakker from public, anon, authenticated, service_role;
grant select on public.boost_pakker to anon, authenticated, service_role;

create or replace function public.boost_pakker_forbyd_sletning()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'Boost-pakker slettes ikke (købene peger på dem) - sæt aktiv = false';
end;
$fn$;
drop trigger if exists boost_pakker_forbyd_sletning on public.boost_pakker;
create trigger boost_pakker_forbyd_sletning before delete on public.boost_pakker
  for each row execute function public.boost_pakker_forbyd_sletning();
revoke all on function public.boost_pakker_forbyd_sletning() from public, anon, authenticated, service_role;
-- Heller ikke tømning (som boost_koeb - boost_forbyd_aendring fra 20261023030000).
drop trigger if exists boost_pakker_ingen_truncate on public.boost_pakker;
create trigger boost_pakker_ingen_truncate before truncate on public.boost_pakker
  for each statement execute function public.boost_forbyd_aendring();

comment on column public.boost_indstillinger.pakke_point is
  'Erstattet af boost_pakker (20261026010000) - bruges ikke længere.';
comment on column public.boost_indstillinger.pakke_pris_oere is
  'Erstattet af boost_pakker (20261026010000) - bruges ikke længere.';

-- Standardpakken (den første aktive): {id, point, pris_oere}. Bruges, når
-- klienten ikke sender en pakke (den nuværende app), og som mine_point.pakke.
-- Er ingen pakke aktiv: de gamle tal fra boost_indstillinger uden id (der kan
-- så ikke købes - 'pakke_ukendt').
create or replace function public.boost_standard_pakke()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(
    (select jsonb_build_object('id', p.id, 'point', p.point, 'pris_oere', p.pris_oere)
       from public.boost_pakker p where p.aktiv order by p.sortering, p.id limit 1),
    (select jsonb_build_object('id', null, 'point', s.pakke_point, 'pris_oere', s.pakke_pris_oere)
       from public.boost_indstillinger s where s.id));
$fn$;

-- De aktive pakker til visning: [{id, point, pris_oere, boost, spar_oere,
-- bedste}] efter sortering. boost = antal boost for pointene; spar_oere =
-- forskellen til samme antal point købt i den mindste aktive pakke (0 for
-- den selv).
create or replace function public.boost_pakke_liste()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  with b as (
    select p.point, p.pris_oere from public.boost_pakker p where p.aktiv order by p.point, p.sortering, p.id limit 1
  ), s as (
    select greatest(x.boost_point, 1) as boost_point from public.boost_indstillinger x where x.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'point', p.point, 'pris_oere', p.pris_oere,
           'boost', p.point / (select s.boost_point from s),
           'spar_oere', greatest((p.point::bigint * b.pris_oere) / b.point - p.pris_oere, 0),
           'bedste', p.bedste)
         order by p.sortering, p.id), '[]'::jsonb)
    from public.boost_pakker p cross join b
   where p.aktiv;
$fn$;

-- ===========================================================================
-- 2. boost_koeb.pakke_id (låst på købet)
-- ===========================================================================
alter table public.boost_koeb add column if not exists pakke_id text
  references public.boost_pakker(id) on delete restrict;
-- Eksisterende køb er alle 100 point for 39 kr. (før pakkerne). Udfyldes kun
-- én gang (pakke_id kan derefter ikke ændres).
update public.boost_koeb set pakke_id = 'point_100'
 where pakke_id is null and point = 100 and beloeb_oere = 3900;
grant select (pakke_id) on public.boost_koeb to authenticated;

do $do$
begin
  raise notice 'boost_koeb_laaste_felter: %', pg_temp.ps_ret(
    'public.boost_koeb_laaste_felter()',
    '23363a4519b436f6851ffddd529a6e40',
    '475bb4a8618de7146372e3d69203bf7f',
    jsonb_build_array(jsonb_build_array(
$g$or new.valuta <> old.valuta or new.oprettet_kl <> old.oprettet_kl then$g$,
$n$or new.valuta <> old.valuta or new.oprettet_kl <> old.oprettet_kl
     -- Pakken (20261026010000): kan sættes én gang, aldrig ændres - og kun
     -- til en pakke, hvis point og pris passer til købets låste tal.
     or (old.pakke_id is not null and new.pakke_id is distinct from old.pakke_id)
     or (old.pakke_id is null and new.pakke_id is not null
         and not exists (select 1 from public.boost_pakker bp
                          where bp.id = new.pakke_id and bp.point = new.point and bp.pris_oere = new.beloeb_oere)) then$n$, 1)));
end $do$;

-- ===========================================================================
-- 3. boost_koeb_start med pakke
-- ===========================================================================
-- Den gamle udgave (uuid, boolean) droppes kun, hvis den er præcis den kendte
-- fra 20261023030000_boost.sql.
do $do$
declare
  h text := pg_temp.krop_md5('public.boost_koeb_start(uuid,boolean)');
begin
  if h is null then return; end if; -- allerede erstattet (genkørsel)
  if h <> '2541cd508d365b6e66260a6fb0f13855' then
    raise exception 'public.boost_koeb_start(uuid,boolean): md5 % er ikke den kendte - kontrollér funktionen, før migrationen køres', h;
  end if;
  drop function public.boost_koeb_start(uuid, boolean);
end $do$;

-- p_bruger SKAL være verificeret af serveren (auth). p_pakke: pakkens id
-- (null = standardpakken). Svar:
--   {kode: 'ok', id, pakke, point, beloeb_oere, pi: null, pi_forsoeg: 0, gammel_pi}  nyt køb
--   {kode: 'findes', id, pakke, point, beloeb_oere, pi, pi_forsoeg, status}          åbent køb af samme pakke
--   {kode: 'skift', id, pi}     åbent køb af en anden pakke med PaymentIntent: serveren
--                               annullerer den hos Stripe (eller spejler den) og prøver igen
--   {kode: 'behandles', id}     åbent køb af en anden pakke, betalingen behandles
--   {kode: 'pakke_ukendt' | 'ugyldig' | 'ikke_fundet' | 'erhverv' | 'spaerret' | 'samtykke'}
create or replace function public.boost_koeb_start(p_bruger uuid, p_samtykke boolean default false, p_pakke text default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_spaerret text;
  s  public.boost_indstillinger%rowtype;
  p  record;
  k  record;
  v_id uuid;
  v_gammel_pi text;
  v_ny boolean := false;
  v_anden boolean;
begin
  if p_bruger is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if p_pakke is not null and p_pakke !~ '^[a-z0-9_]{1,40}$' then return jsonb_build_object('kode', 'pakke_ukendt'); end if;
  v_spaerret := public.boost_bruger_spaerret(p_bruger);
  if v_spaerret is not null then return jsonb_build_object('kode', v_spaerret); end if;
  select * into s from public.boost_indstillinger where id;
  if not found then return jsonb_build_object('kode', 'ugyldig'); end if;
  -- Pakken vælges af databasen: den valgte (skal være aktiv), ellers
  -- standardpakken (den første aktive - samme som mine_point.pakke).
  select x.id, x.point, x.pris_oere into p
    from public.boost_pakker x
   where x.aktiv and (p_pakke is null or x.id = p_pakke)
   order by x.sortering, x.id
   limit 1;
  if p.id is null then return jsonb_build_object('kode', 'pakke_ukendt'); end if;
  perform public.boost_laas_bruger(p_bruger);

  select b.id, b.point, b.beloeb_oere, b.pakke_id, b.stripe_payment_intent_id, b.pi_forsoeg, b.status, b.aktivitet_kl
    into k
    from public.boost_koeb b where b.bruger_id = p_bruger and b.status in ('afventer', 'behandles')
    for update;
  -- Samme pakke = samme id, point og pris (ændres pakkens pris, er det et
  -- andet køb - som et ændret beløb). Uden p_pakke (fx den gamle app) har
  -- brugeren ikke valgt en pakke: et åbent køb genbruges, uanset pakke - det
  -- annulleres aldrig af et kald uden pakke.
  v_anden := k.id is not null and p_pakke is not null
             and (k.pakke_id is distinct from p.id or k.point <> p.point or k.beloeb_oere <> p.pris_oere);
  -- Et ubetalt køb uden aktivitet i 7 dage er for gammelt (som før): det
  -- annulleres, og der startes et nyt. Serveren annullerer den gamle
  -- PaymentIntent hos Stripe (gammel_pi); betales den alligevel, er den
  -- kasseret og refunderes som dobbeltbetaling.
  if k.id is not null and k.status = 'afventer' and k.aktivitet_kl <= now() - interval '7 days' then
    if public.boost_koeb_annuller(k.id, k.stripe_payment_intent_id) then
      v_gammel_pi := k.stripe_payment_intent_id;
      v_ny := true;
    end if;
  end if;
  -- Åbent køb af en anden pakke.
  if k.id is not null and not v_ny and v_anden then
    if k.status = 'behandles' then
      return jsonb_build_object('kode', 'behandles', 'id', k.id);
    end if;
    if k.stripe_payment_intent_id is not null
       or not public.boost_koeb_annuller(k.id, null) then
      -- PaymentIntenten skal annulleres hos Stripe FØR købet annulleres her.
      return jsonb_build_object('kode', 'skift', 'id', k.id, 'pi', k.stripe_payment_intent_id);
    end if;
    v_ny := true;
  end if;
  if k.id is not null and not v_ny then
    update public.boost_koeb
       set aktivitet_kl = now(),
           fortrydelse_samtykke_kl = case when s.kraev_fortrydelse_samtykke and coalesce(p_samtykke, false)
                                          then coalesce(fortrydelse_samtykke_kl, now()) else fortrydelse_samtykke_kl end
     where id = k.id;
    return jsonb_build_object('kode', 'findes', 'id', k.id, 'pakke', k.pakke_id, 'point', k.point,
                              'beloeb_oere', k.beloeb_oere, 'pi', k.stripe_payment_intent_id,
                              'pi_forsoeg', k.pi_forsoeg, 'status', k.status);
  end if;
  if s.kraev_fortrydelse_samtykke and not coalesce(p_samtykke, false) then
    return jsonb_build_object('kode', 'samtykke', 'gammel_pi', v_gammel_pi);
  end if;
  insert into public.boost_koeb (bruger_id, pakke_id, point, beloeb_oere, fortrydelse_samtykke_kl)
  values (p_bruger, p.id, p.point, p.pris_oere, case when coalesce(p_samtykke, false) then now() end)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'pakke', p.id, 'point', p.point, 'beloeb_oere', p.pris_oere,
                            'pi', null, 'pi_forsoeg', 0, 'gammel_pi', v_gammel_pi);
end;
$fn$;

-- ===========================================================================
-- 4. mine_point og min_auktion_boost: pakkerne
-- ===========================================================================
do $do$
begin
  raise notice 'mine_point: %', pg_temp.ps_ret(
    'public.mine_point()',
    '07eeaeb9d6b08d0822202254d02d35ee',
    '7d4a1623efaac0e9e2f33ad4e8456c38',
    jsonb_build_array(
      jsonb_build_array(
$g$'pakke', jsonb_build_object('point', s.pakke_point, 'pris_oere', s.pakke_pris_oere),$g$,
$n$'pakke', public.boost_standard_pakke(),
    'pakker', public.boost_pakke_liste(),$n$, 1),
      jsonb_build_array(
$g$jsonb_build_object('id', k.id, 'status', k.status)$g$,
$n$jsonb_build_object('id', k.id, 'status', k.status, 'pakke', k.pakke_id,
                                        'point', k.point, 'beloeb_oere', k.beloeb_oere)$n$, 1),
      jsonb_build_array(
$g$'auktion_id', ab.auktion_id, 'auktion_titel', a.titel)$g$,
$n$'auktion_id', ab.auktion_id, 'auktion_titel', a.titel,
               'beloeb_oere', bk.beloeb_oere)$n$, 1),
      jsonb_build_array(
$g$left join public.auctions a on a.id = ab.auktion_id), '[]'::jsonb));$g$,
$n$left join public.auctions a on a.id = ab.auktion_id
        left join public.boost_koeb bk on bk.id = p.boost_koeb_id and p.type = 'koeb'), '[]'::jsonb));$n$, 1)));

  raise notice 'min_auktion_boost: %', pg_temp.ps_ret(
    'public.min_auktion_boost(uuid)',
    '38f1a10851e79db6549365803513166b',
    'b9c2a9242078b2f4b0ed5bc253b8b723',
    jsonb_build_array(jsonb_build_array(
$g$'pakke', jsonb_build_object('point', s.pakke_point, 'pris_oere', s.pakke_pris_oere))$g$,
$n$'pakke', public.boost_standard_pakke(),
                            'pakker', public.boost_pakke_liste())$n$, 1)));
end $do$;

-- ===========================================================================
-- 5. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_koeb_start(uuid, boolean, text)',
    'public.boost_standard_pakke()',
    'public.boost_pakke_liste()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
-- create or replace (via ps_ret) bevarer rettighederne; sat igen for en sikkerheds skyld.
revoke all on function public.mine_point() from public, anon;
grant execute on function public.mine_point() to authenticated, service_role;
revoke all on function public.min_auktion_boost(uuid) from public, anon;
grant execute on function public.min_auktion_boost(uuid) to authenticated, service_role;
