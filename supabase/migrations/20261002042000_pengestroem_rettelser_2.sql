-- Pengestrøm: rettelser fra reviewerens 2. gennemgang (2. oktober 2026).
--
-- Idempotent og sikker at køre flere gange i produktion: kun
-- create or replace af funktioner og drop policy if exists. Ingen data
-- slettes eller ændres.
--
--   1  Beløb skrives aldrig i sidste_fejl (den vises for medarbejdere; beløb
--      må kun ses af chef, i beløbskolonnerne).
--   2  betaling_paabegynd_refusion afviser (null), når en indsigelse blokerer.
--   4  betaling_overfoersel_nulstil tjekker handlen (ikke annulleret, ingen
--      åben sag) og hæver kun grænsen. Markering og fejltekst ryddes først af
--      serveren, når overførslen er gennemført (stripe_transfer_id sat).
--   5  M7: ingen delete-policies på auctions/users (handelsdata slettes aldrig).

-- ============================================================ 1 beløb i sidste_fejl

-- Uændret fra 20261001020000, bortset fra fejlteksten ved afvigende beløb,
-- som nu er uden tal.
create or replace function public.betaling_registrer_betalt(
  p_payment_intent text,
  p_charge         text,
  p_beloeb_oere    bigint,
  p_beskyttelse    boolean)
returns text
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
begin
  select * into b from public.betalinger
   where stripe_payment_intent_id = p_payment_intent
   for update;

  if not found then
    -- En kasseret PaymentIntent (afvigende beløb): serveren refunderer den
    -- (idempotent). Rører aldrig den nye betaling.
    update public.betaling_afvigelser
       set stripe_charge_id = coalesce(stripe_charge_id, p_charge), opdateret = now()
     where stripe_payment_intent_id = p_payment_intent;
    if found then return 'beloeb_afviger'; end if;
    return 'ukendt';
  end if;
  if b.status = 'betalt' then return 'allerede_betalt'; end if;
  if b.status = 'refunderet' then return 'allerede_refunderet'; end if;

  -- Betalingen er annulleret (fx frist overskredet), eller en refusion er
  -- allerede sat i gang: pengene må ikke bogføres som betaling. Serveren
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

  if p_beloeb_oere <> b.total_oere then
    insert into public.betaling_afvigelser (
      betaling_id, trade_id, stripe_payment_intent_id, stripe_charge_id,
      modtaget_oere, forventet_oere)
    values (
      b.id, b.trade_id, p_payment_intent, p_charge, p_beloeb_oere, b.total_oere)
    on conflict (stripe_payment_intent_id) do nothing;

    -- Tilbage til 'afventer' uden PaymentIntent. Handlen og fristen røres ikke.
    update public.betalinger
       set stripe_payment_intent_id = null,
           stripe_charge_id = null,
           status = 'afventer',
           pi_forsoeg = pi_forsoeg + 1,
           sidste_fejl = 'Betalt beløb stemmer ikke med handlen - refunderes '
                         || 'automatisk, køberen betaler igen',
           kraever_opmaerksomhed = true,
           opdateret = now()
     where id = b.id;
    return 'beloeb_afviger';
  end if;

  update public.betalinger
     set status = 'betalt',
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

-- Delvis refusion: fast tekst uden beløb. p_besked bevares i signaturen (så
-- en ældre server-version stadig virker), men bruges ikke.
create or replace function public.betaling_registrer_delvis_refusion(
  p_payment_intent text, p_besked text)
returns void
language sql security definer set search_path = public as $fn$
  update public.betalinger
     set kraever_opmaerksomhed = true,
         sidste_fejl = 'Delvis refusion hos Stripe - overførsel til sælger er blokeret',
         refusion_anmodet_kl = coalesce(refusion_anmodet_kl, now()),
         refusion_aarsag = coalesce(refusion_aarsag, 'delvis_refusion_stripe'),
         opdateret = now()
   where stripe_payment_intent_id = p_payment_intent;
$fn$;

revoke all on function public.betaling_registrer_delvis_refusion(text, text)
  from public, anon, authenticated;
grant execute on function public.betaling_registrer_delvis_refusion(text, text) to service_role;

-- ============================================================ 2 refusion under indsigelse

-- Som i 20261002040000, men en blokerende indsigelse afviser refusionen:
-- køberens bank har trukket (eller kan trække) pengene tilbage, så en
-- refusion oveni ville betale køberen to gange.
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
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
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
     and status in ('betaling_modtaget','pakke_sendt','modtaget','leveret','annulleret');

  return b.total_oere;
end;
$fn$;

revoke all on function public.betaling_paabegynd_refusion(uuid, text)
  from public, anon, authenticated;
grant execute on function public.betaling_paabegynd_refusion(uuid, text) to service_role;

-- ============================================================ 4 nye overførselsforsøg

-- Hæver kun grænsen (3 nye forsøg). kraever_opmaerksomhed og sidste_fejl
-- røres ikke - serveren rydder dem, når stripe_transfer_id er sat. Afvises
-- for alt, der ikke må overføres, herunder annulleret handel og åben sag.
-- Låserækkefølge som betaling_claim_overfoersel: betaling, derefter handel.
create or replace function public.betaling_overfoersel_nulstil(p_betaling uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  b record;
  t record;
begin
  select * into b from public.betalinger where id = p_betaling for update;
  if not found then return false; end if;

  select status, sag_aaben into t from public.trades where id = b.trade_id for update;
  if not found
     or t.status = 'annulleret'
     or coalesce(t.sag_aaben, false)
     or b.status <> 'betalt'
     or b.frigivet_kl is null
     or b.stripe_transfer_id is not null
     or b.refusion_anmodet_kl is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then
    return false;
  end if;

  update public.betalinger
     set overfoersel_graense = greatest(overfoersel_graense, overfoersel_forsoeg + 3),
         opdateret = now()
   where id = b.id;
  return true;
end;
$fn$;

revoke all on function public.betaling_overfoersel_nulstil(uuid) from public, anon, authenticated;
grant execute on function public.betaling_overfoersel_nulstil(uuid) to service_role;

-- ============================================================ 5 M7

-- Allerede fjernet i 20260930030000/20260930040000; gentages, så intet miljø
-- har dem. Auktioner arkiveres (deleteAuction), brugere slettes aldrig.
drop policy if exists "auctions_delete_own" on public.auctions;
drop policy if exists "users_delete_own" on public.users;
