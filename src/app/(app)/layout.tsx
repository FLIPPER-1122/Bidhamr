import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { Suspense } from "react";
import FavoritterProvider from "@/components/FavoritterProvider";
import MitIDResultat from "@/components/mitid/MitIDResultat";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <FavoritterProvider>
      <Header />
      {/* Mål for "Spring til indhold" i topbaren. På mobil fylder indholdet
          mindst skærmhøjden, så footeren ikke hopper inde i billedet, når en
          side skifter fra indlæsning (skelet) til det rigtige indhold (CLS). */}
      <div id="indhold" tabIndex={-1} className="flex flex-1 flex-col outline-none max-lg:min-h-svh">
        {/* Besked efter MitID (?mitid=...) - se src/app/api/mitid/callback. */}
        <Suspense fallback={null}>
          <MitIDResultat />
        </Suspense>
        {children}
      </div>
      <Footer />
    </FavoritterProvider>
  );
}
