-- KØRES FØRST I PRODUKTION, NÅR APPEN BRUGER antal_foelgere() OG KUN INSERT/DELETE PÅ seller_follows
--
-- Flyttet ud af 20261007010000_brugerens_egne_ting.sql, saa den kan holdes
-- tilbage i produktion, indtil Expo-appen er tilpasset:
--   - appen maa ikke taelle foelgere med select paa seller_follows (brug
--     rpc antal_foelgere(p_bruger)) og maa kun laese brugerens egne raekker
--     (follower_id = brugeren selv),
--   - appen maa ikke bruge upsert (kraever UPDATE) - kun insert og delete,
--     eller rpc foelg_saelger()/stop_foelg_saelger().
-- Hjemmesiden virker med og uden denne fil (den filtrerer altid paa
-- follower_id og bruger antal_foelgere()).
--
-- Testdatabasen havde allerede stramningen fra den oprindelige 010000 - filen
-- er idempotent og kan koeres igen.
--
-- Hvem der foelger hvem er privat: kun brugeren selv kan se sine egne
-- foelgninger. Alle eksisterende policies paa tabellen fjernes (ogsaa evt.
-- policies med andre navne fra appen) og erstattes af de tre nedenfor.

do $$
declare
  p record;
begin
  if to_regclass('public.seller_follows') is null then
    raise exception 'seller_follows mangler - koer 20260930130000 foerst';
  end if;

  for p in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'seller_follows'
  loop
    execute format('drop policy if exists %I on public.seller_follows', p.policyname);
  end loop;
end $$;

alter table public.seller_follows enable row level security;

revoke all on public.seller_follows from public, anon, authenticated;
grant select, insert, delete on public.seller_follows to authenticated;
grant all on public.seller_follows to service_role;

create policy seller_follows_select_own on public.seller_follows
  for select to authenticated using (follower_id = auth.uid());
create policy seller_follows_insert_own on public.seller_follows
  for insert to authenticated with check (follower_id = auth.uid());
create policy seller_follows_delete_own on public.seller_follows
  for delete to authenticated using (follower_id = auth.uid());
