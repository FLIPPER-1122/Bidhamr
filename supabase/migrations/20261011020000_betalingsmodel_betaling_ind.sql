-- Ny betalingsmodel, trin 2: betaling ind (docs/BETALINGSMODEL-PLAN.md afsnit 6.2).
-- ROADMAP-BESLUTNINGER.md "Ny betalingsmodel – Filips svar (8. okt. 2026)".
--
-- Som trin 1: INTET ændres for 'separat', så længe databasens
-- stripe_tilstand.betalingsmodel er 'separat' (i dag). Alt nyt i dette trin
-- slår kun til, når databasen står til 'destination' (og serveren bruger kun
-- destination, når også STRIPE_BETALINGSMODEL=destination - model.ts).
--
--  1. Betalingen VENTER på sælgerens konto (Filip: "konto før auktion"):
--     slutter en auktion, mens sælgerens Connect-konto endnu ikke kan tage
--     imod betaling (charges_enabled + card_payments aktiv + manuel plan),
--     oprettes betalingen som "venter" (venter_paa_saelgerkonto_kl).
--     Betalingsfristen på 48 t starter først, når betalingen åbner
--     (betaling_aabnet_kl). Mens den venter, står betal_senest til fristen
--     for, hvornår kontoen senest skal være godkendt (7 dage efter
--     auktionens slutning) - ingen påmindelser, ingen "ubetalt vinder".
--  2. Bliver kontoen ikke godkendt inden for 7 dage (Filip 8. okt. 2026):
--     handlen og auktionen annulleres (køberen trækkes ikke), og sælgerens
--     konto fryses (saelger_frosset_kl): kan ikke oprette auktioner, og der
--     kan ikke bydes på sælgerens auktioner, til Stripe har godkendt kontoen.
--  3. Skiftet separat -> destination: en betaling, der afventer med en
--     separat-PaymentIntent, kan skiftes til destination, når den gamle
--     PaymentIntent er annulleret hos Stripe (betaling_klargoer_destination).
--  4. Tidligt svindelvarsel fra Stripe (radar.early_fraud_warning): markering
--     til staff (betaling_registrer_svindelvarsel). Ingen automatisk
--     refusion. Pengene gives ikke til sælger, før staff har kigget
--     (svindelvarsel_loest_kl sættes, når staff lukker markeringen) - også i
--     separat (betaling_claim_overfoersel).
--  5. betaling_udbetaling_blokeret(): ALLE grunde til, at pengene ikke må
--     udbetales endnu (bruges af trin 3 før hver payout).
--  6. har_udbetalingskonto: med destination kræves (som Filip har besluttet)
--     kun, at kontoen er oprettet med kortbetaling anmodet og oplysningerne
--     sendt ind - auktionen må køre, mens Stripe godkender. Frosset sælger =
--     nej.
--
-- Idempotent. Ændrer ingen handelsdata. Nye funktioner: security definer med
-- search_path = ''.

set local lock_timeout = '5s';

-- ===========================================================================
-- Kolonner
-- ===========================================================================
alter table public.betalinger
  add column if not exists venter_paa_saelgerkonto_kl timestamptz,
  add column if not exists venter_aarsag              text,
  add column if not exists betaling_aabnet_kl         timestamptz,
  add column if not exists aabnet_besked_sendt_kl     timestamptz,
  add column if not exists venter_paamindet_kl        timestamptz,
  add column if not exists tidligere_payment_intents  text[] not null default '{}',
  add column if not exists stripe_svindelvarsel_id    text,
  add column if not exists svindelvarsel_loest_kl     timestamptz;

comment on column public.betalinger.venter_paa_saelgerkonto_kl is
  'Destination: betalingen venter på, at sælgerens Stripe-konto kan tage imod betaling. Imens står betal_senest til fristen for kontoens godkendelse (ikke købers betalingsfrist). null = betalingen er åben.';
comment on column public.betalinger.betaling_aabnet_kl is
  'Hvornår en ventende betaling åbnede (sælgerens konto godkendt). Betalingsfristen (48 t, højst 7 dage med forlængelse) regnes herfra i stedet for oprettet.';
comment on column public.betalinger.tidligere_payment_intents is
  'PaymentIntents, der er annulleret og erstattet (fx separat -> destination ved skiftet). Til revision.';
comment on column public.betalinger.svindelvarsel_loest_kl is
  'Staff har lukket markeringen efter et tidligt svindelvarsel (sættes automatisk, når kraever_opmaerksomhed går fra true til false). Indtil da gives pengene ikke til sælger.';

alter table public.betalingsprofiler
  add column if not exists saelger_frosset_kl    timestamptz,
  add column if not exists saelger_frosset_aarsag text;

comment on column public.betalingsprofiler.saelger_frosset_kl is
  'Sælgerens konto er frosset, fordi Stripe ikke godkendte udbetalingskontoen i tide (en auktion er annulleret). Kan ikke oprette auktioner, og der kan ikke bydes på sælgerens auktioner. Ophæves automatisk, når kontoen kan tage imod betaling. Kun service role skriver.';

-- Køber og sælger (RLS: egen række) må se, om betalingen venter.
grant select (venter_paa_saelgerkonto_kl, betaling_aabnet_kl) on public.betalinger to authenticated;

create index if not exists betalinger_venter_idx
  on public.betalinger (seller_id)
  where venter_paa_saelgerkonto_kl is not null;

-- ===========================================================================
-- Kan sælgerens konto tage imod betaling nu?
-- ===========================================================================
-- separat: altid ja (som i dag). destination: spejlet fra Stripe
-- (spejlConnectKonto) - charges_enabled, card_payments aktiv og manuel
-- udbetalingsplan, ikke frakoblet eller afvist. Serveren tjekker desuden
-- kontoen FRISK hos Stripe, før en PaymentIntent laves.
create or replace function public.saelger_kan_modtage_betaling(p_saelger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.betalingsmodel_aktiv() = 'separat'
      or exists (
        select 1 from public.betalingsprofiler bp
         where bp.user_id = p_saelger
           and bp.stripe_account_id is not null
           and bp.connect_frakoblet_kl is null
           and coalesce(bp.connect_spaerret_aarsag, '') not like 'rejected.%'
           and bp.connect_charges_enabled
           and bp.connect_kort_aktiv
           and bp.connect_plan_ok);
$fn$;

revoke all on function public.saelger_kan_modtage_betaling(uuid) from public, anon, authenticated;
grant execute on function public.saelger_kan_modtage_betaling(uuid) to service_role;

-- Fristen for, hvornår sælgerens konto senest skal være godkendt: 7 dage
-- efter auktionens slutning (= betalingens oprettelse), dog mindst 48 timer
-- fra nu (en konto, der først spærres senere, får også tid).
create or replace function public.betaling_venter_frist(p_oprettet timestamptz)
returns timestamptz
language sql
stable
set search_path = ''
as $fn$
  select date_trunc('second', greatest(p_oprettet + interval '7 days', now() + interval '48 hours'));
$fn$;

revoke all on function public.betaling_venter_frist(timestamptz) from public, anon, authenticated;
grant execute on function public.betaling_venter_frist(timestamptz) to service_role;

-- ===========================================================================
-- 1. Ny betaling: venter, hvis sælgerens konto ikke er klar
-- ===========================================================================
create or replace function public.betalinger_venter_ved_oprettelse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status = 'afventer'
     and new.stripe_payment_intent_id is null
     and not public.saelger_kan_modtage_betaling(new.seller_id) then
    new.venter_paa_saelgerkonto_kl := now();
    new.venter_aarsag := 'saelgerkonto_ikke_klar';
    new.betal_senest := public.betaling_venter_frist(coalesce(new.oprettet, now()));
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_venter_ved_oprettelse() from public, anon, authenticated;

drop trigger if exists betalinger_venter_ved_oprettelse on public.betalinger;
create trigger betalinger_venter_ved_oprettelse
  before insert on public.betalinger
  for each row execute function public.betalinger_venter_ved_oprettelse();

-- Ved hver ændring:
--   - betalt: venter ophører (en betaling er gået igennem alligevel).
--   - staff lukker markeringen (kraever_opmaerksomhed true -> false) efter et
--     svindelvarsel: svindelvarsel_loest_kl sættes.
--   - destination: application_fee_oere følger altid beløbene (CHECK
--     betalinger_destination_gebyr_stemmer), så en rettelse af fx
--     BidHamr Beskyttelse aldrig bryder constraint'en. PaymentIntentens fee
--     rettes af serveren (sikrPaymentIntent).
create or replace function public.betalinger_trin2_vedligehold()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status = 'betalt' and new.venter_paa_saelgerkonto_kl is not null then
    new.venter_paa_saelgerkonto_kl := null;
    new.venter_aarsag := null;
    new.betaling_aabnet_kl := coalesce(new.betaling_aabnet_kl, now());
  end if;
  if old.kraever_opmaerksomhed and not new.kraever_opmaerksomhed
     and new.svindelvarsel_kl is not null and new.svindelvarsel_loest_kl is null then
    new.svindelvarsel_loest_kl := now();
  end if;
  if new.pengemodel = 'destination' and new.application_fee_oere is not null then
    new.application_fee_oere := new.koebergebyr_oere + new.saelgergebyr_oere
                                + new.fragt_oere + new.beskyttelse_oere;
  end if;
  return new;
end;
$fn$;

revoke all on function public.betalinger_trin2_vedligehold() from public, anon, authenticated;

drop trigger if exists betalinger_trin2_vedligehold on public.betalinger;
create trigger betalinger_trin2_vedligehold
  before update on public.betalinger
  for each row execute function public.betalinger_trin2_vedligehold();

-- ===========================================================================
-- Sæt en åben betaling til at vente (serverens friske kontotjek fejlede)
-- ===========================================================================
create or replace function public.betaling_saet_venter(p_betaling uuid, p_aarsag text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found or b.status <> 'afventer' or b.stripe_charge_id is not null then
    return false;
  end if;
  if b.venter_paa_saelgerkonto_kl is not null then
    return true;
  end if;
  update public.betalinger
     set venter_paa_saelgerkonto_kl = now(),
         venter_aarsag = left(coalesce(nullif(btrim(p_aarsag), ''), 'saelgerkonto_ikke_klar'), 200),
         betal_senest = public.betaling_venter_frist(b.oprettet),
         paamindelse_24_sendt_kl = null,
         paamindelse_40_sendt_kl = null,
         aabnet_besked_sendt_kl = null,
         venter_paamindet_kl = null,
         opdateret = now()
   where id = b.id;
  return true;
end;
$fn$;

revoke all on function public.betaling_saet_venter(uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_saet_venter(uuid, text) to service_role;

-- ===========================================================================
-- Åbn ventende betalinger, hvis sælgerens konto nu kan tage imod betaling
-- ===========================================================================
-- Fristen på 48 t starter nu. Ophæver også en frysning af sælgeren.
-- Returnerer de åbnede betalingers id'er.
create or replace function public.betaling_aabn_ventende(p_saelger uuid default null)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  -- Frysning ophæves for sælgere, hvis konto nu kan tage imod betaling.
  update public.betalingsprofiler bp
     set saelger_frosset_kl = null, saelger_frosset_aarsag = null, opdateret = now()
   where bp.saelger_frosset_kl is not null
     and (p_saelger is null or bp.user_id = p_saelger)
     and public.saelger_kan_modtage_betaling(bp.user_id);

  for b in
    select bt.id, bt.trade_id
      from public.betalinger bt
     where bt.venter_paa_saelgerkonto_kl is not null
       and bt.status = 'afventer'
       and (p_saelger is null or bt.seller_id = p_saelger)
       and public.saelger_kan_modtage_betaling(bt.seller_id)
     order by bt.venter_paa_saelgerkonto_kl
     limit 500
     for update of bt skip locked
  loop
    if not exists (select 1 from public.trades t
                    where t.id = b.trade_id and t.status = 'afventer_betaling') then
      continue;
    end if;
    update public.betalinger
       set venter_paa_saelgerkonto_kl = null,
           venter_aarsag = null,
           betaling_aabnet_kl = now(),
           betal_senest = date_trunc('second', now() + interval '48 hours'),
           paamindelse_24_sendt_kl = null,
           paamindelse_40_sendt_kl = null,
           aabnet_besked_sendt_kl = null,
           opdateret = now()
     where id = b.id;
    return next b.id;
  end loop;
  return;
end;
$fn$;

revoke all on function public.betaling_aabn_ventende(uuid) from public, anon, authenticated;
grant execute on function public.betaling_aabn_ventende(uuid) to service_role;

-- ===========================================================================
-- 2. Kontoen blev ikke godkendt i tide: annullér og frys sælgeren
-- ===========================================================================
-- Kun betalinger, der stadig venter, hvis frist er udløbet, og hvis sælger
-- STADIG ikke kan tage imod betaling. Køberen trækkes ikke (der er ingen
-- betalt charge), og der oprettes ingen "ubetalt vinder"-sag (køberen har
-- intet gjort forkert). Returnerer pr. annulleret handel: trade_id,
-- auction_id, buyer_id, seller_id og payment_intent (skal annulleres hos
-- Stripe af serveren, hvis den findes).
create or replace function public.betaling_annuller_ikke_godkendt_saelgerkonto()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b   record;
  res jsonb;
  ud  jsonb := '[]'::jsonb;
begin
  for b in
    select bt.*
      from public.betalinger bt
     where bt.venter_paa_saelgerkonto_kl is not null
       and bt.status = 'afventer'
       and bt.stripe_charge_id is null
       and bt.betal_senest <= now()
     order by bt.betal_senest
     limit 100
     for update of bt skip locked
  loop
    if public.saelger_kan_modtage_betaling(b.seller_id) then
      continue; -- åbnes af betaling_aabn_ventende
    end if;
    res := public.betaling_annuller(b.trade_id);
    if res is null then
      continue;
    end if;
    update public.betalinger
       set venter_aarsag = 'annulleret_saelgerkonto_ikke_godkendt', opdateret = now()
     where id = b.id;
    update public.auctions
       set status = 'annulleret'
     where id = b.auction_id and status <> 'annulleret';
    update public.betalingsprofiler
       set saelger_frosset_kl = coalesce(saelger_frosset_kl, now()),
           saelger_frosset_aarsag = coalesce(saelger_frosset_aarsag,
             'Stripe godkendte ikke udbetalingskontoen inden for 7 dage efter auktionens slutning'),
           opdateret = now()
     where user_id = b.seller_id;
    ud := ud || jsonb_build_array(jsonb_build_object(
      'trade_id', b.trade_id, 'auction_id', b.auction_id, 'buyer_id', b.buyer_id,
      'seller_id', b.seller_id, 'betaling_id', b.id,
      'payment_intent', res->>'payment_intent'));
  end loop;
  return ud;
end;
$fn$;

revoke all on function public.betaling_annuller_ikke_godkendt_saelgerkonto() from public, anon, authenticated;
grant execute on function public.betaling_annuller_ikke_godkendt_saelgerkonto() to service_role;

-- Frosset sælger: der kan ikke bydes på sælgerens auktioner.
create or replace function public.bids_kraev_saelger_ikke_frosset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (
    select 1
      from public.auctions a
      join public.betalingsprofiler bp on bp.user_id = a.bruger_id
     where a.id = new.auktion_id
       and bp.saelger_frosset_kl is not null) then
    raise exception 'saelger_frosset: Sælgerens konto er sat på pause, til vores betalingspartner Stripe har godkendt den. Du kan ikke byde lige nu.'
      using errcode = 'BHU03';
  end if;
  return new;
end;
$fn$;

revoke all on function public.bids_kraev_saelger_ikke_frosset() from public, anon, authenticated;

drop trigger if exists bids_kraev_saelger_ikke_frosset on public.bids;
create trigger bids_kraev_saelger_ikke_frosset
  before insert on public.bids
  for each row execute function public.bids_kraev_saelger_ikke_frosset();

-- ===========================================================================
-- 6. har_udbetalingskonto (opret auktion m.m.)
-- ===========================================================================
-- Filip 8. okt. 2026: kontoen skal være oprettet og oplysningerne sendt ind;
-- auktionen må køre, mens Stripe godkender (pengene venter - afsnit 1).
-- Med destination kræves desuden, at kortbetaling (card_payments) er anmodet
-- på kontoen (ellers kan den aldrig tage imod betaling). Frosset = nej.
create or replace function public.har_udbetalingskonto(p_bruger uuid)
returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.betalingsprofiler
     where user_id = p_bruger
       and stripe_account_id is not null
       and connect_detaljer_indsendt
       and connect_frakoblet_kl is null
       and saelger_frosset_kl is null
       and coalesce(connect_spaerret_aarsag, '') not like 'rejected.%'
       and (public.betalingsmodel_aktiv() = 'separat'
            or connect_betalingsmetoder ? 'card_payments')
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;

-- Tydelig fejl, når sælgeren er frosset (ellers som før).
create or replace function public.auctions_kraev_udbetalingskonto()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if auth.uid() is null
     and current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  if new.bruger_id is not null and exists (
       select 1 from public.betalingsprofiler
        where user_id = new.bruger_id and saelger_frosset_kl is not null) then
    raise exception 'saelger_frosset: Din udbetalingskonto er ikke godkendt af vores betalingspartner Stripe. Du kan sætte varer til salg igen, når Stripe har godkendt den.'
      using errcode = 'BHU02';
  end if;
  if new.bruger_id is null or not public.har_udbetalingskonto(new.bruger_id) then
    raise exception 'Du skal oprette en udbetalingskonto, før du kan sætte varer til salg.'
      using errcode = 'BHU01';
  end if;
  return new;
end;
$fn$;

-- ===========================================================================
-- 3. Skiftet separat -> destination og lås af sælgerkonto/gebyr
-- ===========================================================================
-- pengemodel-låsen (trin 1) tillader skiftet, når betaling_klargoer_destination
-- har sat bidhamr.pengemodel_skift (kun den funktion gør det) - den gamle
-- PaymentIntent er da annulleret hos Stripe af serveren.
create or replace function public.betalinger_pengemodel_laas()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.pengemodel is distinct from old.pengemodel
     and (old.status <> 'afventer' or old.stripe_charge_id is not null
          or old.stripe_payment_intent_id is not null)
     and not (coalesce(current_setting('bidhamr.pengemodel_skift', true), '') = 'ja'
              and old.status = 'afventer' and old.stripe_charge_id is null
              and new.stripe_payment_intent_id is null) then
    raise exception 'betalinger_pengemodel_laast: pengemodel kan ikke ændres efter betaling';
  end if;
  return new;
end;
$$;

-- Låser sælgerens konto og BidHamrs gebyr på betalingen, før en destination-
-- PaymentIntent oprettes. p_gammel_pi: en separat-PaymentIntent, som
-- serveren HAR annulleret hos Stripe (null, hvis der ingen er).
-- Svar: 'klar' (klar til ny PaymentIntent), 'har_pi' (destination-PI findes
-- allerede), 'venter', 'ikke_afventer', 'pi_aendret', 'konto_aendret'.
create or replace function public.betaling_klargoer_destination(
  p_betaling uuid, p_konto text, p_gammel_pi text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b     record;
  konto text;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found or b.status <> 'afventer' or b.stripe_charge_id is not null then
    return 'ikke_afventer';
  end if;
  if b.venter_paa_saelgerkonto_kl is not null then
    return 'venter';
  end if;
  select bp.stripe_account_id into konto
    from public.betalingsprofiler bp where bp.user_id = b.seller_id;
  if konto is null or konto is distinct from p_konto then
    return 'konto_aendret';
  end if;

  if b.pengemodel = 'destination' then
    if b.stripe_payment_intent_id is not null then
      return 'har_pi';
    end if;
    update public.betalinger
       set saelger_stripe_konto = p_konto,
           application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere + beskyttelse_oere,
           opdateret = now()
     where id = b.id;
    return 'klar';
  end if;

  -- separat -> destination
  if b.stripe_payment_intent_id is distinct from p_gammel_pi then
    return 'pi_aendret';
  end if;
  perform set_config('bidhamr.pengemodel_skift', 'ja', true);
  update public.betalinger
     set pengemodel = 'destination',
         tidligere_payment_intents = case when b.stripe_payment_intent_id is null
                                          then tidligere_payment_intents
                                          else tidligere_payment_intents || b.stripe_payment_intent_id end,
         stripe_payment_intent_id = null,
         pi_forsoeg = case when b.stripe_payment_intent_id is null then pi_forsoeg else pi_forsoeg + 1 end,
         saelger_stripe_konto = p_konto,
         application_fee_oere = koebergebyr_oere + saelgergebyr_oere + fragt_oere + beskyttelse_oere,
         opdateret = now()
   where id = b.id;
  perform set_config('bidhamr.pengemodel_skift', '', true);
  return 'klar';
end;
$fn$;

revoke all on function public.betaling_klargoer_destination(uuid, text, text) from public, anon, authenticated;
grant execute on function public.betaling_klargoer_destination(uuid, text, text) to service_role;

-- ===========================================================================
-- 4. Tidligt svindelvarsel
-- ===========================================================================
create or replace function public.betaling_registrer_svindelvarsel(
  p_payment_intent text, p_charge text, p_varsel text, p_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
begin
  select * into b from public.betalinger
   where (p_payment_intent is not null and stripe_payment_intent_id = p_payment_intent)
      or (p_charge is not null and stripe_charge_id = p_charge)
   limit 1
   for update;
  if not found then
    return 'ukendt';
  end if;
  if b.stripe_svindelvarsel_id is not distinct from p_varsel then
    return 'allerede';
  end if;
  update public.betalinger
     set svindelvarsel_kl = coalesce(svindelvarsel_kl, now()),
         stripe_svindelvarsel_id = p_varsel,
         svindelvarsel_loest_kl = null,
         kraever_opmaerksomhed = true,
         sidste_fejl = left('Tidligt svindelvarsel fra Stripe (' || coalesce(nullif(p_type, ''), 'ukendt')
           || ') - pengene gives ikke til sælger, før staff har kigget på handlen. Ingen automatisk refusion.', 500),
         opdateret = now()
   where id = b.id;
  return 'markeret';
end;
$fn$;

revoke all on function public.betaling_registrer_svindelvarsel(text, text, text, text) from public, anon, authenticated;
grant execute on function public.betaling_registrer_svindelvarsel(text, text, text, text) to service_role;

-- ===========================================================================
-- 5. Hvorfor må pengene (endnu) ikke udbetales? (trin 3)
-- ===========================================================================
-- null = intet blokerer. Filip (ufravigeligt): intet udbetales, før handlen
-- er helt færdig; sag eller indsigelse fryser pengene, til de er afgjort.
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
    if not bp.connect_plan_ok then return 'plan_ikke_manuel'; end if;
  end if;
  return null;
end;
$fn$;

revoke all on function public.betaling_udbetaling_blokeret(uuid) from public, anon, authenticated;
grant execute on function public.betaling_udbetaling_blokeret(uuid) to service_role;

-- ===========================================================================
-- Gammel transfer (separat): heller ikke ved uløst svindelvarsel
-- ===========================================================================
create or replace function public.betaling_claim_overfoersel(p_betaling uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  b record;
  t record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return false; end if;
  select * into t from public.trades where id = b.trade_id for update;

  if b.pengemodel <> 'separat'
     or b.status <> 'betalt'
     or b.frigivet_kl is null
     or b.refusion_anmodet_kl is not null
     or b.stripe_charge_id is null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or (b.svindelvarsel_kl is not null and b.svindelvarsel_loest_kl is null)
     or t.sag_aaben
     or t.status = 'annulleret' then
    return false;
  end if;

  update public.betalinger
     set overfoersel_paabegyndt_kl = coalesce(overfoersel_paabegyndt_kl, now()),
         opdateret = now()
   where id = b.id;
  return true;
end;
$$;

revoke all on function public.betaling_claim_overfoersel(uuid) from public, anon, authenticated;
grant execute on function public.betaling_claim_overfoersel(uuid) to service_role;

-- ===========================================================================
-- Ventende betalinger: ingen "ubetalt vinder" og ingen forlængelse
-- ===========================================================================
-- Rettes på stedet (som trin 1): mønstrene skal findes præcis én gang.
create or replace function pg_temp.bm2_ret(p_fn text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  e     jsonb;
  n     integer;
begin
  if position('venter_paa_saelgerkonto_kl' in v_def) > 0 then
    return 'allerede';
  end if;
  for e in select * from jsonb_array_elements(p_par) loop
    n := (length(v_def) - length(replace(v_def, e->>0, ''))) / length(e->>0);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, e->>0, n;
    end if;
    v_def := replace(v_def, e->>0, e->>1);
  end loop;
  execute v_def;
  return 'rettet';
end
$f$;

do $do$
begin
  raise notice 'ubetalt_vinder_annuller: %', pg_temp.bm2_ret(
    'public.ubetalt_vinder_annuller(uuid,boolean)', jsonb_build_array(
      jsonb_build_array(
        '  if not ((b.status = ''afventer'' and b.betal_senest < now())',
        '  if b.venter_paa_saelgerkonto_kl is not null or not ((b.status = ''afventer'' and b.betal_senest < now())',
        1)));
  raise notice 'handel_forlaeng_betalingsfrist: %', pg_temp.bm2_ret(
    'public.handel_forlaeng_betalingsfrist(uuid,timestamp with time zone)', jsonb_build_array(
      jsonb_build_array(
        '  if b.betal_senest <= now() then',
        E'  if b.venter_paa_saelgerkonto_kl is not null then\n    return jsonb_build_object(''kode'', ''venter_paa_saelgerkonto'');\n  end if;\n  if b.betal_senest <= now() then',
        1),
      jsonb_build_array(
        'v_maks := date_trunc(''second'', b.oprettet + interval ''7 days'');',
        'v_maks := date_trunc(''second'', coalesce(b.betaling_aabnet_kl, b.oprettet) + interval ''7 days'');',
        1)));
end $do$;

drop function pg_temp.bm2_ret(text, jsonb);
