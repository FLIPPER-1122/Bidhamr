-- ============================================================================
-- To-trins-login (TOTP/AAL2) er fjernet (Filip, 7. oktober 2026)
-- ============================================================================
--
-- "Man skal bare være logget ind én gang." Appen laver selv Face ID-login.
-- Hjemmesiden tjekker ikke længere aal2 nogen steder (proxy, server actions,
-- /api/konto/slet, admin). Denne fil fjerner resten i databasen.
-- Idempotent - kan køres igen. Ingen handelsdata røres.
--
-- 1. storage_to_trin_ok() returnerer altid true. Navnet bevares, fordi
--    storage-policies (20261009020000/022000) kalder den. Findes den ikke
--    (fx i produktion, hvor 20261009020000 måske ikke er kørt endnu), oprettes
--    den her - så er rækkefølgen ligegyldig.
-- 2. PostgREST' pre-request (pgrst.db_pre_request = bidhamr_pre_request) slås
--    fra. Den blev kun sat på testdatabasen (den tilbageholdte fil
--    20261007032000_mfa_database_haandhaevelse.sql, som er slettet fra repoet
--    og aldrig er kørt i produktion). "reset" er harmløs, hvis den ikke er sat.
--    BEMÆRK: pre-requesten afviste også tokens fra slettede konti
--    (users.konto_slettet_kl). Det har produktion aldrig haft; kontosletningen
--    logger i stedet ud alle steder (signOut global), og access tokens udløber
--    efter højst en time.
-- 3. Funktionen bidhamr_pre_request droppes, hvis den findes - EFTER reset.
--    På testdatabasen kan forespørgsler i de få millisekunder, før PostgREST
--    har genindlæst sin konfiguration, fejle. I produktion findes hverken
--    indstillingen eller funktionen, så punkt 2 og 3 gør intet dér.
--
-- Eksisterende TOTP-faktorer (auth.mfa_factors) fjernes IKKE her: på
-- testdatabasen er de slettet separat; i produktion er der 0 verificerede
-- (1 halvfærdig) pr. 7. oktober 2026, og de gør ingen skade, da intet tjekker
-- dem længere. mine_data() har ingen MFA-felter, så den er uændret.

-- 1. Storage-tjekket er altid opfyldt.
create or replace function public.storage_to_trin_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$ select true $fn$;

comment on function public.storage_to_trin_ok() is
  'Udgået (to-trins-login fjernet 7. okt. 2026). Returnerer altid true; navnet bevares, fordi storage-policies kalder den.';

revoke all on function public.storage_to_trin_ok() from public;
grant execute on function public.storage_to_trin_ok() to anon, authenticated, service_role;

-- 2. Slå PostgREST' pre-request fra.
alter role authenticator reset pgrst.db_pre_request;
notify pgrst, 'reload config';

-- 3. Drop funktionen (kun efter reset ovenfor).
drop function if exists public.bidhamr_pre_request();
