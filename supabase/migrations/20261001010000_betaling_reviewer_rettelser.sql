-- Rettelser til den nye betalingsmodel efter review (20261001000000).
--
--   1. Refusion og frigivelse fra admin gaar gennem Stripe for handler med en
--      betaling (ikke wallet). Nye kolonner til refusion, overfoerselsclaim og
--      en markering, som admin kan se (kraever_opmaerksomhed).
--   2. betaling_registrer_betalt registrerer kun betalinger, der stadig
--      venter ('afventer'/'behandles'). Ellers 'sen_betaling' -> serveren
--      refunderer automatisk.
--   3. 'beloeb_afviger' markeres til refusion og til admin.
--   4. handel_godkend kraever, at der ikke er en aaben sag.
--   5. Wallet-skriveveje lukkes ogsaa for service_role (admin-klienten).
--
-- Alle beloeb i oere. Stripe er sandheden om penge; databasen spejler.

-- ============================================================ kolonner

alter table public.betalinger
  add column if not exists refusion_anmodet_kl      timestamptz,
  add column if not exists refusion_aarsag          text,
  add column if not exists stripe_refund_id         text,
  add column if not exists refunderet_kl            timestamptz,
  add column if not exists overfoersel_paabegyndt_kl timestamptz,
  add column if not exists annulleret_kl            timestamptz,
  add column if not exists kraever_opmaerksomhed    boolean not null default false;

comment on column public.betalinger.kraever_opmaerksomhed is
  'Sat, naar noget uventet skete med pengene (fx beloeb afviger, sen betaling, '
  'refusion efter overfoersel). Vises for admin. Se sidste_fejl.';
comment on column public.betalinger.refusion_anmodet_kl is
  'Sat atomisk, foer serveren beder Stripe om en refusion. Blokerer overfoersel.';
comment on column public.betalinger.overfoersel_paabegyndt_kl is
  'Sat atomisk, foer serveren opretter overfoerslen til saelger. Blokerer refusion.';

create index if not exists betalinger_opmaerksomhed_idx
  on public.betalinger (oprettet desc) where kraever_opmaerksomhed;

-- ============================================================ betalt

create or replace function public.betaling_registrer_betalt(
  p_payment_intent text,
  p_charge         text,
  p_beloeb_oere    bigint,
  p_beskyttelse    boolean)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b    record;
  besk bigint;
begin
  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'betalt' then return 'allerede_betalt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  -- Betalingen er annulleret (fx frist overskredet), eller en refusion er
  -- allerede sat i gang: pengene maa ikke bogfoeres som betaling. Serveren
  -- refunderer automatisk.
  if b.status not in ('afventer', 'behandles') or b.refusion_anmodet_kl is not null then
    update public.betalinger
       set stripe_charge_id = coalesce(stripe_charge_id, p_charge),
           refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
           refusion_aarsag = coalesce(refusion_aarsag, 'sen_betaling'),
           sidste_fejl = 'Betaling modtaget efter annullering - refunderes automatisk',
           kraever_opmaerksomhed = true,
           opdateret = now()
     where id = b.id;
    return 'sen_betaling';
  end if;

  besk := case when p_beskyttelse then public.beregn_beskyttelse_oere(b.bud_oere) else 0 end;

  if p_beloeb_oere <> b.bud_oere + b.koebergebyr_oere + b.fragt_oere + besk then
    update public.betalinger
       set stripe_charge_id = coalesce(stripe_charge_id, p_charge),
           refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
           refusion_aarsag = coalesce(refusion_aarsag, 'beloeb_afviger'),
           sidste_fejl = 'Beloeb fra Stripe (' || p_beloeb_oere || ' oere) stemmer ikke '
                         || 'med handlen - refunderes automatisk',
           kraever_opmaerksomhed = true,
           opdateret = now()
     where id = b.id;
    return 'beloeb_afviger';
  end if;

  update public.betalinger
     set status = 'betalt',
         beskyttelse = p_beskyttelse,
         beskyttelse_oere = besk,
         total_oere = p_beloeb_oere,
         stripe_charge_id = p_charge,
         betalt_kl = now(),
         sidste_fejl = null,
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'betaling_modtaget'
   where id = b.trade_id and status = 'afventer_betaling';

  return 'betalt';
end;
$fn$;

revoke all on function public.betaling_registrer_betalt(text, text, bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_betalt(text, text, bigint, boolean)
  to service_role;

-- ============================================================ refunderet

-- Webhook: charge.refunded (fuld refusion). Spejler status. Idempotent.
-- Handlen annulleres, medmindre den allerede er afsluttet; skete refusionen
-- efter overfoersel til saelger, markeres betalingen til admin.
create or replace function public.betaling_registrer_refunderet(
  p_payment_intent text,
  p_refund         text)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then return 'ukendt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  update public.betalinger
     set status = 'refunderet',
         refunderet_kl = now(),
         stripe_refund_id = coalesce(stripe_refund_id, p_refund),
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'stripe'),
         kraever_opmaerksomhed = kraever_opmaerksomhed
                                 or stripe_transfer_id is not null
                                 or overfoersel_paabegyndt_kl is not null,
         sidste_fejl = case
           when stripe_transfer_id is not null or overfoersel_paabegyndt_kl is not null
             then 'Refunderet EFTER overfoersel til saelger - kontroller hos Stripe'
           else sidste_fejl end,
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = b.trade_id
     and status in ('afventer_betaling','betaling_modtaget','pakke_sendt','modtaget');

  return 'refunderet';
end;
$fn$;

revoke all on function public.betaling_registrer_refunderet(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_refunderet(text, text) to service_role;

-- Delvis refusion eller anden uventet haendelse: kun markering til admin.
create or replace function public.betaling_marker_opmaerksomhed(
  p_payment_intent text, p_besked text)
returns void
language sql security definer set search_path = public as $fn$
  update public.betalinger
     set kraever_opmaerksomhed = true, sidste_fejl = p_besked, opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
$fn$;

revoke all on function public.betaling_marker_opmaerksomhed(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_marker_opmaerksomhed(text, text) to service_role;

-- ============================================================ refusion (admin)

-- Claimer en betalt handel til refusion. Kun FOER frigivelse/overfoersel.
-- Handlen annulleres i samme transaktion. Returnerer refusionsbeloebet i oere
-- (det, Stripe faktisk har modtaget), eller null hvis det ikke er tilladt.
-- Kan kaldes igen for en allerede claimet refusion (nyt forsoeg mod Stripe).
create or replace function public.betaling_paabegynd_refusion(
  p_trade uuid, p_aarsag text)
returns bigint
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then return null; end if;

  if b.status <> 'betalt'
     or b.frigivet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null then
    return null;
  end if;

  update public.betalinger
     set refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, p_aarsag),
         opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget','pakke_sendt','modtaget','annulleret');

  return b.total_oere;
end;
$fn$;

revoke all on function public.betaling_paabegynd_refusion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_paabegynd_refusion(uuid, text) to service_role;

-- Annullerer en ikke-betalt betaling (admin, eller senere fristen paa 48 t).
-- Returnerer PaymentIntent-id'et (kan vaere null), som serveren derefter
-- annullerer hos Stripe. Betales der alligevel, giver
-- betaling_registrer_betalt 'sen_betaling', og pengene refunderes.
create or replace function public.betaling_annuller(p_trade uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found then return null; end if;
  if b.status = 'annulleret' then
    return jsonb_build_object('payment_intent', b.stripe_payment_intent_id, 'ny', false);
  end if;
  if b.status not in ('afventer', 'behandles') then return null; end if;

  update public.betalinger
     set status = 'annulleret', annulleret_kl = now(), opdateret = now()
   where id = b.id;

  update public.trades
     set status = 'annulleret', sag_aaben = false
   where id = p_trade and status = 'afventer_betaling';

  return jsonb_build_object('payment_intent', b.stripe_payment_intent_id, 'ny', true);
end;
$fn$;

revoke all on function public.betaling_annuller(uuid) from public, anon, authenticated;
grant execute on function public.betaling_annuller(uuid) to service_role;

-- ============================================================ overfoersel

-- Claimer en betaling til overfoersel til saelger. Afvises, hvis handlen har
-- aaben sag, er annulleret, betalingen er refunderet eller en refusion er sat
-- i gang. Kan kaldes igen for en allerede claimet overfoersel (nyt forsoeg).
create or replace function public.betaling_claim_overfoersel(p_betaling uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  t record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return false; end if;
  select * into t from public.trades where id = b.trade_id for update;

  if b.status <> 'betalt'
     or b.frigivet_kl is null
     or b.refusion_anmodet_kl is not null
     or b.stripe_charge_id is null
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
$fn$;

revoke all on function public.betaling_claim_overfoersel(uuid) from public, anon, authenticated;
grant execute on function public.betaling_claim_overfoersel(uuid) to service_role;

-- ============================================================ godkend

create or replace function public.handel_godkend(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  kalder uuid := auth.uid();
  t      record;
begin
  if kalder is null then return false; end if;

  if not exists (
    select 1 from public.betalinger
     where trade_id = p_trade
       and status = 'betalt'
       and refusion_anmodet_kl is null
  ) then
    return false;
  end if;

  update public.trades
     set status = 'leveret'
   where id = p_trade
     and status = 'modtaget'
     and buyer_id = kalder
     and not coalesce(sag_aaben, false)
  returning * into t;

  if not found then return false; end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where trade_id = p_trade and frigivet_kl is null;

  return true;
end;
$fn$;

revoke all on function public.handel_godkend(uuid) from public, anon;
grant execute on function public.handel_godkend(uuid) to authenticated;

-- ============================================================ admin frigiv

-- Handler med en betaling: frigiv (frigivet_kl) - serveren opretter derefter
-- Stripe-overfoerslen. Gamle handler fra saldo-modellen (uden betaling)
-- afregnes som foer, saa de kan afsluttes.
create or replace function public.admin_frigiv_handel(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  t            record;
  b            record;
  saelgergebyr numeric(12,2);
  titel        text;
begin
  select * into b from public.betalinger where trade_id = p_trade for update;

  if found then
    if b.status <> 'betalt' or b.refusion_anmodet_kl is not null then
      return false;
    end if;

    update public.trades
       set status = 'leveret',
           received_at = coalesce(received_at, now()),
           sag_aaben = false
     where id = p_trade
       and status in ('betaling_modtaget','pakke_sendt','modtaget')
    returning * into t;

    if not found then return false; end if;

    update public.betalinger
       set frigivet_kl = coalesce(frigivet_kl, now()), opdateret = now()
     where id = b.id;
    return true;
  end if;

  -- Gammel handel fra saldo-modellen.
  update public.trades
     set status = 'leveret',
         received_at = coalesce(received_at, now()),
         sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget','pakke_sendt','modtaget')
  returning * into t;

  if not found then return false; end if;

  select a.titel into titel from public.auctions a where a.id = t.auction_id;
  saelgergebyr := round(t.amount * 0.05, 2);

  perform public.wallet_bogfoer(
    t.seller_id, t.amount, 'salg', t.auction_id,
    'Solgt (frigivet af BidHamr): ' || coalesce(titel, 'auktion'));
  perform public.wallet_bogfoer(
    t.seller_id, -saelgergebyr, 'saelgergebyr', t.auction_id,
    'Saelgergebyr 5%');

  return true;
end;
$fn$;

revoke execute on function public.admin_frigiv_handel(uuid) from public, anon, authenticated;
grant execute on function public.admin_frigiv_handel(uuid) to service_role;

-- ============================================================ admin refunder

-- Den gamle wallet-refusion maa aldrig koere for en handel med en betaling
-- (den gav 0 kr). Den vej er nu betaling_paabegynd_refusion + Stripe.
create or replace function public.admin_refunder_handel(p_trade uuid)
returns numeric
language plpgsql security definer set search_path = public as $fn$
declare
  t      record;
  retur  numeric(12,2);
  titel  text;
begin
  if exists (select 1 from public.betalinger where trade_id = p_trade) then
    raise exception 'brug_stripe_refusion';
  end if;

  update public.trades
     set status = 'annulleret',
         sag_aaben = false
   where id = p_trade
     and status in ('betaling_modtaget','pakke_sendt','modtaget')
  returning * into t;

  if not found then return null; end if;

  select -coalesce(sum(e.amount), 0) into retur
    from public.wallet_entries e
   where e.user_id = t.buyer_id
     and e.auction_id = t.auction_id
     and e.kind in ('koeb','koebergebyr');

  select a.titel into titel from public.auctions a where a.id = t.auction_id;

  if retur > 0 then
    perform public.wallet_bogfoer(
      t.buyer_id, retur, 'refusion', t.auction_id,
      'Refusion: ' || coalesce(titel, 'auktion'));
  end if;

  return retur;
end;
$fn$;

revoke execute on function public.admin_refunder_handel(uuid) from public, anon, authenticated;
grant execute on function public.admin_refunder_handel(uuid) to service_role;

-- ============================================================ wallet lukket

-- Ingen saldo laengere: wallet-funktionerne, der kan skrive penge, kan ikke
-- kaldes direkte - heller ikke af service_role (admin-klienten). Interne
-- kald fra security definer-funktioner (ejer) virker stadig.
do $$
begin
  if to_regprocedure('public.wallet_bogfoer(uuid, numeric, text, uuid, text, text)') is not null then
    revoke execute on function public.wallet_bogfoer(uuid, numeric, text, uuid, text, text) from service_role;
  end if;
  if to_regprocedure('public.wallet_saet_saldo(uuid, numeric, text)') is not null then
    revoke execute on function public.wallet_saet_saldo(uuid, numeric, text) from service_role;
  end if;
  if to_regprocedure('public.wallet_indbetal(uuid, numeric, text)') is not null then
    revoke execute on function public.wallet_indbetal(uuid, numeric, text) from service_role;
  end if;
  if to_regprocedure('public.wallet_udbetal_saelger(uuid)') is not null then
    revoke execute on function public.wallet_udbetal_saelger(uuid) from service_role;
  end if;
end $$;
