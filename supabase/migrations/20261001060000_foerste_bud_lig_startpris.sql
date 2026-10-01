-- Foerste bud maa vaere lig startprisen (Filip, 1. oktober 2026). Derefter
-- mindst 10 % over nuvaerende bud (budstigningen fastlaegges senere).
-- Ellers uaendret fra 20260930090000_check_minimum_bid_indfang.sql.
create or replace function public.check_minimum_bid()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  nuvaerende numeric;
  start      numeric;
  minimum    numeric;
begin
  select "nuværende_bud", startpris into nuvaerende, start
    from auctions where id = new.auktion_id;

  if nuvaerende is null then
    minimum := ceil(start);
    if new."beløb" < minimum then
      raise exception 'minimum_bid: Dit bud skal være mindst % kr (startprisen).', minimum;
    end if;
  else
    minimum := ceil(nuvaerende * 1.1);
    if new."beløb" < minimum then
      raise exception 'minimum_bid: Dit bud skal være mindst % kr (10%% over nuværende bud).', minimum;
    end if;
  end if;
  return new;
end;
$function$;

revoke execute on function public.check_minimum_bid() from public, anon, authenticated;

drop trigger if exists trg_check_minimum_bid on public.bids;
create trigger trg_check_minimum_bid
  before insert on public.bids
  for each row execute function public.check_minimum_bid();
