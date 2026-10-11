import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { Suspense } from "react";
import FavoritterProvider from "@/components/FavoritterProvider";
import MitIDResultatBoks from "@/components/mitid/MitIDResultatBoks";
import VilkaarVindue from "@/components/vilkaar/VilkaarVindue";
import BetaFejlKnap from "@/components/betafejl/BetaFejlKnap";

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
          <MitIDResultatBoks />
        </Suspense>
        {children}
      </div>
      <Footer />
      {/* Blokerende vindue med brugerbetingelserne (kun logget ind, ikke
          accepteret den aktuelle version) - efter cookie-banneret. */}
      <Suspense fallback={null}>
        <VilkaarVindue />
      </Suspense>
      {/* "Meld fejl" til beta-testere og staff før lancering (ellers intet). */}
      <Suspense fallback={null}>
        <BetaFejlKnap />
      </Suspense>
    </FavoritterProvider>
  );
}
