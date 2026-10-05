// Forbudte varer på BidHamr. Bruges af siden /forbudte-varer, opret- og
// redigeringsformularen (advarsel i browseren) og som reference for appen.
//
// HOLD SYNKRON med databasen
// (supabase/migrations/20261006041000_auktionsfunktioner_rettelser.sql):
//   FORBUDTE_KATEGORIER  <-> public.forbudte_varer()
//   FORBUDTE_REGLER      <-> public.forbudte_ord()   (samme rækkefølge = nr)
//   PLADSHOLDERE         <-> public.forbudt_ekspander()
//   normaliserTekst      <-> public.forbudt_normaliser()
//   tjekForbudtTekst     <-> public.forbudt_tekst_tjek()
// Databasen er autoriteten: den afviser "blokeret" ved oprettelse/redigering
// (fejlkode BHF01 / kode 'forbudt_vare') og opretter en automatisk rapport
// til staff (reports.category = 'forbudt_vare') ved "tvivl".
//
// Princip (for at undgå falske positiver):
//   blokeret - KUN helt entydige formuleringer ("skarp ammunition",
//              "springkniv", "kokain" uden film/bog-ord ...).
//   tvivl    - kun hvor der reelt er grund til, at staff kigger
//              ("pistol", "kanin til salg", "flaske vodka" ...).
//   Almindelige varer ("Kanin bur", "Vodka glas", "Nerf pistol") giver
//   hverken blokering eller rapport.
//
// En regel har:
//   moenster  - skal stå i teksten (som hele ord)
//   kraever   - (valgfri) skal OGSÅ stå et sted i teksten (hele ord)
//   undtagen  - (valgfri) står det et sted i teksten, gælder reglen ikke
// Pladsholdere (@medie, @vaaben, ...) udfoldes i alle tre felter.
//
// Mønstrene er bevidst skrevet i en lille fælles regex-delmængde, som både
// JavaScript og Postgres forstår ens: bogstaver, tal, mellemrum, % &, [..],
// ?, +, (a|b). Ingen \b, \w, \d, lookahead eller (?:..). De matches mod den
// normaliserede tekst (se normaliserTekst) og kun som hele ord.
//
// TESTTABEL (samme eksempler som DO-blokken sidst i 20261006041000, som får
// migrationen til at fejle ved et forkert resultat; ret begge steder):
//   ok (hverken blokering eller rapport):
//     "Dynamit-Harry DVD", "Olsen-banden på dynamit-tur",
//     "Eternitplader uden asbest", "Asbest-fri tagplader",
//     "Næsespray ikke receptpligtig", "Legepenge falske penge",
//     "Kokain Bear DVD", "Testosteron bog", "Snus dåse (tom)",
//     "Hash brown-pande", "Skunk-jakke", "Skunk Anansie CD",
//     "Killing Eve DVD", "Kanin bur", "Hamster bur med hjul",
//     "Fake fur jakke", "Replika af Titanic model", "Medicin skab",
//     "Piller til pool", "Nerf pistol", "Pistol Pete bog",
//     "Krudt og kugler brætspil", "Joint compound spartelmasse",
//     "Ding Dong bong klokke", "THC-fri CBD olie", "Vodka glas",
//     "Alkohol tester", "Cigaret etui", "Billet holder", "Login",
//     "Vandpistol", "Sex Pistols plakat", "iPhone 12", "Sofabord i eg"
//   tvivl (bevidst): "Gevær rack" (gevær), "Kopi af Arne Jacobsen stol"
//   tvivl: "Haglgevær", "2 billetter til Roskilde Festival",
//     "Kanin til salg", "Flaske vodka", "Pistol"
//   blokeret: "Sælger strømpistol", "Springkniv sælges", "Kokain 5 gram",
//     "MitID kodeviser", "Falske 500-kr sedler", "Skarp ammunition 9mm"

export type ForbudtKategori =
  | "vaaben"
  | "narkotika"
  | "medicin"
  | "levende_dyr"
  | "forfalskninger"
  | "tobak_alkohol"
  | "stjaalne"
  | "voksenindhold"
  | "kemikalier"
  | "persondata"
  | "billetter";

export const FORBUDTE_KATEGORIER: readonly {
  kode: ForbudtKategori;
  navn: string;
  beskrivelse: string;
}[] = [
  {
    kode: "vaaben",
    navn: "Våben og ammunition",
    beskrivelse:
      "Skydevåben, dele til skydevåben, ammunition og krudt, springknive, butterflyknive, knojern, peberspray, strømpistoler og andre våben, der kræver tilladelse eller er forbudte i Danmark.",
  },
  {
    kode: "narkotika",
    navn: "Narkotika",
    beskrivelse:
      "Euforiserende stoffer af enhver art – også udstyr, frø og planter, der er beregnet til at fremstille eller bruge dem.",
  },
  {
    kode: "medicin",
    navn: "Medicin og doping",
    beskrivelse:
      "Receptpligtig medicin, håndkøbsmedicin, doping og anabolske steroider. Medicin må kun sælges af apoteker og godkendte forhandlere.",
  },
  {
    kode: "levende_dyr",
    navn: "Levende dyr",
    beskrivelse: "Alle levende dyr, fx hvalpe, killinger, kaniner, fugle, fisk og krybdyr.",
  },
  {
    kode: "forfalskninger",
    navn: "Forfalskninger og kopivarer",
    beskrivelse:
      "Kopier af mærkevarer, falske dokumenter, pas, ID-kort, kørekort, pengesedler og andet, der udgiver sig for at være ægte.",
  },
  {
    kode: "tobak_alkohol",
    navn: "Tobak og alkohol",
    beskrivelse:
      "Snus (forbudt at sælge i Danmark). Tobak, e-cigaretter og alkohol må aldrig sælges til personer under 18 år.",
  },
  {
    kode: "stjaalne",
    navn: "Stjålne varer",
    beskrivelse: "Stjålne varer og hælervarer – også varer, du har mistanke om er stjålet.",
  },
  {
    kode: "voksenindhold",
    navn: "Voksenindhold",
    beskrivelse: "Pornografi og andet seksuelt indhold, herunder brugt undertøj solgt som voksenindhold.",
  },
  {
    kode: "kemikalier",
    navn: "Farlige kemikalier og sprængstoffer",
    beskrivelse:
      "Sprængstoffer, fyrværkeri, giftige og ætsende kemikalier, kviksølv og asbest.",
  },
  {
    kode: "persondata",
    navn: "Personlige data og konti",
    beskrivelse:
      "CPR-numre, kortoplysninger, kundelister, MitID/NemID og login til brugerkonti – dine egne eller andres.",
  },
  {
    kode: "billetter",
    navn: "Billetter med videresalgsforbud",
    beskrivelse:
      "Billetter, som arrangøren ikke tillader videresalg af, og billetter solgt til mere end den oprindelige pris (billetloven).",
  },
] as const;

export type ForbudtNiveau = "blokeret" | "tvivl";

// Pladsholdere. Udfoldes i denne rækkefølge (nogle indeholder @medie, som
// derfor kommer sidst). HOLD SYNKRON med public.forbudt_ekspander().
export const PLADSHOLDERE: readonly [string, string][] = [
  // Ord, der gør en "farlig" ting til legetøj/værktøj.
  [
    "@legevaaben",
    "(vand|vandpistol|nerf|leget[oø]j|leget[oø]js|lim|limpistol|spr[oø]jte|spr[oø]jtepistol|maling|malerpistol|pete|start|startpistol|signal|signalpistol|kapsel|kapselpistol|knald|skum|massage|massagepistol|varmluft|varmluftpistol|silikone|fugepistol|lodde|loddepistol|@medie)",
  ],
  // Ting til dyr - ikke selve dyret.
  [
    "@tilbehoer",
    "(bur|bure|buret|kurv|seng|foder|leget[oø]j|t[oø]j|sele|halsb[aå]nd|snor|transportkasse|transportbur|kradsetr[aæ]|akvarie|terrarie|hus|bamse|bamser|figur|figurer|sk[aå]l|hegn|grind|kravleg[aå]rd|@medie)",
  ],
  [
    "@vaaben",
    "(pistol(er|en|erne)?|revolver(e|en|erne)?|riffel|riflen|rifler|gev[aæ]r(et|er|erne)?|haglgev[aæ]r(et|er|erne)?|jagtriffel|jagtgev[aæ]r(et)?|luftgev[aæ]r(et)?|luftpistol(en)?|salonriffel|skydev[aå]ben(et)?|h[aå]ndv[aå]ben)",
  ],
  [
    "@dyr",
    "(hvalp(e|en|ene)?|killing(er|en|erne)?|kattekilling(er|en)?|kanin(er|en|erne)?|marsvin|undulat(er|en)?|hamster(e|en|ne)?|kat(te|ten|tene)?|hund(e|en|ene)?|papeg[oø]je(r|n)?|kyllinger|h[oø]ns|h[oø]ner|slange(r|n)?|ilder(e|en)?|fugl(e|en)?|akvariefisk|chinchilla(er)?|gekko(er)?|skildpadde(r|n)?|f[oø]l|hest(e|en)?|pony(er|en)?|ged(er|en)?)",
  ],
  [
    "@maerke",
    "(louis vuitton|lv|gucci|prada|chanel|rolex|omega|cartier|herm[eè]s|dior|balenciaga|moncler|canada goose|nike|adidas|yeezy|jordan|supreme|off white|stone island|ralph lauren|hugo boss|burberry|versace|fendi|ysl|saint laurent|michael kors|ray ban|oakley|patek philippe|audemars piguet|tag heuer|breitling|hublot|bvlgari|bulgari|tiffany|pandora|apple|airpods|beats|arne jacobsen|louis poulsen|wegner|fritz hansen|poul henningsen|ph|vitra|eames|bang olufsen|b&o|georg jensen|royal copenhagen|lego|north face|ugg|dr martens|converse|new balance|goyard|bottega veneta|celine|givenchy|valentino|alexander mcqueen|rimowa|montblanc|swarovski|chrome hearts|bape|trapstar|corteiz)",
  ],
  [
    "@alkohol",
    "(vodka|whisky|whiskey|gin|rom|spiritus|vin|r[oø]dvin|hvidvin|ros[eé]vin|champagne|cava|prosecco|cognac|lik[oø]r|snaps|akvavit|[oø]l|tequila|absinth|brandy|calvados|portvin|sherry|mj[oø]d|cider|alkohol)",
  ],
  // Film, bøger, musik og spil - titler som "Kokain Bear" og "Dynamit-Harry".
  [
    "@medie",
    "(dvd|blu ray|bluray|bog|b[oø]ger|bogen|roman|film|filmen|cd|plakat|plakater|vinyl|lp|tegneserie|br[aæ]tspil|album|dokumentar|t shirt)",
  ],
];

type Regel = {
  kategori: ForbudtKategori;
  niveau: ForbudtNiveau;
  moenster: string;
  kraever?: string;
  undtagen?: string;
};

// Rækkefølgen er nr i public.forbudte_ord(). Blokeret vinder altid over
// tvivl; ved flere tvivl-regler vises den første.
export const FORBUDTE_REGLER: readonly Regel[] = [
  // ---------------------------------------------------------------- Våben
  { kategori: "vaaben", niveau: "blokeret", moenster: "skarpe? (ammunition|patroner|skud)", undtagen: "@medie" },
  {
    kategori: "vaaben",
    niveau: "blokeret",
    moenster: "@vaaben",
    kraever: "(skarp|skarpe|funktionsdygtig|funktionsdygtigt|funktionsdygtige|v[aå]bentilladelse|jagttegn)",
    undtagen: "(@legevaaben|(ikke|uden|ingen) (krav om )?v[aå]bentilladelse|kr[aæ]ver ikke)",
  },
  { kategori: "vaaben", niveau: "blokeret", moenster: "spr[aæ]ngstof(fer|ferne|fet)?", undtagen: "@medie" },
  {
    kategori: "vaaben",
    niveau: "blokeret",
    moenster: "h[aå]ndgranat(er|en|erne)?",
    undtagen: "(attrap|deaktiveret|leget[oø]j|model|replika|kopi|dummy|@medie)",
  },
  { kategori: "vaaben", niveau: "blokeret", moenster: "(springkniv|faldkniv|butterflykniv)(e|en|ene)?", undtagen: "@medie" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "knojern(et)?", undtagen: "@medie" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "peberspray(en)?", undtagen: "@medie" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "(str[oø]mpistol|elpistol)(er|en|erne)?", undtagen: "@medie" },
  { kategori: "vaaben", niveau: "blokeret", moenster: "taser(e|en)?", undtagen: "@medie" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "@vaaben", undtagen: "@legevaaben" },
  { kategori: "vaaben", niveau: "tvivl", moenster: "h[aå]ndgranat(er|en|erne)?", undtagen: "@medie" },
  {
    kategori: "vaaben",
    niveau: "tvivl",
    moenster: "(ammunition|krudt|haglpatroner|riffelpatroner|pistolpatroner)",
    undtagen: "(krudt og kugler|@medie)",
  },
  {
    kategori: "vaaben",
    niveau: "tvivl",
    moenster: "(softgun|airsoft|armbr[oø]st|kastekniv(e)?|machete|kastestjerne(r)?)",
    undtagen: "@medie",
  },

  // ---------------------------------------------------------------- Narkotika
  {
    kategori: "narkotika",
    niveau: "blokeret",
    moenster: "(kokain|heroin|(met)?amfetamin|crystal meth|mdma|ecstasy|lsd|fentanyl|ghb|psilocybin)",
    undtagen: "@medie",
  },
  {
    kategori: "narkotika",
    niveau: "tvivl",
    moenster: "(hash|skunk|joints?)",
    kraever:
      "(gram|[0-9]+ ?g|ryge|rygning|thc|cannabis|weed|marihuana|tjald|grinder|rullepapir|bong|stoned|high)",
    undtagen: "(hash browns?|hashtag|skunk anansie|joint compound|@medie)",
  },
  {
    kategori: "narkotika",
    niveau: "tvivl",
    moenster: "bongs?",
    kraever: "(glas|ryge|rygning|cannabis|thc|weed|hash|skunk|percolator|bowl|vandpibe)",
  },
  { kategori: "narkotika", niveau: "tvivl", moenster: "(cannabis|marihuana|marijuana|weed|ketamin)", undtagen: "@medie" },
  {
    kategori: "narkotika",
    niveau: "tvivl",
    moenster: "thc",
    undtagen: "(thc fri|fri for thc|uden thc|ingen thc|0 ?% thc|@medie)",
  },
  { kategori: "narkotika", niveau: "tvivl", moenster: "(growbox|growtelt|grow telt)" },

  // ---------------------------------------------------------------- Medicin og doping
  {
    kategori: "medicin",
    niveau: "blokeret",
    moenster: "receptpligtig(e|t)? (medicin|piller|tabletter|l[aæ]gemidler|l[aæ]gemiddel|pr[aæ]parat(er)?)",
    undtagen: "(ikke|uden|ej) receptpligtig(e|t)?",
  },
  {
    kategori: "medicin",
    niveau: "blokeret",
    moenster:
      "(viagra|cialis|oxycodon|oxycontin|tramadol|morfin|stesolid|rivotril|xanax|ozempic|wegovy|anabolske steroider)",
    undtagen: "@medie",
  },
  { kategori: "medicin", niveau: "tvivl", moenster: "receptpligtig(e|t)?", undtagen: "(ikke|uden|ej) receptpligtig(e|t)?" },
  {
    kategori: "medicin",
    niveau: "tvivl",
    moenster: "(testosteron|steroider|sovepiller|smertestillende|doping|sarms)",
    undtagen: "@medie",
  },
  { kategori: "medicin", niveau: "tvivl", moenster: "(medicin|piller|tabletter) (s[aæ]lges|til salg)" },

  // ---------------------------------------------------------------- Levende dyr
  {
    kategori: "levende_dyr",
    niveau: "tvivl",
    moenster: "@dyr (til salg|s[aæ]lges|gives v[aæ]k|s[oø]ger (nyt )?hjem|til adoption)",
    undtagen: "@tilbehoer",
  },
  {
    kategori: "levende_dyr",
    niveau: "tvivl",
    moenster: "(s[aæ]lger|s[aæ]lges|giver|gives) (min |mine |vores |en |et |to |tre |[0-9]+ )?@dyr",
    undtagen: "@tilbehoer",
  },
  {
    kategori: "levende_dyr",
    niveau: "tvivl",
    moenster: "@dyr",
    kraever:
      "(levende|stamtavle|stambog|vaccineret|vaccinerede|chippet|chippede|ormekur|ormekureret|nyt hjem|uger gammel|uger gamle|m[aå]neder gammel|m[aå]neder gamle|mdr gammel|mdr gamle|renracet|renracede|opdr[aæ]tter|kuld|hvalpekuld)",
    undtagen: "@tilbehoer",
  },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "hvalp(e|en|ene)?", undtagen: "@tilbehoer" },
  { kategori: "levende_dyr", niveau: "tvivl", moenster: "levende dyr", undtagen: "@medie" },

  // ---------------------------------------------------------------- Forfalskninger
  {
    kategori: "forfalskninger",
    niveau: "blokeret",
    moenster:
      "(falske?|forfalske(de|t)) ([0-9]+ ?(kr|kroner|euro|dollar|usd|eur) )?(pas|id kort|idkort|id|k[oø]rekort|sedler|pengesedler|penge|eurosedler|dollarsedler|dokumenter|eksamensbeviser|eksamensbevis|recepter|sundhedskort|sygesikringskort)",
    undtagen: "(legepenge|leget[oø]j|filmpenge|rekvisit|filmrekvisit|monopoly|@medie)",
  },
  {
    kategori: "forfalskninger",
    niveau: "tvivl",
    moenster: "(falsk|falske|fake|kopi|kopier|replika|replikaer|replica|copy|aaa) (af )?@maerke",
  },
  {
    kategori: "forfalskninger",
    niveau: "tvivl",
    moenster: "@maerke (kopi|kopier|replika|replica|fake|falsk|falske)",
  },
  { kategori: "forfalskninger", niveau: "tvivl", moenster: "kopivare(r|rne)?" },

  // ---------------------------------------------------------------- Tobak og alkohol
  { kategori: "tobak_alkohol", niveau: "tvivl", moenster: "snus", undtagen: "(snus d[aå]se|tom|tomme|etui|@medie)" },
  {
    kategori: "tobak_alkohol",
    niveau: "tvivl",
    moenster: "(cigaret|cigaretter|cigaretterne|cigar|cigarer|cigarillos)",
    undtagen: "(etui|etuier|holder|t[aæ]nder|[aæ]ske|rullemaskine|maskine|askeb[aæ]ger|tom|tomme|@medie)",
  },
  {
    kategori: "tobak_alkohol",
    niveau: "tvivl",
    moenster: "(tobak|pibetobak|rulletobak)",
    undtagen: "(tobak(s)? ?(pung|d[aå]se|krukke|kasse)|tom|tomme|@medie)",
  },
  {
    kategori: "tobak_alkohol",
    niveau: "tvivl",
    moenster: "(e cigaret|e cigaretter|vape|vapes|e juice|nikotinposer|nikotinpuder)",
    undtagen: "(tom|tomme|@medie)",
  },
  {
    kategori: "tobak_alkohol",
    niveau: "tvivl",
    moenster: "(flaske|flasker|fl|kasse|kasser|karton|dunk|[0-9]+ ?(cl|ml|l|liter)) (med )?@alkohol",
    undtagen: "(tom|tomme|glas|attrap)",
  },
  {
    kategori: "tobak_alkohol",
    niveau: "tvivl",
    moenster: "@alkohol (flaske|flasker|[0-9]+ ?(cl|ml|l|liter)|s[aæ]lges|til salg)",
    undtagen: "(tom|tomme|glas|attrap)",
  },

  // ---------------------------------------------------------------- Stjålne varer
  {
    kategori: "stjaalne",
    niveau: "blokeret",
    moenster: "(h[aæ]lervare(r)?|tyvekoster|tyvegods)",
    undtagen: "((ikke|ingen) (h[aæ]lervare(r)?|tyvekoster|tyvegods)|@medie)",
  },
  {
    kategori: "stjaalne",
    niveau: "blokeret",
    moenster:
      "(stj[aå]lne|stj[aå]let|stj[aå]lede) (varer|vare|gods|telefon|telefoner|mobil|mobiler|iphone|iphones|cykel|cykler|elcykel|elcykler|computer|computere)",
    undtagen: "((ikke|aldrig) stj[aå]l(et|ne)|@medie)",
  },
  {
    kategori: "stjaalne",
    niveau: "tvivl",
    moenster: "stj[aå]l(et|ne|ede)",
    undtagen:
      "((ikke|aldrig) stj[aå]l(et|ne)|blev stj[aå]let|er blevet stj[aå]let|stj[aå]let fra (mig|os)|@medie)",
  },

  // ---------------------------------------------------------------- Voksenindhold
  { kategori: "voksenindhold", niveau: "blokeret", moenster: "(porno(film|grafi|blade)?|b[oø]rneporno|onlyfans)" },
  { kategori: "voksenindhold", niveau: "tvivl", moenster: "(dildo(er)?|sexleget[oø]j|brugte trusser)" },

  // ---------------------------------------------------------------- Kemikalier og sprængstoffer
  { kategori: "kemikalier", niveau: "blokeret", moenster: "dynamit(ten)?", undtagen: "(harry|banden|olsen|@medie)" },
  { kategori: "kemikalier", niveau: "blokeret", moenster: "(semtex|cyanid)", undtagen: "@medie" },
  {
    kategori: "kemikalier",
    niveau: "tvivl",
    moenster: "asbest",
    undtagen: "(asbest fri|asbestfri|asbestfrie|uden asbest|fri for asbest|ingen asbest|ikke asbest|asbest testet|asbesttestet)",
  },
  {
    kategori: "kemikalier",
    niveau: "tvivl",
    moenster:
      "(fyrv[aæ]rkeri|kanonslag|nitroglycerin|flussyre|kviks[oø]lv|pesticid(er)?|spr[oø]jtegift|rottegift|klorat)",
    undtagen: "(uden kviks[oø]lv|@medie)",
  },

  // ---------------------------------------------------------------- Personlige data og konti
  {
    kategori: "persondata",
    niveau: "blokeret",
    moenster: "cpr ?(num(mer|re)|nr)",
    undtagen: "(uden|ikke|ingen|intet) cpr",
  },
  {
    kategori: "persondata",
    niveau: "blokeret",
    moenster: "((kreditkort|kort|betalingskort)oplysninger|kortdata|kortnumre)",
  },
  {
    kategori: "persondata",
    niveau: "blokeret",
    moenster:
      "(mitid|nemid|mit id|nem id) ?(kodeviser|kodeopl[aæ]ser|n[oø]glekort|n[oø]gleapp|login|konto|bruger|kode|koder|adgang|oplysninger)",
  },
  {
    kategori: "persondata",
    niveau: "blokeret",
    moenster: "(kodeviser|kodeopl[aæ]ser|n[oø]glekort) (til )?(mitid|nemid|mit id|nem id)",
  },
  {
    kategori: "persondata",
    niveau: "blokeret",
    moenster: "(kunde(database|kartotek|liste|lister|data)|e ?mail ?liste(r)?)",
  },
  { kategori: "persondata", niveau: "tvivl", moenster: "kodeviser(en|e)?" },
  {
    kategori: "persondata",
    niveau: "tvivl",
    moenster:
      "(konto til salg|(netflix|spotify|steam|instagram|tiktok|fortnite|snapchat|facebook|bruger|gaming|psn|hbo|disney) ?konto(en)?|(login|loginoplysninger|adgangskode|password) (til|p[aå]))",
  },

  // ---------------------------------------------------------------- Billetter
  { kategori: "billetter", niveau: "tvivl", moenster: "billet(ter|ten|terne)? til" },
  {
    kategori: "billetter",
    niveau: "tvivl",
    moenster: "(koncert|festival|fodbold|teater|landskamp|vip)billet(ter|ten|terne)?",
  },
  { kategori: "billetter", niveau: "tvivl", moenster: "billet(ter|ten|terne)? (s[aæ]lges|til salg)" },
];

function ekspander(moenster: string): string {
  let r = moenster;
  for (const [navn, vaerdi] of PLADSHOLDERE) r = r.split(navn).join(vaerdi);
  return r;
}

// Den udfoldede liste - præcis det, public.forbudte_ord() returnerer.
export const FORBUDTE_ORD: readonly {
  nr: number;
  kategori: ForbudtKategori;
  niveau: ForbudtNiveau;
  moenster: string;
  kraever: string | null;
  undtagen: string | null;
}[] = FORBUDTE_REGLER.map((o, i) => ({
  nr: i + 1,
  kategori: o.kategori,
  niveau: o.niveau,
  moenster: ekspander(o.moenster),
  kraever: o.kraever ? ekspander(o.kraever) : null,
  undtagen: o.undtagen ? ekspander(o.undtagen) : null,
}));

// Usynlige tegn og retningsmærker (samme som public.spoergsmaal_ryd_tekst),
// så fx "ko​kain" ikke slipper igennem.
const USYNLIGE = /[­​-‏‪-‮⁠-⁯﻿]/g;

// Tegn, der tæller som bogstaver/tal. Alt andet (tegnsætning, bindestreg,
// parenteser ...) bliver til mellemrum - undtagen % og &.
const ORDTEGN = "a-z0-9æøåäöüéèáàâêëíìîïóòôúùûñçß";

// Små bogstaver, NFC, usynlige tegn fjernes, tegnsætning og bindestreger
// bliver til mellemrum, gentagne mellemrum til ét. Samme regel som
// public.forbudt_normaliser.
export function normaliserTekst(tekst: string | null | undefined): string {
  return (tekst ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(USYNLIGE, "")
    .replace(new RegExp(`[^${ORDTEGN}%& ]+`, "g"), " ")
    .replace(/ +/g, " ")
    .trim();
}

// Hele ord: ingen bogstaver/tal lige før eller efter.
const GRAENSE = `[^${ORDTEGN}]`;
const helOrd = (m: string) => new RegExp(`(^|${GRAENSE})(${m})($|${GRAENSE})`, "u");

const KOMPILEREDE = FORBUDTE_ORD.map((o) => ({
  ...o,
  re: helOrd(o.moenster),
  kraeverRe: o.kraever ? helOrd(o.kraever) : null,
  undtagenRe: o.undtagen ? helOrd(o.undtagen) : null,
}));

export type ForbudtResultat =
  | { resultat: "ok" }
  | { resultat: "blokeret" | "tvivl"; kategori: ForbudtKategori; ord: string };

// Blokerede ord vinder over tvivl. Samme logik som public.forbudt_tekst_tjek.
export function tjekForbudtTekst(...tekster: (string | null | undefined)[]): ForbudtResultat {
  const norm = normaliserTekst(tekster.filter(Boolean).join(" "));
  if (norm === "") return { resultat: "ok" };
  let tvivl: ForbudtResultat | null = null;
  for (const o of KOMPILEREDE) {
    const m = norm.match(o.re);
    if (!m) continue;
    if (o.kraeverRe && !o.kraeverRe.test(norm)) continue;
    if (o.undtagenRe && o.undtagenRe.test(norm)) continue;
    if (o.niveau === "blokeret") return { resultat: "blokeret", kategori: o.kategori, ord: m[2] };
    tvivl ??= { resultat: "tvivl", kategori: o.kategori, ord: m[2] };
  }
  return tvivl ?? { resultat: "ok" };
}

export function forbudtKategoriNavn(kode: string): string {
  return FORBUDTE_KATEGORIER.find((k) => k.kode === kode)?.navn ?? "forbudte varer";
}

// Brugerbesked, når et ord blokerer oprettelsen.
export function forbudtBesked(ord: string, kategori: string): string {
  return `Ordet "${ord}" hører under ${forbudtKategoriNavn(kategori).toLowerCase()}, som ikke må sælges på BidHamr. Ret titlen eller beskrivelsen – se listen over forbudte varer.`;
}
