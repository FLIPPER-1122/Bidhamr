-- Rettelser til 20261005090000_tilbagebetaling_igen.sql (reviewer):
--
--  M1. Markeringer overskriver ikke laengere en tidligere grund. sidste_fejl
--      bygges op af dele adskilt af ' · ' (som afhentningsfristen i
--      20261005080000). Saa virker reglen i betaling_registrer_refunderet
--      ("ALLE dele skal vaere refusionsfejl") som tænkt: en afhentnings-,
--      sen-betalings- eller anden grund kan ikke forsvinde automatisk, fordi en
--      senere refusionsfejl har overskrevet den.
--        - betaling_fejl_tilfoej: faelles hjaelper (ingen dubletter, hoejst
--          2000 tegn - de nyeste dele beholdes, og de fjernede erstattes af
--          '…', som aldrig regnes for en refusions-/overfoerselsfejl).
--        - betaling_marker_opmaerksomhed (senest 20261001010000) og
--          betaling_refusion_fejlet (senest 20261003011000) bruger den.
--        - betaling_marker_refusion: ny, bruges af markerRefusion i
--          stripeBetaling.ts (tidligere en direkte update, der overskrev).
--  L1. betaling_refusion_konflikt: en anden refusion hos Stripe (fx fra
--      Dashboard) - markerer og saetter refusion_graense = refusion_forsoeg,
--      saa cron ikke proever igen hver koersel. Kun under laasen.
--  L2. Den gamle betaling_refusion_nyt_forsoeg(uuid, text) uden laas fjernes,
--      saa en ny idempotency key kun kan gives af den, der holder laasen.
--  L3. Laasen (betaling_refusion_laas) varer 15 minutter i stedet for 5.
--      Stripe-kaldene under laasen har desuden timeout 20 s og hoejst 1
--      netvaerksgenforsoeg (stripeBetaling.ts), saa laasen altid varer
--      laengere end kaldene.
--
-- moderation_log_handling_check roeres ikke.
-- Idempotent: create or replace / drop function if exists.

-- ============================================================ M1 hjaelper

-- Tilfoejer p_ny til p_gammel med ' · '. Er betalingen ikke markeret
-- (p_markeret false) eller er der ingen tidligere tekst, erstattes den (en
-- gammel, loest grund skal ikke blive haengende). Findes praecis samme del
-- allerede, aendres intet. Bliver teksten laengere end 2000 tegn, fjernes de
-- aeldste dele og erstattes af '…'.
create or replace function public.betaling_fejl_tilfoej(
  p_gammel   text,
  p_ny       text,
  p_markeret boolean)
returns text
language plpgsql immutable set search_path = public as $fn$
declare
  maks constant integer := 2000;
  ny    text := btrim(coalesce(p_ny, ''));
  dele  text[];
  tekst text;
begin
  if ny = '' then
    return p_gammel;
  end if;
  if not coalesce(p_markeret, false) or nullif(btrim(coalesce(p_gammel, '')), '') is null then
    return left(ny, maks);
  end if;

  select coalesce(array_agg(btrim(d) order by nr), '{}')
    into dele
    from regexp_split_to_table(p_gammel, ' · ') with ordinality as t(d, nr)
   where btrim(d) <> '';

  if ny = any(dele) then
    return p_gammel;
  end if;

  -- Et tidligere '…' (fjernede dele) laegges til igen nedenfor, hvis noedvendigt.
  if dele[1] = '…' then
    dele := dele[2:];
    tekst := array_to_string(dele || ny, ' · ');
    if length('… · ' || tekst) <= maks then
      return '… · ' || tekst;
    end if;
  else
    tekst := array_to_string(dele || ny, ' · ');
    if length(tekst) <= maks then
      return tekst;
    end if;
  end if;

  -- For lang: fjern de aeldste dele, til resten (med '…' foran) kan vaere der.
  while coalesce(array_length(dele, 1), 0) > 0 loop
    dele := dele[2:];
    tekst := array_to_string(dele || ny, ' · ');
    if length('… · ' || tekst) <= maks then
      return '… · ' || tekst;
    end if;
  end loop;

  -- Selv den nye del alene er for lang.
  return left('… · ' || ny, maks);
end;
$fn$;

revoke all on function public.betaling_fejl_tilfoej(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.betaling_fejl_tilfoej(text, text, boolean) to service_role;

-- ============================================================ M1 markeringer

-- Som 20261001010000_betaling_reviewer_rettelser.sql, men tilfoejer til
-- sidste_fejl i stedet for at overskrive.
create or replace function public.betaling_marker_opmaerksomhed(
  p_payment_intent text, p_besked text)
returns void
language sql security definer set search_path = public as $fn$
  update public.betalinger
     set sidste_fejl = public.betaling_fejl_tilfoej(sidste_fejl, p_besked, kraever_opmaerksomhed),
         kraever_opmaerksomhed = true,
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
$fn$;

revoke all on function public.betaling_marker_opmaerksomhed(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_marker_opmaerksomhed(text, text) to service_role;

-- Markering fra refunderBetaling (markerRefusion). Samme regel som ovenfor.
create or replace function public.betaling_marker_refusion(
  p_betaling uuid, p_besked text)
returns void
language sql security definer set search_path = public as $fn$
  update public.betalinger
     set sidste_fejl = public.betaling_fejl_tilfoej(sidste_fejl, p_besked, kraever_opmaerksomhed),
         kraever_opmaerksomhed = true,
         opdateret = now()
   where id = p_betaling;
$fn$;

revoke all on function public.betaling_marker_refusion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_marker_refusion(uuid, text) to service_role;

-- Som 20261003011000_sager_rettelser.sql, men tilfoejer til sidste_fejl.
-- Returnerer 'genaabnet' | 'ikke_refunderet' | 'erstattet' | 'ukendt'.
create or replace function public.betaling_refusion_fejlet(
  p_betaling uuid,
  p_refund   text)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  b record;
begin
  if p_betaling is null or nullif(btrim(coalesce(p_refund, '')), '') is null then
    return 'ukendt';
  end if;

  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return 'ukendt'; end if;
  if b.status <> 'refunderet' then return 'ikke_refunderet'; end if;
  if b.stripe_refund_id is not null and b.stripe_refund_id <> p_refund then
    return 'erstattet';
  end if;

  perform 1 from public.trades where id = b.trade_id for update;

  update public.betalinger
     set status = 'betalt',
         refunderet_kl = null,
         stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         sidste_fejl = public.betaling_fejl_tilfoej(
           sidste_fejl, 'Refusion fejlede hos Stripe – prøves igen', kraever_opmaerksomhed),
         kraever_opmaerksomhed = true,
         opdateret = now()
   where id = b.id
     and status = 'refunderet';
  if not found then return 'ikke_refunderet'; end if;

  return 'genaabnet';
end;
$fn$;

revoke all on function public.betaling_refusion_fejlet(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_refusion_fejlet(uuid, text) to service_role;

-- ============================================================ L1 konflikt

-- refunderBetaling fandt en anden refusion hos Stripe, der ikke daekker
-- beloebet (fx lavet i Stripe Dashboard). Der oprettes intet nyt: betalingen
-- markeres, og cron stopper (refusion_graense = refusion_forsoeg), til admin
-- har set paa den ("Proev tilbagebetaling igen" haever graensen igen).
-- Graensen saettes kun af den, der holder laasen; markeringen altid.
-- Returnerer true, hvis graensen er sat.
create or replace function public.betaling_refusion_konflikt(
  p_betaling uuid,
  p_noegle   uuid,
  p_besked   text)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  laast boolean;
begin
  if p_betaling is null then return false; end if;

  update public.betalinger
     set refusion_graense = refusion_forsoeg
   where id = p_betaling
     and p_noegle is not null
     and refusion_laas_noegle = p_noegle
     and refusion_laas_til > now()
     and status <> 'refunderet';
  laast := found;

  update public.betalinger
     set sidste_fejl = public.betaling_fejl_tilfoej(sidste_fejl, p_besked, kraever_opmaerksomhed),
         kraever_opmaerksomhed = true,
         opdateret = now()
   where id = p_betaling;

  return laast;
end;
$fn$;

revoke all on function public.betaling_refusion_konflikt(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_refusion_konflikt(uuid, uuid, text) to service_role;

-- ============================================================ L2 ingen ny key uden laas

drop function if exists public.betaling_refusion_nyt_forsoeg(uuid, text);

-- ============================================================ L3 laas 15 min

-- Som 20261005090000_tilbagebetaling_igen.sql, men laasen varer 15 minutter.
-- Stripe-kaldene under laasen har timeout 20 s og hoejst 1 genforsoeg (i alt
-- hoejst ca. 4 minutter for alle kald), saa laasen udloeber aldrig, mens et
-- kald stadig er i gang. Doer serveren midt i kaldet, kan naeste forsoeg
-- tidligst ske efter 15 minutter (og slaar saa eksisterende refusioner op hos
-- Stripe, foer en ny oprettes).
create or replace function public.betaling_refusion_laas(
  p_betaling uuid,
  p_noegle   uuid,
  p_forsoeg  integer,
  p_refund   text)
returns boolean
language plpgsql security definer set search_path = public as $fn$
begin
  if p_betaling is null or p_noegle is null then return false; end if;
  update public.betalinger
     set refusion_laas_til = now() + interval '15 minutes',
         refusion_laas_noegle = p_noegle
   where id = p_betaling
     and (refusion_laas_til is null or refusion_laas_til < now())
     and refusion_forsoeg = p_forsoeg
     and stripe_refund_id is not distinct from p_refund
     and refusion_anmodet_kl is not null
     and status <> 'refunderet'
     and stripe_transfer_id is null
     and overfoersel_paabegyndt_kl is null;
  return found;
end;
$fn$;

revoke all on function public.betaling_refusion_laas(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.betaling_refusion_laas(uuid, uuid, integer, text) to service_role;
