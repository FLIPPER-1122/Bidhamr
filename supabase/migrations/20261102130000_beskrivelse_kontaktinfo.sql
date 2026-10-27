-- Kontaktoplysninger i en auktions titel og beskrivelse (Filip, 27. okt. 2026).
--
-- Telefonnumre, e-mails, links og MobilePay-/bankoplysninger må ikke stå i en
-- auktion - køber og sælger skal tale sammen via BidHamr.
--   - Private sælgere: alt, som chattens spamfilter stopper
--     (public.besked_spam_grund, seneste udgave 20261102080000_handel_testfund.sql),
--     blokeres - link, e-mail, bank/kort, MobilePay, telefon og sociale medier.
--   - Firmaer (users.konto_type = 'erhverv'): links må gerne stå (fx til
--     firmaets egen hjemmeside - alle links, fordi firmaer ikke har et
--     hjemmeside-felt, og mange bruger en gmail-adresse). Telefon, e-mail,
--     MobilePay, bank og sociale medier blokeres stadig: kontaktoplysningerne
--     står allerede på firmasiden.
--
-- Indhold:
--   1. public.auktion_kontaktinfo_grund(tekst, erhverv) -> grund | null.
--      Firma: findes et link, fjernes alle links, og resten tjekkes igen (så
--      "www.firma.dk ring 22 33 44 55" stadig stoppes). E-mail tjekkes altid
--      på den oprindelige tekst (besked_spam_grund tjekker e-mail først).
--      SPEJL: auktionKontaktGrund() i src/lib/auktionKontaktinfo.ts.
--   2. Trigger auctions_zzz_kontaktinfo (BEFORE INSERT OR UPDATE OF titel,
--      beskrivelse) - fejlkode BHA08, detail = {"felt", "grund", "erhverv"}.
--      - Kun for brugere (auth.role() authenticated/anon) - service role,
--        staff-værktøjer og interne job slipper igennem, så staff kan rette.
--        Samme undtagelse som auctions_indhold_kontrol.
--      - Ved UPDATE tjekkes kun det felt, der faktisk er ændret, så en gammel
--        auktion kan få rettet pris eller billeder (eksisterende auktioner
--        røres ikke).
--      - Rækkefølge: BEFORE-triggere kører alfabetisk. "zzz" kører efter
--        alle konto-tjek (a0_*, a1_*, kraev_*, salg_frosset, zz_erhverv) og
--        efter auctions_indhold_kontrol (længde og forbudte varer), så de
--        fejl vises først, og den endelige titel/beskrivelse tjekkes. Kun
--        beloebsloft_auktion (b...) kører efter.
--      Dækker både hjemmesidens oprettelse (insert fra browseren), appens
--      insert og rediger_auktion (security definer, men auth.role() er
--      stadig brugerens) - rediger_auktion ændres ikke.
--   3. Testblok: samme eksempler som tests/enhed/auktionKontaktinfoEksempler.ts.
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) før
-- noget ændres. Idempotent (kan køres igen). Kør først på testdatabasen.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Hjælper
-- ---------------------------------------------------------------------------
create or replace function pg_temp.krop_md5(p_fn regprocedure)
returns text language sql stable as $$
  select md5(regexp_replace(replace(pr.prosrc, E'\r\n', E'\n'),
                            E'^[ \t]*(--[^\n]*)?\n', '', 'gn'))
    from pg_proc pr where pr.oid = p_fn
$$;

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek - før noget ændres.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- Filteret, der bygges på (20261102080000). TS-spejlet forudsætter samme udgave.
  v_md5 := pg_temp.krop_md5('public.besked_spam_grund(text)'::regprocedure);
  if v_md5 <> '4868b54e7fa5ac608e9f2e0d08795d7a' then
    raise exception 'besked_spam_grund er ikke udgaven fra 20261102080000 (md5 %). Kør den migration først, eller tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.besked_normaliser(text)'::regprocedure);
  if v_md5 <> 'f9d51fb4ddd0b58662cac11336405f46' then
    raise exception 'besked_normaliser er ændret uden for migrationerne (md5 %). Tjek spejlet i src/lib/auktionKontaktinfo.ts.', v_md5;
  end if;
  -- Denne fils egne funktioner (ved genkørsel): kun denne fils udgave.
  if to_regprocedure('public.auktion_kontaktinfo_grund(text, boolean)') is not null then
    v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_grund(text, boolean)'::regprocedure);
    if v_md5 <> '3f11cbdeb8fc6641932e7101444b3c84' then
      raise exception 'auktion_kontaktinfo_grund er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
    end if;
  end if;
  if to_regprocedure('public.auctions_kontaktinfo()') is not null then
    v_md5 := pg_temp.krop_md5('public.auctions_kontaktinfo()'::regprocedure);
    if v_md5 <> 'cf068be2eb64196ddad9855aca8a092b' then
      raise exception 'auctions_kontaktinfo er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
    end if;
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'users' and column_name = 'konto_type') then
    raise exception 'users.konto_type mangler - kør de tidligere migrationer først.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Filteret til auktioner
-- ---------------------------------------------------------------------------
create or replace function public.auktion_kontaktinfo_grund(p_tekst text, p_erhverv boolean)
 returns text
 language plpgsql
 immutable parallel safe
 set search_path = public
as $function$
declare
  v_grund text;
begin
  if coalesce(btrim(p_tekst), '') = '' then
    return null;
  end if;
  v_grund := public.besked_spam_grund(p_tekst);
  if v_grund is distinct from 'link' or not coalesce(p_erhverv, false) then
    return v_grund;
  end if;
  -- Firma: fjern links (https://..., www...., navn.dk/sti) og tjek resten.
  return public.besked_spam_grund(regexp_replace(
    public.besked_normaliser(p_tekst),
    '(https?://|www\.)[a-z0-9.-]+(/[a-z0-9/_.?=&%#+~-]*)?'
      || '|([a-z0-9-]+\.)+(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)\M(/[a-z0-9/_.?=&%#+~-]*)?',
    ' ', 'g'));
end;
$function$;

comment on function public.auktion_kontaktinfo_grund(text, boolean) is
  'Kontaktoplysninger i en auktions titel/beskrivelse: grund som besked_spam_grund eller null. Firmaer (p_erhverv) må skrive links. SPEJL: auktionKontaktGrund() i src/lib/auktionKontaktinfo.ts. 20261102130000.';

-- Ren funktion (ingen data). Appen må gerne kalde den for at advare i forvejen.
revoke all on function public.auktion_kontaktinfo_grund(text, boolean) from public, anon;
grant execute on function public.auktion_kontaktinfo_grund(text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Triggeren
-- ---------------------------------------------------------------------------
-- security definer: læser users.konto_type uanset kolonne-grants på users.
create or replace function public.auctions_kontaktinfo()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_erhverv boolean;
  v_felt    text;
  v_grund   text;
begin
  -- Service role, staff-værktøjer og interne job (ingen brugerrolle) må rette.
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.titel is not distinct from old.titel
     and new.beskrivelse is not distinct from old.beskrivelse then
    return new;
  end if;

  select u.konto_type = 'erhverv' into v_erhverv
    from public.users u where u.id = new.bruger_id;
  v_erhverv := coalesce(v_erhverv, false);

  if tg_op = 'INSERT' or new.titel is distinct from old.titel then
    v_grund := public.auktion_kontaktinfo_grund(new.titel, v_erhverv);
    if v_grund is not null then
      v_felt := 'titel';
    end if;
  end if;
  if v_felt is null and (tg_op = 'INSERT' or new.beskrivelse is distinct from old.beskrivelse) then
    v_grund := public.auktion_kontaktinfo_grund(new.beskrivelse, v_erhverv);
    if v_grund is not null then
      v_felt := 'beskrivelse';
    end if;
  end if;

  if v_felt is not null then
    raise exception 'Skriv ikke telefonnummer, e-mail eller links i %. Køber og sælger skal tale sammen via BidHamr.',
      case v_felt when 'titel' then 'titlen' else 'beskrivelsen' end
      using errcode = 'BHA08',
            detail = jsonb_build_object('felt', v_felt, 'grund', v_grund, 'erhverv', v_erhverv)::text;
  end if;
  return new;
end;
$function$;

comment on function public.auctions_kontaktinfo() is
  'Afviser kontaktoplysninger i titel/beskrivelse (BHA08) for brugere. Service role slipper igennem. 20261102130000.';

-- Kun til triggeren.
revoke all on function public.auctions_kontaktinfo() from public, anon, authenticated;

drop trigger if exists auctions_zzz_kontaktinfo on public.auctions;
create trigger auctions_zzz_kontaktinfo
  before insert or update of titel, beskrivelse on public.auctions
  for each row execute function public.auctions_kontaktinfo();

-- ---------------------------------------------------------------------------
-- 4. Testblok - samme liste som tests/enhed/auktionKontaktinfoEksempler.ts.
--    Fejler et eksempel, afbrydes migrationen.
-- ---------------------------------------------------------------------------
do $test$
declare
  r record;
  v_privat text;
  v_firma text;
  v_fejl text := '';
begin
  for r in
    select * from (values
      ('Ring på 22 33 44 55 for mere info', 'telefon', 'telefon'),
      ('Spørgsmål? 22334455', 'telefon', 'telefon'),
      ('Tlf. +45 2233 4455', 'telefon', 'telefon'),
      ('Skriv til hans@gmail.com', 'email', 'email'),
      ('Kontakt info@firma.dk', 'email', 'email'),
      ('Betal med MobilePay 22334455', 'mobilepay', 'mobilepay'),
      ('MobilePay 22334455', 'mobilepay', 'mobilepay'),
      ('Overfør til reg 1234 konto 12345678', 'bank', 'bank'),
      ('Skriv på snap @hans_123', 'socialt_medie', 'socialt_medie'),
      ('Se flere billeder på www.dba.dk', 'link', null),
      ('Læs mere på https://firma.dk/sofaer/model-x', 'link', null),
      ('Producentens side: firma.com', 'link', null),
      ('Se www.firma.dk eller ring 22 33 44 55', 'link', 'telefon'),
      ('Se www.firma.dk - MobilePay 22334455', 'link', 'mobilepay'),
      ('www.firma.dk / salg@firma.dk', 'email', 'email'),
      ('Sofa i grå uld. Mål: 200 x 90 x 45 cm. Nypris 4.500 kr, sælges for 1.200 kr.', null, null),
      ('Købt 12.03.2024, brugt ca. 10 gange. Afhentes efter 24/12.', null, null),
      ('Cykel 28 tommer, 7 gear, årgang 2019. Stelnummer WAW12345678.', null, null),
      ('iPhone 13, 128 GB, sort. Batteri 87 %. IMEI 356938035643809', null, null),
      ('Lego 42115, komplet med vejledning og æske', null, null),
      ('Børnetøj str 86 92 98 104, 10 dele', null, null),
      ('Kan sendes med GLS eller afhentes i 8000 Aarhus C', null, null),
      ('Fra 2019/2020. Pris 2.500-3.000 ved nypris.', null, null)
    ) as x(tekst, privat, firma)
  loop
    v_privat := public.auktion_kontaktinfo_grund(r.tekst, false);
    v_firma := public.auktion_kontaktinfo_grund(r.tekst, true);
    if v_privat is distinct from r.privat then
      v_fejl := v_fejl || format(E'\n  privat %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.privat, 'null'), coalesce(v_privat, 'null'));
    end if;
    if v_firma is distinct from r.firma then
      v_fejl := v_fejl || format(E'\n  firma %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.firma, 'null'), coalesce(v_firma, 'null'));
    end if;
  end loop;
  if public.auktion_kontaktinfo_grund(null, false) is not null
     or public.auktion_kontaktinfo_grund('   ', true) is not null then
    v_fejl := v_fejl || E'\n  tom tekst skulle give null';
  end if;
  if v_fejl <> '' then
    raise exception 'Kontaktinfo-filteret til auktioner fejlede:%', v_fejl;
  end if;
end
$test$;
