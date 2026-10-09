-- Fragt med DAO via Shipmondo (ROADMAP fase 2; ROADMAP-BESLUTNINGER afsnit 2,
-- "Fragtfirma og priser (Filip, 9. oktober 2026)"; Filip 9. okt.: køberen
-- vælger levering i en checkout FØR betalingen, og der er ingen automatisk
-- betaling længere).
--
-- Indhold:
--   1. fragt_pakkestoerrelser: ÉT sted for pakkestørrelser, vægtgrænser og
--      købers fragtpris (inkl. moms). Databasen bruger tabellen til alle
--      beløb; serveren og appen læser den (offentlig læsning).
--   2. fragt_kostpriser + fragt_tillaeg: DAO's forventede kostpris (ekskl.
--      moms) til admin/penge (BidHamrs fragttilskud). Kun service_role.
--   3. auctions: pakkestoerrelse, vaegt_gram og fragtpriserne låst på
--      auktionen (det, byderne ser, er det, der betales). Vægtgrænsen
--      håndhæves i databasen (også fra appen): over 15 kg kun afhentning;
--      Stor kan ikke leveres til døren. Genopsætning kopierer felterne.
--   4. betalinger: ny betaling får fragten fra auktionens pakkeshop-pris
--      (standard, indtil køberen vælger i checkout).
--   5. handel_levering: købers leveringsvalg (pakkeshop + shop, eller
--      levering til døren). leveringsforslag: købers/sælgers sidst brugte
--      adresse og pakkeshop som forudfyldning (ikke handelsdata).
--   6. handel_gem_levering: gemmer valget og opdaterer betalingens fragt,
--      total og gebyr sikkert (kun før charge; en PaymentIntent nulstilles
--      kontrolleret med pi_forsoeg + 1, efter serveren har annulleret den hos
--      Stripe).
--   7. Værn: en betaling med fragt kan ikke få en PaymentIntent uden et
--      gyldigt leveringsvalg med samme fragtbeløb.
--   8. forsendelser: produkt, vægt, forventet kostpris, afsender/modtager-
--      snapshot; forsendelse_claim kræver leveringsvalg; detaljer gemmes.
--   9. Læse-RPC'er til web og app (auth.uid()).
--  10. admin_fragt_tilskud (kun service_role - kun chef må se pengetal).
--  11. Konto slettet: leveringsforslaget slettes (GDPR, ikke handelsdata).
--
-- Ingen pengeflytning her ud over, at fragtbeløbet i en AFVENTENDE betaling
-- (uden charge) følger købers leveringsvalg. Frigivelse/udbetaling røres ikke
-- (levering i pakkeshop udløser aldrig udbetaling).
--
-- Idempotent: kan køres flere gange. Kør først på testdatabasen.

set lock_timeout = '5s';

-- ============================================================ 1. pakkestørrelser og priser

create table if not exists public.fragt_pakkestoerrelser (
  kode            text primary key,
  navn            text not null,
  maks_gram       integer not null,
  -- Købers pris inkl. moms i øre. doer_oere null = kan ikke leveres til døren.
  pakkeshop_oere  integer not null,
  doer_oere       integer,
  sortering       integer not null default 0,
  opdateret_kl    timestamptz not null default now(),
  constraint fragt_pakkestoerrelser_kode_check check (kode in ('lille', 'mellem', 'stor')),
  constraint fragt_pakkestoerrelser_vaerdier_check check (
        maks_gram between 1 and 100000
    and pakkeshop_oere between 100 and 1000000
    and (doer_oere is null or doer_oere between 100 and 1000000))
);

comment on table public.fragt_pakkestoerrelser is
  'Pakkestørrelser, vægtgrænser og købers fragtpris inkl. moms (Filip 9. okt. 2026). '
  'Ét sted: auktionerne låser prisen herfra, når pakkestørrelsen sættes.';

-- Pakkeshop-prisen er mindst 1 kr. (betalingens fragt > 0 er det, der gør en
-- handel til en forsendelse).
alter table public.fragt_pakkestoerrelser drop constraint if exists fragt_pakkestoerrelser_vaerdier_check;
alter table public.fragt_pakkestoerrelser add constraint fragt_pakkestoerrelser_vaerdier_check check (
      maks_gram between 1 and 100000
  and pakkeshop_oere between 100 and 1000000
  and (doer_oere is null or doer_oere between 100 and 1000000));

insert into public.fragt_pakkestoerrelser (kode, navn, maks_gram, pakkeshop_oere, doer_oere, sortering)
values ('lille',  'Lille',  1000,  4000, 6000, 1),
       ('mellem', 'Mellem', 5000,  5000, 8500, 2),
       ('stor',   'Stor',   15000, 6500, null, 3)
on conflict (kode) do nothing;

alter table public.fragt_pakkestoerrelser enable row level security;
drop policy if exists fragt_pakkestoerrelser_laes on public.fragt_pakkestoerrelser;
create policy fragt_pakkestoerrelser_laes on public.fragt_pakkestoerrelser
  for select to anon, authenticated using (true);
revoke all on public.fragt_pakkestoerrelser from public, anon, authenticated;
grant select on public.fragt_pakkestoerrelser to anon, authenticated;
grant all on public.fragt_pakkestoerrelser to service_role;

create or replace function public.fragt_pakkestoerrelser_opdateret()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.opdateret_kl := now();
  return new;
end;
$fn$;
revoke all on function public.fragt_pakkestoerrelser_opdateret() from public, anon, authenticated;
drop trigger if exists fragt_pakkestoerrelser_opdateret on public.fragt_pakkestoerrelser;
create trigger fragt_pakkestoerrelser_opdateret
  before update on public.fragt_pakkestoerrelser
  for each row execute function public.fragt_pakkestoerrelser_opdateret();

-- Mindste pakkestørrelse, en vægt passer i (null = over grænsen: kun afhentning).
create or replace function public.fragt_stoerrelse_for_vaegt(p_gram integer)
returns text
language sql
stable
set search_path = ''
as $fn$
  select p.kode from public.fragt_pakkestoerrelser p
   where p_gram is not null and p_gram > 0 and p.maks_gram >= p_gram
   order by p.maks_gram asc
   limit 1;
$fn$;
revoke all on function public.fragt_stoerrelse_for_vaegt(integer) from public, anon;
grant execute on function public.fragt_stoerrelse_for_vaegt(integer) to authenticated, service_role;

-- ============================================================ 2. DAO's kostpris

-- DAO-tilbuddet (ekskl. moms, før tillæg). Chefens valg: Shop2Shop har 7
-- priser for 8 vægttrin i tilbuddet - 33 kr. bruges for både 250 g og 500 g,
-- så 1 kg = 35 kr. (giver Filips "ca. 54/70/88 kr. inkl. moms"). Filip kan
-- rette trinene her.
create table if not exists public.fragt_kostpriser (
  fragtfirma  text not null,
  produkt     text not null,
  maks_gram   integer not null,
  pris_oere   integer not null,
  primary key (fragtfirma, produkt, maks_gram),
  constraint fragt_kostpriser_check check (
        fragtfirma in ('dao')
    and produkt in ('shop2shop', 'shop2home')
    and maks_gram between 1 and 100000
    and pris_oere between 0 and 1000000)
);

insert into public.fragt_kostpriser (fragtfirma, produkt, maks_gram, pris_oere) values
  ('dao', 'shop2shop',   250, 3300),
  ('dao', 'shop2shop',   500, 3300),
  ('dao', 'shop2shop',  1000, 3500),
  ('dao', 'shop2shop',  2000, 3800),
  ('dao', 'shop2shop',  3000, 4100),
  ('dao', 'shop2shop',  5000, 4500),
  ('dao', 'shop2shop', 10000, 5100),
  ('dao', 'shop2shop', 15000, 5800),
  ('dao', 'shop2home',   250, 3600),
  ('dao', 'shop2home',   500, 3800),
  ('dao', 'shop2home',  1000, 4000),
  ('dao', 'shop2home',  2000, 4400),
  ('dao', 'shop2home',  3000, 4900),
  ('dao', 'shop2home',  5000, 5600)
on conflict (fragtfirma, produkt, maks_gram) do nothing;

-- Tillæg (ekskl. moms). Én række. Chefens valg: energitillæg 15 % og ekstra
-- energitillæg 2 % lægges begge på grundprisen (17 % i alt, ikke 15 % oven i 2 %).
create table if not exists public.fragt_tillaeg (
  id                          boolean primary key default true,
  energitillaeg_promille      integer not null default 150,
  ekstra_energitillaeg_promille integer not null default 20,
  vejskat_oere                integer not null default 28,
  labelfri_oere               integer not null default 200,
  moms_promille               integer not null default 250,
  constraint fragt_tillaeg_en_raekke check (id),
  constraint fragt_tillaeg_check check (
        energitillaeg_promille between 0 and 1000
    and ekstra_energitillaeg_promille between 0 and 1000
    and vejskat_oere between 0 and 10000
    and labelfri_oere between 0 and 10000
    and moms_promille between 0 and 1000)
);
insert into public.fragt_tillaeg (id) values (true) on conflict (id) do nothing;

alter table public.fragt_kostpriser enable row level security;
alter table public.fragt_tillaeg enable row level security;
revoke all on public.fragt_kostpriser from public, anon, authenticated;
revoke all on public.fragt_tillaeg from public, anon, authenticated;
grant all on public.fragt_kostpriser to service_role;
grant all on public.fragt_tillaeg to service_role;

-- DAO's forventede pris i øre EKSKL. moms for én pakke. null = vægten er over
-- produktets grænse.
create or replace function public.fragt_forventet_kostpris_oere(
  p_produkt  text,
  p_gram     integer,
  p_labelfri boolean)
returns integer
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_grund integer;
  t       record;
begin
  select k.pris_oere into v_grund
    from public.fragt_kostpriser k
   where k.fragtfirma = 'dao' and k.produkt = p_produkt
     and k.maks_gram >= greatest(coalesce(p_gram, 1), 1)
   order by k.maks_gram asc
   limit 1;
  if v_grund is null then return null; end if;
  select * into t from public.fragt_tillaeg where id;
  return v_grund
       + round(v_grund * (coalesce(t.energitillaeg_promille, 0) + coalesce(t.ekstra_energitillaeg_promille, 0)) / 1000.0)::integer
       + coalesce(t.vejskat_oere, 0)
       + case when coalesce(p_labelfri, false) then coalesce(t.labelfri_oere, 0) else 0 end;
end;
$fn$;
revoke all on function public.fragt_forventet_kostpris_oere(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.fragt_forventet_kostpris_oere(text, integer, boolean) to service_role;

-- ============================================================ 3. auktioner

alter table public.auctions
  add column if not exists pakkestoerrelse      text,
  add column if not exists vaegt_gram           integer,
  -- Købers fragtpris låst på auktionen (inkl. moms, øre). Sættes af
  -- databasen ud fra fragt_pakkestoerrelser - klientens værdi ignoreres.
  add column if not exists fragt_pakkeshop_oere integer,
  add column if not exists fragt_doer_oere      integer;

alter table public.auctions drop constraint if exists auctions_pakkestoerrelse_check;
alter table public.auctions add constraint auctions_pakkestoerrelse_check check (
  pakkestoerrelse is null or pakkestoerrelse in ('lille', 'mellem', 'stor'));
alter table public.auctions drop constraint if exists auctions_vaegt_check;
alter table public.auctions add constraint auctions_vaegt_check check (
  vaegt_gram is null or vaegt_gram between 1 and 1000000);
alter table public.auctions drop constraint if exists auctions_fragtpris_check;
alter table public.auctions add constraint auctions_fragtpris_check check (
      (fragt_pakkeshop_oere is null or fragt_pakkeshop_oere between 0 and 1000000)
  and (fragt_doer_oere is null or fragt_doer_oere between 0 and 1000000));

comment on column public.auctions.pakkestoerrelse is
  'lille (op til 1 kg) | mellem (op til 5 kg) | stor (op til 15 kg, kun pakkeshop). '
  'null ved kun afhentning. Mangler den ved forsendelse, bruges mellem (ældre klienter).';
comment on column public.auctions.vaegt_gram is
  'Sælgerens vægt i gram (valgfri). Over 15 kg kan varen kun afhentes.';

-- Håndhæver vægtgrænsen og låser fragtprisen. BEFORE INSERT/UPDATE - også
-- for appens direkte insert/update. Fejlkoder:
--   BHT01 'fragt_for_tung: ...'      over 15 kg med forsendelse
--   BHT02 'fragt_stoerrelse: ...'    vægten passer ikke til pakkestørrelsen
--   BHT03 'fragt_vaegt: ...'         Mellem/Stor uden vægt (kun brugerens
--                                    egne ændringer - ikke systemet)
-- Ved UPDATE genberegnes prisen kun, når forsendelse/størrelse/vægt ændres;
-- ellers bevares den låste pris (klienten kan ikke sætte den selv).
-- Chefens valg: sender klienten INGEN størrelse (ældre web/app), bliver den
-- Mellem uden krav om vægt, så den nuværende app ikke går i stykker. Når
-- appen sender størrelsen, kan kravet gøres generelt.
create or replace function public.auctions_fragt()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_min    text;
  v_maks   integer;
  v_system boolean := coalesce(auth.role(), '') = 'service_role'
                      or current_user in ('postgres', 'supabase_admin', 'service_role');
  p        record;
begin
  if tg_op = 'UPDATE'
     and new.forsendelse_mulig is not distinct from old.forsendelse_mulig
     and new.pakkestoerrelse is not distinct from old.pakkestoerrelse
     and new.vaegt_gram is not distinct from old.vaegt_gram then
    new.fragt_pakkeshop_oere := old.fragt_pakkeshop_oere;
    new.fragt_doer_oere := old.fragt_doer_oere;
    return new;
  end if;

  if not coalesce(new.forsendelse_mulig, false) then
    new.fragt_pakkeshop_oere := null;
    new.fragt_doer_oere := null;
    return new;
  end if;

  if new.vaegt_gram is not null then
    v_min := public.fragt_stoerrelse_for_vaegt(new.vaegt_gram);
    if v_min is null then
      raise exception 'fragt_for_tung: Varer over 15 kg kan kun afhentes. Slå forsendelse fra.'
        using errcode = 'BHT01';
    end if;
    if new.pakkestoerrelse is null then
      new.pakkestoerrelse := v_min;
    else
      select maks_gram into v_maks from public.fragt_pakkestoerrelser where kode = new.pakkestoerrelse;
      if v_maks is null or new.vaegt_gram > v_maks then
        raise exception 'fragt_stoerrelse: Vægten passer ikke til pakkestørrelsen. Vælg en større pakke.'
          using errcode = 'BHT02';
      end if;
    end if;
  elsif not v_system and new.pakkestoerrelse in ('mellem', 'stor')
        and (tg_op = 'INSERT' or new.pakkestoerrelse is distinct from old.pakkestoerrelse) then
    raise exception 'fragt_vaegt: Skriv, hvor meget pakken vejer (Mellem og Stor).'
      using errcode = 'BHT03';
  end if;

  -- Ældre klienter, der ikke sender størrelsen: Mellem (chefens valg).
  new.pakkestoerrelse := coalesce(new.pakkestoerrelse, 'mellem');

  select * into p from public.fragt_pakkestoerrelser where kode = new.pakkestoerrelse;
  if p.kode is null then
    raise exception 'fragt_stoerrelse: Ukendt pakkestørrelse.' using errcode = 'BHT02';
  end if;
  new.fragt_pakkeshop_oere := p.pakkeshop_oere;
  new.fragt_doer_oere := p.doer_oere;
  return new;
end;
$fn$;
revoke all on function public.auctions_fragt() from public, anon, authenticated;

drop trigger if exists auctions_fragt on public.auctions;
create trigger auctions_fragt
  before insert or update on public.auctions
  for each row execute function public.auctions_fragt();

-- Backfill: eksisterende auktioner med forsendelse er budt på med "35 kr."
-- (den gamle faste fragt). De beholder 35 kr. til pakkeshop; levering til
-- døren til Mellem-prisen (et frivilligt tilvalg i checkout). Chefens valg.
-- Triggeren er slået fra under opdateringen (den ville sætte dagens pris).
alter table public.auctions disable trigger auctions_fragt;
update public.auctions a
   set pakkestoerrelse = 'mellem',
       fragt_pakkeshop_oere = 3500,
       fragt_doer_oere = (select doer_oere from public.fragt_pakkestoerrelser where kode = 'mellem')
 where a.forsendelse_mulig
   and a.pakkestoerrelse is null;
alter table public.auctions enable trigger auctions_fragt;

-- Kolonne-læsning (auctions har kolonne-grants efter 20261010061000).
grant select (pakkestoerrelse, vaegt_gram, fragt_pakkeshop_oere, fragt_doer_oere)
  on public.auctions to anon, authenticated;

-- Genopsætning (saet_annulleret_op_igen m.fl. registrerer i genopsaetninger):
-- den nye auktion får samme pakkestørrelse og vægt (prisen låses igen med
-- dagens priser).
create or replace function public.genopsaetninger_kopier_fragt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.auctions ny
     set pakkestoerrelse = g.pakkestoerrelse,
         vaegt_gram = g.vaegt_gram
    from public.auctions g
   where g.id = new.gammel_auction_id
     and ny.id = new.ny_auction_id
     and ny.forsendelse_mulig
     and (ny.pakkestoerrelse is distinct from g.pakkestoerrelse
          or ny.vaegt_gram is distinct from g.vaegt_gram);
  return new;
end;
$fn$;
revoke all on function public.genopsaetninger_kopier_fragt() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.genopsaetninger') is not null then
    execute 'drop trigger if exists genopsaetninger_kopier_fragt on public.genopsaetninger';
    execute 'create trigger genopsaetninger_kopier_fragt after insert on public.genopsaetninger
             for each row execute function public.genopsaetninger_kopier_fragt()';
  end if;
end $$;

-- Sælger ændrer pakkestørrelse/vægt på sin egen auktion (før første bud).
-- Samme beskyttelse som en direkte UPDATE (auctions_beskyt_kolonner): ikke
-- efter første bud, ikke skjult/pauset, ikke slut, ikke suspenderet.
-- Svar: {kode: 'ok', fragt_pakkeshop_oere, fragt_doer_oere} | {kode:
-- 'ikke_fundet' | 'har_bud' | 'ikke_aktiv' | 'skjult' | 'pauset' |
-- 'suspenderet' | 'for_tung' | 'stoerrelse' | 'vaegt_mangler' | 'ugyldig'}.
create or replace function public.saet_auktion_fragt(
  p_auktion         uuid,
  p_pakkestoerrelse text,
  p_vaegt_gram      integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  a     record;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  if p_pakkestoerrelse is not null and p_pakkestoerrelse not in ('lille', 'mellem', 'stor') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if p_vaegt_gram is not null and (p_vaegt_gram < 1 or p_vaegt_gram > 1000000) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  -- Samme krav som ved oprettelse: vægt ved Mellem og Stor.
  if p_vaegt_gram is null and coalesce(p_pakkestoerrelse, 'mellem') in ('mellem', 'stor') then
    return jsonb_build_object('kode', 'vaegt_mangler');
  end if;
  if public.jeg_er_suspenderet() then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  select * into a from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if a.skjult then return jsonb_build_object('kode', 'skjult'); end if;
  if a.pauset_kl is not null then return jsonb_build_object('kode', 'pauset'); end if;
  if a.status <> 'aktiv' or a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if a."nuværende_bud" is not null
     or exists (select 1 from public.bids b where b.auktion_id = a.id) then
    return jsonb_build_object('kode', 'har_bud');
  end if;
  if not coalesce(a.forsendelse_mulig, false) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  begin
    update public.auctions
       set pakkestoerrelse = p_pakkestoerrelse,
           vaegt_gram = p_vaegt_gram,
           redigeret_kl = date_trunc('milliseconds', clock_timestamp())
     where id = a.id;
  exception
    when sqlstate 'BHT01' then return jsonb_build_object('kode', 'for_tung');
    when sqlstate 'BHT02' then return jsonb_build_object('kode', 'stoerrelse');
    when sqlstate 'BHT03' then return jsonb_build_object('kode', 'vaegt_mangler');
  end;

  return (select jsonb_build_object('kode', 'ok',
                   'pakkestoerrelse', x.pakkestoerrelse,
                   'fragt_pakkeshop_oere', x.fragt_pakkeshop_oere,
                   'fragt_doer_oere', x.fragt_doer_oere)
            from public.auctions x where x.id = a.id);
end;
$fn$;
revoke all on function public.saet_auktion_fragt(uuid, text, integer) from public, anon;
grant execute on function public.saet_auktion_fragt(uuid, text, integer) to authenticated, service_role;

-- ============================================================ 4. betalinger: fragt fra auktionen

-- Ny betaling (afslut_udloebne_auktioner, andenchance m.fl. sætter fortsat
-- 3500 for forsendelse): fragten tages fra auktionens låste pakkeshop-pris,
-- og totalen rettes tilsvarende. Navnet starter med "betalinger_a" , så
-- triggeren kører før de andre BEFORE INSERT-triggere (alfabetisk).
create or replace function public.betalinger_a_fragtpris()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_pris integer;
begin
  if coalesce(new.fragt_oere, 0) <= 0 then return new; end if;
  select a.fragt_pakkeshop_oere into v_pris from public.auctions a where a.id = new.auction_id;
  if v_pris is null or v_pris <= 0 or v_pris = new.fragt_oere then return new; end if;
  new.total_oere := new.total_oere - new.fragt_oere + v_pris;
  new.fragt_oere := v_pris;
  return new;
end;
$fn$;
revoke all on function public.betalinger_a_fragtpris() from public, anon, authenticated;

drop trigger if exists betalinger_a_fragtpris on public.betalinger;
create trigger betalinger_a_fragtpris
  before insert on public.betalinger
  for each row execute function public.betalinger_a_fragtpris();

-- ============================================================ 5. leveringsvalg

create table if not exists public.handel_levering (
  trade_id              uuid primary key references public.trades(id) on delete restrict,
  maade                 text not null,
  -- Pakkeshop (maade = 'pakkeshop'): hentet fra fragtfirmaet af serveren,
  -- ikke fra klienten.
  fragtfirma            text not null,
  pakkeshop_id          text,
  pakkeshop_navn        text,
  pakkeshop_adresse     text,
  pakkeshop_postnummer  text,
  pakkeshop_by          text,
  pakkeshop_lat         double precision,
  pakkeshop_lng         double precision,
  -- Modtager (køberen). Adressen er krævet ved levering til døren.
  modtager_navn         text not null,
  modtager_adresse      text,
  modtager_postnummer   text,
  modtager_by           text,
  modtager_telefon      text not null,
  modtager_email        text,
  -- Fragten, valget giver (inkl. moms, øre) - samme som betalingens fragt_oere.
  fragt_oere            integer not null,
  valgt_kl              timestamptz not null default now(),
  opdateret_kl          timestamptz not null default now(),
  constraint handel_levering_maade_check check (maade in ('pakkeshop', 'doer')),
  constraint handel_levering_fragtfirma_check check (fragtfirma in ('test', 'gls', 'shipmondo')),
  constraint handel_levering_pakkeshop_check check (
    maade <> 'pakkeshop' or (pakkeshop_id is not null and pakkeshop_navn is not null)),
  constraint handel_levering_doer_check check (
    maade <> 'doer' or (modtager_adresse is not null and modtager_postnummer is not null and modtager_by is not null)),
  constraint handel_levering_tekst_check check (
        char_length(coalesce(pakkeshop_id, '')) <= 50
    and char_length(coalesce(pakkeshop_navn, '')) <= 120
    and char_length(coalesce(pakkeshop_adresse, '')) <= 200
    and coalesce(pakkeshop_postnummer, '0000') ~ '^\d{4}$'
    and char_length(coalesce(pakkeshop_by, '')) <= 80
    and char_length(modtager_navn) between 1 and 100
    and char_length(coalesce(modtager_adresse, '')) <= 200
    and coalesce(modtager_postnummer, '0000') ~ '^\d{4}$'
    and char_length(coalesce(modtager_by, '')) <= 80
    and modtager_telefon ~ '^\+?[0-9]{8,15}$'
    and char_length(coalesce(modtager_email, '')) <= 254),
  constraint handel_levering_fragt_check check (fragt_oere between 0 and 1000000)
);

comment on table public.handel_levering is
  'Købers leveringsvalg på en handel (checkout før betaling). Handelsdata - slettes aldrig.';

alter table public.handel_levering enable row level security;
drop policy if exists handel_levering_select_parter on public.handel_levering;
create policy handel_levering_select_parter on public.handel_levering
  for select to authenticated using (
    public.er_staff()
    or exists (select 1 from public.trades t
                where t.id = handel_levering.trade_id
                  and (t.buyer_id = auth.uid() or t.seller_id = auth.uid()))
  );
-- Parterne ser valget og pakkeshoppen. Købers adresse/telefon/e-mail hentes
-- via mit_leveringsvalg() (kun køberen og staff).
revoke all on public.handel_levering from public, anon, authenticated;
grant select (trade_id, maade, fragtfirma, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse,
              pakkeshop_postnummer, pakkeshop_by, pakkeshop_lat, pakkeshop_lng,
              fragt_oere, valgt_kl, opdateret_kl)
  on public.handel_levering to authenticated;
grant all on public.handel_levering to service_role;

create or replace function public.handel_levering_ingen_sletning()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'Leveringsvalg er handelsdata og kan ikke slettes.' using errcode = '42501';
end;
$fn$;
revoke all on function public.handel_levering_ingen_sletning() from public, anon, authenticated;
drop trigger if exists handel_levering_ingen_sletning on public.handel_levering;
create trigger handel_levering_ingen_sletning
  before delete on public.handel_levering
  for each row execute function public.handel_levering_ingen_sletning();

-- Forslag til checkout og "Send pakke" (sidst brugte). Ikke handelsdata: kan
-- slettes af brugeren og slettes, når kontoen slettes.
create table if not exists public.leveringsforslag (
  user_id               uuid primary key references public.users(id) on delete cascade,
  maade                 text,
  pakkeshop_id          text,
  pakkeshop_navn        text,
  pakkeshop_adresse     text,
  pakkeshop_postnummer  text,
  pakkeshop_by          text,
  modtager_navn         text,
  modtager_adresse      text,
  modtager_postnummer   text,
  modtager_by           text,
  modtager_telefon      text,
  afsender_navn         text,
  afsender_adresse      text,
  afsender_postnummer   text,
  afsender_by           text,
  afsender_telefon      text,
  opdateret_kl          timestamptz not null default now(),
  constraint leveringsforslag_maade_check check (maade is null or maade in ('pakkeshop', 'doer')),
  constraint leveringsforslag_tekst_check check (
        char_length(coalesce(pakkeshop_id, '')) <= 50
    and char_length(coalesce(pakkeshop_navn, '')) <= 120
    and char_length(coalesce(pakkeshop_adresse, '')) <= 200
    and char_length(coalesce(pakkeshop_postnummer, '')) <= 4
    and char_length(coalesce(pakkeshop_by, '')) <= 80
    and char_length(coalesce(modtager_navn, '')) <= 100
    and char_length(coalesce(modtager_adresse, '')) <= 200
    and char_length(coalesce(modtager_postnummer, '')) <= 4
    and char_length(coalesce(modtager_by, '')) <= 80
    and char_length(coalesce(modtager_telefon, '')) <= 16
    and char_length(coalesce(afsender_navn, '')) <= 100
    and char_length(coalesce(afsender_adresse, '')) <= 200
    and char_length(coalesce(afsender_postnummer, '')) <= 4
    and char_length(coalesce(afsender_by, '')) <= 80
    and char_length(coalesce(afsender_telefon, '')) <= 16)
);

alter table public.leveringsforslag enable row level security;
drop policy if exists leveringsforslag_egen on public.leveringsforslag;
create policy leveringsforslag_egen on public.leveringsforslag
  for select to authenticated using (user_id = auth.uid());
revoke all on public.leveringsforslag from public, anon, authenticated;
grant select on public.leveringsforslag to authenticated;
grant all on public.leveringsforslag to service_role;

-- Brugeren sletter sit eget forslag ("Glem min adresse").
create or replace function public.slet_mit_leveringsforslag()
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;
  delete from public.leveringsforslag where user_id = auth.uid();
  return found;
end;
$fn$;
revoke all on function public.slet_mit_leveringsforslag() from public, anon;
grant execute on function public.slet_mit_leveringsforslag() to authenticated;

-- Konto slettet/anonymiseret: forslaget slettes.
create or replace function public.users_slet_leveringsforslag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.konto_slettet_kl is not null and old.konto_slettet_kl is null then
    delete from public.leveringsforslag where user_id = new.id;
  end if;
  return new;
end;
$fn$;
revoke all on function public.users_slet_leveringsforslag() from public, anon, authenticated;
drop trigger if exists users_slet_leveringsforslag on public.users;
create trigger users_slet_leveringsforslag
  after update of konto_slettet_kl on public.users
  for each row execute function public.users_slet_leveringsforslag();

-- ============================================================ 6. gem leveringsvalg

-- Gemmer købers leveringsvalg og retter betalingens fragt + total (gebyret
-- følger med via betalinger_trin2_vedligehold). KUN service_role: serveren
-- har verificeret køberen med auth (p_bruger), slået pakkeshoppen op hos
-- fragtfirmaet, og - hvis der findes en PaymentIntent, og beløbet ændres -
-- annulleret den hos Stripe først (p_annulleret_pi).
--
-- Regler:
--   - Kun køberen, kun en forsendelseshandel, ikke når en fragtlabel er lavet.
--   - Betalingen afventer uden charge: valget må ændre fragten.
--     Findes der en PaymentIntent, og beløbet ændres, kræves p_annulleret_pi =
--     den gemte PaymentIntent; den fjernes (pi_forsoeg + 1, tidligere_payment_intents),
--     så serveren laver en ny med det nye beløb. Ellers svar 'pi_skal_annulleres'.
--   - Betalt: kun valg med samme fragt (fx en anden pakkeshop), før label.
--   - Levering til døren kun hvis auktionen har en dør-pris (ikke Stor).
--
-- p_valg: {maade, fragtfirma, pakkeshop: {id, navn, adresse, postnummer, by,
--          lat, lng} | null, modtager: {navn, adresse, postnummer, by,
--          telefon, email}, gem_forslag: bool}
-- Svar: {kode: 'ok', fragt_oere, total_oere, pris_aendret, pi_nulstillet} |
--       {kode: 'pi_skal_annulleres', pi} |
--       {kode: 'ikke_fundet' | 'afhentning' | 'forkert_status' | 'laast' |
--              'ikke_mulig' | 'pris_laast' | 'ugyldig'}
create or replace function public.handel_gem_levering(
  p_trade          uuid,
  p_bruger         uuid,
  p_valg           jsonb,
  p_annulleret_pi  text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  t        record;
  b        record;
  a        record;
  v_maade  text := p_valg->>'maade';
  v_firma  text := p_valg->>'fragtfirma';
  v_shop   jsonb := p_valg->'pakkeshop';
  v_mod    jsonb := p_valg->'modtager';
  v_pris   integer;
  v_aendret boolean := false;
  v_pi_nul boolean := false;
begin
  if p_trade is null or p_bruger is null or p_valg is null
     or jsonb_typeof(p_valg) <> 'object'
     or coalesce(v_maade, '') not in ('pakkeshop', 'doer')
     or coalesce(v_firma, '') not in ('test', 'gls', 'shipmondo')
     or v_mod is null or jsonb_typeof(v_mod) <> 'object'
     or (v_maade = 'pakkeshop' and (v_shop is null or jsonb_typeof(v_shop) <> 'object')) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  select id, buyer_id, seller_id, status, afhentning, auction_id into t
    from public.trades where id = p_trade for update;
  if t.id is null or t.buyer_id <> p_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if coalesce(t.afhentning, false) then
    return jsonb_build_object('kode', 'afhentning');
  end if;

  select * into b from public.betalinger where trade_id = p_trade for update;
  if b.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if coalesce(b.fragt_oere, 0) <= 0 then return jsonb_build_object('kode', 'afhentning'); end if;

  if exists (select 1 from public.forsendelser f
              where f.trade_id = p_trade and f.type = 'udgaaende'
                and f.status not in ('annulleret', 'fejlet')) then
    return jsonb_build_object('kode', 'laast');
  end if;

  select fragt_pakkeshop_oere, fragt_doer_oere into a from public.auctions where id = t.auction_id;
  v_pris := case v_maade when 'pakkeshop' then a.fragt_pakkeshop_oere else a.fragt_doer_oere end;
  if v_pris is null then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  if b.status = 'afventer' and b.stripe_charge_id is null and t.status = 'afventer_betaling' then
    if v_pris <> b.fragt_oere then
      v_aendret := true;
      if b.stripe_payment_intent_id is not null then
        if p_annulleret_pi is distinct from b.stripe_payment_intent_id then
          return jsonb_build_object('kode', 'pi_skal_annulleres', 'pi', b.stripe_payment_intent_id);
        end if;
        update public.betalinger
           set stripe_payment_intent_id = null,
               pi_forsoeg = pi_forsoeg + 1,
               tidligere_payment_intents = tidligere_payment_intents || b.stripe_payment_intent_id,
               fragt_oere = v_pris,
               total_oere = total_oere - fragt_oere + v_pris,
               opdateret = now()
         where id = b.id and status = 'afventer' and stripe_charge_id is null
           and stripe_payment_intent_id = b.stripe_payment_intent_id;
        v_pi_nul := true;
      else
        -- pi_forsoeg + 1 også uden PaymentIntent: en PaymentIntent, der er ved
        -- at blive lavet med det gamle beløb (samme idempotency key), kan så
        -- ikke gemmes (sikrPaymentIntent gemmer kun ved samme pi_forsoeg,
        -- total og gebyr).
        update public.betalinger
           set fragt_oere = v_pris,
               total_oere = total_oere - fragt_oere + v_pris,
               pi_forsoeg = pi_forsoeg + 1,
               opdateret = now()
         where id = b.id and status = 'afventer' and stripe_charge_id is null
           and stripe_payment_intent_id is null;
      end if;
      if not found then return jsonb_build_object('kode', 'forkert_status'); end if;
    end if;
  elsif b.status = 'betalt' and t.status = 'betaling_modtaget' then
    if v_pris <> b.fragt_oere then return jsonb_build_object('kode', 'pris_laast'); end if;
  else
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  insert into public.handel_levering as hl (
    trade_id, maade, fragtfirma,
    pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
    pakkeshop_lat, pakkeshop_lng,
    modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, modtager_email,
    fragt_oere)
  values (
    p_trade, v_maade, v_firma,
    case when v_maade = 'pakkeshop' then v_shop->>'id' end,
    case when v_maade = 'pakkeshop' then v_shop->>'navn' end,
    case when v_maade = 'pakkeshop' then v_shop->>'adresse' end,
    case when v_maade = 'pakkeshop' then v_shop->>'postnummer' end,
    case when v_maade = 'pakkeshop' then v_shop->>'by' end,
    case when v_maade = 'pakkeshop' then (v_shop->>'lat')::double precision end,
    case when v_maade = 'pakkeshop' then (v_shop->>'lng')::double precision end,
    btrim(v_mod->>'navn'), nullif(btrim(coalesce(v_mod->>'adresse', '')), ''),
    nullif(btrim(coalesce(v_mod->>'postnummer', '')), ''), nullif(btrim(coalesce(v_mod->>'by', '')), ''),
    v_mod->>'telefon', nullif(btrim(coalesce(v_mod->>'email', '')), ''),
    v_pris)
  on conflict (trade_id) do update set
    maade = excluded.maade, fragtfirma = excluded.fragtfirma,
    pakkeshop_id = excluded.pakkeshop_id, pakkeshop_navn = excluded.pakkeshop_navn,
    pakkeshop_adresse = excluded.pakkeshop_adresse, pakkeshop_postnummer = excluded.pakkeshop_postnummer,
    pakkeshop_by = excluded.pakkeshop_by, pakkeshop_lat = excluded.pakkeshop_lat,
    pakkeshop_lng = excluded.pakkeshop_lng,
    modtager_navn = excluded.modtager_navn, modtager_adresse = excluded.modtager_adresse,
    modtager_postnummer = excluded.modtager_postnummer, modtager_by = excluded.modtager_by,
    modtager_telefon = excluded.modtager_telefon, modtager_email = excluded.modtager_email,
    fragt_oere = excluded.fragt_oere, opdateret_kl = now();

  if coalesce((p_valg->>'gem_forslag')::boolean, true) then
    insert into public.leveringsforslag as lf (
      user_id, maade, pakkeshop_id, pakkeshop_navn, pakkeshop_adresse, pakkeshop_postnummer, pakkeshop_by,
      modtager_navn, modtager_adresse, modtager_postnummer, modtager_by, modtager_telefon, opdateret_kl)
    select p_bruger, hl.maade, hl.pakkeshop_id, hl.pakkeshop_navn, hl.pakkeshop_adresse,
           hl.pakkeshop_postnummer, hl.pakkeshop_by, hl.modtager_navn, hl.modtager_adresse,
           hl.modtager_postnummer, hl.modtager_by, hl.modtager_telefon, now()
      from public.handel_levering hl where hl.trade_id = p_trade
    on conflict (user_id) do update set
      maade = excluded.maade,
      pakkeshop_id = coalesce(excluded.pakkeshop_id, lf.pakkeshop_id),
      pakkeshop_navn = coalesce(excluded.pakkeshop_navn, lf.pakkeshop_navn),
      pakkeshop_adresse = coalesce(excluded.pakkeshop_adresse, lf.pakkeshop_adresse),
      pakkeshop_postnummer = coalesce(excluded.pakkeshop_postnummer, lf.pakkeshop_postnummer),
      pakkeshop_by = coalesce(excluded.pakkeshop_by, lf.pakkeshop_by),
      modtager_navn = excluded.modtager_navn,
      modtager_adresse = coalesce(excluded.modtager_adresse, lf.modtager_adresse),
      modtager_postnummer = coalesce(excluded.modtager_postnummer, lf.modtager_postnummer),
      modtager_by = coalesce(excluded.modtager_by, lf.modtager_by),
      modtager_telefon = excluded.modtager_telefon,
      opdateret_kl = now();
  end if;

  select fragt_oere, total_oere into b from public.betalinger where trade_id = p_trade;
  return jsonb_build_object('kode', 'ok', 'fragt_oere', b.fragt_oere, 'total_oere', b.total_oere,
                            'pris_aendret', v_aendret, 'pi_nulstillet', v_pi_nul);
end;
$fn$;
revoke all on function public.handel_gem_levering(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.handel_gem_levering(uuid, uuid, jsonb, text) to service_role;

-- Gem sælgers afsenderadresse som forslag til næste "Send pakke". service_role.
create or replace function public.leveringsforslag_gem_afsender(p_bruger uuid, p_afsender jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_bruger is null or p_afsender is null or jsonb_typeof(p_afsender) <> 'object' then return; end if;
  insert into public.leveringsforslag as lf (user_id, afsender_navn, afsender_adresse,
         afsender_postnummer, afsender_by, afsender_telefon, opdateret_kl)
  values (p_bruger, left(p_afsender->>'navn', 100), left(p_afsender->>'adresse', 200),
          left(p_afsender->>'postnummer', 4), left(p_afsender->>'by', 80),
          left(p_afsender->>'telefon', 16), now())
  on conflict (user_id) do update set
    afsender_navn = excluded.afsender_navn, afsender_adresse = excluded.afsender_adresse,
    afsender_postnummer = excluded.afsender_postnummer, afsender_by = excluded.afsender_by,
    afsender_telefon = excluded.afsender_telefon, opdateret_kl = now();
end;
$fn$;
revoke all on function public.leveringsforslag_gem_afsender(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.leveringsforslag_gem_afsender(uuid, jsonb) to service_role;

-- ============================================================ 7. værn: betaling kræver leveringsvalg

-- En betaling med fragt kan ikke få en PaymentIntent, før køberen har valgt
-- levering, og valgets fragt skal være betalingens fragt. Gælder også, hvis
-- serverens eget tjek (sikrPaymentIntent) fejler eller springes over.
create or replace function public.betalinger_kraev_levering()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_fragt integer;
begin
  if new.stripe_payment_intent_id is not null
     and old.stripe_payment_intent_id is null
     and coalesce(new.fragt_oere, 0) > 0 then
    select hl.fragt_oere into v_fragt from public.handel_levering hl where hl.trade_id = new.trade_id;
    if v_fragt is null then
      raise exception 'levering_mangler: Vælg levering, før du betaler.' using errcode = 'BHT10';
    end if;
    if v_fragt <> new.fragt_oere then
      raise exception 'levering_mangler: Fragten passer ikke til leveringsvalget.' using errcode = 'BHT10';
    end if;
  end if;
  return new;
end;
$fn$;
revoke all on function public.betalinger_kraev_levering() from public, anon, authenticated;

drop trigger if exists betalinger_kraev_levering on public.betalinger;
create trigger betalinger_kraev_levering
  before update of stripe_payment_intent_id on public.betalinger
  for each row execute function public.betalinger_kraev_levering();

-- ============================================================ 8. forsendelser

alter table public.forsendelser
  -- 'pakkeshop' | 'doer' (udgående) eller 'retur'.
  add column if not exists levering                 text,
  -- Fragtfirmaets produktkode (fx DAO_STS, DAO_STH).
  add column if not exists produkt                  text,
  add column if not exists vaegt_gram               integer,
  -- DAO-pris efter aftalen ekskl. moms (fragt_forventet_kostpris_oere).
  -- pris_oere er fragtfirmaets/Shipmondos pris INKL. moms fra svaret.
  add column if not exists forventet_kostpris_oere  integer,
  add column if not exists pakkeshop_id             text,
  -- Snapshot af adresserne på labelen (kun staff/service_role).
  add column if not exists afsender                 jsonb,
  add column if not exists modtager                 jsonb,
  -- Oprettelsen fik et ukendt udfald (timeout/netværk, eller fejl efter at
  -- fragtfirmaet havde oprettet den). Claimet bliver stående, og næste forsøg
  -- genbruger SAMME reference, så der aldrig bestilles en ny label, før det
  -- er afklaret.
  add column if not exists ukendt_udfald_kl         timestamptz,
  -- Seneste forsøg på at oprette (claim eller genoptag).
  add column if not exists forsoegt_kl              timestamptz;

-- Staff kan godkende flere udgående labels end de 2 tilladte pr. handel.
alter table public.handel_levering
  add column if not exists ekstra_labels_godkendt integer not null default 0;

alter table public.forsendelser drop constraint if exists forsendelser_levering_check;
alter table public.forsendelser add constraint forsendelser_levering_check check (
      (levering is null or levering in ('pakkeshop', 'doer', 'retur'))
  and char_length(coalesce(produkt, '')) <= 40
  and (vaegt_gram is null or vaegt_gram between 1 and 1000000)
  and (forventet_kostpris_oere is null or forventet_kostpris_oere between 0 and 10000000)
  and char_length(coalesce(pakkeshop_id, '')) <= 50
  and (afsender is null or pg_column_size(afsender) <= 2048)
  and (modtager is null or pg_column_size(modtager) <= 2048));

grant select (levering, produkt, pakkeshop_id) on public.forsendelser to authenticated;

-- Som i 20261006010000, plus:
--   - en udgående forsendelse kræver købers leveringsvalg (handel_levering),
--   - pakkestørrelsen er auktionens (sælgeren kan ikke vælge en anden - prisen
--     er låst på auktionen); p_pakkestoerrelse bruges kun, når auktionen ingen
--     størrelse har,
--   - et afbrudt forsøg eller et ukendt udfald markeres IKKE længere fejlet:
--     det genoptages med samme id/reference ('genoptag'), så der aldrig
--     bestilles en ny label, før det er afklaret,
--   - højst 2 udgående labels pr. handel ('for_mange_labels'), medmindre
--     staff har godkendt flere.
-- Svar: {kode: 'ok' | 'genoptag', id, pakkestoerrelse, levering, fragtfirma} |
--       {kode: 'findes', id} | {kode: 'i_gang' | 'ikke_fundet' | 'afhentning' |
--       'forkert_status' | 'mangler_levering' | 'ingen_retur' |
--       'for_mange_labels' | 'ugyldig'}
create or replace function public.forsendelse_claim(
  p_trade           uuid,
  p_bruger          uuid,
  p_type            text,
  p_fragtfirma      text,
  p_pakkestoerrelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  t  record;
  f  record;
  v_id uuid;
  v_stoerrelse text;
  v_levering text;
  v_ekstra integer;
  v_antal integer;
begin
  if p_trade is null or p_bruger is null
     or p_type not in ('udgaaende', 'retur')
     or p_fragtfirma not in ('test', 'gls', 'shipmondo')
     or (p_pakkestoerrelse is not null and p_pakkestoerrelse not in ('lille', 'mellem', 'stor')) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  select tr.id, tr.seller_id, tr.buyer_id, tr.status, tr.afhentning, au.pakkestoerrelse as a_stoerrelse
    into t
    from public.trades tr
    join public.auctions au on au.id = tr.auction_id
   where tr.id = p_trade
   for update of tr;
  if t.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if p_type = 'udgaaende' then
    if t.seller_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
    if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;
  else
    if t.buyer_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  end if;

  v_stoerrelse := coalesce(t.a_stoerrelse, p_pakkestoerrelse, 'mellem');

  if p_type = 'udgaaende' then
    if t.status <> 'betaling_modtaget' then
      return jsonb_build_object('kode', 'forkert_status');
    end if;
    select hl.maade, hl.ekstra_labels_godkendt into v_levering, v_ekstra
      from public.handel_levering hl where hl.trade_id = p_trade;
    if v_levering is null then
      return jsonb_build_object('kode', 'mangler_levering');
    end if;
  else
    if not exists (select 1 from public.sager s
                    where s.trade_id = p_trade
                      and s.status = 'afventer_retur'
                      and s.retur_kraeves) then
      return jsonb_build_object('kode', 'ingen_retur');
    end if;
    v_levering := 'retur';
  end if;

  select id, status, oprettet_kl, forsoegt_kl, ukendt_udfald_kl, fragtfirma, pakkestoerrelse into f
    from public.forsendelser
   where trade_id = p_trade and type = p_type
     and status not in ('annulleret', 'fejlet')
   for update;
  if f.id is not null then
    if f.status <> 'opretter' then
      return jsonb_build_object('kode', 'findes', 'id', f.id);
    end if;
    -- Et forsøg er i gang (eller fik et ukendt udfald for under 1 minut
    -- siden - fragtfirmaets søgning på reference er nogle sekunder bagud).
    if (f.ukendt_udfald_kl is null and coalesce(f.forsoegt_kl, f.oprettet_kl) > now() - interval '10 minutes')
       or f.ukendt_udfald_kl > now() - interval '1 minute' then
      return jsonb_build_object('kode', 'i_gang');
    end if;
    -- Ukendt udfald eller afbrudt forsøg: genoptag med SAMME id/reference,
    -- så fragtfirmaet giver den eksisterende forsendelse tilbage, hvis den findes.
    update public.forsendelser
       set forsoegt_kl = now(), ukendt_udfald_kl = null
     where id = f.id and status = 'opretter';
    return jsonb_build_object('kode', 'genoptag', 'id', f.id, 'pakkestoerrelse', f.pakkestoerrelse,
                              'levering', v_levering, 'fragtfirma', f.fragtfirma);
  end if;

  -- Højst 2 udgående labels pr. handel (også annullerede); flere kræver, at
  -- staff godkender (fragt_godkend_ekstra_label). Fejlede tæller ikke - dér
  -- blev intet oprettet hos fragtfirmaet.
  if p_type = 'udgaaende' then
    select count(*) into v_antal from public.forsendelser
     where trade_id = p_trade and type = 'udgaaende' and status <> 'fejlet';
    if v_antal >= 2 + coalesce(v_ekstra, 0) then
      return jsonb_build_object('kode', 'for_mange_labels');
    end if;
  end if;

  insert into public.forsendelser (trade_id, type, fragtfirma, status, pakkestoerrelse, oprettet_af, levering, forsoegt_kl)
  values (p_trade, p_type, p_fragtfirma, 'opretter', v_stoerrelse, p_bruger, v_levering, now())
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'id', v_id, 'pakkestoerrelse', v_stoerrelse, 'levering', v_levering,
                            'fragtfirma', p_fragtfirma);
end;
$fn$;
revoke all on function public.forsendelse_claim(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_claim(uuid, uuid, text, text, text) to service_role;

-- Detaljer fra fragtfirmaet på en claimet forsendelse (før forsendelse_gem_oprettet).
-- Forventet kostpris beregnes her ud fra produkt og vægt.
create or replace function public.forsendelse_gem_detaljer(
  p_id           uuid,
  p_produkt      text,
  p_vaegt_gram   integer,
  p_labelfri     boolean,
  p_pakkeshop_id text,
  p_afsender     jsonb,
  p_modtager     jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_kost integer;
begin
  v_kost := public.fragt_forventet_kostpris_oere(
    case p_produkt when 'DAO_STS' then 'shop2shop' when 'DAO_STH' then 'shop2home' else null end,
    p_vaegt_gram, p_labelfri);
  update public.forsendelser
     set produkt = left(p_produkt, 40),
         vaegt_gram = p_vaegt_gram,
         forventet_kostpris_oere = v_kost,
         pakkeshop_id = left(p_pakkeshop_id, 50),
         afsender = p_afsender,
         modtager = p_modtager
   where id = p_id and status = 'opretter';
  return found;
end;
$fn$;
revoke all on function public.forsendelse_gem_detaljer(uuid, text, integer, boolean, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.forsendelse_gem_detaljer(uuid, text, integer, boolean, text, jsonb, jsonb) to service_role;

-- Ukendt udfald: claimet bliver stående ('opretter'), og næste forsøg (efter
-- mindst 1 minut) genoptager med samme reference. Staff markeres.
create or replace function public.forsendelse_marker_ukendt(p_id uuid, p_fejl text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.forsendelser
     set ukendt_udfald_kl = now(),
         fejl = left(coalesce(p_fejl, 'Ukendt udfald'), 500),
         kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst,
           'Oprettelsen hos fragtfirmaet fik et ukendt udfald. Næste forsøg genbruger samme reference ('
           || p_id || '). Tjek hos fragtfirmaet, hvis det bliver ved.')
   where id = p_id and status = 'opretter';
  return found;
end;
$fn$;
revoke all on function public.forsendelse_marker_ukendt(uuid, text) from public, anon, authenticated;
grant execute on function public.forsendelse_marker_ukendt(uuid, text) to service_role;

-- Staff godkender én ekstra udgående label på handlen (efter 2). Kun
-- service_role - serveren har tjekket staff-rollen og inhabilitet og logger i
-- moderation_log. Svar: 'ok' | 'ikke_fundet'.
create or replace function public.fragt_godkend_ekstra_label(p_trade uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.handel_levering
     set ekstra_labels_godkendt = ekstra_labels_godkendt + 1, opdateret_kl = now()
   where trade_id = p_trade;
  if not found then return 'ikke_fundet'; end if;
  return 'ok';
end;
$fn$;
revoke all on function public.fragt_godkend_ekstra_label(uuid) from public, anon, authenticated;
grant execute on function public.fragt_godkend_ekstra_label(uuid) to service_role;

-- Fragtfirmaets målte vægt (webhook). Er den over pakkestørrelsens maksimum,
-- markeres forsendelsen OG betalingen til staff (betalinger.kraever_opmaerksomhed
-- holder udbetalingen, se betaling_udbetaling_blokeret). ROADMAP: sælgeren
-- betaler forskellen - chefens valg: kun markering + note nu, modregning senere.
-- Idempotent (noten tilføjes kun én gang). Svar: true = for tung.
create or replace function public.forsendelse_tjek_vaegt(p_id uuid, p_maalt_gram integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  f      record;
  v_maks integer;
  v_note text;
begin
  if p_maalt_gram is null or p_maalt_gram <= 0 then return false; end if;
  select id, trade_id, type, pakkestoerrelse, vaegt_gram into f from public.forsendelser where id = p_id;
  if f.id is null or f.type <> 'udgaaende' then return false; end if;
  select maks_gram into v_maks from public.fragt_pakkestoerrelser where kode = f.pakkestoerrelse;
  if v_maks is null or p_maalt_gram <= v_maks then return false; end if;
  v_note := 'Fragtfirmaet har vejet pakken til ' || p_maalt_gram || ' g, men pakkestørrelsen '
            || f.pakkestoerrelse || ' er højst ' || v_maks || ' g. Sælgeren skal betale forskellen '
            || '(modregning er ikke bygget) - udbetalingen holdes, til staff har set det.';
  update public.forsendelser
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, v_note)
   where id = f.id;
  update public.betalinger
     set kraever_opmaerksomhed = true, opdateret = now()
   where trade_id = f.trade_id and not kraever_opmaerksomhed;
  return true;
end;
$fn$;
revoke all on function public.forsendelse_tjek_vaegt(uuid, integer) from public, anon, authenticated;
grant execute on function public.forsendelse_tjek_vaegt(uuid, integer) to service_role;

-- Gamle handler (før denne migration), hvor køberen har startet betalingen
-- uden leveringsvalg: køberen skal vælge levering (fragt-cron sender én besked
-- pr. handel). Kun service_role.
create or replace function public.fragt_mangler_leveringsvalg(p_graense integer)
returns table (trade_id uuid, buyer_id uuid, auction_id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  select b.trade_id, b.buyer_id, b.auction_id
    from public.betalinger b
    join public.trades t on t.id = b.trade_id
   where b.status = 'afventer'
     and b.fragt_oere > 0
     and b.stripe_payment_intent_id is not null
     and t.status = 'afventer_betaling'
     and not exists (select 1 from public.handel_levering hl where hl.trade_id = b.trade_id)
     and not exists (select 1 from public.notifikation_afsendelser n
                      where n.noegle = 'vaelg_levering:' || b.trade_id)
   order by b.oprettet
   limit greatest(1, least(coalesce(p_graense, 20), 100));
$fn$;
revoke all on function public.fragt_mangler_leveringsvalg(integer) from public, anon, authenticated;
grant execute on function public.fragt_mangler_leveringsvalg(integer) to service_role;

-- ============================================================ 9. læse-RPC'er (web og app)

-- Købers eget leveringsvalg inkl. adresse (køberen og staff). Ingen række =
-- intet valg / ingen adgang.
create or replace function public.mit_leveringsvalg(p_trade uuid)
returns table (
  trade_id uuid, maade text, fragtfirma text,
  pakkeshop_id text, pakkeshop_navn text, pakkeshop_adresse text,
  pakkeshop_postnummer text, pakkeshop_by text, pakkeshop_lat double precision, pakkeshop_lng double precision,
  modtager_navn text, modtager_adresse text, modtager_postnummer text, modtager_by text,
  modtager_telefon text, modtager_email text, fragt_oere integer, valgt_kl timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  select hl.trade_id, hl.maade, hl.fragtfirma,
         hl.pakkeshop_id, hl.pakkeshop_navn, hl.pakkeshop_adresse,
         hl.pakkeshop_postnummer, hl.pakkeshop_by, hl.pakkeshop_lat, hl.pakkeshop_lng,
         hl.modtager_navn, hl.modtager_adresse, hl.modtager_postnummer, hl.modtager_by,
         hl.modtager_telefon, hl.modtager_email, hl.fragt_oere, hl.valgt_kl
    from public.handel_levering hl
    join public.trades t on t.id = hl.trade_id
   where hl.trade_id = p_trade
     and auth.uid() is not null
     and (t.buyer_id = auth.uid() or public.er_staff());
$fn$;
revoke all on function public.mit_leveringsvalg(uuid) from public, anon;
grant execute on function public.mit_leveringsvalg(uuid) to authenticated;

-- Checkout-data for køberen: hvad kan vælges, og hvad koster det.
-- Svar: null (ikke køber / ingen handel) eller
--   {trade_id, afhentning, pakkestoerrelse, pakkeshop_oere, doer_oere,
--    valgt: {maade, pakkeshop_id, pakkeshop_navn, fragt_oere} | null,
--    betaling: {status, fragt_oere, total_oere, kan_aendre_pris}}
create or replace function public.handel_checkout(p_trade uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'trade_id', t.id,
    'afhentning', coalesce(t.afhentning, false) or coalesce(b.fragt_oere, 0) = 0,
    'pakkestoerrelse', a.pakkestoerrelse,
    'pakkeshop_oere', a.fragt_pakkeshop_oere,
    'doer_oere', a.fragt_doer_oere,
    'valgt', (select jsonb_build_object('maade', hl.maade, 'pakkeshop_id', hl.pakkeshop_id,
                                        'pakkeshop_navn', hl.pakkeshop_navn, 'fragt_oere', hl.fragt_oere)
                from public.handel_levering hl where hl.trade_id = t.id),
    'betaling', jsonb_build_object(
      'status', b.status,
      'fragt_oere', b.fragt_oere,
      'total_oere', b.total_oere,
      'kan_aendre_pris', b.status = 'afventer' and b.stripe_charge_id is null and t.status = 'afventer_betaling'),
    'label_lavet', exists (select 1 from public.forsendelser f
                            where f.trade_id = t.id and f.type = 'udgaaende'
                              and f.status not in ('annulleret', 'fejlet')))
    from public.trades t
    join public.auctions a on a.id = t.auction_id
    left join public.betalinger b on b.trade_id = t.id
   where t.id = p_trade
     and auth.uid() is not null
     and t.buyer_id = auth.uid();
$fn$;
revoke all on function public.handel_checkout(uuid) from public, anon;
grant execute on function public.handel_checkout(uuid) to authenticated;

-- ============================================================ 10. admin: fragttilskud

-- Kun service_role (serveren kalder den efter assertRole('chef')).
-- Købers fragt (inkl. moms) mod DAO's forventede pris for forsendelser,
-- oprettet i perioden (ikke annullerede/fejlede).
create or replace function public.admin_fragt_tilskud(p_fra timestamptz, p_til timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with f as (
    select fo.id, fo.trade_id, fo.type, fo.forventet_kostpris_oere, fo.pris_oere,
           case when fo.type = 'udgaaende' then coalesce(b.fragt_oere, 0) else 0 end as koeber_oere
      from public.forsendelser fo
      left join public.betalinger b on b.trade_id = fo.trade_id
     where fo.oprettet_kl >= p_fra and fo.oprettet_kl < p_til
       and fo.status not in ('opretter', 'annulleret', 'fejlet')
  ), t as (select moms_promille from public.fragt_tillaeg where id)
  select jsonb_build_object(
    'antal', count(*),
    'koeber_betalt_oere', coalesce(sum(koeber_oere), 0),
    'forventet_kost_ex_moms_oere', coalesce(sum(forventet_kostpris_oere), 0),
    'forventet_kost_inkl_moms_oere',
      coalesce(sum(round(forventet_kostpris_oere * (1000 + (select moms_promille from t)) / 1000.0)), 0),
    'tilskud_inkl_moms_oere',
      coalesce(sum(round(forventet_kostpris_oere * (1000 + (select moms_promille from t)) / 1000.0)), 0)
      - coalesce(sum(koeber_oere), 0),
    'fragtfirma_pris_inkl_moms_oere', coalesce(sum(pris_oere), 0),
    'uden_kostpris', count(*) filter (where forventet_kostpris_oere is null))
    from f;
$fn$;
revoke all on function public.admin_fragt_tilskud(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_fragt_tilskud(timestamptz, timestamptz) to service_role;

-- ============================================================ 12. notifikationstype 'pakke_indleveret'

-- "Pakken er indleveret" til sælgeren (påkrævet). FLETTES ind i de nuværende
-- værdier (som 20261009010000/20261009040000). HOLD SYNKRON med
-- src/lib/notifikationer/typer.ts.
do $do$
declare
  v_src  text;
  v_vals text[];
begin
  if to_regprocedure('public.notifikation_paakraevet(text)') is null then return; end if;
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.notifikation_paakraevet(text)');
  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x from regexp_matches(coalesce(v_src, ''), '''([a-z0-9_]+)''', 'g') as m
    union select 'pakke_indleveret'
  ) s;
  execute format($f$
    create or replace function public.notifikation_paakraevet(p_type text)
    returns boolean
    language sql immutable set search_path = '' as $b$
      select p_type = any (array[%s]);
    $b$
    $f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) as v));
end $do$;

reset lock_timeout;
