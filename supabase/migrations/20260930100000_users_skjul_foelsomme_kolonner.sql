-- users_select_all (init_schema) er "using (true)" og gav alle - ogsaa anon -
-- adgang til email, telefon, rolle og suspensionsfelter paa alle brugere.
--
-- RLS kan ikke begraense kolonner, saa vi bruger kolonne-grants: anon og
-- authenticated maa kun laese de offentlige profilfelter. Policyen bliver
-- staaende (raekkerne er fortsat offentlige profiler).
--
-- Egne foelsomme felter hentes via min_profil()/min_rolle() (security
-- definer, udleder brugeren af auth.uid()). Admin-panel, cron og
-- mailudsendelse bruger service-role, som ikke er beroert.
--
-- Triggere, der laeser NEW/OLD, og security definer-funktioner (er_staff,
-- handle_new_bid m.fl., ejet af postgres) er ikke beroert.
--
-- NB: kolonner, der findes i produktion uden at staa i en migration, bliver
-- ogsaa skjult (sikker default). Skal en af dem vaere offentlig, tilfoejes den
-- til grant-listen herunder.

revoke select on table public.users from anon, authenticated;
grant select (id, navn, avatar_url, rating, oprettet)
  on table public.users to anon, authenticated;

-- ---------------------------------------------------------
-- Egen profil: foelsomme felter for den kaldende bruger.
-- ---------------------------------------------------------
create or replace function public.min_profil()
returns table (
  email text,
  telefon text,
  rolle text,
  suspenderet boolean,
  suspenderet_aarsag text,
  suspenderet_kl timestamptz,
  suspenderet_til timestamptz
)
language sql
stable
security definer
set search_path = public
as $fn$
  select u.email, u.telefon, u.rolle, u.suspenderet, u.suspenderet_aarsag,
         u.suspenderet_kl, u.suspenderet_til
    from public.users u
   where u.id = auth.uid();
$fn$;

revoke execute on function public.min_profil() from public, anon;
grant execute on function public.min_profil() to authenticated;

-- ---------------------------------------------------------
-- Egen rolle (middleware, header, admin-adgang).
-- ---------------------------------------------------------
create or replace function public.min_rolle()
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select u.rolle from public.users u where u.id = auth.uid();
$fn$;

revoke execute on function public.min_rolle() from public, anon;
grant execute on function public.min_rolle() to authenticated;
