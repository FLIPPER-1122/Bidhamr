// Betalingsmodel (destination): gør alle eksisterende sælgerkonti
// (betalingsprofiler.stripe_account_id) klar til betaling på sælgerens vegne
// med sikrKontoopsaetning (src/lib/betaling/connect.ts) og spejler de nye
// felter (connect_charges_enabled, connect_kort_aktiv, connect_betalings-
// metoder, connect_udbetalingsplan, connect_plan_ok) i databasen.
//
// Skal køres FØR 20261011050000_betalingsmodel_oprydning.sql (trin 5): den
// sætter databasen til destination, og vagten (betalingsmodel_backfill_mangler)
// afviser det, hvis en aktiv sælgerkonto ikke er spejlet. Kan køres igen når
// som helst (en kørsel mere ændrer intet). Rækkefølge: docs/GO-LIVE-STRIPE.md.
//
// Kørsel (Node 24 kører TypeScript direkte):
//   node scripts/betalingsmodel-backfill.mts                # prøvekørsel, ændrer intet
//   node scripts/betalingsmodel-backfill.mts --udfoer       # udfør
//   node scripts/betalingsmodel-backfill.mts --env .env.production.local --produktion --udfoer
//
// Hvad --udfoer ÆNDRER hos Stripe (kun det, der mangler):
//   - capabilities card_payments, transfers og mobilepay_payments
//   - debit_negative_balances = true og MANUEL udbetalingsplan (BidHamr
//     udbetaler først, når handlen er helt færdig)
//   - business_profile.mcc 5931, hvis kontoen ingen MCC har (en anden MCC
//     ændres ikke - kun advarsel), url og beskrivelse, hvis de mangler
//   - statement descriptor "BIDHAMR.DK", hvis den mangler
//   - business_type ændres aldrig (kun advarsel)
// Verificeret 8. okt. 2026: mangler en konto oplysninger til card_payments
// (fx telefon, nationalitet), bliver overførsler/udbetalinger inaktive, indtil
// sælgeren har gjort onboardingen færdig - giv sælgerne besked først.
// I databasen: spejlet for hver konto.
//
// Sikringer:
//   - Kun Stripes TESTnøgle (sk_test_/rk_test_) indtil fase 6. Live afvises.
//   - Databasens stripe_tilstand skal være 'test'.
//   - Produktionsdatabasen (lkifkrexeldimmghnsie) kræver også --produktion
//     (og Filips "ja").
//   - Nøgler skrives aldrig ud.
//   - En konto, Stripe ikke kender (fx falske testdata), giver FEJL og
//     springes over - den skal frakobles/nulstilles i databasen først.

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

console.log(
  `Database: ${ref}  Stripe: test  Databasens betalingsmodel: ${tilstand.betalingsmodel}  ${udfoer ? "UDFØRER" : "PRØVEKØRSEL"}`,
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
    const ukendt = (err as { code?: string })?.code === "resource_missing" || /No such account/i.test(tekst);
    console.log(
      `- ${acct}: FEJL ${tekst}` +
        (ukendt ? "\n    Stripe kender ikke kontoen - frakobl/nulstil den i databasen (fx admin \"Nulstil udbetalingskonto\"), før trin 5 køres." : ""),
    );
  }
}
console.log(`Færdig: ${ok} ok, ${fejl} fejl.`);
process.exit(fejl ? 1 : 0);
