-- Sikker åben tilmelding: databasen kræver ALTID en billet fra serveren for
-- en ny konto (ROADMAP fase 6, "Sikker signup for alle"). Bygger på
-- 20261017010000_beta_invitationer.sql.
--
-- Problemet: med åben tilmelding (kun_inviterede = false) slap
-- beta_tjek_ny_bruger alle nye auth-brugere igennem. Var "Allow new users to
-- sign up" slået til i Supabase, kunne en angriber kalde supabase.auth.signUp
-- direkte med anon-nøglen, offerets e-mail og sin egen adgangskode - og
-- beholde kontoen, når offeret bekræftede med koden (kontoovertagelse).
--
-- Nu:
--   1. konto_oprettelse_billetter.kilde: 'staff' (konto_oprettelse_tillad,
--      fx firmakonti - som før) eller 'signup' (ny, se 2).
--   2. konto_oprettelse_billet_signup(p_email) - KUN service_role. Signup-
--      koden (src/lib/kontoOprettelse.ts) lægger billetten lige før
--      generateLink('signup'). Gælder 2 minutter og én gang. Mens
--      kun_inviterede er slået til, gives billetten kun, når beta er åben og
--      e-mailen har en aktiv invitation (samme regel som
--      beta_tilmelding_tilladt). { kode: 'ok' | 'ikke_tilladt' | 'ugyldig_email' }.
--   3. beta_tjek_ny_bruger (kaldt af handle_new_user, FØR public.users-rækken
--      oprettes): enhver ny auth-bruger kræver nu en gyldig billet - uanset
--      kun_inviterede og uanset dashboard-indstillingen. Uden billet: errcode
--      BHB01. Billetten bruges (slettes) i samme insert.
--        - 'staff'-billet: godtages altid (som før).
--        - 'signup'-billet: mens kun_inviterede er slået til, kræves desuden
--          stadig, at beta er åben og invitationen aktiv (dobbelttjek, hvis
--          invitationen tilbagekaldes i samme sekund).
--      Undtaget er kun direkte SQL som postgres/supabase_admin (seed.sql,
--      migrationer, SQL-editoren). Supabase Auth skriver altid som
--      supabase_auth_admin og er ALDRIG undtaget - så signUp med anon-nøglen,
--      "Add user"/"Invite user" i Supabase-dashboardet og admin-API'et uden
--      billet afvises altid.
--   4. konto_oprettelse_tillad (staff) sætter kilde = 'staff' - også når den
--      overskriver en ventende signup-billet for samme e-mail.
--
-- handle_new_user ændres IKKE (md5 383bd379... efter 20261017010000) - den
-- kalder stadig beta_tjek_ny_bruger. kun_inviterede beholder sin betydning:
-- slået til = kun inviterede (beta), slået fra = åben tilmelding. Ved
-- lancering sættes den stadig til false (HUSKELISTE.md, "Lancering").
--
-- Kræver hjemmesidens nye signup-kode (src/lib/kontoOprettelse.ts), som lægger
-- billetten. Kørt FØR den kode er i drift, afvises alle nye konti fra den
-- gamle opretKonto (signUp) - og appens direkte signUp afvises altid efter
-- denne migration (appen skal bruge POST /api/konto/opret, docs/APP-SIGNUP.md).
-- Den nye kode virker også, før migrationen er kørt (så gælder det gamle værn).
--
-- Drift-tjek: alt, der erstattes, skal være præcis som efter 20261017010000
-- (eller allerede som efter denne). Idempotent (kan køres igen). Kør først på
-- testdatabasen.

set local lock_timeout = '5s';

create or replace function pg_temp.plain_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(replace(pr.prosrc, E'\r\n', E'\n')) from pg_proc pr where pr.oid = p_fn
$$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek - før noget ændres
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- Ændres ikke, men skal stadig kalde beta_tjek_ny_bruger.
  v_md5 := pg_temp.plain_md5('public.handle_new_user()'::regprocedure);
  if v_md5 <> '383bd3797481c94797bf65c52aa27890' then
    raise exception 'handle_new_user er ændret uden for migrationerne (md5 %). Kør 20261017010000 først, eller tjek den.', v_md5;
  end if;

  -- Efter 20261017010000 | efter denne.
  v_md5 := pg_temp.plain_md5('public.beta_tjek_ny_bruger(text)'::regprocedure);
  if v_md5 not in ('5186f0c3252fea62c87f19fc2f6342dd', 'a98de2c7df493992ac7a4fcba6b7ff91') then
    raise exception 'beta_tjek_ny_bruger er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;

  v_md5 := pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text)'::regprocedure);
  if v_md5 not in ('ec63e632335753d3a76d09b270a4652a', '53e9edf7cf8c946f49bda9a4bd9f769c') then
    raise exception 'konto_oprettelse_tillad er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Billetternes kilde
-- ---------------------------------------------------------------------------
alter table public.konto_oprettelse_billetter
  add column if not exists kilde text not null default 'staff';

alter table public.konto_oprettelse_billetter
  drop constraint if exists konto_oprettelse_billetter_kilde_check;
alter table public.konto_oprettelse_billetter
  add constraint konto_oprettelse_billetter_kilde_check check (kilde in ('staff', 'signup'));

comment on table public.konto_oprettelse_billetter is
  'Kortlivet tilladelse til at oprette netop én auth-bruger. handle_new_user (beta_tjek_ny_bruger) kræver altid en (20261018010000). kilde staff: konto_oprettelse_tillad (fx firmakonti, 10 min.). kilde signup: konto_oprettelse_billet_signup (signup-koden på serveren, 2 min.). Bruges én gang.';

-- ---------------------------------------------------------------------------
-- 3. Signup-billet (kun service_role - signup-koden på serveren)
-- ---------------------------------------------------------------------------
create or replace function public.konto_oprettelse_billet_signup(p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_kun   boolean;
begin
  if char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('kode', 'ugyldig_email');
  end if;

  -- Mangler rækken, gælder værnet (fail closed).
  select s.kun_inviterede into v_kun from public.beta_indstillinger s where s.id;
  if coalesce(v_kun, true) and not public.beta_tilmelding_tilladt(v_email) then
    return jsonb_build_object('kode', 'ikke_tilladt');
  end if;

  delete from public.konto_oprettelse_billetter b where b.udloeber_kl < now() - interval '1 day';
  insert into public.konto_oprettelse_billetter (email, oprettet_af, udloeber_kl, kilde)
  values (v_email, null, now() + interval '2 minutes', 'signup')
  on conflict (email) do update
    set oprettet_af = null, udloeber_kl = excluded.udloeber_kl, kilde = 'signup';
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.konto_oprettelse_billet_signup(text) from public, anon, authenticated;
grant execute on function public.konto_oprettelse_billet_signup(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Tilmeldingsværnet: billet altid (internt - kaldes kun fra handle_new_user)
-- ---------------------------------------------------------------------------
create or replace function public.beta_tjek_ny_bruger(p_email text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_aaben  boolean;
  v_kun    boolean;
  v_kilde  text;
begin
  -- Direkte SQL som databasens ejer (seed.sql, migrationer, SQL-editoren).
  -- Supabase Auth skriver altid som supabase_auth_admin og er ALDRIG undtaget.
  -- session_user påvirkes ikke af security definer.
  if session_user in ('postgres', 'supabase_admin') then return; end if;

  -- Billetten fra serveren (signup-koden eller staff-koden). Bruges én gang.
  -- Uden billet afvises enhver ny konto - også ved åben tilmelding, så en
  -- direkte signUp med anon-nøglen aldrig kan oprette en konto.
  delete from public.konto_oprettelse_billetter b
   where b.email = v_email and b.udloeber_kl > now()
  returning b.kilde into v_kilde;
  if v_kilde is null then
    raise exception 'bidhamr_tilmelding_lukket: Det er ikke muligt at oprette en konto på den måde.'
      using errcode = 'BHB01';
  end if;
  if v_kilde = 'staff' then return; end if;

  -- Signup-billet: mens tilmeldingen kun er for inviterede, kræves stadig en
  -- aktiv invitation, og at beta er åben. Mangler rækken: værnet gælder.
  select s.beta_aaben, s.kun_inviterede into v_aaben, v_kun
    from public.beta_indstillinger s where s.id;
  if not coalesce(v_kun, true) then return; end if;
  if coalesce(v_aaben, false) and v_email <> '' and exists (
       select 1 from public.beta_invitationer i
        where i.email = v_email and i.tilbagekaldt_kl is null) then
    return;
  end if;

  raise exception 'bidhamr_tilmelding_lukket: Det er ikke muligt at oprette en konto endnu.'
    using errcode = 'BHB01';
end $$;

revoke all on function public.beta_tjek_ny_bruger(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Staff-billetten sætter kilde = 'staff'
-- ---------------------------------------------------------------------------
create or replace function public.konto_oprettelse_tillad(p_staff uuid, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if p_staff is null or not (public.staff_chat_har_rolle(p_staff, 'admin')
                             or public.erhverv_har_adgang(p_staff)) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('kode', 'ugyldig_email');
  end if;
  delete from public.konto_oprettelse_billetter b where b.udloeber_kl < now() - interval '1 day';
  insert into public.konto_oprettelse_billetter (email, oprettet_af, udloeber_kl, kilde)
  values (v_email, p_staff, now() + interval '10 minutes', 'staff')
  on conflict (email) do update
    set oprettet_af = excluded.oprettet_af, udloeber_kl = excluded.udloeber_kl, kilde = 'staff';
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'konto_oprettelse_tilladt', 'beta',
          (select s.log_id from public.beta_indstillinger s where s.id), null, v_email);
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.konto_oprettelse_tillad(uuid, text) from public, anon, authenticated;
grant execute on function public.konto_oprettelse_tillad(uuid, text) to service_role;

comment on table public.beta_indstillinger is
  'Beta-testen: beta_aaben (kontakten i Admin -> Beta-invitationer, kun chef) og kun_inviterede (slået til: kun inviterede kan få en signup-billet; slås fra ved lancering). En ny konto kræver altid en billet (20261018010000). Én række.';

-- ---------------------------------------------------------------------------
-- 6. Kontrol
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.plain_md5('public.handle_new_user()'::regprocedure) <> '383bd3797481c94797bf65c52aa27890' then
    raise exception 'handle_new_user er ændret (md5 %).', pg_temp.plain_md5('public.handle_new_user()'::regprocedure);
  end if;
  if pg_temp.plain_md5('public.beta_tjek_ny_bruger(text)'::regprocedure) <> 'a98de2c7df493992ac7a4fcba6b7ff91' then
    raise exception 'beta_tjek_ny_bruger blev ikke opdateret som forventet (md5 %).',
      pg_temp.plain_md5('public.beta_tjek_ny_bruger(text)'::regprocedure);
  end if;
  if pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text)'::regprocedure) <> '53e9edf7cf8c946f49bda9a4bd9f769c' then
    raise exception 'konto_oprettelse_tillad blev ikke opdateret som forventet (md5 %).',
      pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text)'::regprocedure);
  end if;
end $$;
