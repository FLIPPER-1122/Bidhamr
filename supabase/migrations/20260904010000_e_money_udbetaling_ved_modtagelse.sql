-- Forfininger af e-money-afregningen, fundet under test af den foerste
-- version. Tre aendringer:
--
-- 1. Kun auktioner med en FAKTISK reservation afregnes. Foerste udgave
--    forsoegte at afregne alle gamle afsluttede auktioner - vinderne dér
--    havde aldrig faaet reserveret penge, saa saldoen gik negativ og hele
--    lukkefunktionen brød sammen paa check-constrainten.
--
-- 2. Hver afregning koerer bag sit eget fejlhegn, saa en enkelt problematisk
--    auktion ikke forhindrer resten i at blive lukket.
--
-- 3. Saelgeren krediteres foerst, naar koeberen bekraefter modtagelsen -
--    ikke ved auktionsluk. Platformen holder beloebet imellem, praecis som
--    det gamle escrow-flow gjorde, men internt mellem e-money-konti.

create or replace function public.wallet_afregn_auktion(p_auction uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  a            record;
  res          record;
  bud          numeric(12,2);
  koebergebyr  numeric(12,2);
  koeber_saldo numeric(12,2);
begin
  select id, bruger_id, vinder_id, titel
    into a
    from public.auctions
   where id = p_auction and status = 'afsluttet' and vinder_id is not null;

  if not found then return false; end if;

  if exists (select 1 from public.trades where auction_id = p_auction) then
    return false;
  end if;

  -- Ingen reservation = auktionen er fra foer e-money. Spring over.
  select * into res from public.bid_reservations where auction_id = p_auction;
  if not found then
    raise notice 'afregning sprunget over (ingen reservation): %', p_auction;
    return false;
  end if;

  if res.user_id <> a.vinder_id then
    raise notice 'afregning sprunget over (reservation matcher ikke vinder): %',
      p_auction;
    return false;
  end if;

  select b.beløb into bud
    from public.bids b
   where b.auktion_id = p_auction and b.bruger_id = a.vinder_id
   order by b.beløb desc limit 1;

  if bud is null then return false; end if;

  koebergebyr := round(bud * 0.05, 2);

  select balance into koeber_saldo
    from public.wallets where user_id = a.vinder_id for update;

  if koeber_saldo < bud + koebergebyr then
    raise notice 'afregning sprunget over (utilstraekkelig saldo): %', p_auction;
    return false;
  end if;

  perform public.wallet_frigiv(p_auction);

  perform public.wallet_bogfoer(
    a.vinder_id, -bud, 'koeb', p_auction, 'Vundet auktion: ' || a.titel);
  perform public.wallet_bogfoer(
    a.vinder_id, -koebergebyr, 'koebergebyr', p_auction, 'Koebergebyr 5%');

  insert into public.trades (auction_id, seller_id, buyer_id, amount, status)
  values (p_auction, a.bruger_id, a.vinder_id, bud, 'betaling_modtaget')
  on conflict (auction_id) do nothing;

  return true;
end;
$fn$;

-- Koeberen har bekraeftet modtagelsen: saelgeren krediteres bruttobeloebet,
-- og 10% saelgergebyr traekkes som sin egen hovedbogslinje, saa platformens
-- indtaegt kan aflaeses direkte i hovedbogen.
--
-- Idempotent: statusskiftet sker i samme saetning som kontrollen af, at
-- handlen stod paa 'pakke_sendt'. Et gentaget kald finder ingen raekke og
-- udbetaler derfor ikke igen.
create or replace function public.wallet_udbetal_saelger(
  p_trade uuid, p_koeber uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  t            record;
  saelgergebyr numeric(12,2);
  titel        text;
begin
  update public.trades
     set status = 'leveret'
   where id = p_trade
     and status = 'pakke_sendt'
     and buyer_id = p_koeber
  returning * into t;

  if not found then return false; end if;

  select a.titel into titel from public.auctions a where a.id = t.auction_id;
  saelgergebyr := round(t.amount * 0.10, 2);

  perform public.wallet_bogfoer(
    t.seller_id, t.amount, 'salg', t.auction_id,
    'Solgt: ' || coalesce(titel, 'auktion'));
  perform public.wallet_bogfoer(
    t.seller_id, -saelgergebyr, 'saelgergebyr', t.auction_id,
    'Saelgergebyr 10%');

  return true;
end;
$fn$;

create or replace function public.afslut_udloebne_auktioner()
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  antal integer;
  r     record;
begin
  update public.auctions a
     set status = 'afsluttet',
         vinder_id = (
           select b.bruger_id
             from public.bids b
            where b.auktion_id = a.id
            order by b.beløb desc, b.oprettet asc
            limit 1
         )
   where a.status = 'aktiv'
     and a.slutter_kl <= now();

  get diagnostics antal = row_count;

  for r in
    select br.auction_id as id
      from public.bid_reservations br
      join public.auctions a on a.id = br.auction_id
     where a.status = 'afsluttet'
       and a.vinder_id is not null
       and not exists (select 1 from public.trades t where t.auction_id = a.id)
  loop
    begin
      perform public.wallet_afregn_auktion(r.id);
    exception when others then
      raise warning 'afregning fejlede for auktion %: %', r.id, sqlerrm;
    end;
  end loop;

  -- Auktioner der lukkede uden vinder maa ikke holde paa penge.
  for r in
    select br.auction_id as id
      from public.bid_reservations br
      join public.auctions a on a.id = br.auction_id
     where a.status <> 'aktiv'
       and (a.vinder_id is null
            or exists (select 1 from public.trades t where t.auction_id = a.id))
  loop
    perform public.wallet_frigiv(r.id);
  end loop;

  return antal;
end;
$fn$;
