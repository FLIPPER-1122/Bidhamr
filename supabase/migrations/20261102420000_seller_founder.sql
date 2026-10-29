-- =============================================================================
-- Seller founder (Filip, 29. okt. 2026 - ROADMAP-BESLUTNINGER afsnittet
-- "Seller founder").
--
-- En seller founder er en PRIVAT sælger, som chefen har lavet en aftale med.
-- På founderens salg er gebyrerne:
--   måned 1-6 fra startdatoen (dansk tid):  0 kr. i både købergebyr og sælgergebyr
--   derefter (for altid, til aftalen stoppes): 50 % af begge gebyrer
-- BidHamr Beskyttelse gælder uændret (betalinger.beskyttelse følger stadig
-- prismodellen og leveringsformen). Fragten betales som normalt.
--
--   1. Tabellen seller_founder (én række pr. bruger). RLS slået til uden
--      policies: kun service role. Rækker slettes aldrig (aftalen stoppes
--      med stoppet_kl). Firmakonti kan ikke være founder (trigger).
--   2. public.founder_rabat_pct(bruger, tidspunkt): 100 / 50 / 0. Måned 1-6
--      = fra og med start_dato til (start_dato + 6 måneder) - 1 dag, regnet
--      på datoen i Europe/Copenhagen. 0, når aftalen er stoppet, endnu ikke
--      er startet, eller brugeren er/er blevet firma.
--      public.founder_gebyr_oere(gebyr, rabat) = round(gebyr * (100 - rabat)
--      / 100), halv op i hele øre - samme afrunding som gebyrerne.
--   3. betalinger.founder_rabat_pct (0 / 50 / 100) låses, når betalingen
--      oprettes - præcis som prismodellen: triggeren betalinger_b_prismodel
--      sætter den ud fra auktionens sælger og regner købergebyr og
--      sælgergebyr med rabatten. Ved UPDATE bevares den gamle værdi (også når
--      kolonnen selv sættes - triggeren lytter nu også på den). Kun 'ny2'
--      (ny privat handel) kan have rabat; erhverv aldrig.
--      CHECK-formlerne for købergebyr og sælgergebyr medregner rabatten.
--      application_fee, udbetaling, total, refusionsplan, fakturaer og DAC7
--      læser de gemte beløb og følger automatisk med. Er hele BidHamrs gebyr
--      0 kr. (100 % rabat og afhentning), laves der ingen gebyrfaktura
--      (faktura_planlaeg springer 0 kr. over, faktura_linje dropper 0-linjer).
--   4. Offentligt (mærket "Founding seller" og visningen af gebyret før
--      buddet): founding_seller(bruger), founding_sellere(brugere[]) og
--      auktion_founder_rabat(auktion). Siger kun ja/nej og rabatten - aldrig
--      datoer, noter eller hvem der har oprettet aftalen.
--   5. Chefen (service role + rollen tjekkes igen her): seller_founder_opret,
--      seller_founder_ret_start, seller_founder_stop, seller_founder_admin
--      og seller_founder_liste. Oprettet, ændret startdato og stoppet logges
--      i moderation_log.
--
-- TypeScript-spejl: src/lib/betaling/beregn.ts (founderGebyrOere,
-- founderRabatPct). Appen: docs/APP-ENDPOINTS.md ("Founding seller").
--
-- OVERGANG: gammel serverkode kender ikke founder_rabat_pct og vil afvise at
-- oprette en PaymentIntent for en betaling med rabat (forventetTotalOere
-- passer ikke). Migration og kode skal ud samtidig. Uden founders (tabellen
-- er tom) ændrer migrationen intet for eksisterende eller nye betalinger.
--
-- Idempotent (kan køres igen). Én transaktion: ingen egen begin;/commit;.
-- Ingen handelsdata ændres. KØRES IKKE i produktion uden Filips "ja".
-- =============================================================================

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.betalinger_b_prismodel()') is null
     or to_regprocedure('public.prismodel_koebergebyr_oere(text,bigint)') is null
     or to_regprocedure('public.prismodel_saelgergebyr_oere(text,bigint)') is null
     or to_regprocedure('public.aktuel_prismodel(boolean)') is null
     or to_regclass('public.moderation_log') is null
     or to_regclass('public.firmaer') is null
     or not exists (select 1 from pg_constraint
                     where conrelid = 'public.betalinger'::regclass and conname = 'betalinger_prismodel_check'
                       and pg_get_constraintdef(oid) like '%ny2%') then
    raise exception 'Forudsætning mangler: kør 20261102140000_glidende_gebyrer.sql først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session)
-- ===========================================================================
create or replace function pg_temp.sf_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Nye værdier i en check-constraint af formen "kolonne = any (array[...])"
-- på moderation_log (de gamle værdier bevares) - som 20261102410000.
create or replace function pg_temp.sf_flet_check(p_navn text, p_kol text, p_nye text[])
returns void language plpgsql as $f$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = p_navn;
  if v_def is null then
    raise exception '% findes ikke', p_navn;
  end if;
  if (select bool_and(v_def like '%''' || x || '''%' or v_def like '%,' || x || ',%' or v_def like '%{' || x || ',%'
                      or v_def like '%,' || x || '}%' or v_def like '%{' || x || '}%') from unnest(p_nye) x) then
    return;
  end if;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m
      union select unnest(p_nye)) s
    where x <> '' order by 1);
  if cardinality(v_vals) <= cardinality(p_nye) then
    raise exception 'Kunne ikke læse %: %', p_navn, v_def;
  end if;
  execute format('alter table public.moderation_log drop constraint %I', p_navn);
  execute format('alter table public.moderation_log add constraint %I check (%I = any (%L::text[]))', p_navn, p_kol, v_vals);
end $f$;

-- Drift-tjek: triggeren skal være repoets version (20261102140000) eller
-- allerede denne. Ellers afbrydes migrationen, før noget ændres.
do $do$
declare
  h text := pg_temp.sf_md5('public.betalinger_b_prismodel()');
begin
  if h is distinct from '76a1f1f1a5799422eaac6e27607b6951'
     and h is distinct from '71c3db40bf76679a88c6a4902b896d6b' then
    raise exception 'betalinger_b_prismodel: md5 % er hverken 20261102140000 eller denne migration - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

-- ===========================================================================
-- 1. Tabellen
-- ===========================================================================
create table if not exists public.seller_founder (
  id           uuid primary key default gen_random_uuid(),
  bruger_id    uuid not null references public.users(id),
  -- Aftalens dato. Måned 1-6 (0 kr.) regnes herfra i dansk tid.
  start_dato   date not null,
  -- Aftalen er stoppet (ingen rabat på betalinger oprettet fra nu af).
  stoppet_kl   timestamptz,
  stoppet_af   uuid references public.users(id),
  oprettet_af  uuid not null references public.users(id),
  oprettet_kl  timestamptz not null default now(),
  opdateret_kl timestamptz not null default now(),
  note         text,
  constraint seller_founder_bruger_unik unique (bruger_id),
  constraint seller_founder_note_laengde check (note is null or char_length(note) <= 1000),
  constraint seller_founder_stoppet_af check ((stoppet_kl is null) = (stoppet_af is null))
);

comment on table public.seller_founder is
  'Seller founder (Filip, 29. okt. 2026): privat sælger med gebyraftale. Måned 1-6 fra start_dato (dansk tid) 0 kr. i købergebyr og sælgergebyr, derefter 50 % - indtil stoppet_kl. Rabatten låses på betalingen (betalinger.founder_rabat_pct). Kun service role; offentligt kun via founding_seller()/founding_sellere()/auktion_founder_rabat(). Rækker slettes aldrig. 20261102420000.';

alter table public.seller_founder enable row level security;
revoke all on table public.seller_founder from public, anon, authenticated, service_role;
grant select, insert, update on table public.seller_founder to service_role;

-- Firmakonti kan aldrig være (aktiv) founder. Et stop er altid tilladt.
create or replace function public.seller_founder_kun_privat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.stoppet_kl is null and (
       exists (select 1 from public.users u where u.id = new.bruger_id and coalesce(u.konto_type, 'privat') <> 'privat')
       or exists (select 1 from public.firmaer f where f.bruger_id = new.bruger_id)) then
    raise exception 'Firmakonti kan ikke være seller founder' using errcode = 'check_violation';
  end if;
  new.opdateret_kl := now();
  return new;
end
$fn$;
revoke execute on function public.seller_founder_kun_privat() from public, anon, authenticated;

drop trigger if exists seller_founder_kun_privat on public.seller_founder;
create trigger seller_founder_kun_privat before insert or update on public.seller_founder
  for each row execute function public.seller_founder_kun_privat();

-- Aftaler arkiveres (stoppes) - de slettes aldrig.
create or replace function public.seller_founder_forbyd_sletning()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'Seller founder-aftaler slettes ikke - stop aftalen i stedet' using errcode = 'insufficient_privilege';
end
$fn$;
revoke execute on function public.seller_founder_forbyd_sletning() from public, anon, authenticated;

drop trigger if exists seller_founder_forbyd_sletning on public.seller_founder;
create trigger seller_founder_forbyd_sletning before delete on public.seller_founder
  for each row execute function public.seller_founder_forbyd_sletning();

-- ===========================================================================
-- 2. Rabatten
-- ===========================================================================
-- 100 = måned 1-6, 50 = derefter, 0 = ingen (aldrig founder, stoppet, ikke
-- startet endnu, eller firma). p_tid null = nu.
create or replace function public.founder_rabat_pct(p_bruger uuid, p_tid timestamptz)
returns smallint
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((
    select case
             when d.dag < sf.start_dato then 0
             when d.dag < (sf.start_dato + interval '6 months')::date then 100
             else 50
           end
      from public.seller_founder sf
      join public.users u on u.id = sf.bruger_id
     cross join lateral (select (coalesce(p_tid, now()) at time zone 'Europe/Copenhagen')::date as dag) d
     where sf.bruger_id = p_bruger
       and (sf.stoppet_kl is null or sf.stoppet_kl > coalesce(p_tid, now()))
       and coalesce(u.konto_type, 'privat') = 'privat'
       and not exists (select 1 from public.firmaer f where f.bruger_id = p_bruger)
  ), 0)::smallint;
$fn$;
comment on function public.founder_rabat_pct(uuid, timestamptz) is
  'Seller founder-rabat i procent på et tidspunkt (20261102420000): 100 fra og med start_dato til start_dato + 6 måneder (dansk dato), derefter 50; 0 uden aktiv aftale eller for firmaer. Spejl: src/lib/betaling/beregn.ts founderRabatPct.';
revoke execute on function public.founder_rabat_pct(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.founder_rabat_pct(uuid, timestamptz) to service_role;

-- Gebyret efter rabatten, i hele øre (halv op - som gebyrerne). Ukendt
-- rabat = null (CHECK-formlerne lader aldrig null passere).
create or replace function public.founder_gebyr_oere(p_gebyr_oere bigint, p_rabat_pct integer)
returns bigint
language sql
immutable
strict
parallel safe
set search_path = ''
as $fn$
  select case when p_rabat_pct in (0, 50, 100)
              then round(p_gebyr_oere * (100 - p_rabat_pct) / 100.0)::bigint end;
$fn$;
comment on function public.founder_gebyr_oere(bigint, integer) is
  'Gebyr i øre efter seller founder-rabat (20261102420000): round(gebyr * (100 - rabat) / 100), halv op. Rabat 0, 50 eller 100 - ellers null. Spejl: src/lib/betaling/beregn.ts founderGebyrOere.';
grant execute on function public.founder_gebyr_oere(bigint, integer) to anon, authenticated, service_role;

-- ===========================================================================
-- 3. Rabatten låses på betalingen
-- ===========================================================================
alter table public.betalinger add column if not exists founder_rabat_pct smallint not null default 0;

do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.betalinger'::regclass
                  and conname = 'betalinger_founder_rabat_check') then
    alter table public.betalinger add constraint betalinger_founder_rabat_check
      check (founder_rabat_pct in (0, 50, 100) and (founder_rabat_pct = 0 or prismodel = 'ny2'));
  end if;
end $do$;

-- Parterne kan læse den som prismodel og koebergebyr_oere (kolonne-grants;
-- RLS afgør rækkerne). Appen viser teksten "Founding seller" ved gebyret.
grant select (founder_rabat_pct) on public.betalinger to authenticated;

comment on column public.betalinger.founder_rabat_pct is
  'Seller founder-rabat på købergebyr og sælgergebyr i procent (0, 50 eller 100), låst ved oprettelsen ud fra sælgerens aftale på det tidspunkt (20261102420000). Sættes af betalinger_b_prismodel og kan ikke ændres. Kun ny2.';

-- CHECK-formlerne medregner rabatten (rækker uden rabat: uændret).
do $do$
declare
  c record;
  n integer;
begin
  for c in
    select * from (values
      ('betalinger_koebergebyr_formel',
       $c$check (pengemodel = 'separat'
          or koebergebyr_oere = coalesce(public.founder_gebyr_oere(public.prismodel_koebergebyr_oere(prismodel, bud_oere), founder_rabat_pct), -1))$c$),
      ('betalinger_saelgergebyr_formel',
       $c$check (pengemodel = 'separat'
          or saelgergebyr_oere = coalesce(public.founder_gebyr_oere(public.prismodel_saelgergebyr_oere(prismodel, bud_oere), founder_rabat_pct), -1))$c$)
    ) as v(navn, def)
  loop
    if exists (select 1 from pg_constraint where conname = c.navn and conrelid = 'public.betalinger'::regclass
                and strpos(pg_get_constraintdef(oid), 'founder_gebyr_oere(') > 0) then
      continue;
    end if;
    execute format('alter table public.betalinger drop constraint if exists %I', c.navn);
    execute format('alter table public.betalinger add constraint %I %s not valid', c.navn, c.def);
    execute format('select count(*) from public.betalinger where not (%s)',
                   regexp_replace(c.def, '^check ', '')) into n;
    if n = 0 then
      execute format('alter table public.betalinger validate constraint %I', c.navn);
    else
      raise notice '%: % eksisterende række(r) afviger - constrainten står NOT VALID (nye og ændrede rækker skal passe)', c.navn, n;
    end if;
  end loop;
end $do$;

create or replace function public.betalinger_b_prismodel()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_erhverv boolean;
  v_saelger uuid;
begin
  if tg_op = 'INSERT' then
    select coalesce(a.erhverv, false), a.bruger_id into v_erhverv, v_saelger
      from public.auctions a
     where a.id = coalesce(new.auction_id,
                           (select t.auction_id from public.trades t where t.id = new.trade_id));
    v_erhverv := coalesce(v_erhverv, false);
    v_saelger := coalesce(v_saelger, new.seller_id);
    -- 20261101010000: erhvervshandler uden sælgergebyr ('erhverv2').
    -- 20261102140000: private handler med glidende overgang ('ny2').
    new.prismodel         := public.aktuel_prismodel(v_erhverv);
    -- 20261102420000: seller founder-rabat efter sælgerens aftale NU (låst).
    -- Firmaer aldrig.
    new.founder_rabat_pct := case when v_erhverv then 0
                                  else public.founder_rabat_pct(v_saelger, now()) end;
    new.fragt_oere        := coalesce(new.fragt_oere, 0);
    new.koebergebyr_oere  := public.founder_gebyr_oere(
                               public.prismodel_koebergebyr_oere(new.prismodel, new.bud_oere), new.founder_rabat_pct);
    new.saelgergebyr_oere := public.founder_gebyr_oere(
                               public.prismodel_saelgergebyr_oere(new.prismodel, new.bud_oere), new.founder_rabat_pct);
    new.udbetaling_oere   := new.bud_oere - new.saelgergebyr_oere;
    new.beskyttelse_oere  := 0;
    new.beskyttelse       := not v_erhverv and new.fragt_oere > 0;
    new.total_oere        := new.bud_oere + new.koebergebyr_oere + new.fragt_oere;
    return new;
  end if;

  -- UPDATE: prismodellen og founder-rabatten kan ikke ændres. I den nye
  -- model følger beskyttelse leveringsformen (fragt > 0 = forsendelse) - fx
  -- når køberen skifter mellem afhentning og forsendelse i checkout
  -- (handel_gem_levering). Beløbene røres ikke her (CHECK-formlerne afviser
  -- forkerte beløb).
  new.prismodel := old.prismodel;
  new.founder_rabat_pct := old.founder_rabat_pct;
  if old.prismodel <> 'gammel' then
    new.beskyttelse := old.prismodel in ('ny', 'ny2') and coalesce(new.fragt_oere, 0) > 0;
  end if;
  return new;
end;
$function$;

do $do$
begin
  if pg_temp.sf_md5('public.betalinger_b_prismodel()') is distinct from '71c3db40bf76679a88c6a4902b896d6b' then
    raise exception 'betalinger_b_prismodel: efter rettelsen er md5 %', pg_temp.sf_md5('public.betalinger_b_prismodel()');
  end if;
end $do$;

-- Triggeren lytter også på founder_rabat_pct, så en UPDATE af kolonnen
-- altid nulstilles til den låste værdi.
drop trigger if exists betalinger_b_prismodel on public.betalinger;
create trigger betalinger_b_prismodel
  before insert or update of prismodel, fragt_oere, beskyttelse, founder_rabat_pct on public.betalinger
  for each row execute function public.betalinger_b_prismodel();

-- ===========================================================================
-- 4. Offentligt: mærket og gebyret før buddet
-- ===========================================================================
create or replace function public.founding_seller(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_bruger is not null and public.founder_rabat_pct(p_bruger, now()) > 0;
$fn$;
comment on function public.founding_seller(uuid) is
  'Er brugeren aktiv seller founder lige nu (mærket "Founding seller")? Kun ja/nej. 20261102420000.';
revoke execute on function public.founding_seller(uuid) from public;
grant execute on function public.founding_seller(uuid) to anon, authenticated, service_role;

-- Til auktionskort: de af (højst 200) brugere, der er aktive founders.
create or replace function public.founding_sellere(p_brugere uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select d.id
    from (select distinct x.id from unnest((coalesce(p_brugere, '{}'::uuid[]))[1:200]) as x(id)
           where x.id is not null) d
   where public.founder_rabat_pct(d.id, now()) > 0;
$fn$;
comment on function public.founding_sellere(uuid[]) is
  'De af brugerne (højst 200), der er aktive seller founders lige nu (mærket "Founding seller"). 20261102420000.';
revoke execute on function public.founding_sellere(uuid[]) from public;
grant execute on function public.founding_sellere(uuid[]) to anon, authenticated, service_role;

-- Rabatten på gebyrerne, hvis auktionen sluttede nu eller ved sin sluttid
-- (det seneste): betalingen oprettes, når auktionen slutter. 0 for
-- erhvervsauktioner og ukendte auktioner. Til "Det betaler du, hvis du
-- vinder" - det endelige gebyr låses på betalingen.
create or replace function public.auktion_founder_rabat(p_auktion uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((
    select case when coalesce(a.erhverv, false) then 0
                else public.founder_rabat_pct(a.bruger_id, greatest(now(), coalesce(a.slutter_kl, now()))) end
      from public.auctions a
     where a.id = p_auktion), 0)::smallint;
$fn$;
comment on function public.auktion_founder_rabat(uuid) is
  'Seller founder-rabat (0/50/100) på auktionens gebyrer, hvis den slutter som planlagt (20261102420000). Visning - det endelige tal låses på betalingen.';
revoke execute on function public.auktion_founder_rabat(uuid) from public;
grant execute on function public.auktion_founder_rabat(uuid) to anon, authenticated, service_role;

-- ===========================================================================
-- 5. Chefen
-- ===========================================================================
select pg_temp.sf_flet_check('moderation_log_handling_check', 'handling',
  array['seller_founder_oprettet', 'seller_founder_startdato', 'seller_founder_stoppet']);

create or replace function public.seller_founder_er_chef(p_chef uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_chef is not null
     and exists (select 1 from public.users u where u.id = p_chef and u.rolle = 'chef'
                    and u.konto_slettet_kl is null);
$fn$;
revoke execute on function public.seller_founder_er_chef(uuid) from public, anon, authenticated;
grant execute on function public.seller_founder_er_chef(uuid) to service_role;

-- Datoen i dansk tid i dag.
create or replace function public.seller_founder_i_dag()
returns date
language sql
stable
set search_path = ''
as $fn$
  select (now() at time zone 'Europe/Copenhagen')::date;
$fn$;
revoke execute on function public.seller_founder_i_dag() from public, anon, authenticated;
grant execute on function public.seller_founder_i_dag() to service_role;

-- Gør en privat bruger til founder (eller genoptag en stoppet aftale med en
-- ny startdato). Koder: ok, allerede, ingen_adgang, inhabil, ikke_fundet,
-- firma, ugyldig_dato, ugyldig.
create or replace function public.seller_founder_opret(p_chef uuid, p_bruger uuid, p_start date, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  u      record;
  sf     record;
  n      integer;
begin
  if not public.seller_founder_er_chef(p_chef) then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_bruger is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if p_bruger = p_chef then return jsonb_build_object('kode', 'inhabil'); end if;
  if p_start is null or p_start < date '2026-01-01' or p_start > public.seller_founder_i_dag() + 366 then
    return jsonb_build_object('kode', 'ugyldig_dato');
  end if;
  if v_note is not null and char_length(v_note) > 1000 then return jsonb_build_object('kode', 'ugyldig'); end if;

  select x.id, x.konto_type, x.konto_slettet_kl into u from public.users x where x.id = p_bruger;
  if not found or u.konto_slettet_kl is not null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if coalesce(u.konto_type, 'privat') <> 'privat'
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'firma');
  end if;

  select * into sf from public.seller_founder s where s.bruger_id = p_bruger for update;
  if found and sf.stoppet_kl is null then return jsonb_build_object('kode', 'allerede'); end if;
  if found then
    update public.seller_founder
       set start_dato = p_start, stoppet_kl = null, stoppet_af = null, oprettet_af = p_chef, oprettet_kl = now(),
           note = coalesce(v_note, note)
     where id = sf.id;
  else
    insert into public.seller_founder (bruger_id, start_dato, oprettet_af, note)
    values (p_bruger, p_start, p_chef, v_note)
    on conflict (bruger_id) do nothing;
    get diagnostics n = row_count;
    if n = 0 then return jsonb_build_object('kode', 'allerede'); end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'seller_founder_oprettet', 'bruger', p_bruger, p_bruger,
          left('Seller founder fra ' || to_char(p_start, 'DD-MM-YYYY')
               || case when sf.id is not null then ' (aftalen genoptaget)' else '' end
               || coalesce(' - ' || v_note, ''), 2000));
  return jsonb_build_object('kode', 'ok');
end
$fn$;
revoke execute on function public.seller_founder_opret(uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.seller_founder_opret(uuid, uuid, date, text) to service_role;

-- Ret startdatoen på en aktiv aftale. Koder: ok, uaendret, ingen_adgang,
-- inhabil, ikke_founder, ugyldig_dato.
create or replace function public.seller_founder_ret_start(p_chef uuid, p_bruger uuid, p_start date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  sf record;
begin
  if not public.seller_founder_er_chef(p_chef) then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_bruger is null or p_bruger = p_chef then return jsonb_build_object('kode', 'inhabil'); end if;
  if p_start is null or p_start < date '2026-01-01' or p_start > public.seller_founder_i_dag() + 366 then
    return jsonb_build_object('kode', 'ugyldig_dato');
  end if;
  select * into sf from public.seller_founder s where s.bruger_id = p_bruger for update;
  if not found or sf.stoppet_kl is not null then return jsonb_build_object('kode', 'ikke_founder'); end if;
  if sf.start_dato = p_start then return jsonb_build_object('kode', 'uaendret'); end if;
  update public.seller_founder set start_dato = p_start where id = sf.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'seller_founder_startdato', 'bruger', p_bruger, p_bruger,
          'Startdato ændret fra ' || to_char(sf.start_dato, 'DD-MM-YYYY') || ' til ' || to_char(p_start, 'DD-MM-YYYY'));
  return jsonb_build_object('kode', 'ok');
end
$fn$;
revoke execute on function public.seller_founder_ret_start(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.seller_founder_ret_start(uuid, uuid, date) to service_role;

-- Stop aftalen. Betalinger, der allerede er oprettet, beholder deres rabat.
-- Koder: ok, ingen_adgang, inhabil, ikke_founder.
create or replace function public.seller_founder_stop(p_chef uuid, p_bruger uuid, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  sf record;
  v_b text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  if not public.seller_founder_er_chef(p_chef) then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_bruger is null or p_bruger = p_chef then return jsonb_build_object('kode', 'inhabil'); end if;
  select * into sf from public.seller_founder s where s.bruger_id = p_bruger for update;
  if not found or sf.stoppet_kl is not null then return jsonb_build_object('kode', 'ikke_founder'); end if;
  update public.seller_founder set stoppet_kl = now(), stoppet_af = p_chef where id = sf.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'seller_founder_stoppet', 'bruger', p_bruger, p_bruger,
          left('Seller founder-aftalen stoppet (startdato ' || to_char(sf.start_dato, 'DD-MM-YYYY') || ')'
               || coalesce(' - ' || v_b, ''), 2000));
  return jsonb_build_object('kode', 'ok');
end
$fn$;
revoke execute on function public.seller_founder_stop(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.seller_founder_stop(uuid, uuid, text) to service_role;

-- Én aftale som json (til boksen og listen): fasen, datoerne og hvad
-- rabatten har kostet BidHamr på betalte handler.
create or replace function public.seller_founder_json(p_sf public.seller_founder)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'bruger_id', p_sf.bruger_id,
    'navn', u.navn,
    'email', u.email,
    'start_dato', p_sf.start_dato,
    'stoppet_kl', p_sf.stoppet_kl,
    'note', p_sf.note,
    'oprettet_kl', p_sf.oprettet_kl,
    'oprettet_af_navn', o.navn,
    'er_firma', coalesce(u.konto_type, 'privat') <> 'privat'
                or exists (select 1 from public.firmaer f where f.bruger_id = p_sf.bruger_id),
    'rabat_nu', public.founder_rabat_pct(p_sf.bruger_id, now()),
    -- Sidste dag med 0 kr. og første dag med 50 %.
    'fri_til', ((p_sf.start_dato + interval '6 months')::date - 1),
    'halv_fra', (p_sf.start_dato + interval '6 months')::date,
    'handler', (select count(*) from public.betalinger b
                 where b.seller_id = p_sf.bruger_id and b.founder_rabat_pct > 0 and b.betalt_kl is not null),
    'rabat_oere', (select coalesce(sum(public.prismodel_koebergebyr_oere(b.prismodel, b.bud_oere)
                                      + public.prismodel_saelgergebyr_oere(b.prismodel, b.bud_oere)
                                      - b.koebergebyr_oere - b.saelgergebyr_oere), 0)
                     from public.betalinger b
                    where b.seller_id = p_sf.bruger_id and b.founder_rabat_pct > 0 and b.betalt_kl is not null))
    from public.users u
    left join public.users o on o.id = p_sf.oprettet_af
   where u.id = p_sf.bruger_id;
$fn$;
revoke execute on function public.seller_founder_json(public.seller_founder) from public, anon, authenticated;
grant execute on function public.seller_founder_json(public.seller_founder) to service_role;

-- Boksen på brugersiden: { kode, er_firma, founder (null = ingen aftale) }.
create or replace function public.seller_founder_admin(p_chef uuid, p_bruger uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when not public.seller_founder_er_chef(p_chef) then jsonb_build_object('kode', 'ingen_adgang')
    else jsonb_build_object(
      'kode', 'ok',
      'i_dag', public.seller_founder_i_dag(),
      'er_firma', exists (select 1 from public.users u where u.id = p_bruger and coalesce(u.konto_type, 'privat') <> 'privat')
                  or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger),
      'founder', (select public.seller_founder_json(s) from public.seller_founder s where s.bruger_id = p_bruger))
  end;
$fn$;
revoke execute on function public.seller_founder_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.seller_founder_admin(uuid, uuid) to service_role;

-- Listen over alle aftaler: aktive først, så de stoppede.
create or replace function public.seller_founder_liste(p_chef uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when not public.seller_founder_er_chef(p_chef) then null
    else coalesce((select jsonb_agg(public.seller_founder_json(s)
                                    order by (s.stoppet_kl is not null), s.start_dato desc, s.oprettet_kl desc)
                     from public.seller_founder s), '[]'::jsonb)
  end;
$fn$;
revoke execute on function public.seller_founder_liste(uuid) from public, anon, authenticated;
grant execute on function public.seller_founder_liste(uuid) to service_role;

-- ===========================================================================
-- 6. Kontrol
-- ===========================================================================
do $do$
begin
  if public.founder_gebyr_oere(1505, 50) <> 753 or public.founder_gebyr_oere(1505, 100) <> 0
     or public.founder_gebyr_oere(1505, 0) <> 1505 or public.founder_gebyr_oere(65000, 50) <> 32500
     or public.founder_gebyr_oere(1505, 30) is not null then
    raise exception 'Kontrol: founder_gebyr_oere regner forkert';
  end if;
  if public.founder_rabat_pct(null, now()) <> 0 then
    raise exception 'Kontrol: founder_rabat_pct uden bruger skal være 0';
  end if;
end $do$;

-- ===========================================================================
-- 7. Oprydning
-- ===========================================================================
drop function if exists pg_temp.sf_flet_check(text, text, text[]);
drop function if exists pg_temp.sf_md5(text);
