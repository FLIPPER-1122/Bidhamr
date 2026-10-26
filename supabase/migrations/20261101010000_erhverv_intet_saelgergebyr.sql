-- Firmaer betaler intet sælgergebyr (Filip, 26. okt. 2026 - ROADMAP-
-- BESLUTNINGER afsnit 3, "Ændret: firmaer betaler INTET sælgergebyr - de
-- betaler allerede abonnement"). Køberen betaler stadig 5 % købergebyr uden
-- min./maks. på firmaauktioner. Udbetaling til firmaet = hele buddet. Gælder
-- auktioner, der slutter efter opdateringen. Buddet er inkl. moms (som før),
-- og firmaets abonnement er uændret.
--
--   1. Ny prismodel-værdi 'erhverv2' (betalinger.prismodel): erhvervshandel
--      UDEN sælgergebyr. Triggeren betalinger_b_prismodel sætter 'erhverv2'
--      på ALLE nye betalinger fra en erhvervsauktion (afslut_udloebne_auktioner,
--      "tilbud til næste byder" og alt fremtidigt - kalderens beløb ignoreres
--      som før). Prismodellen kan stadig aldrig ændres.
--   2. Gamle 'erhverv'-rækker (5 %/5 %, før denne migration) røres IKKE og
--      beholder deres beløb: CHECK-formlerne regner nu 'erhverv' med de faste
--      5 %/5 % (ikke længere via funktionen), så de altid passer - også når
--      en gammel række opdateres senere (status, refusion, udbetaling ...).
--   3. public.saelgergebyr_oere(bud, erhverv => true) giver nu 0.
--      public.koebergebyr_oere er uændret (erhverv: 5 % uden min./maks.).
--      CHECK-formlen for 'erhverv2': købergebyr = koebergebyr_oere(bud, true),
--      sælgergebyr = saelgergebyr_oere(bud, true) = 0; udbetaling = bud
--      (betalinger_udbetaling_stemmer). Beskyttelse som 'erhverv': ingen
--      (beskyttelse = false, beskyttelse_oere = 0 - formlen er uændret).
--   4. Fakturaer: faktura_planlaeg laver allerede kun en sælgerfaktura, når
--      saelgergebyr_oere > 0 - en 'erhverv2'-handel får ingen faktura på et
--      0-kr.-gebyr (købers faktura på gebyr og fragt laves som før).
--      Refusion ved medhold i en sag: 'erhverv2' følger 'erhverv' (alt
--      undtagen BidHamr Beskyttelse - der er ingen), public.sag_refusion_oere
--      er uændret ('ny' er den eneste med "kun buddet").
--   5. DAC7, admin-tal og Firma oversigt læser saelgergebyr_oere/udbetaling_oere
--      fra betalingerne - 0 og hele buddet vises af sig selv for nye handler.
--
-- TypeScript-spejl: src/lib/betaling/beregn.ts (saelgergebyrOere(bud, true) = 0,
-- Prismodel 'erhverv2', forventetTotalOere kender alle fire modeller).
--
-- Funktioner fra 20261031010000 rettes på stedet med md5-drift-tjek (samme
-- mønster): afviger kroppen fra både den kendte og den rettede version,
-- afbrydes migrationen (intet ændres). Idempotent (kan køres igen). Én
-- transaktion: ingen egen begin;/commit; (repoets mønster - se
-- 20261031020000, S5). KØRES IKKE i produktion uden Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.betalinger_b_prismodel()') is null
     or to_regprocedure('public.saelgergebyr_oere(bigint,boolean)') is null
     or to_regprocedure('public.koebergebyr_oere(bigint,boolean)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'betalinger'
                       and column_name = 'prismodel') then
    raise exception 'Forudsætning mangler: kør 20261031010000_ny_prismodel.sql først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session) - som i 20261031010000
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
    raise exception '%: funktionen findes ikke', p_fn;
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
-- 1. Prismodel 'erhverv2'
-- ===========================================================================
do $do$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.betalinger'::regclass and conname = 'betalinger_prismodel_check'
                and pg_get_constraintdef(oid) like '%erhverv2%') then
    return;
  end if;
  alter table public.betalinger drop constraint if exists betalinger_prismodel_check;
  alter table public.betalinger
    add constraint betalinger_prismodel_check check (prismodel in ('gammel', 'ny', 'erhverv', 'erhverv2'));
end $do$;

comment on column public.betalinger.prismodel is
  'Gebyrmodel: gammel = før 26. okt. 2026 (5 %/5 % + evt. tilkøbt BidHamr Beskyttelse), ny = privat (koebergebyr_oere/saelgergebyr_oere, Beskyttelse inkluderet ved forsendelse, beskyttelse_oere = 0), erhverv = erhvervshandel 5 %/5 % uden Beskyttelse (20261031010000 - kun gamle rækker), erhverv2 = erhvervshandel med 5 % købergebyr og INTET sælgergebyr (20261101010000 - alle nye erhvervshandler). Sættes af betalinger_b_prismodel og kan ikke ændres.';

-- ===========================================================================
-- 2. CHECK-formlerne: 'erhverv' med faste 5 %/5 %, 'erhverv2' via funktionerne
-- ===========================================================================
-- Erstattes FØR saelgergebyr_oere ændres (afsnit 3), så de gamle
-- 'erhverv'-rækker aldrig regnes med den nye funktion. NOT VALID + VALIDATE
-- som i 20261031010000: afviger eksisterende rækker, bliver constrainten
-- stående NOT VALID (nye og ændrede rækker skal stadig passe), og antallet
-- skrives. Beskyttelse-formlen er uændret (passer allerede til 'erhverv2').
do $do$
declare
  c record;
  n integer;
begin
  for c in
    select * from (values
      ('betalinger_koebergebyr_formel',
       $c$check (pengemodel = 'separat' or case
          when prismodel in ('gammel', 'erhverv') then koebergebyr_oere = round(bud_oere * 5 / 100.0)
          else koebergebyr_oere = public.koebergebyr_oere(bud_oere, prismodel = 'erhverv2') end)$c$),
      ('betalinger_saelgergebyr_formel',
       $c$check (pengemodel = 'separat' or case
          when prismodel in ('gammel', 'erhverv') then saelgergebyr_oere = round(bud_oere * 5 / 100.0)
          else saelgergebyr_oere = public.saelgergebyr_oere(bud_oere, prismodel = 'erhverv2') end)$c$)
    ) as v(navn, def)
  loop
    -- Er constrainten allerede denne version (genkørsel), røres den ikke.
    if exists (select 1 from pg_constraint where conname = c.navn and conrelid = 'public.betalinger'::regclass
                and pg_get_constraintdef(oid) like '%erhverv2%') then
      continue;
    end if;
    execute format('alter table public.betalinger drop constraint if exists %I', c.navn);
    execute format('alter table public.betalinger add constraint %I %s not valid', c.navn, c.def);
    execute format('select count(*) from public.betalinger where not (%s)',
                   regexp_replace(c.def, '^check ', '')) into n;
    if n = 0 then
      execute format('alter table public.betalinger validate constraint %I', c.navn);
    else
      raise notice '%: % eksisterende række(r) afviger - constrainten står NOT VALID (nye og ændrede rækker skal passe)', c.navn, n;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 3. saelgergebyr_oere: erhverv = 0
-- ===========================================================================
do $do$
begin
  raise notice 'saelgergebyr_oere: %', pg_temp.ps_ret(
    'public.saelgergebyr_oere(bigint,boolean)',
    '58741a49fa54948eb3986dfa58943842',
    '242e6edb831a581095ee23122e39c6dd',
    jsonb_build_array(
      jsonb_build_array(
$g$    when coalesce(p_erhverv, false) then round(p_bud_oere * 5 / 100.0)::bigint$g$,
$n$    when coalesce(p_erhverv, false) then 0::bigint$n$, 1)));
end $do$;

comment on function public.saelgergebyr_oere(bigint, boolean) is
  'Sælgergebyr i øre inkl. moms: privat <= 7.500 kr. 5 % + 5 kr. (maks 95 kr.), > 7.500 kr. 2 % + 15 kr. (maks 450 kr.) (Filip, 26. okt. 2026); erhverv 0 kr. - firmaer betaler intet sælgergebyr (Filip, 26. okt. 2026, 20261101010000; gamle erhverv-handler havde 5 %, se betalinger.prismodel). Spejl: src/lib/betaling/beregn.ts.';

-- ===========================================================================
-- 4. Triggeren: nye erhvervsbetalinger får 'erhverv2'
-- ===========================================================================
do $do$
begin
  raise notice 'betalinger_b_prismodel: %', pg_temp.ps_ret(
    'public.betalinger_b_prismodel()',
    '9e9bbedbf55ac7e399fb5bdcc880d46f',
    '47f5b20333109f3a0997f718b2230c19',
    jsonb_build_array(
      jsonb_build_array(
$g$    new.prismodel         := case when v_erhverv then 'erhverv' else 'ny' end;$g$,
$n$    -- 20261101010000: erhvervshandler uden sælgergebyr ('erhverv2').
    new.prismodel         := case when v_erhverv then 'erhverv2' else 'ny' end;$n$, 1)));
end $do$;
-- (create or replace via pg_get_functiondef bevarer rettighederne - uændrede.)

-- ===========================================================================
-- 5. Oprydning
-- ===========================================================================
drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.krop_md5(text);
