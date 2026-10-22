// BidHamrs egne firmaoplysninger - ét sted (e-handelsloven § 7: navn,
// adresse, CVR og e-mail skal være let tilgængelige). Bruges af sidefoden,
// kontakt-siden, mails' bundtekst, kvitteringen, PDF-udtrækket og
// fakturakontrollen (BIDHAMR_CVR i src/lib/faktura/konfig.ts).
//
// Juradokumenterne (jura/brugerbetingelser-udkast.md og
// jura/privatlivspolitik-udkast.md) er markdown og kan ikke importere herfra;
// tests/enhed/firmaoplysninger.test.ts tjekker, at de står ens dér.
// Ingen hemmeligheder - må gerne bruges i klient-komponenter.

export const FIRMA = {
  navn: "BidHamr ApS",
  cvr: "46836219",
  momsnr: "DK46836219",
  vej: "Ellegårdsvej 40",
  postnr: "4684",
  by: "Holmegaard",
  email: "support@bidhamr.dk",
} as const;

// "Ellegårdsvej 40, 4684 Holmegaard"
export const FIRMA_ADRESSE = `${FIRMA.vej}, ${FIRMA.postnr} ${FIRMA.by}`;

// Delene af firmalinjen, så visningen kan gøre e-mailen til et link og
// bryde pænt mellem delene på mobil.
export const FIRMA_LINJE_DELE = [FIRMA.navn, `CVR ${FIRMA.cvr}`, FIRMA_ADRESSE, FIRMA.email] as const;

// "BidHamr ApS · CVR 46836219 · Ellegårdsvej 40, 4684 Holmegaard · support@bidhamr.dk"
export const FIRMA_LINJE = FIRMA_LINJE_DELE.join(" · ");
