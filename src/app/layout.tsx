import type { Metadata } from "next";
import { Inter, Fraunces } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: {
    default: "BidHamr – auktioner mellem private",
    template: "%s · BidHamr",
  },
  description:
    "BidHamr er den danske auktionsplatform, hvor privatpersoner sælger brugte ting til hinanden. Byd trygt med BidHamr Beskyttelse.",
  icons: {
    icon: [{ url: "/brand/bidhamr-app-ikon.svg", type: "image/svg+xml" }],
    shortcut: "/brand/bidhamr-app-ikon.svg",
    apple: "/brand/bidhamr-app-ikon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="da"
      className={`${inter.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="font-sans min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
