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
  Scriptet kræver Stripes TESTnøgle (produktionen bruger test indtil fase 6). Det anmoder om `card_payments`, `mobilepay_payments` og `revolut_pay_payments` (fra 20. okt. 2026), sætter manuel udbetalingsplan og `debit_negative_balances` og spejler kontoen i databasen. Alle konti skal ende uden `FEJL` (en konto, Stripe ikke kender, skal nulstilles under admin → Betalinger først).
- [ ] **Kør filen** i SQL Editor. Den stopper (og ændrer intet), hvis:
  - en betaling i den gamle model er i gang eller et afvigende beløb ikke er refunderet (`separat_betalinger_i_gang` / `afvigelser_ikke_refunderet` – produktionen har 0 betalinger),
  - en funktion i produktionen afviger fra repoets version (md5-tjek – bekræftet ens 9. okt. 2026),
  - backfill mangler (se ovenfor).
- [ ] Kør dem i ÉN omgang (ingen pause mellem trin 2 og 5).
- [ ] **Ingen automatisk betaling** (Filip, 9. okt. 2026): kør `20261012020000_ingen_autobetaling.sql` efter fragt-migrationen `20261012010000_fragt_dao_shipmondo.sql`. Den slår automatisk betaling fra for alle (samtykkehistorikken bevares), tilføjer `CHECK (autobetaling = false)` og dropper triggeren/funktionen `betalingsprofiler_samtykke`. Den stopper (og ændrer intet), hvis funktionen i databasen afviger fra repoets version (md5 `cc6e4f6cffba780ed060509d773e4273`). Koden virker også før migrationen (serveren trækker aldrig automatisk længere), men kør den sammen med pushet.

- [ ] **Sikkerhedsnet A** (11. okt. 2026): `20261019010000_pengesikkerhed.sql` efter `20261017030000`. Den stopper (og ændrer intet), hvis en af de 20 funktioner afviger fra repoets version (md5-tjek). Grænsen for chefen er 10.000 kr. (Filip, 12. okt. 2026): admin kan frigive handler under 10.000 kr., fra 10.000 kr. kræver det chefen, og udbetalinger kræver chefens godkendelse, når købers samlede betaling er 10.000 kr. eller mere – også når pengene er frigivet via en sag. Kør den FØR pushet: koden kalder `admin_frigiv_handel(p_trade, p_medarbejder, p_begrundelse)`, som først findes efter migrationen. Webhook-eventet `payout.created` skal tilføjes Connect-destinationen (C).
- [ ] **Sikkerhedsnet B** (afstemning og overblik): kør `20261019020000_pengeafstemning.sql` efter sikkerhedsnet A's `20261019010000`. Den kan køres flere gange og rører ingen eksisterende funktioner. Den opretter pg_cron-jobbet `pengeafstemning` (hver time, minut 37), som kalder `/api/cron/afstemning` med samme `cron_url`/`cron_secret` fra Vault som betalings-cron'en (stien skiftes ud automatisk; valgfri Vault-hemmelighed `afstemning_url`). Kør den på testdatabasen først (gjort 12. okt. 2026). Sæt også `CRON_AFSTEMNING_HEALTHCHECK_URL` i Vercel (Production), så en afstemning, der ikke kører eller fejler, giver alarm udefra (HUSKELISTE.md, "Vagt udefra").

## B. Push koden (Filip)

- [ ] **Migrationerne i A SKAL være kørt, før du pusher.** Push derefter `main` (Vercel deployer) med det samme. Pushes koden alligevel først, er det sikkert, men handlerne går i stå: serveren opretter ingen betalinger, betalings-cron'en springer alle pengetrin over, og webhooks svarer 503 (Stripe prøver igen i op til 3 dage) – alt med én drift-alarm (`betaling/betalingsmodel`). Den falder aldrig tilbage til den gamle model. Kør A hurtigst muligt i så fald.

## C. Stripe-dashboardet: webhook-events (test nu, live i fase 6)

Endpoint: `https://bidhamr.dk/api/webhooks/stripe` (samme rute til begge destinationer).

- [ ] **Platform** ("Events from: Your account", signeres med `STRIPE_WEBHOOK_SECRET`):
  `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled`, `charge.succeeded`, `charge.updated`, `charge.refunded`, `refund.updated`, `refund.failed`, `charge.refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `radar.early_fraud_warning.created`, `radar.early_fraud_warning.updated`, `review.opened`, `review.closed`, `setup_intent.succeeded` – og for erhverv: `customer.subscription.created/updated/deleted/pending_update_expired`, `invoice.finalized/paid/payment_failed/voided/marked_uncollectible`.
- [ ] **Connect** ("Events from: Connected accounts", signeres med `STRIPE_CONNECT_WEBHOOK_SECRET`):
  `account.updated`, `account.application.deauthorized`, `capability.updated`, `payout.created`, `payout.paid`, `payout.failed`, `payout.canceled`, `balance.available`, `account.external_account.created`, `account.external_account.updated`. (`payout.created` er nyt med sikkerhedsnet A, 20261019010000: en udbetaling, BidHamr ikke har lavet, fryser sælgeren med det samme.)
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
- [ ] **Betalingsmetoder (Filip, 20. okt. 2026): kort, Apple Pay, Google Pay, MobilePay og Revolut Pay** slået til i live – både under **Settings → Payment methods** (platformen: boost og returfragt) og under **Settings → Connect → Payment methods** for Express-konti (checkout på sælgerens vegne). Koden beder om netop disse (`payment_method_types: ['card','mobilepay','revolut_pay']`, `src/lib/betaling/betalingsmetoder.ts`) og ser ikke på dashboardets øvrige metoder, så Klarna og Link kan godt stå til uden at blive vist. NB: Stripe kan afvise en PaymentIntent med en metode, der ikke er slået til på kontoen i live [VERIFICÉR i live]. Koden tilbyder derfor kun de metoder, platformens standard-konfiguration hos Stripe melder `available` (`src/lib/betaling/platformMetoder.ts`, cachet 10 min). Er MobilePay eller Revolut Pay ikke slået til, viser boost og returfragt bare kort, Apple Pay og Google Pay. Testmiljøet håndhæver ikke kravet. Lav én boost-betaling i live som det første efter skiftet. Sælgerkonti uden aktiv `mobilepay_payments`/`revolut_pay_payments` får blot kort i checkout (koden filtrerer pr. sælger).
- [ ] **Sælgerne må ikke selv kunne udbetale** (sikkerhedsnet A, 11. okt. 2026). Begge indstillinger ligger under **Settings (tandhjulet) → Connect → Payouts** (direkte: `dashboard.stripe.com/settings/connect/payouts`). Tjek dem i LIVE (skift "Test mode" fra øverst til højre) - test- og live-indstillinger er adskilte:
  - [ ] **Payout schedules → "Allow accounts to manage their payout schedule"** skal være slået **FRA**. Den stod TIL i testmiljøet (slået fra af Filip 11. okt. 2026). NB: ændringen gælder kun nye konti - eksisterende konti kontrolleres af koden (se nedenfor).
  - [ ] **Instant Payouts → platformens grænse (platform limit) skal være 0 kr. om dagen**, og der må **ikke** bedes Stripe om en højere grænse. Med 0 kr. kan hverken sælgerne (fra Express Dashboard) eller BidHamr lave Instant Payouts. Står der en knap/indstilling for, at forbundne konti selv kan starte Instant Payouts, skal den være slået fra.
  - [ ] Under **Connect → Settings → Express Dashboard** (hvis menuen findes): tjek, at sælgerne ikke har adgang til at starte udbetalinger selv. [VERIFICÉR - Stripes dokumentation beskriver ikke en separat knap; Instant Payouts styres af grænsen ovenfor.]
  - Hvad koden gør, hvis det alligevel sker: Stripes API har **ingen** indstilling pr. konto, der slår Instant Payouts fra (undersøgt 11. okt. 2026 - kun `settings.payouts.schedule.interval`, som sættes til `manual`). Derfor: (1) en udbetaling, BidHamr ikke har lavet (`payout.created/paid/...` på en sælgerkonto, også `method = instant`), fryser sælgeren for nye auktioner, bud og udbetalinger, markerer alle ventende handler til staff og giver chefen drift-alarm med det samme; (2) står en sælgerkontos udbetalingsplan ikke til `manual` (ved `account.updated`, før hver udbetaling og i den daglige overvågning), sættes den tilbage, sælgerens udbetalinger fryses, og chefen får drift-alarm. Kun chefen ophæver frysningen (Admin → Penge → "Frosne sælgere").
- **Nødstop og kapløb** (sikkerhedsnet A - til viden, ingen opgave):
  - Udbetalinger: nødstoppet tjekkes i `saelger_udbetaling_claim` (databasen) og igen i `udbetaling.ts` lige før `payouts.create` (sammen med sælgerens frysning). Sættes stoppet i de millisekunder mellem det sidste tjek og Stripes svar, kan én udbetaling pr. igangværende kørsel nå at blive oprettet. Den står så som "på vej" under Admin → Penge. En udbetaling med status `pending` kan annulleres i Stripe-dashboardet (sælgerens konto → Payouts → Cancel), så længe den ikke er sendt til banken; pengene står så igen på sælgerens Stripe-konto.
  - Nye betalinger: en køber med checkout-siden åben har en client_secret. Ved stop annulleres alle åbne PaymentIntents (`requires_payment_method`, `requires_confirmation`, `requires_action`) hos Stripe. En betaling, der allerede er `processing` (fx MobilePay), kan ikke annulleres og kan gå igennem - webhooken registrerer den som normalt. Betalingsfristen står stille under stoppet og forlænges ved genoptagelse.
- [ ] **Radar-regler** (Settings → Radar → Rules) gennemgået. Koden beder om 3D Secure på ALLE kortbetalinger (`payment_method_options.card.request_three_d_secure = 'any'`, sikkerhedsnet A). Anbefalet regel oveni (chefens valg, til Filips godkendelse):
  - `Block if :card_3d_secure_support: = 'required' and not :is_3d_secure_authenticated:` - kortet kræver 3D Secure, men betalingen blev ikke autentificeret. (Attributterne findes i Stripes "Supported attributes"; boolske attributter skrives uden `= true/false`. Brug "Test rule" i editoren før du gemmer.)
  - Overvej også `Review if :amount_in_dkk: > 5000 and not :is_3d_secure_authenticated:` (store beløb uden 3D Secure til manuel gennemgang - et åbent review stopper udbetalingen i koden).
  - Behold Stripes indbyggede regler (bl.a. "Block if :risk_level: = 'highest'" og blokering ved fejlet 3D Secure). MobilePay, Revolut Pay og Apple Pay har ikke 3D Secure - bloker dem ikke med en 3DS-regel (Link tilbydes ikke, 20. okt. 2026). Google Pay: kort i Google Wallet på telefonen (DPAN) har ikke 3D Secure, men et kort, der kun er gemt i Chrome/Google-kontoen (Googles "PAN_ONLY"/FPAN), behandles som et kort og kan få en 3D Secure-udfordring (docs.stripe.com/google-pay, "Liability shift").
  - Testet i testmiljøet 11. okt. 2026: med `'any'` gav både 4000 0000 0000 3055 og 4242 4242 4242 4242 `requires_action` (3D Secure-vinduet i Payment Element); uden gav 3055 `succeeded`.
- [ ] Billing (erhverv): Smart Retries, fakturaindstillinger (firmanavn, CVR, nummerering), kundeportal, e-mail-kvitteringer.
- [ ] Webhook-endpoints oprettet i **live** med de samme events som i C. Noter signatur-hemmelighederne.

### E2. Ryd testdata i produktionsdatabasen (kræver Filips "ja" – skriv det som en migration)
Stripe-id'er fra testtilstand virker ikke med live-nøglen. Nulstil (sæt til `null`, slet ikke rækkerne – handelsdata arkiveres):
- [ ] `betalingsprofiler`: `stripe_customer_id`, `gemt_betalingsmetode_id`, `gemt_kort_*` (`autobetaling` er allerede altid `false` – CHECK fra `20261012020000_ingen_autobetaling.sql`; samtykkekolonnerne `autobetaling_samtykke_*`/`autobetaling_fravalgt_kl` er historik og røres ikke), `stripe_account_id`, `connect_tidligere_konti`, alle `connect_*`-felter (også `connect_charges_enabled`, `connect_kort_aktiv`, `connect_betalingsmetoder`, `connect_udbetalingsplan`, `connect_plan_ok`, `connect_udbetaling_fejlet_*`).
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
