// Kontaktoplysninger i en auktions titel og beskrivelse (Filip, 27. okt. 2026).
//
// Telefonnumre, e-mails, links og MobilePay-/bankoplysninger må ikke stå i
// auktionen - køber og sælger skal tale sammen via BidHamr, og al betaling
// går via BidHamr.
//   - Private: alt, som chattens spamfilter stopper (spamGrund), blokeres.
//   - Firmaer (users.konto_type = 'erhverv'): links må gerne stå (fx til
//     firmaets egen hjemmeside). Kun værtsnavnet fjernes - stien tjekkes som
//     resten af teksten, og et link med 7 eller flere cifre stoppes. Telefon,
//     e-mail, MobilePay, bank og sociale medier blokeres stadig -
//     kontaktoplysningerne står på firmasiden.
//   - Beskedtjenester, sociale medier, betalingsapps og linkforkortere som
//     link (wa.me, t.me, facebook, instagram, x.com, linkedin, youtube,
//     discord, signal.me, mobilepay, paypal, bit.ly, linktr.ee ...) stoppes
//     for alle.
//   - Teksten læses som tegnene: alle %XX (ASCII) og HTML-entiteter (&#64;,
//     &#x40;, &commat; ...) afkodes, og alle Unicode-cifre (fx arabisk-indiske)
//     læses som 0-9.
//   - 8 cifre stoppes ALTID (chefen, 27. okt. 2026) - et dansk telefonnummer
//     kan ikke skelnes fra et varenummer på 8 cifre. Cifre i en "kæde" er
//     adskilt af mellemrum eller tegnene . , ; : _ * | + ( ) [ ] { } < > / \ ~
//     = ' " & ! ? ^ - – — (gerne flere i træk) eller enhederne db/hz/khz/mhz/ghz.
//       * efter et vareord eller en mærkat (varenr., SKU, EAN, art.nr.,
//         model, ID, nr ...): 8 cifre i alt, 0/00/45/0045 + 8 cifre, en blok
//         på 8 cifre, eller 8 cifre i grupperne 4-4 eller 2-2-2-2 inde i et
//         længere nummer ("2233/4455/1", "1-2233-4455").
//       * ellers: det samme, medmindre chattens filter kender cifrene som
//         dato, klokkeslæt, beløb, årstal eller størrelser (filteret køres på
//         højst 40 tegn før kæden + nummeret, hvert vindue én gang; over 50
//         forskellige mulige telefonnumre stoppes). 0/00/45/0045 + 8 cifre
//         stoppes altid.
//   - Bankoplysninger skrevet som varenummer: står der et bankord (bank,
//     netbank, konto, kontonr, bankoverførsel, overfør..., reg.nr, reg + 4
//     cifre ... - ikke "powerbank" eller "reg. højde") i teksten, stoppes 4
//     cifre efterfulgt af 6-10 cifre og en blok på 10-14 cifre (ikke med en
//     enhed som km/kr bagefter, og ikke når de 4 cifre er årstallet i en dato
//     som 15.03.2024 eller 2024-03-15 - medmindre en blok på 6-10 cifre
//     følger lige efter datoen). Er bankordet kun det svage "bank"/"netbank",
//     kræves 8-10 cifre efter de 4 lige efter et vareord (EAN/SKU/varenr).
//     Passivformerne "overføres"/"overført" er ikke bankord; er de det
//     eneste bankord (også for chattens filter), læser chattens filter ikke
//     numre efter en mærkat ("Garanti overføres, kvittering nr 1234 5678 90").
//   - En ISO-dato (åååå-mm-dd, også . og /, måned 1-12, dag 1-31) er ikke et
//     telefonnummer, når hele cifferkæden er datoen og der intet kontaktord
//     står ("Købt 2023-11-24"; "Ring 2023-11-24" stoppes).
//   - MobilePay (også "mobile pay", "mp box 1234", "på mp") stoppes altid.
//   - E-mail skrevet med mellemrum ("hans @ gmail . com"), som "hans på
//     gmail", "hans.hansen icloud", "hans123 på outlook" eller "skriv/kontakt
//     mig på mail" stoppes. "iCloud-låst", "iPhone13 iCloud låst op",
//     "Office2019 outlook", "Gmail-konto" og "kvittering sendes på mail" må
//     gerne stå.
//   - Kombinationstegn (Unicode M), formattegn (Cf), Default_Ignorable-tegn og
//     U+2800 fjernes efter normaliseringen.
//   - Står der intet kontaktord, neutraliseres - EFTER 8-cifre-tjekket -
//     varenumre med andre længder (fx 6, 7, 9 eller flere cifre) efter et
//     vareord og signalværdier ("Signal: analog", "Signal: 20 dB" - højst 4
//     cifre). IKEA-numre ("402.638.47") neutraliseres FØR 8-cifre-tjekket,
//     kun når ordet "ikea" står i teksten. "nr"/"nummer" i et vareord ("Vare
//     nr.", "Del nummer") tæller ikke som kontaktord. Kun i auktioner -
//     chatten er uændret.
//   - Tekster over 2.000 tegn afvises ('for_lang'; databasen tillader højst
//     120/500 tegn).
//
// SPEJL af public.auktion_kontaktinfo_grund i
// supabase/migrations/20261102300000_kontaktinfo_rettelser5.sql. Databasen
// afgør altid (triggeren auctions_zzz_kontaktinfo, fejlkode BHA08); denne
// kopi viser fejlen ved feltet, mens brugeren skriver. Ændres en regel, SKAL
// begge steder rettes (eksemplerne står begge steder:
// tests/enhed/auktionKontaktinfoEksempler.ts og testblokken i migrationen).
//
// Ingen server-only-import: klientkomponenterne bruger den.

import { normaliserBesked, spamGrund, type SpamGrund } from "@/lib/tryghed";

export const AUKTION_KONTAKTINFO_KODE = "BHA08";

export type AuktionKontaktFelt = "titel" | "beskrivelse";

type Grund = Exclude<SpamGrund, "gentaget"> | "for_lang";

// Højst så mange tegn (kodepunkter) tjekkes - længere tekster afvises.
const MAKS_TEGN = 2000;
// Højst så mange forskellige mulige telefonnumre tjekkes med chattens filter.
// Flere stoppes ('telefon') - en almindelig beskrivelse har langt færre.
const MAKS_CHATTJEK = 50;

// Postgres' \m / \M (ordstart/ordslut). Postgres regner æøå som bogstaver.
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

// Ekstra topdomæner, som chatfilteret ikke kender (be, ee ...) - links her også.
const EKSTRA_TLD = "(be|ee|fi|nl|ch|uk|pl|tv|cc|gg)";
const EKSTRA_LINK = new RegExp(`${B}[a-z0-9-]{2,}\\.${EKSTRA_TLD}${E}`, "u");
const TLD = "(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co|be|ee|fi|nl|ch|uk|pl|tv|cc|gg)";
// Værtsnavnet i et link (https://..., www.... eller navn.dk).
const VAERT =
  "(https?://[a-z0-9.-]+" +
  "|(?<![a-z0-9.@-])www\\.[a-z0-9.-]+" +
  `|(?<![a-z0-9.@-])([a-z0-9-]+\\.)+${TLD}${E})`;
const VAERT_RE = new RegExp(VAERT, "gu");
// Et helt link: værtsnavn + sti/forespørgsel til næste mellemrum.
const LINK_RE = new RegExp(`${VAERT}([/?#:]\\S*)?`, "gu");

// Beskedtjenester, sociale medier, betalingsapps og linkforkortere som
// domæne - altid stoppet.
const BLOK_TLD =
  `(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co|gg|am|to|be|ee|gl|gd|in|it|tv)${E}`;
const BLOK_START = "(?<![a-z0-9.@-])([a-z0-9-]+\\.)*";
const BLOK_SOME = new RegExp(
  `${BLOK_START}(((wa|t|m|fb|vb)\\.me|fb\\.com|x\\.com|youtu\\.be|instagr\\.am|discord\\.gg|threads\\.(net|com)` +
    `|signal\\.(me|org|group)|lnkd\\.in|pin\\.it|redd\\.it)${E}` +
    "|[a-z0-9-]*(whatsapp|telegram|messenger|facebook|instagram|snapchat|tiktok" +
    `|twitter|linkedin|youtube|pinterest|discord|viber|reddit)[a-z0-9-]*\\.${BLOK_TLD})`,
  "u",
);
const BLOK_MOBILEPAY = new RegExp(`${BLOK_START}[a-z0-9-]*mobilepay[a-z0-9-]*\\.${BLOK_TLD}`, "u");
const BLOK_BETALING = new RegExp(`${BLOK_START}[a-z0-9-]*(revolut|paypal|swipp)[a-z0-9-]*\\.${BLOK_TLD}`, "u");
const BLOK_KORT = new RegExp(
  `${BLOK_START}(bit\\.ly|tinyurl\\.com|t\\.ly|goo\\.gl|is\\.gd|ow\\.ly|rebrand\\.ly|linktr\\.ee` +
    `|cutt\\.ly|rb\\.gy|tiny\\.cc|shorturl\\.at)${E}`,
  "u",
);

// Et brugernavn: bogstaver med . eller _ ("hans.hansen", "hans_12").
// Bogstaver + cifre alene ("iPhone13", "Office2019", "ios17") tæller ikke -
// kun med "på" foran mailudbyderen ("hans123 på outlook").
const BRUGER = "(?<![a-z0-9._%+@-])([a-z][a-z0-9]*([._][a-z0-9]+)+)";
const BRUGER_CIFRE = "(?<![a-z0-9._%+@-])([a-z]+[0-9][a-z0-9]*)";
// Et kontaktverbum foran "på mail": skriv (til mig), send mig, kontakt (mig).
const KONTAKTVERBUM = "(skriv(e|er)?(\\s+(til\\s+)?mig)?|send(e|er)?\\s+mig|kontakt(e|er)?(\\s+mig)?)";

// E-mail, som chatfilteret ikke kender: mellemrum om punktummet ("hans @
// gmail . com"), en mailudbyder som ord ("hans på gmail" - men ikke
// "gmail-konto"), iCloud/Outlook med et brugernavn eller @ ved siden af
// ("hans.hansen icloud" - men ikke "iCloud-låst") og "skriv/send mig/kontakt
// (mig) på mail" (men ikke "kvittering sendes på mail").
const EMAIL_EKSTRA = new RegExp(
  `[a-z0-9._%+-]+\\s*(@|\\(at\\)|\\[at\\]|${B}snabel-?a${E})\\s*[a-z0-9-]*[a-z][a-z0-9-]*\\s*(\\.|${B}(punktum|dot)${E})\\s*[a-z]{2,}` +
    `|${B}(g-?mail|hotmail|protonmail|yahoo|gmx)${E}(?!-[a-zæøå])` +
    `|${BRUGER}\\s+(på\\s+)?(icloud|outlook)${E}(?!-[a-zæøå])` +
    `|${BRUGER_CIFRE}\\s+på\\s+(icloud|outlook)${E}(?!-[a-zæøå])` +
    `|${B}icloud(\\s*[:=]\\s*|\\s+)${BRUGER}${E}` +
    `|@\\s*(icloud|outlook)${E}|${B}(icloud|outlook)\\s*@` +
    `|${B}${KONTAKTVERBUM}\\s+(på|via|over|til|pr\\.?|per)\\s+(e-?mail|mail)${E}`,
  "u",
);

// MobilePay som ord - al betaling går via BidHamr. "mp" alene er også
// megapixel ("12 mp"), så det kræver "mp box"/"mp-boks" lige efter hinanden
// med cifre bagefter, eller et ord som "på mp".
const MOBILEPAY_ORD = new RegExp(
  `${B}(m[o0]bil[e3]?\\s*-?\\s*pay|m-?pay)${E}` +
    `|${B}mp\\s*-?\\s*(box|boks)[\\s:#.-]*[0-9]` +
    `|${B}(på|via|med|over|eller|og|til)\\s+mp${E}` +
    `|${B}mp\\s+(ok|modtages|tages|velkommen|accepteres)${E}`,
  "u",
);

// Står et af disse ord i teksten (uden for et vareord), neutraliseres intet.
// Fast ordliste for konto/bank ("kontor", "bankskab" tæller ikke).
const KONTAKTORD = new RegExp(
  `${B}(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt` +
    "|skriv|skrive|skriver|besked|beskeden|beskeder|opkald|nummer|nummeret|nr" +
    "|whats\\s*app|mobile?\\s*-?\\s*pay|m-?pay|mp|swish|vipps" +
    "|konto|kontoen|kontonr|kontonummer|bank|banken|bankkonto|bankoverførsel" +
    `|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)${E}`,
  "u",
);
// Bankord til "4 cifre + 6-10 cifre": fast liste med ordstart ("powerbank"
// tæller ikke). "reg" kun som reg.nr/regnr/reg nr eller reg + 4 cifre
// ("reg. højde" tæller ikke). "overfør..." skal stå i starten af et ord.
// Passivformerne "overføres" og "overført" er ikke bankord ("Garantien
// overføres, EAN 1234 567890").
const BANKORD = new RegExp(
  `${B}(bank|banken|netbank|netbanken|bankkonto|bankkontoen|bankoverførsel|bankoverførslen` +
    `|konto|kontoen|kontonr|kontonummer|kontonummeret|regnr|registreringsnummer|registreringsnr|iban` +
    `|overf(ø|o)r(?!(es|t)${E})[a-zæøå]*)${E}` +
    `|${B}reg\\.?\\s*nr${E}|${B}reg[.:]?\\s*[0-9]{4}(?![0-9])`,
  "u",
);
// De stærke bankord (alt undtagen "bank"/"banken"/"netbank"/"netbanken"):
// står et af dem i teksten, gælder undtagelsen for vareord ikke, og 4 + 6-10
// cifre stoppes altid ("Kontonr: varenr 1234 1234567").
const BANKORD_STAERK = new RegExp(
  `${B}(bankkonto|bankkontoen|bankoverførsel|bankoverførslen` +
    `|konto|kontoen|kontonr|kontonummer|kontonummeret|regnr|registreringsnummer|registreringsnr|iban` +
    `|overf(ø|o)r(?!(es|t)${E})[a-zæøå]*)${E}` +
    `|${B}reg\\.?\\s*nr${E}|${B}reg[.:]?\\s*[0-9]{4}(?![0-9])`,
  "u",
);
// Passivformerne "overføres"/"overført". Chattens filter læser dem som
// bankord; er de det eneste bankord, skjules numre efter en mærkat for
// chattens filter til sidst ("Garanti overføres, kvittering nr 1234 5678 90").
const PASSIV = new RegExp(`${B}overf(ø|o)r(es|t)${E}`, "gu");
// Chattens bankord (P_BANK_ORD i src/lib/tryghed.ts).
const BANKORD_CHAT = new RegExp(
  `${B}(bank[a-zæøå]*|konto[a-zæøå]*|overf(ø|o)r[a-zæøå]*|indbetal[a-zæøå]*|indsæt[a-zæøå]*|iban` +
    `|regnr|registreringsn[a-zæøå]*|reg\\.?\\s*(nr|nummer))${E}`,
  "u",
);
// En enhed lige efter et nummer: så er det ikke et kontonummer ("145000 km").
const ENHED_EFTER = new RegExp(`^\\s*((km|kr|kroner|dkk|kg|gram|g|cm|mm|ml|l)${E}|,-|\\.-)`, "u");
// Et vareord: varenummer, art.nr., produktnr., reservedelsnr., delnr., SKU,
// EAN. "vare", "del" osv. alene tæller ikke.
const VAREORD_ORD_S = `${B}(sku|ean|(vare|artikel|produkt|reservedel|del|art)s?e?\\.?\\s*(nr|nummer|nummeret))${E}`;
const VAREORD_ORD = new RegExp(VAREORD_ORD_S, "gu");
// Vareord + mindst 6 cifre/skilletegn uden mellemrum. Neutraliseres kun uden
// kontaktord og efter 8-cifre-tjekket.
const VAREORD = new RegExp(`${VAREORD_ORD_S}\\.?[\\s:#]*[0-9][0-9./-]{4,}[0-9](?![0-9])`, "gu");
// Et vareord lige før et nummer (EAN, SKU, varenr ...): så kræver
// kontoreglen 4 cifre + mindst 8 cifre ("Varenr 1234 567890" er et varenummer).
const VARE_FOER = new RegExp(`${VAREORD_ORD_S}\\.?[\\s.:#]*$`, "u");
// Skilletegn mellem cifre i et nummer (gerne flere i træk).
const SKILLE = String.raw`[\s.,;:_*|+()\[\]{}<>/\\~='"&!?^–—-]`;
// Et vareord eller en anden mærkat + nummeret efter den.
const MAERKAT = new RegExp(
  `${B}(sku|ean|imei|id|nr|nummer|nummeret|ref|reference|stregkode|art` +
    "|model[a-zæøå]*|ordre[a-zæøå]*|serie\\s*nr|serienummer[a-zæøå]*|kunde\\s*nr|kundenummer[a-zæøå]*" +
    "|faktura[a-zæøå]*|pakke[a-zæøå]*|varenummer[a-zæøå]*" +
    `|(vare|artikel|produkt|reservedel|del|art)s?e?\\.?\\s*(nr|nummer|nummeret))${E}` +
    `[\\s.:#]*((nr|nummer|nummeret)${E})?[\\s.:#]*[0-9](${SKILLE}*[0-9])*`,
  "gu",
);
// En kæde af cifre: skilletegn eller en signalenhed (db, hz ...) imellem.
const KAEDE = new RegExp(`[0-9]+((${SKILLE}|(db|khz|mhz|ghz|hz)${E})+[0-9]+)*`, "gu");
// Et telefonnummer: 8 cifre (første 2-9), evt. med 0, 00, 45 eller 0045 foran.
const TLF_CIFRE = /^(0045|00|0|45)?[2-9][0-9]{7}$/u;
const TLF_FORAN = /^(0045|00|0|45)[2-9][0-9]{7}$/u;
const AAR = /^(19|20)[0-9]{2}$/u;
// Et årstalspar ("Model 2019 2020") er ikke et telefonnummer.
const AARSPAR = /^(19|20)[0-9]{2}[\s/-]+(19|20)[0-9]{2}$/u;
// IKEA-format: 402.638.47 - kun når ordet "ikea" står i teksten.
const IKEA_ORD = new RegExp(`${B}ikea${E}`, "u");
const IKEA = /(?<![0-9]\.?)[0-9]{3}\.[0-9]{3}\.[0-9]{2}(?!\.?[0-9])/gu;
// Tekniske signalværdier: "Signal: analog", "Signal: 20 dB" (højst 4 cifre).
const SIGNAL = new RegExp(
  `${B}signal\\s*[:=]\\s*(analog|digital|hdmi|dvb[a-z0-9-]*|wifi|bluetooth|stereo|mono|svagt|godt|stærkt` +
    `|[0-9]{1,4}\\s*(db|mhz|ghz|hz))${E}`,
  "gu",
);

// Nullet i hver række af Unicode-cifre (Nd) ud over 0-9 (Unicode 16). De ti
// cifre fra nullet læses som 0-9. Samme liste i databasen.
const CIFFER_NUL = [
  1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872, 4160, 4240, 6112,
  6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472, 43504, 43600, 44016, 65296, 66720,
  68912, 68928, 69734, 69872, 69942, 70096, 70384, 70736, 70864, 71248, 71360, 71376, 71386, 71472, 71904, 72016,
  72688, 72784, 73040, 73120, 73552, 90416, 92768, 92864, 93008, 93552, 118000, 120782, 120792, 120802, 120812, 120822,
  123200, 123632, 124144, 124401, 125264, 130032,
];
const CIFFER = new Map<string, string>();
for (const nul of CIFFER_NUL) {
  for (let d = 0; d < 10; d++) CIFFER.set(String.fromCodePoint(nul + d), String(d));
}

// Tegn, der fjernes efter normaliseringen, som par [fra, til] (Unicode 16):
// kombinationstegn (M: Mn, Mc, Me - "2" + U+0301 ... læses som "2"),
// formattegn (Cf) og Default_Ignorable_Code_Point (fx U+200B, U+2060,
// U+180E, U+061C, U+202A-202E, U+2066-2069, U+115F, U+1160, U+3164, U+FFA0,
// U+1D173-1D17A, U+E0000-E0FFF) samt U+2800 (blankt punktskrifttegn).
// NFKC har allerede samlet æ/ø/å og é. Samme liste i databasen.
const MAERKE_PAR = [
  173, 173, 768, 879, 1155, 1161, 1425, 1469, 1471, 1471, 1473, 1474, 1476, 1477, 1479, 1479, 1536, 1541, 1552, 1562,
  1564, 1564, 1611, 1631, 1648, 1648, 1750, 1757, 1759, 1764, 1767, 1768, 1770, 1773, 1807, 1807, 1809, 1809, 1840,
  1866, 1958, 1968, 2027, 2035, 2045, 2045, 2070, 2073, 2075, 2083, 2085, 2087, 2089, 2093, 2137, 2139, 2192, 2193,
  2199, 2207, 2250, 2307, 2362, 2364, 2366, 2383, 2385, 2391, 2402, 2403, 2433, 2435, 2492, 2492, 2494, 2500, 2503,
  2504, 2507, 2509, 2519, 2519, 2530, 2531, 2558, 2558, 2561, 2563, 2620, 2620, 2622, 2626, 2631, 2632, 2635, 2637,
  2641, 2641, 2672, 2673, 2677, 2677, 2689, 2691, 2748, 2748, 2750, 2757, 2759, 2761, 2763, 2765, 2786, 2787, 2810,
  2815, 2817, 2819, 2876, 2876, 2878, 2884, 2887, 2888, 2891, 2893, 2901, 2903, 2914, 2915, 2946, 2946, 3006, 3010,
  3014, 3016, 3018, 3021, 3031, 3031, 3072, 3076, 3132, 3132, 3134, 3140, 3142, 3144, 3146, 3149, 3157, 3158, 3170,
  3171, 3201, 3203, 3260, 3260, 3262, 3268, 3270, 3272, 3274, 3277, 3285, 3286, 3298, 3299, 3315, 3315, 3328, 3331,
  3387, 3388, 3390, 3396, 3398, 3400, 3402, 3405, 3415, 3415, 3426, 3427, 3457, 3459, 3530, 3530, 3535, 3540, 3542,
  3542, 3544, 3551, 3570, 3571, 3633, 3633, 3636, 3642, 3655, 3662, 3761, 3761, 3764, 3772, 3784, 3790, 3864, 3865,
  3893, 3893, 3895, 3895, 3897, 3897, 3902, 3903, 3953, 3972, 3974, 3975, 3981, 3991, 3993, 4028, 4038, 4038, 4139,
  4158, 4182, 4185, 4190, 4192, 4194, 4196, 4199, 4205, 4209, 4212, 4226, 4237, 4239, 4239, 4250, 4253, 4447, 4448,
  4957, 4959, 5906, 5909, 5938, 5940, 5970, 5971, 6002, 6003, 6068, 6099, 6109, 6109, 6155, 6159, 6277, 6278, 6313,
  6313, 6432, 6443, 6448, 6459, 6679, 6683, 6741, 6750, 6752, 6780, 6783, 6783, 6832, 6862, 6912, 6916, 6964, 6980,
  7019, 7027, 7040, 7042, 7073, 7085, 7142, 7155, 7204, 7223, 7376, 7378, 7380, 7400, 7405, 7405, 7412, 7412, 7415,
  7417, 7616, 7679, 8203, 8207, 8234, 8238, 8288, 8303, 8400, 8432, 10240, 10240, 11503, 11505, 11647, 11647, 11744,
  11775, 12330, 12335, 12441, 12442, 12644, 12644, 42607, 42610, 42612, 42621, 42654, 42655, 42736, 42737, 43010,
  43010, 43014, 43014, 43019, 43019, 43043, 43047, 43052, 43052, 43136, 43137, 43188, 43205, 43232, 43249, 43263,
  43263, 43302, 43309, 43335, 43347, 43392, 43395, 43443, 43456, 43493, 43493, 43561, 43574, 43587, 43587, 43596,
  43597, 43643, 43645, 43696, 43696, 43698, 43700, 43703, 43704, 43710, 43711, 43713, 43713, 43755, 43759, 43765,
  43766, 44003, 44010, 44012, 44013, 64286, 64286, 65024, 65039, 65056, 65071, 65279, 65279, 65440, 65440, 65520,
  65531, 66045, 66045, 66272, 66272, 66422, 66426, 68097, 68099, 68101, 68102, 68108, 68111, 68152, 68154, 68159,
  68159, 68325, 68326, 68900, 68903, 68969, 68973, 69291, 69292, 69372, 69375, 69446, 69456, 69506, 69509, 69632,
  69634, 69688, 69702, 69744, 69744, 69747, 69748, 69759, 69762, 69808, 69818, 69821, 69821, 69826, 69826, 69837,
  69837, 69888, 69890, 69927, 69940, 69957, 69958, 70003, 70003, 70016, 70018, 70067, 70080, 70089, 70092, 70094,
  70095, 70188, 70199, 70206, 70206, 70209, 70209, 70367, 70378, 70400, 70403, 70459, 70460, 70462, 70468, 70471,
  70472, 70475, 70477, 70487, 70487, 70498, 70499, 70502, 70508, 70512, 70516, 70584, 70592, 70594, 70594, 70597,
  70597, 70599, 70602, 70604, 70608, 70610, 70610, 70625, 70626, 70709, 70726, 70750, 70750, 70832, 70851, 71087,
  71093, 71096, 71104, 71132, 71133, 71216, 71232, 71339, 71351, 71453, 71467, 71724, 71738, 71984, 71989, 71991,
  71992, 71995, 71998, 72000, 72000, 72002, 72003, 72145, 72151, 72154, 72160, 72164, 72164, 72193, 72202, 72243,
  72249, 72251, 72254, 72263, 72263, 72273, 72283, 72330, 72345, 72751, 72758, 72760, 72767, 72850, 72871, 72873,
  72886, 73009, 73014, 73018, 73018, 73020, 73021, 73023, 73029, 73031, 73031, 73098, 73102, 73104, 73105, 73107,
  73111, 73459, 73462, 73472, 73473, 73475, 73475, 73524, 73530, 73534, 73538, 73562, 73562, 78896, 78912, 78919,
  78933, 90398, 90415, 92912, 92916, 92976, 92982, 94031, 94031, 94033, 94087, 94095, 94098, 94180, 94180, 94192,
  94193, 113821, 113822, 113824, 113827, 118528, 118573, 118576, 118598, 119141, 119145, 119149, 119170, 119173,
  119179, 119210, 119213, 119362, 119364, 121344, 121398, 121403, 121452, 121461, 121461, 121476, 121476, 121499,
  121503, 121505, 121519, 122880, 122886, 122888, 122904, 122907, 122913, 122915, 122916, 122918, 122922, 123023,
  123023, 123184, 123190, 123566, 123566, 123628, 123631, 124140, 124143, 124398, 124399, 125136, 125142, 125252,
  125258, 917504, 921599,
];
const MAERKE = new RegExp(
  "[" +
    Array.from({ length: MAERKE_PAR.length / 2 }, (_, i) => {
      const [fra, til] = [MAERKE_PAR[2 * i], MAERKE_PAR[2 * i + 1]];
      const u = (k: number) => `\\u{${k.toString(16)}}`;
      return fra === til ? u(fra) : `${u(fra)}-${u(til)}`;
    }).join("") +
    "]",
  "gu",
);

function asciiCifre(v: string): string {
  if (!/[^\u0000-ɏ]/u.test(v)) return v;
  return Array.from(v, (tegn) => CIFFER.get(tegn) ?? tegn).join("");
}

// Erstat hver forekomst (sorteret, som "order by ... collate C" i databasen).
function erstatAlle(v: string, re: RegExp, afkod: (m: string) => string | null): string {
  const fund = [...new Set(Array.from(v.matchAll(re), (m) => m[0]))].sort();
  for (const m of fund) {
    const r = afkod(m);
    if (r !== null) v = v.split(m).join(r);
  }
  return v;
}

const ENTITET = /&#(x[0-9a-f]{1,6}|[0-9]{1,7});?|&(amp|commat|period|sol|colon|nbsp|plus|percnt|lowbar|hyphen|dash|lpar|rpar|num|quot|apos|lt|gt);/gu;
const NAVNGIVET: Record<string, string> = {
  amp: "&", commat: "@", period: ".", sol: "/", colon: ":", nbsp: " ", plus: "+", percnt: "%", lowbar: "_",
  hyphen: "-", dash: "-", lpar: "(", rpar: ")", num: "#", quot: '"', apos: "'", lt: "<", gt: ">",
};

function afkodEntitet(m: string): string {
  if (!m.startsWith("&#")) return NAVNGIVET[m.slice(1, -1)] ?? " ";
  const tal = m.replace(/;$/, "").slice(2);
  const kode = tal.startsWith("x") ? parseInt(tal.slice(1), 16) : parseInt(tal, 10);
  if (kode < 1 || kode > 0x10ffff || (kode >= 0xd800 && kode <= 0xdfff)) return " ";
  return String.fromCodePoint(kode);
}

// %XX: ASCII-tegn afkodes (kontroltegn bliver et mellemrum); %80-%ff røres ikke.
function afkodProcent(m: string): string | null {
  const kode = parseInt(m.slice(1), 16);
  if (kode >= 0x80) return null;
  return kode < 0x20 || kode === 0x7f ? " " : String.fromCharCode(kode);
}

// HTML-entiteter og %XX afkodes (op til 4 gange: "%2540", "&#38;#64;").
function afkod(v: string): string {
  for (let i = 0; i < 4; i++) {
    const foer = v;
    v = erstatAlle(v, ENTITET, afkodEntitet);
    v = erstatAlle(v, /%[0-9a-f]{2}/gu, afkodProcent);
    v = normaliserBesked(v).replace(MAERKE, "");
    if (v === foer) break;
  }
  return v;
}

const laengde = (v: string) => Array.from(v).length;

// Blokke (cifre) og skilletegnene imellem: skille[k] står mellem blok k og k+1.
function del(nummer: string): { blokke: string[]; skille: string[] } {
  return { blokke: nummer.split(/[^0-9]+/), skille: nummer.split(/[0-9]+/).slice(1, -1) };
}

// Mulige telefonnumre i et nummer: [fra, til] (blokindeks). Hele nummeret
// med 8 cifre, en blok på 8 cifre og grupperne 4-4 og 2-2-2-2.
function kandidater(blokke: string[]): [number, number][] {
  const ud: [number, number][] = [];
  const n = blokke.length;
  if (blokke.join("").length === 8) ud.push([0, n - 1]);
  for (let i = 0; i < n; i++) {
    if (blokke[i].length === 8) ud.push([i, i]);
    if (i + 1 < n && blokke[i].length === 4 && blokke[i + 1].length === 4) ud.push([i, i + 1]);
    if (i + 3 < n && [0, 1, 2, 3].every((k) => blokke[i + k].length === 2)) ud.push([i, i + 3]);
  }
  return ud.filter(([fra]) => /^[2-9]/.test(blokke[fra]));
}

// Et nummer efter en mærkat, der kan være et telefonnummer.
function lignerTelefon(nummer: string): boolean {
  if (AARSPAR.test(nummer)) return false;
  const { blokke } = del(nummer);
  if (TLF_CIFRE.test(blokke.join(""))) return true;
  if (blokke.some((b) => TLF_CIFRE.test(b))) return true;
  // Et årstalspar inde i et længere nummer ("Model 2019 2020 2021") tæller ikke.
  return kandidater(blokke).some(([fra, til]) => !(til === fra + 1 && AAR.test(blokke[fra]) && AAR.test(blokke[til])));
}

// Skilletegn i en dato (15.03.2024, 15/03/2024, 15-03-2024, 2024-03-15).
const DATO_SKILLE = /^[./-]$/u;
const MAANED = /^(0?[1-9]|1[0-2])$/u;
const DAG = /^(0?[1-9]|[12][0-9]|3[01])$/u;

// Er de 4 cifre i blok i årstallet i en dato? dd.mm.åååå (ikke når en blok
// på 6-10 cifre følger lige efter: "konto 15.03.2024 12345678") eller
// åååå-mm-dd (måned 1-12, dag 1-31, ikke fortsat med . / - og ikke fulgt af
// en blok på 6-10 cifre).
function erDatoAar(blokke: string[], skille: string[], i: number): boolean {
  const n = blokke.length;
  if (!AAR.test(blokke[i])) return false;
  const lang = (k: number) => k < n && blokke[k].length >= 6 && blokke[k].length <= 10;
  if (
    i >= 2 &&
    blokke[i - 1].length <= 2 &&
    blokke[i - 2].length <= 2 &&
    DATO_SKILLE.test(skille[i - 2]) &&
    DATO_SKILLE.test(skille[i - 1]) &&
    !lang(i + 1)
  )
    return true;
  return (
    i + 2 < n &&
    blokke[i + 1].length <= 2 &&
    blokke[i + 2].length <= 2 &&
    DATO_SKILLE.test(skille[i]) &&
    DATO_SKILLE.test(skille[i + 1]) &&
    MAANED.test(blokke[i + 1]) &&
    DAG.test(blokke[i + 2]) &&
    !(i + 3 < n && DATO_SKILLE.test(skille[i + 2])) &&
    !lang(i + 3)
  );
}

// Bankoplysninger: 4 cifre + 6-10 cifre (efter et vareord: 8-10 cifre) eller
// en blok på 10-14 cifre. Er de 4 cifre et årstal i en dato ("15.03.2024 -
// 12.04.2024", "2024-03-15 10:30"), er det ikke et registreringsnummer.
function lignerKonto(blokke: string[], skille: string[], vare: boolean): boolean {
  const mindst = vare ? 8 : 6;
  for (let i = 0; i < blokke.length; i++) {
    if (blokke[i].length >= 10 && blokke[i].length <= 14) return true;
    if (blokke[i].length !== 4) continue;
    if (erDatoAar(blokke, skille, i)) continue;
    let sum = 0;
    for (let j = i + 1; j < blokke.length && sum < 10; j++) {
      sum += blokke[j].length;
      if (sum >= mindst && sum <= 10) return true;
    }
  }
  return false;
}

// Skilletegn i et kandidatnummer, som chatfilteret kan læse: . / - og
// mellemrum (højst 3) bevares, ":" bliver "." (klokkeslæt), resten et mellemrum.
function chatSkille(s: string): string {
  if (/^[\s./-]{1,3}$/u.test(s)) return s;
  return s === ":" ? "." : " ";
}

// Grunden (som spamGrund) eller null, hvis teksten må stå i auktionen.
export function auktionKontaktGrund(tekst: string | null | undefined, erhverv: boolean): Grund | null {
  const t = tekst ?? "";
  if (!t.trim()) return null;
  if (laengde(t) > MAKS_TEGN) return "for_lang";
  let v = afkod(normaliserBesked(t));
  if (laengde(v) > MAKS_TEGN) return "for_lang";
  v = asciiCifre(v);
  let g: Grund | null = spamGrund(v);
  // E-mail tjekkes altid på hele teksten.
  if (g === "email") return g;
  if (EMAIL_EKSTRA.test(v)) return "email";

  // Beskedtjenester, betalingsapps og linkforkortere som link - for alle.
  if (BLOK_SOME.test(v)) return "socialt_medie";
  if (BLOK_MOBILEPAY.test(v)) return "mobilepay";
  if (BLOK_BETALING.test(v)) return "bank";
  if (BLOK_KORT.test(v)) return "link";
  // Et link med et af de ekstra topdomæner tæller som link (som i chatten
  // går link forud for telefon, bank osv.).
  if (EKSTRA_LINK.test(v)) g = "link";

  // Links: stoppes for private. Firmaer: 7+ cifre i et link stoppes, og kun
  // værtsnavnene fjernes - stien tjekkes med resten af teksten.
  if (g === "link") {
    if (!erhverv) return "link";
    for (const m of v.matchAll(LINK_RE)) {
      if (m[0].replace(/[^0-9]/g, "").length >= 7) return "telefon";
    }
    v = v.replace(VAERT_RE, " ");
    g = spamGrund(v);
    if (g === "email" || g === "link") return g;
  }

  // Kontaktord uden for vareordene ("Vare nr." tæller ikke som "nr").
  const kontakt = KONTAKTORD.test(v.replace(VAREORD_ORD, " "));

  // IKEA-numre: kun med ordet "ikea" og uden kontaktord.
  if (!kontakt && IKEA_ORD.test(v)) v = v.replace(IKEA, " # ");

  // 8 cifre efter et vareord eller en mærkat - altid stoppet.
  for (const m of v.matchAll(MAERKAT)) {
    if (lignerTelefon(m[0].slice(m[0].search(/[0-9]/)))) return "telefon";
  }

  // En ISO-dato (åååå-mm-dd, måned 1-12, dag 1-31 - samme regel som
  // kontoreglen) er ikke et telefonnummer: "Købt 2023-11-24". Kun når hele
  // kæden er datoen og uden kontaktord ("Ring 2023-11-24" stoppes).
  if (!kontakt) {
    v = v.replace(KAEDE, (m) => {
      const { blokke, skille } = del(m);
      return blokke.length === 3 && erDatoAar(blokke, skille, 0) ? " # " : m;
    });
  }

  // Bankoplysninger skrevet som et varenummer (kræver et bankord).
  const bank = BANKORD.test(v);
  // Undtagelsen for vareord gælder kun med de svage bankord (bank, netbank).
  const staerk = bank && BANKORD_STAERK.test(v);
  // 8 cifre i en hvilken som helst gruppering - før varenumre og
  // signalværdier neutraliseres. Hvert vindue tjekkes én gang, og højst
  // MAKS_CHATTJEK gange - flere mulige telefonnumre stoppes.
  const tjekket = new Set<string>();
  for (const m of v.matchAll(KAEDE)) {
    const { blokke, skille } = del(m[0]);
    const slut = (m.index ?? 0) + m[0].length;
    const foer = Array.from(v.slice(0, m.index ?? 0));
    const kontekst = foer.slice(Math.max(0, foer.length - 40)).join("");
    if (bank && !ENHED_EFTER.test(v.slice(slut)) && lignerKonto(blokke, skille, !staerk && VARE_FOER.test(kontekst)))
      return "bank";
    if (TLF_FORAN.test(blokke.join("")) || blokke.some((b) => TLF_FORAN.test(b))) return "telefon";
    for (const [fra, til] of kandidater(blokke)) {
      let nr = blokke[fra];
      for (let k = fra; k < til; k++) nr += chatSkille(skille[k]) + blokke[k + 1];
      const vindue = kontekst + nr;
      if (tjekket.has(vindue)) continue;
      if (tjekket.size >= MAKS_CHATTJEK) return "telefon";
      tjekket.add(vindue);
      if (spamGrund(vindue) === "telefon") return "telefon";
    }
  }

  // Intet kontaktord: varenumre med andre længder og signalværdier tæller ikke.
  if (!kontakt) v = v.replace(VAREORD, " # ").replace(SIGNAL, " # ");
  // Er "overføres"/"overført" det eneste bankord, læser chattens filter ikke
  // numrene efter en mærkat (8 cifre er allerede tjekket ovenfor).
  if (!bank && v.search(PASSIV) >= 0 && !BANKORD_CHAT.test(v.replace(PASSIV, " ")))
    v = v.replace(MAERKAT, " # ");
  g = spamGrund(v);
  if (g !== null) return g;

  // MobilePay som ord - al betaling går via BidHamr.
  if (MOBILEPAY_ORD.test(v)) return "mobilepay";
  return null;
}

// Samme tekster som databasen (public.auktion_kontaktinfo_afvis). Firmaer må
// skrive links, så teksten nævner dem ikke.
export function auktionKontaktTekst(felt: AuktionKontaktFelt, erhverv: boolean): string {
  const sted = felt === "titel" ? "titlen" : "beskrivelsen";
  return erhverv
    ? `Skriv ikke telefonnummer, e-mail, betalingsoplysninger eller sociale medier i ${sted}. Jeres kontaktoplysninger står på firmasiden.`
    : `Skriv ikke telefonnummer, e-mail eller links i ${sted}. Køber og sælger skal tale sammen via BidHamr.`;
}

// "Sæt op igen" / genopsætning: den gamle auktion kan ikke rettes, så sælgeren
// skal oprette en ny uden kontaktoplysningerne.
export function auktionKontaktOpIgenTekst(felt: AuktionKontaktFelt, erhverv: boolean): string {
  const sted = felt === "titel" ? "Titlen" : "Beskrivelsen";
  const hvad = erhverv
    ? "telefonnummer, e-mail, betalingsoplysninger eller sociale medier"
    : "telefonnummer, e-mail eller links";
  return `${sted} indeholder ${hvad}, som ikke må stå i en auktion. Opret en ny auktion uden dem.`;
}

// Fejl fra databasen (BHA08). details er JSON: { felt, grund, erhverv }.
export function auktionKontaktFejl(
  fejl: { code?: string | null; details?: string | null } | null | undefined,
): { felt: AuktionKontaktFelt; erhverv: boolean; tekst: string } | null {
  if (fejl?.code !== AUKTION_KONTAKTINFO_KODE) return null;
  let felt: AuktionKontaktFelt = "beskrivelse";
  let erhverv = false;
  try {
    const d = JSON.parse(fejl.details ?? "{}") as { felt?: string; erhverv?: boolean };
    if (d.felt === "titel") felt = "titel";
    erhverv = d.erhverv === true;
  } catch {
    // standardteksten
  }
  return { felt, erhverv, tekst: auktionKontaktTekst(felt, erhverv) };
}
