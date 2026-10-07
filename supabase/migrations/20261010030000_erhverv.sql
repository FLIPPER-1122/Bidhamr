-- Erhvervskonti - fundament (database). Fase 7 i ROADMAP.md.
--
-- Regler: ROADMAP-BESLUTNINGER.md, "Erhvervskonti (Filip, 7. oktober 2026)".
--
-- Indhold:
--   1. Ny staff-rolle 'saelger'. Den står UDEN FOR hierarkiet
--      medarbejder < admin < chef: er_staff(), staff_chat_har_rolle() og alle
--      admin-funktioner nævner rollerne eksplicit, så 'saelger' får ingen
--      adgang til resten af admin. Erhverv: chef + saelger (erhverv_har_adgang).
--      Pakker og priser: kun chef.
--   2. users.konto_type ('privat' | 'erhverv'). Kan kun sættes af service
--      role/postgres (users_beskyt_konto_type) - aldrig via signup-metadata
--      (handle_new_user læser den ikke) eller en UPDATE fra appen. En
--      firmakonto kan ikke have en staff-rolle (CHECK).
--   3. Tabeller: erhverv_henvendelser (formularen), erhverv_pakker, firmaer,
--      firma_pakkeskift (log), firma_regninger. Ingen af dem kan slettes
--      (handelsdata/bogføring) - arkiveres i stedet.
--   4. Håndhævelse (gælder også appen):
--      - Firmakonti kan ikke byde (bids-trigger og saet_maksimum):
--        'erhverv_kan_ikke_byde: …' (BHE01).
--      - Auktioner kræver aktivt abonnement ('erhverv_intet_abonnement: …',
--        BHE02) og højst pakke.auktioner_pr_uge pr. KALENDERUGE (mandag 00:00
--        dansk tid) ('erhverv_kvote: …', BHE03). Annullerede auktioner tæller
--        med - ellers kunne kvoten omgås ved at oprette og annullere.
--      - Erhverv + stand 'ny_med_maerke' ("Ny") kræver GPSR-felterne
--        producent og sikkerhedsoplysninger ('erhverv_gpsr: …', BHE04).
--        Private kan i dag allerede vælge "Ny med mærke" - det er uændret.
--      - Ingen BidHamr Beskyttelse på bud på en erhvervsauktion (tvinges til
--        false, som bids_beskyttelse_kun_afhentning).
--   5. auctions.erhverv (sat af databasen ved oprettelse) - billigste måde for
--      lister og auktionssiden at vise "Erhvervssælger" uden join.
--   6. RPC'er: firma_oversigt, firma_ugekvote, firma_skift_pakke,
--      firma_offentlig + staff-RPC'er (kun service_role, med p_staff) +
--      Stripe-krogene firma_pakkeskift_betalt, firma_abonnement_betalt,
--      firma_abonnement_mislykket og firma_abonnement_frist_koer.
--   7. mine_data har firmadata med; konto_sletning_blokeringer blokerer en
--      firmakonto (BidHamr lukker den) og en sælger-rolle.
--
-- STRIPE (på pause): ingen betaling sker her. Opgradering gemmes som
-- 'afventer_betaling' i firma_pakkeskift og giver IKKE flere auktioner, før
-- firma_pakkeskift_betalt kaldes (af en Stripe-webhook senere eller af staff
-- via erhverv_firma_opdater efter manuel aftale). Se src/lib/erhverv/betaling.ts.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper: flet værdier ind i en eksisterende CHECK (kol = ANY (...)).
--    Læser den nuværende definition, så værdier fra drift/andre migrationer
--    bevares.
-- ---------------------------------------------------------------------------
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

select pg_temp.flet_check('public.users'::regclass, 'users_rolle_check', 'rolle',
  array['bruger', 'medarbejder', 'admin', 'chef', 'saelger']);

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_maal_type_check', 'maal_type',
  array['firma', 'erhverv_henvendelse', 'erhverv_pakke']);

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['erhverv_henvendelse_opdateret', 'erhverv_pakke_gemt', 'firma_oprettet', 'firma_opdateret',
        'firma_velkomst_gensendt']);

-- ---------------------------------------------------------------------------
-- 1. users.konto_type
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists konto_type text not null default 'privat';

alter table public.users drop constraint if exists users_konto_type_check;
alter table public.users add constraint users_konto_type_check
  check (konto_type in ('privat', 'erhverv'));

-- En firmakonto er aldrig medarbejder/sælger/chef.
alter table public.users drop constraint if exists users_erhverv_ingen_staffrolle;
alter table public.users add constraint users_erhverv_ingen_staffrolle
  check (konto_type = 'privat' or rolle = 'bruger');

-- Offentlig oplysning (som navn): profilen kan vise "Erhvervssælger".
grant select (konto_type) on public.users to anon, authenticated;

comment on column public.users.konto_type is
  'privat | erhverv. Sættes KUN af BidHamr (service role) ved oprettelse af en firmakonto (erhverv_firma_opret). Kan ikke sættes ved signup eller ændres fra appen.';

create or replace function public.users_beskyt_konto_type()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.konto_type := 'privat';
  elsif new.konto_type is distinct from old.konto_type then
    raise exception 'Du må ikke ændre denne oplysning.' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function public.users_beskyt_konto_type() from public, anon, authenticated;

drop trigger if exists users_beskyt_konto_type on public.users;
create trigger users_beskyt_konto_type
  before insert or update of konto_type on public.users
  for each row execute function public.users_beskyt_konto_type();

create or replace function public.er_erhverv(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.users u where u.id = p_bruger and u.konto_type = 'erhverv');
$$;

revoke all on function public.er_erhverv(uuid) from public, anon, authenticated;
grant execute on function public.er_erhverv(uuid) to service_role;

-- Adgang til Erhverv i admin: chef og saelger (p_kun_chef: kun chef).
create or replace function public.erhverv_har_adgang(p_bruger uuid, p_kun_chef boolean default false)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bruger is not null and exists (
    select 1 from public.users u
     where u.id = p_bruger
       and u.konto_lukket_kl is null
       and u.konto_slettet_kl is null
       and not (u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()))
       and (u.rolle = 'chef' or (not coalesce(p_kun_chef, false) and u.rolle = 'saelger')));
$$;

revoke all on function public.erhverv_har_adgang(uuid, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_har_adgang(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tabeller
-- ---------------------------------------------------------------------------

-- Fælles værn: erhvervsdata slettes aldrig (arkivér). Kun til oprydning af
-- testdata: set local bidhamr.tillad_brugersletning = 'ja' (samme nøgle som
-- users_ingen_haard_sletning).
create or replace function public.erhverv_ingen_sletning()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('bidhamr.tillad_brugersletning', true), '') = 'ja' then
    return case when tg_level = 'ROW' then old else null end;
  end if;
  raise exception 'Erhvervsdata kan ikke slettes - arkivér i stedet.' using errcode = '42501';
end $$;

revoke all on function public.erhverv_ingen_sletning() from public, anon, authenticated;

create table if not exists public.erhverv_henvendelser (
  id              uuid primary key default gen_random_uuid(),
  firmanavn       text not null check (char_length(firmanavn) between 1 and 200),
  cvr             text not null check (cvr ~ '^[0-9]{8}$'),
  kontaktperson   text not null check (char_length(kontaktperson) between 1 and 200),
  telefon         text not null check (char_length(telefon) between 6 and 30),
  email           text not null check (char_length(email) between 3 and 254),
  adresse         text check (adresse is null or char_length(adresse) <= 200),
  postnummer      text check (postnummer is null or postnummer ~ '^[0-9]{4}$'),
  bynavn          text check (bynavn is null or char_length(bynavn) <= 100),
  hvad_saelger_i  text not null check (char_length(hvad_saelger_i) between 1 and 2000),
  antal_varer_ca  integer check (antal_varer_ca is null or antal_varer_ca between 0 and 10000000),
  besked          text check (besked is null or char_length(besked) <= 4000),
  status          text not null default 'ny' check (status in ('ny', 'i_gang', 'godkendt', 'afvist')),
  noter           text check (noter is null or char_length(noter) <= 10000),
  behandlet_af    uuid references public.users(id),
  behandlet_kl    timestamptz,
  bruger_id       uuid references public.users(id),
  ip_hash         text check (ip_hash is null or char_length(ip_hash) <= 128),
  arkiveret_kl    timestamptz,
  oprettet_kl     timestamptz not null default now(),
  opdateret_kl    timestamptz not null default now()
);

create index if not exists erhverv_henvendelser_status_idx
  on public.erhverv_henvendelser (status, oprettet_kl desc) where arkiveret_kl is null;

comment on table public.erhverv_henvendelser is
  'Erhvervsformularen (/erhverv). Indsættes kun af serveren (service role) efter honeypot, tidsfælde og rate limits. Læses/opdateres kun af chef og saelger via erhverv_henvendelser_liste/erhverv_henvendelse_opdater. Slettes aldrig - arkiveres.';

create table if not exists public.erhverv_pakker (
  id                uuid primary key default gen_random_uuid(),
  navn              text not null unique check (char_length(navn) between 1 and 60),
  beskrivelse       text check (beskrivelse is null or char_length(beskrivelse) <= 1000),
  maanedspris       numeric check (maanedspris is null
                                   or (maanedspris >= 0 and maanedspris <= 1000000
                                       and maanedspris = trunc(maanedspris))),
  auktioner_pr_uge  integer not null check (auktioner_pr_uge between 1 and 1000),
  aktiv             boolean not null default true,
  sortering         integer not null default 0,
  oprettet_af       uuid references public.users(id),
  opdateret_af      uuid references public.users(id),
  oprettet_kl       timestamptz not null default now(),
  opdateret_kl      timestamptz not null default now()
);

comment on table public.erhverv_pakker is
  'Abonnementspakker for erhverv. Kun chef opretter/ændrer (erhverv_pakke_gem). maanedspris i hele kroner, null indtil Filip har sat priserne. aktiv=false: tilbydes ikke længere, men eksisterende firmaer beholder den. Slettes aldrig.';

create table if not exists public.firmaer (
  id                      uuid primary key default gen_random_uuid(),
  bruger_id               uuid not null unique references public.users(id),
  firmanavn               text not null check (char_length(firmanavn) between 1 and 200),
  cvr                     text not null check (cvr ~ '^[0-9]{8}$'),
  adresse                 text not null check (char_length(adresse) between 1 and 200),
  postnummer              text not null check (postnummer ~ '^[0-9]{4}$'),
  bynavn                  text not null check (char_length(bynavn) between 1 and 100),
  telefon                 text not null check (char_length(telefon) between 6 and 30),
  kontakt_email           text not null check (char_length(kontakt_email) between 3 and 254),
  kontaktperson           text not null check (char_length(kontaktperson) between 1 and 200),
  henvendelse_id          uuid references public.erhverv_henvendelser(id),
  pakke_id                uuid not null references public.erhverv_pakker(id),
  abonnement_status       text not null default 'aktiv' check (abonnement_status in ('aktiv', 'pauset', 'opsagt')),
  abonnement_start        timestamptz not null default now(),
  naeste_pakke_id         uuid references public.erhverv_pakker(id),
  naeste_pakke_fra        timestamptz,
  -- Stripe (null indtil Stripe kobles på; kun service role kan sætte dem).
  stripe_customer_id      text,
  stripe_subscription_id  text,
  betalt_til              timestamptz,
  betaling_mislykket_kl   timestamptz,
  pauset_aarsag           text check (pauset_aarsag is null or pauset_aarsag in ('betaling', 'bidhamr')),
  opsagt_kl               timestamptz,
  oprettet_af             uuid references public.users(id),
  oprettet_kl             timestamptz not null default now(),
  opdateret_kl            timestamptz not null default now(),
  constraint firmaer_naeste_pakke_par check ((naeste_pakke_id is null) = (naeste_pakke_fra is null))
);

-- CVR er unikt blandt firmaer, der ikke er opsagt.
create unique index if not exists firmaer_cvr_aktiv_unik
  on public.firmaer (cvr) where abonnement_status <> 'opsagt';
create unique index if not exists firmaer_stripe_customer_unik
  on public.firmaer (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists firmaer_stripe_subscription_unik
  on public.firmaer (stripe_subscription_id) where stripe_subscription_id is not null;
create index if not exists firmaer_henvendelse_idx on public.firmaer (henvendelse_id);

comment on table public.firmaer is
  'Firmakonti. Oprettes kun af BidHamr (erhverv_firma_opret). Firmaet kan læse sin egen række, men ikke ændre den. Slettes aldrig - opsiges (abonnement_status = opsagt).';

create table if not exists public.firma_pakkeskift (
  id                uuid primary key default gen_random_uuid(),
  firma_id          uuid not null references public.firmaer(id),
  fra_pakke_id      uuid references public.erhverv_pakker(id),
  til_pakke_id      uuid not null references public.erhverv_pakker(id),
  type              text not null check (type in ('start', 'opgradering', 'nedgradering', 'bidhamr')),
  status            text not null check (status in ('afventer_betaling', 'planlagt', 'gennemfoert', 'annulleret', 'erstattet')),
  gaelder_fra       timestamptz,
  anmodet_af        uuid references public.users(id),
  stripe_reference  text unique,
  note              text check (note is null or char_length(note) <= 1000),
  oprettet_kl       timestamptz not null default now(),
  behandlet_kl      timestamptz
);

create index if not exists firma_pakkeskift_firma_idx on public.firma_pakkeskift (firma_id, oprettet_kl desc);
-- Højst én ventende opgradering og én planlagt nedgradering pr. firma.
create unique index if not exists firma_pakkeskift_en_afventer
  on public.firma_pakkeskift (firma_id) where status = 'afventer_betaling';
create unique index if not exists firma_pakkeskift_en_planlagt
  on public.firma_pakkeskift (firma_id) where status = 'planlagt';

comment on table public.firma_pakkeskift is
  'Log over pakkeskift. Opgradering = afventer_betaling, indtil firma_pakkeskift_betalt kaldes (Stripe-webhook senere). Nedgradering = planlagt fra næste periode. Slettes aldrig.';

create table if not exists public.firma_regninger (
  id                 uuid primary key default gen_random_uuid(),
  firma_id           uuid not null references public.firmaer(id),
  nummer             text unique check (nummer is null or char_length(nummer) <= 50),
  type               text not null check (type in ('abonnement', 'opgradering', 'andet')),
  periode_fra        date,
  periode_til        date,
  beloeb_oere        bigint not null check (beloeb_oere >= 0),
  status             text not null default 'afventer' check (status in ('afventer', 'betalt', 'mislykket', 'krediteret')),
  stripe_invoice_id  text unique,
  stripe_reference   text unique,
  pdf_url            text check (pdf_url is null or pdf_url ~ '^https://'),
  betalt_kl          timestamptz,
  oprettet_kl        timestamptz not null default now()
);

create index if not exists firma_regninger_firma_idx on public.firma_regninger (firma_id, oprettet_kl desc);

comment on table public.firma_regninger is
  'Regninger fra BidHamr til firmaet. Tom indtil Stripe/regnskabsprogram kobles på (firma_pakkeskift_betalt, firma_abonnement_betalt). Firmaet kan læse egne. Slettes aldrig.';

-- RLS og rettigheder
alter table public.erhverv_henvendelser enable row level security;
alter table public.erhverv_pakker      enable row level security;
alter table public.firmaer             enable row level security;
alter table public.firma_pakkeskift    enable row level security;
alter table public.firma_regninger     enable row level security;

revoke all on public.erhverv_henvendelser, public.erhverv_pakker, public.firmaer,
              public.firma_pakkeskift, public.firma_regninger
  from public, anon, authenticated;
grant all on public.erhverv_henvendelser, public.erhverv_pakker, public.firmaer,
             public.firma_pakkeskift, public.firma_regninger to service_role;
grant select on public.firmaer, public.firma_pakkeskift, public.firma_regninger to authenticated;

drop policy if exists firmaer_select_egen on public.firmaer;
create policy firmaer_select_egen on public.firmaer
  for select to authenticated using (bruger_id = (select auth.uid()));

drop policy if exists firma_pakkeskift_select_egen on public.firma_pakkeskift;
create policy firma_pakkeskift_select_egen on public.firma_pakkeskift
  for select to authenticated using (exists (
    select 1 from public.firmaer f where f.id = firma_id and f.bruger_id = (select auth.uid())));

drop policy if exists firma_regninger_select_egen on public.firma_regninger;
create policy firma_regninger_select_egen on public.firma_regninger
  for select to authenticated using (exists (
    select 1 from public.firmaer f where f.id = firma_id and f.bruger_id = (select auth.uid())));

-- Ingen sletning
do $$
declare t text;
begin
  foreach t in array array['erhverv_henvendelser', 'erhverv_pakker', 'firmaer', 'firma_pakkeskift', 'firma_regninger'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_sletning', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.erhverv_ingen_sletning()',
                   t || '_ingen_sletning', t);
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.erhverv_ingen_sletning()',
                   t || '_ingen_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. auctions: erhverv-flag og GPSR-felter
-- ---------------------------------------------------------------------------
alter table public.auctions add column if not exists erhverv boolean not null default false;
alter table public.auctions add column if not exists producent text;
alter table public.auctions add column if not exists sikkerhedsoplysninger text;

alter table public.auctions drop constraint if exists auctions_producent_laengde;
alter table public.auctions add constraint auctions_producent_laengde
  check (producent is null or char_length(producent) <= 500);
alter table public.auctions drop constraint if exists auctions_sikkerhed_laengde;
alter table public.auctions add constraint auctions_sikkerhed_laengde
  check (sikkerhedsoplysninger is null or char_length(sikkerhedsoplysninger) <= 2000);

comment on column public.auctions.erhverv is
  'Sælgeren var en firmakonto, da auktionen blev oprettet. Sættes af databasen (auctions_zz_erhverv) og kan ikke ændres. Bruges til mærket "Erhvervssælger".';
comment on column public.auctions.producent is
  'GPSR: producentens navn og adresse. Påkrævet for erhverv ved stand ''ny_med_maerke''. Altid null for private.';
comment on column public.auctions.sikkerhedsoplysninger is
  'GPSR: advarsler og sikkerhedsoplysninger. Påkrævet for erhverv ved stand ''ny_med_maerke''. Altid null for private.';

-- ---------------------------------------------------------------------------
-- 4. Kvote og pakker
-- ---------------------------------------------------------------------------

-- Kalenderuge: mandag 00:00 dansk tid.
create or replace function public.erhverv_uge_start(p_ts timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (date_trunc('week', p_ts at time zone 'Europe/Copenhagen')) at time zone 'Europe/Copenhagen';
$$;

-- Starten på næste abonnementsperiode (månedlig fra abonnement_start).
-- Når Stripe kobles på, erstattes den af Stripes current_period_end.
create or replace function public.firma_naeste_periode(p_start timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when p_start > now() then p_start
    else p_start + make_interval(months => (
      extract(year from age(now(), p_start))::int * 12
      + extract(month from age(now(), p_start))::int + 1))
  end;
$$;

-- Gennemfører en planlagt nedgradering, når dens dato er nået. Intern.
create or replace function public.firma_anvend_planlagt(p_firma uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.firmaer
     set pakke_id = naeste_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null,
         opdateret_kl = now()
   where id = p_firma and naeste_pakke_fra is not null and naeste_pakke_fra <= now();
  if found then
    update public.firma_pakkeskift
       set status = 'gennemfoert', behandlet_kl = now()
     where firma_id = p_firma and status = 'planlagt' and gaelder_fra <= now();
  end if;
end $$;

revoke all on function public.firma_anvend_planlagt(uuid) from public, anon, authenticated;

-- Kvoten for en firmakonto. p_laas: lås firmarækken (ved oprettelse), så to
-- samtidige oprettelser ikke begge kan bruge den sidste plads.
-- Svar: {kode: ok|erhverv_kvote|erhverv_intet_abonnement, brugt, max,
--        uge_start, naeste_uge, naeste_ledige}
create or replace function public.erhverv_kvote(p_bruger uuid, p_laas boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.firmaer;
  v_start  timestamptz := public.erhverv_uge_start(now());
  v_naeste timestamptz := (date_trunc('week', now() at time zone 'Europe/Copenhagen') + interval '7 days')
                          at time zone 'Europe/Copenhagen';
  v_pakke  uuid;
  v_max    integer;
  v_brugt  integer;
  v_kode   text;
begin
  if p_laas then
    select * into f from public.firmaer where bruger_id = p_bruger for update;
    if f.id is not null and f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now() then
      perform public.firma_anvend_planlagt(f.id);
      select * into f from public.firmaer where id = f.id;
    end if;
  else
    select * into f from public.firmaer where bruger_id = p_bruger;
  end if;

  if f.id is null then
    return jsonb_build_object('kode', 'erhverv_intet_abonnement', 'brugt', 0, 'max', 0,
                              'uge_start', v_start, 'naeste_uge', v_naeste, 'naeste_ledige', null);
  end if;

  v_pakke := case when f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now()
                  then f.naeste_pakke_id else f.pakke_id end;
  select p.auktioner_pr_uge into v_max from public.erhverv_pakker p where p.id = v_pakke;
  v_max := coalesce(v_max, 0);

  -- Alle auktioner oprettet i ugen tæller - også annullerede.
  select count(*) into v_brugt from public.auctions a
   where a.bruger_id = p_bruger and a.oprettet >= v_start;

  v_kode := case
    when f.abonnement_status <> 'aktiv' then 'erhverv_intet_abonnement'
    when v_brugt >= v_max then 'erhverv_kvote'
    else 'ok' end;

  return jsonb_build_object(
    'kode', v_kode,
    'brugt', v_brugt,
    'max', v_max,
    'uge_start', v_start,
    'naeste_uge', v_naeste,
    'naeste_ledige', case when v_kode = 'erhverv_intet_abonnement' then null
                          when v_brugt < v_max then now() else v_naeste end);
end $$;

revoke all on function public.erhverv_kvote(uuid, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_kvote(uuid, boolean) to service_role;

-- Firmaets egen kvote. null, hvis brugeren ikke er en firmakonto.
create or replace function public.firma_ugekvote()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  k jsonb;
begin
  if v_uid is null or not exists (select 1 from public.firmaer where bruger_id = v_uid) then
    return null;
  end if;
  k := public.erhverv_kvote(v_uid, false);
  return jsonb_build_object(
    'brugt', k->'brugt', 'max', k->'max', 'naeste_ledige', k->'naeste_ledige',
    'uge_start', k->'uge_start', 'naeste_uge', k->'naeste_uge',
    'aktivt_abonnement', k->>'kode' <> 'erhverv_intet_abonnement');
end $$;

revoke all on function public.firma_ugekvote() from public, anon, authenticated;
grant execute on function public.firma_ugekvote() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Triggere på auctions og bids
-- ---------------------------------------------------------------------------
create or replace function public.auctions_erhverv()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_k jsonb;
begin
  if tg_op = 'INSERT' then
    new.erhverv := coalesce((select u.konto_type = 'erhverv' from public.users u where u.id = new.bruger_id), false);
    if new.erhverv then
      v_k := public.erhverv_kvote(new.bruger_id, true);
      if v_k->>'kode' = 'erhverv_intet_abonnement' then
        raise exception 'erhverv_intet_abonnement: Firmaet har ikke et aktivt abonnement. Kontakt BidHamr på erhverv@bidhamr.dk.'
          using errcode = 'BHE02';
      elsif v_k->>'kode' = 'erhverv_kvote' then
        raise exception 'erhverv_kvote: Du har oprettet % af % auktioner i denne uge. Du kan oprette den næste mandag den %.',
          v_k->>'brugt', v_k->>'max',
          to_char((v_k->>'naeste_uge')::timestamptz at time zone 'Europe/Copenhagen', 'DD.MM.YYYY')
          using errcode = 'BHE03';
      end if;
    end if;
  else
    new.erhverv := old.erhverv;
  end if;

  if not new.erhverv then
    new.producent := null;
    new.sikkerhedsoplysninger := null;
    return new;
  end if;

  new.producent := nullif(btrim(coalesce(new.producent, '')), '');
  new.sikkerhedsoplysninger := nullif(btrim(coalesce(new.sikkerhedsoplysninger, '')), '');

  if public.stand_normaliser(new.stand) = 'ny_med_maerke'
     and (tg_op = 'INSERT'
          or new.stand is distinct from old.stand
          or new.producent is distinct from old.producent
          or new.sikkerhedsoplysninger is distinct from old.sikkerhedsoplysninger)
     and (char_length(coalesce(new.producent, '')) < 3
          or char_length(coalesce(new.sikkerhedsoplysninger, '')) < 3) then
    raise exception 'erhverv_gpsr: Når varen er ny, skal du udfylde producent (navn og adresse) og sikkerhedsoplysninger.'
      using errcode = 'BHE04';
  end if;

  return new;
end $$;

revoke all on function public.auctions_erhverv() from public, anon, authenticated;

-- "zz": kører efter de andre BEFORE-triggere, så almindelige fejl (billeder,
-- kategori, stand …) vises først, og firmarækken låses sidst.
drop trigger if exists auctions_zz_erhverv on public.auctions;
create trigger auctions_zz_erhverv
  before insert or update of erhverv, stand, producent, sikkerhedsoplysninger on public.auctions
  for each row execute function public.auctions_erhverv();

create or replace function public.bids_erhverv()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.users u where u.id = new.bruger_id and u.konto_type = 'erhverv') then
    raise exception 'erhverv_kan_ikke_byde: Firmakonti kan ikke byde. Vil du købe, så brug en privat konto.'
      using errcode = 'BHE01';
  end if;
  return new;
end $$;

revoke all on function public.bids_erhverv() from public, anon, authenticated;

drop trigger if exists a2_bids_erhverv on public.bids;
create trigger a2_bids_erhverv
  before insert on public.bids
  for each row execute function public.bids_erhverv();

-- Som før + ingen BidHamr Beskyttelse på en erhvervsauktion (køberen har
-- fortrydelses- og reklamationsret efter loven i stedet).
create or replace function public.bids_beskyttelse_kun_afhentning()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(new.beskyttelse, false)
     and not exists (select 1 from public.auctions a
                      where a.id = new.auktion_id
                        and coalesce(a.forsendelse_mulig, false)
                        and not coalesce(a.erhverv, false)) then
    new.beskyttelse := false;
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. saet_maksimum: firmakonti kan ikke byde; ingen Beskyttelse på erhverv.
--    Ellers uændret i forhold til 20261010011000_autobud_rettelser.
-- ---------------------------------------------------------------------------
create or replace function public.saet_maksimum(p_auktion uuid, p_maks numeric, p_beskyttelse boolean default false, p_auktion_redigeret_kl timestamp with time zone default null::timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  a record;
  v_bruger record;
  v_foerende uuid;
  v_min numeric;
  v_m record;
  v_bud_afgivet boolean := false;
  v_besk boolean;
  v_nu_besk boolean;
  v_beloeb_aendret boolean;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if p_auktion is null then
    raise exception 'Auktionen findes ikke';
  end if;
  if p_maks is null or p_maks <> trunc(p_maks) then
    raise exception 'Buddet skal være i hele kroner.' using errcode = '22023';
  end if;
  if p_maks < 1 or p_maks > 9999999999 then
    raise exception 'maks_ugyldigt: Dit maksimum er ugyldigt.';
  end if;

  select au.id, au.bruger_id, au.startpris, au.status, au.skjult, au.pauset_kl, au.slutter_kl,
         au."nuværende_bud" as nuv, au.forsendelse_mulig, au.erhverv
    into a
    from public.auctions au where au.id = p_auktion for update;

  if a.id is null then
    raise exception 'Auktionen findes ikke';
  end if;
  if a.bruger_id = v_uid then
    raise exception 'own_auction: Du kan ikke byde på din egen auktion.';
  end if;
  if coalesce(a.skjult, false) then
    raise exception 'Auktionen er ikke tilgængelig';
  end if;
  if a.pauset_kl is not null then
    raise exception 'Auktionen er sat på pause';
  end if;
  if a.status <> 'aktiv' then
    raise exception 'Auktionen er ikke aktiv længere';
  end if;
  if a.slutter_kl <= now() then
    raise exception 'Auktionen er allerede slut';
  end if;

  select suspenderet, suspenderet_til, konto_slettet_kl, konto_type into v_bruger
    from public.users where id = v_uid for share;
  if v_bruger is null or v_bruger.konto_slettet_kl is not null then
    raise exception 'Kontoen er slettet.' using errcode = '42501';
  end if;
  -- NYT (erhverv): firmakonti kan ikke byde.
  if v_bruger.konto_type = 'erhverv' then
    raise exception 'erhverv_kan_ikke_byde: Firmakonti kan ikke byde. Vil du købe, så brug en privat konto.'
      using errcode = 'BHE01';
  end if;
  if v_bruger.suspenderet
     and (v_bruger.suspenderet_til is null or v_bruger.suspenderet_til > now()) then
    raise exception 'Din konto er suspenderet, og du kan ikke byde.' using errcode = '42501';
  end if;
  if public.er_blokeret(a.bruger_id, v_uid) then
    raise exception 'Sælgeren har spærret dig fra at byde på sine auktioner.' using errcode = '42501';
  end if;

  -- Rate limit: højst 10 ændringer af beløbet pr. minut pr. auktion.
  select * into v_m from public.bud_maksimum
   where auktion_id = p_auktion and bruger_id = v_uid for update;
  if v_m.auktion_id is not null
     and v_m.aendringer_vindue_kl > now() - interval '1 minute'
     and v_m.aendringer_antal >= 10 then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'P0001';
  end if;

  select b.bruger_id into v_foerende
    from public.bids b
   where b.auktion_id = p_auktion
   order by b."beløb" desc, b.oprettet asc
   limit 1;

  -- Kun afhentning: ingen BidHamr Beskyttelse (som bids_beskyttelse_kun_afhentning).
  -- NYT (erhverv): heller ikke på en erhvervsauktion.
  v_besk := coalesce(p_beskyttelse, false) and coalesce(a.forsendelse_mulig, false)
            and not coalesce(a.erhverv, false);

  if v_foerende = v_uid then
    -- Fører: maksimum kan sænkes, men ikke under det nuværende bud.
    if p_maks < a.nuv then
      raise exception 'maks_under_bud: Du fører med % kr. Dit maksimum kan ikke være lavere end dit nuværende bud.',
        trim_scale(a.nuv);
    end if;
    -- BidHamr Beskyttelse følger det førende bud og kan ikke ændres her
    -- (p_beskyttelse = null betyder "uændret"). Afvisningen tæller ikke i
    -- rate limit.
    select b.beskyttelse into v_nu_besk
      from public.bids b
     where b.auktion_id = p_auktion and b.bruger_id = v_uid
     order by b.oprettet desc, b."beløb" desc
     limit 1;
    v_nu_besk := coalesce(v_nu_besk, false);
    if p_beskyttelse is not null and v_besk <> v_nu_besk then
      raise exception 'beskyttelse_laast: Du fører allerede. BidHamr Beskyttelse følger dit bud og kan ikke ændres, mens du fører.';
    end if;
    v_besk := v_nu_besk;
  else
    v_min := public.naeste_bud_minimum(a.nuv, a.startpris);
    if p_maks < v_min then
      raise exception 'maks_for_lavt: Dit maksimum skal være mindst % kr.', trim_scale(v_min);
    end if;
  end if;

  v_beloeb_aendret := v_m.auktion_id is null or v_m.maks_beloeb <> p_maks;

  if v_m.auktion_id is null then
    insert into public.bud_maksimum (auktion_id, bruger_id, maks_beloeb, beskyttelse,
                                     sat_kl, aendringer_vindue_kl, aendringer_antal)
    values (p_auktion, v_uid, p_maks, v_besk, clock_timestamp(), now(), 1);
    insert into public.bud_maksimum_log (auktion_id, bruger_id, maks_beloeb, forrige_beloeb,
                                         beskyttelse, forrige_beskyttelse)
    values (p_auktion, v_uid, p_maks, null, v_besk, null);
  elsif v_beloeb_aendret or v_m.beskyttelse <> v_besk then
    update public.bud_maksimum
       set maks_beloeb = p_maks,
           beskyttelse = v_besk,
           sat_kl = case when v_beloeb_aendret then clock_timestamp() else sat_kl end,
           opdateret_kl = now(),
           aendringer_antal = case
             when not v_beloeb_aendret then aendringer_antal
             when aendringer_vindue_kl > now() - interval '1 minute' then aendringer_antal + 1
             else 1 end,
           aendringer_vindue_kl = case
             when not v_beloeb_aendret then aendringer_vindue_kl
             when aendringer_vindue_kl > now() - interval '1 minute' then aendringer_vindue_kl
             else now() end
     where auktion_id = p_auktion and bruger_id = v_uid;
    insert into public.bud_maksimum_log (auktion_id, bruger_id, maks_beloeb, forrige_beloeb,
                                         beskyttelse, forrige_beskyttelse)
    values (p_auktion, v_uid, p_maks, v_m.maks_beloeb, v_besk, v_m.beskyttelse);
  end if;

  if v_foerende is distinct from v_uid then
    -- Startbud på næste mindstebud (følger budtrappen, tæller som
    -- automatisk); zz_bids_autobud afgør resten i samme transaktion.
    perform set_config('bidhamr.autobud', 'start', true);
    insert into public.bids (auktion_id, bruger_id, "beløb", beskyttelse, auktion_redigeret_kl, automatisk)
    values (p_auktion, v_uid, v_min, v_besk, p_auktion_redigeret_kl, true);
    perform set_config('bidhamr.autobud', '', true);
    v_bud_afgivet := true;
  elsif v_beloeb_aendret then
    -- Den førende har ændret sit maksimum: står der et andet maksimum over
    -- det nuværende bud (fx fra en byder, der var spærret ved sidste runde),
    -- afgøres det nu.
    perform public.autobud_afgoer(p_auktion, v_uid, a.nuv, false);
  end if;

  select au."nuværende_bud" as nuv, au.slutter_kl into a
    from public.auctions au where au.id = p_auktion;
  select b.bruger_id into v_foerende
    from public.bids b
   where b.auktion_id = p_auktion
   order by b."beløb" desc, b.oprettet asc
   limit 1;

  return jsonb_build_object(
    'foerer', coalesce(v_foerende = v_uid, false),
    'nuvaerende_bud', a.nuv,
    'maks_beloeb', p_maks,
    'slutter_kl', a.slutter_kl,
    'bud_afgivet', v_bud_afgivet
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. rediger_auktion: + GPSR-felter (null = uændret, '' = ryd). Ny signatur
--    med standardværdier, så gamle kaldere (hjemmesiden, appen) virker.
-- ---------------------------------------------------------------------------
drop function if exists public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean, text);

create or replace function public.rediger_auktion(
  p_auktion uuid, p_titel text, p_beskrivelse text, p_billeder text[], p_kategori text,
  p_startpris numeric, p_forsendelse_mulig boolean, p_stand text default null::text,
  p_producent text default null::text, p_sikkerhedsoplysninger text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid   uuid := auth.uid();
  a       record;
  u       record;
  v_titel   text := btrim(coalesce(p_titel, ''));
  v_beskr   text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  v_kat     text := btrim(coalesce(p_kategori, ''));
  v_ver     timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_stand   text;
  v_forbudt jsonb;
  v_prod    text;
  v_sikker  text;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  -- Laaser raekken: et samtidigt bud (handle_new_bid, "for update") venter,
  -- til redigeringen er faerdig, eller er naaet foerst og ses herunder.
  select * into a from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = v_uid;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if a.status <> 'aktiv' then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'slut');
  end if;
  if a."nuværende_bud" is not null
     or exists (select 1 from public.bids b where b.auktion_id = a.id) then
    return jsonb_build_object('kode', 'har_bud');
  end if;

  if char_length(v_titel) < 1 or char_length(v_titel) > 120 then
    return jsonb_build_object('kode', 'ugyldig_titel');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 500 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if not public.er_gyldig_auktionskategori(v_kat) then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  -- Mindste startpris 1 kr - kun naar startprisen AENDRES, saa en gammel
  -- auktion med startpris 0 stadig kan faa rettet titel/billeder
  -- (samme regel som auctions_beskyt_kolonner).
  if p_startpris is distinct from a.startpris and p_startpris < 1 then
    return jsonb_build_object('kode', 'startpris_for_lav');
  end if;

  if not public.auktion_billeder_gyldige(v_uid, p_billeder) then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;

  -- Stand. null = uaendret (gamle kaldere uden p_stand).
  v_stand := coalesce(public.stand_normaliser(p_stand), a.stand);
  if v_stand is not null
     and v_stand not in ('ny_med_maerke', 'som_ny', 'god', 'brugt', 'defekt') then
    return jsonb_build_object('kode', 'ugyldig_stand');
  end if;

  -- NYT (erhverv): GPSR-felter. null = uaendret, '' = ryd. Private: altid null
  -- (auctions_zz_erhverv).
  v_prod   := case when p_producent is null then a.producent
                   else nullif(btrim(p_producent), '') end;
  v_sikker := case when p_sikkerhedsoplysninger is null then a.sikkerhedsoplysninger
                   else nullif(btrim(p_sikkerhedsoplysninger), '') end;
  if coalesce(a.erhverv, false) then
    if char_length(coalesce(v_prod, '')) > 500 or char_length(coalesce(v_sikker, '')) > 2000 then
      return jsonb_build_object('kode', 'erhverv_gpsr');
    end if;
    if v_stand = 'ny_med_maerke'
       and (char_length(coalesce(v_prod, '')) < 3 or char_length(coalesce(v_sikker, '')) < 3) then
      return jsonb_build_object('kode', 'erhverv_gpsr');
    end if;
  else
    v_prod := null;
    v_sikker := null;
  end if;

  -- Forbudte ord - kun naar teksten aendres (samme regel som
  -- auctions_indhold_kontrol, som ogsaa koerer ved selve opdateringen).
  if v_titel is distinct from a.titel or v_beskr is distinct from a.beskrivelse then
    v_forbudt := public.forbudt_tekst_tjek(v_titel || ' ' || coalesce(v_beskr, ''));
    if v_forbudt->>'resultat' = 'blokeret' then
      return jsonb_build_object('kode', 'forbudt_vare',
                                'kategori', v_forbudt->>'kategori',
                                'ord', v_forbudt->>'ord');
    end if;
  end if;

  update public.auctions
     set titel                 = v_titel,
         beskrivelse           = v_beskr,
         billeder              = p_billeder,
         kategori              = v_kat,
         startpris             = p_startpris,
         forsendelse_mulig     = coalesce(p_forsendelse_mulig, false),
         stand                 = v_stand,
         producent             = v_prod,
         sikkerhedsoplysninger = v_sikker,
         redigeret_kl          = v_ver
   where id = a.id;

  return jsonb_build_object('kode', 'ok', 'redigeret_kl', v_ver);
end;
$function$;

revoke all on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean, text, text, text) from public, anon;
grant execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. saet_annulleret_op_igen: kopierer GPSR-felterne og tjekker kvoten.
-- ---------------------------------------------------------------------------
create or replace function public.saet_annulleret_op_igen(p_auction uuid, p_seller uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  a      record;
  u      record;
  v_kode text;
  v_tjek jsonb;
  dage   integer;
  pris   numeric;
  ny_id  uuid;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_seller is null or a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til, konto_lukket_kl, konto_slettet_kl, konto_type into u
    from public.users where id = p_seller;
  if u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then
    return jsonb_build_object('kode', 'konto_lukket');
  end if;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;
  if not public.har_udbetalingskonto(p_seller) then
    return jsonb_build_object('kode', 'mangler_udbetalingskonto');
  end if;

  v_kode := public.kan_saette_op_igen(p_auction);
  if v_kode <> 'ok' then return jsonb_build_object('kode', v_kode); end if;

  -- NYT (erhverv): abonnement og ugens kvote (låser firmarækken).
  if u.konto_type = 'erhverv' then
    v_tjek := public.erhverv_kvote(p_seller, true);
    if v_tjek->>'kode' <> 'ok' then
      return jsonb_build_object('kode', v_tjek->>'kode', 'naeste_ledige', v_tjek->'naeste_ledige');
    end if;
  end if;

  -- Indholdskontrollen (auctions_indhold_kontrol) springer serveren over -
  -- forbudte ord tjekkes derfor her.
  v_tjek := public.forbudt_tekst_tjek(coalesce(a.titel, '') || ' ' || coalesce(a.beskrivelse, ''));
  if v_tjek->>'resultat' = 'blokeret' then
    return jsonb_build_object('kode', 'forbudt_vare', 'ord', v_tjek->>'ord', 'kategori', v_tjek->>'kategori');
  end if;

  dage := case when public.er_gyldig_varighed(a.varighed_dage) then a.varighed_dage else 7 end;
  pris := greatest(trunc(coalesce(a.startpris, 1)), 1);

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, varighed_dage, redigeret_kl,
    kategori, postnummer, lat, lng, maerke, stand, skjult,
    spoergsmaal_aktiv, forbudt_bekraeftet, producent, sikkerhedsoplysninger)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, pris, a.lokation,
    a.forsendelse_mulig, 'aktiv', now() + make_interval(days => dage), dage,
    date_trunc('milliseconds', now()),
    a.kategori, a.postnummer, a.lat, a.lng, a.maerke, a.stand, false,
    a.spoergsmaal_aktiv, a.forbudt_bekraeftet, a.producent, a.sikkerhedsoplysninger)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Firmaets egne RPC'er
-- ---------------------------------------------------------------------------

-- Pakken som jsonb (intern hjælper).
create or replace function public.erhverv_pakke_json(p_pakke uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'navn', p.navn, 'beskrivelse', p.beskrivelse,
                            'maanedspris', p.maanedspris, 'auktioner_pr_uge', p.auktioner_pr_uge,
                            'aktiv', p.aktiv)
    from public.erhverv_pakker p where p.id = p_pakke;
$$;

revoke all on function public.erhverv_pakke_json(uuid) from public, anon, authenticated;

create or replace function public.firma_oversigt()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  f         public.firmaer;
  v_maaned  timestamptz := (date_trunc('month', now() at time zone 'Europe/Copenhagen')) at time zone 'Europe/Copenhagen';
  v_pakke   uuid;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select * into f from public.firmaer where bruger_id = v_uid;
  if f.id is null then
    return null;
  end if;
  v_pakke := case when f.naeste_pakke_fra is not null and f.naeste_pakke_fra <= now()
                  then f.naeste_pakke_id else f.pakke_id end;

  return jsonb_build_object(
    'firma', jsonb_build_object(
      'id', f.id, 'firmanavn', f.firmanavn, 'cvr', f.cvr, 'adresse', f.adresse,
      'postnummer', f.postnummer, 'by', f.bynavn, 'telefon', f.telefon,
      'kontakt_email', f.kontakt_email, 'kontaktperson', f.kontaktperson,
      'abonnement_status', f.abonnement_status, 'abonnement_start', f.abonnement_start,
      'betalt_til', f.betalt_til, 'betaling_mislykket_kl', f.betaling_mislykket_kl,
      'pauset_aarsag', f.pauset_aarsag, 'naeste_periode', public.firma_naeste_periode(f.abonnement_start)),
    'pakke', public.erhverv_pakke_json(v_pakke),
    'naeste_pakke', case when v_pakke = f.pakke_id and f.naeste_pakke_id is not null
                         then public.erhverv_pakke_json(f.naeste_pakke_id)
                              || jsonb_build_object('fra', f.naeste_pakke_fra) end,
    'afventende_opgradering', (select public.erhverv_pakke_json(s.til_pakke_id)
                                      || jsonb_build_object('skift_id', s.id, 'anmodet_kl', s.oprettet_kl)
                                 from public.firma_pakkeskift s
                                where s.firma_id = f.id and s.status = 'afventer_betaling'),
    'pakker', coalesce((select jsonb_agg(public.erhverv_pakke_json(p.id) order by p.sortering, p.auktioner_pr_uge, p.navn)
                          from public.erhverv_pakker p where p.aktiv), '[]'::jsonb),
    'ugekvote', public.firma_ugekvote(),
    'auktioner', (select jsonb_build_object(
        'aktive', count(*) filter (where a.status = 'aktiv'),
        'i_alt', count(*),
        'visninger', coalesce(sum(a.visninger), 0),
        'visninger_aktive', coalesce(sum(a.visninger) filter (where a.status = 'aktiv'), 0),
        'bud', coalesce(sum(a.antal_bud), 0))
      from public.auctions a where a.bruger_id = v_uid),
    'salg', (select jsonb_build_object(
        'solgte_i_alt', count(*),
        'solgte_denne_maaned', count(*) filter (where t.created_at >= v_maaned),
        'omsaetning_i_alt', coalesce(sum(t.amount), 0),
        'omsaetning_denne_maaned', coalesce(sum(t.amount) filter (where t.created_at >= v_maaned), 0),
        'afsluttede_i_alt', count(*) filter (where t.status = 'afsluttet'),
        'omsaetning_afsluttede_i_alt', coalesce(sum(t.amount) filter (where t.status = 'afsluttet'), 0))
      from public.trades t where t.seller_id = v_uid and t.status <> 'annulleret'),
    'udbetalinger', (select jsonb_build_object(
        'udbetalt_i_alt_oere', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl is not null), 0),
        'udbetalt_denne_maaned_oere', coalesce(sum(b.udbetaling_oere) filter (where b.overfoert_kl >= v_maaned), 0),
        'paa_vej_oere', coalesce(sum(b.udbetaling_oere) filter (
            where b.status = 'betalt' and b.overfoert_kl is null and b.refunderet_kl is null), 0))
      from public.betalinger b where b.seller_id = v_uid),
    'venter_paa_dig', coalesce((select jsonb_agg(jsonb_build_object(
        'trade_id', t.id, 'auktion_id', t.auction_id, 'titel', a.titel, 'beloeb', t.amount,
        'afhentning', t.afhentning, 'status', t.status, 'oprettet', t.created_at) order by t.created_at)
      from public.trades t left join public.auctions a on a.id = t.auction_id
     where t.seller_id = v_uid and t.status = 'betaling_modtaget'), '[]'::jsonb),
    'ubesvarede_spoergsmaal', coalesce((select jsonb_agg(jsonb_build_object(
        'id', q.id, 'auktion_id', q.auction_id, 'titel', a.titel, 'spoergsmaal', q.question,
        'stillet_kl', q.asked_at) order by q.asked_at)
      from public.auction_questions q join public.auctions a on a.id = q.auction_id
     where a.bruger_id = v_uid and a.status = 'aktiv' and q.answer is null
       and not coalesce(q.hidden, false)), '[]'::jsonb),
    'regninger', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'nummer', r.nummer, 'type', r.type, 'periode_fra', r.periode_fra,
        'periode_til', r.periode_til, 'beloeb_oere', r.beloeb_oere, 'status', r.status,
        'pdf_url', r.pdf_url, 'betalt_kl', r.betalt_kl, 'oprettet', r.oprettet_kl) order by r.oprettet_kl desc)
      from public.firma_regninger r where r.firma_id = f.id), '[]'::jsonb),
    'kontakt_bidhamr', 'erhverv@bidhamr.dk'
  );
end $$;

revoke all on function public.firma_oversigt() from public, anon, authenticated;
grant execute on function public.firma_oversigt() to authenticated, service_role;

-- Firmaet skifter pakke.
--  - Opgradering (flere auktioner/uge): gemmes som 'afventer_betaling' og
--    giver IKKE flere auktioner, før firma_pakkeskift_betalt kaldes (Stripe).
--  - Nedgradering: gælder fra næste periode (naeste_pakke_*), intet refunderes.
--  - Samme pakke som nu: annullerer ventende skift.
-- Svar: {kode: opgradering_afventer_betaling | nedgradering_planlagt |
--        uaendret | ugyldig_pakke, ...}
create or replace function public.firma_skift_pakke(p_pakke uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  f       public.firmaer;
  nu      public.erhverv_pakker;
  ny      public.erhverv_pakker;
  v_fra   timestamptz;
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  select * into f from public.firmaer where bruger_id = v_uid for update;
  if f.id is null then
    raise exception 'erhverv_intet_abonnement: Kun firmakonti har et abonnement.' using errcode = 'BHE02';
  end if;
  if not public.rate_limit_tjek('firma_skift_pakke:' || v_uid::text, 10, 3600) then
    raise exception 'Du har prøvet for mange gange. Vent lidt, og prøv så igen.' using errcode = 'BHR01';
  end if;
  if f.abonnement_status <> 'aktiv' then
    raise exception 'erhverv_intet_abonnement: Abonnementet er ikke aktivt. Kontakt BidHamr på erhverv@bidhamr.dk.'
      using errcode = 'BHE02';
  end if;

  perform public.firma_anvend_planlagt(f.id);
  select * into f from public.firmaer where id = f.id;

  select * into ny from public.erhverv_pakker where id = p_pakke and aktiv;
  if ny.id is null then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  select * into nu from public.erhverv_pakker where id = f.pakke_id;

  if ny.id = nu.id then
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
     where id = f.id;
    return jsonb_build_object('kode', 'uaendret');
  end if;

  if ny.auktioner_pr_uge > nu.auktioner_pr_uge then
    -- Opgradering: en ny anmodning erstatter en tidligere ventende, og en
    -- planlagt nedgradering annulleres.
    update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
     where firma_id = f.id and status = 'afventer_betaling';
    update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
     where firma_id = f.id and status = 'planlagt';
    update public.firmaer set naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
     where id = f.id;
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af)
    values (f.id, nu.id, ny.id, 'opgradering', 'afventer_betaling', v_uid)
    returning id into v_id;
    -- TODO(Stripe): src/lib/erhverv/betaling.ts startOpgradering opdaterer
    -- abonnementet med proration og kalder firma_pakkeskift_betalt, når
    -- fakturaen er betalt (webhook invoice.paid).
    return jsonb_build_object('kode', 'opgradering_afventer_betaling', 'skift_id', v_id,
                              'pakke', public.erhverv_pakke_json(ny.id));
  end if;

  -- Nedgradering (eller samme antal auktioner): fra næste periode.
  v_fra := coalesce(f.betalt_til, public.firma_naeste_periode(f.abonnement_start));
  update public.firma_pakkeskift set status = 'erstattet', behandlet_kl = now()
   where firma_id = f.id and status = 'planlagt';
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = f.id and status = 'afventer_betaling';
  update public.firmaer set naeste_pakke_id = ny.id, naeste_pakke_fra = v_fra, opdateret_kl = now()
   where id = f.id;
  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, gaelder_fra, anmodet_af)
  values (f.id, nu.id, ny.id, 'nedgradering', 'planlagt', v_fra, v_uid)
  returning id into v_id;
  -- TODO(Stripe): startNedgradering planlægger skiftet i Stripe ved
  -- periodens udløb (subscription schedule) - ingen refusion.
  return jsonb_build_object('kode', 'nedgradering_planlagt', 'skift_id', v_id, 'gaelder_fra', v_fra,
                            'pakke', public.erhverv_pakke_json(ny.id));
end $$;

revoke all on function public.firma_skift_pakke(uuid) from public, anon, authenticated;
grant execute on function public.firma_skift_pakke(uuid) to authenticated, service_role;

-- Offentlige firmaoplysninger til mærket "Erhvervssælger" og firmaprofilen.
-- Vises også efter opsigelse (køberen skal kunne reklamere i 2 år).
create or replace function public.firma_offentlig(p_bruger uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bruger_id', f.bruger_id, 'firmanavn', f.firmanavn, 'cvr', f.cvr,
    'adresse', f.adresse, 'postnummer', f.postnummer, 'by', f.bynavn,
    'telefon', f.telefon, 'kontakt_email', f.kontakt_email,
    'aktiv', f.abonnement_status = 'aktiv', 'siden', f.oprettet_kl)
    from public.firmaer f
    join public.users u on u.id = f.bruger_id
   where f.bruger_id = p_bruger and u.konto_slettet_kl is null;
$$;

revoke all on function public.firma_offentlig(uuid) from public, anon, authenticated;
grant execute on function public.firma_offentlig(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. Staff-RPC'er (kun service_role; serveren sender p_staff efter
--     assertErhverv i src/lib/adminAuth.ts, og databasen tjekker rollen igen)
-- ---------------------------------------------------------------------------
create or replace function public.erhverv_henvendelser_liste(p_staff uuid, p_status text default null, p_arkiverede boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(x order by (x->>'oprettet_kl')::timestamptz desc) from (
    select to_jsonb(h) - 'ip_hash'
           || jsonb_build_object('behandlet_af_navn', s.navn,
                                 'firma_id', (select f.id from public.firmaer f where f.henvendelse_id = h.id limit 1)) as x
      from public.erhverv_henvendelser h
      left join public.users s on s.id = h.behandlet_af
     where (p_status is null or h.status = p_status)
       and (case when coalesce(p_arkiverede, false) then h.arkiveret_kl is not null
                 else h.arkiveret_kl is null end)
     order by h.oprettet_kl desc
     limit 500) q), '[]'::jsonb);
end $$;

revoke all on function public.erhverv_henvendelser_liste(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_henvendelser_liste(uuid, text, boolean) to service_role;

-- null = uændret. p_arkiver: true arkiverer, false henter tilbage.
create or replace function public.erhverv_henvendelse_opdater(
  p_staff uuid, p_id uuid, p_status text default null, p_noter text default null, p_arkiver boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.erhverv_henvendelser;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into h from public.erhverv_henvendelser where id = p_id for update;
  if h.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_status is not null and p_status not in ('ny', 'i_gang', 'godkendt', 'afvist') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if p_noter is not null and char_length(p_noter) > 10000 then
    return jsonb_build_object('kode', 'for_lang_note');
  end if;

  update public.erhverv_henvendelser
     set status       = coalesce(p_status, status),
         noter        = case when p_noter is null then noter else nullif(btrim(p_noter), '') end,
         arkiveret_kl = case when p_arkiver is null then arkiveret_kl
                             when p_arkiver then coalesce(arkiveret_kl, now()) else null end,
         behandlet_af = p_staff,
         behandlet_kl = now(),
         opdateret_kl = now()
   where id = p_id;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_henvendelse_opdateret', 'erhverv_henvendelse', p_id, null,
          left(concat_ws('; ',
            case when p_status is not null and p_status <> h.status then 'Status: ' || h.status || ' → ' || p_status end,
            case when p_noter is not null then 'Noter opdateret' end,
            case when p_arkiver is true then 'Arkiveret' when p_arkiver is false then 'Hentet fra arkiv' end,
            h.firmanavn || ' (CVR ' || h.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.erhverv_henvendelse_opdater(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.erhverv_henvendelse_opdater(uuid, uuid, text, text, boolean) to service_role;

create or replace function public.erhverv_pakker_liste(p_staff uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(public.erhverv_pakke_json(p.id)
                     || jsonb_build_object('sortering', p.sortering,
                                           'antal_firmaer', (select count(*) from public.firmaer f
                                                              where f.pakke_id = p.id and f.abonnement_status <> 'opsagt'))
                     order by p.sortering, p.auktioner_pr_uge, p.navn)
                     from public.erhverv_pakker p), '[]'::jsonb);
end $$;

revoke all on function public.erhverv_pakker_liste(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_pakker_liste(uuid) to service_role;

-- Kun chef. p_id null = ny pakke.
create or replace function public.erhverv_pakke_gem(
  p_staff uuid, p_id uuid, p_navn text, p_beskrivelse text, p_maanedspris numeric,
  p_auktioner_pr_uge integer, p_aktiv boolean default true, p_sortering integer default 0)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_navn text := btrim(coalesce(p_navn, ''));
  v_id   uuid;
begin
  if not public.erhverv_har_adgang(p_staff, true) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  if char_length(v_navn) < 1 or char_length(v_navn) > 60 then
    return jsonb_build_object('kode', 'ugyldigt_navn');
  end if;
  if p_beskrivelse is not null and char_length(p_beskrivelse) > 1000 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if p_maanedspris is not null and (p_maanedspris < 0 or p_maanedspris > 1000000 or p_maanedspris <> trunc(p_maanedspris)) then
    return jsonb_build_object('kode', 'ugyldig_pris');
  end if;
  if p_auktioner_pr_uge is null or p_auktioner_pr_uge < 1 or p_auktioner_pr_uge > 1000 then
    return jsonb_build_object('kode', 'ugyldigt_antal');
  end if;
  if exists (select 1 from public.erhverv_pakker where lower(navn) = lower(v_navn) and id is distinct from p_id) then
    return jsonb_build_object('kode', 'navn_findes');
  end if;

  if p_id is null then
    insert into public.erhverv_pakker (navn, beskrivelse, maanedspris, auktioner_pr_uge, aktiv, sortering,
                                       oprettet_af, opdateret_af)
    values (v_navn, nullif(btrim(coalesce(p_beskrivelse, '')), ''), p_maanedspris, p_auktioner_pr_uge,
            coalesce(p_aktiv, true), coalesce(p_sortering, 0), p_staff, p_staff)
    returning id into v_id;
  else
    update public.erhverv_pakker
       set navn = v_navn, beskrivelse = nullif(btrim(coalesce(p_beskrivelse, '')), ''),
           maanedspris = p_maanedspris, auktioner_pr_uge = p_auktioner_pr_uge,
           aktiv = coalesce(p_aktiv, aktiv), sortering = coalesce(p_sortering, sortering),
           opdateret_af = p_staff, opdateret_kl = now()
     where id = p_id
    returning id into v_id;
    if v_id is null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'erhverv_pakke_gemt', 'erhverv_pakke', v_id, null,
          left(format('%s: %s auktioner/uge, %s kr./md., %s',
                      v_navn, p_auktioner_pr_uge, coalesce(p_maanedspris::text, 'pris ikke sat'),
                      case when coalesce(p_aktiv, true) then 'aktiv' else 'ikke aktiv' end), 1000));

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end $$;

revoke all on function public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer) from public, anon, authenticated;
grant execute on function public.erhverv_pakke_gem(uuid, uuid, text, text, numeric, integer, boolean, integer) to service_role;

-- Gør en NY auth-bruger (lige oprettet af serveren via generateLink 'invite')
-- til firmakonto. Kaldes kun af serveren (opretFirmakonto).
create or replace function public.erhverv_firma_opret(
  p_staff uuid, p_bruger uuid, p_firmanavn text, p_cvr text, p_adresse text, p_postnummer text,
  p_by text, p_telefon text, p_kontakt_email text, p_kontaktperson text, p_pakke uuid,
  p_henvendelse uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  u    record;
  h    public.erhverv_henvendelser;
  v_id uuid;
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;

  select * into u from public.users where id = p_bruger for update;
  if u.id is null then
    return jsonb_build_object('kode', 'bruger_findes_ikke');
  end if;
  -- Kun en helt ny konto: aldrig en eksisterende privat konto.
  if u.konto_type <> 'privat' or u.rolle <> 'bruger'
     or u.konto_slettet_kl is not null or u.konto_lukket_kl is not null
     or u.oprettet < now() - interval '1 hour'
     or exists (select 1 from public.auctions a where a.bruger_id = p_bruger)
     or exists (select 1 from public.bids b where b.bruger_id = p_bruger)
     or exists (select 1 from public.trades t where t.buyer_id = p_bruger or t.seller_id = p_bruger)
     or exists (select 1 from public.firmaer f where f.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_ny_konto');
  end if;

  if p_cvr is null or p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;
  if exists (select 1 from public.firmaer f where f.cvr = p_cvr and f.abonnement_status <> 'opsagt') then
    return jsonb_build_object('kode', 'cvr_findes');
  end if;
  if not exists (select 1 from public.erhverv_pakker p where p.id = p_pakke) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_henvendelse is not null then
    select * into h from public.erhverv_henvendelser where id = p_henvendelse for update;
    if h.id is null then
      return jsonb_build_object('kode', 'henvendelse_findes_ikke');
    end if;
    if exists (select 1 from public.firmaer f where f.henvendelse_id = p_henvendelse) then
      return jsonb_build_object('kode', 'henvendelse_brugt');
    end if;
  end if;

  begin
    insert into public.firmaer (bruger_id, firmanavn, cvr, adresse, postnummer, bynavn, telefon,
                                kontakt_email, kontaktperson, henvendelse_id, pakke_id, oprettet_af)
    values (p_bruger, btrim(p_firmanavn), p_cvr, btrim(p_adresse), btrim(p_postnummer), btrim(p_by),
            btrim(p_telefon), lower(btrim(p_kontakt_email)), btrim(p_kontaktperson), p_henvendelse,
            p_pakke, p_staff)
    returning id into v_id;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  update public.users
     set konto_type = 'erhverv',
         navn = left(btrim(p_firmanavn), 200),
         fornavn = null,
         efternavn = null,
         telefon = btrim(p_telefon)
   where id = p_bruger;

  insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl)
  values (v_id, null, p_pakke, 'start', 'gennemfoert', p_staff, now());

  if p_henvendelse is not null then
    update public.erhverv_henvendelser
       set status = 'godkendt', behandlet_af = p_staff, behandlet_kl = now(), opdateret_kl = now()
     where id = p_henvendelse;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_oprettet', 'firma', v_id, p_bruger,
          left(btrim(p_firmanavn) || ' (CVR ' || p_cvr || ')', 1000));

  return jsonb_build_object('kode', 'ok', 'firma_id', v_id);
end $$;

revoke all on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opret(uuid, uuid, text, text, text, text, text, text, text, text, uuid, uuid) to service_role;

create or replace function public.erhverv_firmaer_liste(p_staff uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(f)
        || jsonb_build_object(
             'login_email', u.email,
             'har_logget_ind', au.last_sign_in_at is not null,
             'pakke', public.erhverv_pakke_json(f.pakke_id),
             'naeste_pakke', public.erhverv_pakke_json(f.naeste_pakke_id),
             'afventende_opgradering', (select public.erhverv_pakke_json(s.til_pakke_id)
                                               || jsonb_build_object('skift_id', s.id)
                                          from public.firma_pakkeskift s
                                         where s.firma_id = f.id and s.status = 'afventer_betaling'),
             'aktive_auktioner', (select count(*) from public.auctions a
                                   where a.bruger_id = f.bruger_id and a.status = 'aktiv'),
             'oprettet_af_navn', s.navn)
        order by f.oprettet_kl desc)
      from public.firmaer f
      join public.users u on u.id = f.bruger_id
      left join auth.users au on au.id = f.bruger_id
      left join public.users s on s.id = f.oprettet_af), '[]'::jsonb);
end $$;

revoke all on function public.erhverv_firmaer_liste(uuid) from public, anon, authenticated;
grant execute on function public.erhverv_firmaer_liste(uuid) to service_role;

-- Staff ændrer et firma. null = uændret.
--  - p_pakke: skifter pakken MED DET SAMME (fx efter manuel aftale). En
--    ventende opgradering til samme pakke markeres gennemført, andre ventende
--    skift annulleres.
--  - p_status: aktiv | pauset | opsagt.
create or replace function public.erhverv_firma_opdater(
  p_staff uuid, p_firma uuid, p_pakke uuid default null, p_status text default null,
  p_firmanavn text default null, p_cvr text default null, p_adresse text default null,
  p_postnummer text default null, p_by text default null, p_telefon text default null,
  p_kontakt_email text default null, p_kontaktperson text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f        public.firmaer;
  v_tekst  text[] := '{}';
begin
  if not public.erhverv_har_adgang(p_staff) then
    raise exception 'Ingen adgang' using errcode = '42501';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_status is not null and p_status not in ('aktiv', 'pauset', 'opsagt') then
    return jsonb_build_object('kode', 'ugyldig_status');
  end if;
  if p_pakke is not null and not exists (select 1 from public.erhverv_pakker where id = p_pakke) then
    return jsonb_build_object('kode', 'ugyldig_pakke');
  end if;
  if p_cvr is not null and p_cvr !~ '^[0-9]{8}$' then
    return jsonb_build_object('kode', 'ugyldigt_cvr');
  end if;

  begin
    update public.firmaer
       set firmanavn      = coalesce(nullif(btrim(p_firmanavn), ''), firmanavn),
           cvr            = coalesce(p_cvr, cvr),
           adresse        = coalesce(nullif(btrim(p_adresse), ''), adresse),
           postnummer     = coalesce(nullif(btrim(p_postnummer), ''), postnummer),
           bynavn         = coalesce(nullif(btrim(p_by), ''), bynavn),
           telefon        = coalesce(nullif(btrim(p_telefon), ''), telefon),
           kontakt_email  = coalesce(lower(nullif(btrim(p_kontakt_email), '')), kontakt_email),
           kontaktperson  = coalesce(nullif(btrim(p_kontaktperson), ''), kontaktperson),
           abonnement_status = coalesce(p_status, abonnement_status),
           pauset_aarsag  = case when p_status is null then pauset_aarsag
                                 when p_status = 'pauset' then 'bidhamr' else null end,
           opsagt_kl      = case when p_status = 'opsagt' then coalesce(opsagt_kl, now())
                                 when p_status is not null then null else opsagt_kl end,
           pakke_id       = coalesce(p_pakke, pakke_id),
           naeste_pakke_id  = case when p_pakke is not null then null else naeste_pakke_id end,
           naeste_pakke_fra = case when p_pakke is not null then null else naeste_pakke_fra end,
           opdateret_kl   = now()
     where id = p_firma;
  exception
    when unique_violation then
      return jsonb_build_object('kode', 'cvr_findes');
    when check_violation then
      return jsonb_build_object('kode', 'ugyldige_felter');
  end;

  if p_firmanavn is not null and nullif(btrim(p_firmanavn), '') is not null then
    update public.users set navn = left(btrim(p_firmanavn), 200) where id = f.bruger_id;
  end if;

  if p_pakke is not null and p_pakke is distinct from f.pakke_id then
    update public.firma_pakkeskift
       set status = case when til_pakke_id = p_pakke and status = 'afventer_betaling' then 'gennemfoert' else 'annulleret' end,
           behandlet_kl = now(),
           note = coalesce(note, 'Afgjort af BidHamr')
     where firma_id = f.id and status in ('afventer_betaling', 'planlagt');
    insert into public.firma_pakkeskift (firma_id, fra_pakke_id, til_pakke_id, type, status, anmodet_af, behandlet_kl, note)
    values (f.id, f.pakke_id, p_pakke, 'bidhamr', 'gennemfoert', p_staff, now(), left(p_note, 1000));
    v_tekst := v_tekst || 'Pakke ændret'::text;
  end if;
  if p_status is not null and p_status <> f.abonnement_status then
    v_tekst := v_tekst || ('Status: ' || f.abonnement_status || ' → ' || p_status);
  end if;
  if coalesce(p_firmanavn, p_cvr, p_adresse, p_postnummer, p_by, p_telefon, p_kontakt_email, p_kontaktperson) is not null then
    v_tekst := v_tekst || 'Firmaoplysninger ændret'::text;
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'firma_opdateret', 'firma', f.id, f.bruger_id,
          left(concat_ws('; ', array_to_string(v_tekst, '; '), nullif(btrim(coalesce(p_note, '')), ''),
                         f.firmanavn || ' (CVR ' || f.cvr || ')'), 1000));

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.erhverv_firma_opdater(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Stripe-kroge (kun service_role). Kaldes af Stripe-webhooks, når Stripe
--     kobles på (src/lib/erhverv/betaling.ts). Idempotente på
--     p_stripe_reference (fx Stripe invoice id / event id).
-- ---------------------------------------------------------------------------

-- Opgraderingen er betalt: aktivér pakken med det samme og lav regningen.
create or replace function public.firma_pakkeskift_betalt(
  p_skift uuid, p_stripe_reference text, p_beloeb_oere bigint, p_stripe_invoice_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.firma_pakkeskift;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into s from public.firma_pakkeskift where id = p_skift for update;
  if s.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.status = 'gennemfoert' and s.stripe_reference = p_stripe_reference then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;
  if s.status <> 'afventer_betaling' then
    return jsonb_build_object('kode', 'ikke_afventende', 'status', s.status);
  end if;

  perform 1 from public.firmaer where id = s.firma_id for update;

  update public.firma_pakkeskift
     set status = 'gennemfoert', behandlet_kl = now(), stripe_reference = p_stripe_reference
   where id = s.id;
  update public.firmaer
     set pakke_id = s.til_pakke_id, naeste_pakke_id = null, naeste_pakke_fra = null, opdateret_kl = now()
   where id = s.firma_id;
  update public.firma_pakkeskift set status = 'annulleret', behandlet_kl = now()
   where firma_id = s.firma_id and status = 'planlagt';

  insert into public.firma_regninger (firma_id, type, periode_fra, beloeb_oere, status,
                                      stripe_invoice_id, stripe_reference, betalt_kl)
  values (s.firma_id, 'opgradering', (now() at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'skift:' || p_stripe_reference, now())
  on conflict do nothing;

  return jsonb_build_object('kode', 'ok', 'firma_id', s.firma_id);
end $$;

revoke all on function public.firma_pakkeskift_betalt(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.firma_pakkeskift_betalt(uuid, text, bigint, text) to service_role;

-- Månedens abonnement er betalt (Stripe invoice.paid). Genaktiverer et firma,
-- der var pauset pga. betaling, og gennemfører en planlagt nedgradering, når
-- den nye periode er startet.
create or replace function public.firma_abonnement_betalt(
  p_firma uuid, p_periode_start timestamptz, p_periode_slut timestamptz, p_beloeb_oere bigint,
  p_stripe_reference text, p_stripe_invoice_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
  v_ny integer;
begin
  if p_stripe_reference is null or btrim(p_stripe_reference) = '' then
    raise exception 'Mangler Stripe-reference';
  end if;
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  insert into public.firma_regninger (firma_id, type, periode_fra, periode_til, beloeb_oere, status,
                                      stripe_invoice_id, stripe_reference, betalt_kl)
  values (f.id, 'abonnement', (p_periode_start at time zone 'Europe/Copenhagen')::date,
          (p_periode_slut at time zone 'Europe/Copenhagen')::date,
          greatest(coalesce(p_beloeb_oere, 0), 0), 'betalt', p_stripe_invoice_id,
          'abon:' || p_stripe_reference, now())
  on conflict do nothing;
  get diagnostics v_ny = row_count;
  if v_ny = 0 then
    return jsonb_build_object('kode', 'allerede_registreret');
  end if;

  update public.firmaer
     set betalt_til = greatest(coalesce(betalt_til, p_periode_slut), p_periode_slut),
         betaling_mislykket_kl = null,
         abonnement_status = case when abonnement_status = 'pauset' and pauset_aarsag = 'betaling'
                                  then 'aktiv' else abonnement_status end,
         pauset_aarsag = case when abonnement_status = 'pauset' and pauset_aarsag = 'betaling'
                              then null else pauset_aarsag end,
         opdateret_kl = now()
   where id = f.id;

  -- Planlagt nedgradering: gælder fra den periode, der nu er betalt.
  update public.firmaer set naeste_pakke_fra = least(naeste_pakke_fra, p_periode_start)
   where id = f.id and naeste_pakke_fra is not null and naeste_pakke_fra <= p_periode_start + interval '1 day';
  perform public.firma_anvend_planlagt(f.id);

  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.firma_abonnement_betalt(uuid, timestamptz, timestamptz, bigint, text, text) from public, anon, authenticated;
grant execute on function public.firma_abonnement_betalt(uuid, timestamptz, timestamptz, bigint, text, text) to service_role;

-- Betalingen af abonnementet er mislykket (Stripe invoice.payment_failed).
-- Regel (forslag): firmaet kan sælge videre i 7 dage, mens Stripe prøver
-- igen. Er der stadig ikke betalt efter 7 dage, sættes abonnementet på pause
-- (firma_abonnement_frist_koer, cron) - nye auktioner kan ikke oprettes, men
-- igangværende auktioner og handler kører færdigt. Betaling genaktiverer.
create or replace function public.firma_abonnement_mislykket(
  p_firma uuid, p_stripe_reference text, p_beloeb_oere bigint default null, p_stripe_invoice_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.firmaer;
begin
  select * into f from public.firmaer where id = p_firma for update;
  if f.id is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  update public.firmaer
     set betaling_mislykket_kl = coalesce(betaling_mislykket_kl, now()), opdateret_kl = now()
   where id = f.id;
  if p_stripe_reference is not null then
    insert into public.firma_regninger (firma_id, type, beloeb_oere, status, stripe_invoice_id, stripe_reference)
    values (f.id, 'abonnement', greatest(coalesce(p_beloeb_oere, 0), 0), 'mislykket', p_stripe_invoice_id,
            'fejl:' || p_stripe_reference)
    on conflict do nothing;
  end if;
  return jsonb_build_object('kode', 'ok', 'pause_fra', coalesce(f.betaling_mislykket_kl, now()) + interval '7 days');
end $$;

revoke all on function public.firma_abonnement_mislykket(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.firma_abonnement_mislykket(uuid, text, bigint, text) to service_role;

-- Cron (fx dagligt): pauser firmaer, hvis betaling har fejlet i over 7 dage.
create or replace function public.firma_abonnement_frist_koer()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  update public.firmaer
     set abonnement_status = 'pauset', pauset_aarsag = 'betaling', opdateret_kl = now()
   where abonnement_status = 'aktiv'
     and betaling_mislykket_kl is not null
     and betaling_mislykket_kl < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.firma_abonnement_frist_koer() from public, anon, authenticated;
grant execute on function public.firma_abonnement_frist_koer() to service_role;

-- ---------------------------------------------------------------------------
-- 12. Kontosletning: firmakonti lukkes af BidHamr; sælger-rollen blokerer
--     som andre staff-roller. Ellers uændret.
-- ---------------------------------------------------------------------------
create or replace function public.konto_sletning_blokeringer(p_bruger uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(distinct b), '[]'::jsonb) from (
    select jsonb_build_object('type', 'staff', 'tekst', 'Din medarbejderrolle', 'link', null) as b
      from public.users u
     where u.id = p_bruger and u.rolle in ('medarbejder', 'admin', 'chef', 'saelger')
    union all
    -- NYT (erhverv): en firmakonto slettes ikke af firmaet selv.
    select jsonb_build_object('type', 'firmakonto', 'tekst', 'Firmakonto', 'link', null)
      from public.users u
     where u.id = p_bruger and u.konto_type = 'erhverv'
    union all
    select jsonb_build_object('type', 'auktion_med_bud', 'tekst', a.titel, 'link', '/auktion/' || a.id)
      from public.auctions a
     where a.bruger_id = p_bruger
       and a.status = 'aktiv'
       and (a."nuværende_bud" is not null
            or exists (select 1 from public.bids x where x.auktion_id = a.id))
    union all
    select jsonb_build_object('type', 'bud_paa_aktiv', 'tekst', a.titel, 'link', '/auktion/' || a.id)
      from public.auctions a
     where a.status = 'aktiv'
       and a.bruger_id <> p_bruger
       and exists (select 1 from public.bids x
                    where x.auktion_id = a.id and x.bruger_id = p_bruger)
    union all
    select jsonb_build_object(
             'type', case when t.status = 'afventer_betaling' and t.buyer_id = p_bruger
                          then 'mangler_betaling' else 'aaben_handel' end,
             'tekst', coalesce(a.titel, 'Handel'),
             'link', '/mine-handler/' || t.id)
      from public.trades t
      left join public.auctions a on a.id = t.auction_id
     where (t.buyer_id = p_bruger or t.seller_id = p_bruger)
       and t.status not in ('afsluttet', 'annulleret')
    union all
    select jsonb_build_object('type', 'aaben_sag', 'tekst', coalesce(a.titel, 'Sag'),
                              'link', '/mine-handler/' || t.id)
      from public.sager s
      join public.trades t on t.id = s.trade_id
      left join public.auctions a on a.id = t.auction_id
     where (t.buyer_id = p_bruger or t.seller_id = p_bruger)
       and (s.status in ('aaben', 'afventer_retur')
            or (s.penge_handling is not null and s.afviklet_kl is null))
    union all
    select jsonb_build_object('type', 'aaben_anke', 'tekst', coalesce(a.titel, 'Anke'),
                              'link', '/mine-handler/' || t.id)
      from public.sag_anker k
      join public.trades t on t.id = k.trade_id
      left join public.auctions a on a.id = t.auction_id
     where (t.buyer_id = p_bruger or t.seller_id = p_bruger)
       and k.status = 'afventer'
    union all
    select jsonb_build_object('type', 'aabent_tilbud', 'tekst', coalesce(a.titel, 'Tilbud'),
                              'link', case when o.byder_id = p_bruger
                                           then '/andenchance/' || o.id
                                           else '/mine-handler/' || o.oprindelig_trade_id end)
      from public.andenchance_tilbud o
      left join public.auctions a on a.id = o.auction_id
     where (o.byder_id = p_bruger or o.seller_id = p_bruger)
       and o.status = 'afventer'
    union all
    select jsonb_build_object('type', 'penge_undervejs', 'tekst', coalesce(a.titel, 'Betaling'),
                              'link', '/mine-handler/' || b.trade_id)
      from public.betalinger b
      left join public.auctions a on a.id = b.auction_id
     where (b.buyer_id = p_bruger or b.seller_id = p_bruger)
       and (b.status = 'behandles'
            or (b.seller_id = p_bruger and b.status = 'betalt' and b.frigivet_kl is not null
                and b.stripe_transfer_id is null and b.refunderet_kl is null)
            or (b.buyer_id = p_bruger and b.refusion_anmodet_kl is not null and b.refunderet_kl is null)
            or (b.indsigelse_kl is not null
                and coalesce(b.indsigelse_status, '') not in ('won', 'lost', 'warning_closed', 'prevented')))
    union all
    select jsonb_build_object('type', 'ubetalt_sag', 'tekst', coalesce(a.titel, 'Manglende betaling'),
                              'link', '/mine-handler/' || v.trade_id)
      from public.ubetalte_vindere v
      left join public.auctions a on a.id = v.auction_id
     where v.buyer_id = p_bruger and v.status = 'afventer'
  ) s;
$function$;

-- ---------------------------------------------------------------------------
-- 13. mine_data: + firmadata. Flettes ind i den NUVÆRENDE definition (den er
--     lang og ændres af flere migrationer), så intet andet overskrives.
-- ---------------------------------------------------------------------------
create or replace function public.mine_firmadata()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'firma', to_jsonb(f) - 'stripe_customer_id' - 'stripe_subscription_id',
    'pakke', public.erhverv_pakke_json(f.pakke_id),
    'pakkeskift', coalesce((select jsonb_agg(jsonb_build_object(
        'fra', (select p.navn from public.erhverv_pakker p where p.id = s.fra_pakke_id),
        'til', (select p.navn from public.erhverv_pakker p where p.id = s.til_pakke_id),
        'type', s.type, 'status', s.status, 'gaelder_fra', s.gaelder_fra,
        'oprettet', s.oprettet_kl, 'behandlet', s.behandlet_kl) order by s.oprettet_kl)
      from public.firma_pakkeskift s where s.firma_id = f.id), '[]'::jsonb),
    'regninger', coalesce((select jsonb_agg(jsonb_build_object(
        'nummer', r.nummer, 'type', r.type, 'periode_fra', r.periode_fra, 'periode_til', r.periode_til,
        'beloeb_oere', r.beloeb_oere, 'status', r.status, 'betalt_kl', r.betalt_kl,
        'oprettet', r.oprettet_kl) order by r.oprettet_kl)
      from public.firma_regninger r where r.firma_id = f.id), '[]'::jsonb),
    'henvendelse', (select jsonb_build_object(
        'firmanavn', h.firmanavn, 'cvr', h.cvr, 'kontaktperson', h.kontaktperson,
        'telefon', h.telefon, 'email', h.email, 'adresse', h.adresse, 'postnummer', h.postnummer,
        'by', h.bynavn, 'hvad_saelger_i', h.hvad_saelger_i, 'antal_varer_ca', h.antal_varer_ca,
        'besked', h.besked, 'status', h.status, 'sendt', h.oprettet_kl)
      from public.erhverv_henvendelser h where h.id = f.henvendelse_id))
  from public.firmaer f where f.bruger_id = auth.uid();
$$;

revoke all on function public.mine_firmadata() from public, anon, authenticated;

do $$
declare
  v_def text := pg_get_functiondef('public.mine_data()'::regprocedure);
  v_gl  text := 'return v || jsonb_build_object(''mine_maksimumbud'', public.mine_maksimumbud());';
  v_ny  text := 'return v || jsonb_build_object(''mine_maksimumbud'', public.mine_maksimumbud(), ''firmakonto'', public.mine_firmadata());';
begin
  if position(v_ny in v_def) > 0 then
    return; -- allerede flettet
  end if;
  if position(v_gl in v_def) = 0 then
    raise exception 'mine_data har ikke den forventede slutning - flet firmadata ind manuelt';
  end if;
  execute replace(v_def, v_gl, v_ny);
end $$;
