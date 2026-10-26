-- "Ugens butik" - betalt forsideplads for firmaer (Filip, 26. okt. 2026 -
-- ROADMAP-BESLUTNINGER "Erhvervskonti").
--
--   - Ét firma ad gangen pr. uge. Ugen går fra mandag 00:00 til søndag 24:00,
--     dansk tid (Europe/Copenhagen - også i uger med skift til/fra sommertid).
--   - Rabat fra firmaets pakke (Filip, 26. okt. 2026: Butik 50 % de første 3
--     gange hvert kalenderår, Pro 50 % op til 5 gange, Start fuld pris):
--     nye kolonner erhverv_pakker.ugens_butik_rabat_procent og
--     ugens_butik_rabat_antal (standard 0 = ingen rabat, til pakkerne er
--     bygget om). Se afsnit 2 og ugens_butik_pris_for.
--   - Pris 500 kr. + moms (625 kr. inkl. moms) pr. uge. Prisen står ÉT sted:
--     ugens_butik_indstillinger.pris_ekskl_moms_oere. Chefen retter den med
--     ugens_butik_saet_pris (logges). En åben reservation beholder den pris,
--     den blev startet med (låst på bookingen).
--   - Bookingtabellen ugens_butik_bookinger har et UNIKT indeks på ugen for
--     alle bookinger, der holder ugen (reserveret, behandles, betalt, manuel).
--     To firmaer kan derfor aldrig få samme uge - heller ikke ved samtidige
--     køb (indekset håndhæves af Postgres; desuden låses ugen med en advisory
--     lock, så den, der kommer sidst, får 'optaget' i stedet for en fejl).
--   - En reservation (firmaets køb) holder ugen i 30 minutter
--     (reservation_minutter), mens betalingen står åben. Udløber den, frigives
--     ugen: med det samme, når en anden vil have ugen, og ellers af cron'en,
--     som først annullerer PaymentIntenten hos Stripe. Bliver en udløbet
--     reservation alligevel betalt, får firmaet ugen, hvis den stadig er
--     ledig - ellers refunderes betalingen automatisk ('for_sent').
--   - Firmaet køber selv i Firma oversigt: kun aktive firmaer
--     (firmaer.abonnement_status = 'aktiv'), hvis konto ikke er lukket,
--     slettet eller suspenderet. Fra næste uge og højst 12 uger frem
--     (maks_uger_frem). Én åben reservation ad gangen pr. firma.
--   - Betalingen er en engangsbetaling på BidHamrs PLATFORMSKONTO som boost
--     (src/lib/betaling/ugensButik.ts): PaymentIntent uden on_behalf_of,
--     transfer_data og application fee, tvungen 3D Secure, idempotency key pr.
--     booking og forsøg, metadata type 'ugens_butik'. Webhooks:
--     /api/webhooks/stripe (samme idempotens: stripe_haendelser +
--     statusvagter her).
--   - Faktura: BidHamrs egen omsætning med moms, i Dinero-køen som boost
--     (fakturaer.slags 'ugens_butik', part 'koeber'). Firmaets Dinero-kontakt
--     har CVR som momsnummer og firmaets adresse (src/lib/faktura/koe.ts), og
--     fakturaen vises under Firma oversigt -> Regninger -> "Fakturaer"
--     (mine_fakturaer). Kreditnota ved refusion.
--   - Staff: chef og sælger-rollen kan booke en uge manuelt (med betaling =
--     en reservation, firmaet betaler i Firma oversigt inden for 48 timer;
--     uden betaling = 'manuel', fx efter en aftale), og annullere bookinger,
--     der ikke er betalt. En BETALT booking kunne her kun chefen annullere -
--     RETTET i 20261101060000: chef OG sælger-rollen annullerer og
--     refunderer betalte uger (Filip, 26. okt. 2026). Alt logges i
--     moderation_log (maal_type 'ugens_butik').
--     Se også 20261101060000 for den igangværende uge, loftet (4 uger i
--     træk), rabat pr. firma og sen betaling på en uge, der er slut.
--   - Forsiden: forside_ugens_butik() (anon) giver den aktive uges firma
--     (navn, link til firmaprofilen, billede) og højst 8 aktive auktioner -
--     intet resultat uden aktive auktioner. Kun offentlige felter. Feltet
--     skal vises som "Annonce" (markedsføringsloven - frontendens opgave).
--
-- Handelsdata slettes aldrig (triggere). Ændrer på eksisterende tabeller: ny
-- kolonne, CHECK'er, unikt indeks og trigger på fakturaer; nye værdier i
-- moderation_log's CHECK'er. Idempotent (kan køres igen). Én transaktion: ingen
-- egen begin;/commit; (repoets mønster). Kun testdatabasen, indtil Filip
-- siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.firmaer') is null or to_regclass('public.users') is null
     or to_regclass('public.auctions') is null or to_regclass('public.fakturaer') is null
     or to_regclass('public.moderation_log') is null or to_regclass('public.erhverv_pakker') is null then
    raise exception 'Forudsætning mangler: firmaer, erhverv_pakker, users, auctions, fakturaer og moderation_log';
  end if;
  if to_regprocedure('public.nye_betalinger_stoppet()') is null
     or to_regprocedure('public.faktura_linje(text,text,bigint)') is null
     or to_regprocedure('public.faktura_sum(jsonb)') is null
     or to_regprocedure('public.faktura_moms(jsonb)') is null then
    raise exception 'Forudsætning mangler: nye_betalinger_stoppet() og fakturafunktionerne (20261012080000, 20261019010000)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Indstillinger (prisen står her - ét sted)
-- ===========================================================================
create table if not exists public.ugens_butik_indstillinger (
  id                        boolean primary key default true,
  -- Pris pr. uge i øre EKSKL. moms (Filip, 26. okt. 2026: 500 kr. + moms).
  pris_ekskl_moms_oere      bigint  not null default 50000,
  -- Fast dansk moms (alle firmaer har dansk CVR - som abonnementet).
  moms_procent              integer not null default 25,
  -- Firmaets reservation, mens betalingen står åben.
  reservation_minutter      integer not null default 30,
  -- Staff booker "med betaling": firmaet har så lang tid til at betale.
  staff_reservation_timer   integer not null default 48,
  -- Firmaet kan købe fra næste uge og højst så mange uger frem.
  maks_uger_frem            integer not null default 12,
  -- Staff kan booke op til så mange uger frem (også den igangværende uge).
  staff_maks_uger_frem      integer not null default 52,
  -- Højst så mange auktioner i forsidefeltet.
  maks_auktioner            integer not null default 8,
  opdateret_kl              timestamptz not null default now(),
  opdateret_af              uuid references public.users(id) on delete set null,
  constraint ugens_butik_indstillinger_en check (id),
  constraint ugens_butik_indstillinger_tal check (
    pris_ekskl_moms_oere between 10000 and 1000000 and moms_procent = 25
    and reservation_minutter between 5 and 240 and staff_reservation_timer between 1 and 336
    and maks_uger_frem between 1 and 52 and staff_maks_uger_frem between 1 and 104
    and maks_auktioner between 1 and 24)
);
comment on table public.ugens_butik_indstillinger is
  'Ugens butik (Filip, 26. okt. 2026): pris pr. uge ekskl. moms (500 kr.), moms 25 %, reservationstid (30 min.), uger frem (12) og antal auktioner på forsiden (8). Én række. Prisen rettes af chefen med ugens_butik_saet_pris (logges); resten med en migration.';
insert into public.ugens_butik_indstillinger (id) values (true) on conflict (id) do nothing;

alter table public.ugens_butik_indstillinger enable row level security;
drop policy if exists ugens_butik_indstillinger_laes on public.ugens_butik_indstillinger;
create policy ugens_butik_indstillinger_laes on public.ugens_butik_indstillinger
  for select to anon, authenticated using (true);
revoke all on public.ugens_butik_indstillinger from public, anon, authenticated, service_role;
grant select (id, pris_ekskl_moms_oere, moms_procent, reservation_minutter, maks_uger_frem, maks_auktioner)
  on public.ugens_butik_indstillinger to anon, authenticated;
grant select on public.ugens_butik_indstillinger to service_role;

-- Ugen (mandag) for et tidspunkt, dansk tid.
create or replace function public.ugens_butik_uge(p_kl timestamptz)
returns date language sql stable set search_path = '' as $fn$
  select date_trunc('week', p_kl at time zone 'Europe/Copenhagen')::date;
$fn$;

-- Ugens start (mandag 00:00 dansk tid) som tidspunkt.
create or replace function public.ugens_butik_uge_start_kl(p_uge date)
returns timestamptz language sql stable set search_path = '' as $fn$
  select (p_uge::timestamp) at time zone 'Europe/Copenhagen';
$fn$;

-- Moms i øre af en pris ekskl. moms (halv op - som Stripe og Dinero).
create or replace function public.ugens_butik_moms_oere(p_ekskl bigint)
returns bigint language sql immutable set search_path = '' as $fn$
  select round(p_ekskl * 25 / 100.0)::bigint;
$fn$;

-- ===========================================================================
-- 2. Bookinger
-- ===========================================================================
create table if not exists public.ugens_butik_bookinger (
  id                        uuid primary key default gen_random_uuid(),
  firma_id                  uuid not null references public.firmaer(id) on delete restrict,
  -- Firmakontoen (firmaer.bruger_id) - fakturaens modtager.
  bruger_id                 uuid not null references public.users(id) on delete restrict,
  uge_start                 date not null,
  start_kl                  timestamptz not null,
  slut_kl                   timestamptz not null,
  -- 'firma' = firmaets eget køb; 'staff' = booket af chef/sælger i admin.
  kilde                     text not null,
  -- 'stripe' = betales via Stripe; 'ingen' = staff uden betaling (aftale).
  betaling                  text not null,
  status                    text not null,
  reserveret_til            timestamptz,
  -- Låst, når bookingen oprettes (fra ugens_butik_indstillinger). 0 ved
  -- betaling 'ingen'.
  pris_ekskl_moms_oere      bigint not null,
  moms_oere                 bigint not null,
  beloeb_oere               bigint not null,
  valuta                    text not null default 'dkk',
  stripe_payment_intent_id  text,
  -- Kasserede PaymentIntents (annulleret hos Stripe): betales en alligevel,
  -- er det en dobbeltbetaling, som refunderes.
  tidligere_payment_intents text[] not null default '{}',
  pi_forsoeg                integer not null default 0,
  stripe_charge_id          text,
  modtaget_oere             bigint,
  betalt_kl                 timestamptz,
  sidste_fejl               text,
  aktivitet_kl              timestamptz not null default now(),
  oprettet_af               uuid references public.users(id) on delete set null,
  note                      text,
  annulleret_kl             timestamptz,
  annulleret_af             uuid references public.users(id) on delete set null,
  annullering_begrundelse   text,
  udloebet_kl               timestamptz,
  -- Refusion (kun hele beløbet): 'beloeb' (betalt med et andet beløb),
  -- 'for_sent' (betalt efter udløb/annullering, og ugen var taget), 'staff'
  -- (chefen), 'ekstern' (refunderet i Stripe uden om BidHamr).
  refusion_aarsag           text,
  refusion_anmodet_kl       timestamptz,
  refusion_af               uuid references public.users(id) on delete set null,
  refusion_begrundelse      text,
  refusion_forsoeg          integer not null default 0,
  refusion_naeste_kl        timestamptz,
  refusion_sidste_fejl      text,
  stripe_refund_id          text,
  refunderet_kl             timestamptz,
  indsigelse_status         text,
  stripe_dispute_id         text,
  kraever_opmaerksomhed     boolean not null default false,
  opmaerksomhed_tekst       text,
  synket_kl                 timestamptz,
  oprettet_kl               timestamptz not null default now(),
  opdateret                 timestamptz not null default now(),
  constraint ugens_butik_mandag check (extract(isodow from uge_start) = 1),
  constraint ugens_butik_kilde_check check (kilde in ('firma', 'staff')),
  constraint ugens_butik_betaling_check check (betaling in ('stripe', 'ingen')),
  constraint ugens_butik_status_check check (
    status in ('reserveret', 'behandles', 'betalt', 'manuel', 'udloebet', 'annulleret', 'refunderes', 'refunderet')),
  -- 'manuel' er altid uden betaling, og en booking uden betaling kan kun
  -- være 'manuel' eller 'annulleret' - uden beløb og uden Stripe.
  constraint ugens_butik_status_betaling check (
    (status <> 'manuel' or betaling = 'ingen')
    and (betaling = 'stripe' or (status in ('manuel', 'annulleret') and beloeb_oere = 0 and betalt_kl is null
                                 and stripe_payment_intent_id is null and pi_forsoeg = 0))),
  constraint ugens_butik_beloeb_check check (
    beloeb_oere = pris_ekskl_moms_oere + moms_oere and beloeb_oere between 0 and 1250000
    and (betaling = 'ingen' or beloeb_oere >= 300)),
  constraint ugens_butik_valuta_check check (valuta = 'dkk'),
  constraint ugens_butik_reserveret_check check (status not in ('reserveret', 'behandles') or reserveret_til is not null),
  constraint ugens_butik_betalt_check check (status not in ('betalt', 'refunderes', 'refunderet') or betalt_kl is not null),
  constraint ugens_butik_refunderet_check check (status <> 'refunderet' or refunderet_kl is not null),
  constraint ugens_butik_refusion_aarsag_check check (
    refusion_aarsag is null or refusion_aarsag in ('beloeb', 'for_sent', 'staff', 'ekstern')),
  constraint ugens_butik_tekst_laengde check (
    coalesce(char_length(sidste_fejl), 0) <= 500 and coalesce(char_length(refusion_sidste_fejl), 0) <= 500
    and coalesce(char_length(note), 0) <= 1000 and coalesce(char_length(annullering_begrundelse), 0) <= 1000
    and coalesce(char_length(refusion_begrundelse), 0) <= 1000 and coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000)
);
comment on table public.ugens_butik_bookinger is
  'Ugens butik (Filip, 26. okt. 2026): én række pr. booking af en uge (mandag-søndag, dansk tid). Ugen holdes af status reserveret, behandles, betalt og manuel - højst én pr. uge (unikt indeks). Betaling til BidHamrs platformskonto (src/lib/betaling/ugensButik.ts). Skrives kun af security definer-funktionerne. Handelsdata - slettes aldrig.';

-- ÉN booking pr. uge, der holder ugen - også ved samtidige køb.
create unique index if not exists ugens_butik_en_pr_uge
  on public.ugens_butik_bookinger (uge_start) where status in ('reserveret', 'behandles', 'betalt', 'manuel');
-- Højst én åben betaling pr. firma.
create unique index if not exists ugens_butik_et_aabent_pr_firma
  on public.ugens_butik_bookinger (firma_id) where status in ('reserveret', 'behandles');
create unique index if not exists ugens_butik_pi
  on public.ugens_butik_bookinger (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists ugens_butik_charge
  on public.ugens_butik_bookinger (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists ugens_butik_firma on public.ugens_butik_bookinger (firma_id, uge_start desc);
create index if not exists ugens_butik_uge on public.ugens_butik_bookinger (uge_start, status);
create index if not exists ugens_butik_aaben on public.ugens_butik_bookinger (status)
  where status in ('reserveret', 'behandles', 'refunderes');
create index if not exists ugens_butik_tidligere on public.ugens_butik_bookinger using gin (tidligere_payment_intents);

-- ---------------------------------------------------------------------------
-- Rabat fra firmaets pakke (Filip, 26. okt. 2026 - "NYE pakker og priser":
-- Butik 50 % de første 3 gange hvert kalenderår, Pro 50 % op til 5 gange,
-- Start fuld pris). Satsen og antallet står på PAKKEN (erhverv_pakker), så
-- pakkerne kan bygges om uden at røre Ugens butik. 0 = ingen rabat (standard
-- - også for de nuværende pakker, til de er bygget om).
--   Tælles pr. firma pr. kalenderår for UGENS år (mandagens år, dansk
--   kalender): bookinger med rabat i status reserveret (ikke udløbet),
--   behandles eller betalt. En annulleret, udløbet eller refunderet booking
--   giver rabatten tilbage. Manuelle bookinger (staff, uden betaling) bruger
--   ingen rabat. Rabatten låses på bookingen (rabat_procent, rabat_oere);
--   pris_ekskl_moms_oere er prisen EFTER rabat, og momsen regnes af den.
-- ---------------------------------------------------------------------------
alter table public.erhverv_pakker add column if not exists ugens_butik_rabat_procent integer not null default 0;
alter table public.erhverv_pakker add column if not exists ugens_butik_rabat_antal integer not null default 0;
alter table public.erhverv_pakker drop constraint if exists erhverv_pakker_ugens_butik_rabat_check;
alter table public.erhverv_pakker add constraint erhverv_pakker_ugens_butik_rabat_check
  check (ugens_butik_rabat_procent between 0 and 90 and ugens_butik_rabat_antal between 0 and 52);
comment on column public.erhverv_pakker.ugens_butik_rabat_procent is
  'Ugens butik: rabat i procent af ugeprisen (ekskl. moms) for firmaer med pakken, fx 50 (Butik og Pro). 0 = fuld pris (Start). 20261101020000.';
comment on column public.erhverv_pakker.ugens_butik_rabat_antal is
  'Ugens butik: så mange uger pr. kalenderår får rabatten, fx 3 (Butik) eller 5 (Pro). 0 = ingen rabat. 20261101020000.';

alter table public.ugens_butik_bookinger add column if not exists rabat_procent integer not null default 0;
alter table public.ugens_butik_bookinger add column if not exists rabat_oere bigint not null default 0;
alter table public.ugens_butik_bookinger drop constraint if exists ugens_butik_rabat_check;
alter table public.ugens_butik_bookinger add constraint ugens_butik_rabat_check
  check (rabat_procent between 0 and 90 and rabat_oere >= 0 and (rabat_procent = 0) = (rabat_oere = 0)
         and (betaling = 'stripe' or rabat_procent = 0));
comment on column public.ugens_butik_bookinger.rabat_procent is
  'Rabat fra firmaets pakke, låst ved bookingen (0 = fuld pris). pris_ekskl_moms_oere er efter rabat; listeprisen = pris_ekskl_moms_oere + rabat_oere.';

-- Handelsdata: aldrig slettes (heller ikke truncate).
create or replace function public.ugens_butik_forbyd_sletning()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'Handelsdata må ikke slettes (Ugens butik)';
end;
$fn$;
drop trigger if exists ugens_butik_forbyd_sletning on public.ugens_butik_bookinger;
create trigger ugens_butik_forbyd_sletning before delete on public.ugens_butik_bookinger
  for each row execute function public.ugens_butik_forbyd_sletning();
drop trigger if exists ugens_butik_ingen_truncate on public.ugens_butik_bookinger;
create trigger ugens_butik_ingen_truncate before truncate on public.ugens_butik_bookinger
  for each statement execute function public.ugens_butik_forbyd_sletning();

-- Firma, uge, pris og kilde er låst.
create or replace function public.ugens_butik_laaste_felter()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.id <> old.id or new.firma_id <> old.firma_id or new.bruger_id <> old.bruger_id
     or new.uge_start <> old.uge_start or new.start_kl <> old.start_kl or new.slut_kl <> old.slut_kl
     or new.kilde <> old.kilde or new.betaling <> old.betaling
     or new.pris_ekskl_moms_oere <> old.pris_ekskl_moms_oere or new.moms_oere <> old.moms_oere
     or new.beloeb_oere <> old.beloeb_oere or new.valuta <> old.valuta or new.oprettet_kl <> old.oprettet_kl
     or new.rabat_procent <> old.rabat_procent or new.rabat_oere <> old.rabat_oere then
    raise exception 'Bookingens firma, uge og pris kan ikke ændres';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;
drop trigger if exists ugens_butik_laaste_felter on public.ugens_butik_bookinger;
create trigger ugens_butik_laaste_felter before update on public.ugens_butik_bookinger
  for each row execute function public.ugens_butik_laaste_felter();

-- Ugens tidspunkter sættes altid af databasen (dansk tid).
create or replace function public.ugens_butik_tider()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  new.start_kl := public.ugens_butik_uge_start_kl(new.uge_start);
  new.slut_kl := public.ugens_butik_uge_start_kl(new.uge_start + 7);
  return new;
end;
$fn$;
drop trigger if exists ugens_butik_tider on public.ugens_butik_bookinger;
create trigger ugens_butik_tider before insert on public.ugens_butik_bookinger
  for each row execute function public.ugens_butik_tider();

alter table public.ugens_butik_bookinger enable row level security;
revoke all on public.ugens_butik_bookinger from public, anon, authenticated, service_role;
grant select on public.ugens_butik_bookinger to service_role;

-- ===========================================================================
-- 3. Hjælpere
-- ===========================================================================
-- Låserækkefølge (overalt): firmaet (ugens_butik_laas_firma) FØR ugen
-- (ugens_butik_laas_uge) FØR rækken (for update) - så der aldrig opstår en
-- deadlock (40P01).
create or replace function public.ugens_butik_laas_firma(p_firma uuid)
returns void language sql security definer set search_path = '' as $fn$
  select pg_advisory_xact_lock(hashtextextended('bidhamr-ugens-butik-firma:' || p_firma::text, 0));
$fn$;

create or replace function public.ugens_butik_laas_uge(p_uge date)
returns void language sql security definer set search_path = '' as $fn$
  select pg_advisory_xact_lock(hashtextextended('bidhamr-ugens-butik-uge:' || p_uge::text, 0));
$fn$;

-- Må firmaet (brugeren) købe? null = ja, ellers koden:
-- 'ikke_firma' | 'spaerret' (lukket, slettet eller suspenderet) |
-- 'ikke_aktiv' (abonnementet er ikke aktivt/betalt).
create or replace function public.ugens_butik_firma_spaerret(p_bruger uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  select case
           when u.id is null or f.id is null or u.konto_type is distinct from 'erhverv' then 'ikke_firma'
           when u.konto_lukket_kl is not null or u.konto_slettet_kl is not null then 'spaerret'
           when coalesce(u.suspenderet, false) and (u.suspenderet_til is null or u.suspenderet_til > now()) then 'spaerret'
           when f.abonnement_status is distinct from 'aktiv' then 'ikke_aktiv'
           else null
         end
    from (select 1) x
    left join public.users u on u.id = p_bruger
    left join public.firmaer f on f.bruger_id = u.id;
$fn$;

-- Firmaets rabat på Ugens butik i ugens kalenderår: pakkens sats og antal,
-- og hvor mange rabat-uger firmaet har brugt (se afsnit 2). Kaldes under
-- firmaets lås, når der bookes (én åben betaling pr. firma, så tællingen
-- ikke kan løbe om kap med sig selv).
create or replace function public.ugens_butik_rabat(p_firma uuid, p_uge date)
returns table (procent integer, antal integer, brugt integer)
language sql stable security definer set search_path = '' as $fn$
  select coalesce(p.ugens_butik_rabat_procent, 0), coalesce(p.ugens_butik_rabat_antal, 0),
         (select count(*)::integer from public.ugens_butik_bookinger b
           where b.firma_id = p_firma and b.rabat_procent > 0
             and extract(year from b.uge_start) = extract(year from p_uge)
             and (b.status in ('behandles', 'betalt') or (b.status = 'reserveret' and b.reserveret_til > now())))
    from public.firmaer f
    left join public.erhverv_pakker p on p.id = f.pakke_id
   where f.id = p_firma;
$fn$;

-- Prisen for firmaet for en given uge (øre): listepris ekskl. moms fra
-- ugens_butik_indstillinger, pakkens rabat (hvis der er rabat-uger tilbage i
-- ugens år), pris efter rabat, moms og i alt.
create or replace function public.ugens_butik_pris_for(p_firma uuid, p_uge date)
returns table (liste_ekskl_oere bigint, rabat_procent integer, rabat_oere bigint,
               ekskl_oere bigint, moms_oere bigint, inkl_oere bigint)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_liste bigint;
  v_pct   integer := 0;
  r       record;
begin
  select s.pris_ekskl_moms_oere into v_liste from public.ugens_butik_indstillinger s where s.id;
  select * into r from public.ugens_butik_rabat(p_firma, p_uge);
  if r.procent > 0 and r.brugt < r.antal then v_pct := r.procent; end if;
  liste_ekskl_oere := v_liste;
  rabat_procent := v_pct;
  rabat_oere := round(v_liste * v_pct / 100.0)::bigint;
  ekskl_oere := v_liste - rabat_oere;
  moms_oere := public.ugens_butik_moms_oere(ekskl_oere);
  inkl_oere := ekskl_oere + moms_oere;
  return next;
end;
$fn$;

-- Udløbne reservationer for ugen frigives (status 'udloebet'). Kaldes under
-- ugens lås. Svar: de PaymentIntents, serveren skal annullere hos Stripe
-- (betales en alligevel, behandles den af ugens_butik_registrer).
create or replace function public.ugens_butik_udloeb_uge(p_uge date)
returns text[] language plpgsql security definer set search_path = '' as $fn$
declare
  v_pi text[];
begin
  select coalesce(array_agg(b.stripe_payment_intent_id) filter (where b.stripe_payment_intent_id is not null), '{}')
    into v_pi
    from (select x.id, x.stripe_payment_intent_id from public.ugens_butik_bookinger x
           where x.uge_start = p_uge and x.status = 'reserveret' and x.reserveret_til <= now()
           for update) b;
  update public.ugens_butik_bookinger b
     set status = 'udloebet', udloebet_kl = now(),
         tidligere_payment_intents = case when b.stripe_payment_intent_id is null then b.tidligere_payment_intents
                                          else array_append(b.tidligere_payment_intents, b.stripe_payment_intent_id) end,
         stripe_payment_intent_id = null
   where b.uge_start = p_uge and b.status = 'reserveret' and b.reserveret_til <= now();
  return v_pi;
end;
$fn$;

-- ===========================================================================
-- 4. Firmaets køb: start, PaymentIntent, spejl fra Stripe
-- ===========================================================================
-- p_bruger SKAL være verificeret af serveren (auth). p_uge: mandagen. Svar:
--   {kode: 'ok', id, uge_start, beloeb_oere, reserveret_til, pi: null,
--    pi_forsoeg: 0, gammel_pi: [...]}                      ny reservation
--   {kode: 'findes', id, uge_start, beloeb_oere, reserveret_til, pi,
--    pi_forsoeg, status}                                   åben betaling for ugen
--   {kode: 'skift', pi}       firmaets åbne betaling for en ANDEN uge har en
--                             PaymentIntent - serveren annullerer den og prøver igen
--   {kode: 'aaben_reservation', uge_start}   staff har reserveret en anden uge
--                             til firmaet - den skal betales eller annulleres først
--   {kode: 'behandles'}       en betaling er på vej igennem banken
--   {kode: 'optaget' | 'uge_ugyldig' | 'ugyldig' | 'ikke_firma' | 'spaerret'
--          | 'ikke_aktiv' | 'noedstop'}
create or replace function public.ugens_butik_koeb_start(p_bruger uuid, p_uge date)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  s        public.ugens_butik_indstillinger%rowtype;
  v_firma  uuid;
  v_kode   text;
  v_nu     date := public.ugens_butik_uge(now());
  k        record;
  v_id     uuid;
  v_til    timestamptz;
  p        record;
  v_gamle  text[];
begin
  if p_bruger is null or p_uge is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  v_kode := public.ugens_butik_firma_spaerret(p_bruger);
  if v_kode is not null then return jsonb_build_object('kode', v_kode); end if;
  if public.nye_betalinger_stoppet() then return jsonb_build_object('kode', 'noedstop'); end if;
  select * into s from public.ugens_butik_indstillinger where id;
  if not found then return jsonb_build_object('kode', 'ugyldig'); end if;
  -- Fra NÆSTE uge (en igangværende uge kan kun staff booke) og højst
  -- maks_uger_frem uger frem.
  if extract(isodow from p_uge) <> 1 or p_uge <= v_nu or p_uge > v_nu + 7 * s.maks_uger_frem then
    return jsonb_build_object('kode', 'uge_ugyldig');
  end if;
  select f.id into v_firma from public.firmaer f where f.bruger_id = p_bruger;
  perform public.ugens_butik_laas_firma(v_firma);

  select b.id, b.uge_start, b.status, b.kilde, b.beloeb_oere, b.reserveret_til, b.stripe_payment_intent_id, b.pi_forsoeg
    into k
    from public.ugens_butik_bookinger b
   where b.firma_id = v_firma and b.status in ('reserveret', 'behandles')
   for update;
  if k.id is not null then
    if k.status = 'behandles' then return jsonb_build_object('kode', 'behandles', 'uge_start', k.uge_start); end if;
    if k.uge_start = p_uge and k.reserveret_til > now() then
      update public.ugens_butik_bookinger set aktivitet_kl = now() where id = k.id;
      return jsonb_build_object('kode', 'findes', 'id', k.id, 'uge_start', k.uge_start, 'beloeb_oere', k.beloeb_oere,
                                'reserveret_til', k.reserveret_til, 'pi', k.stripe_payment_intent_id,
                                'pi_forsoeg', k.pi_forsoeg, 'status', k.status);
    end if;
    if k.kilde = 'staff' and k.reserveret_til > now() then
      return jsonb_build_object('kode', 'aaben_reservation', 'uge_start', k.uge_start);
    end if;
    if k.stripe_payment_intent_id is not null then
      -- En anden uge, eller reservationen er udløbet: serveren annullerer
      -- PaymentIntenten hos Stripe FØRST (eller spejler den, hvis den nåede
      -- at blive betalt - så har firmaet ugen) og prøver igen.
      return jsonb_build_object('kode', 'skift', 'pi', k.stripe_payment_intent_id, 'uge_start', k.uge_start);
    end if;
    -- Udløbet eller en ubetalt reservation uden PaymentIntent for en anden
    -- uge: den frigives, og der startes en ny.
    update public.ugens_butik_bookinger
       set status = case when reserveret_til <= now() then 'udloebet' else 'annulleret' end,
           udloebet_kl = case when reserveret_til <= now() then now() end,
           annulleret_kl = case when reserveret_til > now() then now() end,
           annullering_begrundelse = case when reserveret_til > now() then 'Firmaet valgte en anden uge' end,
           tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                            else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
           stripe_payment_intent_id = null
     where id = k.id;
    v_gamle := case when k.stripe_payment_intent_id is not null then array[k.stripe_payment_intent_id] else '{}' end;
  end if;

  perform public.ugens_butik_laas_uge(p_uge);
  v_gamle := coalesce(v_gamle, '{}') || public.ugens_butik_udloeb_uge(p_uge);
  if exists (select 1 from public.ugens_butik_bookinger b
              where b.uge_start = p_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then
    return jsonb_build_object('kode', 'optaget', 'gammel_pi', to_jsonb(v_gamle));
  end if;
  -- Prisen (med pakkens rabat, hvis der er rabat-uger tilbage i ugens år).
  select * into p from public.ugens_butik_pris_for(v_firma, p_uge);
  v_til := now() + make_interval(mins => s.reservation_minutter);
  insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
                                            reserveret_til, pris_ekskl_moms_oere, moms_oere, beloeb_oere,
                                            rabat_procent, rabat_oere)
  values (v_firma, p_bruger, p_uge, now(), now(), 'firma', 'stripe', 'reserveret',
          v_til, p.ekskl_oere, p.moms_oere, p.inkl_oere, p.rabat_procent, p.rabat_oere)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'uge_start', p_uge, 'beloeb_oere', p.inkl_oere,
                            'rabat_procent', p.rabat_procent, 'rabat_oere', p.rabat_oere,
                            'reserveret_til', v_til, 'pi', null, 'pi_forsoeg', 0, 'gammel_pi', to_jsonb(v_gamle));
end;
$fn$;

-- PaymentIntenten gemmes kun, hvis reservationen stadig er åben (og ikke
-- udløbet) med samme forsøg - og ikke under et nødstop. 'ok' | 'noedstop' | 'nej'
create or replace function public.ugens_butik_gem_pi(p_id uuid, p_pi text, p_forsoeg integer)
returns text language plpgsql security definer set search_path = '' as $fn$
begin
  if p_pi is null or p_pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then return 'nej'; end if;
  if public.nye_betalinger_stoppet() then return 'noedstop'; end if;
  update public.ugens_butik_bookinger
     set stripe_payment_intent_id = p_pi, aktivitet_kl = now()
   where id = p_id and stripe_payment_intent_id is null and pi_forsoeg = p_forsoeg
     and status = 'reserveret' and reserveret_til > now() and betaling = 'stripe';
  return case when found then 'ok' else 'nej' end;
end;
$fn$;

-- En PaymentIntent, der er annulleret hos Stripe, kasseres (pi_forsoeg + 1).
create or replace function public.ugens_butik_nulstil_pi(p_id uuid, p_pi text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  update public.ugens_butik_bookinger
     set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
         stripe_payment_intent_id = null,
         pi_forsoeg = pi_forsoeg + 1
   where id = p_id and stripe_payment_intent_id = p_pi and status = 'reserveret';
  return found;
end;
$fn$;

-- Spejler PaymentIntentens status (webhooken, returen fra betalingen og
-- cron'en). Idempotent. Svar {kode, id?}:
--   'betalt'          betalt nu - firmaet har ugen
--   'allerede'        var allerede registreret
--   'beloeb_afviger'  betalt med et andet beløb: ugen frigives, refunderes af koden
--   'for_sent'        betalt efter udløb/annullering, og ugen er ikke ledig
--                     (eller bookingen er annulleret af staff): refunderes af koden
--   'kasseret'        en kasseret PaymentIntent er betalt: refunderes af koden
--   'behandles' | 'afventer' | 'nulstillet' | 'uaendret' | 'ukendt'
create or replace function public.ugens_butik_registrer(
  p_pi text, p_status text, p_charge text, p_beloeb bigint, p_fejl text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  k       record;
  v_k     uuid;
  v_firma uuid;
  v_uge   date;
begin
  if p_pi is null then return jsonb_build_object('kode', 'ukendt'); end if;
  -- Låserækkefølge: firmaet, ugen, rækken. Firma og uge slås op uden lås.
  select b.firma_id, b.uge_start into v_firma, v_uge
    from public.ugens_butik_bookinger b where b.stripe_payment_intent_id = p_pi;
  if v_firma is null then
    select b.id into v_k from public.ugens_butik_bookinger b where p_pi = any(b.tidligere_payment_intents) limit 1;
    if v_k is not null then
      -- Den kasserede PaymentIntent er måske udløbet-reservationens: er
      -- bookingen udløbet med netop denne som seneste, og er ugen ledig,
      -- får firmaet ugen alligevel.
      select b.firma_id, b.uge_start into v_firma, v_uge from public.ugens_butik_bookinger b where b.id = v_k;
      perform public.ugens_butik_laas_firma(v_firma);
      perform public.ugens_butik_laas_uge(v_uge);
      select b.id, b.status, b.beloeb_oere, b.betalt_kl, b.slut_kl,
             b.tidligere_payment_intents[array_length(b.tidligere_payment_intents, 1)] as seneste
        into k from public.ugens_butik_bookinger b where b.id = v_k for update;
      if p_status = 'succeeded' and k.status = 'udloebet' and k.seneste = p_pi and k.betalt_kl is null then
        if p_beloeb is distinct from k.beloeb_oere then
          update public.ugens_butik_bookinger
             set status = 'refunderes', betalt_kl = now(), stripe_payment_intent_id = p_pi,
                 tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
                 stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
                 refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(), kraever_opmaerksomhed = true,
                 opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
                   'Ugens butik er betalt med et andet beløb end prisen - ugen er ikke givet, og beløbet refunderes automatisk.'), 4000)
           where id = k.id;
          return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
        end if;
        if k.slut_kl > now() and not exists (
             select 1 from public.ugens_butik_bookinger b
              where b.uge_start = v_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then
          update public.ugens_butik_bookinger
             set status = 'betalt', betalt_kl = now(), stripe_payment_intent_id = p_pi,
                 tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
                 stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
                 udloebet_kl = null, sidste_fejl = null
           where id = k.id;
          return jsonb_build_object('kode', 'betalt', 'id', k.id);
        end if;
        update public.ugens_butik_bookinger
           set status = 'refunderes', betalt_kl = now(), stripe_payment_intent_id = p_pi,
               tidligere_payment_intents = array_remove(tidligere_payment_intents, p_pi),
               stripe_charge_id = coalesce(p_charge, stripe_charge_id), modtaget_oere = p_beloeb,
               refusion_aarsag = 'for_sent', refusion_anmodet_kl = now()
         where id = k.id;
        return jsonb_build_object('kode', 'for_sent', 'id', k.id);
      end if;
      if p_status = 'succeeded' then return jsonb_build_object('kode', 'kasseret', 'id', v_k); end if;
      return jsonb_build_object('kode', 'uaendret', 'id', v_k);
    end if;
    return jsonb_build_object('kode', 'ukendt');
  end if;
  perform public.ugens_butik_laas_firma(v_firma);
  perform public.ugens_butik_laas_uge(v_uge);
  select b.id, b.status, b.beloeb_oere, b.betalt_kl, b.slut_kl into k
    from public.ugens_butik_bookinger b where b.stripe_payment_intent_id = p_pi for update;
  if k.id is null then return jsonb_build_object('kode', 'ukendt'); end if;

  if p_status = 'succeeded' then
    if k.betalt_kl is not null then return jsonb_build_object('kode', 'allerede', 'id', k.id); end if;
    if p_beloeb is distinct from k.beloeb_oere then
      update public.ugens_butik_bookinger
         set status = 'refunderes', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null, refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(),
             kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
               'Ugens butik er betalt med et andet beløb end prisen - ugen er ikke givet, og beløbet refunderes automatisk.'), 4000)
       where id = k.id;
      return jsonb_build_object('kode', 'beloeb_afviger', 'id', k.id);
    end if;
    if k.status in ('reserveret', 'behandles') then
      update public.ugens_butik_bookinger
         set status = 'betalt', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
             modtaget_oere = p_beloeb, sidste_fejl = null
       where id = k.id;
      return jsonb_build_object('kode', 'betalt', 'id', k.id);
    end if;
    -- Annulleret (staff) eller udløbet: pengene sendes tilbage.
    update public.ugens_butik_bookinger
       set status = 'refunderes', betalt_kl = now(), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
           modtaget_oere = p_beloeb, refusion_aarsag = 'for_sent', refusion_anmodet_kl = now()
     where id = k.id;
    return jsonb_build_object('kode', 'for_sent', 'id', k.id);
  elsif p_status = 'processing' then
    update public.ugens_butik_bookinger set status = 'behandles' where id = k.id and status = 'reserveret';
    return jsonb_build_object('kode', case when found then 'behandles' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'requires_payment_method' then
    update public.ugens_butik_bookinger set status = 'reserveret', sidste_fejl = left(p_fejl, 500)
     where id = k.id and status in ('reserveret', 'behandles');
    return jsonb_build_object('kode', case when found then 'afventer' else 'uaendret' end, 'id', k.id);
  elsif p_status = 'canceled' then
    if k.status in ('reserveret', 'behandles') then
      update public.ugens_butik_bookinger
         set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
             stripe_payment_intent_id = null, pi_forsoeg = pi_forsoeg + 1, status = 'reserveret'
       where id = k.id;
      return jsonb_build_object('kode', 'nulstillet', 'id', k.id);
    end if;
  end if;
  return jsonb_build_object('kode', 'uaendret', 'id', k.id);
end;
$fn$;

-- Firmaet annullerer selv sin åbne betaling ("Annullér" i Firma oversigt -
-- også en reservation, staff har lavet til firmaet). Serveren annullerer
-- PaymentIntenten hos Stripe FØRST; her ændres kun en reservation, hvis
-- PaymentIntent stadig er den annullerede (p_pi) eller der ingen er.
-- p_bruger SKAL være verificeret af serveren. 'ok' | 'ikke_fundet' | 'behandles' | 'nej'
create or replace function public.ugens_butik_firma_annuller(p_bruger uuid, p_id uuid, p_pi text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
begin
  select b.id, b.firma_id, b.uge_start, b.status, b.stripe_payment_intent_id into k
    from public.ugens_butik_bookinger b
    join public.firmaer f on f.id = b.firma_id
   where b.id = p_id and f.bruger_id = p_bruger;
  if k.id is null then return 'ikke_fundet'; end if;
  perform public.ugens_butik_laas_firma(k.firma_id);
  perform public.ugens_butik_laas_uge(k.uge_start);
  select b.status, b.stripe_payment_intent_id into k from public.ugens_butik_bookinger b where b.id = p_id for update;
  if k.status = 'behandles' then return 'behandles'; end if;
  update public.ugens_butik_bookinger
     set status = 'annulleret', annulleret_kl = now(), annullering_begrundelse = 'Annulleret af firmaet',
         tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                          else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
         stripe_payment_intent_id = null
   where id = p_id and status = 'reserveret'
     and (stripe_payment_intent_id is null or stripe_payment_intent_id = p_pi);
  return case when found then 'ok' else 'nej' end;
end;
$fn$;

-- En reservation, der ikke blev betalt i tide, udløber (cron - EFTER at
-- PaymentIntenten er annulleret hos Stripe). Kun fra 'reserveret', kun når
-- tiden er gået, og kun hvis bookingens PaymentIntent er den, der blev
-- annulleret (p_pi), eller der ingen er.
create or replace function public.ugens_butik_udloeb(p_id uuid, p_pi text)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  update public.ugens_butik_bookinger
     set status = 'udloebet', udloebet_kl = now(),
         tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                          else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
         stripe_payment_intent_id = null
   where id = p_id and status = 'reserveret' and reserveret_til <= now()
     and (stripe_payment_intent_id is null or stripe_payment_intent_id = p_pi);
  return found;
end;
$fn$;

-- ===========================================================================
-- 5. Refusion (hele beløbet) - chef og sælger-rollen (20261101060000) eller automatisk
-- ===========================================================================
-- Resultat af et refusionsforsøg hos Stripe (som boost).
-- 'refunderet' | 'allerede' | 'igen' | 'opgivet' | 'forkert_status'
create or replace function public.ugens_butik_refusion_resultat(p_id uuid, p_ok boolean, p_refund text, p_fejl text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
begin
  select b.id, b.status, b.refusion_forsoeg into k from public.ugens_butik_bookinger b where b.id = p_id for update;
  if k.id is null then return 'forkert_status'; end if;
  if k.status = 'refunderet' then return 'allerede'; end if;
  if k.status <> 'refunderes' then return 'forkert_status'; end if;
  if p_ok then
    update public.ugens_butik_bookinger
       set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = p_refund, refusion_sidste_fejl = null
     where id = p_id;
    return 'refunderet';
  end if;
  update public.ugens_butik_bookinger
     set refusion_forsoeg = refusion_forsoeg + 1,
         refusion_sidste_fejl = left(p_fejl, 500),
         refusion_naeste_kl = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(refusion_forsoeg, 7))),
         kraever_opmaerksomhed = kraever_opmaerksomhed or refusion_forsoeg + 1 >= 5
   where id = p_id;
  return case when k.refusion_forsoeg + 1 >= 5 then 'opgivet' else 'igen' end;
end;
$fn$;

-- refund.failed: tilbage til 'refunderes', så cron'en prøver igen (ny nøgle).
create or replace function public.ugens_butik_refusion_fejlet(p_refund text, p_fejl text)
returns text language plpgsql security definer set search_path = '' as $fn$
begin
  update public.ugens_butik_bookinger
     set status = 'refunderes', refunderet_kl = null, stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         refusion_sidste_fejl = left(p_fejl, 500), refusion_naeste_kl = now() + interval '5 minutes'
   where stripe_refund_id = p_refund and status = 'refunderet';
  return case when found then 'genaabnet' else 'uaendret' end;
end;
$fn$;

-- charge.refunded (fx refunderet i Stripe-dashboardet eller vores egen
-- refusion, før resultatet er gemt). Fuld: bookingen bliver 'refunderet' (og
-- ugen frigives); var det ikke BidHamrs egen refusion, markeres staff.
-- Delvis: kun staff. 'refunderet' | 'allerede' | 'markeret' | 'ukendt'
create or replace function public.ugens_butik_registrer_charge_refusion(p_charge text, p_refund text, p_fuld boolean)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  k record;
  v_firma uuid;
  v_uge date;
begin
  select b.firma_id, b.uge_start into v_firma, v_uge from public.ugens_butik_bookinger b where b.stripe_charge_id = p_charge;
  if v_firma is null then return 'ukendt'; end if;
  perform public.ugens_butik_laas_firma(v_firma);
  perform public.ugens_butik_laas_uge(v_uge);
  select b.id, b.status into k from public.ugens_butik_bookinger b where b.stripe_charge_id = p_charge for update;
  if k.id is null then return 'ukendt'; end if;
  if k.status = 'refunderet' then return 'allerede'; end if;
  if k.status not in ('betalt', 'refunderes', 'annulleret') then return 'ukendt'; end if;
  if not p_fuld then
    update public.ugens_butik_bookinger
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
             'Ugens butik er delvist refunderet hos Stripe uden om BidHamr - kontrollér det.'), 4000)
     where id = k.id;
    return 'markeret';
  end if;
  update public.ugens_butik_bookinger
     set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_aarsag = coalesce(refusion_aarsag, 'ekstern'), refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         kraever_opmaerksomhed = kraever_opmaerksomhed or k.status <> 'refunderes',
         opmaerksomhed_tekst = case when k.status <> 'refunderes'
                                    then left(concat_ws(E'\n', opmaerksomhed_tekst,
                                      'Ugens butik er refunderet hos Stripe uden om BidHamr - bookingen er annulleret, og ugen er ledig igen.'), 4000)
                                    else opmaerksomhed_tekst end
   where id = k.id;
  return 'refunderet';
end;
$fn$;

-- Indsigelse fra firmaets bank (chargeback): bookingen markeres til staff.
-- Intet flyttes automatisk (staff svarer banken i Stripe). Idempotent.
-- 'markeret' | 'ukendt'
create or replace function public.ugens_butik_indsigelse(p_charge text, p_dispute text, p_status text)
returns text language plpgsql security definer set search_path = '' as $fn$
begin
  if p_charge is null or p_status is null then return 'ukendt'; end if;
  update public.ugens_butik_bookinger
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = case when indsigelse_status is not distinct from p_status then opmaerksomhed_tekst
                                    else left(concat_ws(E'\n', opmaerksomhed_tekst,
                                      format('Indsigelse fra firmaets bank (%s): svar banken i Stripe-dashboardet.', p_status)), 4000) end,
         indsigelse_status = p_status, stripe_dispute_id = coalesce(p_dispute, stripe_dispute_id)
   where stripe_charge_id = p_charge;
  return case when found then 'markeret' else 'ukendt' end;
end;
$fn$;

-- Cron: hvad skal gøres? (claimet med synket_kl / refusion_naeste_kl)
--   'refusion'  refusionen er claimet, men ikke gennemført
--   'udloeb'    reservationen er udløbet: PaymentIntenten annulleres hos
--               Stripe (eller spejles, hvis den er betalt), og bookingen udløber
--   'synk'      åben betaling med PaymentIntent i over 15 min (mistet webhook)
create or replace function public.ugens_butik_cron(p_graense integer default 20)
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
                when b.status = 'reserveret' and b.reserveret_til <= now() then 'udloeb'
                else 'synk' end as handling,
           b.status, b.synket_kl, b.refusion_naeste_kl, b.oprettet_kl
      from public.ugens_butik_bookinger b
     where (b.status = 'refunderes' and b.refusion_forsoeg < 5
            and (b.refusion_naeste_kl is null or b.refusion_naeste_kl <= now())
            and b.refusion_anmodet_kl <= now() - interval '2 minutes')
        or (b.status = 'reserveret' and b.reserveret_til <= now()
            and (b.synket_kl is null or b.synket_kl <= now() - interval '5 minutes'))
        or (b.status in ('reserveret', 'behandles') and b.stripe_payment_intent_id is not null
            and b.opdateret <= now() - interval '15 minutes'
            and (b.synket_kl is null or b.synket_kl <= now() - interval '15 minutes'))
     order by case when b.status = 'refunderes' then 0 when b.status = 'reserveret' then 1 else 2 end,
              coalesce(b.refusion_naeste_kl, b.synket_kl, b.oprettet_kl)
     limit v_graense
     for update of b skip locked
  ), u as (
    update public.ugens_butik_bookinger x
       set synket_kl = case when k.handling in ('synk', 'udloeb') then now() else x.synket_kl end,
           refusion_naeste_kl = case when k.handling = 'refusion' then now() + interval '10 minutes' else x.refusion_naeste_kl end
      from k
     where x.id = k.id
    returning x.id, k.handling
  )
  select u.id, u.handling from u;
end;
$fn$;

-- ===========================================================================
-- 6. Staff: book, annullér, refundér, pris og oversigt
-- ===========================================================================
-- Chef og sælger-rollen (Erhverv). Kun chefen: prisen (betalte bookinger:
-- også sælger-rollen fra 20261101060000).
create or replace function public.ugens_butik_staff_rolle(p_staff uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  select u.rolle from public.users u
   where u.id = p_staff and u.rolle in ('chef', 'saelger')
     and u.konto_lukket_kl is null and u.konto_slettet_kl is null;
$fn$;

-- Book en uge manuelt (fx efter en aftale). p_med_betaling: true = en
-- reservation, firmaet betaler i Firma oversigt inden for
-- staff_reservation_timer (48 t); false = 'manuel' uden betaling. Begrundelse
-- påkrævet. Svar {kode: 'ok', id, status} | 'ingen_adgang' | 'ugyldig' |
-- 'begrundelse_mangler' | 'ikke_fundet' | 'spaerret' | 'ikke_aktiv' |
-- 'uge_ugyldig' | 'optaget' (gammel_pi) | 'aaben_reservation' (firmaet har
-- allerede en åben betaling) | 'noedstop'
create or replace function public.ugens_butik_staff_book(
  p_staff uuid, p_firma uuid, p_uge date, p_med_betaling boolean, p_begrundelse text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  s       public.ugens_butik_indstillinger%rowtype;
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_nu    date := public.ugens_butik_uge(now());
  v_bruger uuid;
  v_kode  text;
  v_id    uuid;
  p       record;
  v_gamle text[];
  v_med   boolean := coalesce(p_med_betaling, false);
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if p_firma is null or p_uge is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  select * into s from public.ugens_butik_indstillinger where id;
  if extract(isodow from p_uge) <> 1 or p_uge < v_nu or p_uge > v_nu + 7 * s.staff_maks_uger_frem
     or (v_med and p_uge <= v_nu) then
    return jsonb_build_object('kode', 'uge_ugyldig');
  end if;
  select f.bruger_id into v_bruger from public.firmaer f where f.id = p_firma;
  if v_bruger is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_bruger = p_staff then return jsonb_build_object('kode', 'inhabil'); end if;
  v_kode := public.ugens_butik_firma_spaerret(v_bruger);
  if v_kode is not null then return jsonb_build_object('kode', case when v_kode = 'ikke_firma' then 'ikke_fundet' else v_kode end); end if;
  if v_med and public.nye_betalinger_stoppet() then return jsonb_build_object('kode', 'noedstop'); end if;

  perform public.ugens_butik_laas_firma(p_firma);
  if v_med and exists (select 1 from public.ugens_butik_bookinger b
                        where b.firma_id = p_firma and b.status in ('reserveret', 'behandles')
                          and (b.status = 'behandles' or b.reserveret_til > now())) then
    return jsonb_build_object('kode', 'aaben_reservation');
  end if;
  perform public.ugens_butik_laas_uge(p_uge);
  v_gamle := public.ugens_butik_udloeb_uge(p_uge);
  if exists (select 1 from public.ugens_butik_bookinger b
              where b.uge_start = p_uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')) then
    return jsonb_build_object('kode', 'optaget', 'gammel_pi', to_jsonb(v_gamle));
  end if;
  if v_med then
    -- Firmaets egen udløbne reservation (en anden uge) frigives, så det
    -- unikke indeks (én åben betaling pr. firma) ikke rammer.
    select b.stripe_payment_intent_id into v_kode
      from public.ugens_butik_bookinger b
     where b.firma_id = p_firma and b.status = 'reserveret' and b.reserveret_til <= now()
     for update;
    update public.ugens_butik_bookinger b
       set status = 'udloebet', udloebet_kl = now(),
           tidligere_payment_intents = case when b.stripe_payment_intent_id is null then b.tidligere_payment_intents
                                            else array_append(b.tidligere_payment_intents, b.stripe_payment_intent_id) end,
           stripe_payment_intent_id = null
     where b.firma_id = p_firma and b.status = 'reserveret' and b.reserveret_til <= now();
    if v_kode is not null then v_gamle := v_gamle || v_kode; end if;
    -- Samme pris og rabat, som hvis firmaet selv havde købt ugen.
    select * into p from public.ugens_butik_pris_for(p_firma, p_uge);
    insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
                                              reserveret_til, pris_ekskl_moms_oere, moms_oere, beloeb_oere,
                                              rabat_procent, rabat_oere, oprettet_af, note)
    values (p_firma, v_bruger, p_uge, now(), now(), 'staff', 'stripe', 'reserveret',
            now() + make_interval(hours => s.staff_reservation_timer), p.ekskl_oere, p.moms_oere,
            p.inkl_oere, p.rabat_procent, p.rabat_oere, p_staff, left(v_grund, 1000))
    returning id into v_id;
  else
    insert into public.ugens_butik_bookinger (firma_id, bruger_id, uge_start, start_kl, slut_kl, kilde, betaling, status,
                                              pris_ekskl_moms_oere, moms_oere, beloeb_oere, oprettet_af, note)
    values (p_firma, v_bruger, p_uge, now(), now(), 'staff', 'ingen', 'manuel', 0, 0, 0, p_staff, left(v_grund, 1000))
    returning id into v_id;
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'ugens_butik_booket', 'ugens_butik', v_id, v_bruger,
          left(format('Ugens butik uge %s (%s) booket %s. %s', to_char(p_uge, 'IYYY-IW'), p_uge,
                      case when v_med then 'med betaling (firmaet betaler i Firma oversigt)' else 'uden betaling' end,
                      v_grund), 1000));
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'status', case when v_med then 'reserveret' else 'manuel' end,
                            'gammel_pi', to_jsonb(v_gamle));
end;
$fn$;

-- Annullér en booking. Chef og sælger: manuelle og ubetalte (reserveret).
-- Kun chefen (RETTET i 20261101060000: også sælger-rollen): betalte - med refusion (p_refunder = true: 'refunderes', serveren
-- refunderer hos Stripe; cron'en prøver igen) eller uden (pengene beholdes,
-- fx efter aftale med firmaet). Begrundelse påkrævet; logges. Svar {kode:
-- 'ok', status, pi?} | 'ingen_adgang' | 'kun_chef' | 'begrundelse_mangler' |
-- 'ikke_fundet' | 'forkert_status' | 'behandles' | 'inhabil'
-- pi: en åben PaymentIntent, serveren skal annullere hos Stripe.
create or replace function public.ugens_butik_staff_annuller(
  p_staff uuid, p_id uuid, p_begrundelse text, p_refunder boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_rolle text := public.ugens_butik_staff_rolle(p_staff);
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  v_firma uuid;
  v_uge   date;
  k       record;
  v_ny    text;
begin
  if v_rolle is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
  if v_grund is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
  select b.firma_id, b.uge_start into v_firma, v_uge from public.ugens_butik_bookinger b where b.id = p_id;
  if v_firma is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  perform public.ugens_butik_laas_firma(v_firma);
  perform public.ugens_butik_laas_uge(v_uge);
  select b.id, b.status, b.bruger_id, b.stripe_payment_intent_id, b.betalt_kl, b.beloeb_oere into k
    from public.ugens_butik_bookinger b where b.id = p_id for update;
  if k.bruger_id = p_staff then return jsonb_build_object('kode', 'inhabil'); end if;
  if k.status = 'behandles' then return jsonb_build_object('kode', 'behandles'); end if;
  if k.status = 'betalt' then
    if v_rolle <> 'chef' then return jsonb_build_object('kode', 'kun_chef'); end if;
    v_ny := case when coalesce(p_refunder, false) then 'refunderes' else 'annulleret' end;
    update public.ugens_butik_bookinger
       set status = v_ny, annulleret_kl = now(), annulleret_af = p_staff, annullering_begrundelse = left(v_grund, 1000),
           refusion_aarsag = case when v_ny = 'refunderes' then 'staff' else refusion_aarsag end,
           refusion_anmodet_kl = case when v_ny = 'refunderes' then now() else refusion_anmodet_kl end,
           refusion_naeste_kl = null,
           refusion_af = case when v_ny = 'refunderes' then p_staff else refusion_af end,
           refusion_begrundelse = case when v_ny = 'refunderes' then left(v_grund, 1000) else refusion_begrundelse end
     where id = p_id;
  elsif k.status in ('reserveret', 'manuel') then
    if coalesce(p_refunder, false) then return jsonb_build_object('kode', 'forkert_status'); end if;
    v_ny := 'annulleret';
    update public.ugens_butik_bookinger
       set status = 'annulleret', annulleret_kl = now(), annulleret_af = p_staff, annullering_begrundelse = left(v_grund, 1000),
           tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                            else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
           stripe_payment_intent_id = null
     where id = p_id;
  elsif k.status = 'annulleret' and k.betalt_kl is not null and coalesce(p_refunder, false) then
    -- En annulleret, betalt booking kan senere refunderes af chefen.
    if v_rolle <> 'chef' then return jsonb_build_object('kode', 'kun_chef'); end if;
    v_ny := 'refunderes';
    update public.ugens_butik_bookinger
       set status = 'refunderes', refusion_aarsag = 'staff', refusion_anmodet_kl = now(), refusion_naeste_kl = null,
           refusion_af = p_staff, refusion_begrundelse = left(v_grund, 1000)
     where id = p_id;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, case when v_ny = 'refunderes' then 'ugens_butik_refunderet' else 'ugens_butik_annulleret' end,
          'ugens_butik', p_id, k.bruger_id,
          left(format('Ugens butik uge %s (%s) %s. %s', to_char(v_uge, 'IYYY-IW'), v_uge,
                      case when v_ny = 'refunderes' then format('annulleret og refunderet (%s kr.)', k.beloeb_oere / 100.0)
                           when k.betalt_kl is not null then 'annulleret uden refusion'
                           else 'annulleret' end, v_grund), 1000));
  return jsonb_build_object('kode', 'ok', 'status', v_ny,
                            'pi', case when k.status = 'reserveret' then k.stripe_payment_intent_id end);
end;
$fn$;

-- Chefen retter prisen (ekskl. moms, øre). Gælder nye reservationer og
-- bookinger; åbne reservationer beholder deres pris. Logges.
-- {kode: 'ok', pris_ekskl_moms_oere, moms_oere, beloeb_oere} | 'ingen_adgang' | 'ugyldig'
create or replace function public.ugens_butik_saet_pris(p_staff uuid, p_pris_ekskl_moms_oere bigint)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_gl bigint;
begin
  if public.ugens_butik_staff_rolle(p_staff) is distinct from 'chef' then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_pris_ekskl_moms_oere is null or p_pris_ekskl_moms_oere not between 10000 and 1000000 then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  select pris_ekskl_moms_oere into v_gl from public.ugens_butik_indstillinger where id for update;
  update public.ugens_butik_indstillinger
     set pris_ekskl_moms_oere = p_pris_ekskl_moms_oere, opdateret_kl = now(), opdateret_af = p_staff
   where id;
  if v_gl is distinct from p_pris_ekskl_moms_oere then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_staff, 'ugens_butik_pris', 'system', p_staff, null,
            format('Ugens butik: pris ændret fra %s kr. til %s kr. pr. uge + moms', v_gl / 100.0, p_pris_ekskl_moms_oere / 100.0));
  end if;
  return jsonb_build_object('kode', 'ok', 'pris_ekskl_moms_oere', p_pris_ekskl_moms_oere,
                            'moms_oere', public.ugens_butik_moms_oere(p_pris_ekskl_moms_oere),
                            'beloeb_oere', p_pris_ekskl_moms_oere + public.ugens_butik_moms_oere(p_pris_ekskl_moms_oere));
end;
$fn$;

-- Admin -> Erhverv -> Ugens butik: prisen, ugerne frem og alle bookinger
-- (nyeste uger først, højst 300). null = ingen adgang (chef og sælger).
create or replace function public.ugens_butik_admin(p_staff uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  s    public.ugens_butik_indstillinger%rowtype;
  v_nu date := public.ugens_butik_uge(now());
begin
  if public.ugens_butik_staff_rolle(p_staff) is null then return null; end if;
  select * into s from public.ugens_butik_indstillinger where id;
  return jsonb_build_object(
    'rolle', public.ugens_butik_staff_rolle(p_staff),
    'pris', jsonb_build_object('ekskl_moms_oere', s.pris_ekskl_moms_oere,
                               'moms_oere', public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere),
                               'inkl_moms_oere', s.pris_ekskl_moms_oere + public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere),
                               'opdateret_kl', s.opdateret_kl),
    'denne_uge', v_nu,
    'uger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uge_start', g.uge, 'uge_nr', to_char(g.uge, 'IW')::int, 'aar', to_char(g.uge, 'IYYY')::int,
               'booking_id', b.id, 'status', b.status, 'firma_id', b.firma_id, 'firmanavn', f.firmanavn)
             order by g.uge)
        from generate_series(v_nu, v_nu + 7 * s.maks_uger_frem, interval '7 days') as g0(d)
        cross join lateral (select g0.d::date as uge) g
        left join public.ugens_butik_bookinger b
          on b.uge_start = g.uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')
        left join public.firmaer f on f.id = b.firma_id), '[]'::jsonb),
    'bookinger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
               'firma_id', b.firma_id, 'firmanavn', f.firmanavn, 'firma_bruger_id', b.bruger_id,
               'kilde', b.kilde, 'betaling', b.betaling, 'status', b.status,
               'reserveret_til', b.reserveret_til, 'beloeb_oere', b.beloeb_oere, 'modtaget_oere', b.modtaget_oere, 'rabat_procent', b.rabat_procent, 'rabat_oere', b.rabat_oere,
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl, 'refusion_aarsag', b.refusion_aarsag,
               'annulleret_kl', b.annulleret_kl, 'annullering_begrundelse', b.annullering_begrundelse,
               'note', b.note, 'oprettet_af_navn', su.navn, 'oprettet_kl', b.oprettet_kl,
               'kraever_opmaerksomhed', b.kraever_opmaerksomhed, 'opmaerksomhed_tekst', b.opmaerksomhed_tekst,
               'stripe_payment_intent_id', b.stripe_payment_intent_id)
             order by b.uge_start desc, b.oprettet_kl desc)
        from (select * from public.ugens_butik_bookinger x order by x.uge_start desc, x.oprettet_kl desc limit 300) b
        left join public.firmaer f on f.id = b.firma_id
        left join public.users su on su.id = b.oprettet_af), '[]'::jsonb),
    'firmaer', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'firmanavn', f.firmanavn, 'aktiv', f.abonnement_status = 'aktiv')
             order by f.firmanavn)
        from public.firmaer f
        join public.users u on u.id = f.bruger_id
       where u.konto_lukket_kl is null and u.konto_slettet_kl is null), '[]'::jsonb));
end;
$fn$;

-- ===========================================================================
-- 7. Firmaet selv (Firma oversigt - også appen)
-- ===========================================================================
-- null = ikke en firmakonto. Uger: fra næste mandag og maks_uger_frem uger
-- frem med status 'ledig' | 'optaget' (et andet firma - hvilket vises ikke) |
-- 'din' (betalt/booket) | 'din_reservation' (åben betaling). En anden
-- reservation, der er udløbet, vises som ledig.
create or replace function public.firma_ugens_butik()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid   uuid := auth.uid();
  v_firma uuid;
  s       public.ugens_butik_indstillinger%rowtype;
  v_nu    date := public.ugens_butik_uge(now());
  v_moms  bigint;
begin
  if v_uid is null then return null; end if;
  select f.id into v_firma from public.firmaer f join public.users u on u.id = f.bruger_id
   where f.bruger_id = v_uid and u.konto_type = 'erhverv';
  if v_firma is null then return null; end if;
  select * into s from public.ugens_butik_indstillinger where id;
  v_moms := public.ugens_butik_moms_oere(s.pris_ekskl_moms_oere);
  return jsonb_build_object(
    'pris', jsonb_build_object('ekskl_moms_oere', s.pris_ekskl_moms_oere, 'moms_oere', v_moms,
                               'inkl_moms_oere', s.pris_ekskl_moms_oere + v_moms),
    'reservation_minutter', s.reservation_minutter,
    -- Pakkens rabat og hvor mange rabat-uger, der er brugt i år (dansk kalender).
    'rabat', (select jsonb_build_object('procent', r.procent, 'antal_pr_aar', r.antal, 'brugt_i_aar', r.brugt,
                                        'tilbage_i_aar', greatest(r.antal - r.brugt, 0))
                from public.ugens_butik_rabat(v_firma, (now() at time zone 'Europe/Copenhagen')::date) r),
    'kan_koebe', public.ugens_butik_firma_spaerret(v_uid) is null,
    'grund', public.ugens_butik_firma_spaerret(v_uid),
    'denne_uge', v_nu,
    'uger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'uge_start', g.uge, 'uge_nr', to_char(g.uge, 'IW')::int, 'aar', to_char(g.uge, 'IYYY')::int,
               'start_kl', public.ugens_butik_uge_start_kl(g.uge),
               'slut_kl', public.ugens_butik_uge_start_kl(g.uge + 7),
               'status', case when b.id is null then 'ledig'
                              when b.firma_id = v_firma and b.status in ('reserveret', 'behandles') then 'din_reservation'
                              when b.firma_id = v_firma then 'din'
                              else 'optaget' end,
               -- Prisen for netop denne uge (rabat efter ugens kalenderår).
               'pris_inkl_moms_oere', pf.inkl_oere, 'pris_ekskl_moms_oere', pf.ekskl_oere,
               'rabat_procent', pf.rabat_procent)
             order by g.uge)
        from generate_series(v_nu + 7, v_nu + 7 * s.maks_uger_frem, interval '7 days') as g0(d)
        cross join lateral (select g0.d::date as uge) g
        cross join lateral public.ugens_butik_pris_for(v_firma, g.uge) pf
        left join public.ugens_butik_bookinger b
          on b.uge_start = g.uge and b.status in ('reserveret', 'behandles', 'betalt', 'manuel')
         and not (b.status = 'reserveret' and b.reserveret_til <= now())), '[]'::jsonb),
    'aaben', (
      select jsonb_build_object('id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
                                'status', b.status, 'kilde', b.kilde, 'reserveret_til', b.reserveret_til,
                                'beloeb_oere', b.beloeb_oere, 'rabat_procent', b.rabat_procent)
        from public.ugens_butik_bookinger b
       where b.firma_id = v_firma and b.status in ('reserveret', 'behandles')
         and (b.status = 'behandles' or b.reserveret_til > now())),
    'bookinger', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'uge_start', b.uge_start, 'uge_nr', to_char(b.uge_start, 'IW')::int,
               'aar', to_char(b.uge_start, 'IYYY')::int, 'start_kl', b.start_kl, 'slut_kl', b.slut_kl,
               'status', b.status, 'kilde', b.kilde, 'beloeb_oere', b.beloeb_oere,
               'rabat_procent', b.rabat_procent, 'rabat_oere', b.rabat_oere,
               'betalt_kl', b.betalt_kl, 'refunderet_kl', b.refunderet_kl,
               'aktiv_nu', b.status in ('betalt', 'manuel') and b.start_kl <= now() and b.slut_kl > now())
             order by b.uge_start desc, b.oprettet_kl desc)
        from (select * from public.ugens_butik_bookinger x
               where x.firma_id = v_firma and x.status in ('betalt', 'manuel', 'refunderes', 'refunderet', 'annulleret')
                 and (x.status <> 'annulleret' or x.betalt_kl is not null or x.kilde = 'staff')
               order by x.uge_start desc limit 100) b), '[]'::jsonb));
end;
$fn$;

-- ===========================================================================
-- 8. Forsiden (offentligt - anon og authenticated)
-- ===========================================================================
-- Den aktive uges firma (betalt eller booket af staff) med højst
-- maks_auktioner aktive auktioner, der kan ses og bydes på (som boost_top:
-- aktiv, ikke skjult, ikke arkiveret, ikke på pause, ikke slut, ikke under
-- kunst-kontrol), dem der slutter først øverst. Kun offentlige felter.
-- null = ingen booking denne uge, firmaet er ikke aktivt længere, eller
-- firmaet har ingen aktive auktioner. Vises som "Annonce" (markedsføringsloven).
create or replace function public.forside_ugens_butik()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  s  public.ugens_butik_indstillinger%rowtype;
  b  record;
  v_auk jsonb;
begin
  select * into s from public.ugens_butik_indstillinger where id;
  if not found then return null; end if;
  select x.id, x.uge_start, x.start_kl, x.slut_kl, f.bruger_id, f.firmanavn, u.avatar_url into b
    from public.ugens_butik_bookinger x
    join public.firmaer f on f.id = x.firma_id
    join public.users u on u.id = f.bruger_id
   where x.status in ('betalt', 'manuel') and x.start_kl <= now() and x.slut_kl > now()
     and f.abonnement_status = 'aktiv'
     and u.konto_lukket_kl is null and u.konto_slettet_kl is null
     and not (coalesce(u.suspenderet, false) and (u.suspenderet_til is null or u.suspenderet_til > now()))
   limit 1;
  if b.id is null then return null; end if;
  select jsonb_agg(z.j order by z.slutter_kl, z.id) into v_auk
    from (select a.id, a.slutter_kl,
                 jsonb_build_object('id', a.id, 'titel', a.titel,
                                    'billede', case when a.billeder is not null and cardinality(a.billeder) > 0 then a.billeder[1] end,
                                    'startpris', a.startpris, 'nuvaerende_bud', a."nuværende_bud",
                                    'antal_bud', a.antal_bud, 'slutter_kl', a.slutter_kl,
                                    'forsendelse_mulig', a.forsendelse_mulig) as j
            from public.auctions a
           where a.bruger_id = b.bruger_id
             and a.status = 'aktiv' and not coalesce(a.skjult, false) and a.arkiveret_kl is null
             and a.pauset_kl is null and a.slutter_kl > now()
             and (to_jsonb(a) ->> 'kunst_kontrol') is distinct from 'afventer'
           order by a.slutter_kl, a.id
           limit s.maks_auktioner) z;
  if v_auk is null then return null; end if;
  return jsonb_build_object(
    'annonce', true,
    'uge_start', b.uge_start, 'slut_kl', b.slut_kl,
    'firma', jsonb_build_object('bruger_id', b.bruger_id, 'firmanavn', b.firmanavn,
                                'profil_url', '/erhvervssaelger/' || b.bruger_id::text,
                                'billede', b.avatar_url),
    'auktioner', v_auk);
end;
$fn$;

-- ===========================================================================
-- 9. Faktura: købet faktureres firmaet (salgskonto, med moms - Dinero)
-- ===========================================================================
alter table public.fakturaer add column if not exists ugens_butik_id uuid
  references public.ugens_butik_bookinger(id) on delete restrict;

-- CHECK'erne udvides med en ny gren - den nuværende definition bevares
-- (læses fra databasen), så ændringer fra andre migrationer ikke overskrives.
do $do$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.fakturaer'::regclass and c.conname = 'fakturaer_kilde';
  if v_def is null then raise exception 'Drift: CHECK fakturaer_kilde mangler'; end if;
  if v_def not like '%ugens_butik%' then
    alter table public.fakturaer drop constraint fakturaer_kilde;
    execute format('alter table public.fakturaer add constraint fakturaer_kilde check ((%s) or %s)',
      regexp_replace(v_def, '^CHECK ', ''),
      $k$(dokument in ('faktura', 'kreditnota') and slags = 'ugens_butik' and ugens_butik_id is not null
          and betaling_id is null and firma_regning_id is null and part = 'koeber')$k$);
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.fakturaer'::regclass and c.conname = 'fakturaer_slags_check';
  if v_def is null then raise exception 'Drift: CHECK fakturaer_slags_check mangler'; end if;
  if v_def not like '%ugens_butik%' then
    alter table public.fakturaer drop constraint fakturaer_slags_check;
    -- (slags = any(...) and (...)) -> slags må også være 'ugens_butik' (kun
    -- faktura/kreditnota til køberen = firmaet).
    execute format('alter table public.fakturaer add constraint fakturaer_slags_check check ((%s) or %s)',
      regexp_replace(v_def, '^CHECK ', ''),
      $k$(slags = 'ugens_butik' and dokument in ('faktura', 'kreditnota') and part = 'koeber')$k$);
  end if;
end $do$;

alter table public.fakturaer drop constraint if exists fakturaer_ugens_butik_id_check;
alter table public.fakturaer add constraint fakturaer_ugens_butik_id_check
  check ((slags = 'ugens_butik') = (ugens_butik_id is not null));

create unique index if not exists fakturaer_ugens_butik_dokument
  on public.fakturaer (ugens_butik_id, dokument) where ugens_butik_id is not null;

create or replace function public.fakturaer_ugens_butik_laast()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.ugens_butik_id is distinct from old.ugens_butik_id then
    raise exception 'Fakturaens indhold kan ikke ændres, når den er oprettet';
  end if;
  return new;
end;
$fn$;
revoke all on function public.fakturaer_ugens_butik_laast() from public, anon, authenticated;
drop trigger if exists fakturaer_ugens_butik_laast on public.fakturaer;
create trigger fakturaer_ugens_butik_laast before update on public.fakturaer
  for each row execute function public.fakturaer_ugens_butik_laast();

comment on column public.fakturaer.ugens_butik_id is
  'Ugens butik (20261101020000): firmaets faktura (og kreditnota ved refusion) på en uges forsideplads. slags = ugens_butik, part = koeber (firmaet køber ydelsen). Låst.';

-- Fakturaens linjetekst, fx "Ugens butik på BidHamrs forside, uge 45 2026
-- (2.11.2026-8.11.2026)" - med rabat: "... (50 % rabat fra din pakke)".
drop function if exists public.ugens_butik_faktura_tekst(date);
create or replace function public.ugens_butik_faktura_tekst(p_uge date, p_rabat_procent integer)
returns text language sql immutable set search_path = '' as $fn$
  select format('Ugens butik på BidHamrs forside, uge %s %s (%s-%s)',
                to_char(p_uge, 'IW')::int, to_char(p_uge, 'IYYY'),
                to_char(p_uge, 'FMDD.FMMM.YYYY'), to_char(p_uge + 6, 'FMDD.FMMM.YYYY'))
         || case when coalesce(p_rabat_procent, 0) > 0 then format(' - %s %% rabat fra din pakke', p_rabat_procent) else '' end;
$fn$;

-- Planlægger fakturaer og kreditnotaer for Ugens butik (kaldes af
-- fakturakøen efter faktura_planlaeg). Idempotent.
--   faktura:    betalt booking (også hvis den senere er refunderet - så
--               bogføres begge). Dateret på betalingsdagen. Passer det
--               modtagne beløb ikke, oprettes den som "kræver handling".
--   kreditnota: refunderet booking (hele beløbet), dateret på refusionsdagen.
create or replace function public.faktura_planlaeg_ugens_butik(p_graense integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura integer := 0;
  v_kredit  integer := 0;
  n         integer;
  r         record;
  v_linjer  jsonb;
  v_ok      boolean;
  v_fejl    text := 'Ugens butik er betalt med et andet beløb end prisen - kontrollér betalingen hos Stripe og lav dokumentet manuelt i Dinero.';
begin
  for r in
    select x.id, x.bruger_id, x.uge_start, x.beloeb_oere, x.moms_oere, x.modtaget_oere, x.betalt_kl, x.rabat_procent,
           x.stripe_charge_id, x.stripe_payment_intent_id
      from public.ugens_butik_bookinger x
     where x.betalt_kl is not null
       and x.betaling = 'stripe'
       and x.status in ('betalt', 'annulleret', 'refunderes', 'refunderet')
       and not exists (select 1 from public.fakturaer f where f.ugens_butik_id = x.id and f.dokument = 'faktura')
     order by x.betalt_kl
     limit v_graense
  loop
    v_ok := r.modtaget_oere is not distinct from r.beloeb_oere;
    v_linjer := jsonb_build_array(public.faktura_linje('ugens_butik', public.ugens_butik_faktura_tekst(r.uge_start, r.rabat_procent), r.beloeb_oere));
    -- Momsen på fakturaen skal være præcis den, firmaet blev opkrævet
    -- (25 % af prisen ekskl. moms = 20 % af beløbet inkl. moms).
    if v_ok and public.faktura_moms(v_linjer) <> r.moms_oere then v_ok := false; end if;
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, ugens_butik_id)
    values ('faktura', 'koeber', r.bruger_id, null, null, v_linjer, public.faktura_sum(v_linjer),
            public.faktura_moms(v_linjer), (r.betalt_kl at time zone 'Europe/Copenhagen')::date,
            coalesce(r.stripe_charge_id, r.stripe_payment_intent_id),
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else v_fejl end, 'ugens_butik', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_faktura := v_faktura + n;
  end loop;

  for r in
    select fa.id as faktura_id, fa.bruger_id, fa.linjer, fa.manuel, fa.status as moder_status,
           x.id, x.refunderet_kl, x.stripe_refund_id
      from public.fakturaer fa
      join public.ugens_butik_bookinger x on x.id = fa.ugens_butik_id
     where fa.dokument = 'faktura'
       and fa.slags = 'ugens_butik'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.ugens_butik_id = x.id and k.dokument = 'kreditnota')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_ok := not (r.manuel or r.moder_status in ('kraever_handling', 'haandteret_manuelt'));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, ugens_butik_id)
    values ('kreditnota', 'koeber', r.bruger_id, null, null, r.faktura_id, r.linjer,
            public.faktura_sum(r.linjer), public.faktura_moms(r.linjer),
            (r.refunderet_kl at time zone 'Europe/Copenhagen')::date, r.stripe_refund_id,
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.' end,
            'ugens_butik', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit);
end;
$fn$;

-- ===========================================================================
-- 10. moderation_log: handlinger og maal_type 'ugens_butik'
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_vals text[];
  v_navn text;
  v_kol  text;
  v_nye  text[];
begin
  foreach v_navn in array array['moderation_log_handling_check', 'moderation_log_maal_type_check'] loop
    v_kol := case v_navn when 'moderation_log_handling_check' then 'handling' else 'maal_type' end;
    v_nye := case v_navn when 'moderation_log_handling_check'
               then array['ugens_butik_booket', 'ugens_butik_annulleret', 'ugens_butik_refunderet', 'ugens_butik_pris']
               else array['ugens_butik', 'system'] end;
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = v_navn;
    if v_def is null then continue; end if;
    if (select bool_and(v_def like '%''' || x || '''%') from unnest(v_nye) x) then continue; end if;
    v_vals := array(
      select distinct x from (
        select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
          from regexp_matches(v_def, '''([^'']+)''', 'g') as m
        union select unnest(v_nye)) s
      where x <> '' order by 1);
    execute format('alter table public.moderation_log drop constraint %I', v_navn);
    execute format('alter table public.moderation_log add constraint %I check (%I = any (%L::text[]))', v_navn, v_kol, v_vals);
  end loop;
end $do$;

-- ===========================================================================
-- 11. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.ugens_butik_uge(timestamptz)',
    'public.ugens_butik_uge_start_kl(date)',
    'public.ugens_butik_moms_oere(bigint)',
    'public.ugens_butik_laas_firma(uuid)',
    'public.ugens_butik_laas_uge(date)',
    'public.ugens_butik_firma_spaerret(uuid)',
    'public.ugens_butik_udloeb_uge(date)',
    'public.ugens_butik_koeb_start(uuid, date)',
    'public.ugens_butik_gem_pi(uuid, text, integer)',
    'public.ugens_butik_nulstil_pi(uuid, text)',
    'public.ugens_butik_registrer(text, text, text, bigint, text)',
    'public.ugens_butik_udloeb(uuid, text)',
    'public.ugens_butik_firma_annuller(uuid, uuid, text)',
    'public.ugens_butik_refusion_resultat(uuid, boolean, text, text)',
    'public.ugens_butik_refusion_fejlet(text, text)',
    'public.ugens_butik_registrer_charge_refusion(text, text, boolean)',
    'public.ugens_butik_indsigelse(text, text, text)',
    'public.ugens_butik_cron(integer)',
    'public.ugens_butik_staff_rolle(uuid)',
    'public.ugens_butik_staff_book(uuid, uuid, date, boolean, text)',
    'public.ugens_butik_staff_annuller(uuid, uuid, text, boolean)',
    'public.ugens_butik_saet_pris(uuid, bigint)',
    'public.ugens_butik_admin(uuid)',
    'public.ugens_butik_faktura_tekst(date, integer)',
    'public.ugens_butik_rabat(uuid, date)',
    'public.ugens_butik_pris_for(uuid, date)',
    'public.faktura_planlaeg_ugens_butik(integer)',
    'public.firma_ugens_butik()',
    'public.forside_ugens_butik()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.ugens_butik_forbyd_sletning()', 'public.ugens_butik_laaste_felter()', 'public.ugens_butik_tider()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $do$;
-- Interne byggesten (kaldes kun inde fra RPC'erne): heller ikke service role.
revoke all on function public.ugens_butik_udloeb_uge(date) from service_role;
revoke all on function public.ugens_butik_laas_firma(uuid) from service_role;
revoke all on function public.ugens_butik_laas_uge(date) from service_role;
-- Firmaet selv (auth.uid()).
grant execute on function public.firma_ugens_butik() to authenticated;
-- Offentligt (forsiden).
grant execute on function public.forside_ugens_butik() to anon, authenticated;
