-- SIKKERHEDSRETTELSE
--
-- Wallet-funktionerne er SECURITY DEFINER og laa aabne for rollen
-- 'authenticated'. Funktioner i public-skemaet eksponeres automatisk som
-- RPC-endpoints af PostgREST, saa en hvilken som helst indlogget bruger
-- kunne kalde dem direkte fra browseren:
--
--   supabase.rpc('wallet_bogfoer', {
--     p_user: <egen id>, p_amount: 999999, p_kind: 'indbetaling' })
--
-- Verificeret: en almindelig bruger (rolle 'bruger') kunne kreditere sig
-- selv 999.999 kr. Funktionerne kontrollerer nemlig ikke HVEM der kalder -
-- de stoler paa deres parametre, fordi de var taenkt som interne.
--
-- Alle fem kaldes udelukkende fra serverkode med service-role-klienten
-- (eller fra pg_cron), som ikke paavirkes af disse grants. At lukke dem
-- braekker derfor ingenting:
--
--   wallet_bogfoer       -> adminActions.justerSaldo   (admin.rpc)
--   wallet_saet_saldo    -> adminActions.saetSaldo     (admin.rpc)
--   wallet_indbetal      -> stripe-webhook             (createAdminClient)
--   wallet_frigiv        -> kun fra SQL
--   wallet_afregn_auktion-> kun fra SQL (afslut_udloebne_auktioner)
--
-- wallet_udbetal_saelger er IKKE med her: den kaldes fra browserens session
-- og haandteres i feature-migrationen, hvor den laegges om til auth.uid().

revoke execute on function public.wallet_bogfoer(
  uuid, numeric, text, uuid, text, text) from anon, authenticated;

revoke execute on function public.wallet_saet_saldo(
  uuid, numeric, text) from anon, authenticated;

revoke execute on function public.wallet_indbetal(
  uuid, numeric, text) from anon, authenticated;

revoke execute on function public.wallet_frigiv(uuid) from anon, authenticated;

revoke execute on function public.wallet_afregn_auktion(uuid)
  from anon, authenticated;

-- PUBLIC arver ogsaa execute som standard i public-skemaet; uden dette kan
-- rettighederne komme ind ad bagdoeren.
revoke execute on function public.wallet_bogfoer(
  uuid, numeric, text, uuid, text, text) from public;
revoke execute on function public.wallet_saet_saldo(uuid, numeric, text) from public;
revoke execute on function public.wallet_indbetal(uuid, numeric, text) from public;
revoke execute on function public.wallet_frigiv(uuid) from public;
revoke execute on function public.wallet_afregn_auktion(uuid) from public;
