-- M1: reports_insert_own lader anmelderen saette status, handled_by,
-- handled_note og handled_at selv (fx oprette en anmeldelse, der ser
-- "behandlet" ud af en medarbejder). Tving startvaerdier for almindelige
-- brugere. service_role (admin-panel) og databasens egne roller maa alt.

create or replace function public.reports_beskyt_ny()
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

  new.status       := 'pending';
  new.handled_by   := null;
  new.handled_note := null;
  new.handled_at   := null;
  new.created_at   := now();

  return new;
end;
$fn$;

revoke execute on function public.reports_beskyt_ny() from public, anon, authenticated;

drop trigger if exists reports_beskyt_ny on public.reports;
create trigger reports_beskyt_ny
  before insert on public.reports
  for each row execute function public.reports_beskyt_ny();
