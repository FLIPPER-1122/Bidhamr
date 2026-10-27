-- Glidende overgang over 7.500 kr. (Filip, 27. okt. 2026 - ROADMAP-
-- BESLUTNINGER afsnit 3: erstatter "3 % + 15 kr." og "2 % + 15 kr." i den
-- private models høje trin). Op til og med 7.500,00 kr. er alt uændret.
--
--   1. Ny prismodel-værdi 'ny2' (betalinger.prismodel): privat handel med
--      glidende overgang. Over 7.500,00 kr. (750.000 øre) er gebyret det lave
--      trins loft + en procent af beløbet OVER 7.500 kr.:
--        køber:  300 kr. + 3 % af (pris - 7.500), højst 650 kr.
--        sælger:  95 kr. + 2 % af (pris - 7.500), højst 450 kr.
--      Til og med 7.500 kr. som 'ny': køber 7 % + 5 kr. (højst 300 kr.),
--      sælger 5 % + 5 kr. (højst 95 kr.). Øre, round = halv op (som før).
--      Triggeren betalinger_b_prismodel sætter 'ny2' på ALLE nye private
--      betalinger (afslut_udloebne_auktioner, "tilbud til næste byder" og
--      alt fremtidigt - kalderens beløb ignoreres som før).
--   2. Eksisterende handler (Filip, 26. okt. 2026: "Handler, der allerede er
--      vundet, beholder deres beløb"): prismodellen er låst pr. betaling fra
--      oprettelsen (triggeren bevarer old.prismodel). Gamle 'ny'-rækker -
--      også ubetalte - beholder 3 % + 15 / 2 % + 15 over 7.500 kr. Ingen
--      rækker opdateres af denne migration.
--   3. Gebyrerne pr. prismodel regnes ÉT sted:
--        public.prismodel_koebergebyr_oere(prismodel, bud)
--        public.prismodel_saelgergebyr_oere(prismodel, bud)
--      (gammel, ny, ny2, erhverv, erhverv2; ukendt = null). CHECK-formlerne
--      på betalinger bruger dem for ALLE modeller (før: faste 5 % for
--      gammel/erhverv og koebergebyr_oere(bud, erhverv) for resten - den
--      ville have ramt gamle 'ny'-rækker over 7.500 kr., nu hvor
--      koebergebyr_oere skifter til 'ny2'). Beskyttelse-formlen kender 'ny2'.
--      CHECK-formlerne erstattes FØR koebergebyr_oere/saelgergebyr_oere
--      ændres.
--   4. public.aktuel_prismodel(erhverv): modellen for en NY handel
--      ('ny2' / 'erhverv2'). koebergebyr_oere(bud, erhverv) og
--      saelgergebyr_oere(bud, erhverv) = gebyret for en ny handel (nu
--      glidende) - bruges af afslut_udloebne_auktioner og andenchance_svar
--      (beløbene regnes alligevel om af triggeren).
--   5. Refusion ved medhold i en sag (sag_refusion_oere) og fakturaerne
--      (faktura_planlaeg): 'ny2' følger 'ny' (kun buddet; købers faktura
--      står, sælgerens krediteres). Fakturatekster: "Gebyr (inkl. BidHamr
--      Beskyttelse)" / "Gebyr" / "Sælgergebyr" som 'ny' (uændrede funktioner).
--      DAC7, admin-tal, application_fee, total og refusionsplan læser de
--      gemte beløb - uændret.
--   6. Firmaernes model ('erhverv2'), 'erhverv' og 'gammel' er uændrede.
--
-- TypeScript-spejl: src/lib/betaling/beregn.ts (koebergebyrForPrismodel /
-- saelgergebyrForPrismodel, Prismodel 'ny2'). Appen: bidhamr-app src/lib/beregn.ts.
--
-- OVERGANG: gammel kode (før denne ændring) kender ikke 'ny2' og afviser at
-- oprette en PaymentIntent for en 'ny2'-betaling (forventetTotalOere = null
-- -> "Beløbet passer ikke"). Migration og kode skal derfor ud samtidig
-- (testdatabasen og test.bidhamr.dk: private betalinger oprettet efter
-- migrationen kan først betales, når den nye kode kører der).
--
-- Funktioner fra tidligere migrationer rettes med md5-drift-tjek (mønstret
-- fra 20261031010000): "gammel" = repoets nuværende version, "ny" = efter
-- rettelsen. Afviger kroppen fra begge, afbrydes migrationen (intet ændres).
-- Idempotent (kan køres igen). Én transaktion: ingen egen begin;/commit;
-- (repoets mønster - se 20261031020000, S5). KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regprocedure('public.betalinger_b_prismodel()') is null
     or to_regprocedure('public.koebergebyr_oere(bigint,boolean)') is null
     or to_regprocedure('public.saelgergebyr_oere(bigint,boolean)') is null
     or to_regprocedure('public.sag_refusion_oere(text,bigint,bigint,bigint)') is null
     or to_regprocedure('public.faktura_planlaeg(integer)') is null
     or not exists (select 1 from pg_constraint
                     where conrelid = 'public.betalinger'::regclass and conname = 'betalinger_prismodel_check'
                       and pg_get_constraintdef(oid) like '%erhverv2%') then
    raise exception 'Forudsætning mangler: kør 20261031010000_ny_prismodel.sql og 20261101010000_erhverv_intet_saelgergebyr.sql først';
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

-- Drift-tjek før en hel funktion erstattes: 'gammel' (repoets version),
-- 'allerede' (genkørsel) - ellers afbrydes migrationen.
create or replace function pg_temp.kraev_md5(p_fn text, p_gammel text, p_ny text)
returns text language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then raise exception '%: funktionen findes ikke', p_fn; end if;
  if h = p_ny then return 'allerede'; end if;
  if h is distinct from p_gammel then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
  return 'gammel';
end
$f$;

create or replace function pg_temp.kraev_efter(p_fn text, p_ny text)
returns void language plpgsql as $f$
begin
  if pg_temp.krop_md5(p_fn) is distinct from p_ny then
    raise exception '%: efter rettelsen er md5 % (forventet %)', p_fn, pg_temp.krop_md5(p_fn), p_ny;
  end if;
end
$f$;

-- Alle drift-tjek FØR noget ændres (så en afvigelse ikke efterlader en halv
-- migration - filen er alligevel én transaktion).
do $do$
begin
  perform pg_temp.kraev_md5('public.koebergebyr_oere(bigint,boolean)',
                            '94a3184f21c333e57337589342bcf91a', '985032686aafbba963668ae038be3b89');
  perform pg_temp.kraev_md5('public.saelgergebyr_oere(bigint,boolean)',
                            '242e6edb831a581095ee23122e39c6dd', '308f426b8c9a13f45a3e42ea4d7002e8');
  perform pg_temp.kraev_md5('public.sag_refusion_oere(text,bigint,bigint,bigint)',
                            '195b80a283200dc2dfa06dadbbc14471', '96fcb7120b41a9381fd9e178756ad47b');
end $do$;

-- ===========================================================================
-- 1. Gebyrerne pr. prismodel - ét sted
-- ===========================================================================
-- Grænsen: præcis 7.500,00 kr. (750.000 øre), til og med = lav sats.
-- Rettes satserne nogensinde, skal der en ny prismodel-værdi til (CHECK-
-- formlerne bruger funktionerne på gamle rækker).
create or replace function public.prismodel_koebergebyr_oere(p_prismodel text, p_bud_oere bigint)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case p_prismodel
    -- Glidende (Filip, 27. okt. 2026): 300 kr. + 3 % af beløbet over 7.500 kr., højst 650 kr.
    when 'ny2' then case when p_bud_oere <= 750000
                         then least(round(p_bud_oere * 7 / 100.0)::bigint + 500, 30000)
                         else least(30000 + round((p_bud_oere - 750000) * 3 / 100.0)::bigint, 65000) end
    -- 26. okt. 2026 (20261031010000): over 7.500 kr. 3 % + 15 kr., højst 650 kr.
    when 'ny' then case when p_bud_oere <= 750000
                        then least(round(p_bud_oere * 7 / 100.0)::bigint + 500, 30000)
                        else least(round(p_bud_oere * 3 / 100.0)::bigint + 1500, 65000) end
    when 'gammel' then round(p_bud_oere * 5 / 100.0)::bigint
    when 'erhverv' then round(p_bud_oere * 5 / 100.0)::bigint
    when 'erhverv2' then round(p_bud_oere * 5 / 100.0)::bigint
  end;
$fn$;

create or replace function public.prismodel_saelgergebyr_oere(p_prismodel text, p_bud_oere bigint)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case p_prismodel
    -- Glidende (Filip, 27. okt. 2026): 95 kr. + 2 % af beløbet over 7.500 kr., højst 450 kr.
    when 'ny2' then case when p_bud_oere <= 750000
                         then least(round(p_bud_oere * 5 / 100.0)::bigint + 500, 9500)
                         else least(9500 + round((p_bud_oere - 750000) * 2 / 100.0)::bigint, 45000) end
    -- 26. okt. 2026 (20261031010000): over 7.500 kr. 2 % + 15 kr., højst 450 kr.
    when 'ny' then case when p_bud_oere <= 750000
                        then least(round(p_bud_oere * 5 / 100.0)::bigint + 500, 9500)
                        else least(round(p_bud_oere * 2 / 100.0)::bigint + 1500, 45000) end
    when 'gammel' then round(p_bud_oere * 5 / 100.0)::bigint
    when 'erhverv' then round(p_bud_oere * 5 / 100.0)::bigint
    -- Firmaer betaler intet sælgergebyr (20261101010000).
    when 'erhverv2' then 0::bigint
  end;
$fn$;

-- Prismodellen for en NY handel. Ét sted: triggeren og koebergebyr_oere/
-- saelgergebyr_oere(bud, erhverv) bruger den.
create or replace function public.aktuel_prismodel(p_erhverv boolean)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case when coalesce(p_erhverv, false) then 'erhverv2' else 'ny2' end;
$fn$;

comment on function public.prismodel_koebergebyr_oere(text, bigint) is
  'Købergebyr i øre inkl. moms for en prismodel (20261102140000): ny2 = privat glidende (<= 7.500 kr. 7 % + 5 kr., maks 300 kr.; > 7.500 kr. 300 kr. + 3 % af beløbet over 7.500 kr., maks 650 kr.), ny = privat 26. okt. 2026 (> 7.500 kr. 3 % + 15 kr., maks 650 kr.), gammel/erhverv/erhverv2 = 5 %. Ukendt = null. Spejl: src/lib/betaling/beregn.ts.';
comment on function public.prismodel_saelgergebyr_oere(text, bigint) is
  'Sælgergebyr i øre inkl. moms for en prismodel (20261102140000): ny2 = privat glidende (<= 7.500 kr. 5 % + 5 kr., maks 95 kr.; > 7.500 kr. 95 kr. + 2 % af beløbet over 7.500 kr., maks 450 kr.), ny = privat 26. okt. 2026 (> 7.500 kr. 2 % + 15 kr., maks 450 kr.), gammel/erhverv = 5 %, erhverv2 = 0. Ukendt = null. Spejl: src/lib/betaling/beregn.ts.';
comment on function public.aktuel_prismodel(boolean) is
  'Prismodellen for en ny betaling (20261102140000): erhverv2 for erhvervsauktioner, ellers ny2.';

-- Rene beregninger - må kaldes af alle (ingen data).
grant execute on function public.prismodel_koebergebyr_oere(text, bigint) to anon, authenticated, service_role;
grant execute on function public.prismodel_saelgergebyr_oere(text, bigint) to anon, authenticated, service_role;
grant execute on function public.aktuel_prismodel(boolean) to anon, authenticated, service_role;

-- ===========================================================================
-- 2. Prismodel 'ny2'
-- ===========================================================================
do $do$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.betalinger'::regclass and conname = 'betalinger_prismodel_check'
                and pg_get_constraintdef(oid) like '%ny2%') then
    return;
  end if;
  alter table public.betalinger drop constraint if exists betalinger_prismodel_check;
  alter table public.betalinger
    add constraint betalinger_prismodel_check check (prismodel in ('gammel', 'ny', 'ny2', 'erhverv', 'erhverv2'));
end $do$;

-- Triggeren sætter prismodellen; defaulten følger den for en sikkerheds skyld.
alter table public.betalinger alter column prismodel set default 'ny2';

comment on column public.betalinger.prismodel is
  'Gebyrmodel, låst ved oprettelsen: gammel = før 26. okt. 2026 (5 %/5 % + evt. tilkøbt BidHamr Beskyttelse), ny = privat 26. okt. 2026 (> 7.500 kr. 3 % + 15 / 2 % + 15), ny2 = privat glidende fra 27. okt. 2026 (20261102140000: > 7.500 kr. 300 kr. + 3 % / 95 kr. + 2 % af beløbet over 7.500 kr.) - ny og ny2: Beskyttelse inkluderet ved forsendelse, beskyttelse_oere = 0, kun buddet refunderes ved sag; erhverv = erhvervshandel 5 %/5 % (kun gamle rækker), erhverv2 = erhvervshandel 5 % købergebyr og intet sælgergebyr. Beløbene: prismodel_koebergebyr_oere / prismodel_saelgergebyr_oere. Sættes af betalinger_b_prismodel og kan ikke ændres.';

-- ===========================================================================
-- 3. CHECK-formlerne via prismodel-funktionerne (FØR afsnit 4)
-- ===========================================================================
-- NOT VALID + VALIDATE som i 20261031010000: afviger eksisterende rækker,
-- bliver constrainten stående NOT VALID (nye og ændrede rækker skal stadig
-- passe), og antallet skrives. coalesce(..., -1): en ukendt prismodel
-- (null) må aldrig passere.
do $do$
declare
  c record;
  n integer;
begin
  for c in
    select * from (values
      ('betalinger_koebergebyr_formel',
       $c$check (pengemodel = 'separat'
          or koebergebyr_oere = coalesce(public.prismodel_koebergebyr_oere(prismodel, bud_oere), -1))$c$),
      ('betalinger_saelgergebyr_formel',
       $c$check (pengemodel = 'separat'
          or saelgergebyr_oere = coalesce(public.prismodel_saelgergebyr_oere(prismodel, bud_oere), -1))$c$),
      ('betalinger_beskyttelse_formel',
       $c$check (pengemodel = 'separat' or case when prismodel = 'gammel'
          then beskyttelse_oere = 0 or beskyttelse_oere = least(greatest(round(bud_oere * 5 / 100.0), 2500), 25000)
          else beskyttelse_oere = 0 and beskyttelse = (prismodel in ('ny', 'ny2') and fragt_oere > 0) end)$c$)
    ) as v(navn, def)
  loop
    -- Er constrainten allerede denne version (genkørsel), røres den ikke.
    if exists (select 1 from pg_constraint where conname = c.navn and conrelid = 'public.betalinger'::regclass
                and (strpos(pg_get_constraintdef(oid), 'prismodel_koebergebyr_oere(') > 0
                     or strpos(pg_get_constraintdef(oid), 'prismodel_saelgergebyr_oere(') > 0
                     or strpos(pg_get_constraintdef(oid), 'ny2') > 0)) then
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
-- 4. Gebyret for en ny handel: koebergebyr_oere / saelgergebyr_oere
-- ===========================================================================
create or replace function public.koebergebyr_oere(p_bud_oere bigint, p_erhverv boolean)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select public.prismodel_koebergebyr_oere(public.aktuel_prismodel(p_erhverv), p_bud_oere);
$fn$;

create or replace function public.saelgergebyr_oere(p_bud_oere bigint, p_erhverv boolean)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select public.prismodel_saelgergebyr_oere(public.aktuel_prismodel(p_erhverv), p_bud_oere);
$fn$;

comment on function public.koebergebyr_oere(bigint, boolean) is
  'Købergebyr i øre inkl. moms for en NY handel (20261102140000): prismodel_koebergebyr_oere(aktuel_prismodel(erhverv), bud) - privat glidende (ny2), erhverv 5 % (erhverv2). Gemte betalinger regnes efter deres egen prismodel. Spejl: src/lib/betaling/beregn.ts.';
comment on function public.saelgergebyr_oere(bigint, boolean) is
  'Sælgergebyr i øre inkl. moms for en NY handel (20261102140000): prismodel_saelgergebyr_oere(aktuel_prismodel(erhverv), bud) - privat glidende (ny2), erhverv 0 kr. (erhverv2). Gemte betalinger regnes efter deres egen prismodel. Spejl: src/lib/betaling/beregn.ts.';

-- Refusion ved medhold i en sag: ny og ny2 = kun buddet (Filip, 26. okt.
-- 2026 - som Trendsales). Ellers (gammel, erhverv, erhverv2): alt undtagen
-- BidHamr Beskyttelse.
create or replace function public.sag_refusion_oere(p_prismodel text, p_bud_oere bigint,
                                                    p_total_oere bigint, p_beskyttelse_oere bigint)
returns bigint
language sql
immutable
set search_path = ''
as $fn$
  select case when p_prismodel in ('ny', 'ny2') then p_bud_oere
              else p_total_oere - coalesce(p_beskyttelse_oere, 0) end;
$fn$;
-- (create or replace bevarer rettighederne fra 20261031010000.)

do $do$
begin
  perform pg_temp.kraev_efter('public.koebergebyr_oere(bigint,boolean)', '985032686aafbba963668ae038be3b89');
  perform pg_temp.kraev_efter('public.saelgergebyr_oere(bigint,boolean)', '308f426b8c9a13f45a3e42ea4d7002e8');
  perform pg_temp.kraev_efter('public.sag_refusion_oere(text,bigint,bigint,bigint)', '96fcb7120b41a9381fd9e178756ad47b');
end $do$;

-- ===========================================================================
-- 5. Triggeren og fakturaerne (rettet på stedet, md5-drift-tjek)
-- ===========================================================================
do $do$
begin
  raise notice 'betalinger_b_prismodel: %', pg_temp.ps_ret(
    'public.betalinger_b_prismodel()',
    '47f5b20333109f3a0997f718b2230c19',
    '76a1f1f1a5799422eaac6e27607b6951',
    jsonb_build_array(
      jsonb_build_array(
$g$    -- 20261101010000: erhvervshandler uden sælgergebyr ('erhverv2').
    new.prismodel         := case when v_erhverv then 'erhverv2' else 'ny' end;
    new.fragt_oere        := coalesce(new.fragt_oere, 0);
    new.koebergebyr_oere  := public.koebergebyr_oere(new.bud_oere, v_erhverv);
    new.saelgergebyr_oere := public.saelgergebyr_oere(new.bud_oere, v_erhverv);$g$,
$n$    -- 20261101010000: erhvervshandler uden sælgergebyr ('erhverv2').
    -- 20261102140000: private handler med glidende overgang ('ny2').
    new.prismodel         := public.aktuel_prismodel(v_erhverv);
    new.fragt_oere        := coalesce(new.fragt_oere, 0);
    new.koebergebyr_oere  := public.prismodel_koebergebyr_oere(new.prismodel, new.bud_oere);
    new.saelgergebyr_oere := public.prismodel_saelgergebyr_oere(new.prismodel, new.bud_oere);$n$, 1),
      jsonb_build_array(
$g$    new.beskyttelse := old.prismodel = 'ny' and coalesce(new.fragt_oere, 0) > 0;$g$,
$n$    new.beskyttelse := old.prismodel in ('ny', 'ny2') and coalesce(new.fragt_oere, 0) > 0;$n$, 1)));

  raise notice 'faktura_planlaeg: %', pg_temp.ps_ret(
    'public.faktura_planlaeg(integer)',
    '67b378f749ee4d5c0875ee9c3d3a57b0',
    '040bdbd26a8fb67ee66942a42ef29814',
    jsonb_build_array(
      jsonb_build_array(
$g$       and not (fa.part = 'koeber' and x.prismodel = 'ny'$g$,
$n$       and not (fa.part = 'koeber' and x.prismodel in ('ny', 'ny2')$n$, 1),
      jsonb_build_array(
$g$    elsif rf.prismodel = 'ny' and rf.part = 'saelger'$g$,
$n$    elsif rf.prismodel in ('ny', 'ny2') and rf.part = 'saelger'$n$, 1)));
end $do$;
-- (create or replace via pg_get_functiondef bevarer rettighederne - uændrede.)

-- ===========================================================================
-- 6. Kontrol: gebyrerne giver Filips eksempler (27. okt. 2026)
-- ===========================================================================
do $do$
declare
  r record;
begin
  for r in
    select * from (values
      -- (bud øre, køber øre, sælger øre)
      (750000::bigint, 30000::bigint, 9500::bigint),
      (750100, 30003, 9502),
      (1000000, 37500, 14500),
      (1500000, 52500, 24500),
      (2000000, 65000, 34500),
      (2500000, 65000, 44500)
    ) as v(bud, koeb, saelg)
  loop
    if public.koebergebyr_oere(r.bud, false) <> r.koeb or public.saelgergebyr_oere(r.bud, false) <> r.saelg then
      raise exception 'Kontrol: % øre gav køber %/sælger % (forventet %/%)', r.bud,
        public.koebergebyr_oere(r.bud, false), public.saelgergebyr_oere(r.bud, false), r.koeb, r.saelg;
    end if;
  end loop;
end $do$;

-- ===========================================================================
-- 7. Oprydning
-- ===========================================================================
drop function pg_temp.kraev_efter(text, text);
drop function pg_temp.kraev_md5(text, text, text);
drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.krop_md5(text);
