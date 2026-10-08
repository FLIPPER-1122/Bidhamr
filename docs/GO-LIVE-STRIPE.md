# Go-live med Stripe – tjekliste

Lavet 8. okt. 2026 efter Niels' gennemgang (F07). Bruges, når BidHamr skifter fra Stripes **testmiljø** til **live** (fase 6). Intet herfra er kørt – Filip (og Niels) gør det selv.

> **Vigtigt:** Ombygningen af betalingsmodellen (købers penge på sælgerens Connect-konto i stedet for platformens saldo) skal være færdig og testet, FØR denne liste køres. Afsnit 4 skal opdateres efter ombygningen.

## 0. Det automatiske værn (allerede bygget)
- Tabellen `public.stripe_tilstand` siger, hvilken Stripe-tilstand databasens Stripe-id'er stammer fra: `test` indtil go-live.
- **Alle** kald til Stripe går gennem en vagt i `src/lib/stripe.ts`: passer nøglens tilstand (`sk_test_`/`sk_live_`) ikke til databasen, kaldes Stripe ikke, og der gives drift-alarm (`stripe/tilstand` på /admin/drift). Med live-nøgle afvises også, hvis tilstanden ikke kan læses.
- **Webhooken** behandler kun events, hvis eventets tilstand (`livemode`) passer til både nøglen og databasen. Ellers: drift-alarm og svar **503** (ikke "modtaget"), så Stripe prøver igen i op til 3 dage – og fejlen ses under Webhooks i Stripe-dashboardet.
- Erhvervsabonnementet (`src/lib/erhverv/betaling.ts`) har desuden sit eget test-nøgle-krav, som skal fjernes bevidst (se 5).
- Stripes API-version er låst til `2026-05-27.dahlia` (`STRIPE_API_VERSION` i `src/lib/stripe.ts`).

## 1. Før – i Stripe-dashboardet (live)
- [ ] Kontoen er aktiveret (virksomhed, bank, ID) – live-nøgler findes.
- [ ] **Payout schedule** på platformskontoen (og på de forbundne konti efter ombygningen) er sat som besluttet (manuel – ROADMAP-BESLUTNINGER linje 6).
- [ ] Connect: Express, land DK, branding, vilkår. Samme indstillinger som i test.
- [ ] Betalingsmetoder (kort, MobilePay, Apple Pay, Google Pay …) slået til i live.
- [ ] Radar-regler (fx bloker ved høj risiko, 3D Secure-regler) gennemgået.
- [ ] Billing (erhverv): Smart Retries, fakturaindstillinger (firmanavn, CVR, nummerering), kundeportal, e-mail-kvitteringer.
- [ ] Webhook-endpoints oprettet i **live** med de samme events som i test (platform: se `src/app/api/webhooks/stripe/route.ts`; Connect: `account.updated`, `account.application.deauthorized`, `capability.updated`, `payout.paid`, `payout.failed`). Noter signatur-hemmelighederne.
- [ ] **Ny betalingsmodel (destination, docs/BETALINGSMODEL-PLAN.md):** ombygningen skal være færdig (trin 1–5). Derefter:
  - Migrationen `20261011010000_betalingsmodel_fundament.sql` (og trin 2–5) er kørt i produktion.
  - **Rækkefølgen er vigtig** (`har_udbetalingskonto` bruger KUN databasens indstilling og kræver med destination card_payments aktiv, charges_enabled og manuel plan – ud fra spejlet i `betalingsprofiler`):
    1. **Backfill (spejl):** `node scripts/betalingsmodel-backfill.mts` (prøvekørsel), derefter `--udfoer`. I separat ændrer den kun MCC/url/beskrivelse/descriptor, hvis de mangler, og spejler alle konti i databasen – plan, debit_negative_balances og capabilities røres ikke. Alle konti skal ende uden FEJL (en konto, Stripe ikke kender, skal frakobles/nulstilles først).
    2. **Serverflaget (Vercel, Filip selv):** `STRIPE_BETALINGSMODEL=destination`. Koden kører stadig separat (med drift-alarm), indtil databasen også er sat.
    3. **Databasen:** `update public.stripe_tilstand set betalingsmodel = 'destination' where id;` – afvises af vagten (`betalingsmodel_backfill_mangler`), hvis en aktiv sælgerkonto ikke er spejlet (trin 1 ikke gennemført). Sæt den IKKE før serverflaget: står databasen til destination, mens serveren kører separat, oprettes nye konti kun med transfers og blokeres af den strammere regel.
    4. **Backfill igen** (nu destination): `--udfoer` anmoder om card_payments + mobilepay_payments og sætter manuel plan og debit_negative_balances. Mangler en konto oplysninger til card_payments, bliver overførsler/udbetalinger inaktive, og sælgeren kan ikke oprette auktioner, indtil onboardingen er færdig – giv sælgerne besked først.
    - Tilbage til separat: databasen først (`betalingsmodel = 'separat'`), derefter serverflaget.
  - Kontrol: ingen `connect/udbetalingsplan`- eller `betaling/betalingsmodel`-alarmer på /admin/drift; alle sælgerkonti står til manuel udbetaling.

## 2. Ryd testdata i produktionsdatabasen (kræver Filips "ja" – skriv det som en migration)
Stripe-id'er fra testtilstand virker ikke med live-nøglen (Stripe svarer "No such …"). Status i prod 8. okt. 2026 (kun læst): 3 Stripe-kunder, 3 Connect-konti, 0 gemte kort, 0 betalinger, 103 registrerede webhook-events.

Nulstil (sæt til `null`, slet ikke rækkerne – handelsdata arkiveres):
- [ ] `betalingsprofiler`: `stripe_customer_id`, `gemt_betalingsmetode_id`, `gemt_kort_maerke`, `gemt_kort_sidste4`, `gemt_kort_udloeb`, `gemt_kort_kl`, `autobetaling = false`, `stripe_account_id`, `connect_tidligere_konti`, alle `connect_*`-felter (detaljer, overførsler/udbetalinger aktiv, mangler, spærret, klar_kl, frakoblet_kl, opmærksomhed).
- [ ] `firmaer`: `stripe_customer_id`, `stripe_subscription_id`, `stripe_abonnement_status`, `opsiges_fra`, `periode_slut` (når erhverv er i prod).
- [ ] `erhverv_pakker`: `stripe_price_id`, `stripe_price_oere` (priserne laves igen i live af koden).
- [ ] Testhandler fra testperioden: `betalinger` (`stripe_payment_intent_id`, `stripe_charge_id`, `stripe_transfer_id`, `stripe_refund_id`, `stripe_dispute_id`), `betaling_afvigelser`, `firma_regninger`, `firma_pakkeskift.stripe_invoice_id`, `transactions` – arkivér/markér som testhandler (bogføringsloven: slettes ikke), og sørg for, at ingen cron prøver dem igen (fx `status = 'annulleret'`, `refusion_graense = refusion_forsoeg`).
- [ ] `stripe_haendelser`: kan blive stående (event-id'er er unikke på tværs af tilstande).
- [ ] Brugerne skal oprette udbetalingskonto og gemt kort på ny – send evt. en besked.

## 3. Skift
- [ ] Vercel → Environment Variables (Filip selv): `STRIPE_SECRET_KEY` (sk_live_…), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (pk_live_…), `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` (live-værdierne fra 1).
- [ ] Appen (Expo): live-publishable key.
- [ ] Til sidst – i samme migration som 2 eller lige efter: `update public.stripe_tilstand set tilstand = 'live', aendret_kl = now(), note = 'Go-live <dato>' where id;` Først nu kalder serveren Stripe med live-nøglen. Indtil da står der en drift-alarm og 503 på webhooken (forventet).
- [ ] Redeploy.

## 4. Kontrol efter skiftet
- [ ] /admin/drift: ingen `stripe/tilstand`-alarmer, betalings-cron kører (`drift_cron_koersler.ok`).
- [ ] Webhooks i Stripe-dashboardet: 2xx.
- [ ] Én rigtig handel med et lille beløb (≥ 3 kr.): betal, frigiv, udbetaling – og en refusion.
- [ ] Ekstern heartbeat (`HEARTBEAT_URL`) får livstegn hvert 5. minut.

## 5. Erhvervsabonnement
- [ ] Fjern test-nøgle-kravet i `stripe()`/`stripeTilgaengelig()` og `cs_test_`-tjekket i `bekraeftCheckout` (`src/lib/erhverv/betaling.ts`) – bevidst, efter Niels' gennemgang (STRIPE-ERHVERV-NOTE.md punkt 6).
- [ ] Moms-sats, produkter, priser og portal-konfiguration oprettes automatisk i live første gang.

## Rul tilbage
Sæt nøglerne tilbage til test i Vercel og `stripe_tilstand` tilbage til `test`. Live-id'er, der er gemt i mellemtiden, skal så ryddes igen, før der testes videre.
