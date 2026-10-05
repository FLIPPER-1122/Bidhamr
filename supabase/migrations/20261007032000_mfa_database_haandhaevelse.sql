-- ============================================================================
-- KØRES FØRST I PRODUKTION, NÅR EXPO-APPEN UNDERSTØTTER TO-TRINS-LOGIN
-- (mfa.challengeAndVerify)
-- ============================================================================
--
-- Hvorfor vente: når denne fil er kørt, afviser databasen ALLE forespørgsler
-- fra en bruger med to-trins-login, hvis sessionen kun har adgangskoden
-- (aal1). En app, der ikke kan bede om koden, kan så slet ikke bruge
-- databasen for de brugere. Indtil da håndhæver hjemmesiden selv to-trin i
-- proxyen og i server actions (getUserMedToTrin / manglerToTrin).
--
-- Testdatabasen har allerede pre-requesten (fra 20261007030000 før den blev
-- delt op). Filen er idempotent og kan køres igen.
--
-- Hvad den gør (PostgREST kalder funktionen før hver forespørgsel - tabeller
-- og RPC'er; gælder IKKE Realtime og Storage):
--   1. Rollen authenticated + bruger med verificeret to-trins-faktor + aal1
--      -> afvist ("To-trins-login mangler").
--   2. Rollen authenticated + users.konto_slettet_kl er sat -> afvist. Et
--      access token lever op til en time efter kontosletningen.
--   3. anon og service_role slipper ALTID igennem (ingen opslag).
--   4. Uventet fejl i opslaget for authenticated -> slippes igennem (fail
--      open) med en WARNING i loggen. Bevidst valg: en fejl her (fx ændrede
--      rettigheder på auth.mfa_factors) må ikke lukke hele sitet og appen
--      ned. RLS og hjemmesidens egne tjek gælder stadig.
--
-- !!! FUNKTIONEN MÅ ALDRIG DROPPES ELLER OMDØBES, så længe rollen peger på
-- !!! den: findes public.bidhamr_pre_request ikke, fejler HVER forespørgsel
-- !!! til PostgREST (hele sitet og appen er nede).
--
-- Tilbagerulning (kør i SQL-editoren):
--   alter role authenticator reset pgrst.db_pre_request;
--   notify pgrst, 'reload config';
-- Først DEREFTER må funktionen evt. droppes.

create or replace function public.bidhamr_pre_request()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_claims  jsonb;
  v_uid     uuid;
  v_aal2    boolean;
  v_mfa     boolean := false;
  v_slettet boolean := false;
begin
  -- Ingen/ugyldige claims = anon-noeglen eller intern forespoergsel.
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return;
  end;
  if v_claims is null or (v_claims->>'role') is distinct from 'authenticated' then
    return;  -- anon, service_role m.fl.: altid igennem
  end if;

  begin
    v_uid  := (v_claims->>'sub')::uuid;
    v_aal2 := coalesce(v_claims->>'aal', 'aal1') = 'aal2';
    if v_uid is null then
      return;
    end if;

    select exists (select 1 from public.users u
                    where u.id = v_uid and u.konto_slettet_kl is not null)
      into v_slettet;

    if not v_aal2 then
      select exists (select 1 from auth.mfa_factors f
                      where f.user_id = v_uid and f.status = 'verified')
        into v_mfa;
    end if;
  exception when others then
    -- Fail open (se overskriften). Afvisningerne herunder kastes UDEN for
    -- denne blok, saa de aldrig fanges her.
    raise warning 'bidhamr_pre_request: opslag fejlede (%): %', sqlstate, sqlerrm;
    return;
  end;

  if v_slettet then
    raise exception 'Kontoen er slettet.'
      using errcode = '42501', hint = 'konto_slettet';
  end if;
  if v_mfa then
    raise exception 'To-trins-login mangler. Log ind igen med koden fra din app.'
      using errcode = '42501', hint = 'mfa_kraeves';
  end if;
end;
$fn$;

comment on function public.bidhamr_pre_request() is
  'PostgREST db_pre_request (rollen authenticator). MAA ALDRIG DROPPES ELLER '
  'OMDOEBES, mens rollen peger paa den. Tilbagerulning: alter role authenticator '
  'reset pgrst.db_pre_request; notify pgrst, ''reload config''; '
  'Se 20261007032000_mfa_database_haandhaevelse.sql.';

revoke all on function public.bidhamr_pre_request() from public;
grant execute on function public.bidhamr_pre_request() to anon, authenticated, service_role;

alter role authenticator set pgrst.db_pre_request to 'public.bidhamr_pre_request';
notify pgrst, 'reload config';

-- ============================================================================
-- Storage: to-trin ogsaa for uploads (tilfoejet i fase 4-testrettelserne)
-- ============================================================================
--
-- Pre-requesten ovenfor gaelder ikke Storage. Uden dette afsnit kan en
-- aal1-session (kun adgangskode) for en bruger med to-trins-login uploade
-- og slette billeder. Skrive-policies (insert/delete) paa storage.objects
-- kraever nu storage_to_trin_ok(): sessionen er aal2, ELLER brugeren har
-- ingen verificeret to-trins-faktor. Laesning er uaendret.
-- Gaelder buckets: auktion-billeder, avatarer, pakke-billeder, sag-billeder.
-- Tilbagerulning: koer policy-definitionerne uden "and public.storage_to_trin_ok()".

create or replace function public.storage_to_trin_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select auth.uid() is null
      or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f
                      where f.user_id = auth.uid() and f.status = 'verified');
$fn$;

revoke all on function public.storage_to_trin_ok() from public;
grant execute on function public.storage_to_trin_ok() to anon, authenticated, service_role;

alter policy auktion_billeder_insert_own on storage.objects
  with check (bucket_id = 'auktion-billeder'
              and (auth.uid())::text = (storage.foldername(name))[1]
              and public.storage_to_trin_ok());
alter policy auktion_billeder_delete_own on storage.objects
  using (bucket_id = 'auktion-billeder'
         and (auth.uid())::text = (storage.foldername(name))[1]
         and public.storage_to_trin_ok());
alter policy avatarer_insert_own on storage.objects
  with check (bucket_id = 'avatarer'
              and (auth.uid())::text = (storage.foldername(name))[1]
              and public.storage_to_trin_ok());
alter policy avatarer_delete_own on storage.objects
  using (bucket_id = 'avatarer'
         and (auth.uid())::text = (storage.foldername(name))[1]
         and public.storage_to_trin_ok());
alter policy pakke_billeder_upload_saelger on storage.objects
  with check (bucket_id = 'pakke-billeder'
              and public.pakke_billede_maa_uploade(name)
              and public.storage_to_trin_ok());
alter policy sag_billeder_upload_koeber on storage.objects
  with check (bucket_id = 'sag-billeder'
              and public.sag_billede_maa_uploade(name)
              and public.storage_to_trin_ok());
