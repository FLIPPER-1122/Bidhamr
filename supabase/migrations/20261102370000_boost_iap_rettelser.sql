-- Rettelser til køb af boost-point i appen (20261102320000_boost_iap.sql)
-- efter reviewerens gennemgang (28. okt. 2026).
--
--   1. boost_iap_koeb.markering: 'testkoeb_prod' (testkøb på
--      produktionsdatabasen, fx Apples App Review) og 'promo' (Google-køb med
--      promokode, purchaseType 1 - ikke betalt). Tælles for sig i
--      "Boost-salg" og ikke som omsætning. Testkøbene kan trækkes tilbage
--      samlet med boost_iap_tilbagekald_testkoeb().
--   2. Ventende refusioner: en refusion (Apple REFUND, Google void) af et
--      køb, vi endnu ikke har krediteret, gemmes i
--      boost_iap_ventende_refusioner, og boost_iap_krediter afviser købet
--      bagefter ('refunderet'). Apple REFUND_REVERSED ophæver den
--      (boost_iap_ventende_ophaev).
--   3. Kreditering og refusion af SAMME køb låses mod hinanden (advisory
--      lock på transaktions-id / Google-token, før pointkontoen), så en
--      refusion, der kommer samtidig med krediteringen, ikke går tabt.
--   4. Refusionskilderne 'apple_historik' (Apples Get Notification History i
--      den daglige cron) og 'staff_testkoeb' (tilbagekaldte testkøb).
--   5. Chefens visning (markering) og "Boost-salg" (promo og testkøb i
--      produktion for sig).
--   6. "Download dine data" (mine_data): nøglen 'boost_koeb' med brugerens
--      køb af boost-point på bidhamr.dk (Stripe) og i appen (Apple/Google) -
--      uden Google-token og uden Stripe-id'er. Flettes ind lige efter
--      "v := public.mine_data_grund()" som 20261102340000.
--
-- Idempotent (kan køres igen). Én transaktion. Kun testdatabasen, indtil
-- Filip siger ja (og først efter 20261102320000).

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.boost_iap_koeb') is null or to_regclass('public.boost_iap_produkter') is null then
    raise exception 'Forudsætning mangler: 20261102320000_boost_iap.sql';
  end if;
  if to_regprocedure('public.mine_data()') is null then
    raise exception 'Forudsætning mangler: mine_data() (20261014010000_dac7.sql)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Markering af særlige køb
-- ===========================================================================
alter table public.boost_iap_koeb add column if not exists markering text;
alter table public.boost_iap_koeb drop constraint if exists boost_iap_koeb_markering_check;
alter table public.boost_iap_koeb add constraint boost_iap_koeb_markering_check check (
  markering is null
  or (markering = 'testkoeb_prod' and miljoe = 'test')
  or (markering = 'promo' and platform = 'android' and miljoe = 'produktion'));
create index if not exists boost_iap_koeb_markering on public.boost_iap_koeb (markering) where markering is not null;
comment on column public.boost_iap_koeb.markering is
  'testkoeb_prod = testkøb på produktionsdatabasen (Apple Sandbox / Googles licenstestere - fx App Review; trækkes tilbage med boost_iap_tilbagekald_testkoeb). promo = Google-promokode (ikke betalt). Begge tælles for sig og ikke som omsætning.';

-- Refusionskilderne (+ apple_historik og staff_testkoeb).
alter table public.boost_iap_koeb drop constraint if exists boost_iap_koeb_kilde_check;
alter table public.boost_iap_koeb add constraint boost_iap_koeb_kilde_check check (
  refusion_kilde is null or refusion_kilde in ('apple_notifikation', 'apple_historik', 'google_rtdn', 'google_voided',
                                               'apple_opslag', 'google_opslag', 'staff_testkoeb'));

-- Markeringen er låst som resten af købet.
create or replace function public.boost_iap_koeb_laaste_felter()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.id <> old.id or new.platform <> old.platform or new.ekstern_id <> old.ekstern_id
     or new.original_ekstern_id is distinct from old.original_ekstern_id
     or new.google_token is distinct from old.google_token
     or new.bruger_id <> old.bruger_id or new.produkt_id <> old.produkt_id or new.point <> old.point
     or new.miljoe <> old.miljoe or new.koebt_kl <> old.koebt_kl
     or new.pris_milli is distinct from old.pris_milli or new.valuta is distinct from old.valuta
     or new.land is distinct from old.land or new.krediteret_kl <> old.krediteret_kl
     or new.markering is distinct from old.markering
     -- Refunderede point kan kun gå op.
     or new.refunderet_point < old.refunderet_point
     or (old.forbrugt_kl is not null and new.forbrugt_kl is distinct from old.forbrugt_kl) then
    raise exception 'Købets platform, transaktion, køber, produkt, point, pris og markering kan ikke ændres';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;

-- ===========================================================================
-- 2. Ventende refusioner
-- ===========================================================================
create table if not exists public.boost_iap_ventende_refusioner (
  id              uuid primary key default gen_random_uuid(),
  platform        text not null,
  ekstern_id      text,
  google_token    text,
  andel_milli     integer not null,
  kilde           text not null,
  modtaget_kl     timestamptz not null default now(),
  opdateret_kl    timestamptz not null default now(),
  ophaevet_kl     timestamptz,
  afvist_antal    integer not null default 0,
  sidst_afvist_kl timestamptz,
  constraint boost_iap_ventende_platform_check check (platform in ('ios', 'android')),
  constraint boost_iap_ventende_noegle_check check (
    (ekstern_id is not null or google_token is not null)
    and (ekstern_id is null or char_length(ekstern_id) between 1 and 200)
    and (google_token is null or (platform = 'android' and char_length(google_token) between 10 and 2000))),
  constraint boost_iap_ventende_andel_check check (andel_milli between 1 and 100000),
  constraint boost_iap_ventende_kilde_check check (
    kilde in ('apple_notifikation', 'apple_historik', 'google_rtdn', 'google_voided', 'apple_opslag', 'google_opslag'))
);
comment on table public.boost_iap_ventende_refusioner is
  'Refusioner fra Apple/Google af køb, der (endnu) ikke er krediteret hos BidHamr - fx en refusion, der kommer før appen sender købet, eller et firmakøb. boost_iap_krediter afviser købet, så længe rækken ikke er ophævet (Apple REFUND_REVERSED). Slettes aldrig.';
create unique index if not exists boost_iap_ventende_ekstern on public.boost_iap_ventende_refusioner (platform, ekstern_id)
  where ekstern_id is not null;
create unique index if not exists boost_iap_ventende_token on public.boost_iap_ventende_refusioner (google_token)
  where google_token is not null;

drop trigger if exists boost_iap_ventende_forbyd_sletning on public.boost_iap_ventende_refusioner;
create trigger boost_iap_ventende_forbyd_sletning before delete on public.boost_iap_ventende_refusioner
  for each row execute function public.boost_koeb_forbyd_sletning();
drop trigger if exists boost_iap_ventende_ingen_truncate on public.boost_iap_ventende_refusioner;
create trigger boost_iap_ventende_ingen_truncate before truncate on public.boost_iap_ventende_refusioner
  for each statement execute function public.boost_forbyd_aendring();
alter table public.boost_iap_ventende_refusioner enable row level security;
revoke all on public.boost_iap_ventende_refusioner from public, anon, authenticated, service_role;
grant select on public.boost_iap_ventende_refusioner to service_role;

-- Lås for ét køb (transaktions-id eller Google-token) i transaktionen.
-- Rækkefølge overalt: token ('t:'), så transaktion/ordre ('e:'), så
-- pointkontoen (boost_laas_bruger).
create or replace function public.boost_iap_laas_koeb(p_platform text, p_noegle text)
returns void language sql security definer set search_path = '' as $fn$
  select pg_advisory_xact_lock(hashtextextended('bidhamr-iap-koeb:' || p_platform || ':' || p_noegle, 0));
$fn$;

-- ===========================================================================
-- 3. Krediteringen (ny parameter p_markering; ventende refusion afviser)
-- ===========================================================================
-- Svar {kode, ...} som før, plus:
--   'refunderet'   Apple/Google har refunderet købet, før det blev krediteret
drop function if exists public.boost_iap_krediter(uuid, text, text, text, text, text, text, timestamptz, bigint, text, text);
create or replace function public.boost_iap_krediter(
  p_bruger uuid, p_platform text, p_ekstern_id text, p_original_id text, p_google_token text,
  p_produkt text, p_miljoe text, p_koebt_kl timestamptz, p_pris_milli bigint, p_valuta text, p_land text,
  p_markering text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_spaerret text;
  v_point integer;
  v_id uuid;
  k record;
begin
  if p_bruger is null or p_platform not in ('ios', 'android') or coalesce(p_ekstern_id, '') = ''
     or p_miljoe not in ('produktion', 'test') or p_koebt_kl is null
     or (p_platform = 'android') <> (p_google_token is not null)
     or not (p_markering is null
             or (p_markering = 'testkoeb_prod' and p_miljoe = 'test')
             or (p_markering = 'promo' and p_platform = 'android' and p_miljoe = 'produktion')) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  -- Købets lås (mod en samtidig refusion), så pointkontoen.
  if p_google_token is not null then perform public.boost_iap_laas_koeb(p_platform, 't:' || p_google_token); end if;
  perform public.boost_iap_laas_koeb(p_platform, 'e:' || p_ekstern_id);
  perform public.boost_laas_bruger(p_bruger);
  -- Samme transaktion/ordre eller samme Google-token: aldrig igen, aldrig til
  -- en anden bruger.
  select x.id, x.bruger_id, x.point, x.forbrugt_kl, x.refunderet_point into k
    from public.boost_iap_koeb x
   where (x.platform = p_platform and x.ekstern_id = p_ekstern_id)
      or (p_google_token is not null and x.google_token = p_google_token)
   limit 1;
  if k.id is not null then
    if k.bruger_id <> p_bruger then return jsonb_build_object('kode', 'anden_bruger'); end if;
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'point', k.point,
                              'forbrugt', k.forbrugt_kl is not null, 'refunderet', k.refunderet_point > 0,
                              'saldo', public.boost_saldo(p_bruger));
  end if;
  -- Refunderet, før det blev krediteret: ingen point.
  update public.boost_iap_ventende_refusioner r
     set afvist_antal = r.afvist_antal + 1, sidst_afvist_kl = now()
   where r.platform = p_platform and r.ophaevet_kl is null
     and (r.ekstern_id = p_ekstern_id or (p_google_token is not null and r.google_token = p_google_token));
  if found then return jsonb_build_object('kode', 'refunderet'); end if;
  v_spaerret := public.boost_bruger_spaerret(p_bruger);
  if v_spaerret is not null then return jsonb_build_object('kode', v_spaerret); end if;
  -- Point fra produktet (også et produkt, der er slået fra - købet er betalt).
  select pr.point into v_point from public.boost_iap_produkter pr where pr.produkt_id = p_produkt;
  if v_point is null then return jsonb_build_object('kode', 'produkt_ukendt'); end if;

  insert into public.boost_iap_koeb (platform, ekstern_id, original_ekstern_id, google_token, bruger_id, produkt_id,
                                     point, miljoe, koebt_kl, pris_milli, valuta, land, markering)
  values (p_platform, p_ekstern_id, nullif(p_original_id, ''), p_google_token, p_bruger, p_produkt,
          v_point, p_miljoe, p_koebt_kl, p_pris_milli, case when p_pris_milli is null then null else p_valuta end,
          nullif(upper(coalesce(p_land, '')), ''), p_markering)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    select x.id, x.bruger_id into k from public.boost_iap_koeb x
     where (x.platform = p_platform and x.ekstern_id = p_ekstern_id)
        or (p_google_token is not null and x.google_token = p_google_token)
     limit 1;
    if k.bruger_id is distinct from p_bruger then return jsonb_build_object('kode', 'anden_bruger'); end if;
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'saldo', public.boost_saldo(p_bruger));
  end if;
  insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, iap_koeb_id)
  values (p_bruger, case when p_platform = 'ios' then 'koeb_apple' else 'koeb_google' end, v_point, 0, v_id);
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'point', v_point, 'saldo', public.boost_saldo(p_bruger));
end;
$fn$;

-- ===========================================================================
-- 4. Refusionen (låst mod krediteringen; ukendt køb = ventende refusion)
-- ===========================================================================
-- Svar som før; 'ukendt' betyder nu også, at refusionen er gemt som ventende
-- (ventende: true). staff_testkoeb kan ikke blive ventende.
create or replace function public.boost_iap_refusion(
  p_platform text, p_ekstern_id text, p_google_token text, p_andel_milli integer, p_kilde text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_bruger uuid;
  k record;
  v_maal integer;
  v_delta integer;
  v_saldo integer;
  v_vid uuid;
  v_hvem text;
  v_e text := nullif(p_ekstern_id, '');
  v_t text := case when p_platform = 'android' then nullif(p_google_token, '') else null end;
begin
  if p_platform not in ('ios', 'android') or p_andel_milli is null or p_andel_milli not between 1 and 100000
     or (v_e is null and v_t is null)
     or p_kilde not in ('apple_notifikation', 'apple_historik', 'google_rtdn', 'google_voided',
                        'apple_opslag', 'google_opslag', 'staff_testkoeb') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if v_t is not null then perform public.boost_iap_laas_koeb(p_platform, 't:' || v_t); end if;
  if v_e is not null then perform public.boost_iap_laas_koeb(p_platform, 'e:' || v_e); end if;
  select x.bruger_id into v_bruger from public.boost_iap_koeb x
   where x.platform = p_platform
     and ((v_e is not null and x.ekstern_id = v_e) or (v_t is not null and x.google_token = v_t))
   limit 1;
  if v_bruger is null then
    if p_kilde = 'staff_testkoeb' then return jsonb_build_object('kode', 'ukendt'); end if;
    -- Ikke krediteret (endnu): gem som ventende, så købet afvises bagefter.
    select r.id into v_vid from public.boost_iap_ventende_refusioner r
     where r.platform = p_platform
       and ((v_e is not null and r.ekstern_id = v_e) or (v_t is not null and r.google_token = v_t))
     limit 1
     for update;
    if v_vid is not null then
      update public.boost_iap_ventende_refusioner
         set andel_milli = greatest(andel_milli, p_andel_milli), ophaevet_kl = null, opdateret_kl = now()
       where id = v_vid;
    else
      begin
        insert into public.boost_iap_ventende_refusioner (platform, ekstern_id, google_token, andel_milli, kilde)
        values (p_platform, v_e, v_t, p_andel_milli, p_kilde);
      exception when unique_violation then
        null; -- samme refusion er netop gemt
      end;
    end if;
    return jsonb_build_object('kode', 'ukendt', 'ventende', true);
  end if;
  -- Låserækkefølge: købet (ovenfor), pointkontoen, så rækken.
  perform public.boost_laas_bruger(v_bruger);
  select x.id, x.point, x.refunderet_point, x.bruger_id into k from public.boost_iap_koeb x
   where x.platform = p_platform
     and ((v_e is not null and x.ekstern_id = v_e) or (v_t is not null and x.google_token = v_t))
   limit 1
   for update;
  v_maal := least(ceil(k.point::numeric * p_andel_milli / 100000)::integer, k.point);
  v_delta := v_maal - k.refunderet_point;
  if v_delta <= 0 then
    return jsonb_build_object('kode', 'allerede', 'id', k.id, 'bruger_id', k.bruger_id,
                              'saldo', public.boost_saldo(k.bruger_id));
  end if;
  insert into public.boost_posteringer (bruger_id, type, point, saldo_efter, iap_koeb_id)
  values (k.bruger_id, case when p_platform = 'ios' then 'refusion_apple' else 'refusion_google' end, -v_delta, 0, k.id);
  v_saldo := public.boost_saldo(k.bruger_id);
  v_hvem := case when p_kilde = 'staff_testkoeb' then 'BidHamr har trukket testkøbet tilbage'
                 when p_platform = 'ios' then 'Apple har refunderet købet'
                 else 'Google har refunderet købet' end;
  update public.boost_iap_koeb
     set refunderet_point = v_maal, refunderet_kl = coalesce(refunderet_kl, now()),
         refusion_kilde = coalesce(refusion_kilde, p_kilde),
         kraever_opmaerksomhed = kraever_opmaerksomhed or v_saldo < 0,
         opmaerksomhed_tekst = case when v_saldo < 0 then left(concat_ws(E'\n', opmaerksomhed_tekst,
           format('%s - %s point er trukket tilbage, og saldoen er nu %s (i minus). Nye boost er blokeret, til saldoen er over prisen for et boost.',
                  v_hvem, v_delta, v_saldo)), 4000)
                                    else opmaerksomhed_tekst end
   where id = k.id;
  return jsonb_build_object('kode', 'tilbagefoert', 'id', k.id, 'bruger_id', k.bruger_id, 'point', v_delta,
                            'saldo', v_saldo, 'i_minus', v_saldo < 0);
end;
$fn$;

-- Apple REFUND_REVERSED for et køb, vi ikke har krediteret: ophæv den
-- ventende refusion (købet må krediteres). true = ophævet.
create or replace function public.boost_iap_ventende_ophaev(p_platform text, p_ekstern_id text, p_google_token text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  v_e text := nullif(p_ekstern_id, '');
  v_t text := case when p_platform = 'android' then nullif(p_google_token, '') else null end;
begin
  if v_e is null and v_t is null then return false; end if;
  if v_t is not null then perform public.boost_iap_laas_koeb(p_platform, 't:' || v_t); end if;
  if v_e is not null then perform public.boost_iap_laas_koeb(p_platform, 'e:' || v_e); end if;
  update public.boost_iap_ventende_refusioner r
     set ophaevet_kl = now(), opdateret_kl = now()
   where r.platform = p_platform and r.ophaevet_kl is null
     and ((v_e is not null and r.ekstern_id = v_e) or (v_t is not null and r.google_token = v_t));
  return found;
end;
$fn$;

-- Træk alle testkøb i produktion tilbage (efter App Review). Kør i
-- Supabase SQL Editor: select public.boost_iap_tilbagekald_testkoeb();
-- Idempotent: allerede tilbagekaldte køb springes over. Saldoen kan gå i
-- minus, hvis pointene er brugt (købet markeres til chefen).
create or replace function public.boost_iap_tilbagekald_testkoeb()
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
  r jsonb;
  n integer := 0;
  p integer := 0;
begin
  for k in select x.platform, x.ekstern_id, x.google_token from public.boost_iap_koeb x
            where x.markering = 'testkoeb_prod' and x.refunderet_point < x.point
            order by x.krediteret_kl loop
    r := public.boost_iap_refusion(k.platform, k.ekstern_id, k.google_token, 100000, 'staff_testkoeb');
    if r->>'kode' = 'tilbagefoert' then
      n := n + 1;
      p := p + (r->>'point')::integer;
    end if;
  end loop;
  return jsonb_build_object('tilbagekaldt', n, 'point', p);
end;
$fn$;

-- ===========================================================================
-- 5. Chefens visning
-- ===========================================================================
create or replace function public.boost_iap_admin_bruger(p_staff uuid, p_bruger uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
begin
  if p_staff is null or not exists (select 1 from public.users u where u.id = p_staff and u.rolle = 'chef') then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', k.id, 'platform', k.platform, 'produkt_id', k.produkt_id, 'point', k.point,
             'miljoe', k.miljoe, 'markering', k.markering, 'koebt_kl', k.koebt_kl, 'krediteret_kl', k.krediteret_kl,
             'pris_milli', k.pris_milli, 'valuta', k.valuta, 'ekstern_id', k.ekstern_id,
             'forbrugt_kl', k.forbrugt_kl, 'refunderet_point', k.refunderet_point, 'refunderet_kl', k.refunderet_kl,
             'kraever_opmaerksomhed', k.kraever_opmaerksomhed, 'opmaerksomhed_tekst', k.opmaerksomhed_tekst)
           order by k.krediteret_kl desc)
      from (select * from public.boost_iap_koeb x where x.bruger_id = p_bruger order by x.krediteret_kl desc limit 50) k),
    '[]'::jsonb);
end;
$fn$;

-- Omsætningen (antal, point, brutto, listepris, refusioner) er kun betalte
-- køb i produktion uden markering. promo_* og testkoeb_prod_antal for sig;
-- test_antal = alle testkøb (Sandbox/licenstestere, også i produktion).
create or replace function public.boost_salg_iap_platform(p_platform text, p_fra timestamptz, p_til timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
           'antal', count(*) filter (where k.miljoe = 'produktion' and k.markering is null),
           'point', coalesce(sum(k.point) filter (where k.miljoe = 'produktion' and k.markering is null), 0),
           'brutto_oere', coalesce(sum(k.pris_milli / 10) filter (where k.miljoe = 'produktion' and k.markering is null and k.valuta = 'DKK'), 0),
           'ukendt_pris', count(*) filter (where k.miljoe = 'produktion' and k.markering is null and k.valuta is distinct from 'DKK'),
           'listepris_oere', coalesce(sum(bp.pris_oere) filter (where k.miljoe = 'produktion' and k.markering is null), 0),
           'refunderet_antal', count(*) filter (where k.miljoe = 'produktion' and k.markering is null and k.refunderet_point > 0),
           'refunderet_point', coalesce(sum(k.refunderet_point) filter (where k.miljoe = 'produktion' and k.markering is null), 0),
           'refunderet_oere', coalesce(sum(k.pris_milli / 10 * k.refunderet_point / k.point)
                                         filter (where k.miljoe = 'produktion' and k.markering is null and k.valuta = 'DKK' and k.refunderet_point > 0), 0),
           'promo_antal', count(*) filter (where k.markering = 'promo'),
           'promo_point', coalesce(sum(k.point) filter (where k.markering = 'promo'), 0),
           'test_antal', count(*) filter (where k.miljoe = 'test'),
           'testkoeb_prod_antal', count(*) filter (where k.markering = 'testkoeb_prod'))
    from public.boost_iap_koeb k
    left join public.boost_iap_produkter pr on pr.produkt_id = k.produkt_id
    left join public.boost_pakker bp on bp.id = pr.pakke_id
   where k.platform = p_platform and (p_fra is null or k.krediteret_kl >= p_fra) and k.krediteret_kl < p_til;
$fn$;

-- ===========================================================================
-- 6. "Download dine data"
-- ===========================================================================
-- Kaldes kun af mine_data (security definer, ejer postgres) med brugerens
-- eget id. Ingen Google-token, ingen Stripe-id'er og ingen interne noter.
create or replace function public.mine_data_boost(p_uid uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'saldo', public.boost_saldo(p_uid),
    'bidhamr_dk', coalesce((
      select jsonb_agg(jsonb_build_object(
               'point', b.point, 'beloeb_oere', b.beloeb_oere, 'valuta', b.valuta, 'status', b.status,
               'oprettet_kl', b.oprettet_kl, 'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl)
             order by b.oprettet_kl)
        from public.boost_koeb b where p_uid is not null and b.bruger_id = p_uid), '[]'::jsonb),
    'appen', coalesce((
      select jsonb_agg(jsonb_build_object(
               'platform', case when k.platform = 'ios' then 'App Store' else 'Google Play' end,
               'transaktion', case when k.ekstern_id like 'token:%' then null else k.ekstern_id end,
               'produkt', k.produkt_id, 'point', k.point, 'testkoeb', k.miljoe = 'test', 'promo', coalesce(k.markering = 'promo', false),
               'koebt_kl', k.koebt_kl, 'krediteret_kl', k.krediteret_kl,
               'pris_milli', k.pris_milli, 'valuta', k.valuta, 'land', k.land,
               'refunderet_point', k.refunderet_point, 'refunderet_kl', k.refunderet_kl)
             order by k.krediteret_kl)
        from public.boost_iap_koeb k where p_uid is not null and k.bruger_id = p_uid), '[]'::jsonb));
$fn$;
revoke all on function public.mine_data_boost(uuid) from public, anon, authenticated, service_role;

create or replace function pg_temp.boost_flet_mine_data()
returns void language plpgsql as $$
declare
  v_def text := replace(pg_get_functiondef('public.mine_data()'::regprocedure), E'\r\n', E'\n');
  v_gl  text := E'  v := public.mine_data_grund()';
  v_n   integer;
begin
  if position('public.mine_data_boost(' in v_def) > 0 then
    return;
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
  if v_n <> 1 then
    raise exception 'mine_data: "%" fundet % gange (skal være 1) - flet boost-købene ind manuelt', v_gl, v_n;
  end if;
  execute replace(v_def, v_gl,
    v_gl || E'\n       || jsonb_build_object(''boost_koeb'', public.mine_data_boost(v_uid))');
end $$;

select pg_temp.boost_flet_mine_data();

do $$
begin
  if position('public.mine_data_boost(v_uid)' in pg_get_functiondef('public.mine_data()'::regprocedure)) = 0 then
    raise exception 'mine_data mangler boost-købene efter fletningen';
  end if;
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;

-- ===========================================================================
-- 7. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_iap_krediter(uuid, text, text, text, text, text, text, timestamptz, bigint, text, text, text)',
    'public.boost_iap_refusion(text, text, text, integer, text)',
    'public.boost_iap_ventende_ophaev(text, text, text)',
    'public.boost_iap_tilbagekald_testkoeb()',
    'public.boost_iap_admin_bruger(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.boost_iap_laas_koeb(text, text)',
    'public.boost_salg_iap_platform(text, timestamptz, timestamptz)',
    'public.boost_iap_koeb_laaste_felter()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $do$;
