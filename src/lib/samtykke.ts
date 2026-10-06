// Cookie-samtykke: fælles regler for server og klient.
//
// Valget gemmes i førsteparts-cookien bh_samtykke (selv en nødvendig cookie):
//   v=<version>&t=<unix-sekunder>&statistik=0|1&markedsfoering=0|1
// Samtykket gælder højst 12 måneder. Ændres cookiepolitikken (nyt værktøj,
// ny kategori, ny udbyder), skal SAMTYKKE_VERSION tælles op - så bliver alle
// spurgt igen, fordi et samtykke kun gælder det, man er blevet oplyst om.
//
// Klient-API (harSamtykke, useSamtykke, naarSamtykke, KraeverSamtykke) ligger
// i src/lib/samtykkeKlient.ts og src/components/samtykke/.

export const SAMTYKKE_COOKIE = "bh_samtykke";

// Tæl op, når cookiepolitikken ændres på en måde, der kræver nyt samtykke.
// Husk også at opdatere src/lib/tekster/sider/cookies.ts.
export const SAMTYKKE_VERSION = 1;

// 12 måneder (Datatilsynets anbefaling for, hvor længe et samtykke holder).
export const SAMTYKKE_MAKS_SEKUNDER = 365 * 24 * 60 * 60;

// Kategorier, man kan sige ja eller nej til. "Nødvendige" er altid til og
// står derfor ikke her. iBrug=false: kategorien findes, men BidHamr bruger
// ingen værktøjer i den i dag (det står ærligt i banneret).
export const SAMTYKKE_KATEGORIER = [
  { id: "statistik", iBrug: false },
  { id: "markedsfoering", iBrug: false },
] as const;

export type SamtykkeKategori = (typeof SAMTYKKE_KATEGORIER)[number]["id"];

export type SamtykkeValg = Record<SamtykkeKategori, boolean>;

export type Samtykke = {
  version: number;
  // Unix-sekunder for, hvornår valget blev truffet.
  tidspunkt: number;
  valg: SamtykkeValg;
};

// Cookies og lagring, som værktøjer i en kategori sætter. Slettes, når
// samtykket trækkes tilbage. Tom i dag - udfyld, når et værktøj tages i brug.
export const COOKIES_PR_KATEGORI: Record<SamtykkeKategori, string[]> = {
  statistik: [],
  markedsfoering: [],
};

export const INTET_VALG: SamtykkeValg = { statistik: false, markedsfoering: false };
export const ALT_VALGT: SamtykkeValg = { statistik: true, markedsfoering: true };

// Læser cookieværdien. Returnerer null, hvis den mangler, er ugyldig, er fra
// en gammel version eller er ældre end 12 måneder (så skal man spørges igen).
// Uden nuMs tjekkes alderen ikke (værdien er allerede tjekket, fx i et snapshot).
export function fortolkSamtykke(raa: string | null | undefined, nuMs?: number): Samtykke | null {
  if (!raa || raa.length > 200) return null;
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(raa);
  } catch {
    return null;
  }
  const version = Number(p.get("v"));
  const tidspunkt = Number(p.get("t"));
  if (version !== SAMTYKKE_VERSION) return null;
  if (!Number.isInteger(tidspunkt) || tidspunkt <= 0) return null;
  if (nuMs !== undefined) {
    const nu = Math.floor(nuMs / 1000);
    // Et tidspunkt mere end et døgn ude i fremtiden er ikke troværdigt.
    if (tidspunkt > nu + 24 * 60 * 60) return null;
    if (nu - tidspunkt > SAMTYKKE_MAKS_SEKUNDER) return null;
  }
  const valg = { ...INTET_VALG };
  for (const k of SAMTYKKE_KATEGORIER) valg[k.id] = p.get(k.id) === "1";
  return { version, tidspunkt, valg };
}

// Cookieværdien, hvis den er gyldig lige nu - ellers "". Bruges af root-
// layoutet, så serveren ved, om banneret skal med i den første HTML.
export function gyldigSamtykkeVaerdi(raa: string | null | undefined): string {
  return raa && fortolkSamtykke(raa, Date.now()) ? raa : "";
}

export function lavSamtykkeVaerdi(valg: SamtykkeValg, nuMs: number): string {
  const p = new URLSearchParams();
  p.set("v", String(SAMTYKKE_VERSION));
  p.set("t", String(Math.floor(nuMs / 1000)));
  for (const k of SAMTYKKE_KATEGORIER) p.set(k.id, valg[k.id] ? "1" : "0");
  return p.toString();
}
