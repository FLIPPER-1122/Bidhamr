// Henvis en ven: koden og linket (ingen server-afhængigheder - bruges også i
// browseren). Databasen laver koden (henvisning_ny_kode,
// 20261102230000_henvis_en_ven.sql): 10 tegn fra A-Z uden I og O og 2-9.
//
// Ingen cookie (Filip, 27. okt. 2026): koden gemmes aldrig i browseren. Den
// følger med i URL'en (?ven=KODE) fra den side, vennen landede på, til opret
// konto og videre til "Indtast koden" (medHenvisning nedenfor), og vennen kan
// se og rette den i feltet "Henvisningskode".

export const HENVISNING_PARAM = "ven";

const KODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

// Renser en kode fra linket, formularen eller appen. null = ugyldig.
export function renHenvisningskode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const kode = v.trim().toUpperCase();
  return KODE_RE.test(kode) ? kode : null;
}

// Stien til linket (bidhamr.dk/?ven=KODE).
export function henvisningSti(kode: string): string {
  return `/?${HENVISNING_PARAM}=${encodeURIComponent(kode)}`;
}

// Kun links til login, opret konto og "Indtast koden" får koden med.
const MED_KODE = new Set(["/login", "/signup", "/tjek-indbakke"]);

// Lægger ?ven=KODE på et internt link til login/opret konto/"Indtast koden",
// når kodeInput er en gyldig kode. Andre links (og eksterne) er uændrede, og
// en kode, der allerede står i linket, overskrives ikke.
export function medHenvisning(href: string, kodeInput: unknown): string {
  const kode = renHenvisningskode(kodeInput);
  if (!kode || !href.startsWith("/") || href.startsWith("//")) return href;
  const hashStart = href.indexOf("#");
  const hash = hashStart >= 0 ? href.slice(hashStart) : "";
  const udenHash = hashStart >= 0 ? href.slice(0, hashStart) : href;
  const qStart = udenHash.indexOf("?");
  const sti = qStart >= 0 ? udenHash.slice(0, qStart) : udenHash;
  if (!MED_KODE.has(sti)) return href;
  const params = new URLSearchParams(qStart >= 0 ? udenHash.slice(qStart + 1) : "");
  if (params.has(HENVISNING_PARAM)) return href;
  params.set(HENVISNING_PARAM, kode);
  return `${sti}?${params.toString()}${hash}`;
}
