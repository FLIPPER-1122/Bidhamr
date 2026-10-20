-- Fragtfirmaer (Filip, 20. okt. 2026): køberen kan kun vælge DAO og GLS (GLS
-- med printet PDF-label). PostNord er slået fra indtil videre -
-- ROADMAP-BESLUTNINGER, "Fragtfirmaer (Filip, 20. okt. 2026)".
--
-- Erstatter GLS-værnet fra 20261024020000 (gls_aktiv) med én liste over
-- tilladte fragtfirmaer, som serveren sender med:
--
--   handel_gem_levering afviser ved Shipmondo en transportør, der ikke står i
--   p_valg->'tilladte' (et JSON-array, fx ["dao","gls"]), med koden
--   'transportoer_lukket'. Serveren bygger listen af SHIPMONDO_TRANSPORTOERER
--   (standard dao,gls) + SHIPMONDO_POSTNORD_AKTIV=true - src/lib/fragt/
--   shipmondo.ts, shipmondoTransportoerer.
--
--   Standard, når listen mangler (gammel kode under deploy, der kun sender
--   gls_aktiv): ['dao','gls'] - Filips nye standard. PostNord er altså altid
--   afvist uden listen (fail closed); GLS er tilladt, fordi GLS nu er slået
--   til, og den gamle kode alligevel selv afviser GLS uden SHIPMONDO_GLS_AKTIV.
--   Er 'tilladte' sendt, men ikke et array (fx null), afvises alt (fail
--   closed). Manglende transportør er DAO som før.
--
--   Eksisterende valg og forsendelser røres ikke: en betalt PostNord-levering
--   kan stadig få label, sporing, webhooks og retur (forsendelser.transportoer
--   og forsendelse_claim kigger ikke på listen). En gemt, ubetalt
--   PostNord-levering afvises ved betaling i koden (sikrPaymentIntent).
--
-- Rettes på stedet med md5-drift-tjek (mønstret fra 20261024010000):
-- "gammel" = efter 20261024020000 (hentet med SELECT på BÅDE produktion
-- lkifkrexeldimmghnsie og test pjiigmzqwlfepxnjdvug 20. okt. 2026 - samme md5
-- og samme pg_get_functiondef), "ny" = efter denne migration. Andet afbryder
-- migrationen.
--
-- Desuden (Filip, 20. okt. 2026): sælgeren accepterer DAO's handelsbetingelser
-- før første DAO-forsendelse - tabellen fragt_betingelser_accept nederst.
--
-- Kræver 20261024020000. Idempotent (kan køres igen). Én transaktion: filen
-- køres som én samlet forespørgsel. KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

-- ===========================================================================
-- Hjælpere (kun i denne session) - som i 20261024010000/20261024020000
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
-- handel_gem_levering: kun fragtfirmaer fra serverens liste (p_valg->'tilladte')
-- ===========================================================================
do $do$
begin
  raise notice 'handel_gem_levering: %', pg_temp.ps_ret(
    'public.handel_gem_levering(uuid,uuid,jsonb,text)',
    'a2a4ad4825f4cb948780621d6084255a',
    '60fe2b47983b475aefc5a54e9743ae02',
    jsonb_build_array(jsonb_build_array(
$g$
  -- GLS er slået fra, indtil Shipmondo har svaret, om GLS kan sendes
  -- labelfrit (Filip, 15. okt. 2026 - 20261024020000). Serveren sender
  -- gls_aktiv = true, når SHIPMONDO_GLS_AKTIV=true. Mangler den: afvist.
  if not v_afh and v_firma = 'shipmondo' and p_valg->>'transportoer' = 'gls'
     and coalesce(p_valg->>'gls_aktiv', '') <> 'true' then
    return jsonb_build_object('kode', 'gls_lukket');
  end if;
$g$,
$n$
  -- Kun de fragtfirmaer, køberen må vælge nu (Filip, 20. okt. 2026 - DAO og
  -- GLS, ingen PostNord - 20261028010000). Serveren sender listen i
  -- p_valg->'tilladte' (SHIPMONDO_TRANSPORTOERER, standard dao,gls). Uden
  -- listen (gammel kode): dao og gls. Ikke et array: alt afvist.
  if not v_afh and v_firma = 'shipmondo'
     and not (coalesce(p_valg->>'transportoer', 'dao') = any (
       case
         when jsonb_typeof(p_valg->'tilladte') = 'array'
           then array(select jsonb_array_elements_text(p_valg->'tilladte'))
         when p_valg->'tilladte' is not null then array[]::text[]
         else array['dao', 'gls']
       end)) then
    return jsonb_build_object('kode', 'transportoer_lukket');
  end if;
$n$, 1)));
end $do$;

-- Grants som før (uændrede af rettelsen på stedet - gentages for en
-- sikkerheds skyld). Kun service-role.
revoke all on function public.handel_gem_levering(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.handel_gem_levering(uuid, uuid, jsonb, text) to service_role;

-- ===========================================================================
-- DAO's handelsbetingelser: sælgerens accept (Filip, 20. okt. 2026)
-- ===========================================================================
-- Før en sælger laver sin første DAO-label (DAO direkte eller Shipmondo med
-- transportoer = 'dao'), skal han acceptere DAO's handelsbetingelser (maks.
-- 2.500 kr. erstatning pr. pakke, ingen tilkøb, DAO's undtagelser). Accepten
-- gemmes én gang pr. sælger og version. Ændres versionen i koden
-- (DAO_BETINGELSER.version i src/lib/fragt/betingelser.ts), skal han
-- acceptere igen - de gamle rækker bliver stående som dokumentation.
--
--   Skrives KUN af serveren med service-role (src/lib/fragt/server.ts,
--   opretUdgaaendeForsendelse) - versionen er serverens konstant, aldrig
--   klientens. Brugeren kan kun læse sine egne rækker (RLS). Ingen sletning
--   (heller ikke ved sletning af kontoen: on delete restrict - kontoen
--   anonymiseres, rækken er dokumentation for forsendelser/handelsdata).
create table if not exists public.fragt_betingelser_accept (
  bruger_id      uuid        not null references public.users(id) on delete restrict,
  fragtfirma     text        not null,
  version        text        not null,
  accepteret_kl  timestamptz not null default now(),
  primary key (bruger_id, fragtfirma, version),
  constraint fragt_betingelser_accept_fragtfirma_check check (fragtfirma in ('dao', 'gls')),
  constraint fragt_betingelser_accept_version_check check (length(version) between 1 and 40)
);

comment on table public.fragt_betingelser_accept is
  'Sælgerens accept af fragtfirmaets handelsbetingelser (DAO - Filip 20. okt. 2026). Én række pr. sælger, fragtfirma og version. Skrives kun af serveren (service-role).';

alter table public.fragt_betingelser_accept enable row level security;
drop policy if exists fragt_betingelser_accept_egen on public.fragt_betingelser_accept;
create policy fragt_betingelser_accept_egen on public.fragt_betingelser_accept
  for select to authenticated using (bruger_id = (select auth.uid()));
revoke all on public.fragt_betingelser_accept from public, anon, authenticated;
grant select on public.fragt_betingelser_accept to authenticated;
grant all on public.fragt_betingelser_accept to service_role;
