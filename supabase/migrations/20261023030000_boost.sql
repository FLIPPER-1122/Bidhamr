-- Boost (Filip, 13. okt. 2026 - ROADMAP-BESLUTNINGER, "Nye funktioner").
--
--   - Boost-point kan købes: 100 point for 39 kr. (inkl. moms). Det er
--     BidHamrs EGEN omsætning: en PaymentIntent på BidHamrs PLATFORMSKONTO
--     (ingen on_behalf_of, ingen transfer_data, intet application fee) med
--     tvungen 3D Secure ('any'), metadata type 'boost', boost_koeb_id,
--     bruger_id, point og bidhamr_db, og en idempotency key pr. køb og
--     forsøg (src/lib/betaling/boost.ts). Køberen får en faktura i Dinero-
--     køen (fakturaer.slags 'boost', salgskonto med moms).
--   - Et boost koster 50 point og lægger opslaget i toppen i 24 timer.
--   - 10 point pr. GENNEMFØRT salg (pengene er frigivet til sælgeren - samme
--     definition som gennemfoerte_salg i 20261023020000_badge_konkurrence.sql),
--     kun når buddet er mindst 50 kr., og højst 10 point pr. køber pr.
--     sælger pr. måned (Filip, 15. okt. 2026 - se afsnit 9).
--     Annullerede og refunderede handler giver ingen point, og point fra en
--     handel, der senere refunderes, trækkes tilbage, så langt saldoen
--     rækker (saldoen bliver aldrig negativ).
--   - Kun private konti kan købe, optjene og bruge point. Firmaer kan ikke.
--   - Et boostet opslag vises tydeligt som "Boostet" (markedsføringsloven).
--
-- Pointkontoen er en APPEND-ONLY ledger (boost_posteringer): køb, optjening,
-- forbrug, tilbageførsel og staff-justering. Saldoen er summen af
-- posteringerne. En postering kan aldrig ændres eller slettes (triggere, og
-- ingen har update/delete-rettighed - heller ikke service role). Hver
-- postering låser brugerens pointkonto (advisory lock), tjekker saldoen og
-- gemmer saldo_efter (>= 0), så samme point aldrig kan bruges to gange, og
-- saldoen aldrig kan blive negativ - uanset hvor mange kald der kommer
-- samtidig. Idempotens: unikke indeks (ét køb giver point én gang, én
-- optjening og én tilbageførsel pr. betaling, ét forbrug pr. boost, én
-- staff-justering pr. nøgle).
--
-- Uafklaret hos advokaten (jura/noter-til-advokat.md 128-130) - styres af
-- boost_indstillinger, men logikken er IKKE bygget, og CHECK'en tillader kun
-- dagens valg, så de ikke kan slås til ved et uheld:
--   - fortrydelsesret: kraev_fortrydelse_samtykke (false nu). Er den true,
--     kræver boost_koeb_start samtykket, og tidspunktet gemmes på købet.
--   - udløb: point_udloeber_dage (NULL = point udløber ikke).
--   - refusion ved kontolukning: refusion_ved_lukning (false = ingen
--     automatisk refusion; staff kan refundere et køb, chef).
--
-- Sortering (boost_top): boostede auktioner kommer først på forsiden, i
-- kategori og i søgning, mens boostet varer - højst maks_pladser (4) pr.
-- liste. Er der flere, roteres de: listen over boostede (sorteret efter
-- boost-start) forskydes med maks_pladser for hvert rotationsvindue (10
-- min), så alle boostede får lige mange visninger øverst. De viste sorteres
-- indbyrdes efter boost-start.
--
-- Ændrer INGEN eksisterende funktioner. Ændrer på eksisterende tabeller: ny
-- kolonne, CHECK, unikt indeks og trigger på fakturaer; nye værdier i
-- moderation_log's CHECK. Idempotent (kan køres igen). Én transaktion: filen
-- køres som én samlet forespørgsel, så en fejl ruller alt tilbage. Kun
-- testdatabasen, indtil Filip siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.users') is null or to_regclass('public.auctions') is null
     or to_regclass('public.betalinger') is null or to_regclass('public.fakturaer') is null
     or to_regclass('public.moderation_log') is null or to_regclass('public.trades') is null then
    raise exception 'Forudsætning mangler: users, auctions, trades, betalinger, fakturaer og moderation_log';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'fakturaer' and column_name = 'returfragt_id') then
    raise exception 'Forudsætning mangler: fakturaer.returfragt_id (20261022010000_returfragt_betaling.sql)';
  end if;
  if to_regprocedure('public.nye_betalinger_stoppet()') is null then
    raise exception 'Forudsætning mangler: public.nye_betalinger_stoppet() (20261019010000_pengesikkerhed.sql)';
  end if;
  if to_regprocedure('public.bidhamr_system_id()') is null then
    raise exception 'Forudsætning mangler: public.bidhamr_system_id()';
  end if;
  -- Den fælles definition af et gennemført salg (med køberen) og mindstebuddet.
  if to_regprocedure('public.gennemfoerte_salg_min_bud_oere()') is null
     or not exists (select 1 from pg_proc p
                     where p.oid = to_regprocedure('public.gennemfoerte_salg(timestamptz, timestamptz, uuid)')
                       and pg_get_function_result(p.oid) like '%buyer_id%') then
    raise exception 'Forudsætning mangler: gennemfoerte_salg() med buyer_id og gennemfoerte_salg_min_bud_oere() (20261023020000_badge_konkurrence.sql)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Indstillinger (konstanter - ændres med en ny migration)
-- ===========================================================================
create table if not exists public.boost_indstillinger (
  id                        boolean primary key default true,
  -- Pakken: point og pris i øre (inkl. moms).
  pakke_point               integer not null default 100,
  pakke_pris_oere           bigint  not null default 3900,
  -- Et boost: pris i point og varighed.
  boost_point               integer not null default 50,
  boost_timer               integer not null default 24,
  -- Optjening pr. gennemført salg.
  point_pr_salg             integer not null default 10,
  -- Visning: højst så mange boostede øverst pr. liste, roteret pr. vindue.
  maks_pladser              integer not null default 4,
  rotation_minutter         integer not null default 10,
  -- Et boost kræver mindst så lang tid tilbage af auktionen.
  min_tid_tilbage_minutter  integer not null default 60,
  -- Afventer advokaten (128-130) - se toppen. Kun dagens valg er tilladt.
  kraev_fortrydelse_samtykke boolean not null default false,
  point_udloeber_dage       integer,
  refusion_ved_lukning      boolean not null default false,
  -- Salg frigivet før dette tidspunkt giver ikke point (ingen point bagud).
  optjening_fra_kl          timestamptz not null default now(),
  constraint boost_indstillinger_en check (id),
  constraint boost_indstillinger_tal check (
    pakke_point between 1 and 100000 and pakke_pris_oere between 300 and 1000000
    and boost_point between 1 and 100000 and boost_timer between 1 and 720
    and point_pr_salg between 0 and 10000 and maks_pladser between 1 and 24
    and rotation_minutter between 1 and 1440 and min_tid_tilbage_minutter between 0 and 10080),
  -- Logikken for udløb og refusion ved lukning er ikke bygget.
  constraint boost_indstillinger_afventer_advokat check (point_udloeber_dage is null and not refusion_ved_lukning)
);
comment on table public.boost_indstillinger is
  'Boost (Filip, 13. okt. 2026): konstanterne for point, pris, boost og visning. Én række. Ændres med en migration. Udløb og refusion ved lukning afventer advokaten (noter-til-advokat 128-130) og kan ikke slås til, før logikken er bygget.';
insert into public.boost_indstillinger (id) values (true) on conflict (id) do nothing;

alter table public.boost_indstillinger enable row level security;
drop policy if exists boost_indstillinger_laes on public.boost_indstillinger;
create policy boost_indstillinger_laes on public.boost_indstillinger for select to anon, authenticated using (true);
revoke all on public.boost_indstillinger from public, anon, authenticated, service_role;
grant select on public.boost_indstillinger to anon, authenticated, service_role;

-- ===========================================================================
-- 2. Køb af point (betaling til platformen)
-- ===========================================================================
create table if not exists public.boost_koeb (
  id                        uuid primary key default gen_random_uuid(),
  bruger_id                 uuid not null references public.users(id) on delete restrict,
  -- Låst, når købet startes (fra boost_indstillinger).
  point                     integer not null,
  beloeb_oere               bigint not null,
  valuta                    text not null default 'dkk',
  status                    text not null default 'afventer',
  stripe_payment_intent_id  text,
  -- Kasserede PaymentIntents (annulleret hos Stripe): betales en alligevel,
  -- er det en dobbeltbetaling, som refunderes.
  tidligere_payment_intents text[] not null default '{}',
  pi_forsoeg                integer not null default 0,
  stripe_charge_id          text,
  modtaget_oere             bigint,
  sidste_fejl               text,
  fortrydelse_samtykke_kl   timestamptz,
  oprettet_kl               timestamptz not null default now(),
  betalt_kl                 timestamptz,
  -- Refusion (kun hele købet): 'beloeb' (betalt med et andet beløb - ingen
  -- point), 'staff' (chefen), 'ekstern' (refunderet i Stripe uden om BidHamr).
  refusion_aarsag           text,
  refusion_anmodet_kl       timestamptz,
  refusion_af               uuid references public.users(id) on delete set null,
  refusion_begrundelse      text,
  refusion_forsoeg          integer not null default 0,
  refusion_naeste_kl        timestamptz,
  refusion_sidste_fejl      text,
  stripe_refund_id          text,
  refunderet_kl             timestamptz,
  kraever_opmaerksomhed     boolean not null default false,
  opmaerksomhed_tekst       text,
  synket_kl                 timestamptz,
  opdateret                 timestamptz not null default now(),
  constraint boost_koeb_status_check check (
    status in ('afventer', 'behandles', 'betalt', 'refunderes', 'refunderet', 'annulleret')),
  constraint boost_koeb_tal_check check (point between 1 and 100000 and beloeb_oere between 300 and 1000000),
  constraint boost_koeb_valuta_check check (valuta = 'dkk'),
  constraint boost_koeb_refusion_aarsag_check check (
    refusion_aarsag is null or refusion_aarsag in ('beloeb', 'staff', 'ekstern')),
  constraint boost_koeb_betalt_check check (status not in ('betalt', 'refunderes', 'refunderet') or betalt_kl is not null),
  constraint boost_koeb_refunderet_check check (status <> 'refunderet' or refunderet_kl is not null),
  constraint boost_koeb_tekst_laengde check (
    coalesce(char_length(sidste_fejl), 0) <= 500 and coalesce(char_length(refusion_sidste_fejl), 0) <= 500
    and coalesce(char_length(refusion_begrundelse), 0) <= 1000 and coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000)
);
comment on table public.boost_koeb is
  'Køb af boost-point (Filip, 13. okt. 2026): betaling til BidHamrs platformskonto (BidHamrs egen omsætning med moms). Højst ét åbent køb pr. bruger. Skrives kun af security definer-funktionerne. Brugeren kan læse sine egne køb. Handelsdata - slettes aldrig.';

-- Tabt indsigelse fra køberens bank (pointene trækkes tilbage) og
-- annullering af et køb, der aldrig blev betalt (7 dage).
alter table public.boost_koeb add column if not exists indsigelse_tabt_kl timestamptz;
alter table public.boost_koeb add column if not exists stripe_dispute_id text;
alter table public.boost_koeb add column if not exists annulleret_kl timestamptz;
-- Seneste indsigelses-status hos Stripe (null = ingen indsigelse). En åben
-- indsigelse låser brugerens point (boost_point_laast).
alter table public.boost_koeb add column if not exists indsigelse_status text;
-- Seneste aktivitet på et åbent køb (startet/genoptaget, PaymentIntent
-- gemt). 7 dage uden aktivitet: købet annulleres.
alter table public.boost_koeb add column if not exists aktivitet_kl timestamptz not null default now();

create unique index if not exists boost_koeb_et_aabent on public.boost_koeb (bruger_id) where status in ('afventer', 'behandles');
create unique index if not exists boost_koeb_pi on public.boost_koeb (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists boost_koeb_charge on public.boost_koeb (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists boost_koeb_bruger on public.boost_koeb (bruger_id, oprettet_kl desc);
create index if not exists boost_koeb_aaben on public.boost_koeb (status) where status in ('afventer', 'behandles', 'refunderes');
create index if not exists boost_koeb_tidligere on public.boost_koeb using gin (tidligere_payment_intents);

-- ===========================================================================
-- 3. Boosts (én række pr. boost af en auktion)
-- ===========================================================================
create table if not exists public.auktion_boosts (
  id                uuid primary key default gen_random_uuid(),
  auktion_id        uuid not null references public.auctions(id) on delete restrict,
  bruger_id         uuid not null references public.users(id) on delete restrict,
  point             integer not null,
  start_kl          timestamptz not null default now(),
  slut_kl           timestamptz not null,
  -- Klientens nøgle: samme nøgle = samme boost (dobbeltklik, genforsøg).
  idempotens_noegle uuid not null,
  oprettet_kl       timestamptz not null default now(),
  constraint auktion_boosts_tid check (slut_kl > start_kl),
  constraint auktion_boosts_point check (point between 1 and 100000)
);
comment on table public.auktion_boosts is
  'Boost af en auktion (Filip, 13. okt. 2026): opslaget ligger i toppen fra start_kl til slut_kl og vises som "Boostet". Højst ét aktivt boost pr. auktion. Kan ikke ændres eller slettes.';
create unique index if not exists auktion_boosts_noegle on public.auktion_boosts (idempotens_noegle);
create index if not exists auktion_boosts_auktion on public.auktion_boosts (auktion_id, slut_kl desc);
create index if not exists auktion_boosts_slut on public.auktion_boosts (slut_kl);
create index if not exists auktion_boosts_bruger on public.auktion_boosts (bruger_id, oprettet_kl desc);

-- ===========================================================================
-- 4. Pointkontoen: append-only ledger
-- ===========================================================================
create table if not exists public.boost_posteringer (
  id                uuid primary key default gen_random_uuid(),
  bruger_id         uuid not null references public.users(id) on delete restrict,
  type              text not null,
  -- + ind, - ud. Tilbageførsel: det faktisk trukne (kan være mindre end
  -- oensket_point, hvis saldoen er for lav - saldoen bliver aldrig negativ).
  point             integer not null,
  oensket_point     integer,
  saldo_efter       integer not null,
  boost_koeb_id     uuid references public.boost_koeb(id) on delete restrict,
  betaling_id       uuid references public.betalinger(id) on delete restrict,
  boost_id          uuid references public.auktion_boosts(id) on delete restrict,
  staff_id          uuid references public.users(id) on delete restrict,
  begrundelse       text,
  idempotens_noegle uuid,
  oprettet_kl       timestamptz not null default now(),
  constraint boost_posteringer_type_check check (type in ('koeb', 'optjening', 'forbrug', 'tilbagefoersel', 'staff')),
  constraint boost_posteringer_saldo_check check (saldo_efter >= 0),
  constraint boost_posteringer_graense check (point between -1000000 and 1000000),
  constraint boost_posteringer_begrundelse_check check (begrundelse is null or char_length(begrundelse) between 1 and 1000),
  constraint boost_posteringer_form check (
    (type = 'koeb' and point > 0 and boost_koeb_id is not null and betaling_id is null and boost_id is null
       and staff_id is null and oensket_point is null)
    or (type = 'optjening' and point > 0 and betaling_id is not null and boost_koeb_id is null and boost_id is null
       and staff_id is null and oensket_point is null)
    or (type = 'forbrug' and point < 0 and boost_id is not null and boost_koeb_id is null and betaling_id is null
       and staff_id is null and oensket_point is null)
    or (type = 'tilbagefoersel' and point <= 0 and oensket_point > 0 and -point <= oensket_point
       and ((betaling_id is not null) <> (boost_koeb_id is not null)) and boost_id is null)
    or (type = 'staff' and point <> 0 and staff_id is not null and begrundelse is not null
       and idempotens_noegle is not null and boost_koeb_id is null and betaling_id is null and boost_id is null
       and oensket_point is null))
);
comment on table public.boost_posteringer is
  'Boost-pointkontoen (append-only ledger): køb, optjening, forbrug, tilbageførsel og staff-justering. Saldoen er summen af point. Kan ALDRIG ændres eller slettes. Hver postering låser brugerens konto og gemmer saldo_efter (>= 0).';

create unique index if not exists boost_post_koeb on public.boost_posteringer (boost_koeb_id) where type = 'koeb';
create unique index if not exists boost_post_koeb_tilbage on public.boost_posteringer (boost_koeb_id)
  where type = 'tilbagefoersel' and boost_koeb_id is not null;
create unique index if not exists boost_post_optjening on public.boost_posteringer (betaling_id) where type = 'optjening';
create unique index if not exists boost_post_optjening_tilbage on public.boost_posteringer (betaling_id)
  where type = 'tilbagefoersel' and betaling_id is not null;
create unique index if not exists boost_post_forbrug on public.boost_posteringer (boost_id) where type = 'forbrug';
create unique index if not exists boost_post_staff on public.boost_posteringer (idempotens_noegle) where idempotens_noegle is not null;
create index if not exists boost_post_bruger on public.boost_posteringer (bruger_id, oprettet_kl desc);

-- Lås for én brugers pointkonto (samme nøgle overalt).
create or replace function public.boost_laas_bruger(p_bruger uuid)
returns void language sql volatile set search_path = '' as $fn$
  select pg_advisory_xact_lock(hashtextextended('bidhamr-boost-point:' || p_bruger::text, 0));
$fn$;

-- Saldoen = summen af posteringerne.
create or replace function public.boost_saldo(p_bruger uuid)
returns integer language sql stable security definer set search_path = '' as $fn$
  select coalesce(sum(p.point), 0)::integer from public.boost_posteringer p where p.bruger_id = p_bruger;
$fn$;

-- BEFORE INSERT: lås kontoen, regn saldoen, klip en tilbageførsel til
-- saldoen og afvis alt, der ville gøre saldoen negativ.
create or replace function public.boost_posteringer_saldo()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_saldo integer;
begin
  perform public.boost_laas_bruger(new.bruger_id);
  select coalesce(sum(p.point), 0)::integer into v_saldo
    from public.boost_posteringer p where p.bruger_id = new.bruger_id;
  if new.type = 'tilbagefoersel' then
    new.point := -least(coalesce(new.oensket_point, 0), greatest(v_saldo, 0));
  end if;
  if v_saldo + new.point < 0 then
    raise exception 'boost_saldo: der er ikke point nok (saldo %, postering %)', v_saldo, new.point
      using errcode = 'BHB01';
  end if;
  new.saldo_efter := v_saldo + new.point;
  new.oprettet_kl := now();
  return new;
end;
$fn$;
drop trigger if exists boost_posteringer_saldo on public.boost_posteringer;
create trigger boost_posteringer_saldo before insert on public.boost_posteringer
  for each row execute function public.boost_posteringer_saldo();

-- Append-only: ingen ændring, sletning eller tømning - heller ikke af
-- service role. Gælder også auktion_boosts. Købene slettes aldrig.
create or replace function public.boost_forbyd_aendring()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'boost: % kan ikke ændres eller slettes (append-only)', tg_table_name using errcode = 'BHB02';
end;
$fn$;
drop trigger if exists boost_posteringer_laast on public.boost_posteringer;
create trigger boost_posteringer_laast before update or delete on public.boost_posteringer
  for each row execute function public.boost_forbyd_aendring();
drop trigger if exists boost_posteringer_ingen_truncate on public.boost_posteringer;
create trigger boost_posteringer_ingen_truncate before truncate on public.boost_posteringer
  for each statement execute function public.boost_forbyd_aendring();
drop trigger if exists auktion_boosts_laast on public.auktion_boosts;
create trigger auktion_boosts_laast before update or delete on public.auktion_boosts
  for each row execute function public.boost_forbyd_aendring();
drop trigger if exists auktion_boosts_ingen_truncate on public.auktion_boosts;
create trigger auktion_boosts_ingen_truncate before truncate on public.auktion_boosts
  for each statement execute function public.boost_forbyd_aendring();

create or replace function public.boost_koeb_forbyd_sletning()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'Handelsdata må ikke slettes (boost-køb)';
end;
$fn$;
drop trigger if exists boost_koeb_forbyd_sletning on public.boost_koeb;
create trigger boost_koeb_forbyd_sletning before delete on public.boost_koeb
  for each row execute function public.boost_koeb_forbyd_sletning();
drop trigger if exists boost_koeb_ingen_truncate on public.boost_koeb;
create trigger boost_koeb_ingen_truncate before truncate on public.boost_koeb
  for each statement execute function public.boost_forbyd_aendring();

-- Beløb, point og køber er låst.
create or replace function public.boost_koeb_laaste_felter()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.id <> old.id or new.bruger_id <> old.bruger_id or new.point <> old.point
     or new.beloeb_oere <> old.beloeb_oere or new.valuta <> old.valuta or new.oprettet_kl <> old.oprettet_kl then
    raise exception 'Boost-købets beløb, point og køber kan ikke ændres';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;
drop trigger if exists boost_koeb_laaste_felter on public.boost_koeb;
create trigger boost_koeb_laaste_felter before update on public.boost_koeb
  for each row execute function public.boost_koeb_laaste_felter();

-- BEFORE INSERT på auktion_boosts: højst ét aktivt boost pr. auktion - også
-- ved samtidige kald (lås pr. auktion).
create or replace function public.auktion_boosts_et_aktivt()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  perform pg_advisory_xact_lock(hashtextextended('bidhamr-boost-auktion:' || new.auktion_id::text, 0));
  if exists (select 1 from public.auktion_boosts b
              where b.auktion_id = new.auktion_id and b.slut_kl > new.start_kl and b.start_kl < new.slut_kl) then
    raise exception 'boost_aktivt: auktionen er allerede boostet' using errcode = 'BHB03';
  end if;
  return new;
end;
$fn$;
drop trigger if exists auktion_boosts_et_aktivt on public.auktion_boosts;
create trigger auktion_boosts_et_aktivt before insert on public.auktion_boosts
  for each row execute function public.auktion_boosts_et_aktivt();

do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_posteringer_saldo()', 'public.boost_forbyd_aendring()', 'public.boost_koeb_forbyd_sletning()',
    'public.boost_koeb_laaste_felter()', 'public.auktion_boosts_et_aktivt()', 'public.boost_laas_bruger(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $do$;

-- RLS: brugeren ser kun sine egne posteringer, køb og boosts (og kun de
-- viste kolonner). Ingen skrivning udefra - heller ikke service role direkte.
alter table public.boost_posteringer enable row level security;
alter table public.boost_koeb enable row level security;
alter table public.auktion_boosts enable row level security;
drop policy if exists boost_posteringer_egne on public.boost_posteringer;
create policy boost_posteringer_egne on public.boost_posteringer
  for select to authenticated using (bruger_id = (select auth.uid()));
drop policy if exists boost_koeb_egne on public.boost_koeb;
create policy boost_koeb_egne on public.boost_koeb
  for select to authenticated using (bruger_id = (select auth.uid()));
drop policy if exists auktion_boosts_egne on public.auktion_boosts;
create policy auktion_boosts_egne on public.auktion_boosts
  for select to authenticated using (bruger_id = (select auth.uid()));

revoke all on public.boost_posteringer, public.boost_koeb, public.auktion_boosts
  from public, anon, authenticated, service_role;
grant select on public.boost_posteringer, public.boost_koeb, public.auktion_boosts to service_role;
grant select (id, type, point, oensket_point, saldo_efter, boost_koeb_id, betaling_id, boost_id, oprettet_kl)
  on public.boost_posteringer to authenticated;
grant select (id, point, beloeb_oere, status, betalt_kl, refunderet_kl, oprettet_kl)
  on public.boost_koeb to authenticated;
grant select (id, auktion_id, point, start_kl, slut_kl, oprettet_kl)
  on public.auktion_boosts to authenticated;

-- ===========================================================================
-- 5. Hjælpere
-- ===========================================================================

-- Må brugeren købe, optjene og bruge point? null = ja, ellers koden:
-- 'ikke_fundet' | 'erhverv' (firmakonto) | 'spaerret' (lukket, slettet eller
-- suspenderet).
create or replace function public.boost_bruger_spaerret(p_bruger uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  select case
           when u.id is null then 'ikke_fundet'
           when u.konto_type is distinct from 'privat' then 'erhverv'
           when u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then 'spaerret'
           when coalesce(u.suspenderet, false) and (u.suspenderet_til is null or u.suspenderet_til > now()) then 'spaerret'
           else null
         end
    from (select 1) x
    left join public.users u on u.id = p_bruger;
$fn$;

-- Afventer auktionen kunst-kontrol (auctions.kunst_kontrol = 'afventer',
-- 20261023010000_kunst_forbudt.sql)? Læses via to_jsonb, så funktionen
-- virker både før og efter, at kolonnen findes (før: altid false).
-- Bruges af alle boost-funktioner, der læser auctions uden RLS.
create or replace function public.boost_kunst_afventer(p_auktion uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select coalesce((select (to_jsonb(a) ->> 'kunst_kontrol') = 'afventer'
                     from public.auctions a where a.id = p_auktion), false);
$fn$;

-- Indsætter en postering (idempotent via de unikke indeks). Svar: true =
-- indsat, false = fandtes allerede.
create or replace function public.boost_postering_indsaet(
  p_bruger uuid, p_type text, p_point integer, p_koeb uuid default null, p_betaling uuid default null,
  p_boost uuid default null, p_staff uuid default null, p_begrundelse text default null,
  p_noegle uuid default null, p_oensket integer default null)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare
  n integer;
begin
  insert into public.boost_posteringer (bruger_id, type, point, oensket_point, saldo_efter, boost_koeb_id, betaling_id,
                                        boost_id, staff_id, begrundelse, idempotens_noegle)
  values (p_bruger, p_type, coalesce(p_point, 0), p_oensket, 0, p_koeb, p_betaling, p_boost, p_staff, p_begrundelse, p_noegle)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$fn$;

-- ===========================================================================
-- 6. Køb af point: start, PaymentIntent, spejl fra Stripe
-- ===========================================================================
-- p_bruger SKAL være verificeret af serveren (auth). Svar:
--   {kode: 'ok', id, point, beloeb_oere, pi: null, pi_forsoeg: 0}          nyt køb
--   {kode: 'findes', id, point, beloeb_oere, pi, pi_forsoeg, status}       åbent køb findes
--   {kode: 'ugyldig' | 'ikke_fundet' | 'erhverv' | 'spaerret' | 'samtykke'}
create or replace function public.boost_koeb_start(p_bruger uuid, p_samtykke boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_spaerret text;
  s  public.boost_indstillinger%rowtype;
  k  record;
  v_id uuid;
  v_gammel_pi text;
  v_ny boolean := false;
begin
  if p_bruger is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  v_spaerret := public.boost_bruger_spaerret(p_bruger);
  if v_spaerret is not null then return jsonb_build_object('kode', v_spaerret); end if;
  select * into s from public.boost_indstillinger where id;
  if not found then return jsonb_build_object('kode', 'ugyldig'); end if;
  perform public.boost_laas_bruger(p_bruger);

  select b.id, b.point, b.beloeb_oere, b.stripe_payment_intent_id, b.pi_forsoeg, b.status, b.aktivitet_kl into k
    from public.boost_koeb b where b.bruger_id = p_bruger and b.status in ('afventer', 'behandles')
    for update;
  -- Et ubetalt køb uden aktivitet i 7 dage er for gammelt (prisen kan være
  -- ændret): det annulleres, og der startes et nyt. Serveren annullerer den
  -- gamle PaymentIntent hos Stripe (gammel_pi); betales den alligevel, er
  -- den kasseret og refunderes som dobbeltbetaling.
  if k.id is not null and k.status = 'afventer' and k.aktivitet_kl <= now() - interval '7 days' then
    if public.boost_koeb_annuller(k.id, k.stripe_payment_intent_id) then
      v_gammel_pi := k.stripe_payment_intent_id;
      v_ny := true;
    end if;
  end if;
  if k.id is not null and not v_ny then
    update public.boost_koeb
       set aktivitet_kl = now(),
           fortrydelse_samtykke_kl = case when s.kraev_fortrydelse_samtykke and coalesce(p_samtykke, false)
                                          then coalesce(fortrydelse_samtykke_kl, now()) else fortrydelse_samtykke_kl end
     where id = k.id;
    return jsonb_build_object('kode', 'findes', 'id', k.id, 'point', k.point, 'beloeb_oere', k.beloeb_oere,
                              'pi', k.stripe_payment_intent_id, 'pi_forsoeg', k.pi_forsoeg, 'status', k.status);
  end if;
  if s.kraev_fortrydelse_samtykke and not coalesce(p_samtykke, false) then
    return jsonb_build_object('kode', 'samtykke', 'gammel_pi', v_gammel_pi);
  end if;
  insert into public.boost_koeb (bruger_id, point, beloeb_oere, fortrydelse_samtykke_kl)
  values (p_bruger, s.pakke_point, s.pakke_pris_oere,
          case when coalesce(p_samtykke, false) then now() end)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'point', s.pakke_point, 'beloeb_oere', s.pakke_pris_oere,
                            'pi', null, 'pi_forsoeg', 0, 'gammel_pi', v_gammel_pi);
end;
$fn$;

-- PaymentIntenten gemmes kun, hvis købet stadig er åbent med samme forsøg -
-- og ikke under et nødstop for nye betalinger. 'ok' | 'noedstop' | 'nej'
create or replace function public.boost_koeb_gem_pi(p_id uuid, p_pi text, p_forsoeg integer)
returns text language plpgsql security definer set search_path = '' as $fn$
begin
  if p_pi is null or p_pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then return 'nej'; end if;
  if public.nye_betalinger_stoppet() then return 'noedstop'; end if;
  update public.boost_koeb
     set stripe_payment_intent_id = p_pi, aktivitet_kl = now()
   where id = p_id and stripe_payment_intent_id is null and pi_forsoeg = p_forsoeg and status = 'afventer';
  return case when found then 'ok' else 'nej' end;
end;
$fn$;

-- En PaymentIntent, der er annulleret hos Stripe, kasseres (pi_forsoeg + 1).
create or replace function public.boost_koeb_nulstil_pi(p_id uuid, p_pi text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  update public.boost_koeb
     set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
         stripe_payment_intent_id = null,
         pi_forsoeg = pi_forsoeg + 1
   where id = p_id and stripe_payment_intent_id = p_pi and status = 'afventer';
  return found;
end;
$fn$;

-- Spejler PaymentIntentens status (webhooken, returen fra betalingen og
-- cron'en). Idempotent. Svar {kode, id?}:
--   'betalt'          betalt nu - pointene er krediteret
--   'allerede'        var allerede registreret
--   'beloeb_afviger'  betalt med et andet beløb: INGEN point, claimet til refusion
--   'kasseret'        en kasseret PaymentIntent er betalt: refunderes af koden
--   'behandles' | 'afventer' | 'nulstillet' | 'uaendret' | 'ukendt'
create or replace function public.boost_koeb_registrer(
  p_pi text, p_status text, p_charge text, p_beloeb bigint, p_fejl text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
  v_k uuid;
begin
  if p_pi is null then return jsonb_build_object('kode', 'ukendt'); end if;
  select b.id, b.status, b.beloeb_oere, b.bruger_id, b.point into k
    from public.boost_koeb b where b.stripe_payment_intent_id = p_pi for update;
  if k.id is null then
    select b.id into v_k from public.boost_koeb b where p_pi = any(b.tidligere_payment_intents) limit 1;
    if v_k is not null then
      if p_status = 'succeeded' then return jsonb_build_object('kode', 'kasseret', 'id', v_k); end if;
      return jsonb_build_object('kode', 'uaendret', 'id', v_k);
    end if;
    return jsonb_build_object('kode', 'ukendt');
  end if;

  if p_status = 'succeeded' then
    if k.status in ('betalt', 'refunderes', 'refunderet') then
      return jsonb_build_object('kode', 'allerede', 'id', k.id);
    end if;
    if p_beloeb is distinct from k.beloeb_oere then
      update public.boost_koeb
         set status = 'refunderes', betalt_kl = coalesce(betalt_kl, now()), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null, refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(),
             kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
               'Boost-købet er betalt med et andet beløb end prisen - ingen point, og det refunderes automatisk.'), 4000)
       where id = k.id;
      return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
    end if;
    update public.boost_koeb
       set status = 'betalt', betalt_kl = coalesce(betalt_kl, now()), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
           modtaget_oere = p_beloeb, sidste_fejl = null
     where id = k.id;
    perform public.boost_postering_indsaet(k.bruger_id, 'koeb', k.point, p_koeb => k.id);
    return jsonb_build_object('kode', 'betalt', 'id', k.id);
  elsif p_status = 'processing' then
    update public.boost_koeb set status = 'behandles' where id = k.id and status = 'afventer';
    return jsonb_build_object('kode', case when found then 'behandles' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'requires_payment_method' then
    update public.boost_koeb set status = 'afventer', sidste_fejl = left(p_fejl, 500)
     where id = k.id and status in ('afventer', 'behandles');
    return jsonb_build_object('kode', case when found then 'afventer' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'canceled' then
    if k.status in ('afventer', 'behandles') then
      update public.boost_koeb
         set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
             stripe_payment_intent_id = null, pi_forsoeg = pi_forsoeg + 1, status = 'afventer'
       where id = k.id;
      return jsonb_build_object('kode', 'nulstillet', 'id', k.id);
    end if;
  end if;
  return jsonb_build_object('kode', 'uaendret', 'id', k.id);
end;
$fn$;

-- ===========================================================================
-- 7. Refusion af et køb (hele beløbet) - kun chef eller automatisk
-- ===========================================================================
-- Point fra købet trækkes tilbage, så langt saldoen rækker (én gang).
create or replace function public.boost_koeb_tilbagefoer(p_id uuid)
returns integer language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
  v_point integer;
begin
  select b.id, b.bruger_id, b.point into k from public.boost_koeb b where b.id = p_id;
  if k.id is null then return 0; end if;
  if not exists (select 1 from public.boost_posteringer p where p.boost_koeb_id = p_id and p.type = 'koeb') then
    return 0;
  end if;
  perform public.boost_postering_indsaet(k.bruger_id, 'tilbagefoersel', 0, p_koeb => k.id, p_oensket => k.point);
  select -p.point into v_point from public.boost_posteringer p where p.boost_koeb_id = p_id and p.type = 'tilbagefoersel';
  return coalesce(v_point, 0);
end;
$fn$;

-- Chefen: "Refundér boost-køb". Kun chef, ikke på egne køb. Claimer
-- refusionen (status 'refunderes'), trækker pointene tilbage (så langt
-- saldoen rækker) og logger i moderation_log - alt i samme transaktion.
-- Selve refusionen hos Stripe laver serveren bagefter; cron'en prøver igen.
-- {kode: 'ok', trukket, oensket} | 'ingen_adgang' | 'inhabil' |
-- 'begrundelse_mangler' | 'ikke_fundet' | 'forkert_status'
create or replace function public.boost_staff_refusion(p_staff uuid, p_id uuid, p_begrundelse text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  k record;
  v_trukket integer;
begin
  if p_staff is null or not exists (select 1 from public.users u where u.id = p_staff and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  select b.id, b.bruger_id, b.status, b.point into k from public.boost_koeb b where b.id = p_id for update;
  if k.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if k.bruger_id = p_staff then return jsonb_build_object('kode', 'inhabil'); end if;
  if k.status <> 'betalt' then return jsonb_build_object('kode', 'forkert_status'); end if;
  update public.boost_koeb
     set status = 'refunderes', refusion_aarsag = 'staff', refusion_anmodet_kl = now(), refusion_naeste_kl = null,
         refusion_af = p_staff, refusion_begrundelse = left(v_grund, 1000)
   where id = p_id;
  v_trukket := public.boost_koeb_tilbagefoer(p_id);
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'boost_refunderet', 'bruger', k.bruger_id, k.bruger_id,
          left(format('Boost-køb %s refunderet (%s point trukket af %s). %s', p_id, v_trukket, k.point, v_grund), 1000));
  return jsonb_build_object('kode', 'ok', 'trukket', v_trukket, 'oensket', k.point);
end;
$fn$;

-- Resultat af et refusionsforsøg hos Stripe (som returfragten).
-- 'refunderet' | 'allerede' | 'igen' | 'opgivet' | 'forkert_status'
create or replace function public.boost_koeb_refusion_resultat(p_id uuid, p_ok boolean, p_refund text, p_fejl text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
begin
  select b.id, b.status, b.refusion_forsoeg into k from public.boost_koeb b where b.id = p_id for update;
  if k.id is null then return 'forkert_status'; end if;
  if k.status = 'refunderet' then return 'allerede'; end if;
  if k.status <> 'refunderes' then return 'forkert_status'; end if;
  if p_ok then
    update public.boost_koeb
       set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = p_refund, refusion_sidste_fejl = null
     where id = p_id;
    return 'refunderet';
  end if;
  update public.boost_koeb
     set refusion_forsoeg = refusion_forsoeg + 1,
         refusion_sidste_fejl = left(p_fejl, 500),
         refusion_naeste_kl = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(refusion_forsoeg, 7))),
         kraever_opmaerksomhed = kraever_opmaerksomhed or refusion_forsoeg + 1 >= 5
   where id = p_id;
  return case when k.refusion_forsoeg + 1 >= 5 then 'opgivet' else 'igen' end;
end;
$fn$;

-- refund.failed: tilbage til 'refunderes', så cron'en prøver igen (ny nøgle).
-- 'genaabnet' | 'uaendret'
create or replace function public.boost_koeb_refusion_fejlet(p_refund text, p_fejl text)
returns text language plpgsql security definer set search_path = '' as $fn$
begin
  update public.boost_koeb
     set status = 'refunderes', refunderet_kl = null, stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         refusion_sidste_fejl = left(p_fejl, 500), refusion_naeste_kl = now() + interval '5 minutes'
   where stripe_refund_id = p_refund and status = 'refunderet';
  return case when found then 'genaabnet' else 'uaendret' end;
end;
$fn$;

-- charge.refunded på et boost-køb (fx refunderet i Stripe-dashboardet eller
-- vores egen refusion, før resultatet er gemt). Fuld: købet bliver
-- 'refunderet', og pointene trækkes tilbage (så langt saldoen rækker); var
-- det ikke BidHamrs egen refusion, markeres staff. Delvis: kun staff.
-- 'refunderet' | 'allerede' | 'markeret' | 'ukendt'
create or replace function public.boost_koeb_registrer_charge_refusion(p_charge text, p_refund text, p_fuld boolean)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
begin
  select b.id, b.status into k from public.boost_koeb b where b.stripe_charge_id = p_charge for update;
  if k.id is null then return 'ukendt'; end if;
  if k.status = 'refunderet' then return 'allerede'; end if;
  if k.status not in ('betalt', 'refunderes') then return 'ukendt'; end if;
  if not p_fuld then
    update public.boost_koeb
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
             'Boost-købet er delvist refunderet hos Stripe uden om BidHamr - kontrollér det, og justér point.'), 4000)
     where id = k.id;
    return 'markeret';
  end if;
  update public.boost_koeb
     set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_aarsag = coalesce(refusion_aarsag, 'ekstern'), refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         kraever_opmaerksomhed = kraever_opmaerksomhed or k.status = 'betalt',
         opmaerksomhed_tekst = case when k.status = 'betalt'
                                    then left(concat_ws(E'\n', opmaerksomhed_tekst,
                                      'Boost-købet er refunderet hos Stripe uden om BidHamr - pointene er trukket tilbage, så langt saldoen rækker.'), 4000)
                                    else opmaerksomhed_tekst end
   where id = k.id;
  perform public.boost_koeb_tilbagefoer(k.id);
  return 'refunderet';
end;
$fn$;

-- Indsigelse fra køberens bank på et boost-køb (chefens valg, til Filips
-- godkendelse - som ved handler: intet flyttes, før indsigelsen er afgjort):
--   - ÅBEN (needs_response, under_review, warning_needs_response,
--     warning_under_review): brugerens boost-point er LÅST - de kan ikke
--     bruges (boost_brug: 'laast'), til indsigelsen er afgjort. Intet trækkes.
--   - TABT ('lost'): banken har givet køberen pengene, så pointene fra købet
--     trækkes tilbage, så langt saldoen rækker (én gang), og købet markeres
--     til staff. Låsen ophører.
--   - VUNDET/lukket ('won', 'warning_closed', 'prevented'): låsen ophører af
--     sig selv; intet trækkes.
-- Købets status røres ikke (det er ikke en refusion fra BidHamr). Idempotent.
-- 'tilbagefoert' | 'allerede' | 'laast' | 'afgjort' | 'ukendt'
drop function if exists public.boost_koeb_indsigelse_tabt(text, text);
create or replace function public.boost_indsigelse_aaben(p_status text)
returns boolean language sql immutable set search_path = '' as $fn$
  select coalesce(p_status in ('needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'), false);
$fn$;

create or replace function public.boost_koeb_indsigelse(p_charge text, p_dispute text, p_status text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
  v_bruger uuid;
begin
  if p_charge is null or p_status is null then return 'ukendt'; end if;
  -- Lås brugerens pointkonto først (samme lås og rækkefølge som boost_brug
  -- og ledgeren), så låsen/tilbageførslen ikke kan krydse et samtidigt boost.
  select b.bruger_id into v_bruger from public.boost_koeb b where b.stripe_charge_id = p_charge;
  if v_bruger is null then return 'ukendt'; end if;
  perform public.boost_laas_bruger(v_bruger);
  select b.id, b.indsigelse_tabt_kl, b.indsigelse_status into k
    from public.boost_koeb b where b.stripe_charge_id = p_charge for update;
  if k.id is null then return 'ukendt'; end if;

  if p_status = 'lost' then
    if k.indsigelse_tabt_kl is not null then
      perform public.boost_koeb_tilbagefoer(k.id); -- no-op, hvis den findes
      return 'allerede';
    end if;
    update public.boost_koeb
       set indsigelse_status = 'lost', indsigelse_tabt_kl = now(),
           stripe_dispute_id = coalesce(p_dispute, stripe_dispute_id),
           kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
             'Indsigelsen fra køberens bank er tabt - pointene fra købet er trukket tilbage, så langt saldoen rakte, og brugerens point er låst op igen.'), 4000)
     where id = k.id;
    perform public.boost_koeb_tilbagefoer(k.id);
    return 'tilbagefoert';
  end if;
  -- En tabt indsigelse er en sluttilstand.
  if k.indsigelse_tabt_kl is not null then return 'allerede'; end if;

  if public.boost_indsigelse_aaben(p_status) then
    update public.boost_koeb
       set indsigelse_status = p_status, stripe_dispute_id = coalesce(p_dispute, stripe_dispute_id),
           kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = case when public.boost_indsigelse_aaben(k.indsigelse_status) then opmaerksomhed_tekst
                                      else left(concat_ws(E'\n', opmaerksomhed_tekst,
                                        'Indsigelse fra køberens bank er åben - brugerens boost-point er låst, til den er afgjort. Pointene trækkes kun tilbage, hvis den tabes.'), 4000) end
     where id = k.id;
    return 'laast';
  end if;

  update public.boost_koeb
     set indsigelse_status = p_status, stripe_dispute_id = coalesce(p_dispute, stripe_dispute_id)
   where id = k.id;
  return 'afgjort';
end;
$fn$;

-- Er brugerens boost-point låst af en åben indsigelse på et af brugerens køb?
create or replace function public.boost_point_laast(p_bruger uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.boost_koeb b
                  where b.bruger_id = p_bruger and public.boost_indsigelse_aaben(b.indsigelse_status));
$fn$;

-- Et køb, der aldrig blev betalt, annulleres (cron eller en ny start, efter
-- 7 dage uden aktivitet - efter at PaymentIntenten er annulleret hos Stripe).
-- Kun fra 'afventer', og kun hvis købets PaymentIntent er den, der blev
-- annulleret (p_pi) eller der ingen er.
drop function if exists public.boost_koeb_annuller(uuid);
create or replace function public.boost_koeb_annuller(p_id uuid, p_pi text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  update public.boost_koeb
     set status = 'annulleret', annulleret_kl = now(),
         tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                          else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
         stripe_payment_intent_id = null
   where id = p_id and status = 'afventer'
     and (stripe_payment_intent_id is null or stripe_payment_intent_id = p_pi);
  return found;
end;
$fn$;

-- Cron: hvad skal gøres? (claimet med synket_kl / refusion_naeste_kl)
--   'synk'      åbent køb med PaymentIntent i over 15 min (mistet webhook)
--   'refusion'  refusionen er claimet, men ikke gennemført
--   'annuller'  købet har stået ubetalt ('afventer') i 7 dage uden aktivitet
--               (aktivitet_kl - start/genoptag og ny PaymentIntent): PaymentIntenten
--               annulleres hos Stripe, og købet annulleres (boost_koeb_annuller)
-- Rækkefølge: refusioner, så nye køb, der aldrig er synket, så resten.
create or replace function public.boost_koeb_cron(p_graense integer default 20)
returns table (id uuid, handling text)
language plpgsql security definer set search_path = '' as $fn$
#variable_conflict use_column
declare
  v_graense integer := least(greatest(coalesce(p_graense, 20), 1), 100);
begin
  return query
  with k as (
    select b.id,
           case when b.status = 'refunderes' then 'refusion'
                when b.status = 'afventer' and b.aktivitet_kl <= now() - interval '7 days' then 'annuller'
                else 'synk' end as handling,
           b.status, b.synket_kl, b.refusion_naeste_kl, b.oprettet_kl
      from public.boost_koeb b
     where (b.status = 'refunderes' and b.refusion_forsoeg < 5
            and (b.refusion_naeste_kl is null or b.refusion_naeste_kl <= now())
            and b.refusion_anmodet_kl <= now() - interval '2 minutes')
        or (b.status = 'afventer' and b.aktivitet_kl <= now() - interval '7 days'
            and (b.synket_kl is null or b.synket_kl <= now() - interval '15 minutes'))
        or (b.status in ('afventer', 'behandles') and b.stripe_payment_intent_id is not null
            and b.opdateret <= now() - interval '15 minutes'
            -- Opgivne betalinger: hvert 15. minut det første døgn, derefter hver 6. time.
            and (b.synket_kl is null
                 or b.synket_kl <= now() - case when b.oprettet_kl > now() - interval '24 hours'
                                                then interval '15 minutes' else interval '6 hours' end))
     order by case when b.status = 'refunderes' then 0 when b.synket_kl is null then 1 else 2 end,
              coalesce(b.refusion_naeste_kl, b.synket_kl, b.oprettet_kl)
     limit v_graense
     for update of b skip locked
  ), u as (
    update public.boost_koeb x
       set synket_kl = case when k.handling in ('synk', 'annuller') then now() else x.synket_kl end,
           refusion_naeste_kl = case when k.handling = 'refusion' then now() + interval '10 minutes' else x.refusion_naeste_kl end
      from k
     where x.id = k.id
    returning x.id, k.handling
  )
  select u.id, u.handling from u;
end;
$fn$;

-- ===========================================================================
-- 8. Brug et boost
-- ===========================================================================
-- p_bruger SKAL være verificeret af serveren (auth). p_noegle: klientens
-- nøgle (samme nøgle = samme boost). Svar {kode, ...}:
--   'ok' | 'allerede' (samme nøgle) -> boost_id, start_kl, slut_kl, saldo
--   'boostet'        auktionen har allerede et aktivt boost (slut_kl)
--   'for_faa_point'  saldo, pris
--   'ikke_ejer' | 'ikke_aktiv' | 'slutter_snart' | 'erhverv' | 'spaerret' | 'laast' (åben indsigelse) |
--   'ikke_fundet' | 'ugyldig'
create or replace function public.boost_brug(p_bruger uuid, p_auktion uuid, p_noegle uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  s  public.boost_indstillinger%rowtype;
  a  record;
  b  record;
  v_spaerret text;
  v_saldo integer;
  v_id uuid;
  v_slut timestamptz;
  v_ny_start timestamptz;
  v_ny_slut timestamptz;
begin
  if p_bruger is null or p_auktion is null or p_noegle is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select * into s from public.boost_indstillinger where id;
  -- Låse: brugerens konto, så auktionen (samme rækkefølge overalt).
  perform public.boost_laas_bruger(p_bruger);
  perform pg_advisory_xact_lock(hashtextextended('bidhamr-boost-auktion:' || p_auktion::text, 0));

  -- Samme nøgle: samme boost (dobbeltklik/genforsøg) - intet nyt forbrug.
  select x.id, x.auktion_id, x.bruger_id, x.start_kl, x.slut_kl into b
    from public.auktion_boosts x where x.idempotens_noegle = p_noegle;
  if b.id is not null then
    if b.bruger_id <> p_bruger or b.auktion_id <> p_auktion then return jsonb_build_object('kode', 'ugyldig'); end if;
    return jsonb_build_object('kode', 'allerede', 'boost_id', b.id, 'start_kl', b.start_kl, 'slut_kl', b.slut_kl,
                              'saldo', public.boost_saldo(p_bruger));
  end if;

  v_spaerret := public.boost_bruger_spaerret(p_bruger);
  if v_spaerret is not null then return jsonb_build_object('kode', v_spaerret); end if;
  -- Åben indsigelse på et af brugerens køb: pointene er låst, til den er
  -- afgjort (ophører af sig selv, når BidHamr vinder - eller pointene trækkes
  -- tilbage, hvis den tabes).
  if public.boost_point_laast(p_bruger) then return jsonb_build_object('kode', 'laast'); end if;

  select x.id, x.bruger_id, x.status, coalesce(x.skjult, false) as skjult, x.arkiveret_kl, x.pauset_kl,
         x.slutter_kl, coalesce(x.erhverv, false) as erhverv
    into a from public.auctions x where x.id = p_auktion;
  if a.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if a.bruger_id <> p_bruger then return jsonb_build_object('kode', 'ikke_ejer'); end if;
  if a.erhverv then return jsonb_build_object('kode', 'erhverv'); end if;
  -- Afventer kunst-kontrol (20261023010000_kunst_forbudt.sql): skjult for
  -- andre og kan ikke få bud - og kan derfor heller ikke boostes.
  if public.boost_kunst_afventer(p_auktion) then return jsonb_build_object('kode', 'ikke_aktiv'); end if;
  if a.status <> 'aktiv' or a.skjult or a.arkiveret_kl is not null or a.pauset_kl is not null or a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if a.slutter_kl <= now() + make_interval(mins => s.min_tid_tilbage_minutter) then
    return jsonb_build_object('kode', 'slutter_snart');
  end if;

  select x.slut_kl into v_slut from public.auktion_boosts x
   where x.auktion_id = p_auktion and x.slut_kl > now() order by x.slut_kl desc limit 1;
  if v_slut is not null then return jsonb_build_object('kode', 'boostet', 'slut_kl', v_slut); end if;

  v_saldo := public.boost_saldo(p_bruger);
  if v_saldo < s.boost_point then
    return jsonb_build_object('kode', 'for_faa_point', 'saldo', v_saldo, 'pris', s.boost_point);
  end if;

  insert into public.auktion_boosts (auktion_id, bruger_id, point, start_kl, slut_kl, idempotens_noegle)
  values (p_auktion, p_bruger, s.boost_point, now(), now() + make_interval(hours => s.boost_timer), p_noegle)
  returning id, start_kl, slut_kl into v_id, v_ny_start, v_ny_slut;
  -- Saldoen tjekkes igen under låsen i triggeren (BHB01 ruller alt tilbage).
  perform public.boost_postering_indsaet(p_bruger, 'forbrug', -s.boost_point, p_boost => v_id);
  return jsonb_build_object('kode', 'ok', 'boost_id', v_id, 'start_kl', v_ny_start, 'slut_kl', v_ny_slut,
                            'saldo', public.boost_saldo(p_bruger));
end;
$fn$;

-- ===========================================================================
-- 9. Optjening og tilbageførsel ved salg (cron, idempotent)
-- ===========================================================================
-- Filip, 15. okt. 2026: kun salg med et bud på mindst 50 kr. giver point, og
-- højst 10 point pr. køber pr. sælger pr. måned (så en køber ikke kan "sælge"
-- point til sælgeren med mange små handler).
--
-- Mindstebuddet og "gennemført salg" er den FÆLLES definition fra
-- 20261023020000_badge_konkurrence.sql: gennemfoerte_salg() og
-- gennemfoerte_salg_min_bud_oere() (= 5000 øre) - badge, konkurrence og
-- boost følges ad. (En tidligere udgave af denne fil havde sin egen kopi,
-- boost_min_bud_oere(), på testdatabasen - den fjernes.)
drop function if exists public.boost_min_bud_oere();

alter table public.boost_indstillinger add column if not exists maks_point_pr_koeber_maaned integer not null default 10;
alter table public.boost_indstillinger drop constraint if exists boost_indstillinger_maks_koeber;
alter table public.boost_indstillinger add constraint boost_indstillinger_maks_koeber
  check (maks_point_pr_koeber_maaned between 0 and 100000);

-- Salg, der er vurderet og IKKE gav point, fordi køberen allerede har givet
-- sælgeren det højeste antal point i måneden. Gemmes, så de ikke vurderes
-- igen ved hver kørsel (og ikke kan give point senere). Append-only.
create table if not exists public.boost_optjening_afvist (
  betaling_id uuid primary key references public.betalinger(id) on delete restrict,
  saelger_id  uuid not null references public.users(id) on delete restrict,
  koeber_id   uuid references public.users(id) on delete restrict,
  maaned      text not null,
  grund       text not null check (grund in ('maks_pr_koeber')),
  oprettet_kl timestamptz not null default now()
);
comment on table public.boost_optjening_afvist is
  'Boost: gennemførte salg, der ikke gav point, fordi køberen allerede havde givet sælgeren højst maks_point_pr_koeber_maaned point i måneden (Filip, 15. okt. 2026). Kan ikke ændres eller slettes.';
drop trigger if exists boost_optjening_afvist_laast on public.boost_optjening_afvist;
create trigger boost_optjening_afvist_laast before update or delete on public.boost_optjening_afvist
  for each row execute function public.boost_forbyd_aendring();
drop trigger if exists boost_optjening_afvist_ingen_truncate on public.boost_optjening_afvist;
create trigger boost_optjening_afvist_ingen_truncate before truncate on public.boost_optjening_afvist
  for each statement execute function public.boost_forbyd_aendring();
alter table public.boost_optjening_afvist enable row level security;
revoke all on public.boost_optjening_afvist from public, anon, authenticated, service_role;
grant select on public.boost_optjening_afvist to service_role;
-- Et GENNEMFØRT salg: samme definition som gennemfoerte_salg
-- (20261023020000_badge_konkurrence.sql) - betalt, frigivet, ikke annulleret,
-- intet refunderet/bestilt refunderet, ingen "BidHamr dækker", ingen åben
-- eller tabt indsigelse. Kun private sælgere (ikke BidHamrs systemkonto).
-- Kun salg frigivet efter optjening_fra_kl (ingen point bagud).
--
-- Tilbageførsel: et salg, der har givet point, og som senere refunderes
-- (refusion bestilt/gennemført, "BidHamr dækker", tabt indsigelse eller
-- annulleret), får pointene trukket tilbage - så langt saldoen rækker.
-- Svar: {optjent, tilbagefoert}.
create or replace function public.boost_point_synk(p_graense integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense integer := least(greatest(coalesce(p_graense, 500), 1), 5000);
  s  public.boost_indstillinger%rowtype;
  r  record;
  v_optjent integer := 0;
  v_tilbage integer := 0;
  v_brugt   integer;
  v_point   integer;
begin
  select * into s from public.boost_indstillinger where id;
  if not found then return jsonb_build_object('optjent', 0, 'tilbagefoert', 0); end if;

  if s.point_pr_salg > 0 then
    for r in
      -- Den fælles definition (20261023020000_badge_konkurrence.sql): betalt,
      -- frigivet, bud >= gennemfoerte_salg_min_bud_oere(), intet refunderet,
      -- ingen åben/tabt indsigelse, ikke annulleret, ikke BidHamrs systemkonto.
      select g.betaling_id as id, g.seller_id, g.buyer_id,
             to_char(g.frigivet_kl at time zone 'Europe/Copenhagen', 'YYYY-MM') as maaned
        -- Kun de seneste 60 dage (så kørslen ikke bliver langsommere med
        -- tiden); et salg frigives og synkes langt inden for det vindue.
        from public.gennemfoerte_salg(greatest(s.optjening_fra_kl, now() - interval '60 days'), null, null) g
       -- Kun private, og ikke spærrede, lukkede eller suspenderede sælgere
       -- (boost_bruger_spaerret: null = må bruge boost).
       where public.boost_bruger_spaerret(g.seller_id) is null
         and not exists (select 1 from public.boost_optjening_afvist x where x.betaling_id = g.betaling_id)
         and not exists (select 1 from public.boost_posteringer p where p.betaling_id = g.betaling_id and p.type = 'optjening')
       order by g.frigivet_kl
       limit v_graense
    loop
      -- Højst maks_point_pr_koeber_maaned pr. køber pr. sælger pr. måned
      -- (dansk tid for frigivelsen). Brugt = alle optjeninge fra samme køber i
      -- måneden (brutto - en senere tilbageførsel giver ikke plads igen).
      -- Låst pr. sælger, så to samtidige kørsler ikke begge giver point.
      perform public.boost_laas_bruger(r.seller_id);
      continue when exists (select 1 from public.boost_posteringer p where p.betaling_id = r.id and p.type = 'optjening')
                 or exists (select 1 from public.boost_optjening_afvist x where x.betaling_id = r.id);
      select coalesce(sum(p.point), 0)::integer into v_brugt
        from public.boost_posteringer p
        join public.betalinger b2 on b2.id = p.betaling_id
       where p.type = 'optjening' and p.bruger_id = r.seller_id
         and b2.buyer_id is not distinct from r.buyer_id
         and to_char(b2.frigivet_kl at time zone 'Europe/Copenhagen', 'YYYY-MM') = r.maaned;
      v_point := least(s.point_pr_salg, greatest(s.maks_point_pr_koeber_maaned - v_brugt, 0));
      if v_point <= 0 then
        insert into public.boost_optjening_afvist (betaling_id, saelger_id, koeber_id, maaned, grund)
        values (r.id, r.seller_id, r.buyer_id, r.maaned, 'maks_pr_koeber')
        on conflict do nothing;
        continue;
      end if;
      if public.boost_postering_indsaet(r.seller_id, 'optjening', v_point, p_betaling => r.id) then
        v_optjent := v_optjent + 1;
      end if;
    end loop;
  end if;

  for r in
    select p.betaling_id, p.bruger_id, p.point
      from public.boost_posteringer p
      join public.betalinger b on b.id = p.betaling_id
      left join public.trades t on t.id = b.trade_id
     where p.type = 'optjening'
       and not exists (select 1 from public.boost_posteringer x where x.betaling_id = p.betaling_id and x.type = 'tilbagefoersel')
       and (b.status in ('refunderet', 'annulleret')
            or b.annulleret_kl is not null
            or b.refusion_anmodet_kl is not null
            or b.refunderet_kl is not null
            or coalesce(b.refusion_oere, 0) > 0
            or b.bidhamr_daekker_kl is not null
            or b.indsigelse_tabt_kl is not null
            or coalesce(t.status, '') = 'annulleret')
     limit v_graense
  loop
    if public.boost_postering_indsaet(r.bruger_id, 'tilbagefoersel', 0, p_betaling => r.betaling_id, p_oensket => r.point) then
      v_tilbage := v_tilbage + 1;
    end if;
  end loop;
  return jsonb_build_object('optjent', v_optjent, 'tilbagefoert', v_tilbage);
end;
$fn$;

-- ===========================================================================
-- 10. Staff (chef): se en brugers point og justér med begrundelse
-- ===========================================================================
-- {kode: 'ok', saldo} | 'ingen_adgang' | 'inhabil' | 'begrundelse_mangler' |
-- 'ugyldig' | 'ikke_fundet' | 'for_lav_saldo' (saldo) | 'allerede' (samme nøgle)
create or replace function public.boost_staff_justering(
  p_staff uuid, p_bruger uuid, p_point integer, p_begrundelse text, p_noegle uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_saldo integer;
begin
  if p_staff is null or not exists (select 1 from public.users u where u.id = p_staff and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_bruger is null or p_noegle is null or p_point is null or p_point = 0 or abs(p_point) > 10000 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  if p_staff = p_bruger then return jsonb_build_object('kode', 'inhabil'); end if;
  if not exists (select 1 from public.users u where u.id = p_bruger) then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform public.boost_laas_bruger(p_bruger);
  if exists (select 1 from public.boost_posteringer p where p.idempotens_noegle = p_noegle) then
    return jsonb_build_object('kode', 'allerede', 'saldo', public.boost_saldo(p_bruger));
  end if;
  v_saldo := public.boost_saldo(p_bruger);
  if v_saldo + p_point < 0 then return jsonb_build_object('kode', 'for_lav_saldo', 'saldo', v_saldo); end if;
  perform public.boost_postering_indsaet(p_bruger, 'staff', p_point, p_staff => p_staff,
                                         p_begrundelse => left(v_grund, 1000), p_noegle => p_noegle);
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'boost_justering', 'bruger', p_bruger, p_bruger,
          left(format('%s%s boost-point. %s', case when p_point > 0 then '+' else '' end, p_point, v_grund), 1000));
  return jsonb_build_object('kode', 'ok', 'saldo', public.boost_saldo(p_bruger));
end;
$fn$;

-- Chefens visning af en brugers point: saldo, posteringer og køb.
-- null = ingen adgang.
create or replace function public.boost_admin_bruger(p_staff uuid, p_bruger uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
begin
  if p_staff is null or not exists (select 1 from public.users u where u.id = p_staff and u.rolle = 'chef') then
    return null;
  end if;
  return jsonb_build_object(
    'saldo', public.boost_saldo(p_bruger),
    'spaerret', public.boost_bruger_spaerret(p_bruger),
    'posteringer', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'type', p.type, 'point', p.point, 'oensket_point', p.oensket_point,
               'saldo_efter', p.saldo_efter, 'kl', p.oprettet_kl, 'begrundelse', p.begrundelse,
               'staff_navn', su.navn, 'boost_koeb_id', p.boost_koeb_id, 'betaling_id', p.betaling_id,
               'auktion_id', ab.auktion_id, 'auktion_titel', a.titel)
             order by p.oprettet_kl desc, p.id)
        from (select * from public.boost_posteringer x where x.bruger_id = p_bruger
               order by x.oprettet_kl desc, x.id limit 200) p
        left join public.users su on su.id = p.staff_id
        left join public.auktion_boosts ab on ab.id = p.boost_id
        left join public.auctions a on a.id = ab.auktion_id), '[]'::jsonb),
    'koeb', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'point', k.point, 'beloeb_oere', k.beloeb_oere, 'status', k.status,
               'oprettet_kl', k.oprettet_kl, 'betalt_kl', k.betalt_kl, 'refunderet_kl', k.refunderet_kl,
               'refusion_aarsag', k.refusion_aarsag, 'kraever_opmaerksomhed', k.kraever_opmaerksomhed,
               'opmaerksomhed_tekst', k.opmaerksomhed_tekst, 'stripe_payment_intent_id', k.stripe_payment_intent_id)
             order by k.oprettet_kl desc)
        from (select * from public.boost_koeb x where x.bruger_id = p_bruger order by x.oprettet_kl desc limit 50) k), '[]'::jsonb));
end;
$fn$;

-- ===========================================================================
-- 11. Brugeren (også appen)
-- ===========================================================================
-- supabase.rpc("mine_point") -> { saldo, kan_bruge, spaerret, pakke: {point,
-- pris_oere}, boost: {point, timer}, point_pr_salg, min_bud_oere,
-- maks_pr_koeber_maaned, kraev_samtykke,
-- aabent_koeb: {id, status} | null, historik: [{ id, type, point,
-- oensket_point, saldo_efter, kl, auktion_id, auktion_titel }] } eller null.
create or replace function public.mine_point()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_bruger uuid := (select auth.uid());
  s public.boost_indstillinger%rowtype;
  v_spaerret text;
begin
  if v_bruger is null then return null; end if;
  select * into s from public.boost_indstillinger where id;
  v_spaerret := public.boost_bruger_spaerret(v_bruger);
  return jsonb_build_object(
    'saldo', public.boost_saldo(v_bruger),
    'kan_bruge', v_spaerret is null,
    -- Åben indsigelse på et af brugerens køb: pointene kan ikke bruges lige nu.
    'point_laast', public.boost_point_laast(v_bruger),
    'spaerret', v_spaerret,
    'pakke', jsonb_build_object('point', s.pakke_point, 'pris_oere', s.pakke_pris_oere),
    'boost', jsonb_build_object('point', s.boost_point, 'timer', s.boost_timer),
    'point_pr_salg', s.point_pr_salg,
    'min_bud_oere', public.gennemfoerte_salg_min_bud_oere(),
    'maks_pr_koeber_maaned', s.maks_point_pr_koeber_maaned,
    'kraev_samtykke', s.kraev_fortrydelse_samtykke,
    'aabent_koeb', (select jsonb_build_object('id', k.id, 'status', k.status)
                      from public.boost_koeb k where k.bruger_id = v_bruger and k.status in ('afventer', 'behandles')
                     limit 1),
    'historik', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'type', p.type, 'point', p.point, 'oensket_point', p.oensket_point,
               'saldo_efter', p.saldo_efter, 'kl', p.oprettet_kl,
               'auktion_id', ab.auktion_id, 'auktion_titel', a.titel)
             order by p.oprettet_kl desc, p.id)
        from (select * from public.boost_posteringer x where x.bruger_id = v_bruger
               order by x.oprettet_kl desc, x.id limit 200) p
        left join public.auktion_boosts ab on ab.id = p.boost_id
        left join public.auctions a on a.id = ab.auktion_id), '[]'::jsonb));
end;
$fn$;

-- supabase.rpc("min_auktion_boost", { p_auktion }) -> for ejeren:
-- { boostet, slut_kl, kan_booste, grund, saldo, pris, timer } ellers null.
-- grund: null | 'boostet' | 'laast' | 'for_faa_point' | 'ikke_aktiv' | 'slutter_snart' |
-- 'erhverv' | 'spaerret'.
create or replace function public.min_auktion_boost(p_auktion uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_bruger uuid := (select auth.uid());
  s public.boost_indstillinger%rowtype;
  a record;
  v_slut timestamptz;
  v_saldo integer;
  v_grund text;
begin
  if v_bruger is null or p_auktion is null then return null; end if;
  select x.id, x.bruger_id, x.status, coalesce(x.skjult, false) as skjult, x.arkiveret_kl, x.pauset_kl, x.slutter_kl,
         coalesce(x.erhverv, false) as erhverv
    into a from public.auctions x where x.id = p_auktion;
  if a.id is null or a.bruger_id <> v_bruger then return null; end if;
  select * into s from public.boost_indstillinger where id;
  select x.slut_kl into v_slut from public.auktion_boosts x
   where x.auktion_id = p_auktion and x.slut_kl > now() order by x.slut_kl desc limit 1;
  v_saldo := public.boost_saldo(v_bruger);
  v_grund := case
    when a.erhverv then 'erhverv'
    when public.boost_kunst_afventer(p_auktion) then 'ikke_aktiv'
    when public.boost_bruger_spaerret(v_bruger) is not null then coalesce(nullif(public.boost_bruger_spaerret(v_bruger), 'ikke_fundet'), 'spaerret')
    when a.status <> 'aktiv' or a.skjult or a.arkiveret_kl is not null or a.pauset_kl is not null or a.slutter_kl <= now() then 'ikke_aktiv'
    when v_slut is not null then 'boostet'
    when public.boost_point_laast(v_bruger) then 'laast'
    when a.slutter_kl <= now() + make_interval(mins => s.min_tid_tilbage_minutter) then 'slutter_snart'
    when v_saldo < s.boost_point then 'for_faa_point'
    else null end;
  return jsonb_build_object('boostet', v_slut is not null, 'slut_kl', v_slut, 'kan_booste', v_grund is null,
                            'grund', v_grund, 'saldo', v_saldo, 'pris', s.boost_point, 'timer', s.boost_timer,
                            'pakke', jsonb_build_object('point', s.pakke_point, 'pris_oere', s.pakke_pris_oere));
end;
$fn$;

-- ===========================================================================
-- 12. Visning: boostede auktioner (offentligt - anon og authenticated)
-- ===========================================================================
-- De auktioner (af en liste), der er boostet lige nu - til mærket "Boostet".
-- Højst 500 id'er pr. kald.
create or replace function public.aktive_boosts(p_auktioner uuid[])
returns table (auktion_id uuid, slut_kl timestamptz)
language sql stable security definer set search_path = '' as $fn$
  select b.auktion_id, max(b.slut_kl)
    from public.auktion_boosts b
    join public.auctions a on a.id = b.auktion_id
   where b.auktion_id = any ((coalesce(p_auktioner, '{}'::uuid[]))[1:500])
     -- Kun auktioner, der kan ses (som boost_top).
     and not coalesce(a.skjult, false) and a.arkiveret_kl is null and a.pauset_kl is null
     and (to_jsonb(a) ->> 'kunst_kontrol') is distinct from 'afventer'
     and b.start_kl <= now() and b.slut_kl > now()
   group by b.auktion_id;
$fn$;

-- De boostede auktioner, der skal stå øverst i en liste (forsiden: ingen
-- filtre; kategori: p_kategori; søgning: p_soeg - samme regel som søgningen:
-- titlen indeholder teksten, uden forskel på store og små bogstaver).
-- Kun auktioner, der kan ses og bydes på (aktiv, ikke skjult, ikke
-- arkiveret, ikke på pause, ikke slut). Højst maks_pladser; er der flere,
-- roteres de pr. rotationsvindue (se toppen). Sorteret efter boost-start.
create or replace function public.boost_top(p_kategori text default null, p_soeg text default null)
returns table (auktion_id uuid, start_kl timestamptz, slut_kl timestamptz)
language plpgsql stable security definer set search_path = '' as $fn$
#variable_conflict use_column
declare
  s public.boost_indstillinger%rowtype;
  v_soeg text := nullif(lower(btrim(left(coalesce(p_soeg, ''), 100))), '');
  v_kategori text := nullif(btrim(left(coalesce(p_kategori, ''), 100)), '');
  v_slot bigint;
begin
  select * into s from public.boost_indstillinger where id;
  if not found then return; end if;
  v_slot := floor(extract(epoch from now()) / (s.rotation_minutter * 60))::bigint;
  return query
  with k as (
    select b.auktion_id, b.start_kl, b.slut_kl,
           (row_number() over (order by b.start_kl, b.auktion_id) - 1)::bigint as nr,
           (count(*) over ())::bigint as n
      from public.auktion_boosts b
      join public.auctions a on a.id = b.auktion_id
     where b.start_kl <= now() and b.slut_kl > now()
       and a.status = 'aktiv' and not coalesce(a.skjult, false) and a.arkiveret_kl is null
       and a.pauset_kl is null and a.slutter_kl > now()
       -- Afventer kunst-kontrol: skjult for alle andre (se boost_kunst_afventer).
       and (to_jsonb(a) ->> 'kunst_kontrol') is distinct from 'afventer'
       and (v_kategori is null or a.kategori = v_kategori)
       and (v_soeg is null or strpos(lower(a.titel), v_soeg) > 0)
  )
  select k.auktion_id, k.start_kl, k.slut_kl
    from k
   where k.n <= s.maks_pladser
      or ((k.nr - (v_slot * s.maks_pladser) % k.n) + k.n) % k.n < s.maks_pladser
   order by k.start_kl, k.auktion_id;
end;
$fn$;

-- ===========================================================================
-- 13. Faktura: købet faktureres køberen (salgskonto, med moms)
-- ===========================================================================
alter table public.fakturaer add column if not exists boost_koeb_id uuid
  references public.boost_koeb(id) on delete restrict;

-- Drift-tjek (md5 af den normaliserede definition, uden mellemrum): de to
-- CHECK'er erstattes kun, hvis de er præcis den kendte udgave fra
-- 20261012080000_fakturaer.sql (fakturaer_kilde) og
-- 20261022010000_returfragt_betaling.sql (fakturaer_slags_check) - eller
-- allerede er denne fils udgave (genkørsel). Ellers stoppes migrationen, så
-- en ændring lavet et andet sted ikke overskrives i stilhed.
do $do$
declare
  v_navn text;
  v_def  text;
  v_md5  text;
  v_kendte text[];
begin
  foreach v_navn in array array['fakturaer_kilde', 'fakturaer_slags_check'] loop
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c where c.conrelid = 'public.fakturaer'::regclass and c.conname = v_navn;
    if v_def is null then
      raise exception 'Drift: CHECK % på fakturaer mangler - kontrollér fakturaer, før boost-migrationen køres', v_navn;
    end if;
    v_md5 := md5(regexp_replace(v_def, '\s', '', 'g'));
    v_kendte := case v_navn
      when 'fakturaer_kilde' then array[
        md5(regexp_replace($k$CHECK ((((dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (betaling_id IS NOT NULL) AND (firma_regning_id IS NULL) AND (part = ANY (ARRAY['koeber'::text, 'saelger'::text]))) OR ((dokument = ANY (ARRAY['abonnement'::text, 'abonnement_retur'::text])) AND (firma_regning_id IS NOT NULL) AND (betaling_id IS NULL) AND (part = 'firma'::text))))$k$, '\s', '', 'g')),
        md5(regexp_replace($k$CHECK ((((dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (betaling_id IS NOT NULL) AND (firma_regning_id IS NULL) AND (part = ANY (ARRAY['koeber'::text, 'saelger'::text]))) OR ((dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (slags = 'boost'::text) AND (boost_koeb_id IS NOT NULL) AND (betaling_id IS NULL) AND (firma_regning_id IS NULL) AND (part = 'koeber'::text)) OR ((dokument = ANY (ARRAY['abonnement'::text, 'abonnement_retur'::text])) AND (firma_regning_id IS NOT NULL) AND (betaling_id IS NULL) AND (part = 'firma'::text))))$k$, '\s', '', 'g'))]
      else array[
        md5(regexp_replace($k$CHECK (((slags = ANY (ARRAY['salg'::text, 'returfragt'::text, 'sag_returfragt'::text])) AND ((slags = 'salg'::text) OR ((slags = 'returfragt'::text) AND (dokument = 'faktura'::text) AND (part = 'koeber'::text)) OR ((slags = 'sag_returfragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)))))$k$, '\s', '', 'g')),
        md5(regexp_replace($k$CHECK (((slags = ANY (ARRAY['salg'::text, 'returfragt'::text, 'sag_returfragt'::text, 'boost'::text])) AND ((slags = 'salg'::text) OR ((slags = 'returfragt'::text) AND (dokument = 'faktura'::text) AND (part = 'koeber'::text)) OR ((slags = 'sag_returfragt'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)) OR ((slags = 'boost'::text) AND (dokument = ANY (ARRAY['faktura'::text, 'kreditnota'::text])) AND (part = 'koeber'::text)))))$k$, '\s', '', 'g'))]
      end;
    if not (v_md5 = any (v_kendte)) then
      raise exception 'Drift: CHECK % på fakturaer er ændret uden for migrationerne (md5 %) - opdatér boost-migrationen: %',
        v_navn, v_md5, v_def;
    end if;
  end loop;
end $do$;

alter table public.fakturaer drop constraint if exists fakturaer_kilde;
alter table public.fakturaer add constraint fakturaer_kilde check (
  (dokument in ('faktura', 'kreditnota') and betaling_id is not null and firma_regning_id is null
   and part in ('koeber', 'saelger'))
  or (dokument in ('faktura', 'kreditnota') and slags = 'boost' and boost_koeb_id is not null
      and betaling_id is null and firma_regning_id is null and part = 'koeber')
  or (dokument in ('abonnement', 'abonnement_retur') and firma_regning_id is not null and betaling_id is null
      and part = 'firma'));

alter table public.fakturaer drop constraint if exists fakturaer_slags_check;
alter table public.fakturaer add constraint fakturaer_slags_check
  check (slags in ('salg', 'returfragt', 'sag_returfragt', 'boost')
         and (slags = 'salg'
              or (slags = 'returfragt' and dokument = 'faktura' and part = 'koeber')
              or (slags = 'sag_returfragt' and dokument in ('faktura', 'kreditnota') and part = 'koeber')
              or (slags = 'boost' and dokument in ('faktura', 'kreditnota') and part = 'koeber')));

alter table public.fakturaer drop constraint if exists fakturaer_boost_koeb_id_check;
alter table public.fakturaer add constraint fakturaer_boost_koeb_id_check
  check ((slags = 'boost') = (boost_koeb_id is not null));

comment on column public.fakturaer.slags is
  'salg: fakturaen ved betalingen (og kreditnotaen for den). returfragt: køberens faktura på returfragten, der blev trukket fra refusionen, da pakken ikke blev afhentet (20261016030000). sag_returfragt: køberens faktura (og kreditnota ved refusion) på returfragten, køberen betalte i en sag (20261022010000, returfragt_id). boost: købers faktura (og kreditnota ved refusion) på boost-point (20261023030000, boost_koeb_id). Låst.';

create unique index if not exists fakturaer_boost_dokument
  on public.fakturaer (boost_koeb_id, dokument) where boost_koeb_id is not null;

create or replace function public.fakturaer_boost_laast()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.boost_koeb_id is distinct from old.boost_koeb_id then
    raise exception 'Fakturaens indhold kan ikke ændres, når den er oprettet';
  end if;
  return new;
end;
$fn$;
revoke all on function public.fakturaer_boost_laast() from public, anon, authenticated;
drop trigger if exists fakturaer_boost_laast on public.fakturaer;
create trigger fakturaer_boost_laast before update on public.fakturaer
  for each row execute function public.fakturaer_boost_laast();

-- Planlægger fakturaer og kreditnotaer for boost-køb (kaldes af fakturakøen
-- efter faktura_planlaeg). Idempotent.
--   faktura:    betalt køb (også hvis det senere er refunderet - så bogføres
--               begge). Dateret på betalingsdagen. Passer det modtagne beløb
--               ikke, oprettes den som "kræver handling".
--   kreditnota: refunderet køb (hele beløbet), dateret på refusionsdagen.
create or replace function public.faktura_planlaeg_boost(p_graense integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura integer := 0;
  v_kredit  integer := 0;
  n         integer;
  r         record;
  v_linjer  jsonb;
  v_ok      boolean;
  v_fejl    text := 'Boost-købet er betalt med et andet beløb end prisen - kontrollér betalingen hos Stripe og lav dokumentet manuelt i Dinero.';
begin
  for r in
    select x.id, x.bruger_id, x.point, x.beloeb_oere, x.modtaget_oere, x.betalt_kl, x.stripe_charge_id,
           x.stripe_payment_intent_id
      from public.boost_koeb x
     where x.betalt_kl is not null
       and x.status in ('betalt', 'refunderes', 'refunderet')
       and not exists (select 1 from public.fakturaer f where f.boost_koeb_id = x.id and f.dokument = 'faktura')
     order by x.betalt_kl
     limit v_graense
  loop
    v_ok := r.modtaget_oere is not distinct from r.beloeb_oere;
    v_linjer := jsonb_build_array(public.faktura_linje('boost', format('Boost-point (%s point)', r.point), r.beloeb_oere));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, boost_koeb_id)
    values ('faktura', 'koeber', r.bruger_id, null, null, v_linjer, public.faktura_sum(v_linjer),
            public.faktura_moms(v_linjer), (r.betalt_kl at time zone 'Europe/Copenhagen')::date,
            coalesce(r.stripe_charge_id, r.stripe_payment_intent_id),
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else v_fejl end, 'boost', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_faktura := v_faktura + n;
  end loop;

  for r in
    select fa.id as faktura_id, fa.bruger_id, fa.linjer, fa.manuel, fa.status as moder_status,
           x.id, x.refunderet_kl, x.stripe_refund_id
      from public.fakturaer fa
      join public.boost_koeb x on x.id = fa.boost_koeb_id
     where fa.dokument = 'faktura'
       and fa.slags = 'boost'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.boost_koeb_id = x.id and k.dokument = 'kreditnota')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_ok := not (r.manuel or r.moder_status in ('kraever_handling', 'haandteret_manuelt'));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, boost_koeb_id)
    values ('kreditnota', 'koeber', r.bruger_id, null, null, r.faktura_id, r.linjer,
            public.faktura_sum(r.linjer), public.faktura_moms(r.linjer),
            (r.refunderet_kl at time zone 'Europe/Copenhagen')::date, r.stripe_refund_id,
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.' end,
            'boost', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit);
end;
$fn$;

-- ===========================================================================
-- 14. moderation_log: 'boost_justering' og 'boost_refunderet' (maal_type 'bruger')
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if v_def is not null and (v_def not like '%''boost_justering''%' or v_def not like '%''boost_refunderet''%') then
    v_vals := array(
      select distinct x from (
        select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
          from regexp_matches(v_def, '''([^'']+)''', 'g') as m
        union select 'boost_justering' union select 'boost_refunderet') s
      where x <> '' order by 1);
    alter table public.moderation_log drop constraint moderation_log_handling_check;
    execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);
  end if;
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_maal_type_check';
  if v_def is not null and v_def not like '%''bruger''%' then
    v_vals := array(
      select distinct x from (
        select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
          from regexp_matches(v_def, '''([^'']+)''', 'g') as m
        union select 'bruger') s
      where x <> '' order by 1);
    alter table public.moderation_log drop constraint moderation_log_maal_type_check;
    execute format('alter table public.moderation_log add constraint moderation_log_maal_type_check check (maal_type = any (%L::text[]))', v_vals);
  end if;
end $do$;

-- ===========================================================================
-- 15. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.boost_saldo(uuid)',
    'public.boost_bruger_spaerret(uuid)',
    'public.boost_kunst_afventer(uuid)',
    'public.boost_postering_indsaet(uuid, text, integer, uuid, uuid, uuid, uuid, text, uuid, integer)',
    'public.boost_koeb_start(uuid, boolean)',
    'public.boost_koeb_gem_pi(uuid, text, integer)',
    'public.boost_koeb_nulstil_pi(uuid, text)',
    'public.boost_koeb_registrer(text, text, text, bigint, text)',
    'public.boost_koeb_tilbagefoer(uuid)',
    'public.boost_staff_refusion(uuid, uuid, text)',
    'public.boost_koeb_refusion_resultat(uuid, boolean, text, text)',
    'public.boost_koeb_refusion_fejlet(text, text)',
    'public.boost_koeb_registrer_charge_refusion(text, text, boolean)',
    'public.boost_koeb_cron(integer)',
    'public.boost_koeb_indsigelse(text, text, text)',
    'public.boost_indsigelse_aaben(text)',
    'public.boost_point_laast(uuid)',
    'public.boost_koeb_annuller(uuid, text)',
    'public.boost_brug(uuid, uuid, uuid)',
    'public.boost_point_synk(integer)',
    'public.boost_staff_justering(uuid, uuid, integer, text, uuid)',
    'public.boost_admin_bruger(uuid, uuid)',
    'public.faktura_planlaeg_boost(integer)',
    'public.mine_point()',
    'public.min_auktion_boost(uuid)',
    'public.aktive_boosts(uuid[])',
    'public.boost_top(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
-- Interne byggesten (kaldes kun inde fra RPC'erne ovenfor): heller ikke
-- service role må kalde dem direkte - ellers kunne serveren kreditere point
-- uden en betaling, et salg eller en staff-handling bag.
revoke all on function public.boost_postering_indsaet(uuid, text, integer, uuid, uuid, uuid, uuid, text, uuid, integer)
  from service_role;
revoke all on function public.boost_koeb_tilbagefoer(uuid) from service_role;
-- Brugeren selv (auth.uid()).
grant execute on function public.mine_point() to authenticated;
grant execute on function public.min_auktion_boost(uuid) to authenticated;
-- Offentligt (lister og mærket "Boostet").
grant execute on function public.aktive_boosts(uuid[]) to anon, authenticated;
grant execute on function public.boost_top(text, text) to anon, authenticated;
