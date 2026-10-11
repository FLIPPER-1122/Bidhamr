-- Sikkerhedsgennemgang 11. okt. 2026 - rettigheder (grants) og drift.
--
--   V1. trades: køber og sælger kunne læse staffs interne felter
--       sag_note (begrundelse) og sag_aabnet_af (medarbejderens id) via REST,
--       fordi authenticated havde SELECT på hele tabellen. Nu:
--         - anon: ingen rettigheder på trades (revoke all).
--         - authenticated: kun kolonne-SELECT på alle kolonner UNDTAGEN
--           sag_note og sag_aabnet_af. Listen bygges dynamisk (som
--           20261010061000 for auctions), så kolonner, der kun findes i den
--           ene database, også kommer med.
--         - insert/update/delete/truncate/references/trigger (og maintain på
--           PG17) fjernes fra anon og authenticated. RLS blokerer dem
--           allerede; alle skrivninger sker med service role eller i
--           security definer-funktioner (ejer postgres), som ikke påvirkes.
--       Konsekvens: select('*') på trades (også indlejret trades(*)) fejler
--       nu for brugerens klient med "permission denied for table trades".
--       Hjemmesiden bruger altid kolonnelister (tjekket 11. okt. 2026), og
--       admin læser sag_note med service role. Appen må heller ikke bruge
--       select('*') på trades (ROADMAP fase 5).
--       NB til fremtidige migrationer: en ny kolonne på trades skal have
--         grant select (<kolonne>) on public.trades to authenticated;
--       ellers kan parterne ikke læse den.
--
--   M4. Grant-hygiejne:
--         - sekvenserne bud_maksimum_log_id_seq, dac7_log_id_seq,
--           drift_cron_koersler_id_seq, drift_fejl_id_seq,
--           erhverv_klager_nummer_seq og navne_arkiv_id_seq: ingen
--           rettigheder for anon og authenticated. Alle inserts i de tabeller
--           sker med service role eller i security definer-funktioner
--           (saet_maksimum, dac7_*, drift_fejl_log via definer/service role,
--           erhverv_klage_opret, navne_arkiv kun fra migrationer).
--         - transactions, moderation_log og employee_complaints: revoke all
--           from anon.
--
--   M7. Drift mellem test og prod (gør intet i produktion):
--         - Storage-policies avatarer_delete_own, sag_billeder_upload_koeber
--           og pakke_billeder_upload_saelger kalder på testdatabasen
--           storage_to_trin_ok() (fra den slettede
--           20261007032000_mfa_database_haandhaevelse.sql). Indeholder
--           policyen kaldet, genskabes den med produktionens definition
--           (20260625000000, 20261003010000 og 20261003040000). Ellers
--           røres den ikke.
--         - oeg_auktion_visning(uuid) (kun testdatabasen, udgået - se
--           20261001030000) droppes, hvis den findes. Bruges ikke i src.
--         - MAINTAIN på auction_views fjernes fra public, anon og
--           authenticated (kun på PG17+, hvor rettigheden findes).
--
-- Idempotent (kan køres flere gange). Kør først på testdatabasen.
--
-- Tilbagerulning V1:
--   grant select on public.trades to authenticated;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- V1. trades: kolonne-SELECT uden staffs interne felter
-- ---------------------------------------------------------------------------
do $$
declare
  v_kolonner text;
begin
  select string_agg(quote_ident(attname), ', ' order by attnum)
    into v_kolonner
    from pg_attribute
   where attrelid = 'public.trades'::regclass
     and attnum > 0
     and not attisdropped
     and attname not in ('sag_note', 'sag_aabnet_af');

  -- revoke all på tabellen fjerner også eventuelle kolonne-rettigheder
  -- (bl.a. en tidligere kolonne-SELECT på sag_note ved gentagen kørsel).
  revoke all on public.trades from anon, authenticated;
  execute format('grant select (%s) on public.trades to authenticated', v_kolonner);
end $$;

-- ---------------------------------------------------------------------------
-- M4. Sekvenser og anon på interne tabeller
-- ---------------------------------------------------------------------------
do $$
declare
  v_seq text;
  v_tabel text;
begin
  foreach v_seq in array array[
    'public.bud_maksimum_log_id_seq',
    'public.dac7_log_id_seq',
    'public.drift_cron_koersler_id_seq',
    'public.drift_fejl_id_seq',
    'public.erhverv_klager_nummer_seq',
    'public.navne_arkiv_id_seq'
  ] loop
    if to_regclass(v_seq) is not null then
      execute format('revoke all on sequence %s from anon, authenticated', v_seq);
    else
      raise notice 'Sekvensen % findes ikke - springes over.', v_seq;
    end if;
  end loop;

  foreach v_tabel in array array[
    'public.transactions',
    'public.moderation_log',
    'public.employee_complaints'
  ] loop
    if to_regclass(v_tabel) is not null then
      execute format('revoke all on table %s from anon', v_tabel);
    else
      raise notice 'Tabellen % findes ikke - springes over.', v_tabel;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- M7a. Storage-policies med storage_to_trin_ok() (kun testdatabasen)
-- ---------------------------------------------------------------------------
-- Definitionerne er de samme som i produktionen (seneste migration for hver
-- policy). Policyen genskabes KUN, hvis den i dag kalder storage_to_trin_ok;
-- i produktion gør afsnittet derfor intet.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'avatarer_delete_own'
       and (coalesce(qual, '') || coalesce(with_check, '')) like '%storage_to_trin_ok%'
  ) then
    drop policy "avatarer_delete_own" on storage.objects;
    create policy "avatarer_delete_own"
      on storage.objects for delete
      using (
        bucket_id = 'avatarer'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
    raise notice 'avatarer_delete_own genskabt uden storage_to_trin_ok.';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'sag_billeder_upload_koeber'
       and (coalesce(qual, '') || coalesce(with_check, '')) like '%storage_to_trin_ok%'
  ) then
    drop policy "sag_billeder_upload_koeber" on storage.objects;
    create policy "sag_billeder_upload_koeber"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'sag-billeder'
        and public.sag_billede_maa_uploade(name)
      );
    raise notice 'sag_billeder_upload_koeber genskabt uden storage_to_trin_ok.';
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'pakke_billeder_upload_saelger'
       and (coalesce(qual, '') || coalesce(with_check, '')) like '%storage_to_trin_ok%'
  ) then
    drop policy "pakke_billeder_upload_saelger" on storage.objects;
    create policy "pakke_billeder_upload_saelger"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'pakke-billeder'
        and public.pakke_billede_maa_uploade(name)
      );
    raise notice 'pakke_billeder_upload_saelger genskabt uden storage_to_trin_ok.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- M7b. Udgået visningstæller (kun testdatabasen)
-- ---------------------------------------------------------------------------
-- Ingen kode i src kalder den; produktion tæller i auction_views via
-- registrer_auktion_visning. Kolonnen auctions.visninger røres ikke.
drop function if exists public.oeg_auktion_visning(uuid);

-- ---------------------------------------------------------------------------
-- M7c. MAINTAIN på auction_views (rettigheden findes kun i PG17+)
-- ---------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int >= 170000
     and to_regclass('public.auction_views') is not null then
    execute 'revoke maintain on table public.auction_views from public, anon, authenticated';
  end if;
end $$;
