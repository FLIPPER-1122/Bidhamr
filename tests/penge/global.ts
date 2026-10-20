// Kører én gang før alle pengetestene (vitest globalSetup):
//   1. Vagter: testdatabasen, Stripes testnøgle, stripe_tilstand = test og
//      betalingsmodel = destination.
//   2. Pengetestenes faste TEST-brugere (oprettes første gang; slettes aldrig
//      - brugere kan ikke slettes, og seed.sql nægter at køre med over 50).
//   3. Nye Stripe Connect-testkonti til sælgerne for HVER kørsel, så saldoen
//      altid starter på 0 og ikke påvirkes af tidligere kørsler.
//
// Kun supabase-js og stripe her (globalSetup kører uden for testenes
// modulsystem).
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import type { TestProject } from "vitest/node";
import { indlaesMiljoe } from "./miljoe";
import { BRUGERE, type PengeKontekst } from "./brugere";

declare module "vitest" {
  export interface ProvidedContext {
    penge: PengeKontekst;
  }
}

const API_VERSION = "2026-05-27.dahlia" as const;

// Danske test-IBAN'er (Stripes testmiljø): den første lykkes, den anden giver
// en udbetaling, der fejler (no_account) - til payout.failed.
const IBAN_OK = "DK5000400440116243";
export const IBAN_FEJLER = "DK8003450003179681";

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function sikrBruger(admin: ReturnType<typeof db>, b: (typeof BRUGERE)[number]): Promise<void> {
  const { data: findes } = await admin.from("users").select("id").eq("id", b.id).maybeSingle();
  if (!findes) {
    const { error } = await admin.auth.admin.createUser({
      id: b.id,
      email: b.email,
      email_confirm: true,
      user_metadata: { navn: b.navn },
    } as Parameters<typeof admin.auth.admin.createUser>[0] & { id: string });
    if (error && !/already/i.test(error.message)) throw new Error(`opret ${b.email}: ${error.message}`);
  }
  const { data: version } = await admin.rpc("vilkaar_aktuel_version");
  const { error: uFejl } = await admin
    .from("users")
    .update({
      navn: b.navn,
      fornavn: b.navn.split(" ").slice(0, 2).join(" "),
      efternavn: b.navn.split(" ").slice(2).join(" ") || "Test",
      vilkaar_version: version,
      vilkaar_accepteret_kl: new Date().toISOString(),
      mitid_verificeret_kl: new Date().toISOString(),
    })
    .eq("id", b.id);
  if (uFejl) throw new Error(`users ${b.email}: ${uFejl.message}`);
  const { data: mitid } = await admin
    .from("mitid_verificeringer")
    .select("bruger_id")
    .eq("bruger_id", b.id)
    .eq("status", "aktiv")
    .maybeSingle();
  if (!mitid) {
    const { error } = await admin.from("mitid_verificeringer").insert({
      bruger_id: b.id,
      id_hash: createHash("sha256").update(`pengetest:${b.id}`).digest("hex"),
      juridisk_navn: b.navn,
      foedselsdato: "1990-01-01",
    });
    if (error) throw new Error(`mitid ${b.email}: ${error.message}`);
  }
}

async function nyKonto(stripe: Stripe, email: string, iban: string, koersel: string): Promise<string> {
  const a = await stripe.accounts.create({
    country: "DK",
    email,
    // Testkonto, som platformen selv opretter færdig via API'et (samme
    // betingelser som sælgernes Express-konti i koden: card_payments,
    // transfers, manuel plan, platformen hæfter for tab).
    controller: {
      fees: { payer: "application" },
      losses: { payments: "application" },
      requirement_collection: "application",
      stripe_dashboard: { type: "none" },
    },
    // Samme betalingsmetoder som sælgernes konti (KONTO_CAPABILITIES):
    // kort, MobilePay og Revolut Pay (Filip, 20. okt. 2026).
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
      mobilepay_payments: { requested: true },
      revolut_pay_payments: { requested: true },
    },
    business_type: "individual",
    business_profile: { mcc: "5931", url: "https://bidhamr.dk", product_description: "TEST pengetest" },
    individual: {
      first_name: "TEST",
      last_name: "Pengetest",
      email,
      phone: "+4520000000",
      dob: { day: 1, month: 1, year: 1901 },
      address: { line1: "address_full_match", city: "Koebenhavn", postal_code: "1000", country: "DK" },
    },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    external_account: { object: "bank_account", country: "DK", currency: "dkk", account_number: iban },
    settings: { payouts: { schedule: { interval: "manual" }, debit_negative_balances: true } },
    metadata: { test: "TEST pengetest", koersel },
  });
  return a.id;
}

async function ventPaaKonto(stripe: Stripe, id: string): Promise<void> {
  const slut = Date.now() + 240_000;
  for (;;) {
    const a = await stripe.accounts.retrieve(id);
    if (
      a.charges_enabled &&
      a.payouts_enabled &&
      a.capabilities?.card_payments === "active" &&
      a.capabilities?.mobilepay_payments === "active" &&
      a.capabilities?.revolut_pay_payments === "active"
    ) {
      return;
    }
    if (Date.now() > slut) throw new Error(`Stripe-testkontoen ${id} blev ikke klar (${a.requirements?.disabled_reason})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export default async function setup(project: TestProject) {
  indlaesMiljoe();
  const admin = db();
  const { data: t, error } = await admin
    .from("stripe_tilstand")
    .select("tilstand, betalingsmodel")
    .eq("id", true)
    .maybeSingle<{ tilstand: string; betalingsmodel: string }>();
  if (error || !t) throw new Error(`stripe_tilstand kan ikke læses: ${error?.message}`);
  if (t.tilstand !== "test") throw new Error("Databasens Stripe-tilstand er ikke 'test'.");
  if (t.betalingsmodel !== "destination") throw new Error("Databasens betalingsmodel er ikke 'destination'.");

  for (const b of BRUGERE) await sikrBruger(admin, b);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: API_VERSION });
  const koersel = `pt${Date.now().toString(36)}`;
  const konti: Record<string, string> = {};
  for (const b of BRUGERE.filter((x) => x.saelger)) {
    konti[b.id] = await nyKonto(stripe, b.email, b.bankFejler ? IBAN_FEJLER : IBAN_OK, koersel);
  }
  await Promise.all(Object.values(konti).map((id) => ventPaaKonto(stripe, id)));

  for (const [brugerId, konto] of Object.entries(konti)) {
    const { data: p } = await admin
      .from("betalingsprofiler")
      .select("user_id, stripe_account_id, connect_tidligere_konti")
      .eq("user_id", brugerId)
      .maybeSingle<{ user_id: string; stripe_account_id: string | null; connect_tidligere_konti: string[] | null }>();
    const tidligere = [...(p?.connect_tidligere_konti ?? [])];
    if (p?.stripe_account_id) tidligere.push(p.stripe_account_id);
    const raekke = {
      user_id: brugerId,
      stripe_account_id: konto,
      connect_tidligere_konti: tidligere.slice(-50),
      connect_frakoblet_kl: null,
      connect_udbetaling_fejlet_kl: null,
      connect_udbetaling_fejlet_bank: null,
      connect_udbetaling_fejlkode: null,
      saelger_frosset_kl: null,
      saelger_frosset_aarsag: null,
      connect_kraever_opmaerksomhed: false,
      connect_opmaerksomhed_aarsag: null,
      connect_opmaerksomhed_kl: null,
    };
    const { error: pFejl } = p
      ? await admin.from("betalingsprofiler").update(raekke).eq("user_id", brugerId)
      : await admin.from("betalingsprofiler").insert(raekke);
    if (pFejl) throw new Error(`betalingsprofil ${brugerId}: ${pFejl.message}`);
  }

  project.provide("penge", { koersel, konti });
}
