import "server-only";

// Betalingsmetoder for betalinger til BidHamrs PLATFORMSKONTO (boost,
// returfragt): den tilladte liste (betalingsmetoder.ts) minus det, der ikke
// er slået til på platformen hos Stripe. Ellers ville Stripe i live kunne
// afvise hele PaymentIntenten, hvis fx Revolut Pay ikke er slået til - og så
// kunne ingen betale boost eller returfragt.
//
// Kilden er platformens standard-konfiguration (paymentMethodConfigurations,
// is_default, uden parent/application) - der skal være PRÆCIS én. Cachet i
// 10 minutter pr. proces. Kan den ikke hentes (eller er der ingen eller flere
// kandidater), bruges kun kort (virker altid) i 1 minut, og chefen får én
// drift-alarm (fast nøgle, alarmPrTilfaelde), som lukkes igen, når
// opslaget virker. Betalingen stopper aldrig af den grund.

import { getStripe } from "@/lib/stripe";
import { alarmPrTilfaelde, lukTilfaelde } from "@/lib/betaling/driftTilfaelde";
import { platformMetoderFra, type Betalingsmetode } from "@/lib/betaling/betalingsmetoder";

const CACHE_MS = 10 * 60_000;
const FEJL_CACHE_MS = 60_000;
export const PLATFORM_METODER_ALARM = "betalingsmetoder:platform-konfiguration";
let cache: { udloeber: number; metoder: Betalingsmetode[] } | null = null;

export async function hentPlatformMetoder(): Promise<Betalingsmetode[]> {
  if (cache && cache.udloeber > Date.now()) return [...cache.metoder];
  try {
    const liste = await getStripe().paymentMethodConfigurations.list({ limit: 100 });
    const kandidater = liste.data.filter((c) => c.is_default && !c.parent && !c.application);
    if (kandidater.length !== 1) {
      throw new Error(
        `Forventede præcis én standard-konfiguration for betalingsmetoder på platformen, fandt ${kandidater.length}${liste.has_more ? " (listen har flere sider)" : ""}`,
      );
    }
    const metoder = platformMetoderFra(kandidater[0] as unknown as Record<string, { available?: boolean | null }>);
    cache = { udloeber: Date.now() + CACHE_MS, metoder };
    // Lukker alarmen (højst én gang pr. 10 min) - også hvis en anden proces
    // åbnede den.
    await lukTilfaelde(PLATFORM_METODER_ALARM);
    return [...metoder];
  } catch (err) {
    cache = { udloeber: Date.now() + FEJL_CACHE_MS, metoder: ["card"] };
    await alarmPrTilfaelde({
      noegle: PLATFORM_METODER_ALARM,
      hvor: "betaling/platform-metoder",
      fejl: `Platformens betalingsmetoder kunne ikke afgøres hos Stripe - boost og returfragt tilbyder kun kort (inkl. Apple Pay/Google Pay), indtil det virker igen: ${err instanceof Error ? err.message : String(err)}`,
    });
    return ["card"];
  }
}

// Kun til tests.
export function nulstilPlatformMetoderCache(): void {
  cache = null;
}
