-- M2: handle_new_bid (seneste definition: 20260623000000) afviste ikke bud
-- fra suspenderede brugere eller paa skjulte auktioner. Desuden kunne
-- klienten selv saette bids.oprettet (fx bagdatere et bud).
-- Kroppen herunder er 20260623000000's med de nye tjek tilfoejet.
-- NB: bids har ogsaa BEFORE INSERT-triggeren trg_check_minimum_bid
-- (check_minimum_bid, minimum 10% over), som laa i produktion uden
-- migration. Den er indfanget i 20260930090000.

create or replace function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auktion record;
  v_bruger record;
begin
  select suspenderet, suspenderet_til into v_bruger
    from public.users where id = new.bruger_id;

  if v_bruger is null then
    raise exception 'Brugeren findes ikke';
  end if;

  -- Samme regel som login: udloebet suspension (suspenderet_til passeret)
  -- taeller ikke.
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

  if new.beløb <= coalesce(v_auktion.nuværende_bud, v_auktion.startpris) then
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
$$;

-- Triggerfunktion - kaldes kun af triggeren.
revoke execute on function public.handle_new_bid() from public, anon, authenticated;

-- bids.oprettet saettes altid af serveren.
create or replace function public.bids_tving_tidspunkt()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  new.oprettet := now();
  return new;
end;
$fn$;

revoke execute on function public.bids_tving_tidspunkt() from public, anon, authenticated;

drop trigger if exists bids_tving_tidspunkt on public.bids;
create trigger bids_tving_tidspunkt
  before insert on public.bids
  for each row execute function public.bids_tving_tidspunkt();
