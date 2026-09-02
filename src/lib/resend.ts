import { Resend } from "resend";

// Lazy-initialiseret, så en manglende nøgle ikke kaster ved module-load og
// dermed vælter `next build` (samme problem som Stripe-klienten havde).
let client: Resend | null = null;

export function getResend(): Resend | null {
  if (client) return client;

  const key = process.env.RESEND_API_KEY;
  if (!key) return null;

  client = new Resend(key);
  return client;
}
