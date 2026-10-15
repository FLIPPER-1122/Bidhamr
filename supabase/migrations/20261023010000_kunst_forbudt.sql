-- =============================================================================
-- Kunst er forbudt (Filip, 14. okt. 2026 - ROADMAP-BESLUTNINGER.md, "Kunst er
-- forbudt"; advokat-spørgsmål 135-137).
--
-- Forbudt: malerier, tegninger, skulpturer, grafiske tryk og litografier (også
-- signerede og nummererede) og kunst, sælgeren selv har lavet. Tilladt:
-- plakater og masseproducerede billeder uden kunstner/værdi (fx IKEA).
-- Uafklaret (designerkeramik/-glas og antikviteter) forbydes IKKE her - de
-- står slået fra i src/lib/kunstForbud.ts (KUNST_UAFKLAREDE).
--
-- Valg (forklaret for chefen): kunst MARKERES og sendes til staff-tjek som en
-- automatisk anmeldelse - auktionen blokeres og skjules ikke ved oprettelse.
-- Det er samme flow som "tvivl"-varerne (billetter, alkohol), og det knækker
-- ikke appens insert. At skjule auktionen fra start ville ramme pause-reglerne
-- for skjulte auktioner (uret stopper, 14-dages annullering, DSA-afgørelse
-- med mail til sælgeren) uden at nogen medarbejder har truffet en afgørelse.
--
-- 1. auctions.kunst_bekraeftet (sælgerens "Det er ikke kunst" ved oprettelse;
--    kan ikke ændres bagefter af brugeren) og auctions.kunst_markeret_kl
--    (sættes KUN af databasen, første gang titel/beskrivelse ligner kunst;
--    nulstilles aldrig - bruges til at tælle gentagne forsøg). Ingen af dem
--    kan læses af anon/authenticated (kolonne-grants på auctions).
-- 2. Ordlisten: kunst_ord(), kunst_fjern() og kunst_tekst_tjek(). HOLD
--    SYNKRON med src/lib/kunstForbud.ts (testen tests/enhed/kunstForbud.test.ts
--    sammenligner). Normaliseringen genbruger forbudt_normaliser().
-- 3. Triggere på auctions: auctions_kunst_kontrol (BEFORE: markering) og
--    auctions_kunst_rapport (AFTER: automatisk anmeldelse til staff med
--    category 'kunst', højst én åben pr. auktion). Ved oprettelse altid (også
--    service_role, fx "sæt varen op igen"); ved rettelse kun brugerens egne
--    rettelser (authenticated) - som forbudte varer.
-- 4. reports.category og dsa_anmeldelser.kategori får 'kunst';
--    dsa_anmeldelse_opret godtager 'kunst' (brugere kan anmelde kunst).
-- 5. dsa_regler() får reglen 'kunst' ("Kunst er ikke tilladt").
-- 6. forbudte_varer() får kategorien 'kunst' (vises på /forbudte-varer).
-- 7. Ingen kategori må hedde noget med kunst. Der findes ingen i dag
--    (auktion_kategorier() i prod og test, 15. okt. 2026, og ingen auktioner
--    med en kunst-kategori) - DO-blokken nederst stopper migrationen, hvis
--    der kommer en.
--
-- Appen (Expo): INGEN nye krav for at oprette en auktion. Sender appen ikke
-- kunst_bekraeftet, er den false, og auktionen bliver stadig oprettet og
-- markeret. Appen bør (ROADMAP fase 5) vise samme advarsel og sende
-- kunst_bekraeftet: true, når sælgeren trykker "Det er ikke kunst".
--
-- Kan køres flere gange (if not exists, create or replace, flettede checks,
-- md5-drift-tjek). Én transaktion. md5 = normaliseret krop (CR og
-- kommentarer fjernet, al whitespace fjernet, små bogstaver) som
-- 20261020020000. "gammel" = prod og test før denne migration (hentet med
-- SELECT 15. okt. 2026), "ny" = efter. Andet afbryder migrationen.
-- Køres først på testdatabasen (pjiigmzqwlfepxnjdvug). Produktion kræver
-- Filips "ja".
-- =============================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Hjælpere (midlertidige - droppes nederst)
-- ---------------------------------------------------------------------------

-- Flet nye værdier ind i en check-constraint (som 20261020010000).
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
      union
      select unnest(p_nye)
    ) s where x <> '' order by 1);
  execute format('alter table %s drop constraint if exists %I', p_tabel, p_navn);
  execute format('alter table %s add constraint %I check (%I = any (%L::text[]))',
                 p_tabel, p_navn, p_kolonne, v_vals);
end $$;

create or replace function pg_temp.krop_md5(p_fn text)
returns text language sql stable as $f$
  select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\n]*', '', 'g'), '\s', '', 'g')))
    from pg_proc p where p.oid = to_regprocedure(p_fn);
$f$;

-- Drift-tjek før en funktion erstattes helt: md5 skal være gammel eller ny.
create or replace function pg_temp.drift_tjek(p_fn text, p_gammel text, p_ny text)
returns void language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if h is distinct from p_gammel and h is distinct from p_ny then
    raise exception '%: md5 % er hverken gammel eller ny - kontrollér funktionen, før migrationen køres', p_fn, h;
  end if;
end $f$;

create or replace function pg_temp.efter_tjek(p_fn text, p_ny text)
returns void language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is distinct from p_ny then
    raise exception '%: efter migrationen er md5 % (forventet %)', p_fn, h, p_ny;
  end if;
end $f$;

-- Retter en funktion på stedet (som 20261020020000): md5 før (gammel) eller
-- allerede rettet (ny); hvert mønster skal findes præcis det forventede antal
-- gange; md5 bagefter skal være "ny".
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

-- Drift-tjek af de eksisterende funktioner, der ændres - FØR noget ændres.
select pg_temp.drift_tjek('public.forbudte_varer()', '26f66c209eafd8851d51bc524a5771bc', '2ffa99d5dbcb0dc6d559a77d22047963');
select pg_temp.drift_tjek('public.dsa_regler()', '3c089e00118b314b50a3b2fcdc988c8d', '020c8c1d1a545e9588430c1b2898721f');
select pg_temp.drift_tjek('public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)',
                          '10671a6ecac0d9faaae0518587047ff9', 'ab9150038013a607a91e708f57252322');

-- ---------------------------------------------------------------------------
-- 1. Kolonner på auctions
-- ---------------------------------------------------------------------------
alter table public.auctions
  add column if not exists kunst_bekraeftet boolean not null default false,
  add column if not exists kunst_markeret_kl timestamptz;

comment on column public.auctions.kunst_bekraeftet is
  'Sælgerens "Det er ikke kunst" ved oprettelse (kun når teksten lignede kunst). Kan ikke ændres af brugeren bagefter. Ses kun af staff.';
comment on column public.auctions.kunst_markeret_kl is
  'Sat af databasen (auctions_kunst_kontrol), første gang titel/beskrivelse lignede kunst. Nulstilles aldrig - bruges til at tælle gentagne forsøg. Ses kun af staff.';

-- Kun staff (service_role) læser kolonnerne. auctions har kolonne-grants
-- (20261010061000), så nye kolonner er ikke synlige for anon/authenticated -
-- det gøres eksplicit her, hvis nogen har givet dem senere.
revoke select (kunst_bekraeftet, kunst_markeret_kl) on public.auctions from anon, authenticated;

create index if not exists auctions_kunst_markeret_idx
  on public.auctions (bruger_id) where kunst_markeret_kl is not null;

-- ---------------------------------------------------------------------------
-- 2. Ordlisten (HOLD SYNKRON med src/lib/kunstForbud.ts)
-- ---------------------------------------------------------------------------

-- Udfoldede mønstre i samme rækkefølge som KUNST_REGLER (nr = rækkefølgen).
create or replace function public.kunst_ord()
returns table (nr integer, moenster text, kraever text, undtagen text)
language sql
immutable
set search_path = public
as $fn$
  select v.nr, v.moenster, v.kraever, v.undtagen
    from (values
      -- KUNST_ORD_START
      (1, '[a-zæøå]*maleri(et|er|erne)?', null, null),
      (2, '(kunstv(æ|ae)rk(et|er|erne)?|originalv(æ|ae)rk(et|er|erne)?|original(t|e)? v(æ|ae)rk(et|er)?)', null, null),
      (3, '(kunst|v(æ|ae)gkunst|billedkunst|fotokunst|kunstfoto|kunstfotografi|kunstgrafik|kunsttryk)', null, null),
      (4, '(kunstner(e|en|ens|ne|nes)?|kunstmaler(e|en|ens|ne|nes)?|kunstnersigneret|kunstnersignatur)', null, '(cd|cder|vinyl|lp|lper|album|plade|plader|single|kassette|koncert|koncerter|musik|musiker|sang|sanger|sangerinde|band|rapper|festival|(plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet))'),
      (5, 'l(æ|ae)rred(et|er|erne)?', '(olie|akryl|akvarel|gouache|malet|malede|h(å|aa)ndmalet|h(å|aa)ndmalede|kunstner|kunstneren|signeret|signerede|signatur|original|originalt|originalv(æ|ae)rk|unika)', '(projektor|projektorl(æ|ae)rred|l(æ|ae)rredssk(æ|ae)rm|blank|blankt|blanke|ubrugt|ubrugte)'),
      (6, '(akvarel(len|ler|lerne)?|gouache(r|n)?)', null, null),
      (7, '(litografi(en|er|erne)?|serigrafi(en|er|erne)?|radering(en|er|erne)?|tr(æ|ae)snit(tet|ter|terne)?|linoleumssnit(tet|ter)?|linoleumsnit(tet|ter)?|linosnit(tet|ter)?|kobberstik(ket|ker|kene)?|st(å|aa)lstik(ket|ker)?|xylografi(en|er)?|akvatinta|mezzotinte|giclee|gicl(é|e)e|grafisk(e)? (tryk|blad|blade|v(æ|ae)rk|v(æ|ae)rker))', null, null),
      (8, 'grafik(ken|ker|kerne)?', '(signeret|signerede|signatur|nummereret|nummererede|original|originalt|kunstner|kunstneren|indrammet|indrammede|tryk|blad|oplag|(æ|ae)tsning)', '(t shirt|tshirt|tr(ø|oe)je|t(ø|oe)j|h(æ|ae)ttetr(ø|oe)je|hoodie|spil|gaming)'),
      (9, '(signere(t|de)|nummerere(t|de))', '(tryk|trykket|oplag|eksemplar|eksemplarer)', null),
      (10, '[a-zæøå]*skulptur(en|er|erne)?', null, null),
      (11, '(buste(n|r|rne)?|byste(n|r|rne)?)', null, '(sy|syning|skr(æ|ae)dder|syerbuste|skr(æ|ae)dderbuste|t(ø|oe)j|kjole|kjoler|bluse|top|mannequin|mannequindukke|udstillingsdukke|smykke|smykker|halsk(æ|ae)de|halsk(æ|ae)der|paryk|parykker|bh|undert(ø|oe)j|str|st(ø|oe)rrelse|cm|m(å|aa)l|vidde|justerbar)'),
      (12, '((bronze|bronce|marmor) ?(figur|figuren|figurer|statue|statuen|statuer|statuette|statuetter|relief)|(figur|figuren|figurer|statue|statuen|statuer|statuette|statuetter|relief) (i|af|udf(ø|oe)rt i|st(ø|oe)bt i) (bronze|bronce|marmor))', null, null),
      (13, 'tegning(en|er|erne)?', null, '(teknisk|tekniske|samlevejledning|vejledning|monteringsvejledning|manual|m(ø|oe)nster|m(ø|oe)nstre|strikkem(ø|oe)nster|symønster|sym(ø|oe)nster|byggetegning|plantegning|tegneserie|tegneserier|tegnefilm)'),
      (14, '(selvmalet|selvmalede|selvtegnet|selvtegnede)', '(billede|billeder|l(æ|ae)rred|motiv|portr(æ|ae)t|ramme|indrammet)', null),
      (15, '((olie|akryl|akvarel|gouache|tempera) p(å|aa) (l(æ|ae)rred|plade|tr(æ|ae)|pap|papir)|(blyant|kul|tusch|bl(æ|ae)k|pastel|pastelkridt|rødkridt) p(å|aa) papir)', null, null),
      (16, '(painting|paintings|oil painting|artwork|artworks|sculpture|sculptures|lithograph|lithographs|etching|etchings|watercolou?r|watercolou?rs|art print|signed print)', null, null)
      -- KUNST_ORD_SLUT
    ) as v(nr, moenster, kraever, undtagen)
   order by v.nr;
$fn$;

-- Tilladte fraser, der fjernes før reglerne tjekkes (KUNST_FJERN).
create or replace function public.kunst_fjern()
returns text
language sql
immutable
set search_path = public
as $fn$
  select '(kunst (l(æ|ae)der|gr(æ|ae)s|stof|stoffer|pels|blomst|blomster|plante|planter|silke|ruskind|negle|juletr(æ|ae)|sk(ø|oe)jtel(ø|oe)b|harpiks|is)|(akvarel|gouache|akryl|olie|pastel|kunstner|kunstmaler|tegne) (farve|farver|farvers(æ|ae)t|maling|pensel|pensler|papir|blok|blokke|s(æ|ae)t|kasse|kasser|(æ|ae)ske|(æ|ae)sker|kursus|kurser|staffeli|staffelier|ler|v(æ|ae)rkt(ø|oe)j|tape|lak|spartel|paletkniv|palet|paletter|udstyr|grej|artikler|forsyninger)|(maleri|kunst|tegning|skulptur|grafik) (kursus|kurser|artikler|udstyr|grej|forsyninger|v(æ|ae)rkt(ø|oe)j)|((farve|farver|farvers(æ|ae)t|maling|pensel|pensler|papir|blok|blokke|s(æ|ae)t|kasse|kasser|(æ|ae)ske|(æ|ae)sker|kursus|kurser|staffeli|staffelier|ler|v(æ|ae)rkt(ø|oe)j|tape|lak|spartel|paletkniv|palet|paletter|udstyr|grej|artikler|forsyninger)|(ramme|rammer|billedramme|billedrammer|lampe|lamper|oph(æ|ae)ng|krog|kroge|lys|l(æ|ae)rred|l(æ|ae)rreder|transportkasse)) (til|for) (et |en |dit |din |mit |min |dine |mine |de )?(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|(bog|b(ø|oe)ger|bogen|b(ø|oe)rnebog|b(ø|oe)rneb(ø|oe)ger|billedbog|billedb(ø|oe)ger|malebog|maleb(ø|oe)ger|dvd|film|filmen|leksikon|katalog|kataloger|udstillingskatalog|tidsskrift|blad|blade|magasin|foredrag|kursus|kurser|puslespil|kort|postkort|kalender|plakatbog) (om|med|af|fra) (et |en |de |det |den )?(kendte |kendt |berømte |berømt |danske |dansk |moderne |gamle )?(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|(plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet) (af|med|fra|efter) (et |en |det |den )?(kendte |kendt |berømte |berømt )?(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst) (plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet)|(ikea|jysk|bilka|s(ø|oe)strene grene|imerco|kop og kande|kop & kande|ilva|bolia|h&m home|zara home|normal|flying tiger|tiger|jem og fix|jem & fix|harald nyborg|silvan|bauhaus|desenio|poster store) ((maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|billede|billeder|v(æ|ae)gbillede|v(æ|ae)gbilleder)|((maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|billede|billeder) (fra|k(ø|oe)bt i|k(ø|oe)bt hos|k(ø|oe)bt p(å|aa)) (ikea|jysk|bilka|s(ø|oe)strene grene|imerco|kop og kande|kop & kande|ilva|bolia|h&m home|zara home|normal|flying tiger|tiger|jem og fix|jem & fix|harald nyborg|silvan|bauhaus|desenio|poster store))'::text;
$fn$;

-- {"resultat": "ok"} eller {"resultat": "kunst", "ord", "nr"}. Samme logik
-- som tjekKunstTekst i TypeScript: normalisér, fjern tilladte fraser (første
-- forekomst ad gangen, højst 50 gange), og tjek reglerne som hele ord.
-- kraever og undtagen tjekkes mod hele teksten.
create or replace function public.kunst_tekst_tjek(p_tekst text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
declare
  g       constant text := '[^a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß]';
  v_norm  text := public.forbudt_normaliser(p_tekst);
  v_tekst text;
  v_re    text;
  o       record;
  m       text[];
begin
  if v_norm = '' then
    return jsonb_build_object('resultat', 'ok');
  end if;
  v_tekst := v_norm;
  v_re := '(^|' || g || ')(' || public.kunst_fjern() || ')($|' || g || ')';
  for i in 1..50 loop
    exit when v_tekst !~ v_re;
    v_tekst := regexp_replace(v_tekst, v_re, ' ');
  end loop;
  for o in select * from public.kunst_ord() k order by k.nr loop
    m := regexp_match(v_tekst, '(^|' || g || ')(' || o.moenster || ')($|' || g || ')');
    if m is null then continue; end if;
    if o.kraever is not null
       and v_norm !~ ('(^|' || g || ')(' || o.kraever || ')($|' || g || ')') then
      continue;
    end if;
    if o.undtagen is not null
       and v_norm ~ ('(^|' || g || ')(' || o.undtagen || ')($|' || g || ')') then
      continue;
    end if;
    return jsonb_build_object('resultat', 'kunst', 'ord', m[2], 'nr', o.nr);
  end loop;
  return jsonb_build_object('resultat', 'ok');
end;
$fn$;

-- Rene funktioner uden dataadgang - appen må gerne tjekke på forhånd.
revoke all on function public.kunst_ord() from public;
revoke all on function public.kunst_fjern() from public;
revoke all on function public.kunst_tekst_tjek(text) from public;
grant execute on function public.kunst_ord()             to anon, authenticated, service_role;
grant execute on function public.kunst_fjern()           to anon, authenticated, service_role;
grant execute on function public.kunst_tekst_tjek(text)  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Triggere på auctions
-- ---------------------------------------------------------------------------

-- BEFORE: markeringen. kunst_markeret_kl sættes kun her (brugerens værdi
-- ignoreres altid). kunst_bekraeftet hører til oprettelsen og kan ikke
-- ændres af brugeren bagefter (som forbudt_bekraeftet).
create or replace function public.auctions_kunst_kontrol()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v jsonb;
begin
  if tg_op = 'INSERT' then
    new.kunst_bekraeftet := coalesce(new.kunst_bekraeftet, false);
    v := public.kunst_tekst_tjek(coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, ''));
    new.kunst_markeret_kl := case when v->>'resultat' = 'kunst' then now() end;
    return new;
  end if;

  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.kunst_bekraeftet := old.kunst_bekraeftet;
  end if;
  new.kunst_bekraeftet := coalesce(new.kunst_bekraeftet, old.kunst_bekraeftet, false);
  new.kunst_markeret_kl := old.kunst_markeret_kl;
  if old.kunst_markeret_kl is null
     and (new.titel is distinct from old.titel or new.beskrivelse is distinct from old.beskrivelse) then
    v := public.kunst_tekst_tjek(coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, ''));
    if v->>'resultat' = 'kunst' then
      new.kunst_markeret_kl := now();
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function public.auctions_kunst_kontrol() from public, anon, authenticated;

drop trigger if exists auctions_kunst_kontrol on public.auctions;
create trigger auctions_kunst_kontrol
  before insert or update on public.auctions
  for each row execute function public.auctions_kunst_kontrol();

-- AFTER: automatisk anmeldelse til staff (Admin -> Anmeldelser), højst én
-- åben pr. auktion. Fejler den, oprettes/rettes auktionen alligevel (advarsel
-- i loggen) - som auctions_forbudt_rapport.
create or replace function public.auctions_kunst_rapport()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v       jsonb;
  v_antal integer;
begin
  if tg_op = 'UPDATE' then
    if coalesce(auth.role(), '') <> 'authenticated' then
      return null;
    end if;
    if new.titel is not distinct from old.titel
       and new.beskrivelse is not distinct from old.beskrivelse then
      return null;
    end if;
  end if;

  v := public.kunst_tekst_tjek(coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, ''));
  if v->>'resultat' is distinct from 'kunst' then
    return null;
  end if;

  begin
    if exists (select 1 from public.reports r
                where r.auction_id = new.id
                  and r.category = 'kunst'
                  and r.status in ('pending', 'under_behandling')) then
      return null;
    end if;

    -- Gentagne forsøg: andre auktioner fra samme sælger, der har lignet kunst.
    select count(*) into v_antal
      from public.auctions a
     where a.bruger_id = new.bruger_id
       and a.id <> new.id
       and a.kunst_markeret_kl is not null;

    insert into public.reports (auction_id, reporter_id, category, description, status, created_at)
    values (new.id, public.bidhamr_system_id(), 'kunst',
            left(concat_ws(' ',
              format('Kontrol: muligvis kunst. Ordet "%s" står i %s.', v->>'ord',
                     case when tg_op = 'INSERT' then 'titlen eller beskrivelsen'
                          else 'den rettede titel eller beskrivelse' end),
              case when tg_op = 'INSERT' and new.kunst_bekraeftet
                     then 'Sælgeren har bekræftet "Det er ikke kunst".'
                   when tg_op = 'INSERT'
                     then 'Sælgeren har ikke bekræftet, at det ikke er kunst (fx oprettet fra appen).' end,
              case when v_antal > 0
                     then format('Sælgeren har %s andre auktioner, der har lignet kunst – overvej en advarsel.', v_antal) end,
              'Auktionen er oprettet – vurdér, om den skal skjules eller fjernes.'), 1000),
            'pending', now());
  exception when others then
    raise warning 'auctions_kunst_rapport: anmeldelse kunne ikke oprettes for %: %', new.id, sqlerrm;
  end;
  return null;
end;
$fn$;

revoke all on function public.auctions_kunst_rapport() from public, anon, authenticated;

drop trigger if exists auctions_kunst_rapport on public.auctions;
create trigger auctions_kunst_rapport
  after insert or update of titel, beskrivelse on public.auctions
  for each row execute function public.auctions_kunst_rapport();

-- ---------------------------------------------------------------------------
-- 4. Kategorier på anmeldelser
-- ---------------------------------------------------------------------------
select pg_temp.flet_check('public.reports'::regclass, 'reports_category_check', 'category', array['kunst']);
select pg_temp.flet_check('public.dsa_anmeldelser'::regclass, 'dsa_anmeldelser_kategori_check', 'kategori', array['kunst']);

do $do$
begin
  raise notice 'dsa_anmeldelse_opret: %', pg_temp.ps_ret(
    'public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)',
    '10671a6ecac0d9faaae0518587047ff9',
    'ab9150038013a607a91e708f57252322',
    jsonb_build_array(jsonb_build_array(
      $g$'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'andet') then$g$,
      $n$'hadefuld_tale', 'misbrug_boern', 'vilkaar', 'kunst', 'andet') then$n$,
      1)));
end $do$;

-- ---------------------------------------------------------------------------
-- 5. Regel for indgreb: "Kunst er ikke tilladt" (spejl af DSA_REGLER i
--    src/lib/dsa/regler.ts). Som 20261009030000 + 'kunst'.
-- ---------------------------------------------------------------------------
create or replace function public.dsa_regler()
returns table (kode text, navn text, grundlag text, henvisning text)
language sql
immutable
set search_path = ''
as $fn$
  select * from (values
    ('forbudt_vare',            'Varen må ikke sælges på BidHamr',                    'vilkaar', 'BidHamrs regler om forbudte varer, se bidhamr.dk/forbudte-varer'),
    ('kunst',                   'Kunst er ikke tilladt',                              'vilkaar', 'BidHamrs regler om forbudte varer: kunst må ikke sælges, se bidhamr.dk/forbudte-varer'),
    ('ulovlig_vare',            'Varen er ulovlig at sælge',                          'lov',     'Dansk lovgivning, fx våbenloven, lov om euforiserende stoffer og dyrevelfærdsloven'),
    ('falsk_vare',              'Kopivare eller krænkelse af et varemærke',           'lov',     'Varemærkeloven'),
    ('ophavsret',               'Krænkelse af ophavsret (fx kopierede billeder)',     'lov',     'Ophavsretsloven'),
    ('svindel',                 'Svindel eller vildledning',                          'lov',     'Straffeloven § 279 og BidHamrs regler'),
    ('personoplysninger',       'Deling af andres personoplysninger',                 'lov',     'Databeskyttelsesforordningen (GDPR)'),
    ('hadefuld_tale',           'Hadefuld eller truende tale',                        'lov',     'Straffeloven §§ 266 og 266 b'),
    ('misbrug_boern',           'Seksuelt misbrug af børn',                           'lov',     'Straffeloven § 235'),
    ('chikane',                 'Grove ord eller chikane',                            'vilkaar', 'BidHamrs regler for god opførsel'),
    ('kontaktinfo',             'Kontaktoplysninger eller handel uden om BidHamr',    'vilkaar', 'BidHamrs regler for handel på BidHamr'),
    ('ikke_relateret',          'Indholdet handler ikke om handlen',                  'vilkaar', 'BidHamrs regler for bedømmelser og spørgsmål'),
    ('spam',                    'Spam eller reklame',                                 'vilkaar', 'BidHamrs regler for god opførsel'),
    ('gentagne_overtraedelser', 'Gentagne overtrædelser (3 advarsler)',               'vilkaar', 'BidHamrs regler om advarsler'),
    ('andet',                   'Andet brud på BidHamrs regler',                      'vilkaar', 'BidHamrs regler')
  ) as r(kode, navn, grundlag, henvisning);
$fn$;

revoke all on function public.dsa_regler() from public, anon, authenticated;
grant execute on function public.dsa_regler() to service_role;

-- ---------------------------------------------------------------------------
-- 6. Kategorien på /forbudte-varer (spejl af FORBUDTE_KATEGORIER i
--    src/lib/forbudteVarer.ts). Som 20261006042000 + 'kunst'.
-- ---------------------------------------------------------------------------
create or replace function public.forbudte_varer()
returns table (nr integer, kode text, navn text, beskrivelse text)
language sql
immutable
set search_path = public
as $fn$
  select * from (values
    (1, 'vaaben', 'Våben og ammunition', 'Skydevåben (også luftvåben), dele til skydevåben, ammunition og krudt, springknive, butterflyknive, knojern, peberspray, strømpistoler og andre våben, der kræver tilladelse eller er forbudte i Danmark. Auktioner med softguns, armbrøster og våbentilbehør bliver kontrolleret af BidHamr.'),
    (2, 'narkotika', 'Narkotika', 'Euforiserende stoffer af enhver art – også udstyr, frø og planter, der er beregnet til at fremstille eller bruge dem.'),
    (3, 'medicin', 'Medicin og doping', 'Receptpligtig medicin, håndkøbsmedicin, doping og anabolske steroider. Medicin må kun sælges af apoteker og godkendte forhandlere.'),
    (4, 'levende_dyr', 'Levende dyr', 'Levende dyr må ikke sælges på BidHamr, fx hvalpe, killinger, kaniner, fugle, fisk og krybdyr. Tilbehør som bure, foder og akvarier må gerne sælges.'),
    (5, 'forfalskninger', 'Forfalskninger og kopivarer', 'Falske mærkevarer (fx en falsk Rolex), falske dokumenter, pas, ID-kort, kørekort, pengesedler og andet, der udgiver sig for at være ægte. Auktioner med kopier og replikaer bliver kontrolleret af BidHamr.'),
    (6, 'tobak_alkohol', 'Tobak og alkohol', 'Snus (forbudt at sælge i Danmark). Tobak, e-cigaretter og alkohol må aldrig sælges til personer under 18 år, og auktioner med dem bliver kontrolleret af BidHamr.'),
    (7, 'stjaalne', 'Stjålne varer', 'Stjålne varer og hælervarer – også varer, du har mistanke om er stjålet.'),
    (8, 'voksenindhold', 'Voksenindhold', 'Pornografi og andet seksuelt indhold, herunder brugt undertøj solgt som voksenindhold.'),
    (9, 'kemikalier', 'Farlige kemikalier og sprængstoffer', 'Sprængstoffer, fyrværkeri, giftige og ætsende kemikalier, kviksølv og asbest.'),
    (10, 'persondata', 'Personlige data og konti', 'CPR-numre, kortoplysninger, kundelister, MitID/NemID og login til brugerkonti – dine egne eller andres.'),
    (11, 'billetter', 'Billetter med videresalgsforbud', 'Billetter, som arrangøren ikke tillader videresalg af, og billetter solgt til mere end den oprindelige pris (billetloven). Alle auktioner med billetter bliver kontrolleret af BidHamr.'),
    (12, 'kunst', 'Kunst', 'Malerier, tegninger, skulpturer, grafiske tryk og litografier – også signerede og nummererede – og kunst, du selv har lavet. Plakater og masseproducerede billeder uden kunstner, fx fra IKEA, må gerne sælges. Auktioner, der ligner kunst, bliver kontrolleret af BidHamr.')
  ) as v(nr, kode, navn, beskrivelse);
$fn$;

grant execute on function public.forbudte_varer() to anon, authenticated, service_role;

select pg_temp.efter_tjek('public.forbudte_varer()', '2ffa99d5dbcb0dc6d559a77d22047963');
select pg_temp.efter_tjek('public.dsa_regler()', '020c8c1d1a545e9588430c1b2898721f');
select pg_temp.efter_tjek('public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)', 'ab9150038013a607a91e708f57252322');

-- ---------------------------------------------------------------------------
-- 7. Ingen kunst-kategori + test af ordlisten
-- ---------------------------------------------------------------------------

-- Ingen kategori må hedde noget med kunst. Findes der en, skal den fjernes
-- fra auktion_kategorier() (auktionerne beholder deres kategori - intet
-- slettes), før migrationen køres.
do $do$
begin
  if exists (select 1 from public.auktion_kategorier() k where k::text ilike '%kunst%') then
    raise exception 'auktion_kategorier() indeholder en kunst-kategori - fjern den, så den ikke kan vælges';
  end if;
end $do$;

-- Fejler migrationen, hvis et eksempel giver et andet resultat end
-- forventet. Samme eksempler som tests/enhed/kunstEksempler.ts.
do $do$
declare
  t      record;
  r      text;
  v_fejl text := '';
begin
  for t in select * from (values
    ('Oliemaleri', 'kunst'),
    ('Maleri af Per Kirkeby', 'kunst'),
    ('Malerier sælges', 'kunst'),
    ('Stort abstrakt akrylmaleri', 'kunst'),
    ('Landskabsmaleri i guldramme', 'kunst'),
    ('Olie-maleri af skib', 'kunst'),
    ('Akvarel af fyrtårn', 'kunst'),
    ('Olie på lærred 60x80', 'kunst'),
    ('Lærred malet med akryl', 'kunst'),
    ('Signeret lærred', 'kunst'),
    ('Litografi signeret og nummereret', 'kunst'),
    ('Serigrafi 23/100', 'kunst'),
    ('Radering af Rembrandt', 'kunst'),
    ('Træsnit', 'kunst'),
    ('Traesnit fra 1920', 'kunst'),
    ('Kobberstik indrammet', 'kunst'),
    ('Signeret og nummereret tryk', 'kunst'),
    ('Indrammet grafik af Asger Jorn', 'kunst'),
    ('Grafisk tryk', 'kunst'),
    ('Bronzefigur', 'kunst'),
    ('Bronze-figur af hest', 'kunst'),
    ('Figur i bronze', 'kunst'),
    ('Skulptur i træ', 'kunst'),
    ('Bronzeskulptur', 'kunst'),
    ('Buste af H.C. Andersen', 'kunst'),
    ('Tegning af Storm P', 'kunst'),
    ('Tegninger af Ib Spang Olsen', 'kunst'),
    ('Originalt værk', 'kunst'),
    ('Original værk af kendt kunstner', 'kunst'),
    ('Kunstværk til salg', 'kunst'),
    ('Kunstvaerk', 'kunst'),
    ('Moderne kunst', 'kunst'),
    ('Vægkunst', 'kunst'),
    ('Kunsttryk', 'kunst'),
    ('Kunstner: Asger Jorn', 'kunst'),
    ('Selvmalet billede på lærred', 'kunst'),
    ('Gouache', 'kunst'),
    ('Blyant på papir, portræt', 'kunst'),
    ('Oil painting', 'kunst'),
    ('Signed print', 'kunst'),
    ('Maleri, ikke en plakat', 'kunst'),
    ('Maleri med ramme', 'kunst'),
    ('Olie på lærred, ramme medfølger', 'kunst'),
    ('Maleritape', 'ok'),
    ('Malerpensel', 'ok'),
    ('Malerpensler 3 stk', 'ok'),
    ('Malerrulle og bakke', 'ok'),
    ('Plakat', 'ok'),
    ('Plakat af Monet', 'ok'),
    ('Monet plakat i ramme', 'ok'),
    ('Plakat af maleri', 'ok'),
    ('Maleri plakat 50x70', 'ok'),
    ('IKEA-billede', 'ok'),
    ('IKEA billede på lærred', 'ok'),
    ('Lærred billede fra IKEA', 'ok'),
    ('Maleri fra IKEA', 'ok'),
    ('Billede på lærred med New York', 'ok'),
    ('Tegneblok A4', 'ok'),
    ('Tegnebræt', 'ok'),
    ('Kunstlæder sofa', 'ok'),
    ('Kunst læder jakke', 'ok'),
    ('Kunstgræs 20 m2', 'ok'),
    ('Kunststof havemøbler', 'ok'),
    ('Grafikkort RTX 3080', 'ok'),
    ('PS5 med flot grafik', 'ok'),
    ('T-shirt med grafik tryk', 'ok'),
    ('Projektor lærred 100 tommer', 'ok'),
    ('Akvarel farver 24 stk', 'ok'),
    ('Akvarel papir', 'ok'),
    ('Gouache maling', 'ok'),
    ('Kunstner pensler', 'ok'),
    ('Billedramme til maleri 50x70', 'ok'),
    ('Lærred til maleri, blankt', 'ok'),
    ('Staffeli til maleri', 'ok'),
    ('Bog om danske malerier', 'ok'),
    ('Børnebog med tegninger', 'ok'),
    ('Kjole str 38, buste 90 cm', 'ok'),
    ('Syerbuste justerbar', 'ok'),
    ('Signeret fodboldtrøje nr 10', 'ok'),
    ('Signeret LP af kunstneren', 'ok'),
    ('Tegneserie Anders And', 'ok'),
    ('Samlevejledning med tegning', 'ok'),
    ('Malet kommode', 'ok'),
    ('Selvmalet kommode', 'ok'),
    ('Maling til træ', 'ok'),
    ('Kunsten at elske, bog', 'ok'),
    ('Skulpturel lampe', 'ok'),
    ('Royal Copenhagen musselmalet', 'ok'),
    ('Holmegaard vase', 'ok'),
    ('Antik kommode', 'ok'),
    ('Sofabord i eg', 'ok'),
    ('iPhone 13', 'ok'),
    ('', 'ok')
  ) as x(tekst, forventet)
  loop
    r := public.kunst_tekst_tjek(t.tekst)->>'resultat';
    if r is distinct from t.forventet then
      v_fejl := v_fejl || format(E'\n  %s: forventet %s, fik %s', t.tekst, t.forventet, r);
    end if;
  end loop;
  if v_fejl <> '' then
    raise exception 'Kunst-ordlisten giver forkerte resultater:%', v_fejl;
  end if;
end $do$;

drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.efter_tjek(text, text);
drop function pg_temp.drift_tjek(text, text, text);
drop function pg_temp.krop_md5(text);
drop function pg_temp.flet_check(regclass, text, text, text[]);

commit;
