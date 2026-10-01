-- Opfoelgning paa sikkerhedsrettelserne (reviewer 2026-10-01).
--
-- auctions_beskyt_kolonner (20260930030000) er security invoker og tjekker
-- "findes der bud paa auktionen?" direkte i bids. Efter
-- 20261001035000_privatliv_bud_foelgere.sql ser saelgeren kun sine egne bud,
-- saa tjekket ville altid give falsk, og saelgeren kunne redigere varen,
-- efter der er budt. Tjekket flyttes til en security definer-hjaelper, der
-- kun svarer ja/nej og ikke afsloerer, hvem der har budt.
--
-- Virker baade med og uden 035000. Idempotent.

create or replace function public.auktion_har_bud(p_auktion_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.bids b where b.auktion_id = p_auktion_id);
$fn$;
revoke execute on function public.auktion_har_bud(uuid) from public, anon;
grant execute on function public.auktion_har_bud(uuid) to authenticated, service_role;

-- Uaendret logik fra 20260930030000; kun bud-tjekket bruger hjaelperen.
create or replace function public.auctions_beskyt_kolonner()
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

  -- Felter brugeren aldrig maa aendre.
  if new.id              is distinct from old.id
  or new.bruger_id       is distinct from old.bruger_id
  or new.status          is distinct from old.status
  or new.vinder_id       is distinct from old.vinder_id
  or new.slutter_kl      is distinct from old.slutter_kl
  or new."nuværende_bud" is distinct from old."nuværende_bud"
  or new.startpris       is distinct from old.startpris
  or new.skjult          is distinct from old.skjult
  or new.oprettet        is distinct from old.oprettet then
    raise exception 'Du må ikke ændre denne oplysning.'
      using errcode = '42501';
  end if;

  -- Indholdsfelter: kun paa en aktiv auktion uden bud, saa budgivere ikke
  -- faar aendret varen under sig.
  if old.status <> 'aktiv'
     or old."nuværende_bud" is not null
     or public.auktion_har_bud(old.id) then
    raise exception 'Auktionen kan ikke redigeres, efter der er budt.'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.auctions_beskyt_kolonner() from public, anon, authenticated;

drop trigger if exists auctions_beskyt_kolonner on public.auctions;
create trigger auctions_beskyt_kolonner
  before update on public.auctions
  for each row execute function public.auctions_beskyt_kolonner();
