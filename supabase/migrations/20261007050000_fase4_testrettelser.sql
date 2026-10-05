-- ============================================================================
-- Fase 4: rettelser efter test (database/sikkerhed)
-- ============================================================================
--
-- !!! DATAAENDRING I PRODUKTION, NAAR FILEN KOERES DER !!!
--   Afsnit 3 saetter visningsnavnet (public.users.navn) til 'Bruger' og
--   fjerner fornavn/efternavn, KUN naar de indeholder en e-mail (@ + domaene)
--   eller et telefonnummer (8+ cifre eller +45). De gamle vaerdier gemmes
--   foerst i public.navne_arkiv (kun service_role), saa det kan fortrydes.
--   Toerkoersel i produktion 6. okt. 2026: 11 brugere (11 navne + 9 fornavne,
--   alle = brugerens e-mail - den gamle handle_new_user brugte e-mailen som
--   navn). Ingen lukkede konti. Taelles foer koersel:
--     select count(*) from public.users
--      where lower(coalesce(navn,'')||' '||coalesce(fornavn,'')||' '||coalesce(efternavn,''))
--            ~ '[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
--         or length(regexp_replace(coalesce(navn,''), '[^0-9]', '', 'g')) >= 8;
--   Afsnit 6 retter teksten i eksisterende notifikationer (ingen sletning).
--   Tabellaase (trigger, constraint, indeks) venter hoejst 5 s (lock_timeout).
--
-- Indhold:
--   2. Kontaktinfo-filteret (besked_spam_grund -> ogsaa indeholder_kontaktinfo,
--      saa chat, Spoerg saelger og saelgersvar paa bedoemmelser):
--      a) Telefonnumre i formatet 2030 4050 / 2030-4050 / 20 30 40 50 stoppes
--         - med et kontaktord hoejst 25 tegn FOER (nu ogsaa nr, hilsen, mvh),
--         - med et kontaktord hoejst 15 tegn EFTER (ring, sms, hvis, tlf,
--           telefon, mobil, nr, nummer, whatsapp, signal),
--         - eller naar nummeret staar alene sidst i beskeden (kun tegn, der
--           ikke er bogstaver/cifre, efter). En besked, der KUN er
--           "22 34 56 78", stoppes derfor nu (fase 3's test er vendt).
--         Falske positiver undgaas ved at "neutralisere" cifre i en
--         arbejdskopi, foer reglerne koeres: klokkeslaet/datoer i par eller
--         intervaller (20.00-22.00, 20.10 21.10, 24.12-27.12.); cifre lige
--         efter model/ordre(nr)/postnr/sporing/ean/imei/serienr/varenr/
--         faktura/kundenr/reg/pakke/maal; efter ref/konto/art - men ALDRIG et
--         nummer i 2-2-2-2/4-4-format; efter str/stoerrelse - men ikke
--         2-2-2-2; efter kl/klokken kun et klokkeslaet; aarstalspar
--         (2019 2020); beloebspar i hele hundreder (2500 3000); beloeb foran
--         kr/dkk/,-; og lister af 2-cifrede tal med fast trin 1 eller 2
--         (stoerrelser "38 39 40 41", "36 38 40 42"). Cifre, der er del af en
--         laengere cifferraekke (sporingsnumre), rammes ikke.
--      b) Sociale medier (ny grund 'socialt_medie'): instagram, insta, ig,
--         facebook, fb, messenger, snap(chat), tiktok, telegram, whatsapp,
--         signal, wechat, viber, discord - naar de bruges som kontaktvej:
--           "insta: sofie_99" (kolon/@ + brugernavn), "mit snap er sofie99",
--           "på/via/over/gennem/i (min/mit) facebook", "min insta" (men
--           ikke "mit signal er daarligt"), og et selvstaendigt @brugernavn
--           med mindst et bogstav eller _ ("Pris @1500" er ok).
--         VURDERING: I chat, Spoerg saelger og saelgersvar er "paa Facebook
--         Marketplace" et kontaktforsoeg (at flytte handlen) og stoppes ogsaa.
--         Auktionsbeskrivelser bruger IKKE dette filter (kun forbudte varer),
--         saa "kan ogsaa ses paa Facebook Marketplace" i en beskrivelse er ok.
--         Ordet alene ("har du facebook?") stoppes ikke.
--      Fase 3's testeksempler + de nye koeres i DO-blokken sidst i filen.
--      SPEJL: spamGrund() i src/lib/tryghed.ts - hold reglerne synkrone.
--      messages_blokeret_grund_check FLETTES med 'socialt_medie'.
--   3. Visningsnavn: navn/fornavn/efternavn maa ikke indeholde e-mail,
--      telefonnummer eller link (navn_har_kontaktinfo; et link kraever 2+
--      tegn foer punktummet, saa "A.de Jong" og "J.P. Hansen" er tilladt).
--      Trigger users_navn_kontaktinfo: ved oprettelse -> 'Bruger' (fornavn/
--      efternavn -> null), ved aendring -> fejl BHN02. handle_new_user
--      renser ogsaa. Eksisterende navne ryddes KUN ved e-mail/telefonnummer
--      (se overskriften); de gamle vaerdier gemmes i public.navne_arkiv.
--      mine_data(): et modpart-fornavn, der ligner kontaktinfo, vises som
--      'Bruger'.
--   4. profil_offentlige_tal(p_bruger): auktioner oprettet (offentligt uden
--      auktioner, BidHamr har skjult; auktioner_oprettet_alle med dem, kun
--      for brugeren selv), solgte handler (samme definition som
--      min_statistik), medlem siden - og bud_afgivet kun for brugeren selv.
--      Ingen beloeb.
--   6. Notifikationer: eksisterende "Saelgeren har svaret paa din
--      bedoemmelse: "..."" faar tekst uden citat; "... er synlig(t) igen"
--      flyttes fra 'advarsel' til 'bedoemmelse' og faar et link.
--  10. auctions.idempotens_noegle (uuid, valgfri) + unikt indeks paa
--      (bruger_id, idempotens_noegle). Dublet -> 23505 paa indekset
--      auctions_idempotens_unik; klienten slaar den eksisterende auktion op
--      med min_auktion_for_noegle(p_noegle).
--   (5. Storage/to-trin ligger i 20261007032000_mfa_database_haandhaevelse.sql.)
--
-- Rene tekstfunktioner er security invoker (ingen tabeladgang); alle andre
-- er security definer. Alle har search_path = ''.
-- Idempotent: create or replace / if not exists / betingede updates.

set local lock_timeout = '5s';

-- ============================================================ 2. Spamfilter

-- Kontaktoplysninger, der skal stoppes: 'email', 'link', 'mobilepay',
-- 'telefon', 'socialt_medie' eller null.
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

-- messages_blokeret_grund_check: FLET eksisterende vaerdier + 'socialt_medie'.
do $flet$
declare
  v_def  text;
  v_vaerdier text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.messages'::regclass and c.conname = 'messages_blokeret_grund_check';
  select coalesce(array_agg(distinct x[1]), '{}') into v_vaerdier
    from regexp_matches(coalesce(v_def, ''), '''([a-z_]+)''', 'g') as x;
  v_vaerdier := array(select distinct unnest(v_vaerdier
                  || array['link', 'email', 'telefon', 'mobilepay', 'gentaget', 'socialt_medie'])
                  order by 1);
  alter table public.messages drop constraint if exists messages_blokeret_grund_check;
  execute format('alter table public.messages add constraint messages_blokeret_grund_check '
                 || 'check (blokeret_grund is null or blokeret_grund = any (%L::text[]))', v_vaerdier);
end;
$flet$;

-- ============================================================ 3. Visningsnavn

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

create or replace function public.users_navn_kontaktinfo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- Systembrugeren roeres ikke.
  if new.id = '00000000-0000-4000-8000-0000000b1d00'::uuid then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if public.navn_har_kontaktinfo(new.navn) then
      new.navn := 'Bruger';
    end if;
    if public.navn_har_kontaktinfo(new.fornavn) then
      new.fornavn := null;
    end if;
    if public.navn_har_kontaktinfo(new.efternavn) then
      new.efternavn := null;
    end if;
    return new;
  end if;
  if (new.navn is distinct from old.navn and public.navn_har_kontaktinfo(new.navn))
     or (new.fornavn is distinct from old.fornavn and public.navn_har_kontaktinfo(new.fornavn))
     or (new.efternavn is distinct from old.efternavn and public.navn_har_kontaktinfo(new.efternavn)) then
    raise exception 'Navnet må ikke indeholde en e-mail, et telefonnummer eller et link.'
      using errcode = 'BHN02';
  end if;
  return new;
end;
$fn$;

revoke all on function public.users_navn_kontaktinfo() from public, anon, authenticated;

drop trigger if exists users_navn_kontaktinfo on public.users;
create trigger users_navn_kontaktinfo
  before insert or update of navn, fornavn, efternavn on public.users
  for each row execute function public.users_navn_kontaktinfo();

-- handle_new_user: som 20261007030000 (testdatabasen), men renser navnene.
-- NB: produktionens udgave brugte e-mailen som navn - den erstattes her.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fornavn   text := left(nullif(btrim(new.raw_user_meta_data->>'fornavn'), ''), 100);
  v_efternavn text := left(nullif(btrim(new.raw_user_meta_data->>'efternavn'), ''), 100);
  v_navn      text := left(nullif(btrim(new.raw_user_meta_data->>'navn'), ''), 200);
begin
  if public.navn_har_kontaktinfo(v_fornavn) then v_fornavn := null; end if;
  if public.navn_har_kontaktinfo(v_efternavn) then v_efternavn := null; end if;
  if public.navn_har_kontaktinfo(v_navn) then v_navn := null; end if;
  if v_navn is null then
    v_navn := nullif(btrim(concat_ws(' ', v_fornavn, v_efternavn)), '');
  end if;
  insert into public.users (id, navn, fornavn, efternavn, email, telefon)
  values (
    new.id,
    coalesce(v_navn, 'Bruger'),
    v_fornavn,
    v_efternavn,
    new.email,
    new.raw_user_meta_data->>'telefon'
  );
  return new;
end;
$fn$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

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

-- mine_data: praecis kopi af 20261007031000 + modpart-fornavn via navn_har_kontaktinfo.
create or replace function public.mine_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := auth.uid();
  v     jsonb;
begin
  if v_uid is null then
    raise exception 'Ikke logget ind' using errcode = '42501';
  end if;
  if not public.rate_limit_tjek('mine_data:' || v_uid::text, 1, 3600) then
    raise exception 'Du kan hente dine data én gang i timen.' using errcode = 'BHR01';
  end if;

  with
  mine_handler as (
    select t.* from public.trades t where t.buyer_id = v_uid or t.seller_id = v_uid
  ),
  -- Kun de brugere, der optraeder i udtraekket (modparter), slaas op.
  modparter as (
    select case when t.buyer_id = v_uid then t.seller_id else t.buyer_id end as id from mine_handler t
    union
    select m.sender_id from public.messages m join mine_handler t on t.id = m.trade_id
    union
    select r.til_bruger_id from public.ratings r where r.fra_bruger_id = v_uid
    union
    select r.fra_bruger_id from public.ratings r where r.til_bruger_id = v_uid
    union
    select x.seller_id from public.seller_follows x where x.follower_id = v_uid
    union
    select x.blokeret_id from public.brugerblokeringer x where x.blokerer_id = v_uid
  ),
  fornavn as (
    select u.id,
           case when u.konto_slettet_kl is not null then 'Slettet bruger'
                -- NYT (20261007050000): aldrig en e-mail/et telefonnummer.
                when public.navn_har_kontaktinfo(u.fornavn) or public.navn_har_kontaktinfo(u.navn) then 'Bruger'
                else coalesce(nullif(btrim(u.fornavn), ''), nullif(split_part(btrim(u.navn), ' ', 1), ''), 'Bruger')
           end as navn
      from public.users u
     where u.id in (select p.id from modparter p where p.id is not null and p.id <> v_uid)
  )
  select jsonb_build_object(
    'om_udtraekket', jsonb_build_object(
      'dannet_kl', now(),
      'forklaring', 'Dette er de oplysninger, BidHamr har om dig. Andre brugere står kun med fornavn. Interne noter fra BidHamrs medarbejdere er ikke med. Bedømmelser, som BidHamr har skjult, er med og markeret "skjult af BidHamr".'),

    'profil', (select jsonb_build_object(
        'id', u.id, 'navn', u.navn, 'fornavn', u.fornavn, 'efternavn', u.efternavn,
        'email', u.email, 'telefon', u.telefon, 'adresse', u.adresse,
        'profilbillede', u.avatar_url, 'oprettet', u.oprettet, 'bedoemmelse', u.rating,
        'suspenderet', u.suspenderet, 'suspenderet_til', u.suspenderet_til)
      from public.users u where u.id = v_uid),

    'betalingsindstillinger', (select jsonb_build_object(
        'gemt_kort', case when p.gemt_kort_sidste4 is null then null else jsonb_build_object(
          'maerke', p.gemt_kort_maerke, 'sidste_4', p.gemt_kort_sidste4, 'udloeb', p.gemt_kort_udloeb) end,
        'automatisk_betaling', p.autobetaling,
        'udbetalingskonto_oprettet', p.stripe_account_id is not null,
        'udbetalinger_aktive', p.connect_udbetalinger_aktiv)
      from public.betalingsprofiler p where p.user_id = v_uid),

    'auktioner', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'titel', a.titel, 'beskrivelse', a.beskrivelse, 'kategori', a.kategori,
        'maerke', a.maerke, 'stand', a.stand, 'startpris', a.startpris,
        'nuvaerende_bud', a."nuværende_bud", 'antal_bud', a.antal_bud, 'status', a.status,
        'oprettet', a.oprettet, 'slutter_kl', a.slutter_kl, 'lokation', a.lokation,
        'postnummer', a.postnummer, 'forsendelse_mulig', a.forsendelse_mulig,
        'billeder', a.billeder) order by a.oprettet)
      from public.auctions a where a.bruger_id = v_uid), '[]'::jsonb),

    'bud', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', b.auktion_id, 'auktion', a.titel, 'beloeb', b."beløb",
        'bidhamr_beskyttelse', b.beskyttelse, 'tidspunkt', b.oprettet) order by b.oprettet)
      from public.bids b left join public.auctions a on a.id = b.auktion_id
     where b.bruger_id = v_uid), '[]'::jsonb),

    'handler', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'auktion_id', t.auction_id, 'vare', a.titel,
        'din_rolle', case when t.buyer_id = v_uid then 'køber' else 'sælger' end,
        'modpart_fornavn', (select f.navn from fornavn f
                             where f.id = case when t.buyer_id = v_uid then t.seller_id else t.buyer_id end),
        'beloeb', t.amount, 'status', t.status, 'oprettet', t.created_at,
        'sendt_kl', t.sendt_kl, 'modtaget_kl', t.received_at, 'afhentning', t.afhentning,
        'sporingsnummer', t.tracking_number,
        'betaling', (select case when t.buyer_id = v_uid then jsonb_build_object(
                        'bud_oere', p.bud_oere, 'koebergebyr_oere', p.koebergebyr_oere,
                        'fragt_oere', p.fragt_oere, 'bidhamr_beskyttelse_oere', p.beskyttelse_oere,
                        'total_oere', p.total_oere, 'status', p.status, 'betalt_kl', p.betalt_kl,
                        'refunderet_oere', p.refusion_oere, 'refunderet_kl', p.refunderet_kl)
                      else jsonb_build_object(
                        'bud_oere', p.bud_oere, 'saelgergebyr_oere', p.saelgergebyr_oere,
                        'udbetaling_oere', p.udbetaling_oere, 'status', p.status,
                        'betalt_kl', p.betalt_kl, 'frigivet_kl', p.frigivet_kl,
                        'overfoert_kl', p.overfoert_kl) end
                       from public.betalinger p where p.trade_id = t.id)
        ) order by t.created_at)
      from mine_handler t left join public.auctions a on a.id = t.auction_id), '[]'::jsonb),

    'beskeder_i_handler', coalesce((select jsonb_agg(jsonb_build_object(
        'handel_id', m.trade_id,
        'fra', case when m.fra_bidhamr then 'BidHamr'
                    when m.sender_id = v_uid then 'dig'
                    else (select f.navn from fornavn f where f.id = m.sender_id) end,
        'tekst', m.content, 'sendt_kl', m.created_at) order by m.created_at)
      from public.messages m join mine_handler t on t.id = m.trade_id
     -- Beskeder, spamfilteret skjulte for dig, har du aldrig set.
     where m.sender_id = v_uid or m.blokeret_grund is null), '[]'::jsonb),

    'samtaler_med_bidhamr', coalesce((select jsonb_agg(jsonb_build_object(
        'emne', s.emne, 'aabnet_kl', s.aabnet_kl, 'lukket_kl', s.lukket_kl,
        'beskeder', coalesce((select jsonb_agg(jsonb_build_object(
            'fra', case when b.fra_staff then 'BidHamr' else 'dig' end,
            'tekst', b.tekst, 'sendt_kl', b.oprettet_kl) order by b.oprettet_kl)
          from public.staff_beskeder b where b.samtale_id = s.id), '[]'::jsonb)
        ) order by s.aabnet_kl)
      from public.staff_samtaler s where s.bruger_id = v_uid), '[]'::jsonb),

    'bedoemmelser_givet', coalesce((select jsonb_agg(jsonb_build_object(
        'til_fornavn', (select f.navn from fornavn f where f.id = r.til_bruger_id),
        'auktion', a.titel, 'stjerner', r.stjerner, 'kommentar', r.kommentar,
        'skjult_af_bidhamr', coalesce(r.skjult, false),
        'synlighed', case when r.skjult then 'skjult af BidHamr' else 'synlig' end,
        'tidspunkt', r.oprettet) order by r.oprettet)
      from public.ratings r left join public.auctions a on a.id = r.auktion_id
     where r.fra_bruger_id = v_uid), '[]'::jsonb),

    'bedoemmelser_modtaget', coalesce((select jsonb_agg(jsonb_build_object(
        'fra_fornavn', (select f.navn from fornavn f where f.id = r.fra_bruger_id),
        'auktion', a.titel, 'stjerner', r.stjerner, 'kommentar', r.kommentar,
        'skjult_af_bidhamr', coalesce(r.skjult, false),
        'synlighed', case when r.skjult then 'skjult af BidHamr' else 'synlig' end,
        'tidspunkt', r.oprettet) order by r.oprettet)
      from public.ratings r left join public.auctions a on a.id = r.auktion_id
     where r.til_bruger_id = v_uid), '[]'::jsonb),

    'spoergsmaal_du_har_stillet', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', q.auction_id, 'spoergsmaal', q.question, 'svar', q.answer,
        'stillet_kl', q.asked_at, 'besvaret_kl', q.answered_at) order by q.asked_at)
      from public.auction_questions q where q.asker_id = v_uid), '[]'::jsonb),

    'sager', coalesce((select jsonb_agg(jsonb_build_object(
        'handel_id', s.trade_id, 'type', s.type,
        'oprettet_af_dig', s.oprettet_af = v_uid,
        'beskrivelse', case when s.oprettet_af = v_uid then s.beskrivelse else null end,
        'status', s.status, 'afgoerelse', s.begrundelse,
        'oprettet_kl', s.oprettet_kl, 'afgjort_kl', s.afgjort_kl) order by s.oprettet_kl)
      from public.sager s join mine_handler t on t.id = s.trade_id), '[]'::jsonb),

    'anker', coalesce((select jsonb_agg(jsonb_build_object(
        'handel_id', k.trade_id, 'begrundelse', k.begrundelse, 'status', k.status,
        'afgoerelse', k.afgoerelse_begrundelse, 'indgivet_kl', k.indgivet_kl,
        'behandlet_kl', k.behandlet_kl) order by k.indgivet_kl)
      from public.sag_anker k where k.indgivet_af = v_uid), '[]'::jsonb),

    'advarsler', coalesce((select jsonb_agg(jsonb_build_object(
        'begrundelse', w.begrundelse_bruger, 'tidspunkt', w.oprettet_kl) order by w.oprettet_kl)
      from public.advarsler w where w.bruger_id = v_uid), '[]'::jsonb),

    'paamindelser', coalesce((select jsonb_agg(jsonb_build_object(
        'grund', p.grund, 'begrundelse', p.begrundelse_bruger, 'tidspunkt', p.oprettet_kl)
        order by p.oprettet_kl)
      from public.paamindelser p where p.bruger_id = v_uid), '[]'::jsonb),

    'notifikationsindstillinger', coalesce((select jsonb_agg(jsonb_build_object(
        'type', n.type, 'klokke', n.klokke, 'mail', n.mail, 'push', n.push) order by n.type)
      from public.notifikation_indstillinger n where n.bruger_id = v_uid), '[]'::jsonb),

    'notifikationer', coalesce((select jsonb_agg(jsonb_build_object(
        'type', n.type, 'titel', n.titel, 'tekst', n.tekst, 'tidspunkt', n.oprettet_kl,
        'laest_kl', n.laest_kl) order by n.oprettet_kl)
      from public.notifikationer n where n.bruger_id = v_uid), '[]'::jsonb),

    'favoritter', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', x.auction_id, 'auktion', a.titel, 'tilfoejet_kl', x.created_at)
        order by x.created_at)
      from public.favorites x left join public.auctions a on a.id = x.auction_id
     where x.user_id = v_uid), '[]'::jsonb),

    'gemte_auktioner', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', x.auction_id, 'auktion', a.titel, 'tilfoejet_kl', x.created_at)
        order by x.created_at)
      from public.saved_auctions x left join public.auctions a on a.id = x.auction_id
     where x.user_id = v_uid), '[]'::jsonb),

    'saelgere_du_foelger', coalesce((select jsonb_agg(jsonb_build_object(
        'saelger_fornavn', (select f.navn from fornavn f where f.id = x.seller_id),
        'siden', x.created_at) order by x.created_at)
      from public.seller_follows x where x.follower_id = v_uid), '[]'::jsonb),

    'antal_foelgere', (select count(*) from public.seller_follows x where x.seller_id = v_uid),

    'blokerede_brugere', coalesce((select jsonb_agg(jsonb_build_object(
        'bruger', case when x.kilde_auktion_id is not null then 'Anonym byder'
                       else (select f.navn from fornavn f where f.id = x.blokeret_id) end,
        'siden', x.oprettet_kl) order by x.oprettet_kl)
      from public.brugerblokeringer x where x.blokerer_id = v_uid), '[]'::jsonb),

    'rapporter_om_auktioner', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion_id', r.auction_id, 'kategori', r.category, 'beskrivelse', r.description,
        'status', r.status, 'tidspunkt', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = v_uid), '[]'::jsonb),

    'rapporter_om_brugere', coalesce((select jsonb_agg(jsonb_build_object(
        'kategori', r.category, 'beskrivelse', r.description, 'handel_id', r.trade_id,
        'status', r.status, 'tidspunkt', r.created_at) order by r.created_at)
      from public.bruger_rapporter r where r.reporter_id = v_uid), '[]'::jsonb),

    'kontakthenvendelser', coalesce((select jsonb_agg(jsonb_build_object(
        'emne', k.emne, 'besked', k.besked, 'email', k.email, 'status', k.status,
        'tidspunkt', k.oprettet_kl) order by k.oprettet_kl)
      from public.kontakt_henvendelser k where k.bruger_id = v_uid), '[]'::jsonb),

    'enheder', coalesce((select jsonb_agg(jsonb_build_object(
        'enhed', e.beskrivelse, 'foerst_set', e.foerst_set_kl, 'sidst_set', e.sidst_set_kl)
        order by e.sidst_set_kl desc)
      from public.kendte_enheder e where e.bruger_id = v_uid), '[]'::jsonb),

    'gemte_soegninger', coalesce((select jsonb_agg(jsonb_build_object(
        'navn', g.navn, 'soegeord', g.soegeord, 'kategori', g.kategori,
        'postnummer', g.postnummer, 'radius_km', g.radius_km,
        'pris_min', g.pris_min, 'pris_max', g.pris_max, 'besked', g.besked,
        'oprettet', g.oprettet_kl) order by g.oprettet_kl)
      from public.gemte_soegninger g where g.bruger_id = v_uid), '[]'::jsonb),

    'dine_svar_paa_bedoemmelser', coalesce((select jsonb_agg(jsonb_build_object(
        'auktion', a.titel, 'svar', x.tekst, 'oprettet', x.oprettet,
        'rettet_kl', x.rettet_kl, 'slettet_kl', x.slettet_kl, 'skjult', x.skjult)
        order by x.oprettet)
      from public.bedoemmelse_svar x
      left join public.ratings r on r.id = x.rating_id
      left join public.auctions a on a.id = r.auktion_id
     where x.saelger_id = v_uid), '[]'::jsonb),

    'auktionsskabeloner', coalesce((select jsonb_agg(jsonb_build_object(
        'navn', s.name, 'indhold', s.data, 'oprettet', s.created_at) order by s.created_at)
      from public.auction_templates s where s.user_id = v_uid), '[]'::jsonb)
  ) into v;

  return v;
end;
$fn$;

revoke all on function public.mine_data() from public, anon;
grant execute on function public.mine_data() to authenticated;


-- ============================================================ 4. Offentlige tal

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

-- ============================================================ 6. Notifikationer

-- Svar paa bedoemmelse: ingen citat af svaret.
update public.notifikationer
   set tekst = 'Sælgeren har svaret på din bedømmelse – se svaret.'
 where type = 'bedoemmelse'
   and tekst like 'Sælgeren har svaret på din bedømmelse: %';

-- "... er synlig(t) igen": type 'bedoemmelse' + link til bedoemmelsen paa
-- profilen (bedoemmelse og svar vises samme sted).
update public.notifikationer n
   set type = 'bedoemmelse',
       link = coalesce(case when r.id is not null
                             then '/profil/' || r.til_bruger_id || '#bedoemmelse-' || r.id end, n.link)
  from public.notifikationer n2
  left join public.ratings r
    on r.id = case when (n2.data->>'rating_id') ~ '^[0-9a-f-]{36}$'
                   then (n2.data->>'rating_id')::uuid end
 where n.id = n2.id
   and n.type = 'advarsel'
   and n.titel in ('Din bedømmelse er synlig igen', 'Dit svar på en bedømmelse er synligt igen');

-- ============================================================ 10. Idempotens

alter table public.auctions add column if not exists idempotens_noegle uuid;
comment on column public.auctions.idempotens_noegle is
  'Valgfri noegle fra klienten (en uuid pr. opret-formular). To indsaettelser '
  'med samme noegle fra samme bruger afvises (23505, auctions_idempotens_unik).';
create unique index if not exists auctions_idempotens_unik
  on public.auctions (bruger_id, idempotens_noegle);

-- Den auktion, brugeren allerede har oprettet med noeglen (eller null).
create or replace function public.min_auktion_for_noegle(p_noegle uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id from public.auctions a
   where a.bruger_id = auth.uid() and a.idempotens_noegle = p_noegle
   limit 1;
$fn$;

revoke all on function public.min_auktion_for_noegle(uuid) from public, anon;
grant execute on function public.min_auktion_for_noegle(uuid) to authenticated;

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
