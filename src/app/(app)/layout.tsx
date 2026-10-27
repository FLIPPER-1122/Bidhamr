import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { Suspense } from "react";
import FavoritterProvider from "@/components/FavoritterProvider";
import MitIDResultatBoks from "@/components/mitid/MitIDResultatBoks";
import VilkaarVindue from "@/components/vilkaar/VilkaarVindue";
import BetaFejlKnap from "@/components/betafejl/BetaFejlKnap";
import LukketHeader from "@/components/lukket/LukketHeader";
import LukketFooter from "@/components/lukket/LukketFooter";
import { visLukketUdgave } from "@/lib/lukketUdgave";
import BotBoble from "@/components/bot/BotBoble";

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Før lancering ser besøgende uden adgang til den lukkede app kun erhverv og
  // de lovpligtige sider - i en minimal udgave uden menu og footer-links
  // (src/lib/lukketUdgave.ts). Efter lancering returnerer den straks false.
  const lukket = await visLukketUdgave();
  return (
    <FavoritterProvider>
      {lukket ? <LukketHeader /> : <Header />}
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
      {lukket ? <LukketFooter className="mt-16" /> : <Footer />}
      {/* Blokerende vindue med brugerbetingelserne (kun logget ind, ikke
          accepteret den aktuelle version) - efter cookie-banneret. */}
      <Suspense fallback={null}>
        <VilkaarVindue />
      </Suspense>
      {/* "Meld fejl" til beta-testere og staff før lancering (ellers intet). */}
      {!lukket && (
        <Suspense fallback={null}>
          <BetaFejlKnap />
        </Suspense>
      )}
      {/* BidHamr-bot (kun med ANTHROPIC_API_KEY og, før lancering, kun med
          adgang til den lukkede app - src/lib/bot/synlig.ts). */}
      {!lukket && (
        <Suspense fallback={null}>
          <BotBoble />
        </Suspense>
      )}
    </FavoritterProvider>
  );
}
