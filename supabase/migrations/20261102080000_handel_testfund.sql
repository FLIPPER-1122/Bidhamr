-- Rettelser efter testerens gennemgang af handelsflowet for private
-- (27. okt. 2026).
--
-- Bygger på:
--   besked_spam_grund      20261017030000_vilkaar_efternavn_chat.sql
--   afhentning_info        20261005080000_afhentningsfrist.sql
--   afhentning_bekraeft    20261005080000_afhentningsfrist.sql (seneste)
--   trade_marker_sendt     20261003050000-serien (pakkebilleder)
--   forsendelse_claim      20261024010000_fragt_shipmondo_transportoer.sql
-- Rører IKKE grants på users eller auctions (20261102060000).
--
-- Indhold:
--   1. Chatfilteret (besked_spam_grund - og dermed indeholder_kontaktinfo,
--      "Spørg sælger", bedømmelser og navne) kunne snydes med skilletegn
--      mellem cifrene: "ring 2 2 3 3 4 4 5 5" gik igennem.
--      - Telefon: 8 cifre (første 2-9) med op til 3 mellemrum, punktum,
--        bindestreger eller skråstreger mellem cifrene, i en hvilken som
--        helst gruppering. Delt i mindst 5 grupper ("2 2 3 3 4 4 5 5", "22 3
--        3 44 55") stoppes det altid; ellers ("223 344 55") som de grupperede
--        numre før: med et kontaktord eller sidst i beskeden.
--      - MobilePay: et spredt nummer efter "mobilepay"/"mp".
--      - Bank: reg.nr. og kontonr. må have skilletegn mellem cifrene ("reg 1
--        2 3 4 konto 1 2 3 4 5 6 7 8"), og 10-14 cifre i mindst to grupper +
--        et bankord stoppes. Et kontonr. alene i én blok stoppes stadig ikke.
--      - Kort (ny, grund 'bank'): 16 cifre (første 2-6) eller 15 cifre
--        (34/37) med gyldigt kontrolciffer (Luhn), i en hvilken som helst
--        gruppering. IMEI, EAN, sporings- og ordrenumre neutraliseres først
--        som før.
--      - Almindelige beløb og datoer må ikke stoppes: hele datoer med år
--        ("24.12.2026", "24/12 2026"), datopar med skråstreg ("24/12 25/12")
--        og beløb med tusindtalspunktum op til 25.000 ("2.500-3.000")
--        neutraliseres, før telefonreglerne køres.
--      SPEJL: spamGrund() i src/lib/tryghed.ts. Eksemplerne sidst i filen er
--      de samme som i tests/enhed/spamfilterEksempler.ts (fejler et,
--      afbrydes migrationen).
--   2. Åben bankindsigelse (chargeback): sælgeren må ikke sende varen.
--      - trade_marker_sendt svarer kode 'indsigelse', når betalingens
--        indsigelse blokerer (betaling_indsigelse_blokerer: åben eller tabt).
--      - forsendelse_claim svarer 'indsigelse' for en NY udgående label.
--        En label, der allerede findes ('findes'), eller et forsøg med ukendt
--        udfald ('genoptag'), afvises ikke - så den kan vises og annulleres,
--        og fragtfirmaet giver den eksisterende forsendelse tilbage.
--      - Ny: handel_indsigelse_status(p_trade) -> 'aaben' | 'tabt' | null
--        (kun til handlens sælger, udledt af auth.uid()), så handelssiden kan
--        vise advarslen. Køberen og andre får null.
--   3. Afhentningskoden:
--      - afhentning_info: 'laast' er nu også true, mens koden er midlertidigt
--        låst (5 forkerte forsøg inden for en time, laast_til i fremtiden).
--        Ny nøgle 'laast_permanent' (15 forkerte forsøg i alt) - den, der før
--        hed 'laast'. 'laast_til' er uændret.
--      - afhentning_bekraeft: ved den rigtige kode nulstilles
--        betalingens kraever_opmaerksomhed og sidste_fejl, hvis sidste_fejl
--        KUN består af afhentningskodens egne markeringer
--        ("Afhentningskode: …"). Andre grunde bliver stående.
--   4. Den gemte pakkeshop: ny kolonne leveringsforslag.pakkeshop_transportoer
--      (shoppens eget fragtfirma) + trigger, der sætter den, når pakkeshoppen
--      skifter. Se afsnit 5.
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) af alt,
-- der erstattes - før noget ændres. Idempotent (kan køres igen).
-- Kør først på testdatabasen.

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
-- 1. Drift-tjek - før noget ændres. Hver: før (test og produktion 27. okt.
--    2026 er ens) | efter denne fil.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  v_md5 := pg_temp.krop_md5('public.besked_spam_grund(text)'::regprocedure);
  if v_md5 not in ('50e35c69db0797df6a2cbb99d3ebed63', '4868b54e7fa5ac608e9f2e0d08795d7a') then
    raise exception 'besked_spam_grund er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.afhentning_info(uuid)'::regprocedure);
  if v_md5 not in ('2e7a400b511f54c2895b2e2880edb3b8', 'f93c31ec878adf163f86c9ae9a2e8264') then
    raise exception 'afhentning_info er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.afhentning_bekraeft(uuid, text)'::regprocedure);
  if v_md5 not in ('07c35e57d44e35e8c6c8a0d539aeb06f', '0da2abc6dc0051cdd3b39f80caaf2e69') then
    raise exception 'afhentning_bekraeft er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.trade_marker_sendt(uuid, text, jsonb)'::regprocedure);
  if v_md5 not in ('36d88ed028fbe3fbcf943f1aa760cb55', '063de526b8eed7a5e25e28b0d9a5fe16') then
    raise exception 'trade_marker_sendt er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.forsendelse_claim(uuid, uuid, text, text, text)'::regprocedure);
  if v_md5 not in ('8086249bb593f2fc64145039449d192e', '900a490925088965f4d1253464b42397') then
    raise exception 'forsendelse_claim er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- Spejlet i TS forudsætter, at normaliseringen er uændret (20261006030000).
  v_md5 := pg_temp.krop_md5('public.besked_normaliser(text)'::regprocedure);
  if v_md5 <> 'f9d51fb4ddd0b58662cac11336405f46' then
    raise exception 'besked_normaliser er ændret uden for migrationerne (md5 %). Tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  -- Indsigelsesreglen, der bruges nedenfor (uændret).
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'betaling_indsigelse_blokerer') then
    raise exception 'betaling_indsigelse_blokerer mangler - kør de tidligere migrationer først.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Chatfilteret
-- ---------------------------------------------------------------------------
create or replace function public.besked_spam_grund(p_tekst text)
 returns text
 language plpgsql
 immutable parallel safe
 set search_path to ''
as $function$
declare
  v text := public.besked_normaliser(p_tekst);
  w text;
  g text;
  k text;
  m text[];
  a int; b int; c int; d int;
  i int;
  v_cifre text;
  v_sum int;
  v_d int;
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
  -- (d) 20261102080000: 8 cifre (foerste 2-9) i en hvilken som helst
  -- gruppering - op til 3 mellemrum, punktum, bindestreger eller skraastreger
  -- mellem cifrene - og ikke en del af en laengere cifferraekke.
  p_loes constant text :=
    '(?<![0-9][\s.,/-]{0,3})[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])';
  -- (e) Som (d), men delt i mindst 5 grupper - altid stoppet.
  p_loes5 constant text :=
    '(?<![0-9][\s.,/-]{0,3})(?=([0-9]+[\s./-]{1,3}){4}[0-9])[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])';
  -- Et nummer i 2-2-2-2- eller 4-4-format (til ref/konto/art/str nedenfor).
  p_grp_2222 constant text :=
    '[2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}(?![\s.,-]?[0-9])';
  p_grp_44 constant text := '[2-9][0-9]{3}[\s.-][0-9]{4}(?![\s.,-]?[0-9])';
  p_nr constant text := '[\s.:#]*((nr|nummer|nummeret)\M)?[\s.:#]*';
  -- Klokkeslaet og datoer i par/intervaller (datoer ogsaa med skraastreg og
  -- 1-cifret dag/maaned fra 20261102080000: "24/12 25/12").
  p_par_sep constant text := '(\s*[-–]\s*|\s+(og|til)\s+|\s+)';
  p_tid constant text := '([01][0-9]|2[0-3])[.:][0-5][0-9]';
  p_dato constant text := '(0?[1-9]|[12][0-9]|3[01])[./](0?[1-9]|1[0-2])\.?';
  -- 20261102080000: beloeb med tusindtalspunktum op til 25.000.
  p_tusind constant text := '([1-9]|1[0-9]|2[0-5])\.[0-9]{3}(,[0-9]{1,2}|,-)?';
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
  -- Bankoplysninger. 20261102080000: cifrene i reg.nr. og kontonr. maa vaere
  -- adskilt af et mellemrum, punktum, bindestreg eller skraastreg.
  p_reg_cifre constant text := '(?<![0-9])[0-9]([\s./-]?[0-9]){3}(?![0-9])';
  -- Reg.nr.: "reg", "regnr", "reg. nr.", "registreringsnummer" + 4 cifre. Et
  -- "reg" alene kan også være en bils første registrering ("1. reg.
  -- 2015"), så det kræver et bankord andetsteds i beskeden (p_bank_ord).
  p_reg constant text :=
    '\mreg(istrerings(nummer|nr)?|\.?\s*(nr|nummer))?\M[^0-9]{0,6}' || p_reg_cifre;
  -- Kun tydelige former: "regnr", "reg.nr.", "reg nummer", "registreringsnr".
  p_reg_staerk constant text :=
    '\mreg(istrerings(nummer|nr)|\.?\s*(nr|nummer))\M[^0-9]{0,6}' || p_reg_cifre;
  -- Et kontonummer på 6-10 cifre (ikke del af en længere cifferrække).
  p_konto_tal constant text := '(?<![0-9])[0-9]([\s./-]?[0-9]){5,9}(?![0-9])';
  -- Kontonr.: "kontonr", "kontonummer", "konto nr" + 6-10 cifre.
  p_kontonr constant text :=
    '\m(kontonr|kontonummer|kontonummeret|konto\s*nr|konto\s*nummer)\M[^0-9]{0,6}' || p_konto_tal;
  -- IBAN: DK + 2 kontrolcifre + 14 cifre, evt. i grupper.
  p_iban_dk constant text := '\mdk\s?[0-9]{2}([\s.-]?[0-9]){14}(?![0-9])';
  -- 4 + 6-10 cifre ("1234-12345678", "1234 12345678"), ikke ved siden af en
  -- anden cifferblok. Kræver et bankord (p_bank_ord) i beskeden.
  p_reg_konto constant text :=
    '(?<![0-9][\s.,-])(?<![0-9])[0-9]{4}(\s?-\s?|[\s.]+)[0-9]{6,10}(?![\s.,-]?[0-9])';
  -- 20261102080000: 10-14 cifre i mindst to grupper, i en hvilken som helst
  -- gruppering. Kræver et bankord. Et kontonr. alene i én blok stoppes ikke.
  p_reg_konto_loes constant text :=
    '(?<![0-9][\s.,/-]{0,3})(?=[0-9]+[\s./-]{1,3}[0-9])[0-9]([\s./-]{0,3}[0-9]){9,13}(?![\s.,/-]{0,3}[0-9])';
  -- 20261102080000: et betalingskort - 13-19 cifre i en hvilken som helst
  -- gruppering; kun 16 cifre (første 2-6) og 15 cifre (34/37) med gyldigt
  -- kontrolciffer (Luhn) tæller.
  p_kort constant text :=
    '(?<![0-9][\s.,/-]{0,3})[0-9]([\s./-]{0,3}[0-9]){12,18}(?![\s.,/-]{0,3}[0-9])';
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

  -- Bankoplysninger. Arbejdskopi k, hvor tal, der ikke er
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
     or k ~ ('(?<![0-9])[0-9]([\s./-]?[0-9]){3}[\s,/-]*\mkonto[a-zæøå]*\M[^0-9]{0,6}' || p_konto_tal)
     or (k ~ p_reg_konto and k ~ p_bank_ord)
     or (k ~ p_reg_konto_loes and k ~ p_bank_ord) then
    return 'bank';
  end if;
  -- Betalingskort (Luhn).
  for m in select regexp_matches(k, '(' || p_kort || ')', 'g') loop
    v_cifre := regexp_replace(m[1], '[^0-9]', '', 'g');
    if (length(v_cifre) = 16 and v_cifre ~ '^[2-6]')
       or (length(v_cifre) = 15 and v_cifre ~ '^3[47]') then
      v_sum := 0;
      for i in 1..length(v_cifre) loop
        v_d := substr(v_cifre, length(v_cifre) - i + 1, 1)::int;
        if i % 2 = 0 then
          v_d := v_d * 2;
          if v_d > 9 then v_d := v_d - 9; end if;
        end if;
        v_sum := v_sum + v_d;
      end loop;
      if v_sum % 10 = 0 then
        return 'bank';
      end if;
    end if;
  end loop;

  -- MobilePay-nummer.
  if v ~ (p_mobilepay || '(\s*(boks|box))?[\s:#.]*((nr|nummer|nummeret|på|til)[\s:#.]*)?'
          || '(?<![0-9])[0-9]{4,5}(?![0-9])(?!\s*(kr|dkk|,-|\.-|,[0-9]|\.[0-9]))')
     or v ~ (p_mobilepay || '.{0,25}(' || p_landekode || '|' || p_otte || '|' || p_grupperet
             || '|' || p_loes || ')') then
    return 'mobilepay';
  end if;

  -- Telefon (a), (b) og (e).
  if v ~ p_landekode or v ~ p_otte or v ~ p_loes5 then
    return 'telefon';
  end if;

  -- Telefon (c) og (d): arbejdskopi g, hvor tal, der ikke er telefonnumre,
  -- er erstattet med '#'. Samme raekkefoelge som neutraliserTal() i TS.
  -- Hele datoer med aar: "24.12.2026", "24/12/26", "24/12 2026".
  g := regexp_replace(v,
         '(?<![0-9][\s.,/-]?)(0?[1-9]|[12][0-9]|3[01])([./-](0?[1-9]|1[0-2])[./-]|[./](0?[1-9]|1[0-2])\.?\s+)'
         || '((19|20)[0-9]{2}|[0-9]{2})(?![\s.,/-]?[0-9])',
         ' # ', 'g');
  -- Klokkeslaet/datoer i par: "20.00-22.00", "20.10 21.10", "24.12-27.12.", "24/12 25/12".
  g := regexp_replace(g,
         '(?<![0-9][.:/])(?<![0-9])(' || p_tid || p_par_sep || p_tid
         || '|' || p_dato || p_par_sep || p_dato || ')(?![.:/]?[0-9])',
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
  -- Beloeb med tusindtalspunktum, alene eller i par: "2.500", "2.500-3.000".
  g := regexp_replace(g,
         '(?<![0-9][\s.,/-]?)' || p_tusind
         || '((\s*[-–/]\s*|\s+(og|til|eller)\s+|\s+)' || p_tusind || ')?(?![\s.,/-]?[0-9])',
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
     or g ~ (p_grp || '[^a-z0-9æøå]*$')
     or g ~ (p_foer || '.{0,25}' || p_loes)
     or g ~ (p_loes || '.{0,15}' || p_efter)
     or g ~ (p_loes || '[^a-z0-9æøå]*$') then
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
$function$;

comment on function public.besked_spam_grund(text) is
  'Chattens spamfilter: link, email, bank (også kortnumre), mobilepay, telefon, socialt_medie eller null. Spredte cifre ("2 2 3 3 4 4 5 5") fanges fra 20261102080000. SPEJL: spamGrund() i src/lib/tryghed.ts.';

-- ---------------------------------------------------------------------------
-- 3. Bankindsigelse: ingen afsendelse og ingen ny label
-- ---------------------------------------------------------------------------

-- Til handelssiden: er der en indsigelse fra køberens bank, der stopper
-- afsendelsen? Kun handlens sælger får svar (auth.uid()).
--   'aaben' - indsigelsen er ikke afgjort (needs_response, under_review,
--             warning_needs_response, warning_under_review eller en ukendt
--             status - fail closed som betaling_indsigelse_blokerer)
--   'tabt'  - banken gav køberen medhold
--   null    - ingen indsigelse, den er vundet/lukket, eller du er ikke sælger
create or replace function public.handel_indsigelse_status(p_trade uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
           when b.indsigelse_status = 'lost' then 'tabt'
           when public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status) then 'aaben'
         end
    from public.betalinger b
    join public.trades t on t.id = b.trade_id
   where b.trade_id = p_trade
     and auth.uid() is not null
     and t.seller_id = auth.uid()
   limit 1
$$;
revoke all on function public.handel_indsigelse_status(uuid) from public, anon;
grant execute on function public.handel_indsigelse_status(uuid) to authenticated;
comment on function public.handel_indsigelse_status(uuid) is
  'Sælgerens handelsside: ''aaben'' | ''tabt'' | null for en bankindsigelse på handlens betaling. Kun til sælgeren (auth.uid()). 20261102080000.';

create or replace function public.trade_marker_sendt(p_trade uuid, p_tracking text, p_billeder jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  kalder   uuid := auth.uid();
  tracking text := nullif(btrim(p_tracking), '');
  t        record;
  v_fejl   text;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if tracking is null or char_length(tracking) > 100 then
    return jsonb_build_object('kode', 'ugyldigt_tracking');
  end if;

  -- Ikke saelgeren: samme svar som en ukendt handel. Tjekkes foer laasen, saa
  -- uvedkommende ikke kan laase fremmede raekker.
  if not exists (select 1 from public.trades
                  where id = p_trade and seller_id = kalder) then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  -- Laas handlen, saa to samtidige kald ikke begge knytter billeder.
  select id, seller_id, status, afhentning into t
    from public.trades where id = p_trade for update;
  if t.id is null or t.seller_id <> kalder then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if t.afhentning then return jsonb_build_object('kode', 'afhentning'); end if;
  if t.status = 'annulleret' then
    return jsonb_build_object('kode', 'annulleret');
  end if;
  if t.status <> 'betaling_modtaget' then
    return jsonb_build_object('kode', 'allerede_sendt');
  end if;

  -- 20261102080000: koeberens bank har aabnet en indsigelse (eller givet
  -- koeberen medhold) - varen maa ikke sendes.
  if exists (select 1 from public.betalinger b
              where b.trade_id = p_trade
                and public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;

  v_fejl := public.pakke_valider_billeder(kalder, p_trade, p_billeder);
  if v_fejl is not null then return jsonb_build_object('kode', v_fejl); end if;

  update public.trades
     set status = 'pakke_sendt',
         tracking_number = tracking,
         sendt_kl = coalesce(sendt_kl, now())
   where id = p_trade
     and seller_id = kalder
     and status = 'betaling_modtaget'
     and not afhentning;

  if not found then return jsonb_build_object('kode', 'allerede_sendt'); end if;

  insert into public.pakke_billeder (trade_id, sti, kategori)
  select p_trade, e->>'sti', e->>'kategori'
    from jsonb_array_elements(p_billeder) e;

  return jsonb_build_object('kode', 'ok');
end;
$function$;

create or replace function public.forsendelse_claim(p_trade uuid, p_bruger uuid, p_type text, p_fragtfirma text, p_pakkestoerrelse text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  t  record;
  f  record;
  v_id uuid;
  v_stoerrelse text;
  v_levering text;
  v_ekstra integer;
  v_antal integer;
begin
  if p_trade is null or p_bruger is null
     or p_type not in ('udgaaende', 'retur')
     or p_fragtfirma not in ('test', 'gls', 'shipmondo', 'dao')
     or (p_pakkestoerrelse is not null and p_pakkestoerrelse not in ('lille', 'mellem', 'stor')) then
    return jsonb_build_object('kode', 'ugyldig');
  end if;

  select tr.id, tr.seller_id, tr.buyer_id, tr.status, tr.afhentning, au.pakkestoerrelse as a_stoerrelse
    into t
    from public.trades tr
    join public.auctions au on au.id = tr.auction_id
   where tr.id = p_trade
   for update of tr;
  if t.id is null then return jsonb_build_object('kode', 'ikke_fundet'); end if;

  if p_type = 'udgaaende' then
    if t.seller_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
    if coalesce(t.afhentning, false) then return jsonb_build_object('kode', 'afhentning'); end if;
  else
    if t.buyer_id <> p_bruger then return jsonb_build_object('kode', 'ikke_fundet'); end if;
  end if;

  v_stoerrelse := coalesce(t.a_stoerrelse, p_pakkestoerrelse, 'mellem');

  if p_type = 'udgaaende' then
    if t.status <> 'betaling_modtaget' then
      return jsonb_build_object('kode', 'forkert_status');
    end if;
    select hl.maade, hl.ekstra_labels_godkendt into v_levering, v_ekstra
      from public.handel_levering hl where hl.trade_id = p_trade;
    if v_levering is null then
      return jsonb_build_object('kode', 'mangler_levering');
    end if;
  else
    if not exists (select 1 from public.sager s
                    where s.trade_id = p_trade
                      and s.status = 'afventer_retur'
                      and s.retur_kraeves) then
      return jsonb_build_object('kode', 'ingen_retur');
    end if;
    v_levering := 'retur';
  end if;

  select id, status, oprettet_kl, forsoegt_kl, ukendt_udfald_kl, fragtfirma, pakkestoerrelse into f
    from public.forsendelser
   where trade_id = p_trade and type = p_type
     and status not in ('annulleret', 'fejlet')
   for update;
  if f.id is not null then
    if f.status <> 'opretter' then
      return jsonb_build_object('kode', 'findes', 'id', f.id);
    end if;
    -- Et forsøg er i gang (eller fik et ukendt udfald for under 1 minut
    -- siden - fragtfirmaets søgning på reference er nogle sekunder bagud).
    if (f.ukendt_udfald_kl is null and coalesce(f.forsoegt_kl, f.oprettet_kl) > now() - interval '10 minutes')
       or f.ukendt_udfald_kl > now() - interval '1 minute' then
      return jsonb_build_object('kode', 'i_gang');
    end if;
    -- Ukendt udfald eller afbrudt forsøg: genoptag med SAMME id/reference,
    -- så fragtfirmaet giver den eksisterende forsendelse tilbage, hvis den findes.
    update public.forsendelser
       set forsoegt_kl = now(), ukendt_udfald_kl = null
     where id = f.id and status = 'opretter';
    return jsonb_build_object('kode', 'genoptag', 'id', f.id, 'pakkestoerrelse', f.pakkestoerrelse,
                              'levering', v_levering, 'fragtfirma', f.fragtfirma);
  end if;

  -- 20261102080000: ingen NY udgående label, mens køberens bank har en
  -- indsigelse (eller har givet køberen medhold) - varen må ikke sendes.
  if p_type = 'udgaaende'
     and exists (select 1 from public.betalinger b
                  where b.trade_id = p_trade
                    and public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)) then
    return jsonb_build_object('kode', 'indsigelse');
  end if;

  -- Højst 2 udgående labels pr. handel (også annullerede); flere kræver, at
  -- staff godkender (fragt_godkend_ekstra_label). Fejlede tæller ikke - dér
  -- blev intet oprettet hos fragtfirmaet.
  if p_type = 'udgaaende' then
    select count(*) into v_antal from public.forsendelser
     where trade_id = p_trade and type = 'udgaaende' and status <> 'fejlet'
       -- DAO direkte (20261021010000): en DAO-label, som DAO har bekræftet
       -- annulleret, tæller ikke - sælgeren kan lave en ny, så længe pakken
       -- ikke er indleveret.
       and not (p_fragtfirma = 'dao' and fragtfirma = 'dao' and status = 'annulleret')
       -- Shipmondo (20261024010000): en label, transportøren har bekræftet
       -- annulleret (cancelled_at_carrier), tæller heller ikke.
       and not (fragtfirma = 'shipmondo' and status = 'annulleret'
                and annullering_bekraeftet_kl is not null);
    if v_antal >= 2 + coalesce(v_ekstra, 0) then
      return jsonb_build_object('kode', 'for_mange_labels');
    end if;
    -- Loft for DAO mod misbrug: højst 10 labels i alt (også annullerede).
    if p_fragtfirma in ('dao', 'shipmondo') then
      select count(*) into v_antal from public.forsendelser
       where trade_id = p_trade and type = 'udgaaende' and status <> 'fejlet';
      if v_antal >= 10 + coalesce(v_ekstra, 0) then
        return jsonb_build_object('kode', 'for_mange_labels');
      end if;
    end if;
  end if;

  insert into public.forsendelser (trade_id, type, fragtfirma, status, pakkestoerrelse, oprettet_af, levering, forsoegt_kl)
  values (p_trade, p_type, p_fragtfirma, 'opretter', v_stoerrelse, p_bruger, v_levering, now())
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'id', v_id, 'pakkestoerrelse', v_stoerrelse, 'levering', v_levering,
                            'fragtfirma', p_fragtfirma);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Afhentningskoden
-- ---------------------------------------------------------------------------
create or replace function public.afhentning_info(p_trade uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  kalder  uuid := auth.uid();
  t       record;
  a       record;
  v_betalt timestamptz;
  v_antal integer;
begin
  if kalder is null then return null; end if;

  select * into t from public.trades
   where id = p_trade and afhentning and kalder in (buyer_id, seller_id);
  if not found then return null; end if;

  select * into a from public.afhentninger where trade_id = p_trade;
  select b.betalt_kl into v_betalt
    from public.betalinger b
   where b.trade_id = p_trade and b.status in ('betalt', 'refunderet');
  select count(*) into v_antal
    from public.afhentningsfrist_forlaengelser where trade_id = p_trade;

  return jsonb_build_object(
    'vist',       a.vist_kl is not null,
    'bekraeftet', a.bekraeftet_kl is not null,
    -- 20261102080000: også mens koden er midlertidigt låst (5 forkerte
    -- forsøg inden for en time). laast_permanent: 15 forkerte i alt.
    'laast',      a.laast_kl is not null or coalesce(a.laast_til_kl > now(), false),
    'laast_permanent', a.laast_kl is not null,
    'laast_til',  case when a.laast_til_kl > now() then a.laast_til_kl end,
    'kode',       case when kalder = t.buyer_id
                        and a.vist_kl is not null
                        and a.annulleret_kl is null
                        and t.status = 'betaling_modtaget'
                       then a.kode end,
    'frist',      case when v_betalt is not null
                       then public.afhentning_frist(a.frist_kl, v_betalt) end,
    'maks_frist', case when v_betalt is not null
                       then date_trunc('second', v_betalt + interval '336 hours') end,
    'forlaengelser', v_antal);
end;
$function$;

create or replace function public.afhentning_bekraeft(p_trade uuid, p_kode text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  kalder   uuid := auth.uid();
  v_kode   text := regexp_replace(coalesce(p_kode, ''), '\s', '', 'g');
  b        record;
  t        record;
  a        record;
  v_vindue integer;
  v_i_alt  integer;
  v_tekst  text;
  maks_pr_time constant integer := 5;
  maks_i_alt   constant integer := 15;
begin
  if kalder is null then return jsonb_build_object('kode', 'ikke_logget_ind'); end if;
  if v_kode !~ '^[0-9]{6}$' then return jsonb_build_object('kode', 'ugyldig_kode'); end if;

  -- Laaseraekkefoelge: betaling, handel, afhentning.
  select * into b from public.betalinger where trade_id = p_trade for update;
  if not found
     or b.status <> 'betalt'
     or b.refusion_anmodet_kl is not null
     or b.frigivet_kl is not null
     or b.overfoersel_paabegyndt_kl is not null
     or b.stripe_transfer_id is not null or b.saelger_udbetaling_id is not null
     or public.betaling_indsigelse_blokerer(b.indsigelse_kl, b.indsigelse_status)
     or public.sag_holder_pengene(p_trade) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into t from public.trades where id = p_trade for update;
  if not found
     or t.seller_id <> kalder
     or not t.afhentning
     or t.status <> 'betaling_modtaget'
     or coalesce(t.sag_aaben, false) then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;

  select * into a from public.afhentninger where trade_id = p_trade for update;
  if found and a.annulleret_kl is not null then
    return jsonb_build_object('kode', 'ikke_mulig');
  end if;
  if not found or a.vist_kl is null then
    return jsonb_build_object('kode', 'ikke_vist');
  end if;
  if a.laast_kl is not null then
    return jsonb_build_object('kode', 'laast');
  end if;
  if a.laast_til_kl is not null and a.laast_til_kl > now() then
    return jsonb_build_object('kode', 'laast_midlertidigt', 'laast_til', a.laast_til_kl);
  end if;

  if v_kode <> a.kode then
    -- Nyt vindue, hvis det gamle er over en time gammelt.
    if a.vindue_start_kl is null or a.vindue_start_kl < now() - interval '1 hour' then
      v_vindue := 1;
      update public.afhentninger set vindue_start_kl = now() where trade_id = p_trade;
    else
      v_vindue := a.forkerte_forsoeg_vindue + 1;
    end if;
    v_i_alt := a.forkerte_forsoeg_i_alt + 1;

    update public.afhentninger
       set forkerte_forsoeg_vindue = v_vindue,
           forkerte_forsoeg_i_alt = v_i_alt,
           laast_til_kl = case when v_vindue >= maks_pr_time
                               then coalesce(vindue_start_kl, now()) + interval '1 hour'
                               else laast_til_kl end,
           laast_kl = case when v_i_alt >= maks_i_alt then now() else laast_kl end
     where trade_id = p_trade
    returning * into a;

    if a.laast_kl is not null or v_vindue >= maks_pr_time then
      v_tekst := case when a.laast_kl is not null
        then 'Afhentningskode: låst efter ' || v_i_alt || ' forkerte forsøg'
        else 'Afhentningskode: ' || v_vindue || ' forkerte forsøg inden for en time' end;
      update public.betalinger
         set kraever_opmaerksomhed = true,
             sidste_fejl = left(case
               when kraever_opmaerksomhed and sidste_fejl is not null
                    and position(v_tekst in sidste_fejl) = 0
                 then sidste_fejl || ' · ' || v_tekst
               when kraever_opmaerksomhed and sidste_fejl is not null
                 then sidste_fejl
               else v_tekst end, 500),
             opdateret = now()
       where id = b.id;
    end if;

    if a.laast_kl is not null then
      return jsonb_build_object('kode', 'laast');
    end if;
    if v_vindue >= maks_pr_time then
      return jsonb_build_object('kode', 'laast_midlertidigt', 'laast_til', a.laast_til_kl);
    end if;
    return jsonb_build_object('kode', 'forkert', 'tilbage', maks_pr_time - v_vindue);
  end if;

  -- Rigtig kode: frigiv.
  update public.trades
     set status = 'leveret',
         received_at = coalesce(received_at, now())
   where id = p_trade
     and seller_id = kalder
     and afhentning
     and status = 'betaling_modtaget'
     and not coalesce(sag_aaben, false);
  if not found then return jsonb_build_object('kode', 'ikke_mulig'); end if;

  update public.betalinger
     set frigivet_kl = now(), opdateret = now()
   where id = b.id and frigivet_kl is null;

  -- 20261102080000: skyldtes markeringen KUN forkerte afhentningskoder (de
  -- tekster, der sættes ovenfor), er der intet at kigge på, når den rigtige
  -- kode er tastet. Andre grunde (også blandet med koderne) bliver stående.
  update public.betalinger
     set kraever_opmaerksomhed = false,
         sidste_fejl = null,
         opdateret = now()
   where id = b.id
     and kraever_opmaerksomhed
     and sidste_fejl ~ '^Afhentningskode: [^·]+( · Afhentningskode: [^·]+)*$';

  update public.afhentninger
     set bekraeftet_kl = now()
   where trade_id = p_trade and bekraeftet_kl is null;

  -- Bedoemmelsen offentliggoeres nu, hvor afhentningen er gennemfoert:
  -- altid fra handlens koeber til handlens saelger (aldrig fra kalderen, som
  -- her er saelgeren). Statusskiftet ovenfor sker kun een gang, saa et
  -- dobbeltklik naar aldrig hertil to gange.
  if a.bedoemmelse_stjerner is not null and t.buyer_id <> t.seller_id then
    insert into public.ratings
      (fra_bruger_id, til_bruger_id, auktion_id, trade_id, stjerner, kommentar)
    values
      (t.buyer_id, t.seller_id, t.auction_id, t.id,
       a.bedoemmelse_stjerner, a.bedoemmelse_kommentar)
    on conflict do nothing;
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Den gemte pakkeshop (leveringsforslag)
--
-- handel_gem_levering gemmer transportoer fra det SENESTE valg (også "levering
-- hjem"), men beholder pakkeshoppen fra et tidligere valg (coalesce). En gemt
-- GLS-pakkeshop kunne derfor stå med transportoer 'dao' og blev ikke
-- forudfyldt (eller blev vist under det forkerte fragtfirma). Shoppens eget
-- fragtfirma gemmes nu i pakkeshop_transportoer af en trigger, når
-- pakkeshoppen skifter - handel_gem_levering ændres ikke.
-- Ældre rækker: sidste valg var en pakkeshop -> transportoer er shoppens.
-- Ellers null: hjemmesiden slår shoppen op hos det seneste fragtfirma én
-- gang og retter (eller rydder) rækken (tjekGemtPakkeshop i
-- src/lib/fragt/server.ts).
-- ---------------------------------------------------------------------------
alter table public.leveringsforslag add column if not exists pakkeshop_transportoer text;
alter table public.leveringsforslag drop constraint if exists leveringsforslag_pakkeshop_transportoer_check;
alter table public.leveringsforslag add constraint leveringsforslag_pakkeshop_transportoer_check check (
  pakkeshop_transportoer is null or pakkeshop_transportoer in ('dao', 'gls', 'postnord'));
comment on column public.leveringsforslag.pakkeshop_transportoer is
  'Den gemte pakkeshops eget fragtfirma (transportoer er det SENESTE valgs - kan være levering hjem). Sættes af triggeren leveringsforslag_pakkeshop_transportoer, når pakkeshop_id skifter. 20261102080000.';

update public.leveringsforslag
   set pakkeshop_transportoer = transportoer
 where pakkeshop_transportoer is null
   and pakkeshop_id is not null
   and maade = 'pakkeshop'
   and transportoer is not null;

create or replace function public.leveringsforslag_pakkeshop_transportoer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.pakkeshop_id is not null and new.pakkeshop_transportoer is null then
      new.pakkeshop_transportoer := new.transportoer;
    end if;
  elsif new.pakkeshop_id is distinct from old.pakkeshop_id
        and new.pakkeshop_transportoer is not distinct from old.pakkeshop_transportoer then
    -- Ny pakkeshop: den er valgt hos valgets fragtfirma. Ryddet: null.
    new.pakkeshop_transportoer := case when new.pakkeshop_id is null then null else new.transportoer end;
  end if;
  return new;
end
$$;
revoke all on function public.leveringsforslag_pakkeshop_transportoer() from public, anon, authenticated;

drop trigger if exists leveringsforslag_pakkeshop_transportoer on public.leveringsforslag;
create trigger leveringsforslag_pakkeshop_transportoer
  before insert or update on public.leveringsforslag
  for each row execute function public.leveringsforslag_pakkeshop_transportoer();

-- ---------------------------------------------------------------------------
-- 6. Test af chatfilteret. Fejler et eksempel, afbrydes migrationen. PRÆCIS
--    samme liste som tests/enhed/spamfilterEksempler.ts (TS-spejlet).
-- ---------------------------------------------------------------------------
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
      ('Kan hente kl 17', null),
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
      ('mobilepay 2234 5678', 'mobilepay'),
      ('MobilePay box 12345', 'mobilepay'),
      ('send på mp 22 34 56 78', 'mobilepay'),
      ('Model 1234-567890 virker fint', null),
      ('1. reg. 2015, kørt 145000 km', null),
      ('Reg. år 2016 og 210000 km på uret', null),
      ('1. reg 2018, pris 125000 kr', null),
      ('Årgang 2015 - 145000 km', null),
      ('Stelnr 1234-567890', null),
      ('1234 - 1234567890', null),
      ('Varenr 1234-123456', null),
      ('Prisen er 1234 kr', null),
      ('Pakken vejer 1234 gram', null),
      ('Jeg har en konto hos Stripe', null),
      ('Regningen er på 1234 kr', null),
      ('EAN 5701234567890', null),
      ('Den kostede 2500 i 2019', null),
      ('Jeg betaler med MobilePay', null),
      ('ring 2 2 3 3 4 4 5 5', 'telefon'),
      ('2 2 3 3 4 4 5 5', 'telefon'),
      ('Mit nummer: 2-2-3-3-4-4-5-5 tak', 'telefon'),
      ('2/2/3/3/4/4/5/5', 'telefon'),
      ('2.2.3.3.4.4.5.5 skriv', 'telefon'),
      ('22 3 3 44 55 hej', 'telefon'),
      ('2 23 34 45 5 hilsen Ole', 'telefon'),
      ('ring 223 344 55', 'telefon'),
      ('sms 2233 44 55', 'telefon'),
      ('Skriv til 223.344.55', 'telefon'),
      ('Ring på 22/33/44/55', 'telefon'),
      ('2 2 3 3 4 4 5 5 er mit nummer', 'telefon'),
      ('ring  2  2  3  3  4  4  5  5', 'telefon'),
      ('ring 2 - 2 - 3 - 3 - 4 - 4 - 5 - 5', 'telefon'),
      ('Ring 22 33 44 55 - 2 stk tilbage', 'telefon'),
      ('mobilepay 2 2 3 3 4 4 5 5', 'mobilepay'),
      ('send på mp 223 344 55', 'mobilepay'),
      ('reg 1 2 3 4 konto 1 2 3 4 5 6 7 8', 'bank'),
      ('regnr 1.2.3.4 kontonr 12-34-56-78', 'bank'),
      ('Overfør til 1 2 3 4 - 1 2 3 4 5 6 7 8', 'bank'),
      ('Reg.nr. 12 34 kontonr. 00 12 34 56 78', 'bank'),
      ('1 2 3 4 konto 7 6 5 4 3 2 1', 'bank'),
      ('Indbetal på 1234 0012345678', 'bank'),
      ('Mit kort er 4111 1111 1111 1111', 'bank'),
      ('4111-1111-1111-1111', 'bank'),
      ('4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', 'bank'),
      ('5555555555554444', 'bank'),
      ('4242.4242.4242.4242 udløb 12/28', 'bank'),
      ('Amex 3782 822463 10005', 'bank'),
      ('Dankort 5019 7170 1010 3742', 'bank'),
      ('Den koster 1.500 kr.', null),
      ('Vi ses 24/12', null),
      ('3 x 2 stk', null),
      ('Vi ses 24/12 2026', null),
      ('Afhentning 24.12.2026', null),
      ('Ring hvis 24.12.2026 ikke passer', null),
      ('Jeg kan hente 24-12-2026 kl 14', null),
      ('Jeg forventer 2.500-3.000', null),
      ('Jeg byder 2.500 3.000', null),
      ('Byd mellem 2.000 og 3.000', null),
      ('Jeg tilbyder 2.250', null),
      ('Den måler 22 x 33 x 44 cm', null),
      ('Kan hentes 24/12 25/12', null),
      ('Kan sendes 1/11 eller 2/11', null),
      ('Jeg er hjemme 20.00-22.00 i morgen', null),
      ('kl 9.30 - 10.30', null),
      ('Den er fra 2019/2020', null),
      ('2 stk á 250 kr, 3 stk á 300 kr', null),
      ('Hentes i uge 42 eller 43', null),
      ('Pakken vejer 2,5 kg og måler 30 x 20 x 10', null),
      ('Kortet 4111 1111 1111 1112 virker ikke', null),
      ('IMEI 356938035643809', null),
      ('Ordrenummer 4571 1234 1234 1234', null),
      ('Jeg har 3 børn på 2, 4 og 6 år', null)
    ) as x(tekst, forventet)
  loop
    v_faktisk := public.besked_spam_grund(r.tekst);
    if v_faktisk is distinct from r.forventet then
      v_fejl := v_fejl || format(E'\n  %L: forventet %s, fik %s',
                                 r.tekst, coalesce(r.forventet, 'null'), coalesce(v_faktisk, 'null'));
    end if;
  end loop;

  -- "Spørg sælger" (indeholder_kontaktinfo bygger på besked_spam_grund).
  if not public.indeholder_kontaktinfo('ring 2 2 3 3 4 4 5 5') then
    v_fejl := v_fejl || E'\n  indeholder_kontaktinfo(ring 2 2 3 3 4 4 5 5) skulle være true';
  end if;
  if public.indeholder_kontaktinfo('Den koster 1.500 kr.') then
    v_fejl := v_fejl || E'\n  indeholder_kontaktinfo(Den koster 1.500 kr.) skulle være false';
  end if;

  if v_fejl <> '' then
    raise exception 'Chatfilteret fejlede:%', v_fejl;
  end if;
end
$test$;
