"use server";

import { createClient } from "@/lib/supabase/server";
import { FOR_MANGE_FORSOEG, klientIp, tjekGraenser } from "@/lib/rateLimit";
import { sideUrl } from "@/lib/mails/handel";

// Login, gensend bekraeftelse og nulstil adgangskode koeres paa serveren, saa
// de kan rate-limites pr. IP og pr. e-mail. Fejl RETURNERES (Next.js skjuler
// kastede fejl i produktion).
//
// BEMAERK: auth-API'et kan stadig kaldes direkte med anon-noeglen. Supabase
// Auths egne rate limits (dashboard -> Auth -> Rate Limits) er det egentlige
// vaern; dette er et ekstra lag for hjemmesiden.

type Resultat = { ok: true } | { fejl: string; kode?: "email_ikke_bekraeftet" };

const GENERISK = "Noget gik galt. Prøv igen om lidt.";

function renEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
}

export async function logInd(emailInput: string, password: string): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email || typeof password !== "string" || password.length === 0) {
    return { fejl: "Forkert email eller adgangskode." };
  }

  const ip = await klientIp();
  if (!(await tjekGraenser([["login_ip", ip], ["login_email_ip", `${email}|${ip}`]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") {
      return {
        fejl: "Din email er ikke bekræftet endnu. Tjek din indbakke.",
        kode: "email_ikke_bekraeftet",
      };
    }
    if (error.code === "invalid_credentials") {
      return { fejl: "Forkert email eller adgangskode." };
    }
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("logInd fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }
  return { ok: true };
}

export async function gensendBekraeftelse(emailInput: string): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email) return { fejl: "Indtast en gyldig email." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["gensend_ip", ip], ["nulstil_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({ type: "signup", email });
  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("gensendBekraeftelse fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }
  return { ok: true };
}

export async function nulstilAdgangskode(emailInput: string): Promise<Resultat> {
  const email = renEmail(emailInput);
  if (!email) return { fejl: "Indtast en gyldig email." };

  const ip = await klientIp();
  if (!(await tjekGraenser([["nulstil_ip", ip], ["nulstil_email", email]]))) {
    return { fejl: FOR_MANGE_FORSOEG };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: sideUrl("/auth/callback?next=/reset-password"),
  });
  if (error) {
    if (error.status === 429) return { fejl: FOR_MANGE_FORSOEG };
    console.error("nulstilAdgangskode fejlede:", error.code, error.message);
    return { fejl: GENERISK };
  }
  return { ok: true };
}
