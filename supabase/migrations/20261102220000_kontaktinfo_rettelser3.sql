-- Kontaktoplysninger i auktioner: rettelser efter review nr. 3 (27. okt. 2026).
--
-- Bygger på:
--   auktion_kontaktinfo_grund, auktion_kontaktinfo_afvis   20261102190000_kontaktinfo_rettelser2.sql
--   besked_spam_grund                                      20261102080000_handel_testfund.sql
--   besked_normaliser                                      20261006030000_tryghed_chat_kontakt.sql
-- Rører IKKE chatfilteret (besked_spam_grund), IKKE afvisningen
-- (auktion_kontaktinfo_afvis), IKKE triggeren og IKKE grants på users eller
-- auctions (20261102060000).
--
-- Regel (Filip, ROADMAP-BESLUTNINGER.md): 8 cifre stoppes altid, IKEA-numre
-- (3.3.2) kun tilladt med ordet "ikea", og al betaling går via BidHamr.
--
-- Indhold:
--   1. auktion_kontaktinfo_grund (SPEJL: src/lib/auktionKontaktinfo.ts):
--      a) Skilletegn: cifre i en "kæde" må være adskilt af mellemrum og
--         . , ; : _ * | + ( ) [ ] { } < > / \ ~ = ' " & ! ? ^ - – — (gerne
--         flere i træk) og af enhederne db/hz/khz/mhz/ghz ("Ring 22:33:44:55",
--         "(22) 33 44 55", "22 -- 33 -- 44 -- 55", "Signal: 2233 hz 4455 hz").
--         0 / 00 / 45 / 0045 + 8 cifre stoppes altid ("Sofa 022334455").
--      b) Alle Unicode-cifre (Nd, fx arabisk-indiske) læses som 0-9.
--      c) 8 cifre i en kæde: hele kæden med 8 cifre, en blok på 8 cifre eller
--         grupperne 4-4 og 2-2-2-2 inde i en længere kæde ("2233/4455/1",
--         "1-2233-4455"). Efter et vareord/en mærkat altid stoppet (undtagen et
--         årstalspar); ellers stoppet, medmindre chatfilteret kender cifrene
--         som dato, klokkeslæt, beløb, årstal eller størrelser. Chatfilteret
--         køres på højst 40 tegn før kæden + nummeret (lineært - før blev det
--         kørt på hele teksten for hvert nummer); hvert vindue tjekkes én
--         gang, og har en tekst over 50 forskellige mulige telefonnumre,
--         stoppes den ('telefon'). Køres FØR varenumre og
--         signalværdier neutraliseres, men efter IKEA-numrene.
--      d) Kontaktord: fast ordliste for konto/bank (konto, kontoen, kontonr,
--         kontonummer, bank, banken, bankkonto, bankoverførsel) - "kontor" og
--         "bankskab" tæller ikke. "mvh" og "hilsen" er ikke længere kontaktord.
--      e) Bankoplysninger skrevet som varenummer: står der konto, reg eller
--         bank (også "netbank") i teksten, stoppes 4 cifre + 6-10 cifre og en
--         blok på 10-14 cifre - ikke med en enhed (km, kr, kg ...) bagefter.
--      f) MobilePay som ord ("MobilePay", "mobile pay", "mp box", "på mp")
--         stoppes altid ('mobilepay').
--      g) Alle %XX (ASCII) og HTML-entiteter (&#64; &#x40; &commat; ...)
--         afkodes (op til 4 gange). E-mail med mellemrum ("hans @ gmail .
--         com") og en mailudbyder som ord ("hans på gmail", "på mail")
--         stoppes ('email').
--      h) Tekster over 2.000 tegn afvises ('for_lang'). Titel og beskrivelse
--         må højst være 120/500 tegn (auctions_titel_laengde /
--         auctions_beskrivelse_laengde), men triggeren kører før tjekket.
--   2. auktion_kontaktinfo_kandidater: intern hjælper (blokindeks for
--      mulige telefonnumre i et nummer).
--   3. Adgang: auktion_kontaktinfo_grund lukkes for authenticated - hverken
--      hjemmesiden eller appen kalder den direkte (kun triggeren, "Sæt op
--      igen" og genopsætning via auktion_kontaktinfo_afvis, alle security
--      definer).
--   4. Testblok: samme eksempler som tests/enhed/auktionKontaktinfoEksempler.ts.
--
-- Kendte rester:
--   - "IKEA 223.344.55": står ordet "ikea" i teksten uden kontaktord, slipper
--     et telefonnummer i IKEA-formatet 3.3.2 igennem (Filips regel).
--   - 9-10 cifre i én blok eller i andre grupperinger end 4-4 / 2-2-2-2 efter
--     et vareord ("Varenr 122334455", "SKU 2233445566") er et varenummer.
--   - Tal skrevet med bogstaver ("to to tre tre ...", "2O334455").
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) af alt,
-- der erstattes - før noget ændres. Idempotent (kan køres igen). Kan kun
-- køres efter 20261102190000. Kør først på testdatabasen.

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
-- 1. Drift-tjek - før noget ændres. Hver: før (190000) | efter denne fil.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  -- Filteret, der bygges på (20261102080000). Uændret af denne fil.
  v_md5 := pg_temp.krop_md5('public.besked_spam_grund(text)'::regprocedure);
  if v_md5 <> '4868b54e7fa5ac608e9f2e0d08795d7a' then
    raise exception 'besked_spam_grund er ikke udgaven fra 20261102080000 (md5 %). Kør den migration først, eller tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.besked_normaliser(text)'::regprocedure);
  if v_md5 <> 'f9d51fb4ddd0b58662cac11336405f46' then
    raise exception 'besked_normaliser er ændret uden for migrationerne (md5 %). Tjek spejlet i src/lib/tryghed.ts.', v_md5;
  end if;
  -- 20261102190000 skal være kørt (afvisningen er stable fra den).
  if to_regprocedure('public.auktion_kontaktinfo_afvis(boolean, text, text)') is null
     or (select provolatile from pg_proc
          where oid = 'public.auktion_kontaktinfo_afvis(boolean, text, text)'::regprocedure) <> 's' then
    raise exception 'Kør 20261102190000_kontaktinfo_rettelser2.sql først.';
  end if;
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_grund(text, boolean)'::regprocedure);
  if v_md5 not in ('4004eec6209fd3b66a105621a269afac', '1a1ef4c91e2cb3b673821912e8891534') then
    raise exception 'auktion_kontaktinfo_grund er ikke udgaven fra 20261102190000 (md5 %). Kør den først, eller tjek den, før den erstattes.', v_md5;
  end if;
  -- Afvisningen kalder filteret - uændret af denne fil.
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_afvis(boolean, text, text)'::regprocedure);
  if v_md5 <> 'b367746d6387dfd23d29586311ba77a3' then
    raise exception 'auktion_kontaktinfo_afvis er ændret uden for migrationerne (md5 %). Tjek den først.', v_md5;
  end if;
  -- Hjælperen er ny i denne fil.
  if to_regprocedure('public.auktion_kontaktinfo_kandidater(text[])') is not null then
    v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_kandidater(text[])'::regprocedure);
    if v_md5 <> '536d4763774bb5f1693e095900466f25' then
      raise exception 'auktion_kontaktinfo_kandidater er ændret uden for migrationerne (md5 %). Tjek den først.', v_md5;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Hjælper: mulige telefonnumre i et nummer (SPEJL: kandidater() i
--    src/lib/auktionKontaktinfo.ts). p_blokke = cifferblokkene i rækkefølge.
--    Svar: (fra, til) - blokindeks (1 = første). Hele nummeret med 8 cifre,
--    en blok på 8 cifre og grupperne 4-4 og 2-2-2-2; første ciffer 2-9.
-- ---------------------------------------------------------------------------
create or replace function public.auktion_kontaktinfo_kandidater(p_blokke text[])
 returns table(fra int, til int)
 language sql
 immutable parallel safe
 set search_path = public
as $function$
  select k.fra, k.til
    from (
      select 1 as fra, cardinality(p_blokke) as til
       where length(array_to_string(p_blokke, '')) = 8
      union all
      select i, i from generate_subscripts(p_blokke, 1) i
       where length(p_blokke[i]) = 8
      union all
      select i, i + 1 from generate_subscripts(p_blokke, 1) i
       where length(p_blokke[i]) = 4 and length(p_blokke[i + 1]) = 4
      union all
      select i, i + 3 from generate_subscripts(p_blokke, 1) i
       where length(p_blokke[i]) = 2 and length(p_blokke[i + 1]) = 2
         and length(p_blokke[i + 2]) = 2 and length(p_blokke[i + 3]) = 2
    ) k
   where p_blokke[k.fra] ~ '^[2-9]'
$function$;

comment on function public.auktion_kontaktinfo_kandidater(text[]) is
  'Intern hjælper til auktion_kontaktinfo_grund: blokindeks (fra, til) for mulige telefonnumre i et nummer (8 cifre i alt, en blok på 8, 4-4 eller 2-2-2-2; første ciffer 2-9). SPEJL: kandidater() i src/lib/auktionKontaktinfo.ts. 20261102220000.';

-- Intern: kaldes kun af filteret (triggeren er security definer).
revoke all on function public.auktion_kontaktinfo_kandidater(text[]) from public, anon, authenticated;
grant execute on function public.auktion_kontaktinfo_kandidater(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Filteret til auktioner
-- ---------------------------------------------------------------------------
create or replace function public.auktion_kontaktinfo_grund(p_tekst text, p_erhverv boolean)
 returns text
 language plpgsql
 immutable parallel safe
 set search_path = public
as $function$
declare
  v text;
  v_foer text;
  g text;
  m text[];
  r record;
  k record;
  v_nr text;
  v_tegn text;
  v_kode int;
  v_fra text;
  v_til text;
  v_kontakt boolean;
  v_bank boolean;
  v_kaede text;
  v_kontekst text;
  v_kand text;
  v_tjekket text[] := array[]::text[];
  v_blokke text[];
  v_skille text[];
  v_pos int;
  v_start int;
  v_slut int;
  v_sum int;
  i int;
  j int;
  n int;
  -- Højst så mange tegn tjekkes - længere tekster afvises.
  c_maks constant int := 2000;
  -- Højst så mange forskellige mulige telefonnumre tjekkes med chatfilteret.
  -- Flere stoppes ('telefon') - en almindelig beskrivelse har langt færre.
  c_maks_chattjek constant int := 50;
  -- Værtsnavnet i et link: https://..., www.... eller navn.dk (som chatfilterets links).
  p_vaert constant text :=
    '(https?://[a-z0-9.-]+'
    || '|(?<![a-z0-9.@-])www\.[a-z0-9.-]+'
    || '|(?<![a-z0-9.@-])([a-z0-9-]+\.)+(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co|be|ee|fi|nl|ch|uk|pl|tv|cc|gg)\M)';
  -- Ekstra topdomæner, som chatfilteret ikke kender (be, ee ...) - links her også.
  p_ekstra_link constant text := '\m[a-z0-9-]{2,}\.(be|ee|fi|nl|ch|uk|pl|tv|cc|gg)\M';
  -- Et helt link: værtsnavn + sti/forespørgsel til næste mellemrum.
  p_link constant text := p_vaert || '([/?#:]\S*)?';
  -- Topdomæner til de blokerede tjenester.
  p_tld constant text :=
    '(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co|gg|am|to|be|ee|gl|gd|in|it|tv)\M';
  p_start constant text := '(?<![a-z0-9.@-])([a-z0-9-]+\.)*';
  -- Beskedtjenester og sociale medier som domæne - altid stoppet.
  p_blok_some constant text :=
    p_start || '(((wa|t|m|fb|vb)\.me|fb\.com|x\.com|youtu\.be|instagr\.am|discord\.gg|threads\.(net|com)'
    || '|signal\.(me|org|group)|lnkd\.in|pin\.it|redd\.it)\M'
    || '|[a-z0-9-]*(whatsapp|telegram|messenger|facebook|instagram|snapchat|tiktok'
    || '|twitter|linkedin|youtube|pinterest|discord|viber|reddit)[a-z0-9-]*\.' || p_tld || ')';
  p_blok_mobilepay constant text :=
    p_start || '[a-z0-9-]*mobilepay[a-z0-9-]*\.' || p_tld;
  p_blok_betaling constant text :=
    p_start || '[a-z0-9-]*(revolut|paypal|swipp)[a-z0-9-]*\.' || p_tld;
  -- Linkforkortere - altid stoppet.
  p_blok_kort constant text :=
    p_start || '(bit\.ly|tinyurl\.com|t\.ly|goo\.gl|is\.gd|ow\.ly|rebrand\.ly|linktr\.ee'
    || '|cutt\.ly|rb\.gy|tiny\.cc|shorturl\.at)\M';
  -- E-mail, som chatfilteret ikke kender: mellemrum om punktummet og en
  -- mailudbyder som ord ("hans på gmail").
  p_email_ekstra constant text :=
    '[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\msnabel-?a\M)\s*[a-z0-9-]*[a-z][a-z0-9-]*\s*(\.|\m(punktum|dot)\M)\s*[a-z]{2,}'
    || '|\m(g-?mail|hotmail|icloud|protonmail|yahoo|gmx)\M'
    || '|\m(på|via|over|til)\s+(e-?mail|mail|outlook|live)\M';
  -- MobilePay som ord. "mp" alene er også megapixel ("12 mp"), så det kræver
  -- box/boks eller et ord som "på mp".
  p_mobilepay_ord constant text :=
    '\m(m[o0]bil[e3]?\s*-?\s*pay|m-?pay|mp\s*-?\s*(box|boks))\M'
    || '|\m(på|via|med|over|eller|og|til)\s+mp\M'
    || '|\mmp\s+(ok|modtages|tages|velkommen|accepteres)\M'
    || '|\mmp\M.{0,30}\m(box|boks)\M'
    || '|\m(box|boks)\M.{0,30}\mmp\M';
  -- Står et af disse ord i teksten (uden for et vareord), neutraliseres intet.
  -- Fast ordliste for konto/bank ("kontor", "bankskab" tæller ikke).
  p_kontaktord constant text :=
    '\m(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt'
    || '|skriv|skrive|skriver|besked|beskeden|beskeder|opkald|nummer|nummeret|nr'
    || '|whats\s*app|mobile?\s*-?\s*pay|m-?pay|mp|swish|vipps'
    || '|konto|kontoen|kontonr|kontonummer|bank|banken|bankkonto|bankoverførsel'
    || '|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)\M';
  -- Bankord til "4 cifre + 6-10 cifre": konto, reg eller bank (også "netbank").
  p_bankord constant text :=
    '\m(konto|kontoen|kontonr|kontonummer|kontonummeret|bankkonto|bankkontoen|bankoverførsel|bankoverførslen'
    || '|reg|regnr|registreringsnummer|registreringsnr|iban)\M|bank(en)?\M';
  -- En enhed lige efter et nummer: så er det ikke et kontonummer ("145000 km").
  p_enhed_efter constant text := '^\s*((km|kr|kroner|dkk|kg|gram|g|cm|mm|ml|l)\M|,-|\.-)';
  -- Et vareord: varenummer, art.nr., produktnr., reservedelsnr., delnr., SKU, EAN.
  -- "vare", "del", "art" osv. alene tæller ikke - kun med nr/nummer.
  p_vareord_ord constant text :=
    '\m(sku|ean|(vare|artikel|produkt|reservedel|del|art)s?e?\.?\s*(nr|nummer|nummeret))\M';
  -- Vareord + mindst 6 cifre/skilletegn uden mellemrum. Neutraliseres kun uden
  -- kontaktord og efter 8-cifre-tjekket.
  p_vareord constant text :=
    p_vareord_ord || '\.?[\s:#]*[0-9][0-9./-]{4,}[0-9](?![0-9])';
  -- Skilletegn mellem cifre i et nummer (gerne flere i træk).
  p_skille constant text := '[\s.,;:_*|+()\[\]{}<>/\\~=''"&!?^–—-]';
  -- Et vareord eller en anden mærkat + nummeret efter den.
  p_maerkat constant text :=
    '\m(sku|ean|imei|id|nr|nummer|nummeret|ref|reference|stregkode|art'
    || '|model[a-zæøå]*|ordre[a-zæøå]*|serie\s*nr|serienummer[a-zæøå]*|kunde\s*nr|kundenummer[a-zæøå]*'
    || '|faktura[a-zæøå]*|pakke[a-zæøå]*|varenummer[a-zæøå]*'
    || '|(vare|artikel|produkt|reservedel|del|art)s?e?\.?\s*(nr|nummer|nummeret))\M'
    || '[\s.:#]*((nr|nummer|nummeret)\M)?[\s.:#]*[0-9](' || p_skille || '*[0-9])*';
  -- En kæde af cifre: skilletegn eller en signalenhed (db, hz ...) imellem.
  p_kaede constant text := '[0-9]+((' || p_skille || '|(db|khz|mhz|ghz|hz)\M)+[0-9]+)*';
  -- Et telefonnummer: 8 cifre (første 2-9), evt. med 0, 00, 45 eller 0045 foran.
  p_tlf_cifre constant text := '^(0045|00|0|45)?[2-9][0-9]{7}$';
  p_tlf_foran constant text := '^(0045|00|0|45)[2-9][0-9]{7}$';
  p_aar constant text := '^(19|20)[0-9]{2}$';
  -- IKEA-format: 402.638.47 (ikke en del af en længere cifferrække).
  p_ikea constant text := '(?<![0-9]\.?)[0-9]{3}\.[0-9]{3}\.[0-9]{2}(?!\.?[0-9])';
  -- Tekniske signalværdier: "Signal: analog", "Signal: 20 dB" (højst 4 cifre).
  p_signal constant text :=
    '\msignal\s*[:=]\s*(analog|digital|hdmi|dvb[a-z0-9-]*|wifi|bluetooth|stereo|mono|svagt|godt|stærkt'
    || '|[0-9]{1,4}\s*(db|mhz|ghz|hz))\M';
  -- HTML-entiteter: &#64; &#x40; og de navngivne, der kan skjule kontaktinfo.
  p_entitet constant text :=
    '&#(x[0-9a-f]{1,6}|[0-9]{1,7});?'
    || '|&(amp|commat|period|sol|colon|nbsp|plus|percnt|lowbar|hyphen|dash|lpar|rpar|num|quot|apos|lt|gt);';
begin
  if coalesce(btrim(p_tekst), '') = '' then
    return null;
  end if;
  if char_length(p_tekst) > c_maks then
    return 'for_lang';
  end if;
  v := public.besked_normaliser(p_tekst);

  -- HTML-entiteter og %XX afkodes (op til 4 gange: "%2540", "&#38;#64;").
  -- Hver forekomst erstattes i fast rækkefølge (collate "C") som i spejlet.
  for i in 1..4 loop
    v_foer := v;
    for r in select s.e from (select distinct x[1] as e
                                from regexp_matches(v, '(' || p_entitet || ')', 'g') x) s
              order by s.e collate "C" loop
      if r.e like '&#%' then
        v_nr := rtrim(substr(r.e, 3), ';');
        if v_nr like 'x%' then
          v_kode := ('x' || lpad(substr(v_nr, 2), 8, '0'))::bit(32)::int;
        else
          v_kode := v_nr::int;
        end if;
        v_tegn := case when v_kode between 1 and 1114111 and v_kode not between 55296 and 57343
                       then chr(v_kode) else ' ' end;
      else
        v_tegn := case substr(r.e, 2, length(r.e) - 2)
                    when 'amp' then '&' when 'commat' then '@' when 'period' then '.'
                    when 'sol' then '/' when 'colon' then ':' when 'nbsp' then ' '
                    when 'plus' then '+' when 'percnt' then '%' when 'lowbar' then '_'
                    when 'hyphen' then '-' when 'dash' then '-' when 'lpar' then '('
                    when 'rpar' then ')' when 'num' then '#' when 'quot' then '"'
                    when 'apos' then '''' when 'lt' then '<' when 'gt' then '>'
                    else ' ' end;
      end if;
      v := replace(v, r.e, v_tegn);
    end loop;
    -- %XX: ASCII-tegn afkodes (kontroltegn bliver et mellemrum); %80-%ff røres ikke.
    for r in select s.e from (select distinct x[1] as e
                                from regexp_matches(v, '(%[0-9a-f]{2})', 'g') x) s
              order by s.e collate "C" loop
      v_kode := ('x' || lpad(substr(r.e, 2), 8, '0'))::bit(32)::int;
      if v_kode < 128 then
        v := replace(v, r.e, case when v_kode < 32 or v_kode = 127 then ' ' else chr(v_kode) end);
      end if;
    end loop;
    v := public.besked_normaliser(v);
    exit when v = v_foer;
  end loop;
  if char_length(v) > c_maks then
    return 'for_lang';
  end if;

  -- Alle Unicode-cifre (Nd, Unicode 16) læses som 0-9: nullet i hver række.
  select string_agg(chr(z + d), '' order by z, d), string_agg(d::text, '' order by z, d)
    into v_fra, v_til
    from unnest(array[
      1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872, 4160, 4240, 6112,
      6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016, 65296, 66720,
      68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736, 70864, 71248, 71360, 71376, 71386, 71472, 71904, 72016,
      72688, 72784, 73040, 73120, 73552, 90416, 92768, 92864, 93008, 93552, 118000, 120782, 120792, 120802, 120812, 120822,
      123200, 123632, 124144, 124401, 125264, 130032]) z,
         generate_series(0, 9) d;
  v := translate(v, v_fra, v_til);

  g := public.besked_spam_grund(v);
  -- E-mail tjekkes altid på hele teksten.
  if g = 'email' then
    return g;
  end if;
  if v ~ p_email_ekstra then
    return 'email';
  end if;

  -- Beskedtjenester, betalingsapps og linkforkortere som link - for alle.
  if v ~ p_blok_some then
    return 'socialt_medie';
  end if;
  if v ~ p_blok_mobilepay then
    return 'mobilepay';
  end if;
  if v ~ p_blok_betaling then
    return 'bank';
  end if;
  if v ~ p_blok_kort then
    return 'link';
  end if;
  -- Et link med et af de ekstra topdomæner tæller som link (som i chatten
  -- går link forud for telefon, bank osv.).
  if v ~ p_ekstra_link then
    g := 'link';
  end if;

  -- Links: stoppes for private. Firmaer: 7+ cifre i et link stoppes, og kun
  -- værtsnavnene fjernes - stien tjekkes med resten af teksten.
  if g = 'link' then
    if not coalesce(p_erhverv, false) then
      return 'link';
    end if;
    for m in select regexp_matches(v, '(' || p_link || ')', 'g') loop
      if length(regexp_replace(m[1], '[^0-9]', '', 'g')) >= 7 then
        return 'telefon';
      end if;
    end loop;
    v := regexp_replace(v, p_vaert, ' ', 'g');
    g := public.besked_spam_grund(v);
    if g in ('email', 'link') then
      return g;
    end if;
  end if;

  -- Kontaktord uden for vareordene ("Vare nr." tæller ikke som "nr").
  v_kontakt := regexp_replace(v, p_vareord_ord, ' ', 'g') ~ p_kontaktord;

  -- IKEA-numre: kun med ordet "ikea" og uden kontaktord.
  if not v_kontakt and v ~ '\mikea\M' then
    v := regexp_replace(v, p_ikea, ' # ', 'g');
  end if;

  -- 8 cifre efter et vareord eller en mærkat - altid stoppet. Et årstalspar
  -- ("Model 2019 2020") er ikke et telefonnummer.
  for m in select regexp_matches(v, '(' || p_maerkat || ')', 'g') loop
    v_nr := substring(m[1] from '[0-9].*$');
    if v_nr !~ '^(19|20)[0-9]{2}[\s/-]+(19|20)[0-9]{2}$' then
      v_blokke := regexp_split_to_array(v_nr, '[^0-9]+');
      if array_to_string(v_blokke, '') ~ p_tlf_cifre
         or exists (select 1 from unnest(v_blokke) b where b ~ p_tlf_cifre)
         or exists (select 1 from public.auktion_kontaktinfo_kandidater(v_blokke) kk
                     where not (kk.til = kk.fra + 1 and v_blokke[kk.fra] ~ p_aar
                                and v_blokke[kk.til] ~ p_aar)) then
        return 'telefon';
      end if;
    end if;
  end loop;

  -- Bankoplysninger skrevet som et varenummer (kræver et bankord).
  v_bank := v ~ p_bankord;
  -- 8 cifre i en hvilken som helst gruppering - før varenumre og
  -- signalværdier neutraliseres. Lineært: hver kæde læses én gang, og
  -- chatfilteret får højst 40 tegn før kæden + nummeret. Hvert vindue
  -- tjekkes én gang, og højst c_maks_chattjek gange.
  v_pos := 1;
  loop
    v_start := regexp_instr(v, p_kaede, v_pos);
    exit when v_start = 0;
    v_kaede := regexp_substr(v, p_kaede, v_pos);
    v_slut := v_start + char_length(v_kaede);
    v_pos := v_slut;
    v_blokke := regexp_split_to_array(v_kaede, '[^0-9]+');
    -- v_skille[k + 1] står mellem blok k og k + 1.
    v_skille := regexp_split_to_array(v_kaede, '[0-9]+');
    n := cardinality(v_blokke);

    if v_bank and substring(v from v_slut) !~ p_enhed_efter then
      for i in 1..n loop
        if length(v_blokke[i]) between 10 and 14 then
          return 'bank';
        end if;
        if length(v_blokke[i]) = 4 then
          v_sum := 0;
          j := i + 1;
          while j <= n and v_sum < 10 loop
            v_sum := v_sum + length(v_blokke[j]);
            if v_sum between 6 and 10 then
              return 'bank';
            end if;
            j := j + 1;
          end loop;
        end if;
      end loop;
    end if;

    if array_to_string(v_blokke, '') ~ p_tlf_foran
       or exists (select 1 from unnest(v_blokke) b where b ~ p_tlf_foran) then
      return 'telefon';
    end if;

    v_kontekst := substring(v from greatest(1, v_start - 40) for v_start - greatest(1, v_start - 40));
    for k in select * from public.auktion_kontaktinfo_kandidater(v_blokke) loop
      -- Skilletegn, som chatfilteret kan læse: . / - og mellemrum (højst 3)
      -- bevares, ":" bliver "." (klokkeslæt), resten et mellemrum.
      v_kand := v_blokke[k.fra];
      for j in k.fra .. k.til - 1 loop
        v_kand := v_kand
          || case when v_skille[j + 1] ~ '^[\s./-]{1,3}$' then v_skille[j + 1]
                  when v_skille[j + 1] = ':' then '.'
                  else ' ' end
          || v_blokke[j + 1];
      end loop;
      v_kand := v_kontekst || v_kand;
      continue when v_kand = any(v_tjekket);
      if cardinality(v_tjekket) >= c_maks_chattjek then
        return 'telefon';
      end if;
      v_tjekket := v_tjekket || v_kand;
      if public.besked_spam_grund(v_kand) = 'telefon' then
        return 'telefon';
      end if;
    end loop;
  end loop;

  -- Intet kontaktord: varenumre med andre længder og signalværdier tæller ikke.
  if not v_kontakt then
    v := regexp_replace(v, p_vareord, ' # ', 'g');
    v := regexp_replace(v, p_signal, ' # ', 'g');
  end if;
  g := public.besked_spam_grund(v);
  if g is not null then
    return g;
  end if;

  -- MobilePay som ord - al betaling går via BidHamr.
  if v ~ p_mobilepay_ord then
    return 'mobilepay';
  end if;
  return null;
end;
$function$;

comment on function public.auktion_kontaktinfo_grund(text, boolean) is
  'Kontaktoplysninger i en auktions titel/beskrivelse: grund som besked_spam_grund, ''for_lang'' (over 2.000 tegn) eller null. 8 cifre stoppes altid (alle skilletegn, alle Unicode-cifre, 0/00/45/0045 foran, 4-4 og 2-2-2-2 inde i et længere nummer). %XX og HTML-entiteter afkodes. MobilePay som ord og bankoplysninger skrevet som varenummer stoppes. Firmaer (p_erhverv) må skrive links (kun værtsnavnet fjernes; 7+ cifre i et link, beskedtjenester, sociale medier, betalingsapps og linkforkortere stoppes). Varenumre med andre længder, IKEA-numre (kun med "ikea") og signalværdier (1-4 cifre) tæller ikke uden kontaktord. Intern. SPEJL: auktionKontaktGrund() i src/lib/auktionKontaktinfo.ts. 20261102220000.';

-- Intern: hverken hjemmesiden eller appen kalder den direkte. Triggeren,
-- "Sæt op igen" og genopsætning kalder den via auktion_kontaktinfo_afvis
-- (security definer).
revoke all on function public.auktion_kontaktinfo_grund(text, boolean) from public, anon, authenticated;
grant execute on function public.auktion_kontaktinfo_grund(text, boolean) to service_role;

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
  v_detail text;
  v_besked text;
  v_n int := 0;
  v_tid timestamptz;
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
      ('www.firma.dk', 'link', null),
      ('Se www.firma.dk - varenr. 8027588', 'link', null),
      ('Se www.firma.be', 'link', null),
      ('Se firma.be/kontakt', 'link', null),
      ('firma.ee/22334455', 'link', 'telefon'),
      ('Se www.firma.dk eller ring 22 33 44 55', 'link', 'telefon'),
      ('Se www.firma.dk - MobilePay 22334455', 'link', 'mobilepay'),
      ('www.firma.dk / salg@firma.dk', 'email', 'email'),
      ('Se www.firma.dk - varenr. 80275887', 'link', 'telefon'),
      ('www.firma.dk/22334455', 'link', 'telefon'),
      ('Se https://firma.dk/sofa?tlf=22334455', 'link', 'telefon'),
      ('www.firma.dk/produkt/1234567', 'link', 'telefon'),
      ('Se 22334455.dk', 'link', 'telefon'),
      ('https://firma.dk/kontakt?mail=salg%40firma.dk', 'email', 'email'),
      ('https://firma.dk/r?u=wa%2Eme%2F45', 'socialt_medie', 'socialt_medie'),
      ('https://wa.me/4522334455', 'socialt_medie', 'socialt_medie'),
      ('t.me/firmaet', 'socialt_medie', 'socialt_medie'),
      ('instagram.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('Følg os: www.facebook.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('m.me/firmaet', 'socialt_medie', 'socialt_medie'),
      ('mobilepay.dk/box/12345', 'mobilepay', 'mobilepay'),
      ('Betal på paypal.me/firmaet', 'bank', 'bank'),
      ('https://x.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('twitter.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('www.linkedin.com/company/firmaet', 'socialt_medie', 'socialt_medie'),
      ('Se videoen på youtube.com/@firmaet', 'socialt_medie', 'socialt_medie'),
      ('youtu.be/abc123', 'socialt_medie', 'socialt_medie'),
      ('pinterest.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('threads.net/@firmaet', 'socialt_medie', 'socialt_medie'),
      ('discord.gg/firmaet', 'socialt_medie', 'socialt_medie'),
      ('https://discord.com/invite/abc', 'socialt_medie', 'socialt_medie'),
      ('signal.me/#eu/firmaet', 'socialt_medie', 'socialt_medie'),
      ('viber.com/firmaet', 'socialt_medie', 'socialt_medie'),
      ('instagr.am/firmaet', 'socialt_medie', 'socialt_medie'),
      ('reddit.com/r/firmaet', 'socialt_medie', 'socialt_medie'),
      ('https://bit.ly/3abcde', 'link', 'link'),
      ('https://tinyurl.com/abc', 'link', 'link'),
      ('t.ly/abc', 'link', 'link'),
      ('goo.gl/abc', 'link', 'link'),
      ('is.gd/abc', 'link', 'link'),
      ('ow.ly/abc', 'link', 'link'),
      ('rebrand.ly/abc', 'link', 'link'),
      ('linktr.ee/firmaet', 'link', 'link'),
      ('Spørgsmål? 223.344.55', 'telefon', 'telefon'),
      ('402.638.47', 'telefon', 'telefon'),
      ('Nr 223.344.55', 'telefon', 'telefon'),
      ('Hent varen, ID 223.344.55', 'telefon', 'telefon'),
      ('Varenr. 22334455', 'telefon', 'telefon'),
      ('SKU 22334455', 'telefon', 'telefon'),
      ('Del nr 22334455', 'telefon', 'telefon'),
      ('Produktnummer 22334455', 'telefon', 'telefon'),
      ('art.nr. 45-22334455', 'telefon', 'telefon'),
      ('Sælges. Varenr: 22334455. Hent i Odense', 'telefon', 'telefon'),
      ('Signal: 22334455 hz', 'telefon', 'telefon'),
      ('Varenummer 22334455 eller skriv', 'telefon', 'telefon'),
      ('Varenr 22334455 mobile-pay', 'telefon', 'telefon'),
      ('SKU 22334455, MobilPay velkommen', 'telefon', 'telefon'),
      ('Varenummer 80275887', 'telefon', 'telefon'),
      ('Varenr. 2233-4455', 'telefon', 'telefon'),
      ('Varenr. 22 33 44 55', 'telefon', 'telefon'),
      ('Model 2233 4455', 'telefon', 'telefon'),
      ('Varenr 1234-22334455', 'telefon', 'telefon'),
      ('reservedelsnr 4522334455', 'telefon', 'telefon'),
      ('Art.nr. 802-758-87, reservedelsnr 40263847', 'telefon', 'telefon'),
      ('Fin sofa 2233 4455 afhentes i Odense', 'telefon', 'telefon'),
      ('Sofa 45 22 33 44 55 afhentes', 'telefon', 'telefon'),
      ('Varenummer 80275887 ring 22334455', 'telefon', 'telefon'),
      ('Varenummer 80275887 22334455', 'telefon', 'telefon'),
      ('Vare 22334455', 'telefon', 'telefon'),
      ('Fin sofa. 22334455. Afhentes.', 'telefon', 'telefon'),
      ('Signal: 2233 4455 db', 'telefon', 'telefon'),
      ('Signal: hans_123', 'socialt_medie', 'socialt_medie'),
      ('IKEA Billy reol 402.638.47', null, null),
      ('IKEA Billy reol 402.638.47.', null, null),
      ('IKEA Billy reol, art.nr. 402.638.47', null, null),
      ('IKEA 223.344.55 sms', 'telefon', 'telefon'),
      ('IKEA Billy 402.638.47, skriv for mål', 'telefon', 'telefon'),
      ('Varenummer 8027588', null, null),
      ('Varenr. 1234567', null, null),
      ('SKU 123456789', null, null),
      ('Del nr 4026384712', null, null),
      ('Produktnummer 802-758-879', null, null),
      ('Art.nr. 802-758-879, reservedelsnr 402638471', null, null),
      ('EAN 5701234567890', null, null),
      ('Vare nr. 1234567, skriv gerne for flere billeder', null, null),
      ('Del nummer 123456789 - se billedet', null, null),
      ('Model 2019 2020', null, null),
      ('Signal: analog', null, null),
      ('Signal: digital', null, null),
      ('Signal: 20 dB', null, null),
      ('Signal: analog. Ring ikke', 'socialt_medie', 'socialt_medie'),
      ('Sofa i grå uld. Mål: 200 x 90 x 45 cm. Nypris 4.500 kr, sælges for 1.200 kr.', null, null),
      ('Købt 12.03.2024, brugt ca. 10 gange. Afhentes efter 24/12.', null, null),
      ('Købt 24.12.2025 i Bilka, afhentes', null, null),
      ('Cykel 28 tommer, 7 gear, årgang 2019. Stelnummer WAW12345678.', null, null),
      ('iPhone 13, 128 GB, sort. Batteri 87 %. IMEI 356938035643809', null, null),
      ('Lego 42115, komplet med vejledning og æske', null, null),
      ('Børnetøj str 86 92 98 104, 10 dele', null, null),
      ('Kan sendes med GLS eller afhentes i 8000 Aarhus C', null, null),
      ('Fra 2019/2020. Pris 2.500-3.000 ved nypris.', null, null),
      ('Pris 2500 3000 afhængig af stand', null, null),
      ('Åben kl. 20.00-22.00 for afhentning', null, null),
      ('Ring 22:33:44:55', 'telefon', 'telefon'),
      ('Fin sofa (22) 33 44 55', 'telefon', 'telefon'),
      ('22, 33, 44, 55', 'telefon', 'telefon'),
      ('22_33_44_55', 'telefon', 'telefon'),
      ('22|33|44|55', 'telefon', 'telefon'),
      ('22+33+44+55', 'telefon', 'telefon'),
      ('22*33*44*55', 'telefon', 'telefon'),
      ('[22] 33 44 55', 'telefon', 'telefon'),
      ('22 -- 33 -- 44 -- 55', 'telefon', 'telefon'),
      ('Sofa 022334455', 'telefon', 'telefon'),
      ('Sofa 0022334455', 'telefon', 'telefon'),
      ('Sofa 00 22 33 44 55', 'telefon', 'telefon'),
      ('Varenr 0022334455', 'telefon', 'telefon'),
      ('Model nr 022334455', 'telefon', 'telefon'),
      ('٢٢٣٣٤٤٥٥', 'telefon', 'telefon'),
      ('Sofa ۲۲ ۳۳ ۴۴ ۵۵', 'telefon', 'telefon'),
      ('２２３３４４５５', 'telefon', 'telefon'),
      ('Afhentning kl. 14:30', null, null),
      ('Afhentning kl. 20:00-22:00', null, null),
      ('Åben 20:30 - 21:30', null, null),
      ('Åben 20.00-22.00, 22.30-23.30', null, null),
      ('Mål 22,5 x 33,5 x 44 cm', null, null),
      ('Str. 36, 38, 40, 42', null, null),
      ('Sko str. 22, 23, 24, 25', null, null),
      ('Pris 2.500, 3.000 eller 4.000 kr', null, null),
      ('Nypris 2.999,- sælges 1.499,-', null, null),
      ('Årgang 2015 2016 2017', null, null),
      ('Model 2019 2020 2021', null, null),
      ('Passer til Golf 2008-2012 og Polo 2010-2014', null, null),
      ('Købt 01.02.2024 - 03.02.2024', null, null),
      ('Kamera 12 mp, 4k video', null, null),
      ('Kontorstol IKEA Markus 402.638.47', null, null),
      ('Kontorbord 120x60, IKEA Bekant 802.145.49', null, null),
      ('Bankskab IKEA 402.638.47', null, null),
      ('IKEA Billy 402.638.47 mvh Hans', null, null),
      ('IKEA Malm 802.145.49 - venlig hilsen Hans', null, null),
      ('IKEA Billy 402.638.47, overfør til konto', 'telefon', 'telefon'),
      ('Varenr 1234 12345678 til min konto', 'bank', 'bank'),
      ('Varenr 1234-12345678 reg nr', 'bank', 'bank'),
      ('Varenr. 1234 1234567890 netbank', 'bank', 'bank'),
      ('EAN 1234 12345678 bankoverførsel', 'bank', 'bank'),
      ('Art.nr. 1234 12 34 56 78, betal til banken', 'bank', 'bank'),
      ('SKU 12341234567890 kontoen', 'bank', 'bank'),
      ('1. reg. 2015, 145000 km', null, null),
      ('Art.nr 1234 1234567890', null, null),
      ('Betal med MobilePay', 'mobilepay', 'mobilepay'),
      ('MobilePay box 1234567 velkommen', 'mobilepay', 'mobilepay'),
      ('Box 12345 på mp', 'mobilepay', 'mobilepay'),
      ('Kontant eller mobile pay', 'mobilepay', 'mobilepay'),
      ('Mp-boks 12345', 'mobilepay', 'mobilepay'),
      ('Signal: 2233 hz 4455 hz', 'telefon', 'telefon'),
      ('Signal: 22 db 33 db 44 db 55 db', 'telefon', 'telefon'),
      ('Varenr 2233/4455/1', 'telefon', 'telefon'),
      ('Varenr 2233.4455.9', 'telefon', 'telefon'),
      ('Varenr. 1-2233-4455', 'telefon', 'telefon'),
      ('Varenr 22.33.44.55.6', 'telefon', 'telefon'),
      ('Sofa 1-2233-4455', 'telefon', 'telefon'),
      ('salg&#64;firma.dk', 'email', 'email'),
      ('salg&#x40;firma&period;dk', 'email', 'email'),
      ('%74%2eme/firmaet', 'socialt_medie', 'socialt_medie'),
      ('%32%32334455', 'telefon', 'telefon'),
      ('&#50;&#50;334455', 'telefon', 'telefon'),
      ('hans @ gmail . com', 'email', 'email'),
      ('hans på gmail', 'email', 'email'),
      ('Skriv på mail', 'email', 'email')
    ) as x(tekst, privat, firma)
  loop
    v_n := v_n + 1;
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
  if v_n <> 179 then
    v_fejl := v_fejl || format(E'\n  forventet 179 eksempler, fik %s', v_n);
  end if;
  if public.auktion_kontaktinfo_grund(null, false) is not null
     or public.auktion_kontaktinfo_grund('   ', true) is not null then
    v_fejl := v_fejl || E'\n  tom tekst skulle give null';
  end if;

  -- Over 2.000 tegn afvises; 2.000 tegn er i orden.
  if public.auktion_kontaktinfo_grund(repeat('a', 2001), false) is distinct from 'for_lang'
     or public.auktion_kontaktinfo_grund(repeat('a', 2000), false) is not null then
    v_fejl := v_fejl || E'\n  længdegrænsen på 2.000 tegn virker ikke';
  end if;
  -- Højst 50 forskellige mulige telefonnumre; gentagelser tjekkes én gang.
  if public.auktion_kontaktinfo_grund(left(repeat('2019 2020 ', 200), 2000), false) is not null
     or public.auktion_kontaktinfo_grund(
          (select string_agg(a::text, ' ') from generate_series(2000, 2060) a), false) is distinct from 'telefon'
     or public.auktion_kontaktinfo_grund(
          (select string_agg(a::text, ' ') from generate_series(2000, 2040) a), false) is not null then
    v_fejl := v_fejl || E'\n  loftet på 50 chattjek virker ikke';
  end if;
  -- Lineært: 2.000 tegn datoer, klokkeslæt og årstal på under 2 sekunder.
  v_tid := clock_timestamp();
  perform public.auktion_kontaktinfo_grund(left(repeat('24.12.2025 20.00-22.00 ', 100), 2000), false);
  perform public.auktion_kontaktinfo_grund(left(repeat('20.00-22.00 ', 200), 2000), false);
  perform public.auktion_kontaktinfo_grund(left(repeat('str 22 23 24 25 ', 200), 2000), false);
  if clock_timestamp() - v_tid > interval '2 seconds' then
    v_fejl := v_fejl || format(E'\n  2.000 tegn tog %s', clock_timestamp() - v_tid);
  end if;

  -- Afvisningen: fejlkode, felt og tekst (firmaer får ikke "links").
  begin
    perform public.auktion_kontaktinfo_afvis(true, 'Sofa', 'Varenr. 22334455');
    v_fejl := v_fejl || E'\n  afvis(firma) kastede ikke';
  exception when sqlstate 'BHA08' then
    get stacked diagnostics v_besked = message_text, v_detail = pg_exception_detail;
    if v_besked ~ 'links' or v_detail::jsonb->>'felt' <> 'beskrivelse'
       or v_detail::jsonb->>'grund' <> 'telefon'
       or (v_detail::jsonb->>'erhverv')::boolean is not true then
      v_fejl := v_fejl || format(E'\n  afvis(firma): %s / %s', v_besked, v_detail);
    end if;
  end;
  begin
    perform public.auktion_kontaktinfo_afvis(false, 'Ring 22:33:44:55', null);
    v_fejl := v_fejl || E'\n  afvis(privat) kastede ikke';
  exception when sqlstate 'BHA08' then
    get stacked diagnostics v_besked = message_text, v_detail = pg_exception_detail;
    if v_besked !~ 'links i titlen' or v_detail::jsonb->>'grund' <> 'telefon' then
      v_fejl := v_fejl || format(E'\n  afvis(privat): %s / %s', v_besked, v_detail);
    end if;
  end;
  perform public.auktion_kontaktinfo_afvis(true, 'Sofa fra www.firma.dk', 'Varenummer 8027588');
  perform public.auktion_kontaktinfo_afvis(false, 'Kontorstol IKEA Markus 402.638.47', 'SKU 123456789');

  -- Adgang: intern (kun service_role).
  if has_function_privilege('authenticated', 'public.auktion_kontaktinfo_grund(text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.auktion_kontaktinfo_grund(text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.auktion_kontaktinfo_kandidater(text[])', 'execute')
     or has_function_privilege('anon', 'public.auktion_kontaktinfo_kandidater(text[])', 'execute')
     or not has_function_privilege('service_role', 'public.auktion_kontaktinfo_grund(text, boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.auktion_kontaktinfo_kandidater(text[])', 'execute') then
    v_fejl := v_fejl || E'\n  forkerte rettigheder på auktion_kontaktinfo_grund/_kandidater';
  end if;

  if v_fejl <> '' then
    raise exception 'Kontaktinfo-filteret til auktioner fejlede:%', v_fejl;
  end if;
end
$test$;
