-- =============================================================================
-- Skift af e-mail (Filip, 27. okt. 2026 - ROADMAP-BESLUTNINGER.md, "Skift af
-- e-mail"). Brugeren skifter selv e-mail under Indstillinger / i appen.
--
-- Flowet (src/lib/emailSkift.ts - hjemmesiden og appen bruger samme kode):
--   1. Ny e-mail + nuværende adgangskode. Serveren tjekker adgangskoden
--      (bekraeftAdgangskode, rate limits) og kalder email_skift_anmod. Er
--      adressen ledig, sendes en kode på 6 cifre til den NYE adresse (Resend).
--      Er den i brug, sendes intet - men svaret er det samme ("Vi har sendt
--      en kode til den nye adresse, hvis den kan bruges"), og et kodeforsøg
--      giver bare "forkert kode". Kun hashen af koden gemmes.
--   2. Koden (email_skift_tjek): højst 5 forsøg, gælder 15 minutter, kan kun
--      bruges én gang. Så sætter serveren den nye e-mail med Supabase'
--      admin-API (updateUserById, email_confirm) - først NU skifter login-
--      adressen. Andre sessioner logges ud, den gamle adresse får mailen
--      "Din e-mail er ændret til ...".
--
-- Denne migration:
--   1. public.email_skift: anmodninger og log over alle skift (også skift,
--      der er sket uden for flowet, fx i Supabase-dashboardet: kilde
--      'udenfor'). Kun service_role. E-mailadresserne fjernes, når kontoen
--      slettes (GDPR) - rækkerne (tidspunkt, status) bliver.
--   2. email_skift_anmod / email_skift_tjek / email_skift_afslut - KUN
--      service_role (serveren kalder dem med brugerens id fra en verificeret
--      session). Spærrer staff-konti (staff_to_trin_er_staff_rolle - de skal
--      kontakte chefen), systembrugeren, suspenderede, lukkede og slettede
--      konti.
--   3. Spejling i databasen, i SAMME transaktion som Supabase Auth' ændring
--      (trigger på auth.users, after update of email): public.users.email,
--      firmaets kontakt_email (kun hvis den var login-adressen - så tæller
--      firmaer_stripe_kunde_aendret versionen op, og firmaets Stripe-kunde
--      synkroniseres af cron'en) og loggen. Fejler spejlingen, afviser
--      Supabase Auth hele ændringen, så auth og public.users aldrig er ude af
--      trit. Slettede konti og pladsholder-adresser (@slettet.invalid)
--      springes over (kontosletningen sletter selv).
--   4. Værn: Supabase' eget e-mail-skift (supabase.auth.updateUser({ email })
--      direkte med anon-nøglen og en session, eller generateLink
--      email_change_*) afvises altid af databasen (trigger på auth.users,
--      before update of email_change). Ellers kunne en, der har fået fat i en
--      session (fx en glemt, åben browser), skifte e-mail uden adgangskoden og
--      derefter overtage kontoen med "Glemt adgangskode". Admin-API'et
--      (updateUserById) sætter e-mailen direkte og rammes ikke af værnet.
--
-- Dinero-kontakten og DAC7 behøver intet her: Dinero-kontakten bygges ud fra
-- users.email ved næste faktura (hash-sammenligning i src/lib/faktura/koe.ts),
-- og DAC7 gemmer ingen e-mail. Den private Stripe-kunde og Connect-kontoen
-- opdateres af serveren efter skiftet (src/lib/emailSkift.ts).
--
-- Ingen eksisterende funktioner eller grants ændres; main-koden uden
-- e-mail-skift virker uændret. Kan køres flere gange (create ... if not
-- exists, create or replace, drop trigger if exists, md5-drifttjek).
-- md5 = normaliseret krop (som 20261102110000). Køres først på testdatabasen
-- (pjiigmzqwlfepxnjdvug). Produktion kræver Filips "ja".
-- =============================================================================

set local lock_timeout = '5s';

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
    raise exception '%: findes ikke - kontrollér databasen, før migrationen køres', p_fn;
  end if;
  if not (h = any (p_ok)) then
    raise exception '%: md5 % er ingen af de forventede (%) - kontrollér funktionen, før migrationen køres',
      p_fn, h, array_to_string(p_ok, ', ');
  end if;
end $f$;

-- ---------------------------------------------------------------------------
-- 0. Drift-tjek - før noget ændres
-- ---------------------------------------------------------------------------

-- Afhængigheder, som skal være uændrede.
select pg_temp.drift_tjek('public.staff_to_trin_er_staff_rolle(text)', false, '793d61263de2bba2e3a36df8f43a0e43');

-- Denne migrations egne funktioner: mangler (første kørsel) eller som efter denne.
select pg_temp.drift_tjek('public.email_skift_anmod(uuid,text,text)', true, 'd09e6f7b4a50c22f80f119291588eb82');
-- email_skift_tjek: første udgave (kun kørt på testdatabasen 27. okt. 2026, uden
-- tjek af optaget adresse ved koden) eller som efter denne.
select pg_temp.drift_tjek('public.email_skift_tjek(uuid,text)', true, 'f9b6116bf56fd568fd953ce296119a6d', '40dab15a7a19bea6d3600daad77bc824');
select pg_temp.drift_tjek('public.email_skift_afslut(uuid,text)', true, '6cd8a27a9352f9ea4c3a240235afae20');
select pg_temp.drift_tjek('public.email_skift_konto_spaerret(uuid)', true, 'ea804c6aff35e2f6c8a95eaca2944af4');
select pg_temp.drift_tjek('public.auth_users_email_skift_vaern()', true, '2e1df7975fae66807ec4ab59b09958a7');
select pg_temp.drift_tjek('public.auth_users_email_spejl()', true, '78bb6ea71c8392bc99e7779da24962b7');
select pg_temp.drift_tjek('public.users_email_skift_ved_sletning()', true, '85e531a5dd9a208f6e1f549914976622');

-- Ukendte triggere på auth.users: gennemgå dem først (de kunne ændre e-mail
-- uden om spejlingen).
do $$
declare
  v_ukendte text;
begin
  select string_agg(t.tgname, ', ') into v_ukendte
    from pg_trigger t
   where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
     and t.tgname not in ('on_auth_user_created', 'auth_users_email_skift_vaern', 'auth_users_email_spejl');
  if v_ukendte is not null then
    raise exception 'Ukendte triggere på auth.users (%). Gennemgå dem, før migrationen køres.', v_ukendte;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tabellen: anmodninger og log
-- ---------------------------------------------------------------------------

create table if not exists public.email_skift (
  id             uuid primary key default gen_random_uuid(),
  bruger_id      uuid not null references public.users(id) on delete restrict,
  -- Adresserne (små bogstaver). null, når kontoen er slettet.
  gammel_email   text check (gammel_email is null or char_length(gammel_email) <= 320),
  ny_email       text check (ny_email is null or char_length(ny_email) <= 320),
  -- sha256 af koden (src/lib/emailSkift.ts, hashEmailKode). null = ingen
  -- gyldig kode (adressen var i brug, koden er brugt eller ugyldiggjort).
  kode_hash      text check (kode_hash is null or kode_hash ~ '^[0-9a-f]{64}$'),
  -- Adressen var i brug ved anmodningen: ingen kode er sendt, og ingen kode
  -- passer. Svaret til brugeren var det samme som ellers.
  optaget        boolean not null default false,
  forsoeg        integer not null default 0 check (forsoeg between 0 and 100),
  -- afventer: kode sendt (eller optaget), bekraeftet: koden passede, auth
  -- opdateres nu, gennemfoert: skiftet er sket, erstattet: en nyere anmodning,
  -- udloebet, for_mange (5 forkerte), optaget (adressen blev taget, før
  -- koden blev brugt), fejl (Supabase Auth fejlede - brugeren beder om en ny).
  status         text not null check (status in
                   ('afventer', 'bekraeftet', 'gennemfoert', 'erstattet', 'udloebet', 'for_mange', 'optaget', 'fejl')),
  -- bruger: brugerens eget skift. udenfor: e-mailen er ændret uden for
  -- flowet (Supabase-dashboardet, admin-API'et).
  kilde          text not null default 'bruger' check (kilde in ('bruger', 'udenfor')),
  oprettet_kl    timestamptz not null default now(),
  udloeber_kl    timestamptz,
  gennemfoert_kl timestamptz
);

create index if not exists email_skift_bruger_idx on public.email_skift (bruger_id, oprettet_kl desc);
-- Højst én åben anmodning pr. bruger.
create unique index if not exists email_skift_en_aaben_idx
  on public.email_skift (bruger_id) where status in ('afventer', 'bekraeftet');

-- Kun service_role (ingen policies).
alter table public.email_skift enable row level security;
revoke all on table public.email_skift from public, anon, authenticated;
grant select, insert, update on table public.email_skift to service_role;

-- ---------------------------------------------------------------------------
-- 2. Funktioner til serveren (KUN service_role)
-- ---------------------------------------------------------------------------

-- Må kontoen skifte e-mail? null = ja, ellers koden: 'ukendt', 'slettet',
-- 'lukket', 'suspenderet', 'staff'. Staff (medarbejder, admin, chef,
-- erhvervssælger) og systembrugeren skifter aldrig selv - de kontakter
-- chefen, som skifter i Supabase-dashboardet.
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
  select u.rolle, u.suspenderet, u.suspenderet_til, u.konto_lukket_kl, u.konto_slettet_kl
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
  return null;
end
$fn$;

-- Ny anmodning. p_hash: hashen af koden, serveren sender (hvis adressen er
-- ledig). Svar: { kode: 'ok', optaget } | { kode: 'ugyldig' | 'samme' |
-- 'ukendt' | 'slettet' | 'lukket' | 'suspenderet' | 'staff' }.
-- En tidligere åben anmodning erstattes (dens kode virker ikke længere).
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

-- Tjek af koden. Svar: { kode: 'ok', id, ny_email, gammel_email } |
-- { kode: 'forkert' | 'for_mange' | 'udloebet' | 'ingen' | 'optaget' | spærrekoderne }.
-- Højst 5 forsøg pr. anmodning; en rigtig kode kan kun bruges én gang
-- (status 'afventer' -> 'bekraeftet' i samme update).
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

  -- Adressen er taget, siden koden blev sendt. Må gerne siges nu: den, der
  -- har koden, har adgang til adressen.
  if exists (select 1 from auth.users a where lower(a.email) = v_s.ny_email and a.id <> p_bruger)
     or exists (select 1 from public.users u where lower(u.email) = v_s.ny_email and u.id <> p_bruger) then
    update public.email_skift s set status = 'optaget', kode_hash = null where s.id = v_s.id;
    return jsonb_build_object('kode', 'optaget');
  end if;

  update public.email_skift s
     set status = 'bekraeftet', kode_hash = null, forsoeg = s.forsoeg + 1
   where s.id = v_s.id and s.status = 'afventer';
  if not found then
    return jsonb_build_object('kode', 'ingen');
  end if;
  return jsonb_build_object('kode', 'ok', 'id', v_s.id, 'ny_email', v_s.ny_email, 'gammel_email', v_s.gammel_email);
end
$fn$;

-- Supabase Auth afviste skiftet efter en rigtig kode: 'optaget' (adressen
-- blev taget i mellemtiden) eller 'fejl'. Kun fra 'bekraeftet' (idempotent).
create or replace function public.email_skift_afslut(p_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_status not in ('optaget', 'fejl') then
    return false;
  end if;
  update public.email_skift s set status = p_status where s.id = p_id and s.status = 'bekraeftet';
  return found;
end
$fn$;

revoke execute on function public.email_skift_konto_spaerret(uuid) from public, anon, authenticated;
revoke execute on function public.email_skift_anmod(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.email_skift_tjek(uuid, text) from public, anon, authenticated;
revoke execute on function public.email_skift_afslut(uuid, text) from public, anon, authenticated;
grant execute on function public.email_skift_konto_spaerret(uuid) to service_role;
grant execute on function public.email_skift_anmod(uuid, text, text) to service_role;
grant execute on function public.email_skift_tjek(uuid, text) to service_role;
grant execute on function public.email_skift_afslut(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Spejling: auth.users.email -> public.users, firmaer, log
-- ---------------------------------------------------------------------------

create or replace function public.auth_users_email_spejl()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_ny text := lower(new.email);
  v_gammel text := lower(old.email);
begin
  if v_ny is null or v_ny = '' or v_ny like '%@slettet.invalid' then
    return new;
  end if;
  -- Slettede konti (og konti uden profil) springes over - kontosletningen
  -- sætter selv pladsholderne (konto_slet).
  if not exists (select 1 from public.users u where u.id = new.id and u.konto_slettet_kl is null) then
    return new;
  end if;

  update public.users u set email = v_ny where u.id = new.id and u.email is distinct from v_ny;

  -- Firmaets kontakt-e-mail følger kun med, hvis den var login-adressen.
  update public.firmaer f set kontakt_email = v_ny
   where f.bruger_id = new.id and lower(f.kontakt_email) = v_gammel;

  update public.email_skift s
     set status = 'gennemfoert', gennemfoert_kl = now(), kode_hash = null
   where s.bruger_id = new.id and s.status = 'bekraeftet' and s.ny_email = v_ny;
  if not found then
    -- Ændret uden for flowet (dashboardet/admin-API'et): logges også.
    insert into public.email_skift (bruger_id, gammel_email, ny_email, status, kilde, gennemfoert_kl)
    values (new.id, v_gammel, v_ny, 'gennemfoert', 'udenfor', now());
  end if;
  -- En åben anmodning til en anden adresse gælder ikke længere.
  update public.email_skift s set status = 'erstattet', kode_hash = null
   where s.bruger_id = new.id and s.status in ('afventer', 'bekraeftet');
  return new;
end
$fn$;

revoke execute on function public.auth_users_email_spejl() from public, anon, authenticated;

drop trigger if exists auth_users_email_spejl on auth.users;
create trigger auth_users_email_spejl
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function public.auth_users_email_spejl();

-- ---------------------------------------------------------------------------
-- 4. Værn: Supabase' eget e-mail-skift (email_change) afvises
-- ---------------------------------------------------------------------------

create or replace function public.auth_users_email_skift_vaern()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  raise exception 'E-mail skiftes kun via BidHamrs server (bidhamr.dk).'
    using errcode = '42501';
end
$fn$;

revoke execute on function public.auth_users_email_skift_vaern() from public, anon, authenticated;

drop trigger if exists auth_users_email_skift_vaern on auth.users;
create trigger auth_users_email_skift_vaern
  before update of email_change on auth.users
  for each row
  when (new.email_change is distinct from old.email_change and coalesce(new.email_change, '') <> '')
  execute function public.auth_users_email_skift_vaern();

-- ---------------------------------------------------------------------------
-- 5. GDPR: adresserne i loggen fjernes, når kontoen slettes
-- ---------------------------------------------------------------------------

create or replace function public.users_email_skift_ved_sletning()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  update public.email_skift s
     set gammel_email = null, ny_email = null, kode_hash = null,
         status = case when s.status in ('afventer', 'bekraeftet') then 'udloebet' else s.status end
   where s.bruger_id = new.id;
  return new;
end
$fn$;

revoke execute on function public.users_email_skift_ved_sletning() from public, anon, authenticated;

drop trigger if exists users_email_skift_ved_sletning on public.users;
create trigger users_email_skift_ved_sletning
  after update of konto_slettet_kl on public.users
  for each row
  when (old.konto_slettet_kl is null and new.konto_slettet_kl is not null)
  execute function public.users_email_skift_ved_sletning();

-- ---------------------------------------------------------------------------
-- Efter-tjek: kroppene er dem, migrationen forventer.
-- ---------------------------------------------------------------------------
select pg_temp.drift_tjek('public.email_skift_anmod(uuid,text,text)', false, 'd09e6f7b4a50c22f80f119291588eb82');
select pg_temp.drift_tjek('public.email_skift_tjek(uuid,text)', false, '40dab15a7a19bea6d3600daad77bc824');
select pg_temp.drift_tjek('public.email_skift_afslut(uuid,text)', false, '6cd8a27a9352f9ea4c3a240235afae20');
select pg_temp.drift_tjek('public.email_skift_konto_spaerret(uuid)', false, 'ea804c6aff35e2f6c8a95eaca2944af4');
select pg_temp.drift_tjek('public.auth_users_email_skift_vaern()', false, '2e1df7975fae66807ec4ab59b09958a7');
select pg_temp.drift_tjek('public.auth_users_email_spejl()', false, '78bb6ea71c8392bc99e7779da24962b7');
select pg_temp.drift_tjek('public.users_email_skift_ved_sletning()', false, '85e531a5dd9a208f6e1f549914976622');

drop function pg_temp.drift_tjek(text, boolean, text[]);
drop function pg_temp.krop_md5(text);
