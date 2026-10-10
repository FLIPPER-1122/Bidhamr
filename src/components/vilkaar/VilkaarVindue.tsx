import { bekraeftetBruger, hentMineVilkaar, sessionBrugerId } from "@/lib/supabase/bruger";
import { vilkaarErAccepteret } from "@/lib/vilkaar";
import VilkaarDialog from "@/components/vilkaar/VilkaarDialog";

// Blokerende vindue med brugerbetingelserne (Filip, 10. okt. 2026): vises for
// logget-ind brugere, der ikke har accepteret den aktuelle version. Ikke for
// besøgende uden konto. Ligger i (app)-layoutet bag en <Suspense>, så resten
// af siden ikke venter på opslaget. Bruger og accept deles med resten af
// siden (cache() i src/lib/supabase/bruger.ts) - og opslaget kører samtidig
// med topbarens.
// Hvilke sider der er undtaget, og at vinduet venter på cookie-banneret,
// afgøres i browseren (VilkaarDialog), fordi layoutet ikke kender stien og
// ikke bygges om ved navigation.
// Ved en fejl i opslaget vises vinduet ikke (det er ikke en adgangskontrol).
export default async function VilkaarVindue() {
  const sessionId = await sessionBrugerId();
  if (!sessionId) return null;
  const [bruger, vilkaar] = await Promise.all([bekraeftetBruger(sessionId), hentMineVilkaar()]);
  if (!bruger || !vilkaar || vilkaarErAccepteret(vilkaar.version)) return null;
  return <VilkaarDialog nyVersion={vilkaar.version !== null} />;
}
