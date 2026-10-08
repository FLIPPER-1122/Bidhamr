-- Ny betalingsmodel, trin 3: udbetaling (docs/BETALINGSMODEL-PLAN.md afsnit 1.4 og 6.3).
-- ROADMAP-BESLUTNINGER.md "Ny betalingsmodel – Filips svar (8. okt. 2026)".
--
-- Destination charges: købers penge står på sælgerens Stripe Connect-konto
-- med manuel udbetalingsplan. BidHamr laver selv udbetalingen (payout) fra
-- sælgerens konto til sælgerens bank, når handlen er HELT færdig (Filip,
-- ufravigeligt). Serveren (src/lib/betaling/udbetaling.ts) gør Stripe-delen;
-- databasen låser og spejler.
--
-- Som trin 1 og 2: INTET ændres for 'separat'. Alt nyt virker kun på
-- betalinger med pengemodel = 'destination' (og på sælgerprofiler med en
-- fejlet BidHamr-udbetaling, som kun findes i destination).
--
--  1. saelger_udbetalinger: hvilke betalinger en udbetaling dækker
--     (betaling_ids - historik, også når udbetalingen fejler), sælgerens
--     bankkonto hos Stripe, fejlkode og status 'afvist' (Stripe afviste at
--     oprette udbetalingen - intet har forladt kontoen). Højst én uafklaret
--     udbetaling (claimet/usikker) pr. sælger ad gangen.
--  2. betalingsprofiler: connect_udbetaling_fejlet_* - en udbetaling til
--     sælgerens bank er fejlet ("venter på bank"). Ingen nye udbetalinger,
--     før sælgeren har rettet bankkontoen hos Stripe (ny bankkonto) eller
--     staff har trykket "Prøv igen".
--  3. udbetal_tidligst (Niels F02, Filip 8. okt. 2026): ved AFHENTNING
--     venter udbetalingen 3 dage efter frigivelsen, hvis sælgeren har under 5
--     gennemførte handler, eller købet er over 2.000 kr. Sættes af en trigger,
--     når frigivet_kl sættes (alle frigivelsesveje).
--  4. betaling_udbetaling_blokeret (trin 2) genoprettes med flere grunde:
--     udbetalinger ikke aktive, sælgerens konto skiftet, venter på bank.
--  5. Udbetalingens livscyklus: saelger_udbetaling_claim (låser betalingerne
--     under lås og tjekker betaling_udbetaling_blokeret for hver), _oprettet,
--     _usikker, _afvist, _spejl (payout.paid/failed/canceled) og
--     _bank_rettet. Fejler/annulleres en udbetaling, frigøres betalingerne
--     igen (pengene er tilbage på sælgerens Stripe-konto) - historikken står i
--     saelger_udbetalinger.betaling_ids.
--  6. admin_penge_holdes og admin_penge_tal (chef) kender destination:
--     "penge holdes" indtil udbetalingen til banken er gennemført
--     ('afventer_udbetaling', 'udbetaling_paa_vej', 'venter_paa_bank'), og
--     udbetalinger tælles med (overfoert_kl = udbetalingen er sendt).
--
-- overfoert_kl bruges også i destination: tidspunktet, hvor udbetalingen til
-- sælgerens bank er oprettet hos Stripe (vises som "udbetalt" overalt).
--
-- Idempotent. Ændrer ingen handelsdata. Nye/genoprettede funktioner:
-- security definer med search_path = '' og fuldt kvalificerede navne.

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. saelger_udbetalinger
-- ===========================================================================
alter table public.saelger_udbetalinger
  add column if not exists betaling_ids      uuid[] not null default '{}',
  add column if not exists stripe_bankkonto  text,
  add column if not exists fejlkode          text,
  add column if not exists oprettet_hos_stripe_kl timestamptz;

do $do$
begin
  if exists (select 1 from pg_constraint
              where conname = 'saelger_udbetalinger_status_check'
                and conrelid = 'public.saelger_udbetalinger'::regclass
                and pg_get_constraintdef(oid) not like '%afvist%') then
    alter table public.saelger_udbetalinger drop constraint saelger_udbetalinger_status_check;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'saelger_udbetalinger_status_check'
                    and conrelid = 'public.saelger_udbetalinger'::regclass) then
    alter table public.saelger_udbetalinger
      add constraint saelger_udbetalinger_status_check
      check (status in ('claimet', 'oprettet', 'paid', 'failed', 'canceled', 'usikker', 'afvist'));
  end if;
end $do$;

comment on column public.saelger_udbetalinger.status is
  'claimet: betalingerne er låst, payout oprettes nu. oprettet: payout findes hos Stripe (pending/in_transit). paid/failed/canceled: spejlet fra payout.*. usikker: svaret fra Stripe er ukendt (netværk/5xx) - prøves igen med samme nøgle. afvist: Stripe afviste at oprette payout (intet har forladt kontoen).';
comment on column public.saelger_udbetalinger.betaling_ids is
  'Betalingerne, udbetalingen dækker (låst ved claim). Bevares, også når udbetalingen fejler, og betalingerne frigøres til en ny udbetaling.';
comment on column public.saelger_udbetalinger.stripe_bankkonto is
  'Sælgerens bankkonto hos Stripe (payout.destination, ba_...).';

-- Højst én uafklaret udbetaling pr. sælger: ingen samtidige payouts, mens
-- det er uvist, om den forrige er oprettet hos Stripe.
create unique index if not exists saelger_udbetalinger_en_uafklaret
  on public.saelger_udbetalinger (seller_id)
  where status in ('claimet', 'usikker');

-- ===========================================================================
-- 2. betalingsprofiler: udbetaling til banken fejlet
-- ===========================================================================
alter table public.betalingsprofiler
  add column if not exists connect_udbetaling_fejlet_kl   timestamptz,
  add column if not exists connect_udbetaling_fejlet_bank text,
  add column if not exists connect_udbetaling_fejlkode    text;

comment on column public.betalingsprofiler.connect_udbetaling_fejlet_kl is
  'Destination: en BidHamr-udbetaling til sælgerens bank er fejlet hos Stripe (payout.failed). Ingen nye udbetalinger ("venter på bank"), før sælgeren har en anden bankkonto hos Stripe, eller staff har trykket "Prøv igen". Kun service role skriver.';
comment on column public.betalingsprofiler.connect_udbetaling_fejlet_bank is
  'Bankkontoen (ba_...), udbetalingen fejlede til. Ryddes, når kontoens standard-bankkonto er en anden.';

-- ===========================================================================
-- 3. udbetal_tidligst (F02): 3 dages ventetid ved afhentning
-- ===========================================================================
-- Filip 8. okt. 2026: ved afhentning venter udbetalingen 3 dage, hvis sælgeren
-- har under 5 gennemførte handler, eller købet er over 2.000 kr.
--   "gennemført handel" = en handel med en ANDEN køber end den aktuelle;
--     kun forskellige købere tæller. Betalt og frigivet for mindst 3 dage
--     siden, uden refusion, indsigelse, uløst svindelvarsel eller åben
--     markering (chefens valg - strammet efter review).
--   "købet" = købers samlede betaling (total_oere) - det strengeste (chefens
--     valg).
-- Regnes fra frigivelsen (sælgeren har indtastet købers afhentningskode).
create or replace function public.betalinger_udbetal_tidligst()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_afhentning boolean;
  v_antal      integer;
begin
  if new.pengemodel = 'destination'
     and old.frigivet_kl is null and new.frigivet_kl is not null
     and new.udbetal_tidligst is null then
    select t.afhentning into v_afhentning from public.trades t where t.id = new.trade_id;
    if coalesce(v_afhentning, false) then
      select count(distinct b2.buyer_id) into v_antal
        from public.betalinger b2
       where b2.seller_id = new.seller_id
         and b2.id <> new.id
         and b2.buyer_id <> new.buyer_id
         and b2.buyer_id <> new.seller_id
         and b2.status = 'betalt'
         and b2.frigivet_kl is not null
         and b2.frigivet_kl <= now() - interval '3 days'
         and b2.refusion_anmodet_kl is null
         and b2.refunderet_kl is null
         and b2.indsigelse_kl is null
         and (b2.svindelvarsel_kl is null or b2.svindelvarsel_loest_kl is not null)
         and not b2.kraever_opmaerksomhed;
      if v_antal < 5 or new.total_oere > 200000 then
        new.udbetal_tidligst := new.frigivet_kl + interval '3 days';
      end if;
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_udbetal_tidligst() from public, anon, authenticated;

drop trigger if exists betalinger_udbetal_tidligst on public.betalinger;
create trigger betalinger_udbetal_tidligst
  before update of frigivet_kl on public.betalinger
  for each row execute function public.betalinger_udbetal_tidligst();

-- ===========================================================================
-- 4. betaling_udbetaling_blokeret: genoprettes helt (drift-tjek først)
-- ===========================================================================
do $do$
declare
  h text;
begin
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    into h
    from pg_proc p where p.oid = 'public.betaling_udbetaling_blokeret(uuid)'::regprocedure;
  if h = 'ebbc9160aea98bff95eb44692d0b8eaa' then
    raise notice 'betaling_udbetaling_blokeret: allerede rettet';
  elsif h is distinct from '6532ea98ac75a1dd59df2ad3c3451171' then
    raise exception 'betaling_udbetaling_blokeret: kroppen afviger fra trin 2 (md5 %) - kontrollér funktionen, før migrationen køres', h;
  end if;
end $do$;

-- null = intet blokerer. Filip (ufravigeligt): intet udbetales, før handlen
-- er helt færdig; sag eller indsigelse fryser pengene, til de er afgjort;
-- uløst svindelvarsel stopper udbetalingen, til staff har gennemgået det.
create or replace function public.betaling_udbetaling_blokeret(p_betaling uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  b  record;
  t  record;
  bp record;
begin
  select * into b from public.betalinger where id = p_betaling;
  if not found then return 'ikke_fundet'; end if;
  select * into t from public.trades where id = b.trade_id;
  select * into bp from public.betalingsprofiler where user_id = b.seller_id;
  if b.status <> 'betalt' or b.stripe_charge_id is null then return 'ikke_betalt'; end if;
  if b.frigivet_kl is null then return 'ikke_frigivet'; end if;
  if b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null then return 'allerede_udbetalt'; end if;
  if b.refusion_anmodet_kl is not null or b.refunderet_kl is not null then return 'refusion'; end if;
  if public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then return 'indsigelse'; end if;
  if b.svindelvarsel_kl is not null and b.svindelvarsel_loest_kl is null then return 'svindelvarsel'; end if;
  if b.radar_review_aaben then return 'radar_review'; end if;
  if t.id is null or t.status = 'annulleret' then return 'handel_annulleret'; end if;
  if t.sag_aaben then return 'sag_aaben'; end if;
  if b.kraever_opmaerksomhed then return 'kraever_opmaerksomhed'; end if;
  if b.pengemodel = 'destination' then
    if b.stripe_destination_transfer_id is null then return 'transfer_ukendt'; end if;
    if b.midler_tilgaengelige_kl is null or b.midler_tilgaengelige_kl > now() then return 'midler_ikke_tilgaengelige'; end if;
    if b.udbetal_tidligst is not null and b.udbetal_tidligst > now() then return 'ventetid'; end if;
    if bp.user_id is null or bp.connect_frakoblet_kl is not null then return 'konto_frakoblet'; end if;
    if bp.stripe_account_id is distinct from b.saelger_stripe_konto then return 'konto_skiftet'; end if;
    if not bp.connect_plan_ok then return 'plan_ikke_manuel'; end if;
    if not coalesce(bp.connect_udbetalinger_aktiv, false) then return 'udbetalinger_inaktive'; end if;
    if bp.connect_udbetaling_fejlet_kl is not null then return 'venter_paa_bank'; end if;
  end if;
  return null;
end;
$fn$;

revoke all on function public.betaling_udbetaling_blokeret(uuid) from public, anon, authenticated;
grant execute on function public.betaling_udbetaling_blokeret(uuid) to service_role;

-- ===========================================================================
-- 5. Udbetalingens livscyklus
-- ===========================================================================

-- Låser betalingerne til én udbetaling. Kun betalinger for sælgeren, på den
-- låste sælgerkonto, og hvor betaling_udbetaling_blokeret er null UNDER
-- låsen (betalinger og handler låses i samme rækkefølge som sag_opret og
-- betaling_claim_overfoersel: betaling, derefter handel). De øvrige
-- returneres med grunden. Svar (kode): ok, i_gang (en anden udbetaling for
-- sælgeren er uafklaret), intet (ingen betalinger kan udbetales).
create or replace function public.saelger_udbetaling_claim(
  p_saelger uuid, p_konto text, p_betalinger uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b        record;
  v_grund  text;
  v_ok     uuid[] := '{}';
  v_afvist jsonb := '[]'::jsonb;
  v_sum    bigint := 0;
  v_id     uuid;
begin
  if p_saelger is null or p_konto is null or coalesce(array_length(p_betalinger, 1), 0) = 0 then
    return jsonb_build_object('kode', 'intet', 'afvist', v_afvist);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('saelger_udbetaling:' || p_saelger::text));
  if exists (select 1 from public.saelger_udbetalinger u
              where u.seller_id = p_saelger and u.status in ('claimet', 'usikker')) then
    return jsonb_build_object('kode', 'i_gang', 'afvist', v_afvist);
  end if;

  for b in
    select * from public.betalinger
     where id = any (p_betalinger)
     order by id
       for update
  loop
    perform 1 from public.trades t where t.id = b.trade_id for update;
    if b.seller_id <> p_saelger then
      v_grund := 'anden_saelger';
    elsif b.pengemodel <> 'destination' then
      v_grund := 'ikke_destination';
    elsif b.saelger_stripe_konto is distinct from p_konto then
      v_grund := 'anden_konto';
    elsif b.udbetaling_oere <= 0 then
      v_grund := 'intet_beloeb';
    else
      v_grund := public.betaling_udbetaling_blokeret(b.id);
    end if;
    if v_grund is null then
      v_ok := v_ok || b.id;
      v_sum := v_sum + b.udbetaling_oere;
    else
      v_afvist := v_afvist || jsonb_build_object('betaling_id', b.id, 'grund', v_grund);
    end if;
  end loop;

  if coalesce(array_length(v_ok, 1), 0) = 0 then
    return jsonb_build_object('kode', 'intet', 'afvist', v_afvist);
  end if;

  insert into public.saelger_udbetalinger (seller_id, stripe_konto, beloeb_oere, valuta, status, betaling_ids)
  values (p_saelger, p_konto, v_sum, 'dkk', 'claimet', v_ok)
  returning id into v_id;

  update public.betalinger
     set saelger_udbetaling_id = v_id,
         overfoersel_paabegyndt_kl = coalesce(overfoersel_paabegyndt_kl, now()),
         opdateret = now()
   where id = any (v_ok);

  return jsonb_build_object('kode', 'ok', 'udbetaling_id', v_id, 'beloeb_oere', v_sum,
                            'betalinger', to_jsonb(v_ok), 'afvist', v_afvist);
end;
$fn$;

revoke all on function public.saelger_udbetaling_claim(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_claim(uuid, text, uuid[]) to service_role;

-- Payout er oprettet hos Stripe. overfoert_kl = "udbetalt" (sendt til bank).
-- p_status er payout.status (pending/in_transit/paid ...). Svar: oprettet,
-- paid, allerede, ikke_fundet, forkert_status.
create or replace function public.saelger_udbetaling_oprettet(
  p_udbetaling uuid, p_payout text, p_bank text, p_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  u record;
begin
  select * into u from public.saelger_udbetalinger where id = p_udbetaling for update;
  if not found then return 'ikke_fundet'; end if;
  if u.stripe_payout_id is not null and u.stripe_payout_id <> p_payout then
    raise exception 'saelger_udbetaling_anden_payout: udbetaling % har allerede payout %', u.id, u.stripe_payout_id;
  end if;
  if u.status not in ('claimet', 'usikker') then
    if u.stripe_payout_id is null then
      update public.saelger_udbetalinger set stripe_payout_id = p_payout, opdateret = now() where id = u.id;
    end if;
    return case when u.status in ('oprettet', 'paid') then 'allerede' else 'forkert_status' end;
  end if;
  update public.saelger_udbetalinger
     set stripe_payout_id = p_payout,
         stripe_bankkonto = coalesce(p_bank, stripe_bankkonto),
         status = case when p_status = 'paid' then 'paid' else 'oprettet' end,
         betalt_kl = case when p_status = 'paid' then now() else betalt_kl end,
         oprettet_hos_stripe_kl = coalesce(oprettet_hos_stripe_kl, now()),
         sidste_fejl = null,
         opdateret = now()
   where id = u.id;
  update public.betalinger
     set overfoert_kl = coalesce(overfoert_kl, now()), opdateret = now()
   where saelger_udbetaling_id = u.id;
  return case when p_status = 'paid' then 'paid' else 'oprettet' end;
end;
$fn$;

revoke all on function public.saelger_udbetaling_oprettet(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_oprettet(uuid, text, text, text) to service_role;

-- Stripes svar er ukendt (netværk, 5xx, rate limit, idempotency-konflikt):
-- claimet beholdes, og næste kørsel prøver med samme nøgle. forsoeg tælles
-- op, så et nyt forsøg efter 24 t (idempotency-nøglen udløber) får en ny
-- nøgle - EFTER et opslag af sælgerens payouts hos Stripe.
create or replace function public.saelger_udbetaling_usikker(p_udbetaling uuid, p_fejl text, p_ny_noegle boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.saelger_udbetalinger
     set status = 'usikker',
         sidste_fejl = left(p_fejl, 500),
         forsoeg = forsoeg + case when coalesce(p_ny_noegle, false) then 1 else 0 end,
         opdateret = now()
   where id = p_udbetaling and status in ('claimet', 'usikker');
  return found;
end;
$fn$;

revoke all on function public.saelger_udbetaling_usikker(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_usikker(uuid, text, boolean) to service_role;

-- Ingen payout er oprettet (Stripe afviste anmodningen, eller saldoen var for
-- lav, før Stripe blev kaldt): betalingerne frigøres igen. p_marker: markér
-- betalingerne til staff (kraever_opmaerksomhed - stopper nye forsøg, til
-- staff har set på det).
create or replace function public.saelger_udbetaling_afvist(p_udbetaling uuid, p_fejl text, p_marker boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  u record;
begin
  select * into u from public.saelger_udbetalinger where id = p_udbetaling for update;
  if not found or u.status not in ('claimet', 'usikker') or u.stripe_payout_id is not null then
    return false;
  end if;
  update public.saelger_udbetalinger
     set status = 'afvist', sidste_fejl = left(p_fejl, 500), fejlet_kl = now(), opdateret = now()
   where id = u.id;
  update public.betalinger
     set saelger_udbetaling_id = null,
         overfoersel_paabegyndt_kl = null,
         overfoert_kl = null,
         kraever_opmaerksomhed = kraever_opmaerksomhed or coalesce(p_marker, false),
         sidste_fejl = case when coalesce(p_marker, false)
                            then left('Udbetaling til sælgers bank afvist af Stripe: ' || coalesce(p_fejl, ''), 500)
                            else sidste_fejl end,
         opdateret = now()
   where saelger_udbetaling_id = u.id;
  return true;
end;
$fn$;

revoke all on function public.saelger_udbetaling_afvist(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_afvist(uuid, text, boolean) to service_role;

-- payout.paid / payout.failed / payout.canceled for en BidHamr-udbetaling
-- (payouten hentet frisk hos Stripe). Findes via stripe_payout_id eller
-- (hvis payout-id'et ikke er gemt endnu) udbetalingens id fra metadata.
--   paid: status paid (også fra claimet/usikker - payout-id'et gemmes).
--   failed/canceled: pengene er tilbage på sælgerens Stripe-konto.
--     Betalingerne frigøres (historik i betaling_ids). failed: sælgeren
--     "venter på bank" (betalingsprofiler.connect_udbetaling_fejlet_*).
--     canceled: betalingerne markeres til staff.
-- Svar: jsonb {kode: paid|failed|canceled|allerede|ukendt, seller_id,
-- betalinger}.
create or replace function public.saelger_udbetaling_spejl(
  p_udbetaling uuid, p_payout text, p_status text, p_fejlkode text, p_bank text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  u record;
begin
  select * into u from public.saelger_udbetalinger where stripe_payout_id = p_payout for update;
  if not found and p_udbetaling is not null then
    select * into u from public.saelger_udbetalinger
     where id = p_udbetaling and (stripe_payout_id is null or stripe_payout_id = p_payout)
       for update;
  end if;
  if not found then return jsonb_build_object('kode', 'ukendt'); end if;

  if p_status = 'paid' then
    if u.status = 'paid' then
      return jsonb_build_object('kode', 'allerede', 'seller_id', u.seller_id);
    end if;
    if u.status not in ('claimet', 'usikker', 'oprettet') then
      return jsonb_build_object('kode', 'allerede', 'seller_id', u.seller_id);
    end if;
    update public.saelger_udbetalinger
       set status = 'paid', stripe_payout_id = p_payout,
           stripe_bankkonto = coalesce(p_bank, stripe_bankkonto),
           betalt_kl = coalesce(betalt_kl, now()),
           oprettet_hos_stripe_kl = coalesce(oprettet_hos_stripe_kl, now()),
           opdateret = now()
     where id = u.id;
    update public.betalinger
       set overfoert_kl = coalesce(overfoert_kl, now()), opdateret = now()
     where saelger_udbetaling_id = u.id;
    return jsonb_build_object('kode', 'paid', 'seller_id', u.seller_id, 'betalinger', to_jsonb(u.betaling_ids));
  end if;

  if p_status in ('failed', 'canceled') then
    if u.status in ('failed', 'canceled', 'afvist') then
      return jsonb_build_object('kode', 'allerede', 'seller_id', u.seller_id);
    end if;
    update public.saelger_udbetalinger
       set status = p_status, stripe_payout_id = p_payout,
           stripe_bankkonto = coalesce(p_bank, stripe_bankkonto),
           fejlkode = p_fejlkode, fejlet_kl = now(),
           sidste_fejl = left('Payout ' || p_status || coalesce(' (' || p_fejlkode || ')', ''), 500),
           opdateret = now()
     where id = u.id;
    update public.betalinger
       set saelger_udbetaling_id = null,
           overfoersel_paabegyndt_kl = null,
           overfoert_kl = null,
           kraever_opmaerksomhed = kraever_opmaerksomhed or p_status = 'canceled',
           sidste_fejl = case when p_status = 'canceled'
                              then 'Udbetalingen til sælgers bank blev annulleret hos Stripe - kontrollér, før den prøves igen'
                              else sidste_fejl end,
           opdateret = now()
     where saelger_udbetaling_id = u.id;
    if p_status = 'failed' then
      update public.betalingsprofiler
         set connect_udbetaling_fejlet_kl = now(),
             connect_udbetaling_fejlet_bank = coalesce(p_bank, u.stripe_bankkonto),
             connect_udbetaling_fejlkode = p_fejlkode,
             opdateret = now()
       where user_id = u.seller_id;
    end if;
    return jsonb_build_object('kode', p_status, 'seller_id', u.seller_id, 'betalinger', to_jsonb(u.betaling_ids));
  end if;

  return jsonb_build_object('kode', 'ignoreret', 'seller_id', u.seller_id);
end;
$fn$;

revoke all on function public.saelger_udbetaling_spejl(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_spejl(uuid, text, text, text, text) to service_role;

-- "Venter på bank" ophæves: sælgerens standard-bankkonto hos Stripe er en
-- anden end den, udbetalingen fejlede til (p_bank), eller staff har trykket
-- "Prøv igen" (p_tving - rolle tjekkes i serverens admin-action).
create or replace function public.saelger_udbetaling_bank_rettet(p_saelger uuid, p_bank text, p_tving boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.betalingsprofiler
     set connect_udbetaling_fejlet_kl = null,
         connect_udbetaling_fejlet_bank = null,
         connect_udbetaling_fejlkode = null,
         opdateret = now()
   where user_id = p_saelger
     and connect_udbetaling_fejlet_kl is not null
     and (coalesce(p_tving, false)
          or (p_bank is not null and p_bank is distinct from connect_udbetaling_fejlet_bank));
  return found;
end;
$fn$;

revoke all on function public.saelger_udbetaling_bank_rettet(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.saelger_udbetaling_bank_rettet(uuid, text, boolean) to service_role;

-- ===========================================================================
-- 6. Admin (chef): penge der holdes / pengetal kender destination
-- ===========================================================================
-- Genoprettes helt (som trin 2): md5 af den normaliserede krop skal være
-- versionen fra 20261004040000/41000 (verificeret ens i produktion og på
-- testdatabasen 9. okt. 2026) eller denne migrations version.
do $do$
declare
  r record;
  h text;
begin
  for r in
    select * from (values
      ('public.admin_penge_holdes(integer)',
       'b27ca3cad6b9d35113149ab5f4ca6748', '952173b9a04ede95438fd49da5b3ec20'),
      ('public.admin_penge_tal(timestamp with time zone,timestamp with time zone)',
       'e6b8419cdc4ccdd915344b0a83700958', '168599dca4d37c1844e5bceb124d7cbb')
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

-- Penge, der holdes: betalt og ikke givet videre. I destination står pengene
-- på sælgerens Stripe-konto, indtil udbetalingen til banken er gennemført
-- (paid) - derfor med, til udbetalingen er paid.
create or replace function public.admin_penge_holdes(p_graense integer default 200)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with h as (
    select bt.id as betaling_id, bt.trade_id, bt.auction_id, bt.total_oere,
           bt.udbetaling_oere, bt.betalt_kl, bt.kraever_opmaerksomhed,
           t.status as handel_status, s.penge_fejl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then 'indsigelse'
             when bt.refusion_anmodet_kl is not null then 'refusion_i_gang'
             when bt.pengemodel = 'destination' and su.id is not null then 'udbetaling_paa_vej'
             when bt.overfoersel_paabegyndt_kl is not null then 'overfoersel_i_gang'
             when bt.pengemodel = 'destination' and bt.frigivet_kl is not null
                  and bp.connect_udbetaling_fejlet_kl is not null then 'venter_paa_bank'
             when bt.pengemodel = 'destination' and bt.frigivet_kl is not null then 'afventer_udbetaling'
             when bt.frigivet_kl is not null then 'afventer_overfoersel'
             when an.id is not null then 'afventer_anke'
             when s.status = 'aaben' then 'afventer_sag'
             when s.status = 'afventer_retur' then 'afventer_retur'
             when s.penge_handling is not null then 'ankefrist'
             when coalesce(t.sag_aaben, false) then 'frosset'
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'afhentning'
             when t.status = 'betaling_modtaget' then 'afventer_afsendelse'
             when t.status = 'pakke_sendt' then 'auto_frigivelse'
             when t.status = 'modtaget' and t.received_at is not null then 'auto_frigivelse'
             else 'kraever_tjek'
           end as grund,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
                  or bt.refusion_anmodet_kl is not null
               then null
             when bt.pengemodel = 'destination' and bt.frigivet_kl is not null and su.id is null
                  and bp.connect_udbetaling_fejlet_kl is null
               then greatest(coalesce(bt.midler_tilgaengelige_kl, now()),
                             coalesce(bt.udbetal_tidligst, '-infinity'::timestamptz))
             when bt.overfoersel_paabegyndt_kl is not null
                  or bt.frigivet_kl is not null
                  or an.id is not null
                  or s.status = 'aaben'
               then null
             when s.status = 'afventer_retur' or s.penge_handling is not null
               then s.penge_flyttes_efter_kl
             when coalesce(t.sag_aaben, false) or coalesce(t.afhentning, false) then null
             when t.status = 'betaling_modtaget' then bt.betalt_kl + interval '5 days'
             when t.status = 'pakke_sendt'
               then coalesce(t.sendt_kl, bt.betalt_kl) + interval '14 days'
             when t.status = 'modtaget' then t.received_at + interval '48 hours'
           end as forventet_kl,
           case
             when public.betaling_indsigelse_blokerer(bt.indsigelse_kl, bt.indsigelse_status)
               then null
             when bt.refusion_anmodet_kl is not null then 'refunder'
             when bt.overfoersel_paabegyndt_kl is not null or bt.frigivet_kl is not null
               then 'frigiv'
             when an.id is not null or s.status = 'aaben' then null
             when s.status = 'afventer_retur' then 'refunder'
             when s.penge_handling is not null then s.penge_handling
             when coalesce(t.sag_aaben, false) then null
             when coalesce(t.afhentning, false) and t.status = 'betaling_modtaget' then 'frigiv'
             when t.status = 'betaling_modtaget' then 'refunder'
             when t.status in ('pakke_sendt', 'modtaget') then 'frigiv'
           end as handling
      from public.betalinger bt
      join public.trades t on t.id = bt.trade_id
      left join public.saelger_udbetalinger su on su.id = bt.saelger_udbetaling_id
      left join public.betalingsprofiler bp on bp.user_id = bt.seller_id
      left join lateral (
        select s1.status, s1.penge_handling, s1.penge_flyttes_efter_kl, s1.penge_fejl
          from public.sager s1
         where s1.trade_id = bt.trade_id
           and (s1.status in ('aaben', 'afventer_retur')
                or (s1.penge_handling is not null and s1.afviklet_kl is null))
         order by s1.oprettet_kl desc
         limit 1
      ) s on true
      left join lateral (
        select a1.id from public.sag_anker a1
         where a1.trade_id = bt.trade_id and a1.status = 'afventer'
         limit 1
      ) an on true
     where bt.status = 'betalt'
       and bt.refunderet_kl is null
       and bt.stripe_transfer_id is null
       and (su.id is null or su.status <> 'paid')
       and coalesce(bt.indsigelse_status, '') <> 'lost'
  ),
  afv as (
    select a.id, a.trade_id, a.modtaget_oere, a.oprettet, a.sidste_fejl
      from public.betaling_afvigelser a
     where a.refunderet_kl is null
  )
  select jsonb_build_object(
    'antal', (select count(*) from h),
    'beloeb', (select coalesce(sum(total_oere), 0) from h),
    'til_saelgere', (select coalesce(sum(udbetaling_oere), 0) from h),
    'efter_grund', coalesce((
      select jsonb_agg(jsonb_build_object('grund', grund, 'antal', antal, 'beloeb', beloeb)
                       order by beloeb desc)
        from (select grund, count(*) as antal, sum(total_oere) as beloeb
                from h group by grund) x), '[]'::jsonb),
    'forkerte_beloeb', jsonb_build_object(
        'antal',  (select count(*) from afv),
        'beloeb', (select coalesce(sum(modtaget_oere), 0) from afv)),
    'liste', coalesce((
      select jsonb_agg(jsonb_build_object(
               'betaling_id', l.betaling_id,
               'trade_id', l.trade_id,
               'auction_id', l.auction_id,
               'titel', au.titel,
               'total_oere', l.total_oere,
               'udbetaling_oere', l.udbetaling_oere,
               'betalt_kl', l.betalt_kl,
               'handel_status', l.handel_status,
               'grund', l.grund,
               'forventet_kl', l.forventet_kl,
               'handling', l.handling,
               'penge_fejl', l.penge_fejl,
               'kraever_opmaerksomhed', l.kraever_opmaerksomhed)
             order by l.forventet_kl asc nulls last, l.betalt_kl asc)
        from (select * from h
               order by forventet_kl asc nulls last, betalt_kl asc
               limit greatest(1, least(coalesce(p_graense, 200), 1000))) l
        left join public.auctions au on au.id = l.auction_id), '[]'::jsonb)
  );
$function$;

revoke all on function public.admin_penge_holdes(integer) from public, anon, authenticated;
grant execute on function public.admin_penge_holdes(integer) to service_role;

-- Pengetal: "givet til sælger" = transfer (separat) ELLER udbetaling til
-- banken (destination, saelger_udbetaling_id). overfoert_kl er i begge
-- modeller tidspunktet for overførslen/udbetalingen.
create or replace function public.admin_penge_tal(p_fra timestamptz, p_til timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with g as (
    select coalesce(p_fra, '-infinity'::timestamptz) as fra,
           coalesce(p_til, 'infinity'::timestamptz)  as til
  ),
  b as (
    select bt.*,
           coalesce(bt.refusion_oere, bt.total_oere) as ref_beloeb,
           (bt.refusion_oere is not null and bt.refusion_oere < bt.total_oere) as er_delvis,
           (bt.stripe_transfer_id is not null
            or exists (select 1 from public.saelger_udbetalinger su
                        where su.id = bt.saelger_udbetaling_id
                          and su.status in ('oprettet', 'paid'))) as givet_til_saelger
      from public.betalinger bt
  ),
  betalt as (
    select b.* from b, g
     where b.betalt_kl is not null and b.betalt_kl >= g.fra and b.betalt_kl < g.til
  ),
  aktive as (
    select * from betalt
     where status = 'betalt'
       and refusion_anmodet_kl is null
       and coalesce(indsigelse_status, '') <> 'lost'
  ),
  delvis as (
    select d.*, f.besk, f.kgeb, f.fragt, f.beholdt - f.besk - f.kgeb - f.fragt as oevrigt
      from betalt d
      cross join lateral (
        select x.beholdt, x.besk, x.kgeb,
               least(d.fragt_oere, x.beholdt - x.besk - x.kgeb) as fragt
          from (
            select y.beholdt, y.besk,
                   least(d.koebergebyr_oere, y.beholdt - y.besk) as kgeb
              from (
                select d.total_oere - d.refusion_oere as beholdt,
                       least(d.beskyttelse_oere, d.total_oere - d.refusion_oere) as besk
              ) y
          ) x
      ) f
     where d.status = 'refunderet'
       and d.er_delvis
       and not d.givet_til_saelger
       and d.overfoersel_paabegyndt_kl is null
  ),
  refunderet as (
    select b.* from b, g
     where b.status = 'refunderet'
       and b.refunderet_kl >= g.fra and b.refunderet_kl < g.til
  ),
  ref_i_gang as (
    select b.* from b, g
     where b.status = 'betalt'
       and b.refusion_anmodet_kl is not null
       and b.refusion_anmodet_kl >= g.fra and b.refusion_anmodet_kl < g.til
  ),
  overfoert as (
    select b.* from b, g
     where b.givet_til_saelger
       and b.overfoert_kl >= g.fra and b.overfoert_kl < g.til
  ),
  indsigelser as (
    select b.*,
           (b.givet_til_saelger or b.overfoersel_paabegyndt_kl is not null) as efter_udbetaling
      from b, g
     where b.indsigelse_kl is not null
       and b.indsigelse_kl >= g.fra and b.indsigelse_kl < g.til
  ),
  afv_modtaget as (
    select a.* from public.betaling_afvigelser a, g
     where a.oprettet >= g.fra and a.oprettet < g.til
  ),
  afv_refunderet as (
    select a.* from public.betaling_afvigelser a, g
     where a.refunderet_kl is not null
       and a.refunderet_kl >= g.fra and a.refunderet_kl < g.til
  )
  select jsonb_build_object(
    'betalinger_modtaget', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(total_oere), 0)) from betalt),
    'forkerte_beloeb_modtaget', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(modtaget_oere), 0)) from afv_modtaget),
    'omsaetning', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(bud_oere), 0)) from aktive),
    'indtjening', (
      select jsonb_build_object(
        'koebergebyr',  a.kgeb + d.kgeb,
        'saelgergebyr', a.sgeb,
        'beskyttelse',  a.besk + d.besk,
        'oevrigt',      d.oevrigt,
        'i_alt',        a.kgeb + d.kgeb + a.sgeb + a.besk + d.besk + d.oevrigt,
        'heraf_ikke_frigivet', a.ikke_frigivet,
        'antal_beskyttelse', a.antal_besk)
        from (select coalesce(sum(koebergebyr_oere), 0)  as kgeb,
                     coalesce(sum(saelgergebyr_oere), 0) as sgeb,
                     coalesce(sum(beskyttelse_oere), 0)  as besk,
                     count(*) filter (where beskyttelse)  as antal_besk,
                     coalesce(sum(koebergebyr_oere + saelgergebyr_oere + beskyttelse_oere)
                              filter (where not givet_til_saelger), 0) as ikke_frigivet
                from aktive) a,
             (select coalesce(sum(kgeb), 0) as kgeb,
                     coalesce(sum(besk), 0) as besk,
                     coalesce(sum(oevrigt), 0) as oevrigt
                from delvis) d),
    'fragt', (select jsonb_build_object(
        'beloeb', (select coalesce(sum(fragt_oere), 0) from aktive)
                  + (select coalesce(sum(fragt), 0) from delvis),
        'antal',  (select count(*) from aktive where fragt_oere > 0))),
    'udbetalinger', (select jsonb_build_object(
        'antal', count(*), 'beloeb', coalesce(sum(udbetaling_oere), 0)) from overfoert),
    'refusioner', jsonb_build_object(
        'fulde', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0))
            from refunderet where not er_delvis),
        'delvise', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0))
            from refunderet where er_delvis),
        'i_gang', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(ref_beloeb), 0)) from ref_i_gang),
        'forkerte_beloeb', (select jsonb_build_object(
            'antal', count(*), 'beloeb', coalesce(sum(modtaget_oere), 0)) from afv_refunderet),
        'efter_udbetaling', (select jsonb_build_object(
            'antal', count(*),
            'refunderet', coalesce(sum(ref_beloeb), 0),
            'udbetalt', coalesce(sum(udbetaling_oere), 0))
            from refunderet
           where givet_til_saelger or overfoersel_paabegyndt_kl is not null)),
    'indsigelser', (select jsonb_build_object(
        'antal',  count(*),
        'beloeb', coalesce(sum(total_oere), 0),
        'aabne',  count(*) filter (where public.betaling_indsigelse_blokerer(indsigelse_kl, indsigelse_status)
                                    and coalesce(indsigelse_status, '') <> 'lost'),
        'vundet', count(*) filter (where indsigelse_status = 'won'),
        'lukket', count(*) filter (where indsigelse_status in ('warning_closed', 'prevented')),
        'tabt_foer_udbetaling', jsonb_build_object(
            'antal',  count(*) filter (where indsigelse_status = 'lost' and not efter_udbetaling),
            'beloeb', coalesce(sum(total_oere) filter (
                        where indsigelse_status = 'lost' and not efter_udbetaling), 0)),
        'tabt_efter_udbetaling', jsonb_build_object(
            'antal',  count(*) filter (where indsigelse_status = 'lost' and efter_udbetaling),
            'beloeb', coalesce(sum(total_oere) filter (
                        where indsigelse_status = 'lost' and efter_udbetaling), 0),
            'tab',    coalesce(sum(udbetaling_oere + fragt_oere) filter (
                        where indsigelse_status = 'lost' and efter_udbetaling), 0)))
        from indsigelser)
  );
$function$;

revoke all on function public.admin_penge_tal(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_penge_tal(timestamptz, timestamptz) to service_role;

-- ===========================================================================
-- 7. Sælgerens udbetalingsstatus (hjemmesiden og appen)
-- ===========================================================================
-- saelger_udbetalinger kan ikke læses af brugere. Sælgeren får sin egen
-- status gennem to funktioner (auth.uid() = sælgeren). Ingen interne
-- fejltekster - kun faste koder.

-- Én handel (betalingsmodel destination, frigivet). null = ikke relevant
-- (separat, ikke frigivet, eller ikke sælgerens handel).
-- {status: venter|stoppet|kraever_handling|paa_vej|udbetalt|venter_paa_bank, tidligst_kl,
--  sendt_kl, beloeb_oere}
create or replace function public.handel_udbetalingsstatus(p_trade uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  b       record;
  u       record;
  v_grund text;
  v_tid   timestamptz;
begin
  if v_uid is null or p_trade is null then return null; end if;
  select * into b from public.betalinger
   where trade_id = p_trade and seller_id = v_uid
   order by oprettet desc, id
   limit 1;
  if not found or b.pengemodel <> 'destination' or b.status <> 'betalt' or b.frigivet_kl is null then
    return null;
  end if;
  if b.saelger_udbetaling_id is not null then
    select * into u from public.saelger_udbetalinger where id = b.saelger_udbetaling_id;
    if u.status = 'paid' then
      return jsonb_build_object('status', 'udbetalt', 'tidligst_kl', null,
                                'sendt_kl', u.betalt_kl, 'beloeb_oere', b.udbetaling_oere);
    end if;
    return jsonb_build_object('status', 'paa_vej', 'tidligst_kl', null,
                              'sendt_kl', coalesce(u.oprettet_hos_stripe_kl, b.overfoert_kl),
                              'beloeb_oere', b.udbetaling_oere);
  end if;
  v_grund := public.betaling_udbetaling_blokeret(b.id);
  if v_grund = 'venter_paa_bank' then
    return jsonb_build_object('status', 'venter_paa_bank', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere);
  end if;
  if v_grund in ('udbetalinger_inaktive', 'plan_ikke_manuel', 'transfer_ukendt') then
    return jsonb_build_object('status', 'kraever_handling', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere);
  end if;
  if v_grund in ('refusion', 'indsigelse', 'svindelvarsel', 'radar_review', 'handel_annulleret',
                 'sag_aaben', 'kraever_opmaerksomhed', 'konto_frakoblet', 'konto_skiftet') then
    return jsonb_build_object('status', 'stoppet', 'tidligst_kl', null,
                              'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere);
  end if;
  v_tid := greatest(b.midler_tilgaengelige_kl, b.udbetal_tidligst);
  return jsonb_build_object('status', 'venter',
                            'tidligst_kl', case when v_tid > now() then v_tid end,
                            'sendt_kl', null, 'beloeb_oere', b.udbetaling_oere);
end;
$fn$;

revoke all on function public.handel_udbetalingsstatus(uuid) from public, anon, authenticated;
grant execute on function public.handel_udbetalingsstatus(uuid) to authenticated, service_role;

-- Sælgerens seneste udbetalinger til banken (højst 20).
-- [{id, kl, beloeb_oere, status: paa_vej|udbetalt|fejlet|annulleret, antal_handler}]
create or replace function public.mine_bankudbetalinger()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id,
           'kl', coalesce(x.betalt_kl, x.oprettet_hos_stripe_kl, x.oprettet),
           'beloeb_oere', x.beloeb_oere,
           'status', case x.status when 'paid' then 'udbetalt' when 'oprettet' then 'paa_vej'
                                  when 'canceled' then 'annulleret' else 'fejlet' end,
           'antal_handler', coalesce(array_length(x.betaling_ids, 1), 0))
         order by x.oprettet desc), '[]'::jsonb)
    from (select * from public.saelger_udbetalinger u
           where u.seller_id = auth.uid()
             and u.status in ('oprettet', 'paid', 'failed', 'canceled')
           order by u.oprettet desc
           limit 20) x;
$fn$;

revoke all on function public.mine_bankudbetalinger() from public, anon, authenticated;
grant execute on function public.mine_bankudbetalinger() to authenticated, service_role;
