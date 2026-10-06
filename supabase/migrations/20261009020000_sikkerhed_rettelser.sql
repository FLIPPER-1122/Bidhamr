-- Rettelser fra den fulde sikkerhedsgennemgang (okt. 2026).
--
-- SIKKER AT KOERE I PRODUKTION NU: intet her kraever, at Expo-appen aendres.
-- Det, der kraever en app-opdatering, ligger i 20261009021000_sikkerhed_app_afhaengig.sql
-- (tilbageholdt).
--
-- Idempotent: kan koeres flere gange (create or replace / drop ... if exists /
-- "if not exists"-tjek). Uafhaengig af raekkefoelgen i forhold til
-- 20261007032000_mfa_database_haandhaevelse (se afsnit 3).
--
--  1. hent_medarbejdere(): indfanget fra produktion og laast til staff.
--  2. auctions-RLS (M1): skjulte auktioner er ikke laengere synlige for alle.
--  3. Storage (M5): ingen offentlig listing af auktion-billeder/avatarer, loft
--     paa antal filer pr. bruger, og billeder i en auktion med bud/handel kan
--     ikke slettes af brugeren.
--  4. Laengdegraenser (M6) + venteliste kun via /api/waitlist (service role).
--  5. users.avatar_url skal pege paa projektets egen avatarer-bucket (L2).
--  6. moderation_log: ny handling 'rolle_aendret' (L3).
--  7. search_path paa tre funktioner (L4).
--  8. Prod-drift indfanget (triggere) + truncate/trigger/references fjernet
--     fra anon/authenticated (M8).
--  9. rapporter_auktion(): RPC til anmeldelse af en auktion, saa appen kan
--     holde op med at indsaette direkte i reports (se migration B).
--
-- Tilbagerulning: se kommentaren ved hver sektion.

set lock_timeout = '5s';

-- =====================================================================
-- 1. hent_medarbejdere()
-- =====================================================================
-- Fandtes kun i produktion (oprettet til appen). Den returnerede id og navn
-- paa ALLE medarbejdere til enhver indlogget bruger. Hjemmesiden kalder den
-- ikke; appen goer formentlig (klage over medarbejder). For ikke at vaelte
-- appen med en rettighedsfejl beholdes execute-retten, men funktionen
-- returnerer nu kun noget til staff - almindelige brugere faar en tom liste.
-- Tilbagerulning: fjern "public.er_staff() and" fra where.
create or replace function public.hent_medarbejdere()
returns table(id uuid, navn text)
language sql
stable
security definer
set search_path = ''
as $function$
  select u.id, coalesce(nullif(btrim(u.navn), ''), 'Ukendt')
    from public.users u
   where public.er_staff()
     and u.rolle in ('medarbejder', 'admin', 'chef')
   order by 2;
$function$;

revoke all on function public.hent_medarbejdere() from public, anon;
grant execute on function public.hent_medarbejdere() to authenticated, service_role;

-- =====================================================================
-- 2. auctions SELECT-policies (M1)
-- =====================================================================
-- Produktion havde en ekstra policy auctions_select_synlige (to public):
--   coalesce(skjult,false) = false or auth.uid() = bruger_id or er_staff()
-- Policies OR'es, saa den gjorde arkiverede auktioner synlige for alle, og
-- auctions_select_anon/_authenticated (arkiveret_kl is null) gjorde skjulte
-- auktioner synlige for alle. Nu:
--   anon:          aktiv (ikke arkiveret) og ikke skjult.
--   authenticated: egen auktion, staff, ikke-skjult og ikke-arkiveret, eller
--                  deltager (auktion_arkiv_adgang: saelger, vinder, byder,
--                  koeber/saelger i handlen, andenchance-tilbud, staff).
-- Deltagere kan stadig se en skjult/arkiveret auktion, de har budt paa eller
-- handlet - ellers knaekker auktionssiden og "Mine handler" for vinderen af
-- en auktion, som admin senere har skjult.
-- Admin bruger service role og er upaavirket.
-- Tilbagerulning: genskab de tre policies fra pg_policies (se rapporten).
drop policy if exists auctions_select_synlige on public.auctions;

drop policy if exists auctions_select_anon on public.auctions;
create policy auctions_select_anon on public.auctions
  for select to anon
  using (arkiveret_kl is null and not coalesce(skjult, false));

drop policy if exists auctions_select_authenticated on public.auctions;
create policy auctions_select_authenticated on public.auctions
  for select to authenticated
  using (
    bruger_id = (select auth.uid())
    or public.er_staff()
    or (arkiveret_kl is null and not coalesce(skjult, false))
    or public.auktion_arkiv_adgang(id)
  );

-- =====================================================================
-- 3. Storage (M5)
-- =====================================================================
-- Bucketene auktion-billeder og avatarer er public: billederne vises via
-- /storage/v1/object/public/... uden om RLS. SELECT-policyerne var derfor kun
-- noedvendige for at LISTE filer (storage.list), hvilket afsloerede alle
-- brugeres mapper og filnavne. Hjemmesiden lister kun avatarer med service
-- role (kontosletning).
drop policy if exists auktion_billeder_select_all on storage.objects;
drop policy if exists avatarer_select_all on storage.objects;

-- Antal filer i brugerens egen mappe i en bucket er under loftet.
create or replace function public.storage_mappe_under_loft(p_bucket text, p_loft integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null
     and (select count(*)
            from storage.objects o
           where o.bucket_id = p_bucket
             and o.name like auth.uid()::text || '/%') < p_loft;
$function$;

revoke all on function public.storage_mappe_under_loft(text, integer) from public, anon;
grant execute on function public.storage_mappe_under_loft(text, integer) to authenticated, service_role;

-- Et auktionsbillede maa ikke slettes af brugeren, hvis det indgaar i en af
-- hans auktioner, der har bud eller en handel (bevis i sager/DSA og
-- bogfoering). Billeder i auktioner uden bud (redigering) kan slettes.
-- Mappen er altid uploaderens id (= saelgeren), saa kun hans egne auktioner
-- skal tjekkes (indeks auctions_bruger_id_idx).
create or replace function public.auktion_billede_maa_slettes(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select auth.uid() is not null
     and p_name is not null
     and not exists (
       select 1
         from public.auctions a
        where a.bruger_id = auth.uid()
          and exists (
            select 1 from unnest(a.billeder) as u(url)
             where right(u.url, char_length(p_name) + 18) = '/auktion-billeder/' || p_name
          )
          and (
            exists (select 1 from public.bids b where b.auktion_id = a.id)
            or exists (select 1 from public.trades t where t.auction_id = a.id)
          )
     );
$function$;

revoke all on function public.auktion_billede_maa_slettes(text) from public, anon;
grant execute on function public.auktion_billede_maa_slettes(text) to authenticated, service_role;

-- Faelles to-trins-tjek for storage: policyerne herunder kalder ALTID
-- public.storage_to_trin_ok(). Findes den ikke (20261007032000_mfa_database_
-- haandhaevelse er ikke koert), oprettes den her som "altid true", og 032000
-- erstatter den senere med det rigtige tjek uden at roere policyerne. Findes
-- den allerede (032000 koert), beholdes den. Raekkefoelgen er ligegyldig.
do $do$
begin
  if to_regprocedure('public.storage_to_trin_ok()') is null then
    execute $fn$
      create function public.storage_to_trin_ok()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$ select true $body$
    $fn$;
    revoke all on function public.storage_to_trin_ok() from public;
    grant execute on function public.storage_to_trin_ok() to anon, authenticated, service_role;
  end if;
end $do$;

drop policy if exists auktion_billeder_insert_own on storage.objects;
create policy auktion_billeder_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'auktion-billeder'
    and (select auth.uid())::text = (storage.foldername(name))[1]
    and public.storage_mappe_under_loft('auktion-billeder', 200)
    and public.storage_to_trin_ok()
  );

drop policy if exists auktion_billeder_delete_own on storage.objects;
create policy auktion_billeder_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'auktion-billeder'
    and (select auth.uid())::text = (storage.foldername(name))[1]
    and public.auktion_billede_maa_slettes(name)
    and public.storage_to_trin_ok()
  );

drop policy if exists avatarer_insert_own on storage.objects;
create policy avatarer_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatarer'
    and (select auth.uid())::text = (storage.foldername(name))[1]
    and public.storage_mappe_under_loft('avatarer', 10)
    and public.storage_to_trin_ok()
  );

-- =====================================================================
-- 4. Laengdegraenser (M6) og venteliste
-- =====================================================================
-- Tilfoejes NOT VALID (eksisterende data stopper ikke migrationen) og
-- valideres derefter. Overholder eksisterende data ikke graensen, beholdes
-- constrainten som NOT VALID (gaelder kun nye/aendrede raekker), og der
-- skrives en NOTICE. Tjekket i produktion 2026-10-06: alt overholder graenserne.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('public.users',              'users_navn_laengde',           'navn is null or char_length(navn) <= 100'),
      ('public.users',              'users_telefon_laengde',        'telefon is null or char_length(telefon) <= 30'),
      ('public.users',              'users_avatar_url_laengde',     'avatar_url is null or char_length(avatar_url) <= 500'),
      ('public.auctions',           'auctions_maerke_laengde',      'maerke is null or char_length(maerke) <= 100'),
      ('public.auctions',           'auctions_lokation_laengde',    'lokation is null or char_length(lokation) <= 200'),
      ('public.employee_complaints','employee_complaints_description_laengde', 'description is null or char_length(description) <= 5000'),
      ('public.auction_templates',  'auction_templates_data_stoerrelse', 'pg_column_size(data) <= 20000')
    ) as t(tabel, navn, udtryk)
  loop
    if to_regclass(r.tabel) is null then
      raise notice 'Springer % over: tabellen % findes ikke', r.navn, r.tabel;
      continue;
    end if;
    if not exists (
      select 1 from pg_constraint c
       where c.conname = r.navn and c.conrelid = to_regclass(r.tabel)
    ) then
      execute format('alter table %s add constraint %I check (%s) not valid', r.tabel, r.navn, r.udtryk);
    end if;
    begin
      execute format('alter table %s validate constraint %I', r.tabel, r.navn);
    exception when check_violation then
      raise notice 'Constraint % beholdes NOT VALID: eksisterende raekker overskrider graensen', r.navn;
    end;
  end loop;
end $$;

-- Venteliste: kun /api/waitlist (service role, med IP-graense) maa skrive.
-- Foer kunne enhver med anon-noeglen indsaette ubegraenset direkte.
-- Appen bruger ikke ventelisten.
drop policy if exists venteliste_insert_alle on public.venteliste;
revoke all on public.venteliste from anon, authenticated;
grant all on public.venteliste to service_role;

-- =====================================================================
-- 5. users.avatar_url (L2)
-- =====================================================================
-- Profilbilledet maa kun pege paa BidHamrs egen avatarer-bucket (produktion
-- eller test) i brugerens egen mappe - ellers kunne en bruger saette en URL
-- til en fremmed server (sporingspixel, IP-logning af alle, der ser profilen).
-- Gaelder ogsaa service role (der er ingen grund til andre URL'er).
create or replace function public.users_avatar_url_gyldig()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.avatar_url is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.avatar_url is not distinct from old.avatar_url then
    return new;
  end if;
  if new.avatar_url !~ (
       '^https://(lkifkrexeldimmghnsie|pjiigmzqwlfepxnjdvug)\.supabase\.co'
       || '/storage/v1/object/public/avatarer/'
       || new.id::text || '/[A-Za-z0-9._-]{1,200}$'
     )
     or position('..' in new.avatar_url) > 0 then
    raise exception 'Ugyldigt profilbillede.' using errcode = '22023';
  end if;
  return new;
end;
$function$;

drop trigger if exists users_avatar_url_gyldig on public.users;
create trigger users_avatar_url_gyldig
  before insert or update of avatar_url on public.users
  for each row execute function public.users_avatar_url_gyldig();

-- =====================================================================
-- 6. moderation_log: 'rolle_aendret' (L3)
-- =====================================================================
-- Flettes ind i den NUVAERENDE liste (andre migrationer, fx DSA, tilfoejer
-- ogsaa handlinger), saa ingen eksisterende vaerdi tabes.
do $$
declare
  v_def    text;
  v_liste  text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'moderation_log_handling_check'
     and c.conrelid = 'public.moderation_log'::regclass;
  if v_def is null then
    raise notice 'moderation_log_handling_check findes ikke - springes over';
    return;
  end if;
  v_liste := string_to_array(substring(v_def from '\{([^}]*)\}'), ',');
  if v_liste is null or array_length(v_liste, 1) is null then
    raise exception 'Kunne ikke laese moderation_log_handling_check: %', v_def;
  end if;
  if 'rolle_aendret' = any (v_liste) then
    return;
  end if;
  v_liste := array(select distinct x from unnest(v_liste || 'rolle_aendret'::text) as x order by x);
  alter table public.moderation_log drop constraint moderation_log_handling_check;
  execute format(
    'alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))',
    v_liste
  );
end $$;

-- =====================================================================
-- 7. search_path (L4)
-- =====================================================================
-- Ingen af de tre bruger ukvalificerede tabelnavne (kun raise / indbyggede
-- funktioner fra pg_catalog), saa '' er sikkert.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.afhentninger_forbyd_sletning()',
    'public.betalinger_forbyd_sletning()',
    'public.beregn_beskyttelse_oere(bigint)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('alter function %s set search_path = %L', f, '');
    end if;
  end loop;
end $$;

-- =====================================================================
-- 8. Prod-drift (M8) og tabelrettigheder
-- =====================================================================
-- Triggere, der kun fandtes i produktion (hentet ordret 2026-10-06), saa test
-- og produktion matcher.
create or replace function public.employee_complaints_beskyt_ny()
returns trigger
language plpgsql
set search_path = 'public'
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role'
     or current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  new.status := 'pending';
  new.created_at := now();
  return new;
end;
$function$;

do $$
begin
  if to_regclass('public.employee_complaints') is not null
     and not exists (
       select 1 from pg_trigger
        where tgname = 'employee_complaints_beskyt_ny'
          and tgrelid = 'public.employee_complaints'::regclass
     ) then
    create trigger employee_complaints_beskyt_ny
      before insert on public.employee_complaints
      for each row execute function public.employee_complaints_beskyt_ny();
  end if;
end $$;

create or replace function public.venteliste_ryd_ny()
returns trigger
language plpgsql
set search_path = 'public'
as $function$ begin new.email := lower(btrim(new.email)); return new; end; $function$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'venteliste_ryd_ny'
       and tgrelid = 'public.venteliste'::regclass
  ) then
    create trigger venteliste_ryd_ny
      before insert on public.venteliste
      for each row execute function public.venteliste_ryd_ny();
  end if;
end $$;

-- Supabases standard-grants giver anon/authenticated TRUNCATE, TRIGGER og
-- REFERENCES paa alle tabeller. TRUNCATE gaar uden om RLS. Ingen klient har
-- brug for nogen af dem.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- =====================================================================
-- 9. rapporter_auktion() - anmeld en auktion via RPC
-- =====================================================================
-- Appen og hjemmesiden indsaetter i dag direkte i reports. Migration B
-- fjerner den direkte insert-ret, naar appen er skiftet til denne funktion.
-- Samme koder som rapporter_bruger(): ok, ikke_logget_ind, ugyldig_kategori,
-- beskrivelse_mangler, for_lang_tekst, ikke_fundet, findes, for_mange.
create or replace function public.rapporter_auktion(
  p_auktion uuid,
  p_kategori text,
  p_beskrivelse text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid   uuid := auth.uid();
  v_beskr text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  n       integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_kategori is null or p_kategori not in (
       'andet', 'forbudt_vare', 'forfalsket_vare', 'mistaenkelig_saelger',
       'spam_duplikat', 'stoedende_indhold', 'ulovlig_vare') then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_kategori = 'andet' and v_beskr is null then
    return jsonb_build_object('kode', 'beskrivelse_mangler');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 2000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  -- Auktionen skal findes og vaere synlig for anmelderen.
  if p_auktion is null or not exists (
       select 1 from public.auctions a
        where a.id = p_auktion
          and ((a.arkiveret_kl is null and not coalesce(a.skjult, false))
               or public.auktion_arkiv_adgang(a.id))) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Samme auktion anmeldt igen, mens den forrige er aaben.
  if exists (
       select 1 from public.reports r
        where r.reporter_id = v_uid and r.auction_id = p_auktion
          and r.status in ('pending', 'under_behandling')) then
    return jsonb_build_object('kode', 'findes');
  end if;

  select count(*) into n from public.reports r
   where r.reporter_id = v_uid and r.created_at > now() - interval '1 day';
  if n >= 20 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  insert into public.reports (auction_id, reporter_id, category, description, status)
  values (p_auktion, v_uid, p_kategori, v_beskr, 'pending');

  return jsonb_build_object('kode', 'ok');
end;
$function$;

revoke all on function public.rapporter_auktion(uuid, text, text) from public, anon;
grant execute on function public.rapporter_auktion(uuid, text, text) to authenticated, service_role;

reset lock_timeout;
