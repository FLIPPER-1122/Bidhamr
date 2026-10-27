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
//   - Beskedtjenester og betalingsapps som link (wa.me, t.me, facebook,
//     instagram, mobilepay, paypal ...) stoppes for alle.
//   - Står der intet kontaktord, tæller varenumre ("Varenummer 80275887"),
//     IKEA-numre ("402.638.47") og signalværdier ("Signal: analog") ikke.
//     Kun i auktioner - chatten er uændret.
//
// SPEJL af public.auktion_kontaktinfo_grund i
// supabase/migrations/20261102170000_kontaktinfo_rettelser.sql. Databasen
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

const TLD = "(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)";
// Værtsnavnet i et link (https://..., www.... eller navn.dk).
const VAERT =
  "(https?://[a-z0-9.-]+" +
  "|(?<![a-z0-9.@-])www\\.[a-z0-9.-]+" +
  `|(?<![a-z0-9.@-])([a-z0-9-]+\\.)+${TLD}${E})`;
const VAERT_RE = new RegExp(VAERT, "gu");
// Et helt link: værtsnavn + sti/forespørgsel til næste mellemrum.
const LINK_RE = new RegExp(`${VAERT}([/?#:]\\S*)?`, "gu");

// Beskedtjenester og betalingsapps som domæne - altid stoppet.
const BLOK_TLD = `(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co|gg|am|to)${E}`;
const BLOK_START = "(?<![a-z0-9.@-])([a-z0-9-]+\\.)*";
const BLOK_SOME = new RegExp(
  `${BLOK_START}((wa|t|m|fb)\\.me${E}|fb\\.com${E}` +
    `|[a-z0-9-]*(whatsapp|telegram|messenger|facebook|instagram|snapchat|tiktok)[a-z0-9-]*\\.${BLOK_TLD})`,
  "u",
);
const BLOK_MOBILEPAY = new RegExp(`${BLOK_START}[a-z0-9-]*mobilepay[a-z0-9-]*\\.${BLOK_TLD}`, "u");
const BLOK_BETALING = new RegExp(`${BLOK_START}[a-z0-9-]*(revolut|paypal|swipp)[a-z0-9-]*\\.${BLOK_TLD}`, "u");

// Står et af disse ord i teksten, neutraliseres intet.
const KONTAKTORD = new RegExp(
  `${B}(ring|ringe|ringer|tlf[a-z]*|telefon[a-zæøå]*|mobil|mobilnr|mobilnummer[a-z]*|sms|kontakt` +
    "|whats\\s*app|mvh|hilsen|mobile\\s*pay|mp" +
    `|konto[a-zæøå]*|bank[a-zæøå]*|iban|overf(ø|o)r[a-zæøå]*|reg|regnr)${E}`,
  "u",
);
// Varenummer, art.nr., produktnr., reservedelsnr., delnr., SKU, EAN + mindst
// 6 cifre/skilletegn uden mellemrum. "vare", "del" osv. alene tæller ikke.
const VAREORD = new RegExp(
  `${B}(sku|ean|(vare|artikel|produkt|reservedel|del|art)s?e?\\.?\\s*(nr|nummer|nummeret))${E}\\.?[\\s:#]*` +
    "[0-9][0-9./-]{4,}[0-9](?![0-9])",
  "gu",
);
// IKEA-format: 402.638.47.
const IKEA = /(?<![0-9]\.?)[0-9]{3}\.[0-9]{3}\.[0-9]{2}(?!\.?[0-9])/gu;
// Tekniske signalværdier: "Signal: analog", "Signal: 20 dB".
const SIGNAL = new RegExp(
  `${B}signal\\s*[:=]\\s*(analog|digital|hdmi|dvb[a-z0-9-]*|wifi|bluetooth|stereo|mono|svagt|godt|stærkt` +
    `|[0-9]+\\s*(db|mhz|ghz|hz))${E}`,
  "gu",
);

// Grunden (som spamGrund) eller null, hvis teksten må stå i auktionen.
export function auktionKontaktGrund(tekst: string | null | undefined, erhverv: boolean): Grund | null {
  const t = tekst ?? "";
  if (!t.trim()) return null;
  let v = normaliserBesked(t);
  let g = spamGrund(v);
  // E-mail tjekkes altid på hele teksten.
  if (g === "email") return g;

  // Beskedtjenester og betalingsapps som link - for alle.
  if (BLOK_SOME.test(v)) return "socialt_medie";
  if (BLOK_MOBILEPAY.test(v)) return "mobilepay";
  if (BLOK_BETALING.test(v)) return "bank";

  if (g === null) return null;

  // Links: stoppes for private. Firmaer: 7+ cifre i et link stoppes, og kun
  // værtsnavnene fjernes - stien tjekkes med resten af teksten.
  if (g === "link") {
    if (!erhverv) return "link";
    for (const m of v.matchAll(LINK_RE)) {
      if (m[0].replace(/[^0-9]/g, "").length >= 7) return "telefon";
    }
    v = v.replace(VAERT_RE, " ");
    g = spamGrund(v);
    if (g === null || g === "email" || g === "link") return g;
  }

  // Intet kontaktord: varenumre, IKEA-numre og signalværdier tæller ikke.
  if (!KONTAKTORD.test(v)) {
    v = v.replace(VAREORD, " # ").replace(IKEA, " # ").replace(SIGNAL, " # ");
    g = spamGrund(v);
  }
  return g;
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
