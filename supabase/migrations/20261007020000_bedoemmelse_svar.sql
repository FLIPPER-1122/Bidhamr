-- Svar paa bedoemmelser og moderation af bedoemmelser (fase 4, ROADMAP.md;
-- ROADMAP-BESLUTNINGER.md afsnit 6).
--
--   1. public.bedoemmelse_svar: saelgerens ét offentlige svar paa en
--      bedoemmelse ("Svar fra sælger").
--        - Kun saelgeren paa den bedoemte handel (ratings.til_bruger_id, og
--          trades.seller_id naar trade_id findes).
--        - Ét svar pr. bedoemmelse (unique rating_id - ogsaa efter sletning).
--        - Hoejst 1000 tegn. Ingen kontaktinfo (public.indeholder_kontaktinfo,
--          samme filter som "Spørg sælger") og ingen grove ord
--          (public.indeholder_groft_sprog).
--        - Kan rettes eller slettes i 48 timer efter det er skrevet, derefter
--          laast. Sletning er bloed (slettet_kl) - teksten bevares til
--          moderation, men vises aldrig. Et slettet svar kan ikke skrives igen.
--      RPC'er (authenticated, udleder brugeren af auth.uid()):
--        skriv_bedoemmelse_svar(p_rating, p_tekst)   opret eller ret
--        slet_bedoemmelse_svar(p_rating)
--      Fejlkoder: ikke_logget_ind, konto_lukket, suspenderet, ikke_fundet,
--      skjult, slettet, laast, ugyldig_tekst, kontaktinfo, groft_sprog.
--
--   2. Rapportér en bedoemmelse eller et svar: bruger_rapporter faar
--      rating_id + rating_del ('bedoemmelse' | 'svar'). RPC
--        rapporter_bedoemmelse(p_rating, p_del, p_kategori, p_beskrivelse)
--      Kategorier: chikane, stoedende, personoplysninger, kontaktinfo,
--      ikke_relateret, spam, andet. Vises i admin under Bedømmelser.
--
--   3. Staff (medarbejder og op) skjuler/viser en bedoemmelse og/eller et
--      svar med en begrundelse fra en fast liste (bedoemmelse_moderation):
--        groft_sprog | personoplysninger | kontaktinfo | ikke_relateret | andet
--      ('andet' kraever fritekst). Bedoemmelser SLETTES ALDRIG. Skjulte
--      bedoemmelser vises ikke offentligt (RLS) og taeller ikke med i
--      gennemsnittet (users.rating vedligeholdes nu af en trigger). Handlingen
--      logges i moderation_log, og aabne rapporter paa det skjulte lukkes.
--      "Behold" lukker rapporterne uden at skjule.
--      RPC'er (KUN service_role; serveren tjekker rollen med assertRole, og
--      funktionerne tjekker den igen):
--        skjul_bedoemmelse(p_medarbejder, p_rating, p_del, p_skjul, p_grund, p_aarsag)
--        behold_bedoemmelse(p_medarbejder, p_rating, p_note)
--
--   4. ratings: SELECT-policyen viser ikke laengere skjulte bedoemmelser
--      (undtagen for den, der skrev dem). Alle kolonner er uaendrede, saa
--      appens select("*") virker stadig.
--
--   5. Ny valgfri notifikationstype 'bedoemmelse' (koeberen faar besked, naar
--      saelgeren svarer). Notifikationen om skjult indhold sendes som den
--      paakraevede type 'advarsel' (begrundelse til forfatteren - DSA).
--      HOLD SYNKRON med src/lib/notifikationer/typer.ts.
--
-- FLETNINGER (eksisterende vaerdier i databasen bevares altid, ogsaa vaerdier
-- tilfoejet af andre migrationer, fx 20261007010000 / 20261007030000):
--   moderation_log_handling_check   + bedoemmelse_skjult, bedoemmelse_vist,
--                                     bedoemmelse_svar_skjult,
--                                     bedoemmelse_svar_vist, bedoemmelse_beholdt
--   bruger_rapporter_category_check + personoplysninger, kontaktinfo,
--                                     ikke_relateret
--   notifikation_kendt_type()       + 'bedoemmelse' (vaerdierne laeses af den
--                                     nuvaerende funktion og genskrives)
-- rapporter_bruger roeres ikke.
-- Idempotent. Koeres EFTER 20261006040000_auktionsfunktioner.sql
-- (bruger indeholder_kontaktinfo, spoergsmaal_ryd_tekst og
-- staff_chat_har_rolle).

-- ============================================================ 1. Grove ord

-- Bevidst kort liste over entydige skaeldsord, slurs og trusler, saa et
-- almindeligt svar aldrig afvises. Alt andet klares af rapporter + staff.
-- Hele ord (\m \M); teksten normaliseres som i chatten (besked_normaliser).
create or replace function public.indeholder_groft_sprog(p_tekst text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select public.besked_normaliser(p_tekst) ~ (
    '\m('
    || 'luder|ludder|kælling|kaelling|fisse|fissehoved|pikhoved|røvhul|roevhul'
    || '|kraftidiot|spasser|mongol|perker|neger|bøsserøv|boesseroev'
    || '|fuck dig|fuck you|fuck off|dumme svin|klamme svin|dumme kælling'
    || '|slå dig ihjel|slår dig ihjel|dræbe dig|dræber dig|du skal dø'
    || '|jeg ved hvor du bor'
    || ')\M');
$fn$;

revoke all on function public.indeholder_groft_sprog(text) from public, anon;
grant execute on function public.indeholder_groft_sprog(text) to authenticated, service_role;

-- ============================================================ 2. Svar fra saelger

create table if not exists public.bedoemmelse_svar (
  id         uuid primary key default gen_random_uuid(),
  rating_id  uuid not null unique references public.ratings(id) on delete restrict,
  saelger_id uuid not null references public.users(id) on delete restrict,
  tekst      text not null check (char_length(tekst) between 1 and 1000),
  oprettet   timestamptz not null default now(),
  rettet_kl  timestamptz,
  slettet_kl timestamptz,
  skjult     boolean not null default false
);

comment on table public.bedoemmelse_svar is
  'Saelgerens ét offentlige svar paa en bedoemmelse. Kun via RPC''erne '
  'skriv_bedoemmelse_svar og slet_bedoemmelse_svar (bloed sletning). Staff '
  'skjuler via skjul_bedoemmelse (service_role). Slettes aldrig.';

create index if not exists bedoemmelse_svar_saelger_idx
  on public.bedoemmelse_svar (saelger_id, oprettet desc);
create index if not exists bedoemmelse_svar_oprettet_idx
  on public.bedoemmelse_svar (oprettet desc);

alter table public.bedoemmelse_svar enable row level security;
revoke all on public.bedoemmelse_svar from public, anon, authenticated;
grant select on public.bedoemmelse_svar to anon, authenticated;
grant select, insert, update on public.bedoemmelse_svar to service_role;

-- Offentlig: ikke slettet, ikke skjult (saelgeren ser sit eget skjulte svar),
-- og selve bedoemmelsen skal vaere synlig for den, der laeser (ratings' RLS
-- gaelder i underforespoergslen).
drop policy if exists bedoemmelse_svar_select on public.bedoemmelse_svar;
create policy bedoemmelse_svar_select on public.bedoemmelse_svar
  for select to anon, authenticated
  using (
    slettet_kl is null
    and (not skjult or saelger_id = (select auth.uid()))
    and exists (select 1 from public.ratings r where r.id = rating_id)
  );

create or replace function public.bedoemmelse_svar_slettes_aldrig()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  raise exception 'Svar paa bedoemmelser slettes aldrig.' using errcode = '42501';
end;
$fn$;

revoke all on function public.bedoemmelse_svar_slettes_aldrig() from public, anon, authenticated;

drop trigger if exists bedoemmelse_svar_slettes_aldrig on public.bedoemmelse_svar;
create trigger bedoemmelse_svar_slettes_aldrig
  before delete on public.bedoemmelse_svar
  for each row execute function public.bedoemmelse_svar_slettes_aldrig();

-- Faelles tjek af kalderen og bedoemmelsen. Returnerer en fejlkode eller null.
create or replace function public.bedoemmelse_svar_tjek_saelger(p_rating uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  u     record;
  r     record;
begin
  if v_uid is null then
    return 'ikke_logget_ind';
  end if;
  select suspenderet, suspenderet_til, konto_lukket_kl into u
    from public.users where id = v_uid;
  if not found then
    return 'ikke_logget_ind';
  end if;
  if u.konto_lukket_kl is not null then
    return 'konto_lukket';
  end if;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return 'suspenderet';
  end if;

  select ra.id, ra.til_bruger_id, ra.fra_bruger_id, ra.trade_id, ra.skjult into r
    from public.ratings ra where ra.id = p_rating;
  if not found or r.til_bruger_id is distinct from v_uid or r.fra_bruger_id = v_uid then
    return 'ikke_fundet';
  end if;
  -- Kun saelgeren paa den bedoemte handel.
  if r.trade_id is not null and not exists (
       select 1 from public.trades t where t.id = r.trade_id and t.seller_id = v_uid) then
    return 'ikke_fundet';
  end if;
  if r.skjult then
    return 'skjult';
  end if;
  return null;
end;
$fn$;

revoke all on function public.bedoemmelse_svar_tjek_saelger(uuid) from public, anon, authenticated;

-- Saelgeren skriver eller retter sit svar. {"kode": "ok", "id", "ny": bool}.
create or replace function public.skriv_bedoemmelse_svar(p_rating uuid, p_tekst text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_tekst text := public.spoergsmaal_ryd_tekst(p_tekst);
  v_fejl  text;
  s       record;
  v_id    uuid;
begin
  v_fejl := public.bedoemmelse_svar_tjek_saelger(p_rating);
  if v_fejl is not null then
    return jsonb_build_object('kode', v_fejl);
  end if;

  if char_length(v_tekst) < 1 or char_length(v_tekst) > 1000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;
  if public.indeholder_kontaktinfo(v_tekst) then
    return jsonb_build_object('kode', 'kontaktinfo');
  end if;
  if public.indeholder_groft_sprog(v_tekst) then
    return jsonb_build_object('kode', 'groft_sprog');
  end if;

  -- Én ad gangen pr. bedoemmelse (dobbeltklik).
  perform pg_advisory_xact_lock(hashtextextended('bedoemmelse_svar:' || p_rating::text, 0));

  select * into s from public.bedoemmelse_svar where rating_id = p_rating for update;
  if not found then
    insert into public.bedoemmelse_svar (rating_id, saelger_id, tekst)
    values (p_rating, v_uid, v_tekst)
    returning id into v_id;
    return jsonb_build_object('kode', 'ok', 'id', v_id, 'ny', true);
  end if;

  if s.slettet_kl is not null then
    return jsonb_build_object('kode', 'slettet');
  end if;
  if s.skjult then
    return jsonb_build_object('kode', 'skjult');
  end if;
  if s.oprettet <= now() - interval '48 hours' then
    return jsonb_build_object('kode', 'laast');
  end if;
  if s.tekst = v_tekst then
    return jsonb_build_object('kode', 'ok', 'id', s.id, 'ny', false);
  end if;

  update public.bedoemmelse_svar
     set tekst = v_tekst, rettet_kl = now()
   where id = s.id;
  return jsonb_build_object('kode', 'ok', 'id', s.id, 'ny', false);
end;
$fn$;

revoke all on function public.skriv_bedoemmelse_svar(uuid, text) from public, anon;
grant execute on function public.skriv_bedoemmelse_svar(uuid, text) to authenticated;

-- Saelgeren sletter sit svar (inden for 48 timer). Kan ikke skrives igen.
create or replace function public.slet_bedoemmelse_svar(p_rating uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fejl text;
  s      record;
begin
  v_fejl := public.bedoemmelse_svar_tjek_saelger(p_rating);
  -- Et svar paa en skjult bedoemmelse kan stadig ikke slettes (laast af staff).
  if v_fejl is not null then
    return jsonb_build_object('kode', v_fejl);
  end if;

  select * into s from public.bedoemmelse_svar where rating_id = p_rating for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if s.slettet_kl is not null then
    return jsonb_build_object('kode', 'ok');
  end if;
  if s.skjult then
    return jsonb_build_object('kode', 'skjult');
  end if;
  if s.oprettet <= now() - interval '48 hours' then
    return jsonb_build_object('kode', 'laast');
  end if;

  update public.bedoemmelse_svar set slettet_kl = now() where id = s.id;
  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.slet_bedoemmelse_svar(uuid) from public, anon;
grant execute on function public.slet_bedoemmelse_svar(uuid) to authenticated;

-- ============================================================ 3. ratings: synlighed og gennemsnit

-- Skjulte bedoemmelser ses kun af den, der skrev dem (staff bruger service_role).
drop policy if exists ratings_select_all on public.ratings;
drop policy if exists ratings_select on public.ratings;
create policy ratings_select on public.ratings
  for select to anon, authenticated
  using (not skjult or fra_bruger_id = (select auth.uid()));

-- users.rating = gennemsnit af de synlige bedoemmelser (0 uden nogen, som
-- hidtil - kolonnen er not null).
-- Koerer som ejeren, saa users_beskyt_privilegerede_kolonner tillader det.
create or replace function public.ratings_opdater_gennemsnit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_bruger uuid;
begin
  foreach v_bruger in array array[
    case when tg_op <> 'INSERT' then old.til_bruger_id end,
    case when tg_op <> 'DELETE' then new.til_bruger_id end]
  loop
    continue when v_bruger is null;
    update public.users u
       set rating = (select coalesce(round(avg(r.stjerner)::numeric, 2), 0)
                       from public.ratings r
                      where r.til_bruger_id = v_bruger and not r.skjult)
     where u.id = v_bruger
       and u.rating is distinct from (select coalesce(round(avg(r.stjerner)::numeric, 2), 0)
                                        from public.ratings r
                                       where r.til_bruger_id = v_bruger and not r.skjult);
  end loop;
  return null;
end;
$fn$;

revoke all on function public.ratings_opdater_gennemsnit() from public, anon, authenticated;

drop trigger if exists ratings_opdater_gennemsnit on public.ratings;
create trigger ratings_opdater_gennemsnit
  after insert or delete or update of stjerner, skjult, til_bruger_id on public.ratings
  for each row execute function public.ratings_opdater_gennemsnit();

-- Ret alle eksisterende gennemsnit én gang.
update public.users u
   set rating = g.snit
  from (select uu.id,
               (select coalesce(round(avg(r.stjerner)::numeric, 2), 0) from public.ratings r
                 where r.til_bruger_id = uu.id and not r.skjult) as snit
          from public.users uu) g
 where g.id = u.id and u.rating is distinct from g.snit;

-- ============================================================ 4. Moderation (staff)

-- Seneste moderation pr. del (bedoemmelse/svar). Kun service_role.
create table if not exists public.bedoemmelse_moderation (
  rating_id      uuid not null references public.ratings(id) on delete restrict,
  del            text not null check (del in ('bedoemmelse', 'svar')),
  skjult         boolean not null,
  grund          text check (grund is null or grund in
                   ('groft_sprog', 'personoplysninger', 'kontaktinfo', 'ikke_relateret', 'andet')),
  aarsag         text check (aarsag is null or char_length(aarsag) <= 500),
  medarbejder_id uuid not null references public.users(id) on delete restrict,
  kl             timestamptz not null default now(),
  primary key (rating_id, del)
);

comment on table public.bedoemmelse_moderation is
  'Staffs seneste beslutning pr. bedoemmelse/svar (skjult + begrundelse). '
  'Historikken staar i moderation_log. Kun service_role.';

alter table public.bedoemmelse_moderation enable row level security;
revoke all on public.bedoemmelse_moderation from public, anon, authenticated;
grant select, insert, update on public.bedoemmelse_moderation to service_role;

-- Rapporter af bedoemmelser/svar.
alter table public.bruger_rapporter
  add column if not exists rating_id uuid references public.ratings(id) on delete restrict,
  add column if not exists rating_del text;

alter table public.bruger_rapporter drop constraint if exists bruger_rapporter_rating_del_check;
alter table public.bruger_rapporter add constraint bruger_rapporter_rating_del_check
  check ((rating_id is null and rating_del is null)
      or (rating_id is not null and rating_del in ('bedoemmelse', 'svar')));

create index if not exists bruger_rapporter_rating_idx
  on public.bruger_rapporter (rating_id, status) where rating_id is not null;

-- Fletter: alle vaerdier i den nuvaerende constraint bevares + de nye.
do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'bruger_rapporter_category_check'
     and c.conrelid = 'public.bruger_rapporter'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    -- Constrainten kan staa som ARRAY['a'::text, ...] eller som '{a,b}'::text[].
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array['spam', 'chikane', 'svindel', 'betaling_udenom', 'stoedende', 'andet',
                        'auto_mistaenkelig', 'auto_blokeret',
                        'personoplysninger', 'kontaktinfo', 'ikke_relateret'])
  ) s;

  alter table public.bruger_rapporter drop constraint if exists bruger_rapporter_category_check;
  execute format(
    'alter table public.bruger_rapporter add constraint bruger_rapporter_category_check check (category = any (%L::text[]))',
    v_vals);
end $$;

-- En bruger rapporterer en bedoemmelse (p_del = 'bedoemmelse') eller
-- saelgerens svar (p_del = 'svar'). Den rapporterede er forfatteren.
-- Fejlkoder som rapporter_bruger: ikke_logget_ind, ugyldig_kategori,
-- beskrivelse_mangler, for_lang_tekst, ikke_fundet, sig_selv, findes, for_mange.
create or replace function public.rapporter_bedoemmelse(
  p_rating      uuid,
  p_del         text,
  p_kategori    text,
  p_beskrivelse text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_beskr text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  v_maal  uuid;
  r       record;
  s       record;
  n       integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if p_del is null or p_del not in ('bedoemmelse', 'svar') then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if p_kategori is null or p_kategori not in
     ('chikane', 'stoedende', 'personoplysninger', 'kontaktinfo', 'ikke_relateret', 'spam', 'andet') then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_kategori = 'andet' and v_beskr is null then
    return jsonb_build_object('kode', 'beskrivelse_mangler');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 1000 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select ra.id, ra.fra_bruger_id, ra.til_bruger_id, ra.trade_id, ra.skjult into r
    from public.ratings ra where ra.id = p_rating;
  if not found or r.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if p_del = 'svar' then
    select bs.saelger_id, bs.skjult, bs.slettet_kl into s
      from public.bedoemmelse_svar bs where bs.rating_id = p_rating;
    if not found or s.skjult or s.slettet_kl is not null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    v_maal := s.saelger_id;
  else
    v_maal := r.fra_bruger_id;
  end if;

  if v_maal = v_uid then
    return jsonb_build_object('kode', 'sig_selv');
  end if;

  if exists (
    select 1 from public.bruger_rapporter br
     where br.reporter_id = v_uid and br.status = 'ny'
       and br.rating_id = p_rating and br.rating_del = p_del) then
    return jsonb_build_object('kode', 'findes');
  end if;

  -- Samme graense som rapporter_bruger (20 pr. doegn i alt).
  select count(*) into n from public.bruger_rapporter
   where reporter_id = v_uid and created_at > now() - interval '1 day';
  if n >= 20 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  insert into public.bruger_rapporter
    (kilde, reporter_id, reported_id, trade_id, rating_id, rating_del, category, description)
  values ('bruger', v_uid, v_maal, r.trade_id, p_rating, p_del, p_kategori, v_beskr);

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.rapporter_bedoemmelse(uuid, text, text, text) from public, anon;
grant execute on function public.rapporter_bedoemmelse(uuid, text, text, text) to authenticated;

-- Staff skjuler eller viser en bedoemmelse eller et svar. Begrundelse
-- (p_grund fra den faste liste; 'andet' kraever p_aarsag) kraeves ved skjul.
-- Returnerer {"kode": "ok"|"uaendret", "forfatter_id", "auktion_id"} eller
-- ingen_adgang, ikke_fundet, begrundelse_mangler, for_lang_tekst.
-- Ved skjul lukkes aabne rapporter paa den del.
create or replace function public.skjul_bedoemmelse(
  p_medarbejder uuid,
  p_rating      uuid,
  p_del         text,
  p_skjul       boolean,
  p_grund       text,
  p_aarsag      text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_skjul  boolean := coalesce(p_skjul, true);
  v_grund  text := nullif(btrim(coalesce(p_grund, '')), '');
  v_aarsag text := nullif(btrim(coalesce(p_aarsag, '')), '');
  v_navn   text;
  v_maal   uuid;
  v_tekst  text;
  r        record;
  s        record;
begin
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_del is null or p_del not in ('bedoemmelse', 'svar') then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if v_skjul then
    if v_grund is null or v_grund not in
       ('groft_sprog', 'personoplysninger', 'kontaktinfo', 'ikke_relateret', 'andet') then
      return jsonb_build_object('kode', 'begrundelse_mangler');
    end if;
    if v_grund = 'andet' and v_aarsag is null then
      return jsonb_build_object('kode', 'begrundelse_mangler');
    end if;
  else
    v_grund := null;
  end if;
  if v_aarsag is not null and char_length(v_aarsag) > 500 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  select ra.id, ra.fra_bruger_id, ra.auktion_id, ra.kommentar, ra.skjult into r
    from public.ratings ra where ra.id = p_rating for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  if p_del = 'bedoemmelse' then
    if r.skjult = v_skjul then
      return jsonb_build_object('kode', 'uaendret');
    end if;
    update public.ratings set skjult = v_skjul where id = r.id;
    v_maal := r.fra_bruger_id;
    v_tekst := coalesce(r.kommentar, '(kun stjerner)');
  else
    select bs.id, bs.saelger_id, bs.tekst, bs.skjult, bs.slettet_kl into s
      from public.bedoemmelse_svar bs where bs.rating_id = p_rating for update;
    if not found or s.slettet_kl is not null then
      return jsonb_build_object('kode', 'ikke_fundet');
    end if;
    if s.skjult = v_skjul then
      return jsonb_build_object('kode', 'uaendret');
    end if;
    update public.bedoemmelse_svar set skjult = v_skjul where id = s.id;
    v_maal := s.saelger_id;
    v_tekst := s.tekst;
  end if;

  insert into public.bedoemmelse_moderation
    (rating_id, del, skjult, grund, aarsag, medarbejder_id, kl)
  values (p_rating, p_del, v_skjul, v_grund, v_aarsag, p_medarbejder, now())
  on conflict (rating_id, del) do update
    set skjult = excluded.skjult, grund = excluded.grund, aarsag = excluded.aarsag,
        medarbejder_id = excluded.medarbejder_id, kl = excluded.kl;

  v_navn := case v_grund
    when 'groft_sprog'       then 'Grove ord eller chikane'
    when 'personoplysninger' then 'Personoplysninger'
    when 'kontaktinfo'       then 'Kontaktoplysninger'
    when 'ikke_relateret'    then 'Ikke relateret til handlen'
    when 'andet'             then 'Andet'
  end;

  if v_skjul then
    update public.bruger_rapporter
       set status = 'behandlet', handled_by = p_medarbejder, handled_at = now(),
           handled_note = left('Skjult: ' || v_navn || coalesce(' - ' || v_aarsag, ''), 2000)
     where rating_id = p_rating and rating_del = p_del and status = 'ny';
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder,
          case when p_del = 'bedoemmelse'
               then case when v_skjul then 'bedoemmelse_skjult' else 'bedoemmelse_vist' end
               else case when v_skjul then 'bedoemmelse_svar_skjult' else 'bedoemmelse_svar_vist' end end,
          'anmeldelse', p_rating, v_maal,
          left(case when v_skjul then 'Skjulte ' else 'Viste igen ' end
               || case when p_del = 'bedoemmelse' then 'bedømmelse' else 'svar fra sælger' end
               || ': "' || left(v_tekst, 200) || '"'
               || coalesce(' | ' || v_navn, '')
               || coalesce(' | ' || v_aarsag, ''), 4000));

  return jsonb_build_object('kode', 'ok', 'forfatter_id', v_maal, 'auktion_id', r.auktion_id);
end;
$fn$;

revoke all on function public.skjul_bedoemmelse(uuid, uuid, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.skjul_bedoemmelse(uuid, uuid, text, boolean, text, text) to service_role;

-- Staff beholder en rapporteret bedoemmelse (bryder ikke reglerne): alle
-- aabne rapporter paa bedoemmelsen og svaret lukkes. {"kode", "antal"}.
create or replace function public.behold_bedoemmelse(
  p_medarbejder uuid,
  p_rating      uuid,
  p_note        text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_note text := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Bryder ikke reglerne');
  r      record;
  n      integer;
begin
  if p_medarbejder is null or not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(v_note) > 500 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;
  select ra.id, ra.fra_bruger_id, ra.kommentar into r from public.ratings ra where ra.id = p_rating;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  update public.bruger_rapporter
     set status = 'behandlet', handled_by = p_medarbejder, handled_at = now(),
         handled_note = left('Beholdt: ' || v_note, 2000)
   where rating_id = p_rating and status = 'ny';
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('kode', 'uaendret', 'antal', 0);
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder, 'bedoemmelse_beholdt', 'anmeldelse', p_rating, r.fra_bruger_id,
          left('Beholdt bedømmelse (' || n || ' rapport' || case when n = 1 then '' else 'er' end
               || ' lukket): "' || left(coalesce(r.kommentar, '(kun stjerner)'), 200) || '" | '
               || v_note, 4000));

  return jsonb_build_object('kode', 'ok', 'antal', n);
end;
$fn$;

revoke all on function public.behold_bedoemmelse(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.behold_bedoemmelse(uuid, uuid, text) to service_role;

-- ============================================================ 5. moderation_log

-- Fletter: alle vaerdier i den nuvaerende constraint bevares + de nye.
do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'moderation_log_handling_check'
     and c.conrelid = 'public.moderation_log'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array[
      'slet_anmeldelse', 'rapport_behandlet',
      'bedoemmelse_skjult', 'bedoemmelse_vist',
      'bedoemmelse_svar_skjult', 'bedoemmelse_svar_vist',
      'bedoemmelse_beholdt'])
  ) s;

  alter table public.moderation_log drop constraint if exists moderation_log_handling_check;
  execute format(
    'alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))',
    v_vals);
end $$;

-- ============================================================ 6. Notifikationstype 'bedoemmelse'

-- Fletter: de valgfrie typer laeses af den nuvaerende funktion (ogsaa typer
-- tilfoejet af andre migrationer) + 'bedoemmelse'. notifikation_paakraevet
-- er uaendret.
do $do$
declare
  v_src  text;
  v_vals text[];
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = to_regprocedure('public.notifikation_kendt_type(text)');

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x
      from regexp_matches(coalesce(v_src, ''), '''([a-z0-9_]+)''', 'g') as m
    union
    select unnest(array['overbudt', 'bud_paa_egen', 'like', 'fulgt_slutter_snart',
                        'ny_auktion_fulgt_saelger', 'ny_besked', 'spoergsmaal',
                        'bedoemmelse'])
  ) s;

  -- Skrives som array['a', 'b', ...] (samme form som foer), saa senere
  -- fletninger kan laese vaerdierne paa samme maade.
  execute format($f$
    create or replace function public.notifikation_kendt_type(p_type text)
    returns boolean
    language sql immutable set search_path = '' as $b$
      select public.notifikation_paakraevet(p_type) or p_type = any (array[%s]);
    $b$
    $f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) as v));
end $do$;

grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;
