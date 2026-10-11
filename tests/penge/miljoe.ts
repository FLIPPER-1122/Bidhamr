// Miljøet for pengetestene. Indlæser env-filen (standard .env.local - den
// samme som `npm run dev`, dvs. TESTdatabasen) og nægter at køre mod andet end
// testdatabasen og Stripes testmiljø.
//
// PENGE_ENV_FIL kan pege på en anden env-fil (fx fra en git worktree, der ikke
// har sin egen .env.local).
import { readFileSync } from "node:fs";
import path from "node:path";

export const TEST_DB_HOST = "pjiigmzqwlfepxnjdvug.supabase.co";
const PRODUKTION_REF = "lkifkrexeldimmghnsie";

function stop(tekst: string): never {
  throw new Error(`Pengetestene stoppet: ${tekst}`);
}

export function indlaesMiljoe(): void {
  const fil = path.resolve(process.cwd(), process.env.PENGE_ENV_FIL ?? ".env.local");
  let indhold: string;
  try {
    indhold = readFileSync(fil, "utf8");
  } catch {
    stop(`env-filen ${fil} findes ikke (sæt PENGE_ENV_FIL).`);
  }
  for (const linje of indhold.split(/\r?\n/)) {
    const m = linje.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (url.includes(PRODUKTION_REF)) stop("env-filen peger på PRODUKTIONSDATABASEN.");
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    stop("NEXT_PUBLIC_SUPABASE_URL mangler eller er ugyldig.");
  }
  if (host !== TEST_DB_HOST) stop(`kun testdatabasen (${TEST_DB_HOST}) er tilladt, ikke ${host}.`);
  if (!/^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY ?? "")) {
    stop("STRIPE_SECRET_KEY skal være en TESTnøgle (sk_test_).");
  }
  const pk = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (pk && !pk.startsWith("pk_test_")) stop("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY skal være en testnøgle.");
  if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    stop("SUPABASE_SERVICE_ROLE_KEY mangler.");
  }

  // Ingen rigtige mails, ingen eksterne tjenester, ingen ekstern heartbeat.
  for (const k of [
    "MAIL_TEST_MODTAGER",
    "RESEND_API_KEY",
    "HEARTBEAT_URL",
    "CRON_HEALTHCHECK_URL",
    "DRIFT_ALARM_MAIL",
    "DINERO_CLIENT_ID",
    "DINERO_CLIENT_SECRET",
    "DINERO_API_KEY",
    "DINERO_ORG_ID",
    "SHIPMONDO_API_BRUGER",
    "SHIPMONDO_API_NOEGLE",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    // Ingen rigtige push-beskeder (Expo) fra testene.
    "EXPO_ACCESS_TOKEN",
  ]) {
    delete process.env[k];
  }
}
