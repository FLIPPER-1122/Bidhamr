-- =====================================================================
-- Niels' gennemgang (Ankerdigital, okt. 2026): M02 og M03
-- =====================================================================
-- Kan køres i produktion uden at vente på appen, så længe appen ikke
-- læser auction_views.seer, reports.handled_by/handled_note eller
-- select('*') på de to tabeller (det giver nu "permission denied").
-- Vinderens id (auctions.vinder_id)
-- skjules i 20261010061000_niels_m03_vinder_id_app_afhaengig.sql, som
-- først må køres i produktion, når Expo-appen er tilpasset.
--
-- M02 – Chat og billeder kan ændres bagefter
--   1. messages.created_at sættes altid af databasen ved insert fra
--      brugere. Før kunne klienten sætte et gammelt tidspunkt – det
--      ødelagde beskeden som bevis i sager OG omgik grænsen for antal
--      beskeder (10/min, 150/time) og tjekket for gentagne beskeder i
--      messages_tryghed, som tæller på created_at.
--   2. Brugere kan aldrig ændre eller slette en besked (heller ikke via en
--      fremtidig policy): grants fjernes, og en trigger afviser det.
--      Alarmen for kontaktoplysninger (messages_tryghed /
--      messages_spam_rapport) kører kun ved insert – nu kan indholdet ikke
--      skiftes bagefter.
--   3. Auktionsbilleder kan ikke overskrives (upsert), flyttes eller
--      ændres af brugere, og ikke slettes, når auktionen har bud eller en
--      handel. Restriktive storage-policies, så en senere permissiv policy
--      ikke kan åbne det igen.
--
-- M03 – Læseadgang er for bred
--   4. auction_views.seer (hvem der har kigget) kan ikke læses – kun
--      auktion og tidspunkt (antal via hent_mine_visninger).
--   5. reports.handled_by (medarbejderen) og reports.handled_note (intern
--      note) kan ikke læses af anmelderen.
--   6. jeg_er_vinder(p_auktion): appen kan spørge, om den indloggede er
--      vinder, uden at læse vinder_id.
--
-- Allerede rettet før denne fil (ingen ændring her):
--   - Skjulte auktioner: auctions_select_anon kræver "ikke skjult"
--     (20261009020000_sikkerhed_rettelser.sql); indloggede ser kun skjulte
--     auktioner som sælger, deltager (auktion_arkiv_adgang) eller staff.
--   - sager.intern_note/afgjort_af og sag_anker.intern_note/behandlet_af/
--     ankede_afgjort_af: kun kolonne-grants uden de felter
--     (20261003010000_sager.sql, 20261004050000_anke.sql).
--
-- Idempotent.

set lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 1. messages: databasen sætter tidspunktet
-- ---------------------------------------------------------------------
create or replace function public.messages_server_tid()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Direkte fra klienten (PostgREST som anon/authenticated) eller via en
  -- RPC kaldt af en bruger: tidspunktet er altid nu. Kun service role og
  -- migrationer/seed (postgres uden bruger) må selv sætte det.
  if current_user in ('anon', 'authenticated')
     or coalesce(auth.role(), '') in ('anon', 'authenticated') then
    new.created_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.messages_server_tid() from public, anon, authenticated;

-- Navnet starter med "a", så triggeren kører FØR messages_tryghed
-- (BEFORE-triggere kører i alfabetisk rækkefølge).
drop trigger if exists messages_a_server_tid on public.messages;
create trigger messages_a_server_tid
  before insert on public.messages
  for each row execute function public.messages_server_tid();

-- ---------------------------------------------------------------------
-- 2. messages: kan ikke ændres eller slettes af brugere
-- ---------------------------------------------------------------------
create or replace function public.messages_uforanderlig()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     or coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'Beskeder kan ikke ændres eller slettes.'
      using errcode = 'BHM04';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function public.messages_uforanderlig() from public, anon, authenticated;

drop trigger if exists messages_uforanderlig on public.messages;
create trigger messages_uforanderlig
  before update or delete on public.messages
  for each row execute function public.messages_uforanderlig();

-- Ingen UPDATE/DELETE-policy findes; grants fjernes også, så en fremtidig
-- policy ikke åbner for det. anon kan aldrig skrive beskeder.
revoke update, delete, truncate, references, trigger on public.messages from anon, authenticated;
revoke insert on public.messages from anon;

-- ---------------------------------------------------------------------
-- 3. Auktionsbilleder: ingen overskrivning, flytning eller sletning efter bud
-- ---------------------------------------------------------------------
-- Billederne ligger i <sælger-id>/<navn> og kan kun bruges af sælgerens
-- egne auktioner (auktion_billeder_gyldige), så det er nok at slå op i
-- sælgerens auktioner. Uafhængig af auth.uid(), så den også gælder, hvis
-- en anden end sælgeren nogensinde får en policy på bucket'en.
create or replace function public.auktion_billede_laast(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_name is not null
     and exists (
       select 1
         from public.auctions a
        where a.bruger_id::text = split_part(p_name, '/', 1)
          and exists (
            select 1 from unnest(a.billeder) as u(url)
             where right(split_part(u.url, '?', 1), char_length(p_name) + 18)
                   = '/auktion-billeder/' || p_name
          )
          and (
            exists (select 1 from public.bids b where b.auktion_id = a.id)
            or exists (select 1 from public.trades t where t.auction_id = a.id)
          )
     );
$$;
revoke all on function public.auktion_billede_laast(text) from public, anon;
-- Kun indloggede brugere (og service_role) evaluerer sletnings-policyen
-- nedenfor. anon kan ikke slette i storage og skal ikke kunne kalde den.
grant execute on function public.auktion_billede_laast(text) to authenticated, service_role;

-- Opdatering af et objekt i auktion-billeder er aldrig tilladt for brugere:
-- det dækker upsert (insert ... on conflict do update), flyt (move) og
-- ændring af metadata. Upload sker altid til en ny sti (<uuid>.jpg).
-- with check: man kan heller ikke flytte et objekt IND i bucket'en.
drop policy if exists auktion_billeder_ingen_update on storage.objects;
create policy auktion_billeder_ingen_update on storage.objects
  as restrictive
  for update
  to anon, authenticated
  using (bucket_id <> 'auktion-billeder')
  with check (bucket_id <> 'auktion-billeder');

-- Sletning: aldrig når billedet bruges af en auktion med bud eller handel.
drop policy if exists auktion_billeder_slet_ikke_laast on storage.objects;
create policy auktion_billeder_slet_ikke_laast on storage.objects
  as restrictive
  for delete
  to authenticated
  using (bucket_id <> 'auktion-billeder' or not public.auktion_billede_laast(name));

-- ---------------------------------------------------------------------
-- 4. auction_views: hvem der har kigget kan ikke læses
-- ---------------------------------------------------------------------
-- 20261009021000_sikkerhed_app_afhaengig.sql fjerner al direkte læsning
-- (policy + grant). Er den ikke kørt endnu (produktion), beholder sælgeren
-- læseadgang til sine egne visninger – men kun auktion og tidspunkt, ikke
-- seer. Er den kørt, gøres intet.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'auction_views'
       and policyname = 'auction_views_select_ejer'
  ) then
    revoke select on public.auction_views from anon, authenticated;
    grant select (auktion_id, foerste_visning) on public.auction_views to authenticated;
  else
    revoke select on public.auction_views from anon, authenticated;
  end if;
end $$;
revoke insert, update, delete, truncate, references, trigger
  on public.auction_views from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. reports: anmelderen ser ikke medarbejder eller intern note
-- ---------------------------------------------------------------------
-- Policy reports_select_own (anmelderen ser egne anmeldelser) består.
-- Admin læser med service role.
revoke select, update, delete, truncate, references, trigger on public.reports from anon, authenticated;
grant select (id, auction_id, reporter_id, category, description, created_at, status)
  on public.reports to authenticated;

-- ---------------------------------------------------------------------
-- 6. jeg_er_vinder: er den indloggede vinder af auktionen?
-- ---------------------------------------------------------------------
create or replace function public.jeg_er_vinder(p_auktion uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.vinder_id = auth.uid()
       from public.auctions a
      where a.id = p_auktion and auth.uid() is not null),
    false);
$$;
revoke all on function public.jeg_er_vinder(uuid) from public, anon;
grant execute on function public.jeg_er_vinder(uuid) to authenticated;

reset lock_timeout;

-- Tilbagerulning:
--   drop trigger messages_a_server_tid / messages_uforanderlig on public.messages;
--   grant update, delete on public.messages to authenticated;
--   drop policy auktion_billeder_ingen_update / auktion_billeder_slet_ikke_laast on storage.objects;
--   grant select on public.reports to authenticated;
--   grant select on public.auction_views to authenticated;  (kun hvis 021000 ikke er kørt)
--   drop function public.jeg_er_vinder(uuid);
