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

-- handle_new_bid krævede også bud > startpris. Første bud må nu være lig
-- startprisen; derefter skal buddet være højere end nuværende bud.
-- Ellers ordret som i produktion (hentet 1. oktober 2026).
create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_auktion record;
  v_bruger record;
begin
  select suspenderet, suspenderet_til into v_bruger
    from public.users where id = new.bruger_id;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
  end if;

  if v_bruger.suspenderet
     and (v_bruger.suspenderet_til is null or v_bruger.suspenderet_til > now()) then
    raise exception 'Din konto er suspenderet, og du kan ikke byde.'
      using errcode = '42501';
  end if;

  select * into v_auktion from public.auctions where id = new.auktion_id for update;

  if v_auktion is null then
    raise exception 'Auktionen findes ikke';
  end if;

  if v_auktion.skjult then
    raise exception 'Auktionen er ikke tilgængelig';
  end if;

  if v_auktion.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;

  if v_auktion.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  if (v_auktion.nuværende_bud is null and new.beløb < v_auktion.startpris)
     or (v_auktion.nuværende_bud is not null and new.beløb <= v_auktion.nuværende_bud) then
    raise exception 'Buddet skal være højere end nuværende bud';
  end if;

  update public.auctions
  set
    nuværende_bud = new.beløb,
    slutter_kl = case
      when slutter_kl - now() < interval '2 minutes'
        then now() + interval '2 minutes'
      else slutter_kl
    end
  where id = new.auktion_id;

  return new;
end;
$function$;

revoke execute on function public.handle_new_bid() from public, anon, authenticated;
