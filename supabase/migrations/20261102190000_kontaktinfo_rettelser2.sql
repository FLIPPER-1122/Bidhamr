-- Kontaktoplysninger i auktioner: rettelser efter review nr. 2 (27. okt. 2026).
--
-- Bygger på:
--   auktion_kontaktinfo_grund, auktion_kontaktinfo_afvis,
--   auctions_lokation_fra_postnummer                  20261102170000_kontaktinfo_rettelser.sql
--   besked_spam_grund                                 20261102080000_handel_testfund.sql
--   besked_normaliser                                 20261006030000_tryghed_chat_kontakt.sql
-- Rører IKKE chatfilteret (besked_spam_grund) og IKKE grants på users eller
-- auctions (20261102060000).
--
-- KRITISK hul i 20261102170000: neutraliseringen af varenumre, IKEA-numre og
-- signalværdier lod telefonnumre slippe igennem i private auktioner
-- ("Varenr. 22334455", "Spørgsmål? 223.344.55", "Signal: 22334455 hz").
--
-- Indhold:
--   1. auktion_kontaktinfo_grund (SPEJL: src/lib/auktionKontaktinfo.ts):
--      a) 8 cifre stoppes ALTID (chefen, 27. okt. 2026) - et dansk
--         telefonnummer kan ikke skelnes fra et varenummer på 8 cifre:
--         - efter et vareord eller en mærkat (varenr., SKU, EAN, art.nr.,
--           model, ID, nr ...): 8 cifre i alt (med eller uden skilletegn),
--           45/0045 + 8 cifre, eller en blok på præcis 8 cifre.
--         - ellers: 8 cifre i en hvilken som helst gruppering, medmindre
--           chatfilteret kender dem som dato, beløb, årstal eller størrelser
--           (chatfilteret køres på teksten frem til og med nummeret, så
--           nummeret står sidst som i chatten).
--         - 45 / 0045 + 8 cifre uden + ("4522334455").
--      b) Varenumre med andre længder (6, 7, 9 eller flere cifre) må stå
--         efter et vareord. IKEA-formatet 3.3.2 neutraliseres kun, når ordet
--         "ikea" står i teksten. Signalværdier: kun 1-4 cifre.
--      c) Flere kontaktord: skriv, besked, opkald, nummer, nr, MobilPay /
--         mobile-pay, m-pay, Swish, Vipps. "nr"/"nummer" i et vareord
--         ("Vare nr.", "Del nummer") tæller ikke.
--      d) Altid stoppet (også firmaer): linkforkortere (bit.ly, tinyurl,
--         t.ly, goo.gl, is.gd, ow.ly, rebrand.ly, linktr.ee ...; grund
--         'link'), x.com, twitter, linkedin, youtube/youtu.be, pinterest,
--         threads, discord/discord.gg, signal.me, viber, instagr.am, reddit
--         ('socialt_medie'). Topdomænerne be og ee m.fl. matches.
--      e) URL-kodning læses som tegnet (%25, %40, %2e, %2f, %3a): en e-mail
--         i en forespørgsel ("?mail=salg%40firma.dk") stoppes.
--   2. auktion_kontaktinfo_afvis: stable i stedet for immutable (kroppen
--      er uændret).
--   3. lokation på AKTIVE auktioner sættes til bynavnet for postnummeret
--      (som triggeren auctions_lokation_fra_postnummer gør for nye).
--      Afsluttede, annullerede og arkiverede auktioner (handelsdata) røres
--      aldrig. Idempotent.
--      Læse-forespørgsel til produktion FØR migrationen (kun select) - viser
--      de aktive auktioner, som opdateringen vil rette:
--        select a.id, a.status, a.postnummer, a.lokation,
--               p.bynavn as bynavn_for_postnummer, a.pauset_kl, a.skjult, a.slutter_kl
--          from public.auctions a
--          left join public.postnummer_koordinater p on p.postnummer = btrim(a.postnummer)
--         where a.status = 'aktiv'
--           and a.lokation is distinct from p.bynavn
--         order by a.slutter_kl;
--   4. Testblok: samme eksempler som tests/enhed/auktionKontaktinfoEksempler.ts.
--
-- Kendt rest: står ordet "ikea" i teksten, slipper et telefonnummer skrevet
-- i IKEA-formatet 3.3.2 ("IKEA 223.344.55") igennem, hvis der intet
-- kontaktord er.
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
-- 1. Drift-tjek - før noget ændres. Hver: før (170000) | efter denne fil.
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
  -- 20261102170000 skal være kørt.
  if to_regprocedure('public.auktion_kontaktinfo_afvis(boolean, text, text)') is null
     or to_regprocedure('public.auctions_lokation_fra_postnummer()') is null then
    raise exception 'Kør 20261102170000_kontaktinfo_rettelser.sql først.';
  end if;
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_grund(text, boolean)'::regprocedure);
  if v_md5 not in ('bd6ddb426cb4090fc5f8c410213ee74c', '4004eec6209fd3b66a105621a269afac') then
    raise exception 'auktion_kontaktinfo_grund er ikke udgaven fra 20261102170000 (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- Kroppen er den samme før og efter (kun volatiliteten ændres).
  v_md5 := pg_temp.krop_md5('public.auktion_kontaktinfo_afvis(boolean, text, text)'::regprocedure);
  if v_md5 <> 'b367746d6387dfd23d29586311ba77a3' then
    raise exception 'auktion_kontaktinfo_afvis er ændret uden for migrationerne (md5 %). Tjek den, før den erstattes.', v_md5;
  end if;
  -- Triggeren, som lokation-rettelsen bygger på (uændret af denne fil).
  v_md5 := pg_temp.krop_md5('public.auctions_lokation_fra_postnummer()'::regprocedure);
  if v_md5 <> '6c548c508313f437dfffff51ba6c3d5d' then
    raise exception 'auctions_lokation_fra_postnummer er ændret uden for migrationerne (md5 %). Tjek den først.', v_md5;
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
  g text;
  m text[];
  v_nr text;
  v_kontakt boolean;
  v_slut int;
  i int;
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
  -- Står et af disse ord i teksten (uden for et vareord), neutraliseres intet.
  p_kontaktord constant text :=
    '\m(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt'
    || '|skriv|skrive|skriver|besked|beskeden|beskeder|opkald|nummer|nummeret|nr'
    || '|whats\s*app|mvh|hilsen|mobile?\s*-?\s*pay|m-?pay|mp|swish|vipps'
    || '|konto[a-zæøå]*|bank[a-zæøå]*|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)\M';
  -- Et vareord: varenummer, art.nr., produktnr., reservedelsnr., delnr., SKU, EAN.
  -- "vare", "del", "art" osv. alene tæller ikke - kun med nr/nummer.
  p_vareord_ord constant text :=
    '\m(sku|ean|(vare|artikel|produkt|reservedel|del|art)s?e?\.?\s*(nr|nummer|nummeret))\M';
  -- Vareord + mindst 6 cifre/skilletegn uden mellemrum. Neutraliseres kun uden
  -- kontaktord - et nummer, der kan være et telefonnummer, er da allerede
  -- stoppet af p_maerkat.
  p_vareord constant text :=
    p_vareord_ord || '\.?[\s:#]*[0-9][0-9./-]{4,}[0-9](?![0-9])';
  -- Et vareord eller en anden mærkat + nummeret efter den (cifre med op til
  -- 3 mellemrum, punktummer, bindestreger eller skråstreger imellem).
  p_maerkat constant text :=
    '\m(sku|ean|imei|id|nr|nummer|nummeret|ref|reference|stregkode|art'
    || '|model[a-zæøå]*|ordre[a-zæøå]*|serie\s*nr|serienummer[a-zæøå]*|kunde\s*nr|kundenummer[a-zæøå]*'
    || '|faktura[a-zæøå]*|pakke[a-zæøå]*|varenummer[a-zæøå]*'
    || '|(vare|artikel|produkt|reservedel|del|art)s?e?\.?\s*(nr|nummer|nummeret))\M'
    || '[\s.:#]*((nr|nummer|nummeret)\M)?[\s.:#]*[0-9]([\s./-]{0,3}[0-9])*';
  -- Et telefonnummer: 8 cifre (første 2-9), evt. med 45 eller 0045 foran.
  p_tlf_cifre constant text := '^(0045|45)?[2-9][0-9]{7}$';
  -- IKEA-format: 402.638.47 (ikke en del af en længere cifferrække).
  p_ikea constant text := '(?<![0-9]\.?)[0-9]{3}\.[0-9]{3}\.[0-9]{2}(?!\.?[0-9])';
  -- Tekniske signalværdier: "Signal: analog", "Signal: 20 dB" (højst 4 cifre).
  p_signal constant text :=
    '\msignal\s*[:=]\s*(analog|digital|hdmi|dvb[a-z0-9-]*|wifi|bluetooth|stereo|mono|svagt|godt|stærkt'
    || '|[0-9]{1,4}\s*(db|mhz|ghz|hz))\M';
  -- 8 cifre (første 2-9) i en hvilken som helst gruppering (chatfilterets (d)).
  p_loes constant text :=
    '(?<![0-9][\s.,/-]{0,3})[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])';
  -- 45 / 0045 + 8 cifre uden + ("4522334455", "45 22 33 44 55").
  p_loes45 constant text :=
    '(?<![0-9][\s.,/-]{0,3})(0[\s./-]{0,3}0[\s./-]{0,3})?4[\s./-]{0,3}5[\s./-]{0,3}[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])';
begin
  if coalesce(btrim(p_tekst), '') = '' then
    return null;
  end if;
  v := public.besked_normaliser(p_tekst);
  -- URL-kodede tegn: %25 = % (først), %40 = @, %2e = ., %2f = /, %3a = :.
  v := replace(replace(replace(replace(replace(v, '%25', '%'), '%40', '@'), '%2e', '.'), '%2f', '/'), '%3a', ':');
  g := public.besked_spam_grund(v);
  -- E-mail tjekkes altid på hele teksten.
  if g = 'email' then
    return g;
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
    if v_nr !~ '^(19|20)[0-9]{2}[\s/-]+(19|20)[0-9]{2}$'
       and (regexp_replace(v_nr, '[^0-9]', '', 'g') ~ p_tlf_cifre
            or exists (select 1 from regexp_split_to_table(v_nr, '[\s./-]+') b
                        where b ~ p_tlf_cifre)) then
      return 'telefon';
    end if;
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

  -- 8 cifre i en hvilken som helst gruppering: chatfilteret på teksten frem
  -- til og med nummeret (så nummeret står sidst, som i chatten).
  i := 1;
  loop
    v_slut := regexp_instr(v, p_loes, 1, i, 1);
    exit when v_slut = 0;
    if public.besked_spam_grund(left(v, v_slut - 1)) = 'telefon' then
      return 'telefon';
    end if;
    i := i + 1;
  end loop;
  if v ~ p_loes45 then
    return 'telefon';
  end if;
  return null;
end;
$function$;

comment on function public.auktion_kontaktinfo_grund(text, boolean) is
  'Kontaktoplysninger i en auktions titel/beskrivelse: grund som besked_spam_grund eller null. 8 cifre stoppes altid (også efter et vareord). Firmaer (p_erhverv) må skrive links (kun værtsnavnet fjernes; 7+ cifre i et link, beskedtjenester, sociale medier, betalingsapps og linkforkortere stoppes). Varenumre med andre længder, IKEA-numre (kun med "ikea") og signalværdier (1-4 cifre) tæller ikke uden kontaktord. SPEJL: auktionKontaktGrund() i src/lib/auktionKontaktinfo.ts. 20261102190000.';

-- Ren funktion (ingen data). Appen må gerne kalde den for at advare i forvejen.
revoke all on function public.auktion_kontaktinfo_grund(text, boolean) from public, anon;
grant execute on function public.auktion_kontaktinfo_grund(text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Afvisningen: stable (kaster en fejl - ikke en ren værdi). Kroppen er
--    uændret fra 20261102170000.
-- ---------------------------------------------------------------------------
alter function public.auktion_kontaktinfo_afvis(boolean, text, text) stable;

-- Intern (uændret).
revoke all on function public.auktion_kontaktinfo_afvis(boolean, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. lokation på aktive auktioner = bynavnet for postnummeret
-- ---------------------------------------------------------------------------
-- Kun status 'aktiv' (offentligt synlige, igangværende auktioner). Afsluttede,
-- annullerede og arkiverede auktioner er handelsdata og røres aldrig. En
-- pauset auktion, der ikke er skjult, springes over, så auctions_pause_skjult
-- ikke genoptager den. Ukendt postnummer: null (visningen falder tilbage til
-- postnummeret). Idempotent: kun rækker, der afviger.
update public.auctions a
   set lokation = (select p.bynavn from public.postnummer_koordinater p
                    where p.postnummer = btrim(a.postnummer))
 where a.status = 'aktiv'
   and a.arkiveret_kl is null
   and (a.pauset_kl is null or coalesce(a.skjult, false))
   and a.lokation is distinct from (select p.bynavn from public.postnummer_koordinater p
                                     where p.postnummer = btrim(a.postnummer));

-- ---------------------------------------------------------------------------
-- 5. Testblok - samme liste som tests/enhed/auktionKontaktinfoEksempler.ts.
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
      ('Åben kl. 20.00-22.00 for afhentning', null, null)
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
  if v_n <> 114 then
    v_fejl := v_fejl || format(E'\n  forventet 114 eksempler, fik %s', v_n);
  end if;
  if public.auktion_kontaktinfo_grund(null, false) is not null
     or public.auktion_kontaktinfo_grund('   ', true) is not null then
    v_fejl := v_fejl || E'\n  tom tekst skulle give null';
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
    perform public.auktion_kontaktinfo_afvis(false, 'Spørgsmål? 223.344.55', null);
    v_fejl := v_fejl || E'\n  afvis(privat) kastede ikke';
  exception when sqlstate 'BHA08' then
    get stacked diagnostics v_besked = message_text, v_detail = pg_exception_detail;
    if v_besked !~ 'links i titlen' or v_detail::jsonb->>'grund' <> 'telefon' then
      v_fejl := v_fejl || format(E'\n  afvis(privat): %s / %s', v_besked, v_detail);
    end if;
  end;
  perform public.auktion_kontaktinfo_afvis(true, 'Sofa fra www.firma.dk', 'Varenummer 8027588');
  perform public.auktion_kontaktinfo_afvis(false, 'IKEA Billy reol 402.638.47', 'SKU 123456789');

  -- Volatilitet.
  if (select provolatile from pg_proc
       where oid = 'public.auktion_kontaktinfo_afvis(boolean, text, text)'::regprocedure) <> 's' then
    v_fejl := v_fejl || E'\n  auktion_kontaktinfo_afvis skal være stable';
  end if;

  -- lokation: ingen aktiv auktion (uden for en synlig pause) afviger.
  if exists (select 1 from public.auctions a
              where a.status = 'aktiv' and a.arkiveret_kl is null
                and (a.pauset_kl is null or coalesce(a.skjult, false))
                and a.lokation is distinct from (select p.bynavn from public.postnummer_koordinater p
                                                  where p.postnummer = btrim(a.postnummer))) then
    v_fejl := v_fejl || E'\n  aktive auktioner med forkert lokation';
  end if;

  if v_fejl <> '' then
    raise exception 'Kontaktinfo-filteret til auktioner fejlede:%', v_fejl;
  end if;
end
$test$;
