-- H1: transactions_insert_own/transactions_update_own (init_schema) lod
-- koeber/saelger oprette og aendre egne transaktioner (beloeb, gebyr,
-- status='frigivet') direkte via PostgREST. Transaktioner skrives kun af
-- server-kode med service_role (Stripe-webhooks), som omgaar RLS.
-- Laeseadgang (transactions_select_own) bevares.

drop policy if exists "transactions_insert_own" on public.transactions;
drop policy if exists "transactions_update_own" on public.transactions;
