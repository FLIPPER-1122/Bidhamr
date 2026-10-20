// Betalingsmetoder (Filip, 20. okt. 2026): BidHamr tilbyder KUN kort (inkl.
// Apple Pay og Google Pay, som er wallets på kort), MobilePay og Revolut Pay.
// Ikke Klarna, ikke Link (Stripes "gem mine oplysninger") og intet andet,
// Stripe slår til senere. Listen her er den ENESTE kilde - alle
// PaymentIntents (checkout, boost, returfragt) og SetupIntenten (gem kort)
// bruger den. Den må ikke afhænge af Stripe-dashboardet.
//
// Valget: eksplicit payment_method_types (ikke automatic_payment_methods og
// ikke en payment_method_configuration):
//   - automatic_payment_methods viser alt, der er slået til i dashboardet
//     (verificeret 20. okt. 2026 i testmiljøet: card, klarna, link, mobilepay).
//   - en payment_method_configuration kan ændres i dashboardet igen, og ved
//     destination charges med on_behalf_of gælder sælgerkontoens
//     konfiguration - det er netop den afhængighed, vi vil af med.
//   - payment_method_types virker med destination charges (on_behalf_of +
//     transfer_data + application_fee_amount), DKK og
//     payment_method_options.card.request_three_d_secure = 'any' (verificeret
//     i testmiljøet 20. okt. 2026, API 2026-05-27.dahlia). Koden bruger ingen
//     capture_method (automatisk); MobilePay og Revolut Pay understøtter
//     også manuel capture (docs.stripe.com/payments/mobilepay,
//     /payments/revolut-pay).
//   - Stripe tillader ikke at skifte en eksisterende PaymentIntent fra
//     automatic_payment_methods til payment_method_types ("You cannot provide
//     both ..."): en åben, gammel PaymentIntent annulleres og laves om med en
//     ny idempotency key (pi_forsoeg + 1) - se metodeHandling().
//
// Ingen server-only-import: filen bruges også af klientkomponenterne
// (Payment Element-indstillingerne) og af enhedstestene.

import type Stripe from "stripe";

export const BETALINGSMETODER = ["card", "mobilepay", "revolut_pay"] as const;
export type Betalingsmetode = (typeof BETALINGSMETODER)[number];

// Gem kort (SetupIntent): kun kort. Apple Pay/Google Pay gemmes som kort;
// MobilePay og Revolut Pay kan ikke gemmes som standardmetode hos BidHamr.
export const GEM_KORT_METODER = ["card"] as const;

// Metoder, der aldrig må tilbydes - bruges af tests og sikkerhedstjek.
export const FORBUDTE_METODER = ["link", "klarna"] as const;

// Destination charges med on_behalf_of kræver, at metodens capability er
// aktiv på sælgerens Connect-konto (docs.stripe.com/connect/
// account-capabilities: "To enable connected accounts to accept a payment
// method for direct charges or charges with on_behalf_of, you must request
// that payment method's capability"). Sandkassen håndhæver det ikke altid,
// live gør - så en metode, hvis capability ikke er aktiv, udelades for netop
// den sælger (kort er altid med; uden aktiv card_payments åbner betalingen
// slet ikke - kontrollerSaelgerkonto).
export const METODE_CAPABILITY: Record<Betalingsmetode, string> = {
  card: "card_payments",
  mobilepay: "mobilepay_payments",
  revolut_pay: "revolut_pay_payments",
};

// Hele listen (fx til tests og forklaringer). Betaling til BidHamrs
// platformskonto bruger platformMetoderFra (via hentPlatformMetoder i
// platformMetoder.ts), så en metode, der ikke er slået til hos Stripe i live,
// aldrig får boost og returfragt til at fejle helt.
export function platformMetoder(): Betalingsmetode[] {
  return [...BETALINGSMETODER];
}

// Platformens egne metoder ud fra dens standard-konfiguration hos Stripe
// (paymentMethodConfigurations, is_default). Platformskontoen har ingen
// capabilities i accounts.retrieve() (verificeret 20. okt. 2026: tom), men
// konfigurationen har pr. metode `available` - om metoden kan tilbydes (slået
// til og aktiv). Kort er altid med. Konfigurationen kan kun FJERNE metoder fra
// listen - aldrig tilføje (Klarna, Link osv. vises aldrig, selv om de står til).
export function platformMetoderFra(
  konfiguration: Partial<Record<string, { available?: boolean | null } | null | undefined>> | null | undefined,
): Betalingsmetode[] {
  return BETALINGSMETODER.filter((m) => m === "card" || konfiguration?.[m]?.available === true);
}

// Destination charge på sælgerens vegne: kun metoder, hvis capability er
// aktiv på sælgerens konto. Kort er altid med (kontotjekket kræver
// card_payments aktiv). Rækkefølgen følger BETALINGSMETODER.
export function saelgerMetoder(
  capabilities: Partial<Record<string, string | undefined>> | null | undefined,
): Betalingsmetode[] {
  return BETALINGSMETODER.filter((m) => m === "card" || capabilities?.[METODE_CAPABILITY[m]] === "active");
}

// Del af idempotency key'en for en ny PaymentIntent: samme metoder giver
// samme nøgle; en anden liste (eller den gamle automatic_payment_methods,
// som aldrig havde denne del) giver en ny nøgle i stedet for Stripes
// idempotensfejl.
export function metodeNoegle(metoder: readonly string[]): string {
  return `m-${[...metoder].sort().join(".")}`;
}

// Tekst til brugeren ud fra de metoder, der faktisk tilbydes (fx
// "kort, MobilePay, Apple Pay og Google Pay"). Kort er altid med.
export function metodeTekst(metoder: readonly string[] | null | undefined): string {
  const navne = ["kort"];
  if (metoder?.includes("mobilepay")) navne.push("MobilePay");
  if (metoder?.includes("revolut_pay")) navne.push("Revolut Pay");
  navne.push("Apple Pay", "Google Pay");
  return `${navne.slice(0, -1).join(", ")} og ${navne[navne.length - 1]}`;
}

export function erTilladtMetode(type: string | null | undefined): type is Betalingsmetode {
  return !!type && (BETALINGSMETODER as readonly string[]).includes(type);
}

// Samme metoder (uanset rækkefølge)?
export function sammeMetoder(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Hvad skal der ske med en eksisterende PaymentIntent, før den gives videre?
//   'ok'        metoderne passer (eller den er ikke længere åben - kalderen
//               spejler den som før)
//   'annuller'  åben og lavet med automatic_payment_methods (fra før 20. okt.
//               2026): kan ikke opdateres til en eksplicit liste - annullér
//               den hos Stripe og lav en ny (ny nøgle via pi_forsoeg + 1)
//   'opdater'   requires_payment_method/requires_confirmation, eksplicit
//               liste, men en anden end den tilladte (fx en sælger, hvis
//               MobilePay-capability er blevet aktiv/inaktiv):
//               paymentIntents.update med payment_method_types
// 'annuller' gælder også requires_action: en gammel PaymentIntent, hvor
// køberen fx er midt i Klarna, må ikke kunne gøres færdig med en metode, vi
// ikke tilbyder.
export type MetodeHandling = "ok" | "annuller" | "opdater";

const AABNE = ["requires_payment_method", "requires_confirmation", "requires_action"];
const OPDATERBARE = ["requires_payment_method", "requires_confirmation"];

export function metodeHandling(
  pi: {
    status: string;
    payment_method_types?: readonly string[] | null;
    automatic_payment_methods?: { enabled?: boolean | null } | null;
  },
  tilladte: readonly string[],
): MetodeHandling {
  if (!AABNE.includes(pi.status)) return "ok";
  if (pi.automatic_payment_methods?.enabled) return "annuller";
  if (sammeMetoder(pi.payment_method_types, tilladte)) return "ok";
  if (OPDATERBARE.includes(pi.status)) return "opdater";
  // requires_action (køberen er midt i betalingen) kan ikke opdateres: kun
  // lavet om, hvis listen indeholder en metode, vi ikke tilbyder. Afviger
  // den kun ved en sælger-capability (alle metoder tilladte), får køberen
  // lov at gøre betalingen færdig.
  return (pi.payment_method_types ?? []).every((t) => erTilladtMetode(t)) ? "ok" : "annuller";
}

// Annullerer en åben PaymentIntent med forkerte metoder (metodeHandling =
// 'annuller') hos Stripe. Svar: PaymentIntenten efter forsøget - 'canceled',
// eller 'succeeded'/'processing', hvis den nåede at blive betalt imens (så
// spejler kalderen den som normalt). Idempotency key pr. PaymentIntent.
// Stripe-klienten gives med (filen må ikke importere server-moduler).
export async function annullerForkerteMetoder(
  stripe: Pick<Stripe, "paymentIntents">,
  piId: string,
): Promise<Stripe.PaymentIntent> {
  try {
    return await stripe.paymentIntents.cancel(
      piId,
      { cancellation_reason: "abandoned" },
      { idempotencyKey: `bidhamr-metoder-annuller-${piId}` },
    );
  } catch (err) {
    const igen = await stripe.paymentIntents.retrieve(piId);
    if (igen.status === "canceled" || igen.status === "succeeded" || igen.status === "processing") return igen;
    throw err;
  }
}

// Payment Element (hjemmesiden): Link slås fra (ud over at 'link' aldrig er
// i payment_method_types). Apple Pay og Google Pay vises, hvor browseren
// understøtter det ('auto').
export const PAYMENT_ELEMENT_WALLETS = { applePay: "auto", googlePay: "auto", link: "never" } as const;
