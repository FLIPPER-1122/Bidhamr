-- Returfragt i sager: køberen betaler returfragten med kort, før returkoden
-- udleveres (Filip, 13. okt. 2026 - ROADMAP-BESLUTNINGER, Sager).
--
-- Pengestrømmen:
--   - Køberen betaler en PaymentIntent på BidHamrs PLATFORMSKONTO (ingen
--     on_behalf_of, ingen transfer_data, intet application fee): returfragten
--     er BidHamrs betaling for fragt - ikke sælgerens penge. Kort, MobilePay,
--     Apple Pay og Google Pay (automatic_payment_methods) med tvungen 3D
--     Secure (request_three_d_secure 'any'). Metadata: type 'returfragt',
--     returfragt_id, trade_id, sag_id, bidhamr_db.
--   - Prisen er fragten ud (det køberen betalte - som ved ikke-afhentet pakke,
--     Filip 10. okt. 2026), låst på rækken, når betalingen startes. Under
--     Stripes mindstebeløb (fx en gammel handel uden fragt): auktionens låste
--     pakkeshop-pris, ellers pakkestørrelsens pris.
--   - Returkoden (DAO Shop2Shop, labelfri) må ALDRIG laves, før betalingen er
--     bekræftet: triggeren forsendelser_returfragt_vagt afviser en ny
--     returforsendelse uden en betalt række, og en returforsendelse kan aldrig
--     blive 'oprettet' (labelen gemt), medmindre dens række er betalt.
--   - Lykkes betalingen, men kan labelen ikke laves, prøver systemet igen
--     (spredte forsøg); staff markeres. Kan den slet ikke laves (5 fejl, 48
--     timer, eller sagen kræver ikke længere retur), refunderes returfragten
--     automatisk (fuldt), og køberen får besked. Køberen betaler aldrig to
--     gange: én aktiv række pr. handel (unikt indeks), og kun én PaymentIntent
--     pr. række og forsøg (idempotency key i koden).
--   - Faktura: returfragten er BidHamrs fragt-indtægt og faktureres køberen
--     med moms på fragtkontoen (som fragten ud og returfragten ved ikke-
--     afhentet pakke). Refunderes den, krediteres fakturaen helt.
--     fakturaer.slags 'sag_returfragt' + fakturaer.returfragt_id.
--
-- Ændrer INGEN eksisterende funktioner (ingen md5-drift-tjek nødvendigt).
-- Ændrer på eksisterende tabeller: ny trigger på forsendelser, ny kolonne,
-- CHECK og unikke indeks på fakturaer.
--
-- Idempotent (kan køres igen). Én transaktion: filen køres som én samlet
-- forespørgsel (SQL Editor, db query og migrationsværktøjet), så en fejl
-- ruller alt tilbage. Kun testdatabasen, indtil Filip siger ja.

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.forsendelser') is null or to_regclass('public.sager') is null
     or to_regclass('public.sag_anker') is null or to_regclass('public.fakturaer') is null
     or to_regclass('public.betalinger') is null or to_regclass('public.fragt_pakkestoerrelser') is null then
    raise exception 'Forudsætning mangler: sager, anke, fragt, betalinger og fakturaer skal være kørt først';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'fakturaer' and column_name = 'slags') then
    raise exception 'Forudsætning mangler: fakturaer.slags (20261016030000_ikke_afhentet_pakke.sql)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Tabellen
-- ===========================================================================
create table if not exists public.returfragt_betalinger (
  id                    uuid primary key default gen_random_uuid(),
  trade_id              uuid not null references public.trades(id) on delete restrict,
  sag_id                uuid not null references public.sager(id) on delete restrict,
  koeber_id             uuid not null references public.users(id) on delete restrict,
  -- Handlens betaling (fakturaen hænger på den, som de øvrige fakturaer).
  betaling_id           uuid references public.betalinger(id) on delete restrict,
  -- Låst pris i øre (inkl. moms) og pakkestørrelse, da betalingen startede.
  beloeb_oere           bigint not null,
  pakkestoerrelse       text,
  valuta                text not null default 'dkk',
  status                text not null default 'afventer',
  stripe_payment_intent_id  text,
  -- Kasserede PaymentIntents (annulleret hos Stripe): betales en alligevel,
  -- er det en dobbeltbetaling, som refunderes.
  tidligere_payment_intents text[] not null default '{}',
  pi_forsoeg            integer not null default 0,
  stripe_charge_id      text,
  modtaget_oere         bigint,
  sidste_fejl           text,
  -- Køberens afsenderadresse og mobil til labelen (navn, adresse, postnummer,
  -- by, telefon). Kun køberen og service role kan læse den.
  afsender              jsonb,
  oprettet_kl           timestamptz not null default now(),
  betalt_kl             timestamptz,
  -- Labelen (returkoden): seneste returforsendelse og hvornår den var klar.
  forsendelse_id        uuid references public.forsendelser(id) on delete restrict,
  label_klar_kl         timestamptz,
  label_forsoeg         integer not null default 0,
  label_fejl_antal      integer not null default 0,
  label_naeste_kl       timestamptz,
  -- Fejlen, køberen ser (dansk tekst fra fragtfirmaet), og den interne.
  label_brugerfejl      text,
  label_intern_fejl     text,
  -- Refusion (kun hele returfragten).
  refusion_aarsag       text,
  refusion_anmodet_kl   timestamptz,
  refusion_forsoeg      integer not null default 0,
  refusion_naeste_kl    timestamptz,
  refusion_sidste_fejl  text,
  stripe_refund_id      text,
  refunderet_kl         timestamptz,
  annulleret_kl         timestamptz,
  -- Staff (vises via returforsendelsen under Fragt, og i drift).
  kraever_opmaerksomhed boolean not null default false,
  opmaerksomhed_tekst   text,
  synket_kl             timestamptz,
  opdateret             timestamptz not null default now(),
  constraint returfragt_status_check check (
    status in ('afventer', 'behandles', 'betalt', 'refunderes', 'refunderet', 'annulleret')),
  -- Stripes mindstebeløb (DKK 2,50) med margin; højst 10.000 kr.
  constraint returfragt_beloeb_check check (beloeb_oere between 300 and 1000000),
  constraint returfragt_valuta_check check (valuta = 'dkk'),
  constraint returfragt_refusion_aarsag_check check (
    refusion_aarsag is null or refusion_aarsag in ('label_umulig', 'ikke_noedvendig', 'beloeb', 'staff', 'ekstern')),
  constraint returfragt_betalt_check check (
    status not in ('betalt', 'refunderes', 'refunderet') or betalt_kl is not null),
  constraint returfragt_refunderet_check check (status <> 'refunderet' or refunderet_kl is not null),
  constraint returfragt_tekst_laengde check (
    coalesce(char_length(opmaerksomhed_tekst), 0) <= 4000 and coalesce(char_length(sidste_fejl), 0) <= 500
    and coalesce(char_length(label_brugerfejl), 0) <= 500 and coalesce(char_length(label_intern_fejl), 0) <= 500
    and coalesce(char_length(refusion_sidste_fejl), 0) <= 500)
);

comment on table public.returfragt_betalinger is
  'Returfragt i sager (Filip, 13. okt. 2026): køberen betaler returfragten (= fragten ud) til BidHamrs platformskonto, før returkoden laves. Én aktiv række pr. handel. Skrives kun af security definer-funktionerne (service role). Køberen kan læse sin egen række. Handelsdata - slettes aldrig.';

-- Én aktiv (ikke afsluttet) række pr. handel: køberen kan aldrig betale to gange.
create unique index if not exists returfragt_en_aktiv
  on public.returfragt_betalinger (trade_id)
  where status in ('afventer', 'behandles', 'betalt', 'refunderes');
create unique index if not exists returfragt_pi
  on public.returfragt_betalinger (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists returfragt_charge on public.returfragt_betalinger (stripe_charge_id) where stripe_charge_id is not null;
create index if not exists returfragt_koeber on public.returfragt_betalinger (koeber_id);
create index if not exists returfragt_aaben on public.returfragt_betalinger (status)
  where status in ('afventer', 'behandles', 'betalt', 'refunderes');
create index if not exists returfragt_tidligere on public.returfragt_betalinger using gin (tidligere_payment_intents);

-- Handelsdata slettes aldrig (bogføringsloven).
create or replace function public.returfragt_forbyd_sletning()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  raise exception 'Handelsdata må ikke slettes (returfragt)';
end;
$fn$;
revoke all on function public.returfragt_forbyd_sletning() from public, anon, authenticated;
drop trigger if exists returfragt_forbyd_sletning on public.returfragt_betalinger;
create trigger returfragt_forbyd_sletning before delete on public.returfragt_betalinger
  for each row execute function public.returfragt_forbyd_sletning();

-- Beløb og parter er låst.
create or replace function public.returfragt_laaste_felter()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.id <> old.id or new.trade_id <> old.trade_id or new.sag_id <> old.sag_id
     or new.koeber_id <> old.koeber_id or new.beloeb_oere <> old.beloeb_oere
     or new.betaling_id is distinct from old.betaling_id or new.valuta <> old.valuta
     or new.oprettet_kl <> old.oprettet_kl then
    raise exception 'Returfragtens beløb og parter kan ikke ændres';
  end if;
  new.opdateret := now();
  return new;
end;
$fn$;
revoke all on function public.returfragt_laaste_felter() from public, anon, authenticated;
drop trigger if exists returfragt_laaste_felter on public.returfragt_betalinger;
create trigger returfragt_laaste_felter before update on public.returfragt_betalinger
  for each row execute function public.returfragt_laaste_felter();

-- RLS: køberen læser kun sin egen række. Ingen skrivning udefra - heller ikke
-- service role direkte (kun via funktionerne nedenfor).
alter table public.returfragt_betalinger enable row level security;
drop policy if exists returfragt_select_egen on public.returfragt_betalinger;
create policy returfragt_select_egen on public.returfragt_betalinger
  for select to authenticated using (koeber_id = (select auth.uid()));
revoke all on public.returfragt_betalinger from public, anon, authenticated, service_role;
grant select on public.returfragt_betalinger to service_role;
-- Køberen: kun de felter, hjemmesiden og appen viser (ikke interne fejl,
-- Stripe-id'er, staff-noter eller forsøgstællere).
grant select (id, trade_id, status, beloeb_oere, afsender, betalt_kl, label_klar_kl, refunderet_kl, refusion_aarsag)
  on public.returfragt_betalinger to authenticated;

-- Genskab check'en på refusion_aarsag (tabellen kan være oprettet af en
-- tidligere udgave af filen på testdatabasen).
alter table public.returfragt_betalinger drop constraint if exists returfragt_refusion_aarsag_check;
alter table public.returfragt_betalinger add constraint returfragt_refusion_aarsag_check check (
  refusion_aarsag is null or refusion_aarsag in ('label_umulig', 'ikke_noedvendig', 'beloeb', 'staff', 'ekstern'));

-- ===========================================================================
-- 2. Sagen: må køberen sende varen retur nu?
-- ===========================================================================
-- Samme regel som handelssiden (returVenterTilKl i src/app/actions/sager.ts):
-- sagen afventer retur, returen er ikke registreret, ingen anke venter, og
-- sælgerens ankefrist er udløbet (eller en anke er afgjort).
-- {kode: 'ok' | 'ingen_sag' | 'ingen_retur' | 'afleveret' | 'anke' | 'ankefrist', sag_id?, til_kl?}
create or replace function public.returfragt_sag(p_trade uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_id       uuid;
  v_status   text;
  v_retur    boolean;
  v_afl      timestamptz;
  v_penge    timestamptz;
  v_anke_id  uuid;
  v_anke     text;
begin
  select s.id, s.status, s.retur_kraeves, s.retur_afleveret_kl, s.penge_flyttes_efter_kl
    into v_id, v_status, v_retur, v_afl, v_penge
    from public.sager s
   where s.trade_id = p_trade
   order by s.oprettet_kl desc
   limit 1;
  if v_id is null then return jsonb_build_object('kode', 'ingen_sag'); end if;
  if v_status <> 'afventer_retur' or not v_retur then
    return jsonb_build_object('kode', 'ingen_retur', 'sag_id', v_id);
  end if;
  if v_afl is not null then return jsonb_build_object('kode', 'afleveret', 'sag_id', v_id); end if;
  select a.id, a.status into v_anke_id, v_anke
    from public.sag_anker a where a.sag_id = v_id order by a.indgivet_kl desc limit 1;
  if v_anke = 'afventer' then return jsonb_build_object('kode', 'anke', 'sag_id', v_id); end if;
  if v_anke_id is null and v_penge is not null and v_penge > now() then
    return jsonb_build_object('kode', 'ankefrist', 'sag_id', v_id, 'til_kl', v_penge);
  end if;
  return jsonb_build_object('kode', 'ok', 'sag_id', v_id);
end;
$fn$;

-- ===========================================================================
-- 3. Start betalingen (låser prisen)
-- ===========================================================================
-- p_koeber SKAL være verificeret af serveren (auth). Svar:
--   {kode: 'ok', id, beloeb_oere, pi: null, pi_forsoeg}        ny række
--   {kode: 'findes', id, beloeb_oere, pi, pi_forsoeg, status}   ubetalt række findes
--   {kode: 'betalt' | 'refunderes', id, beloeb_oere}           allerede betalt
--   {kode: 'ugyldig' | 'ikke_fundet' | 'ingen_sag' | 'ingen_retur' | 'afleveret' |
--          'anke' | 'ankefrist' | 'mangler_adresse' | 'ingen_betaling' | 'ingen_pris'}
create or replace function public.returfragt_start(p_trade uuid, p_koeber uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  t        record;
  rf       record;
  v_sag    jsonb;
  v_bet    uuid;
  v_fragt  bigint;
  v_stoerrelse text;
  v_shop   bigint;
  v_pris   bigint;
  v_id     uuid;
begin
  if p_trade is null or p_koeber is null then return jsonb_build_object('kode', 'ugyldig'); end if;
  select tr.id, tr.buyer_id, tr.auction_id, tr.afhentning into t
    from public.trades tr where tr.id = p_trade for update;
  if t.id is null or t.buyer_id is distinct from p_koeber then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'ingen_retur'); end if;

  select r.id, r.status, r.beloeb_oere, r.stripe_payment_intent_id, r.pi_forsoeg into rf
    from public.returfragt_betalinger r
   where r.trade_id = p_trade and r.status in ('afventer', 'behandles', 'betalt', 'refunderes')
   limit 1
   for update;
  if rf.id is not null then
    if rf.status in ('betalt', 'refunderes') then
      return jsonb_build_object('kode', rf.status, 'id', rf.id, 'beloeb_oere', rf.beloeb_oere);
    end if;
    -- Ubetalt række: kun videre, hvis sagen stadig kræver retur nu (ellers
    -- annullerer cron'en PaymentIntenten).
    v_sag := public.returfragt_sag(p_trade);
    if v_sag->>'kode' <> 'ok' and rf.status = 'afventer' then
      return jsonb_build_object('kode', v_sag->>'kode', 'til_kl', v_sag->'til_kl');
    end if;
    return jsonb_build_object('kode', 'findes', 'id', rf.id, 'beloeb_oere', rf.beloeb_oere,
                              'pi', rf.stripe_payment_intent_id, 'pi_forsoeg', rf.pi_forsoeg, 'status', rf.status);
  end if;

  v_sag := public.returfragt_sag(p_trade);
  if v_sag->>'kode' <> 'ok' then
    return jsonb_build_object('kode', v_sag->>'kode', 'til_kl', v_sag->'til_kl');
  end if;

  -- Sælgerens adresse (modtager) står på den udgående label.
  if not exists (select 1 from public.forsendelser f
                  where f.trade_id = p_trade and f.type = 'udgaaende' and f.afsender is not null) then
    return jsonb_build_object('kode', 'mangler_adresse');
  end if;

  -- Prisen: fragten ud, som køberen betalte (handlens betaling).
  select b.id, b.fragt_oere into v_bet, v_fragt
    from public.betalinger b
   where b.trade_id = p_trade and b.betalt_kl is not null
   order by b.betalt_kl desc
   limit 1;
  if v_bet is null then return jsonb_build_object('kode', 'ingen_betaling'); end if;
  select a.pakkestoerrelse, a.fragt_pakkeshop_oere into v_stoerrelse, v_shop
    from public.auctions a where a.id = t.auction_id;
  v_pris := v_fragt;
  if v_pris is null or v_pris < 300 then v_pris := v_shop; end if;
  if v_pris is null or v_pris < 300 then
    select p.pakkeshop_oere into v_pris from public.fragt_pakkestoerrelser p
     where p.kode = coalesce(v_stoerrelse, 'mellem');
  end if;
  if v_pris is null or v_pris < 300 or v_pris > 1000000 then
    return jsonb_build_object('kode', 'ingen_pris');
  end if;

  insert into public.returfragt_betalinger (trade_id, sag_id, koeber_id, betaling_id, beloeb_oere, pakkestoerrelse)
  values (p_trade, (v_sag->>'sag_id')::uuid, p_koeber, v_bet, v_pris, v_stoerrelse)
  returning id into v_id;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'beloeb_oere', v_pris, 'pi', null, 'pi_forsoeg', 0);
end;
$fn$;

-- Køberens afsenderadresse (valideret af serveren). Kan rettes, indtil
-- returkoden er klar (fx når fragtfirmaet afviste adressen).
-- 'ok' | 'ikke_fundet' | 'laast' | 'ugyldig'
create or replace function public.returfragt_gem_afsender(p_id uuid, p_koeber uuid, p_afsender jsonb)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
begin
  if p_id is null or p_koeber is null or p_afsender is null or jsonb_typeof(p_afsender) <> 'object'
     or length(p_afsender::text) > 2000 then
    return 'ugyldig';
  end if;
  select r.id, r.koeber_id, r.status, r.label_klar_kl into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null or rf.koeber_id <> p_koeber then return 'ikke_fundet'; end if;
  if rf.status not in ('afventer', 'behandles', 'betalt') or rf.label_klar_kl is not null then
    return 'laast';
  end if;
  update public.returfragt_betalinger
     set afsender = jsonb_build_object(
           'navn', left(p_afsender->>'navn', 100), 'adresse', left(p_afsender->>'adresse', 200),
           'postnummer', left(p_afsender->>'postnummer', 10), 'by', left(p_afsender->>'by', 80),
           'telefon', left(p_afsender->>'telefon', 20))
   where id = p_id;
  return 'ok';
end;
$fn$;

-- PaymentIntenten gemmes kun, hvis rækken stadig er ubetalt med samme forsøg.
create or replace function public.returfragt_gem_pi(p_id uuid, p_pi text, p_forsoeg integer)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  if p_pi is null or p_pi !~ '^pi_[A-Za-z0-9_]{1,250}$' then return false; end if;
  update public.returfragt_betalinger
     set stripe_payment_intent_id = p_pi
   where id = p_id and stripe_payment_intent_id is null and pi_forsoeg = p_forsoeg and status = 'afventer';
  return found;
end;
$fn$;

-- En PaymentIntent, der er annulleret hos Stripe, kasseres (pi_forsoeg + 1).
create or replace function public.returfragt_nulstil_pi(p_id uuid, p_pi text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.returfragt_betalinger
     set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
         stripe_payment_intent_id = null,
         pi_forsoeg = pi_forsoeg + 1
   where id = p_id and stripe_payment_intent_id = p_pi and status = 'afventer';
  return found;
end;
$fn$;

-- ===========================================================================
-- 4. Spejl fra Stripe (webhooken og cron'en)
-- ===========================================================================
-- p_status = PaymentIntentens status hos Stripe. Svar {kode, id?}:
--   'betalt'           betalingen er registreret nu (labelen kan laves)
--   'allerede'         var allerede registreret
--   'beloeb_afviger'   betalt med et andet beløb: registreret og claimet til refusion
--   'kasseret'         en kasseret PaymentIntent er betalt: refunderes af koden
--   'behandles' | 'afventer' | 'nulstillet' | 'uaendret' | 'ukendt'
create or replace function public.returfragt_registrer(
  p_pi text, p_status text, p_charge text, p_beloeb bigint, p_fejl text)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
  v_k uuid;
begin
  if p_pi is null then return jsonb_build_object('kode', 'ukendt'); end if;
  select r.id, r.status, r.beloeb_oere into rf
    from public.returfragt_betalinger r where r.stripe_payment_intent_id = p_pi for update;
  if rf.id is null then
    select r.id into v_k from public.returfragt_betalinger r where p_pi = any(r.tidligere_payment_intents) limit 1;
    if v_k is not null then
      if p_status = 'succeeded' then return jsonb_build_object('kode', 'kasseret', 'id', v_k); end if;
      return jsonb_build_object('kode', 'uaendret', 'id', v_k);
    end if;
    return jsonb_build_object('kode', 'ukendt');
  end if;

  if p_status = 'succeeded' then
    if rf.status in ('betalt', 'refunderes', 'refunderet') then
      return jsonb_build_object('kode', 'allerede', 'id', rf.id);
    end if;
    update public.returfragt_betalinger
       set status = 'betalt', betalt_kl = coalesce(betalt_kl, now()), stripe_charge_id = coalesce(p_charge, stripe_charge_id),
           modtaget_oere = p_beloeb, sidste_fejl = null, annulleret_kl = null
     where id = rf.id;
    if p_beloeb is distinct from rf.beloeb_oere then
      update public.returfragt_betalinger
         set status = 'refunderes', refusion_aarsag = 'beloeb', refusion_anmodet_kl = now(),
             kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
               'Returfragten er betalt med et andet beløb end prisen - den refunderes automatisk.'), 4000)
       where id = rf.id;
      return jsonb_build_object('kode', 'beloeb_afviger', 'id', rf.id);
    end if;
    return jsonb_build_object('kode', 'betalt', 'id', rf.id);
  elsif p_status = 'processing' then
    update public.returfragt_betalinger set status = 'behandles' where id = rf.id and status = 'afventer';
    return jsonb_build_object('kode', case when found then 'behandles' else 'uaendret' end, 'id', rf.id);
  elsif p_status = 'requires_payment_method' then
    update public.returfragt_betalinger set status = 'afventer', sidste_fejl = left(p_fejl, 500)
     where id = rf.id and status in ('afventer', 'behandles');
    return jsonb_build_object('kode', case when found then 'afventer' else 'uaendret' end, 'id', rf.id);
  elsif p_status = 'canceled' then
    if rf.status = 'afventer' then
      update public.returfragt_betalinger
         set tidligere_payment_intents = array_append(tidligere_payment_intents, p_pi),
             stripe_payment_intent_id = null, pi_forsoeg = pi_forsoeg + 1
       where id = rf.id;
      return jsonb_build_object('kode', 'nulstillet', 'id', rf.id);
    end if;
    return jsonb_build_object('kode', 'uaendret', 'id', rf.id);
  end if;
  return jsonb_build_object('kode', 'uaendret', 'id', rf.id);
end;
$fn$;

-- Ubetalt række, hvor sagen ikke længere kræver retur: annulleret (efter at
-- PaymentIntenten er annulleret hos Stripe).
create or replace function public.returfragt_annuller(p_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.returfragt_betalinger
     set status = 'annulleret', annulleret_kl = now(),
         tidligere_payment_intents = case when stripe_payment_intent_id is null then tidligere_payment_intents
                                          else array_append(tidligere_payment_intents, stripe_payment_intent_id) end,
         stripe_payment_intent_id = null
   where id = p_id and status = 'afventer';
  return found;
end;
$fn$;

-- ===========================================================================
-- 5. Labelen: kun efter betaling (trigger på forsendelser)
-- ===========================================================================
-- INSERT af en returforsendelse kræver en betalt række uden en klar label,
-- hvis seneste label ikke er aktiv (fejlet/annulleret). Rækken får
-- forsendelsens id. Højst 10 forsøg pr. betaling (derefter staff).
-- UPDATE fra 'opretter' til en aktiv status (labelen er gemt) kræver, at
-- rækken STADIG er betalt (fx ikke refunderet imens) - og sætter
-- label_klar_kl. Gælder alle veje (også staffs "tilknyt").
create or replace function public.forsendelser_returfragt_vagt()
returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
begin
  -- En forsendelse kan aldrig skifte til eller fra retur (så vagten ikke kan
  -- omgås ved at lave en udgående om til en returlabel).
  if tg_op = 'UPDATE' and new.type is distinct from old.type and 'retur' in (new.type, old.type) then
    raise exception 'returfragt_type: en forsendelse kan ikke skifte type til eller fra retur' using errcode = 'BHR04';
  end if;
  if new.type <> 'retur' then return new; end if;
  if tg_op = 'INSERT' then
    select r.id, r.forsendelse_id, r.label_forsoeg into rf
      from public.returfragt_betalinger r
     where r.trade_id = new.trade_id and r.status = 'betalt' and r.label_klar_kl is null
     for update;
    if rf.id is null then
      raise exception 'returfragt_ikke_betalt: returkoden kan først laves, når returfragten er betalt'
        using errcode = 'BHR01';
    end if;
    if rf.forsendelse_id is not null and exists (
         select 1 from public.forsendelser f
          where f.id = rf.forsendelse_id and f.status not in ('fejlet', 'annulleret')) then
      raise exception 'returfragt_label_findes: der er allerede en returlabel i gang' using errcode = 'BHR02';
    end if;
    if rf.label_forsoeg >= 10 then
      raise exception 'returfragt_for_mange: for mange forsøg - BidHamr skal se på returen' using errcode = 'BHR03';
    end if;
    -- Tilknytningen sker i AFTER-triggeren (forsendelsen skal findes først).
    return new;
  end if;

  -- UPDATE
  if old.status in ('opretter', 'fejlet', 'annulleret') and new.status not in ('opretter', 'fejlet', 'annulleret') then
    select r.id into rf from public.returfragt_betalinger r
     where r.forsendelse_id = new.id and r.status = 'betalt'
     for update;
    if rf.id is null then
      raise exception 'returfragt_ikke_betalt: returlabelen kan ikke gemmes uden betalt returfragt'
        using errcode = 'BHR01';
    end if;
    update public.returfragt_betalinger
       set label_klar_kl = coalesce(label_klar_kl, now()), label_brugerfejl = null, label_naeste_kl = null
     where id = rf.id;
  end if;
  -- Returkoden er annulleret: køberen kan få en ny kode uden at betale igen
  -- (og staff kan refundere returfragten).
  if new.status = 'annulleret' and old.status <> 'annulleret' then
    update public.returfragt_betalinger
       set label_klar_kl = null, label_naeste_kl = null
     where forsendelse_id = new.id and status = 'betalt';
  end if;
  return new;
end;
$fn$;
revoke all on function public.forsendelser_returfragt_vagt() from public, anon, authenticated;
drop trigger if exists forsendelser_returfragt_vagt on public.forsendelser;
create trigger forsendelser_returfragt_vagt before insert or update of status, type on public.forsendelser
  for each row execute function public.forsendelser_returfragt_vagt();

-- Efter INSERT (vagten har godkendt): den betalte række får forsendelsens id.
create or replace function public.forsendelser_returfragt_tilknyt()
returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  if new.type <> 'retur' then return null; end if;
  update public.returfragt_betalinger
     set forsendelse_id = new.id, label_forsoeg = label_forsoeg + 1
   where trade_id = new.trade_id and status = 'betalt' and label_klar_kl is null;
  if not found then
    raise exception 'returfragt_ikke_betalt: returkoden kan først laves, når returfragten er betalt'
      using errcode = 'BHR01';
  end if;
  return null;
end;
$fn$;
revoke all on function public.forsendelser_returfragt_tilknyt() from public, anon, authenticated;
-- (triggerfunktion - ingen kan kalde den direkte)
drop trigger if exists forsendelser_returfragt_tilknyt on public.forsendelser;
create trigger forsendelser_returfragt_tilknyt after insert on public.forsendelser
  for each row execute function public.forsendelser_returfragt_tilknyt();

-- Resultat af et label-forsøg, der IKKE gav en label. p_brugerfejl: den danske
-- tekst til køberen (fx adressen blev afvist), p_intern: til staff/drift.
-- Spredte forsøg: 5, 10, 20, 40, 80 min. Svar: antal fejl i alt.
create or replace function public.returfragt_label_fejlet(p_id uuid, p_brugerfejl text, p_intern text)
returns integer
language plpgsql security definer set search_path = '' as $fn$
declare
  n integer;
begin
  update public.returfragt_betalinger
     set label_fejl_antal = label_fejl_antal + 1,
         label_brugerfejl = left(p_brugerfejl, 500),
         label_intern_fejl = left(p_intern, 500),
         label_naeste_kl = now() + (interval '5 minutes' * power(2, least(label_fejl_antal, 4)))
   where id = p_id and status = 'betalt' and label_klar_kl is null
   returning label_fejl_antal into n;
  return coalesce(n, 0);
end;
$fn$;

-- Køberens adresse mangler: ingen fejl hos fragtfirmaet, så det tæller ikke
-- som et forsøg (kun 48-timersgrænsen gælder). Nyt forsøg om 15 min.
create or replace function public.returfragt_label_venter(p_id uuid, p_brugerfejl text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.returfragt_betalinger
     set label_brugerfejl = left(p_brugerfejl, 500), label_naeste_kl = now() + interval '15 minutes'
   where id = p_id and status = 'betalt' and label_klar_kl is null;
  return found;
end;
$fn$;

-- Staff-markering (vises på returforsendelsen under Fragt -> "Kræver handling").
create or replace function public.returfragt_marker(p_id uuid, p_note text)
returns boolean
language plpgsql security definer set search_path = '' as $fn$
declare
  v_f uuid;
begin
  if nullif(btrim(coalesce(p_note, '')), '') is null then return false; end if;
  update public.returfragt_betalinger
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst, left(p_note, 500)), 4000)
   where id = p_id
   returning forsendelse_id into v_f;
  if not found then return false; end if;
  if v_f is not null then
    update public.forsendelser
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst, left(p_note, 500)), 2000)
     where id = v_f;
    return true;
  end if;
  -- Ingen forsendelse at hænge markeringen på: koden giver en drift-alarm.
  return false;
end;
$fn$;

-- ===========================================================================
-- 6. Refusion (hele returfragten)
-- ===========================================================================
-- 'ok' (claimet: status 'refunderes') | 'label_findes' (der er en returkode -
-- staff afgør) | 'i_gang' (et label-forsøg kører) | 'forkert_status' | 'ugyldig'
create or replace function public.returfragt_refusion_claim(p_id uuid, p_aarsag text)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
  f  record;
begin
  if p_aarsag is null or p_aarsag not in ('label_umulig', 'ikke_noedvendig', 'staff') then return 'ugyldig'; end if;
  select r.id, r.status, r.label_klar_kl, r.forsendelse_id into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null or rf.status <> 'betalt' then return 'forkert_status'; end if;
  if rf.label_klar_kl is not null then return 'label_findes'; end if;
  if rf.forsendelse_id is not null then
    select fo.id, fo.status, fo.forsoegt_kl, fo.oprettet_kl, fo.ukendt_udfald_kl into f
      from public.forsendelser fo where fo.id = rf.forsendelse_id for update;
    if f.status not in ('opretter', 'fejlet', 'annulleret') then return 'label_findes'; end if;
    if f.status = 'opretter' then
      -- Et forsøg kan stadig være i gang hos fragtfirmaet.
      if f.ukendt_udfald_kl is null and coalesce(f.forsoegt_kl, f.oprettet_kl) > now() - interval '10 minutes' then
        return 'i_gang';
      end if;
      -- Opgivet: koden er aldrig vist køberen (en evt. forældreløs pakke hos
      -- DAO indleveres aldrig og faktureres ikke).
      update public.forsendelser
         set status = 'fejlet', fejl = left(concat_ws(' - ', fejl, 'Returfragten er refunderet'), 500)
       where id = f.id;
    end if;
  end if;
  update public.returfragt_betalinger
     set status = 'refunderes', refusion_aarsag = p_aarsag, refusion_anmodet_kl = now(),
         refusion_naeste_kl = null
   where id = p_id;
  return 'ok';
end;
$fn$;

-- Resultat af et refusionsforsøg hos Stripe. p_ok: refusionen er oprettet
-- (succeeded/pending) med id p_refund. Ellers spredte forsøg (5 min ... 6
-- t); efter 5 fejl stopper det automatiske, og staff markeres.
-- 'refunderet' | 'allerede' | 'igen' | 'opgivet' | 'forkert_status'
create or replace function public.returfragt_refusion_resultat(p_id uuid, p_ok boolean, p_refund text, p_fejl text)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
begin
  select r.id, r.status, r.refusion_forsoeg into rf
    from public.returfragt_betalinger r where r.id = p_id for update;
  if rf.id is null then return 'forkert_status'; end if;
  if rf.status = 'refunderet' then return 'allerede'; end if;
  if rf.status <> 'refunderes' then return 'forkert_status'; end if;
  if p_ok then
    update public.returfragt_betalinger
       set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = p_refund, refusion_sidste_fejl = null
     where id = p_id;
    return 'refunderet';
  end if;
  update public.returfragt_betalinger
     set refusion_forsoeg = refusion_forsoeg + 1,
         refusion_sidste_fejl = left(p_fejl, 500),
         refusion_naeste_kl = now() + least(interval '6 hours', interval '5 minutes' * power(2, least(refusion_forsoeg, 7))),
         kraever_opmaerksomhed = kraever_opmaerksomhed or refusion_forsoeg + 1 >= 5
   where id = p_id;
  return case when rf.refusion_forsoeg + 1 >= 5 then 'opgivet' else 'igen' end;
end;
$fn$;

-- En refusion, der bagefter fejler hos Stripe (refund.failed): tilbage til
-- 'refunderes', så cron'en prøver igen. Har køberen allerede betalt en ny
-- returfragt på handlen, kan rækken ikke genåbnes (én aktiv pr. handel) -
-- så markeres den til staff (refundér manuelt).
-- 'genaabnet' | 'markeret' | 'uaendret'
create or replace function public.returfragt_refusion_fejlet(p_refund text, p_fejl text)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
begin
  select r.id, r.trade_id into rf from public.returfragt_betalinger r
   where r.stripe_refund_id = p_refund and r.status = 'refunderet'
   for update;
  if rf.id is null then return 'uaendret'; end if;
  if exists (select 1 from public.returfragt_betalinger x
              where x.trade_id = rf.trade_id and x.id <> rf.id
                and x.status in ('afventer', 'behandles', 'betalt', 'refunderes')) then
    update public.returfragt_betalinger
       set refusion_sidste_fejl = left(p_fejl, 500), kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
             'Refusionen af returfragten fejlede hos Stripe efter at være gennemført - refundér manuelt i Stripe.'), 4000)
     where id = rf.id;
    return 'markeret';
  end if;
  -- Nyt forsøg = ny idempotency key (ellers giver Stripe den fejlede tilbage).
  update public.returfragt_betalinger
     set status = 'refunderes', refunderet_kl = null, stripe_refund_id = null,
         refusion_forsoeg = refusion_forsoeg + 1,
         refusion_sidste_fejl = left(p_fejl, 500), refusion_naeste_kl = now() + interval '5 minutes'
   where id = rf.id;
  return 'genaabnet';
end;
$fn$;

-- charge.refunded på returfragtens charge (fx en refusion i Stripe-
-- dashboardet, eller vores egen, før resultatet er gemt). p_fuld: chargen er
-- helt refunderet. Fuld: rækken bliver 'refunderet' (en returkode kan
-- derefter hverken laves eller gemmes - vagten kræver 'betalt'); var det ikke
-- BidHamrs egen refusion, markeres staff. Delvis: kun staff.
-- 'refunderet' | 'allerede' | 'markeret' | 'ukendt'
create or replace function public.returfragt_registrer_charge_refusion(p_charge text, p_refund text, p_fuld boolean)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  rf record;
  v_note text;
begin
  select r.id, r.status, r.label_klar_kl into rf
    from public.returfragt_betalinger r where r.stripe_charge_id = p_charge for update;
  if rf.id is null then return 'ukendt'; end if;
  if rf.status = 'refunderet' then return 'allerede'; end if;
  if rf.status not in ('betalt', 'refunderes') then return 'ukendt'; end if;
  if not p_fuld then
    update public.returfragt_betalinger
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = left(concat_ws(E'\n', opmaerksomhed_tekst,
             'Returfragten er delvist refunderet hos Stripe uden om BidHamr - kontrollér den.'), 4000)
     where id = rf.id;
    return 'markeret';
  end if;
  if rf.status = 'betalt' then
    v_note := case when rf.label_klar_kl is not null
                   then 'Returfragten er refunderet hos Stripe uden om BidHamr, men køberen har en returkode - vurdér returen.'
                   else 'Returfragten er refunderet hos Stripe uden om BidHamr - der laves ingen returkode.' end;
  end if;
  update public.returfragt_betalinger
     set status = 'refunderet', refunderet_kl = now(), stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_aarsag = coalesce(refusion_aarsag, 'ekstern'), refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         kraever_opmaerksomhed = kraever_opmaerksomhed or v_note is not null,
         opmaerksomhed_tekst = case when v_note is null then opmaerksomhed_tekst
                                    else left(concat_ws(E'\n', opmaerksomhed_tekst, v_note), 4000) end
   where id = rf.id;
  return 'refunderet';
end;
$fn$;

-- Staff: "Refundér returfragt" (Admin -> sagen). Kun admin og chef, ikke
-- inhabile (part i handlen eller har handlet med en af parterne). Kun når
-- der ikke er en aktiv returkode (en annulleret kode er ok). Claimer
-- refusionen og logger i moderation_log i samme transaktion; selve
-- refusionen hos Stripe laver serveren bagefter (refunderReturfragt), og
-- cron'en prøver igen, hvis den fejler.
-- 'ok' | 'ingen_adgang' | 'inhabil' | 'begrundelse_mangler' | 'ikke_fundet' |
-- 'forkert_status' | 'label_findes' | 'i_gang'
create or replace function public.returfragt_staff_refusion(p_staff uuid, p_id uuid, p_begrundelse text)
returns text
language plpgsql security definer set search_path = '' as $fn$
declare
  v_grund text := nullif(btrim(coalesce(p_begrundelse, '')), '');
  rf record;
  t  record;
  v_kode text;
begin
  if p_staff is null or not public.staff_chat_har_rolle(p_staff, 'admin') then return 'ingen_adgang'; end if;
  if v_grund is null then return 'begrundelse_mangler'; end if;
  select r.id, r.trade_id, r.koeber_id, r.status into rf from public.returfragt_betalinger r where r.id = p_id;
  if rf.id is null then return 'ikke_fundet'; end if;
  select tr.buyer_id, tr.seller_id into t from public.trades tr where tr.id = rf.trade_id;
  if public.penge_inhabil(p_staff, t.buyer_id, t.seller_id) then return 'inhabil'; end if;
  v_kode := public.returfragt_refusion_claim(p_id, 'staff');
  if v_kode <> 'ok' then return v_kode; end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'returfragt_refunderet', 'handel', rf.trade_id, rf.koeber_id, left(v_grund, 1000));
  return 'ok';
end;
$fn$;

-- ===========================================================================
-- 7. Cron: hvad skal gøres?
-- ===========================================================================
-- Rækker, der kræver handling (claimet med synket_kl / label_naeste_kl /
-- refusion_naeste_kl, så to kørsler ikke tager den samme):
--   'synk'      ubetalt med PaymentIntent i over 15 min (mistet webhook)
--   'annuller'  ubetalt, men sagen kræver ikke længere retur
--   'label'     betalt uden returkode - prøv igen
--   'refunder'  betalt uden returkode, og den kan ikke laves (5 fejl, 48 t,
--               eller sagen kræver ikke længere retur)
--   'refusion'  refusionen er claimet, men ikke gennemført
drop function if exists public.returfragt_cron(integer);
create or replace function public.returfragt_cron(p_graense integer default 20, p_labels integer default 2)
returns table (id uuid, handling text)
language plpgsql security definer set search_path = '' as $fn$
#variable_conflict use_column
declare
  v_graense integer := least(greatest(coalesce(p_graense, 20), 1), 100);
  v_labels  integer := least(greatest(coalesce(p_labels, 2), 0), 20);
begin
  return query
  with k as (
    select r.id,
           case
             when r.status = 'refunderes' then 'refusion'
             when r.status = 'betalt' and r.label_klar_kl is null
                  and (r.label_fejl_antal >= 5 or r.betalt_kl <= now() - interval '48 hours'
                       or public.returfragt_sag(r.trade_id)->>'kode' <> 'ok') then 'refunder'
             when r.status = 'betalt' and r.label_klar_kl is null then 'label'
             when r.status = 'afventer' and public.returfragt_sag(r.trade_id)->>'kode' <> 'ok' then 'annuller'
             when r.status in ('afventer', 'behandles') and r.stripe_payment_intent_id is not null then 'synk'
           end as handling,
           -- Penge og returkoder før synk af opgivne betalinger.
           case when r.status in ('refunderes', 'betalt') then 0 else 1 end as prio,
           coalesce(r.label_naeste_kl, r.refusion_naeste_kl, r.synket_kl, r.oprettet_kl) as kl
      from public.returfragt_betalinger r
     where r.status in ('afventer', 'behandles', 'betalt', 'refunderes')
       and (
         (r.status = 'refunderes' and r.refusion_forsoeg < 5
          and (r.refusion_naeste_kl is null or r.refusion_naeste_kl <= now())
          and r.refusion_anmodet_kl <= now() - interval '2 minutes')
         or (r.status = 'betalt' and r.label_klar_kl is null
             and (r.label_naeste_kl is null or r.label_naeste_kl <= now())
             and r.betalt_kl <= now() - interval '2 minutes')
         or (r.status in ('afventer', 'behandles')
             and r.opdateret <= now() - interval '15 minutes'
             -- Opgivne betalinger: hvert 15. minut det første døgn, derefter hver 6. time.
             and (r.synket_kl is null
                  or r.synket_kl <= now() - case when r.oprettet_kl > now() - interval '24 hours'
                                                 then interval '15 minutes' else interval '6 hours' end)
             -- Uden PaymentIntent er der intet at synke (køberen har kun
             -- åbnet betalingen) - kun annullering, hvis sagen er ændret.
             and (r.stripe_payment_intent_id is not null
                  or (r.status = 'afventer' and public.returfragt_sag(r.trade_id)->>'kode' <> 'ok')))
       )
     order by prio, kl
     limit v_graense
     for update of r skip locked
  ), valgt as (
    -- Kun de label-rækker, kørslen faktisk tager (DAO er langsom).
    select k.id, k.handling,
           row_number() over (partition by k.handling order by k.prio, k.kl) as nr
      from k
     where k.handling is not null
  ), u as (
    update public.returfragt_betalinger x
       set synket_kl = case when v.handling in ('synk', 'annuller') then now() else x.synket_kl end,
           label_naeste_kl = case when v.handling = 'label' then now() + interval '15 minutes' else x.label_naeste_kl end,
           refusion_naeste_kl = case when v.handling = 'refusion' then now() + interval '10 minutes' else x.refusion_naeste_kl end
      from valgt v
     where x.id = v.id and (v.handling <> 'label' or v.nr <= v_labels)
    returning x.id, v.handling
  )
  select u.id, u.handling from u;
end;
$fn$;

-- ===========================================================================
-- 8. Køberens og sælgerens visning (også til appen)
-- ===========================================================================
-- supabase.rpc("min_returfragt", { p_trade }) ->
--   køberen: { rolle: 'koeber', sag: {kode, til_kl?}, id?, status?, beloeb_oere,
--              betalt_kl?, label_klar: bool, label_fejl?, refunderet_kl?,
--              refusion_aarsag?, afsender? }  (beloeb_oere er prisen, også før betaling)
--   sælgeren: { rolle: 'saelger', retur_paa_vej: bool }
--   ellers null.
create or replace function public.min_returfragt(p_trade uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_bruger uuid := (select auth.uid());
  t   record;
  rf  record;
  v_pris bigint;
  v_shop bigint;
  v_stoerrelse text;
begin
  if v_bruger is null or p_trade is null then return null; end if;
  select tr.id, tr.buyer_id, tr.seller_id, tr.auction_id into t from public.trades tr where tr.id = p_trade;
  if t.id is null then return null; end if;
  if t.seller_id = v_bruger then
    return jsonb_build_object('rolle', 'saelger', 'retur_paa_vej', exists (
      select 1 from public.forsendelser f where f.trade_id = p_trade and f.type = 'retur'
         and f.status not in ('opretter', 'fejlet', 'annulleret')));
  end if;
  if t.buyer_id <> v_bruger then return null; end if;
  select r.* into rf from public.returfragt_betalinger r
   where r.trade_id = p_trade order by r.oprettet_kl desc limit 1;
  if rf.id is not null and rf.status in ('afventer', 'behandles', 'betalt', 'refunderes', 'refunderet') then
    v_pris := rf.beloeb_oere;
  else
    select b.fragt_oere into v_pris from public.betalinger b
     where b.trade_id = p_trade and b.betalt_kl is not null order by b.betalt_kl desc limit 1;
    select a.pakkestoerrelse, a.fragt_pakkeshop_oere into v_stoerrelse, v_shop from public.auctions a where a.id = t.auction_id;
    if v_pris is null or v_pris < 300 then v_pris := v_shop; end if;
    if v_pris is null or v_pris < 300 then
      select p.pakkeshop_oere into v_pris from public.fragt_pakkestoerrelser p where p.kode = coalesce(v_stoerrelse, 'mellem');
    end if;
  end if;
  return jsonb_build_object(
    'rolle', 'koeber',
    'sag', public.returfragt_sag(p_trade),
    'id', rf.id,
    'status', rf.status,
    'beloeb_oere', v_pris,
    'betalt_kl', rf.betalt_kl,
    'label_klar', rf.label_klar_kl is not null,
    'label_fejl', case when rf.status = 'betalt' and rf.label_klar_kl is null then rf.label_brugerfejl end,
    'refunderet_kl', rf.refunderet_kl,
    'refusion_aarsag', rf.refusion_aarsag,
    -- Køberens egen adresse (forudfylder formularen).
    'afsender', rf.afsender);
end;
$fn$;

-- ===========================================================================
-- 9. Fakturaer: returfragten faktureres køberen (fragtkonto, med moms)
-- ===========================================================================
alter table public.fakturaer add column if not exists returfragt_id uuid
  references public.returfragt_betalinger(id) on delete restrict;

alter table public.fakturaer drop constraint if exists fakturaer_slags_check;
alter table public.fakturaer add constraint fakturaer_slags_check
  check (slags in ('salg', 'returfragt', 'sag_returfragt')
         and (slags = 'salg'
              or (slags = 'returfragt' and dokument = 'faktura' and part = 'koeber')
              or (slags = 'sag_returfragt' and dokument in ('faktura', 'kreditnota') and part = 'koeber')));

alter table public.fakturaer drop constraint if exists fakturaer_returfragt_id_check;
alter table public.fakturaer add constraint fakturaer_returfragt_id_check
  check ((slags = 'sag_returfragt') = (returfragt_id is not null));

comment on column public.fakturaer.slags is
  'salg: fakturaen ved betalingen (og kreditnotaen for den). returfragt: køberens faktura på returfragten, der blev trukket fra refusionen, da pakken ikke blev afhentet (20261016030000). sag_returfragt: køberens faktura (og kreditnota ved refusion) på returfragten, køberen betalte i en sag (20261022010000, returfragt_id). Låst.';

-- Én faktura pr. betaling, part, dokument og slags - undtagen returfragt i
-- sager (en handel kan have flere, hvis en er refunderet): én pr. returfragt
-- og dokument.
create unique index if not exists fakturaer_handel_part_slags_v2
  on public.fakturaer (betaling_id, part, dokument, slags)
  where betaling_id is not null and slags <> 'sag_returfragt';
drop index if exists public.fakturaer_handel_part_slags;
create unique index if not exists fakturaer_returfragt_dokument
  on public.fakturaer (returfragt_id, dokument) where returfragt_id is not null;

create or replace function public.fakturaer_returfragt_laast()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if new.returfragt_id is distinct from old.returfragt_id then
    raise exception 'Fakturaens indhold kan ikke ændres, når den er oprettet';
  end if;
  return new;
end;
$fn$;
revoke all on function public.fakturaer_returfragt_laast() from public, anon, authenticated;
drop trigger if exists fakturaer_returfragt_laast on public.fakturaer;
create trigger fakturaer_returfragt_laast before update on public.fakturaer
  for each row execute function public.fakturaer_returfragt_laast();

-- Planlægger fakturaer og kreditnotaer for returfragt i sager (kaldes af
-- fakturakøen efter faktura_planlaeg). Idempotent.
--   faktura:    betalt returfragt (også hvis den senere er refunderet - så
--               bogføres begge). Dateret på betalingsdagen. Passer det
--               modtagne beløb ikke, oprettes den som "kræver handling".
--   kreditnota: refunderet returfragt (hele beløbet), dateret på
--               refusionsdagen.
create or replace function public.faktura_planlaeg_returfragt(p_graense integer default 200)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura integer := 0;
  v_kredit  integer := 0;
  n         integer;
  r         record;
  v_linjer  jsonb;
  v_ok      boolean;
  v_fejl    text := 'Returfragten er betalt med et andet beløb end prisen (eller handlens betaling mangler) - kontrollér betalingen hos Stripe og lav dokumentet manuelt i Dinero.';
begin
  for r in
    select x.id, x.koeber_id, x.trade_id, x.betaling_id, x.beloeb_oere, x.modtaget_oere, x.betalt_kl,
           x.stripe_charge_id, x.stripe_payment_intent_id
      from public.returfragt_betalinger x
     where x.betalt_kl is not null
       and x.status in ('betalt', 'refunderes', 'refunderet')
       and x.betaling_id is not null
       and not exists (select 1 from public.fakturaer f where f.returfragt_id = x.id and f.dokument = 'faktura')
     order by x.betalt_kl
     limit v_graense
  loop
    v_ok := r.modtaget_oere is not distinct from r.beloeb_oere;
    v_linjer := jsonb_build_array(public.faktura_linje('fragt', 'Returfragt (retur i sag)', r.beloeb_oere));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, returfragt_id)
    values ('faktura', 'koeber', r.koeber_id, r.betaling_id, r.trade_id, v_linjer, public.faktura_sum(v_linjer),
            public.faktura_moms(v_linjer), (r.betalt_kl at time zone 'Europe/Copenhagen')::date,
            coalesce(r.stripe_charge_id, r.stripe_payment_intent_id),
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else v_fejl end, 'sag_returfragt', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_faktura := v_faktura + n;
  end loop;

  for r in
    select fa.id as faktura_id, fa.bruger_id, fa.betaling_id, fa.trade_id, fa.linjer, fa.manuel, fa.status as moder_status,
           x.id, x.refunderet_kl, x.stripe_refund_id
      from public.fakturaer fa
      join public.returfragt_betalinger x on x.id = fa.returfragt_id
     where fa.dokument = 'faktura'
       and fa.slags = 'sag_returfragt'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.returfragt_id = x.id and k.dokument = 'kreditnota')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_ok := not (r.manuel or r.moder_status in ('kraever_handling', 'haandteret_manuelt'));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl,
                                  slags, returfragt_id)
    values ('kreditnota', 'koeber', r.bruger_id, r.betaling_id, r.trade_id, r.faktura_id, r.linjer,
            public.faktura_sum(r.linjer), public.faktura_moms(r.linjer),
            (r.refunderet_kl at time zone 'Europe/Copenhagen')::date, r.stripe_refund_id,
            case when v_ok then 'venter' else 'kraever_handling' end, not v_ok,
            case when v_ok then null else 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.' end,
            'sag_returfragt', r.id)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit);
end;
$fn$;

-- ===========================================================================
-- 9b. moderation_log: handlingen 'returfragt_refunderet' (maal_type 'handel')
-- ===========================================================================
do $do$
declare
  v_navn text;
  v_kol  text;
  v_ny   text;
  v_def  text;
  v_vals text[];
begin
  foreach v_navn in array array['moderation_log_handling_check', 'moderation_log_maal_type_check'] loop
    v_kol := case when v_navn = 'moderation_log_handling_check' then 'handling' else 'maal_type' end;
    v_ny := case when v_navn = 'moderation_log_handling_check' then 'returfragt_refunderet' else 'handel' end;
    select pg_get_constraintdef(c.oid) into v_def
      from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = v_navn;
    -- Ingen CHECK (eller værdien er der allerede): intet at gøre.
    if v_def is null or v_def like '%''' || v_ny || '''%' then continue; end if;
    v_vals := array(
      select distinct x from (
        select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
          from regexp_matches(v_def, '''([^'']+)''', 'g') as m
        union select v_ny) s
      where x <> '' order by 1);
    execute format('alter table public.moderation_log drop constraint %I', v_navn);
    execute format('alter table public.moderation_log add constraint %I check (%I = any (%L::text[]))', v_navn, v_kol, v_vals);
  end loop;
end $do$;

-- ===========================================================================
-- 10. Rettigheder: kun service role (min_returfragt også authenticated)
-- ===========================================================================
do $do$
declare
  f text;
begin
  foreach f in array array[
    'public.returfragt_sag(uuid)',
    'public.returfragt_start(uuid, uuid)',
    'public.returfragt_gem_afsender(uuid, uuid, jsonb)',
    'public.returfragt_gem_pi(uuid, text, integer)',
    'public.returfragt_nulstil_pi(uuid, text)',
    'public.returfragt_registrer(text, text, text, bigint, text)',
    'public.returfragt_annuller(uuid)',
    'public.returfragt_label_fejlet(uuid, text, text)',
    'public.returfragt_marker(uuid, text)',
    'public.returfragt_refusion_claim(uuid, text)',
    'public.returfragt_refusion_resultat(uuid, boolean, text, text)',
    'public.returfragt_refusion_fejlet(text, text)',
    'public.returfragt_cron(integer, integer)',
    'public.returfragt_label_venter(uuid, text)',
    'public.returfragt_registrer_charge_refusion(text, text, boolean)',
    'public.returfragt_staff_refusion(uuid, uuid, text)',
    'public.faktura_planlaeg_returfragt(integer)',
    'public.min_returfragt(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $do$;
grant execute on function public.min_returfragt(uuid) to authenticated;
