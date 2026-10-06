-- Rettelser til 20261009020000_sikkerhed_rettelser.sql efter reviewer (okt. 2026).
--
-- Til databaser, hvor den FOERSTE version af 020000 allerede er koert
-- (testdatabasen). 020000 er selv rettet, saa i produktion genskaber denne
-- fil blot de samme objekter - slutresultatet er ens. Idempotent.
--
--  K1: SELECT-policies paa egen mappe (auktion-billeder, avatarer), saa
--      remove() af egne filer virker. Listing af andres mapper er stadig lukket.
--  K2: Loftet paa uploads er et tidsvindue: 100 auktionsbilleder og 10
--      avatarer pr. bruger pr. doegn (foer: 200/10 filer i alt nogensinde).
--  V3: avatar_url maa have query-streng, URL-kodede tegn og aeoeaa i filnavnet.
--  V5: auctions_select_authenticated: billig betingelse foerst, (select ...).
--  M1: robust parsing af moderation_log_handling_check.
--  M3: rapporter_auktion: ikke 'forbudt_vare' (systemkategori), og ikke egen
--      auktion (kode 'egen_auktion').
--
-- Kendt begraensning (V6): to-trins-kravet for staff haandhaeves i Next, ikke
-- i databasen - fuld haandhaevelse kommer med 20261007032000.

set lock_timeout = '5s';

-- ---------------------------------------------------------------- V5
drop policy if exists auctions_select_authenticated on public.auctions;
create policy auctions_select_authenticated on public.auctions
  for select to authenticated
  using (
    -- Den billige betingelse foerst; (select ...) evalueres een gang pr.
    -- forespoergsel i stedet for pr. raekke.
    (arkiveret_kl is null and not coalesce(skjult, false))
    or bruger_id = (select auth.uid())
    or (select public.er_staff())
    or public.auktion_arkiv_adgang(id)
  );

-- ---------------------------------------------------------------- K1 + K2
drop policy if exists auktion_billeder_select_egen on storage.objects;
create policy auktion_billeder_select_egen on storage.objects
  for select to authenticated
  using (
    bucket_id = 'auktion-billeder'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists avatarer_select_egen on storage.objects;
create policy avatarer_select_egen on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatarer'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- Antal filer, brugeren har uploadet i sin egen mappe i en bucket det seneste
-- doegn, er under loftet. Et tidsvindue i stedet for "alle filer nogensinde",
-- saa en aktiv saelger ikke rammer loftet med tiden - det skal kun stoppe
-- masseupload. Navnet er bevaret, fordi 20261007032000_mfa_database_
-- haandhaevelse.sql tjekker, om funktionen findes.
-- Tjekket i produktion 2026-10-06: hoejst 4 auktionsbilleder og 1 avatar pr.
-- bruger pr. doegn. Lofter: 100 auktionsbilleder og 10 avatarer pr. doegn.
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
             and o.name like auth.uid()::text || '/%'
             and o.created_at > now() - interval '1 day') < p_loft;
$function$;

revoke all on function public.storage_mappe_under_loft(text, integer) from public, anon;
grant execute on function public.storage_mappe_under_loft(text, integer) to authenticated, service_role;

drop policy if exists auktion_billeder_insert_own on storage.objects;
create policy auktion_billeder_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'auktion-billeder'
    and (select auth.uid())::text = (storage.foldername(name))[1]
    and public.storage_mappe_under_loft('auktion-billeder', 100)
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


-- ---------------------------------------------------------------- V3
-- Profilbilledet skal pege paa projektets egen avatarer-bucket i brugerens
-- egen mappe. Gaelder ogsaa service role.
-- Filnavnet maa indeholde alt undtagen mellemrum/kontroltegn (ogsaa aeoeaa og
-- URL-kodede tegn), og der maa vaere en query-streng (fx ?t=... til cache).
-- Stien (foer '?') tjekkes for '..' og kodede punktummer/skraastreger, saa man
-- ikke kan pege ud af sin egen mappe.
-- Tjekket i produktion 2026-10-06: alle avatar_url er null. Triggeren gaelder
-- kun ved insert og ved AENDRING af vaerdien, saa en eksisterende vaerdi
-- aldrig blokerer andre opdateringer af users.
create or replace function public.users_avatar_url_gyldig()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_sti text;
begin
  if new.avatar_url is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.avatar_url is not distinct from old.avatar_url then
    return new;
  end if;
  v_sti := split_part(new.avatar_url, '?', 1);
  if new.avatar_url !~ (
       '^https://(lkifkrexeldimmghnsie|pjiigmzqwlfepxnjdvug)\.supabase\.co'
       || '/storage/v1/object/public/avatarer/'
       || new.id::text || '/[^?#[:space:][:cntrl:]]{1,255}'
       || '(\?[^[:space:][:cntrl:]]*)?$'
     )
     or position('..' in v_sti) > 0
     or v_sti ~* '%2e%2e|%2f|%5c|\\' then
    raise exception 'Ugyldigt profilbillede.' using errcode = '22023';
  end if;
  return new;
end;
$function$;

drop trigger if exists users_avatar_url_gyldig on public.users;
create trigger users_avatar_url_gyldig
  before insert or update of avatar_url on public.users
  for each row execute function public.users_avatar_url_gyldig();

-- ---------------------------------------------------------------- M1
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
  -- Samme parsing som 20261007030000_konto_sikkerhed_gdpr.sql: constrainten
  -- kan staa som '{a,b}'::text[] eller som ARRAY['a'::text, ...] / in (...).
  select array_agg(distinct x order by x) into v_liste from (
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(v_def, '''([^'']+)''', 'g') as m
  ) s;
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

-- ---------------------------------------------------------------- M3
-- Samme koder som rapporter_bruger(): ok, ikke_logget_ind, ugyldig_kategori,
-- beskrivelse_mangler, for_lang_tekst, ikke_fundet, findes, for_mange - plus
-- egen_auktion (man kan ikke anmelde sin egen auktion).
-- 'forbudt_vare' er en systemkategori (automatisk rapport fra kontrollen af
-- forbudte ord, src/lib/forbudteVarer.ts) og kan ikke vaelges af brugeren.
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
       'andet', 'forfalsket_vare', 'mistaenkelig_saelger',
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

  if exists (select 1 from public.auctions a
              where a.id = p_auktion and a.bruger_id = v_uid) then
    return jsonb_build_object('kode', 'egen_auktion');
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
