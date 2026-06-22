-- Når et bud indsættes: valider at det er højere end nuværende bud, opdater
-- auctions.nuværende_bud, og forlæng slutter_kl med 2 minutter hvis buddet
-- afgives i de sidste 2 minutter af auktionen (anti-snipe). Kører som
-- security definer og låser auktions-rækken, så samtidige bud ikke kan
-- "overhale" hinanden (race condition).

create function public.handle_new_bid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auktion record;
begin
  select * into v_auktion from public.auctions where id = new.auktion_id for update;

  if v_auktion is null then
    raise exception 'Auktionen findes ikke';
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

create trigger on_bid_created
  after insert on public.bids
  for each row execute function public.handle_new_bid();

-- Aktiver Realtime på bids og auctions, så klienter kan lytte på ændringer.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bids'
  ) then
    alter publication supabase_realtime add table public.bids;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'auctions'
  ) then
    alter publication supabase_realtime add table public.auctions;
  end if;
end $$;
