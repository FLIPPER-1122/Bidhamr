import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { seoIndeksering, sideUrl } from "@/lib/seo";

// robots.txt. Uden SEO_INDEKSERING=true må intet indekseres (testmiljø og
// pre-launch). Læses ved hver forespørgsel, så det virker uden nyt build.
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();

  if (!seoIndeksering()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/dev",
        "/api",
        "/auth",
        "/konto",
        "/mine-handler",
        "/beskeder",
        "/notifikationer",
        "/favoritter",
        "/opret-auktion",
        "/andenchance",
        "/profil/mig",
        "/auktion/*/rediger",
        "/nulstil-adgangskode",
        "/reset-password",
      ],
    },
    sitemap: `${sideUrl()}/sitemap.xml`,
  };
}
