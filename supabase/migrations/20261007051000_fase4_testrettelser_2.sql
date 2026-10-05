-- ============================================================================
-- Fase 4: rettelser efter slutreview (database/sikkerhed) - TESTDATABASEN
-- ============================================================================
--
-- 20261007050000_fase4_testrettelser.sql er rettet direkte (den er ikke koert
-- i produktion endnu). Denne fil giver testdatabasen, som allerede har koert
-- den gamle 050000, samme slutresultat. I produktion koeres begge filer i
-- raekkefoelge; 051000 er da en no-op (samme definitioner, intet at rydde).
--
--   1. Navne: navne_arkiv (kun service_role) gemmer de gamle vaerdier, foer
--      et navn ryddes. Oprydningen rammer KUN e-mail (@ + domaene) eller
--      telefonnummer (8+ cifre / +45) - ikke link-reglen. Triggeren for nye
--      navne afviser stadig links, men kraever 2+ tegn foer punktummet
--      ("A.de Jong", "J.P. Hansen" er tilladt). users_beskyt_lukket_konto
--      slaas ikke laengere fra (ingen ACCESS EXCLUSIVE-laas).
--      NB testdatabasen: 050000's oprydning (bredere regel, uden arkiv) er
--      allerede sket der og kan ikke fortrydes.
--   2. Kontaktfilteret: klokkeslaet/datoer i par (20.00-22.00, 24.12-27.12.),
--      beloebspar i hele hundreder (2500 3000), "maal", "klokken" er
--      neutrale; ref/konto/art neutraliserer ikke et nummer i 2-2-2-2/4-4-
--      format; str ikke 2-2-2-2; kl/klokken kun et klokkeslaet; "mit signal"
--      er ikke et socialt medie; "@1500" er ikke et brugernavn.
--      SPEJL: spamGrund() i src/lib/tryghed.ts.
--   3. profil_offentlige_tal: auktioner_oprettet uden skjulte auktioner;
--      auktioner_oprettet_alle (med skjulte) kun til brugeren selv.
--
-- Idempotent: create or replace / if not exists.

set local lock_timeout = '5s';

-- ============================================================ 2. Spamfilter

create or replace function public.besked_spam_grund(p_tekst text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  v text := public.besked_normaliser(p_tekst);
  w text;
  g text;
  m text[];
  a int; b int; c int; d int;
  -- (a) +45 / 0045 / (+45) + 8 cifre.
  p_landekode constant text :=
    '(\(\s*\+\s*45\s*\)|\+\s*45|(?<![0-9])0045)[\s.-]{0,2}[0-9]([\s.-]{0,2}[0-9]){7}(?![0-9])';
  -- (b) 8 cifre i traek.
  p_otte constant text := '(?<![0-9])[2-9][0-9]{7}(?![0-9])';
  -- (c) 2-2-2-2 eller 4-4 (bruges efter MobilePay).
  p_grupperet constant text :=
    '(?<![0-9])([2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}|[2-9][0-9]{3}[\s.-][0-9]{4})(?![0-9])';
  -- (c') Som (c), men heller ikke ved siden af en anden cifferblok
  -- ("0730 2533 0012" i et sporingsnummer).
  p_grp constant text :=
    '(?<![0-9][\s.,-])(?<![0-9])([2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}|[2-9][0-9]{3}[\s.-][0-9]{4})(?![\s.,-]?[0-9])';
  -- Et nummer i 2-2-2-2- eller 4-4-format (til ref/konto/art/str nedenfor).
  p_grp_2222 constant text :=
    '[2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}(?![\s.,-]?[0-9])';
  p_grp_44 constant text := '[2-9][0-9]{3}[\s.-][0-9]{4}(?![\s.,-]?[0-9])';
  p_nr constant text := '[\s.:#]*((nr|nummer|nummeret)\M)?[\s.:#]*';
  -- Klokkeslaet og datoer i par/intervaller.
  p_par_sep constant text := '(\s*[-–]\s*|\s+(og|til)\s+|\s+)';
  p_tid constant text := '([01][0-9]|2[0-3])[.:][0-5][0-9]';
  p_dato constant text := '(0[1-9]|[12][0-9]|3[01])\.(0[1-9]|1[0-2])\.?';
  p_foer constant text :=
    '\m(ring|ringe|ringer|tlf|tlfnr|telefon|telefonnummer|telefonnummeret|telefonnr'
    || '|mobil|mobilnummer|mobilnummeret|mobilnr|sms|skriv til|kontakt mig'
    || '|whats\s*app|signal|nummer|nummeret|nr|hilsen|mvh)\M';
  p_efter constant text :=
    '\m(ring|ringe|ringer|sms|hvis|tlf|telefon|mobil|nr|nummer|nummeret|whats\s*app|signal)\M';
  p_mobilepay constant text := '(mobile\s*pay|\mmp\M)';
  p_some constant text :=
    '(instagram|insta|\mig|facebook|\mfb|messenger|snap\s*chat|\msnap|tik\s*tok|telegram'
    || '|whats\s*app|\msignal|wechat|viber|discord)\M';
  -- Som p_some uden signal: "mit signal er daarligt" er ikke en kontaktvej.
  p_some_min constant text :=
    '(instagram|insta|\mig|facebook|\mfb|messenger|snap\s*chat|\msnap|tik\s*tok|telegram'
    || '|whats\s*app|wechat|viber|discord)\M';
  -- @brugernavn kraever mindst et bogstav eller _ ("Pris @1500" er en pris).
  p_at constant text := '@(?=[a-z0-9_.]*[a-z_])';
begin
  -- E-mail.
  if v ~ '[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\msnabel-?a\M)\s*[a-z0-9-]+(\.|\s+(punktum|dot)\s+)[a-z]{2,}' then
    return 'email';
  end if;

  -- Links.
  w := regexp_replace(v,
         '(?<![a-z0-9.@-])(https?://)?(www\.)?bidhamr\.dk(/[a-z0-9/_-]*)?(?![a-z0-9@-]|\.[a-z0-9])',
         ' ', 'g');
  w := regexp_replace(w,
         '(?<![a-z0-9.@-])(https?://)?([a-z0-9-]+\.)*'
         || '(gls\.dk|gls-group\.eu|gls-group\.com|postnord\.dk|dao\.as|bring\.dk'
         || '|ups\.com|dhl\.dk|dhl\.com|shipmondo\.com)'
         || '(/[a-z0-9/_?=&%#+-]*)?(?![a-z0-9@-]|\.[a-z0-9])',
         ' ', 'g');
  if w ~ '(https?://|www\.)'
     or w ~ '\m[a-z0-9-]{2,}\.(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)\M'
     or w ~ '\mt\.me\M'
     or w ~ '\m[a-z0-9-]{2,}\s+(punktum|dot)\s+(dk|com|net|org|io|me|eu|se|de|no|nu|co)\M' then
    return 'link';
  end if;

  -- MobilePay-nummer.
  if v ~ (p_mobilepay || '(\s*(boks|box))?[\s:#.]*((nr|nummer|nummeret|på|til)[\s:#.]*)?'
          || '(?<![0-9])[0-9]{4,5}(?![0-9])(?!\s*(kr|dkk|,-|\.-|,[0-9]|\.[0-9]))')
     or v ~ (p_mobilepay || '.{0,25}(' || p_landekode || '|' || p_otte || '|' || p_grupperet || ')') then
    return 'mobilepay';
  end if;

  -- Telefon (a) og (b).
  if v ~ p_landekode or v ~ p_otte then
    return 'telefon';
  end if;

  -- Telefon (c): arbejdskopi g, hvor tal, der ikke er telefonnumre, er
  -- erstattet med '#'. Samme raekkefoelge som neutraliserTal() i TS.
  -- Klokkeslaet/datoer i par: "20.00-22.00", "20.10 21.10", "24.12-27.12.".
  g := regexp_replace(v,
         '(?<![0-9][.:])(?<![0-9])(' || p_tid || p_par_sep || p_tid
         || '|' || p_dato || p_par_sep || p_dato || ')(?![.:]?[0-9])',
         ' # ', 'g');
  -- Cifre lige efter model, ordre(nr), postnr, sporing, maal m.fl.
  g := regexp_replace(g,
         '\m(model[a-zæøå]*'
         || '|ordre[a-zæøå]*|post\s*nr|postnummer[a-zæøå]*|sporing[a-zæøå]*|track[a-z]*'
         || '|stregkode|ean|imei|serie\s*nr|serienummer[a-zæøå]*|vare\s*nr|varenummer[a-zæøå]*'
         || '|faktura[a-zæøå]*|kunde\s*nr|kundenummer[a-zæøå]*'
         || '|reg|pakke[a-zæøå]*|mål[a-zæøå]*)\M'
         || p_nr || '[0-9][0-9\s.,/-]*',
         ' # ', 'g');
  -- ref/konto/art: aldrig et nummer i telefonformat (2-2-2-2 eller 4-4).
  g := regexp_replace(g,
         '\m(ref|reference|konto[a-zæøå]*|art)\M' || p_nr
         || '(?!' || p_grp_2222 || '|' || p_grp_44 || ')[0-9][0-9\s.,/-]*',
         ' # ', 'g');
  -- str/stoerrelse: ikke 2-2-2-2 (stoerrelseslister fanges nedenfor).
  g := regexp_replace(g,
         '\m(str|størrelse[a-zæøå]*|skostørrelse[a-zæøå]*|size|sizes)\M' || p_nr
         || '(?!' || p_grp_2222 || ')[0-9][0-9\s.,/-]*',
         ' # ', 'g');
  -- kl/klokken: kun et klokkeslaet (18, 18.30, 18:30, 18 30) uden ciffer efter.
  g := regexp_replace(g,
         '\m(kl|klokken)\M[\s.:]*([01]?[0-9]|2[0-3])([.:\s][0-5][0-9])?(?![\s.:,-]?[0-9])',
         ' # ', 'g');
  -- Aarstalspar: "2019 2020", "2019-2020", "2019 og 2020".
  g := regexp_replace(g,
         '(?<![0-9])(19|20)[0-9]{2}(\s*[-/]\s*|\s+(og|til)\s+|\s+)(19|20)[0-9]{2}(?![0-9])',
         ' # ', 'g');
  -- Beloebspar i hele hundreder: "2500 3000", "1500-2000".
  g := regexp_replace(g,
         '(?<![0-9])[1-9][0-9]{1,3}00(\s*[-–/]\s*|\s+(og|til|eller)\s+|\s+)[1-9][0-9]{1,3}00(?![0-9])',
         ' # ', 'g');
  -- Beloeb: "2500 3000 kr", "1.250,-".
  g := regexp_replace(g, '(?<![0-9])[0-9][0-9 .]*[0-9]\s*(kr\M|dkk\M|kroner\M|,-|\.-)', ' # ', 'g');
  -- Stoerrelseslister: fire 2-cifrede tal med fast trin 1 eller 2.
  for m in
    select regexp_matches(g,
             '((?<![0-9])([0-9]{2})[\s.,/-]+([0-9]{2})[\s.,/-]+([0-9]{2})[\s.,/-]+([0-9]{2})(?![0-9]))', 'g')
  loop
    a := m[2]::int; b := m[3]::int; c := m[4]::int; d := m[5]::int;
    if b - a in (1, 2) and c - b = b - a and d - c = b - a then
      g := replace(g, m[1], ' # ');
    end if;
  end loop;

  if g ~ (p_foer || '.{0,25}' || p_grp)
     or g ~ (p_grp || '.{0,15}' || p_efter)
     or g ~ (p_grp || '[^a-z0-9æøå]*$') then
    return 'telefon';
  end if;

  -- Sociale medier som kontaktvej.
  if v ~ (p_some || '\s*(:|=)\s*@?[a-z0-9_.]{3,}')
     or v ~ (p_some || '.{0,15}(?<![a-z0-9._%+-])' || p_at || '[a-z0-9_.]{3,}')
     or v ~ (p_some || '\s+(er|hedder)\s+@?(?=[a-z0-9_.]*[_.0-9])[a-z0-9_.]{3,}')
     or v ~ ('\m(på|via|over|gennem|i)\s+((min|mit|mine)\s+)?' || p_some)
     or v ~ ('\m(min|mit|mine)\s+' || p_some_min)
     or v ~ ('(^|[^a-z0-9._%+-])' || p_at || '[a-z0-9_][a-z0-9_.]{2,}') then
    return 'socialt_medie';
  end if;

  return null;
end;
$fn$;

revoke all on function public.besked_spam_grund(text) from public, anon;
grant execute on function public.besked_spam_grund(text) to authenticated, service_role;

-- ============================================================ 1. Visningsnavne

-- Indeholder et navn en e-mail, et telefonnummer eller et link? Bruges af
-- triggeren for NYE/AENDREDE navne. Strengere end chatten: '@' og 6+ cifre
-- er nok. Et link kraever mindst 2 tegn foer punktummet, saa "A.de Jong" og
-- "J.P. Hansen" er tilladt.
create or replace function public.navn_har_kontaktinfo(p_navn text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select p_navn is not null and btrim(p_navn) <> '' and (
         public.besked_normaliser(p_navn) ~ '@|\(at\)|\[at\]|\msnabel-?a\M'
      or length(regexp_replace(public.besked_normaliser(p_navn), '[^0-9]', '', 'g')) >= 6
      or public.besked_normaliser(p_navn) ~ '(https?:|www\.|\m[a-z0-9-]{2,}\.(dk|com|net|org|info|io|me|eu|se|de|no|nu|co|app|shop)\M)'
      or public.besked_spam_grund(p_navn) is not null);
$fn$;

revoke all on function public.navn_har_kontaktinfo(text) from public, anon;
grant execute on function public.navn_har_kontaktinfo(text) to authenticated, service_role;

-- Arkiv over navne, BidHamr har ryddet (saa oprydningen kan fortrydes).
-- Kun service_role: RLS slaaet til, ingen policies, ingen grants til
-- anon/authenticated.
create table if not exists public.navne_arkiv (
  id           bigint generated always as identity primary key,
  bruger_id    uuid not null,
  navn         text,
  fornavn      text,
  efternavn    text,
  arkiveret_kl timestamptz not null default now(),
  grund        text not null
);
comment on table public.navne_arkiv is
  'Gamle vaerdier af users.navn/fornavn/efternavn foer BidHamr ryddede dem '
  '(fx e-mail eller telefonnummer i navnet). Kun service_role. Fortryd: '
  'update public.users u set navn = a.navn, fornavn = a.fornavn, efternavn = a.efternavn '
  'from public.navne_arkiv a where a.bruger_id = u.id and a.grund = ... '
  '(kraever at users_navn_kontaktinfo slaas fra).';
alter table public.navne_arkiv enable row level security;
revoke all on table public.navne_arkiv from public, anon, authenticated;
grant all on table public.navne_arkiv to service_role;
create index if not exists navne_arkiv_bruger_idx on public.navne_arkiv (bruger_id);

-- Aabenlys kontaktinfo i et EKSISTERENDE navn: en e-mail (@ + domaene) eller
-- et telefonnummer (8+ cifre eller +45). IKKE link-reglen - den rammer fx
-- "A.de Jong". Kun til oprydningen (pg_temp: forsvinder efter migrationen).
create or replace function pg_temp.navn_aabenlys_kontaktinfo(p_navn text)
returns boolean
language sql
immutable
as $fn$
  select p_navn is not null and (
         public.besked_normaliser(p_navn) ~ '[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
      or length(regexp_replace(p_navn, '[^0-9]', '', 'g')) >= 8
      or p_navn ~ '\+\s*45');
$fn$;

-- Ryd eksisterende navne (DATAAENDRING - se overskriften). De gamle vaerdier
-- gemmes i navne_arkiv foerst. users_beskyt_lukket_konto slaas IKKE fra: den
-- afviser kun aendringer af lukke-kolonnerne og genaabning af en lukket
-- konto, ikke et nyt navn (testet med en lukket konto). Ingen tabellaas ud
-- over raekkelaase.
do $ryd$
declare
  v_antal int;
begin
  with ramt as (
    select u.id, u.navn, u.fornavn, u.efternavn,
           pg_temp.navn_aabenlys_kontaktinfo(u.navn) as r_navn,
           pg_temp.navn_aabenlys_kontaktinfo(u.fornavn) as r_fornavn,
           pg_temp.navn_aabenlys_kontaktinfo(u.efternavn) as r_efternavn
      from public.users u
     where u.id <> '00000000-0000-4000-8000-0000000b1d00'::uuid
       and (pg_temp.navn_aabenlys_kontaktinfo(u.navn)
            or pg_temp.navn_aabenlys_kontaktinfo(u.fornavn)
            or pg_temp.navn_aabenlys_kontaktinfo(u.efternavn))
       for update
  ),
  arkiv as (
    insert into public.navne_arkiv (bruger_id, navn, fornavn, efternavn, grund)
    select r.id, r.navn, r.fornavn, r.efternavn, 'fase4_kontaktinfo_i_navn'
      from ramt r
    returning bruger_id
  )
  update public.users u
     set navn      = case when r.r_navn then 'Bruger' else u.navn end,
         fornavn   = case when r.r_fornavn then null else u.fornavn end,
         efternavn = case when r.r_efternavn then null else u.efternavn end
    from ramt r
   where u.id = r.id
     and r.id in (select a.bruger_id from arkiv a);
  get diagnostics v_antal = row_count;
  raise notice 'Navne ryddet: % brugere (gamle vaerdier i public.navne_arkiv).', v_antal;
end;
$ryd$;

-- ============================================================ 3. Offentlige tal

-- Tal til profilen - samme definitioner som min_statistik (/konto/statistik):
--   auktioner_oprettet      = brugerens auktioner, UDEN dem BidHamr har
--                             skjult (skjult = true) - det offentlige tal,
--   auktioner_oprettet_alle = alle brugerens auktioner ("Oprettet i alt") -
--                             kun til brugeren selv, ellers null,
--   solgte_handler          = auktioner med en gennemfoert betaling ("Solgt"),
--   bud_afgivet             = auktioner, brugeren har budt paa (kun til
--                             brugeren selv, ellers null),
--   medlem_siden            = users.oprettet.
-- Ingen beloeb. null for ukendte/slettede brugere og systembrugeren.
create or replace function public.profil_offentlige_tal(p_bruger uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'auktioner_oprettet', (select count(*) from public.auctions a
                            where a.bruger_id = u.id and not coalesce(a.skjult, false)),
    'auktioner_oprettet_alle', case when u.id = auth.uid() then
                                 (select count(*) from public.auctions a where a.bruger_id = u.id)
                               end,
    'solgte_handler', (select count(*) from public.auctions a
                        where a.bruger_id = u.id
                          and exists (
                            select 1 from public.betalinger b
                             where b.auction_id = a.id
                               and b.status in ('betalt', 'frigivet')
                               and b.refunderet_kl is null and b.annulleret_kl is null
                               and (b.overfoert_kl is not null
                                    or (b.refusion_anmodet_kl is null
                                        and b.afsendelsesfrist_annulleret_kl is null
                                        and b.afhentningsfrist_annulleret_kl is null)))),
    'medlem_siden', u.oprettet,
    'bud_afgivet', case when u.id = auth.uid() then
                     (select count(distinct bi.auktion_id)
                        from public.bids bi
                        join public.auctions a on a.id = bi.auktion_id
                       where bi.bruger_id = u.id
                         and not coalesce(a.skjult, false))
                   end)
    from public.users u
   where u.id = p_bruger
     and u.id <> '00000000-0000-4000-8000-0000000b1d00'::uuid
     and u.konto_slettet_kl is null;
$fn$;

revoke all on function public.profil_offentlige_tal(uuid) from public;
grant execute on function public.profil_offentlige_tal(uuid) to anon, authenticated, service_role;

-- ============================================================ Test

-- Fejler et eksempel, afbrydes migrationen. Fase 3's eksempler
-- (20261006031000), 050000's og slutreviewets nye. PRAECIS samme liste
-- giver samme svar i TS-spejlet spamGrund() i src/lib/tryghed.ts.
do $test$
declare
  r record;
  v_faktisk text;
  v_fejl text := '';
begin
  for r in
    select * from (values
      ('Jeg har størrelse 42 43 44 45', null),
      ('Skostørrelse 38 39 40 41 er udsolgt', null),
      ('Postnr 8000 8200', null),
      ('Den koster 2500 3000 kr afhængig af model', null),
      ('Den er fra 2019 2020', null),
      ('Ordrenr 2024 1234', null),
      ('Model 25-10-20-30', null),
      ('sporing 00370730253300123456', null),
      ('Prisen er 1.250 kr, 12.10.2026', null),
      ('EAN 5701234567890 og IMEI 356938035643809', null),
      ('Str 2234 5678', null),
      ('ring på 22 34 56 78', 'telefon'),
      ('+45 22 34 56 78', 'telefon'),
      ('(+45) 22345678', 'telefon'),
      ('0045 2234-5678', 'telefon'),
      ('22345678', 'telefon'),
      ('Tlf. 2234 5678', 'telefon'),
      ('Mit nummer er 22-34-56-78', 'telefon'),
      ('skriv til mig på whatsapp 22.34.56.78', 'telefon'),
      ('22 34 56 78', 'telefon'),
      ('Mit nr er 2030 4050', 'telefon'),
      ('Tak, hilsen Sofie, 2030-4050', 'telefon'),
      ('Tak! 20 30 40 50', 'telefon'),
      ('2030 4050 hvis spørgsmål', 'telefon'),
      ('Tak for handlen 2030 4050 :)', 'telefon'),
      ('Mvh Sofie 2030 4050', 'telefon'),
      ('2030 4050 ring gerne', 'telefon'),
      ('Jeg har str 42 43 44 45', null),
      ('Har du 38 39 40 41?', null),
      ('Findes den i 36 38 40 42', null),
      ('Den er fra 2019-2020', null),
      ('Bilen er fra 2015 til 2018', null),
      ('Den koster 1500 kr', null),
      ('Kan sende for 2500 3000 kr', null),
      ('Afhentning i 2100 København', null),
      ('Kan hentes 2100 København eller 8000 Aarhus', null),
      ('Pakken har nummer 0037 0730 2533 0012 3456', null),
      ('Vi ses d. 20.10 kl. 18.30', null),
      ('Kan vi mødes kl 18 30?', null),
      ('Ordre nr 2024 1234', null),
      ('Kan jeg betale med MobilePay?', null),
      ('Hej, er den stadig til salg? Hilsen Sofie', null),
      ('Den er 2 år gammel og virker fint', null),
      ('Den måler 120 x 60 x 75 cm', null),
      ('Kan jeg betale med MobilePay? 1250 kr er fint', null),
      ('mobilepay 1250 kr', null),
      ('mp 1250,-', null),
      ('Jeg betaler gerne med MobilePay', null),
      ('mobilepay 12345', 'mobilepay'),
      ('MobilePay boks: 4321', 'mobilepay'),
      ('mp nr 98765', 'mobilepay'),
      ('send på mobilepay til 22 34 56 78', 'mobilepay'),
      ('se bidhamr.dk/auktion/123', null),
      ('Se mere på bidhamr.dk.', null),
      ('https://www.bidhamr.dk/handler', null),
      ('Pakken kan følges på gls-group.eu/DK/da/find-pakke?match=123', null),
      ('https://tracking.postnord.dk/da/?id=00370730253300123456', null),
      ('www.dhl.dk og shipmondo.com', null),
      ('bidhamr.dk/evil.com', 'link'),
      ('evil-bidhamr.dk', 'link'),
      ('bidhamr.dk.evil.com', 'link'),
      ('gls.dk.evil.io', 'link'),
      ('kig på shop.io', 'link'),
      ('skriv på t.me/minkanal', 'link'),
      ('min side minside.se', 'link'),
      ('evilgls.dk', 'link'),
      ('skriv til hans@mail.dk', 'email'),
      ('insta: sofie_99', 'socialt_medie'),
      ('skriv på facebook', 'socialt_medie'),
      ('find mig på snap', 'socialt_medie'),
      ('mit snap er sofie99', 'socialt_medie'),
      ('min insta er sofie_99', 'socialt_medie'),
      ('Skriv til mig @sofie_99', 'socialt_medie'),
      ('tilføj mig på fb', 'socialt_medie'),
      ('vi kan tage den over telegram', 'socialt_medie'),
      ('Jeg har også sat den til salg på Facebook Marketplace', 'socialt_medie'),
      ('Har du facebook?', null),
      ('Dårligt signal på mobilen, så svarer lidt sent', null),
      ('Den har et lille mærke ved stikket', null),
      ('Kan du sende med GLS?', null),
      ('Du kan hente den i aften 20.00-22.00', null),
      ('Jeg er hjemme fra klokken 20.30-22.30', null),
      ('Jeg er væk 24.12-27.12.', null),
      ('Kan hente 20.10 21.10 hvis det passer', null),
      ('Jeg byder 2500 3000', null),
      ('Mål 60 40 30 20', null),
      ('Mit signal er dårligt', null),
      ('Pris @1500', null),
      ('Kan hente mellem 16 og 18', null),
      ('Kan hentes kl 18-20', null),
      ('Jeg er hjemme 20:00 - 22:00', null),
      ('ring 20304050', 'telefon'),
      ('+45 20 30 40 50', 'telefon'),
      ('skriv på signal', 'socialt_medie'),
      ('signal: sofie_99', 'socialt_medie'),
      ('ref 2030 4050', 'telefon'),
      ('ref 2030 4050 ring', 'telefon'),
      ('konto 20 30 40 50', 'telefon'),
      ('kontonr 2030-4050', 'telefon'),
      ('art 2030 4050', 'telefon'),
      ('kl 20 30 40 50', 'telefon'),
      ('klokken 2030 4050', 'telefon'),
      ('str 20 30 40 50', 'telefon'),
      ('Mit nr er 20.30.21.40', 'telefon'),
      ('Ref 12345', null),
      ('Kontonr 1234567890', null),
      ('Kan hente kl 17', null)
    ) as x(tekst, forventet)
  loop
    v_faktisk := public.besked_spam_grund(r.tekst);
    if v_faktisk is distinct from r.forventet then
      v_fejl := v_fejl || format(E'\n  %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.forventet, 'null'), coalesce(v_faktisk, 'null'));
    end if;
  end loop;

  -- Visningsnavne: triggeren (navn_har_kontaktinfo) og oprydningen
  -- (navn_aabenlys_kontaktinfo - kun e-mail/telefon, ikke links).
  for r in
    select * from (values
      ('Sofie Hansen', false, false),
      ('Jens-Peter Ø. Madsen', false, false),
      ('Bruger', false, false),
      ('Sofie 2', false, false),
      ('A.de Jong', false, false),
      ('Anne-Marie', false, false),
      ('J.P. Hansen', false, false),
      ('Ole Ø.', false, false),
      ('sofie@mail.dk', true, true),
      ('Sofie 20304050', true, true),
      ('Sofie 20 30 40 50', true, true),
      ('Sofie +45 2030 4050', true, true),
      ('www.sofie.dk', true, false),
      ('sofie.dk', true, false)
    ) as x(tekst, trigger_afviser, ryddes)
  loop
    if public.navn_har_kontaktinfo(r.tekst) is distinct from r.trigger_afviser then
      v_fejl := v_fejl || format(E'\n  navn %L: trigger forventet %s', r.tekst, r.trigger_afviser);
    end if;
    if pg_temp.navn_aabenlys_kontaktinfo(r.tekst) is distinct from r.ryddes then
      v_fejl := v_fejl || format(E'\n  navn %L: oprydning forventet %s', r.tekst, r.ryddes);
    end if;
  end loop;

  if v_fejl <> '' then
    raise exception 'Fase 4-test fejlede:%', v_fejl;
  end if;
end;
$test$;
