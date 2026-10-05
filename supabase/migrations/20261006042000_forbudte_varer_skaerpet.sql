-- Forbudte varer skaerpet (Filip, 6. oktober 2026 - ROADMAP-BESLUTNINGER.md
-- "Forbudte varer"). Koeres EFTER 20261006041000. Idempotent (kun
-- create or replace + en test-DO-blok).
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
-- HOLD SYNKRON med src/lib/forbudteVarer.ts (PLADSHOLDERE, FORBUDTE_REGLER,
-- FORBUDTE_KATEGORIER). Funktionerne herunder er genereret ud fra TS-listen.
-- Genskrevet ud fra seneste definition (20261006041000 / 20261006040000):
--   forbudt_ekspander, forbudte_ord, forbudte_varer.
-- forbudt_normaliser, forbudt_tekst_tjek, auctions_indhold_kontrol,
-- auctions_forbudt_rapport og rediger_auktion er uaendrede og bruger
-- automatisk den nye liste.

-- ============================================================ Pladsholdere

-- Raekkefoelgen er vigtig (@medie sidst, fordi andre pladsholdere bruger den).
create or replace function public.forbudt_ekspander(p_tekst text)
returns text
language sql
immutable
set search_path = public
as $fn$
  select replace(replace(replace(replace(replace(replace(replace(replace(p_tekst,
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

-- Samme signatur som i 20261006041000, saa create or replace er nok.
-- nr = raekkefoelgen i FORBUDTE_REGLER.
create or replace function public.forbudte_ord()
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
      (2, 'vaaben', 'blokeret', '@vaaben', null, '(@legevaaben|@vaabenundtagen)'),
      (3, 'vaaben', 'blokeret', '(v[aå]bendel(e|en|ene)?|skydev[aå]bendel(e|en|ene)?)', null, '@medie'),
      (4, 'vaaben', 'blokeret', 'spr[aæ]ngstof(fer|ferne|fet)?', null, '@medie'),
      (5, 'vaaben', 'blokeret', 'h[aå]ndgranat(er|en|erne)?', null, '(attrap|deaktiveret|leget[oø]j|model|replika|kopi|dummy|@medie)'),
      (6, 'vaaben', 'blokeret', '(springkniv|faldkniv|butterflykniv)(e|en|ene)?', null, '@medie'),
      (7, 'vaaben', 'blokeret', 'knojern(et)?', null, '@medie'),
      (8, 'vaaben', 'blokeret', 'peberspray(en)?', null, '@medie'),
      (9, 'vaaben', 'blokeret', '(str[oø]mpistol|elpistol)(er|en|erne)?', null, '@medie'),
      (10, 'vaaben', 'blokeret', 'taser(e|en)?', null, '@medie'),
      (11, 'vaaben', 'blokeret', '(ammunition|haglpatroner|riffelpatroner|pistolpatroner|jagtpatroner|salonpatroner)', null, '(tom|tomme|kasse|kasser|[aæ]ske|[aæ]sker|taske|b[aæ]lte|attrap|dummy|deaktiveret|hylster|hylstre|krudt og kugler|@medie)'),
      (12, 'vaaben', 'blokeret', '(sortkrudt|r[oø]gfrit krudt|krudt (til|s[aæ]lges)|krudt [0-9]+ ?(g|gram|kg))', null, '(krudt og kugler|@medie)'),
      (13, 'vaaben', 'tvivl', '@vaaben', null, '@legevaaben'),
      (14, 'vaaben', 'tvivl', 'h[aå]ndgranat(er|en|erne)?', null, '@medie'),
      (15, 'vaaben', 'tvivl', '(ammunition|krudt|haglpatroner|riffelpatroner|pistolpatroner|jagtpatroner|salonpatroner)', null, '(krudt og kugler|@medie)'),
      (16, 'vaaben', 'tvivl', '(softgun|airsoft|armbr[oø]st|kastekniv(e)?|machete|kastestjerne(r)?)', null, '@medie'),
      (17, 'narkotika', 'blokeret', '(kokain|heroin|(met)?amfetamin|crystal meth|mdma|ecstasy|lsd|fentanyl|ghb|psilocybin)', null, '@medie'),
      (18, 'narkotika', 'blokeret', '(hash|skunk|joints?)', '(gram|[0-9]+ ?g|ryge|rygning|thc|cannabis|weed|marihuana|tjald|grinder|rullepapir|bong|stoned|high)', '(hash browns?|hashtag|skunk anansie|joint compound|@medie)'),
      (19, 'narkotika', 'blokeret', 'bongs?', '(ryge|rygning|cannabis|marihuana|thc|weed|hash|skunk)', '@medie'),
      (20, 'narkotika', 'tvivl', 'bongs?', '(glas|percolator|bowl|vandpibe)', null),
      (21, 'narkotika', 'blokeret', '(cannabis|marihuana|marijuana|ketamin)', null, '(cbd|hamp|medicinsk|@medie)'),
      (22, 'narkotika', 'tvivl', '(cannabis|marihuana|marijuana|weed|ketamin)', null, '@medie'),
      (23, 'narkotika', 'blokeret', 'thc', null, '(thc fri|fri for thc|uden thc|ingen thc|0 ?% thc|cbd|@medie)'),
      (24, 'narkotika', 'tvivl', 'thc', null, '(thc fri|fri for thc|uden thc|ingen thc|0 ?% thc|@medie)'),
      (25, 'narkotika', 'tvivl', '(growbox|growtelt|grow telt)', null, null),
      (26, 'medicin', 'blokeret', 'receptpligtig(e|t)? (medicin|piller|tabletter|l[aæ]gemidler|l[aæ]gemiddel|pr[aæ]parat(er)?)', null, '(ikke|uden|ej) receptpligtig(e|t)?'),
      (27, 'medicin', 'blokeret', '(viagra|cialis|oxycodon|oxycontin|tramadol|morfin|stesolid|rivotril|xanax|ozempic|wegovy|anabolske steroider)', null, '@medie'),
      (28, 'medicin', 'tvivl', 'receptpligtig(e|t)?', null, '(ikke|uden|ej) receptpligtig(e|t)?'),
      (29, 'medicin', 'tvivl', '(testosteron|steroider|sovepiller|smertestillende|doping|sarms)', null, '@medie'),
      (30, 'medicin', 'tvivl', '(medicin|piller|tabletter) (s[aæ]lges|til salg)', null, null),
      (31, 'levende_dyr', 'blokeret', '@dyr (til salg|s[aæ]lges|gives v[aæ]k|s[oø]ger (nyt )?hjem|til adoption)', null, '@tilbehoer'),
      (32, 'levende_dyr', 'blokeret', '(s[aæ]lger|s[aæ]lges|giver|gives) (min |mine |vores |en |et |to |tre |[0-9]+ )?@dyr', null, '@tilbehoer'),
      (33, 'levende_dyr', 'blokeret', '@dyr', '(levende|stamtavle|stambog|vaccineret|vaccinerede|chippet|chippede|ormekur|ormekureret|nyt hjem|uger gammel|uger gamle|m[aå]neder gammel|m[aå]neder gamle|mdr gammel|mdr gamle|renracet|renracede|opdr[aæ]tter|kuld|hvalpekuld)', '@tilbehoer'),
      (34, 'levende_dyr', 'blokeret', '(hvalp(e|en|ene)?|kattekilling(er|en|erne)?|akvariefisk)', null, '@tilbehoer'),
      (35, 'levende_dyr', 'blokeret', 'levende dyr', null, '@medie'),
      (36, 'forfalskninger', 'blokeret', '(falske?|forfalske(de|t)) ([0-9]+ ?(kr|kroner|euro|dollar|usd|eur) )?(pas|id kort|idkort|id|k[oø]rekort|sedler|pengesedler|penge|eurosedler|dollarsedler|dokumenter|eksamensbeviser|eksamensbevis|recepter|sundhedskort|sygesikringskort)', null, '(legepenge|leget[oø]j|filmpenge|rekvisit|filmrekvisit|monopoly|@medie)'),
      (37, 'forfalskninger', 'blokeret', '(falsk|falske|fake|aaa) (af )?@maerke', null, '((ikke|ingen|aldrig) (en )?(falsk|falske|fake)|pas p[aå]|frugt|dekoration|pynt|@medie)'),
      (38, 'forfalskninger', 'blokeret', '@maerke (fake|falsk|falske)', null, '((ikke|ingen|aldrig) (en )?(falsk|falske|fake)|pas p[aå]|frugt|dekoration|pynt|@medie)'),
      (39, 'forfalskninger', 'tvivl', '(falsk|falske|fake|kopi|kopier|replika|replikaer|replica|copy|aaa) (af )?@maerke', null, null),
      (40, 'forfalskninger', 'tvivl', '@maerke (kopi|kopier|replika|replica|fake|falsk|falske)', null, null),
      (41, 'forfalskninger', 'tvivl', 'kopivare(r|rne)?', null, null),
      (42, 'tobak_alkohol', 'tvivl', 'snus', null, '(snus d[aå]se|tom|tomme|etui|@medie)'),
      (43, 'tobak_alkohol', 'tvivl', '(cigaret|cigaretter|cigaretterne|cigar|cigarer|cigarillos)', null, '(etui|etuier|holder|t[aæ]nder|[aæ]ske|rullemaskine|maskine|askeb[aæ]ger|tom|tomme|@medie)'),
      (44, 'tobak_alkohol', 'tvivl', '(tobak|pibetobak|rulletobak)', null, '(tobak(s)? ?(pung|d[aå]se|krukke|kasse)|tom|tomme|@medie)'),
      (45, 'tobak_alkohol', 'tvivl', '(e cigaret|e cigaretter|vape|vapes|e juice|nikotinposer|nikotinpuder)', null, '(tom|tomme|@medie)'),
      (46, 'tobak_alkohol', 'tvivl', '(flaske|flasker|fl|kasse|kasser|karton|dunk|[0-9]+ ?(cl|ml|l|liter)) (med )?@alkohol', null, '(tom|tomme|glas|attrap)'),
      (47, 'tobak_alkohol', 'tvivl', '@alkohol (flaske|flasker|[0-9]+ ?(cl|ml|l|liter)|s[aæ]lges|til salg)', null, '(tom|tomme|glas|attrap)'),
      (48, 'stjaalne', 'blokeret', '(h[aæ]lervare(r)?|tyvekoster|tyvegods)', null, '((ikke|ingen) (h[aæ]lervare(r)?|tyvekoster|tyvegods)|@medie)'),
      (49, 'stjaalne', 'blokeret', '(stj[aå]lne|stj[aå]let|stj[aå]lede) (varer|vare|gods|telefon|telefoner|mobil|mobiler|iphone|iphones|cykel|cykler|elcykel|elcykler|computer|computere)', null, '((ikke|aldrig) stj[aå]l(et|ne)|@medie)'),
      (50, 'stjaalne', 'tvivl', 'stj[aå]l(et|ne|ede)', null, '((ikke|aldrig) stj[aå]l(et|ne)|blev stj[aå]let|er blevet stj[aå]let|stj[aå]let fra (mig|os)|@medie)'),
      (51, 'voksenindhold', 'blokeret', '(porno(film|grafi|blade)?|b[oø]rneporno|onlyfans)', null, null),
      (52, 'voksenindhold', 'tvivl', '(dildo(er)?|sexleget[oø]j|brugte trusser)', null, null),
      (53, 'kemikalier', 'blokeret', 'dynamit(ten)?', null, '(harry|banden|olsen|@medie)'),
      (54, 'kemikalier', 'blokeret', '(semtex|cyanid)', null, '@medie'),
      (55, 'kemikalier', 'tvivl', 'asbest', null, '(asbest fri|asbestfri|asbestfrie|uden asbest|fri for asbest|ingen asbest|ikke asbest|asbest testet|asbesttestet)'),
      (56, 'kemikalier', 'tvivl', '(fyrv[aæ]rkeri|kanonslag|nitroglycerin|flussyre|kviks[oø]lv|pesticid(er)?|spr[oø]jtegift|rottegift|klorat)', null, '(uden kviks[oø]lv|@medie)'),
      (57, 'persondata', 'blokeret', 'cpr ?(num(mer|re)|nr)', null, '(uden|ikke|ingen|intet) cpr'),
      (58, 'persondata', 'blokeret', '((kreditkort|kort|betalingskort)oplysninger|kortdata|kortnumre)', null, null),
      (59, 'persondata', 'blokeret', '(mitid|nemid|mit id|nem id) ?(kodeviser|kodeopl[aæ]ser|n[oø]glekort|n[oø]gleapp|login|konto|bruger|kode|koder|adgang|oplysninger)', null, null),
      (60, 'persondata', 'blokeret', '(kodeviser|kodeopl[aæ]ser|n[oø]glekort) (til )?(mitid|nemid|mit id|nem id)', null, null),
      (61, 'persondata', 'blokeret', '(kunde(database|kartotek|liste|lister|data)|e ?mail ?liste(r)?)', null, null),
      (62, 'persondata', 'tvivl', 'kodeviser(en|e)?', null, null),
      (63, 'persondata', 'tvivl', '(konto til salg|(netflix|spotify|steam|instagram|tiktok|fortnite|snapchat|facebook|bruger|gaming|psn|hbo|disney) ?konto(en)?|(login|loginoplysninger|adgangskode|password) (til|p[aå]))', null, null),
      (64, 'billetter', 'tvivl', 'billet(ter|ten|terne)? til', null, null),
      (65, 'billetter', 'tvivl', '(koncert|festival|fodbold|teater|landskamp|vip|e)billet(ter|ten|terne)?', null, null),
      (66, 'billetter', 'tvivl', 'billet(ter|ten|terne)? (s[aæ]lges|til salg)', null, null),
      (67, 'billetter', 'tvivl', '(e )?billet(ter|ten|terne)?', '(koncert|festival|kamp|forestilling|show|teater|stadion|arena|r[aæ]kke|s[aæ]de|siddeplads|st[aå]plads|parket|parterre|balkon|ticketmaster|billetlugen|tivoli)', null),
      (68, 'billetter', 'tvivl', 'tickets?', null, '(ticket to ride|@medie)')
    ) as v(nr, kategori, niveau, moenster, kraever, undtagen)
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

-- Rene funktioner uden dataadgang - appen maa gerne tjekke paa forhaand.
grant execute on function public.forbudt_ekspander(text)  to anon, authenticated, service_role;
grant execute on function public.forbudte_ord()           to anon, authenticated, service_role;
grant execute on function public.forbudte_varer()         to anon, authenticated, service_role;

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
    ('Sælger min hest', 'blokeret')
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
