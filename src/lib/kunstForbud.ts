// Kunst er forbudt på BidHamr (Filip, 14. okt. 2026 - ROADMAP-BESLUTNINGER.md,
// "Kunst er forbudt"). ALLE kunst-ord står i denne ene fil.
//
// Afgrænsning:
//   forbudt  - malerier, tegninger, skulpturer, grafiske tryk og litografier
//              (også signerede og nummererede) og kunst, sælgeren selv har lavet.
//   tilladt  - plakater og masseproducerede billeder uden kunstner/værdi
//              (fx IKEA).
//   uafklaret (advokaten, spørgsmål 135-136) - designerkeramik og -glas samt
//              antikviteter. Står i KUNST_UAFKLAREDE med aktiv: false og
//              bruges IKKE. Sæt aktiv: true og skriv en ny migration med
//              kunst_ord() (testen tests/enhed/kunstForbud.test.ts skriver de
//              rækker, der skal stå i SQL), når advokaten har svaret.
//
// Et træf blokerer ikke oprettelsen: sælgeren ser en advarsel og bekræfter
// "Det er ikke kunst". Databasen markerer auktionen (kunst_markeret_kl), sætter
// den til staff-tjek (kunst_kontrol = 'afventer': kun sælgeren og staff kan se
// den, og der kan ikke bydes) og opretter en automatisk anmeldelse
// (reports.category = 'kunst'). Appen kan ikke omgå det (triggere og RLS).
//
// HOLD SYNKRON med databasen
// (supabase/migrations/20261023010000_kunst_forbudt.sql):
//   KUNST_REGLER (aktive, udfoldet) <-> public.kunst_ord()   (samme rækkefølge = nr)
//   KUNST_FJERN (udfoldet)          <-> public.kunst_fjern()
//   kunstSloerVariant               <-> public.kunst_sloer_variant(p_tekst, p_et)
//   kunstPar                        <-> public.kunst_par()
//   tjekKunstTekst                  <-> public.kunst_tekst_tjek()
// Normaliseringen er den samme som for forbudte varer (normaliserTekst <->
// public.forbudt_normaliser). Testen sammenligner TS-listen med migrationen,
// og PGlite-testen sammenligner svarene.
//
// Mønstrene bruger samme lille regex-delmængde som forbudteVarer.ts, så
// JavaScript og Postgres forstår dem ens: bogstaver, tal, mellemrum, &, [..],
// ?, *, +, (a|b). Ingen \b, \w, lookahead eller (?:..). Æ/ø/å skrives som
// (æ|ae), (ø|oe), (å|aa), så "kunstvaerk" også fanges. Bøjninger står som
// valgfrie endelser: maleri(et|er|erne)?.
//
// Sådan virker tjekket:
//   1. Højst 5000 tegn. Teksten normaliseres (små bogstaver, tegnsætning ->
//      mellemrum).
//   2. Tilladte fraser (KUNST_FJERN) fjernes: "kunst læder", "akvarel farver",
//      "ramme til maleri", "plakat af maleri", "IKEA billede", "bog om kunst".
//      De gælder kun, når ordene står LIGE ved hinanden.
//   3. Hver regel tjekkes som hele ord i den RENSEDE tekst: moenster skal stå
//      der, kraever (valgfri) skal OGSÅ stå der, og står undtagen (valgfri)
//      der, gælder reglen ikke. Ord i en tilladt frase kan derfor hverken
//      udløse eller undskylde et andet kunst-ord ("Plakat af maleri. Kunstner:
//      Jorn" fanges).
//   4. Giver det intet træf, tjekkes "to ord samlet" ("ma leri", kunstPar),
//      og derefter to "afslørede" udgaver af teksten (kunstSloerVariant):
//      @ -> a, € -> e, accenter fjernes, 3/1/0 ved siden af bogstaver bliver
//      e/i/o (og e/l/o i den anden udgave: "ku1tegning"), skilletegn mellem
//      bogstaver fjernes ("ma-leri") og 3+ enkeltbogstaver i træk sættes
//      sammen ("m.a.l.e.r.i") - hver også med to ord samlet.

import { USYNLIGE, fjernFraser, helOrd, normaliserTekst } from "@/lib/forbudteVarer";

// Pladsholdere, der udfoldes i mønstrene (i denne rækkefølge).
export const KUNST_PLADSHOLDERE: readonly [string, string][] = [
  // Selve kunstgenstanden (bruges i fjern-fraserne).
  [
    "@kunstobj",
    "(maleri|malerier|maleriet|malerierne|kunst|kunsten|kunstv(æ|ae)rk|kunstv(æ|ae)rker|kunstv(æ|ae)rket|l(æ|ae)rred|l(æ|ae)rreder|l(æ|ae)rredet|tegning|tegninger|akvarel|akvareller|skulptur|skulpturer|litografi|litografier|grafik|danske malerier|moderne kunst|dansk kunst)",
  ],
  // Kunstartikler: farver, pensler, papir ...
  [
    "@artikel",
    "(farve|farver|farvers(æ|ae)t|maling|pensel|pensler|papir|blok|blokke|s(æ|ae)t|kasse|kasser|(æ|ae)ske|(æ|ae)sker|kursus|kurser|staffeli|staffelier|ler|v(æ|ae)rkt(ø|oe)j|tape|lak|spartel|paletkniv|palet|paletter|udstyr|grej|artikler|forsyninger)",
  ],
  // Ting, man hænger eller pakker kunst i - og blanke lærreder.
  [
    "@ophaeng",
    "(ramme|rammer|billedramme|billedrammer|lampe|lamper|oph(æ|ae)ng|krog|kroge|lys|l(æ|ae)rred|l(æ|ae)rreder|transportkasse)",
  ],
  // Bøger, film og andet om kunst - ikke selve kunsten.
  [
    "@medieom",
    "(bog|b(ø|oe)ger|bogen|b(ø|oe)rnebog|b(ø|oe)rneb(ø|oe)ger|billedbog|billedb(ø|oe)ger|malebog|maleb(ø|oe)ger|dvd|film|filmen|leksikon|katalog|kataloger|udstillingskatalog|tidsskrift|blad|blade|magasin|foredrag|kursus|kurser|puslespil|kort|postkort|kalender|plakatbog)",
  ],
  // Plakater og tryk uden kunstner/værdi (tilladt).
  [
    "@plakat",
    "(plakat|plakater|plakaten|plakaterne|poster|posters|kunstplakat|kunstplakater|print|prints|reproduktion|reproduktioner|fototapet)",
  ],
  // Ting, der ofte er signerede/nummererede uden at være kunst.
  [
    "@signting",
    "(bog|b(ø|oe)ger|bogen|roman|digtsamling|f(ø|oe)rsteudgave|udgave|tr(ø|oe)je|fodboldtr(ø|oe)je|bold|fodbold|kort|samlekort|billet|program|autograf|autografkort)",
  ],
  // Kæder med masseproducerede billeder. "tiger" og "normal" kun efter
  // "fra"/"købt i" (@kaedefra) - "Tiger maleri" er et maleri af en tiger.
  [
    "@kaedefra",
    "(@kaede|tiger|normal)",
  ],
  [
    "@kaede",
    "(ikea|jysk|bilka|s(ø|oe)strene grene|imerco|kop og kande|kop & kande|ilva|bolia|h&m home|zara home|flying tiger|jem og fix|jem & fix|harald nyborg|silvan|bauhaus|desenio|poster store)",
  ],
];

type KunstRegel = {
  moenster: string;
  kraever?: string;
  undtagen?: string;
};

// Rækkefølgen er nr i public.kunst_ord(). Første træf vises.
export const KUNST_REGLER_RAA: readonly KunstRegel[] = [
  // Malerier, også sammensatte ord: oliemaleri, akvarelmaleri, landskabsmaleri.
  // "maleritape" og "malerpensel" er andre ord og fanges ikke. Porcelænsmaleri
  // (designerkeramik, uafklaret) fjernes som tilladt frase.
  { moenster: "[a-zæøå]*maleri(et|er|erne)?" },
  { moenster: "(kunstv(æ|ae)rk(et|er|erne)?|originalv(æ|ae)rk(et|er|erne)?|original(t|e)? v(æ|ae)rk(et|er)?)" },
  // ("Kunsten at ..." er ofte en bogtitel og fanges ikke.)
  { moenster: "(kunst|v(æ|ae)gkunst|billedkunst|fotokunst|kunstfoto|kunstfotografi|kunstgrafik|kunsttryk)" },
  // Kunstner/kunstmaler - men ikke musikere ("Signeret af kunstneren, LP").
  {
    moenster: "(kunstner(e|en|ens|ne|nes)?|kunstmaler(e|en|ens|ne|nes)?|kunstnersigneret|kunstnersignatur)",
    undtagen:
      "(cd|cder|vinyl|lp|lper|album|plade|plader|single|kassette|koncert|koncerter|musik|musiker|sang|sanger|sangerinde|band|rapper|festival)",
  },
  // Lærred kun med kunst-ord - "Billede på lærred" og "Projektor lærred" er ok.
  {
    moenster: "l(æ|ae)rred(et|er|erne)?",
    kraever:
      "(olie|akryl|akvarel|gouache|malet|malede|h(å|aa)ndmalet|h(å|aa)ndmalede|kunstner|kunstneren|signeret|signerede|signatur|original|originalt|originalv(æ|ae)rk|unika|oil|acrylic|painted|signed)",
    undtagen: "(projektor|projektorl(æ|ae)rred|l(æ|ae)rredssk(æ|ae)rm|blank|blankt|blanke|ubrugt|ubrugte)",
  },
  // Canvas er også et stof (sko, tasker, telte) - kun med maleri-ord.
  {
    moenster: "canvas",
    kraever:
      "(olie|akryl|akvarel|gouache|malet|malede|h(å|aa)ndmalet|h(å|aa)ndmalede|kunstner|kunstneren|signeret|signerede|signatur|unika|oil|acrylic|painted|signed)",
    undtagen:
      "(sko|sneakers|sneaker|converse|vans|taske|tasker|mulepose|rygs(æ|ae)k|stol|stole|klapstol|telt|telte|bukser|jakke|kasket|b(æ|ae)lte)",
  },
  { moenster: "(akvarel(len|ler|lerne)?|aquarelle?|gouache(r|n)?)" },
  // Grafiske tryk.
  {
    moenster:
      "(litografi(en|er|erne)?|lithografi(en|er|erne)?|lithography|lithographs?|serigrafi(en|er|erne)?|radering(en|er|erne)?|tr(æ|ae)snit(tet|ter|terne)?|linoleumssnit(tet|ter)?|linoleumsnit(tet|ter)?|linosnit(tet|ter)?|kobberstik(ket|ker|kene)?|st(å|aa)lstik(ket|ker)?|xylografi(en|er)?|akvatinta|mezzotinte|giclee|gicl(é|e)e|(æ|ae)tsning(en|er|erne)?|grafisk(e)? (tryk|blad|blade|v(æ|ae)rk|v(æ|ae)rker))",
  },
  // "Litho"/"lito" - men ikke lamper og armaturer (Lito-lampe).
  {
    moenster: "(litho|lithos|lito|litos)",
    undtagen: "(lampe|lamper|lampen|armatur|armaturer|belysning|loftlampe|pendel|v(æ|ae)glampe|bordlampe|standerlampe)",
  },
  // Silketryk - men ikke på tøj, tasker og reklameting.
  {
    moenster: "silketryk(ket|ker|kene)?",
    undtagen:
      "(t shirt|tshirt|tr(ø|oe)je|t(ø|oe)j|h(æ|ae)ttetr(ø|oe)je|hoodie|stof|taske|mulepose|reklame|logo|firmalogo|krus|kasket)",
  },
  // "Grafik" kun med kunst-ord - "PS5 med flot grafik" og "Grafikkort" er ok.
  {
    moenster: "grafik(ken|ker|kerne)?",
    kraever:
      "(signeret|signerede|signatur|nummereret|nummererede|original|originalt|kunstner|kunstneren|indrammet|indrammede|tryk|blad|oplag|(æ|ae)tsning)",
    undtagen: "(t shirt|tshirt|tr(ø|oe)je|t(ø|oe)j|h(æ|ae)ttetr(ø|oe)je|hoodie|spil|gaming)",
  },
  // Signeret/nummereret kun ved tryk og oplag - "Signeret fodboldtrøje" og
  // "Signeret bog, 1. oplag" er ok (se @signting i de tilladte fraser).
  { moenster: "(signere(t|de)|nummerere(t|de))", kraever: "(tryk|trykket|oplag|eksemplar|eksemplarer)" },
  // Skulpturer, også bronzeskulptur, træskulptur, haveskulptur.
  { moenster: "[a-zæøå]*skulptur(en|er|erne)?" },
  {
    moenster: "(buste(n|r|rne)?|byste(n|r|rne)?)",
    undtagen:
      "(sy|syning|skr(æ|ae)dder|syerbuste|skr(æ|ae)dderbuste|t(ø|oe)j|kjole|kjoler|bluse|top|mannequin|mannequindukke|udstillingsdukke|smykke|smykker|halsk(æ|ae)de|halsk(æ|ae)der|paryk|parykker|bh|undert(ø|oe)j|str|st(ø|oe)rrelse|cm|m(å|aa)l|vidde|justerbar)",
  },
  {
    moenster:
      "((bronze|bronce|marmor) ?(figur|figuren|figurer|statue|statuen|statuer|statuette|statuetter|relief)|(figur|figuren|figurer|statue|statuen|statuer|statuette|statuetter|relief) (i|af|udf(ø|oe)rt i|st(ø|oe)bt i) (bronze|bronce|marmor))",
  },
  // Statuer - men ikke havestatuer, plastfigurer og legetøj.
  {
    moenster: "(statue(n|r|rne)?|statuette(n|r|rne)?)",
    undtagen:
      "(have|haven|havestatue|udend(ø|oe)rs|plast|plastik|plastic|plastfigur|resin|polyresin|leget(ø|oe)j|lego|actionfigur|samlefigur|funko|souvenir|frihedsgudinden|lampe)",
  },
  // Tegninger, også kultegning, blyantstegning, portrættegning - men ikke
  // tekniske tegninger, samlevejledninger og mønstre (se også de tilladte
  // fraser: byggetegning, plantegning ...).
  {
    moenster: "([a-zæøå]*tegning(en|er|erne)?|drawings?)",
    undtagen:
      "(teknisk|tekniske|samlevejledning|vejledning|monteringsvejledning|manual|m(ø|oe)nster|m(ø|oe)nstre|strikkem(ø|oe)nster|symønster|sym(ø|oe)nster|byggetegning|plantegning|tegneserie|tegneserier|tegnefilm)",
  },
  // Kunst, sælgeren selv har lavet. "Selvmalet kommode" er ok.
  {
    moenster: "(selvmalet|selvmalede|selvtegnet|selvtegnede)",
    kraever: "(billede|billeder|l(æ|ae)rred|motiv|portr(æ|ae)t|ramme|indrammet)",
  },
  // Malede billeder: "Håndmalet billede", "Oliebillede", "Akryl-billede",
  // "Billede malet i olie", "Oliemalet".
  { moenster: "(h(å|aa)ndmalet|h(å|aa)ndmalede|malet|malede|olie|akryl) ?billede(t|r|rne)?" },
  {
    moenster:
      "((billede(t|r|rne)?|motiv(et|er)?) (malet |udf(ø|oe)rt )?i (olie|akryl|akvarel|gouache|tempera)|(olie|akryl)malet|(olie|akryl)malede)",
  },
  // "Abstrakt billede, olie".
  {
    moenster: "(abstrakt|abstrakte|figurativ|figurativt|figurative|moderne) billede(t|r|rne)?",
    kraever: "(olie|akryl|akvarel|gouache|malet|malede|l(æ|ae)rred|signeret|signatur|kunstner)",
  },
  // Klassiske teknikangivelser.
  {
    moenster:
      "((olie|akryl|akvarel|gouache|tempera) p(å|aa) (l(æ|ae)rred|plade|tr(æ|ae)|pap|papir)|(blyant|kul|tusch|bl(æ|ae)k|pastel|pastelkridt|rødkridt) p(å|aa) papir|portr(æ|ae)t(tet|ter)? (i|malet i|udf(ø|oe)rt i) (olie|akryl|akvarel|kul|blyant|pastel))",
  },
  // Engelske ord.
  {
    moenster:
      "(painting|paintings|oil painting|artwork|artworks|original art|fine art|wall art|sculpture|sculptures|etching|etchings|watercolou?r|watercolou?rs|art print|signed print|(oil|acrylic) on (canvas|board|paper|panel|wood|linen|card|masonite))",
  },
  // Tyske ord.
  { moenster: "(gem(ä|ae|a)lde|aquarell)" },
];

// Tilladte fraser, der fjernes, før reglerne tjekkes (kun når ordene står
// lige ved hinanden).
export const KUNST_FJERN_RAA =
  "(" +
  [
    // Materialer med "kunst" som forled skrevet i to ord, og bøger om kunsthåndværk.
    "kunst (l(æ|ae)der|gr(æ|ae)s|stof|stoffer|pels|blomst|blomster|plante|planter|silke|ruskind|negle|juletr(æ|ae)|sk(ø|oe)jtel(ø|oe)b|harpiks|is)",
    "kunst (og|&) h(å|aa)ndv(æ|ae)rk",
    // Kunstartikler: "akvarel farver", "kunstner pensler", "maleri kursus".
    "(akvarel|gouache|akryl|olie|pastel|kunstner|kunstmaler|tegne) @artikel",
    "(maleri|kunst|tegning|skulptur|grafik) (kursus|kurser|artikler|udstyr|grej|forsyninger|v(æ|ae)rkt(ø|oe)j)",
    "drawing (tablet|tablets|pad|board|table|book|set|kit)",
    // "Ramme til maleri", "Lærred til maleri", "Farver til akvarel".
    "(@artikel|@ophaeng) (til|for) (et |en |dit |din |mit |min |dine |mine |de )?@kunstobj",
    // Bøger og film om kunst: "Bog om danske malerier".
    "@medieom (om|med|af|fra) (et |en |de |det |den )?(kendte |kendt |berømte |berømt |danske |dansk |moderne |gamle )?@kunstobj",
    // Plakater og reproduktioner: "Plakat af maleri", "Maleri plakat",
    // "Tegning til børneværelse plakat".
    "@plakat (af|med|fra|efter) (et |en |det |den )?(kendte |kendt |berømte |berømt )?@kunstobj",
    "@kunstobj ?@plakat",
    "@kunstobj (til|for|i|med) [a-zæøå]+ @plakat",
    // Masseproducerede billeder: "IKEA maleri" (også "IKEA-maleri" skrevet
    // sammen), "Lærred fra IKEA", "Maleri fra Tiger".
    "@kaede ?(@kunstobj|billede|billeder|v(æ|ae)gbillede|v(æ|ae)gbilleder)",
    "(@kunstobj|billede|billeder) (fra|k(ø|oe)bt i|k(ø|oe)bt hos|k(ø|oe)bt p(å|aa)) @kaedefra",
    // Signerede ting, der ikke er kunst: "Signeret bog", "LP signeret".
    "(signeret|signerede|nummereret|nummererede) @signting",
    "@signting (signeret|signerede|nummereret|nummererede)",
    // Sletning af data: "Radering af tekst", "Sikker radering af harddisk".
    "(sikker |data )?radering (af |i )?(tekst|teksten|data|harddisk|harddiske|disk|filer|fil|ssd)",
    // Bryst-/syerbuste: "Buste ramme", "Buste stativ".
    "(buste|byste) (ramme|stativ|form|dukke|holder|top|bh)",
    // Porcelæn (designerkeramik er uafklaret - advokat-spørgsmål 135).
    "(porcel(æ|ae)ns|porcel(æ|ae)n|keramik|stent(ø|oe)js) ?maleri(et|er|erne)?",
    "maleri(et|er|erne)? p(å|aa) porcel(æ|ae)n",
    // Tekniske tegninger.
    "(bygge|plan|arbejds|monterings|konstruktions|el|vvs|maskin|snit|facade|samle|udstyknings|matrikel)tegning(en|er|erne)?",
  ].join("|") +
  ")";

// ---------------------------------------------------------------- Uafklaret
// Afventer advokaten (spørgsmål 135-136). Bruges IKKE, før aktiv sættes til
// true OG kunst_ord() i databasen er opdateret med en ny migration.
export const KUNST_UAFKLAREDE: readonly { gruppe: string; aktiv: boolean; regler: readonly KunstRegel[] }[] = [
  {
    gruppe: "Designerkeramik og -glas",
    aktiv: false,
    regler: [
      {
        moenster:
          "(royal copenhagen|k(æ|ae)hler|holmegaard|bing (og|&) gr(ø|oe)ndahl|b&g|kosta boda|orrefors|iittala|arabia|aluminia|wiinblad|bj(ø|oe)rn wiinblad|gustavsberg|r(ö|oe|ø)rstrand|venini|murano|lalique)",
      },
    ],
  },
  {
    gruppe: "Antikviteter",
    aktiv: false,
    regler: [
      {
        moenster:
          "(antik|antikke|antikt|antikvitet(en|er|erne)?|antique|empire|rokoko|barok|biedermeier|chippendale|s(ø|oe)lvt(ø|oe)j|bornholmer ?ur|standur|lommeur)",
      },
    ],
  },
];

// ---------------------------------------------------------------- Motor

function ekspander(m: string): string {
  let r = m;
  for (const [navn, vaerdi] of KUNST_PLADSHOLDERE) r = r.split(navn).join(vaerdi);
  return r;
}

const AKTIVE_RAA: readonly KunstRegel[] = [
  ...KUNST_REGLER_RAA,
  ...KUNST_UAFKLAREDE.filter((g) => g.aktiv).flatMap((g) => g.regler),
];

// Den udfoldede liste - præcis det, public.kunst_ord() returnerer.
export const KUNST_REGLER: readonly {
  nr: number;
  moenster: string;
  kraever: string | null;
  undtagen: string | null;
}[] = AKTIVE_RAA.map((r, i) => ({
  nr: i + 1,
  moenster: ekspander(r.moenster),
  kraever: r.kraever ? ekspander(r.kraever) : null,
  undtagen: r.undtagen ? ekspander(r.undtagen) : null,
}));

// Præcis det, public.kunst_fjern() returnerer.
export const KUNST_FJERN: string = ekspander(KUNST_FJERN_RAA);

// Højst så mange tegn tjekkes (som left(p_tekst, 5000) i SQL).
export const KUNST_MAKS_TEGN = 5000;

const FJERN_RE = helOrd(KUNST_FJERN);
const KOMPILEREDE = KUNST_REGLER.map((r) => ({
  ...r,
  re: helOrd(r.moenster),
  kraeverRe: r.kraever ? helOrd(r.kraever) : null,
  undtagenRe: r.undtagen ? helOrd(r.undtagen) : null,
}));

const B = "a-zæøå";
const SKILLE = "[-.·_*']";
// Accenter fjernes i varianten (é -> e). HOLD SYNKRON med translate() i
// public.kunst_sloer_variant.
const ACCENT_FRA = "äöüéèáàâêëíìîïóòôúùûñç";
const ACCENT_TIL = "aoueeaaaeeiiiiooouuunc";
const SAML_SKILLE = new RegExp(`([${B}])${SKILLE}(?=[${B}])`, "g");
const ET_BOGSTAV = new RegExp(`^[${B}]$`);

// Afslører simple forsøg på at skjule et ord. Samme trin som
// public.kunst_sloer_variant(p_tekst, p_et):
//   1. små bogstaver (NFC), usynlige tegn fjernes
//   2. @ -> a, € -> e, accenter fjernes (é -> e)
//   3. 3/1/0 ved siden af et bogstav -> e/<et>/o (et = "i" eller "l")
//   4. skilletegn (- . · _ * ') mellem to bogstaver fjernes ("ma-leri")
//   5. normalisering, og 3+ enkeltbogstaver i træk sættes sammen ("m a l e r i")
export function kunstSloerVariant(raa: string, et: "i" | "l" = "i"): string {
  let t = raa.normalize("NFC").toLowerCase().replace(USYNLIGE, "");
  t = t.replace(/@/g, "a").replace(/€/g, "e");
  t = Array.from(t)
    .map((c) => {
      const i = ACCENT_FRA.indexOf(c);
      return i >= 0 ? ACCENT_TIL[i] : c;
    })
    .join("");
  for (const [tal, bogstav] of [
    ["3", "e"],
    ["1", et],
    ["0", "o"],
  ] as const) {
    for (let i = 0; i < 2; i++) {
      t = t.replace(new RegExp(`([${B}])${tal}`, "g"), `$1${bogstav}`);
      t = t.replace(new RegExp(`${tal}([${B}])`, "g"), `${bogstav}$1`);
    }
  }
  t = t.replace(SAML_SKILLE, "$1");
  t = normaliserTekst(t);
  const ud: string[] = [];
  let raekke: string[] = [];
  const toem = () => {
    if (raekke.length >= 3) ud.push(raekke.join(""));
    else ud.push(...raekke);
    raekke = [];
  };
  for (const ord of t.split(" ")) {
    if (ET_BOGSTAV.test(ord)) raekke.push(ord);
    else {
      toem();
      ud.push(ord);
    }
  }
  toem();
  return ud.filter((o) => o !== "").join(" ");
}

// Teksten efter de tilladte fraser er fjernet (som public.kunst_rens).
function rens(norm: string): string {
  return fjernFraser(norm, FJERN_RE);
}

// To og to ord sat sammen ("ma leri" -> "maleri"), bygget af den RENSEDE
// tekst, så tilladte fraser ikke bliver til kunst-ord. Ordene selv står
// først, så undtagelser stadig ses. "" ved under to ord. Som public.kunst_par.
export function kunstPar(norm: string): string {
  const ord = rens(norm).split(" ").filter((o) => o !== "");
  if (ord.length < 2) return "";
  const par: string[] = [];
  for (let i = 0; i < ord.length - 1; i++) par.push(ord[i] + ord[i + 1]);
  return [...ord, ...par].join(" ");
}

export type KunstResultat = { resultat: "ok" } | { resultat: "kunst"; ord: string; nr: number };

function tjekNormaliseret(norm: string): KunstResultat | null {
  const renset = rens(norm);
  for (const r of KOMPILEREDE) {
    const m = renset.match(r.re);
    if (!m) continue;
    if (r.kraeverRe && !r.kraeverRe.test(renset)) continue;
    if (r.undtagenRe && r.undtagenRe.test(renset)) continue;
    return { resultat: "kunst", ord: m[2], nr: r.nr };
  }
  return null;
}

// Samme logik som public.kunst_tekst_tjek: den normaliserede tekst, derefter
// varianterne med 1 -> i og 1 -> l - og for hver også to ord samlet.
export function tjekKunstTekst(...tekster: (string | null | undefined)[]): KunstResultat {
  // Tegn (ikke UTF-16-enheder), som left() i Postgres.
  const raa = Array.from(tekster.filter(Boolean).join(" ")).slice(0, KUNST_MAKS_TEGN).join("");
  const norm = normaliserTekst(raa);
  if (norm === "") return { resultat: "ok" };
  const set: string[] = [];
  for (const k of [norm, kunstSloerVariant(raa, "i"), kunstSloerVariant(raa, "l")]) {
    if (k === "" || set.includes(k)) continue;
    set.push(k);
    const r = tjekNormaliseret(k);
    if (r) return r;
    const par = kunstPar(k);
    if (par !== "") {
      const p = tjekNormaliseret(par);
      if (p) return p;
    }
  }
  return { resultat: "ok" };
}

// ---------------------------------------------------------------- Tekster

export const KUNST_TEKST = {
  // Kort forklaring (forbudte varer, FAQ, betingelser).
  forklaring:
    "Kunst må ikke sælges på BidHamr: malerier, tegninger, skulpturer, grafiske tryk og litografier – også signerede og nummererede – og kunst, du selv har lavet. Plakater og masseproducerede billeder uden kunstner, fx fra IKEA, må gerne sælges.",
  // Advarsel i opret/ret auktion.
  advarselTitel: "Er det kunst?",
  advarsel: (ord: string) =>
    `Ordet "${ord}" tyder på, at varen er kunst. Kunst må ikke sælges på BidHamr: malerier, tegninger, skulpturer, grafiske tryk og litografier – også signerede og nummererede – og kunst, du selv har lavet. Plakater og masseproducerede billeder uden kunstner, fx fra IKEA, må gerne sælges.`,
  bekraeft: "Det er ikke kunst",
  bekraeftHjaelp:
    "Er det fx en plakat eller et masseproduceret billede, kan du fortsætte. Auktionen bliver først synlig for andre, når en medarbejder har tjekket den. Er det kunst, bliver den fjernet.",
  mangler: "Bekræft, at varen ikke er kunst – eller ret titlen og beskrivelsen.",
  // Auktionen afventer staff-tjek (kunst_kontrol = 'afventer').
  afventerTitel: "Afventer kontrol – BidHamr tjekker, at det ikke er kunst",
  afventerSaelger:
    "Andre kan ikke se auktionen eller byde, før vi har tjekket den. Tiden løber imens. Er auktionen ikke tjekket, før den slutter, slutter den uden bud.",
  afventerStaff: "Kun sælgeren og BidHamrs medarbejdere kan se auktionen, og der kan ikke bydes. Afgør anmeldelsen under Anmeldelser.",
  // Databasens afvisning af et bud (BHK01).
  budAfvist: "Auktionen afventer kontrol hos BidHamr, og der kan ikke bydes endnu.",
} as const;

// Databasens fejlkode, når der bydes på en auktion, der afventer kunst-kontrol.
export const KUNST_BUD_FEJLKODE = "BHK01";

export function erKunstBudFejl(code: string | null | undefined, message?: string | null): boolean {
  return code === KUNST_BUD_FEJLKODE || (message ?? "").includes("kunst_kontrol:");
}
