-- =====================================================================
-- KØRES FØRST I PRODUKTION, NÅR EXPO-APPEN ER TILPASSET
-- =====================================================================
-- Niels' gennemgang M03: vinderens id (auctions.vinder_id) kunne læses af
-- alle, også uden login. Kræver 20261010060000_niels_m02_m03.sql
-- (jeg_er_vinder).
--
-- Kolonne-rettigheder: anon og authenticated kan læse alle kolonner på
-- auctions UNDTAGEN vinder_id. Det betyder, at select('*') på auctions
-- fejler ("permission denied for table auctions") – der skal altid stå en
-- kolonneliste. Appen skal FØRST:
--   1. Erstatte alle .from('auctions').select('*') (også indlejret
--      auctions(*)) med en kolonneliste uden vinder_id.
--   2. Spørge "er jeg vinder?" med rpc('jeg_er_vinder', { p_auktion }) eller
--      bruge min_status fra rpc('mine_bud_auktioner'); sælgeren ser køberen
--      på handlen (trades.buyer_id).
-- Hjemmesiden bruger AUKTION_KOLONNER (src/lib/auktionKolonner.ts) og
-- læser vinder_id med service role på serveren.
--
-- NB til fremtidige migrationer: en ny kolonne på auctions skal have
--   grant select (<kolonne>) on public.auctions to anon, authenticated;
-- ellers kan den ikke læses fra klienten.
--
-- Idempotent. Tilbagerulning: grant select on public.auctions to anon, authenticated;

set lock_timeout = '5s';

do $$
declare
  v_kolonner text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_kolonner
    from pg_attribute
   where attrelid = 'public.auctions'::regclass
     and attnum > 0
     and not attisdropped
     and attname <> 'vinder_id';

  revoke select on public.auctions from anon, authenticated;
  execute format('grant select (%s) on public.auctions to anon, authenticated', v_kolonner);
end $$;

reset lock_timeout;
