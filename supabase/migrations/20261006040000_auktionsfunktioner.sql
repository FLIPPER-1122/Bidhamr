-- Auktionsfunktioner (fase 3, ROADMAP.md):
--
--   1. Forbudte varer: listen (public.forbudte_varer) og ordkontrollen
--      (public.forbudte_ord / public.forbudt_tekst_tjek) - HOLD SYNKRON med
--      src/lib/forbudteVarer.ts.
--        - "blokeret" (aabenlyst forbudt): oprettelse/redigering afvises.
--            * direkte insert/update (hjemmesiden, appen): fejlkode BHF01,
--              detail = jsonb {resultat, kategori, ord}
--            * rediger_auktion: kode 'forbudt_vare' (+ kategori, ord)
--        - "tvivl": auktionen oprettes, og staff faar en automatisk rapport
--          (reports.category = 'forbudt_vare', reporter = systembrugeren
--          BidHamr). Hoejst én aaben automatisk rapport pr. auktion.
--      auctions.forbudt_bekraeftet: saelgerens afkrydsning "Jeg bekraefter,
--      at varen ikke er forbudt" ved oprettelse. Gemmes, men kraeves IKKE af
--      databasen (appen sender den ikke endnu) - formularen kraever den.
--
--   2. Stand: auctions.stand (fandtes allerede med 'Ny'/'Som ny'/'Brugt'/
--      'Defekt' fra appen) er nu en kode:
--        ny_med_maerke | som_ny | god | brugt | defekt
--      Eksisterende raekker oversaettes ('Ny' -> 'ny_med_maerke' osv.), og
--      triggeren oversaetter fortsat appens gamle tekster ved skrivning
--      (public.stand_normaliser). Paakraevet ved NYE auktioner fra brugere
--      (fejlkode BHA03); gamle auktioner maa vaere null. Kan ikke saettes
--      tilbage til null. HOLD SYNKRON med src/lib/stand.ts.
--
--   3. Spoerg saelger: tabel auction_questions + RPC'er
--        stil_spoergsmaal(p_auktion, p_tekst)            authenticated
--        besvar_spoergsmaal(p_spoergsmaal, p_svar)       authenticated (saelger)
--        saet_spoergsmaal_aktiv(p_auktion, p_aktiv)      authenticated (saelger)
--        auktion_spoergsmaal_liste(p_auktion)            anon + authenticated
--        skjul_spoergsmaal(p_medarbejder, ...)           service_role (staff)
--      auctions.spoergsmaal_aktiv (default true). Links, e-mails,
--      telefonnumre og beskedtjenester afvises (public.indeholder_kontaktinfo,
--      bygger paa chattens spamfilter besked_spam_grund fra 20261006030000).
--      Blokerede brugere (er_blokeret_mellem) kan ikke spoerge. Rate-limit i databasen, saa
--      det ogsaa gaelder appen. Offentlig visning kun med fornavn + initial,
--      aldrig bruger-id. Ny notifikationstype 'spoergsmaal' (valgfri).
--
--   4. rediger_auktion: ny parameter p_stand (default null = uaendret). Den
--      gamle 7-parameter-version droppes, saa PostgREST ikke faar to
--      kandidater; kald med de gamle 7 navngivne parametre virker stadig.
--
-- Genskrevet ud fra seneste definition:
--   rediger_auktion           (seneste: 20261005021000) + p_stand + forbudte ord
--   notifikation_kendt_type   (seneste: 20261002060000) + 'spoergsmaal'
-- CHECK'er, der UDVIDES ved fletning (eksisterende vaerdier i databasen
-- bevares altid, ogsaa vaerdier tilfoejet af andre migrationer):
--   reports_category_check         + 'forbudt_vare'
--   moderation_log_handling_check  + 'spoergsmaal_skjult', 'spoergsmaal_vist'
--     (alle 37 vaerdier fra 20261006011000_fragt_rettelser.sql staar ogsaa
--      eksplicit herunder)
-- admin_forside_tal roeres ikke.
-- Idempotent. Koeres EFTER 20261006030000_tryghed_chat_kontakt.sql
-- (bruger besked_spam_grund, besked_normaliser og er_blokeret_mellem).
-- handle_new_bid roeres ikke.

-- ============================================================ 1. Kolonner

alter table public.auctions
  add column if not exists spoergsmaal_aktiv boolean not null default true,
  add column if not exists forbudt_bekraeftet boolean not null default false;

-- Appens gamle tekster -> koder. Ukendte vaerdier returneres uaendret (saa
-- CHECK'en afviser dem).
create or replace function public.stand_normaliser(p_stand text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select case lower(btrim(coalesce(p_stand, '')))
    when '' then null
    when 'ny' then 'ny_med_maerke'
    when 'ny med mærke' then 'ny_med_maerke'
    when 'ny med maerke' then 'ny_med_maerke'
    when 'ny_med_maerke' then 'ny_med_maerke'
    when 'som ny' then 'som_ny'
    when 'som_ny' then 'som_ny'
    when 'god' then 'god'
    when 'brugt' then 'brugt'
    when 'defekt' then 'defekt'
    else p_stand
  end;
$fn$;

grant execute on function public.stand_normaliser(text) to anon, authenticated, service_role;

alter table public.auctions drop constraint if exists auctions_stand_check;

update public.auctions
   set stand = public.stand_normaliser(stand)
 where stand is distinct from public.stand_normaliser(stand);

alter table public.auctions add constraint auctions_stand_check
  check (stand is null or stand in ('ny_med_maerke', 'som_ny', 'god', 'brugt', 'defekt'));

-- ============================================================ 2. Forbudte varer

-- Kategorierne paa /forbudte-varer. HOLD SYNKRON med FORBUDTE_KATEGORIER.
create or replace function public.forbudte_varer()
returns table (nr integer, kode text, navn text, beskrivelse text)
language sql
immutable
set search_path = public
as $fn$
  select * from (values
    (1, 'vaaben', 'Våben og ammunition', 'Skydevåben, dele til skydevåben, ammunition og krudt, springknive, butterflyknive, knojern, peberspray, strømpistoler og andre våben, der kræver tilladelse eller er forbudte i Danmark.'),
    (2, 'narkotika', 'Narkotika', 'Euforiserende stoffer af enhver art – også udstyr, frø og planter, der er beregnet til at fremstille eller bruge dem.'),
    (3, 'medicin', 'Medicin og doping', 'Receptpligtig medicin, håndkøbsmedicin, doping og anabolske steroider. Medicin må kun sælges af apoteker og godkendte forhandlere.'),
    (4, 'levende_dyr', 'Levende dyr', 'Alle levende dyr, fx hvalpe, killinger, kaniner, fugle, fisk og krybdyr.'),
    (5, 'forfalskninger', 'Forfalskninger og kopivarer', 'Kopier af mærkevarer, falske dokumenter, pas, ID-kort, kørekort, pengesedler og andet, der udgiver sig for at være ægte.'),
    (6, 'tobak_alkohol', 'Tobak og alkohol', 'Snus (forbudt at sælge i Danmark). Tobak, e-cigaretter og alkohol må aldrig sælges til personer under 18 år.'),
    (7, 'stjaalne', 'Stjålne varer', 'Stjålne varer og hælervarer – også varer, du har mistanke om er stjålet.'),
    (8, 'voksenindhold', 'Voksenindhold', 'Pornografi og andet seksuelt indhold, herunder brugt undertøj solgt som voksenindhold.'),
    (9, 'kemikalier', 'Farlige kemikalier og sprængstoffer', 'Sprængstoffer, fyrværkeri, giftige og ætsende kemikalier, kviksølv og asbest.'),
    (10, 'persondata', 'Personlige data og konti', 'CPR-numre, kortoplysninger, kundelister, MitID/NemID og login til brugerkonti – dine egne eller andres.'),
    (11, 'billetter', 'Billetter med videresalgsforbud', 'Billetter, som arrangøren ikke tillader videresalg af, og billetter solgt til mere end den oprindelige pris (billetloven).')
  ) as v(nr, kode, navn, beskrivelse);
$fn$;

-- Ordlisten. HOLD SYNKRON med FORBUDTE_ORD (samme raekkefoelge).
-- Moenstrene bruger kun: bogstaver, mellemrum, [..], ?, (a|b) - saa de
-- virker ens i JavaScript og Postgres.
create or replace function public.forbudte_ord()
returns table (kategori text, niveau text, moenster text)
language sql
immutable
set search_path = public
as $fn$
  select * from (values
    ('vaaben', 'blokeret', 'skydev[aå]ben'),
    ('vaaben', 'blokeret', 'skarpe patroner'),
    ('vaaben', 'blokeret', 'springkniv(e|en|ene)?'),
    ('vaaben', 'blokeret', 'faldkniv(e|en|ene)?'),
    ('vaaben', 'blokeret', 'butterflykniv(e|en|ene)?'),
    ('vaaben', 'blokeret', 'knojern'),
    ('vaaben', 'blokeret', 'peberspray'),
    ('vaaben', 'blokeret', 'str[oø]mpistol(er|en)?'),
    ('vaaben', 'blokeret', 'elpistol(er|en)?'),
    ('vaaben', 'blokeret', 'taser(e|en)?'),
    ('vaaben', 'blokeret', 'h[aå]ndgranat(er)?'),
    ('vaaben', 'blokeret', 'haglgev[aæ]r(et)?'),
    ('vaaben', 'blokeret', 'jagtriffel'),
    ('vaaben', 'tvivl', 'pistol(er|en)?'),
    ('vaaben', 'tvivl', 'revolver(e|en)?'),
    ('vaaben', 'tvivl', '(riffel|rifler)'),
    ('vaaben', 'tvivl', 'gev[aæ]r(et)?'),
    ('vaaben', 'tvivl', 'ammunition'),
    ('vaaben', 'tvivl', 'krudt'),
    ('vaaben', 'tvivl', 'armbr[oø]st'),
    ('vaaben', 'tvivl', 'kastekniv(e)?'),
    ('vaaben', 'tvivl', 'machete'),
    ('narkotika', 'blokeret', 'kokain'),
    ('narkotika', 'blokeret', 'heroin'),
    ('narkotika', 'blokeret', '(met)?amfetamin'),
    ('narkotika', 'blokeret', 'crystal meth'),
    ('narkotika', 'blokeret', 'mdma'),
    ('narkotika', 'blokeret', 'lsd'),
    ('narkotika', 'blokeret', 'fentanyl'),
    ('narkotika', 'blokeret', 'ghb'),
    ('narkotika', 'blokeret', 'psilocybin'),
    ('narkotika', 'tvivl', 'hash'),
    ('narkotika', 'tvivl', 'skunk'),
    ('narkotika', 'tvivl', 'cannabis'),
    ('narkotika', 'tvivl', 'thc'),
    ('narkotika', 'tvivl', 'ecstasy'),
    ('narkotika', 'tvivl', 'ketamin'),
    ('narkotika', 'tvivl', 'joints?'),
    ('narkotika', 'tvivl', 'growbox'),
    ('narkotika', 'tvivl', 'bongs?'),
    ('medicin', 'blokeret', 'receptpligtig(e)?'),
    ('medicin', 'blokeret', 'viagra'),
    ('medicin', 'blokeret', 'cialis'),
    ('medicin', 'blokeret', 'oxycodon'),
    ('medicin', 'blokeret', 'oxycontin'),
    ('medicin', 'blokeret', 'tramadol'),
    ('medicin', 'blokeret', 'morfin'),
    ('medicin', 'blokeret', 'stesolid'),
    ('medicin', 'blokeret', 'rivotril'),
    ('medicin', 'blokeret', 'xanax'),
    ('medicin', 'blokeret', 'ozempic'),
    ('medicin', 'blokeret', 'wegovy'),
    ('medicin', 'blokeret', '(anabolske )?steroider'),
    ('medicin', 'blokeret', 'testosteron'),
    ('medicin', 'tvivl', 'medicin'),
    ('medicin', 'tvivl', 'piller'),
    ('medicin', 'tvivl', 'sovepiller'),
    ('medicin', 'tvivl', 'kosttilskud'),
    ('levende_dyr', 'blokeret', 'levende dyr'),
    ('levende_dyr', 'tvivl', 'hvalp(e|en|ene)?'),
    ('levende_dyr', 'tvivl', '(katte)?killing(er|en|erne)?'),
    ('levende_dyr', 'tvivl', 'kanin(er|en|erne)?'),
    ('levende_dyr', 'tvivl', 'marsvin'),
    ('levende_dyr', 'tvivl', 'undulat(er)?'),
    ('levende_dyr', 'tvivl', 'hamster(e|en)?'),
    ('forfalskninger', 'blokeret', 'kopivare(r)?'),
    ('forfalskninger', 'blokeret', 'falske? (pas|id|k[oø]rekort|sedler|penge|dokumenter)'),
    ('forfalskninger', 'tvivl', 'replika'),
    ('forfalskninger', 'tvivl', 'replica'),
    ('forfalskninger', 'tvivl', 'fake'),
    ('forfalskninger', 'tvivl', 'kopi af'),
    ('tobak_alkohol', 'blokeret', 'snus'),
    ('tobak_alkohol', 'tvivl', '(e )?cigaret(ter)?'),
    ('tobak_alkohol', 'tvivl', 'vapes?'),
    ('tobak_alkohol', 'tvivl', 'tobak'),
    ('tobak_alkohol', 'tvivl', 'spiritus'),
    ('tobak_alkohol', 'tvivl', 'vodka'),
    ('tobak_alkohol', 'tvivl', 'alkohol'),
    ('stjaalne', 'blokeret', 'h[aæ]lervare(r)?'),
    ('stjaalne', 'blokeret', 'tyvekoster'),
    ('stjaalne', 'tvivl', 'stj[aå]l(et|ne)'),
    ('voksenindhold', 'blokeret', 'porno(film|grafi)?'),
    ('voksenindhold', 'blokeret', 'b[oø]rneporno'),
    ('voksenindhold', 'blokeret', 'onlyfans'),
    ('voksenindhold', 'tvivl', 'dildo(er)?'),
    ('voksenindhold', 'tvivl', 'sexleget[oø]j'),
    ('voksenindhold', 'tvivl', 'brugte trusser'),
    ('kemikalier', 'blokeret', 'spr[aæ]ngstof(fer)?'),
    ('kemikalier', 'blokeret', 'dynamit'),
    ('kemikalier', 'blokeret', 'nitroglycerin'),
    ('kemikalier', 'blokeret', 'cyanid'),
    ('kemikalier', 'blokeret', 'flussyre'),
    ('kemikalier', 'blokeret', 'asbest'),
    ('kemikalier', 'tvivl', 'fyrv[aæ]rkeri'),
    ('kemikalier', 'tvivl', 'kanonslag'),
    ('kemikalier', 'tvivl', 'kviks[oø]lv'),
    ('kemikalier', 'tvivl', 'pesticid(er)?'),
    ('persondata', 'blokeret', 'cpr ?(num(mer|re)|nr)'),
    ('persondata', 'blokeret', 'personnum(mer|re)'),
    ('persondata', 'blokeret', '(kreditkort|kort)oplysninger'),
    ('persondata', 'blokeret', 'kortdata'),
    ('persondata', 'blokeret', '(nemid|mitid)'),
    ('persondata', 'blokeret', 'kunde(database|kartotek)'),
    ('persondata', 'blokeret', 'e ?mail ?liste'),
    ('persondata', 'tvivl', 'konto til salg'),
    ('persondata', 'tvivl', '(netflix|spotify|steam|bruger) ?konto'),
    ('persondata', 'tvivl', 'login'),
    ('billetter', 'tvivl', 'billet(ter|ten|terne)?'),
    ('billetter', 'tvivl', '(koncert|festival|fodbold)billet(ter)?')
  ) as v(kategori, niveau, moenster);
$fn$;

-- Smaa bogstaver, NFC, og - _ . / samt gentagne mellemrum -> ét mellemrum.
-- Samme regel som normaliserTekst i TypeScript.
create or replace function public.forbudt_normaliser(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select regexp_replace(
           regexp_replace(lower(normalize(coalesce(p_tekst, ''), NFC)), '[-_./]+', ' ', 'g'),
           '[[:space:]]+', ' ', 'g');
$fn$;

-- {"resultat": "ok"} eller {"resultat": "blokeret"|"tvivl", "kategori", "ord"}.
-- Blokerede ord vinder over tvivl. Kun hele ord. Samme logik som
-- tjekForbudtTekst i TypeScript.
create or replace function public.forbudt_tekst_tjek(p_tekst text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_norm  text := public.forbudt_normaliser(p_tekst);
  v_tvivl jsonb;
  o       record;
  m       text[];
begin
  if v_norm = '' then
    return jsonb_build_object('resultat', 'ok');
  end if;
  for o in select * from public.forbudte_ord() loop
    m := regexp_match(v_norm,
           '(^|[^a-z0-9æøåäöüé])(' || o.moenster || ')($|[^a-z0-9æøåäöüé])');
    if m is null then continue; end if;
    if o.niveau = 'blokeret' then
      return jsonb_build_object('resultat', 'blokeret', 'kategori', o.kategori, 'ord', m[2]);
    end if;
    if v_tvivl is null then
      v_tvivl := jsonb_build_object('resultat', 'tvivl', 'kategori', o.kategori, 'ord', m[2]);
    end if;
  end loop;
  return coalesce(v_tvivl, jsonb_build_object('resultat', 'ok'));
end;
$fn$;

-- Rene funktioner uden dataadgang - appen maa gerne tjekke paa forhaand.
grant execute on function public.forbudte_varer()          to anon, authenticated, service_role;
grant execute on function public.forbudte_ord()            to anon, authenticated, service_role;
grant execute on function public.forbudt_normaliser(text)  to anon, authenticated, service_role;
grant execute on function public.forbudt_tekst_tjek(text)  to anon, authenticated, service_role;

-- ============================================================ 2b. reports: kategori 'forbudt_vare'

-- Fletter: alle vaerdier i den nuvaerende constraint bevares (ogsaa nye fra
-- andre migrationer) + de oprindelige + 'forbudt_vare'.
do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'reports_category_check' and c.conrelid = 'public.reports'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    -- Constrainten kan staa som ARRAY['a'::text, ...] eller som '{a,b}'::text[].
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array['ulovlig_vare', 'forfalsket_vare', 'spam_duplikat',
                        'stoedende_indhold', 'mistaenkelig_saelger', 'andet',
                        'forbudt_vare'])
  ) s;

  alter table public.reports drop constraint if exists reports_category_check;
  execute format(
    'alter table public.reports add constraint reports_category_check check (category = any (%L::text[]))',
    v_vals);
end $$;

-- ============================================================ 2c. Kontrol ved oprettelse/redigering

-- BEFORE insert/update: stand oversaettes altid; for brugere (hjemmeside og
-- app, ogsaa via rediger_auktion) kraeves stand ved oprettelse, og
-- aabenlyst forbudte ord afvises. service_role/cron springes over.
create or replace function public.auctions_indhold_kontrol()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v jsonb;
begin
  new.stand := public.stand_normaliser(new.stand);

  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.stand is null then
      raise exception 'Vælg varens stand.' using errcode = 'BHA03';
    end if;
  else
    -- Afkrydsningen hoerer til oprettelsen og kan ikke aendres bagefter.
    new.forbudt_bekraeftet := old.forbudt_bekraeftet;
    if old.stand is not null and new.stand is null then
      raise exception 'Vælg varens stand.' using errcode = 'BHA03';
    end if;
  end if;

  if tg_op = 'INSERT'
     or new.titel is distinct from old.titel
     or new.beskrivelse is distinct from old.beskrivelse then
    v := public.forbudt_tekst_tjek(coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, ''));
    if v->>'resultat' = 'blokeret' then
      raise exception 'Ordet "%" hører under forbudte varer og må ikke sælges på BidHamr.', v->>'ord'
        using errcode = 'BHF01', detail = v::text;
    end if;
  end if;

  return new;
end;
$fn$;

revoke execute on function public.auctions_indhold_kontrol() from public, anon, authenticated;

drop trigger if exists auctions_indhold_kontrol on public.auctions;
create trigger auctions_indhold_kontrol
  before insert or update on public.auctions
  for each row execute function public.auctions_indhold_kontrol();

-- AFTER insert/update: tvivlstilfaelde giver en automatisk rapport til staff.
-- Fejler rapporten, oprettes auktionen alligevel (advarsel i loggen).
create or replace function public.auctions_forbudt_rapport()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v      jsonb;
  v_navn text;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.titel is not distinct from old.titel
     and new.beskrivelse is not distinct from old.beskrivelse then
    return null;
  end if;

  v := public.forbudt_tekst_tjek(coalesce(new.titel, '') || ' ' || coalesce(new.beskrivelse, ''));
  if v->>'resultat' <> 'tvivl' then
    return null;
  end if;

  begin
    if exists (select 1 from public.reports r
                where r.auction_id = new.id
                  and r.category = 'forbudt_vare'
                  and r.status in ('pending', 'under_behandling')) then
      return null;
    end if;

    select f.navn into v_navn from public.forbudte_varer() f where f.kode = v->>'kategori';

    insert into public.reports (auction_id, reporter_id, category, description, status, created_at)
    values (new.id, public.bidhamr_system_id(), 'forbudt_vare',
            left(format('Automatisk kontrol: muligvis forbudt vare (%s). Ordet "%s" står i %s. '
                        || 'Auktionen er oprettet – vurdér, om den skal fjernes.',
                        coalesce(v_navn, v->>'kategori'), v->>'ord',
                        case when tg_op = 'INSERT' then 'titlen eller beskrivelsen'
                             else 'den rettede titel eller beskrivelse' end), 1000),
            'pending', now());
  exception when others then
    raise warning 'auctions_forbudt_rapport: rapport kunne ikke oprettes for %: %', new.id, sqlerrm;
  end;
  return null;
end;
$fn$;

revoke execute on function public.auctions_forbudt_rapport() from public, anon, authenticated;

drop trigger if exists auctions_forbudt_rapport on public.auctions;
create trigger auctions_forbudt_rapport
  after insert or update of titel, beskrivelse on public.auctions
  for each row execute function public.auctions_forbudt_rapport();

-- ============================================================ 3. rediger_auktion + stand + forbudte ord

drop function if exists public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean);

-- Som 20261005021000 + p_stand (null = uaendret) + forbudte ord (kode
-- 'forbudt_vare') + 'ugyldig_stand'.
create or replace function public.rediger_auktion(
  p_auktion           uuid,
  p_titel             text,
  p_beskrivelse       text,
  p_billeder          text[],
  p_kategori          text,
  p_startpris         numeric,
  p_forsendelse_mulig boolean,
  p_stand             text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  a       record;
  u       record;
  v_titel   text := btrim(coalesce(p_titel, ''));
  v_beskr   text := nullif(btrim(coalesce(p_beskrivelse, '')), '');
  v_kat     text := btrim(coalesce(p_kategori, ''));
  v_ver     timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_stand   text;
  v_forbudt jsonb;
begin
  if v_uid is null then
    raise exception 'Du skal være logget ind.' using errcode = '42501';
  end if;

  -- Laaser raekken: et samtidigt bud (handle_new_bid, "for update") venter,
  -- til redigeringen er faerdig, eller er naaet foerst og ses herunder.
  select * into a from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  select suspenderet, suspenderet_til into u from public.users where id = v_uid;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  if a.status <> 'aktiv' then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'slut');
  end if;
  if a."nuværende_bud" is not null
     or exists (select 1 from public.bids b where b.auktion_id = a.id) then
    return jsonb_build_object('kode', 'har_bud');
  end if;

  if char_length(v_titel) < 1 or char_length(v_titel) > 120 then
    return jsonb_build_object('kode', 'ugyldig_titel');
  end if;
  if v_beskr is not null and char_length(v_beskr) > 500 then
    return jsonb_build_object('kode', 'ugyldig_beskrivelse');
  end if;
  if not public.er_gyldig_auktionskategori(v_kat) then
    return jsonb_build_object('kode', 'ugyldig_kategori');
  end if;
  if p_startpris is null or p_startpris < 0 or p_startpris > 9999999999
     or p_startpris <> trunc(p_startpris) then
    return jsonb_build_object('kode', 'ugyldig_startpris');
  end if;
  -- Mindste startpris 1 kr - kun naar startprisen AENDRES, saa en gammel
  -- auktion med startpris 0 stadig kan faa rettet titel/billeder
  -- (samme regel som auctions_beskyt_kolonner).
  if p_startpris is distinct from a.startpris and p_startpris < 1 then
    return jsonb_build_object('kode', 'startpris_for_lav');
  end if;

  if not public.auktion_billeder_gyldige(v_uid, p_billeder) then
    return jsonb_build_object('kode', 'ugyldige_billeder');
  end if;

  -- NYT: stand. null = uaendret (gamle kaldere uden p_stand).
  v_stand := coalesce(public.stand_normaliser(p_stand), a.stand);
  if v_stand is not null
     and v_stand not in ('ny_med_maerke', 'som_ny', 'god', 'brugt', 'defekt') then
    return jsonb_build_object('kode', 'ugyldig_stand');
  end if;

  -- NYT: forbudte ord (samme kontrol som auctions_indhold_kontrol).
  v_forbudt := public.forbudt_tekst_tjek(v_titel || ' ' || coalesce(v_beskr, ''));
  if v_forbudt->>'resultat' = 'blokeret' then
    return jsonb_build_object('kode', 'forbudt_vare',
                              'kategori', v_forbudt->>'kategori',
                              'ord', v_forbudt->>'ord');
  end if;

  update public.auctions
     set titel             = v_titel,
         beskrivelse       = v_beskr,
         billeder          = p_billeder,
         kategori          = v_kat,
         startpris         = p_startpris,
         forsendelse_mulig = coalesce(p_forsendelse_mulig, false),
         stand             = v_stand,
         redigeret_kl      = v_ver
   where id = a.id;

  return jsonb_build_object('kode', 'ok', 'redigeret_kl', v_ver);
end;
$fn$;

revoke execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean, text)
  from public, anon;
grant execute on function public.rediger_auktion(uuid, text, text, text[], text, numeric, boolean, text)
  to authenticated;

-- ============================================================ 4. Spoerg saelger

create table if not exists public.auction_questions (
  id            uuid primary key default gen_random_uuid(),
  auction_id    uuid not null references public.auctions(id) on delete restrict,
  asker_id      uuid not null references public.users(id) on delete cascade,
  question      text not null check (char_length(question) between 3 and 500),
  answer        text check (answer is null or char_length(answer) between 1 and 1000),
  asked_at      timestamptz not null default now(),
  answered_at   timestamptz,
  hidden        boolean not null default false,
  hidden_by     uuid references public.users(id) on delete set null,
  hidden_at     timestamptz,
  hidden_reason text check (hidden_reason is null or char_length(hidden_reason) <= 500),
  constraint auction_questions_svar_tid check ((answer is null) = (answered_at is null))
);

comment on table public.auction_questions is
  'Spoerg saelger: spoergsmaal og svar paa auktioner. Kun via RPC''erne '
  'stil_spoergsmaal, besvar_spoergsmaal, auktion_spoergsmaal_liste og '
  'skjul_spoergsmaal (service_role). Slettes ikke - staff skjuler.';

create index if not exists auction_questions_auction_idx
  on public.auction_questions (auction_id, asked_at desc);
create index if not exists auction_questions_asker_idx
  on public.auction_questions (asker_id, asked_at desc);
create index if not exists auction_questions_answered_idx
  on public.auction_questions (answered_at) where answered_at is not null;

-- Ingen policies: browseren og appen bruger RPC'erne (bruger-id'er sendes
-- aldrig ud). service_role (notifikations-cron, admin) laeser.
alter table public.auction_questions enable row level security;
revoke all on public.auction_questions from public, anon, authenticated;
grant select on public.auction_questions to service_role;

-- Links, e-mails, telefonnumre og MobilePay-numre: samme regler som
-- spamfilteret i chatten (public.besked_spam_grund, 20261006030000) +
-- andre beskedtjenester (WhatsApp m.fl.), som i et offentligt spoergsmaal
-- kun bruges til at flytte handlen uden om BidHamr. (besked_mistaenkelig
-- bruges ikke: den rammer ogsaa "kan jeg betale med MobilePay?".)
-- TS-kopien i src/lib/kontaktInfo.ts er kun en advarsel, mens man skriver.
create or replace function public.indeholder_kontaktinfo(p_tekst text)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select public.besked_spam_grund(p_tekst) is not null
      or public.besked_normaliser(p_tekst)
         ~ '(whats ?app|telegram|snapchat|messenger|wechat|viber)';
$fn$;

revoke all on function public.indeholder_kontaktinfo(text) from public, anon;
grant execute on function public.indeholder_kontaktinfo(text) to authenticated, service_role;

-- Rydder tekst: fjerner usynlige tegn og retningsmaerker (saa de ikke kan
-- skjule en e-mail), og samler alle mellemrum/linjeskift til ét mellemrum.
create or replace function public.spoergsmaal_ryd_tekst(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select btrim(regexp_replace(
           regexp_replace(coalesce(p_tekst, ''),
                          '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F­​-‏‪-‮⁠-⁯﻿]', '', 'g'),
           '[[:space:]]+', ' ', 'g'));
$fn$;

revoke execute on function public.spoergsmaal_ryd_tekst(text) from public, anon;
grant execute on function public.spoergsmaal_ryd_tekst(text) to authenticated, service_role;

-- "Mads K." - samme regel som kortNavn i src/lib/kortNavn.ts.
create or replace function public.kort_visningsnavn(p_navn text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select case
    when btrim(coalesce(p_navn, '')) = '' then 'Anonym'
    else (select case when cardinality(d) = 1 then d[1]
                      else d[1] || ' ' || upper(left(d[2], 1)) || '.' end
            from (select regexp_split_to_array(btrim(p_navn), '[[:space:]]+') as d) x)
  end;
$fn$;

grant execute on function public.kort_visningsnavn(text) to anon, authenticated, service_role;

-- Koeberen stiller et spoergsmaal. Returnerer {"kode": "ok", "id", "dublet"?}
-- eller en fejlkode: ikke_logget_ind, suspenderet, konto_lukket, ikke_fundet,
-- egen_auktion, ikke_aktiv, slaaet_fra, blokeret, ugyldig_tekst, kontaktinfo,
-- for_mange, for_mange_ubesvarede.
-- Rate-limit: 5 pr. 10 minutter og 30 pr. doegn pr. bruger, og hoejst 3
-- ubesvarede pr. bruger pr. auktion. Samme tekst igen inden for et doegn
-- (dobbeltklik) giver det eksisterende spoergsmaal tilbage.
create or replace function public.stil_spoergsmaal(p_auktion uuid, p_tekst text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_tekst text := public.spoergsmaal_ryd_tekst(p_tekst);
  u       record;
  a       record;
  v_id    uuid;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;

  select suspenderet, suspenderet_til, konto_lukket_kl into u from public.users where id = v_uid;
  if not found then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  if u.konto_lukket_kl is not null then
    return jsonb_build_object('kode', 'konto_lukket');
  end if;
  if u.suspenderet and (u.suspenderet_til is null or u.suspenderet_til > now()) then
    return jsonb_build_object('kode', 'suspenderet');
  end if;

  select id, bruger_id, status, slutter_kl, skjult, arkiveret_kl, spoergsmaal_aktiv
    into a from public.auctions where id = p_auktion;
  if not found or a.skjult or a.arkiveret_kl is not null then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if a.bruger_id = v_uid then
    return jsonb_build_object('kode', 'egen_auktion');
  end if;
  if a.status <> 'aktiv' or a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if not a.spoergsmaal_aktiv then
    return jsonb_build_object('kode', 'slaaet_fra');
  end if;
  -- Blokering (20261006030000) i en af retningerne.
  if public.er_blokeret_mellem(a.bruger_id, v_uid) then
    return jsonb_build_object('kode', 'blokeret');
  end if;

  if char_length(v_tekst) < 3 or char_length(v_tekst) > 500 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;
  if public.indeholder_kontaktinfo(v_tekst) then
    return jsonb_build_object('kode', 'kontaktinfo');
  end if;

  -- Én ad gangen pr. bruger, saa taellingerne holder ved samtidige kald.
  perform pg_advisory_xact_lock(hashtextextended('auction_questions:' || v_uid::text, 0));

  select q.id into v_id from public.auction_questions q
   where q.asker_id = v_uid and q.auction_id = a.id and q.question = v_tekst
     and q.asked_at > now() - interval '1 day'
   limit 1;
  if v_id is not null then
    return jsonb_build_object('kode', 'ok', 'id', v_id, 'dublet', true);
  end if;

  if (select count(*) from public.auction_questions q
       where q.asker_id = v_uid and q.asked_at > now() - interval '10 minutes') >= 5
     or (select count(*) from public.auction_questions q
          where q.asker_id = v_uid and q.asked_at > now() - interval '1 day') >= 30 then
    return jsonb_build_object('kode', 'for_mange');
  end if;
  if (select count(*) from public.auction_questions q
       where q.asker_id = v_uid and q.auction_id = a.id
         and q.answer is null and not q.hidden) >= 3 then
    return jsonb_build_object('kode', 'for_mange_ubesvarede');
  end if;

  insert into public.auction_questions (auction_id, asker_id, question)
  values (a.id, v_uid, v_tekst)
  returning id into v_id;

  return jsonb_build_object('kode', 'ok', 'id', v_id);
end;
$fn$;

revoke execute on function public.stil_spoergsmaal(uuid, text) from public, anon;
grant execute on function public.stil_spoergsmaal(uuid, text) to authenticated;

-- Saelgeren svarer (én gang - svaret kan ikke rettes bagefter, saa det kan
-- bruges i en sag). Kun mens auktionen koerer. Fejlkoder: ikke_logget_ind,
-- ikke_fundet, suspenderet, skjult, ikke_aktiv, ugyldig_tekst, kontaktinfo,
-- allerede_besvaret.
create or replace function public.besvar_spoergsmaal(p_spoergsmaal uuid, p_svar text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid  uuid := auth.uid();
  v_svar text := public.spoergsmaal_ryd_tekst(p_svar);
  q      record;
  a      record;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;

  select * into q from public.auction_questions where id = p_spoergsmaal for update;
  if not found then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  select id, bruger_id, status, slutter_kl, skjult into a
    from public.auctions where id = q.auction_id;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if public.jeg_er_suspenderet() then
    return jsonb_build_object('kode', 'suspenderet');
  end if;
  if q.answer is not null then
    return jsonb_build_object('kode', 'allerede_besvaret');
  end if;
  if q.hidden then
    return jsonb_build_object('kode', 'skjult');
  end if;
  if a.status <> 'aktiv' or a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;
  if char_length(v_svar) < 1 or char_length(v_svar) > 1000 then
    return jsonb_build_object('kode', 'ugyldig_tekst');
  end if;
  if public.indeholder_kontaktinfo(v_svar) then
    return jsonb_build_object('kode', 'kontaktinfo');
  end if;

  update public.auction_questions
     set answer = v_svar, answered_at = now()
   where id = q.id and answer is null;
  if not found then
    return jsonb_build_object('kode', 'allerede_besvaret');
  end if;

  return jsonb_build_object('kode', 'ok');
end;
$fn$;

revoke execute on function public.besvar_spoergsmaal(uuid, text) from public, anon;
grant execute on function public.besvar_spoergsmaal(uuid, text) to authenticated;

-- Saelgeren slaar spoergsmaal til/fra - ogsaa efter foerste bud (aendrer ikke
-- redigeret_kl, saa bud ikke afvises). Fejlkoder: ikke_logget_ind,
-- ikke_fundet, suspenderet, ikke_aktiv.
create or replace function public.saet_spoergsmaal_aktiv(p_auktion uuid, p_aktiv boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  a     record;
begin
  if v_uid is null then
    return jsonb_build_object('kode', 'ikke_logget_ind');
  end if;
  select id, bruger_id, status, slutter_kl, skjult into a
    from public.auctions where id = p_auktion for update;
  if not found or a.bruger_id is distinct from v_uid or a.skjult then
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;
  if public.jeg_er_suspenderet() then
    return jsonb_build_object('kode', 'suspenderet');
  end if;
  if a.status <> 'aktiv' or a.slutter_kl <= now() then
    return jsonb_build_object('kode', 'ikke_aktiv');
  end if;

  update public.auctions
     set spoergsmaal_aktiv = coalesce(p_aktiv, true)
   where id = a.id and spoergsmaal_aktiv is distinct from coalesce(p_aktiv, true);

  return jsonb_build_object('kode', 'ok', 'aktiv', coalesce(p_aktiv, true));
end;
$fn$;

revoke execute on function public.saet_spoergsmaal_aktiv(uuid, boolean) from public, anon;
grant execute on function public.saet_spoergsmaal_aktiv(uuid, boolean) to authenticated;

-- Offentlig liste til auktionssiden. Ingen bruger-id'er: kun fornavn +
-- initial og "is_mine". Skjulte spoergsmaal ses kun af staff (hidden=true).
-- Samme synlighed som auktionen (skjult/arkiveret kun for saelger, staff og
-- parter med arkivadgang).
create or replace function public.auktion_spoergsmaal_liste(p_auktion uuid)
returns table (
  id          uuid,
  question    text,
  answer      text,
  asked_at    timestamptz,
  answered_at timestamptz,
  asker_name  text,
  is_mine     boolean,
  hidden      boolean)
language sql
stable
security definer
set search_path = public
as $fn$
  with mig as (
    select auth.uid() as uid,
           (auth.uid() is not null
            and public.staff_chat_har_rolle(auth.uid(), 'medarbejder')) as staff
  ),
  synlig as (
    select 1
      from public.auctions a, mig
     where a.id = p_auktion
       and (mig.staff
            or a.bruger_id = mig.uid
            or (not a.skjult
                and (a.arkiveret_kl is null
                     or (mig.uid is not null and public.auktion_arkiv_adgang(a.id)))))
  )
  select q.id, q.question, q.answer, q.asked_at, q.answered_at,
         public.kort_visningsnavn(u.navn),
         coalesce(q.asker_id = mig.uid, false),
         q.hidden
    from public.auction_questions q
    cross join mig
    left join public.users u on u.id = q.asker_id
   where q.auction_id = p_auktion
     and exists (select 1 from synlig)
     and (not q.hidden or mig.staff)
   order by q.asked_at desc
   limit 200;
$fn$;

revoke execute on function public.auktion_spoergsmaal_liste(uuid) from public;
grant execute on function public.auktion_spoergsmaal_liste(uuid) to anon, authenticated, service_role;

-- Staff skjuler/viser et spoergsmaal. Serveren udleder p_medarbejder af
-- sessionen og tjekker rollen (assertRole); funktionen tjekker igen.
-- Idempotent: 'uaendret', hvis spoergsmaalet allerede har den tilstand.
create or replace function public.skjul_spoergsmaal(
  p_medarbejder uuid,
  p_spoergsmaal uuid,
  p_skjul       boolean,
  p_aarsag      text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_grund text := nullif(btrim(coalesce(p_aarsag, '')), '');
  v_skjul boolean := coalesce(p_skjul, true);
  q       record;
begin
  if not public.staff_chat_har_rolle(p_medarbejder, 'medarbejder') then
    return jsonb_build_object('kode', 'ingen_adgang');
  end if;
  if v_skjul and v_grund is null then
    return jsonb_build_object('kode', 'begrundelse_mangler');
  end if;
  if v_grund is not null and char_length(v_grund) > 500 then
    return jsonb_build_object('kode', 'for_lang_tekst');
  end if;

  update public.auction_questions
     set hidden        = v_skjul,
         hidden_by     = p_medarbejder,
         hidden_at     = now(),
         hidden_reason = case when v_skjul then v_grund else hidden_reason end
   where id = p_spoergsmaal and hidden is distinct from v_skjul
  returning id, auction_id, asker_id, question into q;

  if not found then
    if exists (select 1 from public.auction_questions where id = p_spoergsmaal) then
      return jsonb_build_object('kode', 'uaendret');
    end if;
    return jsonb_build_object('kode', 'ikke_fundet');
  end if;

  insert into public.moderation_log (medarbejder_id, handling, maal_type, maal_id, bruger_id, aarsag)
  values (p_medarbejder,
          case when v_skjul then 'spoergsmaal_skjult' else 'spoergsmaal_vist' end,
          'auktion', q.auction_id, q.asker_id,
          left(case when v_skjul then 'Skjulte spørgsmål' else 'Viste spørgsmål igen' end
               || ': "' || left(q.question, 200) || '"'
               || coalesce(' | ' || v_grund, ''), 4000));

  return jsonb_build_object('kode', 'ok', 'auction_id', q.auction_id);
end;
$fn$;

revoke all on function public.skjul_spoergsmaal(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.skjul_spoergsmaal(uuid, uuid, boolean, text) to service_role;

-- ============================================================ 5. Notifikationstype 'spoergsmaal'

-- Som 20261002060000 + 'spoergsmaal' (valgfri). notifikation_paakraevet
-- er uaendret. HOLD SYNKRON med src/lib/notifikationer/typer.ts.
create or replace function public.notifikation_kendt_type(p_type text)
returns boolean
language sql immutable set search_path = public as $fn$
  select public.notifikation_paakraevet(p_type) or p_type = any (array[
    'overbudt', 'bud_paa_egen', 'like', 'fulgt_slutter_snart',
    'ny_auktion_fulgt_saelger', 'ny_besked', 'spoergsmaal'
  ]);
$fn$;

grant execute on function public.notifikation_kendt_type(text) to anon, authenticated, service_role;

-- ============================================================ 6. moderation_log

-- Fletter: alle vaerdier i den nuvaerende constraint bevares (ogsaa fra
-- andre migrationer), + de 37 fra 20261006011000_fragt_rettelser.sql
-- + 'spoergsmaal_skjult', 'spoergsmaal_vist'.
do $$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conname = 'moderation_log_handling_check'
     and c.conrelid = 'public.moderation_log'::regclass;

  select array_agg(distinct x order by x) into v_vals from (
    -- Constrainten kan staa som ARRAY['a'::text, ...] eller som '{a,b}'::text[].
    select unnest(case when m[1] like '{%}' then m[1]::text[] else array[m[1]] end) as x
      from regexp_matches(coalesce(v_def, ''), '''([^'']+)''', 'g') as m
    union
    select unnest(array[
      'slet_auktion','slet_anmeldelse','suspender','ophaev_suspension',
      'advarsel','annuller_auktion',
      'saldo_sat','saldo_tilfoert','saldo_traukket',
      'sag_aabnet','sag_lukket','handel_frigivet','handel_refunderet',
      'ubetalt_afvist','overfoersel_proevet_igen','betaling_loest',
      'chat_aabnet','chat_lukket','faellesbesked',
      'sag_afgjort_koeber','sag_afgjort_saelger','sag_retur_afleveret',
      'sag_genaabnet','konto_lukket','sag_afviklet',
      'indpakning_paamindelse','konto_lukning_foreslaaet','konto_lukning_afvist',
      'udbetalingskonto_loest',
      'udbetalingskonto_nulstillet',
      'rapport_behandlet',
      'sag_anke_indgivet','sag_anke_stadfaestet','sag_anke_omgjort',
      'chat_laest',
      'refusion_proevet_igen',
      'fragt_haandteret',
      'spoergsmaal_skjult','spoergsmaal_vist'])
  ) s;

  alter table public.moderation_log drop constraint if exists moderation_log_handling_check;
  execute format(
    'alter table public.moderation_log add constraint moderation_log_handling_check check (handling = any (%L::text[]))',
    v_vals);
end $$;
