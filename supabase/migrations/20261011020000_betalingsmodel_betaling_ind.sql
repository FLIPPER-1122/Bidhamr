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
--     refusion. Pengene gives ikke til sælger, før admin/chef eksplicit har
--     gennemgået varslet (betaling_svindelvarsel_gennemgaaet, logger hvem) -
--     også i separat (betaling_claim_overfoersel). Indtil da kan markeringen
--     til staff ikke lukkes.
--  5. betaling_udbetaling_blokeret(): ALLE grunde til, at pengene ikke må
--     udbetales endnu (bruges af trin 3 før hver payout).
--  6. har_udbetalingskonto: med destination kræves (som Filip har besluttet)
--     kun, at kontoen er oprettet med kortbetaling anmodet og oplysningerne
--     sendt ind - auktionen må køre, mens Stripe godkender. Frosset sælger =
--     nej.
--
--  7. Destination-låse: sælgerkonto og gebyr kan ikke ændres, når der findes
--     en PaymentIntent (undtagen kontrolleret nulstilling), og beløbene ikke,
--     når der findes en charge (betalinger_trin2_vedligehold).
--  8. ubetalt_vinder_annuller og handel_forlaeng_betalingsfrist genoprettes
--     helt (efter et drift-tjek af den nuværende definition).
--
-- Idempotent. Ændrer ingen handelsdata. Nye og ændrede funktioner: security
-- definer med search_path = '' (de to genoprettede beholder search_path =
-- public som før).

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
  add column if not exists svindelvarsel_loest_kl     timestamptz,
  add column if not exists svindelvarsel_loest_af     uuid references public.users(id) on delete set null,
  add column if not exists svindelvarsel_note         text;

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

-- Fristen for, hvornår sælgerens konto senest skal være godkendt: fast 7 dage
-- efter auktionens slutning (= betalingens oprettelse). Også når kontoen
-- først spærres senere - så annulleringen altid sker (ingen løkke).
create or replace function public.betaling_venter_frist(p_oprettet timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $fn$
  select date_trunc('second', p_oprettet + interval '7 days');
$fn$;

revoke all on function public.betaling_venter_frist(timestamptz) from public, anon, authenticated;
grant execute on function public.betaling_venter_frist(timestamptz) to service_role;

-- Kan en ventende betaling åbnes nu? Sælgerens konto kan tage imod betaling
-- (spejlet), og er sælgerkontoen låst på betalingen, er det stadig den konto.
create or replace function public.betaling_kan_aabnes(p_betaling uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.betalinger bt
      join public.betalingsprofiler bp on bp.user_id = bt.seller_id
     where bt.id = p_betaling
       and public.saelger_kan_modtage_betaling(bt.seller_id)
       and (bt.saelger_stripe_konto is null or bt.saelger_stripe_konto = bp.stripe_account_id));
$fn$;

revoke all on function public.betaling_kan_aabnes(uuid) from public, anon, authenticated;
grant execute on function public.betaling_kan_aabnes(uuid) to service_role;

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

-- Ved hver ændring (BEFORE UPDATE):
--   - betalt: venter ophører (en betaling er gået igennem alligevel).
--   - uløst svindelvarsel: markeringen til staff kan ikke fjernes, før staff
--     eksplicit har gennemgået varslet (betaling_svindelvarsel_gennemgaaet).
--   - destination: application_fee_oere følger beløbene, så længe betalingen
--     afventer uden charge (CHECK betalinger_destination_gebyr_stemmer).
--   - destination: sælgerkonto og gebyr kan ikke ændres, når der findes en
--     PaymentIntent - undtagen den kontrollerede nulstilling (PaymentIntent
--     fjernes og pi_forsoeg + 1, fx ved skiftet eller når betalingen sættes
--     til at vente). Beløbene kan ikke ændres, når der findes en charge.
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
  if new.svindelvarsel_kl is not null and new.svindelvarsel_loest_kl is null then
    new.kraever_opmaerksomhed := true;
  end if;
  if new.pengemodel = 'destination' and new.application_fee_oere is not null
     and new.status = 'afventer' and new.stripe_charge_id is null then
    new.application_fee_oere := new.koebergebyr_oere + new.saelgergebyr_oere
                                + new.fragt_oere + new.beskyttelse_oere;
  end if;
  if new.pengemodel = 'destination' then
    if old.stripe_payment_intent_id is not null
       and (new.saelger_stripe_konto is distinct from old.saelger_stripe_konto
            or new.application_fee_oere is distinct from old.application_fee_oere)
       and not (new.stripe_payment_intent_id is null and new.pi_forsoeg = old.pi_forsoeg + 1) then
      raise exception 'betalinger_destination_laast: sælgerkonto og gebyr kan ikke ændres, når der findes en PaymentIntent';
    end if;
    if old.stripe_charge_id is not null
       and (new.bud_oere is distinct from old.bud_oere
            or new.koebergebyr_oere is distinct from old.koebergebyr_oere
            or new.saelgergebyr_oere is distinct from old.saelgergebyr_oere
            or new.fragt_oere is distinct from old.fragt_oere
            or new.beskyttelse is distinct from old.beskyttelse
            or new.beskyttelse_oere is distinct from old.beskyttelse_oere
            or new.total_oere is distinct from old.total_oere
            or new.udbetaling_oere is distinct from old.udbetaling_oere
            or new.application_fee_oere is distinct from old.application_fee_oere
            or new.saelger_stripe_konto is distinct from old.saelger_stripe_konto) then
      raise exception 'betalinger_destination_laast: beløbene kan ikke ændres efter betaling';
    end if;
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
-- Sæt en åben betaling til at vente (serverens friske kontotjek fejlede).
-- En destination-PaymentIntent skal være annulleret hos Stripe af serveren
-- først (p_annulleret_pi): den fjernes, og pi_forsoeg + 1, så der laves en ny,
-- når betalingen åbner. En separat-PaymentIntent bliver stående (den kan
-- stadig betales i den gamle model).
drop function if exists public.betaling_saet_venter(uuid, text);

create or replace function public.betaling_saet_venter(
  p_betaling uuid, p_aarsag text, p_annulleret_pi text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b record;
  fjern boolean;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found or b.status <> 'afventer' or b.stripe_charge_id is not null then
    return false;
  end if;
  fjern := b.pengemodel = 'destination' and b.stripe_payment_intent_id is not null;
  if fjern and b.stripe_payment_intent_id is distinct from p_annulleret_pi then
    return false; -- PaymentIntenten er ikke annulleret hos Stripe
  end if;
  if b.venter_paa_saelgerkonto_kl is not null and not fjern then
    return true;
  end if;
  update public.betalinger
     set venter_paa_saelgerkonto_kl = coalesce(venter_paa_saelgerkonto_kl, now()),
         venter_aarsag = left(coalesce(nullif(btrim(p_aarsag), ''), 'saelgerkonto_ikke_klar'), 200),
         betal_senest = public.betaling_venter_frist(b.oprettet),
         paamindelse_24_sendt_kl = null,
         paamindelse_40_sendt_kl = null,
         aabnet_besked_sendt_kl = null,
         stripe_payment_intent_id = case when fjern then null else stripe_payment_intent_id end,
         pi_forsoeg = case when fjern then pi_forsoeg + 1 else pi_forsoeg end,
         tidligere_payment_intents = case when fjern then tidligere_payment_intents || b.stripe_payment_intent_id
                                          else tidligere_payment_intents end,
         opdateret = now()
   where id = b.id;
  return true;
end;
$fn$;

revoke all on function public.betaling_saet_venter(uuid, text, text) from public, anon, authenticated;
grant execute on function public.betaling_saet_venter(uuid, text, text) to service_role;

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
     order by bt.venter_paa_saelgerkonto_kl
     limit 500
     for update of bt skip locked
  loop
    if not public.betaling_kan_aabnes(b.id) then
      continue;
    end if;
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
-- Kun betalinger, der stadig venter, og hvis frist er udløbet. Kan betalingen
-- åbnes (sælgerens konto er klar), springes den over - dog højst 1 døgn efter
-- fristen: venter den stadig da, annulleres den altid (ingen løkke mellem
-- "venter" og "åben"). Serveren henter sælgerkontoen frisk hos Stripe lige
-- før (betalingInd.ts). Køberen trækkes ikke (der er ingen betalt charge), og
-- der oprettes ingen "ubetalt vinder"-sag. Returnerer pr. annulleret handel:
-- trade_id, auction_id, buyer_id, seller_id, betaling_id og payment_intent
-- (skal annulleres hos Stripe af serveren, hvis den findes).
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
    if public.betaling_kan_aabnes(b.id) and b.betal_senest > now() - interval '1 day' then
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
language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.betalingsprofiler bp
     where bp.user_id = p_bruger
       and bp.stripe_account_id is not null
       and bp.connect_detaljer_indsendt
       and bp.connect_frakoblet_kl is null
       and bp.saelger_frosset_kl is null
       and coalesce(bp.connect_spaerret_aarsag, '') not like 'rejected.%'
       and (public.betalingsmodel_aktiv() = 'separat'
            or bp.connect_betalingsmetoder ? 'card_payments')
  );
$fn$;

revoke all on function public.har_udbetalingskonto(uuid) from public, anon, authenticated;
grant execute on function public.har_udbetalingskonto(uuid) to service_role;

-- Tydelig fejl, når sælgeren er frosset (ellers som før).
create or replace function public.auctions_kraev_udbetalingskonto()
returns trigger
language plpgsql
security definer
set search_path = ''
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
       select 1 from public.betalingsprofiler bp
        where bp.user_id = new.bruger_id and bp.saelger_frosset_kl is not null) then
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
set search_path = ''
as $$
begin
  if new.pengemodel is distinct from old.pengemodel
     and (old.status <> 'afventer' or old.stripe_charge_id is not null
          or old.stripe_payment_intent_id is not null)
     and not (coalesce(pg_catalog.current_setting('bidhamr.pengemodel_skift', true), '') = 'ja'
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
         svindelvarsel_loest_af = null,
         svindelvarsel_note = null,
         kraever_opmaerksomhed = true,
         sidste_fejl = left('Tidligt svindelvarsel fra Stripe (' || coalesce(nullif(p_type, ''), 'ukendt')
           || ') - pengene gives ikke til sælger, før staff har gennemgået varslet. Ingen automatisk refusion.', 500),
         opdateret = now()
   where id = b.id;
  return 'markeret';
end;
$fn$;

revoke all on function public.betaling_registrer_svindelvarsel(text, text, text, text) from public, anon, authenticated;
grant execute on function public.betaling_registrer_svindelvarsel(text, text, text, text) to service_role;

-- moderation_log: ny handling 'svindelvarsel_gennemgaaet' (de eksisterende
-- værdier bevares - constraint'en genopbygges kun, hvis værdien mangler).
do $do$
declare
  def      text;
  vaerdier text[];
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conname = 'moderation_log_handling_check' and conrelid = 'public.moderation_log'::regclass;
  if def is null then
    raise exception 'moderation_log_handling_check findes ikke - kontrollér moderation_log';
  end if;
  if position('svindelvarsel_gennemgaaet' in def) = 0 then
    vaerdier := ('{' || substring(def from '\{([^}]*)\}') || '}')::text[] || array['svindelvarsel_gennemgaaet'];
    alter table public.moderation_log drop constraint moderation_log_handling_check;
    execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', vaerdier);
  end if;
end $do$;

-- Staff (admin/chef) har gennemgået et tidligt svindelvarsel. Først derefter
-- kan pengene gives til sælger, og markeringen kan lukkes. Svar (kode):
-- ok, ingen_adgang, note_mangler, ikke_fundet, inhabil, intet_varsel, allerede.
create or replace function public.betaling_svindelvarsel_gennemgaaet(
  p_betaling uuid, p_medarbejder uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  b    record;
  note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not exists (select 1 from public.users u
                  where u.id = p_medarbejder and u.rolle in ('admin', 'chef')) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if note is null then return jsonb_build_object('kode', 'note_mangler'); end if;
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if p_medarbejder = b.buyer_id or p_medarbejder = b.seller_id then
    return jsonb_build_object('kode', 'inhabil');
  end if;
  if b.svindelvarsel_kl is null then return jsonb_build_object('kode', 'intet_varsel'); end if;
  if b.svindelvarsel_loest_kl is not null then return jsonb_build_object('kode', 'allerede'); end if;
  update public.betalinger
     set svindelvarsel_loest_kl = now(),
         svindelvarsel_loest_af = p_medarbejder,
         svindelvarsel_note = left(note, 2000),
         opdateret = now()
   where id = b.id;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'svindelvarsel_gennemgaaet', 'handel', b.trade_id, b.buyer_id, left(note, 2000));
  return jsonb_build_object('kode', 'ok', 'trade_id', b.trade_id);
end;
$fn$;

revoke all on function public.betaling_svindelvarsel_gennemgaaet(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.betaling_svindelvarsel_gennemgaaet(uuid, uuid, text) to service_role;

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
set search_path = ''
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
-- Ventende betalinger: ingen "ubetalt vinder" og ingen forlængelse.
-- De to funktioner genoprettes HELT (ikke tekst-erstatning - teksten er
-- forskellig i produktion, på testdatabasen og i en database bygget fra
-- filerne). Drift fanges først: den nuværende definition skal indeholde de
-- forventede dele (whitespace ignoreres), ellers afbrydes migrationen, så en
-- ukendt ændring ikke overskrives i stilhed.
do $do$
declare
  r   record;
  def text;
  del text;
begin
  for r in
    select * from (values
      ('public.ubetalt_vinder_annuller(uuid,boolean)', array[
        'select * into b from public.betalinger where trade_id = p_trade for update;',
        'if not ((b.status = ''afventer'' and b.betal_senest < now()) or (b.status = ''behandles'' and coalesce(p_stripe_fejlet, false) and b.betal_senest + interval ''1 hour'' < now())) then',
        'perform public.betaling_annuller(p_trade);',
        'insert into public.ubetalte_vindere (trade_id, auction_id, buyer_id, seller_id) values (p_trade, b.auction_id, b.buyer_id, b.seller_id) on conflict (trade_id) do nothing returning id into sag;']),
      ('public.handel_forlaeng_betalingsfrist(uuid,timestamp with time zone)', array[
        'if t.status <> ''afventer_betaling'' or b.status not in (''afventer'', ''behandles'') then',
        'if b.betal_senest <= now() then',
        'if v_antal >= 3 then',
        'v_maks := date_trunc(''second'', b.oprettet + interval ''7 days'');',
        'v_min := date_trunc(''second'', b.betal_senest + interval ''24 hours'');',
        'insert into public.betalingsfrist_forlaengelser ( betaling_id, trade_id, seller_id, buyer_id, gammel_frist, ny_frist)'])
    ) as v(fn, dele)
  loop
    def := regexp_replace(replace(pg_get_functiondef(r.fn::regprocedure), chr(13), ''), '\s+', ' ', 'g');
    def := replace(replace(def, '( ', '('), ' )', ')');
    if position('venter_paa_saelgerkonto_kl' in def) > 0 then
      raise notice '%: allerede rettet - genoprettes', r.fn;
      continue;
    end if;
    foreach del in array r.dele loop
      del := replace(replace(regexp_replace(del, '\s+', ' ', 'g'), '( ', '('), ' )', ')');
      if position(del in def) = 0 then
        raise exception '%: definitionen afviger fra den forventede (mangler "%") - kontrollér funktionen, før migrationen køres', r.fn, del;
      end if;
    end loop;
  end loop;
end $do$;

create or replace function public.ubetalt_vinder_annuller(
  p_trade uuid, p_stripe_fejlet boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b     record;
  sag   uuid;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then
    return jsonb_build_object('annulleret', false, 'payment_intent', null, 'sag_id', null);
  end if;

  -- Betalingsmodel trin 2: en betaling, der venter på sælgerens konto, er
  -- ikke en ubetalt vinder (betal_senest er fristen for kontoen).
  if b.venter_paa_saelgerkonto_kl is not null or not (
       (b.status = 'afventer' and b.betal_senest < now())
    or (b.status = 'behandles' and coalesce(p_stripe_fejlet, false)
        and b.betal_senest + interval '1 hour' < now())
  ) then
    return jsonb_build_object('annulleret', false,
                              'payment_intent', b.stripe_payment_intent_id,
                              'sag_id', null);
  end if;

  perform public.betaling_annuller(p_trade);

  insert into public.ubetalte_vindere (trade_id, auction_id, buyer_id, seller_id)
  values (p_trade, b.auction_id, b.buyer_id, b.seller_id)
  on conflict (trade_id) do nothing
  returning id into sag;

  return jsonb_build_object('annulleret', true,
                            'payment_intent', b.stripe_payment_intent_id,
                            'sag_id', sag);
end;
$fn$;

revoke all on function public.ubetalt_vinder_annuller(uuid, boolean) from public, anon, authenticated;
grant execute on function public.ubetalt_vinder_annuller(uuid, boolean) to service_role;

create or replace function public.handel_forlaeng_betalingsfrist(p_trade uuid, p_ny_frist timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_bruger uuid := auth.uid();
  v_ny     timestamptz := date_trunc('second', p_ny_frist);
  v_maks   timestamptz;
  v_min    timestamptz;
  v_antal  integer;
  b        record;
  t        record;
begin
  if v_bruger is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_trade is null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laaseraekkefoelge som ubetalt_vinder_annuller/betaling_annuller:
  -- betalinger foerst, derefter trades.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found or b.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select * into t from public.trades where id = p_trade for update;
  if not found or t.seller_id is distinct from v_bruger then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if t.status <> 'afventer_betaling' or b.status not in ('afventer', 'behandles') then
    return jsonb_build_object('kode', 'ikke_afventer');
  end if;
  -- Betalingsmodel trin 2: venter betalingen på sælgerens konto, er der
  -- ingen betalingsfrist at forlænge endnu.
  if b.venter_paa_saelgerkonto_kl is not null then
    return jsonb_build_object('kode', 'venter_paa_saelgerkonto');
  end if;
  if b.betal_senest <= now() then
    return jsonb_build_object('kode', 'frist_udloebet');
  end if;

  -- Hoejst 3 forlaengelser. Betalingen er laast, saa taellingen er sikker.
  select count(*) into v_antal
    from public.betalingsfrist_forlaengelser
   where betaling_id = b.id;
  if v_antal >= 3 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  -- Fristen kan højst forlænges til 7 dage efter, at den startede (auktionens
  -- slutning, eller når en ventende betaling åbnede - trin 2).
  v_maks := date_trunc('second', coalesce(b.betaling_aabnet_kl, b.oprettet) + interval '7 days');
  if v_ny is null or v_ny <= b.betal_senest then
    return jsonb_build_object('kode', 'ugyldig_frist', 'maks_frist', v_maks);
  end if;
  if v_ny > v_maks then
    return jsonb_build_object('kode', 'for_sent', 'maks_frist', v_maks);
  end if;
  -- Mindst 24 timer laengere end den nuvaerende frist - medmindre den nye
  -- frist er maks-fristen (under 24 timer tilbage til graensen).
  v_min := date_trunc('second', b.betal_senest + interval '24 hours');
  if v_ny < v_min and v_ny <> v_maks then
    return jsonb_build_object('kode', 'ugyldig_frist', 'maks_frist', v_maks);
  end if;

  update public.betalinger
     set betal_senest            = v_ny,
         paamindelse_24_sendt_kl = null,
         paamindelse_40_sendt_kl = null,
         opdateret               = now()
   where id = b.id;

  insert into public.betalingsfrist_forlaengelser (
    betaling_id, trade_id, seller_id, buyer_id, gammel_frist, ny_frist)
  values (b.id, t.id, t.seller_id, t.buyer_id, b.betal_senest, v_ny)
  on conflict (betaling_id, ny_frist) do nothing;

  return jsonb_build_object('kode', 'ok', 'betal_senest', v_ny, 'maks_frist', v_maks);
end;
$fn$;
