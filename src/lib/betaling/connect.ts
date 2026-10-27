// Opsætning af sælgerens Stripe Connect Express-konto (betalingsmodel
// destination, docs/BETALINGSMODEL-PLAN.md 1.1).
//
// Rene funktioner uden import af server-moduler: Stripe-klienten gives med,
// så backfill-scriptet (scripts/betalingsmodel-backfill.mts) kan bruge samme
// kode som serveren. Serveren giver altid getStripe() (med tilstandsvagten).
//
// Verificeret i Stripes testmiljø 8. okt. 2026 (API 2026-05-27.dahlia, DK
// Express): card_payments, transfers og mobilepay_payments kan anmodes om;
// MCC 5931 (brugte varer) accepteres; settings.payouts.schedule.interval =
// 'manual' og debit_negative_balances accepteres; statement descriptor
// "BIDHAMR.DK" accepteres (og er allerede standard på eksisterende konti).
// business_type ændres aldrig på en eksisterende konto - kun meldt.
//
// Den gamle model (separate charges and transfers) er fjernet (trin 5): alle
// konti sættes op til betaling på sælgerens vegne med manuel udbetalingsplan
// - BidHamr udbetaler først, når handlen er helt færdig.

import type Stripe from "stripe";

export const BIDHAMR_MCC = "5931"; // Used Merchandise and Secondhand Stores
export const BIDHAMR_STATEMENT_DESCRIPTOR = "BIDHAMR.DK";
// Betalingsmetoder på sælgerens konto (destination charges med on_behalf_of
// kræver, at metoden er aktiv på den forbundne konto). Svarer til
// betalingsmetoder.ts (kort, MobilePay, Revolut Pay - Filip 20. okt. 2026).
// revolut_pay_payments: verificeret 20. okt. 2026 i testmiljøet, at en DK
// Express-konto kan anmode om den (ingen ekstra oplysningskrav ifølge
// docs.stripe.com/connect/account-capabilities). Er den ikke aktiv på en
// sælgers konto, udelades Revolut Pay blot i sælgerens checkout
// (saelgerMetoder).
export const KONTO_CAPABILITIES = [
  "card_payments",
  "transfers",
  "mobilepay_payments",
  "revolut_pay_payments",
] as const;

export function produktbeskrivelse(erFirma: boolean): string {
  return erFirma ? "Salg af brugte ting på BidHamr" : "Privat salg af brugte ting på BidHamr";
}

// Firmaets oplysninger fra firmaer-rækken (BidHamr har allerede tjekket dem
// ved oprettelsen af firmakontoen), som forudfyldes på Stripe-kontoen, så
// butiksejeren ikke skal taste dem igen i Stripes onboarding.
export type FirmaForudfyld = {
  firmanavn: string;
  cvr: string;
  adresse: string;
  postnummer: string;
  bynavn: string;
  telefon: string;
  kontaktEmail: string;
};

// Telefonnummer i det format, Stripe kræver (E.164, fx +4512345678). Et
// dansk nummer med 8 cifre får +45 foran; "00" foran bliver til "+". Kan
// nummeret ikke laves om med sikkerhed, udelades det (null) - så spørger
// Stripe selv i onboardingen i stedet for at afvise hele kontoen.
export function stripeTelefon(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!/^\+?[0-9][0-9 \-]*$/.test(s)) return null;
  const cifre = s.replace(/[^0-9]/g, "");
  let e164: string;
  if (s.startsWith("+")) e164 = `+${cifre}`;
  else if (cifre.startsWith("00")) e164 = `+${cifre.slice(2)}`;
  else if (cifre.length === 8) e164 = `+45${cifre}`;
  else return null;
  // Danske numre: præcis 8 cifre efter +45. Udenlandske: E.164 (8-15 cifre).
  if (e164.startsWith("+45")) return /^\+45[0-9]{8}$/.test(e164) ? e164 : null;
  return /^\+[1-9][0-9]{7,14}$/.test(e164) ? e164 : null;
}

const EMAIL_ENKEL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Felterne, der forudfyldes for en firmakonto. Verificeret i Stripes
// testmiljø 27. okt. 2026 (DK Express, business_type company): company.name,
// company.tax_id (CVR som 8 cifre uden "DK"), company.phone (E.164) og
// company.address accepteres og forsvinder fra requirements.currently_due;
// business_profile.name/support_email/support_phone gemmes. Stripe beder så
// kun om repræsentant, ejere, bankkonto og accept af vilkår.
// Kun ved OPRETTELSE: efter det første onboarding-link kan platformen ikke
// længere ændre en Express-kontos KYC-oplysninger (docs.stripe.com/connect/
// express-accounts, "Before creating the first account link ... prefill").
// Kun felter, der med sikkerhed er gyldige, sendes med - resten spørger Stripe
// selv om.
export function firmaForudfyldning(f: FirmaForudfyld): {
  company: Stripe.AccountCreateParams.Company;
  business_profile: Pick<Stripe.AccountCreateParams.BusinessProfile, "name" | "support_email" | "support_phone">;
} {
  const navn = f.firmanavn.trim().slice(0, 200);
  const telefon = stripeTelefon(f.telefon);
  const email = f.kontaktEmail.trim().toLowerCase();
  const company: Stripe.AccountCreateParams.Company = {};
  if (navn) company.name = navn;
  if (/^[0-9]{8}$/.test(f.cvr)) company.tax_id = f.cvr;
  if (telefon) company.phone = telefon;
  const linje1 = f.adresse.trim().slice(0, 200);
  const by = f.bynavn.trim().slice(0, 100);
  if (linje1 && by && /^[0-9]{4}$/.test(f.postnummer)) {
    company.address = { line1: linje1, postal_code: f.postnummer, city: by, country: "DK" };
  }
  const bp: Pick<Stripe.AccountCreateParams.BusinessProfile, "name" | "support_email" | "support_phone"> = {};
  if (navn) bp.name = navn;
  if (EMAIL_ENKEL.test(email) && email.length <= 254) bp.support_email = email;
  if (telefon) bp.support_phone = telefon;
  return { company, business_profile: bp };
}

// Parametre til accounts.create for en ny sælgerkonto: card_payments +
// transfers + mobilepay_payments + revolut_pay_payments, business_type 'company' for firmaer, manuel
// udbetalingsplan og debit_negative_balances, MCC, url, beskrivelse og
// statement descriptor. Firmaer (firma givet): firmanavn, CVR, adresse,
// telefon og kontakt-e-mail forudfyldes (firmaForudfyldning). Private
// brugere er uændrede.
export function nyKontoParametre(o: {
  userId: string;
  email?: string;
  erFirma: boolean;
  url: string;
  firma?: FirmaForudfyld | null;
}): Stripe.AccountCreateParams {
  const forudfyld = o.erFirma && o.firma ? firmaForudfyldning(o.firma) : null;
  return {
    type: "express",
    country: "DK",
    email: o.email,
    business_type: o.erFirma ? "company" : "individual",
    capabilities: Object.fromEntries(
      KONTO_CAPABILITIES.map((c) => [c, { requested: true }]),
    ) as Stripe.AccountCreateParams.Capabilities,
    business_profile: {
      mcc: BIDHAMR_MCC,
      product_description: produktbeskrivelse(o.erFirma),
      // Stripe afviser http- og localhost-adresser som virksomheds-URL.
      url: o.url,
      ...(forudfyld?.business_profile ?? {}),
    },
    ...(forudfyld && Object.keys(forudfyld.company).length ? { company: forudfyld.company } : {}),
    settings: {
      payments: { statement_descriptor: BIDHAMR_STATEMENT_DESCRIPTOR },
      payouts: { debit_negative_balances: true, schedule: { interval: "manual" } },
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

// Gør en eksisterende sælgerkonto klar. Idempotent: kun det, der mangler,
// sendes til Stripe; intet kald, hvis kontoen allerede er sat op.
//   - anmoder om card_payments, transfers, mobilepay_payments og revolut_pay_payments. Verificeret
//     8. okt. 2026: mangler kontoen oplysninger til card_payments (fx telefon,
//     nationalitet), bliver transfers og udbetalinger inaktive, indtil
//     sælgeren har gjort onboardingen færdig (betalinger venter imens).
//   - business_profile: MCC, url og beskrivelse, hvis de mangler (en MCC, som
//     sælgeren selv har valgt i onboarding, overskrives ikke - kun meldt)
//   - statement descriptor, hvis den mangler
//   - debit_negative_balances og manuel udbetalingsplan
//   - business_type ændres aldrig (meldes, hvis den ikke passer til kontotypen)
export async function sikrKontoopsaetning(
  stripe: Stripe,
  kontoId: string,
  // kunVis: beregn ændringerne uden at sende dem til Stripe (prøvekørsel).
  o: { erFirma: boolean; url: string; kunVis?: boolean },
): Promise<KontoOpsaetningResultat> {
  const konto = await stripe.accounts.retrieve(kontoId);
  const aendret: string[] = [];
  const advarsler: string[] = [];
  const params: Stripe.AccountUpdateParams = {};

  const caps: Record<string, { requested: true }> = {};
  for (const c of KONTO_CAPABILITIES) {
    if (!(konto.capabilities as Record<string, string | undefined> | undefined)?.[c]) {
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
  if (konto.settings?.payouts?.debit_negative_balances === false) {
    payouts.debit_negative_balances = true;
    aendret.push("debit_negative_balances");
  }
  const interval = konto.settings?.payouts?.schedule?.interval;
  if (interval !== "manual") {
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
