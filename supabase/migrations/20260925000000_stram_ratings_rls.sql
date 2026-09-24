-- Ret fejl: bedoemmelser kunne gives af alle til alle.
--
-- Foer denne migration havde ratings kun policyen ratings_insert_own med
-- with check "auth.uid() = fra_bruger_id". Den forhindrer udelukkende, at man
-- forfalsker afsenderen. Enhver indlogget bruger kunne altsaa bedoemme en
-- vilkaarlig anden bruger paa en vilkaarlig auktion, ogsaa en auktion han
-- intet havde med at goere.
--
-- Regel (ROADMAP-BESLUTNINGER.md afsnit 6): kun koeberen i en handel maa
-- bedoemme, og kun handlens saelger, og kun én gang pr. auktion. Unique
-- (fra_bruger_id, auktion_id) staar for "én gang".
--
-- Sandheden om hvem der handlede ligger i public.trades (auction_id er unique
-- der), saa policyen slaar op der. trades har RLS, men policy-udtryk
-- evalueres uden RLS paa de tabeller de laeser, saa opslaget virker uanset
-- trades' egne policies.

drop policy if exists "ratings_insert_own" on public.ratings;

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
    )
  );

-- En afgivet bedoemmelse er handelsdata og skal staa fast. Kunne afsenderen
-- frit redigere eller slette den, kunne han presse saelgeren ("giv mig pengene
-- tilbage, saa fjerner jeg de to stjerner") og omgaa unique-reglen ved at
-- slette og bedoemme igen. Moderation af bedoemmelser sker i admin-panelet
-- (deleteRating/hideRating i src/app/actions/adminActions.ts), som koerer med
-- service-role og derfor ikke rammes af RLS.
drop policy if exists "ratings_update_own" on public.ratings;
drop policy if exists "ratings_delete_own" on public.ratings;

-- Opslaget i policyen gaar paa (auction_id, buyer_id, seller_id). auction_id er
-- unique, saa unique-indekset daekker det.

comment on table public.ratings is
  'Bedoemmelser. Kun koeberen i en handel (public.trades) kan indsaette en '
  'raekke, og kun paa handlens saelger, én gang pr. auktion. Raekker kan ikke '
  'aendres eller slettes af brugere - kun via admin med service-role.';
