// Systemlampen "Test eller live" (lamper.ts). Ren funktion (testes i
// tests/penge-db).
//
// Samme regel som Stripe-vagten kraevSammeStripeTilstand (src/lib/stripe.ts):
// nøglens tilstand skal passe til databasens stripe_tilstand ('test' indtil
// fase 6 - også i produktionen, docs/GO-LIVE-STRIPE.md). Om Supabase-
// projektet er testdatabasen, afgør KUN teksten - aldrig om lampen er rød.
// Lampen (og dermed statuslinjen) er aldrig rød, når vagten ville godkende.

import type { Lampe } from "@/lib/admin/lamper";
import type { StripeTilstand } from "@/lib/stripe";

export function stripeTilstandLampe(
  noegle: StripeTilstand | null,
  db: StripeTilstand | null,
  testdatabase: boolean,
): Lampe | null {
  // Ingen (gyldig) nøgle: ingen lampe (som før).
  if (!noegle) return null;
  if (noegle === "test" && db === "test") {
    return testdatabase
      ? { navn: "Testmiljø", tone: "blaa", tekst: "testnøgle + testdatabase" }
      : { navn: "Testmiljø", tone: "blaa", tekst: "Stripe testmiljø (før lancering)" };
  }
  if (noegle === "live" && db === "live") {
    // En live-nøgle på testdatabasen godkendes af vagten (stripe_tilstand er
    // 'live'), men er ikke meningen - gul, ikke rød.
    return testdatabase
      ? {
          navn: "Live",
          tone: "gul",
          tekst: "live-nøgle på testdatabasen",
          statusTekst: "Testdatabasen kører med Stripes live-nøgle",
        }
      : { navn: "Live", tone: "groen", tekst: "live-nøgle + live i databasen" };
  }
  if (noegle === "test" && db === null) {
    // Vagten tillader testnøglen, når stripe_tilstand ikke kan læses (kun
    // testpenge). Ikke rød - men heller ikke grøn.
    return {
      navn: "Test eller live",
      tone: "gul",
      tekst: "testnøgle · databasens Stripe-tilstand kunne ikke læses",
      statusTekst: "Databasens Stripe-tilstand kunne ikke læses",
    };
  }
  // Vagten afviser: alle Stripe-kald er stoppet.
  return {
    navn: "Test eller live",
    tone: "roed",
    tekst: "Stripe-nøglen passer ikke til databasen",
    statusTekst: "Stripe-nøglen passer ikke til databasen - alle Stripe-kald er stoppet",
  };
}
