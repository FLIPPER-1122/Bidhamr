// "Meld fejl"-knappen til beta-testen. Vises kun før lancering for
// indloggede beta-testere og staff (src/lib/betaFejlAdgang.ts) - uden
// databasekald: identiteten kommer fra sessionens JWT og den signerede
// rolle-cookie, som gaten allerede har sat. Alle andre får intet (heller
// ikke knappens JavaScript). Læg den i en <Suspense fallback={null}>.
import dynamic from "next/dynamic";
import { betaFejlKnapBruger } from "@/lib/betaFejlAdgang";

const BetaFejlStarter = dynamic(() => import("./BetaFejlStarter"));

export default async function BetaFejlKnap() {
  const brugerId = await betaFejlKnapBruger();
  if (!brugerId) return null;
  return <BetaFejlStarter brugerId={brugerId} />;
}
