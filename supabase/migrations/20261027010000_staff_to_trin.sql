-- To-trins-login for staff på admin.bidhamr.dk (Filip, 19. okt. 2026 -
-- ROADMAP-BESLUTNINGER, "Admin på admin.bidhamr.dk"; docs/ADMIN-VAERT.md).
--
-- Indsnævrer beslutningen fra 7. okt. 2026: brugere har stadig intet
-- to-trins-login, men alle staff-roller (medarbejder, admin, chef, saelger)
-- skal bruge Supabase MFA (TOTP) for at komme ind i admin på admin-hosten.
--
-- HARMLØS: intet uden for den nye kode (src/lib/adminAuth.ts og
-- src/app/actions/adgang.ts) læser tabellerne eller kalder funktionerne. Der
-- er INGEN db_pre_request, ingen ændring af RLS og ingen ændring af er_staff()
-- (det var den globale pre-request, der lukkede appen 7. okt. - se
-- 20261009060000_fjern_to_trin.sql). En medarbejder med en faktor kan logge
-- ind i appen og på hovedsitet som før (aal1). RLS med aal2 (migration B)
-- kommer i en senere opgave - se listen i docs/ADMIN-VAERT.md.
--
--   1. staff_to_trin (én række pr. medarbejder): aktiv, faktor_ider (de
--      faktorer i auth.mfa_factors, serveren har godkendt - TOTP nu, plads til
--      en passkey senere), opsat_kl, tilmeldingsvinduet (tilmelding_aaben_til,
--      tilmelding_aabnet_af) og nulstillingen (nulstillet_kl, nulstillet_af).
--   2. staff_gendannelseskoder: 10 pr. medarbejder, KUN sha256-hashen
--      (serveren hasher med bruger-id'et, src/lib/staffToTrinRegler.ts).
--      Begge tabeller: RLS slået til uden policies - kun service_role.
--   3. min_staff_adgang() (authenticated, ud fra auth.uid() og auth.jwt()):
--      rolle, aktiv (rækken er aktiv OG mindst én godkendt faktor findes
--      stadig og er verificeret), ukendte_faktorer (en verificeret faktor,
--      serveren ikke har godkendt - fx oprettet direkte mod Supabase),
--      tilmeldingsvinduet og sessionens aal.
--      staff_aal2_ok(p_maks_timer) (authenticated): det samme som én boolean
--      inkl. aal2 og et TOTP i amr, der højst er p_maks_timer gammelt - til
--      migration B.
--   4. Service-role-RPC'er (serveren tjekker host, rolle og frisk kode først):
--      staff_to_trin_aabn_tilmelding(chef, bruger, timer) - chefen åbner et
--        vindue (standard 24 t). Ikke sig selv.
--      staff_to_trin_aktiver(bruger, faktor, hashes) - efter mfa.verify: kun
--        i et åbent vindue, faktoren skal være verificeret, og ingen ANDRE
--        verificerede faktorer må findes (serveren har slettet dem). Gemmer
--        faktoren, lukker vinduet og erstatter gendannelseskoderne (præcis
--        10). Idempotent: 'allerede_aktiv' ved dobbeltklik.
--      staff_to_trin_nulstil(chef, bruger, timer) - chefen nulstiller en
--        andens to-trins-login: aktiv=false, faktorerne og brugerens
--        aal2-sessioner slettes (auth.mfa_factors / auth.sessions - postgres
--        har rettighederne, tjekket på testdatabasen 19. okt. 2026), koderne
--        slettes, og et nyt vindue åbnes (standard 24 t). Ikke sig selv.
--      staff_gendan_brug(bruger, hash) - medarbejderen har mistet sin app:
--        én ubrugt gendannelseskode bruges (atomisk), faktorerne og
--        aal2-sessionerne slettes, og et vindue på 2 timer åbnes, så en ny
--        app kan sættes op med det samme.
--      Alle logger i moderation_log (to_trin_tilmelding_aabnet,
--      to_trin_opsat, to_trin_nulstillet, to_trin_gendannet).
--   5. Trigger på users.rolle: forlader en bruger staff, sættes aktiv=false,
--      og vinduet lukkes.
--   6. moderation_log_handling_check udvides med de 4 handlinger (flettes ind
--      i den nuværende liste - mønstret fra 20261009020000:338-370). Før denne
--      migration var md5(pg_get_constraintdef) 20470dc11b09bc4558a37a28a33a5ec8
--      i både produktion og test (SELECT 19. okt. 2026).
--   7. Første udrulning: nuværende staff får et tilmeldingsvindue på 14 dage
--      (on conflict do nothing - en ny kørsel forlænger det ikke).
--      KØR MIGRATIONEN LIGE FØR ADMIN_VAERT SÆTTES I VERCEL: de 14 dage
--      regnes fra kørslen.
--
-- Ingen eksisterende funktioner ændres, så intet md5-drift-tjek på
-- funktionskroppe er nødvendigt; constrainten flettes og tjekkes bagefter.
-- Idempotent (kan køres igen). Én transaktion: filen køres som én samlet
-- forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.users') is null or to_regclass('public.moderation_log') is null then
    raise exception 'Forudsætning mangler: public.users og public.moderation_log';
  end if;
  if to_regclass('auth.mfa_factors') is null or to_regclass('auth.sessions') is null then
    raise exception 'Forudsætning mangler: auth.mfa_factors og auth.sessions (Supabase Auth)';
  end if;
end $do$;

-- ===========================================================================
-- 1. Tabeller
-- ===========================================================================
create table if not exists public.staff_to_trin (
  bruger_id            uuid primary key references public.users(id),
  aktiv                boolean not null default false,
  faktor_ider          uuid[] not null default '{}',
  opsat_kl             timestamptz,
  tilmelding_aaben_til timestamptz,
  tilmelding_aabnet_af uuid references public.users(id),
  nulstillet_kl        timestamptz,
  nulstillet_af        uuid references public.users(id),
  oprettet_kl          timestamptz not null default now(),
  opdateret_kl         timestamptz not null default now(),
  constraint staff_to_trin_aktiv_faktor check (not aktiv or cardinality(faktor_ider) > 0)
);

comment on table public.staff_to_trin is
  'To-trins-login for staff på admin-hosten (20261027010000). faktor_ider: de '
  'faktorer i auth.mfa_factors, serveren har godkendt (TOTP nu, passkey senere). '
  'Kun service_role; brugeren læser sin egen status via min_staff_adgang().';

create table if not exists public.staff_gendannelseskoder (
  id          uuid primary key default gen_random_uuid(),
  bruger_id   uuid not null references public.users(id),
  kode_hash   text not null check (kode_hash ~ '^[0-9a-f]{64}$'),
  oprettet_kl timestamptz not null default now(),
  brugt_kl    timestamptz,
  constraint staff_gendannelseskoder_unik unique (bruger_id, kode_hash)
);

comment on table public.staff_gendannelseskoder is
  'Gendannelseskoder til staffs to-trins-login (20261027010000). Kun sha256-hashen '
  '(med bruger-id). Kun service_role.';

alter table public.staff_to_trin enable row level security;
alter table public.staff_gendannelseskoder enable row level security;
revoke all on table public.staff_to_trin from public, anon, authenticated;
revoke all on table public.staff_gendannelseskoder from public, anon, authenticated;
grant select, insert, update, delete on table public.staff_to_trin to service_role;
grant select, insert, update, delete on table public.staff_gendannelseskoder to service_role;

-- ===========================================================================
-- 2. Hjælpere
-- ===========================================================================
create or replace function public.staff_to_trin_er_staff_rolle(p_rolle text)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(p_rolle in ('medarbejder', 'admin', 'chef', 'saelger'), false)
$fn$;

-- Verificerede faktorer for brugeren, som IKKE er godkendt af serveren.
create or replace function public.staff_to_trin_ukendte_faktorer(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from auth.mfa_factors f
      left join public.staff_to_trin t on t.bruger_id = f.user_id
     where f.user_id = p_bruger
       and f.status::text = 'verified'
       and not (f.id = any (coalesce(t.faktor_ider, '{}'::uuid[])))
  )
$fn$;

-- Er rækken aktiv, og findes mindst én af de godkendte faktorer stadig som
-- verificeret? (En faktor slettet direkte i Supabase giver ingen adgang.)
create or replace function public.staff_to_trin_aktiv(p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
      from public.staff_to_trin t
      join auth.mfa_factors f on f.user_id = t.bruger_id and f.id = any (t.faktor_ider)
     where t.bruger_id = p_bruger
       and t.aktiv
       and f.status::text = 'verified'
  )
$fn$;

-- Sletter brugerens faktorer og aal2-sessioner (nulstilling og gendannelse).
-- Kun aal2-sessioner: appen og hovedsitet (aal1) logges ikke ud.
create or replace function public.staff_to_trin_ryd_auth(p_bruger uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_faktorer integer;
  v_sessioner integer;
begin
  delete from auth.sessions s where s.user_id = p_bruger and s.aal::text = 'aal2';
  get diagnostics v_sessioner = row_count;
  delete from auth.mfa_factors f where f.user_id = p_bruger;
  get diagnostics v_faktorer = row_count;
  return jsonb_build_object('faktorer', v_faktorer, 'sessioner', v_sessioner);
end
$fn$;

-- ===========================================================================
-- 3. Brugerens egen status (authenticated)
-- ===========================================================================
create or replace function public.min_staff_adgang()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_rolle text;
  v_t     public.staff_to_trin%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('staff', false);
  end if;
  select u.rolle into v_rolle from public.users u where u.id = v_uid;
  if not public.staff_to_trin_er_staff_rolle(v_rolle) then
    return jsonb_build_object('staff', false);
  end if;
  select * into v_t from public.staff_to_trin t where t.bruger_id = v_uid;
  return jsonb_build_object(
    'staff', true,
    'rolle', v_rolle,
    'aktiv', public.staff_to_trin_aktiv(v_uid),
    'ukendte_faktorer', public.staff_to_trin_ukendte_faktorer(v_uid),
    'tilmelding_aaben', coalesce(v_t.tilmelding_aaben_til > now(), false),
    'tilmelding_aaben_til', v_t.tilmelding_aaben_til,
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1')
  );
end
$fn$;

comment on function public.min_staff_adgang() is
  'Staffs to-trins-status for den indloggede (auth.uid()): rolle, aktiv, ukendte_faktorer, tilmeldingsvindue og aal (20261027010000).';

-- Én boolean til RLS senere (migration B): staff, aktiv, ingen ukendte
-- faktorer, aal2 og et TOTP i amr højst p_maks_timer gammelt.
create or replace function public.staff_aal2_ok(p_maks_timer integer default 12)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_jwt  jsonb := auth.jwt();
  v_totp bigint;
begin
  if v_uid is null or coalesce(v_jwt ->> 'aal', '') <> 'aal2' then
    return false;
  end if;
  if not exists (select 1 from public.users u where u.id = v_uid and public.staff_to_trin_er_staff_rolle(u.rolle)) then
    return false;
  end if;
  if not public.staff_to_trin_aktiv(v_uid) or public.staff_to_trin_ukendte_faktorer(v_uid) then
    return false;
  end if;
  select max((e ->> 'timestamp')::bigint) into v_totp
    from jsonb_array_elements(case when jsonb_typeof(v_jwt -> 'amr') = 'array' then v_jwt -> 'amr' else '[]'::jsonb end) e
   where e ->> 'method' = 'totp' and (e ->> 'timestamp') ~ '^[0-9]{1,12}$';
  return v_totp is not null
     and v_totp <= extract(epoch from now())::bigint + 300
     and extract(epoch from now())::bigint - v_totp <= greatest(coalesce(p_maks_timer, 12), 1)::bigint * 3600;
end
$fn$;

-- ===========================================================================
-- 4. Service-role-RPC'er
-- ===========================================================================
create or replace function public.staff_to_trin_aabn_tilmelding(p_chef uuid, p_bruger uuid, p_timer integer default 24)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_til timestamptz;
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
  if not exists (select 1 from public.users u where u.id = p_bruger and public.staff_to_trin_er_staff_rolle(u.rolle)) then
    return jsonb_build_object('kode', 'ikke_staff');
  end if;
  v_til := now() + make_interval(hours => least(greatest(coalesce(p_timer, 24), 1), 24 * 14));

  insert into public.staff_to_trin as t (bruger_id, tilmelding_aaben_til, tilmelding_aabnet_af)
  values (p_bruger, v_til, p_chef)
  on conflict (bruger_id) do update
     set tilmelding_aaben_til = excluded.tilmelding_aaben_til,
         tilmelding_aabnet_af = excluded.tilmelding_aabnet_af,
         opdateret_kl = now();

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'to_trin_tilmelding_aabnet', 'bruger', p_bruger, p_bruger,
          'Åbnede tilmelding til to-trins-login til ' || to_char(v_til at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI'));

  return jsonb_build_object('kode', 'ok', 'aaben_til', v_til);
end
$fn$;

create or replace function public.staff_to_trin_aktiver(p_bruger uuid, p_faktor uuid, p_hashes text[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_t public.staff_to_trin%rowtype;
  v_n integer;
begin
  if p_bruger is null or p_faktor is null then
    return jsonb_build_object('kode', 'ugyldig');
  end if;
  if not exists (select 1 from public.users u where u.id = p_bruger and public.staff_to_trin_er_staff_rolle(u.rolle)) then
    return jsonb_build_object('kode', 'ikke_staff');
  end if;
  if p_hashes is null or cardinality(p_hashes) <> 10
     or exists (select 1 from unnest(p_hashes) h where h is null or h !~ '^[0-9a-f]{64}$')
     or (select count(distinct h) from unnest(p_hashes) h) <> 10 then
    return jsonb_build_object('kode', 'ugyldige_koder');
  end if;

  select * into v_t from public.staff_to_trin t where t.bruger_id = p_bruger for update;
  if not found then
    return jsonb_build_object('kode', 'vindue_lukket');
  end if;
  -- Aktiv = rækken er aktiv OG en godkendt faktor findes stadig. Er faktoren
  -- slettet direkte i Supabase, kan en ny app sættes op i et åbent vindue.
  if v_t.aktiv and public.staff_to_trin_aktiv(p_bruger) then
    return jsonb_build_object('kode', case when p_faktor = any (v_t.faktor_ider) then 'allerede_aktiv' else 'aktiv_i_forvejen' end);
  end if;
  if v_t.tilmelding_aaben_til is null or v_t.tilmelding_aaben_til <= now() then
    return jsonb_build_object('kode', 'vindue_lukket');
  end if;
  if not exists (select 1 from auth.mfa_factors f
                  where f.id = p_faktor and f.user_id = p_bruger and f.status::text = 'verified') then
    return jsonb_build_object('kode', 'faktor_ukendt');
  end if;
  if exists (select 1 from auth.mfa_factors f
              where f.user_id = p_bruger and f.status::text = 'verified' and f.id <> p_faktor) then
    return jsonb_build_object('kode', 'andre_faktorer');
  end if;

  update public.staff_to_trin t
     set aktiv = true,
         faktor_ider = array[p_faktor],
         opsat_kl = now(),
         tilmelding_aaben_til = null,
         opdateret_kl = now()
   where t.bruger_id = p_bruger;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('kode', 'vindue_lukket');
  end if;

  delete from public.staff_gendannelseskoder g where g.bruger_id = p_bruger;
  insert into public.staff_gendannelseskoder (bruger_id, kode_hash)
  select p_bruger, h from unnest(p_hashes) h;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_bruger, 'to_trin_opsat', 'bruger', p_bruger, p_bruger, 'Satte to-trins-login op (app-kode)');

  return jsonb_build_object('kode', 'ok');
end
$fn$;

create or replace function public.staff_to_trin_nulstil(p_chef uuid, p_bruger uuid, p_timer integer default 24)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_til   timestamptz;
  v_ryd   jsonb;
  v_var   boolean;
  v_koder integer;
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
  if not exists (select 1 from public.users u where u.id = p_bruger) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  v_til := now() + make_interval(hours => least(greatest(coalesce(p_timer, 24), 1), 24 * 14));

  select coalesce(t.aktiv, false) into v_var from public.staff_to_trin t where t.bruger_id = p_bruger for update;
  v_ryd := public.staff_to_trin_ryd_auth(p_bruger);
  delete from public.staff_gendannelseskoder g where g.bruger_id = p_bruger and g.brugt_kl is null;
  get diagnostics v_koder = row_count;

  insert into public.staff_to_trin as t (bruger_id, aktiv, faktor_ider, nulstillet_kl, nulstillet_af,
                                         tilmelding_aaben_til, tilmelding_aabnet_af)
  values (p_bruger, false, '{}', now(), p_chef, v_til, p_chef)
  on conflict (bruger_id) do update
     set aktiv = false,
         faktor_ider = '{}',
         nulstillet_kl = now(),
         nulstillet_af = p_chef,
         tilmelding_aaben_til = excluded.tilmelding_aaben_til,
         tilmelding_aabnet_af = excluded.tilmelding_aabnet_af,
         opdateret_kl = now();

  -- Dobbeltklik: intet at nulstille anden gang - ingen ny log-linje.
  if not coalesce(v_var, false) and (v_ryd ->> 'faktorer')::integer = 0
     and (v_ryd ->> 'sessioner')::integer = 0 and v_koder = 0 then
    return jsonb_build_object('kode', 'uaendret', 'aaben_til', v_til);
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_chef, 'to_trin_nulstillet', 'bruger', p_bruger, p_bruger,
          format('Nulstillede to-trins-login (%s faktor(er), %s session(er) med to-trins-login logget ud). Ny tilmelding åben til %s',
                 v_ryd ->> 'faktorer', v_ryd ->> 'sessioner',
                 to_char(v_til at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI')));

  return jsonb_build_object('kode', 'ok', 'aaben_til', v_til,
                            'faktorer', (v_ryd ->> 'faktorer')::integer,
                            'sessioner', (v_ryd ->> 'sessioner')::integer);
end
$fn$;

create or replace function public.staff_gendan_brug(p_bruger uuid, p_kode_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id  uuid;
  v_ryd jsonb;
  v_til timestamptz := now() + interval '2 hours';
begin
  if p_bruger is null or p_kode_hash is null or p_kode_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('kode', 'forkert');
  end if;
  if not exists (select 1 from public.users u where u.id = p_bruger and public.staff_to_trin_er_staff_rolle(u.rolle)) then
    return jsonb_build_object('kode', 'forkert');
  end if;

  -- Atomisk: to samtidige forsøg med samme kode - kun det ene vinder.
  update public.staff_gendannelseskoder g
     set brugt_kl = now()
   where g.bruger_id = p_bruger and g.kode_hash = p_kode_hash and g.brugt_kl is null
  returning g.id into v_id;
  if v_id is null then
    return jsonb_build_object('kode', 'forkert');
  end if;

  perform 1 from public.staff_to_trin t where t.bruger_id = p_bruger for update;
  v_ryd := public.staff_to_trin_ryd_auth(p_bruger);
  update public.staff_to_trin t
     set aktiv = false,
         faktor_ider = '{}',
         tilmelding_aaben_til = v_til,
         tilmelding_aabnet_af = p_bruger,
         opdateret_kl = now()
   where t.bruger_id = p_bruger;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_bruger, 'to_trin_gendannet', 'bruger', p_bruger, p_bruger,
          format('Brugte en gendannelseskode (%s tilbage). Faktorerne er slettet, og en ny app skal sættes op inden %s',
                 (select count(*) from public.staff_gendannelseskoder g where g.bruger_id = p_bruger and g.brugt_kl is null),
                 to_char(v_til at time zone 'Europe/Copenhagen', 'DD-MM-YYYY HH24:MI')));

  return jsonb_build_object('kode', 'ok', 'aaben_til', v_til,
                            'tilbage', (select count(*) from public.staff_gendannelseskoder g
                                         where g.bruger_id = p_bruger and g.brugt_kl is null));
end
$fn$;

-- ===========================================================================
-- 5. Trigger: forlader en bruger staff, er to-trins-login ikke aktivt længere
-- ===========================================================================
create or replace function public.users_staff_to_trin_rolle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if public.staff_to_trin_er_staff_rolle(old.rolle) and not public.staff_to_trin_er_staff_rolle(new.rolle) then
    update public.staff_to_trin t
       set aktiv = false,
           tilmelding_aaben_til = null,
           opdateret_kl = now()
     where t.bruger_id = new.id;
  end if;
  return new;
end
$fn$;

drop trigger if exists users_staff_to_trin_rolle on public.users;
create trigger users_staff_to_trin_rolle
  after update of rolle on public.users
  for each row
  when (old.rolle is distinct from new.rolle)
  execute function public.users_staff_to_trin_rolle();

-- ===========================================================================
-- 6. moderation_log: de nye handlinger (flettes ind i den nuværende liste)
-- ===========================================================================
do $do$
declare
  v_def  text;
  v_nye  text[] := array['to_trin_gendannet', 'to_trin_nulstillet', 'to_trin_opsat', 'to_trin_tilmelding_aabnet'];
  v_gl   text[];
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if v_def is null then
    raise exception 'moderation_log_handling_check findes ikke';
  end if;
  v_gl := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m) s
     where x <> '' order by 1);
  if cardinality(v_gl) = 0 then
    raise exception 'Kunne ikke læse moderation_log_handling_check: %', v_def;
  end if;
  if v_nye <@ v_gl then
    return;
  end if;
  v_vals := array(select distinct x from unnest(v_gl || v_nye) x order by 1);
  alter table public.moderation_log drop constraint moderation_log_handling_check;
  execute format('alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))', v_vals);

  -- Tjek: alle gamle værdier er bevaret, og de nye er med.
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.moderation_log'::regclass and c.conname = 'moderation_log_handling_check';
  if not (v_gl <@ array(
            select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
              from regexp_matches(v_def, '''([^'']+)''', 'g') as m)
          and v_nye <@ array(
            select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "')
              from regexp_matches(v_def, '''([^'']+)''', 'g') as m)) then
    raise exception 'moderation_log_handling_check blev ikke flettet korrekt: %', v_def;
  end if;
end $do$;

-- ===========================================================================
-- 7. Første udrulning: 14 dages tilmeldingsvindue for nuværende staff
-- ===========================================================================
insert into public.staff_to_trin (bruger_id, tilmelding_aaben_til)
select u.id, now() + interval '14 days'
  from public.users u
 where public.staff_to_trin_er_staff_rolle(u.rolle)
on conflict (bruger_id) do nothing;

-- ===========================================================================
-- 8. Rettigheder
-- ===========================================================================
do $do$
declare
  f text;
begin
  -- Kun service_role (serveren).
  foreach f in array array[
    'public.staff_to_trin_ukendte_faktorer(uuid)',
    'public.staff_to_trin_aktiv(uuid)',
    'public.staff_to_trin_ryd_auth(uuid)',
    'public.staff_to_trin_aabn_tilmelding(uuid, uuid, integer)',
    'public.staff_to_trin_aktiver(uuid, uuid, text[])',
    'public.staff_to_trin_nulstil(uuid, uuid, integer)',
    'public.staff_gendan_brug(uuid, text)',
    'public.users_staff_to_trin_rolle()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- Den indloggede selv (udleder brugeren af auth.uid()).
  foreach f in array array[
    'public.min_staff_adgang()',
    'public.staff_aal2_ok(integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  -- Ren hjælper uden data.
  execute 'revoke all on function public.staff_to_trin_er_staff_rolle(text) from public, anon';
  execute 'grant execute on function public.staff_to_trin_er_staff_rolle(text) to authenticated, service_role';
end $do$;
