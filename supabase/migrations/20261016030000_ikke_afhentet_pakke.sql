-- Ikke-afhentet pakke (ROADMAP fase 2; ROADMAP-BESLUTNINGER afsnit 1
-- "Ikke-afhentet pakke (model 3)").
--
-- Fragtfirmaet sender pakken retur til sælgeren, når køberen ikke henter den
-- (DAO/GLS: 7 dage i pakkeshoppen). Beslutningen:
--   - Sælgeren beholder varen og får dækket sin fragt (han betaler hverken
--     fragten ud eller retur; der udbetales intet til ham).
--   - Køberen refunderes købsbeløbet MINUS gebyrer og fragt begge veje:
--       R = total - købergebyr - BidHamr Beskyttelse - fragt - returfragt
--         = bud - returfragt   (total = bud + købergebyr + fragt + Beskyttelse)
--     aldrig under 0 (Filip, 10. okt. 2026: er returfragten mindst buddet,
--     får køberen 0 kr. og skylder intet; sælgerens del tilbageføres stadig
--     helt automatisk, og BidHamr dækker resten af returfragten).
--   - Afhentning udløser aldrig udbetaling; kun købers bekræftelse eller 48
--     timer uden sag gør det. En returneret pakke frigives derfor aldrig
--     automatisk (handel_auto_frigiv nedenfor).
--   - Køberen kan ikke oprette en sag (handlen annulleres).
--
-- Returfragten (Filip, 10. okt. 2026): samme beløb som den fragt, køberen
-- betalte ud (betalinger.fragt_oere). p_returfragt_oere findes kun til
-- test/fremtidig brug - kalderne i koden sender den ikke.
--
-- Indhold:
--   0. Forudsætninger og md5-drift-tjek af de 4 funktioner, der genoprettes.
--   1. handel_ikke_afhentet: hændelsen "returneret - ikke afhentet" (én pr.
--      handel, låste beløb, kan aldrig ændres eller slettes - handelsdata).
--   2. handel_ikke_afhentet_registrer: adapter-neutral funktion, som både
--      fragtens webhook/cron (kilde 'fragt') og staff (kilde 'staff', med
--      begrundelse) kalder. Idempotent: et nyt kald svarer 'allerede'.
--      Låser betaling og handel, annullerer handlen og claimer refusionen
--      (refusion_aarsag 'ikke_afhentet', refusion_oere = R).
--   3. betaling_refusionsplan: R må være mindre end sælgerens del U, når
--      årsagen er 'ikke_afhentet'. Planen er stadig eksakt (S + G = R):
--        S = min(U, R)  (det, sælgerens konto bidrager med til refusionen)
--        G = R - S      (BidHamrs gebyr-refusion, >= 0)
--      og tilbageførslen fra sælgerens konto er U + G, så sælgeren altid
--      står med 0 (U + G - (U + G)). Er R < U, beholder platformen U - R
--      af sælgerens del (= returfragten minus sælgergebyret). For alle andre
--      årsager er S = U som før (uændret adfærd).
--   4. handel_auto_frigiv: frigiver aldrig en handel, hvor den udgående pakke
--      er meldt returneret (heller ikke efter 48 t/14 dage).
--   5. fakturaer.slags + faktura_planlaeg: ved ikke-afhentet krediteres
--      KUN sælgerens faktura (sælgergebyret - sælgeren fik intet).
--      Købers faktura (købergebyr, fragt, Beskyttelse) står uændret, og
--      returfragten, der trækkes fra refusionen, faktureres køberen på en
--      ny faktura (slags 'returfragt', konto for fragt).
--   6. dac7_salg: en handel med ikke-afhentet pakke tæller aldrig som salg.
--   7. moderation_log: handling 'handel_ikke_afhentet'.
--
-- Idempotent (kan køres igen). Kun testdatabasen indtil Filip siger ja.

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Forudsætninger og drift-tjek
-- ===========================================================================
do $do$
declare
  r record;
  h text;
begin
  if to_regclass('public.forsendelser') is null or to_regclass('public.fakturaer') is null
     or to_regprocedure('public.betaling_refusionsplan(uuid,uuid)') is null
     or to_regprocedure('public.dac7_salg(integer,uuid)') is null then
    raise exception 'Forudsætning mangler: fragt (20261006010000), refusionsplan (20261011040000), fakturaer (20261012080000) og DAC7 (20261014010000) skal være kørt først';
  end if;

  -- md5 af den normaliserede krop: repoets seneste version (gammel) eller
  -- denne migrations version (ny - så filen kan køres igen). Beregnet med
  -- samme normalisering som 20261011030000 ud fra repoets filer
  -- (handel_auto_frigiv: 20261003011000 + trin 1's rettelser på stedet).
  for r in
    select * from (values
      ('public.betaling_refusionsplan(uuid,uuid)',
       '795e94c093b681f5c80636d5fdef942d', '4f0c6ac7face8b4fb52b42f56020af90'),
      ('public.faktura_planlaeg(integer)',
       'd5a5c3eff0c84de032345f51e2b1a280', 'bfbdedf311ba334efd676cf3ba5a59e7'),
      ('public.handel_auto_frigiv()',
       'd15efc91893d30200360aca5db9aa336', '52bab8ddd30985f672fe60bb380acd97'),
      ('public.dac7_salg(integer,uuid)',
       '919c43ef629f6ff9d8a2ec15dccb295d', 'c3c37f9a49953460381c377274cbd4f8')
    ) as v(fn, gammel, ny)
  loop
    select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
      into h
      from pg_proc p where p.oid = r.fn::regprocedure;
    if h = r.ny then
      raise notice '%: allerede rettet', r.fn;
    elsif h is distinct from r.gammel then
      raise exception '%: kroppen afviger fra repoets seneste version (md5 %) - kontrollér funktionen, før migrationen køres', r.fn, h;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 1. Hændelsen: returneret - ikke afhentet
-- ===========================================================================
create table if not exists public.handel_ikke_afhentet (
  trade_id          uuid primary key references public.trades(id) on delete restrict,
  betaling_id       uuid not null unique references public.betalinger(id) on delete restrict,
  -- Den udgående forsendelse, fragtfirmaet meldte retur (krævet fra fragt).
  forsendelse_id    uuid references public.forsendelser(id) on delete restrict,
  kilde             text not null,
  medarbejder_id    uuid references public.users(id) on delete restrict,
  -- Staffs begrundelse (krævet ved kilde 'staff'). Intern - vises ikke for parterne.
  begrundelse       text,
  -- Låste beløb (øre) fra betalingen, da hændelsen blev registreret.
  total_oere        bigint not null,
  koebergebyr_oere  bigint not null,
  beskyttelse_oere  bigint not null,
  fragt_oere        bigint not null,
  returfragt_oere   bigint not null,
  refusion_oere     bigint not null,
  registreret_kl    timestamptz not null default now(),
  constraint handel_ikke_afhentet_kilde_check check (kilde in ('fragt', 'staff')),
  constraint handel_ikke_afhentet_staff_check check (
    kilde <> 'staff' or (medarbejder_id is not null and begrundelse is not null)),
  constraint handel_ikke_afhentet_fragt_check check (kilde <> 'fragt' or forsendelse_id is not null),
  constraint handel_ikke_afhentet_begrundelse_check check (
    begrundelse is null or char_length(begrundelse) between 1 and 1000),
  constraint handel_ikke_afhentet_beloeb_check check (
    total_oere > 0 and koebergebyr_oere >= 0 and beskyttelse_oere >= 0 and fragt_oere >= 0
    and returfragt_oere >= 0 and refusion_oere >= 0
    and refusion_oere = greatest(0, total_oere - koebergebyr_oere - beskyttelse_oere - fragt_oere - returfragt_oere))
);

comment on table public.handel_ikke_afhentet is
  'Pakken blev ikke afhentet og er sendt retur til sælgeren (ROADMAP-BESLUTNINGER afsnit 1, model 3). Én pr. handel, sat af handel_ikke_afhentet_registrer (fragt eller staff). Køberen refunderes refusion_oere = total - købergebyr - Beskyttelse - fragt - returfragt. Kun service role. Kan aldrig ændres eller slettes (handelsdata).';

create index if not exists handel_ikke_afhentet_kl_idx on public.handel_ikke_afhentet (registreret_kl desc);

alter table public.handel_ikke_afhentet enable row level security;
revoke all on public.handel_ikke_afhentet from public, anon, authenticated;
grant all on public.handel_ikke_afhentet to service_role;

create or replace function public.handel_ikke_afhentet_uaendret()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'handel_ikke_afhentet kan ikke ændres eller slettes (handelsdata)';
end;
$fn$;

revoke all on function public.handel_ikke_afhentet_uaendret() from public, anon, authenticated;

drop trigger if exists handel_ikke_afhentet_uaendret on public.handel_ikke_afhentet;
create trigger handel_ikke_afhentet_uaendret
  before update or delete on public.handel_ikke_afhentet
  for each row execute function public.handel_ikke_afhentet_uaendret();
drop trigger if exists handel_ikke_afhentet_ingen_truncate on public.handel_ikke_afhentet;
create trigger handel_ikke_afhentet_ingen_truncate
  before truncate on public.handel_ikke_afhentet
  for each statement execute function public.handel_ikke_afhentet_uaendret();

-- refusion_oere = 0 er tilladt KUN ved ikke-afhentet pakke (R = 0: køberen
-- får intet, men sælgerens del tilbageføres). Ellers som før (> 0).
do $do$
begin
  if exists (select 1 from pg_constraint
              where conname = 'betalinger_refusion_oere_check' and conrelid = 'public.betalinger'::regclass
                and pg_get_constraintdef(oid) not like '%ikke_afhentet%') then
    alter table public.betalinger drop constraint betalinger_refusion_oere_check;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'betalinger_refusion_oere_check' and conrelid = 'public.betalinger'::regclass) then
    alter table public.betalinger add constraint betalinger_refusion_oere_check
      check (refusion_oere is null
             or (refusion_oere <= total_oere
                 and (refusion_oere > 0 or (refusion_oere = 0 and refusion_aarsag = 'ikke_afhentet'))));
  end if;
end $do$;

-- ===========================================================================
-- 2. Registrering (adapter-neutral)
-- ===========================================================================
-- p_kilde 'fragt': fragtfirmaet har meldt den udgående pakke retur
--   (p_forsendelse krævet: forsendelsen skal være handlens udgående, have
--   returneret_kl og ikke være leveret). Handlen skal stå i 'pakke_sendt'.
-- p_kilde 'staff': medarbejder/admin/chef markerer det manuelt med
--   begrundelse (ikke inhabil). Handlen må også stå i 'modtaget' (køberen
--   trykkede "modtaget" ved en fejl).
-- p_returfragt_oere: returfragten i øre. null = samme som fragten ud.
--
-- Kode:
--   ok        hændelsen er registreret, handlen annulleret og refusionen
--             claimet (refusion_oere > 0) - serveren refunderer nu
--   ok_intet  som ok, men R = 0 (returfragten er mindst buddet): køberen får
--             0 kr. og skylder intet (Filip, 10. okt. 2026). Sælgerens del
--             tilbageføres stadig helt automatisk (X = U) - uden refusion
--             til køberen (refusion_oere = 0, samme refusionsvej og lås)
--   allerede  registreret før (samme svar som ok/ok_intet - idempotent)
--   ingen_adgang, inhabil, begrundelse_mangler, ugyldig, ikke_fundet,
--   ingen_betaling, afhentning, forkert_status, gammel_model, ikke_betalt,
--   frigivet, udbetalt, refusion_i_gang, indsigelse, sag, markeret,
--   forsendelse_ukendt, leveret, ikke_returneret
create or replace function public.handel_ikke_afhentet_registrer(
  p_trade           uuid,
  p_kilde           text,
  p_medarbejder     uuid default null,
  p_begrundelse     text default null,
  p_forsendelse     uuid default null,
  p_returfragt_oere bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b        record;
  t        record;
  f        record;
  e        record;
  v_rolle  text;
  v_begr   text;
  v_retur  bigint;
  v_r      bigint;
  v_fors   uuid;
begin
  if p_trade is null or p_kilde is null or p_kilde not in ('fragt', 'staff') then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  v_begr := nullif(btrim(coalesce(p_begrundelse, '')), '');
  if p_kilde = 'staff' then
    if p_medarbejder is null then return jsonb_build_object('kode', 'ingen_adgang'); end if;
    select u.rolle into v_rolle from public.users u where u.id = p_medarbejder;
    if v_rolle is null or v_rolle not in ('medarbejder', 'admin', 'chef') then
      return jsonb_build_object('kode', 'ingen_adgang');
    end if;
    if v_begr is null then return jsonb_build_object('kode', 'begrundelse_mangler'); end if;
    if char_length(v_begr) > 1000 then return jsonb_build_object('kode', 'ugyldig'); end if;
  elsif p_forsendelse is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  -- Låserækkefølge: betaling, handel (som handel_auto_frigiv og fristerne).
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then
    if not exists (select 1 from public.trades where id = p_trade) then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    return jsonb_build_object('kode', 'ingen_betaling');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  -- Idempotent: allerede registreret (af fragt eller staff).
  select * into e from public.handel_ikke_afhentet where trade_id = p_trade;
  if found then
    return jsonb_build_object(
      'kode', 'allerede', 'betaling_id', e.betaling_id, 'trade_id', e.trade_id,
      'buyer_id', t.buyer_id, 'seller_id', t.seller_id, 'auction_id', t.auction_id,
      'refusion_oere', e.refusion_oere, 'returfragt_oere', e.returfragt_oere,
      'kilde', e.kilde, 'registreret_kl', e.registreret_kl);
  end if;

  if p_kilde = 'staff' and p_medarbejder in (t.buyer_id, t.seller_id) then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;
  if not (t.status = 'pakke_sendt' or (p_kilde = 'staff' and t.status = 'modtaget')) then
    return jsonb_build_object('kode', 'forkert_status');
  end if;

  -- Pengene: betalt, hverken frigivet, udbetalt eller under refusion, og
  -- ingen indsigelse eller sag, der afgør dem.
  if b.pengemodel is distinct from 'destination' then return jsonb_build_object('kode', 'gammel_model'); end if;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return jsonb_build_object('kode', 'ikke_betalt'); end if;
  if b.frigivet_kl is not null then return jsonb_build_object('kode', 'frigivet'); end if;
  if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  if b.refusion_anmodet_kl is not null or b.refunderet_kl is not null then
    return jsonb_build_object('kode', 'refusion_i_gang');
  end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or b.indsigelse_tilbagefoert_oere is not null then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if public.sag_holder_pengene(p_trade) then return jsonb_build_object('kode', 'sag'); end if;
  -- Staffs egen markering (sag_aaben) afgør staff selv - ikke fragten.
  if p_kilde = 'fragt' and coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'markeret');
  end if;

  -- Forsendelsen.
  if p_forsendelse is not null then
    select * into f from public.forsendelser
     where id = p_forsendelse and trade_id = p_trade and type = 'udgaaende';
    if not found then return jsonb_build_object('kode', 'forsendelse_ukendt'); end if;
    if p_kilde = 'fragt' then
      if f.leveret_kl is not null then return jsonb_build_object('kode', 'leveret'); end if;
      if f.returneret_kl is null then return jsonb_build_object('kode', 'ikke_returneret'); end if;
    end if;
    v_fors := f.id;
  else
    -- Staff uden forsendelse: den seneste udgående, der ikke er annulleret
    -- (kun som reference).
    select fo.id into v_fors from public.forsendelser fo
     where fo.trade_id = p_trade and fo.type = 'udgaaende' and fo.status not in ('annulleret', 'fejlet')
     order by fo.oprettet_kl desc limit 1;
  end if;

  -- Beløbene (øre). Returfragten kan aldrig være negativ eller over det betalte.
  v_retur := coalesce(p_returfragt_oere, b.fragt_oere);
  if v_retur is null or v_retur < 0 or v_retur > b.total_oere then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  v_r := greatest(0, b.total_oere - b.koebergebyr_oere - b.beskyttelse_oere - b.fragt_oere - v_retur);

  insert into public.handel_ikke_afhentet (
    trade_id, betaling_id, forsendelse_id, kilde, medarbejder_id, begrundelse,
    total_oere, koebergebyr_oere, beskyttelse_oere, fragt_oere, returfragt_oere, refusion_oere)
  values (
    p_trade, b.id, v_fors, p_kilde, case when p_kilde = 'staff' then p_medarbejder end,
    case when p_kilde = 'staff' then v_begr end,
    b.total_oere, b.koebergebyr_oere, b.beskyttelse_oere, b.fragt_oere, v_retur, v_r);

  -- Handlen lukkes (annulleret - arkiveres af oprydningen, når refusionen er
  -- gennemført). Ingen sag kan oprettes bagefter.
  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = p_trade;

  -- Refusionen er lovet: betalings-cron'en prøver altid igen
  -- (refunderLoveteVentende), til Stripe har gennemført den. R = 0 (Filip,
  -- 10. okt. 2026): samme vej, men kun tilbageførslen af sælgerens del
  -- (X = U) og ingen refusion til køberen (src/lib/betaling/refusion.ts,
  -- betaling_ikke_afhentet_uden_refusion).
  update public.betalinger
     set refusion_oere = v_r,
         refusion_aarsag = 'ikke_afhentet',
         refusion_anmodet_kl = now(),
         opdateret = now()
   where id = b.id;

  return jsonb_build_object(
    'kode', case when v_r > 0 then 'ok' else 'ok_intet' end,
    'betaling_id', b.id, 'trade_id', p_trade,
    'buyer_id', t.buyer_id, 'seller_id', t.seller_id, 'auction_id', t.auction_id,
    'refusion_oere', v_r, 'returfragt_oere', v_retur, 'kilde', p_kilde,
    'registreret_kl', now());
end;
$fn$;

revoke all on function public.handel_ikke_afhentet_registrer(uuid, text, uuid, text, uuid, bigint) from public, anon, authenticated;
grant execute on function public.handel_ikke_afhentet_registrer(uuid, text, uuid, text, uuid, bigint) to service_role;

-- Til appen (og andre klienter): er pakken registreret som ikke afhentet?
-- Kun køber og sælger på handlen. Køberen får sine beløb (hvad han får
-- tilbage, og hvad der er trukket fra); sælgeren kun tidspunktet. Refunderet =
-- Stripe har gennemført refusionen. null = nej / ingen adgang.
create or replace function public.mit_ikke_afhentet(p_trade uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
           when t.buyer_id = (select auth.uid()) then jsonb_build_object(
             'rolle', 'koeber',
             'registreret_kl', ia.registreret_kl,
             'refusion_oere', ia.refusion_oere,
             'koebergebyr_oere', ia.koebergebyr_oere,
             'beskyttelse_oere', ia.beskyttelse_oere,
             'fragt_oere', ia.fragt_oere,
             'returfragt_oere', ia.returfragt_oere,
             'refunderet', b.status = 'refunderet')
           else jsonb_build_object('rolle', 'saelger', 'registreret_kl', ia.registreret_kl)
         end
    from public.handel_ikke_afhentet ia
    join public.trades t on t.id = ia.trade_id
    join public.betalinger b on b.id = ia.betaling_id
   where ia.trade_id = p_trade
     and (select auth.uid()) is not null
     and (select auth.uid()) in (t.buyer_id, t.seller_id);
$fn$;

revoke all on function public.mit_ikke_afhentet(uuid) from public, anon;
grant execute on function public.mit_ikke_afhentet(uuid) to authenticated, service_role;

-- Note til staff på en forsendelse (fx "registreret som ikke afhentet" eller
-- "kunne ikke annulleres automatisk"). Tilføjes uden dubletter, og
-- forsendelsen markeres til staff. Kun service role.
create or replace function public.forsendelse_note_til_staff(p_id uuid, p_note text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_id is null or nullif(btrim(coalesce(p_note, '')), '') is null then return false; end if;
  update public.forsendelser
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, left(p_note, 500)),
         opdateret_kl = now()
   where id = p_id;
  return found;
end;
$fn$;

revoke all on function public.forsendelse_note_til_staff(uuid, text) from public, anon, authenticated;
grant execute on function public.forsendelse_note_til_staff(uuid, text) to service_role;

-- ===========================================================================
-- 3. Refusionsplan (genoprettes helt - drift-tjek i afsnit 0)
-- ===========================================================================
-- Som 20261011040000, men årsagen 'ikke_afhentet' må have R < U: S = min(U, R),
-- og planen returnerer tilbagefoersel_oere = U + G (det, der tages fra
-- sælgerens konto). For alle andre årsager er S = U, og tilbagefoersel_oere =
-- R (uændret). R skal passe med den låste hændelse.
create or replace function public.betaling_refusionsplan(p_betaling uuid, p_noegle uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b   record;
  v_r bigint;
  v_s bigint;
  v_g bigint;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_noegle is null or b.refusion_laas_noegle is distinct from p_noegle
     or b.refusion_laas_til is null or b.refusion_laas_til <= now() then
    return jsonb_build_object('kode', 'ikke_laast');
  end if;
  if b.pengemodel <> 'destination' then return jsonb_build_object('kode', 'ikke_destination'); end if;
  if b.status <> 'betalt' or b.refusion_anmodet_kl is null then
    return jsonb_build_object('kode', 'ikke_anmodet');
  end if;
  if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or b.overfoersel_paabegyndt_kl is not null then
    return jsonb_build_object('kode', 'udbetalt');
  end if;
  -- En indsigelse afgøres af banken (og en tabt tager pengene fra sælgerens
  -- konto via betaling_indsigelse_tilbagefoersel_*): ingen refusionstrin.
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or b.indsigelse_tilbagefoert_oere is not null
     or (b.indsigelse_tilbagefoersel_laas_til is not null and b.indsigelse_tilbagefoersel_laas_til > now()) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;
  if b.application_fee_oere is null or b.saelger_stripe_konto is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  v_r := coalesce(b.refusion_oere, b.total_oere);
  if b.refusion_aarsag = 'ikke_afhentet' then
    -- Ikke-afhentet pakke (20261016030000): køberen får R = total - gebyrer -
    -- fragt begge veje, som kan være mindre end sælgerens del U. Sælgeren får
    -- stadig intet: hele U tages tilbage (U + G), og platformen beholder
    -- U - S. R skal være den låste hændelses beløb.
    if not exists (select 1 from public.handel_ikke_afhentet i
                    where i.betaling_id = b.id and i.refusion_oere = v_r) then
      return jsonb_build_object('kode', 'ugyldig');
    end if;
    v_s := least(b.udbetaling_oere, v_r);
  else
    -- Sælgeren får intet, når køberen får pengene tilbage (annullering og sag
    -- med medhold): hele hans del tages tilbage. BidHamr giver sit gebyr
    -- tilbage, undtagen den del køberen ikke får (BidHamr Beskyttelse ved sag).
    v_s := b.udbetaling_oere;
  end if;
  v_g := v_r - v_s;
  if v_r < 0 or (v_r = 0 and b.refusion_aarsag is distinct from 'ikke_afhentet')
     or v_r > b.total_oere or v_s < 0 or v_g < 0 or v_g > b.application_fee_oere then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  if b.refusion_fra_saelger_oere is null then
    update public.betalinger
       set refusion_fra_saelger_oere = v_s, refusion_gebyr_oere = v_g, opdateret = now()
     where id = b.id;
  elsif b.refusion_fra_saelger_oere <> v_s or b.refusion_gebyr_oere <> v_g then
    return jsonb_build_object('kode', 'konflikt');
  end if;

  return jsonb_build_object(
    'kode', 'ok',
    'refusion_oere', v_r,
    'fra_saelger_oere', v_s,
    'gebyr_oere', v_g,
    -- Det, der tilbageføres fra sælgerens konto: U + G (= R, når S = U).
    'tilbagefoersel_oere', b.udbetaling_oere + v_g,
    'application_fee_oere', b.application_fee_oere,
    'saelger_stripe_konto', b.saelger_stripe_konto,
    'gebyr_refunderet', b.gebyr_refunderet_kl is not null,
    'tilbagefoert', b.refusion_tilbagefoert_kl is not null);
end;
$fn$;

revoke all on function public.betaling_refusionsplan(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_refusionsplan(uuid, uuid) to service_role;

-- Ikke-afhentet pakke med R = 0 (Filip, 10. okt. 2026): køberen får intet
-- tilbage, men sælgerens del er tilbageført (X = U, refusionsplanens trin a og
-- b - gebyr-refusion 0). Der er ingen Stripe-refusion, så betalingen
-- afsluttes her som 'refunderet' (= pengene er afgjort: køberen 0, sælgeren
-- 0, BidHamr resten). Under refusionslåsen, og kun når begge trin er
-- registreret, og planen er S = 0, G = 0. Idempotent.
-- Kode: ok | allerede | ikke_laast | ugyldig | ikke_fundet
create or replace function public.betaling_ikke_afhentet_uden_refusion(p_betaling uuid, p_noegle uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return 'ikke_fundet'; end if;
  if b.status = 'refunderet' then return 'allerede'; end if;
  if p_noegle is null or b.refusion_laas_noegle is distinct from p_noegle
     or b.refusion_laas_til is null or b.refusion_laas_til <= now() then
    return 'ikke_laast';
  end if;
  if b.pengemodel <> 'destination' or b.status <> 'betalt'
     or b.refusion_aarsag is distinct from 'ikke_afhentet'
     or b.refusion_oere is distinct from 0
     or b.refusion_anmodet_kl is null
     or b.refusion_fra_saelger_oere is distinct from 0
     or b.refusion_gebyr_oere is distinct from 0
     or b.gebyr_refunderet_kl is null
     or b.refusion_tilbagefoert_kl is null
     or b.stripe_refund_id is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or b.overfoersel_paabegyndt_kl is not null
     or not exists (select 1 from public.handel_ikke_afhentet i
                     where i.betaling_id = b.id and i.refusion_oere = 0) then
    return 'ugyldig';
  end if;
  update public.betalinger
     set status = 'refunderet', refunderet_kl = now(), opdateret = now()
   where id = b.id;
  return 'ok';
end;
$fn$;

revoke all on function public.betaling_ikke_afhentet_uden_refusion(uuid, uuid) from public, anon, authenticated;
grant execute on function public.betaling_ikke_afhentet_uden_refusion(uuid, uuid) to service_role;

-- ===========================================================================
-- 4. Automatisk frigivelse: aldrig en returneret pakke
-- ===========================================================================
-- Som 20261003011000 (med trin 1's rettelser), men en handel, hvor den
-- udgående pakke er meldt returneret (forsendelser.returneret_kl), eller hvor
-- pakken er registreret som ikke afhentet, frigives aldrig automatisk - heller
-- ikke 14 dage efter afsendelsen. Staff (eller handel_ikke_afhentet_registrer)
-- afgør handlen.
create or replace function public.handel_auto_frigiv()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k      record;
  b      record;
  t      record;
  v_grund text;
  v_ud   jsonb := '[]'::jsonb;
begin
  for k in
    select bt.id as betaling_id, tr.id as trade_id
      from public.trades tr
      join public.betalinger bt on bt.trade_id = tr.id
     where bt.status = 'betalt'
       and bt.frigivet_kl is null
       and bt.refusion_anmodet_kl is null
       and bt.overfoersel_paabegyndt_kl is null
       and bt.stripe_transfer_id is null and bt.saelger_udbetaling_id is null
       and not coalesce(tr.sag_aaben, false)
       -- Frasorteres her, saa de ikke fylder de 200 pladser hver gang.
       and not public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
       and not exists (
         select 1 from public.sager s
          where s.trade_id = tr.id
            and (s.status in ('aaben', 'afventer_retur')
                 or (s.penge_handling is not null and s.afviklet_kl is null)))
       -- Pakken er sendt retur (ikke afhentet): aldrig automatisk.
       and not exists (
         select 1 from public.forsendelser fo
          where fo.trade_id = tr.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
       and not exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = tr.id)
       and ((tr.status = 'modtaget' and tr.received_at < now() - interval '48 hours')
            or (tr.status = 'pakke_sendt'
                and coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days'))
     order by tr.id
     limit 200
  loop
    -- Hver raekke i sin egen undertransaktion: een fejl (fx en constraint)
    -- ruller kun den raekke tilbage og stopper ikke resten af batchen.
    begin
      -- Laaseraekkefoelge: betaling, handel. Alt tjekkes igen under laas.
      select * into b from public.betalinger where id = k.betaling_id for update;
      select * into t from public.trades where id = k.trade_id for update;

      if b.status <> 'betalt'
         or b.frigivet_kl is not null
         or b.refusion_anmodet_kl is not null
         or b.overfoersel_paabegyndt_kl is not null
         or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
         or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
         or coalesce(t.sag_aaben, false)
         or public.sag_holder_pengene(t.id)
         or exists (select 1 from public.forsendelser fo
                     where fo.trade_id = t.id and fo.type = 'udgaaende' and fo.returneret_kl is not null)
         or exists (select 1 from public.handel_ikke_afhentet ia where ia.trade_id = t.id) then
        continue;
      end if;

      if t.status = 'modtaget' and t.received_at < now() - interval '48 hours' then
        v_grund := '48_timer';
      elsif t.status = 'pakke_sendt'
            and coalesce(t.sendt_kl, b.betalt_kl) < now() - interval '14 days' then
        v_grund := '14_dage';
      else
        continue;
      end if;

      update public.trades
         set status = 'leveret', received_at = coalesce(received_at, now())
       where id = t.id and status = t.status;
      if not found then continue; end if;

      update public.betalinger
         set frigivet_kl = now(), opdateret = now()
       where id = b.id and frigivet_kl is null;

      v_ud := v_ud || jsonb_build_array(jsonb_build_object(
        'betaling_id', b.id, 'trade_id', t.id, 'buyer_id', t.buyer_id,
        'seller_id', t.seller_id, 'auction_id', t.auction_id, 'grund', v_grund));
    exception when others then
      raise warning 'handel_auto_frigiv: handel % fejlede: %', k.trade_id, sqlerrm;
    end;
  end loop;
  return v_ud;
end;
$fn$;

revoke all on function public.handel_auto_frigiv() from public, anon, authenticated;
grant execute on function public.handel_auto_frigiv() to service_role;

-- ===========================================================================
-- 5. Fakturaer: returfragt-faktura og kreditnota ved ikke-afhentet
-- ===========================================================================
-- slags: 'salg' (fakturaen ved betalingen og dens kreditnota) eller
-- 'returfragt' (køberens faktura på returfragten ved ikke-afhentet pakke).
alter table public.fakturaer add column if not exists slags text not null default 'salg';

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'fakturaer_slags_check' and conrelid = 'public.fakturaer'::regclass) then
    alter table public.fakturaer add constraint fakturaer_slags_check
      check (slags in ('salg', 'returfragt')
             and (slags = 'salg' or (dokument = 'faktura' and part = 'koeber')));
  end if;
end $do$;

comment on column public.fakturaer.slags is
  'salg: fakturaen ved betalingen (og kreditnotaen for den). returfragt: køberens faktura på returfragten, der blev trukket fra refusionen, da pakken ikke blev afhentet (20261016030000). Låst.';

-- Én faktura pr. betaling, part, dokument OG slags (før: uden slags).
create unique index if not exists fakturaer_handel_part_slags
  on public.fakturaer (betaling_id, part, dokument, slags) where betaling_id is not null;
drop index if exists public.fakturaer_handel_part;

-- slags er låst som de øvrige felter (fakturaer_laaste_felter røres ikke).
create or replace function public.fakturaer_slags_laast()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.slags is distinct from old.slags then
    raise exception 'Fakturaens indhold kan ikke ændres, når den er oprettet';
  end if;
  return new;
end;
$fn$;

revoke all on function public.fakturaer_slags_laast() from public, anon, authenticated;

drop trigger if exists fakturaer_slags_laast on public.fakturaer;
create trigger fakturaer_slags_laast before update on public.fakturaer
  for each row execute function public.fakturaer_slags_laast();

-- Passer en ikke-afhentet refusion med planen? (Bruges af faktura_planlaeg.)
--   - hændelsen findes og har betalingens refusionsbeløb
--   - S = min(U, R), G = R - S, begge Stripe-trin gennemført
--   - det, BidHamr står tilbage med (gebyret - G + U - S), er præcis
--     total - R = købergebyr + fragt + Beskyttelse + den beholdte returfragt
--     (= returfragten, eller buddet, når returfragten er større - så dækker
--     BidHamr resten)
create or replace function public.faktura_ikke_afhentet_ok(p_betaling uuid)
returns boolean
language sql stable security definer set search_path = '' as $fn$
  select coalesce((
    select ia.refusion_oere = x.refusion_oere
       and x.refusion_fra_saelger_oere = least(x.udbetaling_oere, x.refusion_oere)
       and x.refusion_gebyr_oere = x.refusion_oere - x.refusion_fra_saelger_oere
       and x.gebyr_refunderet_kl is not null
       and x.refusion_tilbagefoert_kl is not null
       and x.application_fee_oere - x.refusion_gebyr_oere + (x.udbetaling_oere - x.refusion_fra_saelger_oere)
           = x.total_oere - x.refusion_oere
       and x.total_oere - x.refusion_oere
           = x.koebergebyr_oere + x.fragt_oere + x.beskyttelse_oere
             + least(ia.returfragt_oere, x.total_oere - x.koebergebyr_oere - x.fragt_oere - x.beskyttelse_oere)
      from public.betalinger x
      join public.handel_ikke_afhentet ia on ia.betaling_id = x.id
     where x.id = p_betaling
       and x.refusion_aarsag = 'ikke_afhentet'), false);
$fn$;

revoke all on function public.faktura_ikke_afhentet_ok(uuid) from public, anon, authenticated;
grant execute on function public.faktura_ikke_afhentet_ok(uuid) to service_role;

-- Genoprettes helt (drift-tjek i afsnit 0). Som 20261012080000, men:
--   1) købers faktura ved betalingen er slags 'salg' (unik pr. slags),
--   2) ikke-afhentet pakke (refusion_aarsag 'ikke_afhentet'): købers faktura
--      krediteres IKKE (købergebyr, fragt og Beskyttelse refunderes ikke);
--      sælgerens faktura krediteres helt (sælgeren fik intet), når Stripe-
--      trinnene passer med planen,
--   2b) returfragten, der blev trukket fra refusionen, faktureres køberen
--      (slags 'returfragt', fragtkonto). Passer beløbene ikke, oprettes
--      dokumenterne som "kræver handling" (manuelt i Dinero).
create or replace function public.faktura_planlaeg(p_graense integer default 200)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_graense  integer := least(greatest(coalesce(p_graense, 200), 1), 1000);
  v_faktura  integer := 0;
  v_kredit   integer := 0;
  v_abon     integer := 0;
  v_retur    integer := 0;
  v_returfragt integer := 0;
  n          integer;
  rb         record;
  rf         record;
  rr         record;
  v_linjer   jsonb;
  v_status   text;
  v_manuel   boolean;
  v_fejl     text;
  v_dato     date;
  v_tekst    text;
  v_maade    text;
  v_fragt    text;
  v_moder    text := 'Fakturaen blev håndteret manuelt – lav kreditnotaen manuelt i Dinero.';
  v_ia_fejl  text := 'Pakken blev ikke afhentet, men refusionen hos Stripe passer ikke med planen (gebyr, tilbageførsel eller beløb) - kontrollér refusionen og lav dokumentet manuelt i Dinero.';
begin
  -- 0) Kreditnotaer/modposteringer, der venter, men hvis faktura/bilag
  --    siden er håndteret manuelt (eller stoppet som manuel): de kan ikke
  --    laves automatisk (dokumentet findes ikke sikkert i Dinero med vores
  --    guid) -> kræver handling, manuel. Drift-alarmen gives af serveren
  --    (én pr. dokument, alarm_kl).
  update public.fakturaer k
     set status = 'kraever_handling',
         manuel = true,
         sidste_fejl = case when k.dokument = 'kreditnota' then v_moder
                            else 'Bilaget blev håndteret manuelt – lav modposteringen manuelt i Dinero.' end
    from public.fakturaer m
   where m.id = k.krediterer_id
     and k.status = 'venter'
     and (k.laas_til is null or k.laas_til < now())
     and (m.status = 'haandteret_manuelt' or (m.manuel and m.status = 'kraever_handling'));

  -- 1) Fakturaer: betalte destination-betalinger, hvor BidHamrs gebyr er
  --    trukket og spejlet fra Stripe.
  for rb in
    select x.*
      from public.betalinger x
     where x.pengemodel = 'destination'
       and x.betalt_kl is not null
       and x.application_fee_oere is not null
       and x.stripe_application_fee_id is not null
       and ((x.koebergebyr_oere + x.fragt_oere + x.beskyttelse_oere > 0
             and not exists (select 1 from public.fakturaer f
                              where f.betaling_id = x.id and f.part = 'koeber' and f.dokument = 'faktura'
                                and f.slags = 'salg'))
         or (x.saelgergebyr_oere > 0
             and not exists (select 1 from public.fakturaer f
                              where f.betaling_id = x.id and f.part = 'saelger' and f.dokument = 'faktura'
                                and f.slags = 'salg')))
     order by x.betalt_kl
     limit v_graense
  loop
    v_dato := (rb.betalt_kl at time zone 'Europe/Copenhagen')::date;
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rb.application_fee_oere <> rb.koebergebyr_oere + rb.saelgergebyr_oere + rb.fragt_oere + rb.beskyttelse_oere then
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'BidHamrs gebyr hos Stripe passer ikke med handlens købergebyr, sælgergebyr, fragt og BidHamr Beskyttelse - lav fakturaen manuelt i Dinero.';
    end if;

    -- Fragtlinjen efter købers leveringsvalg i checkout (handel_levering,
    -- 20261012010000_fragt_dao_shipmondo.sql). fragt_oere er låst ved betalingen.
    v_maade := null;
    if rb.fragt_oere > 0 and to_regclass('public.handel_levering') is not null then
      execute 'select maade from public.handel_levering where trade_id = $1' into v_maade using rb.trade_id;
    end if;
    v_fragt := case v_maade when 'pakkeshop' then 'Fragt (levering til pakkeshop)'
                            when 'doer' then 'Fragt (levering til døren)'
                            else 'Fragt' end;

    -- Køberen: købergebyr + fragt + BidHamr Beskyttelse.
    select coalesce(jsonb_agg(v.l order by v.o), '[]'::jsonb) into v_linjer
      from (values (1, public.faktura_linje('koebergebyr', 'Købergebyr (5 %)', rb.koebergebyr_oere)),
                   (2, public.faktura_linje('fragt', v_fragt, rb.fragt_oere)),
                   (3, public.faktura_linje('beskyttelse', 'BidHamr Beskyttelse', rb.beskyttelse_oere))) v(o, l)
     where v.l is not null;
    if jsonb_array_length(v_linjer) > 0 then
      insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                    moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl, slags)
      values ('faktura', 'koeber', rb.buyer_id, rb.id, rb.trade_id, v_linjer, public.faktura_sum(v_linjer),
              public.faktura_moms(v_linjer), v_dato, coalesce(rb.stripe_charge_id, rb.stripe_payment_intent_id),
              v_status, v_manuel, v_fejl, 'salg')
      on conflict do nothing;
      get diagnostics n = row_count;
      v_faktura := v_faktura + n;
    end if;

    -- Sælgeren: sælgergebyret.
    if rb.saelgergebyr_oere > 0 then
      v_linjer := jsonb_build_array(public.faktura_linje('saelgergebyr', 'Sælgergebyr (5 %)', rb.saelgergebyr_oere));
      insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                    moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl, slags)
      values ('faktura', 'saelger', rb.seller_id, rb.id, rb.trade_id, v_linjer, public.faktura_sum(v_linjer),
              public.faktura_moms(v_linjer), v_dato, coalesce(rb.stripe_charge_id, rb.stripe_payment_intent_id),
              v_status, v_manuel, v_fejl, 'salg')
      on conflict do nothing;
      get diagnostics n = row_count;
      v_faktura := v_faktura + n;
    end if;
  end loop;

  -- 2) Kreditnotaer: betalingen er refunderet. Krediteret = det, BidHamr
  --    faktisk har givet tilbage af sit gebyr (refusion_gebyr_oere, trin 4):
  --      hele gebyret              -> alle linjer (køber og sælger)
  --      gebyret - Beskyttelse     -> alt undtagen BidHamr Beskyttelse
  --                                   (sag med medhold - BidHamr beholder den)
  --      ikke afhentet             -> kun sælgerens faktura (helt); købers
  --                                   faktura krediteres ikke
  --      andet / ikke registreret  -> kræver handling (laves manuelt)
  for rf in
    select fa.id, fa.part, fa.bruger_id, fa.betaling_id, fa.trade_id, fa.linjer,
           fa.manuel as moder_manuel, fa.status as moder_status,
           x.refunderet_kl, x.gebyr_refunderet_kl, x.refusion_gebyr_oere, x.application_fee_oere,
           x.beskyttelse_oere, x.stripe_refund_id, x.refusion_aarsag,
           public.faktura_ikke_afhentet_ok(x.id) as ia_ok
      from public.fakturaer fa
      join public.betalinger x on x.id = fa.betaling_id
     where fa.dokument = 'faktura'
       and fa.slags = 'salg'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and not exists (select 1 from public.fakturaer k where k.krediterer_id = fa.id)
       -- Ikke afhentet: købers gebyrer og fragt refunderes ikke - ingen kreditnota.
       and not (x.refusion_aarsag is not distinct from 'ikke_afhentet' and fa.part = 'koeber')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rf.moder_manuel or rf.moder_status in ('kraever_handling', 'haandteret_manuelt') then
      -- Fakturaen findes ikke (sikkert) i Dinero med vores guid.
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := v_moder;
    elsif rf.gebyr_refunderet_kl is null or rf.refusion_gebyr_oere is null then
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Betalingen er refunderet, men BidHamrs gebyr-refusion er ikke registreret - kontrollér refusionen hos Stripe og lav kreditnotaen manuelt i Dinero.';
    elsif rf.refusion_aarsag is not distinct from 'ikke_afhentet' then
      -- Sælgerens faktura (sælgergebyret) krediteres helt: sælgeren fik intet.
      v_linjer := rf.linjer;
      if not rf.ia_ok then
        v_status := 'kraever_handling';
        v_manuel := true;
        v_fejl := v_ia_fejl;
      end if;
    elsif rf.refusion_gebyr_oere = rf.application_fee_oere then
      v_linjer := rf.linjer;
    elsif rf.beskyttelse_oere > 0 and rf.refusion_gebyr_oere = rf.application_fee_oere - rf.beskyttelse_oere then
      select coalesce(jsonb_agg(l), '[]'::jsonb) into v_linjer
        from jsonb_array_elements(rf.linjer) l
       where l->>'kode' <> 'beskyttelse';
    else
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Den refunderede del af BidHamrs gebyr passer ikke med en fuld refusion eller en refusion uden BidHamr Beskyttelse - lav kreditnotaen manuelt i Dinero.';
    end if;
    if jsonb_array_length(v_linjer) = 0 then
      v_linjer := rf.linjer;
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Intet at kreditere på fakturaen - kontrollér refusionen.';
    end if;

    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, krediterer_id, linjer,
                                  beloeb_oere, moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('kreditnota', rf.part, rf.bruger_id, rf.betaling_id, rf.trade_id, rf.id, v_linjer,
            public.faktura_sum(v_linjer), public.faktura_moms(v_linjer),
            (rf.refunderet_kl at time zone 'Europe/Copenhagen')::date, rf.stripe_refund_id,
            v_status, v_manuel, v_fejl)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_kredit := v_kredit + n;
  end loop;

  -- 2b) Ikke afhentet: returfragten, der blev trukket fra købers refusion, er
  --     BidHamrs ydelse og faktureres køberen (fragtkonto). Dateres på
  --     refusionsdagen. Kun når refusionen er gennemført (ved R = 0: når
  --     sælgerens del er tilbageført). Beløbet er den beholdte returfragt -
  --     højst buddet; er returfragten større, dækker BidHamr resten.
  for rf in
    select x.id, x.buyer_id, x.trade_id, x.refunderet_kl, x.stripe_charge_id, x.stripe_payment_intent_id,
           -- Den returfragt, der faktisk er beholdt (højst buddet - resten dækker BidHamr).
           ia.total_oere - ia.koebergebyr_oere - ia.beskyttelse_oere - ia.fragt_oere - ia.refusion_oere as returfragt_oere,
           public.faktura_ikke_afhentet_ok(x.id) as ia_ok
      from public.handel_ikke_afhentet ia
      join public.betalinger x on x.id = ia.betaling_id
     where ia.total_oere - ia.koebergebyr_oere - ia.beskyttelse_oere - ia.fragt_oere - ia.refusion_oere > 0
       and x.pengemodel = 'destination'
       and x.status = 'refunderet'
       and x.refunderet_kl is not null
       and x.refusion_aarsag is not distinct from 'ikke_afhentet'
       and not exists (select 1 from public.fakturaer f
                        where f.betaling_id = x.id and f.part = 'koeber' and f.dokument = 'faktura'
                          and f.slags = 'returfragt')
     order by x.refunderet_kl
     limit v_graense
  loop
    v_linjer := jsonb_build_array(public.faktura_linje('fragt', 'Returfragt (pakken blev ikke afhentet)', rf.returfragt_oere));
    insert into public.fakturaer (dokument, part, bruger_id, betaling_id, trade_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl, slags)
    values ('faktura', 'koeber', rf.buyer_id, rf.id, rf.trade_id, v_linjer, public.faktura_sum(v_linjer),
            public.faktura_moms(v_linjer), (rf.refunderet_kl at time zone 'Europe/Copenhagen')::date,
            coalesce(rf.stripe_charge_id, rf.stripe_payment_intent_id),
            case when rf.ia_ok then 'venter' else 'kraever_handling' end, not rf.ia_ok,
            case when rf.ia_ok then null else v_ia_fejl end, 'returfragt')
    on conflict do nothing;
    get diagnostics n = row_count;
    v_returfragt := v_returfragt + n;
  end loop;

  -- 3) Erhvervsabonnement: betalte Stripe-fakturaer bogføres som finansbilag.
  for rr in
    select rg.*, fm.bruger_id
      from public.firma_regninger rg
      join public.firmaer fm on fm.id = rg.firma_id
     where rg.betalt_kl is not null
       and rg.status in ('betalt', 'krediteret')
       and rg.beloeb_oere > 0
       and not exists (select 1 from public.fakturaer f
                        where f.firma_regning_id = rg.id and f.dokument = 'abonnement')
     order by rg.betalt_kl
     limit v_graense
  loop
    v_tekst := case rr.type when 'opgradering' then 'Opgradering af erhvervsabonnement'
                           when 'andet' then 'BidHamr erhverv'
                           else 'Erhvervsabonnement' end
               || coalesce(' - Stripe-faktura ' || rr.nummer, '');
    v_linjer := jsonb_build_array(jsonb_build_object('kode', 'abonnement', 'tekst', left(v_tekst, 200),
                                                     'beloeb_oere', rr.beloeb_oere));
    v_status := 'venter';
    v_manuel := false;
    v_fejl := null;
    if rr.moms_oere is not null and rr.moms_oere <> public.faktura_moms(v_linjer) then
      v_status := 'kraever_handling';
      v_manuel := true;
      v_fejl := 'Momsen på Stripe-fakturaen er ikke 25 % af beløbet - bogfør den manuelt i Dinero.';
    end if;
    insert into public.fakturaer (dokument, part, bruger_id, firma_regning_id, linjer, beloeb_oere, moms_oere,
                                  betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('abonnement', 'firma', rr.bruger_id, rr.id, v_linjer, rr.beloeb_oere,
            coalesce(rr.moms_oere, public.faktura_moms(v_linjer)),
            (rr.betalt_kl at time zone 'Europe/Copenhagen')::date, rr.stripe_invoice_id,
            v_status, v_manuel, v_fejl)
    on conflict (firma_regning_id, dokument) where firma_regning_id is not null do nothing;
    get diagnostics n = row_count;
    v_abon := v_abon + n;
  end loop;

  -- 3b) Refunderet abonnementsfaktura (krediteret efter betaling): modpostering.
  for rf in
    select fa.id, fa.bruger_id, fa.firma_regning_id, fa.linjer, fa.beloeb_oere, fa.moms_oere, fa.stripe_reference,
           fa.manuel as moder_manuel, fa.status as moder_status, rg.krediteret_kl
      from public.fakturaer fa
      join public.firma_regninger rg on rg.id = fa.firma_regning_id
     where fa.dokument = 'abonnement'
       and rg.status = 'krediteret'
       and not exists (select 1 from public.fakturaer k where k.krediterer_id = fa.id)
     limit v_graense
  loop
    v_manuel := rf.moder_manuel or rf.moder_status in ('kraever_handling', 'haandteret_manuelt');
    -- Delvis refusion hos Stripe kontrolleres, før modposteringen bogføres
    -- (src/lib/faktura/koe.ts) - passer beløbet ikke, stoppes den til staff.
    insert into public.fakturaer (dokument, part, bruger_id, firma_regning_id, krediterer_id, linjer, beloeb_oere,
                                  moms_oere, betalt_dato, stripe_reference, status, manuel, sidste_fejl)
    values ('abonnement_retur', 'firma', rf.bruger_id, rf.firma_regning_id, rf.id, rf.linjer, rf.beloeb_oere,
            rf.moms_oere, (coalesce(rf.krediteret_kl, now()) at time zone 'Europe/Copenhagen')::date, rf.stripe_reference,
            case when v_manuel then 'kraever_handling' else 'venter' end, v_manuel,
            case when v_manuel then 'Bilaget blev håndteret manuelt – lav modposteringen manuelt i Dinero.' end)
    on conflict do nothing;
    get diagnostics n = row_count;
    v_retur := v_retur + n;
  end loop;

  return jsonb_build_object('fakturaer', v_faktura, 'kreditnotaer', v_kredit,
                            'abonnement', v_abon, 'abonnement_retur', v_retur,
                            'returfragt', v_returfragt);
end
$fn$;

revoke all on function public.faktura_planlaeg(integer) from public, anon, authenticated;
grant execute on function public.faktura_planlaeg(integer) to service_role;

-- ===========================================================================
-- 6. DAC7: en ikke-afhentet pakke er ikke et salg
-- ===========================================================================
-- Som 20261014010000, men handler med en ikke-afhentet pakke tæller aldrig
-- (sælgeren fik intet). Også mens refusionen er undervejs (status stadig
-- 'betalt'), og når køberen intet fik (R = 0).
create or replace function public.dac7_salg(p_aar integer, p_bruger uuid default null)
returns table (bruger_id uuid, betaling_id uuid, dato timestamptz, kvartal integer,
               vederlag_oere bigint, gebyr_oere bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with g as (
    select make_timestamptz(p_aar, 1, 1, 0, 0, 0, 'Europe/Copenhagen') as fra,
           make_timestamptz(p_aar + 1, 1, 1, 0, 0, 0, 'Europe/Copenhagen') as til
  ), b as (
    select b.seller_id,
           b.id,
           case when b.pengemodel = 'separat' then b.overfoert_kl else b.betalt_kl end as dato,
           greatest(0, coalesce(b.udbetaling_oere, 0) - coalesce(b.indsigelse_tilbagefoert_oere, 0))::bigint as vederlag,
           coalesce(b.saelgergebyr_oere, 0)::bigint as gebyr
      from public.betalinger b, g
     where b.status = 'betalt'
       and b.seller_id <> public.bidhamr_system_id()
       and (p_bruger is null or b.seller_id = p_bruger)
       and not exists (select 1 from public.handel_ikke_afhentet ia where ia.betaling_id = b.id)
       and ((b.pengemodel is distinct from 'separat' and b.betalt_kl >= g.fra and b.betalt_kl < g.til)
         or (b.pengemodel = 'separat' and b.overfoert_kl >= g.fra and b.overfoert_kl < g.til))
  )
  select b.seller_id, b.id, b.dato,
         extract(quarter from (b.dato at time zone 'Europe/Copenhagen'))::integer,
         b.vederlag, b.gebyr
    from b
   where b.vederlag > 0;
$$;
revoke all on function public.dac7_salg(integer, uuid) from public, anon, authenticated;
grant execute on function public.dac7_salg(integer, uuid) to service_role;

-- ===========================================================================
-- 7. Medarbejder-loggen
-- ===========================================================================
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

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['handel_ikke_afhentet']);
