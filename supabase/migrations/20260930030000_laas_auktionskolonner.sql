-- KRITISK rettelse: auctions_update_own (init_schema) lader ejeren opdatere
-- HELE sin auktion via PostgREST - ogsaa vinder_id, status, nuværende_bud,
-- slutter_kl (fx forkorte/forlaenge efter bud), bruger_id og oprettet.
-- auctions_insert_own lader desuden ejeren oprette en auktion med
-- vilkaarlig status/vinder/bud/skjult.
--
-- RLS kan ikke begraense kolonner, saa vi laegger BEFORE-triggere (samme
-- moenster som 20260930000000_laas_privilegerede_brugerkolonner.sql).
-- service_role (admin-panel, cron) og databasens egne roller (security
-- definer-funktioner som handle_new_bid og afslut_udloebne_auktioner, ejet
-- af postgres) maa fortsat alt.
--
-- Brugeren maa kun aendre indholdsfelter (titel, beskrivelse, billeder,
-- kategori, postnummer, lokation, lat, lng, forsendelse_mulig) - og kun
-- mens auktionen er aktiv og der endnu ikke er afgivet bud.
--
-- Anti-sniping (forlaengelse af slutter_kl) sker allerede i handle_new_bid
-- (20260623000000). Klienten (BidPanel) opdaterede tidligere slutter_kl selv
-- oven i det; det er fjernet i koden og afvises nu her.

-- ---------------------------------------------------------
-- UPDATE
-- ---------------------------------------------------------
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
    raise exception 'Du maa ikke aendre denne oplysning.'
      using errcode = '42501';
  end if;

  -- Indholdsfelter: kun paa en aktiv auktion uden bud, saa budgivere ikke
  -- faar aendret varen under sig.
  if old.status <> 'aktiv'
     or old."nuværende_bud" is not null
     or exists (select 1 from public.bids b where b.auktion_id = old.id) then
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

-- ---------------------------------------------------------
-- INSERT: tving systemfelter til startvaerdier
-- ---------------------------------------------------------
create or replace function public.auctions_beskyt_ny()
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

  new.status          := 'aktiv';
  new.vinder_id       := null;
  new."nuværende_bud" := null;
  new.skjult          := false;
  new.oprettet        := now();

  if new.slutter_kl is null or new.slutter_kl <= now() then
    raise exception 'Sluttidspunktet skal ligge i fremtiden.'
      using errcode = '22023';
  end if;

  if new.slutter_kl > now() + interval '30 days' then
    raise exception 'En auktion kan hoejst vare 30 dage.'
      using errcode = '22023';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.auctions_beskyt_ny() from public, anon, authenticated;

drop trigger if exists auctions_beskyt_ny on public.auctions;
create trigger auctions_beskyt_ny
  before insert on public.auctions
  for each row execute function public.auctions_beskyt_ny();

-- ---------------------------------------------------------
-- DELETE: handelsdata maa ikke slettes (bids cascader ellers vaek sammen
-- med auktionen). Policyen fjernes helt; ejeren annullerer i stedet via
-- public.annuller_egen_auktion (20260930080000).
-- ---------------------------------------------------------
drop policy if exists "auctions_delete_own" on public.auctions;
