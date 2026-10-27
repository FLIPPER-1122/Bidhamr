// BidHamr-bottens svarfilter (ren funktion, ingen server-afhængigheder).
//
// Ordet "forsikring" bruges aldrig (CLAUDE.md) - det hedder "BidHamr
// Beskyttelse". Systemprompten siger det til modellen, og filteret her
// fanger det, hvis modellen alligevel skriver det (også sammensatte ord som
// "købsforsikring" og bøjninger som "forsikringen").
//
// Svaret streames i små bidder, så et ord kan være delt over to bidder
// ("forsik" + "ring"). Strømfilteret holder derfor det sidste ufærdige ord
// tilbage, til det næste mellemrum eller tegnsætning kommer (eller svaret er
// slut).

const FORBUDT = /\p{L}*forsikring\p{L}*/giu;
const ERSTATNING = "BidHamr Beskyttelse";
// Længere ord end dette holdes ikke tilbage (filtreres stadig).
const MAKS_HALE = 60;

export function erstatForbudteOrd(tekst: string): string {
  return tekst.replace(FORBUDT, ERSTATNING);
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
      const hale = rest.match(/\p{L}+$/u)?.[0].length ?? 0;
      const klar = hale > MAKS_HALE ? rest.length : rest.length - hale;
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
