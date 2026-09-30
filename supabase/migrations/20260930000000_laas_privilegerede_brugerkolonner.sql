-- KRITISK rettelse: users_update_own (init_schema) tillader brugeren at
-- opdatere HELE sin egen raekke - ogsaa rolle, suspenderet osv. En bruger
-- kunne altsaa goere sig selv til 'chef' eller ophaeve sin egen suspension
-- direkte via PostgREST.
--
-- RLS kan ikke begraense kolonner, saa vi laegger en BEFORE UPDATE-trigger,
-- der afviser aendring af privilegerede kolonner, medmindre kaldet kommer
-- fra service_role (admin-panelet bruger createAdminClient) eller fra
-- databasens egne roller (security definer-funktioner ejet af postgres,
-- migrationer, SQL-editoren).
--
-- Brugeren maa fortsat selv aendre: navn, telefon, avatar_url.

create or replace function public.users_beskyt_privilegerede_kolonner()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  -- Service-role (admin-panel, cron) og databasens egne roller maa alt.
  -- Inde i en security definer-funktion er current_user funktionsejeren.
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;

  if new.id                 is distinct from old.id
  or new.email              is distinct from old.email
  or new.rolle              is distinct from old.rolle
  or new.suspenderet        is distinct from old.suspenderet
  or new.suspenderet_aarsag is distinct from old.suspenderet_aarsag
  or new.suspenderet_kl     is distinct from old.suspenderet_kl
  or new.suspenderet_til    is distinct from old.suspenderet_til
  or new.rating             is distinct from old.rating
  or new.oprettet           is distinct from old.oprettet then
    raise exception 'Du maa ikke aendre denne oplysning.'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

-- Triggerfunktioner kaldes af triggeren, ikke af brugere.
revoke execute on function public.users_beskyt_privilegerede_kolonner() from public, anon, authenticated;

drop trigger if exists users_beskyt_privilegerede_kolonner on public.users;
create trigger users_beskyt_privilegerede_kolonner
  before update on public.users
  for each row execute function public.users_beskyt_privilegerede_kolonner();
