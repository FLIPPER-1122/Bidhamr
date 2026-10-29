-- =============================================================================
-- Rettelser til 20261102410000_huskeliste_oprydning.sql (review 28. okt.
-- 2026, HUSKELISTE.md "Review af 20261102410000"). 410000 er kørt på test,
-- men ikke på produktion; den røres ikke, så den udgave, der allerede er kørt
-- på test, passer med denne fil. Kør 410000 og derefter denne.
--
-- Idempotent: kan køres flere gange (create ... if not exists, create or
-- replace, drop ... if exists). Køres først på testdatabasen
-- (pjiigmzqwlfepxnjdvug). Produktion kræver Filips "ja".
--
-- Filen er delt i afsnit (linjerne "-- @afsnit <navn>") som 410000, så
-- penge-db-testene kan køre hvert afsnit for sig. I drift køres hele filen.
--
--   enhed   Kendt enhed på admin-hosten (review punkt 1 og 3):
--           - kendte_enheder.admin_mfa_kl: sættes, når to-trins-loginet
--             (TOTP) er gennemført på admin-hosten fra enheden
--             (kendt_enhed_admin_mfa). Kun en sådan enhed (højst 90 dage
--             siden) slipper uden om loftet pr. e-mail ved login og
--             gendannelse (admin_login_loft_undtaget). Et login med
--             adgangskoden alene gør IKKE enheden kendt.
--           - Markeringen ryddes, når adgangskoden skiftes (trigger på
--             auth.users), når to-trins-loginet nulstilles eller gendannes
--             (trigger på staff_to_trin), og ved "Log ud andre steder"
--             (kendte_enheder_ryd_admin_mfa, kaldes af serveren).
--           - Udvej for en medarbejder, der er spærret ude på en ny enhed:
--             chefen trykker "Nulstil login-loft" under Medarbejdere
--             (staff_login_loft_nulstil). Tællerne pr. e-mail nulstilles, og
--             loftet pr. e-mail gælder ikke for kontoen i 30 minutter (eller
--             til medarbejderen har gennemført to-trins-loginet). Logges i
--             moderation_log ('login_loft_nulstillet').
--   email   E-mail-outbox (review punkt 2 og 4, småt):
--           - email_skift_outbox_log_ud: coalesce(created_at, '-infinity'),
--             så en session/token uden tidspunkt også ryddes.
--           - email_skift_outbox_opgivne: rækker med forsoeg >= 12 og
--             udfoert_kl is null (betalings-cron'en melder dem til
--             /admin/drift).
--   bot     bot_indstillinger_log: medarbejderen er kun den, der gemte via
--           bot_indstillinger_gem (/admin/bot). En ændring i SQL-editoren
--           logges med BidHamr-systembrugeren, også hvis opdateret_af står
--           på en medarbejder fra en tidligere ændring.
--   faktura firma_faktura_mail_tag/_frigiv får en ejer (p_ejer): kun det
--           forsøg, der tog låsen, kan slippe den. Den gamle udgave med ét
--           argument (kun på test) fjernes.
--
-- Ingen handelsdata slettes eller ændres.
-- =============================================================================

-- @afsnit faelles
-- Nye værdier i en check-constraint af formen "kolonne = any (array[...])"
-- på moderation_log (de gamle værdier bevares). Samme som i 410000.
create or replace function pg_temp.hr_flet_check(p_navn text, p_kol text, p_nye text[])
returns void language plpgsql as $f$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.moderation_log'::regclass and c.conname = p_navn;
  if v_def is null then
    raise exception '% findes ikke', p_navn;
  end if;
  if (select bool_and(v_def like '%''' || x || '''%' or v_def like '%,' || x || ',%' or v_def like '%{' || x || ',%'
                      or v_def like '%,' || x || '}%' or v_def like '%{' || x || '}%') from unnest(p_nye) x) then
    return;
  end if;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m
      union select unnest(p_nye)) s
    where x <> '' order by 1);
  if cardinality(v_vals) <= cardinality(p_nye) then
    raise exception 'Kunne ikke læse %: %', p_navn, v_def;
  end if;
  execute format('alter table public.moderation_log drop constraint %I', p_navn);
  execute format('alter table public.moderation_log add constraint %I check (%I = any (%L::text[]))', p_navn, p_kol, v_vals);
end $f$;

-- @afsnit enhed
-- ===========================================================================
-- Kendt enhed: kun efter to-trins-login på admin-hosten
-- ===========================================================================
do $do$
begin
  if to_regclass('public.kendte_enheder') is null or to_regclass('public.rate_limits') is null
     or to_regclass('public.staff_to_trin') is null or to_regclass('public.moderation_log') is null then
    raise exception 'kendte_enheder, rate_limits, staff_to_trin eller moderation_log findes ikke - kør de tidligere migrationer først';
  end if;
  if to_regprocedure('public.staff_to_trin_er_staff_rolle(text)') is null then
    raise exception 'staff_to_trin_er_staff_rolle findes ikke - kør 20261027010000 først';
  end if;
end $do$;

-- Hvornår to-trins-loginet (TOTP) sidst blev gennemført på admin-hosten fra
-- denne enhed. null = aldrig (eller ryddet). Kun sådan en enhed er "kendt"
-- for loftet pr. e-mail på admin-login.
alter table public.kendte_enheder add column if not exists admin_mfa_kl timestamptz;

-- Chefens nulstilling af loftet pr. e-mail for en medarbejder (udvejen, hvis
-- en medarbejder er spærret ude på en ny enhed). Ikke handelsdata.
create table if not exists public.staff_login_loft_fritagelse (
  bruger_id     uuid primary key references public.users(id) on delete cascade,
  fritaget_til  timestamptz not null,
  nulstillet_af uuid references public.users(id) on delete set null,
  nulstillet_kl timestamptz not null default now()
);
comment on table public.staff_login_loft_fritagelse is
  'Admin-login: loftet pr. e-mail gælder ikke for medarbejderen indtil fritaget_til (chefens "Nulstil login-loft" under Medarbejdere, staff_login_loft_nulstil). Slutter, når medarbejderen har gennemført to-trins-loginet. Kun service_role. 20261102430000.';
alter table public.staff_login_loft_fritagelse enable row level security;
revoke all on table public.staff_login_loft_fritagelse from public, anon, authenticated;
grant select on table public.staff_login_loft_fritagelse to service_role;

-- To-trins-loginet er netop gennemført på admin-hosten fra enheden (hash af
-- cookien bh_enhed). Kaldes af serveren efter et vellykket TOTP-tjek. En
-- eventuel fritagelse fra chefen slutter (den er ikke længere nødvendig).
-- false = enheden er ikke registreret (registrer_login har ikke kørt).
create or replace function public.kendt_enhed_admin_mfa(p_bruger uuid, p_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_bruger is null or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update public.kendte_enheder k
     set admin_mfa_kl = now(), sidst_set_kl = now()
   where k.bruger_id = p_bruger and k.enhed_hash = p_hash;
  if not found then return false; end if;
  update public.staff_login_loft_fritagelse f
     set fritaget_til = now()
   where f.bruger_id = p_bruger and f.fritaget_til > now();
  return true;
end
$fn$;
revoke execute on function public.kendt_enhed_admin_mfa(uuid, text) from public, anon, authenticated;
grant execute on function public.kendt_enhed_admin_mfa(uuid, text) to service_role;

-- Ryd markeringen på alle brugerens enheder ("Log ud andre steder").
create or replace function public.kendte_enheder_ryd_admin_mfa(p_bruger uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  update public.kendte_enheder k set admin_mfa_kl = null
   where k.bruger_id = p_bruger and k.admin_mfa_kl is not null;
  get diagnostics n = row_count;
  return n;
end
$fn$;
revoke execute on function public.kendte_enheder_ryd_admin_mfa(uuid) from public, anon, authenticated;
grant execute on function public.kendte_enheder_ryd_admin_mfa(uuid) to service_role;

-- Ny adgangskode (alle veje: konto, nulstilling, appen, dashboardet):
-- markeringen ryddes på alle enheder.
create or replace function public.auth_users_adgangskode_ryd_admin_mfa()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update public.kendte_enheder k set admin_mfa_kl = null
     where k.bruger_id = new.id and k.admin_mfa_kl is not null;
  end if;
  return null;
end
$fn$;
revoke execute on function public.auth_users_adgangskode_ryd_admin_mfa() from public, anon, authenticated;

drop trigger if exists auth_users_adgangskode_ryd_admin_mfa on auth.users;
create trigger auth_users_adgangskode_ryd_admin_mfa
  after update of encrypted_password on auth.users
  for each row execute function public.auth_users_adgangskode_ryd_admin_mfa();

-- To-trins-loginet nulstilles (chefen) eller gendannes (mistet telefon):
-- markeringen ryddes - enhederne skal igennem den nye app først.
create or replace function public.staff_to_trin_ryd_admin_mfa()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if old.aktiv and not new.aktiv then
    update public.kendte_enheder k set admin_mfa_kl = null
     where k.bruger_id = new.bruger_id and k.admin_mfa_kl is not null;
  end if;
  return null;
end
$fn$;
revoke execute on function public.staff_to_trin_ryd_admin_mfa() from public, anon, authenticated;

drop trigger if exists staff_to_trin_ryd_admin_mfa on public.staff_to_trin;
create trigger staff_to_trin_ryd_admin_mfa
  after update of aktiv on public.staff_to_trin
  for each row execute function public.staff_to_trin_ryd_admin_mfa();

-- Gælder loftet pr. e-mail IKKE for medarbejderen fra denne enhed?
--   'enhed'    enheden har gennemført to-trins-loginet på admin-hosten inden
--              for 90 dage (serveren tæller så et loft pr. enhed i stedet)
--   'fritaget' chefen har nulstillet loftet (staff_login_loft_nulstil)
--   'nej'      loftet pr. e-mail gælder
-- Kun aktive staff-roller. Kun service_role.
create or replace function public.admin_login_loft_undtaget(p_bruger uuid, p_hash text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if p_bruger is null
     or not exists (select 1 from public.users u
                     where u.id = p_bruger and public.staff_to_trin_er_staff_rolle(u.rolle)) then
    return 'nej';
  end if;
  if p_hash ~ '^[0-9a-f]{64}$' and exists (
       select 1 from public.kendte_enheder k
        where k.bruger_id = p_bruger and k.enhed_hash = p_hash
          and k.admin_mfa_kl > now() - interval '90 days') then
    return 'enhed';
  end if;
  if exists (select 1 from public.staff_login_loft_fritagelse f
              where f.bruger_id = p_bruger and f.fritaget_til > now()) then
    return 'fritaget';
  end if;
  return 'nej';
end
$fn$;
revoke execute on function public.admin_login_loft_undtaget(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_login_loft_undtaget(uuid, text) to service_role;

select pg_temp.hr_flet_check('moderation_log_handling_check', 'handling', array['login_loft_nulstillet']);

-- Chefen nulstiller loftet pr. e-mail for en medarbejder: tællerne for
-- admin-login og gendannelse pr. e-mail slettes, og loftet gælder ikke for
-- kontoen i p_minutter (5-60, standard 30) eller til to-trins-loginet er
-- gennemført. Lofterne pr. IP og pr. e-mail+IP, adgangskoden og koden fra
-- app'en gælder stadig. Kun chefen; ikke sig selv. Logges i moderation_log.
-- Dobbeltklik (en fritagelse med mindst 5 minutter for lidt tilbage): ingen
-- ny log-linje ('uaendret'). Kun service_role - serveren tjekker chefen
-- (assertRole + frisk kode fra app'en), databasen tjekker igen.
create or replace function public.staff_login_loft_nulstil(p_chef uuid, p_bruger uuid, p_minutter integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_email text;
  v_til   timestamptz;
  v_nu    timestamptz;
  v_slet  integer;
begin
  if p_chef is null or p_bruger is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if not exists (select 1 from public.users u where u.id = p_chef and u.rolle = 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_chef = p_bruger then
    return jsonb_build_object('kode', 'egen');
  end if;
  select lower(btrim(u.email)) into v_email from public.users u
   where u.id = p_bruger and public.staff_to_trin_er_staff_rolle(u.rolle);
  if not found then
    return jsonb_build_object('kode', 'ikke_staff');
  end if;
  v_til := now() + make_interval(mins => least(greatest(coalesce(p_minutter, 30), 5), 60));

  -- Lås rækken (to samtidige tryk venter her).
  select f.fritaget_til into v_nu from public.staff_login_loft_fritagelse f
   where f.bruger_id = p_bruger for update;

  delete from public.rate_limits r
   where r.noegle in ('admin_login_email:' || coalesce(v_email, ''), 'admin_gendan_email:' || coalesce(v_email, ''));
  get diagnostics v_slet = row_count;

  if v_nu is not null and v_nu > v_til - interval '5 minutes' and v_slet = 0 then
    return jsonb_build_object('kode', 'uaendret', 'fritaget_til', v_nu);
  end if;

  insert into public.staff_login_loft_fritagelse as f (bruger_id, fritaget_til, nulstillet_af, nulstillet_kl)
  values (p_bruger, v_til, p_chef, now())
  on conflict (bruger_id) do update
     set fritaget_til = excluded.fritaget_til, nulstillet_af = excluded.nulstillet_af, nulstillet_kl = now();

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'login_loft_nulstillet', 'bruger', p_bruger, p_bruger,
          format('Nulstillede login-loftet pr. e-mail på admin (%s tæller(e) slettet). Loftet gælder ikke for kontoen til %s eller til to-trins-loginet er gennemført',
                 v_slet, to_char(v_til at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI')));

  return jsonb_build_object('kode', 'ok', 'fritaget_til', v_til, 'taellere', v_slet);
end
$fn$;
revoke execute on function public.staff_login_loft_nulstil(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.staff_login_loft_nulstil(uuid, uuid, integer) to service_role;

-- @afsnit email
-- ===========================================================================
-- E-mail-outbox: coalesce på tidspunkterne og opgivne rækker
-- ===========================================================================
do $do$
begin
  if to_regclass('public.email_skift_outbox') is null
     or to_regprocedure('public.email_skift_outbox_log_ud(uuid)') is null then
    raise exception 'email_skift_outbox findes ikke - kør 20261102410000 først';
  end if;
end $do$;

-- Som i 410000, men en session eller token uden created_at regnes for at
-- være fra før skiftet (coalesce(..., '-infinity')) og ryddes.
create or replace function public.email_skift_outbox_log_ud(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  o  record;
  v_sess integer := 0;
  v_tok  integer := 0;
  n      integer;
begin
  select x.id, x.bruger_id, x.skiftet_kl, x.log_ud_kl, s.behold_session
    into o
    from public.email_skift_outbox x
    join public.email_skift s on s.id = x.email_skift_id
   where x.id = p_id
   for update of x;
  if not found then return jsonb_build_object('kode', 'ukendt'); end if;
  if o.log_ud_kl is not null then return jsonb_build_object('kode', 'allerede'); end if;

  delete from auth.sessions a
   where a.user_id = o.bruger_id
     and coalesce(a.created_at, '-infinity'::timestamptz) < o.skiftet_kl
     and a.id is distinct from o.behold_session;
  get diagnostics v_sess = row_count;

  -- "Glemt adgangskode" fra før skiftet (til den gamle adresse) virker ikke.
  update auth.users a
     set recovery_token = ''
   where a.id = o.bruger_id
     and coalesce(a.recovery_token, '') <> ''
     and coalesce(a.recovery_sent_at, '-infinity'::timestamptz) < o.skiftet_kl;
  get diagnostics n = row_count;
  v_tok := v_tok + n;
  delete from auth.one_time_tokens t
   where t.user_id = o.bruger_id
     and t.token_type = 'recovery_token'
     and coalesce(t.created_at, '-infinity'::timestamptz) < o.skiftet_kl;
  get diagnostics n = row_count;
  v_tok := v_tok + n;

  update public.email_skift_outbox x
     set log_ud_kl = now(),
         udfoert_kl = case when x.mail_kl is not null and x.stripe_kl is not null then now() end
   where x.id = p_id and x.log_ud_kl is null;
  return jsonb_build_object('kode', 'ok', 'sessioner', v_sess, 'tokens', v_tok);
end
$fn$;
revoke execute on function public.email_skift_outbox_log_ud(uuid) from public, anon, authenticated;
grant execute on function public.email_skift_outbox_log_ud(uuid) to service_role;

-- Opgivne rækker (12 forsøg, email_skift_outbox_tag tager dem ikke mere):
-- { antal, ids (højst p_graense), aeldste_kl, mangler: { log_ud, mail,
-- stripe } }. Betalings-cron'en melder dem til /admin/drift, til nogen har
-- gjort resten manuelt og sat udfoert_kl.
create or replace function public.email_skift_outbox_opgivne(p_graense integer default 20)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'antal', count(*),
    'ids', coalesce((select jsonb_agg(y.id order by y.oprettet_kl)
                       from (select z.id, z.oprettet_kl from public.email_skift_outbox z
                              where z.forsoeg >= 12 and z.udfoert_kl is null
                              order by z.oprettet_kl
                              limit least(greatest(coalesce(p_graense, 20), 1), 100)) y), '[]'::jsonb),
    'aeldste_kl', min(x.oprettet_kl),
    'mangler', jsonb_build_object(
      'log_ud', count(*) filter (where x.log_ud_kl is null),
      'mail', count(*) filter (where x.mail_kl is null),
      'stripe', count(*) filter (where x.stripe_kl is null)))
    from public.email_skift_outbox x
   where x.forsoeg >= 12 and x.udfoert_kl is null;
$fn$;
revoke execute on function public.email_skift_outbox_opgivne(integer) from public, anon, authenticated;
grant execute on function public.email_skift_outbox_opgivne(integer) to service_role;

-- @afsnit bot
-- ===========================================================================
-- BidHamr-bot: systembrugeren, når lofterne ændres uden for /admin/bot
-- ===========================================================================
do $do$
begin
  if to_regclass('public.bot_indstillinger') is null
     or to_regprocedure('public.bot_indstillinger_log()') is null then
    raise exception 'bot_indstillinger_log findes ikke - kør 20261102410000 først';
  end if;
end $do$;

-- /admin/bot gemmer lofterne her. Medarbejderen sættes som en lokal
-- indstilling i transaktionen, så loggen (bot_indstillinger_log) kun bruger
-- en medarbejder, når ændringen kommer herfra. false = rækken findes ikke.
create or replace function public.bot_indstillinger_gem(
  p_af uuid,
  p_doegnloft_usd numeric,
  p_anon_andel numeric,
  p_bruger_loft_usd numeric,
  p_doegnloft_anon integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  n integer;
begin
  if p_af is null then
    raise exception 'p_af mangler' using errcode = '22023';
  end if;
  perform set_config('bidhamr.bot_lofter_af', p_af::text, true);
  update public.bot_indstillinger b
     set doegnloft_usd = p_doegnloft_usd,
         anon_andel = p_anon_andel,
         bruger_loft_usd = p_bruger_loft_usd,
         doegnloft_anon = p_doegnloft_anon,
         opdateret_kl = now(),
         opdateret_af = p_af
   where b.id = true;
  get diagnostics n = row_count;
  perform set_config('bidhamr.bot_lofter_af', '', true);
  return n = 1;
end
$fn$;
revoke execute on function public.bot_indstillinger_gem(uuid, numeric, numeric, numeric, integer) from public, anon, authenticated;
grant execute on function public.bot_indstillinger_gem(uuid, numeric, numeric, numeric, integer) to service_role;

-- Som i 410000, men medarbejderen er kun den fra bot_indstillinger_gem. Ellers
-- (SQL-editoren, en direkte update) BidHamr-systembrugeren.
create or replace function public.bot_indstillinger_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sat text := nullif(current_setting('bidhamr.bot_lofter_af', true), '');
  v_af uuid := '00000000-0000-4000-8000-0000000b1d00'::uuid;
  v_tekst text;
begin
  if v_sat ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and new.opdateret_af is not distinct from v_sat::uuid then
    v_af := v_sat::uuid;
  end if;
  v_tekst := left(
    'Lofter for BidHamr-bot ændret: '
    || 'døgnloft ' || old.doegnloft_usd::text || ' -> ' || new.doegnloft_usd::text || ' USD; '
    || 'andel uden login ' || round(old.anon_andel * 100, 1)::text || ' -> ' || round(new.anon_andel * 100, 1)::text || ' %; '
    || 'pr. bruger ' || old.bruger_loft_usd::text || ' -> ' || new.bruger_loft_usd::text || ' USD; '
    || 'beskeder uden login ' || old.doegnloft_anon::text || ' -> ' || new.doegnloft_anon::text
    || case when v_af = '00000000-0000-4000-8000-0000000b1d00'::uuid then ' (ændret uden for /admin/bot)' else '' end
    || ' | ' || jsonb_build_object(
         'gammel', jsonb_build_object('doegnloft_usd', old.doegnloft_usd, 'anon_andel', old.anon_andel,
                                      'bruger_loft_usd', old.bruger_loft_usd, 'doegnloft_anon', old.doegnloft_anon),
         'ny', jsonb_build_object('doegnloft_usd', new.doegnloft_usd, 'anon_andel', new.anon_andel,
                                  'bruger_loft_usd', new.bruger_loft_usd, 'doegnloft_anon', new.doegnloft_anon))::text,
    4000);
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (v_af, 'bot_lofter_aendret', 'system', v_af, null, v_tekst);
  return null;
end
$fn$;
revoke execute on function public.bot_indstillinger_log() from public, anon, authenticated;

-- @afsnit faktura
-- ===========================================================================
-- Firmafaktura: kun låsens ejer kan slippe mail-låsen
-- ===========================================================================
do $do$
begin
  if to_regclass('public.firma_faktura_mail_laas') is null then
    raise exception 'firma_faktura_mail_laas findes ikke - kør 20261102410000 først';
  end if;
end $do$;

alter table public.firma_faktura_mail_laas add column if not exists ejer uuid;

-- Udgaven med ét argument (410000, kun på test) erstattes af en med ejer.
drop function if exists public.firma_faktura_mail_tag(uuid);
drop function if exists public.firma_faktura_mail_frigiv(uuid);

-- true = kalderen (p_ejer, et tilfældigt id pr. forsøg) må sende mailen nu
-- (låst i 5 minutter). false = mailen er allerede sendt, fakturaen er ikke
-- sendt, eller et andet forsøg er i gang. Rækkelåsen på fakturaen gør det
-- atomisk. En udløbet lås kan tages af et nyt forsøg.
create or replace function public.firma_faktura_mail_tag(p_id uuid, p_ejer uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  f record;
  n integer;
begin
  if p_ejer is null then return false; end if;
  select x.id, x.status, x.mail_sendt_kl into f from public.firma_fakturaer x where x.id = p_id for update;
  if not found or f.status <> 'sendt' or f.mail_sendt_kl is not null then
    return false;
  end if;
  insert into public.firma_faktura_mail_laas (faktura_id, laast_til, ejer, opdateret_kl)
  values (p_id, now() + interval '5 minutes', p_ejer, now())
  on conflict (faktura_id) do update
     set laast_til = excluded.laast_til, ejer = excluded.ejer, opdateret_kl = now()
   where firma_faktura_mail_laas.laast_til is null or firma_faktura_mail_laas.laast_til < now();
  get diagnostics n = row_count;
  return n = 1;
end
$fn$;
revoke execute on function public.firma_faktura_mail_tag(uuid, uuid) from public, anon, authenticated;
grant execute on function public.firma_faktura_mail_tag(uuid, uuid) to service_role;

-- Slipper låsen - kun hvis det er låsens egen ejer (et forsøg, hvis lås er
-- udløbet og taget af et nyt, kan ikke slippe det nye forsøgs lås).
create or replace function public.firma_faktura_mail_frigiv(p_id uuid, p_ejer uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_ejer is null then return false; end if;
  update public.firma_faktura_mail_laas l
     set laast_til = null, ejer = null, opdateret_kl = now()
   where l.faktura_id = p_id and l.ejer = p_ejer;
  return found;
end
$fn$;
revoke execute on function public.firma_faktura_mail_frigiv(uuid, uuid) from public, anon, authenticated;
grant execute on function public.firma_faktura_mail_frigiv(uuid, uuid) to service_role;

-- @afsnit slut
drop function if exists pg_temp.hr_flet_check(text, text, text[]);
