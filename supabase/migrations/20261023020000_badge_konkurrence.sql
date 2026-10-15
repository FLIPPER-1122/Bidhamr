-- "Populær sælger"-badge og den månedlige gavekort-konkurrence
-- (Filip, 13. okt. 2026 - ROADMAP-BESLUTNINGER, "Nye funktioner").
--
-- Et GENNEMFØRT SALG (fælles for badge og konkurrence) er en betaling, hvor
--   - køberen har betalt (status 'betalt'), og pengene er frigivet til
--     sælgeren (frigivet_kl - bekræftelse, 48 timer uden sag, afhentning med
--     kode, afgjort sag + ankefrist eller admin-frigivelse),
--   - handlen ikke er annulleret,
--   - intet er refunderet eller bestilt refunderet - hverken helt eller
--     delvist (refusion_anmodet_kl, refunderet_kl, refusion_oere,
--     "BidHamr dækker"),
--   - der ikke er en åben eller tabt indsigelse fra køberens bank
--     (vundne/lukkede indsigelser tæller som gennemført),
--   - sælgeren ikke er BidHamrs systemkonto,
--   - buddet er mindst gennemfoerte_salg_min_bud_oere() = 5.000 øre (50 kr.)
--     (regel mod falske salg, Filip 15. okt. 2026 - gælder også boost).
-- Tallene regnes altid ud fra betalingerne - der gemmes ingen kopi, der kan
-- blive forkert. Først når chefen trækker en vinder, fastfryses listen.
--
-- BADGE: mindst 50 gennemførte salg i alt (populaer_saelger_graense()) til
-- mindst 20 forskellige købere (populaer_saelger_min_koebere()).
-- Status er offentlig (anon + authenticated), men kun som ja/nej - ikke
-- antallet. Lukkede og slettede konti får det ikke.
--
-- KONKURRENCE: én lod pr. gennemført salg i den måned (dansk tid), hvor
-- pengene blev frigivet til sælgeren - men højst
-- konkurrence_max_lod_pr_koeber() = 1 lod pr. køber pr. sælger pr. måned
-- (Filip 15. okt. 2026). Desuden:
--   - kun private konti (konto_type 'privat'); firmakonti er ikke med,
--   - staff (rolle <> 'bruger', også 'saelger') er ikke med
--     (konkurrencebetingelserne 2.2),
--   - konti på pause (users.suspenderet, også midlertidigt), frosne konti
--     (betalingsprofiler.saelger_frosset_kl / udbetaling_frosset_kl /
--     salg_frosset_kl), lukkede og slettede konti er ikke med,
--   - en handel med åben sag (aaben/afventer_retur), en sag, hvor køberen
--     fik medhold, en sag, hvis ankefrist løber, en anke, der venter, eller
--     staffs "sag"-markering på handlen (trades.sag_aaben) giver ikke lod.
-- Pause/frysning og åbne sager vurderes, når listen ses eller trækkes
-- (betingelserne: "når lodtrækningen sker").
--
-- LODTRÆKNINGEN (kun chef, Admin → Konkurrence):
--   - Kan først ske, når måneden er slut (dansk tid), og kun for måneder fra
--     og med konkurrence_start_maaned() = '2026-11' (Filip 15. okt. 2026;
--     null = der kan ikke trækkes). Én trækning pr. måned; et
--     dobbeltklik giver den samme trækning tilbage.
--   - Listen fastfryses i konkurrence_traekning_lod: deltagerne sorteres efter
--     bruger-id, og hver får et sammenhængende lod-interval (1..N).
--     liste_hash = SHA-256 af "YYYY-MM\n<bruger_id>:<antal>\n..." (sorteret).
--   - Seed = 32 tilfældige bytes, lavet AF DATABASEN i samme transaktion som
--     trækningen (extensions.gen_random_bytes - pgcrypto; findes den ikke:
--     SHA-256 af to gen_random_uuid(), som også bruger Postgres' stærke
--     tilfældighed). Hverken chefen eller serveren kan vælge seedet.
--   - Vinderlod = (SHA-256(seed || liste_hash) som 256-bit heltal) mod N + 1.
--     Hvert lod har samme chance (skævheden er under N/2^256), så chancen er
--     proportional med antal lod. Alt kan efterregnes ud fra den gemte liste,
--     hash og seed (konkurrence_lod_nr; samme regel i
--     src/lib/konkurrence/regler.ts).
--   - Ny vinder: grund 'svarer_ikke' (først når svarfristen på
--     konkurrence_svarfrist_dage() = 14 dage efter trækningen er udløbet) eller
--     'opfylder_ikke', plus valgfri fritekst. Højst
--     konkurrence_max_nye_vindere() = 1 ny vinder pr. måned (Filip 15. okt.
--     2026), derefter 'loft_naaet'. Den gamle trækning markeres
--     som erstattet (aldrig slettet), og der trækkes på samme fastfrosne liste
--     uden de tidligere vindere, med nyt seed. Dobbeltklik giver ikke to nye
--     vindere.
--   - Trækningerne og listerne kan ikke ændres, slettes eller truncates
--     (triggere) og kan kun læses af service role (chefen gennem serveren).
--
-- RETTIGHEDER: alle admin-funktioner er kun service role og tjekker, at
-- p_chef er chef (serveren tjekker det også). Sælgeren ser kun sit eget
-- antal lod (mine_konkurrence_lod, auth.uid()). Badge er offentligt.
-- Alle security definer-funktioner har search_path = ''.
--
-- Ændrer INGEN eksisterende funktioner eller tabeller (kun nye indeks på
-- betalinger). Idempotent (kan køres igen). Én transaktion: filen køres som
-- én samlet forespørgsel (SQL Editor, db query og migrationsværktøjet), så
-- en fejl ruller alt tilbage.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.betalinger') is null or to_regclass('public.trades') is null
     or to_regclass('public.sager') is null or to_regclass('public.sag_anker') is null
     or to_regclass('public.betalingsprofiler') is null then
    raise exception 'Forudsætning mangler: betalinger, sager, anke og betalingsprofiler skal være kørt først';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'betalingsprofiler'
                    and column_name = 'udbetaling_frosset_kl') then
    raise exception 'Forudsætning mangler: betalingsprofiler.udbetaling_frosset_kl (20261019010000_pengesikkerhed.sql)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'betalinger'
                    and column_name = 'bidhamr_daekker_kl') then
    raise exception 'Forudsætning mangler: betalinger.bidhamr_daekker_kl (20261019010000_pengesikkerhed.sql)';
  end if;
  if to_regprocedure('public.bidhamr_system_id()') is null then
    raise exception 'Forudsætning mangler: public.bidhamr_system_id()';
  end if;
end $do$;

-- ===========================================================================
-- 1. Indeks: frigivne betalinger pr. sælger og pr. tidspunkt
-- ===========================================================================
create index if not exists betalinger_frigivet_saelger
  on public.betalinger (seller_id, frigivet_kl) where status = 'betalt' and frigivet_kl is not null;
create index if not exists betalinger_frigivet_kl
  on public.betalinger (frigivet_kl) where status = 'betalt' and frigivet_kl is not null;

-- ===========================================================================
-- 2. Gennemførte salg (internt - kun service role)
-- ===========================================================================

-- Regler mod falske salg (Filip, 15. okt. 2026). Fælles for badge,
-- konkurrence og boost: brug disse konstanter, ikke tallene.
create or replace function public.gennemfoerte_salg_min_bud_oere()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 5000::bigint $$;
revoke all on function public.gennemfoerte_salg_min_bud_oere() from public;
grant execute on function public.gennemfoerte_salg_min_bud_oere() to anon, authenticated, service_role;

-- Alle gennemførte salg, evt. afgrænset til et tidsrum for frigivelsen
-- [p_fra, p_til) og/eller én sælger. Med køberen, så reglerne om
-- forskellige købere kan regnes. (En tidligere udgave på testdatabasen havde
-- ingen buyer_id - returtypen kan ikke ændres med create or replace.)
drop function if exists public.gennemfoerte_salg(timestamptz, timestamptz, uuid);
create or replace function public.gennemfoerte_salg(
  p_fra timestamptz default null, p_til timestamptz default null, p_saelger uuid default null)
returns table (betaling_id uuid, trade_id uuid, seller_id uuid, buyer_id uuid, frigivet_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select b.id, b.trade_id, b.seller_id, b.buyer_id, b.frigivet_kl
    from public.betalinger b
    left join public.trades t on t.id = b.trade_id
   where b.status = 'betalt'
     and b.frigivet_kl is not null
     and (p_fra is null or b.frigivet_kl >= p_fra)
     and (p_til is null or b.frigivet_kl < p_til)
     and (p_saelger is null or b.seller_id = p_saelger)
     and b.seller_id <> public.bidhamr_system_id()
     and b.bud_oere >= public.gennemfoerte_salg_min_bud_oere()
     and b.annulleret_kl is null
     and b.refusion_anmodet_kl is null
     and b.refunderet_kl is null
     and coalesce(b.refusion_oere, 0) = 0
     and b.bidhamr_daekker_kl is null
     and b.indsigelse_tabt_kl is null
     and (b.indsigelse_kl is null
          or coalesce(b.indsigelse_status, '') in ('won', 'warning_closed', 'prevented'))
     and coalesce(t.status, '') <> 'annulleret';
$$;
revoke all on function public.gennemfoerte_salg(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.gennemfoerte_salg(timestamptz, timestamptz, uuid) to service_role;

-- ===========================================================================
-- 3. Badge: "Populær sælger" (offentligt, kun ja/nej)
-- ===========================================================================
create or replace function public.populaer_saelger_graense()
returns integer
language sql
immutable
set search_path = ''
as $$ select 50 $$;
revoke all on function public.populaer_saelger_graense() from public;
grant execute on function public.populaer_saelger_graense() to anon, authenticated, service_role;

-- Salgene skal være til mindst så mange forskellige købere (Filip, 15. okt. 2026).
create or replace function public.populaer_saelger_min_koebere()
returns integer
language sql
immutable
set search_path = ''
as $$ select 20 $$;
revoke all on function public.populaer_saelger_min_koebere() from public;
grant execute on function public.populaer_saelger_min_koebere() to anon, authenticated, service_role;

create or replace function public.populaer_saelger(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bruger is not null
     and exists (select 1 from public.users u
                  where u.id = p_bruger and u.konto_lukket_kl is null and u.konto_slettet_kl is null)
     and (select count(*) >= public.populaer_saelger_graense()
                 and count(distinct g.buyer_id) >= public.populaer_saelger_min_koebere()
            from public.gennemfoerte_salg(null, null, p_bruger) g);
$$;
revoke all on function public.populaer_saelger(uuid) from public;
grant execute on function public.populaer_saelger(uuid) to anon, authenticated, service_role;

-- Til auktionskort: hvilke af disse sælgere har badget? Højst 200 id'er.
create or replace function public.populaere_saelgere(p_brugere uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
    from (select distinct x.id from unnest((coalesce(p_brugere, '{}'::uuid[]))[1:200]) as x(id)
           where x.id is not null) d
   where public.populaer_saelger(d.id);
$$;
revoke all on function public.populaere_saelgere(uuid[]) from public;
grant execute on function public.populaere_saelgere(uuid[]) to anon, authenticated, service_role;

-- ===========================================================================
-- 4. Konkurrencen: hvem er med, og hvor mange lod
-- ===========================================================================

-- Måneden 'YYYY-MM' som [fra, til) i dansk tid. Null ved ugyldig måned.
create or replace function public.konkurrence_maaned_interval(p_maaned text, out fra timestamptz, out til timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_aar int;
  v_md  int;
begin
  if p_maaned is null or p_maaned !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    return;
  end if;
  v_aar := substr(p_maaned, 1, 4)::int;
  v_md  := substr(p_maaned, 6, 2)::int;
  fra := make_timestamptz(v_aar, v_md, 1, 0, 0, 0, 'Europe/Copenhagen');
  til := case when v_md = 12 then make_timestamptz(v_aar + 1, 1, 1, 0, 0, 0, 'Europe/Copenhagen')
              else make_timestamptz(v_aar, v_md + 1, 1, 0, 0, 0, 'Europe/Copenhagen') end;
end $$;
revoke all on function public.konkurrence_maaned_interval(text) from public, anon, authenticated;
grant execute on function public.konkurrence_maaned_interval(text) to service_role;

-- Den aktuelle måned i dansk tid ('YYYY-MM').
create or replace function public.konkurrence_denne_maaned()
returns text
language sql
stable
set search_path = ''
as $$ select to_char(now() at time zone 'Europe/Copenhagen', 'YYYY-MM') $$;
revoke all on function public.konkurrence_denne_maaned() from public, anon;
grant execute on function public.konkurrence_denne_maaned() to authenticated, service_role;

-- Hvorfor er en konto ikke med? null = med.
--   'erhverv' firmakonto, 'staff' medarbejder/admin/chef/sælger,
--   'lukket' lukket eller slettet, 'pause' suspenderet, 'frosset' frosset.
create or replace function public.konkurrence_udelukket_grund(p_bruger uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when u.id is null then 'lukket'
           when coalesce(u.konto_type, 'privat') <> 'privat' then 'erhverv'
           when coalesce(u.rolle, 'bruger') <> 'bruger' then 'staff'
           when u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then 'lukket'
           when coalesce(u.suspenderet, false)
                and (u.suspenderet_til is null or u.suspenderet_til > now()) then 'pause'
           when exists (select 1 from public.betalingsprofiler bp
                         where bp.user_id = u.id
                           and (bp.saelger_frosset_kl is not null
                                or bp.udbetaling_frosset_kl is not null
                                or bp.salg_frosset_kl is not null)) then 'frosset'
         end
    from (select p_bruger as id) x
    left join public.users u on u.id = x.id;
$$;
revoke all on function public.konkurrence_udelukket_grund(uuid) from public, anon, authenticated;
grant execute on function public.konkurrence_udelukket_grund(uuid) to service_role;

-- Højst så mange lod pr. køber pr. sælger pr. måned (Filip, 15. okt. 2026).
create or replace function public.konkurrence_max_lod_pr_koeber()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1 $$;
revoke all on function public.konkurrence_max_lod_pr_koeber() from public, anon, authenticated;
grant execute on function public.konkurrence_max_lod_pr_koeber() to service_role;

-- Lod pr. sælger for salg frigivet i [p_fra, p_til) (højst
-- konkurrence_max_lod_pr_koeber() pr. køber). Medtager også udelukkede
-- sælgere (grund er ikke null) - de deltager ikke.
create or replace function public.konkurrence_lod_beregn(p_fra timestamptz, p_til timestamptz, p_bruger uuid default null)
returns table (bruger_id uuid, antal_lod integer, grund text)
language sql
stable
security definer
set search_path = ''
as $$
  with pr_koeber as (
    select g.seller_id, least(count(*), public.konkurrence_max_lod_pr_koeber())::integer as antal
      from public.gennemfoerte_salg(p_fra, p_til, p_bruger) g
     where not exists (select 1 from public.trades t
                        where t.id = g.trade_id and coalesce(t.sag_aaben, false))
       and not exists (select 1 from public.sager sa
                        where sa.trade_id = g.trade_id
                          and (sa.status in ('aaben', 'afventer_retur', 'afgjort_koeber')
                               or (sa.afviklet_kl is null and sa.penge_flyttes_efter_kl > now())))
       and not exists (select 1 from public.sag_anker an
                        where an.trade_id = g.trade_id and an.status = 'afventer')
     group by g.seller_id, g.buyer_id
  ), s as (
    select k.seller_id, sum(k.antal)::integer as antal from pr_koeber k group by k.seller_id
  )
  select s.seller_id, s.antal, public.konkurrence_udelukket_grund(s.seller_id)
    from s;
$$;
revoke all on function public.konkurrence_lod_beregn(timestamptz, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.konkurrence_lod_beregn(timestamptz, timestamptz, uuid) to service_role;

-- Sælgerens egne lod i den aktuelle måned (Min konto og appen). Kun egne tal.
--   { maaned: 'YYYY-MM', antal_lod, deltager, grund: null | 'erhverv' | 'staff' | 'konto' }
--   'konto' = pause, frosset eller lukket (grunden vises ikke).
create or replace function public.mine_konkurrence_lod()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_md    text := public.konkurrence_denne_maaned();
  v_fra   timestamptz;
  v_til   timestamptz;
  v_grund text;
  v_antal integer;
begin
  if v_uid is null then
    return null;
  end if;
  select i.fra, i.til into v_fra, v_til from public.konkurrence_maaned_interval(v_md) i;
  v_grund := public.konkurrence_udelukket_grund(v_uid);
  select coalesce(sum(l.antal_lod), 0)::integer into v_antal
    from public.konkurrence_lod_beregn(v_fra, v_til, v_uid) l;
  return jsonb_build_object(
    'maaned', v_md,
    'antal_lod', case when v_grund is null then v_antal else 0 end,
    'deltager', v_grund is null,
    'grund', case when v_grund is null then null
                  when v_grund in ('erhverv', 'staff') then v_grund
                  else 'konto' end);
end $$;
revoke all on function public.mine_konkurrence_lod() from public, anon;
grant execute on function public.mine_konkurrence_lod() to authenticated, service_role;

-- ===========================================================================
-- 5. Lodtrækningen: fastfrosne lister og log
-- ===========================================================================
-- Konstanter (Filip, 15. okt. 2026 - ROADMAP-BESLUTNINGER, "Nye funktioner"):
-- første måned med konkurrence er november 2026, højst 1 ny vinder pr.
-- måned og 14 dages svarfrist (konkurrencebetingelserne 7.2-7.3).
-- konkurrence_start_maaned() = null betyder, at der slet ikke kan trækkes.
create or replace function public.konkurrence_start_maaned()
returns text
language sql
immutable
set search_path = ''
as $$ select '2026-11'::text $$;
revoke all on function public.konkurrence_start_maaned() from public, anon, authenticated;
grant execute on function public.konkurrence_start_maaned() to service_role;

create or replace function public.konkurrence_max_nye_vindere()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1 $$;
revoke all on function public.konkurrence_max_nye_vindere() from public, anon, authenticated;
grant execute on function public.konkurrence_max_nye_vindere() to service_role;

create or replace function public.konkurrence_svarfrist_dage()
returns integer
language sql
immutable
set search_path = ''
as $$ select 14 $$;
revoke all on function public.konkurrence_svarfrist_dage() from public, anon, authenticated;
grant execute on function public.konkurrence_svarfrist_dage() to service_role;

create table if not exists public.konkurrence_traekninger (
  id               uuid primary key default gen_random_uuid(),
  maaned           text not null,
  nr               integer not null,
  trukket_kl       timestamptz not null default now(),
  trukket_af       uuid not null references public.users(id) on delete restrict,
  antal_deltagere  integer not null,
  antal_lod        integer not null,
  liste_hash       text not null,
  seed             text not null,
  vinder_lod       integer not null,
  vinder_id        uuid not null references public.users(id) on delete restrict,
  grund            text,
  begrundelse      text,
  erstatter_id     uuid references public.konkurrence_traekninger(id) on delete restrict,
  erstattet_kl     timestamptz,
  erstattet_af     uuid references public.users(id) on delete restrict,
  constraint konkurrence_traekninger_maaned_check check (maaned ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  constraint konkurrence_traekninger_nr_check check (nr >= 1),
  constraint konkurrence_traekninger_antal_check check (antal_deltagere >= 1 and antal_lod >= antal_deltagere),
  constraint konkurrence_traekninger_hash_check check (liste_hash ~ '^[0-9a-f]{64}$' and seed ~ '^[0-9a-f]{64}$'),
  constraint konkurrence_traekninger_lod_check check (vinder_lod between 1 and antal_lod),
  constraint konkurrence_traekninger_erstattet_check check ((erstattet_kl is null) = (erstattet_af is null)),
  constraint konkurrence_traekninger_maaned_nr unique (maaned, nr)
);
-- (En tidligere udgave på testdatabasen havde ingen grund-kolonne og krævede
-- fritekst på mindst 10 tegn.)
alter table public.konkurrence_traekninger add column if not exists grund text;
alter table public.konkurrence_traekninger drop constraint if exists konkurrence_traekninger_ny_check;
alter table public.konkurrence_traekninger add constraint konkurrence_traekninger_ny_check check (
  (nr = 1 and erstatter_id is null and grund is null and begrundelse is null)
  or (nr > 1 and erstatter_id is not null and grund in ('svarer_ikke', 'opfylder_ikke')
      and char_length(coalesce(begrundelse, '')) <= 2000));
-- Højst én gældende (ikke erstattet) trækning pr. måned.
create unique index if not exists konkurrence_traekninger_gaeldende
  on public.konkurrence_traekninger (maaned) where erstattet_kl is null;

create table if not exists public.konkurrence_traekning_lod (
  traekning_id  uuid not null,
  bruger_id     uuid not null references public.users(id) on delete restrict,
  antal_lod     integer not null,
  foerste_lod   integer not null,
  sidste_lod    integer not null,
  primary key (traekning_id, bruger_id),
  constraint konkurrence_traekning_lod_check check (
    antal_lod >= 1 and foerste_lod >= 1 and sidste_lod = foerste_lod + antal_lod - 1)
);
-- Listen indsættes før selve trækningen (i samme transaktion): fremmednøglen
-- tjekkes først ved commit.
do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'konkurrence_traekning_lod_traekning_fk'
                    and conrelid = 'public.konkurrence_traekning_lod'::regclass) then
    alter table public.konkurrence_traekning_lod
      add constraint konkurrence_traekning_lod_traekning_fk
      foreign key (traekning_id) references public.konkurrence_traekninger(id)
      on delete restrict deferrable initially deferred;
  end if;
end $do$;

alter table public.konkurrence_traekninger enable row level security;
alter table public.konkurrence_traekning_lod enable row level security;
revoke all on table public.konkurrence_traekninger from public, anon, authenticated, service_role;
revoke all on table public.konkurrence_traekning_lod from public, anon, authenticated, service_role;
-- Service role (serveren) må kun læse. Alt skrives af funktionerne nedenfor.
grant select on table public.konkurrence_traekninger to service_role;
grant select on table public.konkurrence_traekning_lod to service_role;

comment on table public.konkurrence_traekninger is
  'Log over lodtrækninger i den månedlige konkurrence (kun chef). Kan ikke ændres, slettes eller truncates - kun markeres som erstattet, når en ny vinder trækkes. Se 20261023020000_badge_konkurrence.sql.';
comment on table public.konkurrence_traekning_lod is
  'Den fastfrosne deltagerliste for hver trækning: lod-interval pr. sælger. Kan ikke ændres, slettes eller truncates.';

-- Trækninger kan ikke slettes, og kun "erstattet" kan sættes (én gang).
create or replace function public.konkurrence_traekning_laas()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'En lodtrækning kan ikke slettes' using errcode = '42501';
  end if;
  if old.erstattet_kl is not null
     or new.erstattet_kl is null
     or (to_jsonb(new) - 'erstattet_kl' - 'erstattet_af') is distinct from (to_jsonb(old) - 'erstattet_kl' - 'erstattet_af') then
    raise exception 'En lodtrækning kan ikke ændres' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.konkurrence_traekning_laas() from public, anon, authenticated;

drop trigger if exists konkurrence_traekninger_laas on public.konkurrence_traekninger;
create trigger konkurrence_traekninger_laas
  before update or delete on public.konkurrence_traekninger
  for each row execute function public.konkurrence_traekning_laas();

drop trigger if exists konkurrence_traekninger_ingen_truncate on public.konkurrence_traekninger;
create trigger konkurrence_traekninger_ingen_truncate
  before truncate on public.konkurrence_traekninger
  for each statement execute function public.konkurrence_traekning_laas();

create or replace function public.konkurrence_lod_laas()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'En fastfrosset deltagerliste kan ikke ændres' using errcode = '42501';
end $$;
revoke all on function public.konkurrence_lod_laas() from public, anon, authenticated;

drop trigger if exists konkurrence_traekning_lod_laas on public.konkurrence_traekning_lod;
create trigger konkurrence_traekning_lod_laas
  before update or delete on public.konkurrence_traekning_lod
  for each row execute function public.konkurrence_lod_laas();

drop trigger if exists konkurrence_traekning_lod_ingen_truncate on public.konkurrence_traekning_lod;
create trigger konkurrence_traekning_lod_ingen_truncate
  before truncate on public.konkurrence_traekning_lod
  for each statement execute function public.konkurrence_lod_laas();

-- Vinderloddet: (SHA-256(seed || liste_hash) som 256-bit heltal) mod N + 1.
-- Ren funktion, så enhver kan efterregne trækningen.
create or replace function public.konkurrence_lod_nr(p_seed text, p_liste_hash text, p_antal_lod integer)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_h bytea;
  v_n numeric := 0;
begin
  if p_seed !~ '^[0-9a-f]{64}$' or p_liste_hash !~ '^[0-9a-f]{64}$' or p_antal_lod is null or p_antal_lod < 1 then
    raise exception 'Ugyldigt seed, hash eller antal lod';
  end if;
  v_h := sha256(decode(p_seed, 'hex') || decode(p_liste_hash, 'hex'));
  for i in 0..31 loop
    v_n := v_n * 256 + get_byte(v_h, i);
  end loop;
  return (mod(v_n, p_antal_lod) + 1)::integer;
end $$;
revoke all on function public.konkurrence_lod_nr(text, text, integer) from public, anon, authenticated;
grant execute on function public.konkurrence_lod_nr(text, text, integer) to service_role;

-- Seedet: 32 kryptografisk tilfældige bytes, lavet her i databasen i samme
-- transaktion som trækningen. pgcrypto (extensions.gen_random_bytes) hos
-- Supabase; ellers SHA-256 af to gen_random_uuid() (244 tilfældige bit fra
-- Postgres' stærke generator). Internt - ingen grants.
create or replace function public.konkurrence_nyt_seed()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if to_regprocedure('extensions.gen_random_bytes(integer)') is not null then
    execute 'select encode(extensions.gen_random_bytes(32), ''hex'')' into v;
  else
    v := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  end if;
  return v;
end $$;
revoke all on function public.konkurrence_nyt_seed() from public, anon, authenticated, service_role;

-- SHA-256 af den fastfrosne liste ("YYYY-MM\n<bruger_id>:<antal>\n...",
-- sorteret efter bruger-id).
create or replace function public.konkurrence_liste_hash(p_traekning uuid, p_maaned text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(
           p_maaned || coalesce((select string_agg(e'\n' || l.bruger_id::text || ':' || l.antal_lod::text, '' order by l.bruger_id)
                                   from public.konkurrence_traekning_lod l
                                  where l.traekning_id = p_traekning), ''),
           'UTF8')), 'hex');
$$;
revoke all on function public.konkurrence_liste_hash(uuid, text) from public, anon, authenticated;
grant execute on function public.konkurrence_liste_hash(uuid, text) to service_role;

create or replace function public.konkurrence_er_chef(p_chef uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_chef is not null
     and exists (select 1 from public.users u where u.id = p_chef and u.rolle = 'chef'
                    and u.konto_slettet_kl is null and u.konto_lukket_kl is null);
$$;
revoke all on function public.konkurrence_er_chef(uuid) from public, anon, authenticated;
grant execute on function public.konkurrence_er_chef(uuid) to service_role;

-- Tidligere udgaver (kun testdatabasen) tog seedet som parameter.
drop function if exists public.konkurrence_gem_traekning(uuid, text, integer, uuid, text, text, uuid);
drop function if exists public.konkurrence_traek(uuid, text, text);
drop function if exists public.konkurrence_traek_igen(uuid, uuid, text, text);

-- Fælles: lav seedet, træk vinderen på en allerede indsat (fastfrosset) liste
-- og gem trækningen. Internt - kaldes kun af konkurrence_traek/_traek_igen.
create or replace function public.konkurrence_gem_traekning(
  p_id uuid, p_maaned text, p_nr integer, p_chef uuid,
  p_grund text, p_begrundelse text, p_erstatter uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deltagere integer;
  v_lod       integer;
  v_hash      text;
  v_seed      text := public.konkurrence_nyt_seed();
  v_nr        integer;
  v_vinder    uuid;
begin
  select count(*)::integer, coalesce(sum(l.antal_lod), 0)::integer into v_deltagere, v_lod
    from public.konkurrence_traekning_lod l where l.traekning_id = p_id;
  if v_lod < 1 then
    raise exception 'Tom liste';
  end if;
  v_hash := public.konkurrence_liste_hash(p_id, p_maaned);
  v_nr := public.konkurrence_lod_nr(v_seed, v_hash, v_lod);
  select l.bruger_id into v_vinder
    from public.konkurrence_traekning_lod l
   where l.traekning_id = p_id and v_nr between l.foerste_lod and l.sidste_lod;
  if v_vinder is null then
    raise exception 'Vinderloddet findes ikke på listen';
  end if;
  insert into public.konkurrence_traekninger
    (id, maaned, nr, trukket_af, antal_deltagere, antal_lod, liste_hash, seed, vinder_lod, vinder_id,
     grund, begrundelse, erstatter_id)
  values
    (p_id, p_maaned, p_nr, p_chef, v_deltagere, v_lod, v_hash, v_seed, v_nr, v_vinder,
     p_grund, nullif(btrim(coalesce(p_begrundelse, '')), ''), p_erstatter);
  return jsonb_build_object('kode', 'ok', 'traekning_id', p_id, 'nr', p_nr, 'vinder_id', v_vinder,
                            'vinder_lod', v_nr, 'antal_lod', v_lod, 'antal_deltagere', v_deltagere,
                            'liste_hash', v_hash, 'seed', v_seed);
end $$;
revoke all on function public.konkurrence_gem_traekning(uuid, text, integer, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

-- Træk månedens vinder (første gang). Kun chef, kun efter månedens slut og
-- fra startmåneden. Findes der allerede en trækning for måneden:
-- { kode: 'findes' } (ingen ny).
create or replace function public.konkurrence_traek(p_chef uuid, p_maaned text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fra timestamptz;
  v_til timestamptz;
  v_id  uuid := gen_random_uuid();
  v_n   integer;
begin
  if not public.konkurrence_er_chef(p_chef) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select i.fra, i.til into v_fra, v_til from public.konkurrence_maaned_interval(p_maaned) i;
  if v_fra is null then
    return jsonb_build_object('kode', 'ugyldig_maaned');
  end if;
  if public.konkurrence_start_maaned() is null or p_maaned < public.konkurrence_start_maaned() then
    return jsonb_build_object('kode', 'foer_start');
  end if;
  if p_maaned >= public.konkurrence_denne_maaned() then
    return jsonb_build_object('kode', 'maaned_ikke_slut');
  end if;

  -- Én ad gangen pr. måned (dobbeltklik / to faner).
  perform pg_advisory_xact_lock(hashtextextended('konkurrence_traek:' || p_maaned, 0));
  if exists (select 1 from public.konkurrence_traekninger t where t.maaned = p_maaned) then
    return jsonb_build_object('kode', 'findes',
      'traekning_id', (select t.id from public.konkurrence_traekninger t
                        where t.maaned = p_maaned and t.erstattet_kl is null));
  end if;

  -- Fastfrys listen: kun deltagere, sorteret efter bruger-id, lod 1..N.
  insert into public.konkurrence_traekning_lod (traekning_id, bruger_id, antal_lod, foerste_lod, sidste_lod)
  select v_id, l.bruger_id, l.antal_lod,
         (sum(l.antal_lod) over (order by l.bruger_id) - l.antal_lod + 1)::integer,
         (sum(l.antal_lod) over (order by l.bruger_id))::integer
    from public.konkurrence_lod_beregn(v_fra, v_til) l
   where l.grund is null and l.antal_lod > 0;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('kode', 'ingen_deltagere');
  end if;

  return public.konkurrence_gem_traekning(v_id, p_maaned, 1, p_chef, null, null, null);
end $$;
revoke all on function public.konkurrence_traek(uuid, text) from public, anon, authenticated;
grant execute on function public.konkurrence_traek(uuid, text) to service_role;

-- Træk en ny vinder. p_grund: 'svarer_ikke' (kun når svarfristen efter den
-- gældende trækning er udløbet) eller 'opfylder_ikke'; p_begrundelse er
-- valgfri fritekst (højst 2000 tegn). Højst konkurrence_max_nye_vindere()
-- nye vindere pr. måned. Trækker på samme fastfrosne liste uden de tidligere
-- vindere. p_traekning = den gældende trækning, der erstattes; er den
-- allerede erstattet (dobbeltklik), sker intet: { kode: 'allerede_erstattet' }.
create or replace function public.konkurrence_traek_igen(
  p_chef uuid, p_traekning uuid, p_grund text, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gl  public.konkurrence_traekninger%rowtype;
  v_id  uuid := gen_random_uuid();
  v_n   integer;
begin
  if not public.konkurrence_er_chef(p_chef) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_grund is null or p_grund not in ('svarer_ikke', 'opfylder_ikke') then
    return jsonb_build_object('kode', 'grund_mangler');
  end if;
  if char_length(coalesce(p_begrundelse, '')) > 2000 then
    return jsonb_build_object('kode', 'begrundelse_for_lang');
  end if;
  select t.* into v_gl from public.konkurrence_traekninger t where t.id = p_traekning;
  if not found then
    return jsonb_build_object('kode', 'findes_ikke');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('konkurrence_traek:' || v_gl.maaned, 0));
  select t.* into v_gl from public.konkurrence_traekninger t where t.id = p_traekning for update;
  if v_gl.erstattet_kl is not null then
    return jsonb_build_object('kode', 'allerede_erstattet',
      'traekning_id', (select t.id from public.konkurrence_traekninger t
                        where t.maaned = v_gl.maaned and t.erstattet_kl is null));
  end if;
  -- nr 1 = første vinder; nr - 1 = antal nye vindere indtil nu.
  if v_gl.nr - 1 >= public.konkurrence_max_nye_vindere() then
    return jsonb_build_object('kode', 'loft_naaet');
  end if;
  if p_grund = 'svarer_ikke'
     and now() < v_gl.trukket_kl + make_interval(days => public.konkurrence_svarfrist_dage()) then
    return jsonb_build_object('kode', 'svarfrist_ikke_udloebet',
      'svarfrist', v_gl.trukket_kl + make_interval(days => public.konkurrence_svarfrist_dage()));
  end if;

  -- Samme liste uden den hidtidige vinder (de tidligere vindere er allerede
  -- taget ud af den liste, den gældende trækning brugte), nummereret forfra.
  insert into public.konkurrence_traekning_lod (traekning_id, bruger_id, antal_lod, foerste_lod, sidste_lod)
  select v_id, l.bruger_id, l.antal_lod,
         (sum(l.antal_lod) over (order by l.bruger_id) - l.antal_lod + 1)::integer,
         (sum(l.antal_lod) over (order by l.bruger_id))::integer
    from public.konkurrence_traekning_lod l
   where l.traekning_id = v_gl.id and l.bruger_id <> v_gl.vinder_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('kode', 'ingen_flere');
  end if;

  update public.konkurrence_traekninger
     set erstattet_kl = now(), erstattet_af = p_chef
   where id = v_gl.id and erstattet_kl is null;

  return public.konkurrence_gem_traekning(v_id, v_gl.maaned, v_gl.nr + 1, p_chef, p_grund, p_begrundelse, v_gl.id);
end $$;
revoke all on function public.konkurrence_traek_igen(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.konkurrence_traek_igen(uuid, uuid, text, text) to service_role;

-- ===========================================================================
-- 6. Admin → Konkurrence (kun chef, via serveren)
-- ===========================================================================

-- Oversigt for en måned: deltagere (lige nu), udelukkede sælgere med grund,
-- trækningerne (log) og den fastfrosne liste for den gældende trækning.
create or replace function public.konkurrence_admin_oversigt(p_chef uuid, p_maaned text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fra timestamptz;
  v_til timestamptz;
  v_gaeldende uuid;
begin
  if not public.konkurrence_er_chef(p_chef) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select i.fra, i.til into v_fra, v_til from public.konkurrence_maaned_interval(p_maaned) i;
  if v_fra is null then
    return jsonb_build_object('kode', 'ugyldig_maaned');
  end if;
  select t.id into v_gaeldende from public.konkurrence_traekninger t
   where t.maaned = p_maaned and t.erstattet_kl is null;

  return (
    with l as (select * from public.konkurrence_lod_beregn(v_fra, v_til))
    select jsonb_build_object(
      'kode', 'ok',
      'maaned', p_maaned,
      'denne_maaned', public.konkurrence_denne_maaned(),
      'maaned_slut', p_maaned < public.konkurrence_denne_maaned(),
      'deltagere', coalesce((
        select jsonb_agg(jsonb_build_object('bruger_id', l.bruger_id, 'navn', u.navn, 'antal_lod', l.antal_lod)
                         order by l.antal_lod desc, u.navn, l.bruger_id)
          from l join public.users u on u.id = l.bruger_id
         where l.grund is null), '[]'::jsonb),
      'udelukkede', coalesce((
        select jsonb_agg(jsonb_build_object('bruger_id', l.bruger_id, 'navn', u.navn, 'antal_salg', l.antal_lod,
                                            'grund', l.grund)
                         order by l.antal_lod desc, l.bruger_id)
          from l left join public.users u on u.id = l.bruger_id
         where l.grund is not null), '[]'::jsonb),
      'traekninger', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'nr', t.nr, 'trukket_kl', t.trukket_kl,
                 'trukket_af', t.trukket_af, 'trukket_af_navn', ua.navn,
                 'antal_deltagere', t.antal_deltagere, 'antal_lod', t.antal_lod,
                 'liste_hash', t.liste_hash, 'seed', t.seed, 'vinder_lod', t.vinder_lod,
                 'vinder_id', t.vinder_id, 'vinder_navn', uv.navn, 'vinder_email', uv.email,
                 'grund', t.grund, 'begrundelse', t.begrundelse, 'erstatter_id', t.erstatter_id,
                 'svarfrist', t.trukket_kl + make_interval(days => public.konkurrence_svarfrist_dage()),
                 'erstattet_kl', t.erstattet_kl, 'erstattet_af_navn', ue.navn)
                 order by t.nr desc)
          from public.konkurrence_traekninger t
          left join public.users ua on ua.id = t.trukket_af
          left join public.users uv on uv.id = t.vinder_id
          left join public.users ue on ue.id = t.erstattet_af
         where t.maaned = p_maaned), '[]'::jsonb),
      'gaeldende_id', v_gaeldende,
      'start_maaned', public.konkurrence_start_maaned(),
      'max_nye_vindere', public.konkurrence_max_nye_vindere(),
      'svarfrist_dage', public.konkurrence_svarfrist_dage()));
end $$;
revoke all on function public.konkurrence_admin_oversigt(uuid, text) from public, anon, authenticated;
grant execute on function public.konkurrence_admin_oversigt(uuid, text) to service_role;

-- Listen til CSV og visning: er der trukket, den fastfrosne liste fra den
-- gældende trækning (med lod-intervaller), ellers listen lige nu.
-- Kun de nødvendige felter: bruger-id, navn og lod.
create or replace function public.konkurrence_admin_liste(p_chef uuid, p_maaned text)
returns table (bruger_id uuid, navn text, antal_lod integer, foerste_lod integer, sidste_lod integer,
               fastfrosset boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fra timestamptz;
  v_til timestamptz;
  v_id  uuid;
begin
  if not public.konkurrence_er_chef(p_chef) then
    raise exception 'ingen_adgang' using errcode = '42501';
  end if;
  select i.fra, i.til into v_fra, v_til from public.konkurrence_maaned_interval(p_maaned) i;
  if v_fra is null then
    raise exception 'ugyldig_maaned' using errcode = '22023';
  end if;
  select t.id into v_id from public.konkurrence_traekninger t
   where t.maaned = p_maaned and t.erstattet_kl is null;
  if v_id is not null then
    return query
      select l.bruger_id, u.navn, l.antal_lod, l.foerste_lod, l.sidste_lod, true
        from public.konkurrence_traekning_lod l
        left join public.users u on u.id = l.bruger_id
       where l.traekning_id = v_id
       order by l.foerste_lod;
  else
    return query
      select l.bruger_id, u.navn, l.antal_lod, null::integer, null::integer, false
        from public.konkurrence_lod_beregn(v_fra, v_til) l
        left join public.users u on u.id = l.bruger_id
       where l.grund is null
       order by l.antal_lod desc, l.bruger_id;
  end if;
end $$;
revoke all on function public.konkurrence_admin_liste(uuid, text) from public, anon, authenticated;
grant execute on function public.konkurrence_admin_liste(uuid, text) to service_role;
