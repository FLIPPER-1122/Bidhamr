import Stripe from "stripe";

// Lazy-initialiseret: `new Stripe()` kaster hvis nøglen mangler, og det må
// ikke ske ved module-load (fx under `next build`s page data collection).
let client: Stripe | null = null;

export function getStripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY mangler i miljøvariablerne.");
    }
    client = new Stripe(key);
  }
  return client;
}
