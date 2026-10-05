-- Forbudte varer skaerpet (Filip, 6. oktober 2026 - ROADMAP-BESLUTNINGER.md
-- "Forbudte varer"). Koeres EFTER 20261006041000. Idempotent (create or
-- replace, drop/create af forbudte_ord og en test-DO-blok).
--
-- Ny regel:
--   - ALLE ulovlige varer blokeres med det samme ved oprettelse/redigering
--     (BHF01 / 'forbudt_vare').
--   - Lovlige men foelsomme varer giver en automatisk rapport til staff
--     ("tvivl"). Billetter giver ALTID en rapport.
--
-- Flyttet fra "tvivl" til "blokeret":
--   - Skydevaaben og vaabendele: pistol, revolver, gevaer, riffel,
--     haglgevaer, jagtgevaer, Glock/AK 47/AR 15/Uzi/MP5, "vaabendele".
--     Luftvaaben (luftgevaer/luftpistol) blokeres altid - vi kan ikke se
--     kaliber/energi ud fra teksten.
--     Undtagelser: legetoej/vaerktoej (@legevaaben: vandpistol, Nerf,
--     limpistol, sproejtepistol, "Pistol Pete", medier ...) giver hverken
--     blokering eller rapport. Tilbehoer, attrapper og softguns
--     (@vaabenundtagen: rack, stativ, vaabenskab, hylster, sigtekikkert,
--     replika, softgun, airsoft, paintball ...) giver rapport.
--   - Ammunition (ammunition, hagl-/riffel-/pistol-/jagt-/salonpatroner) og
--     krudt som vare (sortkrudt, roegfrit krudt, "krudt til/saelges",
--     "krudt 500 g"). Tom emballage/attrapper og "Krudt og kugler" undtaget.
--     Ordet "krudt" alene giver stadig kun rapport.
--   - Narkotika i drug-kontekst: hash/skunk/joint med fx gram/THC/ryge,
--     bong med fx hash/THC/ryge, cannabis/marihuana/ketamin (CBD/hamp ->
--     rapport), THC (CBD -> rapport; "THC-fri" -> ok). Eksisterende
--     undtagelser (medier, hash brown, Skunk Anansie, joint compound ...)
--     bevares. Bong med kun glas/percolator -> rapport.
--   - Receptpligtig medicin som vare (var allerede blokeret).
--   - Falske maerkevarer: "falsk/fake/AAA <maerke>" og "<maerke> fake/falsk".
--     "Kopi/replika af <maerke>" (fx en designklassiker) forbliver rapport.
--   - Levende dyr (Filip, 6. oktober 2026): alle dyre-regler er nu blokeret
--     ("Kanin til salg", "Hvalpe saelges", "Kattekilling", "Akvariefisk" ...).
--     Tilbehoer (@tilbehoer: bur, kurv, foder, akvarium, snor, sadel ...)
--     giver hverken blokering eller rapport. "slange" er fjernet fra @dyr
--     (haveslange); i stedet pyton/kongepyton/kornsnog.
-- Forbliver rapport: billetter (nye regler: billet + koncert/festival/
-- kamp/stadion/raekke/saede ..., e-billet, ticket(s)), alkohol, tobak,
-- softguns/armbroest/machete, vaabentilbehoer, kopier/replikaer.
--
-- Smuthul lukket (review): et tilbehoers-/undtagelsesord et sted i teksten
-- maa ikke goere et dyr/vaaben lovligt ("Hest til salg inkl. trailer",
-- "Pistol med hylster", "Hvalpe saelges med kurv"). Nyt felt "fjern" i
-- forbudte_ord(): fraser, hvor tilbehoeret staar LIGE ved dyre-/vaabenordet
-- ("kanin bur", "bur til kanin", "gevaer rack", "nerf pistol"), fjernes fra
-- teksten, foer reglens moenster tjekkes. Staar dyret/vaabnet ogsaa et andet
-- sted (fx "Hvalpe kurv. Hvalpe saelges"), rammes det stadig. Nye
-- dyre-regler: "Kanin med bur", "Bur inkl. kanin", "Bur med 2 kaniner".
-- "+" normaliseres til " og " ("Hvalp + kurv" er ikke "Hvalp kurv").
-- Medier et sted i teksten undtager stadig vaaben-blokeringen, men giver nu
-- rapport ("Beatles Revolver, original 1966 LP").
--
-- Rapportteksten (auctions_forbudt_rapport) afhaenger nu af kategorien:
-- billetter og alkohol/tobak er "tjek at salget er lovligt", ikke "muligvis
-- forbudt vare".
--
-- HOLD SYNKRON med src/lib/forbudteVarer.ts (PLADSHOLDERE, FORBUDTE_REGLER,
-- FORBUDTE_KATEGORIER, normaliserTekst, tjekForbudtTekst). Ordlisten herunder
-- er genereret ud fra TS-listen.
-- Genskrevet ud fra seneste definition (20261006041000 / 20261006040000):
--   forbudt_ekspander, forbudte_ord (+ kolonnen fjern), forbudte_varer,
--   forbudt_normaliser, forbudt_tekst_tjek, auctions_forbudt_rapport.
-- auctions_indhold_kontrol og rediger_auktion er uaendrede og bruger
-- automatisk den nye liste.

-- ============================================================ Pladsholdere

-- Raekkefoelgen er vigtig: en pladsholder, der indeholder andre (fx
-- @fjerndyr -> @dyr, @tilbehoer), skal komme foer dem, og @medie sidst.
create or replace function public.forbudt_ekspander(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(p_tekst,
    '@fjerndyr', '(@dyr @tilbehoer|@tilbehoer (til|for|om|af) (min |mine |vores |din |dine |en |et |@tal )?@dyr( (og|eller) (en |et |@tal )?@dyr)?|(bamse|bamser|figur|figurer|leget[oø]j|schleich|lego|playmobil|duplo|sylvanian|@medie) @dyr|little pony(er|en)?)'),
    '@fjernlege', '(@legevaaben (til |for )?@vaaben|@vaaben (til |for )?@legevaaben)'),
    '@fjernvaabentilbehoer', '(@vaaben @vaabenundtagen( (til|for) (@tal |en |et )?@vaaben)?|@vaabenundtagen (til |for )?(@tal |en |et |din |dit |dine )?@vaaben)'),
    '@fjernammo', '(@ammo (kasse|kasser|[aæ]ske|[aæ]sker|taske|b[aæ]lte|hylster)|(kasse|kasser|[aæ]ske|[aæ]sker|taske|b[aæ]lte|hylster) (til |for )?@ammo)'),
    '@dyrudstyr', '(bur|bure|buret|kurv|transportkasse|transportbur|akvarie|akvarium|terrarie|terrarium|trailer|hestetrailer|sadel|grime|trense|foder|hus|hegn|kravleg[aå]rd|snor|sele|halsb[aå]nd)'),
    '@tal', '([0-9]+|to|tre|fire|fem|seks|syv|otte|ni|ti)'),
    '@ammo', '(ammunition|haglpatroner|riffelpatroner|pistolpatroner|jagtpatroner|salonpatroner)'),
    '@legevaaben', '(vand|vandpistol|nerf|leget[oø]j|leget[oø]js|lim|limpistol|spr[oø]jte|spr[oø]jtepistol|maling|malerpistol|pete|start|startpistol|signal|signalpistol|kapsel|kapselpistol|knald|skum|massage|massagepistol|varmluft|varmluftpistol|silikone|fugepistol|lodde|loddepistol|vanding|haveslange|termometer|boremaskine|skruemaskine|v[aæ]rkt[oø]j|kompressor|trykluft|bl[aæ]sepistol|fedtpistol|tankpistol|@medie)'),
    '@vaabenundtagen', '(rack|stativ|v[aå]benskab|v[aå]benskabe|skab|sikkerhedsskab|holder|oph[aæ]ng|taske|futteral|kuffert|etui|rem|b[aæ]lte|hylster|sigtekikkert|kikkertsigte|reng[oø]ringss[aæ]t|attrap|replika|dummy|deaktiveret|softgun|airsoft|paintball|gotcha)'),
    '@tilbehoer', '(bur|bure|buret|kurv|seng|foder|leget[oø]j|t[oø]j|sele|halsb[aå]nd|snor|transportkasse|transportbur|kradsetr[aæ]|akvarie|akvarium|terrarie|terrarium|hus|bamse|bamser|figur|figurer|sk[aå]l|hegn|grind|kravleg[aå]rd|net|sadel|grime|trense|d[aæ]kken|trailer|hestetrailer|rideudstyr|gyngehest|little pony|kabel|kabler|@medie)'),
    '@vaaben', '(pistol(er|en|erne)?|revolver(e|en|erne)?|riffel|riflen|rifler|gev[aæ]r(et|er|erne)?|haglgev[aæ]r(et|er|erne)?|jagtriffel|jagtgev[aæ]r(et|er)?|luftgev[aæ]r(et|er)?|luftpistol(en|er)?|salonriffel|skydev[aå]ben(et)?|h[aå]ndv[aå]ben|glock|kalashnikov|ak 47|ar 15|uzi|mp5)'),
    '@dyr', '(hvalp(e|en|ene)?|killing(er|en|erne)?|kattekilling(er|en|erne)?|kanin(er|en|erne)?|marsvin|undulat(er|en)?|hamster(e|en|ne)?|kat(te|ten|tene)?|hund(e|en|ene)?|papeg[oø]je(r|n)?|kyllinger|h[oø]ns|h[oø]ner|pyton|kongepyton|kornsnog|ilder(e|en)?|fugl(e|en)?|akvariefisk|chinchilla(er)?|gekko(er)?|skildpadde(r|n)?|f[oø]l|hest(e|en)?|pony(er|en)?|ged(er|en)?)'),
    '@maerke', '(louis vuitton|lv|gucci|prada|chanel|rolex|omega|cartier|herm[eè]s|dior|balenciaga|moncler|canada goose|nike|adidas|yeezy|jordan|supreme|off white|stone island|ralph lauren|hugo boss|burberry|versace|fendi|ysl|saint laurent|michael kors|ray ban|oakley|patek philippe|audemars piguet|tag heuer|breitling|hublot|bvlgari|bulgari|tiffany|pandora|apple|airpods|beats|arne jacobsen|louis poulsen|wegner|fritz hansen|poul henningsen|ph|vitra|eames|bang olufsen|b&o|georg jensen|royal copenhagen|lego|north face|ugg|dr martens|converse|new balance|goyard|bottega veneta|celine|givenchy|valentino|alexander mcqueen|rimowa|montblanc|swarovski|chrome hearts|bape|trapstar|corteiz)'),
    '@alkohol', '(vodka|whisky|whiskey|gin|rom|spiritus|vin|r[oø]dvin|hvidvin|ros[eé]vin|champagne|cava|prosecco|cognac|lik[oø]r|snaps|akvavit|[oø]l|tequila|absinth|brandy|calvados|portvin|sherry|mj[oø]d|cider|alkohol)'),
    '@medie', '(dvd|blu ray|bluray|bog|b[oø]ger|bogen|roman|film|filmen|cd|plakat|plakater|vinyl|lp|tegneserie|br[aæ]tspil|album|dokumentar|t shirt)');
$fn$;

-- ============================================================ Ordlisten

-- Ny kolonne fjern -> returtypen aendres, saa funktionen skal droppes.
-- nr = raekkefoelgen i FORBUDTE_REGLER.
drop function if exists public.forbudte_ord();

create function public.forbudte_ord()
returns table (nr integer, kategori text, niveau text, moenster text, kraever text, undtagen text, fjern text)
language sql
immutable
set search_path = public
as $fn$
  select v.nr, v.kategori, v.niveau,
         public.forbudt_ekspander(v.moenster),
         public.forbudt_ekspander(v.kraever),
         public.forbudt_ekspander(v.undtagen),
         public.forbudt_ekspander(v.fjern)
    from (values
      (1, 'vaaben', 'blokeret', 'skarpe? (ammunition|patroner|skud)', null, '@medie', null),
      (2, 'vaaben', 'blokeret', '@vaaben', null, '@medie', '(@fjernvaabentilbehoer|@fjernlege)'),
      (3, 'vaaben', 'blokeret', '(v[aå]bendel(e|en|ene)?|skydev[aå]bendel(e|en|ene)?)', null, '@medie', null),
      (4, 'vaaben', 'blokeret', 'spr[aæ]ngstof(fer|ferne|fet)?', null, '@medie', null),
      (5, 'vaaben', 'blokeret', 'h[aå]ndgranat(er|en|erne)?', null, '(attrap|deaktiveret|leget[oø]j|model|replika|kopi|dummy|@medie)', null),
      (6, 'vaaben', 'blokeret', '(springkniv|faldkniv|butterflykniv)(e|en|ene)?', null, '@medie', null),
      (7, 'vaaben', 'blokeret', 'knojern(et)?', null, '@medie', null),
      (8, 'vaaben', 'blokeret', 'peberspray(en)?', null, '@medie', null),
      (9, 'vaaben', 'blokeret', '(str[oø]mpistol|elpistol)(er|en|erne)?', null, '@medie', null),
      (10, 'vaaben', 'blokeret', 'taser(e|en)?', null, '@medie', null),
      (11, 'vaaben', 'blokeret', '@ammo', null, '(tom|tomme|attrap|dummy|deaktiveret|hylstre|krudt og kugler|@medie)', '@fjernammo'),
      (12, 'vaaben', 'blokeret', '(sortkrudt|r[oø]gfrit krudt|krudt (til|s[aæ]lges)|krudt [0-9]+ ?(g|gram|kg))', null, '(krudt og kugler|@medie)', null),
      (13, 'vaaben', 'tvivl', '@vaaben', null, null, '@fjernlege'),
      (14, 'vaaben', 'tvivl', 'h[aå]ndgranat(er|en|erne)?', null, '@medie', null),
      (15, 'vaaben', 'tvivl', '(ammunition|krudt|haglpatroner|riffelpatroner|pistolpatroner|jagtpatroner|salonpatroner)', null, '(krudt og kugler|@medie)', null),
      (16, 'vaaben', 'tvivl', '(softgun|airsoft|armbr[oø]st|kastekniv(e)?|machete|kastestjerne(r)?)', null, '@medie', null),
      (17, 'narkotika', 'blokeret', '(kokain|heroin|(met)?amfetamin|crystal meth|mdma|ecstasy|lsd|fentanyl|ghb|psilocybin)', null, '@medie', null),
      (18, 'narkotika', 'blokeret', '(hash|skunk|joints?)', '(gram|[0-9]+ ?g|ryge|rygning|thc|cannabis|weed|marihuana|tjald|grinder|rullepapir|bong|stoned|high)', '(hash browns?|hashtag|skunk anansie|joint compound|@medie)', null),
      (19, 'narkotika', 'blokeret', 'bongs?', '(ryge|rygning|cannabis|marihuana|thc|weed|hash|skunk)', '@medie', null),
      (20, 'narkotika', 'tvivl', 'bongs?', '(glas|percolator|bowl|vandpibe)', null, null),
      (21, 'narkotika', 'blokeret', '(cannabis|marihuana|marijuana|ketamin)', null, '(cbd|hamp|medicinsk|@medie)', null),
      (22, 'narkotika', 'tvivl', '(cannabis|marihuana|marijuana|weed|ketamin)', null, '@medie', null),
      (23, 'narkotika', 'blokeret', 'thc', null, '(thc fri|fri for thc|uden thc|ingen thc|0 ?% thc|cbd|@medie)', null),
      (24, 'narkotika', 'tvivl', 'thc', null, '(thc fri|fri for thc|uden thc|ingen thc|0 ?% thc|@medie)', null),
      (25, 'narkotika', 'tvivl', '(growbox|growtelt|grow telt)', null, null, null),
      (26, 'medicin', 'blokeret', 'receptpligtig(e|t)? (medicin|piller|tabletter|l[aæ]gemidler|l[aæ]gemiddel|pr[aæ]parat(er)?)', null, '(ikke|uden|ej) receptpligtig(e|t)?', null),
      (27, 'medicin', 'blokeret', '(viagra|cialis|oxycodon|oxycontin|tramadol|morfin|stesolid|rivotril|xanax|ozempic|wegovy|anabolske steroider)', null, '@medie', null),
      (28, 'medicin', 'tvivl', 'receptpligtig(e|t)?', null, '(ikke|uden|ej) receptpligtig(e|t)?', null),
      (29, 'medicin', 'tvivl', '(testosteron|steroider|sovepiller|smertestillende|doping|sarms)', null, '@medie', null),
      (30, 'medicin', 'tvivl', '(medicin|piller|tabletter) (s[aæ]lges|til salg)', null, null, null),
      (31, 'levende_dyr', 'blokeret', '@dyr (til salg|s[aæ]lges|gives v[aæ]k|s[oø]ger (nyt )?hjem|til adoption|medf[oø]lger)', null, null, '@fjerndyr'),
      (32, 'levende_dyr', 'blokeret', '(s[aæ]lger|s[aæ]lges|giver|gives) (min |mine |vores |en |et |@tal )?@dyr', null, null, '@fjerndyr'),
      (33, 'levende_dyr', 'blokeret', '@dyr', '(levende|stamtavle|stambog|vaccineret|vaccinerede|chippet|chippede|ormekur|ormekureret|nyt hjem|uger gammel|uger gamle|m[aå]neder gammel|m[aå]neder gamle|mdr gammel|mdr gamle|renracet|renracede|opdr[aæ]tter|kuld|hvalpekuld)', null, '@fjerndyr'),
      (34, 'levende_dyr', 'blokeret', '(hvalp(e|en|ene)?|kattekilling(er|en|erne)?|akvariefisk)', null, null, '@fjerndyr'),
      (35, 'levende_dyr', 'blokeret', '(inkl|inklusiv|inklusive|samt|plus) (min |mine |vores |en |et |@tal )?@dyr', null, null, '@fjerndyr'),
      (36, 'levende_dyr', 'blokeret', '@dyr (med|og|inkl|inklusiv|inklusive|samt|plus) (tilh[oø]rende |eget |egen |egne |nyt |ny |nye |stort |stor |store )?@dyrudstyr', null, null, '@fjerndyr'),
      (37, 'levende_dyr', 'blokeret', '(med|og|@tal) (min |mine |vores |en |et |@tal )?@dyr', '@dyrudstyr', null, '@fjerndyr'),
      (38, 'levende_dyr', 'blokeret', 'levende dyr', null, '@medie', null),
      (39, 'forfalskninger', 'blokeret', '(falske?|forfalske(de|t)) ([0-9]+ ?(kr|kroner|euro|dollar|usd|eur) )?(pas|id kort|idkort|id|k[oø]rekort|sedler|pengesedler|penge|eurosedler|dollarsedler|dokumenter|eksamensbeviser|eksamensbevis|recepter|sundhedskort|sygesikringskort)', null, '(legepenge|leget[oø]j|filmpenge|rekvisit|filmrekvisit|monopoly|@medie)', null),
      (40, 'forfalskninger', 'blokeret', '(falsk|falske|fake|aaa) (af )?@maerke', null, '((ikke|ingen|aldrig) (en )?(falsk|falske|fake)|pas p[aå]|frugt|dekoration|pynt|@medie)', null),
      (41, 'forfalskninger', 'blokeret', '@maerke (fake|falsk|falske)', null, '((ikke|ingen|aldrig) (en )?(falsk|falske|fake)|pas p[aå]|frugt|dekoration|pynt|@medie)', null),
      (42, 'forfalskninger', 'tvivl', '(falsk|falske|fake|kopi|kopier|replika|replikaer|replica|copy|aaa) (af )?@maerke', null, null, null),
      (43, 'forfalskninger', 'tvivl', '@maerke (kopi|kopier|replika|replica|fake|falsk|falske)', null, null, null),
      (44, 'forfalskninger', 'tvivl', 'kopivare(r|rne)?', null, null, null),
      (45, 'tobak_alkohol', 'tvivl', 'snus', null, '(snus d[aå]se|tom|tomme|etui|@medie)', null),
      (46, 'tobak_alkohol', 'tvivl', '(cigaret|cigaretter|cigaretterne|cigar|cigarer|cigarillos)', null, '(etui|etuier|holder|t[aæ]nder|[aæ]ske|rullemaskine|maskine|askeb[aæ]ger|tom|tomme|@medie)', null),
      (47, 'tobak_alkohol', 'tvivl', '(tobak|pibetobak|rulletobak)', null, '(tobak(s)? ?(pung|d[aå]se|krukke|kasse)|tom|tomme|@medie)', null),
      (48, 'tobak_alkohol', 'tvivl', '(e cigaret|e cigaretter|vape|vapes|e juice|nikotinposer|nikotinpuder)', null, '(tom|tomme|@medie)', null),
      (49, 'tobak_alkohol', 'tvivl', '(flaske|flasker|fl|kasse|kasser|karton|dunk|[0-9]+ ?(cl|ml|l|liter)) (med )?@alkohol', null, '(tom|tomme|glas|attrap)', null),
      (50, 'tobak_alkohol', 'tvivl', '@alkohol (flaske|flasker|[0-9]+ ?(cl|ml|l|liter)|s[aæ]lges|til salg)', null, '(tom|tomme|glas|attrap)', null),
      (51, 'stjaalne', 'blokeret', '(h[aæ]lervare(r)?|tyvekoster|tyvegods)', null, '((ikke|ingen) (h[aæ]lervare(r)?|tyvekoster|tyvegods)|@medie)', null),
      (52, 'stjaalne', 'blokeret', '(stj[aå]lne|stj[aå]let|stj[aå]lede) (varer|vare|gods|telefon|telefoner|mobil|mobiler|iphone|iphones|cykel|cykler|elcykel|elcykler|computer|computere)', null, '((ikke|aldrig) stj[aå]l(et|ne)|@medie)', null),
      (53, 'stjaalne', 'tvivl', 'stj[aå]l(et|ne|ede)', null, '((ikke|aldrig) stj[aå]l(et|ne)|blev stj[aå]let|er blevet stj[aå]let|stj[aå]let fra (mig|os)|@medie)', null),
      (54, 'voksenindhold', 'blokeret', '(porno(film|grafi|blade)?|b[oø]rneporno|onlyfans)', null, null, null),
      (55, 'voksenindhold', 'tvivl', '(dildo(er)?|sexleget[oø]j|brugte trusser)', null, null, null),
      (56, 'kemikalier', 'blokeret', 'dynamit(ten)?', null, '(harry|banden|olsen|@medie)', null),
      (57, 'kemikalier', 'blokeret', '(semtex|cyanid)', null, '@medie', null),
      (58, 'kemikalier', 'tvivl', 'asbest', null, '(asbest fri|asbestfri|asbestfrie|uden asbest|fri for asbest|ingen asbest|ikke asbest|asbest testet|asbesttestet)', null),
      (59, 'kemikalier', 'tvivl', '(fyrv[aæ]rkeri|kanonslag|nitroglycerin|flussyre|kviks[oø]lv|pesticid(er)?|spr[oø]jtegift|rottegift|klorat)', null, '(uden kviks[oø]lv|@medie)', null),
      (60, 'persondata', 'blokeret', 'cpr ?(num(mer|re)|nr)', null, '(uden|ikke|ingen|intet) cpr', null),
      (61, 'persondata', 'blokeret', '((kreditkort|kort|betalingskort)oplysninger|kortdata|kortnumre)', null, null, null),
      (62, 'persondata', 'blokeret', '(mitid|nemid|mit id|nem id) ?(kodeviser|kodeopl[aæ]ser|n[oø]glekort|n[oø]gleapp|login|konto|bruger|kode|koder|adgang|oplysninger)', null, null, null),
      (63, 'persondata', 'blokeret', '(kodeviser|kodeopl[aæ]ser|n[oø]glekort) (til )?(mitid|nemid|mit id|nem id)', null, null, null),
      (64, 'persondata', 'blokeret', '(kunde(database|kartotek|liste|lister|data)|e ?mail ?liste(r)?)', null, null, null),
      (65, 'persondata', 'tvivl', 'kodeviser(en|e)?', null, null, null),
      (66, 'persondata', 'tvivl', '(konto til salg|(netflix|spotify|steam|instagram|tiktok|fortnite|snapchat|facebook|bruger|gaming|psn|hbo|disney) ?konto(en)?|(login|loginoplysninger|adgangskode|password) (til|p[aå]))', null, null, null),
      (67, 'billetter', 'tvivl', 'billet(ter|ten|terne)? til', null, null, null),
      (68, 'billetter', 'tvivl', '(koncert|festival|fodbold|teater|landskamp|vip|e)billet(ter|ten|terne)?', null, null, null),
      (69, 'billetter', 'tvivl', 'billet(ter|ten|terne)? (s[aæ]lges|til salg)', null, null, null),
      (70, 'billetter', 'tvivl', '(e )?billet(ter|ten|terne)?', '(koncert|festival|kamp|forestilling|show|teater|stadion|arena|r[aæ]kke|s[aæ]de|siddeplads|st[aå]plads|parket|parterre|balkon|ticketmaster|billetlugen|tivoli)', null, null),
      (71, 'billetter', 'tvivl', 'tickets?', null, '(ticket to ride|@medie)', null)
    ) as v(nr, kategori, niveau, moenster, kraever, undtagen, fjern)
   order by v.nr;
$fn$;

-- ============================================================ Kategorier (/forbudte-varer)

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
    (11, 'billetter', 'Billetter med videresalgsforbud', 'Billetter, som arrangøren ikke tillader videresalg af, og billetter solgt til mere end den oprindelige pris (billetloven). Alle auktioner med billetter bliver kontrolleret af BidHamr.')
  ) as v(nr, kode, navn, beskrivelse);
$fn$;

-- ============================================================ Normalisering og tjek

-- Som 20261006041000 + "+" bliver til " og " (saa "Hvalp + kurv" ikke ligner
-- "Hvalp kurv"). Samme regel som normaliserTekst i TypeScript.
create or replace function public.forbudt_normaliser(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select btrim(regexp_replace(
           regexp_replace(
             replace(
               regexp_replace(lower(normalize(coalesce(p_tekst, ''), NFC)),
                              '[­​-‏‪-‮⁠-⁯﻿]', '', 'g'),
               '+', ' og '),
             '[^a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß%& ]+', ' ', 'g'),
           ' +', ' ', 'g'));
$fn$;

-- {"resultat": "ok"} eller {"resultat": "blokeret"|"tvivl", "kategori", "ord"}.
-- Som 20261006041000 + feltet fjern: forekomster af fjern-frasen fjernes fra
-- teksten (foerste forekomst ad gangen, hoejst 50 gange), foer moenstret
-- tjekkes. kraever og undtagen tjekkes mod hele teksten. Samme logik som
-- tjekForbudtTekst i TypeScript.
create or replace function public.forbudt_tekst_tjek(p_tekst text)
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
  v_tvivl jsonb;
  o       record;
  m       text[];
begin
  if v_norm = '' then
    return jsonb_build_object('resultat', 'ok');
  end if;
  for o in select * from public.forbudte_ord() f order by f.nr loop
    v_tekst := v_norm;
    if o.fjern is not null then
      v_re := '(^|' || g || ')(' || o.fjern || ')($|' || g || ')';
      for i in 1..50 loop
        exit when v_tekst !~ v_re;
        v_tekst := regexp_replace(v_tekst, v_re, ' ');
      end loop;
    end if;
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
-- (forbudte_ord er droppet og genoprettet, saa grants skal gives igen.)
grant execute on function public.forbudt_ekspander(text)   to anon, authenticated, service_role;
grant execute on function public.forbudte_ord()            to anon, authenticated, service_role;
grant execute on function public.forbudte_varer()          to anon, authenticated, service_role;
grant execute on function public.forbudt_normaliser(text)  to anon, authenticated, service_role;
grant execute on function public.forbudt_tekst_tjek(text)  to anon, authenticated, service_role;

-- ============================================================ Automatisk rapport

-- Som 20261006040000, men teksten afhaenger af kategorien: billetter og
-- alkohol/tobak er lovlige varer, hvor staff skal tjekke, at salget er
-- lovligt - ikke "muligvis forbudt vare".
create or replace function public.auctions_forbudt_rapport()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v       jsonb;
  v_navn  text;
  v_start text;
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

    v_start := case v->>'kategori'
      when 'billetter' then
        'Kontrol: billetter – tjek, at salget er lovligt (videresalg tilladt af arrangøren og ikke over den oprindelige pris).'
      when 'tobak_alkohol' then
        'Kontrol: alkohol/tobak – tjek, at salget er lovligt (fx ikke snus og ikke salg til personer under 18 år).'
      else
        format('Automatisk kontrol: muligvis forbudt vare (%s).', coalesce(v_navn, v->>'kategori'))
    end;

    insert into public.reports (auction_id, reporter_id, category, description, status, created_at)
    values (new.id, public.bidhamr_system_id(), 'forbudt_vare',
            left(format('%s Ordet "%s" står i %s. Auktionen er oprettet – vurdér, om den skal fjernes.',
                        v_start, v->>'ord',
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

-- Triggeren fra 20261006040000 peger allerede paa funktionen.

-- ============================================================ Test af ordlisten

-- Fejler migrationen, hvis et eksempel giver et andet resultat end forventet.
-- Samme eksempler koeres mod tjekForbudtTekst i TypeScript.
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
    ('Krudtugle', 'ok'),
    ('Limpistol', 'ok'),
    ('Sprøjtepistol', 'ok'),
    ('Lim pistol', 'ok'),
    ('Sprøjte pistol til maling', 'ok'),
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
    ('Killingefoder', 'ok'),
    ('Kaninhus', 'ok'),
    ('Akvarium 60 L', 'ok'),
    ('Hundesnor', 'ok'),
    ('Kattetræ', 'ok'),
    ('Fuglebur', 'ok'),
    ('Haveslange 20 m', 'ok'),
    ('Printer patroner til HP', 'ok'),
    ('Gevær rack', 'tvivl'),
    ('Kopi af Arne Jacobsen stol', 'tvivl'),
    ('Softgun', 'tvivl'),
    ('Softgun pistol', 'tvivl'),
    ('2 billetter til Roskilde Festival', 'tvivl'),
    ('Flaske vodka', 'tvivl'),
    ('Receptpligtig', 'tvivl'),
    ('10 dåser snus', 'tvivl'),
    ('Billet koncert Parken', 'tvivl'),
    ('Glas bong', 'tvivl'),
    ('CBD olie 2% THC', 'tvivl'),
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
    ('Haglgevær', 'blokeret'),
    ('Pistol', 'blokeret'),
    ('Glock 17 pistol', 'blokeret'),
    ('Jagtgevær sælges', 'blokeret'),
    ('Luftpistol', 'blokeret'),
    ('Luftgevær kræver ikke våbentilladelse', 'blokeret'),
    ('Riffel', 'blokeret'),
    ('Revolver', 'blokeret'),
    ('Hash 5 gram', 'blokeret'),
    ('Bong til hash', 'blokeret'),
    ('Falsk Rolex', 'blokeret'),
    ('Fake Gucci taske', 'blokeret'),
    ('Haglpatroner kaliber 12', 'blokeret'),
    ('Sortkrudt 500 g', 'blokeret'),
    ('Kanin til salg', 'blokeret'),
    ('Hvalpe sælges', 'blokeret'),
    ('Killing til salg', 'blokeret'),
    ('Kattekilling', 'blokeret'),
    ('Undulat sælges', 'blokeret'),
    ('Akvariefisk', 'blokeret'),
    ('Høns sælges', 'blokeret'),
    ('Sælger min hest', 'blokeret'),
    ('Pistolhylster', 'ok'),
    ('Nerf pistol med skumpile', 'ok'),
    ('Vandpistol med tank', 'ok'),
    ('Bur til kanin', 'ok'),
    ('Trailer til hest sælges', 'ok'),
    ('Hestetrailer til salg', 'ok'),
    ('Hundekurv med pude', 'ok'),
    ('Kanin bur med 2 skåle', 'ok'),
    ('Hvalpe kurv til salg', 'ok'),
    ('My Little Pony figur', 'ok'),
    ('Little pony til salg', 'ok'),
    ('2 katte figurer', 'ok'),
    ('Bamse hund til salg', 'ok'),
    ('Schleich 3 heste og stald', 'ok'),
    ('T-shirt med kat', 'ok'),
    ('Krus med hund og kat', 'ok'),
    ('Foder til hund og kat', 'ok'),
    ('Snor til hund og kat sælges', 'ok'),
    ('Hunde og katte foder', 'ok'),
    ('Kurv til hvalpe', 'ok'),
    ('Pistol til maling', 'ok'),
    ('Hestetrailer og hest', 'blokeret'),
    ('Kanin+bur', 'blokeret'),
    ('Hamster bur, hamster medfølger', 'blokeret'),
    ('Hylster til pistol', 'tvivl'),
    ('Gevær rack til 4 geværer', 'tvivl'),
    ('Airsoft gevær med magasin', 'tvivl'),
    ('Ammunition kasse', 'tvivl'),
    ('Beatles Revolver, original 1966 LP', 'tvivl'),
    ('Hest til salg inkl. trailer', 'blokeret'),
    ('Pistol med hylster', 'blokeret'),
    ('Pistol + hylster', 'blokeret'),
    ('Pistol+hylster', 'blokeret'),
    ('Glock 17 og hylster', 'blokeret'),
    ('Riffel samt sigtekikkert', 'blokeret'),
    ('Jagtgevær inkl. rem og taske', 'blokeret'),
    ('Hvalpe sælges med kurv', 'blokeret'),
    ('Hvalp + kurv', 'blokeret'),
    ('Hvalpe kurv. Hvalpe sælges', 'blokeret'),
    ('2 hvalpe med kurv', 'blokeret'),
    ('Kanin med bur', 'blokeret'),
    ('Kanin og bur sælges', 'blokeret'),
    ('Kanin til salg, bur medfølger', 'blokeret'),
    ('Kanin bur inkl. 2 kaniner', 'blokeret'),
    ('Bur med 2 kaniner', 'blokeret'),
    ('Hamster bur med hamster', 'blokeret'),
    ('Akvarium med akvariefisk', 'blokeret'),
    ('Hest med sadel', 'blokeret'),
    ('Haglpatroner med kasse', 'blokeret')
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
