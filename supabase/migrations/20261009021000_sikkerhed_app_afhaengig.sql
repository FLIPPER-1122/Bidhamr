-- =====================================================================
-- KOERES FOERST I PRODUKTION, NAAR EXPO-APPEN ER TILPASSET
-- =====================================================================
-- Fra sikkerhedsgennemgangen (okt. 2026). Koert paa testdatabasen.
-- Kraever 20261009020000_sikkerhed_rettelser.sql (rapporter_auktion).
--
-- Appen skal FOERST:
--   1. Hente visningstal via rpc('hent_mine_visninger', { p_ids: [...] })
--      i stedet for at laese auction_views direkte.
--   2. Anmelde auktioner via rpc('rapporter_auktion', { p_auktion,
--      p_kategori, p_beskrivelse }) i stedet for insert i reports. Svaret er
--      { kode: 'ok' | 'ikke_logget_ind' | 'ugyldig_kategori' |
--      'beskrivelse_mangler' | 'for_lang_tekst' | 'ikke_fundet' | 'findes' |
--      'for_mange' }.
-- Hjemmesidens anmeld-knap (src/components/AnmeldOpslagKnap.tsx) skal ogsaa
-- vaere skiftet til rapporter_auktion, foer denne fil koeres i produktion.
--
-- Idempotent. Tilbagerulning: se kommentarerne.

set lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- auction_views: ingen direkte laesning
-- ---------------------------------------------------------------------
-- Saelgeren kunne laese alle visningsraekker (tidspunkt, evt. seer-id) paa
-- sine auktioner. Antal hentes via hent_mine_visninger() (security definer,
-- kun egne auktioner, kun antal).
-- Tilbagerulning: genskab auction_views_select_ejer og grant select.
drop policy if exists auction_views_select_ejer on public.auction_views;
revoke select on public.auction_views from anon, authenticated;

-- ---------------------------------------------------------------------
-- reports: ingen direkte insert
-- ---------------------------------------------------------------------
-- Direkte insert havde hverken rate limit, dublet-tjek eller laengdegraense.
-- rapporter_auktion() har det hele.
-- Tilbagerulning: grant insert on public.reports to authenticated og genskab
-- reports_insert_own (with check (auth.uid() = reporter_id)).
drop policy if exists reports_insert_own on public.reports;
revoke insert on public.reports from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'reports_description_laengde'
       and conrelid = 'public.reports'::regclass
  ) then
    alter table public.reports add constraint reports_description_laengde
      check (description is null or char_length(description) <= 2000) not valid;
  end if;
  begin
    alter table public.reports validate constraint reports_description_laengde;
  exception when check_violation then
    raise notice 'reports_description_laengde beholdes NOT VALID';
  end;
end $$;

reset lock_timeout;
