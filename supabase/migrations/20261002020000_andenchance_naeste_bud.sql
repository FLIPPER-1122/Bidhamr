-- Andenchance: vis saelgeren beloebet for naeste byder, foer tilbuddet sendes.
--
-- andenchance_naeste_bud(p_trade) returnerer bud i oere for den byder, som
-- andenchance_opret ville vaelge lige nu, eller null. Byderens id returneres
-- ikke (privatliv). WHERE/ORDER er kopieret ordret fra andenchance_opret i
-- 20261002010000_ubetalt_vinder.sql - ret begge steder, hvis reglen aendres.
--
-- Kun service_role (server action tjekker, at kalderen er saelgeren).
-- Idempotent. Ingen data aendres.

create or replace function public.andenchance_naeste_bud(p_trade uuid)
returns bigint
language plpgsql stable security definer set search_path = public as $fn$
declare
  t      record;
  naeste record;
begin
  select * into t from public.trades where id = p_trade;
  if not found then return null; end if;

  with hoejeste as (
    select b.bruger_id, max(b.beløb) as maks
      from public.bids b
     where b.auktion_id = t.auction_id
     group by b.bruger_id
  )
  select h.bruger_id,
         round(h.maks * 100)::bigint as bud_oere,
         (select min(b.oprettet) from public.bids b
           where b.auktion_id = t.auction_id
             and b.bruger_id = h.bruger_id
             and b.beløb = h.maks) as foerste
    into naeste
    from hoejeste h
    join public.users u on u.id = h.bruger_id
   where h.maks > 0
     and h.bruger_id <> t.seller_id
     and not exists (select 1 from public.trades x
                      where x.auction_id = t.auction_id and x.buyer_id = h.bruger_id)
     and not exists (select 1 from public.andenchance_tilbud x
                      where x.auction_id = t.auction_id and x.byder_id = h.bruger_id)
     and not (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()))
   order by h.maks desc, foerste asc
   limit 1;

  if not found then return null; end if;
  return naeste.bud_oere;
end;
$fn$;

revoke all on function public.andenchance_naeste_bud(uuid) from public, anon, authenticated;
grant execute on function public.andenchance_naeste_bud(uuid) to service_role;
