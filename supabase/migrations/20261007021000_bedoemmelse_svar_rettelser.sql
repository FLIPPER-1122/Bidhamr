-- Rettelser til 20261007020000_bedoemmelse_svar.sql efter review (fase 4B).
--
--   1. Inhabilitet: skjul_bedoemmelse og behold_bedoemmelse afviser med
--      {"kode": "inhabil"}, hvis medarbejderen har skrevet eller modtaget
--      bedoemmelsen (fra_bruger_id / til_bruger_id) eller har skrevet svaret.
--      Gaelder ogsaa "vis igen".
--   2. ratings_opdater_gennemsnit tager en advisory lock pr. bruger, foer
--      gennemsnittet regnes ud (to samtidige aendringer kunne ellers skrive et
--      forkert gennemsnit). Laases i fast raekkefoelge (ingen deadlock).
--   3. mine_slettede_bedoemmelse_svar(): saelgeren faar at vide, hvilke af
--      hans bedoemmelser har et svar, han selv har slettet (RLS skjuler
--      slettede svar), saa "Svar offentligt" ikke vises igen.
--   4. Linjeskift bevares i svar: ny bedoemmelse_svar_ryd_tekst (hoejst 2
--      linjeskift i traek). spoergsmaal_ryd_tekst er uaendret. Kontaktinfo og
--      grove ord tjekkes paa teksten med linjeskift som mellemrum, saa et
--      telefonnummer ikke kan deles over flere linjer.
--   5. rapporter_bedoemmelse: advisory lock pr. rapportoer (dobbeltklik og
--      graensen paa 20/doegn), unikt delindeks paa aabne rapporter, og
--      suspenderede/lukkede konti afvises (kode 'suspenderet' / 'konto_lukket',
--      samme regel som public.jeg_er_suspenderet()).
--   6. indeholder_groft_sprog: ordgraenser uden \m/\M (de afhaenger af
--      databasens locale for æ/ø/å) og trusler kun i 1. person, saa fx "det
--      dræber dig ikke at vente" ikke afvises.
--   7. Politikken bedoemmelse_svar_select kvalificerer rating_id.
--
-- Idempotent. Koeres EFTER 20261007020000_bedoemmelse_svar.sql.

-- ============================================================ 6. Grove ord

-- Bevidst kort liste over entydige skaeldsord, slurs og trusler. Hele ord:
-- foer og efter skal staa starten/slutningen eller et tegn, der ikke er et
-- bogstav/tal (eksplicit liste, saa det ikke afhaenger af locale).
create or replace function public.indeholder_groft_sprog(p_tekst text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select public.besked_normaliser(p_tekst) ~ (
    '(^|[^a-z0-9æøåäöüéèáàíóú_])('
    || 'luder|ludder|kælling|kaelling|fisse|fissehoved|pikhoved|røvhul|roevhul'
    || '|kraftidiot|spasser|mongol|perker|neger|bøsserøv|boesseroev'
    || '|fuck dig|fuck you|fuck off|dumme svin|klamme svin|dumme kælling'
    || '|dræb dig selv|slå dig ihjel|jeg slår dig ihjel'
    || '|(jeg|vi) (vil |skal |kommer til at |skal nok )?(dræbe|dræber) dig'
    || '|du skal dø|jeg ved hvor du bor'
    || ')($|[^a-z0-9æøåäöüéèáàíóú_])');
$fn$;

revoke all on function public.indeholder_groft_sprog(text) from public, anon;
grant execute on function public.indeholder_groft_sprog(text) to authenticated, service_role;

-- ============================================================ 4. Tekst med linjeskift

-- Som spoergsmaal_ryd_tekst (fjerner styretegn, usynlige tegn og
-- retningsmaerker), men bevarer linjeskift: \r\n -> \n, mellemrum samles,
-- mellemrum omkring linjeskift fjernes, hoejst 2 linjeskift i traek.
create or replace function public.bedoemmelse_svar_ryd_tekst(p_tekst text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            replace(replace(coalesce(p_tekst, ''), chr(13) || chr(10), chr(10)), chr(13), chr(10)),
            -- Styretegn (ikke tab/linjeskift), bloed bindestreg, nul-bredde-
            -- og retningstegn, BOM.
            '[' || chr(1) || '-' || chr(8) || chr(11) || chr(12) || chr(14) || '-' || chr(31)
                || chr(127) || chr(173) || chr(8203) || '-' || chr(8207)
                || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8303)
                || chr(65279) || ']',
            '', 'g'),
          -- Vandrette mellemrum (tab, haarde mellemrum mv.) -> ét mellemrum.
          '[' || chr(9) || ' ' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
              || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || ']+',
          ' ', 'g'),
        ' ?' || chr(10) || ' ?', chr(10), 'g'),
      chr(10) || '{3,}', chr(10) || chr(10), 'g'),
    ' ' || chr(10));
$fn$;

revoke all on function public.bedoemmelse_svar_ryd_tekst(text) from public, anon;
grant execute on function public.bedoemmelse_svar_ryd_tekst(text) to authenticated, service_role;

create or replace function public.skriv_bedoemmelse_svar(p_rating uuid, p_tekst text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_tekst text := public.bedoemmelse_svar_ryd_tekst(p_tekst);
  v_linje text;
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
  -- Filtrene ser teksten paa én linje, saa intet kan deles over linjeskift.
  v_linje := replace(v_tekst, chr(10), ' ');
  if public.indeholder_kontaktinfo(v_tekst) or public.indeholder_kontaktinfo(v_linje) then
    return jsonb_build_object('kode', 'kontaktinfo');
  end if;
  if public.indeholder_groft_sprog(v_linje) then
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

-- ============================================================ 7. RLS paa svar

drop policy if exists bedoemmelse_svar_select on public.bedoemmelse_svar;
create policy bedoemmelse_svar_select on public.bedoemmelse_svar
  for select to anon, authenticated
  using (
    slettet_kl is null
    and (not skjult or saelger_id = (select auth.uid()))
    and exists (select 1 from public.ratings r where r.id = bedoemmelse_svar.rating_id)
  );

-- ============================================================ 3. Slettede svar (kun egne)

-- Rating-id'er, hvor den indloggede saelger selv har slettet sit svar. Kun
-- id'erne - aldrig teksten.
-- (drop: returtypen kan ikke aendres med create or replace.)
drop function if exists public.mine_slettede_bedoemmelse_svar();
create function public.mine_slettede_bedoemmelse_svar()
returns table (rating_id uuid)
language sql
stable
security definer
set search_path = ''
as $fn$
  select bs.rating_id
    from public.bedoemmelse_svar bs
   where bs.saelger_id = auth.uid()
     and bs.slettet_kl is not null;
$fn$;

revoke all on function public.mine_slettede_bedoemmelse_svar() from public, anon;
grant execute on function public.mine_slettede_bedoemmelse_svar() to authenticated;

-- ============================================================ 2. Gennemsnit med laas

create or replace function public.ratings_opdater_gennemsnit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_bruger uuid;
begin
  -- Sorteret og uden dubletter, saa to transaktioner altid laaser i samme
  -- raekkefoelge.
  for v_bruger in
    select distinct b
      from unnest(array[
             case when tg_op <> 'INSERT' then old.til_bruger_id end,
             case when tg_op <> 'DELETE' then new.til_bruger_id end]) as b
     where b is not null
     order by b
  loop
    perform pg_advisory_xact_lock(hashtextextended('ratings_gennemsnit:' || v_bruger::text, 0));
    update public.users u
       set rating = g.snit
      from (select coalesce(round(avg(r.stjerner)::numeric, 2), 0) as snit
              from public.ratings r
             where r.til_bruger_id = v_bruger and not r.skjult) g
     where u.id = v_bruger
       and u.rating is distinct from g.snit;
  end loop;
  return null;
end;
$fn$;

revoke all on function public.ratings_opdater_gennemsnit() from public, anon, authenticated;

-- ============================================================ 5. Rapporter

-- Højst én aaben rapport pr. bruger, bedoemmelse og del. Oprettes kun, hvis
-- der ikke allerede ligger dubletter (rapporter slettes aldrig; i saa fald
-- beskytter laasen i rapporter_bedoemmelse stadig nye rapporter).
do $$
begin
  if not exists (
    select 1 from public.bruger_rapporter
     where rating_id is not null and status = 'ny'
     group by reporter_id, rating_id, rating_del
    having count(*) > 1) then
    create unique index if not exists bruger_rapporter_rating_aaben_uniq
      on public.bruger_rapporter (reporter_id, rating_id, rating_del)
      where rating_id is not null and status = 'ny';
  else
    raise notice 'bruger_rapporter_rating_aaben_uniq ikke oprettet: der findes dublerede aabne rapporter.';
  end if;
end $$;

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
  u       record;
  r       record;
  s       record;
  n       integer;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  select uu.konto_lukket_kl into u from public.users uu where uu.id = v_uid;
  if not found then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'konto_lukket');
  end if;
  if public.jeg_er_suspenderet() then
    return jsonb_build_object('kode', 'suspenderet');
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

  -- Én rapport ad gangen pr. bruger: dobbeltklik giver ikke to rapporter, og
  -- graensen paa 20 pr. doegn kan ikke overskrides med samtidige kald.
  perform pg_advisory_xact_lock(hashtextextended('rapporter_bedoemmelse:' || v_uid::text, 0));

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

  begin
    insert into public.bruger_rapporter
      (kilde, reporter_id, reported_id, trade_id, rating_id, rating_del, category, description)
    values ('bruger', v_uid, v_maal, r.trade_id, p_rating, p_del, p_kategori, v_beskr);
  exception when unique_violation then
    return jsonb_build_object('kode', 'findes');
  end;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke all on function public.rapporter_bedoemmelse(uuid, text, text, text) from public, anon;
grant execute on function public.rapporter_bedoemmelse(uuid, text, text, text) to authenticated;

-- ============================================================ 1. Inhabilitet

-- Er medarbejderen part i bedoemmelsen (skrev den, modtog den eller skrev
-- svaret)? Intern hjaelper.
create or replace function public.bedoemmelse_er_inhabil(p_medarbejder uuid, p_rating uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
           select 1 from public.ratings ra
            where ra.id = p_rating
              and p_medarbejder in (ra.fra_bruger_id, ra.til_bruger_id))
      or exists (
           select 1 from public.bedoemmelse_svar bs
            where bs.rating_id = p_rating and bs.saelger_id = p_medarbejder);
$fn$;

revoke all on function public.bedoemmelse_er_inhabil(uuid, uuid) from public, anon, authenticated;
grant execute on function public.bedoemmelse_er_inhabil(uuid, uuid) to service_role;

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

  select ra.id, ra.fra_bruger_id, ra.til_bruger_id, ra.auktion_id, ra.kommentar, ra.skjult into r
    from public.ratings ra where ra.id = p_rating for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  -- Ingen behandler en bedoemmelse, de selv er part i - heller ikke "vis igen".
  if public.bedoemmelse_er_inhabil(p_medarbejder, p_rating) then
    return jsonb_build_object('kode', 'inhabil');
  end if;

  if p_del = 'bedoemmelse' then
    if r.skjult = v_skjul then
      return jsonb_build_object('kode', 'uaendret');
    end if;
    update public.ratings set skjult = v_skjul where id = r.id and skjult = not v_skjul;
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
    update public.bedoemmelse_svar set skjult = v_skjul where id = s.id and skjult = not v_skjul;
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
  if public.bedoemmelse_er_inhabil(p_medarbejder, p_rating) then
    return jsonb_build_object('kode', 'inhabil');
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
