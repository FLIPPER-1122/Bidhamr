# Erhvervsabonnement med Stripe Billing – tjekliste til Niels

Bygget 8. okt. 2026 i Stripes **testmiljø** efter Filips ønske (undtagelse fra Stripe-pausen). Regler: `ROADMAP-BESLUTNINGER.md` → "Erhvervskonti". Kode: `src/lib/erhverv/betaling.ts` (kører kun med `sk_test_`/`rk_test_`-nøgle), webhook `src/app/api/webhooks/stripe/route.ts`, database `supabase/migrations/20261010050000_erhverv_stripe.sql`.

## Hvad er bygget
- **Første betaling:** Firma oversigt → Abonnement → "Betal for din pakke" → Stripe Checkout (`mode: subscription`, kun kort) → retur til `/firma/abonnement?betaling=ok` (kvittering). Indtil da er firmaet `afventer_betaling` og kan ikke oprette auktioner (databasen, BHE02).
- **Opgradering:** `subscriptions.update` med `proration_behavior: always_invoice`, `payment_behavior: pending_if_incomplete`. Fakturaen for forskellen betales med det gemte kort; kræver den 3DS, sendes firmaet til `hosted_invoice_url`. `invoice.paid` (billing_reason `subscription_update`) → `firma_pakkeskift_betalt`. En opgradering, der ikke længere venter, annulleres (void); bliver den betalt alligevel, refunderes den automatisk, og prisen sættes tilbage (+ drift-alarm).
- **Nedgradering:** Subscription Schedule (2 faser, `proration_behavior: none`, `end_behavior: release`) – prisen skifter ved periodens slut. "Behold pakken" frigiver planen.
- **Opsigelse:** kun chef i Admin → Erhverv → Firma ("Opsig abonnement") → `cancel_at_period_end`. `customer.subscription.deleted` → status `opsagt`. "Fortryd opsigelsen" findes også.
- **Mislykket betaling:** `invoice.payment_failed` → `firma_abonnement_mislykket`; cron `erhverv-betalingsfrist` (dagligt 04:07) pauser efter 7 dage; senere betaling genaktiverer.
- **Betalingskort:** Customer Portal, egen konfiguration (kun `payment_method_update` + `invoice_history`; opsigelse, pakkeskift og kundeoplysninger er slået fra).
- **Regninger:** `firma_regninger` spejles fra Stripe (nummer, beløb ekskl./inkl. moms, moms, `invoice_pdf`, `hosted_invoice_url`, status).

## Stripe-objekter (oprettes automatisk, idempotent, første gang de bruges)
| Objekt | Kendes på |
|---|---|
| Tax Rate "Moms" 25 %, DK, eksklusiv, `tax_type: vat` | `metadata.bidhamr = moms_dk_25` |
| Product pr. pakke | id `bidhamr_erhverv_<pakke-id uden bindestreger>` |
| Price pr. pakke og beløb (DKK, månedlig, `tax_behavior: exclusive`) | `lookup_key = erhverv_pakke_<pakke-id>_<øre>`; id gemt i `erhverv_pakker.stripe_price_id` |
| Customer pr. firma (navn, adresse, e-mail, `tax_id` eu_vat `DK<CVR>`, `preferred_locales: da`) | `metadata.firma_id`; id i `firmaer.stripe_customer_id` |
| Subscription (`default_tax_rates: [Moms]`, `metadata.firma_id`) | `firmaer.stripe_subscription_id` |
| Billing Portal-konfiguration | `metadata.bidhamr = erhverv_v1` |

Alle opret-/ændringskald har idempotency-nøgler (`idempotensNoegle` i `betaling.ts`).

## Webhook-events, der skal slås til (test)
På det **eksisterende** endpoint `https://bidhamr.dk/api/webhooks/stripe` (samme signatur-hemmelighed `STRIPE_WEBHOOK_SECRET`, ingen nye miljøvariabler):
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_failed`

## Bør gennemgås
1. **Smart Retries / "efter sidste forsøg"** (Billing → Revenue recovery): anbefaling "mark subscription as unpaid" eller "leave past due". Vælges "cancel", sætter koden firmaet på pause og fjerner abonnementet, så firmaet må betale på ny med Checkout.
2. **Fast Tax Rate vs. Stripe Tax:** valgt fast 25 % (kun danske firmaer). Skal udenlandske firmaer med senere, skal det laves om (reverse charge).
3. **Fakturaindstillinger** i dashboardet: firmanavn/adresse/CVR for BidHamr på fakturaen, nummerering, fakturasprog, e-mail-kvitteringer til kunden.
4. **Pause af BidHamr** (staff sætter "Sat på pause"): Stripe trækker fortsat betaling. Skal det være `pause_collection`?
5. **Dobbelt abonnement** (to Checkout-betalinger på samme tid): det nye abonnement stoppes automatisk + drift-alarm; betalingen skal refunderes manuelt.
6. **Live-skift (fase 6):** fjern test-nøgle-tjekket i `betaling.ts` (`stripe()`), og tjek at priser/Tax Rate/portal oprettes i live.
7. Kunden har ikke selv adgang til at ændre navn/adresse i portalen; ændres firmaoplysninger i admin, opdateres Stripe-kunden ikke automatisk endnu.
