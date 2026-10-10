-- Ikke-afhentet pakke: rettelser efter review (10. okt. 2026) af
-- 20261016030000_ikke_afhentet_pakke.sql.
--
--   1. handel_ikke_afhentet_registrer:
--      - afviser med 'leveret', når handlen står i 'modtaget' (køberen har
--        trykket "modtaget"), eller når en udgående forsendelse har
--        leveret_kl - også for staff,
--      - uden en returmelding fra fragtfirmaet (returneret_kl på en udgående
--        pakke, der ikke er leveret) kræver staff-vejen admin eller chef
--        (ny kode 'kraever_admin'); en medarbejder må kun med returmelding,
--      - skriver i moderation_log i samme transaktion (staff).
--   2. ikke_afhentet_fragt_kandidater: reservens kandidater (betalings-
--      cron'en) - handler, der allerede er registreret eller ikke kan
--      registreres (sag, markering, frigivet, refusion, indsigelse), er
--      sorteret fra i forespørgslen, så reserven ikke går i stå.
--
-- Idempotent. md5-drift-tjek: kroppen skal være versionen fra 20261016030000
-- eller denne migrations version.

set local lock_timeout = '5s';

do $do$
declare
  h text;
begin
  if to_regclass('public.handel_ikke_afhentet') is null then
    raise exception 'Kør 20261016030000_ikke_afhentet_pakke.sql først';
  end if;
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    into h
    from pg_proc p where p.oid = 'public.handel_ikke_afhentet_registrer(uuid,text,uuid,text,uuid,bigint)'::regprocedure;
  if h = '9c88ad4a340ff9084680eca441284201' then
    raise notice 'handel_ikke_afhentet_registrer: allerede rettet';
  elsif h is distinct from 'ce997b0ea7ccc8c2846bb99fab24ac7a' then
    raise exception 'handel_ikke_afhentet_registrer: kroppen afviger fra 20261016030000 (md5 %) - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

-- ===========================================================================
-- 1. Registreringen
-- ===========================================================================
-- Kode som i 20261016030000, plus 'kraever_admin'. 'leveret' gælder nu også
-- staff og handler i 'modtaget'.
create or replace function public.handel_ikke_afhentet_registrer(
  p_trade           uuid,
  p_kilde           text,
  p_medarbejder     uuid default null,
  p_begrundelse     text default null,
  p_forsendelse     uuid default null,
  p_returfragt_oere bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b        record;
  t        record;
  f        record;
  e        record;
  v_rolle  text;
  v_begr   text;
  v_retur  bigint;
  v_r      bigint;
  v_fors   uuid;
  v_retur_meldt boolean;
begin
  if p_trade is null or p_kilde is null or p_kilde not in ('fragt', 'staff') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  v_begr := nullif(btrim(coalesce(p_begrundelse, '')), '');
  if p_kilde = 'staff' then
    if p_medarbejder is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
    select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
    if v_rolle is null or v_rolle not in ('medarbejder', 'admin', 'chef') then
      return jsonb_build_object('kode', 'ingen_adgang');
    end if;
    if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
    if char_length(v_begr) > 1000 then return jsonb_build_object('kode', 'ugyldig'); end if;
  elsif p_forsendelse is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  -- Låserækkefølge: betaling, handel (som handel_auto_frigiv og fristerne).
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then
    if not exists (select 1 from public.trades where id = p_trade) then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    return jsonb_build_object('kode', 'ingen_betaling');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Idempotent: allerede registreret (af fragt eller staff).
  select * into e from public.handel_ikke_afhentet where trade_id = p_trade;
  if found then
    return jsonb_build_object(
      'kode', 'allerede', 'betaling_id', e.betaling_id, 'trade_id', e.trade_id,
      'buyer_id', t.buyer_id, 'seller_id', t.seller_id, 'auction_id', t.auction_id,
      'refusion_oere', e.refusion_oere, 'returfragt_oere', e.returfragt_oere,
      'kilde', e.kilde, 'registreret_kl', e.registreret_kl);
  end if;

  if p_kilde = 'staff' and p_medarbejder in (t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;
  -- Køberen har trykket "modtaget": pakken er leveret (review 10. okt. 2026).
  if t.status = 'modtaget' then return jsonb_build_object('kode', 'leveret'); end if;
  if t.status <> 'pakke_sendt' then return jsonb_build_object('kode', 'forkert_status'); end if;
  -- Fragtfirmaet melder en udgående pakke leveret: aldrig "ikke afhentet".
  if exists (select 1 from public.forsendelser fo
              where fo.trade_id = p_trade and fo.type = 'udgaaende'
                and fo.status not in ('annulleret', 'fejlet') and fo.leveret_kl is not null) then
    return jsonb_build_object('kode', 'leveret');
  end if;
  -- Uden en returmelding fra fragtfirmaet kræver staff-vejen admin eller chef;
  -- en medarbejder må kun, når pakken er meldt retur.
  v_retur_meldt := exists (select 1 from public.forsendelser fo
                            where fo.trade_id = p_trade and fo.type = 'udgaaende'
                              and fo.returneret_kl is not null and fo.leveret_kl is null);
  if p_kilde = 'staff' and not v_retur_meldt and v_rolle not in ('admin', 'chef') then
    return jsonb_build_object('kode', 'kraever_admin');
  end if;

  -- Pengene: betalt, hverken frigivet, udbetalt eller under refusion, og
  -- ingen indsigelse eller sag, der afgør dem.
  if b.pengemodel is distinct from 'destination' then return jsonb_build_object('kode', 'gammel_model'); end if;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return jsonb_build_object('kode', 'ikke_betalt'); end if;
  if b.frigivet_kl is not null then return jsonb_build_object('kode', 'frigivet'); end if;
  if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  if b.refusion_anmodet_kl is not null or b.refunderet_kl is not null then
    return jsonb_build_object('kode', 'refusion_i_gang');
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or b.indsigelse_tilbagefoert_oere is not null then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if public.sag_holder_pengene(p_trade) then return jsonb_build_object('kode', 'sag'); end if;
  -- Staffs egen markering (sag_aaben) afgør staff selv - ikke fragten.
  if p_kilde = 'fragt' and coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'markeret');
  end if;

  -- Forsendelsen.
  if p_forsendelse is not null then
    select * into f from public.forsendelser
     where id = p_forsendelse and trade_id = p_trade and type = 'udgaaende';
    if not found then return jsonb_build_object('kode', 'forsendelse_ukendt'); end if;
    if f.leveret_kl is not null then return jsonb_build_object('kode', 'leveret'); end if;
    if p_kilde = 'fragt' and f.returneret_kl is null then
      return jsonb_build_object('kode', 'ikke_returneret');
    end if;
    v_fors := f.id;
  else
    -- Staff uden forsendelse: den seneste udgående, der ikke er annulleret
    -- (kun som reference).
    select fo.id into v_fors from public.forsendelser fo
     where fo.trade_id = p_trade and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet')
     order by fo.oprettet_kl desc limit 1;
  end if;

  -- Beløbene (øre). Returfragten kan aldrig være negativ eller over det betalte.
  v_retur := coalesce(p_returfragt_oere, b.fragt_oere);
  if v_retur is null or v_retur < 0 or v_retur > b.total_oere then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  v_r := greatest(0, b.total_oere - b.koebergebyr_oere - b.beskyttelse_oere - b.fragt_oere - v_retur);

  insert into public.handel_ikke_afhentet (
    trade_id, betaling_id, forsendelse_id, kilde, medarbejder_id, begrundelse,
    total_oere, koebergebyr_oere, beskyttelse_oere, fragt_oere, returfragt_oere, refusion_oere)
  values (
    p_trade, b.id, v_fors, p_kilde, case when p_kilde = 'staff' then p_medarbejder end,
    case when p_kilde = 'staff' then v_begr end,
    b.total_oere, b.koebergebyr_oere, b.beskyttelse_oere, b.fragt_oere, v_retur, v_r);

  -- Handlen lukkes (annulleret - arkiveres af oprydningen, når refusionen er
  -- gennemført). Ingen sag kan oprettes bagefter.
  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = p_trade;

  -- Refusionen er lovet: betalings-cron'en prøver altid igen
  -- (refunderLoveteVentende), til Stripe har gennemført den. R = 0 (Filip,
  -- 10. okt. 2026): samme vej, men kun tilbageførslen af sælgerens del
  -- (X = U) og ingen refusion til køberen (src/lib/betaling/refusion.ts,
  -- betaling_ikke_afhentet_uden_refusion).
  update public.betalinger
     set refusion_oere = v_r,
         refusion_aarsag = 'ikke_afhentet',
         refusion_anmodet_kl = now(),
         opdateret = now()
   where id = b.id;

  -- Medarbejder-loggen i samme transaktion (staff). Ingen beløb - pengetal
  -- er kun for chef.
  if p_kilde = 'staff' then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_medarbejder, 'handel_ikke_afhentet', 'handel', p_trade, t.buyer_id,
            left(case when v_r > 0
                      then 'Tilbagebetaling minus gebyrer og fragt begge veje'
                      else 'Køberen får 0 kr. (returfragten er mindst buddet) - sælgerens del tilbageføres' end
                 || case when v_retur_meldt then ' (fragtfirmaet har meldt pakken retur)'
                         else ' (uden returmelding fra fragtfirmaet)' end
                 || ' — ' || v_begr, 2000));
  end if;

  return jsonb_build_object(
    'kode', case when v_r > 0 then 'ok' else 'ok_intet' end,
    'betaling_id', b.id, 'trade_id', p_trade,
    'buyer_id', t.buyer_id, 'seller_id', t.seller_id, 'auction_id', t.auction_id,
    'refusion_oere', v_r, 'returfragt_oere', v_retur, 'kilde', p_kilde,
    'registreret_kl', now());
end;
$fn$;

revoke all on function public.handel_ikke_afhentet_registrer(uuid, text, uuid, text, uuid, bigint) from public, anon, authenticated;
grant execute on function public.handel_ikke_afhentet_registrer(uuid, text, uuid, text, uuid, bigint) to service_role;

-- ===========================================================================
-- 2. Reservens kandidater (betalings-cron'en, src/lib/betaling/ikkeAfhentet.ts)
-- ===========================================================================
-- Udgående pakker meldt retur (aldrig leveret) de seneste 30 dage hos
-- fragtfirmaer, hvor signalet er sikkert (p_fragtfirmaer - adapterens
-- returErIkkeAfhentet), på handler, der kan registreres nu: ikke registreret,
-- 'pakke_sendt', ikke afhentning, ingen markering, betalt og hverken frigivet,
-- udbetalt eller under refusion, ingen sag der holder pengene og ingen
-- blokerende indsigelse. Ældste først.
create or replace function public.ikke_afhentet_fragt_kandidater(p_fragtfirmaer text[], p_graense integer default 20)
returns table (forsendelse_id uuid, trade_id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  select fo.id, fo.trade_id
    from public.forsendelser fo
    join public.trades t on t.id = fo.trade_id
    join public.betalinger b on b.trade_id = t.id
   where fo.type = 'udgaaende'
     and fo.returneret_kl is not null
     and fo.leveret_kl is null
     and fo.returneret_kl >= now() - interval '30 days'
     and fo.fragtfirma = any(coalesce(p_fragtfirmaer, '{}'::text[]))
     and t.status = 'pakke_sendt'
     and not coalesce(t.afhentning, false)
     and not coalesce(t.sag_aaben, false)
     and b.status = 'betalt'
     and b.frigivet_kl is null
     and b.refusion_anmodet_kl is null
     and b.stripe_transfer_id is null and b.saelger_udbetaling_id is null
     and b.overfoersel_paabegyndt_kl is null
     and not public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     and not public.sag_holder_pengene(t.id)
     and not exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id)
     and not exists (select 1 from public.forsendelser lv
                      where lv.trade_id = t.id and lv.type = 'udgaaende'
                        and lv.status not in ('annulleret', 'fejlet') and lv.leveret_kl is not null)
   order by fo.returneret_kl, fo.id
   limit least(greatest(coalesce(p_graense, 20), 1), 100);
$fn$;

revoke all on function public.ikke_afhentet_fragt_kandidater(text[], integer) from public, anon, authenticated;
grant execute on function public.ikke_afhentet_fragt_kandidater(text[], integer) to service_role;
