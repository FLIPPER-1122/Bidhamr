import type { Instrumentation } from "next";

// Start-tjek (Niels F07, trin 5): når serveren starter, kontrolleres det, at
// Stripe-nøglerne (test/live) passer til databasens stripe_tilstand, og at
// databasen er migreret til betalingsmodellen destination. Afvigelser giver
// drift-alarm - ÉN pr. tilfælde (drift_tilfaelde: start:stripe-noegle,
// start:stripe-offentlig, start:betalingsmodel), lukkes, når det passer igen.
// Selve vagterne sidder foran hvert Stripe-kald og hver ny betaling. Venter
// ikke på svaret (ingen forsinkelse af opstarten) og kaster aldrig.
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.STRIPE_SECRET_KEY || !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) return;
  void (async () => {
    try {
      const { databasensStripeTilstand, noeglensTilstand, offentligNoeglesTilstand } = await import("@/lib/stripe");
      const { databasenErDestination } = await import("@/lib/betaling/model");
      const { alarmPrTilfaelde, lukTilfaelde } = await import("@/lib/betaling/driftTilfaelde");
      const tjek = async (noegle: string, ok: boolean, hvor: string, fejl: string) => {
        if (ok) await lukTilfaelde(noegle);
        else await alarmPrTilfaelde({ noegle, hvor, fejl });
      };
      const hemmelig = noeglensTilstand();
      const db = await databasensStripeTilstand();
      const offentlig = offentligNoeglesTilstand();
      await tjek(
        "start:stripe-noegle",
        !!hemmelig && (db === hemmelig || (db === null && hemmelig === "test")),
        "stripe/tilstand",
        `Start-tjek: Stripe-nøglen er ${hemmelig ?? "ukendt"}, men databasens Stripe-tilstand er ${db ?? "ukendt"} - Stripe-kald stoppes. Se docs/GO-LIVE-STRIPE.md.`,
      );
      await tjek(
        "start:stripe-offentlig",
        !offentlig || !hemmelig || offentlig === hemmelig,
        "stripe/tilstand",
        `Start-tjek: den offentlige Stripe-nøgle er ${offentlig}, men den hemmelige er ${hemmelig} - nye betalinger stoppes.`,
      );
      await tjek(
        "start:betalingsmodel",
        await databasenErDestination(),
        "betaling/betalingsmodel",
        "Start-tjek: databasens betalingsmodel er ikke 'destination' - der oprettes ingen betalinger, før migrationerne er kørt (docs/GO-LIVE-STRIPE.md).",
      );
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
