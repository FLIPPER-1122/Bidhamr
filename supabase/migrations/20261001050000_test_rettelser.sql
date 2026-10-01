-- Rettelser efter sluttesten.
-- Idempotent og sikker at koere i produktion (produktion har ingen
-- auctions.visninger - den haandteres via jsonb).

-- =============================================================== 1. Rate limit paa bud
-- afgivBud (server action) rate-limiter allerede, men bud kan ogsaa indsaettes
-- direkte via REST med brugerens noegle. Derfor ogsaa en graense i databasen:
-- hoejst 20 bud pr. bruger pr. minut.
create index if not exists bids_bruger_id_oprettet_idx
  on public.bids (bruger_id, oprettet desc);

create or replace function public.bids_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  -- Server-kode (service_role) er ikke omfattet.
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select count(*) into n
  from public.bids
  where bruger_id = new.bruger_id
    and oprettet > now() - interval '1 minute';

  if n >= 20 then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$fn$;
revoke execute on function public.bids_rate_limit() from public, anon, authenticated;

drop trigger if exists bids_rate_limit on public.bids;
create trigger bids_rate_limit
  before insert on public.bids
  for each row execute function public.bids_rate_limit();

-- =============================================================== 2. Taellere ved oprettelse
-- Som 20261001030000, men INSERT nulstiller nu ogsaa visninger, hvis kolonnen findes.
create or replace function public.auctions_beskyt_taellere()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.antal_bud := 0;
    -- visninger findes kun paa testdatabasen.
    if to_jsonb(new) ? 'visninger' then
      new := jsonb_populate_record(new, '{"visninger":0}'::jsonb);
    end if;
    return new;
  end if;

  if new.antal_bud is distinct from old.antal_bud
     or (to_jsonb(new) -> 'visninger') is distinct from (to_jsonb(old) -> 'visninger') then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke execute on function public.auctions_beskyt_taellere() from public, anon, authenticated;

drop trigger if exists auctions_beskyt_taellere on public.auctions;
create trigger auctions_beskyt_taellere
  before insert or update on public.auctions
  for each row execute function public.auctions_beskyt_taellere();
