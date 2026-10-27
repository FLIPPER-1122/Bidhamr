-- =============================================================================
-- Skift af e-mail - rettelser efter review (27. okt. 2026). Bygger på
-- 20261102120000_skift_email.sql, som SKAL være kørt først (md5-drifttjek
-- nedenfor).
--
-- 1. En anmodning kan ikke længere sidde fast i 'bekraeftet' (koden passede,
--    men serveren døde/fejlede, før Supabase Auth svarede): email_skift_anmod
--    sætter 'bekraeftet' ældre end 5 minutter til 'fejl', så brugeren kan bede
--    om en ny kode. Ny kolonne bekraeftet_kl (sættes af email_skift_tjek).
--    Er en anmodning bekræftet for under 5 minutter siden (auth opdateres
--    netop nu), svarer anmod 'igang' (serveren: "Prøv igen om lidt").
-- 2. Gamle links og koder til den gamle adresse dør ved skiftet: en BEFORE
--    UPDATE OF email-trigger på auth.users (auth_users_email_ryd_tokens)
--    nulstiller recovery_token, confirmation_token, reauthentication_token,
--    email_change_token_new/_current og email_change i new og sletter
--    brugerens rækker i auth.one_time_tokens. Gælder alle e-mail-ændringer
--    (brugerens skift, chefens i dashboardet, kontosletningens pladsholder).
--    Felterne sættes til '' og ikke null (GoTrue kan ikke læse null i dem).
--    Sessioner og refresh tokens røres ikke - brugeren forbliver logget ind.
-- 3. Firmakonti (konto_type 'erhverv') kan ikke selv skifte e-mail:
--    email_skift_konto_spaerret svarer 'firma' (firmaoplysninger rettes hos
--    BidHamr, ROADMAP-BESLUTNINGER.md "Skift af e-mail").
-- 4. Engangsoprydning: åbne e-mail-skift fra Supabase' eget flow
--    (email_change + email_change_token_*) ryddes på alle brugere, så et
--    gammelt bekræftelseslink ikke kan bruges.
--
-- Ingen set local lock_timeout: filen kører som én transaktion i
-- migrationsværktøjet uden egen begin;/commit;.
-- Kan køres flere gange (add column if not exists, create or replace, drop
-- trigger if exists, md5-drifttjek). Køres først på testdatabasen
-- (pjiigmzqwlfepxnjdvug). Produktion kræver Filips "ja".
-- =============================================================================

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- p_ok: de md5-værdier, der godtages. p_maa_mangle: funktionen må mangle
-- (første kørsel).
create or replace function pg_temp.drift_tjek(p_fn text, p_maa_mangle boolean, variadic p_ok text[])
returns void language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    if p_maa_mangle then return; end if;
    raise exception '%: findes ikke - kør 20261102120000_skift_email.sql først', p_fn;
  end if;
  if not (h = any (p_ok)) then
    raise exception '%: md5 % er ingen af de forventede (%) - kontrollér funktionen, før migrationen køres',
      p_fn, h, array_to_string(p_ok, ', ');
  end if;
end $f$;

-- ---------------------------------------------------------------------------
-- 0. Drift-tjek - før noget ændres
-- ---------------------------------------------------------------------------

select pg_temp.drift_tjek('public.staff_to_trin_er_staff_rolle(text)', false, '793d61263de2bba2e3a36df8f43a0e43');

-- Uændrede fra 20261102120000 (skal findes).
select pg_temp.drift_tjek('public.email_skift_afslut(uuid,text)', false, '6cd8a27a9352f9ea4c3a240235afae20');
select pg_temp.drift_tjek('public.auth_users_email_skift_vaern()', false, '2e1df7975fae66807ec4ab59b09958a7');
select pg_temp.drift_tjek('public.auth_users_email_spejl()', false, '78bb6ea71c8392bc99e7779da24962b7');
select pg_temp.drift_tjek('public.users_email_skift_ved_sletning()', false, '85e531a5dd9a208f6e1f549914976622');

-- Ændres her: som efter 20261102120000 eller som efter denne.
select pg_temp.drift_tjek('public.email_skift_konto_spaerret(uuid)', false, 'ea804c6aff35e2f6c8a95eaca2944af4', 'c48ba19810858843b32d351a19a8115f');
select pg_temp.drift_tjek('public.email_skift_anmod(uuid,text,text)', false, 'd09e6f7b4a50c22f80f119291588eb82', 'f5b7856d6adc8976d94964e5fd2fb01c');
select pg_temp.drift_tjek('public.email_skift_tjek(uuid,text)', false, '40dab15a7a19bea6d3600daad77bc824', 'ca71c5a322a133e6e07b8eab33dffc68');

-- Ny her: mangler (første kørsel) eller som efter denne.
select pg_temp.drift_tjek('public.auth_users_email_ryd_tokens()', true, '25e6e69d941ba2c6a66ca4e98f0d6520');

-- Ukendte triggere på auth.users: gennemgå dem først.
do $$
declare
  v_ukendte text;
begin
  select string_agg(t.tgname, ', ') into v_ukendte
    from pg_trigger t
   where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
     and t.tgname not in ('on_auth_user_created', 'auth_users_email_skift_vaern', 'auth_users_email_spejl',
                          'auth_users_email_ryd_tokens');
  if v_ukendte is not null then
    raise exception 'Ukendte triggere på auth.users (%). Gennemgå dem, før migrationen køres.', v_ukendte;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tabellen: hvornår koden blev godkendt
-- ---------------------------------------------------------------------------

alter table public.email_skift add column if not exists bekraeftet_kl timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Funktionerne (KUN service_role - grants fra 20261102120000 består, da
--    signaturerne er uændrede; gentages for en sikkerheds skyld)
-- ---------------------------------------------------------------------------

-- Må kontoen skifte e-mail? null = ja, ellers koden: 'ukendt', 'slettet',
-- 'lukket', 'suspenderet', 'staff', 'firma'. Staff og systembrugeren
-- kontakter chefen; firmakonti kontakter BidHamr.
create or replace function public.email_skift_konto_spaerret(p_bruger uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_u record;
begin
  select u.rolle, u.konto_type, u.suspenderet, u.suspenderet_til, u.konto_lukket_kl, u.konto_slettet_kl
    into v_u
    from public.users u where u.id = p_bruger;
  if not found then return 'ukendt'; end if;
  if v_u.konto_slettet_kl is not null then return 'slettet'; end if;
  if v_u.konto_lukket_kl is not null then return 'lukket'; end if;
  if coalesce(v_u.suspenderet, false) and (v_u.suspenderet_til is null or v_u.suspenderet_til > now()) then
    return 'suspenderet';
  end if;
  if public.staff_to_trin_er_staff_rolle(v_u.rolle)
     or p_bruger = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    return 'staff';
  end if;
  if v_u.konto_type = 'erhverv' then
    return 'firma';
  end if;
  return null;
end
$fn$;

-- Ny anmodning. Svar: { kode: 'ok', optaget } | { kode: 'ugyldig' | 'samme'
-- | 'igang' | 'ukendt' | 'slettet' | 'lukket' | 'suspenderet' | 'staff' |
-- 'firma' }. En tidligere åben anmodning erstattes; en anmodning, der har
-- siddet i 'bekraeftet' i over 5 minutter, sættes til 'fejl'.
create or replace function public.email_skift_anmod(p_bruger uuid, p_ny text, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ny text := lower(btrim(coalesce(p_ny, '')));
  v_gammel text;
  v_spaerret text;
  v_optaget boolean;
begin
  if p_bruger is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
     or v_ny !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or char_length(v_ny) > 320
     or v_ny like '%.invalid' then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  -- Låser brugerens række, så to samtidige anmodninger ikke krydser.
  perform 1 from public.users u where u.id = p_bruger for update;
  v_spaerret := public.email_skift_konto_spaerret(p_bruger);
  if v_spaerret is not null then
    return jsonb_build_object('kode', v_spaerret);
  end if;

  select lower(a.email) into v_gammel from auth.users a where a.id = p_bruger;
  if v_gammel is null then
    return jsonb_build_object('kode', 'ukendt');
  end if;
  if v_gammel = v_ny then
    return jsonb_build_object('kode', 'samme');
  end if;

  -- Fast i 'bekraeftet' (serveren nåede aldrig at afslutte): 'fejl'.
  update public.email_skift s
     set status = 'fejl', kode_hash = null
   where s.bruger_id = p_bruger and s.status = 'bekraeftet'
     and coalesce(s.bekraeftet_kl, s.oprettet_kl) < now() - interval '5 minutes';
  -- Netop bekræftet: Supabase Auth opdateres lige nu.
  if exists (select 1 from public.email_skift s where s.bruger_id = p_bruger and s.status = 'bekraeftet') then
    return jsonb_build_object('kode', 'igang');
  end if;

  v_optaget := exists (select 1 from auth.users a where lower(a.email) = v_ny and a.id <> p_bruger)
            or exists (select 1 from public.users u where lower(u.email) = v_ny and u.id <> p_bruger);

  update public.email_skift s
     set status = 'erstattet', kode_hash = null
   where s.bruger_id = p_bruger and s.status = 'afventer';

  insert into public.email_skift (bruger_id, gammel_email, ny_email, kode_hash, optaget, status, kilde, udloeber_kl)
  values (p_bruger, v_gammel, v_ny, case when v_optaget then null else p_hash end, v_optaget,
          'afventer', 'bruger', now() + interval '15 minutes');

  return jsonb_build_object('kode', 'ok', 'optaget', v_optaget);
end
$fn$;

-- Tjek af koden (som i 20261102120000, men bekraeftet_kl sættes).
create or replace function public.email_skift_tjek(p_bruger uuid, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_s public.email_skift%rowtype;
  v_spaerret text;
  v_nu_email text;
begin
  if p_bruger is null then
    return jsonb_build_object('kode', 'ingen');
  end if;
  select * into v_s from public.email_skift s
   where s.bruger_id = p_bruger and s.status = 'afventer'
   order by s.oprettet_kl desc limit 1
   for update;
  if not found then
    return jsonb_build_object('kode', 'ingen');
  end if;

  v_spaerret := public.email_skift_konto_spaerret(p_bruger);
  if v_spaerret is not null then
    update public.email_skift s set status = 'udloebet', kode_hash = null where s.id = v_s.id;
    return jsonb_build_object('kode', v_spaerret);
  end if;

  if v_s.udloeber_kl is null or v_s.udloeber_kl <= now() then
    update public.email_skift s set status = 'udloebet', kode_hash = null where s.id = v_s.id;
    return jsonb_build_object('kode', 'udloebet');
  end if;

  if v_s.forsoeg >= 5 then
    update public.email_skift s set status = 'for_mange', kode_hash = null where s.id = v_s.id;
    return jsonb_build_object('kode', 'for_mange');
  end if;

  if v_s.kode_hash is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or v_s.kode_hash <> p_hash then
    update public.email_skift s
       set forsoeg = s.forsoeg + 1,
           status = case when s.forsoeg + 1 >= 5 then 'for_mange' else s.status end,
           kode_hash = case when s.forsoeg + 1 >= 5 then null else s.kode_hash end
     where s.id = v_s.id;
    return jsonb_build_object('kode', case when v_s.forsoeg + 1 >= 5 then 'for_mange' else 'forkert' end);
  end if;

  -- Login-adressen er ændret siden anmodningen (fx af chefen): ugyldig.
  select lower(a.email) into v_nu_email from auth.users a where a.id = p_bruger;
  if v_nu_email is distinct from v_s.gammel_email then
    update public.email_skift s set status = 'udloebet', kode_hash = null where s.id = v_s.id;
    return jsonb_build_object('kode', 'udloebet');
  end if;

  -- Adressen er taget, siden koden blev sendt.
  if exists (select 1 from auth.users a where lower(a.email) = v_s.ny_email and a.id <> p_bruger)
     or exists (select 1 from public.users u where lower(u.email) = v_s.ny_email and u.id <> p_bruger) then
    update public.email_skift s set status = 'optaget', kode_hash = null where s.id = v_s.id;
    return jsonb_build_object('kode', 'optaget');
  end if;

  update public.email_skift s
     set status = 'bekraeftet', kode_hash = null, forsoeg = s.forsoeg + 1, bekraeftet_kl = now()
   where s.id = v_s.id and s.status = 'afventer';
  if not found then
    return jsonb_build_object('kode', 'ingen');
  end if;
  return jsonb_build_object('kode', 'ok', 'id', v_s.id, 'ny_email', v_s.ny_email, 'gammel_email', v_s.gammel_email);
end
$fn$;

revoke execute on function public.email_skift_konto_spaerret(uuid) from public, anon, authenticated;
revoke execute on function public.email_skift_anmod(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.email_skift_tjek(uuid, text) from public, anon, authenticated;
grant execute on function public.email_skift_konto_spaerret(uuid) to service_role;
grant execute on function public.email_skift_anmod(uuid, text, text) to service_role;
grant execute on function public.email_skift_tjek(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Gamle links og koder dør, når login-adressen skifter
-- ---------------------------------------------------------------------------

-- BEFORE UPDATE OF email: felterne nulstilles i new (samme række, samme
-- transaktion som GoTrues opdatering), og brugerens engangskoder i
-- auth.one_time_tokens slettes. En "Glemt adgangskode"-mail til den gamle
-- adresse, et bekræftelseslink eller en kode til genbekræftelse virker
-- derfor ikke længere. "Glemt adgangskode" til den nye adresse laver en ny
-- token bagefter og virker som normalt.
create or replace function public.auth_users_email_ryd_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  new.recovery_token := '';
  new.confirmation_token := '';
  new.reauthentication_token := '';
  new.email_change_token_new := '';
  new.email_change_token_current := '';
  new.email_change := '';
  new.email_change_confirm_status := 0;
  delete from auth.one_time_tokens t where t.user_id = new.id;
  return new;
end
$fn$;

revoke execute on function public.auth_users_email_ryd_tokens() from public, anon, authenticated;

drop trigger if exists auth_users_email_ryd_tokens on auth.users;
create trigger auth_users_email_ryd_tokens
  before update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.auth_users_email_ryd_tokens();

-- ---------------------------------------------------------------------------
-- 4. Engangsoprydning: åbne skift fra Supabase' eget flow
-- ---------------------------------------------------------------------------

-- Værnet (auth_users_email_skift_vaern) tillader at rydde email_change ('').
update auth.users a
   set email_change = '', email_change_token_new = '', email_change_token_current = '',
       email_change_confirm_status = 0, email_change_sent_at = null
 where coalesce(a.email_change, '') <> ''
    or coalesce(a.email_change_token_new, '') <> ''
    or coalesce(a.email_change_token_current, '') <> '';

delete from auth.one_time_tokens t
 where t.token_type in ('email_change_token_new', 'email_change_token_current');

-- ---------------------------------------------------------------------------
-- Efter-tjek: kroppene er dem, migrationen forventer.
-- ---------------------------------------------------------------------------
select pg_temp.drift_tjek('public.email_skift_konto_spaerret(uuid)', false, 'c48ba19810858843b32d351a19a8115f');
select pg_temp.drift_tjek('public.email_skift_anmod(uuid,text,text)', false, 'f5b7856d6adc8976d94964e5fd2fb01c');
select pg_temp.drift_tjek('public.email_skift_tjek(uuid,text)', false, 'ca71c5a322a133e6e07b8eab33dffc68');
select pg_temp.drift_tjek('public.auth_users_email_ryd_tokens()', false, '25e6e69d941ba2c6a66ca4e98f0d6520');
select pg_temp.drift_tjek('public.email_skift_afslut(uuid,text)', false, '6cd8a27a9352f9ea4c3a240235afae20');
select pg_temp.drift_tjek('public.auth_users_email_spejl()', false, '78bb6ea71c8392bc99e7779da24962b7');

drop function pg_temp.drift_tjek(text, boolean, text[]);
drop function pg_temp.krop_md5(text);
