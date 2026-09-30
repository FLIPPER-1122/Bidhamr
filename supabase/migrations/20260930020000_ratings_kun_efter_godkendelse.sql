-- HOEJ: Bedoemmelser maa foerst gives, naar koeberen har godkendt varen.
-- wallet_udbetal_saelger saetter status 'leveret', naar koeberen godkender
-- (20260922030000). 'afsluttet' er reserveret til senere og tillades ogsaa.
-- Foer kunne koeberen bedoemme lige efter betaling, foer varen var sendt.
--
-- Afhaenger fortsat af trades_select_own (koeberen skal kunne se sin handel).

drop policy if exists "ratings_insert_koeber" on public.ratings;

create policy "ratings_insert_koeber" on public.ratings
  for insert with check (
    auth.uid() = fra_bruger_id
    and fra_bruger_id <> til_bruger_id
    and exists (
      select 1
        from public.trades t
       where t.auction_id = ratings.auktion_id
         and t.buyer_id = auth.uid()
         and t.seller_id = ratings.til_bruger_id
         and t.status in ('leveret', 'afsluttet')
    )
  );
