-- Afhentning hos saelger (ROADMAP fase 1: "Afhentning hos saelger: koeber
-- giver stjerner og viser koden -> pengene frigives med det samme";
-- ROADMAP-BESLUTNINGER afsnit 1/2: "Koeberen viser en kode ved afhentning, og
-- pengene frigives med det samme. Ingen klagefrist bagefter." og afsnit 6).
--
-- En afhentningshandel er en handel paa en auktion, der KUN tilbyder
-- afhentning (auctions.forsendelse_mulig = false -> fragt 0 kr). Koeberen kan
-- ikke vaelge afhentning paa en auktion med forsendelse.
--
-- Flow:
--   afventer_betaling -> betaling_modtaget (Stripe) -> [koden genereres]
--   -> koeberen giver 1-5 stjerner og faar koden vist (afhentning_vis_kode)
--   -> saelgeren indtaster koden ved afhentningen (afhentning_bekraeft)
--   -> 'leveret' + betalinger.frigivet_kl (samme sti som handel_godkend /
--      admin_frigiv_handel; serveren overfoerer med overfoerTilSaelger).
--   Afhentningshandler gaar aldrig gennem 'pakke_sendt'/'modtaget'. Derfor:
--     - ingen sag (sag_opret kraever 'modtaget'/'pakke_sendt' og frigivet_kl
--       tom) - heller ikke bagefter (ingen klagefrist),
--     - ingen automatisk frigivelse (handel_auto_frigiv kraever
--       'modtaget'/'pakke_sendt'),
--     - trade_marker_sendt afviser afhentningshandler.
--   Ikke hentet efter 7 dage: betalingen markeres til staff
--   (afhentning_marker_ikke_hentet, cron). Ingen automatisk frigivelse.
--
-- AEndringer:
--   1. trades.afhentning (laast ved oprettelse via trigger fra auktionen).
--   2. Tabel afhentninger (kode + forsoeg). Ingen adgang for brugere -
--      kun via funktionerne nedenfor. Koden gemmes i klartekst, fordi
--      koeberen skal kunne se den igen; tabellen kan kun laeses af
--      service_role og funktionerne, og koden returneres kun til koeberen.
--   3. Koden genereres, naar handlen bliver 'betaling_modtaget' (trigger).
--   4. trade_marker_sendt afviser afhentningshandler.
--   5. afhentning_info, afhentning_vis_kode, afhentning_bekraeft (authenticated).
--   6. afhentning_marker_ikke_hentet (service_role, cron).
--
-- Brute-force-vaern paa koden (6 cifre = 1.000.000 muligheder):
--   - saelgeren kan foerst proeve, naar koeberen har faaet koden vist,
--   - hoejst 5 forkerte forsoeg pr. time pr. handel; derefter laast resten af
--     timen, og betalingen markeres til staff,
--   - 15 forkerte forsoeg i alt: laast permanent. Staff afgoer handlen
--     (admin_frigiv_handel eller refusion).
--
-- Idempotent: if not exists / create or replace / drop ... if exists /
-- on conflict. Handelsdata slettes aldrig.

-- ============================================================ 1. trades.afhentning

alter table public.trades
  add column if not exists afhentning boolean not null default false;

comment on column public.trades.afhentning is
  'true: auktionen tilboed kun afhentning (forsendelse_mulig = false, fragt 0). '
  'Saettes ved oprettelse af triggeren trades_saet_afhentning og aendres ikke. '
  'Pengene frigives, naar saelgeren indtaster koeberens afhentningskode.';

-- Eksisterende handler: kun afhentning, hvis auktionen ikke tilbyder forsendelse.
update public.trades t
   set afhentning = true
  from public.auctions a
 where a.id = t.auction_id
   and not coalesce(a.forsendelse_mulig, false)
   and not t.afhentning;

create or replace function public.trades_saet_afhentning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if tg_op = 'INSERT' then
    -- Altid fra auktionen - aldrig fra kalderen.
    select not coalesce(a.forsendelse_mulig, false) into new.afhentning
      from public.auctions a where a.id = new.auction_id;
    new.afhentning := coalesce(new.afhentning, false);
  else
    -- Flaget kan ikke aendres bagefter.
    new.afhentning := old.afhentning;
  end if;
  return new;
end;
$fn$;

revoke all on function public.trades_saet_afhentning() from public, anon, authenticated;

drop trigger if exists trades_saet_afhentning on public.trades;
create trigger trades_saet_afhentning
  before insert or update of afhentning on public.trades
  for each row execute function public.trades_saet_afhentning();

-- ============================================================ 2. afhentninger

create table if not exists public.afhentninger (
  trade_id                 uuid primary key references public.trades(id) on delete restrict,
  -- 6 cifre. Kun koeberen faar den at se (afhentning_vis_kode).
  kode                     text not null check (kode ~ '^[0-9]{6}$'),
  oprettet                 timestamptz not null default now(),
  -- Foerste gang koeberen fik koden vist (og bedoemte saelgeren).
  vist_kl                  timestamptz,
  -- Saelgeren indtastede den rigtige kode -> pengene frigivet.
  bekraeftet_kl            timestamptz,
  -- Brute-force-vaern.
  forkerte_forsoeg_i_alt   integer not null default 0,
  forkerte_forsoeg_vindue  integer not null default 0,
  vindue_start_kl          timestamptz,
  laast_til_kl             timestamptz,   -- midlertidig laas (5 forkerte pr. time)
  laast_kl                 timestamptz,   -- permanent laas (15 forkerte i alt)
  -- Cron: ikke hentet efter 7 dage -> markeret til staff.
  ikke_hentet_markeret_kl  timestamptz
);

comment on table public.afhentninger is
  'Afhentningskoder for handler med kun afhentning. Ingen adgang for brugere: '
  'koden returneres kun til koeberen via afhentning_vis_kode, og saelgeren '
  'indtaster den via afhentning_bekraeft. Raekker slettes aldrig.';

alter table public.afhentninger enable row level security;
-- Ingen policies: anon/authenticated kan hverken laese eller skrive.
revoke all on public.afhentninger from public, anon, authenticated;
grant all on public.afhentninger to service_role;

create or replace function public.afhentninger_forbyd_sletning()
returns trigger language plpgsql as $fn$
begin
  raise exception 'afhentninger_slettes_aldrig';
end;
$fn$;

revoke all on function public.afhentninger_forbyd_sletning() from public, anon, authenticated;

drop trigger if exists afhentninger_forbyd_sletning_trg on public.afhentninger;
create trigger afhentninger_forbyd_sletning_trg
  before delete on public.afhentninger
  for each row execute function public.afhentninger_forbyd_sletning();

-- ============================================================ 3. kode

-- Kryptografisk tilfaeldig 6-cifret kode. gen_random_uuid() bruger
-- PostgreSQL's staerke tilfaeldighedskilde (pg_strong_random); de foerste 12
-- hex-tegn i en v4-uuid er 48 tilfaeldige bits. Skaevheden ved modulo 10^6
-- er under 1:10^8 og uden betydning. Ingen afhaengighed af pgcrypto.
create or replace function public.afhentning_ny_kode()
returns text
language sql
volatile
set search_path = public
as $fn$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint
                % 1000000))::text, 6, '0');
$fn$;

revoke all on function public.afhentning_ny_kode() from public, anon, authenticated;

-- Opretter koden for en betalt afhentningshandel. Idempotent.
create or replace function public.afhentning_sikr_kode(p_trade uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  insert into public.afhentninger (trade_id, kode)
  select t.id, public.afhentning_ny_kode()
    from public.trades t
   where t.id = p_trade and t.afhentning
  on conflict (trade_id) do nothing;
end;
$fn$;

revoke all on function public.afhentning_sikr_kode(uuid) from public, anon, authenticated;

-- Koden genereres, naar betalingen er modtaget.
create or replace function public.trades_afhentning_kode()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.afhentning
     and new.status = 'betaling_modtaget'
     and old.status is distinct from 'betaling_modtaget' then
    perform public.afhentning_sikr_kode(new.id);
  end if;
  return null;
end;
$fn$;

revoke all on function public.trades_afhentning_kode() from public, anon, authenticated;

drop trigger if exists trades_afhentning_kode on public.trades;
create trigger trades_afhentning_kode
  after update of status on public.trades
  for each row execute function public.trades_afhentning_kode();

-- Allerede betalte afhentningshandler faar en kode nu.
insert into public.afhentninger (trade_id, kode)
select t.id, public.afhentning_ny_kode()
  from public.trades t
 where t.afhentning and t.status = 'betaling_modtaget'
on conflict (trade_id) do nothing;

-- ============================================================ 4. send pakke

-- Som 20261003010000, men afviser afhentningshandler (der sendes ingen pakke).
create or replace function public.trade_marker_sendt(p_trade uuid, p_tracking text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder   uuid := auth.uid();
  tracking text := nullif(btrim(p_tracking), '');
begin
  if kalder is null or tracking is null or char_length(tracking) > 100 then
    return false;
  end if;

  update public.trades
     set status = 'pakke_sendt',
         tracking_number = tracking,
         sendt_kl = coalesce(sendt_kl, now())
   where id = p_trade
     and seller_id = kalder
     and status = 'betaling_modtaget'
     and not afhentning;

  return found;
end;
$fn$;

revoke execute on function public.trade_marker_sendt(uuid, text) from public, anon;
grant execute on function public.trade_marker_sendt(uuid, text) to authenticated;

-- ============================================================ 5a. info

-- Status for handelssiden. Kun koeber og saelger. Koden returneres KUN til
-- koeberen og kun, naar han allerede har faaet den vist (dvs. har bedoemt).
-- Returnerer null, hvis kalderen ikke er part, eller handlen ikke er en
-- afhentningshandel.
-- { vist, bekraeftet, laast, laast_til, kode? }
create or replace function public.afhentning_info(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  kalder uuid := auth.uid();
  t      record;
  a      record;
begin
  if kalder is null then return null; end if;

  select * into t from public.trades
   where id = p_trade and afhentning and kalder in (buyer_id, seller_id);
  if not found then return null; end if;

  select * into a from public.afhentninger where trade_id = p_trade;

  return jsonb_build_object(
    'vist',       a.vist_kl is not null,
    'bekraeftet', a.bekraeftet_kl is not null,
    'laast',      a.laast_kl is not null,
    'laast_til',  case when a.laast_til_kl > now() then a.laast_til_kl end,
    'kode',       case when kalder = t.buyer_id and a.vist_kl is not null
                       then a.kode end);
end;
$fn$;

revoke all on function public.afhentning_info(uuid) from public, anon;
grant execute on function public.afhentning_info(uuid) to authenticated;

-- ============================================================ 5b. vis kode

-- Koeberen giver saelgeren 1-5 stjerner (+ valgfri kommentar) og faar koden
-- vist. Bedoemmelsen gemmes kun foerste gang (samme regler som
-- handel_godkend_med_bedoemmelse). Senere kald returnerer koden igen uden ny
-- bedoemmelse - stjerner/kommentar ignoreres da.
-- Returnerer { kode: 'ok', afhentningskode } eller { kode: <fejl> }:
--   ikke_logget_ind, ugyldige_stjerner, kommentar_for_lang,
--   ikke_mulig (ikke koeber, ikke afhentning, ikke betalt, refusion,
--   indsigelse, sag, allerede frigivet/hentet)
create or replace function public.afhentning_vis_kode(
  p_trade uuid, p_stjerner int, p_kommentar text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder      uuid := auth.uid();
  b           record;
  t           record;
  a           record;
  v_kommentar text := nullif(btrim(coalesce(p_kommentar, '')), '');
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;

  -- Laaseraekkefoelge: betaling, handel, afhentning.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.frigivet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or public.sag_holder_pengene(p_trade) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into t from public.trades where id = p_trade for update;
  if not found
     or t.buyer_id <> kalder
     or t.seller_id = kalder
     or not t.afhentning
     or t.status <> 'betaling_modtaget'
     or coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  perform public.afhentning_sikr_kode(p_trade);
  select * into a from public.afhentninger where trade_id = p_trade for update;

  if a.vist_kl is not null then
    -- Allerede bedoemt: koden igen, ingen ny bedoemmelse.
    return jsonb_build_object('kode', 'ok', 'afhentningskode', a.kode);
  end if;

  if p_stjerner is null or p_stjerner < 1 or p_stjerner > 5 then
    return jsonb_build_object('kode', 'ugyldige_stjerner');
  end if;
  if v_kommentar is not null and char_length(v_kommentar) > 1000 then
    return jsonb_build_object('kode', 'kommentar_for_lang');
  end if;
  -- Links er tilladt i kommentarer (Filips beslutning 2026-10-03).

  update public.afhentninger
     set vist_kl = now()
   where trade_id = p_trade and vist_kl is null;
  if not found then
    return jsonb_build_object('kode', 'ok', 'afhentningskode', a.kode);
  end if;

  -- Bedoemmelsen: altid fra koeberen til handlens saelger, een pr. handel.
  insert into public.ratings
    (fra_bruger_id, til_bruger_id, auktion_id, trade_id, stjerner, kommentar)
  values
    (kalder, t.seller_id, t.auction_id, t.id, p_stjerner::smallint, v_kommentar)
  on conflict do nothing;

  return jsonb_build_object('kode', 'ok', 'afhentningskode', a.kode);
end;
$fn$;

revoke all on function public.afhentning_vis_kode(uuid, int, text) from public, anon;
grant execute on function public.afhentning_vis_kode(uuid, int, text) to authenticated;

-- ============================================================ 5c. bekraeft

-- Saelgeren indtaster koeberens kode. Rigtig kode: handlen 'leveret',
-- received_at og betalinger.frigivet_kl saettes (samme sti som
-- handel_godkend / admin_frigiv_handel). Serveren overfoerer derefter med
-- overfoerTilSaelger. Idempotent: statusskiftet sker i samme update som
-- statuskontrollen.
-- Returnerer { kode, tilbage? , laast_til? }:
--   ok, ikke_logget_ind, ugyldig_kode (ikke 6 cifre - taeller ikke),
--   ikke_mulig, ikke_vist (koeberen har ikke hentet koden frem endnu),
--   forkert (tilbage = forsoeg tilbage i denne time),
--   laast_midlertidigt (laast_til), laast (permanent - kontakt BidHamr)
create or replace function public.afhentning_bekraeft(p_trade uuid, p_kode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder   uuid := auth.uid();
  v_kode   text := regexp_replace(coalesce(p_kode, ''), '\s', '', 'g');
  b        record;
  t        record;
  a        record;
  v_vindue integer;
  v_i_alt  integer;
  v_tekst  text;
  maks_pr_time constant integer := 5;
  maks_i_alt   constant integer := 15;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if v_kode !~ '^[0-9]{6}$' then return jsonb_build_object('kode', 'ugyldig_kode'); end if;

  -- Laaseraekkefoelge: betaling, handel, afhentning.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.frigivet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or public.sag_holder_pengene(p_trade) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into t from public.trades where id = p_trade for update;
  if not found
     or t.seller_id <> kalder
     or not t.afhentning
     or t.status <> 'betaling_modtaget'
     or coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into a from public.afhentninger where trade_id = p_trade for update;
  if not found or a.vist_kl is null then
    return jsonb_build_object('kode', 'ikke_vist');
  end if;
  if a.laast_kl is not null then
    return jsonb_build_object('kode', 'laast');
  end if;
  if a.laast_til_kl is not null and a.laast_til_kl > now() then
    return jsonb_build_object('kode', 'laast_midlertidigt', 'laast_til', a.laast_til_kl);
  end if;

  if v_kode <> a.kode then
    -- Nyt vindue, hvis det gamle er over en time gammelt.
    if a.vindue_start_kl is null or a.vindue_start_kl < now() - interval '1 hour' then
      v_vindue := 1;
      update public.afhentninger set vindue_start_kl = now() where trade_id = p_trade;
    else
      v_vindue := a.forkerte_forsoeg_vindue + 1;
    end if;
    v_i_alt := a.forkerte_forsoeg_i_alt + 1;

    update public.afhentninger
       set forkerte_forsoeg_vindue = v_vindue,
           forkerte_forsoeg_i_alt = v_i_alt,
           laast_til_kl = case when v_vindue >= maks_pr_time
                               then coalesce(vindue_start_kl, now()) + interval '1 hour'
                               else laast_til_kl end,
           laast_kl = case when v_i_alt >= maks_i_alt then now() else laast_kl end
     where trade_id = p_trade
    returning * into a;

    if a.laast_kl is not null or v_vindue >= maks_pr_time then
      v_tekst := case when a.laast_kl is not null
        then 'Afhentningskode: låst efter ' || v_i_alt || ' forkerte forsøg'
        else 'Afhentningskode: ' || v_vindue || ' forkerte forsøg inden for en time' end;
      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                    and position(v_tekst in sidste_fejl) = 0
                 then sidste_fejl || ' · ' || v_tekst
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl
               else v_tekst end, 500),
             opdateret = now()
       where id = b.id;
    end if;

    if a.laast_kl is not null then
      return jsonb_build_object('kode', 'laast');
    end if;
    if v_vindue >= maks_pr_time then
      return jsonb_build_object('kode', 'laast_midlertidigt', 'laast_til', a.laast_til_kl);
    end if;
    return jsonb_build_object('kode', 'forkert', 'tilbage', maks_pr_time - v_vindue);
  end if;

  -- Rigtig kode: frigiv.
  update public.trades
     set status = 'leveret',
         received_at = coalesce(received_at, now())
   where id = p_trade
     and seller_id = kalder
     and afhentning
     and status = 'betaling_modtaget'
     and not coalesce(sag_aaben, false);
  if not found then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where id = b.id and frigivet_kl is null;

  update public.afhentninger
     set bekraeftet_kl = now()
   where trade_id = p_trade and bekraeftet_kl is null;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.afhentning_bekraeft(uuid, text) from public, anon;
grant execute on function public.afhentning_bekraeft(uuid, text) to authenticated;

-- ============================================================ 6. ikke hentet

-- Cron. Afhentningshandler, der er betalt for over 7 dage siden og stadig
-- ikke er hentet (koden ikke bekraeftet), markeres til staff. Ingen penge
-- flyttes - staff kontakter parterne og frigiver eller refunderer.
-- Een gang pr. handel (afhentninger.ikke_hentet_markeret_kl).
create or replace function public.afhentning_marker_ikke_hentet()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  antal integer;
  tekst constant text := 'Afhentning ikke gennemført efter 7 dage';
begin
  -- Sikkerhedsnet: alle betalte afhentningshandler har en raekke.
  insert into public.afhentninger (trade_id, kode)
  select t.id, public.afhentning_ny_kode()
    from public.trades t
   where t.afhentning and t.status = 'betaling_modtaget'
     and not exists (select 1 from public.afhentninger a where a.trade_id = t.id)
  on conflict (trade_id) do nothing;

  with markerede as (
    update public.afhentninger a
       set ikke_hentet_markeret_kl = now()
      from public.trades t, public.betalinger b
     where t.id = a.trade_id
       and b.trade_id = t.id
       and t.afhentning
       and t.status = 'betaling_modtaget'
       and a.bekraeftet_kl is null
       and a.ikke_hentet_markeret_kl is null
       and b.status = 'betalt'
       and b.frigivet_kl is null
       and b.refusion_anmodet_kl is null
       and b.betalt_kl < now() - interval '7 days'
    returning a.trade_id
  )
  update public.betalinger b
     set kraever_opmaerksomhed = true,
         sidste_fejl = left(case
           when b.kraever_opmaerksomhed and b.sidste_fejl is not null
             then b.sidste_fejl || ' · ' || tekst
           else tekst end, 500),
         opdateret = now()
    from markerede m
   where b.trade_id = m.trade_id;
  get diagnostics antal = row_count;
  return antal;
end;
$fn$;

revoke all on function public.afhentning_marker_ikke_hentet() from public, anon, authenticated;
grant execute on function public.afhentning_marker_ikke_hentet() to service_role;
