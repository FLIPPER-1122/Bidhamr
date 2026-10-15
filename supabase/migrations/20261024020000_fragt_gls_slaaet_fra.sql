-- GLS er slået fra, indtil Shipmondo har svaret (Filip, 15. okt. 2026 -
-- ROADMAP-BESLUTNINGER, "Beslutninger (Filip, 15. okt. 2026)"). Køberen må
-- ikke kunne vælge GLS i checkout, før Shipmondo har svaret på, om GLS kan
-- sendes labelfrit. GLS slås til med SHIPMONDO_GLS_AKTIV=true på serveren
-- (standard: fra; fail closed).
--
--   handel_gem_levering afviser transportoer = 'gls' ved Shipmondo med koden
--   'gls_lukket', medmindre serveren sender gls_aktiv = true i p_valg (det
--   gør den kun, når SHIPMONDO_GLS_AKTIV=true - src/lib/fragt/server.ts).
--   Funktionen kaldes kun med service-role; værnet sikrer, at en kodevej, der
--   glemmer tjekket (eller gammel kode), aldrig gemmer GLS.
--
--   Eksisterende GLS-valg og -forsendelser røres ikke: labels, sporing,
--   webhooks og retur (forsendelser.transportoer) virker videre. Kun nye valg
--   i checkout afvises.
--
-- Rettes på stedet med md5-drift-tjek (mønstret fra 20261024010000):
-- "gammel" = efter 20261024010000 (hentet med SELECT på testdatabasen 15. okt.
-- 2026), "ny" = efter denne migration. Andet afbryder migrationen.
--
-- Kræver 20261024010000. Idempotent (kan køres igen). Én transaktion: filen
-- køres som én samlet forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'handel_levering'
                    and column_name = 'transportoer') then
    raise exception 'Forudsætning mangler: kør 20261024010000_fragt_shipmondo_transportoer.sql først';
  end if;
end $do$;

-- ===========================================================================
-- Hjælpere (kun i denne session) - som i 20261024010000
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

create or replace function pg_temp.ps_ret(p_fn text, p_gammel text, p_ny text, p_par jsonb)
returns text
language plpgsql
as $f$
declare
  v_def text;
  e     jsonb;
  n     integer;
  v_gl  text;
  v_ny  text;
  h     text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke - kør de tidligere fragt-migrationer først', p_fn;
  end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  v_def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  for e in select * from jsonb_array_elements(p_par) loop
    v_gl := replace(e->>0, chr(13), '');
    v_ny := replace(e->>1, chr(13), '');
    n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
    if n <> (e->>2)::integer then
      raise exception '%: forventede % forekomst(er) af "%", fandt %', p_fn, e->>2, v_gl, n;
    end if;
    v_def := replace(v_def, v_gl, v_ny);
  end loop;
  execute v_def;
  h := pg_temp.krop_md5(p_fn);
  if h is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
  return 'rettet';
end
$f$;

-- ===========================================================================
-- handel_gem_levering: GLS kun med gls_aktiv fra serveren
-- ===========================================================================
do $do$
begin
  raise notice 'handel_gem_levering: %', pg_temp.ps_ret(
    'public.handel_gem_levering(uuid,uuid,jsonb,text)',
    'a1f676d61079ed6db44bbea02c7c92b4',
    'a2a4ad4825f4cb948780621d6084255a',
    jsonb_build_array(jsonb_build_array(
$g$    return jsonb_build_object('kode', 'ugyldig');
  end if;
$g$,
$n$    return jsonb_build_object('kode', 'ugyldig');
  end if;

  -- GLS er slået fra, indtil Shipmondo har svaret, om GLS kan sendes
  -- labelfrit (Filip, 15. okt. 2026 - 20261024020000). Serveren sender
  -- gls_aktiv = true, når SHIPMONDO_GLS_AKTIV=true. Mangler den: afvist.
  if not v_afh and v_firma = 'shipmondo' and p_valg->>'transportoer' = 'gls'
     and coalesce(p_valg->>'gls_aktiv', '') <> 'true' then
    return jsonb_build_object('kode', 'gls_lukket');
  end if;
$n$, 1)));
end $do$;

-- Grants som før (uændrede af rettelsen på stedet - gentages for en
-- sikkerheds skyld). Kun service-role.
revoke all on function public.handel_gem_levering(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.handel_gem_levering(uuid, uuid, jsonb, text) to service_role;
