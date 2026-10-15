-- =============================================================================
-- Kunst er forbudt (Filip, 14. okt. 2026 - ROADMAP-BESLUTNINGER.md, "Kunst er
-- forbudt"; advokat-spørgsmål 135-137) + brugerbetingelser version 0.2.
--
-- Forbudt: malerier, tegninger, skulpturer, grafiske tryk og litografier (også
-- signerede og nummererede) og kunst, sælgeren selv har lavet. Tilladt:
-- plakater og masseproducerede billeder uden kunstner/værdi (fx IKEA).
-- Uafklaret (designerkeramik/-glas og antikviteter) forbydes IKKE her - de
-- står slået fra i src/lib/kunstForbud.ts (KUNST_UAFKLAREDE).
--
-- Flow (efter review 15. okt. 2026 - "strengt forbudt"): ligner titel eller
-- beskrivelse kunst, oprettes auktionen stadig (appens insert virker), men
-- den sættes til staff-tjek: auctions.kunst_kontrol = 'afventer'. Så længe:
--   - kan kun sælgeren, staff og deltagere se den (RLS-select-policyerne på
--     auctions - virker også i appen og afhænger IKKE af kolonne-grants),
--   - afvises bud og maksimumbud (BHK01, 'kunst_kontrol: ...'),
--   - kører uret videre: er den ikke tjekket ved slutning, slutter den uden
--     bud. Ingen pause og ingen DSA-afgørelse.
-- Staff afgør den automatiske anmeldelse (reports.category = 'kunst'):
--   - "Ikke kunst" -> kunst_kontrol = 'godkendt' (synlig, kan bydes på),
--   - Skjul/fjern (det eksisterende DSA-flow) -> 'afvist' (synligheden styres
--     derefter af skjult; "Vis igen"/medhold virker som altid).
-- Rettes teksten igen til noget, der ligner kunst, kommer den til tjek igen -
-- medmindre det er præcis den tekst, staff allerede har afgjort
-- (kunst_tekst_md5 + en lukket kunst-anmeldelse).
--
-- 1. Kolonner på auctions: kunst_bekraeftet (sælgerens "Det er ikke kunst"),
--    kunst_markeret_kl, kunst_kontrol, kunst_tekst_md5. Kun staff
--    (service_role) læser dem. NB: i produktion har anon/authenticated stadig
--    SELECT på hele auctions, indtil 20261010061000 er kørt (den udelader nu
--    også disse kolonner). Indtil da kan de læses af alle - det er kun
--    oplysninger om kontrollen; selve skjulningen afhænger IKKE af grants.
-- 2. Ordlisten: kunst_ord(), kunst_fjern(), kunst_sloer_variant(),
--    kunst_tjek_normaliseret() og kunst_tekst_tjek(). HOLD SYNKRON med
--    src/lib/kunstForbud.ts (testene sammenligner).
-- 3. Triggere: auctions_kunst_kontrol (BEFORE), auctions_kunst_rapport
--    (AFTER), a0_bids_kunst_kontrol og a0_bud_maksimum_kunst_kontrol.
-- 4. RLS: auctions_select_anon og auctions_select_authenticated skjuler
--    kunst_kontrol = 'afventer' for andre end sælger/staff/deltagere.
-- 5. reports.category og dsa_anmeldelser.kategori får 'kunst';
--    dsa_anmeldelse_opret godtager 'kunst'; dsa_regler() får 'kunst';
--    forbudte_varer() får 'kunst'.
-- 6. Brugerbetingelser 0.2 (kunst er en forbudt vare). Den aktive version
--    står i den nye tabel vilkaar_indstilling og er 0.1 efter migrationen -
--    INTET ændres for brugerne, før admin/chef slår 0.2 til (se herunder).
--    vilkaar_aktuel_version læser tabellen og er stable (ikke immutable),
--    og vilkaar_er_accepteret er også stable.
-- 6b. Staff: dsa_afgoerelser_kunst (skjul/fjern med reglen 'kunst' ->
--    'afvist'), kunst_ikke_kunst (luk anmeldelse + godkend i én
--    transaktion), kunst_tjek_aktive ("Tjek aktive auktioner for kunst",
--    kun admin/chef, aldrig automatisk, tør kørsel først; auktioner med bud
--    får kun en anmeldelse), vilkaar_aktiver_version. Alle kun service_role.
-- 7. Ingen kategori må hedde noget med kunst (der findes ingen i dag).
--
-- RÆKKEFØLGE I PRODUKTION (rækkefølgen af migration og hjemmeside-deploy er
-- ligegyldig - koden tåler, at migrationen mangler, og migrationen ændrer
-- ikke vilkårsversionen):
--   1. FØR migrationen: deploy edge-funktionen (den tåler, at kolonnen mangler):
--      npx supabase functions deploy notificer-foelgere --project-ref lkifkrexeldimmghnsie
--   2. Kør denne migration (Filips "ja"). Hjemmesiden kan deployes før eller efter.
--   3. Når den nye hjemmeside er deployet: Admin -> Drift -> "Slå
--      brugerbetingelser 0.2 til" (admin/chef). Først nu får alle
--      eksisterende brugere accept-vinduet, og bud/maksimum/nye auktioner
--      afvises med BHV02, indtil de har accepteret. Gør det ikke, mens den
--      gamle hjemmeside kører (den kender ikke 0.2).
--   4. Valgfrit: Admin -> Auktioner -> "Tjek aktive auktioner for kunst".
--
-- Notifikationer (cron nyAuktionFraFulgt og slutterSnart, edge-funktionen
-- notificer-foelgere) filtrerer 'afventer' fra i koden.
-- gemte_soegninger_find_nye findes ikke længere (20261016010000).
--
-- Kan køres flere gange (if not exists, create or replace, flettede checks,
-- md5-drift-tjek). Ingen eksplicit begin/commit: filen sendes samlet og kører
-- som én transaktion (som de øvrige migrationer). md5 = normaliseret krop (CR og
-- kommentarer fjernet, al whitespace fjernet, små bogstaver) som
-- 20261020020000. "gammel" = prod og test før denne migration (hentet med
-- SELECT 15. okt. 2026), "ny" = efter. Policyerne tjekkes på samme måde
-- (md5 af pg_get_expr). Andet afbryder migrationen.
-- Køres først på testdatabasen (pjiigmzqwlfepxnjdvug). Produktion kræver
-- Filips "ja".
-- =============================================================================

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Hjælpere (midlertidige - droppes nederst)
-- ---------------------------------------------------------------------------

-- Flet nye værdier ind i en check-constraint (som 20261020010000, men
-- afbryder, hvis constraint'en ikke findes).
create or replace function pg_temp.flet_check(p_tabel regclass, p_navn text, p_kolonne text, p_nye text[])
returns void language plpgsql as $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint where conrelid = p_tabel and conname = p_navn;
  if v_def is null then
    raise exception '%: constraint % findes ikke - kontrollér tabellen, før migrationen køres', p_tabel, p_navn;
  end if;
  v_vals := array(
    select distinct x from (
      select btrim(unnest(string_to_array(btrim(m[1], '{}'), ',')), ' "') as x
        from regexp_matches(v_def, '''([^'']+)''', 'g') as m
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

create or replace function pg_temp.drift_tjek_flere(p_fn text, p_tilladte text[])
returns void language plpgsql as $f$
declare
  h text := pg_temp.krop_md5(p_fn);
begin
  if h is null then
    raise exception '%: funktionen findes ikke', p_fn;
  end if;
  if not (h = any(p_tilladte)) then
    raise exception '%: md5 % er ikke en kendt udgave - kontrollér funktionen, før migrationen køres', p_fn, h;
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

-- Retter en funktion på stedet (som 20261020020000).
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

-- Policy-drift: md5 af pg_get_expr skal være den gamle - eller policyen er
-- allerede rettet (indeholder kunst_kontrol). true = skal rettes.
create or replace function pg_temp.policy_tjek(p_navn text, p_gammel text)
returns boolean language plpgsql as $f$
declare
  v_q text;
begin
  select pg_get_expr(p.polqual, p.polrelid) into v_q
    from pg_policy p where p.polrelid = 'public.auctions'::regclass and p.polname = p_navn;
  if v_q is null then
    raise exception 'policy % findes ikke på auctions', p_navn;
  end if;
  if v_q like '%kunst_kontrol%' then return false; end if;
  if md5(v_q) is distinct from p_gammel then
    raise exception 'policy %: md5 % er ikke den forventede (%), kontrollér den, før migrationen køres: %',
      p_navn, md5(v_q), p_gammel, v_q;
  end if;
  return true;
end $f$;

-- Drift-tjek af alt det eksisterende, der ændres - FØR noget ændres.
select pg_temp.drift_tjek('public.forbudte_varer()', '26f66c209eafd8851d51bc524a5771bc', '2ffa99d5dbcb0dc6d559a77d22047963');
select pg_temp.drift_tjek('public.dsa_regler()', '3c089e00118b314b50a3b2fcdc988c8d', '020c8c1d1a545e9588430c1b2898721f');
select pg_temp.drift_tjek('public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)',
                          '10671a6ecac0d9faaae0518587047ff9', 'ab9150038013a607a91e708f57252322');
-- vilkaar_aktuel_version: gammel = 0.1 (prod), ny = 0.2. Den tidligere udgave
-- af denne migration (0.2, immutable - kørt på test) har samme krop og md5
-- som ny, så test opgraderes (til stable) uden at fejle.
-- Den første udgave af denne migration (0.2 hårdkodet, kørt på test) har md5
-- 26f30051368fb71bd83d82c613eb7216 og godtages også, så test kan opgraderes.
select pg_temp.drift_tjek_flere('public.vilkaar_aktuel_version()',
  array['f87f0070b496a88af134964e29b310ce', '26f30051368fb71bd83d82c613eb7216', '859bc356647bea84a155a1a18fbc3115']);
select pg_temp.drift_tjek('public.vilkaar_er_accepteret(text)', '2985fecec0ac4740a4d17ebc244b8020', '2985fecec0ac4740a4d17ebc244b8020');
select pg_temp.policy_tjek('auctions_select_anon', 'e8ff1c7e4468e4aa59f122841dc1a3fc');
select pg_temp.policy_tjek('auctions_select_authenticated', '15a38a05e63952aaf613e3cea3111374');

-- ---------------------------------------------------------------------------
-- 1. Kolonner på auctions
-- ---------------------------------------------------------------------------
alter table public.auctions
  add column if not exists kunst_bekraeftet boolean not null default false,
  add column if not exists kunst_markeret_kl timestamptz,
  add column if not exists kunst_kontrol text,
  add column if not exists kunst_tekst_md5 text,
  add column if not exists kunst_tjekket_kl timestamptz;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'auctions_kunst_kontrol_check'
                   and conrelid = 'public.auctions'::regclass) then
    alter table public.auctions add constraint auctions_kunst_kontrol_check
      check (kunst_kontrol is null or kunst_kontrol in ('afventer', 'godkendt', 'afvist'));
  end if;
end $do$;

comment on column public.auctions.kunst_bekraeftet is
  'Sælgerens "Det er ikke kunst" ved oprettelse (kun når teksten lignede kunst). Kan ikke ændres af brugeren bagefter. Ses kun af staff.';
comment on column public.auctions.kunst_markeret_kl is
  'Sat af databasen (auctions_kunst_kontrol), første gang titel/beskrivelse lignede kunst. Nulstilles aldrig. Ses kun af staff.';
comment on column public.auctions.kunst_kontrol is
  'Kunst-kontrol: null (ingen), afventer (skjult for andre end sælger/staff/deltagere, ingen bud), godkendt (staff: ikke kunst), afvist (staff skjulte/fjernede den for kunst). Brugere kan ikke ændre den.';
comment on column public.auctions.kunst_tjekket_kl is
  'Sidst ordlisten har tjekket titel/beskrivelse (ved oprettelse, rettelse eller "Tjek aktive auktioner"). null = oprettet før kunst-kontrollen og aldrig tjekket.';
comment on column public.auctions.kunst_tekst_md5 is
  'md5 af den normaliserede tekst, der sidst lignede kunst. Samme tekst, som staff allerede har afgjort, sendes ikke til tjek igen.';

-- Kun staff (service_role) læser kolonnerne (se punkt 1 i toppen om prod).
revoke select (kunst_bekraeftet, kunst_markeret_kl, kunst_kontrol, kunst_tekst_md5, kunst_tjekket_kl)
  on public.auctions from anon, authenticated;

create index if not exists auctions_kunst_markeret_idx
  on public.auctions (bruger_id) where kunst_markeret_kl is not null;
create index if not exists auctions_kunst_afventer_idx
  on public.auctions (id) where kunst_kontrol = 'afventer';

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
      (4, '(kunstner(e|en|ens|ne|nes)?|kunstmaler(e|en|ens|ne|nes)?|kunstnersigneret|kunstnersignatur)', null, '(cd|cder|vinyl|lp|lper|album|plade|plader|single|kassette|koncert|koncerter|musik|musiker|sang|sanger|sangerinde|band|rapper|festival)'),
      (5, 'l(æ|ae)rred(et|er|erne)?', '(olie|akryl|akvarel|gouache|malet|malede|h(å|aa)ndmalet|h(å|aa)ndmalede|kunstner|kunstneren|signeret|signerede|signatur|original|originalt|originalv(æ|ae)rk|unika|oil|acrylic|painted|signed)', '(projektor|projektorl(æ|ae)rred|l(æ|ae)rredssk(æ|ae)rm|blank|blankt|blanke|ubrugt|ubrugte)'),
      (6, 'canvas', '(olie|akryl|akvarel|gouache|malet|malede|h(å|aa)ndmalet|h(å|aa)ndmalede|kunstner|kunstneren|signeret|signerede|signatur|unika|oil|acrylic|painted|signed)', '(sko|sneakers|sneaker|converse|vans|taske|tasker|mulepose|rygs(æ|ae)k|stol|stole|klapstol|telt|telte|bukser|jakke|kasket|b(æ|ae)lte)'),
      (7, '(akvarel(len|ler|lerne)?|aquarelle?|gouache(r|n)?)', null, null),
      (8, '(litografi(en|er|erne)?|lithografi(en|er|erne)?|lithography|lithographs?|serigrafi(en|er|erne)?|radering(en|er|erne)?|tr(æ|ae)snit(tet|ter|terne)?|linoleumssnit(tet|ter)?|linoleumsnit(tet|ter)?|linosnit(tet|ter)?|kobberstik(ket|ker|kene)?|st(å|aa)lstik(ket|ker)?|xylografi(en|er)?|akvatinta|mezzotinte|giclee|gicl(é|e)e|(æ|ae)tsning(en|er|erne)?|grafisk(e)? (tryk|blad|blade|v(æ|ae)rk|v(æ|ae)rker))', null, null),
      (9, '(litho|lithos|lito|litos)', null, '(lampe|lamper|lampen|armatur|armaturer|belysning|loftlampe|pendel|v(æ|ae)glampe|bordlampe|standerlampe)'),
      (10, 'silketryk(ket|ker|kene)?', null, '(t shirt|tshirt|tr(ø|oe)je|t(ø|oe)j|h(æ|ae)ttetr(ø|oe)je|hoodie|stof|taske|mulepose|reklame|logo|firmalogo|krus|kasket)'),
      (11, 'grafik(ken|ker|kerne)?', '(signeret|signerede|signatur|nummereret|nummererede|original|originalt|kunstner|kunstneren|indrammet|indrammede|tryk|blad|oplag|(æ|ae)tsning)', '(t shirt|tshirt|tr(ø|oe)je|t(ø|oe)j|h(æ|ae)ttetr(ø|oe)je|hoodie|spil|gaming)'),
      (12, '(signere(t|de)|nummerere(t|de))', '(tryk|trykket|oplag|eksemplar|eksemplarer)', null),
      (13, '[a-zæøå]*skulptur(en|er|erne)?', null, null),
      (14, '(buste(n|r|rne)?|byste(n|r|rne)?)', null, '(sy|syning|skr(æ|ae)dder|syerbuste|skr(æ|ae)dderbuste|t(ø|oe)j|kjole|kjoler|bluse|top|mannequin|mannequindukke|udstillingsdukke|smykke|smykker|halsk(æ|ae)de|halsk(æ|ae)der|paryk|parykker|bh|undert(ø|oe)j|str|st(ø|oe)rrelse|cm|m(å|aa)l|vidde|justerbar)'),
      (15, '((bronze|bronce|marmor) ?(figur|figuren|figurer|statue|statuen|statuer|statuette|statuetter|relief)|(figur|figuren|figurer|statue|statuen|statuer|statuette|statuetter|relief) (i|af|udf(ø|oe)rt i|st(ø|oe)bt i) (bronze|bronce|marmor))', null, null),
      (16, '(statue(n|r|rne)?|statuette(n|r|rne)?)', null, '(have|haven|havestatue|udend(ø|oe)rs|plast|plastik|plastic|plastfigur|resin|polyresin|leget(ø|oe)j|lego|actionfigur|samlefigur|funko|souvenir|frihedsgudinden|lampe)'),
      (17, '([a-zæøå]*tegning(en|er|erne)?|drawings?)', null, '(teknisk|tekniske|samlevejledning|vejledning|monteringsvejledning|manual|m(ø|oe)nster|m(ø|oe)nstre|strikkem(ø|oe)nster|symønster|sym(ø|oe)nster|byggetegning|plantegning|tegneserie|tegneserier|tegnefilm)'),
      (18, '(selvmalet|selvmalede|selvtegnet|selvtegnede)', '(billede|billeder|l(æ|ae)rred|motiv|portr(æ|ae)t|ramme|indrammet)', null),
      (19, '(h(å|aa)ndmalet|h(å|aa)ndmalede|malet|malede|olie|akryl) ?billede(t|r|rne)?', null, null),
      (20, '((billede(t|r|rne)?|motiv(et|er)?) (malet |udf(ø|oe)rt )?i (olie|akryl|akvarel|gouache|tempera)|(olie|akryl)malet|(olie|akryl)malede)', null, null),
      (21, '(abstrakt|abstrakte|figurativ|figurativt|figurative|moderne) billede(t|r|rne)?', '(olie|akryl|akvarel|gouache|malet|malede|l(æ|ae)rred|signeret|signatur|kunstner)', null),
      (22, '((olie|akryl|akvarel|gouache|tempera) p(å|aa) (l(æ|ae)rred|plade|tr(æ|ae)|pap|papir)|(blyant|kul|tusch|bl(æ|ae)k|pastel|pastelkridt|rødkridt) p(å|aa) papir|portr(æ|ae)t(tet|ter)? (i|malet i|udf(ø|oe)rt i) (olie|akryl|akvarel|kul|blyant|pastel))', null, null),
      (23, '(painting|paintings|oil painting|artwork|artworks|original art|fine art|wall art|sculpture|sculptures|etching|etchings|watercolou?r|watercolou?rs|art print|signed print|(oil|acrylic) on (canvas|board|paper|panel|wood|linen|card|masonite))', null, null),
      (24, '(gem(ä|ae|a)lde|aquarell)', null, null)
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
  select '(kunst (l(æ|ae)der|gr(æ|ae)s|stof|stoffer|pels|blomst|blomster|plante|planter|silke|ruskind|negle|juletr(æ|ae)|sk(ø|oe)jtel(ø|oe)b|harpiks|is)|kunst (og|&) h(å|aa)ndv(æ|ae)rk|(akvarel|gouache|akryl|olie|pastel|kunstner|kunstmaler|tegne) (farve|farver|farvers(æ|ae)t|maling|pensel|pensler|papir|blok|blokke|s(æ|ae)t|kasse|kasser|(æ|ae)ske|(æ|ae)sker|kursus|kurser|staffeli|staffelier|ler|v(æ|ae)rkt(ø|oe)j|tape|lak|spartel|paletkniv|palet|paletter|udstyr|grej|artikler|forsyninger)|(maleri|kunst|tegning|skulptur|grafik) (kursus|kurser|artikler|udstyr|grej|forsyninger|v(æ|ae)rkt(ø|oe)j)|drawing (tablet|tablets|pad|board|table|book|set|kit)|((farve|farver|farvers(æ|ae)t|maling|pensel|pensler|papir|blok|blokke|s(æ|ae)t|kasse|kasser|(æ|ae)ske|(æ|ae)sker|kursus|kurser|staffeli|staffelier|ler|v(æ|ae)rkt(ø|oe)j|tape|lak|spartel|paletkniv|palet|paletter|udstyr|grej|artikler|forsyninger)|(ramme|rammer|billedramme|billedrammer|lampe|lamper|oph(æ|ae)ng|krog|kroge|lys|l(æ|ae)rred|l(æ|ae)rreder|transportkasse)) (til|for) (et |en |dit |din |mit |min |dine |mine |de )?(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|(bog|b(ø|oe)ger|bogen|b(ø|oe)rnebog|b(ø|oe)rneb(ø|oe)ger|billedbog|billedb(ø|oe)ger|malebog|maleb(ø|oe)ger|dvd|film|filmen|leksikon|katalog|kataloger|udstillingskatalog|tidsskrift|blad|blade|magasin|foredrag|kursus|kurser|puslespil|kort|postkort|kalender|plakatbog) (om|med|af|fra) (et |en |de |det |den )?(kendte |kendt |berømte |berømt |danske |dansk |moderne |gamle )?(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|(plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet) (af|med|fra|efter) (et |en |det |den )?(kendte |kendt |berømte |berømt )?(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst) ?(plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet)|(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst) (til|for|i|med) [a-zæøå]+ (plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet)|(ikea|jysk|bilka|s(ø|oe)strene grene|imerco|kop og kande|kop & kande|ilva|bolia|h&m home|zara home|flying tiger|jem og fix|jem & fix|harald nyborg|silvan|bauhaus|desenio|poster store) ?((maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|billede|billeder|v(æ|ae)gbillede|v(æ|ae)gbilleder)|((maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)|billede|billeder) (fra|k(ø|oe)bt i|k(ø|oe)bt hos|k(ø|oe)bt p(å|aa)) ((ikea|jysk|bilka|s(ø|oe)strene grene|imerco|kop og kande|kop & kande|ilva|bolia|h&m home|zara home|flying tiger|jem og fix|jem & fix|harald nyborg|silvan|bauhaus|desenio|poster store)|tiger|normal)|(signeret|signerede|nummereret|nummererede) (bog|b(ø|oe)ger|bogen|roman|digtsamling|f(ø|oe)rsteudgave|udgave|tr(ø|oe)je|fodboldtr(ø|oe)je|bold|fodbold|kort|samlekort|billet|program|autograf|autografkort)|(bog|b(ø|oe)ger|bogen|roman|digtsamling|f(ø|oe)rsteudgave|udgave|tr(ø|oe)je|fodboldtr(ø|oe)je|bold|fodbold|kort|samlekort|billet|program|autograf|autografkort) (signeret|signerede|nummereret|nummererede)|(sikker |data )?radering (af |i )?(tekst|teksten|data|harddisk|harddiske|disk|filer|fil|ssd)|(buste|byste) (ramme|stativ|form|dukke|holder|top|bh)|(porcel(æ|ae)ns|porcel(æ|ae)n|keramik|stent(ø|oe)js) ?maleri(et|er|erne)?|maleri(et|er|erne)? p(å|aa) porcel(æ|ae)n|(bygge|plan|arbejds|monterings|konstruktions|el|vvs|maskin|snit|facade|samle|udstyknings|matrikel)tegning(en|er|erne)?)'::text;
$fn$;

-- Afslører simple forsøg på at skjule et ord (kunstSloerVariant i TS):
-- kyrilliske/græske look-alikes -> latin (HOMOGLYF_FRA/TIL i TS), @ -> a,
-- € -> e, accenter fjernes, 3/1/0 ved siden af bogstaver -> e/<p_et>/o,
-- skilletegn mellem to bogstaver fjernes ("ma-leri"), normalisering, og 3+
-- enkeltbogstaver i træk sættes sammen ("m a l e r i").
-- (Den første udgave i denne migration havde kun p_tekst - droppes.)
drop function if exists public.kunst_sloer_variant(text);

create or replace function public.kunst_sloer_variant(p_tekst text, p_et text default 'i')
returns text
language plpgsql
immutable
set search_path = public
as $fn$
declare
  b      constant text := 'a-zæøå';
  t      text := regexp_replace(lower(translate(normalize(coalesce(p_tekst, ''), NFC),
                                  'аеорсухікмтнвАЕОРСУХІКМТНВαεορτκνιυχΑΕΟΡΤΚΝΙΥΧΒΗΜ',
                                  'aeopcyxikmthbaeopcyxikmthbaeoptkviuxaeoptkniyxbhm')),
                                '[­​-‏‪-‮⁠-⁯﻿]', '', 'g');
  d      record;
  v_ord  text;
  raekke text[] := '{}';
  ud     text[] := '{}';
begin
  t := replace(replace(t, '@', 'a'), '€', 'e');
  t := translate(t, 'äöüéèáàâêëíìîïóòôúùûñç', 'aoueeaaaeeiiiiooouuunc');
  for d in select * from (values (1, '3', 'e'), (2, '1', case when p_et = 'l' then 'l' else 'i' end), (3, '0', 'o'))
             as x(n, tal, bogstav) order by x.n loop
    for i in 1..2 loop
      t := regexp_replace(t, '([' || b || '])' || d.tal, '\1' || d.bogstav, 'g');
      t := regexp_replace(t, d.tal || '([' || b || '])', d.bogstav || '\1', 'g');
    end loop;
  end loop;
  t := regexp_replace(t, '([' || b || '])[-.·_*''](?=[' || b || '])', '\1', 'g');
  t := public.forbudt_normaliser(t);
  foreach v_ord in array string_to_array(t, ' ') loop
    if v_ord ~ ('^[' || b || ']$') then
      raekke := raekke || v_ord;
    else
      if cardinality(raekke) >= 3 then ud := ud || array_to_string(raekke, ''); else ud := ud || raekke; end if;
      raekke := '{}';
      ud := ud || v_ord;
    end if;
  end loop;
  if cardinality(raekke) >= 3 then ud := ud || array_to_string(raekke, ''); else ud := ud || raekke; end if;
  return array_to_string(array_remove(ud, ''), ' ');
end;
$fn$;

-- Fjerner de tilladte fraser (første forekomst ad gangen, højst 50 gange).
create or replace function public.kunst_rens(p_norm text)
returns text
language plpgsql
immutable
set search_path = public
as $fn$
declare
  g       constant text := '[^a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß]';
  v_tekst text := coalesce(p_norm, '');
  v_re    text := '(^|' || g || ')(' || public.kunst_fjern() || ')($|' || g || ')';
begin
  for i in 1..50 loop
    exit when v_tekst !~ v_re;
    v_tekst := regexp_replace(v_tekst, v_re, ' ');
  end loop;
  return v_tekst;
end;
$fn$;

-- To og to ord sat sammen ("ma leri" -> "maleri") af den RENSEDE tekst; ordene
-- selv står først. '' ved under to ord. Som kunstPar i TS.
create or replace function public.kunst_par(p_norm text)
returns text
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_ord text[] := array_remove(string_to_array(public.kunst_rens(p_norm), ' '), '');
  v_par text[] := '{}';
begin
  if cardinality(v_ord) < 2 then
    return '';
  end if;
  for i in 1..cardinality(v_ord) - 1 loop
    v_par := v_par || (v_ord[i] || v_ord[i + 1]);
  end loop;
  -- Tre korte ord i træk ("ma le ri"), kun når alle tre har højst to bogstaver.
  for i in 1..cardinality(v_ord) - 2 loop
    if char_length(v_ord[i]) <= 2 and char_length(v_ord[i + 1]) <= 2 and char_length(v_ord[i + 2]) <= 2 then
      v_par := v_par || (v_ord[i] || v_ord[i + 1] || v_ord[i + 2]);
    end if;
  end loop;
  return array_to_string(v_ord || v_par, ' ');
end;
$fn$;

-- Tjekker en normaliseret tekst: moenster, kraever og undtagen tjekkes som
-- hele ord i den RENSEDE tekst. null = intet træf.
create or replace function public.kunst_tjek_normaliseret(p_norm text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
declare
  g       constant text := '[^a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß]';
  v_tekst text := public.kunst_rens(p_norm);
  o       record;
  m       text[];
begin
  for o in select * from public.kunst_ord() k order by k.nr loop
    m := regexp_match(v_tekst, '(^|' || g || ')(' || o.moenster || ')($|' || g || ')');
    if m is null then continue; end if;
    if o.kraever is not null
       and v_tekst !~ ('(^|' || g || ')(' || o.kraever || ')($|' || g || ')') then
      continue;
    end if;
    if o.undtagen is not null
       and v_tekst ~ ('(^|' || g || ')(' || o.undtagen || ')($|' || g || ')') then
      continue;
    end if;
    return jsonb_build_object('resultat', 'kunst', 'ord', m[2], 'nr', o.nr);
  end loop;
  return null;
end;
$fn$;

-- {"resultat": "ok"} eller {"resultat": "kunst", "ord", "nr"}. Samme logik
-- som tjekKunstTekst i TypeScript: den normaliserede tekst, derefter
-- varianterne med 1 -> i og 1 -> l - og for hver også to ord samlet. Højst
-- 5000 tegn.
create or replace function public.kunst_tekst_tjek(p_tekst text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_raa  text := left(coalesce(p_tekst, ''), 5000);
  v_norm text := public.forbudt_normaliser(v_raa);
  v_set  text[] := '{}';
  k      text;
  v_par  text;
  r      jsonb;
begin
  if v_norm = '' then
    return jsonb_build_object('resultat', 'ok');
  end if;
  foreach k in array array[v_norm, public.kunst_sloer_variant(v_raa, 'i'), public.kunst_sloer_variant(v_raa, 'l')] loop
    if k = '' or k = any(v_set) then continue; end if;
    v_set := v_set || k;
    r := public.kunst_tjek_normaliseret(k);
    if r is not null then return r; end if;
    v_par := public.kunst_par(k);
    if v_par <> '' then
      r := public.kunst_tjek_normaliseret(v_par);
      if r is not null then return r; end if;
    end if;
  end loop;
  return jsonb_build_object('resultat', 'ok');
end;
$fn$;

-- Rene funktioner uden dataadgang - appen (logget ind) må gerne tjekke på
-- forhånd. Ikke anon (review M2). Er de tidligere givet til anon (første
-- udgave af migrationen på test), fjernes det her.
revoke all on function public.kunst_ord() from public, anon;
revoke all on function public.kunst_fjern() from public, anon;
revoke all on function public.kunst_sloer_variant(text, text) from public, anon;
revoke all on function public.kunst_rens(text) from public, anon;
revoke all on function public.kunst_par(text) from public, anon;
revoke all on function public.kunst_tjek_normaliseret(text) from public, anon;
revoke all on function public.kunst_tekst_tjek(text) from public, anon;
grant execute on function public.kunst_ord()                      to authenticated, service_role;
grant execute on function public.kunst_fjern()                    to authenticated, service_role;
grant execute on function public.kunst_sloer_variant(text, text)  to authenticated, service_role;
grant execute on function public.kunst_rens(text)                 to authenticated, service_role;
grant execute on function public.kunst_par(text)                  to authenticated, service_role;
grant execute on function public.kunst_tjek_normaliseret(text)    to authenticated, service_role;
grant execute on function public.kunst_tekst_tjek(text)           to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Triggere
-- ---------------------------------------------------------------------------

-- BEFORE på auctions: markering og kontrol. Brugeren (authenticated/anon)
-- kan aldrig selv sætte eller ændre kunst_kontrol, kunst_markeret_kl,
-- kunst_tekst_md5 - og kunst_bekraeftet kun ved oprettelse. Staff
-- (service_role) sætter kunst_kontrol til 'godkendt'/'afvist' (tjekkes af
-- auctions_kunst_kontrol_check). security definer: læser reports.
create or replace function public.auctions_kunst_kontrol()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      jsonb;
  v_md5  text;
  v_tekst text := coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, '');
begin
  if tg_op = 'INSERT' then
    new.kunst_bekraeftet := coalesce(new.kunst_bekraeftet, false);
    new.kunst_tjekket_kl := now();
    v := public.kunst_tekst_tjek(v_tekst);
    if v->>'resultat' = 'kunst' then
      new.kunst_markeret_kl := now();
      new.kunst_kontrol := 'afventer';
      new.kunst_tekst_md5 := md5(public.forbudt_normaliser(left(v_tekst, 5000)));
    else
      new.kunst_markeret_kl := null;
      new.kunst_kontrol := null;
      new.kunst_tekst_md5 := null;
    end if;
    return new;
  end if;

  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.kunst_bekraeftet := old.kunst_bekraeftet;
    new.kunst_kontrol := old.kunst_kontrol;
    new.kunst_tjekket_kl := old.kunst_tjekket_kl;
  end if;
  new.kunst_bekraeftet := coalesce(new.kunst_bekraeftet, old.kunst_bekraeftet, false);
  new.kunst_markeret_kl := old.kunst_markeret_kl;
  new.kunst_tekst_md5 := old.kunst_tekst_md5;

  if new.titel is distinct from old.titel or new.beskrivelse is distinct from old.beskrivelse then
    new.kunst_tjekket_kl := now();
    v := public.kunst_tekst_tjek(v_tekst);
    if v->>'resultat' = 'kunst' then
      v_md5 := md5(public.forbudt_normaliser(left(v_tekst, 5000)));
      new.kunst_markeret_kl := coalesce(old.kunst_markeret_kl, now());
      -- Samme tekst, som staff allerede har afgjort (lukket anmeldelse):
      -- ingen ny kontrol. Ellers tilbage til tjek, medmindre den er afvist
      -- (skjult/fjernet - så styrer skjult synligheden).
      -- Afvist og stadig skjult/fjernet: skjult styrer synligheden. Afvist,
      -- men synlig igen (medhold): tilbage til tjek som alle andre.
      if not (v_md5 is not distinct from old.kunst_tekst_md5
              and exists (select 1 from public.reports r
                           where r.auction_id = new.id and r.category = 'kunst'
                             and r.status not in ('pending', 'under_behandling')))
         and not (new.kunst_kontrol = 'afvist' and coalesce(new.skjult, false)) then
        new.kunst_kontrol := 'afventer';
      end if;
      new.kunst_tekst_md5 := v_md5;
    end if;
  end if;

  -- Staff/system sætter den til tjek (fx "Tjek aktive auktioner" eller en
  -- genåbnet anmeldelse): markér den også.
  if new.kunst_kontrol = 'afventer' and old.kunst_kontrol is distinct from 'afventer' then
    new.kunst_markeret_kl := coalesce(new.kunst_markeret_kl, now());
    new.kunst_tekst_md5 := coalesce(new.kunst_tekst_md5, md5(public.forbudt_normaliser(left(v_tekst, 5000))));
  end if;
  return new;
end;
$fn$;

revoke all on function public.auctions_kunst_kontrol() from public, anon, authenticated;

drop trigger if exists auctions_kunst_kontrol on public.auctions;
create trigger auctions_kunst_kontrol
  before insert or update on public.auctions
  for each row execute function public.auctions_kunst_kontrol();

-- AFTER på auctions: automatisk anmeldelse til staff (Admin -> Anmeldelser),
-- når auktionen (igen) afventer kontrol. Højst én åben pr. auktion. Fejler
-- den, oprettes/rettes auktionen alligevel (advarsel i loggen) - som
-- auctions_forbudt_rapport; auktionen ses så under Admin -> Auktioner
-- ("Afventer kunst-kontrol").
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
  if new.kunst_kontrol is distinct from 'afventer' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and old.kunst_kontrol is not distinct from 'afventer'
     and new.titel is not distinct from old.titel
     and new.beskrivelse is not distinct from old.beskrivelse then
    return null;
  end if;

  begin
    if exists (select 1 from public.reports r
                where r.auction_id = new.id
                  and r.category = 'kunst'
                  and r.status in ('pending', 'under_behandling')) then
      return null;
    end if;

    v := public.kunst_tekst_tjek(coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, ''));

    -- Gentagne forsøg: andre auktioner fra samme sælger, der afventer eller
    -- er afvist for kunst.
    select count(*) into v_antal
      from public.auctions a
     where a.bruger_id = new.bruger_id
       and a.id <> new.id
       and a.kunst_kontrol in ('afventer', 'afvist');

    insert into public.reports (auction_id, reporter_id, category, description, status, created_at)
    values (new.id, public.bidhamr_system_id(), 'kunst',
            left(concat_ws(' ',
              case when v->>'resultat' = 'kunst'
                   then format('Kontrol: muligvis kunst. Ordet "%s" står i %s.', v->>'ord',
                               case when tg_op = 'INSERT' then 'titlen eller beskrivelsen'
                                    else 'den rettede titel eller beskrivelse' end)
                   else 'Kontrol: muligvis kunst.' end,
              case when tg_op = 'INSERT' and new.kunst_bekraeftet
                     then 'Sælgeren har bekræftet "Det er ikke kunst".'
                   when tg_op = 'INSERT'
                     then 'Sælgeren har ikke bekræftet, at det ikke er kunst (fx oprettet fra appen).' end,
              case when v_antal > 0
                     then format('Sælgeren har %s andre auktioner, der afventer eller er afvist for kunst – overvej en advarsel.', v_antal) end,
              'Auktionen er skjult for andre, og der kan ikke bydes, til den er tjekket: "Ikke kunst" gør den synlig, ellers skjul eller fjern den.'), 1000),
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
  after insert or update of titel, beskrivelse, kunst_kontrol on public.auctions
  for each row execute function public.auctions_kunst_rapport();

-- Bud og maksimumbud afvises, mens auktionen afventer kontrol. a0_ = før de
-- andre bud-triggere (alfabetisk). security definer: brugeren kan ikke læse
-- kunst_kontrol.
create or replace function public.bids_kunst_kontrol()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if exists (select 1 from public.auctions a
              where a.id = new.auktion_id and a.kunst_kontrol = 'afventer') then
    raise exception 'kunst_kontrol: Auktionen afventer kontrol hos BidHamr, og der kan ikke bydes endnu.'
      using errcode = 'BHK01';
  end if;
  return new;
end;
$fn$;

revoke all on function public.bids_kunst_kontrol() from public, anon, authenticated;

drop trigger if exists a0_bids_kunst_kontrol on public.bids;
create trigger a0_bids_kunst_kontrol
  before insert on public.bids
  for each row execute function public.bids_kunst_kontrol();

drop trigger if exists a0_bud_maksimum_kunst_kontrol on public.bud_maksimum;
create trigger a0_bud_maksimum_kunst_kontrol
  before insert or update on public.bud_maksimum
  for each row execute function public.bids_kunst_kontrol();

-- Sælgerens egen kontrol-status (til "Afventer kontrol" i appen). Brugeren
-- udledes af auth.uid(); andres auktioner giver null.
create or replace function public.min_kunst_kontrol(p_auktion uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select a.kunst_kontrol
    from public.auctions a
   where a.id = p_auktion
     and a.bruger_id = auth.uid();
$fn$;

revoke all on function public.min_kunst_kontrol(uuid) from public, anon;
grant execute on function public.min_kunst_kontrol(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RLS: auktioner, der afventer kunst-kontrol, er skjult for andre end
--    sælgeren, staff og deltagere (som 'skjult'). Gælder også appen.
-- ---------------------------------------------------------------------------
do $do$
begin
  if pg_temp.policy_tjek('auctions_select_anon', 'e8ff1c7e4468e4aa59f122841dc1a3fc') then
    alter policy auctions_select_anon on public.auctions
      using ((arkiveret_kl is null) and (not coalesce(skjult, false))
             and (kunst_kontrol is distinct from 'afventer'));
  end if;
  if pg_temp.policy_tjek('auctions_select_authenticated', '15a38a05e63952aaf613e3cea3111374') then
    alter policy auctions_select_authenticated on public.auctions
      using (((arkiveret_kl is null) and (not coalesce(skjult, false))
              and (kunst_kontrol is distinct from 'afventer'))
             or (bruger_id = (select auth.uid()))
             or (select public.er_staff())
             or public.auktion_arkiv_adgang(id));
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- 5. Kategorier på anmeldelser og regler
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

-- Regel for indgreb: "Kunst er ikke tilladt" (spejl af DSA_REGLER i
-- src/lib/dsa/regler.ts). Som 20261009030000 + 'kunst'.
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

-- Kategorien på /forbudte-varer (spejl af FORBUDTE_KATEGORIER i
-- src/lib/forbudteVarer.ts). Som 20261006042000 + 'kunst'.
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

-- ---------------------------------------------------------------------------
-- 6. Brugerbetingelser version 0.2 (HOLD SYNKRON med VILKAAR_VERSION i
--    src/lib/vilkaar.ts). Som 20261009050000 med ny version.
-- ---------------------------------------------------------------------------
-- Den aktive version styres af en indstilling (review V2), så rækkefølgen af
-- migration og deploy er ligegyldig: migrationen ændrer INTET for brugerne -
-- versionen er stadig 0.1, til admin/chef efter deploy trykker "Slå
-- brugerbetingelser 0.2 til" under Admin -> Drift (vilkaar_aktiver_version).
-- Først da får alle accept-vinduet, og BHV02 gælder for 0.2.
create table if not exists public.vilkaar_indstilling (
  id            boolean primary key default true check (id),
  aktiv_version text not null default '0.1' check (aktiv_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  skiftet_kl    timestamptz,
  skiftet_af    uuid references public.users(id) on delete set null
);

insert into public.vilkaar_indstilling (id, aktiv_version) values (true, '0.1') on conflict (id) do nothing;

comment on table public.vilkaar_indstilling is
  'Den aktive version af brugerbetingelserne (vilkaar_aktuel_version). Skiftes kun via vilkaar_aktiver_version (admin/chef) - aldrig ned.';

alter table public.vilkaar_indstilling enable row level security;
revoke all on public.vilkaar_indstilling from public, anon, authenticated;
-- Versionen er offentlig (signup og vinduet læser den); ingen må skrive.
grant select (id, aktiv_version) on public.vilkaar_indstilling to anon, authenticated;

do $do$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'vilkaar_indstilling'
                   and policyname = 'vilkaar_indstilling_laes') then
    create policy vilkaar_indstilling_laes on public.vilkaar_indstilling for select to anon, authenticated using (true);
  end if;
end $do$;

-- Rækken må aldrig slettes (så falder versionen tilbage til 0.1).
create or replace function public.vilkaar_indstilling_ingen_sletning()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'vilkaar_indstilling kan ikke slettes - skift versionen med vilkaar_aktiver_version'
    using errcode = '42501';
end;
$fn$;

revoke all on function public.vilkaar_indstilling_ingen_sletning() from public, anon, authenticated;

drop trigger if exists vilkaar_indstilling_ingen_sletning on public.vilkaar_indstilling;
create trigger vilkaar_indstilling_ingen_sletning
  before delete on public.vilkaar_indstilling
  for each row execute function public.vilkaar_indstilling_ingen_sletning();
drop trigger if exists vilkaar_indstilling_ingen_truncate on public.vilkaar_indstilling;
create trigger vilkaar_indstilling_ingen_truncate
  before truncate on public.vilkaar_indstilling
  for each statement execute function public.vilkaar_indstilling_ingen_sletning();

-- stable (ikke immutable), så planner ikke kan bage en gammel version ind.
create or replace function public.vilkaar_aktuel_version()
returns text
language sql
stable
parallel safe
set search_path = ''
as $fn$
  select coalesce((select v.aktiv_version from public.vilkaar_indstilling v where v.id), '0.1')::text;
$fn$;

grant execute on function public.vilkaar_aktuel_version() to anon, authenticated, service_role;

-- Admin/chef slår en nyere version til (kun op, aldrig ned). Kun service_role
-- (serveren); rollen tjekkes her igen. Et dobbeltklik giver 'uaendret'.
create or replace function public.vilkaar_aktiver_version(p_staff uuid, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_gl text;
begin
  if coalesce(public.kunst_staff_rolle(p_staff), '') not in ('admin', 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if p_version is null or p_version !~ '^[0-9]{1,3}\.[0-9]{1,3}$' then
    return jsonb_build_object('kode', 'ugyldig_version');
  end if;
  select v.aktiv_version into v_gl from public.vilkaar_indstilling v where v.id for update;
  if not found then
    return jsonb_build_object('kode', 'mangler_indstilling');
  end if;
  if (split_part(p_version, '.', 1)::int, split_part(p_version, '.', 2)::int)
     <= (split_part(v_gl, '.', 1)::int, split_part(v_gl, '.', 2)::int) then
    return jsonb_build_object('kode', 'uaendret', 'version', v_gl);
  end if;
  update public.vilkaar_indstilling
     set aktiv_version = p_version, skiftet_kl = now(), skiftet_af = p_staff
   where id;
  return jsonb_build_object('kode', 'ok', 'version', p_version, 'foer', v_gl);
end;
$fn$;

revoke all on function public.vilkaar_aktiver_version(uuid, text) from public, anon, authenticated;
grant execute on function public.vilkaar_aktiver_version(uuid, text) to service_role;

-- vilkaar_er_accepteret (20261017030000) kalder vilkaar_aktuel_version() og
-- var immutable - også stable nu. Kroppen er uændret (md5 tjekket øverst).
alter function public.vilkaar_er_accepteret(text) stable;

do $do$
begin
  if (select provolatile from pg_proc where oid = 'public.vilkaar_aktuel_version()'::regprocedure) <> 's'
     or (select provolatile from pg_proc where oid = 'public.vilkaar_er_accepteret(text)'::regprocedure) <> 's' then
    raise exception 'vilkaar-funktionerne er ikke stable efter migrationen';
  end if;
end $do$;

select pg_temp.efter_tjek('public.forbudte_varer()', '2ffa99d5dbcb0dc6d559a77d22047963');
select pg_temp.efter_tjek('public.dsa_regler()', '020c8c1d1a545e9588430c1b2898721f');
select pg_temp.efter_tjek('public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)', 'ab9150038013a607a91e708f57252322');
select pg_temp.efter_tjek('public.vilkaar_aktuel_version()', '859bc356647bea84a155a1a18fbc3115');

-- ---------------------------------------------------------------------------
-- 6b. Staff-handlinger
-- ---------------------------------------------------------------------------

-- Skjul/fjern/stop med reglen 'kunst' (fra Anmeldelser, DSA, Auktioner eller
-- en brugeranmeldelse): kontrollen er afgjort -> 'afvist' (også en tidligere
-- 'godkendt'). Sker i databasen, så alle veje til dsa_indgreb er dækket.
create or replace function public.dsa_afgoerelser_kunst()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.regel_kode = 'kunst' and new.indhold_type = 'auktion' and new.indhold_id is not null then
    update public.auctions a
       set kunst_kontrol = 'afvist'
     where a.id = new.indhold_id
       and (a.kunst_kontrol is null or a.kunst_kontrol in ('afventer', 'godkendt'));
  end if;
  return null;
end;
$fn$;

revoke all on function public.dsa_afgoerelser_kunst() from public, anon, authenticated;

drop trigger if exists dsa_afgoerelser_kunst on public.dsa_afgoerelser;
create trigger dsa_afgoerelser_kunst
  after insert on public.dsa_afgoerelser
  for each row execute function public.dsa_afgoerelser_kunst();

-- Fælles rolletjek for staff-RPC'erne herunder.
create or replace function public.kunst_staff_rolle(p_staff uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select u.rolle from public.users u where u.id = p_staff;
$fn$;

revoke all on function public.kunst_staff_rolle(uuid) from public, anon, authenticated;
grant execute on function public.kunst_staff_rolle(uuid) to service_role;

-- "Ikke kunst - godkend" i én transaktion: anmeldelsen lukkes (kun en åben
-- kunst-anmeldelse), og auktionen godkendes (kun fra 'afventer'). Et
-- dobbeltklik gør intet anden gang ('allerede'). Kun service_role (serveren);
-- staff-rollen tjekkes her igen.
create or replace function public.kunst_ikke_kunst(p_staff uuid, p_rapport uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_auk uuid;
begin
  if coalesce(public.kunst_staff_rolle(p_staff), '') not in ('medarbejder', 'admin', 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) = 0 or char_length(p_note) > 2000 then
    return jsonb_build_object('kode', 'note');
  end if;
  update public.reports r
     set status = 'behandlet', handled_by = p_staff, handled_note = p_note, handled_at = now()
   where r.id = p_rapport and r.category = 'kunst' and r.status = 'pending'
  returning r.auction_id into v_auk;
  if v_auk is null then
    return jsonb_build_object('kode', 'allerede');
  end if;
  update public.auctions a
     set kunst_kontrol = 'godkendt'
   where a.id = v_auk and a.kunst_kontrol = 'afventer';
  return jsonb_build_object('kode', 'ok', 'auktion_id', v_auk);
end;
$fn$;

revoke all on function public.kunst_ikke_kunst(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.kunst_ikke_kunst(uuid, uuid, text) to service_role;

-- "Tjek aktive auktioner for kunst" (kun admin/chef, aldrig automatisk).
-- Altid i to trin fra admin (review V1):
--   p_toer = true (standard): tør kørsel - tæller kun, ændrer intet.
--   p_toer = false: auktioner UDEN bud sættes til 'afventer' (triggeren
--     markerer og opretter anmeldelsen). Auktioner MED bud ændres IKKE
--     (ingen skjulning, buddene gælder) - de får kun en kunst-anmeldelse.
-- Kun aktive auktioner, der aldrig er tjekket (kunst_tjekket_kl er null:
-- oprettet før migrationen og ikke rettet siden) og uden kunst-kontrol eller
-- kunst-anmeldelse. Ældste først. Højst p_maks pr. kørsel (standard 500,
-- højst 2000); 'mangler' = hvor mange der er tilbage ("kør igen").
-- Auktionsrækken låses, før buddene tjekkes, og skjulningen sker kun, hvis
-- der stadig ikke er bud (review M-a).
drop function if exists public.kunst_tjek_aktive(uuid, integer);

create or replace function public.kunst_tjek_aktive(p_staff uuid, p_maks integer default 500, p_toer boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  a         record;
  v         jsonb;
  v_toer    boolean := coalesce(p_toer, true);
  v_total   integer;
  v_tjekket integer := 0;
  v_uden    integer := 0;
  v_med     integer := 0;
  v_skjult  boolean;
begin
  if coalesce(public.kunst_staff_rolle(p_staff), '') not in ('admin', 'chef') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;

  select count(*) into v_total
    from public.auctions x
   where x.status = 'aktiv' and x.kunst_kontrol is null and x.arkiveret_kl is null
     and x.kunst_tjekket_kl is null
     and not exists (select 1 from public.reports r where r.auction_id = x.id and r.category = 'kunst');

  for a in
    select x.id, x.titel, x.beskrivelse
      from public.auctions x
     where x.status = 'aktiv' and x.kunst_kontrol is null and x.arkiveret_kl is null
       and x.kunst_tjekket_kl is null
       and not exists (select 1 from public.reports r where r.auction_id = x.id and r.category = 'kunst')
     order by x.oprettet asc, x.id
     limit greatest(1, least(coalesce(p_maks, 500), 2000))
  loop
    v_tjekket := v_tjekket + 1;
    if not v_toer then
      -- Lås rækken, før buddene tjekkes.
      perform 1 from public.auctions where id = a.id for update;
    end if;
    v := public.kunst_tekst_tjek(coalesce(a.titel, '') || ' ' || coalesce(a.beskrivelse, ''));
    if v->>'resultat' is distinct from 'kunst' then
      if not v_toer then
        update public.auctions set kunst_tjekket_kl = now() where id = a.id;
      end if;
      continue;
    end if;

    v_skjult := false;
    if not exists (select 1 from public.bids b where b.auktion_id = a.id) then
      if v_toer then
        v_skjult := true;
      else
        update public.auctions
           set kunst_kontrol = 'afventer', kunst_tjekket_kl = now()
         where id = a.id and kunst_kontrol is null
           and not exists (select 1 from public.bids b where b.auktion_id = a.id);
        v_skjult := found;
      end if;
    end if;

    if v_skjult then
      v_uden := v_uden + 1;
    else
      v_med := v_med + 1;
      if not v_toer then
        update public.auctions set kunst_tjekket_kl = now() where id = a.id;
        insert into public.reports (auction_id, reporter_id, category, description, status, created_at)
        values (a.id, public.bidhamr_system_id(), 'kunst',
                left(format('Kontrol (tjek af aktive auktioner): muligvis kunst. Ordet "%s" står i titlen eller beskrivelsen. '
                            || 'Auktionen har bud og er IKKE skjult - buddene gælder. Vurdér, om den skal skjules eller fjernes.',
                            v->>'ord'), 1000),
                'pending', now());
      end if;
    end if;
  end loop;

  return jsonb_build_object('kode', 'ok', 'toer', v_toer, 'tjekket', v_tjekket,
                            'uden_bud', v_uden, 'med_bud', v_med,
                            'mangler', greatest(v_total - v_tjekket, 0));
end;
$fn$;

revoke all on function public.kunst_tjek_aktive(uuid, integer, boolean) from public, anon, authenticated;
grant execute on function public.kunst_tjek_aktive(uuid, integer, boolean) to service_role;

-- gemte_soegninger_find_nye (20261007011000) sendte nye auktioner til gemte
-- søgninger. Den er fjernet i 20261016010000_fjern_gemte_soegninger.sql og
-- findes hverken i prod eller test (tjekket med SELECT 15. okt. 2026), så
-- den rettes ikke her. Findes den alligevel, stoppes migrationen, så den
-- kan få filteret på kunst_kontrol.
do $do$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'gemte_soegninger_find_nye') then
    raise exception 'gemte_soegninger_find_nye findes - kør 20261016010000 først, eller filtrér kunst_kontrol = ''afventer'' fra i den';
  end if;
end $do$;

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
    ('Oil on canvas', 'kunst'),
    ('Acrylic on board', 'kunst'),
    ('Canvas, olie, signeret', 'kunst'),
    ('Original drawing', 'kunst'),
    ('Drawings by Storm P', 'kunst'),
    ('Original art', 'kunst'),
    ('Lithography', 'kunst'),
    ('Litho, signed', 'kunst'),
    ('Lithografi', 'kunst'),
    ('Håndmalet billede', 'kunst'),
    ('Malet billede af skib', 'kunst'),
    ('Oliebillede', 'kunst'),
    ('Akryl-billede', 'kunst'),
    ('Portræt i olie', 'kunst'),
    ('Portræt malet i akryl', 'kunst'),
    ('Tiger maleri', 'kunst'),
    ('M.a.l.e.r.i', 'kunst'),
    ('m a l e r i af skib', 'kunst'),
    ('Ma-leri', 'kunst'),
    ('Male-ri', 'kunst'),
    ('Mal3ri', 'kunst'),
    ('T3gning af Storm P', 'kunst'),
    ('L1tografi', 'kunst'),
    ('Sk0vmaleri', 'kunst'),
    ('Kun-st til væggen', 'kunst'),
    ('Plakat signeret af kunstneren', 'kunst'),
    ('Kunstner: Asger Jorn, plakat', 'kunst'),
    ('Plakat af maleri. Kunstner: Jorn', 'kunst'),
    ('Kunstlæder sofa, oliemaleri medfølger', 'kunst'),
    ('IKEA billede. Akvarel af skib', 'kunst'),
    ('Signeret bog. Litografi signeret', 'kunst'),
    ('Plakat af maleri. Maleri sælges også', 'kunst'),
    ('Gicleé print signeret', 'kunst'),
    ('Malerí af skib', 'kunst'),
    ('M@leri', 'kunst'),
    ('Akvar€l', 'kunst'),
    ('Ku1tegning', 'kunst'),
    ('L1togr@fi', 'kunst'),
    ('Kunstv-ærk', 'kunst'),
    ('Male-ri af skib', 'kunst'),
    ('Skulp.tur i træ', 'kunst'),
    ('ma leri', 'kunst'),
    ('mal eri af skib', 'kunst'),
    ('teg ning af Storm P', 'kunst'),
    ('Kultegning', 'kunst'),
    ('Blyantstegning', 'kunst'),
    ('Portrættegning af kvinde', 'kunst'),
    ('Billede malet i olie', 'kunst'),
    ('Billede i akryl', 'kunst'),
    ('Abstrakt billede, olie', 'kunst'),
    ('Oliemalet', 'kunst'),
    ('Silketryk signeret', 'kunst'),
    ('Silketryk', 'kunst'),
    ('Ætsning', 'kunst'),
    ('Statue af kvinde', 'kunst'),
    ('Bronze statue', 'kunst'),
    ('Fine art', 'kunst'),
    ('Wall art', 'kunst'),
    ('Gemälde', 'kunst'),
    ('Aquarelle', 'kunst'),
    ('Aquarell', 'kunst'),
    ('IKEA-maleri? Nej, oliemaleri', 'kunst'),
    ('Mаlеri af skib', 'kunst'),
    ('Skulрtur i træ', 'kunst'),
    ('ΜΑLERI', 'kunst'),
    ('ma le ri', 'kunst'),
    ('Flot ma le ri af skib', 'kunst'),
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
    ('', 'ok'),
    ('Signeret bog, 1. oplag', 'ok'),
    ('Bog signeret af forfatteren', 'ok'),
    ('Radering af tekst', 'ok'),
    ('Sikker radering af harddisk', 'ok'),
    ('Kunst og håndværk bog', 'ok'),
    ('Buste ramme', 'ok'),
    ('Tegning til børneværelse plakat', 'ok'),
    ('Porcelænsmaleri', 'ok'),
    ('Converse canvas sko', 'ok'),
    ('Canvas taske', 'ok'),
    ('Canvas print fra IKEA', 'ok'),
    ('Maleri fra Tiger', 'ok'),
    ('Billede købt i Normal', 'ok'),
    ('Drawing tablet Wacom', 'ok'),
    ('A3 tegneblok', 'ok'),
    ('PS4 med 3 spil', 'ok'),
    ('T-shirt str. M', 'ok'),
    ('H.C. Andersen eventyr', 'ok'),
    ('B & O højttaler', 'ok'),
    ('Canvas sko str 42', 'ok'),
    ('Canvas sneakers, originale', 'ok'),
    ('Canvas stol til haven', 'ok'),
    ('Canvas telt 4 personer', 'ok'),
    ('Canvas taske original', 'ok'),
    ('Lito lampe', 'ok'),
    ('Lito armatur til loft', 'ok'),
    ('Silketryk på t-shirt', 'ok'),
    ('Havestatue af løve', 'ok'),
    ('Statue i plastik', 'ok'),
    ('Byggetegning til carport', 'ok'),
    ('Plantegning af hus', 'ok'),
    ('Lærred til maleri, blankt', 'ok'),
    ('IKEA-maleri', 'ok'),
    ('Info@firma.dk', 'ok'),
    ('Mal er i god stand', 'ok'),
    ('Мама сумка', 'ok'),
    ('Sofa er i god stand, se billeder', 'ok')
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

drop function pg_temp.policy_tjek(text, text);
drop function pg_temp.ps_ret(text, text, text, jsonb);
drop function pg_temp.efter_tjek(text, text);
drop function pg_temp.drift_tjek(text, text, text);
drop function pg_temp.drift_tjek_flere(text, text[]);
drop function pg_temp.krop_md5(text);
drop function pg_temp.flet_check(regclass, text, text, text[]);

