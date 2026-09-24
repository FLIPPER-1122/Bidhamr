-- Sager: admin-overblik over handler og mulighed for at gribe ind.
--
-- En "sag" er en handel, som staff har flaget til opfoelgning (tvist, manglende
-- afsendelse, klage i chatten osv.). Flaget ligger direkte paa trades, saa der
-- ikke er en ekstra tabel at holde i sync.
--
-- To pengeindgreb, begge kun for admin og opefter (haandhaeves i server
-- action - funktionerne er lukket for authenticated og kaldes med service-role):
--
--   admin_frigiv_handel   -> saelgeren afregnes, som hvis koeberen havde godkendt
--   admin_refunder_handel -> koeberen faar koeb + koebergebyr retur, handlen annulleres

-- ------------------------------------------------------------ trades

alter table public.trades drop constraint if exists trades_status_check;

alter table public.trades add constraint trades_status_check check (
  status in ('betaling_modtaget','pakke_sendt','modtaget','leveret',
             'afsluttet','annulleret'));

alter table public.trades
  add column if not exists sag_aaben     boolean not null default false,
  add column if not exists sag_note      text,
  add column if not exists sag_aabnet_af uuid references public.users(id) on delete set null,
  add column if not exists sag_aabnet_at timestamptz;

create index if not exists trades_sag_idx
  on public.trades (sag_aaben, created_at desc) where sag_aaben;

-- ------------------------------------------------------------ hovedbog

alter table public.wallet_entries drop constraint if exists wallet_entries_kind_check;

alter table public.wallet_entries add constraint wallet_entries_kind_check check (
  kind in ('indbetaling','koeb','salg','koebergebyr','saelgergebyr',
           'justering','refusion'));

-- ------------------------------------------------------------ moderation_log

alter table public.moderation_log
  drop constraint if exists moderation_log_handling_check;

alter table public.moderation_log
  add constraint moderation_log_handling_check check (handling in (
    'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
    'advarsel','annuller_auktion',
    'saldo_sat','saldo_tilfoert','saldo_traukket',
    'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet'));

alter table public.moderation_log
  drop constraint if exists moderation_log_maal_type_check;

alter table public.moderation_log
  add constraint moderation_log_maal_type_check check (
    maal_type in ('auktion','anmeldelse','bruger','handel'));

-- ------------------------------------------------------------ frigiv

-- Saelgeren afregnes uden koeberens godkendelse. Samme bogfoering som
-- wallet_udbetal_saelger. Idempotent: statusskift og kontrol i samme saetning.
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
  saelgergebyr := round(t.amount * 0.10, 2);

  perform public.wallet_bogfoer(
    t.seller_id, t.amount, 'salg', t.auction_id,
    'Solgt (frigivet af BidHamr): ' || coalesce(titel, 'auktion'));
  perform public.wallet_bogfoer(
    t.seller_id, -saelgergebyr, 'saelgergebyr', t.auction_id,
    'Saelgergebyr 10%');

  return true;
end;
$fn$;

-- ------------------------------------------------------------ refunder

-- Koeberen faar praecis det tilbage, der blev traekket for auktionen (koeb +
-- koebergebyr), aflaest i hovedbogen i stedet for genberegnet - saa en senere
-- gebyraendring ikke giver skaeve refusioner.
create or replace function public.admin_refunder_handel(p_trade uuid)
returns numeric
language plpgsql security definer set search_path = public as $fn$
declare
  t      record;
  retur  numeric(12,2);
  titel  text;
begin
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

revoke execute on function public.admin_frigiv_handel(uuid) from public, anon, authenticated;
revoke execute on function public.admin_refunder_handel(uuid) from public, anon, authenticated;
