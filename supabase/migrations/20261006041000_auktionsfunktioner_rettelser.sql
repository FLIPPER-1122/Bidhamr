-- Rettelser til 20261006040000_auktionsfunktioner.sql (fase 3, ROADMAP.md).
-- Koeres EFTER 20261006040000. Idempotent.
--
--   A. Forbudte varer: ny ordliste med langt faerre falske positiver.
--      HOLD SYNKRON med src/lib/forbudteVarer.ts (FORBUDTE_REGLER,
--      PLADSHOLDERE, normaliserTekst, tjekForbudtTekst).
--        - "blokeret" (BHF01 / 'forbudt_vare') kun for helt entydige
--          formuleringer.
--        - "tvivl" (automatisk rapport til staff) kun hvor der reelt er grund.
--        - Almindelige varer ("Kanin bur", "Vodka glas", "Nerf pistol",
--          "Kokain Bear DVD") giver hverken blokering eller rapport.
--      En regel har nu ogsaa "kraever" (skal OGSAA staa i teksten) og
--      "undtagen" (staar det i teksten, gaelder reglen ikke). Pladsholdere
--      (@medie, @vaaben, @dyr, @tilbehoer, @maerke, @alkohol, @legevaaben)
--      udfoldes af public.forbudt_ekspander.
--      public.forbudte_ord() faar nye kolonner (nr, kraever, undtagen) og
--      droppes derfor foerst.
--      Normalisering: usynlige tegn (U+00AD, U+200B-200F, U+202A-202E,
--      U+2060-206F, U+FEFF) fjernes som i spoergsmaal_ryd_tekst; al
--      tegnsaetning bliver til mellemrum (undtagen % og &); smaa bogstaver;
--      aeoeaa bevares.
--
--      TESTTABEL (koert som DO-blok sidst i filen - migrationen fejler, hvis
--      et eksempel giver et andet resultat; samme tabel koeres mod TS):
--        ok: "Dynamit-Harry DVD", "Olsen-banden på dynamit-tur",
--            "Eternitplader uden asbest", "Asbest-fri tagplader",
--            "Næsespray ikke receptpligtig", "Næsespray uden recept",
--            "Legepenge falske penge", "Kokain Bear DVD", "Testosteron bog",
--            "Snus dåse (tom)", "Hash brown-pande", "Skunk-jakke",
--            "Skunk Anansie CD", "Killing Eve DVD", "Kanin bur",
--            "Hamster bur med hjul", "Fake fur jakke",
--            "Replika af Titanic model", "Medicin skab", "Piller til pool",
--            "Nerf pistol", "Pistol Pete bog", "Krudt og kugler brætspil",
--            "Joint compound spartelmasse", "Ding Dong bong klokke",
--            "THC-fri CBD olie", "Vodka glas", "Alkohol tester",
--            "Cigaret etui", "Billet holder", "Login", "Vandpistol",
--            "Sex Pistols plakat", "iPhone 12", "Sofabord i eg",
--            "Gaming mus sælges", "Hvalpe kurv", "Kanin bur sælges"
--        tvivl (bevidst): "Gevær rack", "Kopi af Arne Jacobsen stol"
--        tvivl: "Haglgevær", "2 billetter til Roskilde Festival",
--            "Kanin til salg", "Flaske vodka", "Pistol", "Receptpligtig",
--            "Hash 5 gram", "Falsk Rolex", "10 dåser snus", "Hvalpe sælges"
--        blokeret: "Sælger strømpistol", "Springkniv sælges",
--            "Kokain 5 gram", "MitID kodeviser", "Falske 500-kr sedler",
--            "Skarp ammunition 9mm", "Ko<U+200B>kain 5 gram",
--            "KOKAIN<U+00AD> 5 gram", "Receptpligtig medicin sælges",
--            "Haglgevær med våbentilladelse"
--
--   B. Reviewer-fund:
--      M1  stand: ukendte gamle vaerdier saettes til null, foer CHECK'en
--          tilfoejes (saa migrationen aldrig fejler). Samme rettelse er
--          tilfoejet i 20261006040000 (ikke koert i produktion endnu).
--      M2  auctions.titel <= 120 og auctions.beskrivelse <= 500 tegn i
--          databasen (auctions_titel_laengde / auctions_beskrivelse_laengde).
--          Tilfoejes KUN, hvis alle eksisterende raekker overholder graensen -
--          ellers springes de over med en advarsel. (En NOT VALID-check
--          tjekkes stadig ved HVER opdatering af en raekke, saa en gammel
--          auktion med for lang tekst ville faa cron'ens statusskift til at
--          fejle.) auctions_indhold_kontrol afviser for lang tekst fra brugere
--          foer ordkontrollen: BHA04 (titel) / BHA05 (beskrivelse).
--      L1  rediger_auktion tjekker kun forbudte ord, naar titel eller
--          beskrivelse er aendret.
--      L2  besvar_spoergsmaal: lukket konto ('konto_lukket'), suspension og
--          blokering ('blokeret') mellem saelger og spoerger.
--          stil_spoergsmaal: 'saelger_utilgaengelig', hvis saelgerens konto
--          er lukket eller suspenderet.
--      L6  auction_questions: alle FK'er til users -> on delete restrict
--          (handelsdata slettes ikke).
--
-- Genskrevet ud fra seneste definition (20261006040000):
--   auctions_indhold_kontrol, rediger_auktion, stil_spoergsmaal,
--   besvar_spoergsmaal, forbudt_normaliser, forbudt_tekst_tjek, forbudte_ord.
-- Ingen CHECK-fletninger i denne migration (reports_category_check og
-- moderation_log_handling_check roeres ikke).

-- ============================================================ M1. Stand

alter table public.auctions drop constraint if exists auctions_stand_check;

update public.auctions
   set stand = public.stand_normaliser(stand)
 where stand is distinct from public.stand_normaliser(stand);

update public.auctions
   set stand = null
 where stand is not null
   and stand not in ('ny_med_maerke', 'som_ny', 'god', 'brugt', 'defekt');

alter table public.auctions add constraint auctions_stand_check
  check (stand is null or stand in ('ny_med_maerke', 'som_ny', 'god', 'brugt', 'defekt'));

-- ============================================================ M2. Laengde paa titel og beskrivelse

do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'auctions_titel_laengde'
                and conrelid = 'public.auctions'::regclass) then
    null;
  elsif exists (select 1 from public.auctions where char_length(titel) > 120) then
    raise warning 'auctions_titel_laengde ikke tilfoejet: % auktion(er) har en titel over 120 tegn',
      (select count(*) from public.auctions where char_length(titel) > 120);
  else
    alter table public.auctions
      add constraint auctions_titel_laengde check (char_length(titel) <= 120) not valid;
    alter table public.auctions validate constraint auctions_titel_laengde;
  end if;

  if exists (select 1 from pg_constraint
              where conname = 'auctions_beskrivelse_laengde'
                and conrelid = 'public.auctions'::regclass) then
    null;
  elsif exists (select 1 from public.auctions where char_length(beskrivelse) > 500) then
    raise warning 'auctions_beskrivelse_laengde ikke tilfoejet: % auktion(er) har en beskrivelse over 500 tegn',
      (select count(*) from public.auctions where char_length(beskrivelse) > 500);
  else
    alter table public.auctions
      add constraint auctions_beskrivelse_laengde check (char_length(beskrivelse) <= 500) not valid;
    alter table public.auctions validate constraint auctions_beskrivelse_laengde;
  end if;
end $$;

-- ============================================================ A. Forbudte varer

-- Pladsholdere i ordlisten. Raekkefoelgen er vigtig (@medie sidst, fordi
-- andre pladsholdere bruger den). HOLD SYNKRON med PLADSHOLDERE i
-- src/lib/forbudteVarer.ts.
create or replace function public.forbudt_ekspander(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select replace(replace(replace(replace(replace(replace(replace(p_tekst,
    '@legevaaben', '(vand|vandpistol|nerf|leget[oø]j|leget[oø]js|lim|limpistol|spr[oø]jte|spr[oø]jtepistol|maling|malerpistol|pete|start|startpistol|signal|signalpistol|kapsel|kapselpistol|knald|skum|massage|massagepistol|varmluft|varmluftpistol|silikone|fugepistol|lodde|loddepistol|@medie)'),
    '@tilbehoer', '(bur|bure|buret|kurv|seng|foder|leget[oø]j|t[oø]j|sele|halsb[aå]nd|snor|transportkasse|transportbur|kradsetr[aæ]|akvarie|terrarie|hus|bamse|bamser|figur|figurer|sk[aå]l|hegn|grind|kravleg[aå]rd|@medie)'),
    '@vaaben', '(pistol(er|en|erne)?|revolver(e|en|erne)?|riffel|riflen|rifler|gev[aæ]r(et|er|erne)?|haglgev[aæ]r(et|er|erne)?|jagtriffel|jagtgev[aæ]r(et)?|luftgev[aæ]r(et)?|luftpistol(en)?|salonriffel|skydev[aå]ben(et)?|h[aå]ndv[aå]ben)'),
    '@dyr', '(hvalp(e|en|ene)?|killing(er|en|erne)?|kattekilling(er|en)?|kanin(er|en|erne)?|marsvin|undulat(er|en)?|hamster(e|en|ne)?|kat(te|ten|tene)?|hund(e|en|ene)?|papeg[oø]je(r|n)?|kyllinger|h[oø]ns|h[oø]ner|slange(r|n)?|ilder(e|en)?|fugl(e|en)?|akvariefisk|chinchilla(er)?|gekko(er)?|skildpadde(r|n)?|f[oø]l|hest(e|en)?|pony(er|en)?|ged(er|en)?)'),
    '@maerke', '(louis vuitton|lv|gucci|prada|chanel|rolex|omega|cartier|herm[eè]s|dior|balenciaga|moncler|canada goose|nike|adidas|yeezy|jordan|supreme|off white|stone island|ralph lauren|hugo boss|burberry|versace|fendi|ysl|saint laurent|michael kors|ray ban|oakley|patek philippe|audemars piguet|tag heuer|breitling|hublot|bvlgari|bulgari|tiffany|pandora|apple|airpods|beats|arne jacobsen|louis poulsen|wegner|fritz hansen|poul henningsen|ph|vitra|eames|bang olufsen|b&o|georg jensen|royal copenhagen|lego|north face|ugg|dr martens|converse|new balance|goyard|bottega veneta|celine|givenchy|valentino|alexander mcqueen|rimowa|montblanc|swarovski|chrome hearts|bape|trapstar|corteiz)'),
    '@alkohol', '(vodka|whisky|whiskey|gin|rom|spiritus|vin|r[oø]dvin|hvidvin|ros[eé]vin|champagne|cava|prosecco|cognac|lik[oø]r|snaps|akvavit|[oø]l|tequila|absinth|brandy|calvados|portvin|sherry|mj[oø]d|cider|alkohol)'),
    '@medie', '(dvd|blu ray|bluray|bog|b[oø]ger|bogen|roman|film|filmen|cd|plakat|plakater|vinyl|lp|tegneserie|br[aæ]tspil|album|dokumentar|t shirt)');
$fn$;

-- Ordlisten (udfoldet). HOLD SYNKRON med FORBUDTE_REGLER (nr = raekkefoelge).
-- Moenstrene bruger kun: bogstaver, tal, mellemrum, % &, [..], ?, +, (a|b) -
-- saa de virker ens i JavaScript og Postgres.
drop function if exists public.forbudte_ord();

create function public.forbudte_ord()
returns table (nr integer, kategori text, niveau text, moenster text, kraever text, undtagen text)
language sql
immutable
set search_path = public
as $fn$
  select v.nr, v.kategori, v.niveau,
         public.forbudt_ekspander(v.moenster),
         public.forbudt_ekspander(v.kraever),
         public.forbudt_ekspander(v.undtagen)
    from (values
      (1, 'vaaben', 'blokeret', 'skarpe? (ammunition|patroner|skud)', null, '@medie'),
      (2, 'vaaben', 'blokeret', '@vaaben', '(skarp|skarpe|funktionsdygtig|funktionsdygtigt|funktionsdygtige|v[aå]bentilladelse|jagttegn)', '(@legevaaben|(ikke|uden|ingen) (krav om )?v[aå]bentilladelse|kr[aæ]ver ikke)'),
      (3, 'vaaben', 'blokeret', 'spr[aæ]ngstof(fer|ferne|fet)?', null, '@medie'),
      (4, 'vaaben', 'blokeret', 'h[aå]ndgranat(er|en|erne)?', null, '(attrap|deaktiveret|leget[oø]j|model|replika|kopi|dummy|@medie)'),
      (5, 'vaaben', 'blokeret', '(springkniv|faldkniv|butterflykniv)(e|en|ene)?', null, '@medie'),
      (6, 'vaaben', 'blokeret', 'knojern(et)?', null, '@medie'),
      (7, 'vaaben', 'blokeret', 'peberspray(en)?', null, '@medie'),
      (8, 'vaaben', 'blokeret', '(str[oø]mpistol|elpistol)(er|en|erne)?', null, '@medie'),
      (9, 'vaaben', 'blokeret', 'taser(e|en)?', null, '@medie'),
      (10, 'vaaben', 'tvivl', '@vaaben', null, '@legevaaben'),
      (11, 'vaaben', 'tvivl', 'h[aå]ndgranat(er|en|erne)?', null, '@medie'),
      (12, 'vaaben', 'tvivl', '(ammunition|krudt|haglpatroner|riffelpatroner|pistolpatroner)', null, '(krudt og kugler|@medie)'),
      (13, 'vaaben', 'tvivl', '(softgun|airsoft|armbr[oø]st|kastekniv(e)?|machete|kastestjerne(r)?)', null, '@medie'),
      (14, 'narkotika', 'blokeret', '(kokain|heroin|(met)?amfetamin|crystal meth|mdma|ecstasy|lsd|fentanyl|ghb|psilocybin)', null, '@medie'),
      (15, 'narkotika', 'tvivl', '(hash|skunk|joints?)', '(gram|[0-9]+ ?g|ryge|rygning|thc|cannabis|weed|marihuana|tjald|grinder|rullepapir|bong|stoned|high)', '(hash browns?|hashtag|skunk anansie|joint compound|@medie)'),
      (16, 'narkotika', 'tvivl', 'bongs?', '(glas|ryge|rygning|cannabis|thc|weed|hash|skunk|percolator|bowl|vandpibe)', null),
      (17, 'narkotika', 'tvivl', '(cannabis|marihuana|marijuana|weed|ketamin)', null, '@medie'),
      (18, 'narkotika', 'tvivl', 'thc', null, '(thc fri|fri for thc|uden thc|ingen thc|0 ?% thc|@medie)'),
      (19, 'narkotika', 'tvivl', '(growbox|growtelt|grow telt)', null, null),
      (20, 'medicin', 'blokeret', 'receptpligtig(e|t)? (medicin|piller|tabletter|l[aæ]gemidler|l[aæ]gemiddel|pr[aæ]parat(er)?)', null, '(ikke|uden|ej) receptpligtig(e|t)?'),
      (21, 'medicin', 'blokeret', '(viagra|cialis|oxycodon|oxycontin|tramadol|morfin|stesolid|rivotril|xanax|ozempic|wegovy|anabolske steroider)', null, '@medie'),
      (22, 'medicin', 'tvivl', 'receptpligtig(e|t)?', null, '(ikke|uden|ej) receptpligtig(e|t)?'),
      (23, 'medicin', 'tvivl', '(testosteron|steroider|sovepiller|smertestillende|doping|sarms)', null, '@medie'),
      (24, 'medicin', 'tvivl', '(medicin|piller|tabletter) (s[aæ]lges|til salg)', null, null),
      (25, 'levende_dyr', 'tvivl', '@dyr (til salg|s[aæ]lges|gives v[aæ]k|s[oø]ger (nyt )?hjem|til adoption)', null, '@tilbehoer'),
      (26, 'levende_dyr', 'tvivl', '(s[aæ]lger|s[aæ]lges|giver|gives) (min |mine |vores |en |et |to |tre |[0-9]+ )?@dyr', null, '@tilbehoer'),
      (27, 'levende_dyr', 'tvivl', '@dyr', '(levende|stamtavle|stambog|vaccineret|vaccinerede|chippet|chippede|ormekur|ormekureret|nyt hjem|uger gammel|uger gamle|m[aå]neder gammel|m[aå]neder gamle|mdr gammel|mdr gamle|renracet|renracede|opdr[aæ]tter|kuld|hvalpekuld)', '@tilbehoer'),
      (28, 'levende_dyr', 'tvivl', 'hvalp(e|en|ene)?', null, '@tilbehoer'),
      (29, 'levende_dyr', 'tvivl', 'levende dyr', null, '@medie'),
      (30, 'forfalskninger', 'blokeret', '(falske?|forfalske(de|t)) ([0-9]+ ?(kr|kroner|euro|dollar|usd|eur) )?(pas|id kort|idkort|id|k[oø]rekort|sedler|pengesedler|penge|eurosedler|dollarsedler|dokumenter|eksamensbeviser|eksamensbevis|recepter|sundhedskort|sygesikringskort)', null, '(legepenge|leget[oø]j|filmpenge|rekvisit|filmrekvisit|monopoly|@medie)'),
      (31, 'forfalskninger', 'tvivl', '(falsk|falske|fake|kopi|kopier|replika|replikaer|replica|copy|aaa) (af )?@maerke', null, null),
      (32, 'forfalskninger', 'tvivl', '@maerke (kopi|kopier|replika|replica|fake|falsk|falske)', null, null),
      (33, 'forfalskninger', 'tvivl', 'kopivare(r|rne)?', null, null),
      (34, 'tobak_alkohol', 'tvivl', 'snus', null, '(snus d[aå]se|tom|tomme|etui|@medie)'),
      (35, 'tobak_alkohol', 'tvivl', '(cigaret|cigaretter|cigaretterne|cigar|cigarer|cigarillos)', null, '(etui|etuier|holder|t[aæ]nder|[aæ]ske|rullemaskine|maskine|askeb[aæ]ger|tom|tomme|@medie)'),
      (36, 'tobak_alkohol', 'tvivl', '(tobak|pibetobak|rulletobak)', null, '(tobak(s)? ?(pung|d[aå]se|krukke|kasse)|tom|tomme|@medie)'),
      (37, 'tobak_alkohol', 'tvivl', '(e cigaret|e cigaretter|vape|vapes|e juice|nikotinposer|nikotinpuder)', null, '(tom|tomme|@medie)'),
      (38, 'tobak_alkohol', 'tvivl', '(flaske|flasker|fl|kasse|kasser|karton|dunk|[0-9]+ ?(cl|ml|l|liter)) (med )?@alkohol', null, '(tom|tomme|glas|attrap)'),
      (39, 'tobak_alkohol', 'tvivl', '@alkohol (flaske|flasker|[0-9]+ ?(cl|ml|l|liter)|s[aæ]lges|til salg)', null, '(tom|tomme|glas|attrap)'),
      (40, 'stjaalne', 'blokeret', '(h[aæ]lervare(r)?|tyvekoster|tyvegods)', null, '((ikke|ingen) (h[aæ]lervare(r)?|tyvekoster|tyvegods)|@medie)'),
      (41, 'stjaalne', 'blokeret', '(stj[aå]lne|stj[aå]let|stj[aå]lede) (varer|vare|gods|telefon|telefoner|mobil|mobiler|iphone|iphones|cykel|cykler|elcykel|elcykler|computer|computere)', null, '((ikke|aldrig) stj[aå]l(et|ne)|@medie)'),
      (42, 'stjaalne', 'tvivl', 'stj[aå]l(et|ne|ede)', null, '((ikke|aldrig) stj[aå]l(et|ne)|blev stj[aå]let|er blevet stj[aå]let|stj[aå]let fra (mig|os)|@medie)'),
      (43, 'voksenindhold', 'blokeret', '(porno(film|grafi|blade)?|b[oø]rneporno|onlyfans)', null, null),
      (44, 'voksenindhold', 'tvivl', '(dildo(er)?|sexleget[oø]j|brugte trusser)', null, null),
      (45, 'kemikalier', 'blokeret', 'dynamit(ten)?', null, '(harry|banden|olsen|@medie)'),
      (46, 'kemikalier', 'blokeret', '(semtex|cyanid)', null, '@medie'),
      (47, 'kemikalier', 'tvivl', 'asbest', null, '(asbest fri|asbestfri|asbestfrie|uden asbest|fri for asbest|ingen asbest|ikke asbest|asbest testet|asbesttestet)'),
      (48, 'kemikalier', 'tvivl', '(fyrv[aæ]rkeri|kanonslag|nitroglycerin|flussyre|kviks[oø]lv|pesticid(er)?|spr[oø]jtegift|rottegift|klorat)', null, '(uden kviks[oø]lv|@medie)'),
      (49, 'persondata', 'blokeret', 'cpr ?(num(mer|re)|nr)', null, '(uden|ikke|ingen|intet) cpr'),
      (50, 'persondata', 'blokeret', '((kreditkort|kort|betalingskort)oplysninger|kortdata|kortnumre)', null, null),
      (51, 'persondata', 'blokeret', '(mitid|nemid|mit id|nem id) ?(kodeviser|kodeopl[aæ]ser|n[oø]glekort|n[oø]gleapp|login|konto|bruger|kode|koder|adgang|oplysninger)', null, null),
      (52, 'persondata', 'blokeret', '(kodeviser|kodeopl[aæ]ser|n[oø]glekort) (til )?(mitid|nemid|mit id|nem id)', null, null),
      (53, 'persondata', 'blokeret', '(kunde(database|kartotek|liste|lister|data)|e ?mail ?liste(r)?)', null, null),
      (54, 'persondata', 'tvivl', 'kodeviser(en|e)?', null, null),
      (55, 'persondata', 'tvivl', '(konto til salg|(netflix|spotify|steam|instagram|tiktok|fortnite|snapchat|facebook|bruger|gaming|psn|hbo|disney) ?konto(en)?|(login|loginoplysninger|adgangskode|password) (til|p[aå]))', null, null),
      (56, 'billetter', 'tvivl', 'billet(ter|ten|terne)? til', null, null),
      (57, 'billetter', 'tvivl', '(koncert|festival|fodbold|teater|landskamp|vip)billet(ter|ten|terne)?', null, null),
      (58, 'billetter', 'tvivl', 'billet(ter|ten|terne)? (s[aæ]lges|til salg)', null, null)
    ) as v(nr, kategori, niveau, moenster, kraever, undtagen)
   order by v.nr;
$fn$;

-- Smaa bogstaver, NFC, usynlige tegn fjernes, alt andet end bogstaver, tal,
-- % og & bliver til mellemrum, gentagne mellemrum til ét. Samme regel som
-- normaliserTekst i TypeScript.
create or replace function public.forbudt_normaliser(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(normalize(coalesce(p_tekst, ''), NFC)),
                            '[­​-‏‪-‮⁠-⁯﻿]', '', 'g'),
             '[^a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß%& ]+', ' ', 'g'),
           ' +', ' ', 'g'));
$fn$;

-- {"resultat": "ok"} eller {"resultat": "blokeret"|"tvivl", "kategori", "ord"}.
-- Blokeret vinder over tvivl; ved flere tvivl vises den foerste. Kun hele
-- ord. Samme logik som tjekForbudtTekst i TypeScript.
create or replace function public.forbudt_tekst_tjek(p_tekst text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
declare
  g       constant text := '[^a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß]';
  v_norm  text := public.forbudt_normaliser(p_tekst);
  v_tvivl jsonb;
  o       record;
  m       text[];
begin
  if v_norm = '' then
    return jsonb_build_object('resultat', 'ok');
  end if;
  for o in select * from public.forbudte_ord() f order by f.nr loop
    m := regexp_match(v_norm, '(^|' || g || ')(' || o.moenster || ')($|' || g || ')');
    if m is null then continue; end if;
    if o.kraever is not null
       and v_norm !~ ('(^|' || g || ')(' || o.kraever || ')($|' || g || ')') then
      continue;
    end if;
    if o.undtagen is not null
       and v_norm ~ ('(^|' || g || ')(' || o.undtagen || ')($|' || g || ')') then
      continue;
    end if;
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
grant execute on function public.forbudt_ekspander(text)   to anon, authenticated, service_role;
grant execute on function public.forbudte_ord()            to anon, authenticated, service_role;
grant execute on function public.forbudt_normaliser(text)  to anon, authenticated, service_role;
grant execute on function public.forbudt_tekst_tjek(text)  to anon, authenticated, service_role;

-- ============================================================ M2. auctions_indhold_kontrol

-- Som 20261006040000 + laengdekontrol (BHA04/BHA05) foer ordkontrollen.
-- Laengden tjekkes kun ved oprettelse, og naar teksten aendres, saa en gammel
-- auktion med lang tekst stadig kan faa rettet andre felter.
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

  if tg_op = 'INSERT' or new.titel is distinct from old.titel then
    if char_length(coalesce(new.titel, '')) > 120 then
      raise exception 'Titlen må højst være 120 tegn.' using errcode = 'BHA04';
    end if;
  end if;
  if tg_op = 'INSERT' or new.beskrivelse is distinct from old.beskrivelse then
    if char_length(coalesce(new.beskrivelse, '')) > 500 then
      raise exception 'Beskrivelsen må højst være 500 tegn.' using errcode = 'BHA05';
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

-- ============================================================ L1. rediger_auktion

-- Som 20261006040000, men forbudte ord tjekkes kun, naar titel eller
-- beskrivelse er aendret (en gammel auktion kan faa rettet pris/billeder).
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

  -- Stand. null = uaendret (gamle kaldere uden p_stand).
  v_stand := coalesce(public.stand_normaliser(p_stand), a.stand);
  if v_stand is not null
     and v_stand not in ('ny_med_maerke', 'som_ny', 'god', 'brugt', 'defekt') then
    return jsonb_build_object('kode', 'ugyldig_stand');
  end if;

  -- Forbudte ord - kun naar teksten aendres (samme regel som
  -- auctions_indhold_kontrol, som ogsaa koerer ved selve opdateringen).
  if v_titel is distinct from a.titel or v_beskr is distinct from a.beskrivelse then
    v_forbudt := public.forbudt_tekst_tjek(v_titel || ' ' || coalesce(v_beskr, ''));
    if v_forbudt->>'resultat' = 'blokeret' then
      return jsonb_build_object('kode', 'forbudt_vare',
                                'kategori', v_forbudt->>'kategori',
                                'ord', v_forbudt->>'ord');
    end if;
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

-- ============================================================ L2. Spoerg saelger

-- Som 20261006040000 + 'saelger_utilgaengelig', hvis saelgerens konto er
-- lukket eller suspenderet.
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
  s       record;
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

  -- NYT: saelgeren kan ikke svare, hvis kontoen er lukket eller suspenderet.
  select suspenderet, suspenderet_til, konto_lukket_kl into s from public.users where id = a.bruger_id;
  if not found
     or s.konto_lukket_kl is not null
     or (s.suspenderet and (s.suspenderet_til is null or s.suspenderet_til > now())) then
    return jsonb_build_object('kode', 'saelger_utilgaengelig');
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

-- Som 20261006040000 + lukket konto ('konto_lukket') og blokering
-- ('blokeret') mellem saelger og spoerger. Fejlkoder: ikke_logget_ind,
-- ikke_fundet, konto_lukket, suspenderet, blokeret, allerede_besvaret,
-- skjult, ikke_aktiv, ugyldig_tekst, kontaktinfo.
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
  u      record;
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
  if public.er_blokeret_mellem(v_uid, q.asker_id) then
    return jsonb_build_object('kode', 'blokeret');
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

-- ============================================================ L6. auction_questions: FK'er til users

-- Alle FK'er fra auction_questions til users (asker_id, hidden_by) bliver
-- "on delete restrict": spoergsmaal og svar er handelsdata og slettes ikke.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'public.auction_questions'::regclass
       and con.contype = 'f'
       and con.confrelid = 'public.users'::regclass
       and con.confdeltype <> 'r'
  loop
    execute format('alter table public.auction_questions drop constraint %I', c.conname);
  end loop;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.auction_questions'::regclass
                    and conname = 'auction_questions_asker_id_fkey') then
    alter table public.auction_questions
      add constraint auction_questions_asker_id_fkey
      foreign key (asker_id) references public.users(id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.auction_questions'::regclass
                    and conname = 'auction_questions_hidden_by_fkey') then
    alter table public.auction_questions
      add constraint auction_questions_hidden_by_fkey
      foreign key (hidden_by) references public.users(id) on delete restrict;
  end if;
end $$;

-- ============================================================ Test af ordlisten

-- Fejler migrationen, hvis et eksempel giver et andet resultat end forventet.
-- Samme tabel koeres mod tjekForbudtTekst i TypeScript.
do $$
declare
  t record;
  r text;
  v_fejl text := '';
begin
  for t in select * from (values
    ('Dynamit-Harry DVD', 'ok'),
    ('Olsen-banden på dynamit-tur', 'ok'),
    ('Eternitplader uden asbest', 'ok'),
    ('Asbest-fri tagplader', 'ok'),
    ('Næsespray ikke receptpligtig', 'ok'),
    ('Næsespray uden recept', 'ok'),
    ('Legepenge falske penge', 'ok'),
    ('Kokain Bear DVD', 'ok'),
    ('Testosteron bog', 'ok'),
    ('Snus dåse (tom)', 'ok'),
    ('Hash brown-pande', 'ok'),
    ('Skunk-jakke', 'ok'),
    ('Skunk Anansie CD', 'ok'),
    ('Killing Eve DVD', 'ok'),
    ('Kanin bur', 'ok'),
    ('Hamster bur med hjul', 'ok'),
    ('Fake fur jakke', 'ok'),
    ('Replika af Titanic model', 'ok'),
    ('Medicin skab', 'ok'),
    ('Piller til pool', 'ok'),
    ('Nerf pistol', 'ok'),
    ('Pistol Pete bog', 'ok'),
    ('Krudt og kugler brætspil', 'ok'),
    ('Joint compound spartelmasse', 'ok'),
    ('Ding Dong bong klokke', 'ok'),
    ('THC-fri CBD olie', 'ok'),
    ('Vodka glas', 'ok'),
    ('Alkohol tester', 'ok'),
    ('Cigaret etui', 'ok'),
    ('Billet holder', 'ok'),
    ('Login', 'ok'),
    ('Vandpistol', 'ok'),
    ('Sex Pistols plakat', 'ok'),
    ('iPhone 12', 'ok'),
    ('Sofabord i eg', 'ok'),
    ('Gaming mus sælges', 'ok'),
    ('Hvalpe kurv', 'ok'),
    ('Kanin bur sælges', 'ok'),
    ('Gevær rack', 'tvivl'),
    ('Kopi af Arne Jacobsen stol', 'tvivl'),
    ('Sælger strømpistol', 'blokeret'),
    ('Springkniv sælges', 'blokeret'),
    ('Kokain 5 gram', 'blokeret'),
    ('MitID kodeviser', 'blokeret'),
    ('Falske 500-kr sedler', 'blokeret'),
    ('Skarp ammunition 9mm', 'blokeret'),
    (E'Ko\u200Bkain 5 gram', 'blokeret'),
    (E'KOKAIN\u00AD 5 gram', 'blokeret'),
    ('Receptpligtig medicin sælges', 'blokeret'),
    ('Haglgevær med våbentilladelse', 'blokeret'),
    ('Haglgevær', 'tvivl'),
    ('2 billetter til Roskilde Festival', 'tvivl'),
    ('Kanin til salg', 'tvivl'),
    ('Flaske vodka', 'tvivl'),
    ('Pistol', 'tvivl'),
    ('Receptpligtig', 'tvivl'),
    ('Hash 5 gram', 'tvivl'),
    ('Falsk Rolex', 'tvivl'),
    ('10 dåser snus', 'tvivl'),
    ('Hvalpe sælges', 'tvivl')
  ) as x(tekst, forventet)
  loop
    r := public.forbudt_tekst_tjek(t.tekst)->>'resultat';
    if r is distinct from t.forventet then
      v_fejl := v_fejl || format(E'\n  %s: forventet %s, fik %s', t.tekst, t.forventet, r);
    end if;
  end loop;
  if v_fejl <> '' then
    raise exception 'Ordlisten for forbudte varer giver forkerte resultater:%', v_fejl;
  end if;
end $$;
