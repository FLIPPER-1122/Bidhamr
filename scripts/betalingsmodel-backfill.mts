// Betalingsmodel trin 1: gør alle eksisterende sælgerkonti (betalingsprofiler.
// stripe_account_id) klar til den nye model med sikrKontoopsaetning
// (src/lib/betaling/connect.ts) og spejler de nye felter (connect_charges_
// enabled, connect_kort_aktiv, connect_betalingsmetoder, connect_udbetalings-
// plan, connect_plan_ok) i databasen.
//
// Kørsel (Node 24 kører TypeScript direkte):
//   node scripts/betalingsmodel-backfill.mts                # prøvekørsel, ændrer intet
//   node scripts/betalingsmodel-backfill.mts --udfoer       # udfør
//   node scripts/betalingsmodel-backfill.mts --env .env.local --udfoer
//   node scripts/betalingsmodel-backfill.mts --udfoer --capabilities   # se nedenfor
//
// Hvad --udfoer ÆNDRER hos Stripe (kun det, der mangler - en kørsel mere
// ændrer intet):
//   separat (i dag), uden --capabilities:
//     - business_profile.mcc 5931, hvis kontoen ingen MCC har (en anden MCC
//       ændres ikke - kun advarsel)
//     - business_profile.url (https://bidhamr.dk), hvis den mangler
//     - business_profile.product_description, hvis både den og url mangler
//     - settings.payments.statement_descriptor "BIDHAMR.DK", hvis den mangler
//     Udbetalingsindstillingerne (plan, debit_negative_balances) og
//     capabilities røres IKKE. Disse felter kræver ingen nye oplysninger fra
//     sælgeren, så overførsler/udbetalinger påvirkes ikke.
//   separat med --capabilities: også card_payments og mobilepay_payments
//     (se advarslen nedenfor).
//   destination (begge flag): det hele - capabilities, debit_negative_
//     balances = true og manuel udbetalingsplan.
//   business_type ændres aldrig (kun advarsel).
// I databasen (alle modeller): spejlet (connect_charges_enabled,
// connect_kort_aktiv, connect_betalingsmetoder, connect_udbetalingsplan,
// connect_plan_ok) for hver konto. Databasen kan først sættes til
// 'destination', når alle aktive konti er spejlet (vagt i 20261011010000).
// Rækkefølge ved skift: docs/GO-LIVE-STRIPE.md.
//
// Sikringer:
//   - Kun Stripes TESTnøgle (sk_test_/rk_test_) indtil fase 6. Live afvises.
//   - Databasens stripe_tilstand skal være 'test'.
//   - Produktionsdatabasen (lkifkrexeldimmghnsie) kræver også --produktion
//     (og Filips "ja").
//   - Manuel udbetalingsplan sættes KUN, når både STRIPE_BETALINGSMODEL og
//     databasens stripe_tilstand.betalingsmodel er 'destination' (samme regel
//     som src/lib/betaling/model.ts). Med 'separat' udbetaler Stripe stadig
//     automatisk til sælgerens bank.
//   - Nye capabilities (card_payments, mobilepay_payments) anmodes med
//     destination - med 'separat' KUN med --capabilities. Verificeret 8. okt.
//     2026: mangler kontoen oplysninger til card_payments (fx telefon,
//     nationalitet), bliver transfers og udbetalinger STRAKS inaktive
//     (requirements.past_due), indtil sælgeren har gjort onboardingen færdig.
//   - Nøgler skrives aldrig ud.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type * as ConnectModul from "../src/lib/betaling/connect";

const PRODUKTION = "lkifkrexeldimmghnsie";
const rod = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const udfoer = args.includes("--udfoer");
const envFil = args.includes("--env") ? args[args.indexOf("--env") + 1] : ".env.local";

function stop(tekst: string): never {
  console.error(tekst);
  process.exit(1);
}

// Miljøvariabler fra env-filen (overskriver ikke allerede satte).
for (const linje of readFileSync(path.resolve(rod, envFil), "utf8").split(/\r?\n/)) {
  const m = linje.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const noegle = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_test_/.test(noegle)) stop("Kun Stripes testnøgle er tilladt (STRIPE_SECRET_KEY skal starte med sk_test_).");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const dbNoegle = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!url || !dbNoegle) stop("NEXT_PUBLIC_SUPABASE_URL eller SUPABASE_SERVICE_ROLE_KEY mangler.");
const ref = new URL(url).hostname.split(".")[0];
if (ref === PRODUKTION && !args.includes("--produktion")) {
  stop("Det er PRODUKTIONSDATABASEN. Kræver --produktion (og Filips udtrykkelige ja).");
}

// Samme API-version som serveren (src/lib/stripe.ts).
const apiVersion = readFileSync(path.resolve(rod, "src/lib/stripe.ts"), "utf8").match(
  /STRIPE_API_VERSION = "([^"]+)"/,
)?.[1];
if (!apiVersion) stop("STRIPE_API_VERSION blev ikke fundet i src/lib/stripe.ts.");

const stripe = new Stripe(noegle, { apiVersion: apiVersion as typeof import("../src/lib/stripe").STRIPE_API_VERSION });
const db = createClient(url, dbNoegle, { auth: { persistSession: false, autoRefreshToken: false } });
const { sikrKontoopsaetning, kontoSpejl } = (await import(
  pathToFileURL(path.resolve(rod, "src/lib/betaling/connect.ts")).href
)) as typeof ConnectModul;

const { data: tilstand, error: tFejl } = await db
  .from("stripe_tilstand")
  .select("tilstand, betalingsmodel")
  .eq("id", true)
  .maybeSingle<{ tilstand: string; betalingsmodel: string }>();
if (tFejl || !tilstand) stop(`stripe_tilstand kunne ikke læses (er migrationen 20261011010000 kørt?): ${tFejl?.message ?? "ingen række"}`);
if (tilstand.tilstand !== "test") stop(`Databasens Stripe-tilstand er '${tilstand.tilstand}', ikke 'test'.`);
const manuelPlan =
  (process.env.STRIPE_BETALINGSMODEL ?? "").trim().toLowerCase() === "destination" &&
  tilstand.betalingsmodel === "destination";

console.log(
  `Database: ${ref}  Stripe: test  Betalingsmodel: ${manuelPlan ? "destination (manuel plan)" : "separat (planen røres ikke)"}  ${udfoer ? "UDFØRER" : "PRØVEKØRSEL"}`,
);

const { data: profiler, error: pFejl } = await db
  .from("betalingsprofiler")
  .select("user_id, stripe_account_id, connect_frakoblet_kl")
  .not("stripe_account_id", "is", null);
if (pFejl) stop(`betalingsprofiler: ${pFejl.message}`);
const brugerIds = (profiler ?? []).map((p) => p.user_id as string);
const { data: brugere } = brugerIds.length
  ? await db.from("users").select("id, konto_type").in("id", brugerIds)
  : { data: [] as { id: string; konto_type: string | null }[] };
const kontoType = new Map((brugere ?? []).map((u) => [u.id as string, u.konto_type as string | null]));

let ok = 0;
let fejl = 0;
for (const p of profiler ?? []) {
  const acct = p.stripe_account_id as string;
  if (p.connect_frakoblet_kl) {
    console.log(`- ${acct}: frakoblet - springes over`);
    continue;
  }
  try {
    const r = await sikrKontoopsaetning(stripe, acct, {
      erFirma: kontoType.get(p.user_id as string) === "erhverv",
      manuelPlan,
      capabilities: manuelPlan || args.includes("--capabilities"),
      url: "https://bidhamr.dk",
      kunVis: !udfoer,
    });
    const s = kontoSpejl(r.konto);
    console.log(
      `- ${acct}: ${r.aendret.length ? (udfoer ? "ændret: " : "vil ændre: ") + r.aendret.join(", ") : "intet at ændre"}` +
        (r.advarsler.length ? `\n    advarsler: ${r.advarsler.join("; ")}` : "") +
        `\n    capabilities: ${JSON.stringify(r.konto.capabilities ?? {})}` +
        `\n    charges_enabled=${r.konto.charges_enabled} payouts_enabled=${r.konto.payouts_enabled} plan=${s.connect_udbetalingsplan}` +
        `\n    currently_due: ${JSON.stringify(r.konto.requirements?.currently_due ?? [])}` +
        `  eventually_due: ${JSON.stringify(r.konto.requirements?.eventually_due ?? [])}` +
        (r.konto.requirements?.disabled_reason ? `  disabled_reason: ${r.konto.requirements.disabled_reason}` : ""),
    );
    if (udfoer) {
      const { error } = await db
        .from("betalingsprofiler")
        .update({ ...s, opdateret: new Date().toISOString() })
        .eq("user_id", p.user_id);
      if (error) throw new Error(`spejl i databasen: ${error.message}`);
    }
    ok++;
  } catch (err) {
    fejl++;
    // Stripes fejltekster kan indeholde en maskeret nøgle - skrives aldrig ud.
    const tekst = String((err as Error)?.message ?? err).replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, "<nøgle>");
    console.log(`- ${acct}: FEJL ${tekst}`);
  }
}
console.log(`Færdig: ${ok} ok, ${fejl} fejl.`);
process.exit(fejl ? 1 : 0);
