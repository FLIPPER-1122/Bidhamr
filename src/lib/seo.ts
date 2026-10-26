// Fælles til SEO: robots.ts, sitemap.ts og metadata på auktionssiden.
import type { Metadata } from "next";
import { foerLancering } from "@/lib/lancering";
import { erTestdatabase } from "@/lib/miljoe";

// Efter lancering: søgemaskiner må kun indeksere siden, når
// SEO_INDEKSERING=true er sat. Uden den siger robots.txt "Disallow: /", og
// sitemap.xml er tom - så testmiljø og preview aldrig indekseres.
// Før lancering gælder i stedet seoFoerLancering() herunder (SEO_INDEKSERING
// åbner ikke hele den lukkede side).
export function seoIndeksering(): boolean {
  return process.env.SEO_INDEKSERING === "true" && !foerLancering();
}

// Før lancering (Filip, 26. okt. 2026) må Google lære bidhamr.dk at kende:
// KUN siderne i SEO_FOER_LANCERING må indekseres (forsiden viser coming soon).
// Ingen ny Vercel-variabel: det gælder kun i Vercels produktionsmiljø
// (VERCEL_ENV=production, sat af Vercel selv) mod produktionsdatabasen - aldrig
// preview, test.bidhamr.dk (testdatabasen) eller lokalt. Lokalt kan det testes
// med SIMULER_FOER_LANCERING=true (kun uden for Vercel).
export const SEO_FOER_LANCERING = [
  { sti: "/", prioritet: 1, frekvens: "weekly" },
  { sti: "/erhverv", prioritet: 0.8, frekvens: "monthly" },
  { sti: "/privatliv", prioritet: 0.2, frekvens: "yearly" },
  { sti: "/betingelser", prioritet: 0.2, frekvens: "yearly" },
  { sti: "/dsa", prioritet: 0.2, frekvens: "yearly" },
] as const;

export type SeoFoerLanceringSti = (typeof SEO_FOER_LANCERING)[number]["sti"];

export function seoFoerLancering(): boolean {
  if (!foerLancering()) return false;
  if (erTestdatabase()) return !process.env.VERCEL && process.env.SIMULER_FOER_LANCERING === "true";
  return process.env.VERCEL_ENV === "production";
}

// robots-metadata for en side, der må indekseres før lancering. Før lancering
// (i produktion) index, ellers som resten af siden: arv fra rodlayoutet
// (noindex uden SEO_INDEKSERING) - dvs. uændret efter lancering.
export function robotsFoerLancering(sti: SeoFoerLanceringSti | null): Pick<Metadata, "robots"> {
  if (seoFoerLancering()) {
    return { robots: sti ? { index: true, follow: true } : { index: false, follow: true } };
  }
  return seoIndeksering() ? {} : { robots: { index: false, follow: false } };
}

// Delebilledet (src/app/opengraph-image.jpg). Angives udtrykkeligt, når en side
// selv sætter openGraph/twitter - ellers falder filkonventionens billede væk.
export const DELEBILLEDE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  alt: "BidHamr – auktioner mellem private",
  type: "image/jpeg",
};

// Open Graph og Twitter/X for en side (titel og beskrivelse til deling).
export function delingMetadata(sti: string, titel: string, beskrivelse: string): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: {
      type: "website",
      url: sti,
      siteName: "BidHamr",
      locale: "da_DK",
      title: titel,
      description: beskrivelse,
      images: [DELEBILLEDE],
    },
    twitter: { card: "summary_large_image", title: titel, description: beskrivelse, images: [DELEBILLEDE] },
  };
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
