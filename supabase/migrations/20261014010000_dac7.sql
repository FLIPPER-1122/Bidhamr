-- DAC7: indsamling og indberetning af sælgeroplysninger til Skattestyrelsen.
-- ROADMAP fase 1 ("DAC7") - se docs/DAC7.md.
--
-- Regler (Skattestyrelsens indberetningsvejledning v1.2 + bekendtgørelse 1253):
--   - Salg af varer: en sælger skal indberettes, når BidHamr i et kalenderår
--     har formidlet MINDST 30 salg ELLER et samlet vederlag på OVER 2.000 EUR.
--     Sælgere med færre end 30 salg OG højst 2.000 EUR er "undtagne sælgere".
--   - Pr. sælger og kvartal: antal salg, vederlag (det, sælgeren får efter
--     BidHamrs gebyr) og gebyrer, som BidHamr har tilbageholdt. Skat = 0.
--   - Fristen er 31. januar året efter (fil-upload i TastSelv Erhverv,
--     Skattestyrelsens CSV-format). Sælgeren skal have en kopi inden samme frist.
--   - Mangler oplysningerne efter anmodning + to påmindelser og 60 dage fra
--     første anmodning, skal kontoen lukkes eller udbetalinger tilbageholdes.
--
-- Pengene (destination-modellen, 20261011*): et salg tæller, når køberens
-- betaling er gennemført (status 'betalt'), og pengene dermed er krediteret
-- sælgerens Stripe-konto (betalt_kl). Gamle 'separat'-betalinger tæller, når
-- de er overført (overfoert_kl). Refunderede betalinger tæller ikke (sælgeren
-- fik intet). En tabt indsigelse trækkes fra (indsigelse_tilbagefoert_oere).
-- Vederlag = udbetaling_oere (bud - sælgergebyr); gebyr = saelgergebyr_oere.
-- Kvartal og år efter dansk tid.
--
-- Skatte-id (CPR/TIN) gemmes KUN krypteret (AES-256-GCM i serverkoden,
-- nøglen DAC7_KRYPTERINGSNOEGLE findes kun på serveren). Databasen ser aldrig
-- CPR-nummeret i klar tekst og kan ikke dekryptere det. Tabellen kan kun
-- læses af service_role; brugeren selv og chefen får det kun gennem
-- serverkoden (brugeren maskeret, chefen i eksportfilen).
--
-- CHEFENS VALG (til Filips godkendelse - se docs/DAC7.md):
--   - Vi beder sælgeren om oplysningerne, allerede når han nærmer sig grænsen
--     (25 salg eller 1.500 EUR), med en frist på 60 dage og påmindelser efter
--     20 og 40 dage.
--   - Efter 60 dage uden oplysninger kan sælgeren ikke oprette nye auktioner
--     (fejlkode BHD01), før oplysningerne er givet. Igangværende auktioner og
--     handler kører videre, og udbetalinger tilbageholdes IKKE (se
--     noter-til-advokat.md nr. 111: loven nævner lukning eller tilbageholdelse).
--   - Kurs: 7,46 DKK pr. EUR som standard; chefen kan rette årets kurs.
--
-- Idempotent: kan køres igen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Notifikationstype 'skat' (påkrævet). FLETTES ind i de nuværende værdier
--    (som 20261012010000). HOLD SYNKRON med src/lib/notifikationer/typer.ts.
-- ---------------------------------------------------------------------------
do $do$
declare
  v_src  text;
  v_vals text[];
begin
  if to_regprocedure('public.notifikation_paakraevet(text)') is null then return; end if;
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.notifikation_paakraevet(text)');
  select array_agg(distinct x order by x) into v_vals from (
    select m[1] as x from regexp_matches(coalesce(v_src, ''), '''([a-z0-9_]+)''', 'g') as m
    union select 'skat'
  ) s;
  execute format($f$
    create or replace function public.notifikation_paakraevet(p_type text)
    returns boolean
    language sql immutable set search_path = '' as $b$
      select p_type = any (array[%s]);
    $b$
    $f$,
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(v_vals) as v));
end $do$;

-- ---------------------------------------------------------------------------
-- 1. Tabeller
-- ---------------------------------------------------------------------------

-- BidHamr som platformsoperatør (én række). Udfyldes af chefen i admin.
create table if not exists public.dac7_platform (
  id            boolean primary key default true check (id),
  cvr           text check (cvr is null or cvr ~ '^[0-9]{8}$'),
  navn          text check (navn is null or char_length(navn) between 1 and 200),
  vej           text check (vej is null or char_length(vej) between 1 and 200),
  postnummer    text check (postnummer is null or postnummer ~ '^[0-9]{4}$'),
  bynavn        text check (bynavn is null or char_length(bynavn) between 1 and 100),
  kontakt       text check (kontakt is null or char_length(kontakt) <= 200),
  opdateret_kl  timestamptz not null default now(),
  opdateret_af  uuid references public.users(id)
);

-- Pr. indkomstår: kurs og "sendt til Skattestyrelsen".
create table if not exists public.dac7_aar (
  aar           integer primary key check (aar between 2023 and 2100),
  eur_kurs      numeric(10,4) not null default 7.46 check (eur_kurs between 1 and 100),
  sendt_kl      timestamptz,
  sendt_af      uuid references public.users(id),
  kvittering    text check (kvittering is null or char_length(kvittering) <= 200),
  opdateret_kl  timestamptz not null default now()
);

-- Sælgerens egne oplysninger til DAC7 (private sælgere). Navn og fødselsdato
-- kommer fra MitID (mitid_verificeringer) og gemmes ikke igen her.
create table if not exists public.dac7_saelgeroplysninger (
  bruger_id             uuid primary key references public.users(id),
  adresse               text not null check (char_length(adresse) between 3 and 200),
  postnummer            text not null check (postnummer ~ '^[0-9A-Za-z -]{3,10}$'),
  bynavn                text not null check (char_length(bynavn) between 1 and 100),
  land                  text not null default 'DK' check (land ~ '^[A-Z]{2}$'),
  -- AES-256-GCM: v1.<iv>.<tag>.<data> (base64url). Bundet til bruger_id.
  cpr_krypteret         text not null check (cpr_krypteret ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{10,200}$'),
  -- Evt. skatte-id fra et andet EU-land (DAC7 kræver alle).
  andet_tin_land        text check (andet_tin_land is null or andet_tin_land ~ '^[A-Z]{2}$'),
  andet_tin_krypteret   text check (andet_tin_krypteret is null or andet_tin_krypteret ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,200}$'),
  oplyst_kl             timestamptz not null default now(),
  opdateret_kl          timestamptz not null default now(),
  check ((andet_tin_land is null) = (andet_tin_krypteret is null))
);

-- Anmodninger om oplysninger (én pr. sælger pr. år). Slettes aldrig.
create table if not exists public.dac7_anmodninger (
  bruger_id         uuid not null references public.users(id),
  aar               integer not null check (aar between 2023 and 2100),
  anmodet_kl        timestamptz not null default now(),
  frist             timestamptz not null,
  paamindelse_1_kl  timestamptz,
  paamindelse_2_kl  timestamptz,
  spaerret_kl       timestamptz,
  opfyldt_kl        timestamptz,
  primary key (bruger_id, aar)
);
create index if not exists dac7_anmodninger_aabne
  on public.dac7_anmodninger (bruger_id) where opfyldt_kl is null;

-- Kopien til sælgeren af det indberettede (DAC7 kræver den). Slettes aldrig.
-- CPR gemmes kun krypteret (samme format som ovenfor).
create table if not exists public.dac7_indberetninger (
  id               uuid primary key default gen_random_uuid(),
  aar              integer not null check (aar between 2023 and 2100),
  bruger_id        uuid not null references public.users(id),
  doc_ref_id       text not null check (char_length(doc_ref_id) <= 200),
  data             jsonb not null,
  cpr_krypteret    text,
  indberettet_kl   timestamptz not null default now(),
  unique (aar, bruger_id)
);
create index if not exists dac7_indberetninger_bruger on public.dac7_indberetninger (bruger_id);

-- Log over chefens handlinger (aldrig persondata eller CPR).
create table if not exists public.dac7_log (
  id              bigint generated always as identity primary key,
  kl              timestamptz not null default now(),
  medarbejder_id  uuid references public.users(id),
  bruger_id       uuid references public.users(id),
  handling        text not null check (handling in ('eksport', 'markeret_sendt', 'indstillinger', 'oplysninger_gemt')),
  aar             integer,
  antal           integer
);

-- Hvornår cron sidst kørte DAC7-tjekket (højst én gang i timen).
create table if not exists public.dac7_cron_status (
  id           boolean primary key default true check (id),
  sidst_koert  timestamptz
);

-- RLS: ingen direkte adgang for anon/authenticated. Alt går gennem
-- funktionerne herunder (service_role eller auth.uid()).
do $$
declare t text;
begin
  foreach t in array array['dac7_platform', 'dac7_aar', 'dac7_saelgeroplysninger',
                           'dac7_anmodninger', 'dac7_indberetninger', 'dac7_log', 'dac7_cron_status'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Handelsdata: anmodninger, kopier og log slettes aldrig.
create or replace function public.dac7_ingen_sletning()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'DAC7-data kan ikke slettes (skatteindberetning).' using errcode = '42501';
end $$;
revoke all on function public.dac7_ingen_sletning() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['dac7_anmodninger', 'dac7_indberetninger', 'dac7_log'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_sletning', t);
    execute format('create trigger %I before delete on public.%I for each row execute function public.dac7_ingen_sletning()',
                   t || '_ingen_sletning', t);
    execute format('drop trigger if exists %I on public.%I', t || '_ingen_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.dac7_ingen_sletning()',
                   t || '_ingen_truncate', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Beregning
-- ---------------------------------------------------------------------------

-- Årets kurs (DKK pr. EUR). Standard 7,46.
create or replace function public.dac7_kurs(p_aar integer)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select a.eur_kurs from public.dac7_aar a where a.aar = p_aar), 7.46);
$$;
revoke all on function public.dac7_kurs(integer) from public, anon, authenticated;

-- Alle salg i et år, ét pr. betaling (se reglerne øverst).
create or replace function public.dac7_salg(p_aar integer)
returns table (bruger_id uuid, betaling_id uuid, dato timestamptz, kvartal integer,
               vederlag_oere bigint, gebyr_oere bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with b as (
    select b.seller_id,
           b.id,
           case when b.pengemodel = 'separat' then b.overfoert_kl else b.betalt_kl end as dato,
           greatest(0, coalesce(b.udbetaling_oere, 0) - coalesce(b.indsigelse_tilbagefoert_oere, 0))::bigint as vederlag,
           coalesce(b.saelgergebyr_oere, 0)::bigint as gebyr
      from public.betalinger b
     where b.status = 'betalt'
       and b.seller_id is not null
       and b.seller_id <> public.bidhamr_system_id()
  )
  select b.seller_id, b.id, b.dato,
         extract(quarter from (b.dato at time zone 'Europe/Copenhagen'))::integer,
         b.vederlag, b.gebyr
    from b
   where b.dato is not null
     and b.vederlag > 0
     and extract(year from (b.dato at time zone 'Europe/Copenhagen'))::integer = p_aar;
$$;
revoke all on function public.dac7_salg(integer) from public, anon, authenticated;

-- Tal pr. sælger (alle sælgere med salg i året, eller kun én).
create or replace function public.dac7_saelgertal(p_aar integer, p_bruger uuid default null)
returns table (
  bruger_id uuid, antal integer, vederlag_oere bigint, gebyr_oere bigint,
  q1_antal integer, q1_vederlag bigint, q1_gebyr bigint,
  q2_antal integer, q2_vederlag bigint, q2_gebyr bigint,
  q3_antal integer, q3_vederlag bigint, q3_gebyr bigint,
  q4_antal integer, q4_vederlag bigint, q4_gebyr bigint,
  pligtig boolean, naer boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select * from public.dac7_salg(p_aar) x where p_bruger is null or x.bruger_id = p_bruger
  ), k as (select public.dac7_kurs(p_aar) as kurs)
  select s.bruger_id,
         count(*)::integer,
         sum(s.vederlag_oere)::bigint,
         sum(s.gebyr_oere)::bigint,
         count(*) filter (where s.kvartal = 1)::integer,
         coalesce(sum(s.vederlag_oere) filter (where s.kvartal = 1), 0)::bigint,
         coalesce(sum(s.gebyr_oere) filter (where s.kvartal = 1), 0)::bigint,
         count(*) filter (where s.kvartal = 2)::integer,
         coalesce(sum(s.vederlag_oere) filter (where s.kvartal = 2), 0)::bigint,
         coalesce(sum(s.gebyr_oere) filter (where s.kvartal = 2), 0)::bigint,
         count(*) filter (where s.kvartal = 3)::integer,
         coalesce(sum(s.vederlag_oere) filter (where s.kvartal = 3), 0)::bigint,
         coalesce(sum(s.gebyr_oere) filter (where s.kvartal = 3), 0)::bigint,
         count(*) filter (where s.kvartal = 4)::integer,
         coalesce(sum(s.vederlag_oere) filter (where s.kvartal = 4), 0)::bigint,
         coalesce(sum(s.gebyr_oere) filter (where s.kvartal = 4), 0)::bigint,
         -- Mindst 30 salg ELLER over 2.000 EUR.
         count(*) >= 30 or sum(s.vederlag_oere) > 2000 * (select kurs from k) * 100,
         -- Nærmer sig: 25 salg eller 1.500 EUR.
         count(*) >= 25 or sum(s.vederlag_oere) >= 1500 * (select kurs from k) * 100
    from s
   group by s.bruger_id;
$$;
revoke all on function public.dac7_saelgertal(integer, uuid) from public, anon, authenticated;

-- Hvad mangler for at kunne indberette sælgeren? Tom liste = komplet.
--   mitid   - juridisk navn/fødselsdato fra MitID (private)
--   oplysninger - adresse og CPR (private)
--   firma   - CVR/adresse på firmaet (erhverv; rettes af staff)
create or replace function public.dac7_mangler(p_bruger uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_type text;
  v      text[] := '{}';
begin
  select u.konto_type into v_type from public.users u where u.id = p_bruger;
  if v_type = 'erhverv' then
    if not exists (select 1 from public.firmaer f
                    where f.bruger_id = p_bruger and f.cvr ~ '^[0-9]{8}$'
                      and coalesce(f.adresse, '') <> '' and coalesce(f.postnummer, '') <> ''
                      and coalesce(f.bynavn, '') <> '') then
      v := v || 'firma'::text;
    end if;
    return v;
  end if;
  if not exists (select 1 from public.mitid_verificeringer m
                  where m.bruger_id = p_bruger and m.juridisk_navn is not null and m.foedselsdato is not null) then
    v := v || 'mitid'::text;
  end if;
  if not exists (select 1 from public.dac7_saelgeroplysninger o where o.bruger_id = p_bruger) then
    v := v || 'oplysninger'::text;
  end if;
  return v;
end $$;
revoke all on function public.dac7_mangler(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Sælgeren gemmer sine oplysninger (serveren krypterer CPR først).
--    Kun service_role. p_cpr_krypteret null = behold det gemte.
-- ---------------------------------------------------------------------------
create or replace function public.dac7_gem_oplysninger(
  p_bruger uuid, p_adresse text, p_postnummer text, p_bynavn text, p_land text,
  p_cpr_krypteret text, p_andet_tin_land text, p_andet_tin_krypteret text,
  p_behold_andet boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  select u.konto_type into v_type from public.users u
   where u.id = p_bruger and u.konto_slettet_kl is null;
  if not found then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  if v_type = 'erhverv' then return jsonb_build_object('kode', 'erhverv'); end if;
  if not exists (select 1 from public.mitid_verificeringer m
                  where m.bruger_id = p_bruger and m.status = 'aktiv') then
    return jsonb_build_object('kode', 'mitid');
  end if;
  if p_cpr_krypteret is null
     and not exists (select 1 from public.dac7_saelgeroplysninger o where o.bruger_id = p_bruger) then
    return jsonb_build_object('kode', 'cpr_mangler');
  end if;

  insert into public.dac7_saelgeroplysninger as o
    (bruger_id, adresse, postnummer, bynavn, land, cpr_krypteret, andet_tin_land, andet_tin_krypteret)
  values (p_bruger, btrim(p_adresse), btrim(p_postnummer), btrim(p_bynavn), coalesce(p_land, 'DK'),
          p_cpr_krypteret, p_andet_tin_land, p_andet_tin_krypteret)
  on conflict (bruger_id) do update set
    adresse = excluded.adresse,
    postnummer = excluded.postnummer,
    bynavn = excluded.bynavn,
    land = excluded.land,
    cpr_krypteret = coalesce(p_cpr_krypteret, o.cpr_krypteret),
    andet_tin_land = case when p_behold_andet then o.andet_tin_land else excluded.andet_tin_land end,
    andet_tin_krypteret = case when p_behold_andet then o.andet_tin_krypteret else excluded.andet_tin_krypteret end,
    opdateret_kl = now();

  -- Opfylder åbne anmodninger og ophæver en spærring.
  if cardinality(public.dac7_mangler(p_bruger)) = 0 then
    update public.dac7_anmodninger set opfyldt_kl = now()
     where bruger_id = p_bruger and opfyldt_kl is null;
  end if;

  insert into public.dac7_log (bruger_id, handling) values (p_bruger, 'oplysninger_gemt');
  return jsonb_build_object('kode', 'ok');
end $$;
revoke all on function public.dac7_gem_oplysninger(uuid, text, text, text, text, text, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.dac7_gem_oplysninger(uuid, text, text, text, text, text, text, text, boolean)
  to service_role;

-- Til serverkoden: den krypterede CPR for én bruger (dekrypteres og maskeres
-- i serverkoden til "Min konto"). Kun service_role.
create or replace function public.dac7_cpr_krypteret(p_bruger uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select o.cpr_krypteret from public.dac7_saelgeroplysninger o where o.bruger_id = p_bruger;
$$;
revoke all on function public.dac7_cpr_krypteret(uuid) from public, anon, authenticated;
grant execute on function public.dac7_cpr_krypteret(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Sælgerens egen status (hjemmesiden og appen). Kun egne data, intet CPR.
-- ---------------------------------------------------------------------------
create or replace function public.dac7_min_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_aar  integer := extract(year from (now() at time zone 'Europe/Copenhagen'))::integer;
  v_type text;
  t      record;
  v_kurs numeric;
begin
  if v_uid is null then return null; end if;
  select u.konto_type into v_type from public.users u where u.id = v_uid;
  v_kurs := public.dac7_kurs(v_aar);
  select * into t from public.dac7_saelgertal(v_aar, v_uid);

  return jsonb_build_object(
    'aar', v_aar,
    'konto_type', coalesce(v_type, 'privat'),
    'antal', coalesce(t.antal, 0),
    'vederlag_oere', coalesce(t.vederlag_oere, 0),
    'gebyr_oere', coalesce(t.gebyr_oere, 0),
    'graense_antal', 30,
    'graense_oere', round(2000 * v_kurs * 100)::bigint,
    'varsel_antal', 25,
    'varsel_oere', round(1500 * v_kurs * 100)::bigint,
    'pligtig', coalesce(t.pligtig, false),
    'naer', coalesce(t.naer, false),
    'mangler', to_jsonb(public.dac7_mangler(v_uid)),
    'mitid', (select jsonb_build_object('navn', m.juridisk_navn, 'foedselsdato', m.foedselsdato)
                from public.mitid_verificeringer m
               where m.bruger_id = v_uid and m.status = 'aktiv'
               order by m.verificeret_kl desc limit 1),
    'oplysninger', (select jsonb_build_object(
                      'adresse', o.adresse, 'postnummer', o.postnummer, 'bynavn', o.bynavn,
                      'land', o.land, 'cpr_oplyst', true, 'andet_tin_land', o.andet_tin_land,
                      'oplyst_kl', o.oplyst_kl, 'opdateret_kl', o.opdateret_kl)
                      from public.dac7_saelgeroplysninger o where o.bruger_id = v_uid),
    'anmodning', (select jsonb_build_object(
                    'aar', a.aar, 'anmodet_kl', a.anmodet_kl, 'frist', a.frist,
                    'paamindelser', (a.paamindelse_1_kl is not null)::int + (a.paamindelse_2_kl is not null)::int,
                    'spaerret', a.spaerret_kl is not null)
                    from public.dac7_anmodninger a
                   where a.bruger_id = v_uid and a.opfyldt_kl is null
                   order by a.aar desc limit 1),
    'indberetninger', coalesce((
      select jsonb_agg(jsonb_build_object('aar', i.aar, 'indberettet_kl', i.indberettet_kl, 'data', i.data)
                       order by i.aar desc)
        from public.dac7_indberetninger i where i.bruger_id = v_uid), '[]'::jsonb));
end $$;
revoke all on function public.dac7_min_status() from public, anon;
grant execute on function public.dac7_min_status() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Spærring: ingen nye auktioner, når fristen er overskredet (BHD01).
-- ---------------------------------------------------------------------------
create or replace function public.dac7_kraev(p_bruger uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then return; end if;
  if exists (select 1 from public.dac7_anmodninger a
              where a.bruger_id = p_bruger and a.opfyldt_kl is null and a.spaerret_kl is not null) then
    raise exception 'dac7_mangler: Du skal give os de oplysninger, Skattestyrelsen kræver, før du kan sætte flere varer til salg. Gå til Min konto → Skatteoplysninger.'
      using errcode = 'BHD01';
  end if;
end $$;
revoke all on function public.dac7_kraev(uuid) from public, anon, authenticated;

create or replace function public.auctions_dac7()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.dac7_kraev(new.bruger_id);
  return new;
end $$;
revoke all on function public.auctions_dac7() from public, anon, authenticated;

drop trigger if exists auctions_a1_dac7 on public.auctions;
create trigger auctions_a1_dac7
  before insert on public.auctions
  for each row execute function public.auctions_dac7();

-- ---------------------------------------------------------------------------
-- 6. Cron: anmodninger, påmindelser og spærring. Kun service_role.
--    Kører højst én gang i timen. Returnerer de trin, der er nået inden for de
--    seneste 3 dage, så serverkoden kan sende beskeden (idempotent med en
--    nøgle pr. trin - et nedbrud undervejs giver et nyt forsøg).
-- ---------------------------------------------------------------------------
create or replace function public.dac7_koer_cron(p_tving boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aar   integer := extract(year from (now() at time zone 'Europe/Copenhagen'))::integer;
  v_sidst timestamptz;
  r       record;
  v_nye   integer := 0;
begin
  insert into public.dac7_cron_status (id) values (true) on conflict (id) do nothing;
  select sidst_koert into v_sidst from public.dac7_cron_status where id for update;
  if not p_tving and v_sidst is not null and v_sidst > now() - interval '1 hour' then
    return jsonb_build_object('sprunget', true, 'beskeder', '[]'::jsonb);
  end if;
  update public.dac7_cron_status set sidst_koert = now() where id;

  -- Nye anmodninger: private sælgere, der nærmer sig grænsen (i år eller
  -- sidste år, så december-salg også fanges), og som mangler oplysninger.
  for r in
    select t.bruger_id, t.aar from (
      select s.bruger_id, v_aar as aar from public.dac7_saelgertal(v_aar) s where s.naer
      union
      select s.bruger_id, v_aar - 1 from public.dac7_saelgertal(v_aar - 1) s where s.naer
    ) t
    join public.users u on u.id = t.bruger_id
   where u.konto_type is distinct from 'erhverv'
     and u.konto_slettet_kl is null
     and cardinality(public.dac7_mangler(t.bruger_id)) > 0
     and not exists (select 1 from public.dac7_anmodninger a where a.bruger_id = t.bruger_id and a.aar = t.aar)
     -- Højst én åben anmodning pr. sælger (fx i januar for både i år og sidste år).
     and not exists (select 1 from public.dac7_anmodninger a where a.bruger_id = t.bruger_id and a.opfyldt_kl is null)
  loop
    insert into public.dac7_anmodninger (bruger_id, aar, frist)
    values (r.bruger_id, r.aar, now() + interval '60 days')
    on conflict do nothing;
    v_nye := v_nye + 1;
  end loop;

  -- Opfyldt (fx oplysningerne givet uden om formularen) - luk anmodningen.
  update public.dac7_anmodninger a set opfyldt_kl = now()
   where a.opfyldt_kl is null and cardinality(public.dac7_mangler(a.bruger_id)) = 0;

  -- Påmindelser og spærring. Mindst 7 dage mellem trinene, så en sælger
  -- altid får begge påmindelser i god tid - også hvis cron har stået stille.
  update public.dac7_anmodninger set paamindelse_1_kl = now()
   where opfyldt_kl is null and paamindelse_1_kl is null and anmodet_kl <= now() - interval '20 days';
  update public.dac7_anmodninger set paamindelse_2_kl = now()
   where opfyldt_kl is null and paamindelse_2_kl is null
     and paamindelse_1_kl <= now() - interval '7 days'
     and anmodet_kl <= now() - interval '40 days';
  update public.dac7_anmodninger set spaerret_kl = now()
   where opfyldt_kl is null and spaerret_kl is null
     and paamindelse_2_kl <= now() - interval '7 days'
     and frist <= now();

  return jsonb_build_object(
    'sprunget', false,
    'nye', v_nye,
    'beskeder', coalesce((
      select jsonb_agg(jsonb_build_object('bruger_id', x.bruger_id, 'aar', x.aar, 'trin', x.trin, 'frist', x.frist))
        from (
          select a.bruger_id, a.aar, 'anmodning' as trin, a.frist from public.dac7_anmodninger a
           where a.opfyldt_kl is null and a.anmodet_kl > now() - interval '3 days'
          union all
          select a.bruger_id, a.aar, 'paamindelse_1', a.frist from public.dac7_anmodninger a
           where a.opfyldt_kl is null and a.paamindelse_1_kl > now() - interval '3 days'
          union all
          select a.bruger_id, a.aar, 'paamindelse_2', a.frist from public.dac7_anmodninger a
           where a.opfyldt_kl is null and a.paamindelse_2_kl > now() - interval '3 days'
          union all
          select a.bruger_id, a.aar, 'spaerret', a.frist from public.dac7_anmodninger a
           where a.opfyldt_kl is null and a.spaerret_kl > now() - interval '3 days'
        ) x), '[]'::jsonb));
end $$;
revoke all on function public.dac7_koer_cron(boolean) from public, anon, authenticated;
grant execute on function public.dac7_koer_cron(boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Admin (KUN chef). Alle kun service_role; rollen tjekkes her OG i serveren.
-- ---------------------------------------------------------------------------
create or replace function public.dac7_er_chef(p_medarbejder uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.users u where u.id = p_medarbejder and u.rolle = 'chef'
                    and u.konto_slettet_kl is null);
$$;
revoke all on function public.dac7_er_chef(uuid) from public, anon, authenticated;

-- Oversigt for et år: alle sælgere, der er indberetningspligtige eller
-- nærmer sig, med status. Intet CPR.
create or replace function public.dac7_admin_oversigt(p_medarbejder uuid, p_aar integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.dac7_er_chef(p_medarbejder) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  return jsonb_build_object(
    'kode', 'ok',
    'aar', p_aar,
    'kurs', public.dac7_kurs(p_aar),
    'sendt_kl', (select a.sendt_kl from public.dac7_aar a where a.aar = p_aar),
    'kvittering', (select a.kvittering from public.dac7_aar a where a.aar = p_aar),
    'platform', (select to_jsonb(p) - 'id' - 'opdateret_af' from public.dac7_platform p where p.id),
    'saelgere', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bruger_id', s.bruger_id,
               'navn', u.navn,
               'konto_type', coalesce(u.konto_type, 'privat'),
               'slettet', u.konto_slettet_kl is not null,
               'antal', s.antal, 'vederlag_oere', s.vederlag_oere, 'gebyr_oere', s.gebyr_oere,
               'pligtig', s.pligtig, 'naer', s.naer,
               'mangler', to_jsonb(public.dac7_mangler(s.bruger_id)),
               'anmodet_kl', a.anmodet_kl, 'frist', a.frist,
               'paamindelser', (a.paamindelse_1_kl is not null)::int + (a.paamindelse_2_kl is not null)::int,
               'spaerret', a.spaerret_kl is not null and a.opfyldt_kl is null,
               'opfyldt_kl', a.opfyldt_kl,
               'indberettet_kl', i.indberettet_kl)
             order by s.pligtig desc, s.vederlag_oere desc)
        from public.dac7_saelgertal(p_aar) s
        join public.users u on u.id = s.bruger_id
        left join public.dac7_anmodninger a on a.bruger_id = s.bruger_id and a.aar = p_aar
        left join public.dac7_indberetninger i on i.bruger_id = s.bruger_id and i.aar = p_aar
       where s.naer or s.pligtig), '[]'::jsonb));
end $$;
revoke all on function public.dac7_admin_oversigt(uuid, integer) from public, anon, authenticated;
grant execute on function public.dac7_admin_oversigt(uuid, integer) to service_role;

-- Data til indberetningsfilen: alle indberetningspligtige sælgere med alle
-- oplysninger. CPR kun krypteret (serveren dekrypterer). Logges.
create or replace function public.dac7_admin_eksport(p_medarbejder uuid, p_aar integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  if not public.dac7_er_chef(p_medarbejder) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'bruger_id', s.bruger_id,
           'konto_type', coalesce(u.konto_type, 'privat'),
           'antal', s.antal, 'vederlag_oere', s.vederlag_oere, 'gebyr_oere', s.gebyr_oere,
           'kvartaler', jsonb_build_array(
             jsonb_build_object('antal', s.q1_antal, 'vederlag_oere', s.q1_vederlag, 'gebyr_oere', s.q1_gebyr),
             jsonb_build_object('antal', s.q2_antal, 'vederlag_oere', s.q2_vederlag, 'gebyr_oere', s.q2_gebyr),
             jsonb_build_object('antal', s.q3_antal, 'vederlag_oere', s.q3_vederlag, 'gebyr_oere', s.q3_gebyr),
             jsonb_build_object('antal', s.q4_antal, 'vederlag_oere', s.q4_vederlag, 'gebyr_oere', s.q4_gebyr)),
           'juridisk_navn', m.juridisk_navn,
           'foedselsdato', m.foedselsdato,
           'adresse', o.adresse, 'postnummer', o.postnummer, 'bynavn', o.bynavn, 'land', o.land,
           'cpr_krypteret', o.cpr_krypteret,
           'andet_tin_land', o.andet_tin_land, 'andet_tin_krypteret', o.andet_tin_krypteret,
           'firmanavn', f.firmanavn, 'cvr', f.cvr,
           'firma_adresse', f.adresse, 'firma_postnummer', f.postnummer, 'firma_bynavn', f.bynavn,
           'stripe_konto', bp.stripe_account_id,
           'mangler', to_jsonb(public.dac7_mangler(s.bruger_id)))
         order by s.bruger_id), '[]'::jsonb)
    into v
    from public.dac7_saelgertal(p_aar) s
    join public.users u on u.id = s.bruger_id
    left join lateral (select mv.juridisk_navn, mv.foedselsdato from public.mitid_verificeringer mv
                        where mv.bruger_id = s.bruger_id and mv.juridisk_navn is not null
                        order by (mv.status = 'aktiv') desc, mv.verificeret_kl desc limit 1) m on true
    left join public.dac7_saelgeroplysninger o on o.bruger_id = s.bruger_id
    left join public.firmaer f on f.bruger_id = s.bruger_id
    left join public.betalingsprofiler bp on bp.user_id = s.bruger_id
   where s.pligtig;

  insert into public.dac7_log (medarbejder_id, handling, aar, antal)
  values (p_medarbejder, 'eksport', p_aar, jsonb_array_length(v));

  return jsonb_build_object(
    'kode', 'ok', 'aar', p_aar, 'kurs', public.dac7_kurs(p_aar),
    'platform', (select to_jsonb(p) - 'id' - 'opdateret_af' from public.dac7_platform p where p.id),
    'saelgere', v);
end $$;
revoke all on function public.dac7_admin_eksport(uuid, integer) from public, anon, authenticated;
grant execute on function public.dac7_admin_eksport(uuid, integer) to service_role;

-- Platformsoplysninger og årets kurs.
create or replace function public.dac7_admin_gem_indstillinger(
  p_medarbejder uuid, p_aar integer, p_kurs numeric,
  p_cvr text, p_navn text, p_vej text, p_postnummer text, p_bynavn text, p_kontakt text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.dac7_er_chef(p_medarbejder) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_aar is null or p_aar < 2023 or p_aar > 2100 then return jsonb_build_object('kode', 'ugyldig'); end if;
  if p_kurs is not null and (p_kurs < 1 or p_kurs > 100) then return jsonb_build_object('kode', 'ugyldig_kurs'); end if;
  if exists (select 1 from public.dac7_aar a where a.aar = p_aar and a.sendt_kl is not null)
     and p_kurs is distinct from public.dac7_kurs(p_aar) and p_kurs is not null then
    return jsonb_build_object('kode', 'allerede_sendt');
  end if;

  if p_kurs is not null then
    insert into public.dac7_aar (aar, eur_kurs) values (p_aar, p_kurs)
    on conflict (aar) do update set eur_kurs = excluded.eur_kurs, opdateret_kl = now();
  end if;

  insert into public.dac7_platform as p (id, cvr, navn, vej, postnummer, bynavn, kontakt, opdateret_af)
  values (true, nullif(btrim(p_cvr), ''), nullif(btrim(p_navn), ''), nullif(btrim(p_vej), ''),
          nullif(btrim(p_postnummer), ''), nullif(btrim(p_bynavn), ''), nullif(btrim(p_kontakt), ''), p_medarbejder)
  on conflict (id) do update set
    cvr = excluded.cvr, navn = excluded.navn, vej = excluded.vej, postnummer = excluded.postnummer,
    bynavn = excluded.bynavn, kontakt = excluded.kontakt, opdateret_kl = now(), opdateret_af = p_medarbejder;

  insert into public.dac7_log (medarbejder_id, handling, aar) values (p_medarbejder, 'indstillinger', p_aar);
  return jsonb_build_object('kode', 'ok');
exception when check_violation then
  return jsonb_build_object('kode', 'ugyldig');
end $$;
revoke all on function public.dac7_admin_gem_indstillinger(uuid, integer, numeric, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.dac7_admin_gem_indstillinger(uuid, integer, numeric, text, text, text, text, text, text)
  to service_role;

-- "Sendt til Skattestyrelsen": markerer året og gemmer en kopi pr. sælger af
-- det indberettede (uden CPR i klar tekst). Kan kun ske én gang pr. år, og
-- kun efter årets udløb. Returnerer de sælgere, der skal have besked.
create or replace function public.dac7_admin_marker_sendt(p_medarbejder uuid, p_aar integer, p_kvittering text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aar_nu integer := extract(year from (now() at time zone 'Europe/Copenhagen'))::integer;
  v_cvr    text;
  v_antal  integer;
begin
  if not public.dac7_er_chef(p_medarbejder) then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_aar is null or p_aar >= v_aar_nu then return jsonb_build_object('kode', 'aaret_er_ikke_slut'); end if;
  if char_length(btrim(coalesce(p_kvittering, ''))) not between 1 and 200 then
    return jsonb_build_object('kode', 'kvittering_mangler');
  end if;
  select p.cvr into v_cvr from public.dac7_platform p where p.id;
  if v_cvr is null then return jsonb_build_object('kode', 'platform_mangler'); end if;

  insert into public.dac7_aar (aar) values (p_aar) on conflict (aar) do nothing;
  perform 1 from public.dac7_aar a where a.aar = p_aar for update;
  if exists (select 1 from public.dac7_aar a where a.aar = p_aar and a.sendt_kl is not null) then
    return jsonb_build_object('kode', 'allerede_sendt');
  end if;

  insert into public.dac7_indberetninger (aar, bruger_id, doc_ref_id, data, cpr_krypteret)
  select p_aar, s.bruger_id,
         'DK' || p_aar || v_cvr || 'S' || replace(s.bruger_id::text, '-', ''),
         jsonb_build_object(
           'konto_type', coalesce(u.konto_type, 'privat'),
           'navn', case when u.konto_type = 'erhverv' then f.firmanavn else m.juridisk_navn end,
           'foedselsdato', case when u.konto_type = 'erhverv' then null else m.foedselsdato end,
           'cvr', f.cvr,
           'adresse', case when u.konto_type = 'erhverv' then f.adresse else o.adresse end,
           'postnummer', case when u.konto_type = 'erhverv' then f.postnummer else o.postnummer end,
           'bynavn', case when u.konto_type = 'erhverv' then f.bynavn else o.bynavn end,
           'land', coalesce(o.land, 'DK'),
           'cpr_oplyst', o.cpr_krypteret is not null,
           'andet_tin_land', o.andet_tin_land,
           'antal', s.antal, 'vederlag_oere', s.vederlag_oere, 'gebyr_oere', s.gebyr_oere,
           'kvartaler', jsonb_build_array(
             jsonb_build_object('antal', s.q1_antal, 'vederlag_oere', s.q1_vederlag, 'gebyr_oere', s.q1_gebyr),
             jsonb_build_object('antal', s.q2_antal, 'vederlag_oere', s.q2_vederlag, 'gebyr_oere', s.q2_gebyr),
             jsonb_build_object('antal', s.q3_antal, 'vederlag_oere', s.q3_vederlag, 'gebyr_oere', s.q3_gebyr),
             jsonb_build_object('antal', s.q4_antal, 'vederlag_oere', s.q4_vederlag, 'gebyr_oere', s.q4_gebyr)),
           'valuta', 'DKK',
           'platform', 'BidHamr'),
         o.cpr_krypteret
    from public.dac7_saelgertal(p_aar) s
    join public.users u on u.id = s.bruger_id
    left join lateral (select mv.juridisk_navn, mv.foedselsdato from public.mitid_verificeringer mv
                        where mv.bruger_id = s.bruger_id and mv.juridisk_navn is not null
                        order by (mv.status = 'aktiv') desc, mv.verificeret_kl desc limit 1) m on true
    left join public.dac7_saelgeroplysninger o on o.bruger_id = s.bruger_id
    left join public.firmaer f on f.bruger_id = s.bruger_id
   where s.pligtig
  on conflict (aar, bruger_id) do nothing;
  get diagnostics v_antal = row_count;

  update public.dac7_aar set sendt_kl = now(), sendt_af = p_medarbejder,
         kvittering = btrim(p_kvittering), opdateret_kl = now()
   where aar = p_aar;

  insert into public.dac7_log (medarbejder_id, handling, aar, antal)
  values (p_medarbejder, 'markeret_sendt', p_aar, v_antal);

  return jsonb_build_object('kode', 'ok', 'antal', v_antal,
    'brugere', coalesce((select jsonb_agg(i.bruger_id) from public.dac7_indberetninger i where i.aar = p_aar), '[]'::jsonb));
end $$;
revoke all on function public.dac7_admin_marker_sendt(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.dac7_admin_marker_sendt(uuid, integer, text) to service_role;

-- Kopiens krypterede CPR (til "Min konto": serveren dekrypterer og maskerer).
create or replace function public.dac7_kopi_cpr_krypteret(p_bruger uuid, p_aar integer)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.cpr_krypteret from public.dac7_indberetninger i where i.bruger_id = p_bruger and i.aar = p_aar;
$$;
revoke all on function public.dac7_kopi_cpr_krypteret(uuid, integer) from public, anon, authenticated;
grant execute on function public.dac7_kopi_cpr_krypteret(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Kontosletning: oplysningerne bevares kun, hvis brugeren har solgt
--    (kan blive indberetningspligtig); ellers slettes de.
-- ---------------------------------------------------------------------------
create or replace function public.users_dac7_ved_sletning()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.konto_slettet_kl is null and new.konto_slettet_kl is not null then
    if not exists (select 1 from public.betalinger b where b.seller_id = new.id and b.status = 'betalt')
       and not exists (select 1 from public.dac7_indberetninger i where i.bruger_id = new.id) then
      delete from public.dac7_saelgeroplysninger where bruger_id = new.id;
    end if;
  end if;
  return new;
end $$;
revoke all on function public.users_dac7_ved_sletning() from public, anon, authenticated;

drop trigger if exists users_dac7_ved_sletning on public.users;
create trigger users_dac7_ved_sletning
  before update of konto_slettet_kl on public.users
  for each row execute function public.users_dac7_ved_sletning();

-- ---------------------------------------------------------------------------
-- 9. mine_data(): DAC7 med i "Download dine data" (intet CPR i klar tekst).
--    Bygger på mine_data_grund (20261013010000) og bevarer "mitid".
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.mine_data_grund()') is null then
    raise exception 'mine_data_grund mangler - kør 20261013010000_mitid.sql først';
  end if;
end $$;

create or replace function public.mine_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  v := public.mine_data_grund();
  return v || jsonb_build_object('mitid', jsonb_build_object(
    'verificeret_kl', (select u.mitid_verificeret_kl from public.users u where u.id = v_uid),
    'verificeringer', coalesce((
      select jsonb_agg(jsonb_build_object(
               'status', m.status,
               'juridisk_navn', m.juridisk_navn,
               'foedselsdato', m.foedselsdato,
               'verificeret_kl', m.verificeret_kl,
               'nulstillet_kl', m.nulstillet_kl) order by m.verificeret_kl)
        from public.mitid_verificeringer m where m.bruger_id = v_uid), '[]'::jsonb),
    'note', 'Vi gemmer ikke dit CPR-nummer fra MitID. Dit MitID-id gemmes kun sløret (hash), så samme MitID ikke kan bruges til flere konti.'))
  || jsonb_build_object('dac7', jsonb_build_object(
    'oplysninger', (select jsonb_build_object(
                      'adresse', o.adresse, 'postnummer', o.postnummer, 'bynavn', o.bynavn, 'land', o.land,
                      'cpr', 'oplyst (gemt krypteret - vises under Min konto → Skatteoplysninger)',
                      'andet_tin_land', o.andet_tin_land,
                      'oplyst_kl', o.oplyst_kl, 'opdateret_kl', o.opdateret_kl)
                      from public.dac7_saelgeroplysninger o where o.bruger_id = v_uid),
    'anmodninger', coalesce((
      select jsonb_agg(jsonb_build_object('aar', a.aar, 'anmodet_kl', a.anmodet_kl, 'frist', a.frist,
                                          'paamindelse_1_kl', a.paamindelse_1_kl, 'paamindelse_2_kl', a.paamindelse_2_kl,
                                          'spaerret_kl', a.spaerret_kl, 'opfyldt_kl', a.opfyldt_kl) order by a.aar)
        from public.dac7_anmodninger a where a.bruger_id = v_uid), '[]'::jsonb),
    'indberetninger', coalesce((
      select jsonb_agg(jsonb_build_object('aar', i.aar, 'indberettet_kl', i.indberettet_kl, 'data', i.data) order by i.aar)
        from public.dac7_indberetninger i where i.bruger_id = v_uid), '[]'::jsonb)));
end $$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated, service_role;

reset lock_timeout;
