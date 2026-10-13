-- Fragt: DAO direkte (ROADMAP fase 2, Filip 9. okt. 2026 - i stedet for DAO
-- via Shipmondo). Adapteren er src/lib/fragt/dao.ts; se docs/DAO-API.md.
--
--   1. 'dao' er et gyldigt fragtfirma: forsendelser.fragtfirma,
--      handel_levering.fragtfirma, forsendelse_claim og handel_gem_levering
--      (de havde ('test', 'gls', 'shipmondo') hardkodet).
--   2. Labelgrænsen for DAO (forsendelse_claim): DAO kan annullere en label
--      (AnnullerePakke). En DAO-label med status 'annulleret' tæller derfor
--      ikke i "højst 2 labels pr. handel" - sælgeren kan annullere og lave en
--      ny, så længe pakken ikke er indleveret. Adapteren sætter kun
--      'annulleret', når DAO har bekræftet annulleringen (den kaster aldrig
--      FragtAnnulleringIkkeMulig). Loft mod misbrug: højst 10 DAO-labels i alt
--      pr. handel (også annullerede), derefter staffs godkendelse som før.
--      Andre fragtfirmaer er uændrede.
--   3. fragt_sporing_token: DAO's Track & Trace V2-token (ét kald henter alle
--      nye hændelser på alle vores pakker). Lås, så to cron-kørsler ikke
--      henter samtidig, og compare-and-set, så tokenet aldrig går baglæns.
--      Det nye token gemmes først, når alle hændelser er gemt.
--      Låsen bærer et laas_id: kun den kørsel, der har låsen, kan gemme
--      tokenet eller slippe låsen.
--   4. fragt_ukendte_koder: hændelseskoder, vi ikke kender endnu (de ændrer
--      aldrig status). Bruges til at udfylde src/lib/fragt/daoKoder.ts.
--      fragt_feed_fejl: en hændelse, der aldrig kan gemmes ("poison event"),
--      springes over efter 3 kørsler, så feedet ikke står stille for altid -
--      forsendelsen markeres til staff.
--   5. fragt_foraeldreloese: DAO-pakker, der blev oprettet, men ikke kunne
--      bruges (DAO har intet opslag på reference). De annulleres af
--      fragt-cron'en; efter 5 forsøg får staff en markering. Kapløb med
--      forsendelse_gem_oprettet lukkes i begge retninger: registreringen låser
--      forsendelsen og afviser en gemt stregkode, og triggeren
--      forsendelser_ikke_foraeldreloes afviser at gemme en forældreløs.
--   6. fragt_efterlysninger: ingen leveringsmelding 14 dage efter afsendelse
--      -> én efterlysning (createclaim.php, bortkommet) pr. forsendelse og en
--      markering til staff under Fragt. Pengene holdes allerede tilbage af
--      handel_auto_frigiv (20261019010000: frigiver aldrig efter 14 dage uden
--      leveret_kl, men giver staff en opgave på betalingen).
--   7. forsendelse_gem_label: PDF'en gemmes senere, når DAO ikke kunne levere
--      den ved oprettelsen (den labelfri kode virker uden).
--
-- Alle nye tabeller: RLS slået til, ingen policies, kun service_role.
-- Alle nye funktioner: security definer, search_path = '' (alt er
-- schema-kvalificeret), kun service_role (serveren kalder dem med
-- createAdminClient).
--
-- Tidligere udgaver af denne migration er kun kørt på testdatabasen. De
-- funktioner, der er nye her, droppes og genskabes, når signaturen er ændret;
-- forsendelse_claim/handel_gem_levering har samme "ny" md5 som før, så
-- testdatabasen svarer 'allerede'.
--
-- Kan køres flere gange (idempotent) og kører som én transaktion (én fil = ét
-- kald). Ændrede funktioner, der allerede ligger i produktion, rettes på
-- stedet med md5-drift-tjek efter mønstret i 20261019010000/20261020020000:
-- "gammel" = prod før denne migration (hentet med SELECT 13. okt. 2026 - prod
-- og test havde samme md5), "ny" = efter. Andet afbryder migrationen.
-- KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- 0. Hjælpere (kun i denne session)
-- ===========================================================================
create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Som 20261020020000: md5 før (gammel) eller allerede rettet (ny); hvert
-- mønster skal findes præcis det forventede antal gange; md5 bagefter skal
-- være "ny". Ellers afbrydes migrationen (intet ændres).
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

-- Fletter nye værdier ind i en "kolonne = any(array)"-CHECK (som
-- 20261019010000). Idempotent.
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  if v_def is null then
    raise exception '%: constraint % findes ikke', p_tabel, p_navn;
  end if;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

-- ===========================================================================
-- 1. 'dao' som fragtfirma
-- ===========================================================================
select pg_temp.flet_check('public.forsendelser'::regclass, 'forsendelser_fragtfirma_check', 'fragtfirma', array['dao']);
select pg_temp.flet_check('public.handel_levering'::regclass, 'handel_levering_fragtfirma_check', 'fragtfirma', array['dao']);

-- ===========================================================================
-- 2. forsendelse_claim og handel_gem_levering (rettet på stedet)
-- ===========================================================================
do $do$
begin
  raise notice 'forsendelse_claim: %', pg_temp.ps_ret(
    'public.forsendelse_claim(uuid,uuid,text,text,text)',
    'e1d337ed9c56b6c98d6bb333544f6873',
    '4a9203d3dcb0800bc67375f3ae225c2e',
    jsonb_build_array(
      jsonb_build_array(
$g$     or p_fragtfirma not in ('test', 'gls', 'shipmondo')$g$,
$n$     or p_fragtfirma not in ('test', 'gls', 'shipmondo', 'dao')$n$, 1),
      jsonb_build_array(
$g$    select count(*) into v_antal from public.forsendelser
     where trade_id = p_trade and type = 'udgaaende' and status <> 'fejlet';
    if v_antal >= 2 + coalesce(v_ekstra, 0) then
      return jsonb_build_object('kode', 'for_mange_labels');
    end if;$g$,
$n$    select count(*) into v_antal from public.forsendelser
     where trade_id = p_trade and type = 'udgaaende' and status <> 'fejlet'
       -- DAO direkte (20261021010000): en DAO-label, som DAO har bekræftet
       -- annulleret, tæller ikke - sælgeren kan lave en ny, så længe pakken
       -- ikke er indleveret.
       and not (p_fragtfirma = 'dao' and fragtfirma = 'dao' and status = 'annulleret');
    if v_antal >= 2 + coalesce(v_ekstra, 0) then
      return jsonb_build_object('kode', 'for_mange_labels');
    end if;
    -- Loft for DAO mod misbrug: højst 10 labels i alt (også annullerede).
    if p_fragtfirma = 'dao' then
      select count(*) into v_antal from public.forsendelser
       where trade_id = p_trade and type = 'udgaaende' and status <> 'fejlet';
      if v_antal >= 10 + coalesce(v_ekstra, 0) then
        return jsonb_build_object('kode', 'for_mange_labels');
      end if;
    end if;$n$, 1)));

  raise notice 'handel_gem_levering: %', pg_temp.ps_ret(
    'public.handel_gem_levering(uuid,uuid,jsonb,text)',
    '9a4e2018067b68ce1e376e574893ce12',
    '2b8e1936694bccdf80635b7a9c2e4d5a',
    jsonb_build_array(jsonb_build_array(
$g$(coalesce(v_firma, '') not in ('test', 'gls', 'shipmondo')$g$,
$n$(coalesce(v_firma, '') not in ('test', 'gls', 'shipmondo', 'dao')$n$, 1)));
end $do$;

-- Grants som før (uændrede af rettelsen på stedet - gentages for en
-- sikkerheds skyld).
revoke all on function public.forsendelse_claim(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.forsendelse_claim(uuid, uuid, text, text, text) to service_role;
revoke all on function public.handel_gem_levering(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.handel_gem_levering(uuid, uuid, jsonb, text) to service_role;

-- ===========================================================================
-- 3. Sporings-token (Track & Trace V2)
-- ===========================================================================
create table if not exists public.fragt_sporing_token (
  fragtfirma    text primary key,
  -- DAO: start med '0'. Næste token kommer i hvert svar.
  token         text not null default '0',
  -- Seneste hentning (vellykket eller fejlet) - afstand mellem kald.
  hentet_kl     timestamptz,
  -- Seneste gang et nyt token blev gemt (alle hændelser gemt).
  gemt_kl       timestamptz,
  -- En kørsel er i gang (lås). Kun den, der har laas_id, må slippe den.
  laast_til     timestamptz,
  laas_id       uuid,
  -- Fejl i træk på det NUVÆRENDE token (nulstilles, når et nyt gemmes).
  fejl_i_traek  integer not null default 0,
  sidste_fejl   text,
  sidste_antal  integer,
  oprettet_kl   timestamptz not null default now(),
  constraint fragt_sporing_token_firma_check check (fragtfirma in ('test', 'gls', 'shipmondo', 'dao')),
  constraint fragt_sporing_token_vaerdi_check check (
        token ~ '^[0-9]{1,20}$'
    and fejl_i_traek >= 0
    and (sidste_antal is null or sidste_antal >= 0)
    and char_length(coalesce(sidste_fejl, '')) <= 500)
);
-- Testdatabasen havde tabellen fra en tidligere udgave af denne migration.
alter table public.fragt_sporing_token add column if not exists laas_id uuid;
comment on table public.fragt_sporing_token is
  'Fragtfirmaets sporings-token (DAO Track & Trace V2): ét kald giver alle nye hændelser siden tokenet. Kun service_role.';

alter table public.fragt_sporing_token enable row level security;
revoke all on public.fragt_sporing_token from public, anon, authenticated;
grant all on public.fragt_sporing_token to service_role;

-- Tidligere udgaver af denne migration (kun testdatabasen) havde andre
-- signaturer/returtyper. Funktionerne er nye i denne migration og findes ikke
-- i produktion, så de genskabes helt.
drop function if exists public.fragt_sporing_token_claim(text, integer);
drop function if exists public.fragt_sporing_token_gem(text, text, text, integer);
drop function if exists public.fragt_sporing_token_gem(text, uuid, text, text, integer);
drop function if exists public.fragt_sporing_token_fejl(text, text);
drop function if exists public.fragt_sporing_token_fejl(text, uuid, text);

-- Claimer en hentning: { token, laas } når der er gået mindst p_interval_sek
-- siden sidste hentning, og ingen anden kørsel har låsen (3 minutter).
-- Ellers null.
create function public.fragt_sporing_token_claim(p_fragtfirma text, p_interval_sek integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_token text;
  v_laas  uuid := gen_random_uuid();
begin
  insert into public.fragt_sporing_token (fragtfirma) values (p_fragtfirma)
  on conflict (fragtfirma) do nothing;
  update public.fragt_sporing_token
     set laast_til = now() + interval '3 minutes', laas_id = v_laas
   where fragtfirma = p_fragtfirma
     and (laast_til is null or laast_til < now())
     and (hentet_kl is null
          or hentet_kl < now() - make_interval(secs => greatest(coalesce(p_interval_sek, 0), 0)))
  returning token into v_token;
  if v_token is null then return null; end if;
  return jsonb_build_object('token', v_token, 'laas', v_laas);
end;
$fn$;
revoke all on function public.fragt_sporing_token_claim(text, integer) from public, anon, authenticated;
grant execute on function public.fragt_sporing_token_claim(text, integer) to service_role;

-- Gemmer det nye token - KUN når alle hændelser er gemt, kun af den, der har
-- låsen, og kun hvis tokenet stadig er det gamle (compare-and-set: tokenet
-- går aldrig baglæns). Svar: true = gemt.
create function public.fragt_sporing_token_gem(
  p_fragtfirma text, p_laas uuid, p_gammel text, p_ny text, p_antal integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_ny is null or p_ny !~ '^[0-9]{1,20}$' then
    raise exception 'ugyldigt token' using errcode = '22023';
  end if;
  update public.fragt_sporing_token
     set token = p_ny,
         hentet_kl = now(),
         gemt_kl = now(),
         laast_til = null,
         laas_id = null,
         fejl_i_traek = 0,
         sidste_fejl = null,
         sidste_antal = greatest(coalesce(p_antal, 0), 0)
   where fragtfirma = p_fragtfirma and laas_id = p_laas and token = p_gammel;
  if found then return true; end if;
  update public.fragt_sporing_token set laast_til = null, laas_id = null
   where fragtfirma = p_fragtfirma and laas_id = p_laas;
  return false;
end;
$fn$;
revoke all on function public.fragt_sporing_token_gem(text, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.fragt_sporing_token_gem(text, uuid, text, text, integer) to service_role;

-- En hentning fejlede (eller blev afbrudt): tokenet er uændret, låsen slippes
-- (kun af den, der har den), og næste forsøg venter intervallet.
-- Svar: fejl i træk på det nuværende token (0 = låsen var ikke vores).
create function public.fragt_sporing_token_fejl(p_fragtfirma text, p_laas uuid, p_fejl text)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  update public.fragt_sporing_token
     set hentet_kl = now(),
         laast_til = null,
         laas_id = null,
         fejl_i_traek = fejl_i_traek + 1,
         sidste_fejl = left(coalesce(p_fejl, 'ukendt fejl'), 500)
   where fragtfirma = p_fragtfirma and laas_id = p_laas
  returning fejl_i_traek into n;
  return coalesce(n, 0);
end;
$fn$;
revoke all on function public.fragt_sporing_token_fejl(text, uuid, text) from public, anon, authenticated;
grant execute on function public.fragt_sporing_token_fejl(text, uuid, text) to service_role;

-- ===========================================================================
-- 4. Ukendte hændelseskoder og hændelser, der ikke kan gemmes
-- ===========================================================================
create table if not exists public.fragt_ukendte_koder (
  fragtfirma               text not null,
  kode                     text not null,
  -- 'pakkeshop' | 'direkte' | '' (ukendt liste).
  liste                    text not null default '',
  beskrivelse              text,
  eksempel_sporingsnummer  text,
  antal                    integer not null default 1,
  foerst_set_kl            timestamptz not null default now(),
  sidst_set_kl             timestamptz not null default now(),
  primary key (fragtfirma, kode, liste),
  constraint fragt_ukendte_koder_check check (
        fragtfirma in ('test', 'gls', 'shipmondo', 'dao')
    and kode ~ '^[0-9]{1,6}$'
    and liste in ('', 'pakkeshop', 'direkte')
    and char_length(coalesce(beskrivelse, '')) <= 200
    and char_length(coalesce(eksempel_sporingsnummer, '')) <= 40
    and antal >= 1)
);
comment on table public.fragt_ukendte_koder is
  'Sporingskoder fra fragtfirmaet, som adapteren ikke kender (ændrer aldrig status). Bruges til at udfylde src/lib/fragt/daoKoder.ts. Kun service_role.';

alter table public.fragt_ukendte_koder enable row level security;
revoke all on public.fragt_ukendte_koder from public, anon, authenticated;
grant all on public.fragt_ukendte_koder to service_role;

-- Svar: true = koden er set for første gang (drift får en advarsel).
create or replace function public.fragt_ukendt_kode_registrer(
  p_fragtfirma text, p_kode text, p_liste text, p_beskrivelse text, p_sporingsnummer text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_ny boolean;
begin
  insert into public.fragt_ukendte_koder as u
    (fragtfirma, kode, liste, beskrivelse, eksempel_sporingsnummer)
  values (p_fragtfirma, p_kode, coalesce(p_liste, ''), left(p_beskrivelse, 200), left(p_sporingsnummer, 40))
  on conflict (fragtfirma, kode, liste) do update
     set antal = least(u.antal, 2000000000) + 1,
         sidst_set_kl = now(),
         beskrivelse = coalesce(u.beskrivelse, excluded.beskrivelse)
  returning (xmax = 0) into v_ny;
  return coalesce(v_ny, false);
end;
$fn$;
revoke all on function public.fragt_ukendt_kode_registrer(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fragt_ukendt_kode_registrer(text, text, text, text, text) to service_role;

-- En hændelse fra feedet, der ikke kan gemmes ("poison event"): efter
-- p_maks forsøg (ét pr. feed-kørsel) springes den over, så feedet ikke står
-- stille for altid. Forsendelsen markeres til staff, og drift alarmeres.
create table if not exists public.fragt_feed_fejl (
  fragtfirma      text not null,
  noegle          text not null,
  forsendelse_id  uuid references public.forsendelser(id) on delete restrict,
  forsoeg         integer not null default 1,
  sidste_fejl     text,
  foerst_kl       timestamptz not null default now(),
  sidst_kl        timestamptz not null default now(),
  opgivet_kl      timestamptz,
  primary key (fragtfirma, noegle),
  constraint fragt_feed_fejl_check check (
        fragtfirma in ('test', 'gls', 'shipmondo', 'dao')
    and char_length(noegle) between 1 and 200
    and forsoeg >= 1
    and char_length(coalesce(sidste_fejl, '')) <= 500)
);
comment on table public.fragt_feed_fejl is
  'Sporingshændelser fra feedet, som ikke kunne gemmes. Efter 3 forsøg springes de over (opgivet_kl), og staff får en markering. Kun service_role.';

alter table public.fragt_feed_fejl enable row level security;
revoke all on public.fragt_feed_fejl from public, anon, authenticated;
grant all on public.fragt_feed_fejl to service_role;

-- Svar: { opgivet: true/false, nu: true, når den blev opgivet netop nu }.
create or replace function public.fragt_feed_haendelse_fejl(
  p_fragtfirma text, p_noegle text, p_forsendelse uuid, p_fejl text, p_maks integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r      record;
  v_maks integer := greatest(coalesce(p_maks, 3), 1);
begin
  insert into public.fragt_feed_fejl as x (fragtfirma, noegle, forsendelse_id, sidste_fejl, opgivet_kl)
  values (p_fragtfirma, left(p_noegle, 200), p_forsendelse, left(p_fejl, 500),
          case when v_maks <= 1 then now() end)
  on conflict (fragtfirma, noegle) do update
     set forsoeg = x.forsoeg + 1,
         sidst_kl = now(),
         sidste_fejl = left(excluded.sidste_fejl, 500),
         opgivet_kl = coalesce(x.opgivet_kl, case when x.forsoeg + 1 >= v_maks then now() end)
  returning x.opgivet_kl, x.forsoeg into r;
  if r.opgivet_kl is null then
    return jsonb_build_object('opgivet', false, 'nu', false, 'forsoeg', r.forsoeg);
  end if;
  -- Opgivet netop nu: forsøget, der nåede grænsen.
  if r.forsoeg = v_maks then
    if p_forsendelse is not null then
      update public.forsendelser
         set kraever_opmaerksomhed = true,
             opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst,
               'En sporingshændelse fra fragtfirmaet kunne ikke gemmes (' || r.forsoeg
               || ' forsøg) og er sprunget over. Tjek pakkens sporing hos fragtfirmaet.')
       where id = p_forsendelse;
    end if;
    return jsonb_build_object('opgivet', true, 'nu', true, 'forsoeg', r.forsoeg);
  end if;
  return jsonb_build_object('opgivet', true, 'nu', false, 'forsoeg', r.forsoeg);
end;
$fn$;
revoke all on function public.fragt_feed_haendelse_fejl(text, text, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fragt_feed_haendelse_fejl(text, text, uuid, text, integer) to service_role;

-- ===========================================================================
-- 5. Forældreløse forsendelser (oprettet hos DAO, men ikke brugt)
-- ===========================================================================
create table if not exists public.fragt_foraeldreloese (
  id               uuid primary key default gen_random_uuid(),
  forsendelse_id   uuid not null references public.forsendelser(id) on delete restrict,
  fragtfirma       text not null,
  -- Fragtfirmaets id (DAO: stregkoden).
  forsendelses_id  text not null,
  oprettet_kl      timestamptz not null default now(),
  annulleret_kl    timestamptz,
  forsoeg          integer not null default 0,
  forsoegt_kl      timestamptz,
  sidste_fejl      text,
  -- Efter 5 forsøg: staff annullerer selv hos fragtfirmaet.
  opgivet_kl       timestamptz,
  unique (fragtfirma, forsendelses_id),
  constraint fragt_foraeldreloese_check check (
        fragtfirma in ('test', 'gls', 'shipmondo', 'dao')
    and forsendelses_id ~ '^[A-Za-z0-9_-]{1,100}$'
    and forsoeg >= 0
    and char_length(coalesce(sidste_fejl, '')) <= 500)
);
comment on table public.fragt_foraeldreloese is
  'Forsendelser, som fragtfirmaet oprettede, men som BidHamr ikke kunne bruge (fx svaret kunne ikke gemmes). Annulleres af fragt-cron. Handelsdata - slettes aldrig. Kun service_role.';
create index if not exists fragt_foraeldreloese_aabne_idx
  on public.fragt_foraeldreloese (forsoegt_kl nulls first)
  where annulleret_kl is null and opgivet_kl is null;

alter table public.fragt_foraeldreloese enable row level security;
revoke all on public.fragt_foraeldreloese from public, anon, authenticated;
grant all on public.fragt_foraeldreloese to service_role;

-- Fælles: fragtdata slettes aldrig (bogføring - DAO's faktura).
create or replace function public.fragt_ingen_sletning()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  raise exception 'Fragtdata er handelsdata og kan ikke slettes.' using errcode = '42501';
end;
$fn$;
revoke execute on function public.fragt_ingen_sletning() from public, anon, authenticated;

drop trigger if exists fragt_foraeldreloese_ingen_sletning on public.fragt_foraeldreloese;
create trigger fragt_foraeldreloese_ingen_sletning
  before delete on public.fragt_foraeldreloese
  for each row execute function public.fragt_ingen_sletning();

-- Registrerer en forældreløs forsendelse (idempotent) og noterer det på
-- forsendelsen til staff (uden markering - cron'en annullerer den selv).
--
-- Kapløb med forsendelse_gem_oprettet (samme forsendelse, samme stregkode):
--   - Rækken låses (for update), så de to aldrig ser hinanden halvt.
--   - Er stregkoden allerede gemt på forsendelsen, er den IKKE forældreløs
--     (sælgerens aktive label) - der registreres intet.
--   - Omvendt afviser triggeren forsendelser_ikke_foraeldreloes, at en
--     registreret forældreløs stregkode bagefter gemmes som aktiv label.
create or replace function public.fragt_foraeldreloes_registrer(p_forsendelse uuid, p_forsendelses_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_firma text;
  v_id    text;
begin
  select fragtfirma, forsendelses_id into v_firma, v_id
    from public.forsendelser where id = p_forsendelse
   for update;
  if v_firma is null then return false; end if;
  if v_id is not distinct from p_forsendelses_id then return false; end if;
  -- Gemt på en anden forsendelse (burde ikke ske): heller ikke forældreløs.
  if exists (select 1 from public.forsendelser fo
              where fo.fragtfirma = v_firma and fo.forsendelses_id = p_forsendelses_id) then
    return false;
  end if;
  insert into public.fragt_foraeldreloese (forsendelse_id, fragtfirma, forsendelses_id)
  values (p_forsendelse, v_firma, p_forsendelses_id)
  on conflict (fragtfirma, forsendelses_id) do nothing;
  if not found then return false; end if;
  update public.forsendelser
     set opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst,
           'Fragtfirmaet oprettede pakken ' || p_forsendelses_id
           || ', men den kunne ikke bruges. Den annulleres automatisk; næste forsøg laver en ny.')
   where id = p_forsendelse;
  return true;
end;
$fn$;
revoke all on function public.fragt_foraeldreloes_registrer(uuid, text) from public, anon, authenticated;
grant execute on function public.fragt_foraeldreloes_registrer(uuid, text) to service_role;

-- En stregkode, der er registreret som forældreløs (og annulleres), må aldrig
-- gemmes som aktiv label (fx et forsinket svar fra fragtfirmaet).
create or replace function public.forsendelser_ikke_foraeldreloes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.forsendelses_id is not null
     and (tg_op = 'INSERT' or new.forsendelses_id is distinct from old.forsendelses_id)
     and exists (select 1 from public.fragt_foraeldreloese o
                  where o.fragtfirma = new.fragtfirma and o.forsendelses_id = new.forsendelses_id) then
    raise exception 'foraeldreloes: Forsendelsen % hos fragtfirmaet er registreret som forældreløs og annulleres - den kan ikke gemmes som aktiv label.',
      new.forsendelses_id using errcode = '23505';
  end if;
  return new;
end;
$fn$;
revoke execute on function public.forsendelser_ikke_foraeldreloes() from public, anon, authenticated;

drop trigger if exists forsendelser_ikke_foraeldreloes on public.forsendelser;
create trigger forsendelser_ikke_foraeldreloes
  before insert or update of forsendelses_id on public.forsendelser
  for each row execute function public.forsendelser_ikke_foraeldreloes();

-- Claimer forældreløse til annullering (forsoegt_kl sættes, så to kørsler
-- ikke tager samme). p_forsendelse: kun for den forsendelse og uden ventetid
-- (før et nyt forsøg på samme label). Ellers: højst én gang i timen.
create or replace function public.fragt_foraeldreloese_claim(p_forsendelse uuid, p_graense integer)
returns table (id uuid, forsendelse_id uuid, fragtfirma text, forsendelses_id text)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
begin
  return query
    update public.fragt_foraeldreloese o
       set forsoegt_kl = now()
     where o.id in (
       select x.id from public.fragt_foraeldreloese x
        where x.annulleret_kl is null and x.opgivet_kl is null and x.forsoeg < 5
          and (p_forsendelse is null or x.forsendelse_id = p_forsendelse)
          -- Samme værn som ved registreringen: aldrig en gemt, aktiv label.
          and not exists (select 1 from public.forsendelser fo
                           where fo.fragtfirma = x.fragtfirma
                             and fo.forsendelses_id = x.forsendelses_id)
          and (x.forsoegt_kl is null
               or x.forsoegt_kl < now() - case when p_forsendelse is null
                                               then interval '1 hour' else interval '2 minutes' end)
        order by x.forsoegt_kl nulls first, x.oprettet_kl
        limit greatest(1, least(coalesce(p_graense, 10), 50))
        for update skip locked)
    returning o.id, o.forsendelse_id, o.fragtfirma, o.forsendelses_id;
end;
$fn$;
revoke all on function public.fragt_foraeldreloese_claim(uuid, integer) from public, anon, authenticated;
grant execute on function public.fragt_foraeldreloese_claim(uuid, integer) to service_role;

-- Resultatet af en annullering. Efter 5 fejlede forsøg opgives den, og
-- forsendelsen markeres til staff. Svar: 'annulleret' | 'igen' | 'opgivet'.
create or replace function public.fragt_foraeldreloes_afslut(p_id uuid, p_ok boolean, p_fejl text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  o record;
begin
  if p_ok then
    update public.fragt_foraeldreloese set annulleret_kl = now(), sidste_fejl = null
     where id = p_id and annulleret_kl is null;
    return 'annulleret';
  end if;
  update public.fragt_foraeldreloese
     set forsoeg = forsoeg + 1,
         sidste_fejl = left(coalesce(p_fejl, 'ukendt fejl'), 500),
         opgivet_kl = case when forsoeg + 1 >= 5 then now() else null end
   where id = p_id and annulleret_kl is null and opgivet_kl is null
  returning * into o;
  if o.id is null or o.opgivet_kl is null then return 'igen'; end if;
  update public.forsendelser
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst,
           'Pakken ' || o.forsendelses_id || ' hos fragtfirmaet kunne ikke annulleres automatisk (5 forsøg). '
           || 'Annullér den hos fragtfirmaet. Den faktureres kun, hvis den bliver indleveret.')
   where id = o.forsendelse_id;
  return 'opgivet';
end;
$fn$;
revoke all on function public.fragt_foraeldreloes_afslut(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fragt_foraeldreloes_afslut(uuid, boolean, text) to service_role;

-- ===========================================================================
-- 6. Efterlysninger (ingen leveringsmelding 14 dage efter afsendelse)
-- ===========================================================================
create table if not exists public.fragt_efterlysninger (
  id              uuid primary key default gen_random_uuid(),
  forsendelse_id  uuid not null unique references public.forsendelser(id) on delete restrict,
  trade_id        uuid not null references public.trades(id) on delete restrict,
  fragtfirma      text not null,
  sporingsnummer  text not null,
  -- sender:   kaldet til fragtfirmaet er i gang
  -- oprettet: fragtfirmaet har bekræftet efterlysningen
  -- afvist:   fragtfirmaet afviste (FEJL) - staff opretter den manuelt
  -- ukendt:   svaret udeblev - staff tjekker hos fragtfirmaet (aldrig to)
  -- manuel:   automatisk efterlysning er slået fra - staff opretter den
  status          text not null,
  -- Varens værdi (buddet), som sendes med efterlysningen.
  vaerdi_oere     integer,
  oprettet_kl     timestamptz not null default now(),
  afsluttet_kl    timestamptz,
  fejl            text,
  constraint fragt_efterlysninger_check check (
        fragtfirma in ('test', 'gls', 'shipmondo', 'dao')
    and status in ('sender', 'oprettet', 'afvist', 'ukendt', 'manuel')
    and char_length(sporingsnummer) between 1 and 100
    and (vaerdi_oere is null or vaerdi_oere >= 0)
    and char_length(coalesce(fejl, '')) <= 500)
);
comment on table public.fragt_efterlysninger is
  'Efterlysning (bortkommet pakke) hos fragtfirmaet: højst én pr. forsendelse, når der ikke er nogen leveringsmelding 14 dage efter afsendelse. Pengene holdes af handel_auto_frigiv. Handelsdata - slettes aldrig. Kun service_role.';

alter table public.fragt_efterlysninger enable row level security;
revoke all on public.fragt_efterlysninger from public, anon, authenticated;
grant all on public.fragt_efterlysninger to service_role;

drop trigger if exists fragt_efterlysninger_ingen_sletning on public.fragt_efterlysninger;
create trigger fragt_efterlysninger_ingen_sletning
  before delete on public.fragt_efterlysninger
  for each row execute function public.fragt_ingen_sletning();

-- Fælles betingelse: en aktiv, udgående BidHamr-label på en handel i
-- 'pakke_sendt' uden leverings- eller returmelding. Fristen er BOGSTAVELIGT
-- samme udtryk som handel_auto_frigiv (20261019010000):
--   coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days'
-- på en betalt betaling for handlen.
create or replace function public.fragt_efterlysning_mulig(p_forsendelse uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.forsendelser f
      join public.trades tr on tr.id = f.trade_id
      join public.betalinger bt on bt.trade_id = tr.id
     where f.id = p_forsendelse
       and f.type = 'udgaaende'
       and f.status not in ('opretter', 'annulleres', 'annulleret', 'fejlet', 'leveret', 'returneret')
       and f.leveret_kl is null and f.returneret_kl is null
       and f.sporingsnummer is not null
       and tr.status = 'pakke_sendt'
       and bt.status = 'betalt'
       and coalesce(tr.sendt_kl, bt.betalt_kl) < now() - interval '14 days');
$fn$;
revoke all on function public.fragt_efterlysning_mulig(uuid) from public, anon, authenticated;
grant execute on function public.fragt_efterlysning_mulig(uuid) to service_role;

-- Kandidater til efterlysning (kun de fragtfirmaer, serveren kan efterlyse
-- hos). Rydder først op: 'sender' i over 30 minutter (serveren døde
-- undervejs) bliver 'ukendt' med en markering - der sendes aldrig to.
create or replace function public.fragt_efterlysning_kandidater(p_fragtfirmaer text[], p_graense integer)
returns table (forsendelse_id uuid, trade_id uuid, fragtfirma text, sporingsnummer text)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
begin
  with haeng as (
    update public.fragt_efterlysninger e
       set status = 'ukendt', afsluttet_kl = now(),
           fejl = 'Kaldet til fragtfirmaet blev afbrudt.'
     where e.status = 'sender' and e.oprettet_kl < now() - interval '30 minutes'
    returning e.forsendelse_id)
  update public.forsendelser f
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(f.opmaerksomhed_tekst,
           'Efterlysningen hos fragtfirmaet blev afbrudt. Tjek hos fragtfirmaet, om den er oprettet, før du opretter en ny. Pengene holdes tilbage.')
    from haeng h
   where f.id = h.forsendelse_id;

  return query
    select f.id, f.trade_id, f.fragtfirma, f.sporingsnummer
      from public.forsendelser f
     where f.fragtfirma = any(coalesce(p_fragtfirmaer, '{}'::text[]))
       and f.type = 'udgaaende'
       and public.fragt_efterlysning_mulig(f.id)
       and not exists (select 1 from public.fragt_efterlysninger e where e.forsendelse_id = f.id)
     order by f.oprettet_kl
     limit greatest(1, least(coalesce(p_graense, 10), 50));
end;
$fn$;
revoke all on function public.fragt_efterlysning_kandidater(text[], integer) from public, anon, authenticated;
grant execute on function public.fragt_efterlysning_kandidater(text[], integer) to service_role;

-- Claimer efterlysningen (én pr. forsendelse, også ved samtidige kørsler).
--   p_auto true:  status 'sender' - serveren kalder fragtfirmaet og afslutter
--                 med fragt_efterlysning_afslut.
--   p_auto false: status 'manuel' - staff får markeringen med det samme.
-- Svar: { kode: 'ok', id, sporingsnummer, vaerdi_oere } | { kode: 'findes' }
--       | { kode: 'ikke_mulig' }.
create or replace function public.fragt_efterlysning_claim(p_forsendelse uuid, p_auto boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  f      record;
  v_id   uuid;
  v_bud  integer;
begin
  select id, trade_id, fragtfirma, sporingsnummer into f
    from public.forsendelser where id = p_forsendelse for update;
  if f.id is null or not public.fragt_efterlysning_mulig(f.id) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;
  select bt.bud_oere into v_bud
    from public.betalinger bt
   where bt.trade_id = f.trade_id and bt.betalt_kl is not null
   order by bt.betalt_kl desc limit 1;

  insert into public.fragt_efterlysninger (forsendelse_id, trade_id, fragtfirma, sporingsnummer, status, vaerdi_oere,
                                           afsluttet_kl)
  values (f.id, f.trade_id, f.fragtfirma, f.sporingsnummer,
          case when p_auto then 'sender' else 'manuel' end, v_bud,
          case when p_auto then null else now() end)
  on conflict (forsendelse_id) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('kode', 'findes'); end if;

  if not p_auto then
    update public.forsendelser
       set kraever_opmaerksomhed = true,
           opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst,
             'Ingen leveringsmelding 14 dage efter afsendelse. Efterlys pakken ' || f.sporingsnummer
             || ' hos fragtfirmaet (automatisk efterlysning er slået fra), og afgør handlen. Pengene holdes tilbage.')
     where id = f.id;
  end if;
  return jsonb_build_object('kode', 'ok', 'id', v_id, 'sporingsnummer', f.sporingsnummer,
                            'vaerdi_oere', coalesce(v_bud, 0));
end;
$fn$;
revoke all on function public.fragt_efterlysning_claim(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fragt_efterlysning_claim(uuid, boolean) to service_role;

-- Fragtfirmaets svar på efterlysningen. Markerer altid forsendelsen til staff
-- (det er opgaven i "Kræver handling" -> Fragt). Svar: true = afsluttet nu.
create or replace function public.fragt_efterlysning_afslut(p_id uuid, p_status text, p_fejl text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  e      record;
  v_note text;
begin
  if p_status not in ('oprettet', 'afvist', 'ukendt') then
    raise exception 'ugyldig status %', p_status using errcode = '22023';
  end if;
  update public.fragt_efterlysninger
     set status = p_status, afsluttet_kl = now(), fejl = left(p_fejl, 500)
   where id = p_id and status = 'sender'
  returning * into e;
  if e.id is null then return false; end if;

  v_note := case p_status
    when 'oprettet' then
      'Ingen leveringsmelding 14 dage efter afsendelse: efterlysning (bortkommet) er oprettet hos fragtfirmaet '
      || to_char(now() at time zone 'Europe/Copenhagen', 'DD-MM-YYYY') || '. Følg op hos fragtfirmaet, og afgør handlen. Pengene holdes tilbage.'
    when 'afvist' then
      'Ingen leveringsmelding 14 dage efter afsendelse, men fragtfirmaet afviste efterlysningen af pakken '
      || e.sporingsnummer || '. Efterlys den manuelt, og afgør handlen. Pengene holdes tilbage.'
    else
      'Ingen leveringsmelding 14 dage efter afsendelse. Fragtfirmaet svarede ikke på efterlysningen af pakken '
      || e.sporingsnummer || '. Tjek hos fragtfirmaet, om den er oprettet, før du opretter en ny. Pengene holdes tilbage.'
  end;
  update public.forsendelser
     set kraever_opmaerksomhed = true,
         opmaerksomhed_tekst = public.forsendelse_note_tilfoej(opmaerksomhed_tekst, v_note)
   where id = e.forsendelse_id;
  return true;
end;
$fn$;
revoke all on function public.fragt_efterlysning_afslut(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fragt_efterlysning_afslut(uuid, text, text) to service_role;

-- ===========================================================================
-- 7. Label-PDF hentet senere
-- ===========================================================================
-- Kun når der ingen label er endnu (forsendelser_beskyt tillader at sætte
-- label_sti én gang). Svar: true = gemt.
create or replace function public.forsendelse_gem_label(p_id uuid, p_sti text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_sti is null or p_sti !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.pdf$' then
    raise exception 'ugyldig sti' using errcode = '22023';
  end if;
  update public.forsendelser
     set label_sti = p_sti
   where id = p_id and label_sti is null and status not in ('opretter', 'fejlet');
  return found;
end;
$fn$;
revoke all on function public.forsendelse_gem_label(uuid, text) from public, anon, authenticated;
grant execute on function public.forsendelse_gem_label(uuid, text) to service_role;

drop function pg_temp.flet_check(regclass, text, text, text[]);
drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.krop_md5(text);
