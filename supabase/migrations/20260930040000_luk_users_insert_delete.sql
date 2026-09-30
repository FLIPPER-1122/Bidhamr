-- K1 KRITISK: users_insert_own og users_delete_own (init_schema) lod en
-- bruger slette sin egen profilraekke og indsaette en ny med rolle='chef'.
-- Sletningen cascader desuden handelsdata (auktioner, bud, handler, ratings),
-- hvilket bryder bogfoeringsloven/DAC7.
--
-- Raekken i public.users oprettes af on_auth_user_created -> handle_new_user
-- (20260622000000), som er security definer ejet af postgres og derfor ikke
-- har brug for en insert-policy. Brugere maa aldrig selv oprette/slette.

drop policy if exists "users_insert_own" on public.users;
drop policy if exists "users_delete_own" on public.users;

-- Ekstra vaern: hvis en insert alligevel naar frem fra en almindelig rolle
-- (fx en fremtidig policy), tvinges privilegerede kolonner til startvaerdier.
create or replace function public.users_beskyt_ny()
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

  new.rolle              := 'bruger';
  new.suspenderet        := false;
  new.suspenderet_aarsag := null;
  new.suspenderet_kl     := null;
  new.suspenderet_til    := null;
  new.rating             := 0;
  new.oprettet           := now();

  return new;
end;
$fn$;

revoke execute on function public.users_beskyt_ny() from public, anon, authenticated;

drop trigger if exists users_beskyt_ny on public.users;
create trigger users_beskyt_ny
  before insert on public.users
  for each row execute function public.users_beskyt_ny();
