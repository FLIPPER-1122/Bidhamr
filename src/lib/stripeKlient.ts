// "pure": Stripe.js indsættes først, når hentStripe() kaldes (fx når brugeren
// trykker "Gem et kort"), ikke allerede når modulet importeres.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";

// Stripe.js hentes kun på de sider, der bruger Payment Element.
let stripePromise: Promise<Stripe | null> | null = null;

export function hentStripe() {
  if (!stripePromise) {
    const noegle = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    stripePromise = noegle ? loadStripe(noegle, { locale: "da" }) : Promise.resolve(null);
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
