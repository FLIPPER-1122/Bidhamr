-- Rettelser efter testen 11. okt. 2026 (Filip: ja til brugerbetingelser som
-- hårdt krav). Bygger på 20261016050000_erhverv_saelger_handlinger.sql.
--
--   1. Brugerbetingelser er et hårdt krav i databasen: bud, maksimum
--      (saet_maksimum -> bud_maksimum), nye auktioner (opret, genopsæt, sæt
--      op igen), "tilbud til næste byder" (sælgerens tilbud og købers ja i
--      andenchance_svar) afvises, hvis brugeren ikke har
--      accepteret den aktuelle version (users.vilkaar_version mod
--      vilkaar_aktuel_version(), samme sammenligning som vilkaarErAccepteret i
--      src/lib/vilkaar.ts). Fejl: 'vilkaar_mangler: …', errcode BHV02.
--      Tjekket ligger ved siden af MitID-tjekket (egne triggere, der fyrer
--      lige efter a3_bids_mitid / a0_bud_maksimum_mitid / auctions_a0_mitid /
--      a0_andenchance_mitid). Automatiske bud springes over i bids (som
--      MitID), men autobud_maa_byde springer brugere uden accept over, så
--      ingen byder automatisk uden accept (også maksima sat før denne fil).
--      Firmakonti er IKKE undtaget: der er ingen særskilt accept af
--      erhvervsvilkår i databasen (ROADMAP-BESLUTNINGER nævner kun
--      erhvervsvilkårene som tekst), så firmaet accepterer de almindelige
--      brugerbetingelser i vinduet på Firma oversigt.
--   2. Efternavn: users_kraev_efternavn afviser et tomt efternavn på en
--      privat konto, når navn, fornavn eller efternavn ÆNDRES (errcode
--      BHN03, 'efternavn_mangler: …'). Andre opdateringer af ældre rækker uden
--      efternavn (telefon, adresse, rolle …) blokeres ikke. Undtaget:
--      service_role/postgres uden JWT (staff, seed), firmakonti og
--      kontosletning (konto_slettet_kl sat). handle_new_user ændres IKKE endnu
--      (appen sender ikke efternavn) - se ROADMAP fase 5.
--   3. Chatten:
--      - besked_spam_grund: ny grund 'bank' - dansk reg.nr. + kontonr. ("reg
--        1234 konto 12345678", "overfør til 1234-12345678", "1234 konto
--        7654321"; formatet 4 + 6-10 cifre og et "reg" alene kræver et
--        bankord, så "1. reg. 2015, 145000 km" og "Stelnr 1234-567890" går
--        igennem), IBAN
--        (DK + 16 cifre, eller "IBAN" + landekode). Et kontonr. alene (uden
--        reg.nr.) stoppes ikke - det er en testet falsk positiv fra
--        20261007051000 - men markeres stadig til staff. MobilePay-numre
--        stoppes som før ('mobilepay').
--      - besked_mistaenkelig (beskeden sendes, men markeres til staff, og
--        hjemmesiden advarer afsenderen): også kontant betaling, "betal uden
--        om/uden for", overførsel til egen konto, "mobilepay mig", pengene på
--        MobilePay/Swish/PayPal …
--      - messages_blokeret_grund_check flettes med 'bank'.
--      SPEJL: spamGrund() og erMistaenkeligBesked() i src/lib/tryghed.ts.
--      Testeksempler sidst i filen (fejler et, afbrydes migrationen) og i
--      scripts/test-spamfilter.mts.
--   4. firma_oversigt: 'paa_vej_oere' ("På vej til dig") tæller kun
--      betalinger, der faktisk er på vej til udbetaling: ikke annulleret
--      handel, ikke refunderet, ingen påbegyndt/ventende refusion, ikke
--      annulleret efter afsendelses-/afhentningsfristen og ingen tabt
--      indsigelse.
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) af alt,
-- der erstattes - før noget ændres. Idempotent (kan køres igen).
-- Kør først på testdatabasen.

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

-- ---------------------------------------------------------------------------
-- 1. Drift-tjek af alt, der erstattes - før noget ændres.
--    Hver: kroppen fra den seneste migration (før) | denne fil (efter).
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- 20261013010000_mitid.sql
  v_md5 := pg_temp.krop_md5('public.autobud_maa_byde(uuid, uuid)'::regprocedure);
  if v_md5 not in ('f614cb79c40414f1829cd8d29d0a00cd', '5722ef2f702aafeb8975588a0d0024cd') then
    raise exception 'autobud_maa_byde er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- 20261007050000/20261007051000_fase4_testrettelser(_2).sql
  v_md5 := pg_temp.krop_md5('public.besked_spam_grund(text)'::regprocedure);
  if v_md5 not in ('30441dd87e2fbd4606cfc85845817447', '50e35c69db0797df6a2cbb99d3ebed63') then
    raise exception 'besked_spam_grund er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- 20261006031000_spamfilter_rettelser.sql
  v_md5 := pg_temp.krop_md5('public.besked_mistaenkelig(text)'::regprocedure);
  if v_md5 not in ('7836c4b8837546e07c6e742af30e0bd5', 'a6a6d0b9b3095c14d346e3e69537127c') then
    raise exception 'besked_mistaenkelig er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- besked_normaliser bruges uændret (20261006030000) - spejlet i TS forudsætter den.
  v_md5 := pg_temp.krop_md5('public.besked_normaliser(text)'::regprocedure);
  if v_md5 <> 'f9d51fb4ddd0b58662cac11336405f46' then
    raise exception 'besked_normaliser er ændret uden for migrationerne (md5 %). Tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  -- 20261010030000_erhverv.sql + rettelser på stedet i 20261010032000 og
  -- 20261010050000 (afsnit 7).
  v_md5 := pg_temp.krop_md5('public.firma_oversigt()'::regprocedure);
  if v_md5 not in ('752bc588fa445170d5b0edb59e57f162', 'efd8968d3899abcd26571cff5f13e6e6') then
    raise exception 'firma_oversigt er ændret uden for migrationerne (md5 %). Tjek den, før den rettes.', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Brugerbetingelser (BHV02)
-- ---------------------------------------------------------------------------

-- Er p_version mindst den aktuelle version? ("0.1" < "0.2" < "1.0"). NULL
-- eller en ukendt værdi = ikke accepteret. Samme regel som
-- vilkaarErAccepteret i src/lib/vilkaar.ts.
create or replace function public.vilkaar_er_accepteret(p_version text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select coalesce(
           p_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'
           and (split_part(p_version, '.', 1)::int, split_part(p_version, '.', 2)::int)
               >= (split_part(public.vilkaar_aktuel_version(), '.', 1)::int,
                   split_part(public.vilkaar_aktuel_version(), '.', 2)::int),
           false);
$fn$;

revoke all on function public.vilkaar_er_accepteret(text) from public, anon, authenticated;
grant execute on function public.vilkaar_er_accepteret(text) to service_role;

-- Intern: afviser, hvis brugeren ikke har accepteret den aktuelle version.
-- Kaldes kun fra triggerne herunder (ingen grant til brugere).
create or replace function public.vilkaar_kraev(p_bruger uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if p_bruger is null or p_bruger = public.bidhamr_system_id() then
    return;
  end if;
  if exists (select 1 from public.users u
              where u.id = p_bruger
                and not public.vilkaar_er_accepteret(u.vilkaar_version)) then
    raise exception 'vilkaar_mangler: Du skal acceptere BidHamrs brugerbetingelser, før du byder eller sætter varer til salg.'
      using errcode = 'BHV02';
  end if;
end;
$fn$;

revoke all on function public.vilkaar_kraev(uuid) from public, anon, authenticated;

-- Bud: kun brugerens egne bud. Automatiske bud (bids.automatisk, kun sat af
-- autobud-motoren) springes over - autobud_maa_byde tjekker accepten.
create or replace function public.bids_vilkaar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not coalesce(new.automatisk, false) then
    perform public.vilkaar_kraev(new.bruger_id);
  end if;
  return new;
end;
$fn$;

revoke all on function public.bids_vilkaar() from public, anon, authenticated;

-- "a3_bids_vilkaar" fyrer lige efter "a3_bids_mitid" (alfabetisk).
drop trigger if exists a3_bids_vilkaar on public.bids;
create trigger a3_bids_vilkaar
  before insert on public.bids
  for each row execute function public.bids_vilkaar();

-- Maksimum (saet_maksimum): nyt maksimum eller ændret beløb.
create or replace function public.bud_maksimum_vilkaar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' or new.maks_beloeb is distinct from old.maks_beloeb then
    perform public.vilkaar_kraev(new.bruger_id);
  end if;
  return new;
end;
$fn$;

revoke all on function public.bud_maksimum_vilkaar() from public, anon, authenticated;

drop trigger if exists a0_bud_maksimum_vilkaar on public.bud_maksimum;
create trigger a0_bud_maksimum_vilkaar
  before insert or update of maks_beloeb on public.bud_maksimum
  for each row execute function public.bud_maksimum_vilkaar();

-- Auktioner: ALLE nye auktioner (opret fra hjemmeside/app/Firma oversigt,
-- genopsaet_auktion, saet_annulleret_op_igen). Firmakonti er ikke undtaget.
create or replace function public.auctions_vilkaar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.vilkaar_kraev(new.bruger_id);
  return new;
end;
$fn$;

revoke all on function public.auctions_vilkaar() from public, anon, authenticated;

-- "auctions_a0_vilkaar" fyrer lige efter "auctions_a0_mitid".
drop trigger if exists auctions_a0_vilkaar on public.auctions;
create trigger auctions_a0_vilkaar
  before insert on public.auctions
  for each row execute function public.auctions_vilkaar();

-- Tilbud til næste byder (andenchance_opret): sælgeren sælger.
create or replace function public.andenchance_vilkaar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.vilkaar_kraev(new.seller_id);
  return new;
end;
$fn$;

revoke all on function public.andenchance_vilkaar() from public, anon, authenticated;

drop trigger if exists a0_andenchance_vilkaar on public.andenchance_tilbud;
create trigger a0_andenchance_vilkaar
  before insert on public.andenchance_tilbud
  for each row execute function public.andenchance_vilkaar();

-- Køberen siger ja til tilbuddet (andenchance_svar sætter status
-- 'accepteret' i samme transaktion som handlen oprettes): fejler tjekket,
-- rulles hele svaret tilbage (ingen handel, tilbuddet står stadig åbent).
-- Et nej kræver ikke accept.
create or replace function public.andenchance_svar_vilkaar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.status = 'accepteret' and old.status is distinct from 'accepteret' then
    perform public.vilkaar_kraev(new.byder_id);
  end if;
  return new;
end;
$fn$;

revoke all on function public.andenchance_svar_vilkaar() from public, anon, authenticated;

drop trigger if exists a0_andenchance_svar_vilkaar on public.andenchance_tilbud;
create trigger a0_andenchance_svar_vilkaar
  before update of status on public.andenchance_tilbud
  for each row execute function public.andenchance_svar_vilkaar();

-- Autobud: som 20261013010000, plus accept af brugerbetingelserne.
create or replace function public.autobud_maa_byde(p_saelger uuid, p_bruger uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_bruger <> p_saelger
     and exists (
       select 1 from public.users u
        where u.id = p_bruger
          and u.konto_slettet_kl is null
          and not (coalesce(u.suspenderet, false)
                   and (u.suspenderet_til is null or u.suspenderet_til > now()))
          -- MitID: kun verificerede (firmakonti kan ikke byde).
          and u.mitid_verificeret_kl is not null
          -- NYT (20261017030000): kun brugere, der har accepteret den
          -- aktuelle version af brugerbetingelserne.
          and public.vilkaar_er_accepteret(u.vilkaar_version))
     and not public.er_blokeret(p_saelger, p_bruger);
$$;
revoke all on function public.autobud_maa_byde(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Efternavn på private konti (BHN03)
-- ---------------------------------------------------------------------------
create or replace function public.users_kraev_efternavn()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- Staff (service_role) og seed/migrationer (postgres uden JWT).
  if coalesce(auth.role(), '') = 'service_role'
     or (auth.uid() is null
         and current_user in ('postgres', 'supabase_admin', 'service_role')) then
    return new;
  end if;
  -- Firmakonti har intet efternavn; en slettet konto får navnene ryddet.
  if new.konto_type is not distinct from 'erhverv' or new.konto_slettet_kl is not null then
    return new;
  end if;
  -- Kun når et af navnene ændres - ældre rækker uden efternavn må gerne
  -- opdatere fx telefon og adresse.
  if new.navn is not distinct from old.navn
     and new.fornavn is not distinct from old.fornavn
     and new.efternavn is not distinct from old.efternavn then
    return new;
  end if;
  if nullif(btrim(coalesce(new.efternavn, '')), '') is null then
    raise exception 'efternavn_mangler: Skriv dit efternavn.'
      using errcode = 'BHN03';
  end if;
  return new;
end;
$fn$;

revoke all on function public.users_kraev_efternavn() from public, anon, authenticated;

drop trigger if exists users_kraev_efternavn on public.users;
create trigger users_kraev_efternavn
  before update of navn, fornavn, efternavn on public.users
  for each row execute function public.users_kraev_efternavn();

-- ---------------------------------------------------------------------------
-- 4. Chatten: bankoplysninger ('bank') og betaling uden om BidHamr
-- ---------------------------------------------------------------------------

-- Som 20261007051000, plus afsnittet "Bankoplysninger" (NYT) efter links.
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
  k text;
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
  -- NYT: bankoplysninger.
  -- Reg.nr.: "reg", "regnr", "reg. nr.", "registreringsnummer" + 4 cifre.
  -- Et "reg" alene kan også være en bils første registrering ("1. reg.
  -- 2015"), så det kræver et bankord andetsteds i beskeden (p_bank_ord).
  p_reg constant text :=
    '\mreg(istrerings(nummer|nr)?|\.?\s*(nr|nummer))?\M[^0-9]{0,6}(?<![0-9])[0-9]{4}(?![0-9])';
  -- Kun tydelige former: "regnr", "reg.nr.", "reg nummer", "registreringsnr".
  p_reg_staerk constant text :=
    '\mreg(istrerings(nummer|nr)|\.?\s*(nr|nummer))\M[^0-9]{0,6}(?<![0-9])[0-9]{4}(?![0-9])';
  -- Kontonr.: "kontonr", "kontonummer", "konto nr" + 6-10 cifre.
  p_kontonr constant text :=
    '\m(kontonr|kontonummer|kontonummeret|konto\s*nr|konto\s*nummer)\M[^0-9]{0,6}(?<![0-9])[0-9]{6,10}(?![0-9])';
  -- Et kontonummer på 6-10 cifre (ikke del af en længere cifferrække).
  p_konto_tal constant text := '(?<![0-9])[0-9]{6,10}(?![0-9])';
  -- IBAN: DK + 2 kontrolcifre + 14 cifre, evt. i grupper.
  p_iban_dk constant text := '\mdk\s?[0-9]{2}([\s.-]?[0-9]){14}(?![0-9])';
  -- 4 + 6-10 cifre ("1234-12345678", "1234 12345678"), ikke ved siden af en
  -- anden cifferblok. Kræver et bankord (p_bank_ord) i beskeden.
  p_reg_konto constant text :=
    '(?<![0-9][\s.,-])(?<![0-9])[0-9]{4}(\s?-\s?|[\s.]+)[0-9]{6,10}(?![\s.,-]?[0-9])';
  -- Bankord: konto, kontonr, bank, overfør, indbetal, IBAN og tydelige
  -- reg.nr.-former (IKKE et "reg" alene).
  p_bank_ord constant text :=
    '\m(bank[a-zæøå]*|konto[a-zæøå]*|overf(ø|o)r[a-zæøå]*|indbetal[a-zæøå]*|indsæt[a-zæøå]*|iban'
    || '|regnr|registreringsn[a-zæøå]*|reg\.?\s*(nr|nummer))\M';
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

  -- NYT: Bankoplysninger. Arbejdskopi k, hvor tal, der ikke er
  -- bankoplysninger, er erstattet med '#' (samme rækkefølge som i TS):
  --   1. tal lige efter model, ordre, sporing, varenr., årgang, stelnr., art
  --      m.fl. ("Model 1234-567890", "Stelnr 1234-567890", "Årgang 2015")
  --   2. tal med en enhed: km, kr, kg, cm ... ("145000 km", "125000 kr")
  --   3. et årstal lige efter et "reg" alene ("1. reg. 2015", "Reg. år
  --      2016") - medmindre "konto" følger lige efter (reg.nr. 2015 findes).
  -- 'reg' og 'konto' bevares (de er bankord her).
  k := regexp_replace(v,
         '\m(model[a-zæøå]*|ordre[a-zæøå]*|post\s*nr|postnummer[a-zæøå]*|sporing[a-zæøå]*|track[a-z]*'
         || '|stregkode|ean|imei|serie\s*nr|serienummer[a-zæøå]*|vare\s*nr|varenummer[a-zæøå]*'
         || '|faktura[a-zæøå]*|kunde\s*nr|kundenummer[a-zæøå]*|pakke[a-zæøå]*|ref|reference'
         || '|årgang[a-zæøå]*|stel[a-zæøå]*|art)\M'
         || p_nr || '[0-9][0-9\s.,/-]*',
         ' # ', 'g');
  k := regexp_replace(k,
         '(?<![0-9])[0-9][0-9.]*(,[0-9]+)?\s*(km\M|kr\M|kroner\M|dkk\M|kg\M|gram\M|cm\M|mm\M|,-|\.-)',
         ' # ', 'g');
  k := regexp_replace(k,
         '\mreg\M\.?(\s*(år|dato))?[\s.:,]*(19|20)[0-9]{2}(?![0-9])(?![^0-9]{0,15}konto)',
         ' # ', 'g');
  if k ~ p_iban_dk
     or k ~ '\miban\M[^a-z0-9]{0,6}[a-z]{2}\s?[0-9]{2}'
     or k ~ (p_reg_staerk || '.{0,40}' || p_konto_tal)
     or (k ~ (p_reg || '.{0,40}' || p_konto_tal) and k ~ p_bank_ord)
     or (k ~ p_kontonr and k ~ p_reg)
     or k ~ ('(?<![0-9])[0-9]{4}[\s,/-]*\mkonto[a-zæøå]*\M[^0-9]{0,6}' || p_konto_tal)
     or (k ~ p_reg_konto and k ~ p_bank_ord) then
    return 'bank';
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

-- Mistaenkeligt (forsoeg paa at handle uden om BidHamr). Beskeden sendes,
-- men markeres til staff (messages_tryghed_efter), og hjemmesiden advarer
-- afsenderen, mens beskeden skrives (erMistaenkeligBesked i src/lib/tryghed.ts).
-- Som 20261006031000, plus (NYT): kontant betaling, betal uden om/uden for,
-- overfoersel til egen konto, "mobilepay mig", pengene paa en betalingsapp.
-- MobilePay alene markeres stadig ikke (officiel betalingsmetode via Stripe).
create or replace function public.besked_mistaenkelig(p_tekst text)
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select public.besked_normaliser(p_tekst) ~ (
    'udenom|uden om (bidhamr|bid hamr|siden|appen|platformen|gebyr)'
    || '|uden (gebyr|gebyret|gebyrer)|spar(e|er)? (gebyr|gebyret|gebyrerne)'
    || '|betal(e|er)? (direkte|privat|kontant)|direkte (overf|betaling)'
    || '|bankoverf|overf(ø|o)r(e|er|sel)? (pengene|beløbet|belobet|direkte)'
    || '|\mreg\.?\s*(nr|nummer)\M|kontonummer|kontonr'
    || '|(mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M).{0,40}'
    ||   '(direkte|privat|til mig|udenom|uden om|uden (bidhamr|bid hamr))'
    || '|(direkte|privat|til mig|udenom|uden om|uden (bidhamr|bid hamr)).{0,40}'
    ||   '(mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M)'
    || '|whats\s*app|telegram|snapchat|\msnap\M|messenger'
    || '|ring til mig|sms (til )?mig|skriv (til mig )?på (mail|sms|face|insta|snap)'
    -- NYT (20261017030000):
    || '|betal[a-zæøå]*\s+(mig|dig)\s+(direkte|privat|kontant)'
    || '|kontant\s*betal|betal[a-zæøå]*\s+(med\s+|i\s+)?kontant'
    || '|\mkontant(er|e)?\M.{0,30}\m(afhent[a-zæøå]*|hånden)\M'
    || '|\mafhent[a-zæøå]*\M.{0,30}\mkontant'
    || '|betal[a-zæøå]*\s+uden\s*(om|for)\M|uden\s*for\s+(bidhamr|bid hamr|siden|appen|platformen)'
    -- Ikke datid ("overført"): "Pengene er overført til min konto" er en
    -- sælger, der bekræfter BidHamrs udbetaling.
    || '|overf(ø|o)r(e|er|sel)?\M.{0,30}(til mig|til min|min konto|kontonr|kontonummer|\mreg\M'
    ||   '|mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M)'
    || '|mobile\s*pay(e|er)?\s+(mig|til mig|pengene|beløbet|resten)\M'
    || '|(pengene|beløbet|resten)\s+(på|via|over|med|til)\s+(min\s+)?(mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M)'
    || '|(mobile\s*pay|\mswish\M|paypal|revolut|\mvipps\M).{0,40}uden (gebyr|gebyret|gebyrer)');
$fn$;

revoke all on function public.besked_mistaenkelig(text) from public, anon;
grant execute on function public.besked_mistaenkelig(text) to authenticated, service_role;

-- messages_blokeret_grund_check: FLET eksisterende vaerdier + 'bank'.
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
                  || array['link', 'email', 'telefon', 'mobilepay', 'gentaget', 'socialt_medie', 'bank'])
                  order by 1);
  alter table public.messages drop constraint if exists messages_blokeret_grund_check;
  execute format('alter table public.messages add constraint messages_blokeret_grund_check '
                 || 'check (blokeret_grund is null or blokeret_grund = any (%L::text[]))', v_vaerdier);
end;
$flet$;

-- ---------------------------------------------------------------------------
-- 5. firma_oversigt: "På vej til dig" (paa_vej_oere)
--    Rettes på stedet (tekst-erstatning som 20261010032000/20261010050000).
-- ---------------------------------------------------------------------------
do $do$
declare
  v_def text := replace(pg_get_functiondef('public.firma_oversigt()'::regprocedure), E'\r\n', E'\n');
  v_gl  constant text :=
    $t$where b.status = 'betalt' and b.overfoert_kl is null and b.refunderet_kl is null), 0))$t$;
  v_ny  constant text := replace($t$where b.status = 'betalt' and b.overfoert_kl is null and b.refunderet_kl is null
              and b.annulleret_kl is null and b.refusion_anmodet_kl is null
              and b.afsendelsesfrist_annulleret_kl is null and b.afhentningsfrist_annulleret_kl is null
              and b.indsigelse_tabt_kl is null
              and not exists (select 1 from public.trades t2
                               where t2.id = b.trade_id and t2.status = 'annulleret')), 0))$t$, chr(13), '');
  v_n   integer;
begin
  if position('b.indsigelse_tabt_kl is null' in v_def) > 0 then
    return;   -- allerede rettet
  end if;
  v_n := (length(v_def) - length(replace(v_def, v_gl, ''))) / length(v_gl);
  if v_n <> 1 then
    raise exception 'firma_oversigt: forventet tekst fundet % gange (skal være 1) - ret manuelt', v_n;
  end if;
  execute replace(v_def, v_gl, v_ny);
end;
$do$;

-- ---------------------------------------------------------------------------
-- 6. Test af chatfilteret. Fejler et eksempel, afbrydes migrationen (intet
--    er ændret). Samme eksempler i scripts/test-spamfilter.mts (TS-spejlet).
-- ---------------------------------------------------------------------------
do $test$
declare
  r record;
  v_fejl text := '';
begin
  for r in
    select * from (values
      -- Bank: skal stoppes.
      ('reg 1234 konto 12345678', 'bank'),
      ('Reg.nr. 1234 kontonr. 0012345678', 'bank'),
      ('regnr: 5301 og kontonummer 0123456789', 'bank'),
      ('Registreringsnummer 9570 konto 12345678', 'bank'),
      ('Du kan overføre til 1234-12345678', 'bank'),
      ('konto: 1234 - 1234567890', 'bank'),
      ('reg 2015 konto 12345678', 'bank'),
      ('Overfør til min konto 1234 1234567', 'bank'),
      ('1234 konto 7654321', 'bank'),
      ('kontonr 1234567890, reg 1234', 'bank'),
      ('IBAN: DK50 0040 0440 1162 43', 'bank'),
      ('dk5000400440116243', 'bank'),
      ('iban se45 5000 0000 0583 9825 7466', 'bank'),
      -- MobilePay (som før).
      ('mobilepay 2234 5678', 'mobilepay'),
      ('MobilePay box 12345', 'mobilepay'),
      ('send på mp 22 34 56 78', 'mobilepay'),
      -- Ikke bank: må IKKE stoppes.
      ('Model 1234-567890 virker fint', null),
      -- Biler: første registrering, km, pris, årgang, stelnummer.
      ('1. reg. 2015, kørt 145000 km', null),
      ('Reg. år 2016 og 210000 km på uret', null),
      ('1. reg 2018, pris 125000 kr', null),
      ('Årgang 2015 - 145000 km', null),
      ('Stelnr 1234-567890', null),
      -- 4 + 6-10 cifre uden bankord.
      ('1234 - 1234567890', null),
      -- Et kontonummer alene (uden reg.nr.) stoppes ikke (som 20261007051000),
      -- men markeres til staff (besked_mistaenkelig: kontonr).
      ('Kontonr 1234567890', null),
      ('Varenr 1234-123456', null),
      ('Ordrenr 2024 1234', null),
      ('Prisen er 1234 kr', null),
      ('Den er fra 2019-2020', null),
      ('Pakken vejer 1234 gram', null),
      ('Jeg har en konto hos Stripe', null),
      ('Regningen er på 1234 kr', null),
      ('sporing 00370730253300123456', null),
      ('EAN 5701234567890', null),
      ('Den kostede 2500 i 2019', null),
      ('Jeg betaler med MobilePay', null),
      -- Telefon (uændret).
      ('22345678', 'telefon'),
      ('Tlf. 2234 5678', 'telefon')
    ) as t(tekst, forventet)
  loop
    if public.besked_spam_grund(r.tekst) is distinct from r.forventet then
      v_fejl := v_fejl || format(E'\n  spam_grund %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.forventet, 'null'),
                                 coalesce(public.besked_spam_grund(r.tekst), 'null'));
    end if;
  end loop;

  for r in
    select * from (values
      -- Advarsel (markeres til staff): skal fanges.
      ('Kan jeg ikke bare betale kontant ved afhentning?', true),
      ('Jeg har kontanter med, når jeg afhenter', true),
      ('Ved afhentning betaler jeg kontant', true),
      ('Kontantbetaling er fint', true),
      ('Lad os betale uden om BidHamr', true),
      ('Vi kan handle uden for siden', true),
      ('Du kan bare overføre til min konto', true),
      ('Overfør til mig i stedet', true),
      ('Du kan overføre beløbet på MobilePay', true),
      ('Bankoverførsel er nemmest', true),
      ('Mobilepay mig bare', true),
      ('Send pengene på mobilepay', true),
      ('Beløbet via Swish', true),
      ('Betal på mobilepay uden gebyr', true),
      ('Kan du betale mig direkte?', true),
      -- Ingen advarsel: almindelige beskeder.
      ('Jeg betaler med MobilePay i checkout', false),
      ('MobilePay virker ikke på min telefon', false),
      ('Hvornår kan jeg afhente varen?', false),
      ('Tak for handlen, pengene er overført af BidHamr', false),
      ('Pengene er overført til min konto', false),
      ('Jeg har betalt nu', false),
      ('Varen er sendt med GLS', false),
      ('Kan du sende den i morgen?', false)
    ) as t(tekst, forventet)
  loop
    if public.besked_mistaenkelig(r.tekst) is distinct from r.forventet then
      v_fejl := v_fejl || format(E'\n  mistaenkelig %L: forventet %s', r.tekst, r.forventet);
    end if;
  end loop;

  if v_fejl <> '' then
    raise exception 'Chatfilteret fejlede:%', v_fejl;
  end if;
end;
$test$;
