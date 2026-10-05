import "server-only";

// Drift-logning til /admin/drift (tabellen drift_fejl, se migration
// 20261005060000_admin_drift.sql). Kun server-kode.
//
// Regler:
// - Kaster ALDRIG. En fejl i logningen må ikke ændre det, der blev logget.
// - Ingen personfølsomme data eller hemmeligheder: teksten renses for
//   e-mails, telefonnumre/CPR, nøgler og tokens, og stier gemmes uden
//   query-streng. Databasen afkorter og dedupper.
import { createAdminClient } from "@/lib/supabase/admin";

export type DriftKilde = "klient" | "server" | "action" | "cron" | "webhook" | "notifikation";

// Renser en fejltekst, så den kan gemmes. Bruges også af cron-loggen og
// notifikationsstatus.
export function renFejltekst(err: unknown, maks = 1000): string {
  let t: string;
  if (err instanceof Error) {
    t = err.message || err.name;
  } else if (typeof err === "string") {
    t = err;
  } else if (err && typeof err === "object" && "message" in err) {
    t = String((err as { message: unknown }).message);
  } else {
    try {
      t = JSON.stringify(err) ?? String(err);
    } catch {
      t = String(err);
    }
  }
  return (
    t
      // Nøgler og tokens (Stripe, Resend, webhook, JWT, Bearer, Expo).
      .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "[nøgle]")
      .replace(/\bwhsec_[A-Za-z0-9]+/g, "[nøgle]")
      .replace(/\bre_[A-Za-z0-9_]{16,}/g, "[nøgle]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
      .replace(/Expo(nent)?PushToken\[[^\]]*\]/g, "[push-token]")
      // Stripe client secrets (pi_..._secret_...).
      .replace(/\b(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, "[client-secret]")
      // Persondata.
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
      .replace(/\b\d{6}-?\d{4}\b/g, "[cpr]")
      .replace(/(\+45\s?)?\b\d{2}\s?\d{2}\s?\d{2}\s?\d{2}\b/g, "[tlf]")
      // Postgres-detaljer med værdier: Key (email)=(x) / Failing row contains (...).
      .replace(/=\([^)]*\)/g, "=(…)")
      .replace(/Failing row contains \(.*\)/g, "Failing row contains (…)")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maks) || "(ingen besked)"
  );
}

// Kun stien - aldrig query-streng eller hash (kan indeholde tokens, fx
// nulstillingslinks). E-mails i stien maskeres.
export function renSti(sti: unknown): string | null {
  if (typeof sti !== "string" || sti.length === 0) return null;
  let s = sti;
  try {
    // Fuld URL -> kun pathname.
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname;
  } catch {
    return null;
  }
  s = s.split(/[?#]/)[0];
  return renFejltekst(s, 300).replace(/\s/g, "") || null;
}

export type DriftFejlInput = {
  kilde: DriftKilde;
  sti?: string | null;
  // Rå fejl eller tekst - renses her.
  fejl: unknown;
  // Valgfrit præfiks, fx "startBetaling", så samme fejl fra to steder kan skelnes.
  hvor?: string;
  digest?: string | null;
  brugerId?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gemmer en fejl i drift_fejl. Kaster aldrig. Returnerer databasens svar
// ('ny' | 'dublet' | 'begraenset') eller null ved fejl.
export async function logDriftFejl(input: DriftFejlInput): Promise<string | null> {
  try {
    const tekst = renFejltekst(input.fejl, 900);
    const besked = input.hvor ? `${renFejltekst(input.hvor, 80)}: ${tekst}` : tekst;
    const digest =
      typeof input.digest === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(input.digest)
        ? input.digest
        : null;
    const brugerId =
      typeof input.brugerId === "string" && UUID.test(input.brugerId) ? input.brugerId : null;
    const { data, error } = await createAdminClient().rpc("drift_fejl_log", {
      p_kilde: input.kilde,
      p_sti: renSti(input.sti ?? null),
      p_besked: besked,
      p_digest: digest,
      p_bruger_id: brugerId,
    });
    if (error) {
      console.error("Drift: fejl kunne ikke logges:", error.message);
      return null;
    }
    return typeof data === "string" ? data : null;
  } catch (err) {
    console.error("Drift: logning kastede:", err);
    return null;
  }
}

// Maskerer en e-mail til visning i admin: "jeppe@gmail.com" -> "j***@g***.com".
export function maskerEmail(email: string | null | undefined): string {
  if (!email) return "—";
  const [lokal, domaene] = email.split("@");
  if (!domaene) return "***";
  const punkt = domaene.lastIndexOf(".");
  const navn = punkt > 0 ? domaene.slice(0, punkt) : domaene;
  const tld = punkt > 0 ? domaene.slice(punkt) : "";
  return `${lokal.slice(0, 1)}***@${navn.slice(0, 1)}***${tld}`;
}
