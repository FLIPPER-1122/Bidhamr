// Henvis en ven: koden og cookien (ingen server-afhængigheder - bruges også
// af proxyen). Databasen laver koden (henvisning_ny_kode,
// 20261102230000_henvis_en_ven.sql): 10 tegn fra A-Z uden I og O og 2-9.

export const HENVISNING_COOKIE = "bh_ven";
// Cookien gælder i 30 dage (kun nødvendig: den husker, hvem der sendte
// linket, til kontoen er oprettet - se /cookies).
export const HENVISNING_COOKIE_SEK = 30 * 24 * 60 * 60;
export const HENVISNING_PARAM = "ven";

const KODE_RE = /^[A-HJ-NP-Z2-9]{10}$/;

// Renser en kode fra linket, cookien eller appen. null = ugyldig.
export function renHenvisningskode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const kode = v.trim().toUpperCase();
  return KODE_RE.test(kode) ? kode : null;
}

// Stien til linket (bidhamr.dk/?ven=KODE).
export function henvisningSti(kode: string): string {
  return `/?${HENVISNING_PARAM}=${encodeURIComponent(kode)}`;
}
