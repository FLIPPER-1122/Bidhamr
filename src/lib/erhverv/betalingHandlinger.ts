import "server-only";
import { createClient } from "@/lib/supabase/server";
import { hentLoggetIndBruger } from "@/lib/hentBruger";
import { FOR_MANGE_FORSOEG, indenForGraense } from "@/lib/rateLimit";
import { logDriftFejl } from "@/lib/drift";
import { portalLink, startBetaling, type LinkSvar } from "@/lib/erhverv/betaling";
import { FIRMA_BETALING } from "@/lib/tekster/erhverv";

// Firmaets betalingsknapper i Firma oversigt -> Abonnement. Kaldes KUN fra
// /api/offentlig/[handling] (firma-betal, firma-betalingskort) - ikke som
// server actions, fordi firmakonti før lancering ikke må kalde server
// actions (se src/lib/supabase/middleware.ts). Route handleren har allerede
// tjekket Origin og kroppens størrelse; her tjekkes login og rate limit.
// Firmaet findes ud fra den indloggede bruger (aldrig fra et felt i kroppen).
// base = sidens egen adresse (den kontrollerede Origin), så Stripe sender
// firmaet tilbage til samme vært.

async function medFirma(navn: string, fn: (brugerId: string) => Promise<LinkSvar>): Promise<LinkSvar> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await hentLoggetIndBruger(supabase);
  if (!user) return { fejl: "Du skal være logget ind.", kode: "ikke_logget_ind" };
  if (!(await indenForGraense("firma_stripe_link", user.id))) return { fejl: FOR_MANGE_FORSOEG, kode: "for_mange" };
  try {
    return await fn(user.id);
  } catch (err) {
    await logDriftFejl({ kilde: "action", hvor: navn, fejl: err, brugerId: user.id });
    return { fejl: FIRMA_BETALING.fejl, kode: "fejl" };
  }
}

export function betalForPakke(base: string): Promise<LinkSvar> {
  return medFirma("erhverv/betalForPakke", (brugerId) => startBetaling(brugerId, base));
}

export function skiftBetalingskort(base: string): Promise<LinkSvar> {
  return medFirma("erhverv/skiftBetalingskort", (brugerId) => portalLink(brugerId, base));
}
