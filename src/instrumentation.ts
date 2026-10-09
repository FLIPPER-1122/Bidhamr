import type { Instrumentation } from "next";

// Start-tjek (Niels F07, trin 5): når serveren starter, kontrolleres det, at
// Stripe-nøglerne (test/live) passer til databasens stripe_tilstand, og at
// databasen er migreret til betalingsmodellen destination. Afvigelser giver
// drift-alarm (stripe/tilstand hhv. betaling/betalingsmodel); selve vagterne
// sidder foran hvert Stripe-kald og hver ny betaling. Venter ikke på svaret
// (ingen forsinkelse af opstarten) og kaster aldrig.
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.STRIPE_SECRET_KEY || !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) return;
  void (async () => {
    try {
      const { kraevSammeStripeTilstand } = await import("@/lib/stripe");
      const { kraevDestination } = await import("@/lib/betaling/model");
      await kraevSammeStripeTilstand().catch(() => {});
      await kraevDestination().catch(() => {});
    } catch (e) {
      console.error("Start-tjek af Stripe fejlede:", e);
    }
  })();
}

// Serverfejl (rendering, route handlers, server actions, proxy), som Next selv
// fanger, logges i drift_fejl og vises på /admin/drift. Her har vi den rigtige
// fejlbesked; browseren får kun et digest, som error boundary'en rapporterer
// (samme digest tælles op på samme række).
//
// Kun stien uden query-streng, og teksten renses for persondata og
// hemmeligheder (src/lib/drift.ts). Kaster aldrig.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { logDriftFejl } = await import("@/lib/drift");
    const digest =
      typeof err === "object" && err !== null && "digest" in err
        ? String((err as { digest: unknown }).digest)
        : null;
    await logDriftFejl({
      kilde: "server",
      sti: request.path,
      hvor: `${context.routeType} ${context.routePath}`,
      fejl: err,
      digest,
    });
  } catch (e) {
    console.error("onRequestError: logning fejlede:", e);
  }
};
