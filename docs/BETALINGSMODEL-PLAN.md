# Plan: ny betalingsmodel – pengene står på sælgerens Stripe Connect-konto

Lavet 8. okt. 2026 (Plan-agent, kun læst kode). Beslutning: ROADMAP-BESLUTNINGER.md "Betalingsmodel ændres". Advokat/revisor: jura/noter-til-advokat.md (øverst, nr. 76–94). Niels' fund: docs/niels/GENNEMGANG.md (gitignored). **[VERIFICÉR]** = Stripe-detalje, der skal tjekkes i Stripes dokumentation/testmiljø før der bygges på den.

## 0. Tre ting, der ændrer opgaven
1. **Ved destination charges hører betaling, refusion og dispute stadig til platformskontoen** (også med `on_behalf_of`). Events (`payment_intent.*`, `charge.refunded`, `charge.dispute.*`) kommer på platformens endpoint. En dispute trækkes fra BidHamrs saldo – derfor skal BidHamr selv tilbageføre (transfer reversal) fra sælgerens konto, når disputen kommer (model A, se 1.6).
2. **En payout på en forbundet konto er et beløb fra kontoens samlede saldo**, ikke bundet til en handel. BidHamr skal selv holde styr på, hvilke handler en payout dækker, og afstemme saldoen.
3. **`stripe_transfer_id` må IKKE genbruges** til den automatiske transfer (ca. 28 migrationer og 16 filer bruger `stripe_transfer_id is null` som "ikke givet til sælger"). Ny kolonne `stripe_destination_transfer_id`.

## 1. Stripe-mekanik
### 1.1 Forbundne konti (Express)
`accounts.create`: `capabilities.transfers` + **`card_payments` (krævet for on_behalf_of)** + MobilePay [VERIFICÉR navn/krav], `business_type` = company for firmaer (i dag hardkodet individual), `business_profile.mcc` (5931 brugte varer [VERIFICÉR]), `settings.payouts.schedule.interval = 'manual'`, `debit_negative_balances` [VERIFICÉR DK], statement descriptor "BIDHAMR.DK" [VERIFICÉR tilladt på privat sælgers konto].
- Sælgeren bliver settlement merchant / merchant of record (DK/DKK). Køberens kontoudtog viser sælgerkontoens descriptor.
- `card_payments` skal være active, ellers fejler PaymentIntent → eksisterende testkonti skal gennem onboarding igen.
- Stripe-gebyrer betales fortsat af platformen; Express ca. 2 EUR pr. aktiv konto/md + ca. 0,25 % + 0,10 EUR pr. payout [VERIFICÉR DK] → saml payouts.
- Express: platformen hæfter for negative saldi (`controller.losses.payments = application`).
- `account.updated` spejler `charges_enabled`, capabilities, `payouts.schedule.interval`, `payouts_enabled`; står planen ikke til manual → sæt tilbage, alarm, stop betalinger/udbetalinger (F01). [VERIFICÉR] at sælgeren ikke selv kan ændre plan/lave payout/Instant Payouts i Express Dashboard.

### 1.2 PaymentIntent
`on_behalf_of: saelgerKonto` = `transfer_data.destination`, `application_fee_amount` = købergebyr + sælgergebyr + fragt + Beskyttelse, `transfer_group: handel_<id>`, `metadata.pengemodel = "destination"`, idempotency `bidhamr-pi-dest-<betaling>-<forsøg>`. Sælger ender med `total − fee = bud − sælgergebyr = udbetaling_oere` (CHECK i DB). [VERIFICÉR] transfer = hele beløbet og fee trækkes bagefter.
- Gem `saelger_stripe_konto` på betalingen ved oprettelse. Hent kontoen frisk før oprettelse (charges_enabled, card_payments, manuel plan) – ellers dansk fejl, ingen PI.
- Beløbsrettelse opdaterer også `application_fee_amount`; `on_behalf_of` kan ikke ændres [VERIFICÉR] → gamle PI'er annulleres og laves på ny.
- Betalingsmetoder med on_behalf_of: Apple/Google Pay (domæne på platformen nok? [VERIFICÉR]), MobilePay [VERIFICÉR], Klarna med private sælgere [VERIFICÉR – ellers slå fra]. Klienten (Elements + clientSecret) skal ikke ændres.

### 1.3 Gemt kort og automatisk betaling
Kunde og betalingsmetode bliver på platformen (virker med destination charges). [VERIFICÉR – vigtigt] `on_behalf_of` på SetupIntent og SCA-undtagelse for off-session betalinger mod skiftende settlement merchants. Fejl falder tilbage til manuel betaling inden for 48 timer.

### 1.4 Payouts til sælgers bank
Midlerne bliver "available" efter kontoens `delay_days` (også ved manuel plan) – gem `midler_tilgaengelige_kl` (via `charge.transfer → destination_payment → balance_transaction.available_on`). `payouts.create` med `stripeAccount`, idempotency `bidhamr-payout-<udbetaling>-<forsøg>` [VERIFICÉR source_type for MobilePay]. Før hver payout: `balance.retrieve` – `available ≥ sum`, og `available + pending ≥ alle betalte, ikke-udbetalte, ikke-refunderede handler` (ellers stop + alarm). For lidt saldo = prøv igen + alarm. Én samlet payout pr. sælger pr. cron-kørsel; trigger også på `balance.available`. 90 dage: [VERIFICÉR] adfærd; alarm dag 60/80. `payout.failed` → "venter på bank" → nyt forsøg ved `account.updated`. Mindste payout i DKK [VERIFICÉR].

### 1.5 Refusioner
Fuld: `refunds.create({ payment_intent, reverse_transfer: true, refund_application_fee: true })` – sælger 0, platform 0 (Stripes gebyr er BidHamrs tab). Delvis (sag med medhold, køber får T − Beskyttelse): to trin med eksakte beløb – (1) `applicationFees.createRefund(fee, { amount: R − S })`, (2) `refunds.create({ amount: R, reverse_transfer: true, refund_application_fee: false })`. Refusionsplan gemmes og låses i DB (`refusion_oere`, `refusion_fra_saelger_oere`, `refusion_gebyr_oere`, trin-kolonner). Efter payout: refusion afvises; kun chef-vej "BidHamr dækker".

### 1.6 Disputes
Debiteres platformen. **Model A:** ved `charge.dispute.created` → `transfers.createReversal(destinationTransfer, { amount: S })`, bloker betalingen, besked til sælger ("send ikke varen"). Vundet → ny transfer S. Tabt → fast sluttilstand `indsigelse_tabt` (F04), staff kan "markér løst". Efter payout: BidHamr bærer tabet (advokat nr. 82/92). Tidlige varsler: lyt til `radar.early_fraud_warning.*` og `review.*` → bloker payout + admin-flag (F03).

### 1.7 Fragt
Indgår i application fee; BidHamr betaler GLS/Shipmondo uden for Stripe.

### 1.8 Platformens egen udbetalingsplan
Platformens saldo = kun BidHamrs gebyrer → kan være automatisk; `balance_insufficient` ved refusion = prøv igen + alarm.

## 2. Database og kode
**Ny migration** (fx `20261011010000_destination_charges.sql`): på `betalinger`: `pengemodel ('separat'|'destination', default separat)`, `saelger_stripe_konto`, `application_fee_oere` (+ CHECK), `stripe_destination_transfer_id unique`, `stripe_application_fee_id`, `stripe_destination_payment_id`, `midler_tilgaengelige_kl`, `udbetal_tidligst` (F02), `saelger_udbetaling_id`, refusionsplan-kolonner, indsigelses-kolonner + sluttilstand, `svindelvarsel_kl`, `radar_review_aaben`, `stripe_tilstand ('test'|'live')` (F07). `overfoersel_paabegyndt_kl` = "pengene til sælger er sat i gang" i begge modeller. Gennemgå ca. 24 vagter med `stripe_transfer_id is null` → ny hjælper `betaling_penge_til_saelger(b)`.
**Ny tabel `saelger_udbetalinger`** (payouts, status, forsøg; ingen sletning; service role).
**`betalingsprofiler`:** `connect_charges_enabled`, `connect_kort_aktiv`, `connect_betalingsmetoder`, `connect_udbetalingsplan`, `connect_plan_ok`, `stripe_tilstand`.
**SQL-funktioner:** `betaling_claim_udbetaling`, `saelger_udbetaling_registrer/_fejlet`, refusionsplan i `betaling_paabegynd_refusion`/`sag_claim_refusion`, ny sluttilstand i `betaling_registrer_indsigelse`, `application_fee_oere` ved indsætning i `afslut_udloebne_auktioner`/andenchance/betalingsfrist, strammere `har_udbetalingskonto` (charges_enabled + card_payments + manuel plan).
**TypeScript:** lås `apiVersion` i `src/lib/stripe.ts` FØRST; `beregn.ts` → `applicationFeeOere`; `stripeBetaling.ts` deles i `betalingInd/udbetaling/refusion/indsigelse/connect.ts` (`sikrPaymentIntent`, `spejlPaymentIntent`, `overfoerTilSaelger` → `udbetalTilSaelger` med frisk charge-tjek og saldo-afstemning, `refunderVentende` for ALLE årsager (F05), `spejlIndsigelse` model A, `spejlConnectKonto` (F01), `onboardingLink`, `sikrKontoopsaetning`); webhook: Connect-events `capability.updated`, `payout.*`, `balance.available`; platform-events `charge.succeeded/updated`, `charge.dispute.funds_withdrawn/reinstated`, `radar.early_fraud_warning.*`, `review.*`, `transfer.reversed`, `application_fee.refunded`; cron: `udbetalVentende`, `refunderVentende`, daglig saldo-afstemning, 60/80-dages-alarm, plan-kontrol, fejlet trin = fejlet kørsel (F06); afhentning: frigivet straks i DB, payout når midlerne er tilgængelige og `udbetal_tidligst` passeret; tekster ("udbetalt til bank"); `src/lib/payout.ts` (død wallet-kode) slettes; dokumentation (CLAUDE.md regel 3, ROADMAP, jura).

## 3. Niels' fund i den nye model
F01 → plan på hver sælgerkonto (sæt, spejl, ret, dagligt tjek; lav saldo = retry + alarm). F02 → delvist løst af Stripes ventetid + `udbetal_tidligst` (N dage/beløb – Filip) + evt. 3DS ved afhentning. F03 → tjek før payout + radar/review-events. F04 → sluttilstand + tilbageførsel ved oprettelse + besked. F05 → ét refusionsjob, trinvis. F06 → som før + payouts/saldo/60-80-dage. F07 → `stripe_tilstand` + start-tjek; alle test-Connect-konti findes ikke i live. M04 → API-version, mindstebeløb (2,50 kr. + payout-minimum), gemt kort/samtykke.

## 4. Overgang
Klart skift med flag `STRIPE_BETALINGSMODEL=destination` (server) + kolonnen `pengemodel` til at dræne gamle handler: eksisterende = separat; nye PI'er = destination; gamle "afventer" PI'er annulleres og laves på ny; betalte gamle handler kører færdigt i gammel kode; gammel kode slettes, når drænet er tomt. Engangsscript `sikrKontoopsaetning` på alle testkonti (sælgere skal onboarde igen). Intet i produktion uden Filips "ja"; migrationen må ikke ændre adfærd, før flaget er slået til.

## 5. Åbne spørgsmål
Advokat/revisor: se jura/noter-til-advokat.md nr. 90–94 (kontrol over frigivelse, sælger som merchant of record, hæftelse, moms på application fee, moms for momsregistrerede erhvervssælgere).
Filip: (9) klar konto før bud – auktion kan oprettes, men ikke modtage bud, før kontoen kan tage imod betaling? Hvad hvis kontoen spærres under auktionen? (10) F02: N dage og beløbsgrænse. (11) Tidligt svindelvarsel: automatisk refusion eller kun blokering? (12) Tabt dispute før payout, hvor varen dokumenteret er leveret: får sælger intet, eller betaler BidHamr? (13) Platformens egen udbetalingsplan.
Tekniske risici: Express Dashboard viser saldo (tekster), afrunding ved delvise refusioner (undgås med eksakte trin), MIT med skiftende on_behalf_of, MobilePay/Klarna med private, gebyrer pr. konto/payout, refusion fra afvist sælgerkonto [VERIFICÉR].

## 6. Byggetrin (worktree, reviewer efter hvert trin, tester til sidst; kun testmiljø)
Testkort: 4000 0000 0000 0077 (straks tilgængelig), …0259 (dispute), …5423 (svindelvarsel), …5126 (refusion fejler), 4000 0025 0000 3155 (3DS).
1. **Fundament** (ingen ændring i pengestrømmen): API-version, migration, `sikrKontoopsaetning`/onboarding, `spejlConnectKonto`, backfill-script, auktionsregel bag flag. Test: ny testsælger får card_payments + manual; daily rettes tilbage + alarm; alt virker uændret med flaget slået fra.
2. **Betaling ind:** destination-PI bag flaget, frisk kontotjek, spejling af transfer/fee/available_on, autobetaling, annullering af gamle PI'er, charge-events.
3. **Udbetaling:** `udbetalTilSaelger`/`udbetalVentende`, F03, saldo-afstemning, samling, `udbetal_tidligst`, payout-events, failed → venter på bank, alle kaldesteder, UI/tekster.
4. **Refusioner og indsigelser:** refusionsplan, fuld/delvis, fælles kø (F05), admin, model A + sluttilstand (F04), varsler.
5. **Oprydning og go-live:** fjern gammel transfer-kode, `stripe_tilstand` + start-tjek (F07), overvågning (F06), admin/penge, dokumentation.
