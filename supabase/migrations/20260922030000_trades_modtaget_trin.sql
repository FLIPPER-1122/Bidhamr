-- Koeberens bekraeftelse deles i to trin, saa modtagelse og godkendelse er
-- to separate handlinger:
--
--   betaling_modtaget -> pakke_sendt -> modtaget -> leveret -> afsluttet
--
-- 'modtaget' betyder "pakken er kommet frem, koeberen tjekker varen". Der
-- flyttes ingen penge foerst ved 'leveret'. Det giver koeberen et vindue til
-- at opdage fejl, foer beloebet er ude af doeren.

-- ------------------------------------------------------------ status

alter table public.trades drop constraint if exists trades_status_check;

alter table public.trades add constraint trades_status_check check (
  status in ('betaling_modtaget','pakke_sendt','modtaget','leveret','afsluttet'));

comment on column public.trades.status is
  'betaling_modtaget: sat naar auktionen lukkes. pakke_sendt: saelger har '
  'afsendt. modtaget: koeber har kvitteret for pakken, men endnu ikke '
  'godkendt varen - ingen penge udbetalt. leveret: koeber har godkendt, og '
  'saelger er afregnet. afsluttet: RESERVERET.';

-- Tidspunktet for kvitteringen. Bruges senere til automatisk frigivelse
-- efter en frist og til at regne tvistfrister fra.
alter table public.trades
  add column if not exists received_at timestamptz;

comment on column public.trades.received_at is
  'Naar koeberen kvitterede for pakken (status -> modtaget). Grundlag for '
  'senere auto-frigivelse og tvistfrister.';

-- ------------------------------------------------------------ trin 1

-- Koeberen kvitterer for pakken. Ingen penge flyttes.
--
-- Den kaldende bruger udledes af auth.uid() og tages IKKE som parameter.
-- Tog funktionen koeberens id ind, kunne enhver indlogget bruger kalde den
-- med en andens id via PostgREST og kvittere paa dennes vegne - funktionen
-- er security definer og ville ikke opdage det.
create or replace function public.trade_marker_modtaget(p_trade uuid)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  kalder uuid := auth.uid();
begin
  if kalder is null then
    return false;
  end if;

  -- Betingelserne staar i samme saetning som opdateringen, saa to samtidige
  -- kald ikke kan naa igennem begge to.
  update public.trades
     set status = 'modtaget',
         received_at = now()
   where id = p_trade
     and buyer_id = kalder
     and status = 'pakke_sendt';

  return found;
end;
$fn$;

-- ------------------------------------------------------------ trin 2

-- Koeberen godkender varen: saelgeren krediteres bruttobeloebet, og 10%
-- saelgergebyr traekkes som sin egen hovedbogslinje.
--
-- To aendringer i forhold til foer:
--   1. Kraever status 'modtaget' i stedet for 'pakke_sendt'.
--   2. Koeberen udledes af auth.uid(). Den gamle signatur tog p_koeber ind,
--      saa enhver kunne udloese udbetaling paa en fremmed handel ved at
--      sende den rigtige koebers id med.
--
-- Idempotent: statusskiftet sker i samme saetning som statuskontrollen, saa
-- et dobbeltklik finder ingen raekke og udbetaler ikke igen.
drop function if exists public.wallet_udbetal_saelger(uuid, uuid);

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

-- ------------------------------------------------------------ rettigheder

-- Disse to kaldes fra brugerens egen session (server action med brugerens
-- klient), saa 'authenticated' SKAL kunne kalde dem. Det er forsvarligt,
-- fordi de udleder kalderen af auth.uid() og kun rammer raekker, hvor
-- kalderen er koeber.
revoke execute on function public.trade_marker_modtaget(uuid) from public, anon;
revoke execute on function public.wallet_udbetal_saelger(uuid) from public, anon;

grant execute on function public.trade_marker_modtaget(uuid) to authenticated;
grant execute on function public.wallet_udbetal_saelger(uuid) to authenticated;
