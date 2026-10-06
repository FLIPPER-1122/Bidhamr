// Fælles til SEO: robots.ts, sitemap.ts og metadata på auktionssiden.

// Søgemaskiner må kun indeksere siden, når SEO_INDEKSERING=true er sat
// (produktion efter lancering). Uden den siger robots.txt "Disallow: /", og
// sitemap.xml er tom - så testmiljø, preview og pre-launch aldrig indekseres.
export function seoIndeksering(): boolean {
  return process.env.SEO_INDEKSERING === "true";
}

export function sideUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "https://bidhamr.dk").replace(/\/+$/, "");
}

// Offentlige tekstsider til sitemap.xml. Hold synkron med footeren
// (src/components/Footer.tsx), når nye faste sider kommer til.
export const TEKSTSIDER = [
  "/saadan-virker-det",
  "/bidhamr-beskyttelse",
  "/faq",
  "/pakkeguide",
  "/forbudte-varer",
  "/om",
  "/kontakt",
  "/cookies",
  "/betingelser",
  "/privatliv",
  "/tilgaengelighed",
] as const;

// Afkorter en beskrivelse til meta description (ca. 160 tegn, helt ord).
export function kortBeskrivelse(tekst: string | null | undefined, maks = 160): string {
  const ren = (tekst ?? "").replace(/\s+/g, " ").trim();
  if (ren.length <= maks) return ren;
  const klip = ren.slice(0, maks - 1);
  const sidsteMellemrum = klip.lastIndexOf(" ");
  return `${(sidsteMellemrum > maks * 0.6 ? klip.slice(0, sidsteMellemrum) : klip).trimEnd()}…`;
}
