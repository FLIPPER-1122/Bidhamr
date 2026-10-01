-- KØRES FØRST I PRODUKTION, NÅR APPEN IKKE LÆNGERE LÆSER ANDRES BUD/FØLGERE DIREKTE
--
-- L6 (bydernes og foelgernes privatliv), flyttet uaendret ud af
-- 20261001030000_sikkerhed_rettelser.sql, saa den kan holdes tilbage i
-- produktion, indtil Expo-appen er tilpasset. Hjemmesiden virker med og uden
-- denne fil: andres bud hentes med service-role, antal bud fra
-- auctions.antal_bud (030000). Kraever 20261001036000 (auktion_har_bud), for
-- at saelgeren ikke kan redigere sin auktion, efter der er budt. Idempotent.

-- =============================================================== L6 bids
-- Byderes bruger-id'er maa ikke kunne hentes af andre. Hjemmesiden viser en
-- anonymiseret budhistorik ("Byder 3"/"Dig"), som serveren bygger med
-- service-role. Realtime paa bids respekterer RLS, saa andre byderes bud
-- sendes ikke laengere ud; klienten lytter i stedet paa auctions.
drop policy if exists "bids_select_all" on public.bids;
drop policy if exists bids_select_all on public.bids;
drop policy if exists bids_select_own on public.bids;
create policy bids_select_own on public.bids
  for select to authenticated using (bruger_id = auth.uid());
revoke select on public.bids from anon;

-- =============================================================== L6 seller_follows
-- Kun brugeren selv kan se, hvem han foelger.
do $$
begin
  if to_regclass('public.seller_follows') is not null then
    execute 'drop policy if exists seller_follows_select_all on public.seller_follows';
    execute 'drop policy if exists seller_follows_select_own on public.seller_follows';
    execute 'create policy seller_follows_select_own on public.seller_follows
               for select to authenticated using (follower_id = auth.uid())';
    execute 'revoke select on public.seller_follows from anon';
  end if;
end $$;
