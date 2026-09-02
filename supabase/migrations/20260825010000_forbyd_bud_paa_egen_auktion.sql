-- En sælger kunne byde på sin egen auktion og dermed presse prisen op.
-- Spærres i databasen, så det gælder uanset hvilken klient der indsætter buddet.
-- Triggernavnet sorterer før trg_check_minimum_bid, så denne (mere
-- grundlæggende) fejl vises frem for beløbsfejlen.

create or replace function public.check_ikke_egen_auktion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saelger_id uuid;
begin
  select bruger_id into v_saelger_id
    from public.auctions
   where id = new.auktion_id;

  if v_saelger_id is null then
    raise exception 'Auktionen findes ikke';
  end if;

  if v_saelger_id = new.bruger_id then
    raise exception 'own_auction: Du kan ikke byde på din egen auktion.';
  end if;

  return new;
end;
$$;

comment on function public.check_ikke_egen_auktion() is
  'Forhindrer at en sælger byder på sin egen auktion.';

drop trigger if exists trg_check_egen_auktion on public.bids;
create trigger trg_check_egen_auktion
  before insert on public.bids
  for each row execute function public.check_ikke_egen_auktion();
