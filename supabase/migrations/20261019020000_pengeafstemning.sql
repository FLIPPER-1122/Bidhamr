-- =====================================================================
-- Sikkerhedsnet B: daglig pengeafstemning med Stripe, reserve (kun
-- visning, SLÅET FRA) og økonomioverblik i Admin -> Penge (kun chef).
-- =====================================================================
--
-- INGEN penge flyttes af noget i denne migration. BidHamr har ingen wallet:
-- købers penge står på sælgerens Stripe Connect-konto, og platformens saldo
-- hos Stripe er BidHamrs gebyrer. Alt her er bogføring og visning.
--
--   1. penge_konfiguration       én række: reserven (slået fra, 0 %) - kun chef
--   2. penge_afstemning_koersler log over hver daglig afstemning
--   3. penge_afstemning_afvigelser uoverensstemmelser mellem Stripe og databasen
--   4. penge_saldo_snapshot      platformens saldo hos Stripe (fra afstemningen
--                                 og fra Admin -> Penge), så databasen altid
--                                 kan vise den seneste kendte saldo
--   5. Funktioner (kun service role): claim/afslut af kørslen, registrering af
--      afvigelser, snapshot, chefens konfiguration og "markér som løst",
--      admin_penge_reserve (overblikket) og admin_penge_posteringer (seneste
--      posteringer og månedens CSV).
--
-- Rører IKKE eksisterende funktioner (sikkerhedsnet A ændrer
-- betaling_udbetaling_blokeret, saelger_udbetaling_claim, admin_frigiv_handel
-- og handel_auto_frigiv i 20261019010000) - derfor intet md5-drift-tjek.
-- Kan køres flere gange (if not exists / create or replace / on conflict).
--
-- Reserven (Niels' oplæg, chefens forslag): ROADMAP-BESLUTNINGER siger
-- "Reserve-/bufferkonto bygges IKKE". Den er derfor bygget SLÅET FRA
-- (slaaet_til = false, procent 0) og vises ikke, før chefen slår den til -
-- afventer Filips beslutning. Selv slået til flytter den aldrig penge.

-- ---------------------------------------------------------------------
-- 0. Forudsætninger
-- ---------------------------------------------------------------------
do $do$
begin
  if to_regclass('public.betalinger') is null
     or to_regclass('public.saelger_udbetalinger') is null
     or to_regclass('public.betaling_afvigelser') is null then
    raise exception 'pengeafstemning: betalingsmodellens tabeller mangler (kør trin 1-5 først)';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'betalinger'
                    and column_name = 'indsigelse_tabt_afklaret') then
    raise exception 'pengeafstemning: 20261011041000 (trin 4-rettelser) er ikke kørt';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'betalinger'
                    and column_name = 'bidhamr_daekker_refunderet_kl') then
    raise exception 'pengeafstemning: sikkerhedsnet A (20261019010000_pengesikkerhed) er ikke kørt - kør den først';
  end if;
  if to_regprocedure('public.staff_chat_har_rolle(uuid, text)') is null then
    raise exception 'pengeafstemning: staff_chat_har_rolle mangler';
  end if;
end $do$;

-- ---------------------------------------------------------------------
-- 1. Konfiguration (én række, kun chef ændrer den)
-- ---------------------------------------------------------------------
create table if not exists public.penge_konfiguration (
  id                     boolean primary key default true check (id),
  -- Reserven er slået fra, til Filip har besluttet sig (se toppen).
  reserve_slaaet_til     boolean not null default false,
  -- Reserven = mindst procent af BidHamrs gebyrer de seneste N dage ...
  reserve_procent        numeric(5,2) not null default 0
                           check (reserve_procent >= 0 and reserve_procent <= 100),
  reserve_periode_dage   integer not null default 90
                           check (reserve_periode_dage between 7 and 365),
  -- ... men aldrig under et fast minimum ...
  reserve_minimum_oere   bigint not null default 0 check (reserve_minimum_oere >= 0),
  -- ... og aldrig under åbne indsigelser + forventede tab (chefens skøn).
  forventet_tab_oere     bigint not null default 0 check (forventet_tab_oere >= 0),
  aendret_kl             timestamptz not null default now(),
  aendret_af             uuid references public.users(id) on delete restrict
);

comment on table public.penge_konfiguration is
  'Pengeoverblikkets konfiguration (kun chef): reserven. Kun visning - flytter aldrig penge. Reserven er slået fra (afventer Filip; ROADMAP-BESLUTNINGER: "Reserve-/bufferkonto bygges IKKE").';

insert into public.penge_konfiguration (id) values (true) on conflict (id) do nothing;

alter table public.penge_konfiguration enable row level security;
revoke all on table public.penge_konfiguration from public, anon, authenticated;
grant select on table public.penge_konfiguration to service_role;

-- Hver ændring (hvem, hvornår, hvad). Slettes aldrig.
create table if not exists public.penge_konfiguration_historik (
  id                   bigint generated always as identity primary key,
  aendret_kl           timestamptz not null default now(),
  aendret_af           uuid not null references public.users(id) on delete restrict,
  reserve_slaaet_til   boolean not null,
  reserve_procent      numeric(5,2) not null,
  reserve_periode_dage integer not null,
  reserve_minimum_oere bigint not null,
  forventet_tab_oere   bigint not null
);

alter table public.penge_konfiguration_historik enable row level security;
revoke all on table public.penge_konfiguration_historik from public, anon, authenticated;
grant select on table public.penge_konfiguration_historik to service_role;

-- ---------------------------------------------------------------------
-- 2. Kørsler
-- ---------------------------------------------------------------------
create table if not exists public.penge_afstemning_koersler (
  id                bigint generated always as identity primary key,
  startet_kl        timestamptz not null default now(),
  afsluttet_kl      timestamptz,
  ok                boolean,
  fejl              text check (fejl is null or char_length(fejl) <= 2000),
  -- Kun tal (antal tjekket, summer i øre) - aldrig persondata.
  resultat          jsonb,
  antal_afvigelser  integer not null default 0 check (antal_afvigelser >= 0),
  antal_nye         integer not null default 0 check (antal_nye >= 0)
);

comment on table public.penge_afstemning_koersler is
  'Log over den daglige pengeafstemning med Stripe (src/lib/betaling/afstemning.ts). Slettes ikke.';

-- Kørslen nåede ikke alle trin (tidsbudgettet). Blokerer kun i 2 timer, og
-- næste kørsel starter ved det første trin, der ikke blev nået.
alter table public.penge_afstemning_koersler
  add column if not exists ufuldstaendig boolean not null default false;

create index if not exists penge_afstemning_koersler_startet_idx
  on public.penge_afstemning_koersler (startet_kl desc);

alter table public.penge_afstemning_koersler enable row level security;
revoke all on table public.penge_afstemning_koersler from public, anon, authenticated;
grant select on table public.penge_afstemning_koersler to service_role;

-- ---------------------------------------------------------------------
-- 3. Afvigelser
-- ---------------------------------------------------------------------
create table if not exists public.penge_afstemning_afvigelser (
  id                 uuid primary key default gen_random_uuid(),
  -- Fast nøgle uden persondata, fx "gebyr:fee_123" - én række pr. tilfælde.
  noegle             text not null unique check (char_length(noegle) between 1 and 200),
  type               text not null check (type in (
                       'ukendt_betaling',        -- PaymentIntent hos Stripe, som databasen ikke kender
                       'betaling_status',        -- betalt hos Stripe, ikke i databasen (eller omvendt)
                       'betaling_beloeb',        -- modtaget beløb <> databasens total
                       'gebyr',                  -- application fee/gebyr-refusion <> databasen
                       'ukendt_gebyr',           -- application fee uden betaling i databasen
                       'refusion_udenom',        -- refusion lavet uden for BidHamr (dashboardet)
                       'tilbagefoersel_udenom',  -- transfer reversal uden for BidHamr
                       'udbetaling_ukendt',      -- payout på sælgerkonto, som BidHamr ikke har lavet
                       'udbetaling_afviger',     -- payout-beløb/status <> saelger_udbetalinger
                       'udbetaling_mangler',     -- saelger_udbetalinger siger sendt, Stripe kender den ikke
                       'abonnement_indsigelse',  -- indsigelse på en abonnementsfaktura (firma)
                       'ukendt_indsigelse',      -- indsigelse, der hverken er handel eller abonnement
                       'gebyrsum'                -- summen af gebyrer passer ikke
                     )),
  stripe_id          text check (stripe_id is null or char_length(stripe_id) <= 200),
  betaling_id        uuid references public.betalinger(id) on delete restrict,
  stripe_konto       text check (stripe_konto is null or char_length(stripe_konto) <= 100),
  -- Ingen persondata - kun id'er og tal.
  beskrivelse        text not null check (char_length(beskrivelse) between 1 and 1000),
  beloeb_stripe_oere bigint,
  beloeb_db_oere     bigint,
  foerste_koersel_id bigint references public.penge_afstemning_koersler(id) on delete restrict,
  sidste_koersel_id  bigint references public.penge_afstemning_koersler(id) on delete restrict,
  foerst_set_kl      timestamptz not null default now(),
  sidst_set_kl       timestamptz not null default now(),
  antal_set          integer not null default 1 check (antal_set >= 1),
  loest_kl           timestamptz,
  loest_af           uuid references public.users(id) on delete restrict,
  loest_note         text check (loest_note is null or char_length(loest_note) <= 1000),
  constraint penge_afvigelse_loest_par check ((loest_kl is null) = (loest_af is null))
);

comment on table public.penge_afstemning_afvigelser is
  'Uoverensstemmelser fra den daglige afstemning med Stripe. Én række pr. tilfælde (noegle); chefen markerer dem løst (med note). Slettes aldrig.';

create index if not exists penge_afstemning_afvigelser_aaben_idx
  on public.penge_afstemning_afvigelser (sidst_set_kl desc) where loest_kl is null;

alter table public.penge_afstemning_afvigelser enable row level security;
revoke all on table public.penge_afstemning_afvigelser from public, anon, authenticated;
grant select on table public.penge_afstemning_afvigelser to service_role;

-- ---------------------------------------------------------------------
-- 4. Saldo-snapshots
-- ---------------------------------------------------------------------
create table if not exists public.penge_saldo_snapshot (
  id                        bigint generated always as identity primary key,
  kl                        timestamptz not null default now(),
  kilde                     text not null check (kilde in ('afstemning', 'admin')),
  livemode                  boolean not null,
  -- Platformens saldo hos Stripe (DKK, øre) = BidHamrs penge.
  platform_tilgaengelig_oere bigint not null,
  platform_afventer_oere     bigint not null,
  -- Summen af sælgernes Connect-saldi, som afstemningen hentede (null = ikke
  -- hentet, fx fra Admin -> Penge), og hvor mange konti det dækker.
  saelgere_stripe_oere      bigint,
  saelgerkonti              integer check (saelgerkonti is null or saelgerkonti >= 0)
);

comment on table public.penge_saldo_snapshot is
  'Platformens saldo hos Stripe (BidHamrs penge), gemt af afstemningen og Admin -> Penge, så databasen altid kan vise den seneste kendte saldo. Kun visning.';

create index if not exists penge_saldo_snapshot_kl_idx on public.penge_saldo_snapshot (kl desc);

alter table public.penge_saldo_snapshot enable row level security;
revoke all on table public.penge_saldo_snapshot from public, anon, authenticated;
grant select on table public.penge_saldo_snapshot to service_role;

-- Overvågningens tjek H (udeblevne payment_intent-webhooks): hvornår hver
-- ventende betaling sidst blev slået op hos Stripe, så de ældste ventende også
-- kommer med (rotation - højst 100 opslag pr. kørsel). Kun drift-data.
create table if not exists public.betaling_webhook_tjek (
  betaling_id      uuid primary key references public.betalinger(id) on delete restrict,
  sidst_tjekket_kl timestamptz not null default now()
);

comment on table public.betaling_webhook_tjek is
  'Overvågningen (opsamlUdebleveneBetalinger): sidste opslag hos Stripe pr. ventende betaling. Kun service role.';

alter table public.betaling_webhook_tjek enable row level security;
revoke all on table public.betaling_webhook_tjek from public, anon, authenticated;
grant select, insert, update on table public.betaling_webhook_tjek to service_role;

-- Service role (serveren) kan kun læse logs, afvigelser, snapshots og
-- konfiguration - alle ændringer går gennem funktionerne herunder (security
-- definer). Supabase giver ellers service role alle rettigheder på nye
-- tabeller som standard. Intet i koden sletter fra dem.
revoke insert, update, delete, truncate on table
  public.penge_konfiguration,
  public.penge_konfiguration_historik,
  public.penge_afstemning_koersler,
  public.penge_afstemning_afvigelser,
  public.penge_saldo_snapshot
  from service_role;
revoke delete, truncate on table public.betaling_webhook_tjek from service_role;

-- Ingen sletning af logs/afvigelser/snapshots (bogføringsloven - handelsdata
-- og deres afstemning bevares). Samme funktion som for betalinger.
drop trigger if exists penge_afstemning_koersler_forbyd_sletning on public.penge_afstemning_koersler;
create trigger penge_afstemning_koersler_forbyd_sletning
  before delete on public.penge_afstemning_koersler
  for each row execute function public.betalinger_forbyd_sletning();
drop trigger if exists penge_afstemning_afvigelser_forbyd_sletning on public.penge_afstemning_afvigelser;
create trigger penge_afstemning_afvigelser_forbyd_sletning
  before delete on public.penge_afstemning_afvigelser
  for each row execute function public.betalinger_forbyd_sletning();
-- Historikken kan hverken ændres eller slettes.
create or replace function public.penge_konfiguration_historik_laast()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'penge_konfiguration_historik kan ikke ændres eller slettes';
end;
$fn$;
revoke all on function public.penge_konfiguration_historik_laast() from public, anon, authenticated;

drop trigger if exists penge_konfiguration_historik_forbyd_sletning on public.penge_konfiguration_historik;
drop trigger if exists penge_konfiguration_historik_laast on public.penge_konfiguration_historik;
create trigger penge_konfiguration_historik_laast
  before update or delete on public.penge_konfiguration_historik
  for each row execute function public.penge_konfiguration_historik_laast();
drop trigger if exists penge_saldo_snapshot_forbyd_sletning on public.penge_saldo_snapshot;
create trigger penge_saldo_snapshot_forbyd_sletning
  before delete on public.penge_saldo_snapshot
  for each row execute function public.betalinger_forbyd_sletning();

-- ---------------------------------------------------------------------
-- 5a. Kørslen: claim og afslutning
-- ---------------------------------------------------------------------
-- Ny kørsel, hvis ingen er startet inden for p_timer timer (en kørsel, der
-- ikke er afsluttet efter 2 timer, regnes som død). Serialiseret med en
-- advisory lock, så to samtidige cron-kald aldrig begge kører. null = ikke nu.
create or replace function public.penge_afstemning_claim(p_timer integer)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id bigint;
begin
  if p_timer is null or p_timer < 0 or p_timer > 24 * 7 then
    raise exception 'penge_afstemning_claim: ugyldigt interval';
  end if;
  perform pg_advisory_xact_lock(hashtext('bidhamr.penge_afstemning'));
  -- Blokerer: en vellykket, fuldstændig kørsel inden for intervallet, eller
  -- en fejlet/ufuldstændig/afbrudt kørsel inden for de seneste 2 timer (så
  -- prøves der igen).
  if exists (
    select 1 from public.penge_afstemning_koersler k
     where k.startet_kl > now() - make_interval(hours => p_timer)
       and (   (k.afsluttet_kl is not null and coalesce(k.ok, false) and not k.ufuldstaendig)
            or (k.afsluttet_kl is not null and (not coalesce(k.ok, false) or k.ufuldstaendig)
                and k.afsluttet_kl > now() - interval '2 hours')
            or (k.afsluttet_kl is null and k.startet_kl > now() - interval '2 hours'))
  ) then
    return null;
  end if;
  insert into public.penge_afstemning_koersler default values returning id into v_id;
  return v_id;
end;
$fn$;

revoke all on function public.penge_afstemning_claim(integer) from public, anon, authenticated;
grant execute on function public.penge_afstemning_claim(integer) to service_role;

create or replace function public.penge_afstemning_afslut(
  p_koersel  bigint,
  p_ok       boolean,
  p_fejl     text,
  p_resultat jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.penge_afstemning_koersler k
     set afsluttet_kl = now(),
         ok = coalesce(p_ok, false),
         ufuldstaendig = coalesce((p_resultat->>'ufuldstaendig')::integer, 0) > 0,
         fejl = left(p_fejl, 2000),
         resultat = p_resultat,
         antal_afvigelser = (select count(*) from public.penge_afstemning_afvigelser a
                              where a.sidste_koersel_id = p_koersel),
         antal_nye = (select count(*) from public.penge_afstemning_afvigelser a
                       where a.sidste_koersel_id = p_koersel and a.foerste_koersel_id = p_koersel)
   where k.id = p_koersel and k.afsluttet_kl is null;
end;
$fn$;

revoke all on function public.penge_afstemning_afslut(bigint, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.penge_afstemning_afslut(bigint, boolean, text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 5b. Afvigelser
-- ---------------------------------------------------------------------
-- true = ny afvigelse (eller genopstået efter at være markeret løst): giv
-- drift-alarm. false = kendt og stadig åben (kun "sidst set" opdateres).
create or replace function public.penge_afvigelse_registrer(
  p_koersel      bigint,
  p_noegle       text,
  p_type         text,
  p_stripe_id    text,
  p_betaling     uuid,
  p_stripe_konto text,
  p_beskrivelse  text,
  p_beloeb_stripe bigint,
  p_beloeb_db    bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ny boolean;
begin
  if p_noegle is null or char_length(p_noegle) not between 1 and 200 then
    raise exception 'penge_afvigelse_registrer: ugyldig nøgle';
  end if;
  -- Ny = findes ikke, eller er markeret løst (genopstået).
  perform 1 from public.penge_afstemning_afvigelser a where a.noegle = p_noegle for update;
  v_ny := not exists (select 1 from public.penge_afstemning_afvigelser a
                       where a.noegle = p_noegle and a.loest_kl is null);
  insert into public.penge_afstemning_afvigelser as a (
    noegle, type, stripe_id, betaling_id, stripe_konto, beskrivelse,
    beloeb_stripe_oere, beloeb_db_oere, foerste_koersel_id, sidste_koersel_id)
  values (
    p_noegle, p_type, left(p_stripe_id, 200),
    -- En betaling, der ikke findes, gemmes ikke som reference.
    (select b.id from public.betalinger b where b.id = p_betaling),
    left(p_stripe_konto, 100), left(coalesce(nullif(btrim(p_beskrivelse), ''), p_type), 1000),
    p_beloeb_stripe, p_beloeb_db, p_koersel, p_koersel)
  on conflict (noegle) do update
     set sidst_set_kl = now(),
         sidste_koersel_id = excluded.sidste_koersel_id,
         antal_set = a.antal_set + 1,
         beskrivelse = excluded.beskrivelse,
         beloeb_stripe_oere = excluded.beloeb_stripe_oere,
         beloeb_db_oere = excluded.beloeb_db_oere,
         -- Markeret løst, men stadig forkert: åbnes igen (ny alarm).
         foerste_koersel_id = case when a.loest_kl is not null then excluded.foerste_koersel_id
                                   else a.foerste_koersel_id end,
         loest_kl = null,
         loest_af = null;
  return v_ny;
end;
$fn$;

revoke all on function public.penge_afvigelse_registrer(bigint, text, text, text, uuid, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.penge_afvigelse_registrer(bigint, text, text, text, uuid, text, text, bigint, bigint) to service_role;

-- Chefen markerer en afvigelse løst (note kræves). Kun chef.
create or replace function public.admin_penge_afvigelse_loes(p_chef uuid, p_id uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  n integer;
begin
  if p_chef is null or not public.staff_chat_har_rolle(p_chef, 'chef') then return 'ingen_adgang'; end if;
  if v_note is null then return 'note_mangler'; end if;
  if char_length(v_note) > 1000 then return 'for_lang'; end if;
  update public.penge_afstemning_afvigelser
     set loest_kl = now(), loest_af = p_chef, loest_note = v_note
   where id = p_id and loest_kl is null;
  get diagnostics n = row_count;
  if n = 0 then return 'ikke_fundet'; end if;
  -- Hvem og hvorfor står på rækken (loest_af, loest_note).
  return 'ok';
end;
$fn$;

revoke all on function public.admin_penge_afvigelse_loes(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_penge_afvigelse_loes(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 5c. Konfiguration (kun chef)
-- ---------------------------------------------------------------------
create or replace function public.admin_penge_konfiguration_gem(
  p_chef           uuid,
  p_slaaet_til     boolean,
  p_procent        numeric,
  p_periode_dage   integer,
  p_minimum_oere   bigint,
  p_forventet_tab_oere bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_chef is null or not public.staff_chat_har_rolle(p_chef, 'chef') then return 'ingen_adgang'; end if;
  if p_slaaet_til is null
     or p_procent is null or p_procent < 0 or p_procent > 100
     or p_periode_dage is null or p_periode_dage not between 7 and 365
     or p_minimum_oere is null or p_minimum_oere < 0
     or p_forventet_tab_oere is null or p_forventet_tab_oere < 0 then
    return 'ugyldig';
  end if;
  update public.penge_konfiguration
     set reserve_slaaet_til = p_slaaet_til,
         reserve_procent = round(p_procent, 2),
         reserve_periode_dage = p_periode_dage,
         reserve_minimum_oere = p_minimum_oere,
         forventet_tab_oere = p_forventet_tab_oere,
         aendret_kl = now(),
         aendret_af = p_chef
   where id;
  insert into public.penge_konfiguration_historik (aendret_af, reserve_slaaet_til, reserve_procent,
                                                   reserve_periode_dage, reserve_minimum_oere, forventet_tab_oere)
  values (p_chef, p_slaaet_til, round(p_procent, 2), p_periode_dage, p_minimum_oere, p_forventet_tab_oere);
  return 'ok';
end;
$fn$;

revoke all on function public.admin_penge_konfiguration_gem(uuid, boolean, numeric, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.admin_penge_konfiguration_gem(uuid, boolean, numeric, integer, bigint, bigint) to service_role;

-- ---------------------------------------------------------------------
-- 5d. Snapshot
-- ---------------------------------------------------------------------
-- Fra Admin -> Penge gemmes højst ét snapshot pr. 10 minutter (siden kan
-- genindlæses ofte); afstemningen gemmer altid.
create or replace function public.penge_saldo_snapshot_gem(
  p_kilde        text,
  p_livemode     boolean,
  p_tilgaengelig bigint,
  p_afventer     bigint,
  p_saelgere     bigint,
  p_konti        integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_kilde not in ('afstemning', 'admin') or p_livemode is null
     or p_tilgaengelig is null or p_afventer is null then
    raise exception 'penge_saldo_snapshot_gem: ugyldige værdier';
  end if;
  if p_kilde = 'admin' and exists (
    select 1 from public.penge_saldo_snapshot s
     where s.kilde = 'admin' and s.kl > now() - interval '10 minutes') then
    return false;
  end if;
  insert into public.penge_saldo_snapshot (kilde, livemode, platform_tilgaengelig_oere,
                                           platform_afventer_oere, saelgere_stripe_oere, saelgerkonti)
  values (p_kilde, p_livemode, p_tilgaengelig, p_afventer, p_saelgere, p_konti);
  return true;
end;
$fn$;

revoke all on function public.penge_saldo_snapshot_gem(text, boolean, bigint, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.penge_saldo_snapshot_gem(text, boolean, bigint, bigint, bigint, integer) to service_role;

-- ---------------------------------------------------------------------
-- 5e. Overblikket: hvad er sælgernes, hvad er BidHamrs, og (hvis slået
--     til) hvad er reserve. p_tilgaengelig_oere = platformens tilgængelige
--     saldo lige nu (fra Stripe); null = brug seneste snapshot.
-- ---------------------------------------------------------------------
-- Sælgernes penge (på deres Connect-konti, ikke udbetalt) regnes som
-- skyldigOere/staarPaaKontoen i src/lib/betaling/udbetaling.ts:
--   U (+ G, når gebyret er refunderet) (- (U + G), når tilbageført)
--   (- det tilbageførte ved tabt indsigelse), aldrig under 0 pr. handel.
-- BidHamr skylder købere (platformens saldo dækker det):
--   refusioner, hvor sælgerens del er tilbageført, men køberen endnu ikke
--   refunderet, og betalinger med forkert beløb, der ikke er refunderet.
-- Reserven (kun når slået til): mindst procent af BidHamrs gebyrer
-- (application fee minus gebyr-refusioner) for betalinger de seneste N dage,
-- mindst det faste minimum, og mindst åbne indsigelser + forventede tab.
-- Tab ved tabte indsigelser efter udbetaling i samme periode (BidHamr bærer
-- sælgerens del + fragt - samme tal som admin_penge_tal) trækkes fra
-- reserven. Kan trækkes ud = tilgængelig - skyldig til købere - reserven
-- tilbage (aldrig under 0).
create or replace function public.penge_reserve_beregn(p_tilgaengelig_oere bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with k as (
    select * from public.penge_konfiguration where id
  ),
  dest as (
    select b.* from public.betalinger b where b.pengemodel = 'destination'
  ),
  saelgere as (
    select coalesce(sum(greatest(0,
             d.udbetaling_oere
             + case when d.gebyr_refunderet_kl is not null then coalesce(d.refusion_gebyr_oere, 0) else 0 end
             - case when d.refusion_tilbagefoert_kl is not null
                    then d.udbetaling_oere + coalesce(d.refusion_gebyr_oere, 0) else 0 end
             - case when d.indsigelse_tilbagefoersel_id is not null
                    then coalesce(d.indsigelse_tilbagefoert_oere, 0) else 0 end)), 0)::bigint as oere,
           count(*)::integer as antal,
           count(distinct d.saelger_stripe_konto)::integer as konti
      from dest d
     where d.status = 'betalt' and d.saelger_udbetaling_id is null
  ),
  paa_vej as (
    select coalesce(sum(u.beloeb_oere), 0)::bigint as oere, count(*)::integer as antal
      from public.saelger_udbetalinger u
     where u.status in ('claimet', 'usikker', 'oprettet')
  ),
  skylder as (
    select (select coalesce(sum(coalesce(d.refusion_oere, d.total_oere)), 0)
              from dest d
             where d.status = 'betalt' and d.refusion_tilbagefoert_kl is not null)::bigint
         + (select coalesce(sum(a.modtaget_oere), 0)
              from public.betaling_afvigelser a where a.refunderet_kl is null)::bigint
         -- "BidHamr dækker" (sikkerhedsnet A): claimet af chefen, men endnu
         -- ikke refunderet - BidHamr skal betale køberen af sin egen saldo.
         + (select coalesce(sum(d.bidhamr_daekker_oere), 0)
              from dest d
             where d.bidhamr_daekker_kl is not null
               and d.bidhamr_daekker_refunderet_kl is null
               and d.status <> 'refunderet')::bigint as oere
  ),
  gebyrer as (
    select coalesce(sum(d.application_fee_oere
             - case when d.gebyr_refunderet_kl is not null then coalesce(d.refusion_gebyr_oere, 0) else 0 end), 0)::bigint as oere
      from dest d, k
     where d.betalt_kl is not null
       and d.application_fee_oere is not null
       and d.betalt_kl >= now() - make_interval(days => k.reserve_periode_dage)
  ),
  aabne as (
    select (select coalesce(sum(d.total_oere), 0)
              from dest d
             where d.indsigelse_kl is not null
               and coalesce(d.indsigelse_status, '') not in ('won', 'lost', 'warning_closed', 'prevented'))::bigint
         + (select coalesce(sum(coalesce(a.beloeb_stripe_oere, 0)), 0)
              from public.penge_afstemning_afvigelser a
             where a.type = 'abonnement_indsigelse' and a.loest_kl is null)::bigint as oere
  ),
  tab as (
    select coalesce(sum(d.udbetaling_oere + d.fragt_oere), 0)::bigint as oere, count(*)::integer as antal
      from dest d, k
     where d.indsigelse_tabt_afklaret = 'udbetalt'
       and coalesce(d.indsigelse_tabt_afklaret_kl, d.indsigelse_tabt_kl, d.opdateret)
           >= now() - make_interval(days => k.reserve_periode_dage)
  ),
  snap as (
    select * from public.penge_saldo_snapshot order by kl desc limit 1
  ),
  afv as (
    select count(*)::integer as aabne,
           max(sidst_set_kl) as seneste
      from public.penge_afstemning_afvigelser where loest_kl is null
  ),
  koersel as (
    select * from public.penge_afstemning_koersler order by startet_kl desc limit 1
  ),
  r as (
    select k.reserve_slaaet_til as slaaet_til,
           round(gebyrer.oere * k.reserve_procent / 100)::bigint as procent_oere,
           greatest(k.reserve_minimum_oere, aabne.oere + k.forventet_tab_oere)::bigint as minimum_oere
      from k, gebyrer, aabne
  ),
  maal as (
    select r.*, greatest(r.procent_oere, r.minimum_oere)::bigint as reserve_oere from r
  ),
  tilg as (
    select coalesce(p_tilgaengelig_oere, (select platform_tilgaengelig_oere from snap)) as oere
  )
  select jsonb_build_object(
    'konfiguration', (select jsonb_build_object(
        'reserve_slaaet_til', k.reserve_slaaet_til,
        'reserve_procent', k.reserve_procent,
        'reserve_periode_dage', k.reserve_periode_dage,
        'reserve_minimum_oere', k.reserve_minimum_oere,
        'forventet_tab_oere', k.forventet_tab_oere,
        'aendret_kl', k.aendret_kl) from k),
    'saelgere', (select jsonb_build_object('oere', oere, 'antal_handler', antal, 'konti', konti) from saelgere),
    'paa_vej_til_bank', (select jsonb_build_object('oere', oere, 'antal', antal) from paa_vej),
    'skylder_koebere_oere', (select oere from skylder),
    'gebyrer_periode_oere', (select oere from gebyrer),
    'aabne_indsigelser_oere', (select oere from aabne),
    'tab_efter_udbetaling', (select jsonb_build_object('oere', oere, 'antal', antal) from tab),
    -- Reserven vises KUN, når den er slået til (null ellers).
    'reserve', (select case when m.slaaet_til then jsonb_build_object(
        'procent_oere', m.procent_oere,
        'minimum_oere', m.minimum_oere,
        'reserve_oere', m.reserve_oere,
        'brugt_paa_tab_oere', least(m.reserve_oere, (select oere from tab)),
        'tilbage_oere', greatest(0, m.reserve_oere - (select oere from tab)))
        else null end from maal m),
    'kan_traekkes_ud_oere', (select case when tilg.oere is null then null else greatest(0,
        tilg.oere - (select oere from skylder)
        - (select case when m.slaaet_til then greatest(0, m.reserve_oere - (select oere from tab)) else 0 end from maal m))
        end from tilg),
    'snapshot', (select jsonb_build_object(
        'kl', s.kl, 'kilde', s.kilde, 'livemode', s.livemode,
        'tilgaengelig_oere', s.platform_tilgaengelig_oere,
        'afventer_oere', s.platform_afventer_oere,
        'saelgere_stripe_oere', s.saelgere_stripe_oere,
        'saelgerkonti', s.saelgerkonti) from snap s),
    'afstemning', jsonb_build_object(
        'aabne_afvigelser', (select aabne from afv),
        'seneste_afvigelse_kl', (select seneste from afv),
        'seneste_koersel', (select jsonb_build_object(
            'startet_kl', x.startet_kl, 'afsluttet_kl', x.afsluttet_kl, 'ok', x.ok,
            'ufuldstaendig', x.ufuldstaendig,
            'antal_afvigelser', x.antal_afvigelser, 'antal_nye', x.antal_nye,
            'resultat', x.resultat) from koersel x))
  );
$function$;

-- Intern: kun via admin_penge_reserve (chef-tjek).
revoke all on function public.penge_reserve_beregn(bigint) from public, anon, authenticated, service_role;

-- Kun chef (p_chef tjekkes i databasen). Ældre udgave uden p_chef fjernes.
drop function if exists public.admin_penge_reserve(bigint);
create or replace function public.admin_penge_reserve(p_chef uuid, p_tilgaengelig_oere bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if p_chef is null or not public.staff_chat_har_rolle(p_chef, 'chef') then
    raise exception 'ingen_adgang' using errcode = '42501';
  end if;
  return public.penge_reserve_beregn(p_tilgaengelig_oere);
end;
$fn$;

revoke all on function public.admin_penge_reserve(uuid, bigint) from public, anon, authenticated;
grant execute on function public.admin_penge_reserve(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------
-- 5f. Posteringer (seneste bevægelser og månedens CSV til regnskabet)
-- ---------------------------------------------------------------------
-- Én række pr. pengebevægelse i [p_fra, p_til), nyeste først, højst
-- p_graense (1-20000). Beløb i øre, positive tal; "bidhamr_oere" er
-- virkningen på BidHamrs saldo hos Stripe (+ ind, - ud). Ingen persondata
-- (kun id'er og auktionens titel).
--   betaling              køber betalte (BidHamr: + application fee)
--   gebyr_refusion        gebyr refunderet til sælgerens konto (-)
--   tilbagefoersel        sælgerens del + gebyr hentet tilbage ved refusion (+)
--   refusion              køber refunderet (-)
--   bidhamr_daekker       "BidHamr dækker": køber refunderet af BidHamrs saldo efter udbetaling (-)
--   indsigelse            indsigelse åbnet hos køberens bank (beløb)
--   indsigelse_tilbagefoersel  beløb hentet fra sælgeren efter tabt indsigelse (+)
--   indsigelse_tab        tabt efter udbetaling - BidHamr bærer sælgerens del + fragt
--   udbetaling            sendt fra sælgerens konto til hans bank (ikke BidHamrs penge)
--   udbetaling_fejlet     udbetalingen kom retur (pengene står igen på sælgerens konto)
--   afvigelse             betaling med forkert beløb modtaget / refunderet
create or replace function public.penge_posteringer_hent(
  p_fra timestamptz, p_til timestamptz, p_graense integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with g as (
    select coalesce(p_fra, '-infinity'::timestamptz) as fra,
           coalesce(p_til, 'infinity'::timestamptz) as til,
           greatest(1, least(coalesce(p_graense, 50), 20001)) as graense
  ),
  d as (
    select b.*, au.titel
      from public.betalinger b
      left join public.auctions au on au.id = b.auction_id
     where b.pengemodel = 'destination'
  ),
  p as (
    select d.betalt_kl as kl, 'betaling'::text as type, d.trade_id, d.id as betaling_id,
           d.stripe_payment_intent_id as stripe_id, d.titel,
           d.total_oere as beloeb_oere, coalesce(d.application_fee_oere, 0) as bidhamr_oere,
           d.koebergebyr_oere, d.saelgergebyr_oere, d.beskyttelse_oere, d.fragt_oere,
           d.udbetaling_oere as saelger_oere
      from d where d.betalt_kl is not null
    union all
    select d.gebyr_refunderet_kl, 'gebyr_refusion', d.trade_id, d.id, d.stripe_fee_refund_id, d.titel,
           coalesce(d.refusion_gebyr_oere, 0), -coalesce(d.refusion_gebyr_oere, 0),
           null, null, null, null, null
      from d where d.gebyr_refunderet_kl is not null
    union all
    select d.refusion_tilbagefoert_kl, 'tilbagefoersel', d.trade_id, d.id, d.refusion_tilbagefoersel_id, d.titel,
           d.udbetaling_oere + coalesce(d.refusion_gebyr_oere, 0),
           d.udbetaling_oere + coalesce(d.refusion_gebyr_oere, 0),
           null, null, null, null, -(d.udbetaling_oere + coalesce(d.refusion_gebyr_oere, 0))
      from d where d.refusion_tilbagefoert_kl is not null
    union all
    select d.refunderet_kl, 'refusion', d.trade_id, d.id, d.stripe_refund_id, d.titel,
           coalesce(d.refusion_oere, d.total_oere), -coalesce(d.refusion_oere, d.total_oere),
           null, null, null, null, null
      from d where d.refunderet_kl is not null and d.status = 'refunderet'
                 and d.bidhamr_daekker_refunderet_kl is null
    union all
    -- "BidHamr dækker": køberen refunderet af BidHamrs egen saldo efter
    -- udbetaling (intet taget fra sælgeren) - en udgift for BidHamr.
    select d.bidhamr_daekker_refunderet_kl, 'bidhamr_daekker', d.trade_id, d.id, d.bidhamr_daekker_refund_id, d.titel,
           coalesce(d.bidhamr_daekker_oere, d.refusion_oere, d.total_oere),
           -coalesce(d.bidhamr_daekker_oere, d.refusion_oere, d.total_oere),
           null, null, null, null, null
      from d where d.bidhamr_daekker_refunderet_kl is not null
    union all
    select d.indsigelse_kl, 'indsigelse', d.trade_id, d.id, d.stripe_dispute_id, d.titel,
           d.total_oere, 0, null, null, null, null, null
      from d where d.indsigelse_kl is not null
    union all
    select d.indsigelse_tilbagefoert_kl, 'indsigelse_tilbagefoersel', d.trade_id, d.id,
           d.indsigelse_tilbagefoersel_id, d.titel,
           coalesce(d.indsigelse_tilbagefoert_oere, 0), coalesce(d.indsigelse_tilbagefoert_oere, 0),
           null, null, null, null, -coalesce(d.indsigelse_tilbagefoert_oere, 0)
      from d where d.indsigelse_tilbagefoert_kl is not null and d.indsigelse_tilbagefoersel_id is not null
    union all
    select coalesce(d.indsigelse_tabt_afklaret_kl, d.indsigelse_tabt_kl), 'indsigelse_tab', d.trade_id, d.id,
           d.stripe_dispute_id, d.titel,
           d.udbetaling_oere + d.fragt_oere, -(d.udbetaling_oere + d.fragt_oere),
           null, null, null, null, null
      from d where d.indsigelse_tabt_afklaret = 'udbetalt'
    union all
    select coalesce(u.oprettet_hos_stripe_kl, u.oprettet), 'udbetaling', null, null, u.stripe_payout_id, null,
           u.beloeb_oere, 0, null, null, null, null, -u.beloeb_oere
      from public.saelger_udbetalinger u
     where u.stripe_payout_id is not null and u.status in ('oprettet', 'paid', 'failed', 'canceled')
    union all
    select u.fejlet_kl, 'udbetaling_fejlet', null, null, u.stripe_payout_id, null,
           u.beloeb_oere, 0, null, null, null, null, u.beloeb_oere
      from public.saelger_udbetalinger u
     where u.fejlet_kl is not null and u.status in ('failed', 'canceled')
    union all
    select a.oprettet, 'afvigelse', a.trade_id, a.betaling_id, a.stripe_payment_intent_id, null,
           a.modtaget_oere, 0, null, null, null, null, null
      from public.betaling_afvigelser a
    union all
    select a.refunderet_kl, 'afvigelse_refunderet', a.trade_id, a.betaling_id, a.stripe_refund_id, null,
           a.modtaget_oere, 0, null, null, null, null, null
      from public.betaling_afvigelser a where a.refunderet_kl is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kl', x.kl, 'type', x.type, 'trade_id', x.trade_id, 'betaling_id', x.betaling_id,
           'stripe_id', x.stripe_id, 'titel', x.titel,
           'beloeb_oere', x.beloeb_oere, 'bidhamr_oere', x.bidhamr_oere,
           'koebergebyr_oere', x.koebergebyr_oere, 'saelgergebyr_oere', x.saelgergebyr_oere,
           'beskyttelse_oere', x.beskyttelse_oere, 'fragt_oere', x.fragt_oere,
           'saelger_oere', x.saelger_oere)
         order by x.kl desc, x.type), '[]'::jsonb)
    from (select p.* from p, g
           where p.kl is not null and p.kl >= g.fra and p.kl < g.til
           order by p.kl desc, p.type
           limit (select graense from g)) x;
$function$;

revoke all on function public.penge_posteringer_hent(timestamptz, timestamptz, integer) from public, anon, authenticated, service_role;

-- Kun chef. p_graense er højst 20000; CSV'en spørger efter 20001 for at kunne
-- se, om måneden har flere rækker (så klippes der ikke stille).
drop function if exists public.admin_penge_posteringer(timestamptz, timestamptz, integer);
create or replace function public.admin_penge_posteringer(
  p_chef uuid, p_fra timestamptz, p_til timestamptz, p_graense integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if p_chef is null or not public.staff_chat_har_rolle(p_chef, 'chef') then
    raise exception 'ingen_adgang' using errcode = '42501';
  end if;
  return public.penge_posteringer_hent(p_fra, p_til, p_graense);
end;
$fn$;

revoke all on function public.admin_penge_posteringer(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.admin_penge_posteringer(uuid, timestamptz, timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------
-- 6. Eget pg_cron-job for afstemningen (/api/cron/afstemning)
-- ---------------------------------------------------------------------
-- Afstemningen kan tage op til 3 minutter og kører derfor ikke i
-- betalings-cron'en (pg_net giver op efter 60 s der). Samme mønster som
-- kald_drift_alarm (20261008011000): Vault 'afstemning_url' (valgfri),
-- ellers cron_url med stien skiftet ud (.../api/cron/afslut-auktioner ->
-- .../api/cron/afstemning), og samme cron_secret - virker derfor også i
-- produktion uden ny opsætning. Timeout 300 s (= rutens maxDuration), så
-- pg_net ikke melder timeout på en kørsel, der stadig er i gang (drift-
-- alarmen tæller kun timeouts, fejl og ikke-2xx). Jobbet kører hver time;
-- databasen (penge_afstemning_claim) sørger for, at afstemningen kun kører
-- én gang pr. 20 timer - og igen efter 2 timer, hvis den fejlede eller ikke
-- nåede alle trin. Et kald uden noget at gøre svarer med det samme.
create or replace function public.kald_pengeafstemning()
returns bigint
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_url    text;
  v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    perform public.drift_fejl_log('cron', 'pengeafstemning',
      'kald_pengeafstemning: Vault findes ikke - afstemningen kaldes ikke', null, null);
    return null;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'afstemning_url' limit 1$q$
     into v_url;
  if coalesce(v_url, '') = '' then
    execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_url' limit 1$q$
       into v_url;
    if coalesce(v_url, '') !~ '/api/cron/[A-Za-z0-9_-]+/?$' then
      perform public.drift_fejl_log('cron', 'pengeafstemning',
        'kald_pengeafstemning: cron_url mangler i Vault (eller er ikke en /api/cron/-adresse) - afstemningen kaldes ikke', null, null);
      return null;
    end if;
    v_url := regexp_replace(v_url, '/api/cron/[A-Za-z0-9_-]+/?$', '/api/cron/afstemning');
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1$q$
     into v_secret;
  if coalesce(v_secret, '') = '' then
    perform public.drift_fejl_log('cron', 'pengeafstemning',
      'kald_pengeafstemning: cron_secret mangler i Vault - afstemningen kaldes ikke', null, null);
    return null;
  end if;
  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 300000);
end;
$fn$;

revoke all on function public.kald_pengeafstemning() from public, anon, authenticated;

-- Idempotent: et eksisterende job fjernes først. Kun hvor pg_cron findes.
do $do$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron findes ikke - jobbet pengeafstemning oprettes ikke';
    return;
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'pengeafstemning';
  -- Minut 37 hver time (væk fra betalings-cron'en på 0, 5, 10 ... og
  -- drift-alarmen på 2, 7, 12 ...).
  perform cron.schedule('pengeafstemning', '37 * * * *', 'select public.kald_pengeafstemning();');
end $do$;
