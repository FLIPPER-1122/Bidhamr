# Go-live med Stripe – tjekliste

Lavet 8. okt. 2026 efter Niels' gennemgang (F07), skrevet om 9. okt. 2026 efter betalingsmodellens trin 5 (oprydning). Intet herfra er kørt i produktion – Filip (og Niels) gør det selv.

**Betalingsmodellen:** BidHamr kører KUN med den nye model (destination charges, docs/BETALINGSMODEL-PLAN.md): køberen betaler på sælgerens vegne (`on_behalf_of` + `transfer_data`), pengene står på sælgerens Stripe Connect-konto med **manuel** udbetalingsplan, BidHamrs gebyrer trækkes som application fee, og BidHamr udbetaler fra sælgerens konto til banken, når handlen er helt færdig. Den gamle model (penge på BidHamrs saldo + transfer) er fjernet. Der er **intet serverflag** – `STRIPE_BETALINGSMODEL` bruges ikke længere og skal ikke sættes i Vercel (Vercels miljøvariabler røres ikke).

Rækkefølgen er: **A** (migrationer i produktion) → **B** (push) → **C** (webhook-events i Stripe-dashboardet) → **D** (kontrol) – og først i fase 6: **E** (live-nøgler).

---

## A. Kør migrationerne i produktion (Filip – kræver dit "ja")

Produktionen har allerede `20261011010000_betalingsmodel_fundament.sql` (tjekket 9. okt. 2026 i `supabase_migrations.schema_migrations`). Mangler (i denne rækkefølge):

1. `20261011020000_betalingsmodel_betaling_ind.sql`
2. `20261011030000_betalingsmodel_udbetaling.sql`
3. `20261011040000_betalingsmodel_refusion_indsigelse.sql`
4. `20261011041000_betalingsmodel_trin4_rettelser.sql`
5. `20261011050000_betalingsmodel_oprydning.sql` (trin 5)

De er samlet i én transaktionel fil: `prod-koersel/2026-10-09-betalingsmodel-trin2-5.sql` (gitignored, kun LF – kopiér hele filen ind i Supabase SQL Editor for projekt **Hamr**). Fejler noget, rulles alt tilbage. Filen registrerer også versionerne i `schema_migrations`.

- [ ] **Først: backfill af sælgerkonti** (ellers stopper trin 5's vagt med `betalingsmodel_backfill_mangler` – produktionen har 2 test-Connect-konti med indsendte oplysninger, der ikke er spejlet):
  ```
  node scripts/betalingsmodel-backfill.mts --env .env.production.local --produktion
  node scripts/betalingsmodel-backfill.mts --env .env.production.local --produktion --udfoer
  ```
  Scriptet kræver Stripes TESTnøgle (produktionen bruger test indtil fase 6). Det anmoder om `card_payments` og `mobilepay_payments`, sætter manuel udbetalingsplan og `debit_negative_balances` og spejler kontoen i databasen. Alle konti skal ende uden `FEJL` (en konto, Stripe ikke kender, skal nulstilles under admin → Betalinger først).
- [ ] **Kør filen** i SQL Editor. Den stopper (og ændrer intet), hvis:
  - en betaling i den gamle model er i gang eller et afvigende beløb ikke er refunderet (`separat_betalinger_i_gang` / `afvigelser_ikke_refunderet` – produktionen har 0 betalinger),
  - en funktion i produktionen afviger fra repoets version (md5-tjek – bekræftet ens 9. okt. 2026),
  - backfill mangler (se ovenfor).
- [ ] Kør dem i ÉN omgang (ingen pause mellem trin 2 og 5).

## B. Push koden (Filip)

- [ ] **Migrationerne i A SKAL være kørt, før du pusher.** Push derefter `main` (Vercel deployer) med det samme. Pushes koden alligevel først, er det sikkert, men handlerne går i stå: serveren opretter ingen betalinger, betalings-cron'en springer alle pengetrin over, og webhooks kvitteres uden behandling – alt med én drift-alarm (`betaling/betalingsmodel`). Den falder aldrig tilbage til den gamle model. Kør A hurtigst muligt i så fald.

## C. Stripe-dashboardet: webhook-events (test nu, live i fase 6)

Endpoint: `https://bidhamr.dk/api/webhooks/stripe` (samme rute til begge destinationer).

- [ ] **Platform** ("Events from: Your account", signeres med `STRIPE_WEBHOOK_SECRET`):
  `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled`, `charge.succeeded`, `charge.updated`, `charge.refunded`, `refund.updated`, `refund.failed`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `radar.early_fraud_warning.created`, `radar.early_fraud_warning.updated`, `review.opened`, `review.closed`, `setup_intent.succeeded` – og for erhverv: `customer.subscription.created/updated/deleted/pending_update_expired`, `invoice.finalized/paid/payment_failed/voided/marked_uncollectible`.
- [ ] **Connect** ("Events from: Connected accounts", signeres med `STRIPE_CONNECT_WEBHOOK_SECRET`):
  `account.updated`, `account.application.deauthorized`, `capability.updated`, `payout.paid`, `payout.failed`, `payout.canceled`, `balance.available`, `account.external_account.created`, `account.external_account.updated`.
- Mangler et event, opdager overvågningen det (højst én alarm pr. tilfælde, `betaling/webhook-udeblev` på /admin/drift) og spejler det selv – men ret webhooken.

## D. Kontrol efter A–C

- [ ] /admin/drift: ingen `betaling/betalingsmodel`, `stripe/tilstand`, `connect/udbetalingsplan` eller `betaling/saldo`-alarmer; betalings-cron kører (`drift_cron_koersler.ok`).
- [ ] /admin/penge (chef): "Saldo-afstemning: alle sælgerkonti dækker …", og "Overvågningen kørte sidst …" er under en time gammel.
- [ ] Alle sælgerkonti står til manuel udbetaling (admin → Betalinger: ingen markeringer på udbetalingskonti).
- [ ] Ekstern heartbeat (`HEARTBEAT_URL`, docs/overvaagning.md) får livstegn hvert 5. minut.

## Det automatiske værn (bygget)

- `public.stripe_tilstand.tilstand` siger, hvilken Stripe-tilstand databasens id'er stammer fra (`test` indtil go-live). **Alle** kald til Stripe går gennem en vagt i `src/lib/stripe.ts`: passer nøglens tilstand (`sk_test_`/`sk_live_`) ikke til databasen, kaldes Stripe ikke, og der gives drift-alarm (`stripe/tilstand`). Med live-nøgle afvises også, hvis tilstanden ikke kan læses.
- Nyt (trin 5): passer den offentlige nøgle (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, pk_test/pk_live) ikke til den hemmelige, oprettes ingen nye betalinger (alarm `stripe/tilstand`) – refusioner, udbetalinger og webhooks kører videre.
- `stripe_tilstand.betalingsmodel` er låst til `destination` (CHECK). Serveren opretter kun betalinger, når den står til destination (`src/lib/betaling/model.ts`).
- Start-tjek (`src/instrumentation.ts`): når serveren starter, tjekkes nøgler og betalingsmodel, og afvigelser giver drift-alarm med det samme.
- **Webhooken** behandler kun events, hvis eventets tilstand (`livemode`) passer til både nøglen og databasen. Ellers drift-alarm og svar **503**, så Stripe prøver igen i op til 3 dage.
- Stripes API-version er låst til `2026-05-27.dahlia`.
- Erhvervsabonnementet (`src/lib/erhverv/betaling.ts`) har sit eget test-nøgle-krav, som skal fjernes bevidst (E5).

## Overvågning (Niels F06, bygget)

Betalings-cron'en (hvert 5. min) markeres som fejlet, når et pengetrin fejler; heartbeat som før. Én gang i timen kører `src/lib/betaling/overvaagning.ts`, og hvert fund giver ÉN drift-alarm pr. tilfælde (tabellen `drift_tilfaelde`):
- en udbetaling til sælgerens bank står `claimet`/`usikker`/`oprettet` i over 7 dage (`betaling/udbetaling-haenger`),
- en tabt indsigelse har ikke fået afklaring i over 7 dage, fx fordi den venter på en uafklaret udbetaling (`betaling/indsigelse-uafklaret`),
- saldo-afstemning pr. sælgerkonto fejler (`betaling/saldo` – lukkes, når den passer igen),
- payout-, indsigelses- eller svindelvarsel-events er udeblevet (`betaling/webhook-udeblev` – spejles automatisk),
- penge har stået over 60 og 80 dage på en sælgerkonto uden udbetaling (`betaling/gamle-midler`),
- en udbetaling fra en sælgerkonto, som BidHamr ikke har lavet (`betaling/fremmed-udbetaling`).

---

## E. Fase 6: skift til live (først når alt ovenfor er testet)

### E1. I Stripe-dashboardet (live)
- [ ] Kontoen er aktiveret (virksomhed, bank, ID) – live-nøgler findes.
- [ ] Connect: Express, land DK, branding, vilkår. Samme indstillinger som i test. Sælgerkonti oprettes af koden med manuel udbetalingsplan.
- [ ] Platformens egen udbetalingsplan kan være automatisk (platformens saldo er kun BidHamrs gebyrer, fragt og BidHamr Beskyttelse).
- [ ] Betalingsmetoder (kort, MobilePay, Apple Pay, Google Pay …) slået til i live.
- [ ] Radar-regler (fx bloker ved høj risiko, 3D Secure-regler) gennemgået.
- [ ] Billing (erhverv): Smart Retries, fakturaindstillinger (firmanavn, CVR, nummerering), kundeportal, e-mail-kvitteringer.
- [ ] Webhook-endpoints oprettet i **live** med de samme events som i C. Noter signatur-hemmelighederne.

### E2. Ryd testdata i produktionsdatabasen (kræver Filips "ja" – skriv det som en migration)
Stripe-id'er fra testtilstand virker ikke med live-nøglen. Nulstil (sæt til `null`, slet ikke rækkerne – handelsdata arkiveres):
- [ ] `betalingsprofiler`: `stripe_customer_id`, `gemt_betalingsmetode_id`, `gemt_kort_*`, `autobetaling = false`, `stripe_account_id`, `connect_tidligere_konti`, alle `connect_*`-felter (også `connect_charges_enabled`, `connect_kort_aktiv`, `connect_betalingsmetoder`, `connect_udbetalingsplan`, `connect_plan_ok`, `connect_udbetaling_fejlet_*`).
- [ ] `firmaer`: `stripe_customer_id`, `stripe_subscription_id`, `stripe_abonnement_status`, `opsiges_fra`, `periode_slut` (når erhverv er i prod).
- [ ] `erhverv_pakker`: `stripe_price_id`, `stripe_price_oere` (priserne laves igen i live af koden).
- [ ] Evt. testhandler (`betalinger`, `saelger_udbetalinger`, `betaling_afvigelser`, `firma_regninger`, `transactions`): arkivér/markér som testhandler (bogføringsloven: slettes ikke), og sørg for, at ingen cron prøver dem igen.
- [ ] `stripe_haendelser` og `drift_tilfaelde`: kan blive stående.
- [ ] Brugerne skal oprette udbetalingskonto og gemt kort på ny – send evt. en besked.

### E3. Skift
- [ ] Vercel → Environment Variables (Filip selv): `STRIPE_SECRET_KEY` (sk_live_…), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (pk_live_…), `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` (live-værdierne fra E1). Begge nøgler skal være live – ellers stopper nye betalinger.
- [ ] Appen (Expo): live-publishable key.
- [ ] Til sidst – i samme migration som E2 eller lige efter: `update public.stripe_tilstand set tilstand = 'live', aendret_kl = now(), note = 'Go-live <dato>' where id;` Først nu kalder serveren Stripe med live-nøglen.
- [ ] Redeploy.

### E4. Kontrol efter skiftet
- [ ] /admin/drift: ingen `stripe/tilstand`-alarmer, betalings-cron kører.
- [ ] Webhooks i Stripe-dashboardet: 2xx.
- [ ] Én rigtig handel med et lille beløb (≥ 3 kr.): betal, frigiv, udbetaling – og en refusion. Udbetalingen sendes, når Stripes ventetid på sælgerens konto er gået (nye konti ca. 7 dage) - ved afhentning tidligst 3 dage efter frigivelsen for nye sælgere. Mindste udbetaling er 20 kr.

### E5. Erhvervsabonnement
- [ ] Fjern test-nøgle-kravet i `stripe()`/`stripeTilgaengelig()` og `cs_test_`-tjekket i `bekraeftCheckout` (`src/lib/erhverv/betaling.ts`) – bevidst, efter Niels' gennemgang (STRIPE-ERHVERV-NOTE.md punkt 6).
- [ ] Moms-sats, produkter, priser og portal-konfiguration oprettes automatisk i live første gang.

### Rul tilbage (live → test)
Sæt nøglerne tilbage til test i Vercel og `stripe_tilstand.tilstand` tilbage til `test`. Live-id'er, der er gemt i mellemtiden, skal så ryddes igen. Betalingsmodellen kan IKKE sættes tilbage til den gamle model.
