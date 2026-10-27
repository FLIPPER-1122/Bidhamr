// Blokering, rapporter af beskeder/brugere, spamfilter og kontaktformular.
// Database: supabase/migrations/20261006030000_tryghed_chat_kontakt.sql.
// Ingen server-only-import: både sider og klientkomponenter bruger teksterne.

// Kategorier, en bruger kan vælge, når en besked eller bruger rapporteres
// (bruger_rapporter.category). 'auto_*' sættes kun af spamfilteret.
export const RAPPORT_KATEGORIER = [
  { vaerdi: "spam", label: "Spam eller reklame" },
  { vaerdi: "chikane", label: "Chikane eller trusler" },
  { vaerdi: "svindel", label: "Mistanke om svindel" },
  { vaerdi: "betaling_udenom", label: "Vil handle eller betale uden om BidHamr" },
  { vaerdi: "stoedende", label: "Stødende indhold" },
  { vaerdi: "andet", label: "Andet" },
] as const;

export type RapportKategori = (typeof RAPPORT_KATEGORIER)[number]["vaerdi"];

const KATEGORI_NAVN: Record<string, string> = {
  ...Object.fromEntries(RAPPORT_KATEGORIER.map((k) => [k.vaerdi, k.label])),
  auto_mistaenkelig: "Spamfilter: mulig handel uden om BidHamr",
  auto_blokeret: "Spamfilter: gentagne stoppede beskeder",
};

export function rapportKategoriNavn(kategori: string): string {
  return KATEGORI_NAVN[kategori] ?? kategori;
}

export function erRapportKategori(v: unknown): v is RapportKategori {
  return typeof v === "string" && RAPPORT_KATEGORIER.some((k) => k.vaerdi === v);
}

// messages.blokeret_grund -> venlig forklaring til afsenderen.
export type SpamGrund = "link" | "email" | "telefon" | "mobilepay" | "bank" | "socialt_medie" | "gentaget";

const SPAM_FORKLARING: Record<SpamGrund, string> = {
  link: "Beskeden blev ikke sendt, fordi den indeholder et link. Af hensyn til jeres tryghed må der ikke deles links i chatten.",
  email:
    "Beskeden blev ikke sendt, fordi den indeholder en e-mailadresse. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  telefon:
    "Beskeden blev ikke sendt, fordi den ser ud til at indeholde et telefonnummer. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  mobilepay:
    "Beskeden blev ikke sendt, fordi den indeholder et MobilePay-nummer. Al betaling sker gennem BidHamr, så du er beskyttet.",
  bank:
    "Beskeden blev ikke sendt, fordi den ser ud til at indeholde bank- eller kortoplysninger (reg.nr., kontonummer, IBAN eller kortnummer). Al betaling sker gennem BidHamr, så du er beskyttet.",
  socialt_medie:
    "Beskeden blev ikke sendt, fordi den ser ud til at flytte jeres snak til et socialt medie eller en anden app. Skriv sammen her i chatten – så er I begge beskyttet af BidHamr.",
  gentaget: "Beskeden blev ikke sendt, fordi du har sendt den samme besked flere gange lige efter hinanden.",
};

// --- Spamfilter (spejl af databasen) -----------------------------------------
// SPEJL af public.besked_normaliser + public.besked_spam_grund i
// supabase/migrations/20261007050000_fase4_testrettelser.sql (testdatabasen:
// rettet igen i 20261007051000_fase4_testrettelser_2.sql; bankoplysninger og
// besked_mistaenkelig: 20261017030000_vilkaar_efternavn_chat.sql; spredte
// cifre, kortnumre og reg./kontonr. med skilletegn:
// 20261102080000_handel_testfund.sql - eksempler i
// tests/enhed/spamfilterEksempler.ts). Databasen
// afgør altid (triggeren messages_tryghed); denne kopi kan bruges til at
// advare, før beskeden sendes. Ændres en regel, SKAL begge steder rettes.
// Forskel: Postgres' \m/\M regner æøå som bogstaver; her bruges \p{L}.

const B = "(?<![\\p{L}\\p{N}_])"; // ordstart (\m)
const E = "(?![\\p{L}\\p{N}_])"; // ordslut (\M)

// (a) +45 / 0045 / (+45) + 8 cifre, evt. adskilt af mellemrum, - eller .
const P_LANDEKODE = "(\\(\\s*\\+\\s*45\\s*\\)|\\+\\s*45|(?<![0-9])0045)[\\s.-]{0,2}[0-9]([\\s.-]{0,2}[0-9]){7}(?![0-9])";
// (b) 8 cifre i træk, første 2-9, ikke del af en længere cifferrække.
const P_OTTE = "(?<![0-9])[2-9][0-9]{7}(?![0-9])";
// (c) 2-2-2-2 eller 4-4 – kræver et kontaktord højst 25 tegn før.
const P_GRUPPERET =
  "(?<![0-9])([2-9][0-9][\\s.-][0-9]{2}[\\s.-][0-9]{2}[\\s.-][0-9]{2}|[2-9][0-9]{3}[\\s.-][0-9]{4})(?![0-9])";
// (c') Som (c), men heller ikke ved siden af en anden cifferblok
// ("0730 2533 0012" i et sporingsnummer). Bruges på arbejdskopien.
const P_GRP =
  "(?<![0-9][\\s.,-])(?<![0-9])([2-9][0-9][\\s.-][0-9]{2}[\\s.-][0-9]{2}[\\s.-][0-9]{2}|[2-9][0-9]{3}[\\s.-][0-9]{4})(?![\\s.,-]?[0-9])";
// (d) 20261102080000: 8 cifre (første 2-9) i en hvilken som helst
// gruppering - op til 3 mellemrum, punktum, bindestreger eller skråstreger
// mellem cifrene ("223 344 55", "2 2 3 3 4 4 5 5") - og ikke en del af en
// længere cifferrække. Som (c) kræver det et kontaktord eller beskedens slut
// (på arbejdskopien).
const P_LOES = String.raw`(?<![0-9][\s.,/-]{0,3})[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])`;
// (e) Som (d), men delt i mindst 5 grupper ("2 2 3 3 4 4 5 5", "22 3 3 44
// 55"). Sådan skrives hverken beløb, datoer eller størrelser - altid stoppet.
const P_LOES5 =
  String.raw`(?<![0-9][\s.,/-]{0,3})(?=([0-9]+[\s./-]{1,3}){4}[0-9])[2-9]([\s./-]{0,3}[0-9]){7}(?![\s.,/-]{0,3}[0-9])`;
// Kontaktord højst 25 tegn FØR nummeret.
const P_FOER =
  B +
  "(ring|ringe|ringer|tlf|tlfnr|telefon|telefonnummer|telefonnummeret|telefonnr" +
  "|mobil|mobilnummer|mobilnummeret|mobilnr|sms|skriv til|kontakt mig" +
  "|whats\\s*app|signal|nummer|nummeret|nr|hilsen|mvh)" +
  E;
// Kontaktord højst 15 tegn EFTER nummeret.
const P_EFTER = B + "(ring|ringe|ringer|sms|hvis|tlf|telefon|mobil|nr|nummer|nummeret|whats\\s*app|signal)" + E;
const P_MOBILEPAY = `(mobile\\s*pay|${B}mp${E})`;
const P_SOME =
  `(instagram|insta|${B}ig|facebook|${B}fb|messenger|snap\\s*chat|${B}snap|tik\\s*tok|telegram` +
  `|whats\\s*app|${B}signal|wechat|viber|discord)${E}`;
// Som P_SOME, men uden signal: "mit signal er dårligt" er ikke en kontaktvej
// (bruges kun efter min/mit/mine; "på signal" og "signal:" stoppes stadig).
const P_SOME_MIN =
  `(instagram|insta|${B}ig|facebook|${B}fb|messenger|snap\\s*chat|${B}snap|tik\\s*tok|telegram` +
  `|whats\\s*app|wechat|viber|discord)${E}`;
// @brugernavn kræver mindst ét bogstav eller _ ("Pris @1500" er ikke et brugernavn).
const P_AT = "@(?=[a-z0-9_.]*[a-z_])";

// Tal, der ikke er telefonnumre, erstattes med '#' i arbejdskopien.
// Et 8-cifret nummer i 2-2-2-2- eller 4-4-format (ikke del af en længere cifferrække).
const GRP_2222 = String.raw`[2-9][0-9][\s.-][0-9]{2}[\s.-][0-9]{2}[\s.-][0-9]{2}(?![\s.,-]?[0-9])`;
const GRP_44 = String.raw`[2-9][0-9]{3}[\s.-][0-9]{4}(?![\s.,-]?[0-9])`;
const NR = String.raw`[\s.:#]*((nr|nummer|nummeret)${E})?[\s.:#]*`;
// Cifre lige efter model, ordre(nr), postnr, sporing, mål m.fl.
const NEUTRAL_ORD = new RegExp(
  B +
    "(model[a-zæøå]*" +
    "|ordre[a-zæøå]*|post\\s*nr|postnummer[a-zæøå]*|sporing[a-zæøå]*|track[a-z]*" +
    "|stregkode|ean|imei|serie\\s*nr|serienummer[a-zæøå]*|vare\\s*nr|varenummer[a-zæøå]*" +
    "|faktura[a-zæøå]*|kunde\\s*nr|kundenummer[a-zæøå]*" +
    "|reg|pakke[a-zæøå]*|mål[a-zæøå]*)" +
    E +
    NR +
    String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
// ref/konto/art: aldrig et nummer i telefonformat (2-2-2-2 eller 4-4).
const NEUTRAL_REF = new RegExp(
  `${B}(ref|reference|konto[a-zæøå]*|art)${E}${NR}(?!${GRP_2222}|${GRP_44})` + String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
// str/størrelse: ikke 2-2-2-2 (størrelseslister fanges af STOERRELSER).
const NEUTRAL_STR = new RegExp(
  `${B}(str|størrelse[a-zæøå]*|skostørrelse[a-zæøå]*|size|sizes)${E}${NR}(?!${GRP_2222})` +
    String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
// kl/klokken: kun et klokkeslæt (18, 18.30, 18:30, 18 30) med intet ciffer efter.
const NEUTRAL_KL = new RegExp(
  `${B}(kl|klokken)${E}` + String.raw`[\s.:]*([01]?[0-9]|2[0-3])([.:\s][0-5][0-9])?(?![\s.:,-]?[0-9])`,
  "gu",
);
// Par/intervaller af klokkeslæt (20.00-22.00, 20.10 21.10) og datoer
// (24.12-27.12., 24/12 25/12 - skråstreg og 1-cifret dag/måned fra 20261102080000).
const PAR_SEP = String.raw`(\s*[-–]\s*|\s+(og|til)\s+|\s+)`;
const TID = "([01][0-9]|2[0-3])[.:][0-5][0-9]";
const DATO = String.raw`(0?[1-9]|[12][0-9]|3[01])[./](0?[1-9]|1[0-2])\.?`;
const NEUTRAL_TID_DATO = new RegExp(
  `(?<![0-9][.:/])(?<![0-9])(${TID}${PAR_SEP}${TID}|${DATO}${PAR_SEP}${DATO})(?![.:/]?[0-9])`,
  "gu",
);
// 20261102080000: hel dato med år (24.12.2026, 24/12/26, 24-12-2026, 24/12 2026).
const NEUTRAL_DATO_FULD = new RegExp(
  String.raw`(?<![0-9][\s.,/-]?)(0?[1-9]|[12][0-9]|3[01])([./-](0?[1-9]|1[0-2])[./-]|[./](0?[1-9]|1[0-2])\.?\s+)((19|20)[0-9]{2}|[0-9]{2})(?![\s.,/-]?[0-9])`,
  "gu",
);
// 20261102080000: beløb med tusindtalspunktum op til 25.000 (loftet), alene
// eller i par: "2.500", "2.500-3.000", "2.000 og 3.000", "1.250,50".
const TUSIND = String.raw`([1-9]|1[0-9]|2[0-5])\.[0-9]{3}(,[0-9]{1,2}|,-)?`;
const NEUTRAL_TUSINDER = new RegExp(
  String.raw`(?<![0-9][\s.,/-]?)${TUSIND}((\s*[-–/]\s*|\s+(og|til|eller)\s+|\s+)${TUSIND})?(?![\s.,/-]?[0-9])`,
  "gu",
);
const NEUTRAL_AAR = /(?<![0-9])(19|20)[0-9]{2}(\s*[-/]\s*|\s+(og|til)\s+|\s+)(19|20)[0-9]{2}(?![0-9])/gu;
// Beløbspar i hele hundreder: "2500 3000", "1500-2000".
const NEUTRAL_HUNDREDER =
  /(?<![0-9])[1-9][0-9]{1,3}00(\s*[-–/]\s*|\s+(og|til|eller)\s+|\s+)[1-9][0-9]{1,3}00(?![0-9])/gu;
const NEUTRAL_BELOEB = new RegExp(`(?<![0-9])[0-9][0-9 .]*[0-9]\\s*(kr${E}|dkk${E}|kroner${E}|,-|\\.-)`, "gu");
const STOERRELSER = /(?<![0-9])([0-9]{2})[\s.,/-]+([0-9]{2})[\s.,/-]+([0-9]{2})[\s.,/-]+([0-9]{2})(?![0-9])/gu;

// Arbejdskopi: klokkeslæt/datoer, modelnumre, årstal, beløb og
// størrelseslister (fast trin 1 eller 2) -> '#', så de ikke ligner
// telefonnumre. Samme rækkefølge som i SQL.
function neutraliserTal(v: string): string {
  let g = v
    .replace(NEUTRAL_DATO_FULD, " # ")
    .replace(NEUTRAL_TID_DATO, " # ")
    .replace(NEUTRAL_ORD, " # ")
    .replace(NEUTRAL_REF, " # ")
    .replace(NEUTRAL_STR, " # ")
    .replace(NEUTRAL_KL, " # ")
    .replace(NEUTRAL_AAR, " # ")
    .replace(NEUTRAL_HUNDREDER, " # ")
    .replace(NEUTRAL_TUSINDER, " # ")
    .replace(NEUTRAL_BELOEB, " # ");
  for (const m of [...g.matchAll(STOERRELSER)]) {
    const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
    const trin = b - a;
    if ((trin === 1 || trin === 2) && c - b === trin && d - c === trin) g = g.split(m[0]).join(" # ");
  }
  return g;
}

const RE = (s: string) => new RegExp(s, "u");

// --- Bankoplysninger (20261017030000) ----------------------------------------
// Reg.nr.: "reg", "regnr", "reg. nr.", "registreringsnummer" + 4 cifre. Et
// "reg" alene kan også være en bils første registrering ("1. reg. 2015"), så
// det kræver et bankord andetsteds i beskeden (P_BANK_ORD).
// 20261102080000: cifrene i reg.nr. og kontonr. må være adskilt af et
// mellemrum, punktum, bindestreg eller skråstreg ("1 2 3 4", "12-34-56-78").
const P_REG_CIFRE = String.raw`(?<![0-9])[0-9]([\s./-]?[0-9]){3}(?![0-9])`;
const P_REG =
  B + "reg(istrerings(nummer|nr)?|\\.?\\s*(nr|nummer))?" + E + "[^0-9]{0,6}" + P_REG_CIFRE;
// Kun tydelige former: "regnr", "reg.nr.", "reg nummer", "registreringsnr".
const P_REG_STAERK =
  B + "reg(istrerings(nummer|nr)|\\.?\\s*(nr|nummer))" + E + "[^0-9]{0,6}" + P_REG_CIFRE;
// Et kontonummer på 6-10 cifre (ikke del af en længere cifferrække).
const P_KONTO_TAL = String.raw`(?<![0-9])[0-9]([\s./-]?[0-9]){5,9}(?![0-9])`;
// Kontonr.: "kontonr", "kontonummer", "konto nr" + 6-10 cifre.
const P_KONTONR =
  B + "(kontonr|kontonummer|kontonummeret|konto\\s*nr|konto\\s*nummer)" + E + "[^0-9]{0,6}" + P_KONTO_TAL;
// IBAN: DK + 2 kontrolcifre + 14 cifre, evt. i grupper.
const P_IBAN_DK = B + "dk\\s?[0-9]{2}([\\s.-]?[0-9]){14}(?![0-9])";
// 4 + 6-10 cifre, ikke ved siden af en anden cifferblok. Kræver et bankord.
const P_REG_KONTO = "(?<![0-9][\\s.,-])(?<![0-9])[0-9]{4}(\\s?-\\s?|[\\s.]+)[0-9]{6,10}(?![\\s.,-]?[0-9])";
// 20261102080000: 10-14 cifre i mindst to grupper, i en hvilken som helst
// gruppering (reg.nr. + kontonr. skrevet spredt). Kræver også et bankord. Et
// kontonr. alene i én blok ("Kontonr 1234567890") stoppes stadig ikke.
const P_REG_KONTO_LOES =
  String.raw`(?<![0-9][\s.,/-]{0,3})(?=[0-9]+[\s./-]{1,3}[0-9])[0-9]([\s./-]{0,3}[0-9]){9,13}(?![\s.,/-]{0,3}[0-9])`;
// 20261102080000: et betalingskort - 13-19 cifre i en hvilken som helst
// gruppering. Kun 16 cifre (Visa, Mastercard, Dankort: første ciffer 2-6) og
// 15 cifre (American Express: 34/37) med gyldigt kontrolciffer (Luhn) tæller.
const P_KORT = String.raw`(?<![0-9][\s.,/-]{0,3})[0-9]([\s./-]{0,3}[0-9]){12,18}(?![\s.,/-]{0,3}[0-9])`;

function erKortnummer(tekst: string): boolean {
  const c = tekst.replace(/[^0-9]/g, "");
  if (!((c.length === 16 && /^[2-6]/.test(c)) || (c.length === 15 && /^3[47]/.test(c)))) return false;
  let sum = 0;
  for (let i = 1; i <= c.length; i++) {
    let d = Number(c[c.length - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
// Bankord: konto, kontonr, bank, overfør, indbetal, IBAN og tydelige
// reg.nr.-former (IKKE et "reg" alene).
const P_BANK_ORD =
  B +
  "(bank[a-zæøå]*|konto[a-zæøå]*|overf(ø|o)r[a-zæøå]*|indbetal[a-zæøå]*|indsæt[a-zæøå]*|iban" +
  "|regnr|registreringsn[a-zæøå]*|reg\\.?\\s*(nr|nummer))" +
  E;
// Arbejdskopi til bankreglerne (samme rækkefølge som i SQL):
//   1. tal lige efter model, ordre, sporing, varenr., årgang, stelnr., art m.fl.
//   2. tal med en enhed: km, kr, kg, cm ... ("145000 km", "125000 kr")
//   3. et årstal lige efter et "reg" alene ("1. reg. 2015", "Reg. år 2016") -
//      medmindre "konto" følger lige efter.
// 'reg' og 'konto' bevares - de er bankord her.
const NEUTRAL_BANK = new RegExp(
  B +
    "(model[a-zæøå]*|ordre[a-zæøå]*|post\\s*nr|postnummer[a-zæøå]*|sporing[a-zæøå]*|track[a-z]*" +
    "|stregkode|ean|imei|serie\\s*nr|serienummer[a-zæøå]*|vare\\s*nr|varenummer[a-zæøå]*" +
    "|faktura[a-zæøå]*|kunde\\s*nr|kundenummer[a-zæøå]*|pakke[a-zæøå]*|ref|reference" +
    "|årgang[a-zæøå]*|stel[a-zæøå]*|art)" +
    E +
    NR +
    String.raw`[0-9][0-9\s.,/-]*`,
  "gu",
);
const NEUTRAL_BANK_ENHED = new RegExp(
  `(?<![0-9])[0-9][0-9.]*(,[0-9]+)?\\s*(km${E}|kr${E}|kroner${E}|dkk${E}|kg${E}|gram${E}|cm${E}|mm${E}|,-|\\.-)`,
  "gu",
);
const NEUTRAL_BANK_REG_AAR = new RegExp(
  `${B}reg${E}\\.?(\\s*(år|dato))?[\\s.:,]*(19|20)[0-9]{2}(?![0-9])(?![^0-9]{0,15}konto)`,
  "gu",
);
const BANK_REGLER = {
  altid: [
    RE(P_IBAN_DK),
    RE(`${B}iban${E}[^a-z0-9]{0,6}[a-z]{2}\\s?[0-9]{2}`),
    RE(`${P_REG_STAERK}[^]{0,40}${P_KONTO_TAL}`),
    RE(`(?<![0-9])[0-9]([\\s./-]?[0-9]){3}[\\s,/-]*${B}konto[a-zæøå]*${E}[^0-9]{0,6}${P_KONTO_TAL}`),
  ],
  // Begge skal findes.
  par: [
    [RE(`${P_REG}[^]{0,40}${P_KONTO_TAL}`), RE(P_BANK_ORD)],
    [RE(P_KONTONR), RE(P_REG)],
    [RE(P_REG_KONTO), RE(P_BANK_ORD)],
    [RE(P_REG_KONTO_LOES), RE(P_BANK_ORD)],
  ] as [RegExp, RegExp][],
};

function erBankoplysninger(v: string): boolean {
  const k = v.replace(NEUTRAL_BANK, " # ").replace(NEUTRAL_BANK_ENHED, " # ").replace(NEUTRAL_BANK_REG_AAR, " # ");
  if (BANK_REGLER.altid.some((r) => r.test(k)) || BANK_REGLER.par.some(([a, b]) => a.test(k) && b.test(k))) {
    return true;
  }
  for (const m of k.matchAll(new RegExp(P_KORT, "gu"))) {
    if (erKortnummer(m[0])) return true;
  }
  return false;
}

const SPAM_REGLER = {
  email: RE(`[a-z0-9._%+-]+\\s*(@|\\(at\\)|\\[at\\]|${B}snabel-?a${E})\\s*[a-z0-9-]+(\\.|\\s+(punktum|dot)\\s+)[a-z]{2,}`),
  bidhamr: new RegExp(
    "(?<![a-z0-9.@-])(https?://)?(www\\.)?bidhamr\\.dk(/[a-z0-9/_-]*)?(?![a-z0-9@-]|\\.[a-z0-9])",
    "gu",
  ),
  fragt: new RegExp(
    "(?<![a-z0-9.@-])(https?://)?([a-z0-9-]+\\.)*" +
      "(gls\\.dk|gls-group\\.eu|gls-group\\.com|postnord\\.dk|dao\\.as|bring\\.dk" +
      "|ups\\.com|dhl\\.dk|dhl\\.com|shipmondo\\.com)" +
      "(/[a-z0-9/_?=&%#+-]*)?(?![a-z0-9@-]|\\.[a-z0-9])",
    "gu",
  ),
  links: [
    RE("(https?://|www\\.)"),
    RE(`${B}[a-z0-9-]{2,}\\.(dk|com|net|org|info|biz|shop|online|site|xyz|link|ly|app|io|me|eu|se|de|no|nu|co)${E}`),
    RE(`${B}t\\.me${E}`),
    RE(`${B}[a-z0-9-]{2,}\\s+(punktum|dot)\\s+(dk|com|net|org|io|me|eu|se|de|no|nu|co)${E}`),
  ],
  mobilepay: [
    RE(
      P_MOBILEPAY +
        "(\\s*(boks|box))?[\\s:#.]*((nr|nummer|nummeret|på|til)[\\s:#.]*)?" +
        "(?<![0-9])[0-9]{4,5}(?![0-9])(?!\\s*(kr|dkk|,-|\\.-|,[0-9]|\\.[0-9]))",
    ),
    RE(`${P_MOBILEPAY}[^]{0,25}(${P_LANDEKODE}|${P_OTTE}|${P_GRUPPERET}|${P_LOES})`),
  ],
  telefon: [RE(P_LANDEKODE), RE(P_OTTE), RE(P_LOES5)],
  // Køres på arbejdskopien (neutraliserTal).
  telefonGrupperet: [
    RE(`${P_FOER}[^]{0,25}${P_GRP}`),
    RE(`${P_GRP}[^]{0,15}${P_EFTER}`),
    RE(`${P_GRP}[^a-z0-9æøå]*$`),
    RE(`${P_FOER}[^]{0,25}${P_LOES}`),
    RE(`${P_LOES}[^]{0,15}${P_EFTER}`),
    RE(`${P_LOES}[^a-z0-9æøå]*$`),
  ],
  socialt: [
    RE(`${P_SOME}\\s*(:|=)\\s*@?[a-z0-9_.]{3,}`),
    RE(`${P_SOME}[^]{0,15}(?<![a-z0-9._%+-])${P_AT}[a-z0-9_.]{3,}`),
    RE(`${P_SOME}\\s+(er|hedder)\\s+@?(?=[a-z0-9_.]*[_.0-9])[a-z0-9_.]{3,}`),
    RE(`${B}(på|via|over|gennem|i)\\s+((min|mit|mine)\\s+)?${P_SOME}`),
    RE(`${B}(min|mit|mine)\\s+${P_SOME_MIN}`),
    RE(`(^|[^a-z0-9._%+-])${P_AT}[a-z0-9_][a-z0-9_.]{2,}`),
  ],
};

// public.besked_normaliser: NFKC, små bogstaver, usynlige tegn fjernet.
export function normaliserBesked(tekst: string): string {
  return tekst
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[­​-‏⁠-⁤﻿]/g, "");
}

// Samme svar som public.besked_spam_grund: 'email' | 'link' | 'bank' |
// 'mobilepay' | 'telefon' | 'socialt_medie' | null. ('gentaget' afgøres kun
// i databasen.)
export function spamGrund(tekst: string): Exclude<SpamGrund, "gentaget"> | null {
  const v = normaliserBesked(tekst ?? "");
  if (SPAM_REGLER.email.test(v)) return "email";
  const w = v.replace(SPAM_REGLER.bidhamr, " ").replace(SPAM_REGLER.fragt, " ");
  if (SPAM_REGLER.links.some((r) => r.test(w))) return "link";
  if (erBankoplysninger(v)) return "bank";
  if (SPAM_REGLER.mobilepay.some((r) => r.test(v))) return "mobilepay";
  if (SPAM_REGLER.telefon.some((r) => r.test(v))) return "telefon";
  const g = neutraliserTal(v);
  if (SPAM_REGLER.telefonGrupperet.some((r) => r.test(g))) return "telefon";
  if (SPAM_REGLER.socialt.some((r) => r.test(v))) return "socialt_medie";
  return null;
}

// SPEJL af public.besked_mistaenkelig (20261017030000_vilkaar_efternavn_chat.sql):
// et forsøg på at handle eller betale uden om BidHamr. Beskeden sendes, men
// databasen markerer den til staff. Hjemmesiden bruger denne kopi til at
// advare afsenderen, mens beskeden skrives. MobilePay alene giver ingen
// advarsel (officiel betalingsmetode via Stripe).
const BETALINGSAPP = `(mobile\\s*pay|${B}swish${E}|paypal|revolut|${B}vipps${E})`;
const UDENOM = `(direkte|privat|til mig|udenom|uden om|uden (bidhamr|bid hamr))`;
const MISTAENKELIG = RE(
  [
    "udenom|uden om (bidhamr|bid hamr|siden|appen|platformen|gebyr)",
    "uden (gebyr|gebyret|gebyrer)|spar(e|er)? (gebyr|gebyret|gebyrerne)",
    "betal(e|er)? (direkte|privat|kontant)|direkte (overf|betaling)",
    "bankoverf|overf(ø|o)r(e|er|sel)? (pengene|beløbet|belobet|direkte)",
    `${B}reg\\.?\\s*(nr|nummer)${E}|kontonummer|kontonr`,
    `${BETALINGSAPP}[^]{0,40}${UDENOM}`,
    `${UDENOM}[^]{0,40}${BETALINGSAPP}`,
    `whats\\s*app|telegram|snapchat|${B}snap${E}|messenger`,
    "ring til mig|sms (til )?mig|skriv (til mig )?på (mail|sms|face|insta|snap)",
    // 20261017030000:
    "betal[a-zæøå]*\\s+(mig|dig)\\s+(direkte|privat|kontant)",
    "kontant\\s*betal|betal[a-zæøå]*\\s+(med\\s+|i\\s+)?kontant",
    `${B}kontant(er|e)?${E}[^]{0,30}${B}(afhent[a-zæøå]*|hånden)${E}`,
    `${B}afhent[a-zæøå]*${E}[^]{0,30}${B}kontant`,
    `betal[a-zæøå]*\\s+uden\\s*(om|for)${E}|uden\\s*for\\s+(bidhamr|bid hamr|siden|appen|platformen)`,
    // Ikke datid ("overført"): "Pengene er overført til min konto" er en
    // sælger, der bekræfter BidHamrs udbetaling.
    `overf(ø|o)r(e|er|sel)?${E}[^]{0,30}(til mig|til min|min konto|kontonr|kontonummer|${B}reg${E}` +
      `|mobile\\s*pay|${B}swish${E}|paypal|revolut|${B}vipps${E})`,
    `mobile\\s*pay(e|er)?\\s+(mig|til mig|pengene|beløbet|resten)${E}`,
    `(pengene|beløbet|resten)\\s+(på|via|over|med|til)\\s+(min\\s+)?${BETALINGSAPP}`,
    `${BETALINGSAPP}[^]{0,40}uden (gebyr|gebyret|gebyrer)`,
  ].join("|"),
);

export function erMistaenkeligBesked(tekst: string): boolean {
  return MISTAENKELIG.test(normaliserBesked(tekst ?? ""));
}

export function spamForklaring(grund: string | null | undefined): string {
  return (grund && SPAM_FORKLARING[grund as SpamGrund]) || "Beskeden blev ikke sendt.";
}

const SPAM_NAVN_STAFF: Record<SpamGrund, string> = {
  link: "link",
  email: "e-mail",
  telefon: "telefonnummer",
  mobilepay: "MobilePay-nummer",
  bank: "bankoplysninger",
  socialt_medie: "socialt medie",
  gentaget: "gentaget besked",
};

export function spamNavnStaff(grund: string): string {
  return SPAM_NAVN_STAFF[grund as SpamGrund] ?? grund;
}

// Kontaktformularen (kontakt_henvendelser.emne). "?emne=fejl" forvælger Teknisk fejl.
// BidHamrs supportadresse. Kontaktformularen sender henvendelser hertil.
export const SUPPORT_EMAIL = "support@bidhamr.dk";

export const KONTAKT_EMNER = [
  { vaerdi: "generelt", label: "Generelt" },
  { vaerdi: "handel", label: "Handel" },
  { vaerdi: "betaling", label: "Betaling" },
  { vaerdi: "fejl", label: "Teknisk fejl" },
] as const;

export type KontaktEmne = (typeof KONTAKT_EMNER)[number]["vaerdi"];

export function erKontaktEmne(v: unknown): v is KontaktEmne {
  return typeof v === "string" && KONTAKT_EMNER.some((k) => k.vaerdi === v);
}

export function kontaktEmneNavn(v: string): string {
  // 'bot' = "Kontakt en rigtig medarbejder" i BidHamr-bot (20261102240000) -
  // kan ikke vælges i kontaktformularen.
  if (v === "bot") return "Fra BidHamr-bot";
  return KONTAKT_EMNER.find((k) => k.vaerdi === v)?.label ?? v;
}

export const KONTAKT_BESKED_MIN = 10;
export const KONTAKT_BESKED_MAKS = 4000;
export const RAPPORT_BESKRIVELSE_MAKS = 1000;
