-- Saelgergebyret er besluttet til 5% (ROADMAP-BESLUTNINGER afsnit 3: 5% for
-- saelger og 5% for koeber, altid, uden minimum eller maksimum).
--
-- Denne migration erstatter kun public.admin_frigiv_handel, saa den bogfoerer
-- 5% i stedet for 10%. Alt andet i funktionen er uaendret: samme bogfoering via
-- wallet_bogfoer, samme idempotens (statusskift og kontrol i samme saetning),
-- samme security definer + search_path, og samme lukkede rettigheder.
--
-- public.wallet_udbetal_saelger roeres ikke her - den fjernes sammen med resten
-- af wallet-modellen i fase 1.

create or replace function public.admin_frigiv_handel(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  t            record;
  saelgergebyr numeric(12,2);
  titel        text;
begin
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
