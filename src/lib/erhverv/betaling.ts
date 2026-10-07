import "server-only";

// Betaling af erhvervsabonnementer - KLAR TIL STRIPE, men uden Stripe-kald.
//
// Stripe er på pause (Niels/Ankerdigital gennemgår og sætter det op). Indtil
// da returnerer alle funktioner her { status: "afventer_betaling" }, og intet
// giver firmaet flere auktioner uden betaling. Når Stripe kobles på, skal KUN
// denne fil og en webhook-route skrives - databasen og resten af koden er
// færdige:
//
//   Database (20261010030000_erhverv.sql), kun service_role:
//     firma_pakkeskift_betalt(p_skift, p_stripe_reference, p_beloeb_oere, p_stripe_invoice_id)
//       Opgradering betalt -> pakken aktiveres med det samme + firma_regninger-række.
//     firma_abonnement_betalt(p_firma, p_periode_start, p_periode_slut, p_beloeb_oere,
//                             p_stripe_reference, p_stripe_invoice_id)
//       Månedens abonnement betalt -> regning, betalt_til, genaktivering efter
//       betalingspause, planlagt nedgradering gennemføres ved periodeskift.
//     firma_abonnement_mislykket(p_firma, p_stripe_reference, p_beloeb_oere, p_stripe_invoice_id)
//       Betaling fejlet -> betaling_mislykket_kl. firma_abonnement_frist_koer()
//       (cron, dagligt) sætter abonnementet på pause efter 7 dage uden betaling.
//     firmaer.stripe_customer_id / stripe_subscription_id (kun service_role).
//   Alle kroge er idempotente på p_stripe_reference (brug Stripes event- eller
//   invoice-id), så en webhook, der kommer to gange, ikke giver to regninger.
//
// Pakkeskift i dag: firma_skift_pakke (firmaet selv) gemmer en opgradering
// som 'afventer_betaling' i firma_pakkeskift og en nedgradering som
// naeste_pakke_id/naeste_pakke_fra (fra næste periode, intet refunderes).
// Staff kan aktivere en pakke manuelt (erhverv_firma_opdater) efter en aftale
// uden for Stripe.

export type BetalingsStatus =
  | { status: "afventer_betaling"; besked: string }
  | { status: "betalt" }
  | { status: "fejl"; fejl: string };

const AFVENTER: BetalingsStatus = {
  status: "afventer_betaling",
  besked:
    "Betaling af abonnementer er ikke åbnet endnu. BidHamr kontakter jer om betalingen, og ændringen gælder, når den er betalt.",
};

// Starter firmaets abonnement, når firmakontoen er oprettet.
//
// TODO(Stripe):
//  1. Opret (eller genbrug) en Stripe Customer for firmaet med CVR som
//     tax_id (type 'eu_vat', værdi 'DK' + cvr), firmanavn, adresse og
//     kontakt_email. Gem id'et i firmaer.stripe_customer_id (service role).
//  2. Opret en Subscription (Stripe Billing) med pakkens Price (månedlig,
//     DKK, pakken skal have et stripe_price_id - tilføj kolonnen på
//     erhverv_pakker, når priserne er sat). collection_method
//     'charge_automatically', payment_behavior 'default_incomplete', så
//     firmaet betaler første faktura via Checkout/Payment Element (kort,
//     MobilePay). Gem subscription.id i firmaer.stripe_subscription_id.
//  3. Webhook invoice.paid (billing_reason 'subscription_create' eller
//     'subscription_cycle') -> firma_abonnement_betalt(firma, period.start,
//     period.end, amount_paid, event.id, invoice.id).
//  4. Webhook invoice.payment_failed -> firma_abonnement_mislykket(...).
//  5. Fakturaen fra Stripe (invoice.hosted_invoice_url / invoice_pdf) gemmes
//     i firma_regninger.pdf_url, når regnskabsprogrammet er valgt.
export async function startAbonnement(firmaId: string): Promise<BetalingsStatus> {
  void firmaId;
  return AFVENTER;
}

// Firmaet har valgt en større pakke (firma_skift_pakke svarede
// 'opgradering_afventer_betaling' med skift_id).
//
// TODO(Stripe):
//  1. stripe.subscriptions.update(subscription, { items: [{ id, price:
//     nyPakke.stripe_price_id }], proration_behavior: 'always_invoice',
//     payment_behavior: 'pending_if_incomplete', metadata: { skift_id } }).
//     Stripe laver straks en faktura for forskellen resten af perioden
//     (proration), og ændringen træder først i kraft, når den er betalt.
//  2. Webhook invoice.paid med metadata.skift_id (eller
//     billing_reason 'subscription_update') -> firma_pakkeskift_betalt(
//     skift_id, event.id, amount_paid, invoice.id). Først DÉR får firmaet
//     flere auktioner pr. uge.
//  3. Fejler betalingen, forbliver skiftet 'afventer_betaling'; firmaet
//     beholder sin gamle pakke.
export async function startOpgradering(skiftId: string): Promise<BetalingsStatus> {
  void skiftId;
  return AFVENTER;
}

// Firmaet har valgt en mindre pakke (firma_skift_pakke svarede
// 'nedgradering_planlagt'). Databasen har allerede sat naeste_pakke_fra.
//
// TODO(Stripe):
//  1. Opret/opdater en Subscription Schedule, så prisen skifter ved
//     current_period_end (ingen proration, intet refunderes).
//  2. Sæt firmaer.naeste_pakke_fra = current_period_end fra Stripe (service
//     role), så datoen følger Stripes periode.
//  3. Webhook invoice.paid for den nye periode -> firma_abonnement_betalt
//     gennemfører nedgraderingen (firma_anvend_planlagt).
export async function startNedgradering(skiftId: string): Promise<BetalingsStatus> {
  void skiftId;
  return { status: "betalt" };
}

// Firmaet opsiger (sker via BidHamr - abonnement_status 'opsagt' i admin).
//
// TODO(Stripe): stripe.subscriptions.update(subscription, {
//   cancel_at_period_end: true }). Ingen refusion. Webhook
//   customer.subscription.deleted -> erhverv_firma_opdater(status 'opsagt')
//   via service role (eller en egen krog, hvis staff-id ikke findes).
export async function opsigAbonnement(firmaId: string): Promise<BetalingsStatus> {
  void firmaId;
  return AFVENTER;
}
