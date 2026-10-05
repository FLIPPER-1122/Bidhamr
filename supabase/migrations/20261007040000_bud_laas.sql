-- Bud: undgaa deadlock ved samtidige bud paa samme auktion.
--
-- Problemet: naar et bud indsaettes i public.bids, sker i raekkefoelge:
--   1. BEFORE-triggere (laeser auktionen uden laas)
--   2. AFTER: FK-tjekket bids -> auctions tager FOR KEY SHARE paa auktionen
--   3. AFTER: bids_oeg_antal opdaterer auctions.antal_bud (FOR NO KEY UPDATE)
--   4. AFTER: on_bid_created (handle_new_bid) tager FOR UPDATE paa auktionen
-- KEY SHARE og NO KEY UPDATE er forenelige, saa to samtidige bud kan begge
-- naa forbi trin 2. Det ene venter i trin 3 paa det andet, mens det andet i
-- trin 4 venter paa det foerstes KEY SHARE -> "deadlock detected". Det rammer
-- netop, naar mange byder samtidig i de sidste minutter.
--
-- Rettelsen: den FOERSTE BEFORE INSERT-trigger laaser auktionen FOR UPDATE.
-- BEFORE-triggere koerer foer alle AFTER-triggere og FK-tjek, og inden for
-- samme timing i alfabetisk raekkefoelge - "a0_..." sorteres foerst. Saa er
-- alle senere laase (KEY SHARE, NO KEY UPDATE, FOR UPDATE) paa en raekke,
-- buddet allerede ejer, og samtidige bud stiller sig blot i koe.
--
-- Al eksisterende logik er uaendret: triggeren laaser kun og returnerer new.
-- Findes auktionen ikke, laases intet, og de eksisterende tjek afviser buddet.
-- Idempotent.

create or replace function public.bids_laas_auktion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.auctions where id = new.auktion_id for update;
  return new;
end;
$$;

revoke execute on function public.bids_laas_auktion() from public, anon, authenticated;

drop trigger if exists a0_bids_laas_auktion on public.bids;
create trigger a0_bids_laas_auktion
  before insert on public.bids
  for each row execute function public.bids_laas_auktion();
