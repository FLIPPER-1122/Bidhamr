// Opsætning af sælgerens Stripe Connect Express-konto (betalingsmodel trin 1,
// docs/BETALINGSMODEL-PLAN.md 1.1).
//
// Rene funktioner uden import af server-moduler: Stripe-klienten gives med,
// så backfill-scriptet (scripts/betalingsmodel-backfill.ts) kan bruge samme
// kode som serveren. Serveren giver altid getStripe() (med tilstandsvagten).
//
// Verificeret i Stripes testmiljø 8. okt. 2026 (API 2026-05-27.dahlia, DK
// Express): card_payments, transfers og mobilepay_payments kan anmodes om;
// MCC 5931 (brugte varer) accepteres; settings.payouts.schedule.interval =
// 'manual' og debit_negative_balances accepteres; statement descriptor
// "BIDHAMR.DK" accepteres (og er allerede standard på eksisterende konti).
// business_type ændres aldrig på en eksisterende konto - kun meldt.
//
// Nye konti: card_payments, mobilepay_payments, business_type 'company' og
// manuel plan KUN med destination (nyKontoParametre). I separat oprettes
// kontoen som før (kun transfers, individual).

import type Stripe from "stripe";

export const BIDHAMR_MCC = "5931"; // Used Merchandise and Secondhand Stores
export const BIDHAMR_STATEMENT_DESCRIPTOR = "BIDHAMR.DK";
// Betalingsmetoder på sælgerens konto (destination charges med on_behalf_of
// kræver, at metoden er aktiv på den forbundne konto).
export const KONTO_CAPABILITIES = ["card_payments", "transfers", "mobilepay_payments"] as const;

export function produktbeskrivelse(erFirma: boolean): string {
  return erFirma ? "Salg af brugte ting på BidHamr" : "Privat salg af brugte ting på BidHamr";
}

// Parametre til accounts.create for en ny sælgerkonto.
//
// destination (begge flag sat, src/lib/betaling/model.ts): kontoen oprettes
// klar til betaling på sælgerens vegne - card_payments + transfers +
// mobilepay_payments, business_type 'company' for firmaer, manuel
// udbetalingsplan og debit_negative_balances.
//
// separat (i dag): som før - kun transfers og business_type 'individual'.
// card_payments/mobilepay og 'company' gør onboardingen tungere (flere
// oplysninger), og forfaldne krav til dem kan gøre transfers og udbetalinger
// inaktive (verificeret 8. okt. 2026) - det rammer separat-modellen, som kun
// har brug for transfers. MCC, url, beskrivelse og statement descriptor
// sættes i begge modeller (kræver ingen ekstra oplysninger). Udbetalingsplanen
// røres ikke i separat: Stripe udbetaler automatisk til banken
// (spejlUdbetaling) - en manuel plan ville få sælgerens penge til at stå fast.
export function nyKontoParametre(o: {
  userId: string;
  email?: string;
  erFirma: boolean;
  destination: boolean;
  url: string;
}): Stripe.AccountCreateParams {
  const capabilities = o.destination ? KONTO_CAPABILITIES : (["transfers"] as const);
  return {
    type: "express",
    country: "DK",
    email: o.email,
    business_type: o.destination && o.erFirma ? "company" : "individual",
    capabilities: Object.fromEntries(
      capabilities.map((c) => [c, { requested: true }]),
    ) as Stripe.AccountCreateParams.Capabilities,
    business_profile: {
      mcc: BIDHAMR_MCC,
      product_description: produktbeskrivelse(o.destination && o.erFirma),
      // Stripe afviser http- og localhost-adresser som virksomheds-URL.
      url: o.url,
    },
    settings: {
      payments: { statement_descriptor: BIDHAMR_STATEMENT_DESCRIPTOR },
      ...(o.destination
        ? { payouts: { debit_negative_balances: true, schedule: { interval: "manual" as const } } }
        : {}),
    },
    metadata: { bruger_id: o.userId },
  };
}

export type KontoOpsaetningResultat = {
  konto: Stripe.Account;
  // Hvad der blev ændret hos Stripe (tom = intet at gøre).
  aendret: string[];
  // Afvigelser, der IKKE rettes automatisk (fx business_type, anden MCC).
  advarsler: string[];
};

// Gør en eksisterende sælgerkonto klar til den nye model.
// I separat (manuelPlan og capabilities falsk) ændres KUN MCC, url,
// product_description og statement descriptor - og kun hvis de mangler. Idempotent: kun det,
// der mangler, sendes til Stripe; intet kald, hvis kontoen allerede er sat op.
//   - anmoder om card_payments, transfers og mobilepay_payments (kun med
//     capabilities: true - se nedenfor)
//   - business_profile: MCC, url og beskrivelse, hvis de mangler (en MCC, som
//     sælgeren selv har valgt i onboarding, overskrives ikke - kun meldt)
//   - statement descriptor, hvis den mangler
//   - debit_negative_balances og manuel udbetalingsplan - KUN når manuelPlan
//     er sand (destination). I separat røres udbetalingsindstillingerne ikke.
//   - business_type ændres aldrig (meldes, hvis den ikke passer til kontotypen)
export async function sikrKontoopsaetning(
  stripe: Stripe,
  kontoId: string,
  // kunVis: beregn ændringerne uden at sende dem til Stripe (prøvekørsel).
  // capabilities: anmod om manglende capabilities. PAS PÅ i den nuværende
  // model (separat): verificeret i testmiljøet 8. okt. 2026 - en ny
  // capability (card_payments) på en eksisterende konto, der mangler
  // oplysninger (fx individual.phone/nationality), gør STRAKS transfers og
  // udbetalinger inaktive (disabled_reason requirements.past_due), indtil
  // sælgeren har gjort onboardingen færdig. Derfor kun med destination eller
  // bevidst (backfill --capabilities).
  o: { erFirma: boolean; manuelPlan: boolean; url: string; kunVis?: boolean; capabilities: boolean },
): Promise<KontoOpsaetningResultat> {
  const konto = await stripe.accounts.retrieve(kontoId);
  const aendret: string[] = [];
  const advarsler: string[] = [];
  const params: Stripe.AccountUpdateParams = {};

  const caps: Record<string, { requested: true }> = {};
  for (const c of KONTO_CAPABILITIES) {
    if (!(konto.capabilities as Record<string, string | undefined> | undefined)?.[c]) {
      if (!o.capabilities) {
        advarsler.push(`capability ${c} mangler - ikke anmodet`);
        continue;
      }
      caps[c] = { requested: true };
      aendret.push(`capability ${c}`);
    }
  }
  if (Object.keys(caps).length) params.capabilities = caps as Stripe.AccountUpdateParams.Capabilities;

  const bp: Stripe.AccountUpdateParams.BusinessProfile = {};
  if (!konto.business_profile?.mcc) {
    bp.mcc = BIDHAMR_MCC;
    aendret.push(`mcc ${BIDHAMR_MCC}`);
  } else if (konto.business_profile.mcc !== BIDHAMR_MCC) {
    advarsler.push(`MCC er ${konto.business_profile.mcc} (ikke ${BIDHAMR_MCC}) - ikke ændret`);
  }
  if (!konto.business_profile?.url) {
    bp.url = o.url;
    aendret.push("url");
  }
  // Stripe bruger url ELLER beskrivelse. Verificeret i testmiljøet: på en
  // eksisterende konto med url gemmes beskrivelsen ikke (feltet forbliver
  // tomt) - derfor kun, når begge mangler (ellers ville hver kørsel ændre).
  if (!konto.business_profile?.product_description && !konto.business_profile?.url) {
    bp.product_description = produktbeskrivelse(o.erFirma);
    aendret.push("product_description");
  }
  if (Object.keys(bp).length) params.business_profile = bp;

  const settings: Stripe.AccountUpdateParams.Settings = {};
  const payouts: Stripe.AccountUpdateParams.Settings.Payouts = {};
  // debit_negative_balances kun med destination (manuelPlan) - i separat
  // røres udbetalingsindstillingerne slet ikke.
  if (o.manuelPlan && konto.settings?.payouts?.debit_negative_balances === false) {
    payouts.debit_negative_balances = true;
    aendret.push("debit_negative_balances");
  }
  const interval = konto.settings?.payouts?.schedule?.interval;
  if (o.manuelPlan && interval !== "manual") {
    payouts.schedule = { interval: "manual" };
    aendret.push(`udbetalingsplan ${interval ?? "?"} -> manual`);
  }
  if (Object.keys(payouts).length) settings.payouts = payouts;
  if (!konto.settings?.payments?.statement_descriptor) {
    settings.payments = { statement_descriptor: BIDHAMR_STATEMENT_DESCRIPTOR };
    aendret.push("statement_descriptor");
  }
  if (Object.keys(settings).length) params.settings = settings;

  const oensket = o.erFirma ? "company" : "individual";
  if (konto.business_type && konto.business_type !== oensket) {
    advarsler.push(`business_type er ${konto.business_type}, kontotypen svarer til ${oensket} - ikke ændret`);
  }

  if (!aendret.length || o.kunVis) return { konto, aendret, advarsler };
  const opdateret = await stripe.accounts.update(kontoId, params);
  return { konto: opdateret, aendret, advarsler };
}

// Det, der spejles til betalingsprofiler (20261011010000).
export type KontoSpejl = {
  connect_charges_enabled: boolean;
  connect_kort_aktiv: boolean;
  connect_betalingsmetoder: Record<string, string>;
  connect_udbetalingsplan: string | null;
  connect_plan_ok: boolean;
};

export function kontoSpejl(konto: Stripe.Account): KontoSpejl {
  const caps = (konto.capabilities ?? {}) as Record<string, string | undefined>;
  const metoder: Record<string, string> = {};
  for (const [navn, status] of Object.entries(caps)) {
    if (navn.endsWith("_payments") && status) metoder[navn] = status;
  }
  const interval = konto.settings?.payouts?.schedule?.interval ?? null;
  return {
    connect_charges_enabled: !!konto.charges_enabled,
    connect_kort_aktiv: caps.card_payments === "active",
    connect_betalingsmetoder: metoder,
    connect_udbetalingsplan: interval,
    connect_plan_ok: interval === "manual",
  };
}
