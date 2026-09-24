-- Saelgergebyret er besluttet til 5% ALLE steder (ROADMAP-BESLUTNINGER.md
-- afsnit 3: "5% for saelger og 5% for koeber, altid. Intet minimum eller
-- maksimum."). admin_frigiv_handel blev rettet i 20260925000000; her rettes
-- det normale flow, public.wallet_udbetal_saelger, der stadig traak 10%.
-- Teksterne i UI og mails siger allerede 5%, saa tal og tekst skal stemme.
--
-- Wallet-modellen fjernes i fase 1, men indtil da skal den regne rigtigt.
--
-- Eneste aendringer i forhold til 20260922030000_trades_modtaget_trin.sql:
--   0.10 -> 0.05  og  'Saelgergebyr 10%' -> 'Saelgergebyr 5%'.
-- Alt andet er ordret det samme: signaturen tager kun p_trade (koeberen
-- udledes af auth.uid()), security definer, fast search_path, kravet om
-- status 'modtaget', og idempotensen (statuskontrol i samme saetning som
-- opdateringen + 'if not found then return false').

create or replace function public.wallet_udbetal_saelger(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  kalder       uuid := auth.uid();
  t            record;
  saelgergebyr numeric(12,2);
  titel        text;
begin
  if kalder is null then
    return false;
  end if;

  update public.trades
     set status = 'leveret'
   where id = p_trade
     and status = 'modtaget'
     and buyer_id = kalder
  returning * into t;

  if not found then return false; end if;

  select a.titel into titel from public.auctions a where a.id = t.auction_id;
  saelgergebyr := round(t.amount * 0.05, 2);

  perform public.wallet_bogfoer(
    t.seller_id, t.amount, 'salg', t.auction_id,
    'Solgt: ' || coalesce(titel, 'auktion'));
  perform public.wallet_bogfoer(
    t.seller_id, -saelgergebyr, 'saelgergebyr', t.auction_id,
    'Saelgergebyr 5%');

  return true;
end;
$fn$;

-- create or replace bevarer rettighederne, men de gentages her, saa filen kan
-- koeres paa en frisk database og give praecis samme resultat.
revoke execute on function public.wallet_udbetal_saelger(uuid) from public, anon;
grant execute on function public.wallet_udbetal_saelger(uuid) to authenticated;
