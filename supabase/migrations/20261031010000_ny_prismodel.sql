-- Ny prismodel (Filip, 26. okt. 2026 - ROADMAP-BESLUTNINGER afsnit 2, 3, 4 og
-- "Beløbsloft"; commits 3fee3ce, a87f917 og 22519e9).
--
--   1. Gebyrerne regnes ÉT sted: public.koebergebyr_oere(bud, erhverv) og
--      public.saelgergebyr_oere(bud, erhverv) (immutable, øre, round = halv op):
--        privat, salgspris <= 7.500,00 kr.: køber 7 % + 5 kr. (højst 300 kr.),
--                                           sælger 5 % + 5 kr. (højst 95 kr.)
--        privat, salgspris  > 7.500,00 kr.: køber 3 % + 15 kr. (højst 650 kr.),
--                                           sælger 2 % + 15 kr. (højst 450 kr.)
--        erhverv (auctions.erhverv): 5 % / 5 % uden min/maks (som før).
--      Alle gebyrer er inkl. moms. TypeScript-spejl: src/lib/betaling/beregn.ts.
--   2. betalinger.prismodel: 'gammel' (alle rækker fra før denne migration -
--      5 %/5 % + evt. tilkøbt BidHamr Beskyttelse; beløbene røres ikke),
--      'ny' (privat) og 'erhverv'. BEFORE INSERT-triggeren
--      betalinger_b_prismodel regner gebyrer, Beskyttelse, total og udbetaling
--      for ALLE nye betalinger (afslut_udloebne_auktioner, "tilbud til næste
--      byder" og alt fremtidigt) - kalderens beløb ignoreres. Prismodellen kan
--      aldrig ændres.
--      BidHamr Beskyttelse er ikke længere et tilkøb: ved forsendelse (privat)
--      er handlen altid beskyttet (beskyttelse = true), men beskyttelse_oere
--      = 0 - prisen ligger i købergebyret. Afhentning og erhverv: ingen
--      Beskyttelse. Skifter køberen leveringsform i checkout (fragt ændres),
--      følger beskyttelse med (samme trigger, BEFORE UPDATE).
--      CHECK-formlerne (20261019010000 afsnit 10) kender prismodellen.
--   3. afslut_udloebne_auktioner, andenchance_svar: bruger funktionerne;
--      budets/tilbuddets Beskyttelse-valg ignoreres. saet_maksimum ignorerer
--      p_beskyttelse (appen sender den stadig - parameteren bevares) og giver
--      ikke længere 'beskyttelse_laast'. Kolonnerne bids.beskyttelse,
--      bud_maksimum.beskyttelse og andenchance_tilbud.beskyttelse bevares
--      (handelsdata), men betyder intet for prisen.
--   4. Refusion ved medhold i en sag (Filip, 26. okt. 2026 - som Trendsales):
--      prismodel 'ny' -> køberen får KUN buddet tilbage; købergebyr og fragt
--      refunderes ikke. 'gammel' og 'erhverv': som før (alt undtagen BidHamr
--      Beskyttelse). Ét sted: public.sag_refusion_oere. Bruges af
--      sag_claim_refusion (sag/anke efter ankefristen) og "BidHamr dækker".
--      Refusionsplanen (betaling_refusionsplan) er uændret: S = U (sælgeren
--      får intet), G = R - S = sælgergebyret - BidHamr beholder købergebyr og
--      fragt.
--   5. Fakturaer (faktura_planlaeg): købers gebyrlinje hedder "Gebyr (inkl.
--      BidHamr Beskyttelse)" ved beskyttede handler, ellers "Gebyr";
--      sælgerens "Sælgergebyr". Ingen Beskyttelse-linje for nye handler
--      (beskyttelse_oere = 0 -> faktura_linje udelader den). Gamle handler
--      fakturerer som før. Sag med medhold i den nye model: købers faktura
--      krediteres ikke (BidHamr beholdt gebyr og fragt); sælgerens krediteres
--      helt (han fik intet, BidHamr gav sælgergebyret tilbage).
--   6. Beløbsloft 25.000 kr. (før 500.000) på startpris, bud og maksimum -
--      også erhverv. Kun NYE værdier afvises (insert, eller når værdien
--      ændres); gamle rækker over loftet bliver stående. Ét sted:
--      public.maks_beloeb_kr().
--   7. Fragt for køber (pakkeshop): Lille 42, Mellem 52, Stor 67 kr.
--      (fragt_pakkestoerrelser). Dør-priser uændret. Auktioner uden en
--      igangværende handel, der står med den gamle låste pris, får den nye
--      (overgang: nye priser for alle auktioner, der slutter efter
--      opdateringen). Betalinger røres ikke.
--   8. Udbetaling til sælgerens bank hver 14. dag: højst én payout pr.
--      sælger pr. 14 dage (regnet fra den seneste oprettede/gennemførte
--      payout). saelger_udbetaling_claim afviser med kode 'interval' under
--      sælgerlåsen - alle andre værn er uændrede. handel_udbetalingsstatus
--      viser tidligst_kl inkl. intervallet. Se docs/BETALINGSMODEL-PLAN.md 1.4a.
--
-- Funktioner fra tidligere migrationer rettes på stedet med md5-drift-tjek
-- (mønstret fra 20261030010000): "gammel" = repoets nuværende version,
-- "ny" = efter rettelsen. Afviger kroppen, afbrydes migrationen (intet
-- ændres).
--
-- Idempotent (kan køres igen). Én transaktion. KØRES IKKE i produktion uden
-- Filips "ja".

set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.betalinger') is null or to_regclass('public.fragt_pakkestoerrelser') is null
     or to_regclass('public.saelger_udbetalinger') is null
     or to_regprocedure('public.beloebsloft_bud()') is null
     or to_regprocedure('public.betaling_bidhamr_daekker_claim(uuid,uuid,text,uuid)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'betalinger'
                       and column_name = 'pengemodel') then
    raise exception 'Forudsætning mangler: kør 20261011010000, 20261012010000 og 20261019010000 først';
  end if;
end $do$;

-- ===========================================================================
-- 0. Hjælpere (kun i denne session)
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
-- 1. Gebyrerne - ét sted
-- ===========================================================================
-- Grænsen ligger ved præcis 7.500,00 kr. (750.000 øre): til og med = lav sats.
-- Rettes satserne nogensinde, skal der en ny prismodel-værdi til (CHECK-
-- formlerne på betalinger bruger funktionerne på gamle rækker).
create or replace function public.koebergebyr_oere(p_bud_oere bigint, p_erhverv boolean)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when coalesce(p_erhverv, false) then round(p_bud_oere * 5 / 100.0)::bigint
    when p_bud_oere <= 750000 then least(round(p_bud_oere * 7 / 100.0)::bigint + 500, 30000)
    else least(round(p_bud_oere * 3 / 100.0)::bigint + 1500, 65000)
  end;
$fn$;

create or replace function public.saelgergebyr_oere(p_bud_oere bigint, p_erhverv boolean)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when coalesce(p_erhverv, false) then round(p_bud_oere * 5 / 100.0)::bigint
    when p_bud_oere <= 750000 then least(round(p_bud_oere * 5 / 100.0)::bigint + 500, 9500)
    else least(round(p_bud_oere * 2 / 100.0)::bigint + 1500, 45000)
  end;
$fn$;

comment on function public.koebergebyr_oere(bigint, boolean) is
  'Købergebyr i øre inkl. moms (Filip, 26. okt. 2026): privat <= 7.500 kr. 7 % + 5 kr. (maks 300 kr.), > 7.500 kr. 3 % + 15 kr. (maks 650 kr.); erhverv 5 %. BidHamr Beskyttelse er inkluderet (privat, forsendelse). Spejl: src/lib/betaling/beregn.ts.';
comment on function public.saelgergebyr_oere(bigint, boolean) is
  'Sælgergebyr i øre inkl. moms (Filip, 26. okt. 2026): privat <= 7.500 kr. 5 % + 5 kr. (maks 95 kr.), > 7.500 kr. 2 % + 15 kr. (maks 450 kr.); erhverv 5 %. Spejl: src/lib/betaling/beregn.ts.';

-- Refusion ved medhold i en sag. 'ny': kun buddet (Filip, 26. okt. 2026 - som
-- Trendsales). Ellers (gammel, erhverv): alt undtagen BidHamr Beskyttelse.
create or replace function public.sag_refusion_oere(p_prismodel text, p_bud_oere bigint,
                                                    p_total_oere bigint, p_beskyttelse_oere bigint)
returns bigint
language sql
immutable
set search_path = ''
as $fn$
  select case when p_prismodel = 'ny' then p_bud_oere
              else p_total_oere - coalesce(p_beskyttelse_oere, 0) end;
$fn$;

-- Fakturalinjernes tekst.
create or replace function public.faktura_koebergebyr_tekst(p_prismodel text, p_beskyttelse boolean)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_prismodel is null or p_prismodel = 'gammel' then 'Købergebyr (5 %)'
              when coalesce(p_beskyttelse, false) then 'Gebyr (inkl. BidHamr Beskyttelse)'
              else 'Gebyr' end;
$fn$;

create or replace function public.faktura_saelgergebyr_tekst(p_prismodel text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when p_prismodel is null or p_prismodel = 'gammel' then 'Sælgergebyr (5 %)'
              else 'Sælgergebyr' end;
$fn$;

-- Beløbsloftet i hele kroner (Filip, 26. okt. 2026: 25.000 kr., før 500.000).
create or replace function public.maks_beloeb_kr()
returns integer
language sql
immutable
set search_path = ''
as $fn$ select 25000 $fn$;

-- Rene beregninger - må kaldes af alle (ingen data).
grant execute on function public.koebergebyr_oere(bigint, boolean) to anon, authenticated, service_role;
grant execute on function public.saelgergebyr_oere(bigint, boolean) to anon, authenticated, service_role;
grant execute on function public.maks_beloeb_kr() to anon, authenticated, service_role;
revoke all on function public.sag_refusion_oere(text, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function public.faktura_koebergebyr_tekst(text, boolean) from public, anon, authenticated;
revoke all on function public.faktura_saelgergebyr_tekst(text) from public, anon, authenticated;
grant execute on function public.sag_refusion_oere(text, bigint, bigint, bigint) to service_role;

-- ===========================================================================
-- 2. betalinger.prismodel + trigger + CHECK-formler
-- ===========================================================================
-- Eksisterende rækker får 'gammel' (fast default - ingen UPDATE, ingen
-- triggere). Nye rækker sættes af triggeren nedenfor.
alter table public.betalinger add column if not exists prismodel text not null default 'gammel';
alter table public.betalinger alter column prismodel set default 'ny';

do $do$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.betalinger'::regclass and conname = 'betalinger_prismodel_check') then
    alter table public.betalinger
      add constraint betalinger_prismodel_check check (prismodel in ('gammel', 'ny', 'erhverv'));
  end if;
end $do$;

comment on column public.betalinger.prismodel is
  'Gebyrmodel (20261031010000): gammel = før 26. okt. 2026 (5 %/5 % + evt. tilkøbt BidHamr Beskyttelse), ny = privat (koebergebyr_oere/saelgergebyr_oere, Beskyttelse inkluderet ved forsendelse, beskyttelse_oere = 0), erhverv = 5 %/5 % uden Beskyttelse. Sættes af betalinger_b_prismodel og kan ikke ændres.';

-- Parterne (og appen) skal kunne vise den rigtige gebyrlinje.
grant select (prismodel) on public.betalinger to authenticated;

-- Navnet "betalinger_b_" får triggeren til at køre efter betalinger_a_fragtpris
-- (fragten fra auktionen) og før de andre BEFORE-triggere (alfabetisk).
create or replace function public.betalinger_b_prismodel()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_erhverv boolean;
begin
  if tg_op = 'INSERT' then
    select coalesce(a.erhverv, false) into v_erhverv
      from public.auctions a
     where a.id = coalesce(new.auction_id,
                           (select t.auction_id from public.trades t where t.id = new.trade_id));
    v_erhverv := coalesce(v_erhverv, false);
    new.prismodel         := case when v_erhverv then 'erhverv' else 'ny' end;
    new.fragt_oere        := coalesce(new.fragt_oere, 0);
    new.koebergebyr_oere  := public.koebergebyr_oere(new.bud_oere, v_erhverv);
    new.saelgergebyr_oere := public.saelgergebyr_oere(new.bud_oere, v_erhverv);
    new.udbetaling_oere   := new.bud_oere - new.saelgergebyr_oere;
    new.beskyttelse_oere  := 0;
    new.beskyttelse       := not v_erhverv and new.fragt_oere > 0;
    new.total_oere        := new.bud_oere + new.koebergebyr_oere + new.fragt_oere;
    return new;
  end if;

  -- UPDATE: prismodellen kan ikke ændres. I den nye model følger
  -- beskyttelse leveringsformen (fragt > 0 = forsendelse) - fx når køberen
  -- skifter mellem afhentning og forsendelse i checkout (handel_gem_levering).
  -- Beløbene røres ikke her (CHECK-formlerne afviser forkerte beløb).
  new.prismodel := old.prismodel;
  if old.prismodel <> 'gammel' then
    new.beskyttelse := old.prismodel = 'ny' and coalesce(new.fragt_oere, 0) > 0;
  end if;
  return new;
end;
$fn$;
revoke all on function public.betalinger_b_prismodel() from public, anon, authenticated;

drop trigger if exists betalinger_b_prismodel on public.betalinger;
create trigger betalinger_b_prismodel
  before insert or update of prismodel, fragt_oere, beskyttelse on public.betalinger
  for each row execute function public.betalinger_b_prismodel();

-- CHECK-formlerne (erstatter 20261019010000 afsnit 10). NOT VALID + VALIDATE:
-- afviger eksisterende rækker, bliver constrainten stående NOT VALID (nye og
-- ændrede rækker skal stadig passe), og antallet skrives.
do $do$
declare
  c record;
  n integer;
begin
  for c in
    select * from (values
      ('betalinger_koebergebyr_formel',
       $c$check (pengemodel = 'separat' or case when prismodel = 'gammel'
          then koebergebyr_oere = round(bud_oere * 5 / 100.0)
          else koebergebyr_oere = public.koebergebyr_oere(bud_oere, prismodel = 'erhverv') end)$c$),
      ('betalinger_saelgergebyr_formel',
       $c$check (pengemodel = 'separat' or case when prismodel = 'gammel'
          then saelgergebyr_oere = round(bud_oere * 5 / 100.0)
          else saelgergebyr_oere = public.saelgergebyr_oere(bud_oere, prismodel = 'erhverv') end)$c$),
      ('betalinger_beskyttelse_formel',
       $c$check (pengemodel = 'separat' or case when prismodel = 'gammel'
          then beskyttelse_oere = 0 or beskyttelse_oere = least(greatest(round(bud_oere * 5 / 100.0), 2500), 25000)
          else beskyttelse_oere = 0 and beskyttelse = (prismodel = 'ny' and fragt_oere > 0) end)$c$)
    ) as v(navn, def)
  loop
    -- Er constrainten allerede denne version (genkørsel), røres den ikke.
    if exists (select 1 from pg_constraint where conname = c.navn and conrelid = 'public.betalinger'::regclass
                and pg_get_constraintdef(oid) like '%prismodel%') then
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
-- 3. Udbetaling hver 14. dag - hjælpefunktion (bruges af claim og status)
-- ===========================================================================
-- Tidligst næste payout for sælgeren: 14 dage efter den seneste payout, der
-- er oprettet hos Stripe eller gennemført. Fejlede, annullerede og afviste
-- tæller ikke (pengene er tilbage på kontoen og skal kunne sendes igen).
-- null = ingen begrænsning.
create or replace function public.saelger_naeste_udbetaling_kl(p_saelger uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $fn$
  select max(u.oprettet) + interval '14 days'
    from public.saelger_udbetalinger u
   where u.seller_id = p_saelger
     and u.status in ('oprettet', 'paid');
$fn$;
revoke all on function public.saelger_naeste_udbetaling_kl(uuid) from public, anon, authenticated;
grant execute on function public.saelger_naeste_udbetaling_kl(uuid) to service_role;

-- Sælgerens egen næste udbetalingsdag (hjemmesiden og appen). null = ingen
-- ventetid (næste frigivne handel udbetales med det samme).
create or replace function public.min_naeste_udbetaling_kl()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $fn$
  select case when auth.uid() is null then null
              else (select x from (select public.saelger_naeste_udbetaling_kl(auth.uid()) as x) s
                     where x > now()) end;
$fn$;
revoke all on function public.min_naeste_udbetaling_kl() from public, anon;
grant execute on function public.min_naeste_udbetaling_kl() to authenticated, service_role;

-- ===========================================================================
-- 4. Funktioner rettet på stedet (md5-drift-tjek)
-- ===========================================================================
do $do$
begin
  raise notice 'afslut_udloebne_auktioner: %', pg_temp.ps_ret(
    'public.afslut_udloebne_auktioner()',
    'ca772fa53aa88b1ff98f123bdb108ddf',
    'cd2bfb4d1efbc90b7605593e11235862',
    jsonb_build_array(
      jsonb_build_array(
$g$    select a.id, a.bruger_id, a.vinder_id, a.forsendelse_mulig
      from public.auctions a$g$,
$n$    select a.id, a.bruger_id, a.vinder_id, a.forsendelse_mulig,
           coalesce(a.erhverv, false) as erhverv
      from public.auctions a$n$, 1),
      jsonb_build_array(
$g$      select coalesce(b.beskyttelse, false) into besk_valg
        from public.bids b
       where b.auktion_id = r.id and b.bruger_id = r.vinder_id
       order by b.oprettet desc, b."beløb" desc
       limit 1;
      besk_valg := coalesce(besk_valg, false);

      koeb  := round(bud * 5 / 100.0)::bigint;
      saelg := round(bud * 5 / 100.0)::bigint;$g$,
$n$      -- Ny prismodel (20261031010000): BidHamr Beskyttelse er inkluderet i
      -- købergebyret ved forsendelse (privat). Budets valg (bids.beskyttelse)
      -- ignoreres. Afhentning og erhverv: ingen Beskyttelse.
      besk_valg := coalesce(r.forsendelse_mulig, false) and not r.erhverv;

      koeb  := public.koebergebyr_oere(bud, r.erhverv);
      saelg := public.saelgergebyr_oere(bud, r.erhverv);$n$, 1),
      jsonb_build_array(
$g$      besk  := case when besk_valg then public.beregn_beskyttelse_oere(bud) else 0 end;$g$,
$n$      besk  := 0;$n$, 1)));

  raise notice 'andenchance_svar: %', pg_temp.ps_ret(
    'public.andenchance_svar(uuid,uuid,boolean)',
    'd854171e0482c893a04fc08551a80855',
    '761ddf3bca42fe8554bfa579f37055da',
    jsonb_build_array(
      jsonb_build_array(
$g$  koeb  := round(bud * 5 / 100.0)::bigint;
  saelg := round(bud * 5 / 100.0)::bigint;$g$,
$n$  -- Ny prismodel (20261031010000): samme funktioner som afslut_udloebne_auktioner.
  koeb  := public.koebergebyr_oere(bud, coalesce(a.erhverv, false));
  saelg := public.saelgergebyr_oere(bud, coalesce(a.erhverv, false));$n$, 1),
      jsonb_build_array(
$g$  besk  := case when x.beskyttelse then public.beregn_beskyttelse_oere(bud) else 0 end;$g$,
$n$  -- BidHamr Beskyttelse er inkluderet i købergebyret (tilbuddets valg ignoreres).
  besk  := 0;$n$, 1),
      jsonb_build_array(
$g$    bud, koeb, fragt, x.beskyttelse, besk,$g$,
$n$    bud, koeb, fragt, coalesce(a.forsendelse_mulig, false) and not coalesce(a.erhverv, false), besk,$n$, 1)));

  raise notice 'saet_maksimum: %', pg_temp.ps_ret(
    'public.saet_maksimum(uuid,numeric,boolean,timestamp with time zone)',
    'b97064dc2b8bbcf4ed96c949586ed0f8',
    '2eb2633340edd6274c2d1bc4886924c9',
    jsonb_build_array(
      jsonb_build_array(
$g$  v_besk := coalesce(p_beskyttelse, false) and coalesce(a.forsendelse_mulig, false)
            and not coalesce(a.erhverv, false);$g$,
$n$  -- Ny prismodel (20261031010000): BidHamr Beskyttelse vælges ikke længere ved
  -- buddet (den er inkluderet i købergebyret ved forsendelse). p_beskyttelse
  -- bevares for bagudkompatibilitet (appen), men ignoreres.
  v_besk := false;$n$, 1),
      jsonb_build_array(
$g$    select b.beskyttelse into v_nu_besk
      from public.bids b
     where b.auktion_id = p_auktion and b.bruger_id = v_uid
     order by b.oprettet desc, b."beløb" desc
     limit 1;
    v_nu_besk := coalesce(v_nu_besk, false);
    if p_beskyttelse is not null and v_besk <> v_nu_besk then
      raise exception 'beskyttelse_laast: Du fører allerede. BidHamr Beskyttelse følger dit bud og kan ikke ændres, mens du fører.';
    end if;
    v_besk := v_nu_besk;$g$,
$n$    -- (20261031010000: intet Beskyttelse-valg at låse længere.)
    v_nu_besk := false;$n$, 1)));

  raise notice 'sag_claim_refusion: %', pg_temp.ps_ret(
    'public.sag_claim_refusion(uuid)',
    'b3d540743f7454b9adbadbb9d055b7c7',
    'c17fb96d5867012ac791ea7863cbc0d7',
    jsonb_build_array(
      jsonb_build_array(
$g$  beloeb := b.total_oere - coalesce(b.beskyttelse_oere, 0);$g$,
$n$  -- Ny prismodel (Filip, 26. okt. 2026 - som Trendsales): køberen får kun
  -- buddet tilbage; købergebyr og fragt refunderes ikke. Gamle handler: alt
  -- undtagen BidHamr Beskyttelse (som før). public.sag_refusion_oere.
  beloeb := public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere);$n$, 1)));

  raise notice 'betaling_bidhamr_daekker_claim: %', pg_temp.ps_ret(
    'public.betaling_bidhamr_daekker_claim(uuid,uuid,text,uuid)',
    '8941fd4a65580d38921712a80f1e2817',
    '12bd75266e2ba5b81a586c858586a18e',
    jsonb_build_array(
      jsonb_build_array(
$g$        then b.total_oere - coalesce(b.beskyttelse_oere, 0)$g$,
$n$        -- 20261031010000: ny prismodel = kun buddet (public.sag_refusion_oere).
        then public.sag_refusion_oere(b.prismodel, b.bud_oere, b.total_oere, b.beskyttelse_oere)$n$, 1)));

  raise notice 'saelger_udbetaling_claim: %', pg_temp.ps_ret(
    'public.saelger_udbetaling_claim(uuid,text,uuid[])',
    '788c61fb8c93db6f68d69902555763c7',
    'b96aeedef9a8bacadb24870610d0c864',
    jsonb_build_array(
      jsonb_build_array(
$g$              where u.seller_id = p_saelger and u.status in ('claimet', 'usikker')) then
    return jsonb_build_object('kode', 'i_gang', 'afvist', v_afvist);
  end if;$g$,
$n$              where u.seller_id = p_saelger and u.status in ('claimet', 'usikker')) then
    return jsonb_build_object('kode', 'i_gang', 'afvist', v_afvist);
  end if;
  -- Udbetaling hver 14. dag (Filip, 26. okt. 2026 - 20261031010000): højst én
  -- payout pr. sælger pr. 14 dage. Under låsen, så to samtidige kørsler ikke
  -- begge kommer igennem. Intet låses eller ændres.
  if public.saelger_naeste_udbetaling_kl(p_saelger) > now() then
    return jsonb_build_object('kode', 'interval', 'afvist', v_afvist,
                              'naeste_kl', public.saelger_naeste_udbetaling_kl(p_saelger));
  end if;$n$, 1)));

  raise notice 'handel_udbetalingsstatus: %', pg_temp.ps_ret(
    'public.handel_udbetalingsstatus(uuid)',
    'f8a957f59515b6bc97c61cbdb13b6544',
    '14cc71e6a10709d6e70874a48f8d2d98',
    jsonb_build_array(
      jsonb_build_array(
$g$  return jsonb_build_object('status', 'venter',
                            'tidligst_kl', case when v_tid > now() then v_tid end,$g$,
$n$  -- Udbetaling hver 14. dag (20261031010000): tidligst 14 dage efter
  -- sælgerens seneste udbetaling (greatest ignorerer null).
  v_tid := greatest(v_tid, public.saelger_naeste_udbetaling_kl(b.seller_id));
  return jsonb_build_object('status', 'venter',
                            'tidligst_kl', case when v_tid > now() then v_tid end,$n$, 1)));

  raise notice 'faktura_planlaeg: %', pg_temp.ps_ret(
    'public.faktura_planlaeg(integer)',
    'eaccfc18b96f7d35e32abfd591253bbc',
    '67b378f749ee4d5c0875ee9c3d3a57b0',
    jsonb_build_array(
      jsonb_build_array(
$g$public.faktura_linje('koebergebyr', 'Købergebyr (5 %)', rb.koebergebyr_oere)$g$,
$n$public.faktura_linje('koebergebyr', public.faktura_koebergebyr_tekst(rb.prismodel, rb.beskyttelse), rb.koebergebyr_oere)$n$, 1),
      jsonb_build_array(
$g$public.faktura_linje('saelgergebyr', 'Sælgergebyr (5 %)', rb.saelgergebyr_oere)$g$,
$n$public.faktura_linje('saelgergebyr', public.faktura_saelgergebyr_tekst(rb.prismodel), rb.saelgergebyr_oere)$n$, 1),
      jsonb_build_array(
$g$           x.bidhamr_daekker_refund_id, x.bidhamr_daekker_oere, x.total_oere
      from public.fakturaer fa$g$,
$n$           x.bidhamr_daekker_refund_id, x.bidhamr_daekker_oere, x.total_oere,
           x.prismodel, x.bud_oere, x.saelgergebyr_oere
      from public.fakturaer fa$n$, 1),
      jsonb_build_array(
$g$       and not (x.bidhamr_daekker_refund_id is not null and fa.part = 'saelger')$g$,
$n$       and not (x.bidhamr_daekker_refund_id is not null and fa.part = 'saelger')
       -- Ny prismodel (20261031010000): ved medhold i en sag får køberen kun
       -- buddet tilbage - købergebyr og fragt beholdes, købers faktura står.
       and not (fa.part = 'koeber' and x.prismodel = 'ny'
                and ((x.bidhamr_daekker_refund_id is null and x.refusion_aarsag is not distinct from 'sag'
                      and x.refusion_oere is not distinct from x.bud_oere)
                     or (x.bidhamr_daekker_refund_id is not null and x.bidhamr_daekker_oere = x.bud_oere)))$n$, 1),
      jsonb_build_array(
$g$    elsif rf.refusion_gebyr_oere = rf.application_fee_oere then
      v_linjer := rf.linjer;$g$,
$n$    elsif rf.refusion_gebyr_oere = rf.application_fee_oere then
      v_linjer := rf.linjer;
    elsif rf.prismodel = 'ny' and rf.part = 'saelger'
          and rf.refusion_aarsag is not distinct from 'sag'
          and rf.refusion_gebyr_oere = rf.saelgergebyr_oere then
      -- Ny prismodel, sag med medhold (20261031010000): køberen fik buddet,
      -- sælgeren intet - BidHamr gav sælgergebyret tilbage. Sælgerens faktura
      -- krediteres helt (købers står - den kommer ikke herind).
      v_linjer := rf.linjer;$n$, 1)));

end $do$;
-- (create or replace via pg_get_functiondef bevarer rettighederne - uændrede.)

-- ===========================================================================
-- 5. Beløbsloft: startpris, bud og maksimum højst 25.000 kr.
-- ===========================================================================
-- Kun nye værdier: en eksisterende auktion/et maksimum over loftet kan stadig
-- få andre felter ændret (triggerne kører kun på kolonnen, og kun når
-- værdien ændres). Bud kan kun indsættes.
create or replace function public.beloebsloft_auktion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.startpris > public.maks_beloeb_kr()
     and (tg_op = 'INSERT' or new.startpris is distinct from old.startpris) then
    raise exception 'beloeb_for_hoejt: Startprisen kan højst være 25.000 kr.' using errcode = 'BHB05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.beloebsloft_auktion() from public, anon, authenticated;

create or replace function public.beloebsloft_bud()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new."beløb" > public.maks_beloeb_kr() then
    raise exception 'beloeb_for_hoejt: Det højeste tilladte bud er 25.000 kr.' using errcode = 'BHB05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.beloebsloft_bud() from public, anon, authenticated;

create or replace function public.beloebsloft_maksimum()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.maks_beloeb > public.maks_beloeb_kr()
     and (tg_op = 'INSERT' or new.maks_beloeb is distinct from old.maks_beloeb) then
    raise exception 'beloeb_for_hoejt: Dit maksimum kan højst være 25.000 kr.' using errcode = 'BHB05';
  end if;
  return new;
end;
$fn$;
revoke all on function public.beloebsloft_maksimum() from public, anon, authenticated;
-- (Triggerne fra 20261019010000 peger allerede på funktionerne.)

-- Et gammelt maksimum over loftet på en aktiv auktion ville få autobud til at
-- ramme loftet (buddet afvises med BHB05 - også for den, der byder imod).
-- Ingen findes i dag (test og produktion, 26. okt. 2026); findes der nogen,
-- skal staff se på dem.
do $do$
declare
  n integer;
begin
  select count(*) into n
    from public.bud_maksimum m
    join public.auctions a on a.id = m.auktion_id
   where m.maks_beloeb > public.maks_beloeb_kr() and a.status = 'aktiv';
  if n > 0 then
    raise notice 'Beløbsloft: % maksimum over 25.000 kr. på aktive auktioner - kontrollér dem (autobud over loftet afvises)', n;
  end if;
end $do$;

-- ===========================================================================
-- 6. Fragt for køber (pakkeshop): 42 / 52 / 67 kr.
-- ===========================================================================
update public.fragt_pakkestoerrelser
   set pakkeshop_oere = case kode when 'lille' then 4200 when 'mellem' then 5200 when 'stor' then 6700 end
 where kode in ('lille', 'mellem', 'stor')
   and pakkeshop_oere is distinct from case kode when 'lille' then 4200 when 'mellem' then 5200 when 'stor' then 6700 end;

-- Overgang: auktioner uden en igangværende handel (aktive, eller afsluttede,
-- der kan tilbydes næste byder), som står med den gamle låste pakkeshop-pris,
-- får den nye. Andre priser (fx 35 kr. fra før 20261012010000) røres ikke.
-- auctions_fragt er slået fra under opdateringen (den ville bevare den låste
-- pris), som i 20261012010000.
alter table public.auctions disable trigger auctions_fragt;
update public.auctions a
   set fragt_pakkeshop_oere = p.pakkeshop_oere
  from public.fragt_pakkestoerrelser p
 where p.kode = a.pakkestoerrelse
   and coalesce(a.forsendelse_mulig, false)
   and a.status in ('aktiv', 'afsluttet')
   and a.fragt_pakkeshop_oere = case p.kode when 'lille' then 4000 when 'mellem' then 5000 when 'stor' then 6500 end
   and not exists (select 1 from public.trades t where t.auction_id = a.id and t.status <> 'annulleret');
alter table public.auctions enable trigger auctions_fragt;

-- ===========================================================================
-- 7. Oprydning
-- ===========================================================================
drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.krop_md5(text);
