import { bekraeftetBruger, hentKontoFelter, sessionBrugerId } from "@/lib/supabase/bruger";
import MitIDResultat from "@/components/mitid/MitIDResultat";

// Henter MitID-status på serveren (samme cachede opslag som topbaren - intet
// ekstra kald), så succesbeskeden kun vises for en bruger, der faktisk er
// MitID-verificeret.
export default async function MitIDResultatBoks() {
  const sessionId = await sessionBrugerId();
  const [bruger, felter] = await Promise.all([
    sessionId ? bekraeftetBruger(sessionId) : null,
    sessionId ? hentKontoFelter(sessionId) : null,
  ]);
  const verificeret = !!bruger && !!felter?.mitid_verificeret_kl;
  return <MitIDResultat verificeret={verificeret} />;
}
