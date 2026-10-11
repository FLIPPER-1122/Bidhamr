-- Sikker åben tilmelding: databasen kræver ALTID en billet fra serveren for
-- en ny konto, bundet til serverens eget kald med et engangs-nonce (ROADMAP
-- fase 6, "Sikker signup for alle"). Bygger på 20261017010000_beta_invitationer.sql.
--
-- Problemet: med åben tilmelding (kun_inviterede = false) slap
-- beta_tjek_ny_bruger alle nye auth-brugere igennem. Var "Allow new users to
-- sign up" slået til i Supabase, kunne en angriber kalde supabase.auth.signUp
-- direkte med anon-nøglen, offerets e-mail og sin egen adgangskode - og
-- beholde kontoen, når offeret bekræftede med koden (kontoovertagelse).
--
-- Nu:
--   1. konto_oprettelse_billetter: én række pr. billet (nøgle: noegle_hash =
--      hex SHA-256 af et tilfældigt nonce, som KUN serveren kender), kilde
--      'staff' eller 'signup'. Flere billetter til samme e-mail kan ligge
--      samtidig, så en signup-billet aldrig overskriver en staff-billet (og
--      omvendt). Gamle billetter uden hash slettes (de gælder højst 10 min.).
--   2. konto_oprettelse_billet_signup(p_email, p_hash) - KUN service_role.
--      Signup-koden (src/lib/kontoOprettelse.ts) lægger billetten lige før
--      generateLink('signup') og sender nonce'et med som
--      options.data.bh_billet. Gælder 2 minutter og én gang. Mens
--      kun_inviterede er slået til, gives billetten kun, når beta er åben og
--      e-mailen har en aktiv invitation. { kode: 'ok' | 'ikke_tilladt' |
--      'ugyldig_email' | 'ugyldig_hash' }.
--   3. konto_oprettelse_tillad(p_staff, p_email, p_hash) - staff-billetten
--      (fx firmakonti, generateLink('invite') i adminErhverv.ts), nu med
--      nonce. Den gamle udgave uden hash fjernes.
--   4. beta_tjek_ny_bruger(p_email, p_billet) (kaldt af handle_new_user, FØR
--      public.users-rækken oprettes): enhver ny auth-bruger kræver en gyldig
--      billet til netop e-mailen, hvis hash passer med nonce'et i
--      raw_user_meta_data->>'bh_billet' - uanset kun_inviterede og uanset
--      dashboard-indstillingen. En direkte signUp har ikke nonce'et og
--      afvises (BHB01), også selvom serveren netop har lagt en billet til
--      samme e-mail. Billetten bruges (slettes) i samme insert.
--        - 'staff'-billet: godtages altid.
--        - 'signup'-billet: mens kun_inviterede er slået til, kræves desuden
--          stadig, at beta er åben og invitationen aktiv.
--      Undtaget er kun direkte SQL som postgres/supabase_admin (seed.sql,
--      migrationer, SQL-editoren). Supabase Auth skriver altid som
--      supabase_auth_admin og er ALDRIG undtaget.
--   5. handle_new_user sender nonce'et videre og fjerner bh_billet fra
--      raw_user_meta_data igen (bedst muligt - serveren fjerner den også med
--      updateUserById). Metadata bruges ikke længere til navn og vilkår ved
--      signup: dem sætter serveren først efter bekræftelsen, med oplysninger
--      fra den, der har koden (src/lib/kontoOprettelse.ts). Ellers som før.
--   6. beta_auth_bruger svarer også inviteret (auth.users.invited_at) og firma
--      (konto_type 'erhverv'), så signup-koden aldrig sender en ny
--      signup-kode til en inviteret konto/firmakonto (det ville ugyldiggøre
--      invitationslinket). kilde har ingen standardværdi.
--
-- kun_inviterede beholder sin betydning: slået til = kun inviterede (beta),
-- slået fra = åben tilmelding. Ved lancering sættes den stadig til false
-- (HUSKELISTE.md, "Lancering").
--
-- Kræver hjemmesidens nye signup-kode (src/lib/kontoOprettelse.ts og
-- adminErhverv.ts), som lægger billetten med nonce. Kørt FØR den kode er i
-- drift, afvises alle nye konti fra den gamle kode - og appens direkte signUp
-- afvises altid efter denne migration (appen skal bruge POST
-- /api/konto/opret, docs/APP-SIGNUP.md). Den nye kode virker også, før
-- migrationen er kørt (så gælder det gamle værn).
--
-- Drift-tjek: alt, der erstattes, skal være præcis som efter 20261017010000
-- (eller allerede som efter denne). Idempotent (kan køres igen). Kør først på
-- testdatabasen.

set local lock_timeout = '5s';

create or replace function pg_temp.plain_md5(p_fn text)
returns text language sql stable as $$
  select md5(replace(pr.prosrc, E'\r\n', E'\n')) from pg_proc pr where pr.oid = to_regprocedure(p_fn)
$$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek - før noget ændres
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- Efter 20261017010000 | efter denne.
  v_md5 := pg_temp.plain_md5('public.handle_new_user()');
  if v_md5 is null or v_md5 not in ('383bd3797481c94797bf65c52aa27890', '4c70da4677ef308aeaed83e825ff49b8') then
    raise exception 'handle_new_user er ændret uden for migrationerne (md5 %). Kør 20261017010000 først, eller tjek den.', v_md5;
  end if;

  -- De gamle udgaver (efter 20261017010000) fjernes af denne migration; findes
  -- de stadig, skal de være uændrede.
  v_md5 := pg_temp.plain_md5('public.beta_tjek_ny_bruger(text)');
  if v_md5 is not null and v_md5 <> '5186f0c3252fea62c87f19fc2f6342dd' then
    raise exception 'beta_tjek_ny_bruger er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text)');
  if v_md5 is not null and v_md5 <> 'ec63e632335753d3a76d09b270a4652a' then
    raise exception 'konto_oprettelse_tillad er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;

  -- De nye udgaver (genkørsel): skal være som efter denne.
  v_md5 := pg_temp.plain_md5('public.beta_tjek_ny_bruger(text, text)');
  if v_md5 is not null and v_md5 <> '663cd9b4456b145ee07e35fba621b39c' then
    raise exception 'beta_tjek_ny_bruger(text, text) er ændret uden for migrationerne (md5 %).', v_md5;
  end if;
  v_md5 := pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text, text)');
  if v_md5 is not null and v_md5 <> '1f5461f57487dcf2a659b7b72a72e67e' then
    raise exception 'konto_oprettelse_tillad(uuid, text, text) er ændret uden for migrationerne (md5 %).', v_md5;
  end if;
  v_md5 := pg_temp.plain_md5('public.konto_oprettelse_billet_signup(text, text)');
  if v_md5 is not null and v_md5 <> '78ac8009e704dd91dc32312215cad1e3' then
    raise exception 'konto_oprettelse_billet_signup er ændret uden for migrationerne (md5 %).', v_md5;
  end if;

  -- Efter 20261017010000 | efter denne.
  v_md5 := pg_temp.plain_md5('public.beta_auth_bruger(text)');
  if v_md5 is null or v_md5 not in ('80ace502f526a8749a0f424605442c61', '5aa0ee0b95bf2a8a4d8f31967b8725e6') then
    raise exception 'beta_auth_bruger er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Billet-tabellen: én række pr. nonce
-- ---------------------------------------------------------------------------
alter table public.konto_oprettelse_billetter
  add column if not exists kilde text,
  add column if not exists noegle_hash text;

-- Gamle billetter (uden nonce) kan ikke bruges længere.
delete from public.konto_oprettelse_billetter where noegle_hash is null or kilde is null;

-- Ingen standardværdi: hver billet skal sige, hvor den kommer fra (en
-- glemt kilde må aldrig blive til en staff-billet).
alter table public.konto_oprettelse_billetter
  alter column kilde drop default,
  alter column kilde set not null;

do $$
begin
  -- Den gamle primærnøgle var e-mailen (én billet pr. e-mail).
  if exists (select 1 from pg_constraint c
              where c.conrelid = 'public.konto_oprettelse_billetter'::regclass
                and c.contype = 'p'
                and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (email)') then
    execute (select format('alter table public.konto_oprettelse_billetter drop constraint %I', c.conname)
               from pg_constraint c
              where c.conrelid = 'public.konto_oprettelse_billetter'::regclass and c.contype = 'p');
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.konto_oprettelse_billetter'::regclass and c.contype = 'p') then
    alter table public.konto_oprettelse_billetter
      alter column noegle_hash set not null,
      add constraint konto_oprettelse_billetter_pkey primary key (noegle_hash);
  end if;
end $$;

alter table public.konto_oprettelse_billetter
  drop constraint if exists konto_oprettelse_billetter_kilde_check,
  drop constraint if exists konto_oprettelse_billetter_hash_check;
alter table public.konto_oprettelse_billetter
  add constraint konto_oprettelse_billetter_kilde_check check (kilde in ('staff', 'signup')),
  add constraint konto_oprettelse_billetter_hash_check check (noegle_hash ~ '^[0-9a-f]{64}$');

create index if not exists konto_oprettelse_billetter_email_idx
  on public.konto_oprettelse_billetter (email, udloeber_kl);

comment on table public.konto_oprettelse_billetter is
  'Kortlivet tilladelse til at oprette netop én auth-bruger (20261018010000). noegle_hash = hex SHA-256 af et nonce, som kun serveren kender og sender med som raw_user_meta_data.bh_billet. handle_new_user (beta_tjek_ny_bruger) kræver altid en. kilde staff: konto_oprettelse_tillad (fx firmakonti, 10 min.). kilde signup: konto_oprettelse_billet_signup (2 min.). Bruges én gang.';

-- ---------------------------------------------------------------------------
-- 3. Signup-billet (kun service_role - signup-koden på serveren)
-- ---------------------------------------------------------------------------
create or replace function public.konto_oprettelse_billet_signup(p_email text, p_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_hash  text := lower(btrim(coalesce(p_hash, '')));
  v_kun   boolean;
begin
  if char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('kode', 'ugyldig_email');
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('kode', 'ugyldig_hash');
  end if;

  -- Mangler rækken, gælder værnet (fail closed).
  select s.kun_inviterede into v_kun from public.beta_indstillinger s where s.id;
  if coalesce(v_kun, true) and not public.beta_tilmelding_tilladt(v_email) then
    return jsonb_build_object('kode', 'ikke_tilladt');
  end if;

  delete from public.konto_oprettelse_billetter b where b.udloeber_kl < now() - interval '1 day';
  -- Ny række pr. nonce - overskriver aldrig en anden billet (fx en staff-billet).
  insert into public.konto_oprettelse_billetter (email, oprettet_af, udloeber_kl, kilde, noegle_hash)
  values (v_email, null, now() + interval '2 minutes', 'signup', v_hash)
  on conflict (noegle_hash) do nothing;
  if not found then
    return jsonb_build_object('kode', 'ugyldig_hash');
  end if;
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.konto_oprettelse_billet_signup(text, text) from public, anon, authenticated;
grant execute on function public.konto_oprettelse_billet_signup(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Staff-billetten med nonce (fx opretFirmakonto). Den gamle fjernes.
-- ---------------------------------------------------------------------------
create or replace function public.konto_oprettelse_tillad(p_staff uuid, p_email text, p_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_hash  text := lower(btrim(coalesce(p_hash, '')));
begin
  if p_staff is null or not (public.staff_chat_har_rolle(p_staff, 'admin')
                             or public.erhverv_har_adgang(p_staff)) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('kode', 'ugyldig_email');
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('kode', 'ugyldig_hash');
  end if;
  delete from public.konto_oprettelse_billetter b where b.udloeber_kl < now() - interval '1 day';
  insert into public.konto_oprettelse_billetter (email, oprettet_af, udloeber_kl, kilde, noegle_hash)
  values (v_email, p_staff, now() + interval '10 minutes', 'staff', v_hash)
  on conflict (noegle_hash) do nothing;
  if not found then
    return jsonb_build_object('kode', 'ugyldig_hash');
  end if;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'konto_oprettelse_tilladt', 'beta',
          (select s.log_id from public.beta_indstillinger s where s.id), null, v_email);
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.konto_oprettelse_tillad(uuid, text, text) from public, anon, authenticated;
grant execute on function public.konto_oprettelse_tillad(uuid, text, text) to service_role;

drop function if exists public.konto_oprettelse_tillad(uuid, text);

-- ---------------------------------------------------------------------------
-- 5. Tilmeldingsværnet: billet + nonce altid (internt - kun fra handle_new_user)
-- ---------------------------------------------------------------------------
create or replace function public.beta_tjek_ny_bruger(p_email text, p_billet text)
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

  -- Billetten til netop denne e-mail OG netop dette nonce (som kun serveren
  -- kender). Bruges én gang. Uden den afvises enhver ny konto - også ved åben
  -- tilmelding, og også selvom der ligger en anden billet til e-mailen.
  if p_billet is not null and char_length(p_billet) between 16 and 200 then
    delete from public.konto_oprettelse_billetter b
     where b.noegle_hash = encode(sha256(convert_to(p_billet, 'UTF8')), 'hex')
       and b.email = v_email
       and b.udloeber_kl > now()
    returning b.kilde into v_kilde;
  end if;
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

revoke all on function public.beta_tjek_ny_bruger(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. handle_new_user: nonce videre, bh_billet ud af metadata
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_fornavn   text := left(nullif(btrim(new.raw_user_meta_data->>'fornavn'), ''), 100);
  v_efternavn text := left(nullif(btrim(new.raw_user_meta_data->>'efternavn'), ''), 100);
  v_navn      text := left(nullif(btrim(new.raw_user_meta_data->>'navn'), ''), 200);
  v_vilkaar   text := case
                        when new.raw_user_meta_data->>'vilkaar_version' = public.vilkaar_aktuel_version()
                        then public.vilkaar_aktuel_version()
                      end;
begin
  -- Billet + nonce fra serveren kræves altid (20261018010000).
  perform public.beta_tjek_ny_bruger(new.email, new.raw_user_meta_data->>'bh_billet');
  if public.navn_har_kontaktinfo(v_fornavn) then v_fornavn := null; end if;
  if public.navn_har_kontaktinfo(v_efternavn) then v_efternavn := null; end if;
  if public.navn_har_kontaktinfo(v_navn) then v_navn := null; end if;
  if v_navn is null then
    v_navn := nullif(btrim(concat_ws(' ', v_fornavn, v_efternavn)), '');
  end if;
  insert into public.users (id, navn, fornavn, efternavn, email, telefon,
                            vilkaar_version, vilkaar_accepteret_kl)
  values (
    new.id,
    coalesce(v_navn, 'Bruger'),
    v_fornavn,
    v_efternavn,
    new.email,
    new.raw_user_meta_data->>'telefon',
    v_vilkaar,
    case when v_vilkaar is not null then now() end
  );
  update public.beta_invitationer i
     set bruger_id = new.id, konto_oprettet_kl = now(), opdateret_kl = now()
   where i.email = lower(btrim(new.email)) and i.bruger_id is null;
  -- Nonce'et må ikke blive liggende i metadata (det er brugt). Bedst muligt:
  -- serveren fjerner det også (updateUserById).
  if new.raw_user_meta_data ? 'bh_billet' then
    begin
      update auth.users u
         set raw_user_meta_data = u.raw_user_meta_data - 'bh_billet'
       where u.id = new.id;
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$function$;

drop function if exists public.beta_tjek_ny_bruger(text);

-- ---------------------------------------------------------------------------
-- 6b. beta_auth_bruger: også om kontoen er inviteret (invited_at, fx en
--     firmakonto fra Admin -> Erhverv) eller er en firmakonto. Signup-koden
--     sender så ingen ny signup-kode til den - ellers kunne en fremmed
--     ugyldiggøre firmaets invitationslink. Svaret til kalderen er stadig
--     neutralt. { findes: false } eller { findes: true, id, bekraeftet,
--     inviteret, firma }.
-- ---------------------------------------------------------------------------
create or replace function public.beta_auth_bruger(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
              'findes', true,
              'id', u.id,
              'bekraeftet', u.email_confirmed_at is not null,
              'inviteret', u.invited_at is not null,
              'firma', exists (select 1 from public.users p
                                where p.id = u.id and p.konto_type = 'erhverv'))
       from auth.users u
      where lower(u.email) = lower(btrim(coalesce(p_email, '')))
      order by u.created_at
      limit 1),
    jsonb_build_object('findes', false))
$$;

revoke all on function public.beta_auth_bruger(text) from public, anon, authenticated;
grant execute on function public.beta_auth_bruger(text) to service_role;

comment on table public.beta_indstillinger is
  'Beta-testen: beta_aaben (kontakten i Admin -> Beta-invitationer, kun chef) og kun_inviterede (slået til: kun inviterede kan få en signup-billet; slås fra ved lancering). En ny konto kræver altid en billet med nonce (20261018010000). Én række.';

-- ---------------------------------------------------------------------------
-- 7. Kontrol
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.plain_md5('public.handle_new_user()') is distinct from '4c70da4677ef308aeaed83e825ff49b8' then
    raise exception 'handle_new_user blev ikke opdateret som forventet (md5 %).', pg_temp.plain_md5('public.handle_new_user()');
  end if;
  if pg_temp.plain_md5('public.beta_tjek_ny_bruger(text, text)') is distinct from '663cd9b4456b145ee07e35fba621b39c' then
    raise exception 'beta_tjek_ny_bruger blev ikke opdateret som forventet (md5 %).', pg_temp.plain_md5('public.beta_tjek_ny_bruger(text, text)');
  end if;
  if pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text, text)') is distinct from '1f5461f57487dcf2a659b7b72a72e67e' then
    raise exception 'konto_oprettelse_tillad blev ikke opdateret som forventet (md5 %).', pg_temp.plain_md5('public.konto_oprettelse_tillad(uuid, text, text)');
  end if;
  if pg_temp.plain_md5('public.konto_oprettelse_billet_signup(text, text)') is distinct from '78ac8009e704dd91dc32312215cad1e3' then
    raise exception 'konto_oprettelse_billet_signup blev ikke oprettet som forventet (md5 %).', pg_temp.plain_md5('public.konto_oprettelse_billet_signup(text, text)');
  end if;
  if pg_temp.plain_md5('public.beta_auth_bruger(text)') is distinct from '5aa0ee0b95bf2a8a4d8f31967b8725e6' then
    raise exception 'beta_auth_bruger blev ikke opdateret som forventet (md5 %).', pg_temp.plain_md5('public.beta_auth_bruger(text)');
  end if;
  if to_regprocedure('public.beta_tjek_ny_bruger(text)') is not null
     or to_regprocedure('public.konto_oprettelse_tillad(uuid, text)') is not null then
    raise exception 'De gamle udgaver af beta_tjek_ny_bruger/konto_oprettelse_tillad findes stadig.';
  end if;
end $$;
