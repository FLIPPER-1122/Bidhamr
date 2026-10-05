-- Besoegsstatistik uden cookies (ROADMAP fase 3: "SEO og besoegsstatistik
-- (cookie-venlig)").
--
-- Kun et taeller pr. dag og side. Ingen cookies, intet bruger-id, ingen IP,
-- ingen user agent, ingen query-strenge. Stien normaliseres paa serveren
-- (src/lib/statistikSti.ts) til en fast liste af sidetyper, fx
-- '/auktion/[id]' - id'er gemmes aldrig.
--
-- Skrives af /api/statistik (service-role) via registrer_sidevisning() og
-- laeses af /admin/drift via besoegsstatistik(). Begge kun service_role.
-- Idempotent: if not exists / create or replace / drop ... if exists.

-- ============================================================ Tabel

create table if not exists public.sidevisninger (
  dag   date   not null,
  sti   text   not null,
  antal bigint not null default 0,
  primary key (dag, sti),
  constraint sidevisninger_sti_check check (char_length(sti) between 1 and 100 and left(sti, 1) = '/'),
  constraint sidevisninger_antal_check check (antal >= 0)
);

comment on table public.sidevisninger is
  'Cookiefri besoegsstatistik: antal sidevisninger pr. dag (dansk tid) og '
  'normaliseret sti (uden id''er og query). Ingen persondata. Kun service_role.';

alter table public.sidevisninger enable row level security;
revoke all on public.sidevisninger from public, anon, authenticated;
grant all on public.sidevisninger to service_role;
-- Ingen policies: browseren kan hverken laese eller skrive.

-- ============================================================ Skriv

-- Taeller en visning op for dagen i dag (Europe/Copenhagen). INTERN: kun
-- service_role (kaldes fra /api/statistik efter normalisering og rate-limit).
create or replace function public.registrer_sidevisning(p_sti text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_sti is null or char_length(p_sti) not between 1 and 100 or left(p_sti, 1) <> '/' then
    return;
  end if;

  insert into public.sidevisninger as s (dag, sti, antal)
  values ((now() at time zone 'Europe/Copenhagen')::date, p_sti, 1)
  on conflict (dag, sti) do update set antal = s.antal + 1;
end;
$fn$;

revoke execute on function public.registrer_sidevisning(text) from public, anon, authenticated;
grant execute on function public.registrer_sidevisning(text) to service_role;

-- ============================================================ Laes

-- Overblik til /admin/drift: besoeg i dag / 7 / 30 dage og top-sider for de
-- sidste p_dage dage (1-90). INTERN: kun service_role (siden tjekker rollen).
create or replace function public.besoegsstatistik(p_dage int default 30, p_top int default 15)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with idag as (
    select (now() at time zone 'Europe/Copenhagen')::date as d
  ),
  graenser as (
    select greatest(1, least(coalesce(p_dage, 30), 90)) as dage,
           greatest(1, least(coalesce(p_top, 15), 50)) as top
  )
  select jsonb_build_object(
    'i_dag',  coalesce((select sum(antal) from public.sidevisninger, idag where dag = idag.d), 0),
    'dage_7', coalesce((select sum(antal) from public.sidevisninger, idag where dag > idag.d - 7), 0),
    'dage_30', coalesce((select sum(antal) from public.sidevisninger, idag where dag > idag.d - 30), 0),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object('sti', t.sti, 'antal', t.antal) order by t.antal desc, t.sti)
        from (
          select s.sti, sum(s.antal) as antal
            from public.sidevisninger s, idag, graenser g
           where s.dag > idag.d - g.dage
           group by s.sti
           order by sum(s.antal) desc, s.sti
           limit (select top from graenser)
        ) t
    ), '[]'::jsonb),
    'pr_dag', coalesce((
      select jsonb_agg(jsonb_build_object('dag', x.dag, 'antal', x.antal) order by x.dag)
        from (
          select s.dag, sum(s.antal) as antal
            from public.sidevisninger s, idag, graenser g
           where s.dag > idag.d - g.dage
           group by s.dag
        ) x
    ), '[]'::jsonb)
  );
$fn$;

revoke execute on function public.besoegsstatistik(int, int) from public, anon, authenticated;
grant execute on function public.besoegsstatistik(int, int) to service_role;
