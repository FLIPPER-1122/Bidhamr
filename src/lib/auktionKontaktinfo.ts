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
//   - Bankoplysninger skrevet som varenummer: står der konto, reg eller bank
//     i teksten, stoppes 4 cifre efterfulgt af 6-10 cifre og en blok på
//     10-14 cifre (ikke med en enhed som km/kr bagefter).
//   - MobilePay (også "mobile pay", "mp box", "på mp") stoppes altid.
//   - E-mail skrevet med mellemrum ("hans @ gmail . com") eller som
//     "hans på gmail" stoppes.
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
// supabase/migrations/20261102220000_kontaktinfo_rettelser3.sql. Databasen
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

// E-mail, som chatfilteret ikke kender: mellemrum om punktummet ("hans @
// gmail . com") og en mailudbyder som ord ("hans på gmail").
const EMAIL_EKSTRA = new RegExp(
  `[a-z0-9._%+-]+\\s*(@|\\(at\\)|\\[at\\]|${B}snabel-?a${E})\\s*[a-z0-9-]*[a-z][a-z0-9-]*\\s*(\\.|${B}(punktum|dot)${E})\\s*[a-z]{2,}` +
    `|${B}(g-?mail|hotmail|icloud|protonmail|yahoo|gmx)${E}` +
    `|${B}(på|via|over|til)\\s+(e-?mail|mail|outlook|live)${E}`,
  "u",
);

// MobilePay som ord - al betaling går via BidHamr. "mp" alene er også
// megapixel ("12 mp"), så det kræver box/boks eller et ord som "på mp".
const MOBILEPAY_ORD = new RegExp(
  `${B}(m[o0]bil[e3]?\\s*-?\\s*pay|m-?pay|mp\\s*-?\\s*(box|boks))${E}` +
    `|${B}(på|via|med|over|eller|og|til)\\s+mp${E}` +
    `|${B}mp\\s+(ok|modtages|tages|velkommen|accepteres)${E}` +
    `|${B}mp${E}[^]{0,30}${B}(box|boks)${E}` +
    `|${B}(box|boks)${E}[^]{0,30}${B}mp${E}`,
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
// Bankord til "4 cifre + 6-10 cifre": konto, reg eller bank (også "netbank").
const BANKORD = new RegExp(
  `${B}(konto|kontoen|kontonr|kontonummer|kontonummeret|bankkonto|bankkontoen|bankoverførsel|bankoverførslen` +
    `|reg|regnr|registreringsnummer|registreringsnr|iban)${E}|bank(en)?${E}`,
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
    v = normaliserBesked(v);
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

// Bankoplysninger: 4 cifre + 6-10 cifre eller en blok på 10-14 cifre.
function lignerKonto(blokke: string[]): boolean {
  for (let i = 0; i < blokke.length; i++) {
    if (blokke[i].length >= 10 && blokke[i].length <= 14) return true;
    if (blokke[i].length !== 4) continue;
    let sum = 0;
    for (let j = i + 1; j < blokke.length && sum < 10; j++) {
      sum += blokke[j].length;
      if (sum >= 6 && sum <= 10) return true;
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

  // Bankoplysninger skrevet som et varenummer (kræver et bankord).
  const bank = BANKORD.test(v);
  // 8 cifre i en hvilken som helst gruppering - før varenumre og
  // signalværdier neutraliseres. Hvert vindue tjekkes én gang, og højst
  // MAKS_CHATTJEK gange - flere mulige telefonnumre stoppes.
  const tjekket = new Set<string>();
  for (const m of v.matchAll(KAEDE)) {
    const { blokke, skille } = del(m[0]);
    const slut = (m.index ?? 0) + m[0].length;
    if (bank && lignerKonto(blokke) && !ENHED_EFTER.test(v.slice(slut))) return "bank";
    if (TLF_FORAN.test(blokke.join("")) || blokke.some((b) => TLF_FORAN.test(b))) return "telefon";
    const foer = Array.from(v.slice(0, m.index ?? 0));
    const kontekst = foer.slice(Math.max(0, foer.length - 40)).join("");
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
