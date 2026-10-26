import { FIRMA } from "@/lib/firmaoplysninger";
import { sideUrl } from "@/lib/seo";

// Strukturerede data (schema.org) til coming soon-forsiden før lancering:
// hvem står bag (Organization, fra src/lib/firmaoplysninger.ts) og selve
// webstedet (WebSite). Uden søgefunktion - søgningen er lukket før lancering.
export function comingSoonJsonLd(): string {
  const url = sideUrl();
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${url}/#organisation`,
        name: "BidHamr",
        legalName: FIRMA.navn,
        url: `${url}/`,
        logo: { "@type": "ImageObject", url: `${url}/brand/bidhamr-logo-512.png`, width: 512, height: 512 },
        email: FIRMA.email,
        vatID: FIRMA.momsnr,
        identifier: { "@type": "PropertyValue", propertyID: "CVR", value: FIRMA.cvr },
        address: {
          "@type": "PostalAddress",
          streetAddress: FIRMA.vej,
          postalCode: FIRMA.postnr,
          addressLocality: FIRMA.by,
          addressCountry: "DK",
        },
        contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: FIRMA.email, availableLanguage: ["da", "en"] },
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#websted`,
        name: "BidHamr",
        url: `${url}/`,
        inLanguage: "da-DK",
        publisher: { "@id": `${url}/#organisation` },
      },
    ],
  };
  // "<" escapes, så teksten aldrig kan lukke script-tagget.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
