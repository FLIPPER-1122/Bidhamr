-- Reklamation hos fragtfirma ved transportskade (ROADMAP fase 2;
-- ROADMAP-BESLUTNINGER afsnit 4, "Transportskade - hvem bærer tabet", Filip
-- 7. okt. 2026, og "DAO (Filip, 20. okt. 2026)").
--
-- Model (Filip, 21. okt. 2026): SÆLGEREN anmelder selv skaden hos
-- fragtfirmaet (DAO: omdeling.info - ingen API til skader). Erstatningen går
-- DIREKTE fra fragtfirmaet til sælgeren - BidHamr flytter ingen penge og har
-- ingen Stripe-udbetaling her. BidHamr samler "reklamationspakken"
-- (felter, sælgers pakkebilleder, købers skadebilleder, sporing) og giver
-- sælgeren den på handlen. Afviser fragtfirmaet, er det sælgers tab. Dårlig
-- indpakning -> ingen reklamation (advarselssystemet, indpakning_vurder).
--
--   1. fragt_transportoer_erstatning: maks. erstatning pr. pakke pr.
--      transportør. DAO = 2.500 kr. (DAO's svar 20. okt. 2026). GLS = null =
--      ukendt (vi venter på svar) -> kravbeløbet er varens værdi. Ændres med
--      en ny migration, når GLS svarer.
--   2. indpakning_ordentlig: staffs POSITIVE vurdering af indpakningen i en
--      sag (indpakning_vurder registrerer kun dårlig indpakning). Én række pr.
--      sag; kan fortrydes, så længe sælgeren ikke har anmeldt. Dårlig og
--      ordentlig udelukker hinanden (begge veje).
--   3. fragt_reklamationer: én pr. sag. Status:
--        afventer_saelger -> anmeldt -> godkendt | afvist   (sælgeren registrerer)
--        afventer_saelger/anmeldt -> fravalgt              ("Jeg ønsker ikke at reklamere")
--        afventer_saelger/anmeldt -> annulleret            (staff med grund, eller systemet)
--      Sælgeren må springe "anmeldt" over (godkendt/afvist direkte).
--      Staff kan rette status (fragt_reklamation_ret_status, kræver
--      begrundelse), hvis sælgeren har registreret forkert. Slettes aldrig.
--   4. AUTOMATISK OPRETTELSE (fragt_reklamation_synkroniser): kaldes af en
--      trigger på sager.status OG af indpakning_ordentlig/-_fortryd, så begge
--      rækkefølger virker (indpakning vurderet før eller efter afgørelsen).
--      Betingelser: type 'skadet', status 'afventer_retur' eller
--      'afgjort_koeber', ordentlig indpakning (ikke fortrudt), ikke
--      afhentning, og en udgående forsendelse med DAO eller GLS.
--      Ophører betingelserne (sagen genåbnes, anke omgøres til sælger,
--      vurderingen fortrydes), annulleres en reklamation i 'afventer_saelger'
--      automatisk (annulleret_auto) - og genopstår, hvis betingelserne
--      kommer igen. Har sælgeren allerede anmeldt, røres status ikke, men
--      sag_aendret_kl sættes, så staff ser det.
--   5. Sælgerens funktioner (authenticated, sælgeren = auth.uid()):
--      mit_fragt_reklamation_anmeldt / _godkendt / _afvist / _fravaelg,
--      mine_fragt_reklamationer (offentlige felter) og
--      min_reklamationspakke_adgang (må sælgeren hente pakken?).
--      Køberen ser intet (køberen er refunderet).
--   6. Staff-funktioner (authenticated, auth.uid() + er_staff() = rolle OG
--      aal2 - migration B, 20261027020000; inhabil afvises): note, send
--      pakken/påmindelsen igen, annullér, ret status, indpakning ordentlig /
--      fortryd. Alt logges i moderation_log (maal_type 'sag'); sælgerens
--      egne registreringer logges med systembrugeren som afsender.
--   7. fragt_reklamationer_antal(): tællere til admin-lampen (venter på
--      sælger, stået stille i 14 dage, sagen ændret efter anmeldelse).
--   8. moderation_log_handling_check flettes med de nye handlinger.
--
-- Beskeder til sælgeren (notifikation + mail ved oprettelse, påmindelse
-- efter 7 dage uden "anmeldt", gensendt af staff, annulleret af staff)
-- sendes fra serveren (src/lib/reklamation/notifikationer.ts) ud fra
-- tidsstemplerne - samme mønster som advarsler.
--
-- Ingen eksisterende funktioner ændres. Nye triggere på sager (AFTER UPDATE
-- OF status), advarsler og paamindelser (BEFORE INSERT, kun grund
-- 'daarlig_indpakning').
-- Idempotent (kan køres igen). KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.sager') is null or to_regclass('public.forsendelser') is null
     or to_regclass('public.paamindelser') is null or to_regclass('public.betalinger') is null then
    raise exception 'Forudsætning mangler: sager, forsendelser, paamindelser og betalinger';
  end if;
  if to_regprocedure('public.er_staff()') is null
     or to_regprocedure('public.penge_inhabil(uuid,uuid,uuid)') is null
     or to_regprocedure('public.staff_aal2_ok(integer)') is null then
    raise exception 'Forudsætning mangler: er_staff, penge_inhabil, staff_aal2_ok (20261027020000)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Maks. erstatning pr. transportør
-- ===========================================================================
create table if not exists public.fragt_transportoer_erstatning (
  transportoer  text primary key check (transportoer in ('dao', 'gls')),
  -- null = ukendt: kravbeløbet er varens værdi.
  maks_oere     bigint check (maks_oere is null or maks_oere > 0),
  kilde         text,
  opdateret_kl  timestamptz not null default now()
);

comment on table public.fragt_transportoer_erstatning is
  'Maks. erstatning pr. pakke ved reklamation (20261029010000). null = ukendt '
  '(kravbeløbet er varens værdi). Ændres kun med en migration.';

insert into public.fragt_transportoer_erstatning (transportoer, maks_oere, kilde) values
  ('dao', 250000, 'DAO (Allan), 20. okt. 2026: maks. 2.500 kr. pr. pakke, intet tilkøb'),
  ('gls', null,   'Ukendt - venter på svar fra GLS')
on conflict (transportoer) do nothing;

alter table public.fragt_transportoer_erstatning enable row level security;
revoke all on public.fragt_transportoer_erstatning from public, anon, authenticated;
grant select on public.fragt_transportoer_erstatning to authenticated, service_role;
drop policy if exists fragt_transportoer_erstatning_select_staff on public.fragt_transportoer_erstatning;
create policy fragt_transportoer_erstatning_select_staff on public.fragt_transportoer_erstatning
  for select to authenticated using ((select public.er_staff()));

-- ===========================================================================
-- 2. Ordentlig indpakning
-- ===========================================================================
create table if not exists public.indpakning_ordentlig (
  sag_id             uuid primary key references public.sager(id) on delete restrict,
  trade_id           uuid not null references public.trades(id) on delete restrict,
  vurderet_af        uuid not null references public.users(id) on delete restrict,
  vurderet_kl        timestamptz not null default now(),
  intern_note        text check (intern_note is null or char_length(intern_note) <= 2000),
  -- Fortrudt (fx fejlklik). Kan sættes igen af indpakning_ordentlig.
  tilbagekaldt_kl    timestamptz,
  tilbagekaldt_af    uuid references public.users(id) on delete restrict,
  tilbagekaldt_grund text check (tilbagekaldt_grund is null or char_length(tilbagekaldt_grund) <= 1000),
  constraint indpakning_ordentlig_tilbagekaldt_par check (
    (tilbagekaldt_kl is null) = (tilbagekaldt_af is null))
);

comment on table public.indpakning_ordentlig is
  'Staff har vurderet sælgerens indpakning som ordentlig i en sag (20261029010000). '
  'Forudsætning for reklamation hos fragtfirmaet. Slettes aldrig. Kun staff.';

alter table public.indpakning_ordentlig enable row level security;
revoke all on public.indpakning_ordentlig from public, anon, authenticated;
grant select on public.indpakning_ordentlig to authenticated, service_role;
drop policy if exists indpakning_ordentlig_select_staff on public.indpakning_ordentlig;
create policy indpakning_ordentlig_select_staff on public.indpakning_ordentlig
  for select to authenticated using ((select public.er_staff()));

create or replace function public.indpakning_ordentlig_beskyt()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Vurderingen af indpakningen kan ikke slettes.' using errcode = '42501';
  end if;
  if new.sag_id is distinct from old.sag_id or new.trade_id is distinct from old.trade_id then
    raise exception 'Vurderingen kan ikke flyttes til en anden sag.' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.indpakning_ordentlig_beskyt() from public, anon, authenticated;

drop trigger if exists indpakning_ordentlig_beskyt on public.indpakning_ordentlig;
create trigger indpakning_ordentlig_beskyt
  before update or delete on public.indpakning_ordentlig
  for each row execute function public.indpakning_ordentlig_beskyt();

-- Dårlig indpakning (indpakning_vurder) kan ikke gives på en sag, hvor
-- indpakningen er vurderet ordentlig - fortryd den vurdering først.
create or replace function public.indpakning_daarlig_ikke_ordentlig()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.grund = 'daarlig_indpakning' and new.sag_id is not null
     and exists (select 1 from public.indpakning_ordentlig o
                  where o.sag_id = new.sag_id and o.tilbagekaldt_kl is null) then
    raise exception 'Indpakningen er vurderet ordentlig i denne sag. Fortryd den vurdering først.'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

revoke execute on function public.indpakning_daarlig_ikke_ordentlig() from public, anon, authenticated;

drop trigger if exists advarsler_daarlig_ikke_ordentlig on public.advarsler;
create trigger advarsler_daarlig_ikke_ordentlig
  before insert on public.advarsler
  for each row execute function public.indpakning_daarlig_ikke_ordentlig();

drop trigger if exists paamindelser_daarlig_ikke_ordentlig on public.paamindelser;
create trigger paamindelser_daarlig_ikke_ordentlig
  before insert on public.paamindelser
  for each row execute function public.indpakning_daarlig_ikke_ordentlig();

-- ===========================================================================
-- 3. fragt_reklamationer
-- ===========================================================================
create table if not exists public.fragt_reklamationer (
  id                         uuid primary key default gen_random_uuid(),
  sag_id                     uuid not null unique references public.sager(id) on delete restrict,
  trade_id                   uuid not null references public.trades(id) on delete restrict,
  saelger_id                 uuid not null references public.users(id) on delete restrict,
  forsendelse_id             uuid references public.forsendelser(id) on delete restrict,
  transportoer               text not null check (transportoer in ('dao', 'gls')),
  trackingnummer             text check (trackingnummer is null or char_length(trackingnummer) <= 100),
  -- Varens pris (hammerslag) og transportørens maks. ved oprettelsen.
  varens_vaerdi_oere         bigint not null check (varens_vaerdi_oere > 0),
  maks_erstatning_oere       bigint check (maks_erstatning_oere is null or maks_erstatning_oere > 0),
  -- = least(varens værdi, maks); varens værdi, når maks er ukendt (GLS).
  kravbeloeb_oere            bigint not null,
  status                     text not null default 'afventer_saelger',
  transportoerens_sagsnummer text check (transportoerens_sagsnummer is null
                                         or char_length(transportoerens_sagsnummer) between 1 and 100),
  -- Udbetalt DIREKTE af fragtfirmaet til sælgeren (registreret af sælgeren).
  godkendt_beloeb_oere       bigint,
  -- Fra fragtfirmaet (valgfri ved sælgerens registrering).
  afvisningsgrund            text check (afvisningsgrund is null or char_length(afvisningsgrund) between 1 and 1000),
  -- Til sælgeren, når staff annullerer.
  annulleret_grund           text check (annulleret_grund is null or char_length(annulleret_grund) between 1 and 1000),
  -- Annulleret af systemet (sagen ændret) - genopstår, hvis betingelserne kommer igen.
  annulleret_auto            boolean not null default false,
  -- Sagen er ændret (genåbnet/omgjort), efter sælgeren har anmeldt.
  sag_aendret_kl             timestamptz,
  oprettet_af                uuid not null references public.users(id) on delete restrict,
  oprettet_kl                timestamptz not null default now(),
  -- Hvornår sælgeren fik (eller fik igen) opgaven - påmindelse efter 7 dage.
  aktiv_fra_kl               timestamptz not null default now(),
  -- Seneste fremdrift (oprettet/genopstået, anmeldt, rettet) - lampe efter 14 dage.
  fremdrift_kl               timestamptz not null default now(),
  anmeldt_kl                 timestamptz,
  afgjort_kl                 timestamptz,
  -- Sælgeren selv eller staff (ret status).
  afgjort_af                 uuid references public.users(id) on delete restrict,
  fravalgt_kl                timestamptz,
  annulleret_af              uuid references public.users(id) on delete restrict,
  annulleret_kl              timestamptz,
  -- Staff har sendt pakken/påmindelsen igen.
  gensendt_kl                timestamptz,
  gensendt_af                uuid references public.users(id) on delete restrict,
  gensendt_antal             integer not null default 0 check (gensendt_antal between 0 and 1000),
  intern_note                text check (intern_note is null or char_length(intern_note) <= 4000),
  opdateret_kl               timestamptz not null default now(),
  constraint fragt_reklamationer_status_check check (
    status in ('afventer_saelger', 'anmeldt', 'godkendt', 'afvist', 'fravalgt', 'annulleret')),
  constraint fragt_reklamationer_krav_check check (
    kravbeloeb_oere > 0 and kravbeloeb_oere <= varens_vaerdi_oere
    and (maks_erstatning_oere is null or kravbeloeb_oere <= maks_erstatning_oere)),
  constraint fragt_reklamationer_godkendt_check check (
    (status = 'godkendt') = (godkendt_beloeb_oere is not null)
    and (godkendt_beloeb_oere is null or (godkendt_beloeb_oere > 0 and godkendt_beloeb_oere <= kravbeloeb_oere))),
  constraint fragt_reklamationer_afgjort_par check (
    status not in ('godkendt', 'afvist') or (afgjort_kl is not null and afgjort_af is not null)),
  constraint fragt_reklamationer_anmeldt_par check (
    status <> 'anmeldt' or anmeldt_kl is not null),
  constraint fragt_reklamationer_fravalgt_par check (
    status <> 'fravalgt' or fravalgt_kl is not null),
  constraint fragt_reklamationer_annulleret_par check (
    status <> 'annulleret' or (annulleret_grund is not null and annulleret_af is not null and annulleret_kl is not null))
);

comment on table public.fragt_reklamationer is
  'Reklamation hos fragtfirmaet ved transportskade (20261029010000). Én pr. sag. '
  'Oprettes automatisk (fragt_reklamation_synkroniser). Sælgeren anmelder selv; '
  'erstatningen går direkte fra fragtfirmaet til sælgeren. Slettes aldrig. '
  'Staff læser alt; sælger kun offentlige felter via mine_fragt_reklamationer().';
comment on column public.fragt_reklamationer.intern_note is 'Kun staff. Vises aldrig for sælgeren.';

create index if not exists fragt_reklamationer_status_idx on public.fragt_reklamationer (status, fremdrift_kl);
create index if not exists fragt_reklamationer_saelger_idx on public.fragt_reklamationer (saelger_id);
create index if not exists fragt_reklamationer_trade_idx on public.fragt_reklamationer (trade_id);
create index if not exists fragt_reklamationer_opdateret_idx on public.fragt_reklamationer (opdateret_kl);

alter table public.fragt_reklamationer enable row level security;
revoke all on public.fragt_reklamationer from public, anon, authenticated;
-- Staff (rolle + aal2) må læse alt direkte. Ingen skriverettigheder: alt går
-- gennem funktionerne nedenfor (security definer).
grant select on public.fragt_reklamationer to authenticated, service_role;
drop policy if exists fragt_reklamationer_select_staff on public.fragt_reklamationer;
create policy fragt_reklamationer_select_staff on public.fragt_reklamationer
  for select to authenticated using ((select public.er_staff()));

-- Ingen sletning og faste felter. Statusovergange håndhæves i funktionerne
-- (update ... where status = ...); staff kan rette status bevidst.
create or replace function public.fragt_reklamationer_beskyt()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Reklamationer kan ikke slettes.' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.sag_id is distinct from old.sag_id
     or new.trade_id is distinct from old.trade_id or new.saelger_id is distinct from old.saelger_id
     or new.transportoer is distinct from old.transportoer
     or new.varens_vaerdi_oere is distinct from old.varens_vaerdi_oere
     or new.maks_erstatning_oere is distinct from old.maks_erstatning_oere
     or new.kravbeloeb_oere is distinct from old.kravbeloeb_oere
     or new.oprettet_af is distinct from old.oprettet_af or new.oprettet_kl is distinct from old.oprettet_kl then
    raise exception 'Reklamationens faste oplysninger kan ikke ændres.' using errcode = '42501';
  end if;
  new.opdateret_kl := now();
  return new;
end;
$fn$;

revoke execute on function public.fragt_reklamationer_beskyt() from public, anon, authenticated;

drop trigger if exists fragt_reklamationer_beskyt on public.fragt_reklamationer;
create trigger fragt_reklamationer_beskyt
  before update or delete on public.fragt_reklamationer
  for each row execute function public.fragt_reklamationer_beskyt();

-- ===========================================================================
-- 4. moderation_log: nye handlinger (flettes ind i den nuværende liste)
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_nye  text[] := array[
    'indpakning_ordentlig', 'indpakning_ordentlig_fortrudt',
    'reklamation_oprettet', 'reklamation_genaabnet', 'reklamation_annulleret',
    'reklamation_sag_aendret', 'reklamation_note', 'reklamation_gensendt',
    'reklamation_status_rettet', 'reklamation_saelger_anmeldt',
    'reklamation_saelger_godkendt', 'reklamation_saelger_afvist', 'reklamation_saelger_fravalgt'];
  v_gl   text[];
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if v_def is null then
    raise exception 'moderation_log_handling_check findes ikke';
  end if;
  v_gl := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m) s
     where x <> '' order by 1);
  if cardinality(v_gl) = 0 then
    raise exception 'Kunne ikke læse moderation_log_handling_check: %', v_def;
  end if;
  if v_nye <@ v_gl then
    return;
  end if;
  v_vals := array(select distinct x from unnest(v_gl || v_nye) x order by 1);
  alter table public.moderation_log drop constraint moderation_log_handling_check;
  execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if not (v_gl <@ array(
            select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
              from regexp_matches(v_def, '''([^'']+)''', 'g') as m)
          and v_nye <@ array(
            select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
              from regexp_matches(v_def, '''([^'']+)''', 'g') as m)) then
    raise exception 'moderation_log_handling_check blev ikke flettet korrekt: %', v_def;
  end if;
end $do$;

-- ===========================================================================
-- 5. Hjælpere (interne - ingen grants til browseren)
-- ===========================================================================
create or replace function public.fragt_reklamation_log(
  p_medarbejder uuid, p_handling text, p_sag uuid, p_saelger uuid, p_tekst text)
returns void
language sql
security definer
set search_path = public
as $fn$
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, p_handling, 'sag', p_sag, p_saelger, left(p_tekst, 4000));
$fn$;

revoke all on function public.fragt_reklamation_log(uuid, text, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.fragt_reklamation_kr(p_oere bigint)
returns text
language sql
immutable
set search_path = public
as $fn$
  select to_char(p_oere / 100.0, 'FM999999990.00') || ' kr.';
$fn$;

-- Opretter/annullerer/genopliver sagens reklamation ud fra betingelserne
-- (se toppen). Kaldes af triggeren på sager og af indpakning_ordentlig /
-- indpakning_ordentlig_fortryd. Returnerer hvad der skete:
-- oprettet, genaabnet, annulleret, sag_aendret, uaendret, ikke_relevant.
create or replace function public.fragt_reklamation_synkroniser(p_sag uuid)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  sys      constant uuid := public.bidhamr_system_id();
  s        record;
  t        record;
  f        record;
  r        record;
  v_ok     boolean;
  v_findes boolean;
  v_trans  text;
  v_vaerdi bigint;
  v_maks   bigint;
begin
  select * into s from public.sager where id = p_sag;
  if not found or s.type <> 'skadet' then return 'ikke_relevant'; end if;

  select * into t from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then return 'ikke_relevant'; end if;

  -- Den udgående pakke med DAO eller GLS (den seneste aktive).
  select fo.id, fo.sporingsnummer,
         coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) as transportoer
    into f
    from public.forsendelser fo
   where fo.trade_id = t.id and fo.type = 'udgaaende'
     and fo.status not in ('opretter', 'annulleret', 'fejlet')
     and coalesce(fo.transportoer, case when fo.fragtfirma in ('dao', 'gls') then fo.fragtfirma end) in ('dao', 'gls')
   order by fo.oprettet_kl desc
   limit 1;
  if found then v_trans := f.transportoer; end if;

  v_ok := s.status in ('afventer_retur', 'afgjort_koeber')
          and not coalesce(t.afhentning, false)
          and v_trans is not null
          and exists (select 1 from public.indpakning_ordentlig o
                       where o.sag_id = s.id and o.tilbagekaldt_kl is null);

  select * into r from public.fragt_reklamationer where sag_id = s.id for update;
  v_findes := found;

  if v_ok then
    if not v_findes then
      select b.bud_oere into v_vaerdi from public.betalinger b where b.trade_id = t.id;
      v_vaerdi := coalesce(v_vaerdi, round(coalesce(t.amount, 0) * 100)::bigint);
      if v_vaerdi is null or v_vaerdi <= 0 then return 'ikke_relevant'; end if;
      select e.maks_oere into v_maks from public.fragt_transportoer_erstatning e where e.transportoer = v_trans;

      insert into public.fragt_reklamationer (
        sag_id, trade_id, saelger_id, forsendelse_id, transportoer, trackingnummer,
        varens_vaerdi_oere, maks_erstatning_oere, kravbeloeb_oere, oprettet_af)
      values (
        s.id, t.id, t.seller_id, f.id, v_trans,
        left(nullif(btrim(coalesce(f.sporingsnummer, t.tracking_number, '')), ''), 100),
        v_vaerdi, v_maks, least(v_vaerdi, coalesce(v_maks, v_vaerdi)), sys)
      on conflict (sag_id) do nothing;
      if not found then return 'uaendret'; end if;

      perform public.fragt_reklamation_log(sys, 'reklamation_oprettet', s.id, t.seller_id,
        'Reklamation hos ' || upper(v_trans) || ' oprettet automatisk (skadet under fragten, ordentlig indpakning). '
        || 'Sælgeren anmelder selv - kravbeløb ' || public.fragt_reklamation_kr(least(v_vaerdi, coalesce(v_maks, v_vaerdi)))
        || case when v_maks is null then ' (maks. erstatning ukendt - varens værdi)' else '' end);
      return 'oprettet';
    end if;

    if r.status = 'annulleret' and r.annulleret_auto then
      update public.fragt_reklamationer
         set status = 'afventer_saelger', annulleret_auto = false, annulleret_grund = null,
             annulleret_af = null, annulleret_kl = null, sag_aendret_kl = null,
             aktiv_fra_kl = now(), fremdrift_kl = now()
       where id = r.id and status = 'annulleret' and annulleret_auto;
      perform public.fragt_reklamation_log(sys, 'reklamation_genaabnet', s.id, r.saelger_id,
        'Reklamationen er aktiv igen: sagen er igen afgjort til køber med ordentlig indpakning');
      return 'genaabnet';
    end if;

    if r.sag_aendret_kl is not null then
      update public.fragt_reklamationer set sag_aendret_kl = null where id = r.id;
    end if;
    return 'uaendret';
  end if;

  -- Betingelserne er ikke (længere) opfyldt.
  if not v_findes then return 'ikke_relevant'; end if;

  if r.status = 'afventer_saelger' then
    update public.fragt_reklamationer
       set status = 'annulleret', annulleret_auto = true, annulleret_af = sys, annulleret_kl = now(),
           annulleret_grund = 'Sagen er ændret (genåbnet, omgjort eller indpakningen er vurderet på ny).'
     where id = r.id and status = 'afventer_saelger';
    perform public.fragt_reklamation_log(sys, 'reklamation_annulleret', s.id, r.saelger_id,
      'Reklamationen er annulleret automatisk, før sælgeren anmeldte: sagens status er nu ' || s.status);
    return 'annulleret';
  end if;

  if r.status in ('anmeldt', 'godkendt') and r.sag_aendret_kl is null then
    update public.fragt_reklamationer set sag_aendret_kl = now() where id = r.id;
    perform public.fragt_reklamation_log(sys, 'reklamation_sag_aendret', s.id, r.saelger_id,
      'OBS: sagen er ændret (status ' || s.status || '), efter sælgeren har anmeldt skaden hos '
      || upper(r.transportoer) || '. Tjek reklamationen.');
    return 'sag_aendret';
  end if;

  return 'uaendret';
end;
$fn$;

revoke all on function public.fragt_reklamation_synkroniser(uuid) from public, anon, authenticated;
grant execute on function public.fragt_reklamation_synkroniser(uuid) to service_role;

create or replace function public.sager_fragt_reklamation()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.type = 'skadet' then
    perform public.fragt_reklamation_synkroniser(new.id);
  end if;
  return null;
end;
$fn$;

revoke execute on function public.sager_fragt_reklamation() from public, anon, authenticated;

drop trigger if exists sager_fragt_reklamation on public.sager;
create trigger sager_fragt_reklamation
  after update of status on public.sager
  for each row when (new.status is distinct from old.status)
  execute function public.sager_fragt_reklamation();

-- Fælles tjek for staff: kalderen (auth.uid()) er staff med aal2,
-- reklamationen findes (låses), og kalderen er ikke inhabil.
-- kode = null ved ok, ellers en fejlkode.
create or replace function public.fragt_reklamation_tjek(p_reklamation uuid, out kode text, out r public.fragt_reklamationer)
language plpgsql
security definer
set search_path = public
as $fn$
declare
  t record;
begin
  if auth.uid() is null or not public.er_staff() then
    kode := 'ingen_adgang'; return;
  end if;
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  if not found then kode := 'ikke_fundet'; return; end if;
  select buyer_id, seller_id into t from public.trades where id = r.trade_id;
  if public.penge_inhabil(auth.uid(), t.buyer_id, t.seller_id) then
    kode := 'inhabil'; return;
  end if;
  kode := null;
end;
$fn$;

revoke all on function public.fragt_reklamation_tjek(uuid) from public, anon, authenticated;

-- Fælles tjek for sælgeren: kalderen er sælgeren på reklamationen (låses).
create or replace function public.fragt_reklamation_saelger_tjek(p_reklamation uuid, out kode text, out r public.fragt_reklamationer)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null then kode := 'ingen_adgang'; return; end if;
  select * into r from public.fragt_reklamationer where id = p_reklamation for update;
  -- Samme svar, uanset om den ikke findes eller ikke er din.
  if not found or r.saelger_id <> auth.uid() then kode := 'ikke_fundet'; return; end if;
  kode := null;
end;
$fn$;

revoke all on function public.fragt_reklamation_saelger_tjek(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 6. Indpakning: ordentlig / fortryd (staff)
-- ===========================================================================
-- Koder: ok, ingen_adgang, ikke_fundet, inhabil, ikke_skadet, afhentning,
-- allerede_vurderet (+ resultat: ordentlig|paamindelse|advarsel), for_lang_tekst.
-- Svar ved ok: {"kode":"ok","reklamation":"oprettet"|"genaabnet"|"uaendret"|"ikke_relevant"|...}
create or replace function public.indpakning_ordentlig(p_sag uuid, p_intern_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_intern_note, '')), '');
  s      record;
  t      record;
  o      record;
  v_res  text;
begin
  if v_uid is null or not public.er_staff() then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_note is not null and char_length(v_note) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select id, trade_id, type into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select id, buyer_id, seller_id, afhentning into t from public.trades where id = s.trade_id;
  if not found or t.seller_id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if public.penge_inhabil(v_uid, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if s.type <> 'skadet' then return jsonb_build_object('kode', 'ikke_skadet'); end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;

  if exists (select 1 from public.paamindelser where sag_id = s.id and grund = 'daarlig_indpakning') then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'paamindelse');
  end if;
  if exists (select 1 from public.advarsler where sag_id = s.id and grund = 'daarlig_indpakning') then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'advarsel');
  end if;

  select * into o from public.indpakning_ordentlig where sag_id = s.id for update;
  if found and o.tilbagekaldt_kl is null then
    return jsonb_build_object('kode', 'allerede_vurderet', 'resultat', 'ordentlig');
  end if;

  if found then
    update public.indpakning_ordentlig
       set vurderet_af = v_uid, vurderet_kl = now(), intern_note = v_note,
           tilbagekaldt_kl = null, tilbagekaldt_af = null, tilbagekaldt_grund = null
     where sag_id = s.id and tilbagekaldt_kl is not null;
  else
    insert into public.indpakning_ordentlig (sag_id, trade_id, vurderet_af, intern_note)
    values (s.id, t.id, v_uid, v_note);
  end if;

  perform public.fragt_reklamation_log(v_uid, 'indpakning_ordentlig', s.id, t.seller_id,
    'Indpakningen vurderet ordentlig' || coalesce(' | Intern note: ' || v_note, ''));

  v_res := public.fragt_reklamation_synkroniser(s.id);
  return jsonb_build_object('kode', 'ok', 'reklamation', v_res);
end;
$fn$;

revoke all on function public.indpakning_ordentlig(uuid, text) from public, anon;
grant execute on function public.indpakning_ordentlig(uuid, text) to authenticated;

-- Fortryd "ordentlig" (fx fejlklik). Kun så længe sælgeren ikke har
-- anmeldt (en reklamation i 'afventer_saelger' annulleres så automatisk).
-- Koder: ok, ingen_adgang, ikke_fundet, inhabil, grund_mangler,
-- for_lang_tekst, ikke_vurderet, reklamation_anmeldt.
create or replace function public.indpakning_ordentlig_fortryd(p_sag uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
  s       record;
  t       record;
  v_res   text;
begin
  if v_uid is null or not public.er_staff() then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_grund is null then return jsonb_build_object('kode', 'grund_mangler'); end if;
  if char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  select id, trade_id into s from public.sager where id = p_sag for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  select buyer_id, seller_id into t from public.trades where id = s.trade_id;
  if public.penge_inhabil(v_uid, t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if exists (select 1 from public.fragt_reklamationer
              where sag_id = s.id and status in ('anmeldt', 'godkendt', 'afvist')) then
    return jsonb_build_object('kode', 'reklamation_anmeldt');
  end if;

  update public.indpakning_ordentlig
     set tilbagekaldt_kl = now(), tilbagekaldt_af = v_uid, tilbagekaldt_grund = v_grund
   where sag_id = s.id and tilbagekaldt_kl is null;
  if not found then return jsonb_build_object('kode', 'ikke_vurderet'); end if;

  perform public.fragt_reklamation_log(v_uid, 'indpakning_ordentlig_fortrudt', s.id, t.seller_id,
    'Vurderingen "ordentlig indpakning" er fortrudt | ' || v_grund);

  v_res := public.fragt_reklamation_synkroniser(s.id);
  return jsonb_build_object('kode', 'ok', 'reklamation', v_res);
end;
$fn$;

revoke all on function public.indpakning_ordentlig_fortryd(uuid, text) from public, anon;
grant execute on function public.indpakning_ordentlig_fortryd(uuid, text) to authenticated;

-- ===========================================================================
-- 7. Sælgeren registrerer selv (én funktion pr. knap)
-- ===========================================================================
-- Fælles koder: ingen_adgang, ikke_fundet (også: ikke din), forkert_status (+ status).

-- "Anmeldt" (+ fragtfirmaets sagsnummer, valgfrit). Idempotent: kaldt igen
-- på en anmeldt reklamation gemmes kun et nyt sagsnummer.
-- Koder: + for_lang_tekst.
create or replace function public.mit_fragt_reklamation_anmeldt(p_reklamation uuid, p_sagsnummer text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c    record;
  v_nr text := nullif(btrim(coalesce(p_sagsnummer, '')), '');
begin
  select * into c from public.fragt_reklamation_saelger_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_nr is not null and char_length(v_nr) > 100 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;

  if (c.r).status = 'anmeldt' then
    if v_nr is null or v_nr is not distinct from (c.r).transportoerens_sagsnummer then
      return jsonb_build_object('kode', 'ok', 'uaendret', true);
    end if;
    update public.fragt_reklamationer set transportoerens_sagsnummer = v_nr
     where id = (c.r).id and status = 'anmeldt';
  elsif (c.r).status = 'afventer_saelger' then
    update public.fragt_reklamationer
       set status = 'anmeldt', anmeldt_kl = now(), fremdrift_kl = now(),
           transportoerens_sagsnummer = coalesce(v_nr, transportoerens_sagsnummer)
     where id = (c.r).id and status = 'afventer_saelger';
  else
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;

  perform public.fragt_reklamation_log(public.bidhamr_system_id(), 'reklamation_saelger_anmeldt',
    (c.r).sag_id, (c.r).saelger_id,
    'Sælgeren har anmeldt skaden hos ' || upper((c.r).transportoer) || coalesce(' | Sagsnummer: ' || v_nr, ''));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- "Godkendt" (+ beløb, som fragtfirmaet udbetaler direkte til sælgeren).
-- Fra afventer_saelger eller anmeldt. Beløb 1 øre .. kravbeløbet.
-- Koder: + ugyldigt_beloeb (+ maks_oere).
create or replace function public.mit_fragt_reklamation_godkendt(p_reklamation uuid, p_beloeb_oere bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
begin
  select * into c from public.fragt_reklamation_saelger_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if (c.r).status = 'godkendt' and (c.r).godkendt_beloeb_oere = p_beloeb_oere then
    return jsonb_build_object('kode', 'ok', 'uaendret', true);
  end if;
  if (c.r).status not in ('afventer_saelger', 'anmeldt') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if p_beloeb_oere is null or p_beloeb_oere <= 0 or p_beloeb_oere > (c.r).kravbeloeb_oere then
    return jsonb_build_object('kode', 'ugyldigt_beloeb', 'maks_oere', (c.r).kravbeloeb_oere);
  end if;
  update public.fragt_reklamationer
     set status = 'godkendt', godkendt_beloeb_oere = p_beloeb_oere,
         anmeldt_kl = coalesce(anmeldt_kl, now()),
         afgjort_kl = now(), afgjort_af = auth.uid(), fremdrift_kl = now()
   where id = (c.r).id and status in ('afventer_saelger', 'anmeldt');
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(public.bidhamr_system_id(), 'reklamation_saelger_godkendt',
    (c.r).sag_id, (c.r).saelger_id,
    'Sælgeren oplyser: ' || upper((c.r).transportoer) || ' har godkendt og udbetaler '
    || public.fragt_reklamation_kr(p_beloeb_oere) || ' direkte til sælgeren');
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- "Afvist" (+ fragtfirmaets grund, valgfri). Fra afventer_saelger eller anmeldt.
-- Koder: + for_lang_tekst.
create or replace function public.mit_fragt_reklamation_afvist(p_reklamation uuid, p_grund text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c       record;
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
begin
  select * into c from public.fragt_reklamation_saelger_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_grund is not null and char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status = 'afvist' then return jsonb_build_object('kode', 'ok', 'uaendret', true); end if;
  if (c.r).status not in ('afventer_saelger', 'anmeldt') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  update public.fragt_reklamationer
     set status = 'afvist', afvisningsgrund = v_grund,
         anmeldt_kl = coalesce(anmeldt_kl, now()),
         afgjort_kl = now(), afgjort_af = auth.uid(), fremdrift_kl = now()
   where id = (c.r).id and status in ('afventer_saelger', 'anmeldt');
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(public.bidhamr_system_id(), 'reklamation_saelger_afvist',
    (c.r).sag_id, (c.r).saelger_id,
    'Sælgeren oplyser: ' || upper((c.r).transportoer) || ' har afvist reklamationen'
    || coalesce(' | Grund: ' || v_grund, ''));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- "Jeg ønsker ikke at reklamere". Fra afventer_saelger eller anmeldt.
create or replace function public.mit_fragt_reklamation_fravaelg(p_reklamation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
begin
  select * into c from public.fragt_reklamation_saelger_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if (c.r).status = 'fravalgt' then return jsonb_build_object('kode', 'ok', 'uaendret', true); end if;
  if (c.r).status not in ('afventer_saelger', 'anmeldt') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  update public.fragt_reklamationer
     set status = 'fravalgt', fravalgt_kl = now(), fremdrift_kl = now()
   where id = (c.r).id and status in ('afventer_saelger', 'anmeldt');
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(public.bidhamr_system_id(), 'reklamation_saelger_fravalgt',
    (c.r).sag_id, (c.r).saelger_id, 'Sælgeren ønsker ikke at reklamere hos ' || upper((c.r).transportoer));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- ===========================================================================
-- 8. Staff-handlinger (én funktion pr. knap)
-- ===========================================================================
-- Fælles koder: ingen_adgang, ikke_fundet, inhabil, forkert_status (+ status).

-- Intern note (erstatter den forrige; tom tekst rydder). Kun staff ser den.
-- Koder: + for_lang_tekst.
create or replace function public.fragt_reklamation_gem_note(p_reklamation uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_note is not null and char_length(v_note) > 4000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).intern_note is not distinct from v_note then
    return jsonb_build_object('kode', 'ok', 'uaendret', true);
  end if;
  update public.fragt_reklamationer set intern_note = v_note where id = (c.r).id;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_note', (c.r).sag_id, (c.r).saelger_id,
    'Intern note: ' || coalesce(v_note, '(ryddet)'));
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Send pakken/påmindelsen til sælgeren igen (serveren sender beskeden med
-- nøglen reklamation:<id>:gensendt:<gensendt_antal>). Kun mens den er åben.
-- Højst én gang i minuttet (dobbeltklik).
-- Svar ved ok: {"kode":"ok","gensendt_antal":n,"saelger_id","trade_id"}.
-- Koder: + for_hurtigt.
create or replace function public.fragt_reklamation_send_igen(p_reklamation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
  v_antal integer;
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if (c.r).status not in ('afventer_saelger', 'anmeldt') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  if (c.r).gensendt_kl is not null and (c.r).gensendt_kl > now() - interval '1 minute' then
    return jsonb_build_object('kode', 'for_hurtigt');
  end if;
  update public.fragt_reklamationer
     set gensendt_kl = now(), gensendt_af = auth.uid(), gensendt_antal = gensendt_antal + 1
   where id = (c.r).id and status in ('afventer_saelger', 'anmeldt')
  returning gensendt_antal into v_antal;
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_gensendt', (c.r).sag_id, (c.r).saelger_id,
    'Reklamationspakken/påmindelsen er sendt til sælgeren igen (' || v_antal || '. gang)');
  return jsonb_build_object('kode', 'ok', 'gensendt_antal', v_antal,
                            'saelger_id', (c.r).saelger_id, 'trade_id', (c.r).trade_id);
end;
$fn$;

-- Annullér med grund (vises for sælgeren). Fra afventer_saelger eller anmeldt.
-- Koder: + grund_mangler, for_lang_tekst.
create or replace function public.fragt_reklamation_annuller(p_reklamation uuid, p_grund text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c record;
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if v_grund is null then return jsonb_build_object('kode', 'grund_mangler'); end if;
  if char_length(v_grund) > 1000 then return jsonb_build_object('kode', 'for_lang_tekst'); end if;
  if (c.r).status not in ('afventer_saelger', 'anmeldt') then
    return jsonb_build_object('kode', 'forkert_status', 'status', (c.r).status);
  end if;
  update public.fragt_reklamationer
     set status = 'annulleret', annulleret_auto = false, annulleret_grund = v_grund,
         annulleret_af = auth.uid(), annulleret_kl = now()
   where id = (c.r).id and status in ('afventer_saelger', 'anmeldt');
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_annulleret', (c.r).sag_id, (c.r).saelger_id,
    'Reklamationen er annulleret (status var ' || (c.r).status || ') | Til sælgeren: ' || v_grund);
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

-- Ret status, hvis sælgeren har registreret forkert (eller fx har ringet).
-- p_status: afventer_saelger | anmeldt | godkendt (kræver p_beloeb_oere) |
-- afvist (p_grund valgfri) | fravalgt. p_sagsnummer: valgfrit (bevares ellers).
-- p_begrundelse: intern, påkrævet - logges.
-- Koder: + ugyldig_status, begrundelse_mangler, for_lang_tekst,
-- ugyldigt_beloeb (+ maks_oere), uaendret.
create or replace function public.fragt_reklamation_ret_status(
  p_reklamation uuid, p_status text, p_beloeb_oere bigint, p_sagsnummer text,
  p_grund text, p_begrundelse text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c       record;
  v_nr    text := nullif(btrim(coalesce(p_sagsnummer, '')), '');
  v_grund text := nullif(btrim(coalesce(p_grund, '')), '');
  v_beg   text := nullif(btrim(coalesce(p_begrundelse, '')), '');
begin
  select * into c from public.fragt_reklamation_tjek(p_reklamation);
  if c.kode is not null then return jsonb_build_object('kode', c.kode); end if;
  if p_status is null or p_status not in ('afventer_saelger', 'anmeldt', 'godkendt', 'afvist', 'fravalgt') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if v_beg is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if char_length(v_beg) > 2000 or char_length(coalesce(v_grund, '')) > 1000
     or char_length(coalesce(v_nr, '')) > 100 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;
  if p_status = 'godkendt'
     and (p_beloeb_oere is null or p_beloeb_oere <= 0 or p_beloeb_oere > (c.r).kravbeloeb_oere) then
    return jsonb_build_object('kode', 'ugyldigt_beloeb', 'maks_oere', (c.r).kravbeloeb_oere);
  end if;
  if (c.r).status = p_status
     and (p_status <> 'godkendt' or (c.r).godkendt_beloeb_oere = p_beloeb_oere)
     and (v_nr is null or v_nr is not distinct from (c.r).transportoerens_sagsnummer)
     and (p_status <> 'afvist' or v_grund is not distinct from (c.r).afvisningsgrund) then
    return jsonb_build_object('kode', 'uaendret');
  end if;

  update public.fragt_reklamationer
     set status = p_status,
         transportoerens_sagsnummer = coalesce(v_nr, transportoerens_sagsnummer),
         godkendt_beloeb_oere = case when p_status = 'godkendt' then p_beloeb_oere end,
         afvisningsgrund = case when p_status = 'afvist' then v_grund end,
         anmeldt_kl = case when p_status = 'afventer_saelger' then null
                           else coalesce(anmeldt_kl, case when p_status <> 'fravalgt' then now() end) end,
         afgjort_kl = case when p_status in ('godkendt', 'afvist') then now() end,
         afgjort_af = case when p_status in ('godkendt', 'afvist') then auth.uid() end,
         fravalgt_kl = case when p_status = 'fravalgt' then now() end,
         annulleret_auto = false, annulleret_grund = null, annulleret_af = null, annulleret_kl = null,
         aktiv_fra_kl = case when p_status = 'afventer_saelger' then now() else aktiv_fra_kl end,
         fremdrift_kl = now()
   where id = (c.r).id and status = (c.r).status;
  if not found then return jsonb_build_object('kode', 'forkert_status'); end if;

  perform public.fragt_reklamation_log(auth.uid(), 'reklamation_status_rettet', (c.r).sag_id, (c.r).saelger_id,
    'Status rettet: ' || (c.r).status || ' -> ' || p_status
    || case when p_status = 'godkendt' then ' (' || public.fragt_reklamation_kr(p_beloeb_oere) || ')' else '' end
    || coalesce(' | Sagsnummer: ' || v_nr, '') || coalesce(' | Grund: ' || v_grund, '')
    || ' | Begrundelse: ' || v_beg);
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.mit_fragt_reklamation_anmeldt(uuid,text)',
    'public.mit_fragt_reklamation_godkendt(uuid,bigint)',
    'public.mit_fragt_reklamation_afvist(uuid,text)',
    'public.mit_fragt_reklamation_fravaelg(uuid)',
    'public.fragt_reklamation_gem_note(uuid,text)',
    'public.fragt_reklamation_send_igen(uuid)',
    'public.fragt_reklamation_annuller(uuid,text)',
    'public.fragt_reklamation_ret_status(uuid,text,bigint,text,text,text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $do$;

-- ===========================================================================
-- 9. Sælgerens visning, pakke-adgang og admin-tællere
-- ===========================================================================
-- Kun offentlige felter. Sælgeren udledes af auth.uid(). p_trade = null: alle.
create or replace function public.mine_fragt_reklamationer(p_trade uuid default null)
returns table (
  id uuid, sag_id uuid, trade_id uuid, transportoer text, status text,
  trackingnummer text, varens_vaerdi_oere bigint, kravbeloeb_oere bigint,
  maks_erstatning_oere bigint, godkendt_beloeb_oere bigint,
  afvisningsgrund text, annulleret_grund text, transportoerens_sagsnummer text,
  oprettet_kl timestamptz, anmeldt_kl timestamptz, afgjort_kl timestamptz,
  fravalgt_kl timestamptz, annulleret_kl timestamptz)
language sql
stable
security definer
set search_path = public
as $fn$
  select r.id, r.sag_id, r.trade_id, r.transportoer, r.status,
         r.trackingnummer, r.varens_vaerdi_oere, r.kravbeloeb_oere,
         r.maks_erstatning_oere, r.godkendt_beloeb_oere,
         r.afvisningsgrund, r.annulleret_grund, r.transportoerens_sagsnummer,
         r.oprettet_kl, r.anmeldt_kl, r.afgjort_kl, r.fravalgt_kl, r.annulleret_kl
    from public.fragt_reklamationer r
   where auth.uid() is not null
     and r.saelger_id = auth.uid()
     -- En annullering, systemet lavede (sagen ændret), vises ikke for sælgeren.
     and not (r.status = 'annulleret' and r.annulleret_auto)
     and (p_trade is null or r.trade_id = p_trade)
   order by r.oprettet_kl desc;
$fn$;

revoke all on function public.mine_fragt_reklamationer(uuid) from public, anon;
grant execute on function public.mine_fragt_reklamationer(uuid) to authenticated;

-- Må den indloggede hente reklamationspakken (felter + billeder)? Kun
-- sælgeren på reklamationen, og kun mens den er åben (afventer_saelger,
-- anmeldt). Serveren bygger pakken bagefter med service-role og udelader
-- købers kontaktoplysninger (src/lib/reklamation/pakke.ts).
create or replace function public.min_reklamationspakke_adgang(p_reklamation uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select auth.uid() is not null and exists (
    select 1 from public.fragt_reklamationer r
     where r.id = p_reklamation and r.saelger_id = auth.uid()
       and r.status in ('afventer_saelger', 'anmeldt'));
$fn$;

revoke all on function public.min_reklamationspakke_adgang(uuid) from public, anon;
grant execute on function public.min_reklamationspakke_adgang(uuid) to authenticated;

-- Admin-lampe (alle staff). Ikke-staff: alt 0.
--   afventer_saelger: sælgeren har ikke anmeldt endnu.
--   stille:           åben (afventer_saelger/anmeldt) uden fremdrift i 14 dage.
--   sag_aendret:      sagen er ændret, efter sælgeren anmeldte.
create or replace function public.fragt_reklamationer_antal()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when not public.er_staff() then
           jsonb_build_object('afventer_saelger', 0, 'stille', 0, 'sag_aendret', 0)
         else jsonb_build_object(
           'afventer_saelger', (select count(*) from public.fragt_reklamationer where status = 'afventer_saelger'),
           'stille', (select count(*) from public.fragt_reklamationer
                       where status in ('afventer_saelger', 'anmeldt')
                         and fremdrift_kl < now() - interval '14 days'),
           'sag_aendret', (select count(*) from public.fragt_reklamationer
                            where status in ('anmeldt', 'godkendt') and sag_aendret_kl is not null))
         end;
$fn$;

revoke all on function public.fragt_reklamationer_antal() from public, anon;
grant execute on function public.fragt_reklamationer_antal() to authenticated;

-- Eksisterende sager: en skadet sag, der allerede er afgjort til køber, får
-- først en reklamation, når staff vurderer indpakningen som ordentlig
-- (indpakning_ordentlig er ny, så ingen opfylder betingelserne i dag).
