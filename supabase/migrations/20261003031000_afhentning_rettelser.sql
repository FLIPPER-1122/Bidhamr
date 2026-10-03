-- Afhentning: reviewer-rettelser til 20261003030000_afhentning.sql.
-- Koeres EFTER 20261003030000. Idempotent.
--
-- AEndringer:
--   A. afhentninger: nye kolonner bedoemmelse_stjerner, bedoemmelse_kommentar
--      (koeberens bedoemmelse, gemt indtil afhentningen er bekraeftet) og
--      annulleret_kl (raekker paa handler, der viste sig ikke at vaere
--      afhentningshandler - neutraliseres, slettes aldrig).
--   B. trades_saet_afhentning: flaget kan nu - og kun - gaa fra true til
--      false, naar handlen beviseligt sendes (betalingen har fragt_oere > 0
--      eller handlen har et sporingsnummer). false -> true er stadig umuligt.
--      Saa kan trades.afhentning og betalinger.fragt_oere aldrig vaere uenige.
--   C. Korrektion af backfillet i 030000 (linje 57-62). auctions.
--      forsendelse_mulig har default false, saa backfillet markerede gamle
--      forsendelseshandler som afhentning. afhentning saettes til false for
--      handler med afhentning = true, hvor MINDST EN af disse gaelder:
--        1. handlens betaling har fragt_oere > 0 (uanset status),
--        2. trades.tracking_number er udfyldt (uanset status),
--        3. status er 'pakke_sendt' eller 'modtaget' (kun forsendelsesflowet
--           kan naa dertil),
--        4. status er 'leveret' eller 'afsluttet', og handlen har ingen
--           afhentninger-raekke med vist_kl (dvs. den er ikke gennemfoert med
--           en afhentningskode).
--      Handler i afventer_betaling/betaling_modtaget/annulleret paa en
--      kun-afhentning-auktion uden fragt og uden sporingsnummer roeres ikke.
--      Triggeren slaas midlertidigt fra i en DO-blok (een saetning: fejler
--      noget, rulles det hele tilbage, og triggeren er aldrig slaaet fra).
--   D. afhentninger-raekker paa handler, der ikke laengere er afhentnings-
--      handler, og som ikke er bekraeftet, faar annulleret_kl. Alle
--      funktionerne kraever i forvejen t.afhentning, og flaget kan ikke blive
--      true igen, saa koden kan ikke bruges.
--   E. BidHamr Beskyttelse paa kun-afhentning (kan aldrig bruges, da
--      afhentningshandler ikke kan faa sager):
--        - bids: beskyttelse tvinges til false ved insert, naar auktionen ikke
--          tilbyder forsendelse,
--        - andenchance_tilbud: samme ved insert; aabne tilbud rettes,
--        - betalinger: ved insert paa en afhentningshandel med fragt 0
--          tvinges beskyttelse = false / beskyttelse_oere = 0, og total_oere
--          nedsaettes med praecis beskyttelse_oere (bud, gebyrer, fragt og
--          udbetaling er uaendrede),
--        - eksisterende ubetalte betalinger (status 'afventer', ingen
--          PaymentIntent endnu) paa afhentningshandler rettes paa samme
--          maade. Betalinger med PaymentIntent roeres ikke (se forespoergsel
--          nedenfor) - de skal ses af staff.
--      Efter insert af en betaling med fragt_oere > 0 saettes
--      trades.afhentning = false (jf. B).
--   F. afhentning_info: koden returneres kun, mens handlen er
--      'betaling_modtaget'.
--   G. afhentning_vis_kode: gemmer stjerner/kommentar i afhentninger - ingen
--      insert i ratings. Foerste valg gaelder.
--   H. afhentning_bekraeft: indsaetter bedoemmelsen i ratings ved rigtig kode
--      i samme transaktion som frigivelsen (on conflict do nothing).
--      Gennemfoeres handlen aldrig, offentliggoeres ingen bedoemmelse.
--   I. afhentning_marker_ikke_hentet: laaser betaling -> handel -> afhentning
--      raekke for raekke (samme raekkefoelge som afhentning_bekraeft).
--
-- ---------------------------------------------------------------------------
-- LAESE-FORESPOERGSEL til produktion (FOER 030000/031000 er koert - bruger
-- kun kolonner, der findes i forvejen). Viser handler paa kun-afhentning-
-- auktioner og om de rammes af korrektionen (kolonnen rammes):
--
--   select t.id, t.status, t.tracking_number, b.fragt_oere, b.beskyttelse,
--          b.beskyttelse_oere, b.status as betaling_status,
--          b.stripe_payment_intent_id is not null as har_pi,
--          (coalesce(b.fragt_oere, 0) > 0
--           or t.tracking_number is not null
--           or t.status in ('pakke_sendt', 'modtaget', 'leveret', 'afsluttet'))
--            as rammes
--     from public.trades t
--     join public.auctions a on a.id = t.auction_id
--     left join public.betalinger b on b.trade_id = t.id
--    where not coalesce(a.forsendelse_mulig, false)
--    order by t.created_at;
--
-- (Foer 030000 findes ingen afhentninger-raekker, saa betingelse 4 er
-- "status leveret/afsluttet".) Efter 030000, foer 031000:
--
--   select t.id, t.status, t.tracking_number, b.fragt_oere,
--          af.vist_kl, af.bekraeftet_kl
--     from public.trades t
--     left join public.betalinger b on b.trade_id = t.id
--     left join public.afhentninger af on af.trade_id = t.id
--    where t.afhentning
--      and (coalesce(b.fragt_oere, 0) > 0
--           or t.tracking_number is not null
--           or t.status in ('pakke_sendt', 'modtaget')
--           or (t.status in ('leveret', 'afsluttet')
--               and not exists (select 1 from public.afhentninger x
--                                where x.trade_id = t.id and x.vist_kl is not null)));
--
-- Ubetalte betalinger med BidHamr Beskyttelse paa kun-afhentning, som IKKE
-- rettes automatisk (har allerede en PaymentIntent):
--
--   select b.id, b.trade_id, b.status, b.beskyttelse_oere, b.total_oere
--     from public.betalinger b
--     join public.auctions a on a.id = b.auction_id
--    where not coalesce(a.forsendelse_mulig, false)
--      and b.fragt_oere = 0 and b.beskyttelse
--      and b.stripe_payment_intent_id is not null;
-- ---------------------------------------------------------------------------

-- ============================================================ A. kolonner

alter table public.afhentninger
  add column if not exists bedoemmelse_stjerner smallint
    check (bedoemmelse_stjerner between 1 and 5),
  add column if not exists bedoemmelse_kommentar text,
  add column if not exists annulleret_kl timestamptz;

comment on column public.afhentninger.bedoemmelse_stjerner is
  'Koeberens stjerner til saelgeren, givet da koden blev vist. Offentliggoeres '
  '(insert i ratings) foerst, naar saelgeren har indtastet koden.';
comment on column public.afhentninger.bedoemmelse_kommentar is
  'Koeberens valgfri kommentar. Offentliggoeres sammen med stjernerne.';
comment on column public.afhentninger.annulleret_kl is
  'Handlen viste sig ikke at vaere en afhentningshandel (fx fragt betalt). '
  'Raekken er inaktiv og bruges ikke.';

-- Raekker, hvor 030000 allerede har indsat bedoemmelsen i ratings (kun
-- testdatabasen): stjernerne kopieres, saa foerste valg ogsaa gaelder her.
update public.afhentninger af
   set bedoemmelse_stjerner  = r.stjerner,
       bedoemmelse_kommentar = r.kommentar
  from public.ratings r
 where r.trade_id = af.trade_id
   and af.vist_kl is not null
   and af.bedoemmelse_stjerner is null;

-- ============================================================ B. trigger

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
  elsif old.afhentning
        and not coalesce(new.afhentning, true)
        and (new.tracking_number is not null
             or exists (select 1 from public.betalinger b
                         where b.trade_id = new.id and b.fragt_oere > 0)) then
    -- Eneste tilladte aendring: true -> false, naar handlen beviseligt
    -- sendes (fragt betalt eller sporingsnummer).
    new.afhentning := false;
  else
    -- Ellers kan flaget ikke aendres (og aldrig fra false til true).
    new.afhentning := old.afhentning;
  end if;
  return new;
end;
$fn$;

revoke all on function public.trades_saet_afhentning() from public, anon, authenticated;

-- ============================================================ C. korrektion

do $korrektion$
begin
  -- Kun i denne DO-blok (een saetning, een transaktion).
  alter table public.trades disable trigger trades_saet_afhentning;

  update public.trades t
     set afhentning = false
   where t.afhentning
     and (exists (select 1 from public.betalinger b
                   where b.trade_id = t.id and b.fragt_oere > 0)
          or t.tracking_number is not null
          or t.status in ('pakke_sendt', 'modtaget')
          or (t.status in ('leveret', 'afsluttet')
              and not exists (select 1 from public.afhentninger af
                               where af.trade_id = t.id and af.vist_kl is not null)));

  alter table public.trades enable trigger trades_saet_afhentning;
end;
$korrektion$;

-- ============================================================ D. neutralisér koder

update public.afhentninger af
   set annulleret_kl = now()
  from public.trades t
 where t.id = af.trade_id
   and not t.afhentning
   and af.annulleret_kl is null
   and af.bekraeftet_kl is null;

-- ============================================================ E. beskyttelse

-- Bud: BidHamr Beskyttelse kan ikke vaelges paa kun-afhentning.
create or replace function public.bids_beskyttelse_kun_afhentning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(new.beskyttelse, false)
     and not exists (select 1 from public.auctions a
                      where a.id = new.auktion_id
                        and coalesce(a.forsendelse_mulig, false)) then
    new.beskyttelse := false;
  end if;
  return new;
end;
$fn$;

revoke all on function public.bids_beskyttelse_kun_afhentning() from public, anon, authenticated;

drop trigger if exists bids_beskyttelse_kun_afhentning on public.bids;
create trigger bids_beskyttelse_kun_afhentning
  before insert on public.bids
  for each row execute function public.bids_beskyttelse_kun_afhentning();

-- Andenchance-tilbud: samme regel.
create or replace function public.andenchance_beskyttelse_kun_afhentning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(new.beskyttelse, false)
     and not exists (select 1 from public.auctions a
                      where a.id = new.auction_id
                        and coalesce(a.forsendelse_mulig, false)) then
    new.beskyttelse := false;
  end if;
  return new;
end;
$fn$;

revoke all on function public.andenchance_beskyttelse_kun_afhentning() from public, anon, authenticated;

drop trigger if exists andenchance_beskyttelse_kun_afhentning on public.andenchance_tilbud;
create trigger andenchance_beskyttelse_kun_afhentning
  before insert on public.andenchance_tilbud
  for each row execute function public.andenchance_beskyttelse_kun_afhentning();

update public.andenchance_tilbud x
   set beskyttelse = false
  from public.auctions a
 where a.id = x.auction_id
   and x.status = 'afventer'
   and x.beskyttelse
   and not coalesce(a.forsendelse_mulig, false);

-- Betaling: en afhentningshandel (fragt 0) faar aldrig BidHamr Beskyttelse.
-- total_oere nedsaettes med praecis beskyttelse_oere; intet andet aendres,
-- saa betalinger_total_stemmer (total = bud + koeb + fragt + besk) holder.
create or replace function public.betalinger_beskyttelse_kun_afhentning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if (new.beskyttelse or new.beskyttelse_oere <> 0)
     and new.fragt_oere = 0
     and exists (select 1 from public.trades t
                  where t.id = new.trade_id and t.afhentning) then
    new.total_oere       := new.total_oere - new.beskyttelse_oere;
    new.beskyttelse      := false;
    new.beskyttelse_oere := 0;
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_beskyttelse_kun_afhentning() from public, anon, authenticated;

drop trigger if exists betalinger_beskyttelse_kun_afhentning on public.betalinger;
create trigger betalinger_beskyttelse_kun_afhentning
  before insert on public.betalinger
  for each row execute function public.betalinger_beskyttelse_kun_afhentning();

-- Betaling med fragt: handlen er ikke en afhentningshandel (jf. B).
create or replace function public.betalinger_fragt_ikke_afhentning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.fragt_oere > 0 then
    update public.trades
       set afhentning = false
     where id = new.trade_id and afhentning;
  end if;
  return null;
end;
$fn$;

revoke all on function public.betalinger_fragt_ikke_afhentning() from public, anon, authenticated;

drop trigger if exists betalinger_fragt_ikke_afhentning on public.betalinger;
create trigger betalinger_fragt_ikke_afhentning
  after insert on public.betalinger
  for each row execute function public.betalinger_fragt_ikke_afhentning();

-- Eksisterende ubetalte betalinger uden PaymentIntent paa afhentningshandler.
update public.betalinger b
   set total_oere       = b.total_oere - b.beskyttelse_oere,
       beskyttelse      = false,
       beskyttelse_oere = 0,
       opdateret        = now()
  from public.trades t
 where t.id = b.trade_id
   and t.afhentning
   and b.fragt_oere = 0
   and b.beskyttelse
   and b.status = 'afventer'
   and b.stripe_payment_intent_id is null;

-- ============================================================ F. info

-- Som 030000, men koden returneres kun, mens handlen er 'betaling_modtaget'
-- (og raekken ikke er annulleret).
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
    'kode',       case when kalder = t.buyer_id
                        and a.vist_kl is not null
                        and a.annulleret_kl is null
                        and t.status = 'betaling_modtaget'
                       then a.kode end);
end;
$fn$;

revoke all on function public.afhentning_info(uuid) from public, anon;
grant execute on function public.afhentning_info(uuid) to authenticated;

-- ============================================================ G. vis kode

-- Koeberen giver saelgeren 1-5 stjerner (+ valgfri kommentar) og faar koden
-- vist. Bedoemmelsen GEMMES i afhentninger og offentliggoeres foerst i
-- afhentning_bekraeft, naar saelgeren har indtastet koden. Foerste valg
-- gaelder: senere kald returnerer koden igen, og stjerner/kommentar ignoreres.
-- Returnerer { kode: 'ok', afhentningskode } eller { kode: <fejl> }:
--   ikke_logget_ind, ugyldige_stjerner, kommentar_for_lang,
--   ikke_mulig (ikke koeber, ikke afhentning, ikke betalt, refusion,
--   indsigelse, sag, allerede frigivet/hentet, annulleret)
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
  if not found or a.annulleret_kl is not null then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  if a.vist_kl is not null then
    -- Allerede bedoemt: koden igen. Stjernerne kan ikke aendres.
    return jsonb_build_object('kode', 'ok', 'afhentningskode', a.kode);
  end if;

  if p_stjerner is null or p_stjerner < 1 or p_stjerner > 5 then
    return jsonb_build_object('kode', 'ugyldige_stjerner');
  end if;
  if v_kommentar is not null and char_length(v_kommentar) > 1000 then
    return jsonb_build_object('kode', 'kommentar_for_lang');
  end if;
  -- Links er tilladt i kommentarer (Filips beslutning 2026-10-03).

  -- Bedoemmelsen gemmes sammen med vist_kl i samme update - kun foerste gang.
  update public.afhentninger
     set vist_kl               = now(),
         bedoemmelse_stjerner  = p_stjerner::smallint,
         bedoemmelse_kommentar = v_kommentar
   where trade_id = p_trade and vist_kl is null;

  return jsonb_build_object('kode', 'ok', 'afhentningskode', a.kode);
end;
$fn$;

revoke all on function public.afhentning_vis_kode(uuid, int, text) from public, anon;
grant execute on function public.afhentning_vis_kode(uuid, int, text) to authenticated;

-- ============================================================ H. bekraeft

-- Som 030000. Nyt: annullerede raekker afvises, og ved rigtig kode
-- offentliggoeres koeberens gemte bedoemmelse (insert i ratings) i samme
-- transaktion som frigivelsen.
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
  if found and a.annulleret_kl is not null then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;
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

  -- Bedoemmelsen offentliggoeres nu, hvor afhentningen er gennemfoert:
  -- altid fra handlens koeber til handlens saelger (aldrig fra kalderen, som
  -- her er saelgeren). Statusskiftet ovenfor sker kun een gang, saa et
  -- dobbeltklik naar aldrig hertil to gange.
  if a.bedoemmelse_stjerner is not null and t.buyer_id <> t.seller_id then
    insert into public.ratings
      (fra_bruger_id, til_bruger_id, auktion_id, trade_id, stjerner, kommentar)
    values
      (t.buyer_id, t.seller_id, t.auction_id, t.id,
       a.bedoemmelse_stjerner, a.bedoemmelse_kommentar)
    on conflict do nothing;
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.afhentning_bekraeft(uuid, text) from public, anon;
grant execute on function public.afhentning_bekraeft(uuid, text) to authenticated;

-- ============================================================ I. ikke hentet

-- Som 030000, men hver handel behandles for sig og laases i samme
-- raekkefoelge som afhentning_bekraeft (betaling -> handel -> afhentning),
-- saa cron og saelgerens bekraeftelse ikke kan deadlocke. Fejler en handel,
-- springes den over (subtransaktion), og resten behandles.
create or replace function public.afhentning_marker_ikke_hentet()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  antal integer := 0;
  tekst constant text := 'Afhentning ikke gennemført efter 7 dage';
  r     record;
  b     record;
  t     record;
  a     record;
begin
  -- Sikkerhedsnet: alle betalte afhentningshandler har en raekke.
  insert into public.afhentninger (trade_id, kode)
  select t2.id, public.afhentning_ny_kode()
    from public.trades t2
   where t2.afhentning and t2.status = 'betaling_modtaget'
     and not exists (select 1 from public.afhentninger x where x.trade_id = t2.id)
  on conflict (trade_id) do nothing;

  -- Kandidater (uden laase). Tjekkes igen under laas nedenfor.
  for r in
    select af.trade_id
      from public.afhentninger af
      join public.trades t2 on t2.id = af.trade_id
      join public.betalinger b2 on b2.trade_id = af.trade_id
     where t2.afhentning
       and t2.status = 'betaling_modtaget'
       and af.bekraeftet_kl is null
       and af.ikke_hentet_markeret_kl is null
       and af.annulleret_kl is null
       and b2.status = 'betalt'
       and b2.frigivet_kl is null
       and b2.refusion_anmodet_kl is null
       and b2.betalt_kl < now() - interval '7 days'
  loop
    begin
      select * into b from public.betalinger where trade_id = r.trade_id for update;
      if not found
         or b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or not (b.betalt_kl < now() - interval '7 days') then
        continue;
      end if;

      select * into t from public.trades where id = r.trade_id for update;
      if not found or not t.afhentning or t.status <> 'betaling_modtaget' then
        continue;
      end if;

      select * into a from public.afhentninger where trade_id = r.trade_id for update;
      if not found
         or a.bekraeftet_kl is not null
         or a.ikke_hentet_markeret_kl is not null
         or a.annulleret_kl is not null then
        continue;
      end if;

      update public.afhentninger
         set ikke_hentet_markeret_kl = now()
       where trade_id = r.trade_id and ikke_hentet_markeret_kl is null;
      if not found then continue; end if;

      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl || ' · ' || tekst
               else tekst end, 500),
             opdateret = now()
       where id = b.id;

      antal := antal + 1;
    exception when others then
      raise warning 'afhentning_marker_ikke_hentet fejlede for handel %: %', r.trade_id, sqlerrm;
    end;
  end loop;

  return antal;
end;
$fn$;

revoke all on function public.afhentning_marker_ikke_hentet() from public, anon, authenticated;
grant execute on function public.afhentning_marker_ikke_hentet() to service_role;
