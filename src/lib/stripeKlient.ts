// "pure": Stripe.js indsættes først, når hentStripe() kaldes (fx når brugeren
// trykker "Gem et kort"), ikke allerede når modulet importeres.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";
import { rapporterKlientFejl } from "@/app/actions/drift";
import { indbyggetOffentligNoegle } from "@/lib/stripeNoegle";

// Vises i stedet for en grå "Betal"-knap, når Stripe.js ikke kan bruges.
export const STRIPE_IKKE_INDLAEST =
  "Betalingsformularen kunne ikke indlæses. Genindlæs siden, og prøv igen. Sker det igen, så kontakt BidHamr.";

// Stripe.js hentes kun på de sider, der bruger Payment Element.
let stripePromise: Promise<Stripe | null> | null = null;

function rapporter(besked: string) {
  rapporterKlientFejl({
    sti: typeof window !== "undefined" ? window.location.pathname : null,
    besked,
  }).catch(() => {
    // Serveren svarer ikke - intet at gøre.
  });
}

// null = Stripe.js kan ikke bruges (ingen gyldig offentlig nøgle i buildet,
// eller scriptet kunne ikke hentes - CSP, netværk, blokering). Fejlen
// sendes til /admin/drift, og formularen viser STRIPE_IKKE_INDLAEST
// (StripeIndlaesningsfejl). Før 19. okt. 2026 gav en manglende nøgle
// stille null, og "Betal"-knappen forblev grå uden forklaring.
export function hentStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const noegle = indbyggetOffentligNoegle();
    if (!noegle) {
      rapporter("Stripe: NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY mangler eller er ugyldig i dette build (Payment Element kan ikke vises)");
      stripePromise = Promise.resolve(null);
    } else {
      stripePromise = loadStripe(noegle, { locale: "da" }).catch((err: unknown) => {
        rapporter(`Stripe.js kunne ikke indlæses: ${err instanceof Error ? err.message : String(err)}`);
        // Næste visning prøver igen.
        stripePromise = null;
        return null;
      });
    }
  }
  return stripePromise;
}

// Payment Element i BidHamrs farver.
export const stripeUdseende = {
  theme: "stripe" as const,
  variables: {
    colorPrimary: "#1E5E4A",
    colorText: "#1A1A1A",
    colorDanger: "#A32020",
    fontFamily: "Inter, system-ui, sans-serif",
    borderRadius: "10px",
  },
};
