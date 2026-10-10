-- Erhverv: chef og sælger-rollen kan gøre alt ved firmaer - også på
-- hjemmesiden (Filip, 10. okt. 2026). Bygger på 20261016020000_erhverv_klager.sql.
--
--   A2. Ny bruger_ophaev_suspension(p_staff, p_bruger) (kun service_role):
--       ophæver en suspension og logger i moderation_log. Bruges af "Ophæv
--       suspension" på brugersiden (unsuspendUser) og under Admin → Erhverv
--       → Firmaer. En PERMANENT suspension af en firmakonto kan kun ophæves
--       af chef eller sælger-rollen ('kun_erhverv'). Andre suspensioner:
--       medarbejder+ som før; en midlertidig suspension af en firmakonto kan
--       også ophæves af sælger-rollen. En lukket konto åbnes aldrig ('lukket').
--   A3. 'saelger' er en staff-konto: bruger_luk_konto_permanent svarer
--       'staff' (lukkes ikke som en almindelig bruger), og dsa_indgreb lukker
--       heller ikke en sælger-medarbejder (som for medarbejder: suspension er
--       stadig mulig for admin).
--
-- Drift-tjek mod efter-tilstanden af 20261016020000 og tekst-erstatning (som
-- 20261016010000_fjern_gemte_soegninger.sql). Idempotent (kan køres igen).
-- Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælpere (som 20261016020000)
-- ---------------------------------------------------------------------------
create or replace function pg_temp.krop_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(regexp_replace(replace(pr.prosrc, E'\r\n', E'\n'),
                            E'^[ \t]*(--[^\n]*)?\n', '', 'gn'))
    from pg_proc pr where pr.oid = p_fn
$$;

create or replace function pg_temp.plain_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(replace(pr.prosrc, E'\r\n', E'\n')) from pg_proc pr where pr.oid = p_fn
$$;

create or replace function pg_temp.ret_krop(p regprocedure, p_gl text, p_ny text)
returns void language plpgsql as $$
declare
  v_def text := replace(pg_get_functiondef(p), E'\r\n', E'\n');
  v_n   integer;
begin
  v_n := (length(v_def) - length(replace(v_def, p_gl, ''))) / nullif(length(p_gl), 0);
  if v_n is distinct from 1 then
    raise exception '%: forventet tekst fundet % gange (skal være 1) - ret manuelt', p, coalesce(v_n, 0);
  end if;
  execute replace(v_def, p_gl, p_ny);
end $$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek af alt, der ændres - før noget ændres.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- 20261016020000 (før) | denne (efter). Plain md5 (prosrc, CRLF -> LF).
  v_md5 := pg_temp.plain_md5('public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)'::regprocedure);
  if v_md5 not in ('4fc2013bded2e3dd6b92d8a8d43f354f', '7b95ccc9aa48b88c4f0b1c0f5abf1420') then
    raise exception 'bruger_luk_konto_permanent er ændret uden for migrationerne (md5 %). Kør 20261016020000 først, eller tjek den.', v_md5;
  end if;
  -- Normaliseret md5: efter 20261016020000 på prod | på test (uden
  -- kommentarer) | efter denne på prod | efter denne på test.
  v_md5 := pg_temp.krop_md5('public.dsa_indgreb(uuid, text, uuid, text, text, text, text, uuid, boolean, jsonb)'::regprocedure);
  if v_md5 not in ('79542a6bc6c86d1c409e960e87e091a8', 'a189b160bb59852f20fddf24fcc4a5e3',
                   '5dde8d1a7c2a397b1b4a296f962ba2b9', '0689034919905937d0d4a3c67cca982e') then
    raise exception 'dsa_indgreb er ændret uden for migrationerne (md5 %). Kør 20261016020000 først, eller tjek den.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. A3: 'saelger' er staff
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.plain_md5('public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)'::regprocedure)
     = '4fc2013bded2e3dd6b92d8a8d43f354f' then
    perform pg_temp.ret_krop('public.bruger_luk_konto_permanent(uuid, uuid, text, uuid)'::regprocedure,
      E'  if u.rolle in (''medarbejder'', ''admin'', ''chef'') then\n',
      E'  if u.rolle in (''medarbejder'', ''admin'', ''chef'', ''saelger'') then\n');
  end if;

  if pg_temp.krop_md5('public.dsa_indgreb(uuid, text, uuid, text, text, text, text, uuid, boolean, jsonb)'::regprocedure)
     in ('79542a6bc6c86d1c409e960e87e091a8', 'a189b160bb59852f20fddf24fcc4a5e3') then
    perform pg_temp.ret_krop(
      'public.dsa_indgreb(uuid, text, uuid, text, text, text, text, uuid, boolean, jsonb)'::regprocedure,
      E'    if u.rolle in (''admin'', ''chef'') or (p_handling = ''konto_lukket'' and u.rolle = ''medarbejder'') then\n',
      E'    if u.rolle in (''admin'', ''chef'') or (p_handling = ''konto_lukket'' and u.rolle in (''medarbejder'', ''saelger'')) then\n');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. A2: ophæv suspension (med rolle-tjek)
-- ---------------------------------------------------------------------------
-- { kode: 'ok' } eller ingen_adgang | kun_erhverv | ugyldig_bruger | sig_selv |
-- lukket (permanent lukket - åbnes aldrig) | uaendret (ikke suspenderet).
create or replace function public.bruger_ophaev_suspension(p_staff uuid, p_bruger uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  u          record;
  v_staff    boolean := public.staff_chat_har_rolle(p_staff, 'medarbejder');
  v_erhverv  boolean := public.erhverv_har_adgang(p_staff);
  v_permanent boolean;
begin
  if p_staff is null or not (v_staff or v_erhverv) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return jsonb_build_object('kode', 'ugyldig_bruger');
  end if;
  if p_bruger = p_staff then return jsonb_build_object('kode', 'sig_selv'); end if;

  select x.id, x.konto_type, x.suspenderet, x.suspenderet_til, x.konto_lukket_kl into u
    from public.users x where x.id = p_bruger for update;
  if not found then return jsonb_build_object('kode', 'ugyldig_bruger'); end if;
  if u.konto_lukket_kl is not null then return jsonb_build_object('kode', 'lukket'); end if;
  if not coalesce(u.suspenderet, false) then return jsonb_build_object('kode', 'uaendret'); end if;

  v_permanent := u.suspenderet_til is null;
  if u.konto_type = 'erhverv' then
    -- Permanent: kun chef og sælger-rollen. Midlertidig: også medarbejder+.
    if v_permanent and not v_erhverv then
      return jsonb_build_object('kode', 'kun_erhverv');
    end if;
  elsif not v_staff then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  update public.users
     set suspenderet = false,
         suspenderet_aarsag = null,
         suspenderet_kl = null,
         suspenderet_til = null
   where id = p_bruger and suspenderet;
  if not found then return jsonb_build_object('kode', 'uaendret'); end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_staff, 'ophaev_suspension', 'bruger', p_bruger, p_bruger,
          case when v_permanent then 'Suspension ophævet (var permanent)' else 'Suspension ophævet' end);

  return jsonb_build_object('kode', 'ok');
end;
$$;
revoke all on function public.bruger_ophaev_suspension(uuid, uuid) from public, anon, authenticated;
grant execute on function public.bruger_ophaev_suspension(uuid, uuid) to service_role;
