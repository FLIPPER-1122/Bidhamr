-- Admin-annullering af en auktion (adminActions deleteAuction/cancelAuction)
-- frigiver den hoejestbydendes reservation via wallet_frigiv med
-- service-role. Supabase giver normalt service_role execute via default
-- privileges, men det goeres eksplicit her. Funktionen er fortsat lukket for
-- public, anon og authenticated (20260922020000).
--
-- Guardet med to_regprocedure, saa migrationen ikke fejler, hvis
-- wallet-migrationerne ikke er koert i miljoeet.
do $$
begin
  if to_regprocedure('public.wallet_frigiv(uuid)') is not null then
    grant execute on function public.wallet_frigiv(uuid) to service_role;
  end if;
end;
$$;
