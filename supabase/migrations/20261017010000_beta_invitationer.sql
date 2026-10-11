-- Beta-test: invitationsliste (Filip sagde ja 11. okt. 2026). Se
-- docs/BETA-TEST.md afsnit 3 og HUSKELISTE.md under "Beta-test".
--
-- Før lancering er bidhamr.dk lukket (coming-soon), og tilmeldingen er lukket
-- (TILMELDING_AABEN ikke 'true'). Med denne migration kan staff invitere
-- testpersoner, som så kan oprette sig og bruge den private del af siden
-- (ikke admin). Alle andre ser stadig coming-soon.
--
--   1. Tabeller (ASCII-navne, RLS slået til, INGEN grants til anon/
--      authenticated - kun via RPC'erne herunder og service_role):
--      beta_indstillinger      én række: beta_aaben (kontakten "Beta åben/
--                              lukket", kun chef) og kun_inviterede (databasens
--                              tilmeldingsværn, se 3).
--      beta_invitationer       én række pr. e-mail (normaliseret: trim +
--                              lowercase). Status udledes: tilbagekaldt
--                              (tilbagekaldt_kl), MitID-verificeret
--                              (users.mitid_verificeret_kl), oprettet konto
--                              (bruger_id) eller inviteret.
--      konto_oprettelse_billetter  kortlivet tilladelse (10 min.), som staff-
--                              koden lægger, før den selv opretter en konto via
--                              admin-API'et (firmakonti, opretFirmakonto). Bruges
--                              én gang af handle_new_user.
--   2. Staff (kun service_role; p_staff kommer fra serveren efter assertRole,
--      databasen tjekker rollen igen med staff_chat_har_rolle):
--      beta_oversigt(p_staff)                 admin+
--      beta_inviter(p_staff, p_email, p_note) admin+ (ny eller genaktivér)
--      beta_send_igen(p_staff, p_id)          admin+
--      beta_tilbagekald(p_staff, p_id)        admin+
--      beta_saet_aaben(p_staff, p_aaben)      KUN chef
--      konto_oprettelse_tillad(p_staff, p_email)  staff eller erhverv (chef/saelger)
--      Alle ændringer logges i moderation_log. Statusskift er idempotente
--      (update ... where <gammel status>), så dobbeltklik ikke logger to gange.
--      Rate limit i databasen: højst 60 nye/genaktiverede invitationer pr.
--      staff pr. time; en invitation kan højst sendes 10 gange og højst én
--      gang i minuttet.
--   3. Tilmeldingsværn i databasen: handle_new_user kalder
--      beta_tjek_ny_bruger(email), FØR public.users-rækken oprettes. Er
--      kun_inviterede slået til, afvises en ny auth-bruger (errcode BHB01),
--      medmindre beta er åben og e-mailen har en aktiv invitation, eller der
--      ligger en billet (konto_oprettelse_billetter). Det gælder ALLE veje ind
--      via Supabase Auth (signUp med anon-nøglen, admin-API, dashboardet),
--      fordi GoTrue altid skriver som rollen supabase_auth_admin. Kun direkte
--      SQL som postgres/supabase_admin (seed.sql, migrationer) er undtaget.
--      Ved oprettelse sættes invitationens bruger_id (status "oprettet konto").
--      VED LANCERING: sæt kun_inviterede = false (migration med Filips ja),
--      samtidig med TILMELDING_AABEN=true i Vercel - se HUSKELISTE.md.
--      På testdatabasen sættes kun_inviterede = false af denne migration
--      (genkendes på seed-brugeren tester@test.bidhamr.dk, og test@t.com
--      findes ikke), så signup på testdatabasen virker som før.
--   4. Gaten (src/lib/supabase/middleware.ts) spørger min_beta_adgang()
--      (authenticated, auth.uid()) og gemmer svaret i den signerede
--      rolle-cookie i højst 5 minutter.
--   5. Signup-actionen (opretKonto) spørger beta_tilmelding_tilladt(p_email)
--      (kun service_role), før den opretter kontoen.
--
-- Drift-tjek: handle_new_user erstattes kun, hvis den er præcis som efter
-- 20261009050000_vilkaar_accept.sql (eller allerede som efter denne).
-- Idempotent (kan køres igen). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælpere (som 20261016050000)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.plain_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(replace(pr.prosrc, E'\r\n', E'\n')) from pg_proc pr where pr.oid = p_fn
$$;

create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek af alt, der ændres - før noget ændres.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- Efter 20261009050000 | efter denne. Plain md5 (prosrc, CRLF -> LF).
  v_md5 := pg_temp.plain_md5('public.handle_new_user()'::regprocedure);
  if v_md5 not in ('65526f1eb3aaa6b7ee43f20844d107f4', '383bd3797481c94797bf65c52aa27890') then
    raise exception 'handle_new_user er ændret uden for migrationerne (md5 %). Kør 20261009050000 først, eller tjek den.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. moderation_log: nye handlinger og mål
-- ---------------------------------------------------------------------------
select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_maal_type_check', 'maal_type',
  array['beta_invitation', 'beta']);

select pg_temp.flet_check('public.moderation_log'::regclass, 'moderation_log_handling_check', 'handling',
  array['beta_inviteret', 'beta_genaktiveret', 'beta_sendt_igen', 'beta_tilbagekaldt',
        'beta_aabnet', 'beta_lukket', 'konto_oprettelse_tilladt']);

-- ---------------------------------------------------------------------------
-- 3. Tabeller
-- ---------------------------------------------------------------------------
create table if not exists public.beta_indstillinger (
  id             boolean primary key default true check (id),
  -- Fast id til moderation_log.maal_id (kolonnen er uuid not null).
  log_id         uuid not null default '00000000-0000-4000-8000-0000000be7a0',
  -- Kontakten "Beta åben/lukket" (kun chef). Lukket: ingen beta-bruger kommer
  -- forbi gaten, og inviterede kan ikke oprette sig. Data bevares.
  beta_aaben     boolean not null default false,
  -- Databasens tilmeldingsværn (se toppen, punkt 3). Slås fra ved lancering.
  kun_inviterede boolean not null default true,
  opdateret_kl   timestamptz not null default now(),
  opdateret_af   uuid references public.users(id) on delete set null
);

comment on table public.beta_indstillinger is
  'Beta-testen: beta_aaben (kontakten i Admin -> Beta-invitationer, kun chef) og kun_inviterede (handle_new_user afviser nye konti uden aktiv invitation; slås fra ved lancering). Én række.';

-- Testdatabasen: tilmeldingen er altid åben dér (src/lib/tilmelding.ts), så
-- databasens værn starter slået fra. Produktion: slået til (fail closed).
insert into public.beta_indstillinger (id, kun_inviterede)
select true,
       not (exists (select 1 from auth.users where lower(email) = 'tester@test.bidhamr.dk')
            and not exists (select 1 from auth.users where lower(email) = 'test@t.com'))
on conflict (id) do nothing;

create table if not exists public.beta_invitationer (
  id                uuid primary key default gen_random_uuid(),
  email             text not null
                    check (email = lower(btrim(email))
                           and char_length(email) between 3 and 320
                           and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  note              text check (note is null or char_length(note) <= 500),
  inviteret_af      uuid references public.users(id) on delete set null,
  inviteret_kl      timestamptz not null default now(),
  sidst_sendt_kl    timestamptz,
  antal_sendt       integer not null default 0 check (antal_sendt >= 0),
  -- Sættes af handle_new_user ved oprettelse (eller ved invitationen, hvis
  -- e-mailen allerede har en konto).
  bruger_id         uuid references public.users(id) on delete set null,
  konto_oprettet_kl timestamptz,
  tilbagekaldt_kl   timestamptz,
  tilbagekaldt_af   uuid references public.users(id) on delete set null,
  opdateret_kl      timestamptz not null default now()
);

create unique index if not exists beta_invitationer_email_uniq on public.beta_invitationer (email);
create index if not exists beta_invitationer_bruger_idx on public.beta_invitationer (bruger_id)
  where bruger_id is not null;
create index if not exists beta_invitationer_inviteret_af_idx on public.beta_invitationer (inviteret_af, inviteret_kl desc);

comment on table public.beta_invitationer is
  'Invitationer til beta-testen (Admin -> Beta-invitationer). Én række pr. normaliseret e-mail. Tilbagekaldes (tilbagekaldt_kl) i stedet for at slettes.';

create table if not exists public.konto_oprettelse_billetter (
  email        text primary key check (email = lower(btrim(email)) and char_length(email) <= 320),
  oprettet_af  uuid references public.users(id) on delete set null,
  udloeber_kl  timestamptz not null
);

comment on table public.konto_oprettelse_billetter is
  'Kortlivet tilladelse til, at staff-koden opretter en konto (fx firmakonto), mens tilmeldingen kun er for inviterede. Bruges én gang af handle_new_user.';

alter table public.beta_indstillinger enable row level security;
alter table public.beta_invitationer enable row level security;
alter table public.konto_oprettelse_billetter enable row level security;
revoke all on table public.beta_indstillinger from public, anon, authenticated;
revoke all on table public.beta_invitationer from public, anon, authenticated;
revoke all on table public.konto_oprettelse_billetter from public, anon, authenticated;
grant select, insert, update on table public.beta_indstillinger to service_role;
grant select, insert, update on table public.beta_invitationer to service_role;
grant select, insert, update, delete on table public.konto_oprettelse_billetter to service_role;

-- ---------------------------------------------------------------------------
-- 4. Tilmeldingsværnet (internt - kaldes kun fra handle_new_user)
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
begin
  select s.beta_aaben, s.kun_inviterede into v_aaben, v_kun
    from public.beta_indstillinger s where s.id;
  -- Mangler rækken, gælder værnet (fail closed).
  if found and not v_kun then return; end if;

  -- Direkte SQL som databasens ejer (seed.sql, migrationer, SQL-editoren).
  -- Supabase Auth skriver altid som supabase_auth_admin og er ALDRIG undtaget.
  -- session_user påvirkes ikke af security definer.
  if session_user in ('postgres', 'supabase_admin') then return; end if;

  -- Billet fra staff-koden (fx opretFirmakonto). Bruges én gang.
  delete from public.konto_oprettelse_billetter b
   where b.email = v_email and b.udloeber_kl > now();
  if found then return; end if;

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
-- 5. handle_new_user: værnet + kobling til invitationen
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
  -- Beta: kun inviterede kan oprette sig før lancering (20261017010000).
  perform public.beta_tjek_ny_bruger(new.email);
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
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Staff-RPC'er (kun service_role)
-- ---------------------------------------------------------------------------
-- Status pr. invitation (samme regel i oversigten og i svarene).
create or replace function public.beta_status(p_tilbagekaldt timestamptz, p_bruger uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p_tilbagekaldt is not null then 'tilbagekaldt'
           when p_bruger is null then 'inviteret'
           when exists (select 1 from public.users u
                         where u.id = p_bruger and u.mitid_verificeret_kl is not null) then 'mitid'
           else 'oprettet'
         end
$$;

revoke all on function public.beta_status(timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.beta_status(timestamptz, uuid) to service_role;

-- { kode: 'ok', beta_aaben, kun_inviterede, opdateret_kl, invitationer: [...] }
-- eller { kode: 'ingen_adgang' }. Højst de 2000 nyeste.
create or replace function public.beta_oversigt(p_staff uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s record;
begin
  if p_staff is null or not public.staff_chat_har_rolle(p_staff, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select x.beta_aaben, x.kun_inviterede, x.opdateret_kl into s
    from public.beta_indstillinger x where x.id;

  return jsonb_build_object(
    'kode', 'ok',
    'beta_aaben', coalesce(s.beta_aaben, false),
    'kun_inviterede', coalesce(s.kun_inviterede, true),
    'opdateret_kl', s.opdateret_kl,
    'invitationer', coalesce((
      select jsonb_agg(r order by r.inviteret_kl desc)
        from (
          select i.id, i.email, i.note, i.inviteret_kl, i.sidst_sendt_kl, i.antal_sendt,
                 i.konto_oprettet_kl, i.tilbagekaldt_kl, i.bruger_id,
                 public.beta_status(i.tilbagekaldt_kl, i.bruger_id) as status,
                 (select u.mitid_verificeret_kl from public.users u where u.id = i.bruger_id) as mitid_kl,
                 (select u.navn from public.users u where u.id = i.inviteret_af) as inviteret_af_navn
            from public.beta_invitationer i
           order by i.inviteret_kl desc
           limit 2000
        ) r), '[]'::jsonb));
end $$;

revoke all on function public.beta_oversigt(uuid) from public, anon, authenticated;
grant execute on function public.beta_oversigt(uuid) to service_role;

-- Ny invitation, eller genaktivér en tilbagekaldt. Svar:
-- { kode: 'ok', id, email, genaktiveret, har_konto } eller
-- ingen_adgang | ugyldig_email | ugyldig_note | for_mange |
-- findes (aktiv invitation findes allerede: brug "Send igen") + id.
create or replace function public.beta_inviter(p_staff uuid, p_email text, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_note   text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:space:]]+', ' ', 'g')), '');
  v_id     uuid;
  v_bruger uuid;
  r        record;
begin
  if p_staff is null or not public.staff_chat_har_rolle(p_staff, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return jsonb_build_object('kode', 'ugyldig_email');
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    return jsonb_build_object('kode', 'ugyldig_note');
  end if;

  -- Rate limit: 60 nye/genaktiverede pr. staff pr. time (moderation_log).
  if (select count(*) from public.moderation_log m
       where m.medarbejder_id = p_staff
         and m.handling in ('beta_inviteret', 'beta_genaktiveret')
         and m.oprettet_kl > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('kode', 'for_mange');
  end if;

  -- Har e-mailen allerede en konto (fx en eksisterende testbruger)?
  select u.id into v_bruger from public.users u
   where lower(btrim(u.email)) = v_email and u.konto_slettet_kl is null
   order by u.id limit 1;

  insert into public.beta_invitationer (email, note, inviteret_af, sidst_sendt_kl, antal_sendt,
                                        bruger_id, konto_oprettet_kl)
  values (v_email, v_note, p_staff, now(), 1, v_bruger, null)
  on conflict (email) do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
    values (p_staff, 'beta_inviteret', 'beta_invitation', v_id, v_bruger,
            left(v_email || coalesce(' - ' || v_note, ''), 1000));
    return jsonb_build_object('kode', 'ok', 'id', v_id, 'email', v_email,
                              'genaktiveret', false, 'har_konto', v_bruger is not null);
  end if;

  select i.* into r from public.beta_invitationer i where i.email = v_email for update;
  if r.tilbagekaldt_kl is null then
    return jsonb_build_object('kode', 'findes', 'id', r.id);
  end if;

  -- Genaktivér (idempotent: kun hvis stadig tilbagekaldt).
  update public.beta_invitationer i
     set tilbagekaldt_kl = null, tilbagekaldt_af = null,
         note = coalesce(v_note, i.note),
         bruger_id = coalesce(i.bruger_id, v_bruger),
         sidst_sendt_kl = now(), antal_sendt = i.antal_sendt + 1, opdateret_kl = now()
   where i.id = r.id and i.tilbagekaldt_kl is not null
  returning i.bruger_id into v_bruger;
  if not found then
    return jsonb_build_object('kode', 'findes', 'id', r.id);
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'beta_genaktiveret', 'beta_invitation', r.id, v_bruger,
          left(v_email || coalesce(' - ' || v_note, ''), 1000));
  return jsonb_build_object('kode', 'ok', 'id', r.id, 'email', v_email,
                            'genaktiveret', true, 'har_konto', v_bruger is not null);
end $$;

revoke all on function public.beta_inviter(uuid, text, text) from public, anon, authenticated;
grant execute on function public.beta_inviter(uuid, text, text) to service_role;

-- Send invitationsmailen igen. { kode: 'ok', email, har_konto } eller
-- ingen_adgang | ikke_fundet | tilbagekaldt | for_hurtigt (under 1 min.
-- siden sidst) | for_mange (sendt 10 gange).
create or replace function public.beta_send_igen(p_staff uuid, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if p_staff is null or not public.staff_chat_har_rolle(p_staff, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select i.* into r from public.beta_invitationer i where i.id = p_id for update;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if r.tilbagekaldt_kl is not null then return jsonb_build_object('kode', 'tilbagekaldt'); end if;
  if r.antal_sendt >= 10 then return jsonb_build_object('kode', 'for_mange'); end if;

  update public.beta_invitationer i
     set sidst_sendt_kl = now(), antal_sendt = i.antal_sendt + 1, opdateret_kl = now()
   where i.id = p_id and i.tilbagekaldt_kl is null
     and (i.sidst_sendt_kl is null or i.sidst_sendt_kl < now() - interval '1 minute');
  if not found then return jsonb_build_object('kode', 'for_hurtigt'); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'beta_sendt_igen', 'beta_invitation', r.id, r.bruger_id, r.email);
  return jsonb_build_object('kode', 'ok', 'email', r.email, 'har_konto', r.bruger_id is not null);
end $$;

revoke all on function public.beta_send_igen(uuid, uuid) from public, anon, authenticated;
grant execute on function public.beta_send_igen(uuid, uuid) to service_role;

-- Tilbagekald én invitation. Kontoen og dens data bevares - brugeren kommer
-- bare ikke længere forbi gaten (inden for højst 5 min., rolle-cookien).
-- { kode: 'ok' } | ingen_adgang | ikke_fundet | uaendret (allerede tilbagekaldt).
create or replace function public.beta_tilbagekald(p_staff uuid, p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email  text;
  v_bruger uuid;
begin
  if p_staff is null or not public.staff_chat_har_rolle(p_staff, 'admin') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  update public.beta_invitationer i
     set tilbagekaldt_kl = now(), tilbagekaldt_af = p_staff, opdateret_kl = now()
   where i.id = p_id and i.tilbagekaldt_kl is null
  returning i.email, i.bruger_id into v_email, v_bruger;
  if not found then
    if exists (select 1 from public.beta_invitationer i where i.id = p_id) then
      return jsonb_build_object('kode', 'uaendret');
    end if;
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'beta_tilbagekaldt', 'beta_invitation', p_id, v_bruger, v_email);
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.beta_tilbagekald(uuid, uuid) from public, anon, authenticated;
grant execute on function public.beta_tilbagekald(uuid, uuid) to service_role;

-- Kontakten "Beta åben/lukket" - KUN chef. { kode: 'ok', beta_aaben } |
-- ingen_adgang | uaendret.
create or replace function public.beta_saet_aaben(p_staff uuid, p_aaben boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_log uuid;
begin
  if p_staff is null or p_aaben is null or not public.staff_chat_har_rolle(p_staff, 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  update public.beta_indstillinger s
     set beta_aaben = p_aaben, opdateret_kl = now(), opdateret_af = p_staff
   where s.id and s.beta_aaben is distinct from p_aaben
  returning s.log_id into v_log;
  if not found then return jsonb_build_object('kode', 'uaendret', 'beta_aaben', p_aaben); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, case when p_aaben then 'beta_aabnet' else 'beta_lukket' end, 'beta', v_log, null,
          case when p_aaben then 'Beta-testen er åbnet' else 'Beta-testen er lukket' end);
  return jsonb_build_object('kode', 'ok', 'beta_aaben', p_aaben);
end $$;

revoke all on function public.beta_saet_aaben(uuid, boolean) from public, anon, authenticated;
grant execute on function public.beta_saet_aaben(uuid, boolean) to service_role;

-- Billet til, at staff-koden selv opretter en konto (fx opretFirmakonto),
-- mens tilmeldingen kun er for inviterede. Gælder 10 minutter, én gang.
-- { kode: 'ok' } | ingen_adgang | ugyldig_email.
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
  insert into public.konto_oprettelse_billetter (email, oprettet_af, udloeber_kl)
  values (v_email, p_staff, now() + interval '10 minutes')
  on conflict (email) do update set oprettet_af = excluded.oprettet_af, udloeber_kl = excluded.udloeber_kl;
  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'konto_oprettelse_tilladt', 'beta',
          (select s.log_id from public.beta_indstillinger s where s.id), null, v_email);
  return jsonb_build_object('kode', 'ok');
end $$;

revoke all on function public.konto_oprettelse_tillad(uuid, text) from public, anon, authenticated;
grant execute on function public.konto_oprettelse_tillad(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Signup-actionen (kun service_role): må denne e-mail oprette sig nu?
-- ---------------------------------------------------------------------------
create or replace function public.beta_tilmelding_tilladt(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.beta_aaben from public.beta_indstillinger s where s.id), false)
     and exists (select 1 from public.beta_invitationer i
                  where i.email = lower(btrim(coalesce(p_email, '')))
                    and i.tilbagekaldt_kl is null)
$$;

revoke all on function public.beta_tilmelding_tilladt(text) from public, anon, authenticated;
grant execute on function public.beta_tilmelding_tilladt(text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Gaten (authenticated): har den indloggede bruger beta-adgang lige nu?
-- ---------------------------------------------------------------------------
create or replace function public.min_beta_adgang()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.beta_aaben from public.beta_indstillinger s where s.id), false)
     and (select auth.uid()) is not null
     and exists (select 1 from public.beta_invitationer i
                  where i.bruger_id = (select auth.uid())
                    and i.tilbagekaldt_kl is null)
$$;

revoke all on function public.min_beta_adgang() from public, anon;
grant execute on function public.min_beta_adgang() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Kontrol: handle_new_user er nu den nye udgave.
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.plain_md5('public.handle_new_user()'::regprocedure) <> '383bd3797481c94797bf65c52aa27890' then
    raise exception 'handle_new_user blev ikke opdateret som forventet (md5 %).',
      pg_temp.plain_md5('public.handle_new_user()'::regprocedure);
  end if;
end $$;
