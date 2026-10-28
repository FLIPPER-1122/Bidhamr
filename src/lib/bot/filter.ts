// BidHamr-bottens svarfilter (ren funktion, ingen server-afhængigheder).
//
// Ordet "forsikring" bruges aldrig (CLAUDE.md) - det hedder "BidHamr
// Beskyttelse". Systemprompten siger det til modellen, og filteret her
// fanger det, hvis modellen alligevel skriver det:
//
// - Selve ordet og dets bøjninger (forsikring, forsikringen, forsikringer,
//   forsikringerne - også med stort begyndelsesbogstav, i versaler og i
//   ejefald med -s) bliver til "BidHamr Beskyttelse" (ejefald:
//   "BidHamr Beskyttelses").
// - Sammensatte ord (fx "indboforsikring", "rejseforsikringen",
//   "forsikringsselskab") handler om noget andet end BidHamr. De bliver til
//   det neutrale "dækning" (med samme bøjning og stort begyndelsesbogstav,
//   hvis ordet havde det), så svaret ikke kommer til at love noget om
//   BidHamr Beskyttelse.
//
// Svaret streames i små bidder, så et ord kan være delt over to bidder
// ("forsik" + "ring"). Strømfilteret holder derfor det sidste ufærdige ord
// tilbage, til det næste mellemrum eller tegnsætning kommer (eller svaret er
// slut).

// Et helt ord (bogstaver og tal), der indeholder "forsikring".
const ORD_MED_FORBUDT = /[\p{L}\p{N}]*forsikring[\p{L}\p{N}]*/giu;
// Selve ordet og dets bøjninger, evt. i ejefald.
const SELVE_ORDET = /^forsikring(en|er|erne)?(s)?$/iu;
// Bøjningen sidst i et sammensat ord.
const BOEJNING = /forsikring(en|er|erne)?(s)?$/iu;
const ERSTATNING = "BidHamr Beskyttelse";
const NEUTRAL = "dækning";
// Længere ord end dette holdes ikke helt tilbage (fx en lang streng uden
// mellemrum). Så holdes kun en hale tilbage, der kan være begyndelsen på
// "forsikring" (højst 9 tegn), så ordet ikke kan glide igennem delt over
// grænsen.
const MAKS_HALE = 60;
const ROD = "forsikring";

function begyndelseHale(tekst: string): number {
  const lav = tekst.toLowerCase();
  for (let n = Math.min(ROD.length - 1, lav.length); n > 0; n--) {
    if (ROD.startsWith(lav.slice(lav.length - n))) return n;
  }
  return 0;
}

const storStart = (ord: string) => {
  const f = ord.charAt(0);
  return f !== f.toLowerCase() && f === f.toUpperCase();
};

function erstatOrd(ord: string): string {
  const selve = SELVE_ORDET.exec(ord);
  if (selve) return `${ERSTATNING}${selve[2] ? "s" : ""}`;
  const b = BOEJNING.exec(ord);
  const endelse = b ? `${(b[1] ?? "").toLowerCase()}${b[2] ? "s" : ""}` : "";
  const neutral = `${NEUTRAL}${endelse}`;
  return storStart(ord) ? neutral.charAt(0).toUpperCase() + neutral.slice(1) : neutral;
}

export function erstatForbudteOrd(tekst: string): string {
  return tekst.replace(ORD_MED_FORBUDT, erstatOrd);
}

export type OrdFilter = {
  // Ny bid fra modellen -> den tekst, der kan sendes nu (filtreret).
  skub(bid: string): string;
  // Svaret er slut -> resten (filtreret).
  toem(): string;
};

export function lavOrdFilter(): OrdFilter {
  let rest = "";
  return {
    skub(bid) {
      rest += bid;
      const hale = rest.match(/[\p{L}\p{N}]+$/u)?.[0].length ?? 0;
      // Et meget langt "ord": send det, undtagen en mulig begyndelse på
      // "forsikring".
      const klar = hale > MAKS_HALE ? rest.length - begyndelseHale(rest) : rest.length - hale;
      const ud = rest.slice(0, klar);
      rest = rest.slice(klar);
      return erstatForbudteOrd(ud);
    },
    toem() {
      const ud = erstatForbudteOrd(rest);
      rest = "";
      return ud;
    },
  };
}
