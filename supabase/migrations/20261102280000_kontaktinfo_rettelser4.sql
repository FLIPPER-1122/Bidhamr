-- Kontaktoplysninger i auktioner: rettelser efter review nr. 4 (27. okt. 2026).
--
-- Bygger på:
--   auktion_kontaktinfo_grund, auktion_kontaktinfo_kandidater  20261102220000_kontaktinfo_rettelser3.sql
--   auktion_kontaktinfo_afvis                                  20261102190000_kontaktinfo_rettelser2.sql
--   besked_spam_grund                                          20261102080000_handel_testfund.sql
--   besked_normaliser                                          20261006030000_tryghed_chat_kontakt.sql
-- Rører IKKE chatfilteret (besked_spam_grund), IKKE afvisningen
-- (auktion_kontaktinfo_afvis), IKKE hjælperen (auktion_kontaktinfo_kandidater),
-- IKKE triggeren og IKKE grants på users eller auctions (20261102060000).
--
-- Regel (Filip, ROADMAP-BESLUTNINGER.md): 8 cifre stoppes altid, og al
-- betaling går via BidHamr. Almindelige annoncer må ikke afvises.
--
-- Indhold - kun auktion_kontaktinfo_grund (SPEJL: src/lib/auktionKontaktinfo.ts):
--   a) Mail-ord: "icloud" stoppes kun med et brugernavn ("hans.hansen icloud",
--      "icloud: hans_12") eller "@" ved siden af. "live" og "outlook" er ikke
--      længere med i "(på|via|over|til) ...". "på/via/over mail" stoppes kun
--      med et kontaktverbum foran ("skriv på mail", "kontakt mig på mail",
--      "send mig på mail"). gmail/hotmail ... stoppes ikke i et sammensat ord
--      ("Gmail-konto"). Tilladt nu: "iPhone 12, ikke iCloud-låst", "Perfekt
--      til live musik", "Kvittering kan sendes på mail".
--   b) MobilePay: "mp ... box" og "box ... mp" på afstand er droppet. Kun
--      "mp box"/"mp-box"/"mp boks" lige efter hinanden og med cifre bagefter
--      stoppes. Ordet MobilePay stoppes stadig altid. Tilladt nu: "Kamera 24
--      MP, original boks medfølger", "MP-box ikke inkluderet".
--   c) Bank: bankord kræver ordstart og en fast liste ("powerbank" tæller
--      ikke); "reg" tæller kun som reg.nr/regnr/reg nr eller reg + 4 cifre
--      ("reg. højde" tæller ikke). Er de 4 cifre i "4 + 6-10 cifre" et
--      årstal i en dato (15.03.2024), springes de over. Efter et vareord
--      (EAN, SKU, varenr ...) kræves 4 + mindst 8 cifre ("Varenr 1234 567890"
--      er et varenummer; "Varenr 1234 12345678 til min konto" stoppes).
--      Blokke på 10-14 cifre stoppes som før.
--   d) Kombinationstegn (Unicode M, fx U+0301 efter hvert ciffer) fjernes
--      efter hver normalisering.
--   Testblok: samme eksempler som tests/enhed/auktionKontaktinfoEksempler.ts.
--
-- Kendte rester:
--   - "IKEA 223.344.55": står ordet "ikea" i teksten uden kontaktord, slipper
--     et telefonnummer i IKEA-formatet 3.3.2 igennem (Filips regel).
--   - 9-10 cifre i én blok eller i andre grupperinger end 4-4 / 2-2-2-2 efter
--     et vareord ("Varenr 122334455", "SKU 2233445566") er et varenummer.
--   - Tal skrevet med bogstaver ("to to tre tre ...", "2O334455").
--   - Et kontonummer forklædt som varenummer med 4 + 6-7 cifre ("Varenr 1234
--     567890 netbank") eller efter en dato ("konto 15.03.2024 123456").
--   - E-mail som "hans på outlook", "hans icloud" (brugernavn uden . _ eller
--     cifre) og "på mail" uden kontaktverbum.
--
-- Drift-tjek (md5 af kroppen, CRLF -> LF, uden rene kommentarlinjer) af alt,
-- der bygges på - før noget ændres. Idempotent (kan køres igen). Kan kun
-- køres efter 20261102220000. Kør først på testdatabasen.

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
-- 1. Drift-tjek - før noget ændres. Filteret: før (220000) | efter denne fil.
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
  -- 20261102220000 skal være kørt (hjælperen er ny fra den).
  if to_regprocedure('public.auktion_kontaktinfo_kandidater(text[])') is null then
    raise exception 'Kør 20261102220000_kontaktinfo_rettelser3.sql først.';
  end if;
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_kandidater(text[])'::regprocedure);
  if v_md5 <> '536d4763774bb5f1693e095900466f25' then
    raise exception 'auktion_kontaktinfo_kandidater er ikke udgaven fra 20261102220000 (md5 %). Tjek den først.', v_md5;
  end if;
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_grund(text, boolean)'::regprocedure);
  if v_md5 not in ('1a1ef4c91e2cb3b673821912e8891534', '78961878cea77268a1a9452eda8ea620') then
    raise exception 'auktion_kontaktinfo_grund er ikke udgaven fra 20261102220000 (md5 %). Kør den først, eller tjek den, før den erstattes.', v_md5;
  end if;
  -- Afvisningen kalder filteret - uændret af denne fil.
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_afvis(boolean, text, text)'::regprocedure);
  if v_md5 <> 'b367746d6387dfd23d29586311ba77a3' then
    raise exception 'auktion_kontaktinfo_afvis er ændret uden for migrationerne (md5 %). Tjek den først.', v_md5;
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
  v_min int;
  v_maerker text;
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
  -- Et brugernavn: bogstaver med . eller _ ("hans.hansen", "hans_12") eller
  -- bogstaver efterfulgt af cifre ("hans123").
  p_bruger constant text :=
    '(?<![a-z0-9._%+@-])([a-z][a-z0-9]*([._][a-z0-9]+)+|[a-z]+[0-9][a-z0-9]*)';
  -- Et kontaktverbum foran "på mail": skriv (til mig), send mig, kontakt (mig).
  p_kontaktverbum constant text :=
    '(skriv(e|er)?(\s+(til\s+)?mig)?|send(e|er)?\s+mig|kontakt(e|er)?(\s+mig)?)';
  -- E-mail, som chatfilteret ikke kender: mellemrum om punktummet, en
  -- mailudbyder som ord ("hans på gmail" - ikke "gmail-konto"), iCloud/Outlook
  -- med et brugernavn eller @ ved siden af (ikke "iCloud-låst") og
  -- "skriv/send mig/kontakt (mig) på mail" (ikke "kvittering sendes på mail").
  p_email_ekstra constant text :=
    '[a-z0-9._%+-]+\s*(@|\(at\)|\[at\]|\msnabel-?a\M)\s*[a-z0-9-]*[a-z][a-z0-9-]*\s*(\.|\m(punktum|dot)\M)\s*[a-z]{2,}'
    || '|\m(g-?mail|hotmail|protonmail|yahoo|gmx)\M(?!-[a-zæøå])'
    || '|' || p_bruger || '\s+(på\s+)?(icloud|outlook)\M(?!-[a-zæøå])'
    || '|\micloud(\s*[:=]\s*|\s+)' || p_bruger || '\M'
    || '|@\s*icloud\M|\micloud\s*@'
    || '|\m' || p_kontaktverbum || '\s+(på|via|over|til|pr\.?|per)\s+(e-?mail|mail)\M';
  -- MobilePay som ord. "mp" alene er også megapixel ("12 mp"), så det kræver
  -- "mp box"/"mp-boks" lige efter hinanden med cifre bagefter, eller et ord
  -- som "på mp".
  p_mobilepay_ord constant text :=
    '\m(m[o0]bil[e3]?\s*-?\s*pay|m-?pay)\M'
    || '|\mmp\s*-?\s*(box|boks)[\s:#.-]*[0-9]'
    || '|\m(på|via|med|over|eller|og|til)\s+mp\M'
    || '|\mmp\s+(ok|modtages|tages|velkommen|accepteres)\M';
  -- Står et af disse ord i teksten (uden for et vareord), neutraliseres intet.
  -- Fast ordliste for konto/bank ("kontor", "bankskab" tæller ikke).
  p_kontaktord constant text :=
    '\m(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt'
    || '|skriv|skrive|skriver|besked|beskeden|beskeder|opkald|nummer|nummeret|nr'
    || '|whats\s*app|mobile?\s*-?\s*pay|m-?pay|mp|swish|vipps'
    || '|konto|kontoen|kontonr|kontonummer|bank|banken|bankkonto|bankoverførsel'
    || '|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)\M';
  -- Bankord til "4 cifre + 6-10 cifre": fast liste med ordstart ("powerbank"
  -- tæller ikke). "reg" kun som reg.nr/regnr/reg nr eller reg + 4 cifre
  -- ("reg. højde" tæller ikke).
  p_bankord constant text :=
    '\m(bank|banken|netbank|netbanken|bankkonto|bankkontoen|bankoverførsel|bankoverførslen'
    || '|konto|kontoen|kontonr|kontonummer|kontonummeret|regnr|registreringsnummer|registreringsnr|iban)\M'
    || '|\mreg\.?\s*nr\M|\mreg[.:]?\s*[0-9]{4}(?![0-9])';
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
  -- Et vareord lige før et nummer (EAN, SKU, varenr ...): så kræver
  -- kontoreglen 4 cifre + mindst 8 cifre ("Varenr 1234 567890" er et varenummer).
  p_vare_foer constant text := p_vareord_ord || '\.?[\s.:#]*$';
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

  -- Kombinationstegn (Unicode M: Mn, Mc, Me, Unicode 16) som par (fra, til).
  -- De fjernes efter hver normalisering ("2" + U+0301 ... læses som "2").
  -- NFKC har allerede samlet æ/ø/å og é. Samme liste i spejlet (MAERKE_PAR).
  select '[' || string_agg(case when p.a[2 * q.k - 1] = p.a[2 * q.k] then chr(p.a[2 * q.k - 1])
                                else chr(p.a[2 * q.k - 1]) || '-' || chr(p.a[2 * q.k]) end, '' order by q.k) || ']'
    into v_maerker
    from (select array[
  768, 879, 1155, 1161, 1425, 1469, 1471, 1471, 1473, 1474, 1476, 1477, 1479, 1479, 1552, 1562, 1611, 1631, 1648,
  1648, 1750, 1756, 1759, 1764, 1767, 1768, 1770, 1773, 1809, 1809, 1840, 1866, 1958, 1968, 2027, 2035, 2045, 2045,
  2070, 2073, 2075, 2083, 2085, 2087, 2089, 2093, 2137, 2139, 2199, 2207, 2250, 2273, 2275, 2307, 2362, 2364, 2366,
  2383, 2385, 2391, 2402, 2403, 2433, 2435, 2492, 2492, 2494, 2500, 2503, 2504, 2507, 2509, 2519, 2519, 2530, 2531,
  2558, 2558, 2561, 2563, 2620, 2620, 2622, 2626, 2631, 2632, 2635, 2637, 2641, 2641, 2672, 2673, 2677, 2677, 2689,
  2691, 2748, 2748, 2750, 2757, 2759, 2761, 2763, 2765, 2786, 2787, 2810, 2815, 2817, 2819, 2876, 2876, 2878, 2884,
  2887, 2888, 2891, 2893, 2901, 2903, 2914, 2915, 2946, 2946, 3006, 3010, 3014, 3016, 3018, 3021, 3031, 3031, 3072,
  3076, 3132, 3132, 3134, 3140, 3142, 3144, 3146, 3149, 3157, 3158, 3170, 3171, 3201, 3203, 3260, 3260, 3262, 3268,
  3270, 3272, 3274, 3277, 3285, 3286, 3298, 3299, 3315, 3315, 3328, 3331, 3387, 3388, 3390, 3396, 3398, 3400, 3402,
  3405, 3415, 3415, 3426, 3427, 3457, 3459, 3530, 3530, 3535, 3540, 3542, 3542, 3544, 3551, 3570, 3571, 3633, 3633,
  3636, 3642, 3655, 3662, 3761, 3761, 3764, 3772, 3784, 3790, 3864, 3865, 3893, 3893, 3895, 3895, 3897, 3897, 3902,
  3903, 3953, 3972, 3974, 3975, 3981, 3991, 3993, 4028, 4038, 4038, 4139, 4158, 4182, 4185, 4190, 4192, 4194, 4196,
  4199, 4205, 4209, 4212, 4226, 4237, 4239, 4239, 4250, 4253, 4957, 4959, 5906, 5909, 5938, 5940, 5970, 5971, 6002,
  6003, 6068, 6099, 6109, 6109, 6155, 6157, 6159, 6159, 6277, 6278, 6313, 6313, 6432, 6443, 6448, 6459, 6679, 6683,
  6741, 6750, 6752, 6780, 6783, 6783, 6832, 6862, 6912, 6916, 6964, 6980, 7019, 7027, 7040, 7042, 7073, 7085, 7142,
  7155, 7204, 7223, 7376, 7378, 7380, 7400, 7405, 7405, 7412, 7412, 7415, 7417, 7616, 7679, 8400, 8432, 11503, 11505,
  11647, 11647, 11744, 11775, 12330, 12335, 12441, 12442, 42607, 42610, 42612, 42621, 42654, 42655, 42736, 42737,
  43010, 43010, 43014, 43014, 43019, 43019, 43043, 43047, 43052, 43052, 43136, 43137, 43188, 43205, 43232, 43249,
  43263, 43263, 43302, 43309, 43335, 43347, 43392, 43395, 43443, 43456, 43493, 43493, 43561, 43574, 43587, 43587,
  43596, 43597, 43643, 43645, 43696, 43696, 43698, 43700, 43703, 43704, 43710, 43711, 43713, 43713, 43755, 43759,
  43765, 43766, 44003, 44010, 44012, 44013, 64286, 64286, 65024, 65039, 65056, 65071, 66045, 66045, 66272, 66272,
  66422, 66426, 68097, 68099, 68101, 68102, 68108, 68111, 68152, 68154, 68159, 68159, 68325, 68326, 68900, 68903,
  68969, 68973, 69291, 69292, 69372, 69375, 69446, 69456, 69506, 69509, 69632, 69634, 69688, 69702, 69744, 69744,
  69747, 69748, 69759, 69762, 69808, 69818, 69826, 69826, 69888, 69890, 69927, 69940, 69957, 69958, 70003, 70003,
  70016, 70018, 70067, 70080, 70089, 70092, 70094, 70095, 70188, 70199, 70206, 70206, 70209, 70209, 70367, 70378,
  70400, 70403, 70459, 70460, 70462, 70468, 70471, 70472, 70475, 70477, 70487, 70487, 70498, 70499, 70502, 70508,
  70512, 70516, 70584, 70592, 70594, 70594, 70597, 70597, 70599, 70602, 70604, 70608, 70610, 70610, 70625, 70626,
  70709, 70726, 70750, 70750, 70832, 70851, 71087, 71093, 71096, 71104, 71132, 71133, 71216, 71232, 71339, 71351,
  71453, 71467, 71724, 71738, 71984, 71989, 71991, 71992, 71995, 71998, 72000, 72000, 72002, 72003, 72145, 72151,
  72154, 72160, 72164, 72164, 72193, 72202, 72243, 72249, 72251, 72254, 72263, 72263, 72273, 72283, 72330, 72345,
  72751, 72758, 72760, 72767, 72850, 72871, 72873, 72886, 73009, 73014, 73018, 73018, 73020, 73021, 73023, 73029,
  73031, 73031, 73098, 73102, 73104, 73105, 73107, 73111, 73459, 73462, 73472, 73473, 73475, 73475, 73524, 73530,
  73534, 73538, 73562, 73562, 78912, 78912, 78919, 78933, 90398, 90415, 92912, 92916, 92976, 92982, 94031, 94031,
  94033, 94087, 94095, 94098, 94180, 94180, 94192, 94193, 113821, 113822, 118528, 118573, 118576, 118598, 119141,
  119145, 119149, 119154, 119163, 119170, 119173, 119179, 119210, 119213, 119362, 119364, 121344, 121398, 121403,
  121452, 121461, 121461, 121476, 121476, 121499, 121503, 121505, 121519, 122880, 122886, 122888, 122904, 122907,
  122913, 122915, 122916, 122918, 122922, 123023, 123023, 123184, 123190, 123566, 123566, 123628, 123631, 124140,
  124143, 124398, 124399, 125136, 125142, 125252, 125258, 917760, 917999]::int[] as a) p,
         generate_series(1, cardinality(p.a) / 2) q(k);

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
    v := regexp_replace(public.besked_normaliser(v), v_maerker, '', 'g');
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

    v_kontekst := substring(v from greatest(1, v_start - 40) for v_start - greatest(1, v_start - 40));

    -- Bankoplysninger: 4 cifre + 6-10 cifre (efter et vareord: 8-10) eller en
    -- blok på 10-14 cifre. Er de 4 cifre årstallet i en dato ("15.03.2024 -
    -- 12.04.2024"), er det ikke et registreringsnummer.
    if v_bank and substring(v from v_slut) !~ p_enhed_efter then
      v_min := case when v_kontekst ~ p_vare_foer then 8 else 6 end;
      for i in 1..n loop
        if length(v_blokke[i]) between 10 and 14 then
          return 'bank';
        end if;
        if length(v_blokke[i]) = 4
           and not (v_blokke[i] ~ p_aar and i >= 3
                    and length(v_blokke[i - 1]) <= 2 and length(v_blokke[i - 2]) <= 2
                    and v_skille[i - 1] ~ '^[./-]$' and v_skille[i] ~ '^[./-]$') then
          v_sum := 0;
          j := i + 1;
          while j <= n and v_sum < 10 loop
            v_sum := v_sum + length(v_blokke[j]);
            if v_sum between v_min and 10 then
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
  'Kontaktoplysninger i en auktions titel/beskrivelse: grund som besked_spam_grund, ''for_lang'' (over 2.000 tegn) eller null. 8 cifre stoppes altid (alle skilletegn, alle Unicode-cifre, kombinationstegn fjernes, 0/00/45/0045 foran, 4-4 og 2-2-2-2 inde i et længere nummer). %XX og HTML-entiteter afkodes. MobilePay som ord og bankoplysninger skrevet som varenummer stoppes (ikke powerbank, reg. højde, datoer eller 4 + 6-7 cifre efter et vareord). Firmaer (p_erhverv) må skrive links (kun værtsnavnet fjernes; 7+ cifre i et link, beskedtjenester, sociale medier, betalingsapps og linkforkortere stoppes). Varenumre med andre længder, IKEA-numre (kun med "ikea") og signalværdier (1-4 cifre) tæller ikke uden kontaktord. Intern. SPEJL: auktionKontaktGrund() i src/lib/auktionKontaktinfo.ts. 20261102280000.';

-- Intern: hverken hjemmesiden eller appen kalder den direkte. Triggeren,
-- "Sæt op igen" og genopsætning kalder den via auktion_kontaktinfo_afvis
-- (security definer).
revoke all on function public.auktion_kontaktinfo_grund(text, boolean) from public, anon, authenticated;
grant execute on function public.auktion_kontaktinfo_grund(text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Testblok - samme liste som tests/enhed/auktionKontaktinfoEksempler.ts.
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
      ('Skriv på mail', 'email', 'email'),
      ('iPhone 12, ikke iCloud-låst', null, null),
      ('iCloud låst op', null, null),
      ('iPhone12 iCloud-låst', null, null),
      ('Gmail-konto medfølger ikke', null, null),
      ('Perfekt til live musik', null, null),
      ('Forstærker til live brug', null, null),
      ('Kan sendes til Live-koncert', null, null),
      ('Kvittering kan sendes på mail', null, null),
      ('Faktura sendes via mail', null, null),
      ('Billeder sendes på mail', null, null),
      ('Sendes over mail eller hentes', null, null),
      ('Kontakt mig på mail', 'email', 'email'),
      ('Skriv til mig via e-mail', 'email', 'email'),
      ('Send mig på mail', 'email', 'email'),
      ('hans.hansen icloud', 'email', 'email'),
      ('iCloud: hans_12', 'email', 'email'),
      ('hans @icloud', 'email', 'email'),
      ('hans123 på outlook', 'email', 'email'),
      ('Kamera 24 MP, original boks medfølger', null, null),
      ('Spejlrefleks 18 MP, æske og box', null, null),
      ('12 MP kamera, kan sendes i box', null, null),
      ('Leveres i original box, 12 MP', null, null),
      ('MP-box ikke inkluderet', null, null),
      ('Mp box 12345', 'mobilepay', 'mobilepay'),
      ('Powerbank, varenr 1234 567890', null, null),
      ('Powerbank 20000 mAh, EAN 5701234567890', null, null),
      ('Kontorstol med reg. højde 45-90 cm, model 1234 567890', null, null),
      ('Købt i banken 15.03.2024 - 12.04.2024', null, null),
      ('Konto: 12.05.2023 - 11.05.2024', null, null),
      ('Købt 15.03.2024 12.04.2024, betalt med bankoverførsel', null, null),
      ('Netbank 1234 567890', 'bank', 'bank'),
      ('Reg. 5678, 1234 567890', 'bank', 'bank'),
      ('Betal til banken 15.03.2024 1234 567890', 'bank', 'bank'),
      (E'2\u03012\u03013\u03013\u03014\u03014\u03015\u03015\u0301', 'telefon', 'telefon'),
      (E'Ring 2\u03302\u0330 33 44 55', 'telefon', 'telefon')
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
  if v_n <> 214 then
    v_fejl := v_fejl || format(E'\n  forventet 214 eksempler, fik %s', v_n);
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
  perform public.auktion_kontaktinfo_afvis(false, 'iPhone 12, ikke iCloud-låst', 'Powerbank 20000 mAh, EAN 5701234567890');

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
