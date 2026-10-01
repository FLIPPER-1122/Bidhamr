-- Reviewer-rettelser til "Vinderen betaler ikke" (20261002010000).
--
--   1. ubetalt_vinder_annuller annullerer kun status 'afventer'. En betaling,
--      der er i gang ('behandles', fx MobilePay), annulleres kun med
--      p_stripe_fejlet = true, som serveren saetter EFTER at have spurgt
--      Stripe (PaymentIntent requires_payment_method/canceled), og foerst
--      naar betal_senest + 1 time er passeret. Den gamle signatur (uuid)
--      fjernes, saa der ikke findes to overloads.
--   2. andenchance_svar: suspenderet byder -> tilbuddet saettes til
--      'annulleret' med besvaret_kl, saa saelgeren kan gaa videre straks.
--   3. genopsaet_auktion kraever en ubetalte_vindere-sag paa auktionen og
--      afviser suspenderede saelgere (kode 'suspenderet').
--
-- Idempotent (drop if exists / create or replace). Ingen data aendres.

-- ============================================================ 1. annuller ubetalt

drop function if exists public.ubetalt_vinder_annuller(uuid);

-- Returnerer { annulleret: bool, payment_intent: text|null, sag_id: uuid|null }.
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

  if not (
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

-- ============================================================ 2. andenchance svar

-- p_byder er den indloggede bruger. Returnerer { kode, trade_id? }.
-- Koder: ok, ikke_fundet, ikke_byder, besvaret, udloebet, solgt, genopsat,
--        suspenderet.
create or replace function public.andenchance_svar(p_tilbud uuid, p_byder uuid, p_ja boolean)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  x     record;
  a     record;
  u     record;
  bud   bigint;
  koeb  bigint;
  saelg bigint;
  fragt bigint;
  besk  bigint;
  t_id  uuid;
begin
  select * into x from public.andenchance_tilbud where id = p_tilbud;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if x.byder_id is distinct from p_byder then
    return jsonb_build_object('kode', 'ikke_byder');
  end if;

  -- Samme laaseraekkefoelge som andenchance_opret: auktion, derefter tilbud.
  select * into a from public.auctions where id = x.auction_id for update;
  select * into x from public.andenchance_tilbud where id = p_tilbud for update;

  if x.status <> 'afventer' then return jsonb_build_object('kode', 'besvaret'); end if;
  if x.udloeber <= now() then
    update public.andenchance_tilbud set status = 'udloebet'
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'udloebet');
  end if;

  if not p_ja then
    update public.andenchance_tilbud
       set status = 'afvist', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'ok');
  end if;

  if exists (select 1 from public.trades t
              where t.auction_id = x.auction_id and t.status <> 'annulleret') then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'solgt');
  end if;

  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = x.auction_id) then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'genopsat');
  end if;

  -- Suspenderet byder kan ikke koebe. Tilbuddet lukkes, saa saelgeren kan
  -- sende til naeste byder med det samme (serveren mailer saelgeren).
  select suspenderet, suspenderet_til into u from public.users where id = p_byder;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    update public.andenchance_tilbud set status = 'annulleret', besvaret_kl = now()
     where id = x.id and status = 'afventer';
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  -- Samme beloebslogik som afslut_udloebne_auktioner.
  bud   := x.bud_oere;
  koeb  := round(bud * 5 / 100.0)::bigint;
  saelg := round(bud * 5 / 100.0)::bigint;
  fragt := case when coalesce(a.forsendelse_mulig, false) then 3500 else 0 end;
  besk  := case when x.beskyttelse then public.beregn_beskyttelse_oere(bud) else 0 end;

  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (x.auction_id, x.seller_id, x.byder_id, bud / 100.0, 'afventer_betaling')
  returning id into t_id;

  insert into public.betalinger (
    trade_id, auction_id, buyer_id, seller_id,
    bud_oere, koebergebyr_oere, fragt_oere, beskyttelse, beskyttelse_oere,
    total_oere, saelgergebyr_oere, udbetaling_oere, betal_senest)
  values (
    t_id, x.auction_id, x.byder_id, x.seller_id,
    bud, koeb, fragt, x.beskyttelse, besk,
    bud + koeb + fragt + besk, saelg, bud - saelg,
    now() + interval '24 hours');

  update public.auctions set vinder_id = x.byder_id where id = x.auction_id;

  update public.andenchance_tilbud
     set status = 'accepteret', besvaret_kl = now(), ny_trade_id = t_id
   where id = x.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'trade_id', t_id);
end;
$fn$;

revoke all on function public.andenchance_svar(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.andenchance_svar(uuid, uuid, boolean) to service_role;

-- ============================================================ 3. genopsaet

-- p_seller er den indloggede bruger. Kun auktioner med en ubetalt-vinder-sag
-- kan saettes op igen. Returnerer { kode, auction_id? }.
-- Koder: ok, ikke_fundet, ikke_saelger, suspenderet, ikke_afsluttet, skjult,
--        ikke_ubetalt, solgt, allerede_genopsat, ugyldig_startpris,
--        ugyldig_slutdato.
create or replace function public.genopsaet_auktion(
  p_auction uuid, p_seller uuid, p_startpris numeric, p_slutter_kl timestamptz)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  a     record;
  u     record;
  ny_id uuid;
begin
  select * into a from public.auctions where id = p_auction for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if a.bruger_id is distinct from p_seller then
    return jsonb_build_object('kode', 'ikke_saelger');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = p_seller;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if a.status <> 'afsluttet' then return jsonb_build_object('kode', 'ikke_afsluttet'); end if;
  if a.skjult then return jsonb_build_object('kode', 'skjult'); end if;

  if not exists (select 1 from public.ubetalte_vindere v where v.auction_id = a.id) then
    return jsonb_build_object('kode', 'ikke_ubetalt');
  end if;
  if exists (select 1 from public.trades t
              where t.auction_id = a.id and t.status <> 'annulleret') then
    return jsonb_build_object('kode', 'solgt');
  end if;
  if exists (select 1 from public.genopsaetninger g where g.gammel_auction_id = a.id) then
    return jsonb_build_object('kode', 'allerede_genopsat');
  end if;

  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  if p_slutter_kl is null or p_slutter_kl <= now()
     or p_slutter_kl > now() + interval '30 days' then
    return jsonb_build_object('kode', 'ugyldig_slutdato');
  end if;

  insert into public.auctions (
    bruger_id, titel, beskrivelse, billeder, startpris, lokation,
    forsendelse_mulig, status, slutter_kl, kategori, postnummer, lat, lng,
    maerke, stand, skjult)
  values (
    a.bruger_id, a.titel, a.beskrivelse, a.billeder, p_startpris, a.lokation,
    a.forsendelse_mulig, 'aktiv', p_slutter_kl, a.kategori, a.postnummer, a.lat, a.lng,
    a.maerke, a.stand, false)
  returning id into ny_id;

  insert into public.genopsaetninger (gammel_auction_id, ny_auction_id, seller_id)
  values (a.id, ny_id, a.bruger_id);

  update public.andenchance_tilbud
     set status = 'annulleret', besvaret_kl = now()
   where auction_id = a.id and status = 'afventer';

  return jsonb_build_object('kode', 'ok', 'auction_id', ny_id);
end;
$fn$;

revoke all on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.genopsaet_auktion(uuid, uuid, numeric, timestamptz)
  to service_role;
