import "server-only";

// Betalingsmetoder for betalinger til BidHamrs PLATFORMSKONTO (boost,
// returfragt): den tilladte liste (betalingsmetoder.ts) minus det, der ikke
// er slået til på platformen hos Stripe. Ellers ville Stripe i live kunne
// afvise hele PaymentIntenten, hvis fx Revolut Pay ikke er slået til - og så
// kunne ingen betale boost eller returfragt.
//
// Kilden er platformens standard-konfiguration (paymentMethodConfigurations,
// is_default, uden parent/application). Cachet i 10 minutter pr. proces.
// Kan den ikke hentes, bruges kun kort (virker altid) i 1 minut, og fejlen
// logges - betalingen stopper aldrig af den grund.

import { getStripe } from "@/lib/stripe";
import { platformMetoderFra, type Betalingsmetode } from "@/lib/betaling/betalingsmetoder";

const CACHE_MS = 10 * 60_000;
const FEJL_CACHE_MS = 60_000;
let cache: { udloeber: number; metoder: Betalingsmetode[] } | null = null;

export async function hentPlatformMetoder(): Promise<Betalingsmetode[]> {
  if (cache && cache.udloeber > Date.now()) return [...cache.metoder];
  try {
    const liste = await getStripe().paymentMethodConfigurations.list({ limit: 100 });
    const standard = liste.data.find((c) => c.is_default && !c.parent && !c.application) ?? null;
    if (!standard) throw new Error("Platformens standard-konfiguration for betalingsmetoder blev ikke fundet");
    const metoder = platformMetoderFra(standard as unknown as Record<string, { available?: boolean | null }>);
    cache = { udloeber: Date.now() + CACHE_MS, metoder };
    return [...metoder];
  } catch (err) {
    console.warn("Betalingsmetoder for platformen kunne ikke hentes - kun kort:", err instanceof Error ? err.message : err);
    cache = { udloeber: Date.now() + FEJL_CACHE_MS, metoder: ["card"] };
    return ["card"];
  }
}

// Kun til tests.
export function nulstilPlatformMetoderCache(): void {
  cache = null;
}
