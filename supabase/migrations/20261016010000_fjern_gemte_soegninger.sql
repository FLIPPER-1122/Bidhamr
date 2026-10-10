-- Gemte søgninger fjernes helt (Filip, 10. okt. 2026). UI, server actions og
-- cron-trinnet fjernes på hjemmesiden i samme omgang; appen har aldrig brugt
-- funktionen og skal ikke have den (ROADMAP fase 5).
--
-- Fjernes:
--   1. Tabellen public.gemte_soegninger med indeks, RLS-policies
--      (gemte_soegninger_select_own/insert_own/update_own/delete_own) og
--      triggerne gemte_soegninger_foer og afvis_slettet_konto (kun triggeren
--      på denne tabel - funktionen afvis_slettet_konto() bruges af andre
--      tabeller og bliver).
--   2. Funktionerne gemte_soegninger_foer() (trigger) og
--      gemte_soegninger_find_nye(integer) (kaldt af hjemmesidens
--      notifikations-cron, src/lib/notifikationer/cron.ts - der er intet
--      pg_cron-job). Den gamle cron tåler, at funktionen mangler
--      (PGRST202/42883 springes over), så rækkefølgen af deploy og migration
--      er ligegyldig for cron'en.
--   3. Henvisningerne i konto_slet(uuid) (sletning af brugerens gemte
--      søgninger) og mine_data_grund() (nøglen 'gemte_soegninger' i "Download
--      dine data"). Begge rettes ved at fjerne netop de linjer fra den
--      nuværende krop (samme mønster som 20261010030000, der flettede ind i
--      mine_data), efter et md5-drift-tjek.
--   4. Notifikationstypen 'gemt_soegning':
--      - fjernes fra notifikation_kendt_type(), som er CHECK-reglen for både
--        notifikationer og notifikation_indstillinger. Listen flettes som i
--        20261007010000 (læses fra kildeteksten), så ingen andre typer
--        forsvinder.
--      - notifikation_indstillinger: rækker med typen slettes. Det er kun
--        brugerens til/fra-valg for en funktion, der ikke findes længere -
--        ingen handelsdata, intet brugeren kan se. Uden sletningen ville en
--        opdatering af rækken fejle på CHECK-reglen.
--      - notifikationer: eksisterende beskeder af typen BEVARES (de står i
--        brugerens notifikationsliste og indgår i "Download dine data").
--        CHECK-reglen notifikationer_type_gyldig udvides derfor med
--        "or type = 'gemt_soegning'"; ellers ville fx "markér som læst"
--        (update) fejle på de gamle rækker. Nye kan ikke opstå: intet i
--        databasen eller på hjemmesiden opretter typen længere. Valgt frem for
--        sletning, fordi det ikke kan fortrydes at slette, og fordi en
--        bevaret række ikke koster noget. (10. okt. 2026: 0 rækker i både
--        test og produktion.)
--      - notifikation_gem_indstillinger(jsonb): springer typen over i stedet
--        for at svare 'ukendt_type'. Ellers kunne en gammel klient (fx den
--        hjemmeside, der kører, indtil den nye er deployet), der sender alle
--        typer, slet ikke gemme notifikationsindstillinger.
--
-- Intet handelsdata røres. Tabellen gemte_soegninger er brugerens egne
-- søgefiltre (ingen handler, ingen beløb) og slettes med tabellen.
--
-- Drift-tjek: md5 af funktionskroppen, normaliseret (CRLF -> LF, linjer der
-- kun er en kommentar eller tomme fjernes). Normaliseringen er nødvendig,
-- fordi testdatabasen har de samme kroppe uden kommentarlinjer, mens
-- produktion har dem med (og CRLF) - den kørende kode er den samme.
-- Hver funktion skal have enten den gamle (før) eller den nye (efter) md5.
--
-- Idempotent (kan køres igen). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælpere
-- ---------------------------------------------------------------------------
create or replace function pg_temp.krop_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(regexp_replace(replace(pr.prosrc, E'\r\n', E'\n'),
                            E'^[ \t]*(--[^\n]*)?\n', '', 'gn'))
    from pg_proc pr where pr.oid = p_fn
$$;

-- Erstatter p_gl med p_ny i funktionens nuværende definition og opretter den
-- igen (create or replace beholder ejer og rettigheder). Kræver, at p_gl
-- findes præcis én gang.
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
  v_src text;
  v_def text;
begin
  -- konto_slet(uuid): 20261007031000 (før) / denne migration (efter).
  v_md5 := pg_temp.krop_md5('public.konto_slet(uuid)'::regprocedure);
  if v_md5 not in ('55c9f19056440ee9f16e4a934fe09744', 'd8b7c6524035ac280cf62d90a56d3ff3') then
    raise exception 'konto_slet er ændret uden for migrationerne (md5 %). Tjek den, før den rettes.', v_md5;
  end if;

  -- mine_data_grund(): 20261013010000 + fletninger (før) / denne (efter).
  v_md5 := pg_temp.krop_md5('public.mine_data_grund()'::regprocedure);
  if v_md5 not in ('78464024689e7717a5a528b3073ec34a', 'ee8734eefde4413e7d8c314e7604b2ee') then
    raise exception 'mine_data_grund er ændret uden for migrationerne (md5 %). Tjek den, før den rettes.', v_md5;
  end if;

  -- notifikation_gem_indstillinger(jsonb): 20261002060000 (før) / denne (efter).
  v_md5 := pg_temp.krop_md5('public.notifikation_gem_indstillinger(jsonb)'::regprocedure);
  if v_md5 not in ('b9b264c0ddd25e311f54123c2a32645f', '8f09d965557044211f5f700238d2c61b') then
    raise exception 'notifikation_gem_indstillinger er ændret uden for migrationerne (md5 %). Tjek den, før den rettes.', v_md5;
  end if;

  -- notifikation_kendt_type(text): typelisten flettes, så kun formen tjekkes
  -- (den er genereret af 20261007010000 m.fl.).
  select replace(p.prosrc, E'\r\n', E'\n') into v_src
    from pg_proc p where p.oid = 'public.notifikation_kendt_type(text)'::regprocedure;
  if v_src !~ E'^\\s*select public\\.notifikation_paakraevet\\(p_type\\) or p_type = any \\(array\\[[^]]*\\]::text\\[\\]\\);\\s*$' then
    raise exception 'notifikation_kendt_type har ikke den forventede form - ret manuelt: %', v_src;
  end if;

  -- CHECK på notifikationer: den oprindelige eller den udvidede herunder.
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.notifikationer'::regclass and c.conname = 'notifikationer_type_gyldig';
  if v_def is distinct from 'CHECK (notifikation_kendt_type(type))'
     and v_def is distinct from 'CHECK ((notifikation_kendt_type(type) OR (type = ''gemt_soegning''::text)))' then
    raise exception 'notifikationer_type_gyldig er ændret uden for migrationerne: %', v_def;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. konto_slet: slet ikke længere fra gemte_soegninger.
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.krop_md5('public.konto_slet(uuid)'::regprocedure) = '55c9f19056440ee9f16e4a934fe09744' then
    perform pg_temp.ret_krop('public.konto_slet(uuid)'::regprocedure,
      E'  delete from public.gemte_soegninger           where bruger_id = p_bruger;\n', '');
    -- Kommentaren over linjen (findes kun, hvor kommentarerne er bevaret).
    if position('-- Gemte soegninger (fase 4A). Saelgers svar' in pg_get_functiondef('public.konto_slet(uuid)'::regprocedure)) > 0 then
      perform pg_temp.ret_krop('public.konto_slet(uuid)'::regprocedure,
        '-- Gemte soegninger (fase 4A). Saelgers svar', '-- Saelgers svar');
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. mine_data_grund: nøglen 'gemte_soegninger' udgår af "Download dine data".
-- ---------------------------------------------------------------------------
do $$
begin
  if pg_temp.krop_md5('public.mine_data_grund()'::regprocedure) = '78464024689e7717a5a528b3073ec34a' then
    perform pg_temp.ret_krop('public.mine_data_grund()'::regprocedure,
      E'    ''gemte_soegninger'', coalesce((select jsonb_agg(jsonb_build_object(\n' ||
      E'        ''navn'', g.navn, ''soegeord'', g.soegeord, ''kategori'', g.kategori,\n' ||
      E'        ''postnummer'', g.postnummer, ''radius_km'', g.radius_km,\n' ||
      E'        ''pris_min'', g.pris_min, ''pris_max'', g.pris_max, ''besked'', g.besked,\n' ||
      E'        ''oprettet'', g.oprettet_kl) order by g.oprettet_kl)\n' ||
      E'      from public.gemte_soegninger g where g.bruger_id = v_uid), ''[]''::jsonb),\n',
      '');
    -- Hvor der var en tom linje før og efter, bliver der to: saml dem.
    if position(E'''[]''::jsonb),\n\n\n    ''dine_svar_paa_bedoemmelser''' in
                replace(pg_get_functiondef('public.mine_data_grund()'::regprocedure), E'\r\n', E'\n')) > 0 then
      perform pg_temp.ret_krop('public.mine_data_grund()'::regprocedure,
        E'''[]''::jsonb),\n\n\n    ''dine_svar_paa_bedoemmelser''',
        E'''[]''::jsonb),\n\n    ''dine_svar_paa_bedoemmelser''');
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Tabellen og dens funktioner. Ingen cascade: afhænger noget uventet af
--    tabellen (view, fremmednøgle), stopper migrationen i stedet.
--    Policies, triggere og indeks forsvinder med tabellen.
-- ---------------------------------------------------------------------------
drop table if exists public.gemte_soegninger;
drop function if exists public.gemte_soegninger_find_nye(integer);
drop function if exists public.gemte_soegninger_foer();

-- ---------------------------------------------------------------------------
-- 5. Notifikationstypen 'gemt_soegning'.
-- ---------------------------------------------------------------------------
-- 5a. Indstillinger for typen (kun til/fra-valg, ingen handelsdata).
delete from public.notifikation_indstillinger where type = 'gemt_soegning';

-- 5b. Gamle beskeder bevares: CHECK udvides, før typen fjernes fra listen.
alter table public.notifikationer drop constraint if exists notifikationer_type_gyldig;
alter table public.notifikationer add constraint notifikationer_type_gyldig
  check (public.notifikation_kendt_type(type) or type = 'gemt_soegning');

-- 5c. notifikation_kendt_type uden 'gemt_soegning' (resten flettes uændret).
do $$
declare
  v_src  text;
  v_vals text[];
begin
  select p.prosrc into v_src
    from pg_proc p
   where p.oid = 'public.notifikation_kendt_type(text)'::regprocedure;

  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x
      from regexp_matches(coalesce(v_src, ''), '''([^'']+)''', 'g') as m
  ) s
  where x <> 'gemt_soegning';

  if coalesce(array_length(v_vals, 1), 0) = 0 then
    raise exception 'notifikation_kendt_type: ingen typer fundet - ret manuelt';
  end if;

  execute format($f$
    create or replace function public.notifikation_kendt_type(p_type text)
    returns boolean
    language sql immutable set search_path = public as $fn$
      select public.notifikation_paakraevet(p_type) or p_type = any (array[%s]::text[]);
    $fn$;$f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) v));
end $$;

grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;

-- 5d. notifikation_gem_indstillinger: den fjernede type springes over (gamle
--     klienter sender den stadig), i stedet for at hele gemningen afvises.
do $$
begin
  if pg_temp.krop_md5('public.notifikation_gem_indstillinger(jsonb)'::regprocedure) = 'b9b264c0ddd25e311f54123c2a32645f' then
    perform pg_temp.ret_krop('public.notifikation_gem_indstillinger(jsonb)'::regprocedure,
      E'    v_type := r->>''type'';\n',
      E'    v_type := r->>''type'';\n' ||
      E'    -- Fjernet type (gemte søgninger, 10. okt. 2026): ignoreres.\n' ||
      E'    continue when v_type = ''gemt_soegning'';\n');
    perform pg_temp.ret_krop('public.notifikation_gem_indstillinger(jsonb)'::regprocedure,
      E'  for r in select * from jsonb_array_elements(p_indstillinger) loop\n' ||
      E'    insert into public.notifikation_indstillinger',
      E'  for r in select * from jsonb_array_elements(p_indstillinger) loop\n' ||
      E'    continue when r->>''type'' = ''gemt_soegning'';\n' ||
      E'    insert into public.notifikation_indstillinger');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Efterkontrol: intet i public henviser længere til tabellen/funktionerne.
-- ---------------------------------------------------------------------------
do $$
declare
  v_navne text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_navne
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.prosrc ilike '%gemte_soegninger%' or p.prosrc ilike '%gemt_soegning%')
     and p.oid <> 'public.notifikation_gem_indstillinger(jsonb)'::regprocedure;
  if v_navne is not null then
    raise exception 'Funktioner henviser stadig til gemte søgninger: %', v_navne;
  end if;
  if to_regclass('public.gemte_soegninger') is not null then
    raise exception 'gemte_soegninger findes stadig';
  end if;
end $$;
