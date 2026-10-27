// Kontaktoplysninger i en auktions titel og beskrivelse (Filip, 27. okt. 2026).
//
// Telefonnumre, e-mails, links og MobilePay-/bankoplysninger må ikke stå i
// auktionen - køber og sælger skal tale sammen via BidHamr.
//   - Private: alt, som chattens spamfilter stopper (spamGrund), blokeres.
//   - Firmaer (users.konto_type = 'erhverv'): links må gerne stå (fx til
//     firmaets egen hjemmeside). Kun værtsnavnet fjernes - stien tjekkes som
//     resten af teksten, og et link med 7 eller flere cifre stoppes. Telefon,
//     e-mail, MobilePay, bank og sociale medier blokeres stadig -
//     kontaktoplysningerne står på firmasiden.
//   - Beskedtjenester, sociale medier, betalingsapps og linkforkortere som
//     link (wa.me, t.me, facebook, instagram, x.com, linkedin, youtube,
//     discord, signal.me, mobilepay, paypal, bit.ly, linktr.ee ...) stoppes
//     for alle. URL-kodning (%25, %40, %2e, %2f, %3a) læses som tegnet.
//   - 8 cifre stoppes ALTID (chefen, 27. okt. 2026) - et dansk telefonnummer
//     kan ikke skelnes fra et varenummer på 8 cifre:
//       * efter et vareord eller en mærkat (varenr., SKU, EAN, art.nr.,
//         model, ID, nr ...): 8 cifre i alt (med eller uden skilletegn),
//         45/0045 + 8 cifre, eller en blok på præcis 8 cifre.
//       * ellers: 8 cifre i en hvilken som helst gruppering stoppes,
//         medmindre chattens filter kender dem som dato, beløb, årstal eller
//         størrelser (filteret køres på teksten frem til og med nummeret).
//       * 45 / 0045 + 8 cifre (landekode uden +) stoppes.
//   - Står der intet kontaktord, neutraliseres varenumre med andre længder
//     (fx 6, 7, 9 eller flere cifre) efter et vareord, IKEA-numre
//     ("402.638.47" - kun når ordet "ikea" står i teksten) og
//     signalværdier ("Signal: analog", "Signal: 20 dB" - højst 4 cifre).
//     "nr"/"nummer" i et vareord ("Vare nr.", "Del nummer") tæller ikke som
//     kontaktord. Kun i auktioner - chatten er uændret.
//
// SPEJL af public.auktion_kontaktinfo_grund i
// supabase/migrations/20261102190000_kontaktinfo_rettelser2.sql. Databasen
// afgør altid (triggeren auctions_zzz_kontaktinfo, fejlkode BHA08); denne
// kopi viser fejlen ved feltet, mens brugeren skriver. Ændres en regel, SKAL
// begge steder rettes (eksemplerne står begge steder:
// tests/enhed/auktionKontaktinfoEksempler.ts og testblokken i migrationen).
//
// Ingen server-only-import: klientkomponenterne bruger den.

import { normaliserBesked, spamGrund, type SpamGrund } from "@/lib/tryghed";

export const AUKTION_KONTAKTINFO_KODE = "BHA08";

export type AuktionKontaktFelt = "titel" | "beskrivelse";

type Grund = Exclude<SpamGrund, "gentaget">;

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

// Står et af disse ord i teksten (uden for et vareord), neutraliseres intet.
const KONTAKTORD = new RegExp(
  `${B}(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt` +
    "|skriv|skrive|skriver|besked|beskeden|beskeder|opkald|nummer|nummeret|nr" +
    "|whats\\s*app|mvh|hilsen|mobile?\\s*-?\\s*pay|m-?pay|mp|swish|vipps" +
    `|konto[a-zæøå]*|bank[a-zæøå]*|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)${E}`,
  "u",
);
// Et vareord: varenummer, art.nr., produktnr., reservedelsnr., delnr., SKU,
// EAN. "vare", "del" osv. alene tæller ikke.
const VAREORD_ORD_S = `${B}(sku|ean|(vare|artikel|produkt|reservedel|del|art)s?e?\\.?\\s*(nr|nummer|nummeret))${E}`;
const VAREORD_ORD = new RegExp(VAREORD_ORD_S, "gu");
// Vareord + mindst 6 cifre/skilletegn uden mellemrum. Neutraliseres kun uden
// kontaktord - et nummer, der kan være et telefonnummer, er da allerede
// stoppet af MAERKAT.
const VAREORD = new RegExp(`${VAREORD_ORD_S}\\.?[\\s:#]*[0-9][0-9./-]{4,}[0-9](?![0-9])`, "gu");
// Et vareord eller en anden mærkat + nummeret efter den (cifre med op til 3
// mellemrum, punktummer, bindestreger eller skråstreger imellem).
const MAERKAT = new RegExp(
  `${B}(sku|ean|imei|id|nr|nummer|nummeret|ref|reference|stregkode|art` +
    "|model[a-zæøå]*|ordre[a-zæøå]*|serie\\s*nr|serienummer[a-zæøå]*|kunde\\s*nr|kundenummer[a-zæøå]*" +
    "|faktura[a-zæøå]*|pakke[a-zæøå]*|varenummer[a-zæøå]*" +
    `|(vare|artikel|produkt|reservedel|del|art)s?e?\\.?\\s*(nr|nummer|nummeret))${E}` +
    `[\\s.:#]*((nr|nummer|nummeret)${E})?[\\s.:#]*[0-9]([\\s./-]{0,3}[0-9])*`,
  "gu",
);
// Et telefonnummer: 8 cifre (første 2-9), evt. med 45 eller 0045 foran.
const TLF_CIFRE = /^(0045|45)?[2-9][0-9]{7}$/u;
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
// 8 cifre (første 2-9) i en hvilken som helst gruppering (chattens (d)).
const LOES = /(?<![0-9][\s.,/-]{0,3})[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])/gu;
// 45 / 0045 + 8 cifre uden + ("4522334455", "45 22 33 44 55").
const LOES45 =
  /(?<![0-9][\s.,/-]{0,3})(0[\s./-]{0,3}0[\s./-]{0,3})?4[\s./-]{0,3}5[\s./-]{0,3}[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])/u;

// URL-kodede tegn: %25 = % (først), %40 = @, %2e = ., %2f = /, %3a = :.
function dekodUrl(v: string): string {
  return v
    .replace(/%25/g, "%")
    .replace(/%40/g, "@")
    .replace(/%2e/g, ".")
    .replace(/%2f/g, "/")
    .replace(/%3a/g, ":");
}

// Et nummer efter en mærkat, der kan være et telefonnummer.
function lignerTelefon(nummer: string): boolean {
  if (AARSPAR.test(nummer)) return false;
  if (TLF_CIFRE.test(nummer.replace(/[^0-9]/g, ""))) return true;
  return nummer.split(/[\s./-]+/).some((blok) => TLF_CIFRE.test(blok));
}

// Grunden (som spamGrund) eller null, hvis teksten må stå i auktionen.
export function auktionKontaktGrund(tekst: string | null | undefined, erhverv: boolean): Grund | null {
  const t = tekst ?? "";
  if (!t.trim()) return null;
  let v = dekodUrl(normaliserBesked(t));
  let g = spamGrund(v);
  // E-mail tjekkes altid på hele teksten.
  if (g === "email") return g;

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

  // Intet kontaktord: varenumre med andre længder og signalværdier tæller ikke.
  if (!kontakt) v = v.replace(VAREORD, " # ").replace(SIGNAL, " # ");
  g = spamGrund(v);
  if (g !== null) return g;

  // 8 cifre i en hvilken som helst gruppering: chattens filter på teksten
  // frem til og med nummeret (så nummeret står sidst, som i chatten).
  for (const m of v.matchAll(LOES)) {
    if (spamGrund(v.slice(0, (m.index ?? 0) + m[0].length)) === "telefon") return "telefon";
  }
  if (LOES45.test(v)) return "telefon";
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
