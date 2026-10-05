-- Rapportarkiv (Filip, 5. oktober 2026): behandlede rapporter (anmeldelser)
-- maa ALDRIG slettes - de gemmes permanent som dokumentation (fx DSA).
--
-- Foer: oprydning_koer() (20261004040000_oprydning.sql) slettede behandlede
-- rapporter 48 timer efter behandling.
-- Nu: efter 48 timer flyttes rapporten fra den aktive liste (reports) til
-- rapporter_arkiv i samme statement/transaktion. Alt andet i oprydningen
-- bevares uaendret: undtagelser (handel/sag i gang), moderation_log-linjen
-- 'rapport_behandlet' og arkiveringen af auktioner.
--
-- moderation_log CHECK beroeres ikke.
-- Idempotent: kan koeres flere gange.

-- ============================================================ 1. rapporter_arkiv

-- Samme kolonner som public.reports (20260825020000_reports.sql,
-- 20260825030000_report_statusser.sql, 20260825040000_report_handled_note.sql)
-- + arkiveret_kl. id er rapportens oprindelige id.
-- Fremmednoegler er 'on delete restrict' (som paamindelser): en auktion eller
-- bruger med arkiverede rapporter kan ikke slettes, saa arkivet aldrig mister
-- raekker via cascade. Ingen CHECK paa category/status, saa nye vaerdier i
-- reports aldrig faar oprydningen til at fejle.
create table if not exists public.rapporter_arkiv (
  id            uuid primary key,
  auction_id    uuid not null references public.auctions(id) on delete restrict,
  reporter_id   uuid not null references public.users(id) on delete restrict,
  category      text not null,
  description   text,
  created_at    timestamptz not null,
  status        text not null,
  handled_by    uuid references public.users(id) on delete restrict,
  handled_at    timestamptz,
  handled_note  text,
  arkiveret_kl  timestamptz not null default now()
);

comment on table public.rapporter_arkiv is
  'Behandlede rapporter (anmeldelser), flyttet hertil fra reports af '
  'oprydning_koer() 48 timer efter behandling. Gemmes permanent (DSA-'
  'dokumentation). Slettes og aendres aldrig. Kun service_role (admin-panel).';

create index if not exists rapporter_arkiv_arkiveret_kl_idx
  on public.rapporter_arkiv (arkiveret_kl desc);
create index if not exists rapporter_arkiv_auction_idx
  on public.rapporter_arkiv (auction_id);
create index if not exists rapporter_arkiv_reporter_idx
  on public.rapporter_arkiv (reporter_id);
create index if not exists rapporter_arkiv_handled_by_idx
  on public.rapporter_arkiv (handled_by);

-- Ingen policies: browseren (anon/authenticated) kan intet. Staff laeser via
-- service-role-klienten. Indsaettes kun af oprydning_koer() (security definer).
alter table public.rapporter_arkiv enable row level security;
revoke all on public.rapporter_arkiv from public, anon, authenticated, service_role;
grant select on public.rapporter_arkiv to service_role;

-- Slettes og aendres aldrig - heller ikke af service_role.
create or replace function public.rapporter_arkiv_uforanderlig()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
begin
  raise exception 'Arkiverede rapporter kan ikke ændres eller slettes.' using errcode = '42501';
end;
$fn$;

revoke execute on function public.rapporter_arkiv_uforanderlig() from public, anon, authenticated;

drop trigger if exists rapporter_arkiv_uforanderlig on public.rapporter_arkiv;
create trigger rapporter_arkiv_uforanderlig
  before update or delete on public.rapporter_arkiv
  for each row execute function public.rapporter_arkiv_uforanderlig();

-- TRUNCATE udloeser ikke raekke-triggere; afvis det separat.
drop trigger if exists rapporter_arkiv_ingen_truncate on public.rapporter_arkiv;
create trigger rapporter_arkiv_ingen_truncate
  before truncate on public.rapporter_arkiv
  for each statement execute function public.rapporter_arkiv_uforanderlig();

-- ============================================================ 2. oprydning_koer

-- Som i 20261004040000_oprydning.sql, men behandlede rapporter flyttes til
-- rapporter_arkiv i stedet for at blive slettet. Returnerer antal arkiverede
-- rapporter og arkiverede auktioner.
create or replace function public.oprydning_koer()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_system     uuid;
  v_rapporter  integer := 0;
  v_arkiveret  integer := 0;
begin
  -- Systembrugeren bruges kun, hvis medarbejderen ikke laengere findes.
  select id into v_system from public.users where id = public.bidhamr_system_id();

  -- A. Rapporter. Laaser raekkerne, saa en samtidig "Genaabn" enten vinder
  -- (og rapporten er ikke laengere behandlet) eller venter.
  -- Kopi til arkivet, log-linje og fjernelse fra reports sker i samme
  -- statement (og dermed samme transaktion): fejler indsaettelsen i arkivet,
  -- fjernes intet.
  with kandidater as (
    select r.id, r.auction_id, r.reporter_id, r.category, r.description,
           r.created_at, r.status, r.handled_by, r.handled_note, r.handled_at,
           coalesce(r.handled_by, v_system) as medarbejder_id,
           a.bruger_id
      from public.reports r
      join public.auctions a on a.id = r.auction_id
     where r.status in ('behandlet', 'fjernet')
       and r.handled_at is not null
       and r.handled_at < now() - interval '48 hours'
       and coalesce(r.handled_by, v_system) is not null
       and not (a.status <> 'aktiv' and public.auktion_afsluttet_kl(a.id) is null)
     order by r.handled_at
     limit 5000
       for update of r skip locked
  ), arkiv as (
    insert into public.rapporter_arkiv
      (id, auction_id, reporter_id, category, description, created_at,
       status, handled_by, handled_at, handled_note, arkiveret_kl)
    select k.id, k.auction_id, k.reporter_id, k.category, k.description,
           k.created_at, k.status, k.handled_by, k.handled_at, k.handled_note,
           now()
      from kandidater k
    on conflict (id) do nothing
    returning id
  ), log as (
    insert into public.moderation_log
      (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag, oprettet_kl)
    select k.medarbejder_id, 'rapport_behandlet', 'auktion', k.auction_id,
           k.bruger_id,
           left('Anmeldelse (' || k.category || ') afsluttet uden handling: '
                || coalesce(nullif(btrim(k.handled_note), ''), '(ingen note)'), 2000),
           k.handled_at
      from kandidater k
     where k.status = 'behandlet'
    returning 1
  )
  -- Fjernes kun fra reports, naar raekken ligger i arkivet: enten indsat nu
  -- eller (ved konflikt) allerede arkiveret med samme id.
  delete from public.reports r
   using kandidater k
   where r.id = k.id
     and (k.id in (select id from arkiv)
          or exists (select 1 from public.rapporter_arkiv x where x.id = k.id));
  get diagnostics v_rapporter = row_count;

  -- B. Arkivering af afsluttede auktioner. Kun visning - intet slettes.
  update public.auctions a
     set arkiveret_kl = now()
   where a.id in (
           select x.id
             from public.auctions x
            where x.arkiveret_kl is null
              and x.status <> 'aktiv'
              and x.afsluttet_kl < now() - interval '48 hours'
              and public.auktion_afsluttet_kl(x.id) < now() - interval '48 hours'
            order by x.afsluttet_kl
            limit 2000)
     and a.arkiveret_kl is null
     and a.status <> 'aktiv';
  get diagnostics v_arkiveret = row_count;

  return jsonb_build_object(
    'rapporter_arkiveret', v_rapporter,
    'auktioner_arkiveret', v_arkiveret);
end;
$fn$;

revoke all on function public.oprydning_koer() from public, anon, authenticated;
grant execute on function public.oprydning_koer() to service_role;

comment on function public.oprydning_koer() is
  'Koeres af pg_cron (job ''oprydning'') hver time. Flytter behandlede '
  'rapporter til rapporter_arkiv 48 timer efter behandling (slettes aldrig) '
  'og arkiverer afsluttede auktioner 48 timer efter afsluttet handel.';
