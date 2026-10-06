import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";
import Sidevisning from "@/components/statistik/Sidevisning";
import CookieBanner from "@/components/samtykke/CookieBanner";
import { seoIndeksering } from "@/lib/seo";
import { SAMTYKKE_COOKIE, gyldigSamtykkeVaerdi } from "@/lib/samtykke";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["600"],
  variable: "--font-fraunces",
  display: "swap",
});

// Ikoner og delebillede kommer fra filkonventionerne i src/app:
// favicon.ico, icon.svg, apple-icon.png og opengraph-image.jpg
// (lavet ud fra public/brand/bidhamr-app-ikon.svg, app-ikon 7B).
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://bidhamr.dk"),
  title: {
    default: "BidHamr – auktioner mellem private",
    template: "%s · BidHamr",
  },
  description:
    "BidHamr er den danske auktionsplatform, hvor privatpersoner sælger brugte ting til hinanden. Byd trygt med BidHamr Beskyttelse.",
  applicationName: "BidHamr",
  // Uden SEO_INDEKSERING=true (testmiljø, preview, pre-launch) får alle sider
  // noindex - robots.txt siger desuden "Disallow: /" (src/app/robots.ts).
  ...(seoIndeksering() ? {} : { robots: { index: false, follow: false } }),
  openGraph: {
    type: "website",
    siteName: "BidHamr",
    locale: "da_DK",
  },
};

export const viewport: Viewport = {
  themeColor: "#1e5e4a",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // CSP med nonce (src/proxy.ts) kraever dynamisk rendering: statiske sider
  // bygges uden request og ville faa scripts uden nonce, som browseren afviser.
  await connection();
  // Cookie-samtykket læses her, så banneret er med i den første HTML, når der
  // mangler et gyldigt valg (ingen blink efter hydrering).
  const startRaa = gyldigSamtykkeVaerdi((await cookies()).get(SAMTYKKE_COOKIE)?.value);
  return (
    <html
      lang="da"
      className={`${inter.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="font-sans min-h-full flex flex-col" suppressHydrationWarning>
        {children}
        {/* Cookiefri besøgsstatistik (src/app/api/statistik/route.ts). */}
        <Sidevisning />
        <CookieBanner startRaa={startRaa} />
      </body>
    </html>
  );
}
