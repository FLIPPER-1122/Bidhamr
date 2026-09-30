-- KRITISK rettelse: trades_update_own lod koeber og saelger opdatere ALLE
-- kolonner paa handlen (seller_id, amount, status, sag_aaben, received_at).
-- En koeber kunne fx saette status = 'leveret' uden om udbetalingsflowet
-- eller lukke en sag.
--
-- Policyen droppes. Alle bruger-statusskift sker nu via security definer-
-- funktioner, der udleder kalderen af auth.uid():
--   trade_marker_sendt     (saelger, denne migration)
--   trade_marker_modtaget  (koeber, 20260922030000)
--   wallet_udbetal_saelger (koeber, 20260922030000)
-- Admin-indgreb og cron koerer med service-role og rammes ikke af RLS.

drop policy if exists trades_update_own on public.trades;

-- Saelgeren markerer pakken som sendt og indtaster sporingsnummer.
-- Idempotent: statuskontrollen staar i samme update, saa et dobbeltklik
-- ikke finder raekken anden gang.
create or replace function public.trade_marker_sendt(p_trade uuid, p_tracking text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  kalder   uuid := auth.uid();
  tracking text := nullif(btrim(p_tracking), '');
begin
  if kalder is null or tracking is null or char_length(tracking) > 100 then
    return false;
  end if;

  update public.trades
     set status = 'pakke_sendt',
         tracking_number = tracking
   where id = p_trade
     and seller_id = kalder
     and status = 'betaling_modtaget';

  return found;
end;
$fn$;

revoke execute on function public.trade_marker_sendt(uuid, text) from public, anon;
grant execute on function public.trade_marker_sendt(uuid, text) to authenticated;
