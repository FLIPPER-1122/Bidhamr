-- trg_check_minimum_bid / check_minimum_bid findes i produktion, men laa ikke
-- i nogen migration. Indfanges her med uaendret logik; kun
-- "set search_path = public" er tilfoejet.
create or replace function public.check_minimum_bid()
returns trigger
language plpgsql
set search_path = public
as $function$
declare
  nuvaerende numeric;
  minimum numeric;
begin
  select coalesce("nuværende_bud", startpris) into nuvaerende
    from auctions where id = new.auktion_id;
  minimum := ceil(nuvaerende * 1.1);
  if new."beløb" < minimum then
    raise exception 'minimum_bid: Dit bud skal være mindst % kr (10%% over nuværende bud).', minimum;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_check_minimum_bid on public.bids;
create trigger trg_check_minimum_bid
  before insert on public.bids
  for each row execute function public.check_minimum_bid();
