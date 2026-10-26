import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { SEO_FOER_LANCERING, seoFoerLancering, seoIndeksering, sideUrl } from "@/lib/seo";

// robots.txt. Uden SEO_INDEKSERING=true må intet indekseres (testmiljø og
// pre-launch). Læses ved hver forespørgsel, så det virker uden nyt build.
export default async function robots(): Promise<MetadataRoute.Robots> {
  await connection();

  // Før lancering (kun produktion, src/lib/seo.ts): kun de få offentlige
  // sider. "/$" er præcis forsiden (coming soon). Next' filer (CSS/JS),
  // logo og delebillede må hentes, så Google kan vise siderne rigtigt.
  if (seoFoerLancering()) {
    return {
      rules: {
        userAgent: "*",
        allow: [
          ...SEO_FOER_LANCERING.map((s) => (s.sti === "/" ? "/$" : s.sti)),
          "/_next/static/",
          "/_next/image",
          "/brand/",
          "/opengraph-image.jpg",
          "/icon.svg",
          "/apple-icon.png",
          "/favicon.ico",
        ],
        disallow: "/",
      },
      sitemap: `${sideUrl()}/sitemap.xml`,
    };
  }

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
