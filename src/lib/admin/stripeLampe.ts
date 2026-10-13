// Systemlampen "Test eller live" (lamper.ts). Ren funktion (testes i
// tests/penge-db).
//
// Samme regel som Stripe-vagten kraevSammeStripeTilstand (src/lib/stripe.ts):
// nøglens tilstand skal passe til databasens stripe_tilstand ('test' indtil
// fase 6 - også i produktionen, docs/GO-LIVE-STRIPE.md). Om Supabase-
// projektet er testdatabasen, afgør KUN teksten - aldrig om lampen er rød.
// Lampen (og dermed statuslinjen) er aldrig rød, når vagten ville godkende -
// og altid rød, når den afviser: ingen/ugyldig nøgle, nøgle mod database, og
// hemmelig mod offentlig nøgle (kraevSammeOffentligeNoegle - nye betalinger).

import type { Lampe } from "@/lib/admin/lamper";
import type { StripeTilstand } from "@/lib/stripe";

export function stripeTilstandLampe(
  noegle: StripeTilstand | null,
  db: StripeTilstand | null,
  testdatabase: boolean,
  // NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY's tilstand (null = ikke sat).
  offentlig: StripeTilstand | null = null,
): Lampe {
  // Ingen (gyldig) nøgle: vagten afviser alle Stripe-kald.
  if (!noegle) {
    return {
      navn: "Test eller live",
      tone: "roed",
      tekst: "STRIPE_SECRET_KEY mangler eller er ugyldig – alle Stripe-kald er stoppet",
      statusTekst: "STRIPE_SECRET_KEY mangler eller er ugyldig – alle Stripe-kald er stoppet",
    };
  }
  const vagtGodkender = db === noegle || (db === null && noegle === "test");
  // Hemmelig og offentlig nøgle i hver sin tilstand: nye betalinger er stoppet
  // (samme regel som kraevSammeOffentligeNoegle).
  if (vagtGodkender && offentlig && offentlig !== noegle) {
    return {
      navn: "Test eller live",
      tone: "roed",
      tekst: "den hemmelige og den offentlige Stripe-nøgle passer ikke sammen – nye betalinger er stoppet",
      statusTekst: "Stripe-nøglerne passer ikke sammen – nye betalinger er stoppet",
    };
  }
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
